# symbolication — Architecture (draft)

> Placeholder; fleshed out in Phase 1. Project context: [../../../docs/Architecture.md](../../../docs/Architecture.md).

## Direction

- Input: a capture's profile stream (raw frames) + access to source maps.
- Output: a frame-name resolution table the transcoder/analysis can apply.
- Two modes: source-map resolution; fallback prettification of minified code.
- Redacted/omitted frames are first-class. They remain unresolved with provenance rather than being guessed from neighboring frames or bundles.

## Open questions

- Source-map acquisition (bundled, fetched, uploaded by the app owner) and caching.
- Client-side vs. server-side execution per deployment and the privacy trade-offs.
- License check on any beautifier/source-map dependency (Apache-2-or-looser).
