import { describe, it, expect } from "vitest";
import { planPassthrough, chainHooks, UnsupportedParamError } from "../src/convert/passthrough.js";
import { reasoningSummaryHook } from "../src/convert/usage.js";

const SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };

/** Roughly what pi-ai's anthropic-messages adapter builds for an adaptive-thinking model with OAuth. */
function anthropicPayload(): any {
	return {
		model: "claude-haiku-5-5",
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		max_tokens: 1000,
		stream: true,
		system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
		tools: [{ name: "Read", description: "read", input_schema: { type: "object", properties: {} } }],
		thinking: { type: "adaptive", display: "summarized" },
		output_config: { effort: "high" },
	};
}

function openaiPayload(): any {
	return {
		model: "gpt-x",
		messages: [{ role: "user", content: "hi" }],
		stream: true,
		stream_options: { include_usage: true },
		store: false,
		max_completion_tokens: 500,
		tools: [{ type: "function", function: { name: "lookup", description: "", parameters: { type: "object", properties: {} } } }],
	};
}

function run(format: "anthropic" | "openai", body: any, api: string, payload: any) {
	const plan = planPassthrough(format, body, api);
	return { plan, out: plan.hook ? plan.hook(payload) : payload };
}

function rejects(format: "anthropic" | "openai", body: any, api: string, param: string) {
	try {
		planPassthrough(format, body, api);
	} catch (err) {
		expect(err).toBeInstanceOf(UnsupportedParamError);
		expect((err as UnsupportedParamError).param).toBe(param);
		expect((err as Error).message).toContain(`"${param}"`);
		return;
	}
	throw new Error(`expected "${param}" to be rejected`);
}

describe("same wire format: Anthropic body → anthropic-messages", () => {
	it("merges output_config.format next to pi-ai's effort and copies unmodelled fields", () => {
		const { out, plan } = run("anthropic", {
			model: "x", max_tokens: 1, stream: false, system: "client system",
			messages: [{ role: "user", content: "other" }],
			output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
			thinking: { type: "enabled", budget_tokens: 2000 },
			top_k: 5, stop_sequences: ["END"], metadata: { user_id: "u1" }, service_tier: "standard_only",
		}, "anthropic-messages", anthropicPayload());
		expect(out.output_config).toEqual({ effort: "high", format: { type: "json_schema", schema: SCHEMA } });
		expect(out).toMatchObject({ top_k: 5, stop_sequences: ["END"], metadata: { user_id: "u1" }, service_tier: "standard_only" });
		// pi-ai owns these
		expect(out.model).toBe("claude-haiku-5-5");
		expect(out.max_tokens).toBe(1000);
		expect(out.stream).toBe(true);
		expect(out.system[0].text).toContain("Claude Code");
		expect(out.messages[0].content[0].text).toBe("hi");
		expect(out.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(plan.fields).toEqual(["output_config", "top_k", "stop_sequences", "metadata", "service_tier"]);
	});

	it("sends temperature even when pi-ai dropped it, so the provider can reject it", () => {
		const { out } = run("anthropic", { messages: [], max_tokens: 10, temperature: 0.2 }, "anthropic-messages", anthropicPayload());
		expect(out.temperature).toBe(0.2);
	});

	it("maps a named tool_choice to the tool name pi-ai sent (Claude Code casing)", () => {
		const { out } = run("anthropic", {
			messages: [], max_tokens: 10,
			tools: [{ name: "read", input_schema: {}, strict: true, cache_control: { type: "ephemeral" } }],
			tool_choice: { type: "tool", name: "read", disable_parallel_tool_use: true },
		}, "anthropic-messages", anthropicPayload());
		expect(out.tool_choice).toEqual({ type: "tool", name: "Read", disable_parallel_tool_use: true });
		expect(out.tools[0]).toMatchObject({ name: "Read", strict: true, cache_control: { type: "ephemeral" } });
	});

	it("has no hook when there is nothing extra", () => {
		expect(planPassthrough("anthropic", { model: "m", messages: [], max_tokens: 5, output_config: { effort: "high" } }, "anthropic-messages").hook).toBeUndefined();
	});

	it("is idempotent (pi-ai rebuilds and re-hooks the payload on a strict-tools retry)", () => {
		const { hook } = planPassthrough("anthropic", { messages: [], max_tokens: 1, output_config: { format: { type: "json_schema", schema: SCHEMA } }, top_k: 3 }, "anthropic-messages");
		const once = hook!(anthropicPayload());
		expect(hook!(structuredClone(once))).toEqual(once);
	});
});

describe("same wire format: OpenAI body → openai-completions", () => {
	it("copies response_format, logit_bias, user and tool strict; keeps pi-ai's max-tokens field", () => {
		const { out } = run("openai", {
			model: "m", messages: [], stream: false, stream_options: { include_usage: false },
			max_tokens: 99, reasoning_effort: "high", reasoning: { effort: "high", exclude: true },
			response_format: { type: "json_schema", json_schema: { name: "r", schema: SCHEMA, strict: true } },
			logit_bias: { "50256": -100 }, user: "u1", tool_choice: { type: "function", function: { name: "lookup" } },
			tools: [{ type: "function", function: { name: "lookup", parameters: {}, strict: true } }],
		}, "openai-completions", openaiPayload());
		expect(out.response_format.json_schema.schema).toEqual(SCHEMA);
		expect(out).toMatchObject({ logit_bias: { "50256": -100 }, user: "u1", tool_choice: { type: "function", function: { name: "lookup" } } });
		expect(out.reasoning).toEqual({ exclude: true });
		expect(out.max_tokens).toBeUndefined();
		expect(out.max_completion_tokens).toBe(500);
		expect(out.stream_options).toEqual({ include_usage: true });
		expect(out.tools[0].function.strict).toBe(true);
	});

	it("rejects fields whose output the gateway can't relay", () => {
		rejects("openai", { messages: [], n: 2 }, "openai-completions", "n");
		rejects("openai", { messages: [], logprobs: true }, "openai-completions", "logprobs");
		rejects("openai", { messages: [], modalities: ["text", "audio"] }, "openai-completions", "modalities");
		expect(planPassthrough("openai", { messages: [], n: 1, logprobs: false }, "openai-completions")).toBeDefined();
	});
});

describe("different wire format", () => {
	it("OpenAI → anthropic-messages: response_format, tool_choice, parallel_tool_calls, stop, user", () => {
		const { out } = run("openai", {
			messages: [], temperature: 0.1, top_p: 0.9, stop: "END", user: "u1",
			response_format: { type: "json_schema", json_schema: { name: "r", schema: SCHEMA } },
			tool_choice: "required", parallel_tool_calls: false, frequency_penalty: 0, n: 1,
		}, "anthropic-messages", anthropicPayload());
		expect(out.output_config).toEqual({ effort: "high", format: { type: "json_schema", schema: SCHEMA } });
		expect(out.tool_choice).toEqual({ type: "any", disable_parallel_tool_use: true });
		expect(out).toMatchObject({ temperature: 0.1, top_p: 0.9, stop_sequences: ["END"], metadata: { user_id: "u1" } });
		expect(out.frequency_penalty).toBeUndefined();
	});

	it("OpenAI → anthropic-messages: Open WebUI's Continue flags are accepted as no-ops", () => {
		expect(planPassthrough("openai", { messages: [], continue_final_message: true, add_generation_prompt: false }, "anthropic-messages").hook).toBeUndefined();
	});

	it("OpenAI → anthropic-messages: named tool, with Claude Code casing", () => {
		const { out } = run("openai", { messages: [], tool_choice: { type: "function", function: { name: "read" } } }, "anthropic-messages", anthropicPayload());
		expect(out.tool_choice).toEqual({ type: "tool", name: "Read" });
	});

	it("OpenAI → anthropic-messages: rejects what Anthropic can't do, naming the field", () => {
		rejects("openai", { messages: [], seed: 1 }, "anthropic-messages", "seed");
		rejects("openai", { messages: [], presence_penalty: 0.5 }, "anthropic-messages", "presence_penalty");
		rejects("openai", { messages: [], response_format: { type: "json_object" } }, "anthropic-messages", "response_format");
		rejects("openai", { messages: [], store: true }, "anthropic-messages", "store");
		rejects("openai", { messages: [], prediction: { type: "content", content: "x" } }, "anthropic-messages", "prediction");
		rejects("openai", { messages: [], tools: [{ type: "function", function: { name: "a", parameters: {}, x_custom: 1 } }] }, "anthropic-messages", "tools[0].function.x_custom");
	});

	it("Anthropic → openai-completions: output_config.format, stop_sequences, metadata.user_id, tool_choice", () => {
		const { out } = run("anthropic", {
			messages: [], max_tokens: 10, stop_sequences: ["X"], metadata: { user_id: "u1" },
			output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
			tool_choice: { type: "any", disable_parallel_tool_use: true },
			tools: [{ name: "lookup", input_schema: {}, strict: true }],
		}, "openai-completions", openaiPayload());
		expect(out.response_format).toEqual({ type: "json_schema", json_schema: { name: "response", schema: SCHEMA, strict: true } });
		expect(out).toMatchObject({ stop: ["X"], user: "u1", tool_choice: "required", parallel_tool_calls: false });
		expect(out.tools[0].function.strict).toBe(true);
		rejects("anthropic", { messages: [], max_tokens: 1, top_k: 5 }, "openai-completions", "top_k");
		rejects("anthropic", { messages: [], max_tokens: 1, metadata: { user_id: "u", other: 1 } }, "openai-completions", "metadata.other");
	});

	it("OpenAI → openai-codex-responses: text.format keeps pi-ai's verbosity", () => {
		const payload = { model: "gpt-x", input: [], stream: true, store: false, text: { verbosity: "low" }, tool_choice: "auto", parallel_tool_calls: true };
		const { out } = run("openai", {
			messages: [], response_format: { type: "json_schema", json_schema: { name: "r", schema: SCHEMA, strict: true } },
			tool_choice: { type: "function", function: { name: "lookup" } }, parallel_tool_calls: false, store: false,
		}, "openai-codex-responses", payload);
		expect(out.text).toEqual({ verbosity: "low", format: { type: "json_schema", name: "r", schema: SCHEMA, strict: true } });
		expect(out.tool_choice).toEqual({ type: "function", name: "lookup" });
		expect(out.parallel_tool_calls).toBe(false);
		rejects("openai", { messages: [], stop: ["x"] }, "openai-codex-responses", "stop");
	});

	it("other APIs: pi-ai's own auto/none tool_choice passes, anything else is rejected", () => {
		expect(planPassthrough("openai", { messages: [], tool_choice: "auto", temperature: 0.3 }, "google-generative-ai").hook).toBeUndefined();
		rejects("openai", { messages: [], tool_choice: "required" }, "google-generative-ai", "tool_choice");
		rejects("anthropic", { messages: [], max_tokens: 1, top_p: 0.5 }, "cursor-agent", "top_p");
	});
});

describe("chainHooks", () => {
	it("runs passthrough then the reasoning summary hook", async () => {
		const { hook } = planPassthrough("openai", { messages: [], response_format: { type: "json_object" } }, "openai-codex-responses");
		const chained = chainHooks(hook, reasoningSummaryHook("detailed"))!;
		const out = await chained({ reasoning: { effort: "high", summary: "auto" }, text: { verbosity: "low" } });
		expect(out).toEqual({ reasoning: { effort: "high", summary: "detailed" }, text: { verbosity: "low", format: { type: "json_object" } } });
	});

	it("returns the single hook unchanged, or undefined when there are none", () => {
		const h = (p: any) => p;
		expect(chainHooks(undefined, h)).toBe(h);
		expect(chainHooks(undefined, undefined)).toBeUndefined();
	});
});
