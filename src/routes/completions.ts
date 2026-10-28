/**
 * POST /v1/chat/completions — OpenAI-compatible chat completions
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { AssistantMessage, Api, Model } from "@earendil-works/pi-ai";
import { streamSimple as piAiStreamSimple } from "@earendil-works/pi-ai/compat";
import type { ProxyConfig, OpenAIChatRequest } from "../types.js";
import { resolveModelAlias } from "../config.js";
import { convertOpenAIMessages, convertOpenAITools } from "../convert/openai-to-piai.js";
import { eventToSSEChunks, eventToNonStreamingResponse, ToolCallIndexTracker } from "../convert/piai-to-openai.js";
import { toOpenAIUsage, toThinkingLevel, toToolChoice, compact } from "../convert/usage.js";
import { readBody, jsonResponse, errorResponse } from "../server.js";
import { logRequest, type RequestLogger } from "../logging.js";

export async function handleCompletions(
	req: IncomingMessage,
	res: ServerResponse,
	config: ProxyConfig,
	getModelRegistry: () => any,
	logger: RequestLogger | null,
	signal: AbortSignal,
): Promise<void> {
	const startTime = Date.now();
	const registry = getModelRegistry();
	if (!registry) {
		return errorResponse(res, 503, "Model registry not available yet", { "Retry-After": "1" });
	}

	let body: OpenAIChatRequest;
	try {
		body = JSON.parse(await readBody(req));
	} catch {
		return errorResponse(res, 400, "Invalid JSON body");
	}

	// Resolve model (alias → provider/model-id)
	const rawModel = body.model || config.defaultModel;
	if (!rawModel) {
		return errorResponse(res, 400, "No model specified. Use 'provider/model-id' format or set defaultModel in config.");
	}

	const modelSpec = resolveModelAlias(rawModel, config);
	const slashIndex = modelSpec.indexOf("/");
	if (slashIndex === -1) {
		return errorResponse(res, 400, `Invalid model format "${modelSpec}". Use "provider/model-id" (e.g., "anthropic/claude-sonnet-4-5-20250929").`);
	}

	const provider = modelSpec.slice(0, slashIndex);
	const modelId = modelSpec.slice(slashIndex + 1);
	const model = registry.find(provider, modelId) as Model<Api> | undefined;

	if (!model) {
		return errorResponse(res, 404, `Model "${modelSpec}" not found. Use GET /v1/models to list available models.`);
	}

	// Resolve API key
	const authResult = await registry.getApiKeyAndHeaders(model);
	if (!authResult.ok) {
		return errorResponse(res, 401, `No API key for model "${modelSpec}": ${authResult.error}`);
	}

	// Convert messages and tools
	const { systemPrompt, messages } = convertOpenAIMessages(body.messages);
	const context: any = { systemPrompt, messages };
	if (body.tools?.length) {
		context.tools = convertOpenAITools(body.tools);
	}

	const b = body as any;
	const stop = typeof b.stop === "string" ? [b.stop] : Array.isArray(b.stop) ? b.stop : undefined;
	const samplingParams = compact({ top_p: b.top_p, stop, seed: b.seed, frequency_penalty: b.frequency_penalty, presence_penalty: b.presence_penalty });
	const streamOptions: any = compact({
		maxTokens: b.max_completion_tokens ?? b.max_tokens,
		temperature: b.temperature,
		// OpenAI: reasoning_effort; OpenRouter-style clients: reasoning.effort
		reasoning: toThinkingLevel(b.reasoning_effort ?? b.reasoning?.effort),
		toolChoice: toToolChoice(b.tool_choice),
		// Only OpenAI-compatible adapters read samplingParams; others ignore it.
		samplingParams: Object.keys(samplingParams).length ? samplingParams : undefined,
		// Stable per-conversation key → provider prompt caching (codex prompt_cache_key).
		// Open WebUI sends X-OpenWebUI-Chat-Id when ENABLE_FORWARD_USER_INFO_HEADERS is on.
		sessionId: headerValue(req, "x-openwebui-chat-id") || headerValue(req, "x-session-id"),
		signal,
	});
	// Prefer the registry: it resolves auth and runs extension-registered provider streams
	// (e.g. pi-multi-account OAuth shaping). Fall back to raw pi-ai for older pi versions.
	const streamSimple = typeof registry.streamSimple === "function"
		? (m: Model<Api>, c: any, o: any) => registry.streamSimple(m, c, o)
		: (m: Model<Api>, c: any, o: any) => piAiStreamSimple(m, c, { ...o, apiKey: authResult.apiKey, headers: authResult.headers });
	const includeUsage = b.stream_options?.include_usage !== false;

	const msgId = `proxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

	try {
		const eventStream = streamSimple(model, context, streamOptions);

		if (body.stream === false || body.stream === undefined) {
			// Non-streaming
			let finalMessage: AssistantMessage | undefined;
			for await (const event of eventStream) {
				if (signal.aborted) break;
				if (event.type === "done") {
					finalMessage = event.message;
				} else if (event.type === "error") {
					logRequest(logger, { method: "POST", path: "/v1/chat/completions", model: modelSpec, status: 502, startTime, error: event.error.errorMessage });
					return errorResponse(res, 502, event.error.errorMessage || "Provider error");
				}
			}
			if (!finalMessage) {
				logRequest(logger, { method: "POST", path: "/v1/chat/completions", model: modelSpec, status: 502, startTime, error: "No response from provider" });
				return errorResponse(res, 502, "No response from provider");
			}
			logRequest(logger, { method: "POST", path: "/v1/chat/completions", model: modelSpec, status: 200, startTime, inputTokens: toOpenAIUsage(finalMessage.usage)?.prompt_tokens, outputTokens: finalMessage.usage.output });
			return jsonResponse(res, 200, eventToNonStreamingResponse(finalMessage, modelSpec, msgId));
		}

		// Streaming
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"Access-Control-Allow-Origin": config.allowedOrigins?.join(",") || "*",
		});

		const tracker = new ToolCallIndexTracker();
		let lastMessage: AssistantMessage | undefined;
		for await (const event of eventStream) {
			if (signal.aborted) break;
			if (event.type === "done") lastMessage = event.message;
			const sseChunks = eventToSSEChunks(event, modelSpec, msgId, tracker, includeUsage);
			for (const chunk of sseChunks) {
				res.write(chunk);
			}
		}
		logRequest(logger, { method: "POST", path: "/v1/chat/completions", model: modelSpec, status: 200, startTime, inputTokens: toOpenAIUsage(lastMessage?.usage)?.prompt_tokens, outputTokens: lastMessage?.usage.output });
		res.end();
	} catch (err: any) {
		if (signal.aborted) {
			if (!res.headersSent) {
				return errorResponse(res, 504, "Request timeout or client disconnected");
			}
			res.end();
			return;
		}
		if (!res.headersSent) {
			logRequest(logger, { method: "POST", path: "/v1/chat/completions", model: modelSpec, status: 502, startTime, error: err.message });
			return errorResponse(res, 502, `Provider error: ${err.message}`);
		}
		res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	}
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
	const v = req.headers[name];
	const s = Array.isArray(v) ? v[0] : v;
	return s && s.trim() ? s.trim() : undefined;
}
