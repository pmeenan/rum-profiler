# transcode — Architecture

> Component design. Project context: [../../../docs/Architecture.md](../../../docs/Architecture.md).

## Pipeline

```
.rumcap → unpack (format) → map streams → build TracePackets → varint-encode → Perfetto protobuf
```

## Mapping (draft)

| Our stream | Perfetto construct |
|---|---|
| Navigation phases | slices on a "navigation" track |
| Resource entries | nested async slices (queue/DNS/connect/TLS/TTFB/download) per request |
| Long tasks / LoAF | slices on the main-thread track; LoAF scripts as children |
| JS self-profile | `SampleTree` / `CallstackSample` → flamegraph |
| In-flight requests, CLS, memory | counter tracks |
| Interaction → LoAF → paint | flow events (arrows) |
| User Timing marks/measures | instant/duration slices |

## The emitter

Net-new work, in layers:

1. **Varint + wire primitives** — length-delimited fields, ZigZag where needed. (waterfall-tools' reader is a reference for the inverse.)
2. **`TracePacket` builder** — track descriptors, track events (B/E/I), defaults, sequence handling.
3. **Interned data** — categories, names, and frame strings interned to keep size down (mirrors the format's own interning).
4. **Profiles** — `SampleTree`/`CallstackSample` for sampled stacks; the part nothing existing reuses.
5. **Counters** — counter descriptors + values over time.

## Build order

Timeline first (slices/tracks) to get a usable viewer quickly, then samples (flamegraph), then counters and flows. Each addition degrades cleanly when its source stream is absent.

## Validation

Every generated protobuf fixture should be parsed by Perfetto tooling (`trace_processor` CLI/WASM or an equivalent official parser) and loaded in the viewer during verification. Unit tests catch varint and builder bugs, but the acceptance test is that Perfetto accepts the trace without structural errors and renders the expected tracks/samples.

## Symbolication boundary

Frames may arrive raw (URL + line:col) or symbolicated. Decide whether transcode consumes already-symbolicated frames from [`symbolication`](../../symbolication) or emits raw frames that a Perfetto-side/source-map step resolves. Leaning toward symbolicate-then-transcode so the flamegraph is readable on load.

## Open questions

- Track taxonomy/naming conventions.
- Interning strategy shared with `format` vs. independent.
- Exact automated Perfetto validation path for CI.
- Optional Extended-HAR output for a future bespoke waterfall view.
