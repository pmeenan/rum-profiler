# capture

**Phase:** 0/1 · **Milestone:** v0 · **Status:** design

The on-page library that reads whatever browser performance APIs are available and builds a single correlated timeline, ready for [`format`](../format) to pack.

## Responsibilities

- Subscribe to the browser performance signals (Navigation/Resource/Paint/Element Timing, LCP/CLS/INP attribution, Long Tasks, LoAF, Server-Timing, JS self-profiling, User Timing, environment hints).
- Place every signal on one `timeOrigin`-anchored clock.
- Capture **live attribution** that can't be recovered later (LCP element, CLS sources, INP target).
- Expose a minimal app-signal API for marks/measures and explicit SPA/router boundaries, while staying framework-agnostic.
- Honor a declarative **capture-config**: which streams to attempt, sampling, profiler interval, overhead/size budgets.
- Degrade gracefully when a signal is unsupported, not-requested, dropped, or policy-blocked — and record *why* into the manifest.
- Measure its own CPU/byte overhead and record it into the capture.

## Non-goals

- No packing/serialization — that's [`format`](../format).
- No metric derivation beyond what must be captured live — offline metrics are [`analysis`](../analysis).
- No transport — saving/beaconing is the [`extension`](../extension) (v0 local loop) or [`transport`](../transport) (Phase 2).

## Constraints

- Zero runtime dependencies; tree-shakeable; ship only the observers in use.
- Tiny and cheap — a hard overhead budget; the library must not distort what it measures.
- Robust to partial API support across Chrome/Firefox/Safari.
- Measurement uses only browser APIs available to page code. Extension-only data sources (for example `webRequest` or extension network interception) are not inputs to capture.
- Final lifecycle handling must avoid serialization jank: do expensive preparation incrementally or off-main-thread, and record size/overhead-driven truncation instead of blocking unload.

## Inputs / outputs

- **In:** browser performance APIs; a capture-config (local default in the v0 local loop, dynamic in Phase 2).
- **Out:** an in-memory timeline model conforming to the [`format`](../format) schema.

## Key open questions

- Overhead budget targets (bytes shipped, main-thread ms) and how to enforce them.
- Self-profiling gating: when to turn it on (sampling, "interesting" triggers) given cost and the required Document Policy.
- Soft-navigation / SPA boundary handling in v0, including the shape of the explicit router-boundary API.
- Buffer management (resource timing overflow, profiler sample budget) and how loss is recorded.

See [docs/Architecture.md](docs/Architecture.md).
