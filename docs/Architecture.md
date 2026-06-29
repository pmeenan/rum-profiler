# rum-profiler — Architecture

> Project-wide architecture. Each component refines its own design in `components/<name>/docs/Architecture.md`. This document is the contract between them.

## 1. Goal

Capture deep, real-user performance data from production web pages and make it answerable. "Deep" means: not just metrics, but a correlated, per-session **profile** that explains them. Broad metric coverage and deep profiling are **co-equal** — they are two views of one data model.

The questions we want a single captured sample to answer:

- What blocked LCP (TTFB vs. resource load vs. render delay vs. main-thread contention)?
- What did hydration cost, and what ran during it?
- Where are the windows where both the network and the main thread were idle — i.e. where deferred work could have been scheduled?
- What ran during the interaction that produced a slow INP?

None of these come from a single API. They come from putting every signal on one timeline and querying it.

## 2. Principles

1. **One correlated timeline.** All signals are placed on a single high-resolution clock (`performance.timeOrigin` based). Correlation is the core value and the hard part.
2. **Metrics are derived, not separate.** CWV and attribution are computed from the same raw entries that feed the profile. Some attribution that references ephemeral DOM state (LCP element, CLS sources, INP target) must be captured *live*; the rest is derived offline.
3. **Robust to missing data.** Every signal is an optional, independently-degradable stream. The format self-describes what is present and *why* anything is absent. Consumers degrade gracefully and never confuse "unknown" with "zero."
4. **Local-first.** The v0 product is fully client-side: capture in the page, pack to a file, view via embedded Perfetto. No server required.
5. **Tiny and self-measuring.** The capture library is zero-dependency and tree-shakeable, and it measures its own CPU/byte overhead.
6. **Privacy-first.** URLs and stack frames may carry PII. Redaction is part of capture and format design.
7. **Open, versioned format.** The compact format is specified and versioned so it survives browser-API churn and third-party adoption.
8. **Independent components.** Components integrate only through published interfaces and the shared `format`.
9. **Browser APIs are the measurement boundary.** The extension is a harness for injecting the client libraries, enabling required headers, saving captures, and opening the viewer. It must not provide measurement data through extension-only APIs such as `webRequest`; the capture itself comes 100% from browser APIs available to page code.

## 3. The data model

A capture is a set of **streams** sharing one time base, plus a **manifest** describing them.

### Streams (all optional)

- **Document / navigation** — Navigation Timing, page lifecycle state, bfcache restores, soft-navigation boundaries (native signals when available, plus explicit app/router marks when provided).
- **Resources** — Resource Timing entries with sub-phases (queueing, DNS, connect, TLS, TTFB, download), Server-Timing, initiator info where available.
- **Rendering & layout** — Paint Timing (FP/FCP), LCP (+ sub-parts and element attribution), Layout Instability (CLS + shift sources), Element Timing.
- **Interactivity** — Event Timing / INP, Long Tasks, Long Animation Frames (LoAF) with scripts/attribution.
- **Profile** — JS self-profiling, stored as derived nested timed **slices** (a call-tree folded from the raw samples — see [`format`](../components/format); requires the `Document-Policy: js-profiling` response header; Chromium-only today, so confirm current browser support before relying on it).
- **App signals** — User Timing marks/measures, custom app/framework instrumentation, JS errors.
- **Environment** — UA Client Hints, device memory / hardware concurrency, network information, memory measurement — for segmentation.

### Manifest

Every packed capture begins with a manifest declaring the timeline clock metadata (`performance.timeOrigin`, capture start/end, timestamp unit/base and precision), and per stream: present or absent; schema version; and if absent, **why** — `unsupported` (browser lacks the API), `not-requested` (capture config excluded it), `dropped` (overhead/sampling budget), or `policy-blocked` (e.g. missing Document Policy). The manifest also records **loss/truncation** within present streams (e.g. "resource buffer overflowed at T, N entries dropped") and per-value **provenance** (which API/browser produced it).

### Derived vs. live-captured

| Output | When computed |
|---|---|
| TTFB, FCP, LCP time, CLS score, INP value | Derivable offline from raw entries |
| LCP element identity, CLS shift sources, INP interaction target | Must be captured **live** (references ephemeral DOM) |
| Idle-window / schedulability analysis | Derived offline by intersecting busy intervals across streams |

## 4. Data flow

```
            ┌─────────── in the page ───────────┐
  browser   │  capture  ──►  in-memory timeline  │
  perf APIs │     │                              │
            │     ▼                              │
            │  format (pack)  ──►  .rcap file  │   canonical, compact, self-describing
            └─────────────────┬──────────────────┘
                              │
        ┌─────────────────────┼───────────────────────────────┐
        ▼                     ▼                                ▼
   transcode            analysis                        symbolication
   (→ Perfetto       (metrics & attribution        (source maps → readable
    protobuf:         from the timeline)             profiler frames)
    timeline +             │                                │
    profile +              ▼                                ▼
    counters)        metrics / queries              symbolicated profile
        │
        ▼
   viewer (embedded Perfetto UI, local)
```

- **Canonical artifact:** the packed `.rcap` file (magic `F5 52 55 4D`). It is what gets saved, transported, and stored.
- **Perfetto is a transcode target, not the canonical store.** We keep our own compact format for wire size and control, and transcode to Perfetto for viewing.
- **v0 injector/saver:** the extension is only a harness: it injects capture + format, enables required response headers, writes `.rcap` files, and can hand them to the viewer. It does not collect performance data through extension-only mechanisms.

## 5. Viewing strategy

Per-sample viewing leans on **Perfetto**:

- Slices/tracks for nav phases, resources (nested async sub-phases), long tasks, LoAF, user timing.
- **Profile slices** for the JS self-profile → nested on the main-thread track, inline with long tasks/LoAF; a flamegraph comes from Perfetto aggregating the slice track (the slice wire model trades the *native* sampled-callstack profile for inline-with-the-timeline correlation).
- **Counter tracks** for in-flight requests, CLS-over-time, memory.
- **Flow arrows** connecting interaction → LoAF → paint for INP stories.
- Perfetto's **SQL trace_processor** doubles as a metrics/analysis surface — directly serving the "metrics and profile inform each other" goal.

We emit the **Perfetto protobuf** (not legacy Chrome JSON) because it carries counter tracks and interned track events (frames/strings) compactly — and the dense profile-slice track leans on that interning. The viewer embeds `ui.perfetto.dev` via postMessage and hands over an ArrayBuffer; processing stays local in-browser. Trust boundary: the embedded `ui.perfetto.dev` instance is trusted third-party-origin code for v0 viewing, and it receives the trace bytes even though it does not upload them. The [waterfall-tools](https://github.com/pmeenan/waterfall-tools) embedding flow is our reference for this.

Perfetto is the *per-sample* viewer only. Aggregate viewing (`components/aggregate`) is a separate build. A bespoke resource-waterfall view may be added later if Perfetto's is insufficient.

## 6. Capture configuration

Capture is driven by a declarative **capture-config**: which streams to attempt, sampling rates, profiler interval, and size/overhead budgets. In the v0 local loop this is a local default baked into the extension. In Phase 2 the same schema is delivered dynamically by the server to target "interesting" sessions/events — so the v0 config object *is* the Phase 2 dynamic-config object, sourced differently. The schema lives in `components/format`.

## 7. Cross-cutting concerns

- **Privacy / PII:** URL and stack-frame redaction policies; consent gating; self-profiling's cross-origin symbol limits.
- **Overhead:** a hard budget on capture CPU + bytes; the capture library self-measures and records its own cost into the capture.
- **Browser support matrix:** which APIs exist where; drives the degradation paths and provenance.
- **Time base:** a single `timeOrigin`-anchored clock; reconciling the different observers' timestamps is a first-class capture responsibility. If a future stream captures workers or frames, each execution context's own `performance.timeOrigin` must be recorded and mapped onto the page timeline through an explicit handshake. Epoch-clock values are metadata only; monotonic offsets drive ordering so NTP/system-clock changes cannot bend the timeline.
- **Loss & truncation:** buffer-full handling (resource timing), profiler sample budgets, LoAF's >50ms threshold — all recorded, never silently dropped.
- **Extension boundary:** extension APIs may support harness tasks (script/header injection, UI, saving/opening files), but never replace page-visible performance APIs as the measurement source.
- **Unload path:** final page-lifecycle work must be cheap. Packing, interning, compression, and transport preparation should happen incrementally or off-main-thread where possible; unload/pagehide should mostly flush already-prepared bytes and metadata.

## 8. Components

See each component's folder for detail. Dependencies flow roughly left-to-right:

`capture` → `format` → (`transcode` → `viewer`) / `analysis` / `symbolication` → `transport` → `server` → `aggregate`

Independence is enforced through the `format` contract. See [Plan.md](Plan.md) for phasing.

## 9. Reference, not dependency

[waterfall-tools](https://github.com/pmeenan/waterfall-tools) informs our Perfetto embedding and protobuf wire handling. It is read-only reference material; `rum-profiler` stays independent.
