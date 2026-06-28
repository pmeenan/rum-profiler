# server — Architecture (draft)

> Placeholder; fleshed out in Phase 2. Project context: [../../../docs/Architecture.md](../../../docs/Architecture.md).

## Direction

- Stateless ingest that validates captures against the `format` schema/version and rejects/repairs malformed ones.
- Processing pipeline: redaction enforcement → symbolication → storage in a form [`aggregate`](../../aggregate) can query.
- A config service that evaluates rules ("interesting events") and returns a capture-config to clients.

## Open questions

- Storage substrate and schema for aggregate querying.
- Runtime/stack (must keep the Apache-2-or-looser license rule).
- Config rule language for targeting interesting sessions.
