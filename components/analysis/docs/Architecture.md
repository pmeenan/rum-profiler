# analysis — Architecture (draft)

> Placeholder; fleshed out in Phase 1. Project context: [../../../docs/Architecture.md](../../../docs/Architecture.md).

## Direction

- Input: an unpacked `.rcap` ([`format`](../../format)).
- A library of pure functions, one per metric/attribution, each declaring which streams it needs and returning `value | unknown` with provenance.
- Emergent/cross-stream analyses (idle windows, LCP-blocking) operate on the merged timeline.

## Open questions

- Split of derivations between this component and Perfetto SQL on the transcoded trace.
- Representation of "unknown" results and how they propagate into [`aggregate`](../../aggregate).
- Stable metric IDs/versioning so aggregates stay comparable over time.
