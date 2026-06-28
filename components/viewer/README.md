# viewer

**Phase:** 1 · **Milestone:** v0 · **Status:** design

A thin, local viewer for a single captured sample. It does **not** render its own timeline — it transcodes a capture to Perfetto and embeds the Perfetto UI, which developers already know.

## Responsibilities

- Load a `.rumcap` file (from disk or handed over by the [`extension`](../extension)).
- Transcode it in-browser via [`transcode`](../transcode) to Perfetto protobuf.
- Embed `ui.perfetto.dev` and hand over the trace as an ArrayBuffer (postMessage); processing stays local, and the embedded Perfetto UI is trusted to receive the capture bytes.
- Optionally surface [`analysis`](../analysis) metrics alongside the trace.

## Why Perfetto, not a custom renderer

Perfetto already gives us slices, flamegraphs (sampled callstacks), counter tracks, flow arrows, and a SQL query engine — the exact surface our data needs, in a tool developers are fluent in. Building a bespoke timeline renderer would duplicate it for less. The embedding pattern in [waterfall-tools](https://github.com/pmeenan/waterfall-tools) (postMessage ping-pong + ArrayBuffer to `ui.perfetto.dev`) is our **reference** (not a dependency).

## Scope boundary

- **Per-sample only.** Aggregate viewing is a separate component ([`aggregate`](../aggregate), Phase 3).
- A bespoke **resource-waterfall** view may be added later if Perfetto's request view proves insufficient.

## Inputs / outputs

- **In:** a `.rumcap` capture.
- **Out:** an interactive Perfetto view, local in the browser.

## Key open questions

- Embed hosted `ui.perfetto.dev` vs. self-host the (static) Perfetto UI for zero external dependency / stricter privacy.
- Where transcode runs (worker vs. main thread) for large captures.
- How/whether to overlay our derived metrics on the Perfetto timeline.

See [docs/Architecture.md](docs/Architecture.md).
