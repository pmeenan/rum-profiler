# format

**Phase:** 0 · **Milestone:** v0 · **Status:** schema + binary codec implemented and grounded; round-trips the golden corpus (lossless to 1µs on timeline values, exact otherwise) — Phase-0 exit criterion met

The schema and binary codec for a captured sample. This is the **contract** every other component reads or writes — the canonical, compact, self-describing artifact (**`.rcap`**).

## Responsibilities

- Define the **stream schemas** (navigation, resources, rendering, interactivity, profile, app signals, environment).
- Define the shared **clock metadata** (time origin, capture bounds, timestamp unit/base/precision, and per-context clock mapping when needed) that lets every stream line up on one timeline.
- Define the **manifest**: which streams are present/absent, schema versions, reason-for-absence, loss/truncation, and per-value provenance.
- Define the **capture-config** schema (what to attempt) — reused verbatim by Phase 2 dynamic config.
- Provide **pack** and **unpack** that round-trip the in-memory model — lossless to 1µs on timeline values, exact otherwise.
- Optimize aggressively for size (string interning, delta-encoded timestamps, optional fields).
- Keep serialization streamable/incremental so final pagehide/unload work is a cheap flush, not a large main-thread packing job.
- Version everything so the format survives browser-API churn and external adoption.

## Schema modules

The schema lives in [`src/`](src) as the TypeScript contract (`@rum-profiler/format`), grounded in the real captures under [`samples/`](samples):

- `time.ts` — branded `RelMs` / `DurationMs` / `EpochMs` so epoch-vs-relative is a compile error, not a `> 1e12` guess.
- `registry.ts` — the `StreamId`s, the `present | unsupported | not-requested | dropped | policy-blocked` status set, and the `entryType → stream` map.
- `streams/` — per-stream model types (navigation ⊃ resource; paint/LCP/CLS/element; interactions/long-tasks/LoAF; user-timing/visibility/errors; environment; profile).
- `manifest.ts` — clock metadata + per-stream status/loss/provenance + the embedded capture-config.
- `config.ts` — the capture-config schema (also the Phase 2 dynamic-config object).
- `capture.ts` — the top-level `Capture` model the codec round-trips.
- `json.ts` — `JsonValue`, the bounded payload type for User Timing `detail` (keeps pack/unpack lossless).
- `version.ts` — `FORMAT_VERSION` (1, **draft**) + per-stream schema versions.
- `codec/` — the binary `pack`/`unpack` (see below): `io.ts` (varint/zigzag/µs/f64 byte I/O, string interning, presence bitmaps, the `JsonValue` codec), `schema.ts` (**descriptor tables** + one generic encode/decode walker + the few special handlers), `pack.ts` (header, gzip, section framing, public `pack`/`unpack`), `validate.ts` (`checkConsistency`).

## Codec

`pack(Capture) → Uint8Array` and `unpack(bytes) → Capture` round-trip the model — verified by deep-equality over the golden corpus in [`test/`](test) (`fixtures.ts` + `codec.test.ts`), including the degraded captures. Both are `async` because the output is gzipped (`CompressionStream`). Lossless to the **microsecond** (the timestamp precision policy below); exact for every other field.

Wire layout (see [docs/Architecture.md](docs/Architecture.md) for the full spec):

```
[ magic F5 52 55 4D ][ codecVersion ][ formatVersion ]   cleartext, sniffable header
[ gzip( string-table | manifest | stream blocks | overhead ) ]
```

- **Magic** `F5 52 55 4D` (`\xF5RUM`); `0xF5` is an always-invalid UTF-8 lead byte, so a capture is unmistakably binary. Canonical extension **`.rcap`**.
- **Two version numbers:** `CODEC_VERSION` (the wire encoding) is independent of `FORMAT_VERSION` (the schema/model). Adding the codec did **not** change the model, so `FORMAT_VERSION` stays 1.
- **Compact:** string interning (URLs/names/selectors/enum-literals stored once), varints for counts/sizes/ids, truly-optional fields via presence bitmaps, and an outer gzip pass. On the corpus, packed output is ~0.2× the JSON encoding and smaller than gzipped JSON (asserted per fixture).
- **Descriptor-driven codec:** each struct is a compact data table (`[requiredCount, key, type, …]`); one generic walker encodes and one decodes by interpreting it, instead of ~54 hand-written pairs. Both sides read the *same* descriptor, so encode/decode **cannot drift**. It is also smaller on the page — see *On-page footprint*. The few shapes a flat table can't express (the recursive `notRestoredReasons` tree, the keyed config/overhead maps, the columnar profile samples) are tagged to small special handlers.
- **Timestamp precision policy:** timeline values (`RelMs`/`DurationMs`) are stored as **fixed-point integer microseconds** (zigzag varint), not f64. Browsers coarsen `DOMHighResTimeStamp` to 100µs by default and 5µs at best (cross-origin isolated), so 1µs captures all real precision — the extra f64 digits are float noise. This is ~2–4 bytes vs 8, makes deltas trivial, and `round(ms·1000)/1000` recovers the canonical double exactly for any ≤1µs value. Wall-clock `EpochMs` and true floats (rects, CLS value, ratios) stay f64.
- **Profile samples** (the hot, high-volume stream) use a bespoke **columnar + delta** layout: first absolute µs tick + per-sample µs deltas in one column, `stackId+1` (0 = idle) in another. On a 2000-sample fixture the whole capture packs to **<1 byte/sample**.
- **Skippable blocks:** each section is length-prefixed and each stream is its own block, so an unknown section or a future stream id is skipped, not fatal.
- **Pack-path shape:** the structural encode is synchronous and per-section — the seam a future on-page driver uses to prepare stream bytes incrementally and flush only the (cheap) string table at unload, and the boundary a WASM codec would slot into. Redaction is **not** applied by the codec; it is a separate pre-pack pass (the config that *would* govern it travels in the manifest).
- **On-page footprint:** `unpack` runs in tooling, not on the page — so the whole decode side (`unpack` + the generic decode walker + `Decoder`/`Reader` + `gunzip`) must never reach a user's page. It doesn't: importing only `pack` tree-shakes decode away entirely. Measured with esbuild (`--bundle --minify`): **pack-only is 9.3 KB / 3.7 KB gzip** (the pack-only bundle contains no `DecompressionStream` and none of the decode error strings), vs 13.7 KB / 5.1 KB with `unpack` too. `"sideEffects": false` in `package.json` makes the tree-shaking reliable across bundlers (webpack relies on it), since every module is pure. The descriptor-driven codec is what got the on-page path from 4.9 KB → 3.7 KB gzip (−24%; raw 19.6 KB → 9.3 KB).
- **Consistency:** `checkConsistency(capture)` (exported, for tests/tooling — *not* the hot pack path) flags a manifest/payload disagreement, e.g. a stream marked `present` with no data, or data on a `dropped` stream. The codec itself round-trips faithfully without judging.

## Why a custom format (not Perfetto)

Perfetto is a *transcode target* for viewing ([`transcode`](../transcode)), not our store. We keep our own format for wire size, redaction control, and ownership of the schema across the capture → transport → server → aggregate path.

## Inputs / outputs

- **In/out:** the in-memory timeline model from [`capture`](../capture).
- **Consumed by:** [`transcode`](../transcode), [`analysis`](../analysis), [`symbolication`](../symbolication), [`transport`](../transport), [`server`](../server).

## Design tenets

- **Self-describing.** A reader with only the bytes can tell what's present and what's missing and why.
- **Forward/backward compatible.** Unknown fields/streams are skippable; versions are explicit.
- **Unknown ≠ zero.** Absent values are representable distinctly from zero values.
- **Privacy-aware.** Redaction hooks at pack time (URL/stack-frame policies).

## Key open questions

- **Resolved:** codec substrate (hand-rolled varint writer, zero runtime deps), magic bytes (`F5 52 55 4D`) + extension (`.rcap`), compression (gzip, after interning), timestamp precision (fixed-point **1µs**, lossless vs. the browser's ≤5µs real resolution).
- **Physical encode/decode split** (separate modules + `@rum-profiler/format/pack` subpath) would make the on-page path decode-free *structurally*, even for a non-bundled / native-ESM consumer. Not done: the product path (`capture` + extension) is **bundled**, where decode already tree-shakes to zero (verified above, hardened by `sideEffects: false`); a full structural split means separating the encode/decode pairs that currently sit adjacent for auditability — worth it only if a non-bundled consumer of the encode path ever appears.
- Schema versioning/migration policy once `FORMAT_VERSION` leaves draft.
- How redaction policy is expressed and applied at pack time (a separate pass from the codec).

## Samples (grounding data)

Real `Performance` API captures used to ground these schemas live in [`samples/`](samples/) — four public production pages captured 2026-06-28 in Chrome 149, plus tooling to regenerate or extend them. They are **raw browser shapes**; the **golden corpus** (Capture-shaped fixtures the codec round-trips, including the degraded variants) lives in [`test/fixtures.ts`](test/fixtures.ts) and is grounded in these samples. See [samples/README.md](samples/README.md).

See [docs/Architecture.md](docs/Architecture.md).
