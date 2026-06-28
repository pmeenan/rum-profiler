# transport — Architecture (draft)

> Placeholder; fleshed out in Phase 2. Project context: [../../../docs/Architecture.md](../../../docs/Architecture.md).

## Direction

- Hook page-lifecycle transitions to flush a packed capture exactly once.
- Prefer `sendBeacon`; fall back to `fetch` keepalive; queue + retry for failures.
- Optional batching across soft navigations within a session.
- Do not assume unload can carry a full profile: keepalive/sendBeacon payloads are constrained by a small queued-body budget, so large profiles need periodic/incremental delivery or size-gated truncation with recorded loss.

## Open questions

- Delivery guarantees vs. page-unload constraints (payload size limits on sendBeacon).
- Session stitching across navigations.
- Compression negotiation with [`server`](../../server).
- Chunking/session-resume protocol for profile streams that exceed the keepalive budget.
