/**
 * Shared helpers: pi-ai Usage → wire usage formats, and client request → pi-ai stream options.
 */

import type { Usage } from "@earendil-works/pi-ai";

// =============================================================================
// Usage
// =============================================================================

/**
 * pi-ai splits prompt tokens into `input` (uncached), `cacheRead` and `cacheWrite`.
 * OpenAI's `prompt_tokens` is the TOTAL prompt size, with cached tokens reported as a
 * subset in `prompt_tokens_details.cached_tokens`. `reasoning` is already a subset of
 * `output`, which matches `completion_tokens_details.reasoning_tokens`.
 */
export function toOpenAIUsage(usage: Usage | undefined): Record<string, any> | undefined {
	if (!usage) return undefined;
	const cacheRead = usage.cacheRead || 0;
	const cacheWrite = usage.cacheWrite || 0;
	const prompt = (usage.input || 0) + cacheRead + cacheWrite;
	const completion = usage.output || 0;
	const out: Record<string, any> = {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: prompt + completion,
		prompt_tokens_details: { cached_tokens: cacheRead },
		completion_tokens_details: { reasoning_tokens: usage.reasoning || 0 },
	};
	// Non-standard but harmless: lets clients see cache writes and pi-ai's cost estimate.
	if (cacheWrite) out.prompt_tokens_details.cache_creation_tokens = cacheWrite;
	if (usage.cost?.total) out.cost = usage.cost.total;
	return out;
}

/** Anthropic reports the three prompt buckets separately, which maps 1:1 to pi-ai. */
export function toAnthropicUsage(usage: Usage | undefined): Record<string, number> {
	return {
		input_tokens: usage?.input || 0,
		output_tokens: usage?.output || 0,
		cache_read_input_tokens: usage?.cacheRead || 0,
		cache_creation_input_tokens: usage?.cacheWrite || 0,
	};
}

// =============================================================================
// Request options
// =============================================================================

const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Map a client reasoning effort onto pi-ai's ThinkingLevel.
 * Returns undefined to leave pi-ai on its per-model default (no reasoning requested).
 * pi-ai clamps the level to what each model supports via its thinkingLevelMap.
 */
export function toThinkingLevel(effort: unknown): string | undefined {
	if (typeof effort !== "string") return undefined;
	const value = effort.trim().toLowerCase();
	if (!value || value === "none" || value === "off") return undefined;
	if (THINKING_LEVELS.has(value)) return value;
	return undefined;
}

// The values Codex accepts; anything else is rejected upstream with a 400.
const REASONING_SUMMARIES = new Set(["auto", "concise", "detailed"]);

/** Normalise a reasoning summary mode; undefined when unset or unknown. */
export function toReasoningSummary(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const v = value.trim().toLowerCase();
	return REASONING_SUMMARIES.has(v) ? v : undefined;
}

/**
 * onPayload hook for Responses-style payloads (OpenAI Codex, OpenAI/Azure Responses).
 * pi-ai always asks for `reasoning.summary: "auto"`, and in auto mode the model often skips the
 * summary, so clients see no reasoning. Swap "auto" for the configured mode; payloads without a
 * `reasoning.summary` field (Anthropic, chat completions, OpenRouter) are left alone.
 */
export function reasoningSummaryHook(summary: string | undefined) {
	if (!summary || summary === "auto") return undefined;
	return (payload: any) => {
		const r = payload?.reasoning;
		if (r && typeof r === "object" && r.summary === "auto") r.summary = summary;
		return payload;
	};
}

/**
 * pi-ai only models auto/none. Accepts OpenAI strings and Anthropic `{ type }` objects; anything
 * else (required/any, a named tool) is left to the passthrough hook, which sends it as is.
 */
export function toToolChoice(choice: unknown): "auto" | "none" | undefined {
	const value = (choice as any)?.type ?? choice;
	if (value === "auto" || value === "none") return value;
	return undefined;
}

/** Drop undefined values so they don't clobber pi-ai defaults when spread. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
	return out as Partial<T>;
}
