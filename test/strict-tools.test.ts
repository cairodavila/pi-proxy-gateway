import { describe, it, expect } from "vitest";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { convertOpenAITools } from "../src/convert/openai-to-piai.js";
import { convertAnthropicTools } from "../src/convert/anthropic-to-piai.js";
import { planPassthrough } from "../src/convert/passthrough.js";

const schema = {
	type: "object",
	properties: {
		entries: { type: "array", items: { type: "object", properties: { value: { type: "string" } } } },
	},
	required: ["entries"],
};

for (const format of ["openai", "anthropic"] as const) {
	describe(`${format} strict tools`, () => {
		for (const api of ["anthropic-messages", "openai-completions", "openai-responses"] as const) {
			it.each([true, false, undefined])(`serializes strict=%s for ${api} before passthrough`, async (strict) => {
				const inputSchema = structuredClone(schema);
				const flags = strict === undefined ? {} : { strict };
				const body = { messages: [], tools: format === "openai"
					? [{ type: "function" as const, function: { name: "lookup", parameters: inputSchema, ...flags } }]
					: [{ name: "lookup", input_schema: inputSchema, ...flags }] };
				const tools = format === "openai" ? convertOpenAITools(body.tools as any) : convertAnthropicTools(body.tools as any);
				const model = {
					...(api === "anthropic-messages" ? getModel("anthropic", "claude-haiku-4-5") : getModel("openai", "gpt-4o")),
					api, baseUrl: "http://127.0.0.1:1",
				};
				const { hook } = planPassthrough(format, body, api);
				let before: any;
				let payload: any;
				const stream = streamSimple(model, {
					messages: [{ role: "user", content: "hi", timestamp: 0 }], tools,
				}, {
					apiKey: "test-key",
					onPayload: async (p) => {
						before = structuredClone(p);
						payload = hook ? await hook(p) : p;
						throw new Error("captured before network");
					},
				});
				const result = await stream.result();
				expect(result.errorMessage).toContain("captured before network");
				const definition = api === "openai-completions" ? payload.tools[0].function : payload.tools[0];
				const parameters = api === "anthropic-messages" ? definition.input_schema : definition.parameters;
				if (strict === true) {
					expect(definition.strict).toBe(true);
					expect(parameters.additionalProperties).toBe(false);
					expect(parameters.properties.entries.items.additionalProperties).toBe(false);
					expect(parameters.properties.entries.items.required).toEqual(["value"]);
					const original = api === "openai-completions" ? before.tools[0].function : before.tools[0];
					expect(original.strict).toBe(true);
				} else {
					expect(definition.strict).not.toBe(true);
					expect(parameters.additionalProperties).toBeUndefined();
					expect(tools![0].constrainedSampling).toBeUndefined();
				}
				expect(inputSchema).toEqual(schema);
			});
		}
	});
}
