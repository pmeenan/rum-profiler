# server

**Phase:** 2 · **Milestone:** field collection · **Status:** placeholder

A reference server-side application that receives captures, validates and processes them, stores them, and delivers **dynamic capture-config** back to clients.

## Responsibilities

- Ingest endpoint: accept beaconed captures from [`transport`](../transport); decode/validate against [`format`](../format).
- Process & store: server-side [`symbolication`](../symbolication), redaction enforcement, persistence.
- **Dynamic capture-config delivery:** serve a capture-config (the same schema [`capture`](../capture) uses locally) to target "interesting" sessions/events — turning expensive streams on only where they matter.

## Notes

- Reference implementation, not a hosted service — a clean, self-hostable baseline.
- The dynamic-config schema is shared with the v0 local config, so the client path is identical; only the source changes (baked-in vs. fetched).

Detailed design deferred to its phase — see [docs/Architecture.md](docs/Architecture.md).
