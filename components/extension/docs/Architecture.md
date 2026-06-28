# extension — Architecture

> Component design. Project context: [../../../docs/Architecture.md](../../../docs/Architecture.md).

## Moving parts (Manifest V3)

- **Header injection** — a `declarativeNetRequest` rule adds the `Document-Policy: js-profiling` response header to top-level (and relevant sub-frame) responses for pages where capture is active. Self-profiling is Chromium-only today; confirm current support before relying on it.
- **Script injection** — inject [`capture`](../../capture) into the page's **main world** (so it sees the real performance entries and can run the profiler), parameterized by a capture-config. Prefer `document_start` registration for active captures; late `executeScript`-style injection can miss early navigation, paint, and resource signals.
- **Lifecycle coordination** — inject or trigger the page-side capture flush on `visibilitychange` → hidden, `pagehide`, and bfcache transitions, so captures aren't lost on navigation away.
- **Saver** — pack via [`format`](../../format) and download the `.rumcap`; or post the in-memory capture to the [`viewer`](../../viewer).
- **Popup/options UI** — toggle capture on/off, pick a capture-config preset, open the viewer.

Extension APIs are harness-only. They may inject scripts, set the profiling Document Policy, expose UI, save files, and launch the viewer, but they must not produce performance measurements. No resource timing, navigation timing, profiling, lifecycle, or attribution data should come from `webRequest`, DevTools Protocol, extension network interception, or any other extension-only surface.

## Flow

```
user enables capture on a tab
        │
        ▼
header injection applies profiling Document Policy  ──►  page reload
        │
        ▼
capture lib injected (main world) with config
        │
        ▼
page runs; lifecycle hook fires
        │
        ▼
page-produced capture ──► format.pack() ──► save .rumcap   (or hand buffer to viewer)
```

## Privacy

The extension sees real, possibly-authenticated pages. URL/stack redaction (owned by `format`) applies before save. Host permissions are scoped and surfaced to the user; capture is explicit per tab/site, never silent.

## Measurement boundary

The injected [`capture`](../../capture) library is the only measurement source. It observes browser performance APIs from the page's main world and emits the in-memory model. The extension receives that model only after capture has produced it, then packs/saves/opens it; it does not backfill missing browser APIs with extension-only observations.

## Open questions

- Exact header-injection scoping (DNR/session rule or equivalent, which frames, when active) and reload UX for the header to take effect.
- Browser support matrix for `Document-Policy: js-profiling` (Chromium-only today; track Firefox/Safari status) and graceful fallback when unsupported.
- Main-world injection timing (`document_start`, registered content scripts, frame matching) to not miss early entries.
- v0 capture-config presets.
