/**
 * Extension lifecycle — entry point for pi
 */

import type { Model, Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { createProxyServer } from "./server.js";

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	let modelRegistry: any = null;

	// Start the HTTP server
	const server = createProxyServer({
		config,
		getModelRegistry: () => modelRegistry,
	});

	// Every pi instance loads this extension, but only one can own the port. The others
	// retry quietly, so if the owner exits, another running instance takes over.
	const RETRY_MS = 15000;
	let listening = false;
	let stopped = false;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let warned = false;

	const tryListen = () => {
		if (stopped) return;
		server.listen(config.port, config.host || "127.0.0.1");
	};

	server.on("listening", () => {
		listening = true;
		console.log(`[proxy-gateway] API server listening on http://${config.host || "127.0.0.1"}:${config.port}${warned ? " (took over port)" : ""}`);
		if (config.defaultModel) console.log(`[proxy-gateway] Default model: ${config.defaultModel}`);
		if (config.aliases && Object.keys(config.aliases).length > 0) {
			console.log(`[proxy-gateway] Aliases: ${Object.keys(config.aliases).join(", ")}`);
		}
		if (config.rateLimit) console.log(`[proxy-gateway] Rate limit: ${config.rateLimit} req/min`);
	});

	server.on("error", (err: any) => {
		if (err.code === "EADDRINUSE") {
			if (!warned) {
				console.log(`[proxy-gateway] Port ${config.port} owned by another pi instance; standing by.`);
				warned = true;
			}
			if (!stopped) {
				retryTimer = setTimeout(tryListen, RETRY_MS);
				retryTimer.unref?.();
			}
		} else {
			console.error(`[proxy-gateway] Server error: ${err.message}`);
		}
	});

	tryListen();

	// Capture model registry on session start
	pi.on("session_start", async (_event, ctx) => {
		modelRegistry = ctx.modelRegistry;
		console.log(`[proxy-gateway] Model registry loaded, ${(modelRegistry.getAvailable() as Model<Api>[]).length} models available`);
	});

	// Shutdown server on exit
	pi.on("session_shutdown", async () => {
		stopped = true;
		if (retryTimer) clearTimeout(retryTimer);
		if (listening) {
			server.close();
			console.log(`[proxy-gateway] Server stopped`);
		}
	});

	// Register status command
	pi.registerCommand("proxy-status", {
		description: "Show model proxy status",
		handler: async (_args, ctx) => {
			const models = modelRegistry?.getAvailable() as Model<Api>[] | undefined;
			const lines = [
				`Model Proxy Status`,
				`  Server: http://${config.host || "127.0.0.1"}:${config.port} (${listening ? "this instance owns the port" : "standing by, another instance owns the port"})`,
				`  Models: ${models?.length ?? "loading..."}`,
			];
			if (config.defaultModel) {
				lines.push(`  Default: ${config.defaultModel}`);
			}
			if (config.apiKey) {
				lines.push(`  Auth: API key required`);
			}
			if (config.aliases && Object.keys(config.aliases).length > 0) {
				lines.push(`  Aliases: ${Object.entries(config.aliases).map(([k, v]) => `${k} → ${v}`).join(", ")}`);
			}
			if (config.rateLimit) {
				lines.push(`  Rate limit: ${config.rateLimit} req/min`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
