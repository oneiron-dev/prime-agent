# pa-ai

Provider APIs and model registry.

## Scope
Provider trait + per-provider streaming clients (anthropic, openai-completions/responses, google, bedrock, mistral, azure, prime-inference), model registry/resolution, usage accounting, stream-failure retry, provider-error shapes (per-SDK user-facing texts, diagnostic error names, connection-error profiles), bedrock transport selection (h2c prior-knowledge HTTP/2 cleartext, h2-preferred TLS ALPN, the http1 AWS_BEDROCK_FORCE_HTTP1/proxy mode), the Responses WebSocket transport (generic `openai-responses` and Codex: per-session socket reuse, delta continuation, structured transport failures), overflow handling, JSON repair parsing, faux provider for tests.

## Non-goals
No agent loop, no tool execution, no session state, no UI. Receives/returns `pa-types` messages.
The WebSocket connection cache keyed by session id is provider connection state (sockets,
continuation anchors, in-flight request ownership), not session-engine state: the session engine
owns the session and tells pa-ai when to release it.

## Public API
`Provider` trait, `ProviderRegistry`, model lookup/resolution, faux provider,
`cleanup_session_resources(session_id)` (release a session's WebSocket connections and cancel its
in-flight requests as disposed), and behind the `test-support` feature `test_support` (the scripted
loopback Responses server, for crates that drive the WebSocket transport end to end in their tests).
`utils::stream_failure::ProviderWsTransportError` carries transport classification separately
from diagnostic identity: `sdk_name` preserves an optional provider runtime name, and
`error_name()` borrows it as `&str`. Codex retains its numeric close code; generic Responses
keeps its existing transport diagnostic shape. These are Rust API fields, not new wire fields.
`StreamFailureKind::ConnectionLimit` is a public enum addition, serialized as
`connection_limit`. The generic Responses parser recognizes only the exact structured
`websocket_connection_limit_reached` code, retaining the separate code, supplied status,
and redacted diagnostic. WebSocket failures emit the normal Start/Error lifecycle and
return immediately; pa-ai never replays a cap in the same invocation or falls back to SSE
for that verdict. The session engine owns the bounded refresh and partial rollback.
Generic cached idle sockets rotate on acquisition at 55 minutes; busy responses are never
closed by this age check. Generic pre-event network fallback and Codex SSE behavior stay
unchanged. No helper API or dependency is added.
Per-provider internals are `pub(crate)`.

## Depends on
pa-types (one-way).
