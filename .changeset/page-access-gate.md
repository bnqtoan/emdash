---
"emdash": minor
---

Wire the `page:access` hook into the page pipeline and add the `<EmDashGate>` UI component.

The runtime now resolves the trusted `page:access` verdict for the current visitor via `collectPageAccess(page, visitor)` (first-block-wins, cached per page+visitor). Themes consume it through the new `<EmDashGate>` component (exported from `emdash/ui`, parallel to `<EmDashHead>`/`<EmDashBodyStart>`/`<EmDashBodyEnd>`): it renders the default slot when access is allowed and a `teaser` slot when blocked, server-side, so the gated body is never emitted. The resolved verdict is exposed on `Astro.locals.emdashAccess` for the theme to render the plugin-supplied teaser or perform a page-level redirect.

Additive and backwards-compatible: with no `page:access` gate plugin registered, the verdict is absent and every page renders the full body as before.
