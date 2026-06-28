# format

**Phase:** 0 · **Milestone:** v0 · **Status:** design

The schema and binary codec for a captured sample. This is the **contract** every other component reads or writes — the canonical, compact, self-describing artifact (`.rumcap`, name TBD).

## Responsibilities

- Define the **stream schemas** (navigation, resources, rendering, interactivity, profile, app signals, environment).
- Define the shared **clock metadata** (time origin, capture bounds, timestamp unit/base/precision, and per-context clock mapping when needed) that lets every stream line up on one timeline.
- Define the **manifest**: which streams are present/absent, schema versions, reason-for-absence, loss/truncation, and per-value provenance.
- Define the **capture-config** schema (what to attempt) — reused verbatim by Phase 2 dynamic config.
- Provide **pack** and **unpack** that round-trip the in-memory model losslessly.
- Optimize aggressively for size (string interning, delta-encoded timestamps, optional fields).
- Keep serialization streamable/incremental so final pagehide/unload work is a cheap flush, not a large main-thread packing job.
- Version everything so the format survives browser-API churn and external adoption.

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

- Codec substrate: hand-rolled varints vs. a permissive existing library (must satisfy the Apache-2-or-looser license rule).
- File extension + magic bytes.
- Compression layer (and interaction with the codec's own interning).
- Schema versioning/migration policy.

See [docs/Architecture.md](docs/Architecture.md).
