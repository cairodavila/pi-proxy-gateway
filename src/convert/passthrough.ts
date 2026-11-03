/**
 * Request fields the routes don't convert themselves still have to reach the provider.
 *
 * Same wire format (an Anthropic body to an anthropic-messages model, an OpenAI chat body to an
 * openai-completions model): every such field is copied into the payload pi-ai built, through its
 * onPayload hook. Different wire format: fields with a clear equivalent are translated, and any
 * other field is rejected with a 400 naming it, so clients can tell and fall back instead of the
 * field vanishing.
 */

export type ClientFormat = "anthropic" | "openai";
type Family = ClientFormat | "responses" | "other";
type Obj = Record<string, any>;
type Hook = (payload: any, model?: any) => any;

export class UnsupportedParamError extends Error {
	constructor(readonly param: string, message: string) {
		super(message);
	}
}

// Converted by the routes themselves. pi-ai's value wins for these: it clamps reasoning to the
// model, picks the max-tokens field the provider wants, adds Claude Code identity to `system`.
const MAPPED: Record<ClientFormat, string[]> = {
	anthropic: ["model", "messages", "system", "stream", "tools", "max_tokens", "thinking", "output_config.effort"],
	openai: ["model", "messages", "stream", "stream_options", "tools", "max_tokens", "max_completion_tokens", "reasoning_effort", "reasoning.effort", "reasoning.summary"],
};

const RESPONSES_APIS = new Set(["openai-responses", "azure-openai-responses", "openai-codex-responses"]);

function familyOf(api: string): Family {
	if (api === "anthropic-messages") return "anthropic";
	if (api === "openai-completions") return "openai";
	return RESPONSES_APIS.has(api) ? "responses" : "other";
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** Deep merge: objects recurse, everything else from `src` replaces. */
export function mergeInto(target: Obj, src: Obj): Obj {
	for (const [k, v] of Object.entries(src)) {
		if (isObj(v) && isObj(target[k])) mergeInto(target[k], v);
		else target[k] = clone(v);
	}
	return target;
}

function stripMapped(format: ClientFormat, body: Obj): Obj {
	const extras = clone(body);
	for (const path of MAPPED[format]) {
		const [head, sub] = path.split(".");
		if (!sub) delete extras[head];
		else if (isObj(extras[head])) {
			delete extras[head][sub];
			if (!Object.keys(extras[head]).length) delete extras[head];
		}
	}
	return extras;
}

// The gateway answers with one choice of text and tool calls; it can't relay these.
function rejectUnrelayable(format: ClientFormat, extras: Obj): void {
	if (format !== "openai") return;
	const bad =
		(extras.n !== undefined && extras.n !== 1 && "n") ||
		(extras.logprobs === true && "logprobs") ||
		(extras.top_logprobs && "top_logprobs") ||
		(Array.isArray(extras.modalities) && extras.modalities.some((m: string) => m !== "text") && "modalities") ||
		(extras.audio !== undefined && "audio");
	if (bad) throw new UnsupportedParamError(bad, `Unsupported parameter "${bad}": the gateway returns a single choice of text and tool calls and can't relay it.`);
}

// Values that ask for the default behaviour, so dropping them changes nothing.
function isNoop(key: string, value: any): boolean {
	if (value === undefined || value === null) return true;
	switch (key) {
		case "n": return value === 1;
		case "logprobs": case "store": return value === false;
		case "parallel_tool_calls": return value === true;
		case "frequency_penalty": case "presence_penalty": return value === 0;
		case "service_tier": return value === "auto";
		case "logit_bias": case "metadata": return isObj(value) && !Object.keys(value).length;
		case "response_format": return value?.type === "text";
		// Chat-template flags for self-hosted servers (Open WebUI's "Continue" sends them).
		// Hosted APIs continue a trailing assistant message on their own.
		case "continue_final_message": case "add_generation_prompt": return true;
		default: return false;
	}
}

function fail(param: string, api: string, why = "it has no equivalent in that API"): never {
	throw new UnsupportedParamError(param, `Unsupported parameter "${param}" for ${api} models: ${why}.`);
}

// ---- tool_choice ------------------------------------------------------------------------

/** Normalise either client format to { mode, name, noParallel }. */
function readToolChoice(format: ClientFormat, choice: any, api: string) {
	if (format === "openai") {
		if (choice === "auto" || choice === "none" || choice === "required") return { mode: choice as string };
		if (choice?.type === "function" && choice.function?.name) return { mode: "tool", name: choice.function.name as string };
	} else if (isObj(choice)) {
		const mode = choice.type === "any" ? "required" : choice.type;
		if (["auto", "none", "required"].includes(mode) || (mode === "tool" && choice.name)) {
			return { mode, name: choice.name as string | undefined, noParallel: choice.disable_parallel_tool_use === true };
		}
	}
	return fail("tool_choice", api, "unrecognised value");
}

function writeToolChoice(target: Family, tc: { mode: string; name?: string }, api: string): any {
	if (target === "anthropic") {
		return tc.mode === "tool" ? { type: "tool", name: tc.name } : { type: tc.mode === "required" ? "any" : tc.mode };
	}
	if (target === "openai") return tc.mode === "tool" ? { type: "function", function: { name: tc.name } } : tc.mode;
	if (target === "responses") return tc.mode === "tool" ? { type: "function", name: tc.name } : tc.mode;
	if (tc.mode === "auto" || tc.mode === "none") return undefined; // pi-ai models these for every API
	return fail("tool_choice", api);
}

// ---- structured output ------------------------------------------------------------------

/** OpenAI response_format or Anthropic output_config.format → { schema, name, strict } or "json_object". */
function readFormat(format: ClientFormat, value: any, api: string) {
	const param = format === "openai" ? "response_format" : "output_config.format";
	if (format === "openai" && value?.type === "json_object") return "json_object" as const;
	if (format === "openai" && value?.type === "json_schema" && isObj(value.json_schema?.schema)) {
		const { name = "response", schema, strict = true, description } = value.json_schema;
		return { name, schema, strict, description };
	}
	if (format === "anthropic" && value?.type === "json_schema" && isObj(value.schema)) {
		return { name: "response", schema: value.schema, strict: true, description: undefined };
	}
	return fail(param, api, "unrecognised value");
}

function writeFormat(target: Family, f: ReturnType<typeof readFormat>, param: string, api: string): Obj {
	if (target === "anthropic") {
		if (f === "json_object") return fail(param, api, "Anthropic has no JSON mode without a schema; send a json_schema");
		return { output_config: { format: { type: "json_schema", schema: f.schema } } };
	}
	if (target === "openai") {
		return { response_format: f === "json_object" ? { type: "json_object" } : { type: "json_schema", json_schema: compactObj(f) } };
	}
	if (target === "responses") {
		return { text: { format: f === "json_object" ? { type: "json_object" } : { type: "json_schema", ...compactObj(f) } } };
	}
	return fail(param, api);
}

function compactObj(o: Obj): Obj {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

// ---- cross-format translation -----------------------------------------------------------

function translate(format: ClientFormat, target: Family, extras: Obj, api: string): Obj {
	const out: Obj = {};
	const rest = { ...extras };
	const take = (key: string) => {
		const v = rest[key];
		delete rest[key];
		return v;
	};
	const set = (key: string, v: any) => {
		if (v !== undefined) mergeInto(out, { [key]: v });
	};

	// temperature: pi-ai sets it for every API, but drops it for models that reject it.
	// Send it anyway where we know the field, so the provider's error reaches the client.
	const temperature = take("temperature");
	if (temperature !== undefined && target !== "other") set("temperature", temperature);

	const topP = take("top_p");
	if (topP !== undefined) target === "other" ? fail("top_p", api) : set("top_p", topP);

	const stopKey = format === "openai" ? "stop" : "stop_sequences";
	const stop = take(stopKey);
	if (stop !== undefined) {
		const list = typeof stop === "string" ? [stop] : stop;
		if (target === "anthropic") set("stop_sequences", list);
		else if (target === "openai") set("stop", list);
		else fail(stopKey, api);
	}

	const formatKey = format === "openai" ? "response_format" : "output_config";
	let fmt = take(formatKey);
	if (format === "anthropic" && isObj(fmt)) {
		const { format: f, ...others } = fmt;
		const other = Object.keys(others)[0];
		if (other) fail(`output_config.${other}`, api);
		fmt = f;
	}
	const fmtParam = format === "openai" ? "response_format" : "output_config.format";
	if (fmt !== undefined && !(format === "openai" && isNoop("response_format", fmt))) {
		mergeInto(out, writeFormat(target, readFormat(format, fmt, api), fmtParam, api));
	}

	const choice = take("tool_choice");
	const tc = choice === undefined ? undefined : readToolChoice(format, choice, api);
	const parallel = take("parallel_tool_calls");
	const noParallel = parallel === false || tc?.noParallel === true;
	if (tc) set("tool_choice", writeToolChoice(target, tc, api));
	if (noParallel) {
		const param = format === "openai" ? "parallel_tool_calls" : "tool_choice.disable_parallel_tool_use";
		if (target === "anthropic") out.tool_choice = { ...(out.tool_choice ?? { type: "auto" }), disable_parallel_tool_use: true };
		else if (target === "openai" || target === "responses") set("parallel_tool_calls", false);
		else fail(param, api);
	}

	// End-user id: OpenAI `user`, Anthropic `metadata.user_id`.
	if (format === "openai") {
		const user = take("user");
		if (user !== undefined) {
			if (target === "anthropic") set("metadata", { user_id: user });
			else if (target === "responses") set("user", user);
			else fail("user", api);
		}
		if (target === "responses") {
			for (const key of ["metadata", "store", "service_tier", "prompt_cache_key", "safety_identifier"]) set(key, take(key));
			const verbosity = take("verbosity");
			if (verbosity !== undefined) set("text", { verbosity });
		}
	} else {
		const metadata = take("metadata");
		if (isObj(metadata)) {
			const { user_id, ...others } = metadata;
			const other = Object.keys(others)[0];
			if (other) fail(`metadata.${other}`, api);
			if (user_id !== undefined) target === "other" ? fail("metadata.user_id", api) : set("user", user_id);
		}
	}

	for (const [key, value] of Object.entries(rest)) {
		if (!isNoop(key, value)) fail(key, api);
	}
	return out;
}

// ---- per-tool fields --------------------------------------------------------------------

type ToolExtras = { top: Obj; fn: Obj };

function readToolExtras(format: ClientFormat, tools: any[] | undefined): Map<string, ToolExtras & { index: number }> {
	const map = new Map<string, ToolExtras & { index: number }>();
	(tools ?? []).forEach((t, index) => {
		if (!isObj(t)) return;
		let name: string, top: Obj, fn: Obj = {};
		if (format === "anthropic") {
			const { name: n, description, input_schema, type, ...others } = t;
			if (type !== undefined && type !== "custom") others.type = type;
			name = n;
			top = others;
		} else {
			const { type, function: f, ...others } = t;
			const { name: n, description, parameters, ...fnOthers } = isObj(f) ? f : ({} as Obj);
			name = n;
			top = others;
			fn = fnOthers;
		}
		if (typeof name === "string" && (Object.keys(top).length || Object.keys(fn).length)) map.set(name.toLowerCase(), { top, fn, index });
	});
	return map;
}

/** Cross-format: translate `strict`, accept `cache_control` (pi-ai sets its own cache breakpoints). */
function translateToolExtras(format: ClientFormat, target: Family, map: Map<string, ToolExtras & { index: number }>, api: string) {
	for (const entry of map.values()) {
		const fields = format === "anthropic" ? entry.top : { ...entry.top, ...entry.fn };
		const prefix = format === "anthropic" ? `tools[${entry.index}]` : `tools[${entry.index}].function`;
		const { strict, cache_control, ...others } = fields;
		const other = Object.keys(others)[0];
		if (other) fail(format === "openai" && other in entry.top ? `tools[${entry.index}].${other}` : `${prefix}.${other}`, api);
		entry.top = {};
		entry.fn = {};
		if (strict === undefined) continue;
		if (target === "openai") entry.fn = { strict };
		else if (target === "anthropic" || target === "responses") entry.top = { strict };
		else fail(`${prefix}.strict`, api);
	}
}

function applyToolExtras(payload: Obj, target: Family, map: Map<string, ToolExtras>) {
	if (!map.size || !Array.isArray(payload.tools)) return;
	for (const tool of payload.tools) {
		const name = target === "openai" ? tool?.function?.name : tool?.name;
		const extras = typeof name === "string" ? map.get(name.toLowerCase()) : undefined;
		if (!extras) continue;
		mergeInto(tool, extras.top);
		if (Object.keys(extras.fn).length && isObj(tool.function)) mergeInto(tool.function, extras.fn);
	}
}

/** Anthropic OAuth requests rename tools to Claude Code's casing; a named tool_choice must follow. */
function matchToolChoiceName(payload: Obj) {
	const tc = payload.tool_choice;
	if (tc?.type !== "tool" || typeof tc.name !== "string" || !Array.isArray(payload.tools)) return;
	const match = payload.tools.find((t: any) => typeof t?.name === "string" && t.name.toLowerCase() === tc.name.toLowerCase());
	if (match) tc.name = match.name;
}

// ---- entry point ------------------------------------------------------------------------

export interface Passthrough {
	hook?: Hook;
	/** Top-level client fields forwarded or translated, for the request log. */
	fields: string[];
}

/**
 * Plan how the client's extra fields reach a model on `api`.
 * Throws UnsupportedParamError (→ 400) for a field that can't be relayed.
 */
export function planPassthrough(format: ClientFormat, body: Obj, api: string): Passthrough {
	const target = familyOf(api);
	const extras = stripMapped(format, body);
	rejectUnrelayable(format, extras);
	const fields = Object.keys(extras).filter((k) => !isNoop(k, extras[k]));
	const patch = target === format ? extras : translate(format, target, extras, api);
	const tools = readToolExtras(format, body.tools);
	if (target !== format) translateToolExtras(format, target, tools, api);
	const hasTools = [...tools.values()].some((t) => Object.keys(t.top).length || Object.keys(t.fn).length);
	if (!Object.keys(patch).length && !hasTools) return { fields };
	return {
		fields,
		hook: (payload: any) => {
			if (!isObj(payload)) return payload;
			mergeInto(payload, patch);
			applyToolExtras(payload, target, tools);
			if (target === "anthropic") matchToolChoiceName(payload);
			return payload;
		},
	};
}

/** Run onPayload hooks in order; a hook returning undefined keeps the payload it was given. */
export function chainHooks(...hooks: (Hook | undefined)[]): Hook | undefined {
	const list = hooks.filter((h): h is Hook => !!h);
	if (list.length <= 1) return list[0];
	return async (payload: any, model?: any) => {
		let current = payload;
		for (const hook of list) {
			const next = await hook(current, model);
			if (next !== undefined) current = next;
		}
		return current;
	};
}
