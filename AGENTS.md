# Waterfall Tools — rum-profiler: AI Agent Guidance

Client-side, high-performance tools for measuring, profiling, analyzing and viewing real-user performance of web applications. This file is long-term project memory — keep it current.

`rum-profiler` is a **multi-component** project. The parent repo holds project-wide docs; each component is independent and lives under `components/<name>/`.

## Workflow (mandatory)

- **Start:** read the project-wide `docs/Architecture.md` and `docs/Plan.md`. If you are working inside a component, also read that component's `README.md` and `docs/Architecture.md`.
- **End:** update the docs you invalidated — the project-wide `README.md`, `docs/Plan.md`, `docs/Architecture.md`, and any touched component's `README.md` / `docs/`. Update this `AGENTS.md` when conventions change.
- **Hygiene:** delete any throw-away diagnostic scripts, `.log` files, and scratch outputs from the repo root before concluding.
- **Contracts:** any change to the `format` schema or a cross-component public interface MUST be reflected in the relevant `README.md`/`docs/`, and the format version bumped (see `components/format`). A stale contract is a bug.

## Guardrails

This project is built largely with AI assistance; these keep that on the rails.

- **Verify the platform; don't trust memory.** Browser performance APIs and their exact entry fields, browser support, the JS Self-Profiling output shape, MV3 injection rules, and Perfetto protobuf field numbers all change and are easy to misremember. Confirm against the spec / MDN / caniuse **and** real browser output before relying on a shape. Never invent a Perfetto field number — derive it from the actual `.proto`. Unsure how an API behaves? Capture a real sample and look.
- **Ground in real captures.** The `format` golden corpus is the source of truth. When you need to know what a stream really looks like, add a real captured sample and build against it — don't fabricate data, guess a shape, or hard-code values you "expect." Label stubs/mocks as such; never present them as real or ship them.
- **Verify before claiming it works.** "Captured / packed / transcoded / rendered" means you ran it: produced a real capture in a browser, round-tripped it through the codec, and (for transcode) loaded the output in Perfetto and looked. Report what you actually observed — partial/failing/skipped is fine to say; a confident "done" you didn't run is not.
- **Stay in the current phase; smallest change that does the job.** Follow `docs/Plan.md`. Don't build future-phase components early, add speculative abstraction, or widen scope past the task. New abstraction earns its place only when a second real caller needs it.
- **Some decisions aren't yours.** The open-decisions list in `docs/Plan.md` (tooling, language, file format / magic bytes, license nuance) and anything affecting the on-page budget, privacy, or the wire format are human calls — propose and flag, don't silently pick. For reversible in-task choices, take a sensible default and say so.
- **Never exfiltrate capture data.** Captures come from real, possibly-authenticated pages. In development, don't send them to any external service — no hosted-Perfetto "share"/permalink, no pasting captures into web tools, no third-party uploads. Keep processing local; redact fixtures.
- **Match what exists before adding.** Check whether a sibling component already solved a problem and follow that pattern before introducing a new dependency, pattern, or abstraction.

## Definition of done

Before concluding a change:

- Lint clean (warnings = errors); tests and the golden corpus — including the degraded captures — pass.
- Touched on-page code? Bundle size and main-thread overhead checked against budget.
- Changed the `format` schema or a cross-component interface? Version bumped, docs updated.
- Docs you invalidated are updated (`README.md`, `docs/`, component docs, this file).
- No scratch scripts, `.log` files, or stray output left in the repo.

## Repository layout

- `README.md`, `docs/` — project-wide overview, architecture, and the phased plan. **Plans live here**, at the project level, not per-component.
- `components/<name>/` — one independent component per folder. Each has its own `README.md` and `docs/Architecture.md`. Components declare explicit inputs/outputs and must not reach into each other's internals.
- `LICENSE` — Apache-2.0.

## Licensing (strict — keep the project clean)

- The project is **Apache-2.0**. Do **not** pull in any code or dependency licensed more restrictively than Apache-2.0.
- **Allowed:** MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, ISC, 0BSD, Unlicense, Zlib (permissive only).
- **Not allowed:** any copyleft — GPL, LGPL, AGPL (in any form) — and weak/file-level copyleft such as MPL, EPL, CDDL.
- When a license is unclear or unlisted, do **not** add the dependency — ask first. Prefer vendoring a small, clearly-licensed implementation over a heavy dependency.

## Core conventions

- **Independent components.** No cross-component imports of internals; integrate through each component's published interface and the shared `format`.
- **The `format` component is the contract.** The compact, versioned, self-describing capture format is what every other component reads or writes. Schema changes are versioned and documented in `components/format`.
- **Robust to missing data.** Treat every capture stream as optional. Never assume a stream is present; distinguish "absent" from "zero," and record *why* a stream is missing (unsupported / not-requested / dropped / policy-blocked).
- **Missing is better than wrong.** Never synthesize, interpolate, or proportionally distribute data you didn't actually measure — omit it and mark it absent. A gap is recoverable; a fabricated value silently corrupts every metric and aggregate built on it.
- **Tiny on the page (hard rule).** Any code that runs in a real user's page — the `capture` library and any runtime it injects (`transport`/beacon, dynamic-config client) — must be as small and fast as possible: zero runtime dependencies, tree-shakeable, budget-tracked, shipping only what's used. Not imposing a meaningful cost on real users is the hard constraint; if code *can* reach a user's page, it lives under this rule.
- **Tooling may favor clarity.** Code that does *not* run in users' pages (the `extension` UI, `viewer`, `server`, `aggregate`) is less size-critical and may prioritize correctness and readability over byte count — provided it never ships into or slows a real user's page.
- **Privacy.** Assume URLs, stack frames, and timing can carry PII. Redaction/sanitization is designed into capture and format.
- **Viewing via Perfetto.** Per-sample viewing leans on the Perfetto trace format and an embedded Perfetto UI; we emit Perfetto protobuf rather than building a bespoke timeline renderer.
- **Browser-first.** The browser is the primary runtime and the source of truth for API semantics. Where code also runs under Node, **Node polyfills/shims the relevant browser APIs** (e.g. `performance`, `PerformanceObserver`) so the same browser-shaped code runs — Node adapts to the browser, never the reverse. Target latest stable Chrome, Firefox, and Safari (plus Node via shims); ESM only; no transpilation or browser-support polyfills (we target current evergreen browsers).
- **Extension is a harness, not a measurement source.** The extension may inject scripts, enable required headers, provide UI, save captures, and open the viewer. Do not use extension-only APIs such as `webRequest`, DevTools Protocol, or network interception to collect or augment performance data; measurement must come 100% from in-browser APIs available to the injected page code.

## Data & performance

- **Explicit time units and base.** Every timestamp carries a known unit (s / ms / µs) and a known base (epoch vs. monotonic). Normalizing all streams onto one `timeOrigin`-anchored clock is `capture`'s core responsibility — get it wrong and the whole correlated timeline is wrong. Never discriminate epoch-vs-relative (or seconds-vs-ms) with magic thresholds like `> 1e12`; they break for small epochs and silently shatter the timeline. (A hard-won lesson from waterfall-tools.)
- **Zero cost when idle.** Debug/telemetry output and any optional instrumentation must branch out to ~zero cost when disabled — especially on-page code. Default everything diagnostic to off.
- **No unload serialization cliff.** Do not make `pagehide`, `visibilitychange`→hidden, or unload-adjacent paths do heavy packing, interning, compression, or symbol work. Prepare incrementally or off-main-thread, and record truncation/loss when budgets are hit.
- **Stream large data; avoid O(n²).** Captures and traces can be large. Prefer Web Streams over buffering or `JSON.parse`-ing whole payloads; index large collections by `Map` rather than nested scans; detect formats/versions by magic bytes, not file extension.
- **WASM-ready.** Keep heavy data paths (the `format` codec, `transcode`) structured so a WASM implementation can be dropped in later without changing the surrounding API.

## Code quality (applies as tooling lands)

- **Lint is a gate, not advice.** Warnings are errors. All first-party code stays under lint coverage — when you add a file or directory, make sure it's matched. **Fix the underlying issue; don't silence the rule** — scoped, commented disables only when a rule is genuinely inapplicable. Prefix intentionally-unused identifiers with `_`.
- **Tests round-trip and degrade.** Every change keeps the golden corpus passing, including the *partial/degraded* captures (Safari-subset, no-profiler, buffer-overflowed). Validate `pack → unpack` equality. Scrub volatile fields (timestamps, generated IDs) from both sides before structural comparison. (Test-runner choice is tracked in `docs/Plan.md` open decisions; lean toward the sibling project's `vitest`.)
- **CI gates merges** on lint + build + tests once they exist.
- **Comment the *why*, not the *what*.** Dense binary/codec/clock/encoding logic must carry train-of-thought comments explaining why an order or bound matters; bundlers strip them, so there is no shipping cost. Don't narrate what readable code already shows.

## Dependencies & security

- Keep the (deliberately few) dependencies current; run `npm audit` on maintenance passes and note non-trivial updates here. Prefer a small, clearly-licensed vendored implementation over a heavy dependency (see Licensing). On-page code stays zero-runtime-dependency.

## Reference, not dependency

[waterfall-tools](https://github.com/pmeenan/waterfall-tools) (sibling repo, also Apache-2.0) is a useful **implementation reference** for Perfetto embedding (postMessage to `ui.perfetto.dev`) and protobuf wire handling. Use it for ideas only — `rum-profiler` does not import or depend on it.
