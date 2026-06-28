# aggregate — Architecture (draft)

> Placeholder; fleshed out in Phase 3. Project context: [../../../docs/Architecture.md](../../../docs/Architecture.md).

## Direction

- Aggregate queries over stored captures with correct handling of missing data (unknown ≠ zero, right denominators per provenance).
- Drill-down from aggregate to representative single captures, opened in [`viewer`](../../viewer).

## Open questions

- Aggregation backend and query model.
- Sampling/weighting so aggregates are representative.
- Linking aggregate points back to stored individual captures.
