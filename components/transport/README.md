# transport

**Phase:** 2 · **Milestone:** field collection · **Status:** placeholder

Reliable delivery of packed captures from the page to a server. Distinct from [`capture`](../capture) (which measures) — this is about *getting the bytes out* without losing data or harming the page.

## Responsibilities

- Beacon captures using `navigator.sendBeacon` / `fetch(..., { keepalive: true })` with the right page-lifecycle integration (`visibilitychange`, `pagehide`, bfcache).
- Batch, retry, and compress; respect the capture's size budget.
- Account for browser keepalive/sendBeacon queued-body limits (64 KiB in current specs/docs) by chunking/incrementally sending where possible and recording size-driven truncation when not.
- Degrade safely on flaky networks; never block unload.

## Notes

- In the v0 local loop the [`extension`](../extension) just saves files — no transport. This component is for real field collection feeding [`server`](../server).
- Pairs with the Phase 2 dynamic capture-config (the server may tune what/when to send).

Detailed design deferred to its phase — see [docs/Architecture.md](docs/Architecture.md).
