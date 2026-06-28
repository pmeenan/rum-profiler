# aggregate

**Phase:** 3 · **Milestone:** aggregate · **Status:** placeholder

Live aggregate views over many collected captures — distributions, attribution rollups, and trends. The counterpart to the per-sample [`viewer`](../viewer).

## Responsibilities

- Query and visualize aggregate performance across the corpus stored by [`server`](../server).
- Preserve **unknown vs. zero** and **provenance** semantics so cross-browser/coverage differences don't distort aggregates (correct denominators).
- Let users pivot from an aggregate down to representative individual captures (open in the per-sample viewer).

## Notes

- Per-sample viewing stays with [`viewer`](../viewer)/Perfetto; this is the fleet-level view.
- Depends on [`analysis`](../analysis) metric definitions being stable and versioned for comparability over time.

Detailed design deferred to its phase — see [docs/Architecture.md](docs/Architecture.md).
