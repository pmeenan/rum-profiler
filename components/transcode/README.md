# transcode

**Phase:** 1 · **Milestone:** v0 · **Status:** design

Converts a packed capture ([`format`](../format)) into the **Perfetto protobuf** trace format for viewing. This is the main net-new engineering of v0 — there is no off-the-shelf emitter for what we need.

## Responsibilities

- Map our streams onto Perfetto constructs:
  - nav phases, resources (nested async sub-phases), long tasks, LoAF, user timing → **slices/tracks**
  - JS self-profile → **native sampled callstacks** (flamegraph)
  - in-flight requests, CLS-over-time, memory → **counter tracks**
  - interaction → LoAF → paint → **flow arrows** (INP stories)
- Emit valid Perfetto protobuf: a **varint encoder** + `TracePacket` builder with **interned data**.
- Degrade with the input: missing streams simply produce fewer tracks.
- Validate emitted traces with Perfetto tooling (e.g. `trace_processor` or an equivalent parser/load test), not just byte-level unit tests.

## Why protobuf, not Chrome JSON

Only the Perfetto protobuf carries native sampled callstacks and counter tracks compactly (via interned data) — and those are our deep-profiling payoff. The legacy Chrome JSON trace format can't express them well.

## Reference

waterfall-tools has a hand-rolled, read-only Perfetto **decoder** ([decoder.js](https://github.com/pmeenan/waterfall-tools/blob/main/src/inputs/utilities/perfetto/decoder.js)). Useful as a **wire-format reference** for writing our **encoder** — but it has no write path and skips counters/samples, so the emitter (especially `SampleTree`/`CallstackSample` and counter packets) is built from scratch. Reference only; no dependency.

## Inputs / outputs

- **In:** a `.rcap` packed capture.
- **Out:** a Perfetto protobuf trace (`Uint8Array`/ArrayBuffer) for [`viewer`](../viewer) or any Perfetto UI.

## Key open questions

- Track/slice taxonomy and naming so Perfetto reads naturally.
- How symbolicated frames ([`symbolication`](../symbolication)) feed callstack samples (pre- vs. post-transcode).
- Whether to also emit an "Extended HAR"-style output for a dedicated resource-waterfall view later.

See [docs/Architecture.md](docs/Architecture.md).
