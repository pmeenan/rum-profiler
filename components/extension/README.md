# extension

**Phase:** 1 · **Milestone:** v0 · **Status:** design

A Chrome extension that lets you capture deep performance data on **any** production page without modifying the site. It is the v0 harness: injector, header enabler, saver, and viewer launcher — the thing that makes the local-first loop usable.

## Responsibilities

- Inject the [`capture`](../capture) library into the target page.
- Add the Document Policy response header that permits JS self-profiling (the reason `capture` can't enable it alone).
- Apply a default **capture-config** (and let the user tweak what to capture).
- On page lifecycle / navigation, receive the page-produced capture, pack it via [`format`](../format), and **save the `.rcap` file** to disk.
- Optionally hand a capture straight to the [`viewer`](../viewer) ("capture and view").

## Why an extension

Self-profiling needs a header the site doesn't send, and we want to test the capture APIs on real sites we don't control. The extension supplies the header and the injection, turning any page into a capture source — much like using DevTools, but emitting our portable format. The required header is `Document-Policy: js-profiling` (Chromium-only today); confirm current browser support before relying on it.

The extension is not a measurement component. It must not use extension-only APIs such as `webRequest`, DevTools Protocol, or extension network interception to create or augment performance data. Those APIs may only support harness work such as script/header injection, UI, saving, and opening the viewer.

## Non-goals

- No beaconing to a server (that's [`transport`](../transport)/[`server`](../server) in Phase 2).
- No metric analysis or rendering — it orchestrates `capture` + `format`, and defers viewing to [`viewer`](../viewer).
- No extension-only measurement path. Network, timing, profiler, lifecycle, and attribution data come from the injected `capture` library's browser APIs.

## Inputs / outputs

- **In:** a live page; a capture-config.
- **Out:** saved `.rcap` files; optionally an in-memory capture passed to the viewer.

## Key open questions

- MV3 mechanics for header injection (likely declarativeNetRequest/session rules, for headers only) and early main-world script injection. Prefer registered content scripts or an equivalent `document_start` path over late programmatic injection when early navigation/paint/resource entries matter.
- How much capture-config UI to expose in v0.
- Permissions/host-permissions model and its privacy implications.

See [docs/Architecture.md](docs/Architecture.md).
