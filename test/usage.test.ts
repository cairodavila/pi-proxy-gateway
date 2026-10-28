import { describe, it, expect } from "vitest";
import { toOpenAIUsage, toAnthropicUsage, toThinkingLevel, toToolChoice, compact } from "../src/convert/usage.js";
import { eventToSSEChunks, ToolCallIndexTracker } from "../src/convert/piai-to-openai.js";

const usage = { input: 100, output: 50, cacheRead: 9000, cacheWrite: 400, reasoning: 30, totalTokens: 9550, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 } } as any;

describe("toOpenAIUsage", () => {
	it("counts cached and cache-write tokens in prompt_tokens and reports details", () => {
		const u = toOpenAIUsage(usage)!;
		expect(u.prompt_tokens).toBe(9500);
		expect(u.completion_tokens).toBe(50);
		expect(u.total_tokens).toBe(9550);
		expect(u.prompt_tokens_details.cached_tokens).toBe(9000);
		expect(u.prompt_tokens_details.cache_creation_tokens).toBe(400);
		expect(u.completion_tokens_details.reasoning_tokens).toBe(30);
		expect(u.cost).toBe(0.0123);
	});
	it("handles missing usage", () => {
		expect(toOpenAIUsage(undefined)).toBeUndefined();
	});
	it("omits usage from the final chunk when include_usage is false", () => {
		const done = { type: "done", message: { stopReason: "stop", usage } } as any;
		const withUsage = JSON.parse(eventToSSEChunks(done, "m", "id", new ToolCallIndexTracker())[0].slice(6));
		const without = JSON.parse(eventToSSEChunks(done, "m", "id", new ToolCallIndexTracker(), false)[0].slice(6));
		expect(withUsage.usage.prompt_tokens).toBe(9500);
		expect(without.usage).toBeUndefined();
	});
});

describe("toAnthropicUsage", () => {
	it("maps buckets 1:1", () => {
		expect(toAnthropicUsage(usage)).toEqual({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 9000, cache_creation_input_tokens: 400 });
	});
});

describe("request option mapping", () => {
	it("maps reasoning effort to pi-ai thinking levels", () => {
		expect(toThinkingLevel("xhigh")).toBe("xhigh");
		expect(toThinkingLevel("HIGH")).toBe("high");
		expect(toThinkingLevel("max")).toBe("max");
		expect(toThinkingLevel("none")).toBeUndefined();
		expect(toThinkingLevel("bogus")).toBeUndefined();
		expect(toThinkingLevel(undefined)).toBeUndefined();
	});
	it("maps tool_choice to auto/none", () => {
		expect(toToolChoice("none")).toBe("none");
		expect(toToolChoice("required")).toBe("auto");
		expect(toToolChoice({ type: "function", function: { name: "x" } })).toBeUndefined();
	});
	it("compact drops undefined values", () => {
		expect(compact({ a: 1, b: undefined, c: 0 })).toEqual({ a: 1, c: 0 });
	});
});
