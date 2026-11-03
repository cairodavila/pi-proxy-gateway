/**
 * POST /v1/messages — Anthropic Messages API compatible endpoint
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { AssistantMessage, Api, Model } from "@earendil-works/pi-ai";
import { streamSimple as piAiStreamSimple } from "@earendil-works/pi-ai/compat";
import { toThinkingLevel, toToolChoice, toReasoningSummary, reasoningSummaryHook, compact } from "../convert/usage.js";
import { planPassthrough, chainHooks, UnsupportedParamError, type Passthrough } from "../convert/passthrough.js";
import type { ProxyConfig, AnthropicMessagesRequest } from "../types.js";
import { resolveModelAlias } from "../config.js";
import { convertAnthropicMessages, convertAnthropicTools } from "../convert/anthropic-to-piai.js";
import { eventToAnthropicSSE, eventToAnthropicResponse, AnthropicBlockTracker } from "../convert/piai-to-anthropic.js";
import { readBody, jsonResponse, errorResponse, providerErrorStatus } from "../server.js";
import { logRequest, type RequestLogger } from "../logging.js";

export async function handleMessages(
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

	let body: AnthropicMessagesRequest;
	try {
		body = JSON.parse(await readBody(req));
	} catch {
		return errorResponse(res, 400, "Invalid JSON body");
	}

	// Resolve model
	const rawModel = body.model || config.defaultModel;
	if (!rawModel) {
		return errorResponse(res, 400, "No model specified. Use 'provider/model-id' format or set defaultModel in config.");
	}

	const modelSpec = resolveModelAlias(rawModel, config);
	const slashIndex = modelSpec.indexOf("/");
	if (slashIndex === -1) {
		return errorResponse(res, 400, `Invalid model format "${modelSpec}". Use "provider/model-id".`);
	}

	const provider = modelSpec.slice(0, slashIndex);
	const modelId = modelSpec.slice(slashIndex + 1);
	const model = registry.find(provider, modelId) as Model<Api> | undefined;

	if (!model) {
		return errorResponse(res, 404, `Model "${modelSpec}" not found. Use GET /v1/models to list available models.`);
	}

	// Fields the route doesn't convert: forwarded as is, translated, or rejected with a 400.
	let passthrough: Passthrough;
	try {
		passthrough = planPassthrough("anthropic", body as any, model.api);
	} catch (err) {
		if (!(err instanceof UnsupportedParamError)) throw err;
		logRequest(logger, { method: "POST", path: "/v1/messages", model: modelSpec, status: 400, startTime, error: err.message });
		return errorResponse(res, 400, err.message);
	}

	const authResult = await registry.getApiKeyAndHeaders(model);
	if (!authResult.ok) {
		return errorResponse(res, 401, `No API key for model "${modelSpec}": ${authResult.error}`);
	}

	// Convert messages and tools
	const { systemPrompt, messages } = convertAnthropicMessages(body);
	const context: any = { systemPrompt, messages };
	if (body.tools?.length) {
		context.tools = convertAnthropicTools(body.tools);
	}

	const b = body as any;
	// Anthropic: thinking.type=enabled|adaptive (+ budget) and/or output_config.effort
	let reasoning = toThinkingLevel(b.output_config?.effort);
	if (!reasoning && (b.thinking?.type === "enabled" || b.thinking?.type === "adaptive")) {
		const budget = Number(b.thinking?.budget_tokens) || 0;
		reasoning = budget >= 32000 ? "xhigh" : budget >= 16000 ? "high" : budget >= 4000 ? "medium" : budget > 0 ? "low" : "high";
	}
	const streamOptions: any = compact({
		maxTokens: b.max_tokens,
		temperature: b.temperature,
		reasoning,
		toolChoice: toToolChoice(b.tool_choice),
		onPayload: chainHooks(passthrough.hook, reasoningSummaryHook(toReasoningSummary(config.reasoningSummary))),
		signal,
	});
	const streamSimple = typeof registry.streamSimple === "function"
		? (m: Model<Api>, c: any, o: any) => registry.streamSimple(m, c, o)
		: (m: Model<Api>, c: any, o: any) => piAiStreamSimple(m, c, { ...o, apiKey: authResult.apiKey, headers: authResult.headers });

	const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

	try {
		const eventStream = streamSimple(model, context, streamOptions);

		if (!body.stream) {
			// Non-streaming
			let finalMessage: AssistantMessage | undefined;
			for await (const event of eventStream) {
				if (signal.aborted) break;
				if (event.type === "done") {
					finalMessage = event.message;
				} else if (event.type === "error") {
					const status = providerErrorStatus(event.error.errorMessage);
					logRequest(logger, { method: "POST", path: "/v1/messages", model: modelSpec, passthrough: passthrough.fields, status, startTime, error: event.error.errorMessage });
					return errorResponse(res, status, event.error.errorMessage || "Provider error");
				}
			}
			if (!finalMessage) {
				logRequest(logger, { method: "POST", path: "/v1/messages", model: modelSpec, passthrough: passthrough.fields, status: 502, startTime, error: "No response from provider" });
				return errorResponse(res, 502, "No response from provider");
			}
			logRequest(logger, { method: "POST", path: "/v1/messages", model: modelSpec, passthrough: passthrough.fields, status: 200, startTime, inputTokens: finalMessage.usage.input, outputTokens: finalMessage.usage.output });
			return jsonResponse(res, 200, eventToAnthropicResponse(finalMessage, modelSpec, msgId));
		}

		// Streaming. Headers wait for the first event: pi-ai only starts once the provider accepted
		// the request, so a rejected request still gets its real status instead of a 200 stream.
		const sseHeaders = {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"Access-Control-Allow-Origin": config.allowedOrigins?.join(",") || "*",
		};

		const tracker = new AnthropicBlockTracker();
		let lastMessage: AssistantMessage | undefined;
		for await (const event of eventStream) {
			if (signal.aborted) break;
			if (event.type === "error" && !res.headersSent) {
				const status = providerErrorStatus(event.error.errorMessage);
				logRequest(logger, { method: "POST", path: "/v1/messages", model: modelSpec, passthrough: passthrough.fields, status, startTime, error: event.error.errorMessage });
				return errorResponse(res, status, event.error.errorMessage || "Provider error");
			}
			if (!res.headersSent) res.writeHead(200, sseHeaders);
			if (event.type === "done") lastMessage = event.message;
			const sseChunks = eventToAnthropicSSE(event, modelSpec, msgId, tracker);
			for (const chunk of sseChunks) {
				res.write(chunk);
			}
		}
		if (!res.headersSent) res.writeHead(200, sseHeaders);
		logRequest(logger, { method: "POST", path: "/v1/messages", model: modelSpec, passthrough: passthrough.fields, status: 200, startTime, inputTokens: lastMessage?.usage.input, outputTokens: lastMessage?.usage.output });
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
			const status = providerErrorStatus(err.message);
			logRequest(logger, { method: "POST", path: "/v1/messages", model: modelSpec, passthrough: passthrough.fields, status, startTime, error: err.message });
			return errorResponse(res, status, `Provider error: ${err.message}`);
		}
		res.end();
	}
}


