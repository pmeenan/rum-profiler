# symbolication

**Phase:** 1 · **Milestone:** v0 · **Status:** placeholder

Resolves JS self-profiling frames (script URL + line:col against minified code) into readable function names via source maps, and prettifies/beautifies code where maps are absent.

## Responsibilities

- Fetch/consume source maps and resolve sampled frames to original names/locations.
- Prettify minified frames when no source map is available, so flamegraphs are still legible.
- Run as a separate step (client-side in v0 tooling; server-side in Phase 2 for field data) so the hot capture path stays cheap.

## Notes

- [`capture`](../capture) intentionally emits **unsymbolicated** frames; this component is the resolver.
- Cross-origin or CORS-redacted profiler frames may be absent/opaque by design. Preserve that absence; do not invent source locations during resolution.
- Feeds readable frames to [`transcode`](../transcode) (leaning toward symbolicate-then-transcode) and/or [`analysis`](../analysis).
- Privacy: original source paths/names can be sensitive — resolution may need to stay within a trust boundary (e.g. server-side only) for some users.

Detailed design deferred to its phase — see [docs/Architecture.md](docs/Architecture.md).
