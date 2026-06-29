# rum-profiler — Plan

> Project-wide, phased build plan. Component-level detail lives in each `components/<name>/`. Architecture context: [Architecture.md](Architecture.md).

## Phasing overview

| Phase | Theme | Components | Outcome |
|---|---|---|---|
| **0** | Foundations | format, capture (MVP) | A packed capture exists and round-trips |
| **1** | Local loop (v0) | extension, transcode, viewer, analysis, symbolication | Capture any site → save → view in Perfetto, with derived metrics |
| **2** | Field collection | transport, server, (dynamic config) | Beacon real captures to a reference server with dynamic capture config |
| **3** | Aggregate | aggregate | Live dashboards over collected data |

The **Phase 1 milestone is the first shippable product**: a Chrome extension that captures deep performance data on any production page, saves it, and opens it in Perfetto — with no backend.

---

## Phase 0 — Foundations

**Goal:** lock the data model and prove it round-trips.

- `format`: define the stream schemas, the manifest (present/absent + reason, loss, provenance), versioning rules, and the binary codec (pack/unpack). Optimize for size (interning, delta encoding) and keep the pack path compatible with incremental/off-main-thread serialization so unload is not where heavy work happens.
- `format`: define the **capture-config** schema (also the future dynamic-config schema).
- `format`: build a **golden corpus**, including deliberately *partial* captures (Safari-subset, no-profiler, no-resource-timing, buffer-overflowed) so degradation is tested, not hoped for.
- `capture` (MVP): place the cheap, widely-available raw streams (navigation/resource/paint, LCP/CLS/Event Timing entries with live attribution, long tasks/LoAF) on one clock and emit the in-memory model the format packs. Derived CWV metrics live in `analysis`. Include a tiny app-signal API for explicit SPA/router boundary marks rather than depending solely on experimental soft-navigation heuristics.

**Progress (2026-06-28):** npm + TypeScript workspace scaffolded (vitest, ESLint flat config, `tsc -b` project refs). `format` in-memory model, manifest, and capture-config drafted and grounded in a real Chrome-149 capture corpus ([`components/format/samples`](../components/format/samples)). **Binary codec (`pack`/`unpack`) implemented** — compact (descriptor-driven encode/decode, string interning, varints, fixed-point-µs timestamps, presence-bitmap optionals, gzip) and lossless to 1µs on timeline values / exact otherwise: it round-trips the golden corpus ([`components/format/test/fixtures.ts`](../components/format/test/fixtures.ts)) **including the degraded/partial captures**, so the Phase-0 exit criterion is met. `.rcap` file format (magic `F5 52 55 4D`, `CODEC_VERSION` distinct from `FORMAT_VERSION`) is specified in [`components/format`](../components/format). Lint/build/tests green. **Profiler stream grounded (2026-06-29):** the sample corpus was re-captured with a real JS Self-Profiling trace on all four pages (driver injects `Document-Policy: js-profiling` via CDP), plus a **6× CPU-throttled worst-case set** — confirming the model's shape and the platform facts that Chrome 149 **floors `sampleInterval` at 10ms** and emits **duplicate-timestamp samples** under load. **Profile slice codec implemented (2026-06-29):** the wire moved from raw per-sample to the derived nested-slice (call-tree) model — `samples → slices` transform ([`profile-slices.ts`](../components/format/src/profile-slices.ts), incremental `SliceBuilder` = the capture→wire seam) + columnar slice codec, validated by corpus replay (transform → pack → unpack) and incremental-equals-one-shot. **Next:** the `capture` MVP (browser perf APIs → Capture model; profiler lifecycle = the remaining glue that drives `SliceBuilder`).

**Exit criteria:** capture → pack → unpack → equality on the golden corpus, including partial captures ✅; format spec drafted and versioned ✅. *(Remaining Phase-0 item: the `capture` MVP that produces the in-memory model.)*

## Phase 1 — Local loop (v0)

**Goal:** the server-less product loop.

- `extension`: act as a harness: inject the capture library and the Document Policy needed for JS self-profiling into live pages; collect the page-produced capture on lifecycle; save `.rcap` files. Set the `Document-Policy: js-profiling` response header the API requires, and confirm current (Chromium-only) browser support before relying on it. Do not use extension-only APIs such as `webRequest` as measurement sources. Surface a default capture-config.
- `capture`: add the expensive/conditional streams — JS self-profiling — under the overhead budget and config gating.
- `transcode`: `.rcap` → Perfetto protobuf. Start with slices/tracks (timeline); the **profile-slice track** rides the same slice path (flamegraph via Perfetto aggregation), then add **counter tracks**. This is the main net-new engineering — includes a varint encoder + TracePacket builder, validated by loading/parsing generated protobuf traces with Perfetto tooling.
- `viewer`: embed `ui.perfetto.dev`; load a `.rcap`, transcode in-browser, hand the buffer to Perfetto. Local-only.
- `analysis`: derive CWV + attribution + emergent metrics (idle/schedulable windows) from the timeline; expose as queries.
- `symbolication`: resolve profiler frames through source maps; prettify minified code.

**Exit criteria:** install extension → visit any site → save a capture → open it in the viewer and see the correlated timeline + flamegraph + derived metrics.

## Phase 2 — Field collection

**Goal:** collect at scale, reliably, with server-driven targeting.

- `transport`: reliable beaconing (sendBeacon / fetch keepalive), page-lifecycle integration, batching, retry, compression. Design around browser keepalive/sendBeacon queued-body limits (64 KiB in current specs/docs) with incremental delivery and size-gated degradation instead of waiting until unload with an oversized payload.
- `server`: reference ingest endpoint; decode/validate; store; basic processing. Server-side symbolication pipeline.
- Dynamic capture-config: the server delivers a capture-config (Phase 0 schema) to target "interesting" sessions/events; a thin config-client in `capture` consumes it.

**Exit criteria:** a deployed reference server receiving, validating, and storing real captures driven by remote config.

## Phase 3 — Aggregate

**Goal:** make the collected corpus answerable in aggregate.

- `aggregate`: live dashboards and aggregate queries over many captures, preserving the "unknown vs. zero" and provenance semantics so cross-browser coverage differences don't distort stats.

**Exit criteria:** aggregate views (distributions, attribution rollups) over a real dataset.

---

## Cross-cutting tracks (every phase)

- **Privacy:** redaction policies, consent gating, cross-origin symbol limits.
- **Overhead:** capture CPU/byte budget + self-measurement, validated continuously.
- **Browser support matrix:** kept current; drives degradation and provenance.
- **Docs:** keep `docs/` and each component's docs in step with the code (see [AGENTS.md](../AGENTS.md)).

## Open decisions

- **Monorepo tooling:** ✅ Resolved — **npm workspaces** (TypeScript, ESLint flat config, vitest; `tsc -b` project refs). A `package.json` is added per component as it gains code.
- **Language:** ✅ Resolved — **TypeScript** (strict, NodeNext, `verbatimModuleSyntax`) across the shared schema.
- **Layout:** ✅ Resolved — `components/<name>/` grouping (current).
- **Test runner:** ✅ Resolved — **vitest** (matches the sibling project).
- **Canonical file extension / magic bytes:** ✅ Resolved — extension **`.rcap`**, magic **`F5 52 55 4D`** (`\xF5RUM`; `0xF5` is an always-invalid UTF-8 lead byte → unmistakably binary). Wire encoding carries its own **`CODEC_VERSION`**, separate from the schema **`FORMAT_VERSION`**.
- **Codec substrate / compression:** ✅ Resolved — hand-rolled varint writer (zero runtime deps); **gzip** outer pass applied after string interning.
- **Timestamp precision:** ✅ Resolved — timeline values stored as **fixed-point 1µs** (zigzag varint), lossless vs. the browser's ≤5µs real `DOMHighResTimeStamp` resolution; the profiler stream uses a columnar slice encoding (frameId, zigzag-delta depth, start-delta µs, duration columns). **One exception:** inferred slice **durations** are stored at **1ms**, not 1µs — they're only ±1-interval accurate, so µs would be false precision (and ~3 bytes/slice → ~1). `EpochMs` and true floats stay f64.
- **License nuance:** ✅ Resolved — policy is **product vs. tooling** (see [AGENTS.md](../AGENTS.md)): product code is permissive-only (allowed as a category, not a fixed list); non-shipping dev/build tooling may use weak/file-level copyleft that can't leak (e.g. MPL-2.0 `lightningcss` via Vite/Vitest). Strong copyleft (GPL/AGPL/LGPL) remains a human call.
- **Soft navigations:** how aggressively to support the (still-experimental) SPA boundary signal in v0.
- **JS self-profiling overhead tuning:** the enabling header is fixed (`Document-Policy: js-profiling`); the open question is the overhead budget — `sampleInterval` / `maxBufferSize` and when to enable profiling (always-sampled vs. triggered) — tuned against measured cost and current (Chromium-only) support. **Grounded (2026-06-29):** Chrome 149 **floors `sampleInterval` at 10ms** and quantizes to multiples of 10 (requested 2/4/8 all deliver 10; 16→20), so requesting below 10 is pointless — the budget knob is really `maxBufferSize` + trigger policy, not sub-10ms intervals.
- **Profiler representation (wire format) — ✅ done → slices (implemented 2026-06-29).** The `.rcap` profile stream is a **nested timed-slice (call-tree)** that coalesces each **contiguous run spanning at least ~1 sample interval** into one `{frameId, depth, start, duration}` slice and **drops anything shorter** — single samples, duplicate-timestamp clusters, and the microsecond-spaced bursts Chrome emits as a deep recursion unwinds (≈14% of v0's samples share an exact timestamp on its 5µs cross-origin-isolated grid; a count-based "≥2 samples" rule would keep that sub-resolution noise, so the prune is a **fixed floor of ~1 interval** — `duration >= 0.8 × sampleInterval`, **jitter-tolerant**: under CPU throttling the real cadence drops to ~8ms (corpus: 22–43% of 6×-throttled deltas land in [8,10)ms), so a strict `>= interval` would wrongly prune genuine ≥2-sample runs — 0.8× recovers them, the [5,8)ms band being near-empty; not a knob). The raw interned frames/stacks + per-sample `samples` (the API output) are kept **only in the test corpus** (`samples/json/*`), never in the wire — minimizing payload is the point. Grounded on the 2026-06-29 corpus, slices are **3–14× smaller (gzipped)** and surface only the "slow" operations (the per-sample form's interned `stacks` table dominates — v0.app: ~9,200 stacks → a ~1MB file). **Framing that settles most sub-questions (decided):** this is a **main-thread-blocking / responsiveness** view, *not* CPU-time accounting — a single-sample run is yield-bounded on at least one side, so it cannot be a block; **contiguity is the blocking signal**. Consequences: **no per-slice or per-frame sample weight** (kept-slice durations + nesting are self-describing; a parent's interior "negative space" = self-time + dropped sub-interval runs reads honestly as "block not in a long-enough child"; scattered short "cuts" are out of scope by design — record only an aggregate `droppedSamples` count for honesty). **Where/when the transform runs (decided):** `.rcap` stores **slices**, not samples. Capture holds raw samples in memory only while running and folds them into slices **incrementally, at safe checkpoints** — finalize settled/past slices and hold the still-open tail ("as soon as it makes sense and we aren't likely to lose data") — so the heavy work is spread across the session and the unload path flushes only the small remainder (honors "no unload serialization cliff"). The pure `samples → slices` transform lives in `format`; the raw per-sample API output is **test corpus only**, never shipped. Consequences: the profile wire schema is slice-based (no `FORMAT_VERSION` bump — nothing consumes the codec yet); a shipped `.rcap` can no longer feed Perfetto's *native* sampled-callstack flamegraph (slices still render on the thread track, and Perfetto can aggregate a slice selection into a flame graph) and can't be re-thresholded after the fact (only an aggregate `droppedSamples` survives) — both acceptable given the size goal and the responsiveness framing. **Implemented** in [`profile-slices.ts`](../components/format/src/profile-slices.ts) (`SliceBuilder` incremental folder + one-shot `samplesToSlices`) with the columnar slice codec; tested by slice round-trip, full corpus replay (transform → pack → unpack), and incremental-equals-one-shot. Still to settle: the on-page folding mechanism (periodic `stop()`/restart at idle checkpoints vs. one stop) is the remaining `capture` (Phase 1) glue; durations stay **sample-inferred (±1 interval), not measured** → mark provenance, never conflate with measured LoAF/Event-Timing. Alignments: gaps between slices + idle samples give the **idle/schedulable-window** view for free; a kept contiguous slice ≥50ms *is* a long task / LoAF script span, now with its callstack. Perfetto note: slices render inline on the thread track, correlated with LoAF/INP (flamegraph via slice aggregation, not a native sample profile). Human call — affects the on-page budget and the wire format. See [`components/format/src/streams/profile.ts`](../components/format/src/streams/profile.ts).
- **Multi-context capture:** whether/when to capture same-origin iframes, dedicated workers, shared workers, or service workers. If included, define explicit clock-alignment handshakes and degradation rules before adding those streams.
