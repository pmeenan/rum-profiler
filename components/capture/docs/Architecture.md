# capture — Architecture

> Component design. Project context: [../../../docs/Architecture.md](../../../docs/Architecture.md).

## Shape

A small core plus one module per stream, so consumers ship only what they enable:

```
capture/
  core/        clock, scheduler, overhead meter, manifest builder, config
  streams/     navigation, resources, paint, lcp, cls, inp, longtasks, loaf,
               profiler, usertiming, environment, errors
```

Each stream module is independently importable and independently degradable. The core never assumes a stream loaded successfully.

## The clock

All entries are normalized to a single high-resolution timeline anchored at `performance.timeOrigin`. Reconciling timestamps across observers (which report in different bases/epochs) is this component's core responsibility and the foundation everything downstream relies on.

Ordering must use monotonic offsets, never `Date.now()` thresholds or other epoch-clock guesses. If capture later includes same-origin iframes or workers, each execution context's independent `performance.timeOrigin` is recorded and mapped onto the page clock through an explicit handshake; unsupported or cross-origin contexts stay absent with provenance.

## Streams as a contract

Every stream module implements a common shape: `start(config)`, `stop()`, and `collect()` returning `{ data, status, provenance }` where `status` is one of `present | unsupported | not-requested | dropped | policy-blocked` and carries any loss/truncation note. The core assembles these into the format's manifest — absence is data, not silence.

## Live attribution

Some signals must be read while the DOM context still exists:

- **LCP element** — identity/selector of the largest paint.
- **CLS sources** — the nodes that shifted.
- **INP target** — the element and event behind the worst interaction, joined to its LoAF.

These are captured eagerly; everything else (raw timings) is left for offline derivation in [`analysis`](../../analysis).

Explicit app/router marks are also live signals. A tiny public API should let SPAs mark route boundaries even when native soft-navigation signals are unavailable or too experimental, without depending on any framework.

## Overhead budget

The capture library measures its own cost (main-thread time via its own marks, approximate bytes) and writes it into the capture so overhead is observable in the very tool that measures performance. Streams yield to a scheduler that respects the configured budget; exceeding it downgrades a stream to `dropped` rather than distorting the page. Final lifecycle work should be a cheap flush; string interning, serialization preparation, and compression must happen incrementally or off-main-thread where practical.

## Profiler

JS self-profiling is the most expensive stream and needs the `Document-Policy: js-profiling` response header (injected by the [`extension`](../../extension) in v0) and is Chromium-only today; confirm current support before relying on it, and keep overhead down via `sampleInterval` / `maxBufferSize` and conditional/sampled enablement rather than profiling continuously. It is config-gated and sampled. Output is sampled stacks (script URL + line:col) left **unsymbolicated** here; [`symbolication`](../../symbolication) resolves them later. Sample budget overruns are recorded as truncation.

The profiler API can omit CORS-cross-origin frames and cross-origin execution contexts. Treat missing/opaque frames as platform redaction, preserve what the browser actually returned, and keep flamegraph/transcode paths robust to skipped stack frames; never synthesize a frame to make a stack look complete.

## Open questions

- Exact overhead budget and enforcement strategy.
- Triggering model for expensive streams (random sample vs. "interesting event" — the latter foreshadows Phase 2 dynamic config).
- Soft-navigation support and how SPA boundaries segment the timeline.
- Worker/frame capture scope and clock-alignment handshake.
