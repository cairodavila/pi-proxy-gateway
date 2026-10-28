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

/** OpenAI accepts a string or { type: "function", function: { name } }; pi-ai only models auto/none. */
export function toToolChoice(choice: unknown): "auto" | "none" | undefined {
	if (choice === "auto" || choice === "none") return choice;
	if (choice === "required") return "auto";
	return undefined;
}

/** Drop undefined values so they don't clobber pi-ai defaults when spread. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
	return out as Partial<T>;
}
