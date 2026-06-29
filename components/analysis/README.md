# analysis

**Phase:** 1 · **Milestone:** v0 · **Status:** placeholder

Derives metrics and attribution from a packed capture's correlated timeline. This is where "metrics and profile are co-equal" is realized: the metrics are *queries over the same data the profile is built from*.

## Responsibilities

- Compute Core Web Vitals and their attribution: LCP (TTFB / load delay / load time / render delay, + element), INP (interaction → LoAF → paint), CLS (sources), plus TTFB/FCP and custom measures.
- Compute **emergent** metrics that only exist because streams are correlated — e.g. idle/schedulable windows (intervals where both network and main thread are idle), "what blocked LCP," hydration cost.
- Respect missing data: report **unknown** distinctly from zero; carry provenance forward.

## Notes

- Operates **offline** on a `.rcap` (after [`capture`](../capture) recorded the live attribution that can't be derived later).
- Perfetto's SQL `trace_processor` is a complementary query surface on the transcoded trace; decide which derivations live here vs. as Perfetto SQL.

Detailed design deferred to its phase — see [docs/Architecture.md](docs/Architecture.md).
