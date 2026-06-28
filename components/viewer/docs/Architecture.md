# viewer — Architecture

> Component design. Project context: [../../../docs/Architecture.md](../../../docs/Architecture.md).

## Flow

```
.rumcap (file or from extension)
        │
        ▼
transcode → Perfetto protobuf (ArrayBuffer)   [run in a worker for large captures]
        │
        ▼
embed ui.perfetto.dev (iframe)
        │
        ▼
postMessage handshake (PING/PONG) → send { perfetto: { buffer, title } }
        │
        ▼
Perfetto renders locally in-browser (no upload)
```

## Embedding

Mirrors the waterfall-tools approach as a reference: load the Perfetto UI in an iframe, wait for its readiness ping, then post the trace `ArrayBuffer`. Trace processing happens client-side in Perfetto's WASM `trace_processor`, so the viewer does not upload the capture.

Trust boundary: when using hosted `ui.perfetto.dev`, the embedded Perfetto instance is trusted third-party-origin code and receives the trace bytes via `postMessage`. This is acceptable for v0's local viewer, but stricter deployments can self-host a pinned Perfetto UI build.

For zero external dependency (or stricter environments), the Perfetto UI is static and can be self-hosted; the same postMessage contract applies.

## Privacy

Captures can come from authenticated production pages. Because Perfetto processes locally, viewing uploads nothing by default, but the trace is still exposed to the embedded Perfetto origin. Avoid Perfetto's "share/permalink" feature, which *does* upload — or disable/hide it in a self-hosted build.

## Open questions

- Hosted vs. self-hosted Perfetto UI default.
- Worker-based transcode + streaming for large captures.
- Overlaying `analysis` metrics (annotations/markers) on the Perfetto timeline.
