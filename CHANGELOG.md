# changelog

## 0.3.1

- package metadata: `engines.node` is `>=22.19.0`, the same range pi supports
- the README's development steps no longer need `--legacy-peer-deps`
- CI and releases build on Node 24 (npm 11); a release skips publishing if that version is already on npm

no code changes since 0.3.0.

## 0.3.0

first release as `pi-proxy-gateway`. forked from pi-model-proxy 0.2.0.

- reasoning effort is passed to the model (OpenAI `reasoning_effort` and `reasoning.effort`, Anthropic `output_config.effort` and `thinking`)
- `max_completion_tokens`, `top_p`, `stop`, `seed`, penalties and `tool_choice` are passed through
- requests go through pi's model registry, so extension-registered providers and logins work
- usage counts cached tokens in `prompt_tokens` and reports `cached_tokens`, `reasoning_tokens` and cost
- `stream_options.include_usage: false` is respected
- provider errors appear in the stream instead of ending it silently
- non-streaming responses include `reasoning_content`
- `X-OpenWebUI-Chat-Id` or `X-Session-Id` is used as the session id for prompt caching
- loads automatically: added the `pi.extensions` manifest
- uses the `@earendil-works` pi packages
- default request timeout raised from 2 to 30 minutes
- new `host` option; binds to `127.0.0.1` by default (pi-model-proxy listened on every interface)
- when several pi instances run, the others wait and take over the port if the owner exits
- config moved to `~/.pi/proxy-gateway.json` (the old file is copied over) and the log to `~/.pi/proxy-gateway-log.jsonl`
