# format — Architecture

> Component design. Project context: [../../../docs/Architecture.md](../../../docs/Architecture.md).

## File shape

```
[ magic F5 52 55 4D ]   cleartext signature; 0xF5 is an always-invalid UTF-8 lead byte → binary, sniffable
[ codecVersion        ]   varint — the WIRE encoding version (independent of the schema FORMAT_VERSION)
[ formatVersion       ]   varint — Capture.formatVersion (the schema/model version)
[ gzip( body ) ]          everything below is gzipped as one stream
    body = a sequence of length-prefixed, tagged sections [ tag:u8 ][ byteLen:varint ][ payload ]:
      1 STRING_TABLE   interned URLs/names/frame/selector/enum strings — emitted FIRST so ids resolve before use
      2 MANIFEST       clock metadata, per-stream status/loss/provenance, capture-config used
      3 STREAM         [ streamIndex:u8 ][ data ] — one block per present stream
      4 OVERHEAD       capture's self-measured cost
```

Each section is length-prefixed and each present stream is its own block, so an unknown section or a newer stream id is skipped, never fatal — an older reader keeps working against a newer file. The magic + both versions live **outside** the gzip so a consumer can identify and version-check a capture without decompressing. Canonical extension: **`.rcap`**.

## Manifest

The manifest is the heart of "robust to missing data." It records the capture clock before any stream data:

- `timeOrigin`: the page's `performance.timeOrigin` (wall-clock `EpochMs`, correlation metadata only)
- `captureStart` / `captureEnd`: monotonic `RelMs` offsets from `timeOrigin`
- `unit`: the **model** timestamp unit — `'ms'`. (The codec stores timeline values as fixed-point integer-microsecond ticks on the wire, but that is a codec encoding detail, lossless to 1µs; the manifest declares the model unit, not the wire encoding.)
- `base`: `'timeOrigin'` — what every timeline offset is measured from
- `precision`: reported timer coarsening (e.g. 100µs when not cross-origin-isolated), so consumers don't over-trust resolution
- `contexts`: optional per-frame/worker clock mappings if a capture spans multiple execution contexts

Per-stream `provenance` (producing API/browser) lives in each stream's manifest entry, not the clock.

For every stream the project defines, the manifest records:

- `status`: `present | unsupported | not-requested | dropped | policy-blocked`
- `schemaVersion`
- `loss`: optional note (e.g. resource buffer overflow at T, N dropped; profiler sample budget hit; size budget forced truncation)
- `provenance`: producing API/browser, for cross-source reconciliation

It also embeds the **capture-config** that produced the sample, so a reader knows what *should* have been attempted.

## Compactness (implemented)

- **String interning** via a shared table — URLs, resource names, selectors, and the format's many small enum literals repeat heavily, so each is stored once and referenced by a varint id. This is the single biggest size lever; on the golden corpus, packed output is ~0.2× the JSON encoding and smaller than gzipped JSON (asserted per fixture in the tests).
- **Varints** (LEB128) for the non-negative integers that dominate: counts, sizes, ids, indices, string refs.
- **Optional fields** truly optional on the wire via per-struct **presence bitmaps** — an absent field costs one bit and stays distinguishable from zero/empty/null.
- **Outer gzip** pass over the interned, varint-packed body (compression *after* interning).
- **Fixed-point microsecond timestamps.** Timeline values (`RelMs`/`DurationMs`) are stored as integer-µs **zigzag varints**, not f64. Browsers coarsen `DOMHighResTimeStamp` to 100µs by default and 5µs at best when cross-origin isolated (W3C High Resolution Time; verified vs. MDN + the Chrome cross-origin-isolated-timer blog), so 1µs storage captures all real precision — the extra f64 digits are float noise, not signal. The format is therefore **lossless to 1µs**: `round(ms·1000)/1000` recovers the canonical double exactly for any ≤1µs-resolution value, and re-packing is idempotent. This is ~2–4 bytes vs 8 and makes delta encoding trivial. Wall-clock `EpochMs` (correlation metadata, low-volume) and true floats (rects, CLS value, ratios — which can be negative/non-time) stay f64. Zigzag is computed arithmetically (`*2`/`*-2-1`), not with 32-bit shifts, so a multi-minute session's µs values (past 2^31) and a negative `offsetToPage` both survive.
- **Columnar + delta profile samples.** JS Self-Profiling is the hot, high-volume stream, so its samples bypass the generic per-struct path: column 1 is the first sample's absolute µs tick followed by per-sample µs deltas (each ≈ the sample interval → a 1-byte varint); column 2 is `stackId + 1` with `0` reserved for "idle / no JS on stack" (removing the per-sample presence bit). Contiguous columns let gzip model each run separately. On a 2000-sample fixture the entire capture packs to **<1 byte/sample**.

## Codec

Pack/unpack round-trip the in-memory model — proven by deep-equality over the golden corpus, including the degraded captures — **losslessly to 1µs** (the timestamp policy above) and exactly for every other field. Substrate is a small **hand-rolled varint writer**, zero runtime dependencies (cf. waterfall-tools' hand-rolled reader, *reference only*) — satisfying both the on-page "tiny, zero-dependency" rule and the license rule. `pack`/`unpack` are `async` only because gzip (`CompressionStream`/`DecompressionStream`, a Web API present in browsers and Node) is.

The structural encode is **synchronous and per-section**: each stream block is encoded independently and the string table is finalized last (cheap). That decomposition is the seam for (a) a future on-page driver that prepares stream bytes incrementally and flushes only the table at `pagehide` — never a large synchronous pack/compress on the unload path — and (b) a WASM implementation of the structural codec, which would slot in behind the same API. **Redaction is not applied by the codec**; it is a separate pre-pack pass over the `Capture`, and the config that would govern it travels in the manifest.

**Descriptor-driven, not hand-written.** Each struct is a compact data table — `[requiredCount, key, type, key, type, …]`, where `type` is a primitive code (`S`/`R`/`D`/`U`/`F`/`B`/`J`/`SA`), a nested descriptor, a one-element `[descriptor]` (array-of), or a small special-handler tag. One generic walker encodes by interpreting the table and one decodes; both read the **same** descriptor, so encode/decode can't drift (the property the round-trip corpus otherwise has to police across 54 hand-written pairs). Because this is the on-page path on third-party sites, the size matters: the batched presence bitmap forces each field name to appear ~3× in explicit code (build bitmap, guard write, write) but once in a table — which took the pack-only bundle from 4.9 KB → **3.7 KB gzip** (−24%; raw 19.6 KB → 9.3 KB), `schema.ts` from 1340 → 365 lines. The four shapes a flat table can't express — the recursive `notRestoredReasons` tree, the keyed `config.streams`/`overhead.byStream` maps, and the columnar profile samples — are tagged to explicit handlers the walker dispatches to.

The manifest and the stream payloads can in principle disagree (a stream marked `present` with no block, or data on a `dropped` stream). The codec round-trips faithfully without judging — keeping pack cheap — so a separate **`checkConsistency(capture)`** (exported, for tests and ingest tooling, never the hot path) flags such disagreements.

Code: [`../src/codec/`](../src/codec) — `io.ts` (byte I/O, interning, presence bitmaps, `JsonValue` codec), `schema.ts` (descriptor tables + generic walker + special handlers), `pack.ts` (header, gzip, sections, public API), `validate.ts` (`checkConsistency`).

**Status (2026-06-28):** implemented and grounded; the Phase-0 exit criterion (round-trip the golden corpus incl. degraded captures) is met. A first review round added the fixed-point-µs timestamp policy, columnar profile samples, the consistency check, and per-fixture size assertions. Lint/build/tests green.

## Versioning

Two independent numbers: **`CODEC_VERSION`** (the wire encoding — bumped only on a wire-layout change) and **`FORMAT_VERSION`** (the schema/model) plus per-stream `schemaVersion`. Adding the codec did not change the model, so `FORMAT_VERSION` stays 1 (draft). Readers skip unknown sections/streams; once `FORMAT_VERSION` leaves draft, migrations are documented here. Adding a browser signal = adding a stream schema, not breaking the file.

## Golden corpus

`format` owns a corpus of Capture-shaped fixtures used to validate round-trip and (later) by downstream components — in [`../test/fixtures.ts`](../test/fixtures.ts), grounded in the real [`../samples`](../samples). It crucially includes **partial/degraded** captures (Safari-subset → `unsupported`; no-profiler → `policy-blocked`; buffer-overflowed → a `LossNote` + truncation; minimal/empty) plus the edge cases the codec must not smear (absent-vs-empty arrays, `''`-vs-absent strings, `detail: null`-vs-absent, a populated `notRestoredReasons` tree, a multi-context clock) and a **profile-heavy** fixture (2000 samples) that exercises the columnar sample codec at volume.

## Open questions

- **Resolved:** codec substrate (hand-rolled varint, zero-dep), magic (`F5 52 55 4D`) + extension (`.rcap`), compression (gzip after interning), timestamp precision (fixed-point **1µs**, lossless vs. the browser's ≤5µs real resolution; per-sample delta for the profiler stream).
- **On-page footprint is verified, not assumed.** `unpack` and the whole decode side run in tooling only; they must never reach a user's page. They don't — importing only `pack` tree-shakes decode to zero (esbuild `--bundle --minify`: pack-only **9.3 KB / 3.7 KB gzip** with no `DecompressionStream` or decode strings, vs 13.7 KB / 5.1 KB with `unpack`). `"sideEffects": false` makes this reliable across bundlers. A full **physical encode/decode split** (separate modules + a `@rum-profiler/format/pack` subpath) would guarantee it structurally even for a non-bundled consumer, but the product path is bundled and the win over tree-shaking is marginal — so it stays an option, not a requirement.
- How redaction policy is expressed and applied at pack time (a separate pass from the codec).
- Streaming pack/unpack API shape and worker handoff model (the per-section seam exists; the driver does not yet).
- Whether per-stream columnar/delta encoding (beyond profiler samples) is worth it for resource/LoAF timings — measure against real captures before adding complexity.
