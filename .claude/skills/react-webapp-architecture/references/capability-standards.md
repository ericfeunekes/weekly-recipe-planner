# Capability Standards

Adopt a package when its capability exists. Do not add specialized packages to
the baseline dependency graph before the application needs them.

## TanStack Capability Decisions

| Package/capability | Decision |
|---|---|
| Router | Baseline. Owns routing and URL state. |
| Query | Baseline for API-backed apps. Owns remote cache and request lifecycle. |
| Start | Use when the application needs server React, SSR, or colocated server functions. This is an application architecture decision. |
| Table | Use the stable v8 line for headless table/grid behavior. Do not make a beta major the default. |
| Virtual | Use for measured rendering pressure from large lists, tables, or grids. Do not virtualize small collections pre-emptively. |
| Pacer | Use for deliberate debouncing, throttling, batching, queuing, or rate limiting when hand-written timing logic would become shared behavior. |
| Devtools | Use package-specific development tools. Treat any unified shell that is still pre-stable as optional development tooling, not application architecture. |
| Form | Exception to React Hook Form only for decisive typed subscription or TanStack Start server-validation needs. |
| DB | Explicit architectural choice for normalized reactive collections and live queries. |
| Store | Specialized option while pre-stable; do not prefer it merely for TanStack affiliation. Zustand remains the client-store default. |
| Hotkeys | Specialized and unresolved as a standard. Adopt only after accessibility, scope, conflict, and platform behavior are assessed. |
| Ranger | Use for custom range or multirange controls that shared shadcn/Base UI primitives do not satisfy. |
| publish-config | Package-publishing tooling only. |
| legacy config package | Do not select; use current repository tooling. |
| CLI and Intent | Specialized setup/tooling choices, not runtime defaults. |
| AI | Do not select as the default AI runtime; use the AI standards below. |
| React Charts | Do not select; the project is archived. |

## Shared Components And Styling

Use Tailwind for application styling and shadcn/ui with Base UI primitives for
the shared component foundation. The repository owns the resulting components,
tokens, variants, and accessibility contract. Avoid a second general-purpose
component system.

Use composition patterns instead of boolean-prop proliferation. Keep feature
language out of shared primitives. Put meaningful component states in
Storybook, then verify route-level composition separately.

## Tables And Virtualization

Use TanStack Table v8 for sorting, filtering, pagination, selection, column
state, and headless rendering. Keep server-owned filtering/sorting/pagination in
Query and URL state rather than pretending the browser owns the complete
dataset. Add TanStack Virtual when measured row/column volume or rendering cost
requires it.

## Charts

Use ECharts as the single canonical chart engine. Route all application charts
through repository-owned wrappers that define:

- theme tokens and semantic colors;
- responsive sizing and lifecycle cleanup;
- accessible labels, summaries, and tabular alternatives where needed;
- reduced-motion behavior;
- loading, empty, and error states;
- export behavior when required; and
- Storybook states for representative density and interaction.

Do not introduce Recharts, Plotly, Vega, visx, AG Charts, uPlot, Highcharts, or
LightningChart as a parallel engine. When a demonstrated requirement cannot be
met by ECharts, escalate the canonical charting decision for reassessment
rather than creating an application-local second standard.

The Recharts-backed shadcn Chart is therefore not selected. Shared ECharts
wrappers should still consume repository-owned shadcn/Tailwind tokens,
primitives, layout, and state patterns; shadcn component mechanics do not
require its chart engine.

## Uploads

Use the native file input and a small application adapter for simple uploads.
Use Uppy when uploads require progress, cancellation, pause/resume, retry,
resumability, route-spanning continuity, multipart orchestration, multiple
sources, or remote-source ingestion. Do not standardize react-dropzone as a
separate upload architecture; Uppy can own the richer interaction when needed.

Treat Uppy Companion as server infrastructure. Its remote-source OAuth,
credential handling, URL fetching, and SSRF exposure require an explicit trust
boundary, deployment owner, allowlists, and operational controls.

## Editors, Offline, And Client Collections

- Use Tiptap when a product needs structured rich-text editing. Define the
  document schema, sanitization, persistence format, collaboration needs, and
  migration policy before implementation.
- Use PowerSync when offline/local-first behavior requires SQL-shaped local
  data and synchronized server authority. This commits the app to a sync and
  conflict model, so record it as an architecture decision.
- Use TanStack DB for normalized reactive collections and live queries, not for
  ordinary preferences or transient UI state.

## Testing And Enforcement

Use:

- Vitest for unit and integration tests;
- Testing Library React and user-event for user-observable component behavior;
- MSW for controlled HTTP variation without replacing real-boundary proof;
- axe for automated accessibility checks;
- Storybook plus its Vitest integration or browser mode for shared component
  states; and
- Playwright for route, browser, and end-to-end behavior.

Use dependency-cruiser to enforce module directions unless Nx already owns the
workspace graph. Test behavior at its owner: state machines with transition and
replay tests, Query integration with request/cache tests, shared UI in
Storybook/component tests, and routed composition in Playwright.

## Observability

Use Sentry for browser exceptions, release/source-map diagnostics, and
actionable frontend performance/error context. Scrub sensitive data and define
sampling deliberately. Use OpenTelemetry for server-side traces, metrics, and
logs. Do not make browser OpenTelemetry a default; add it only when a specific
cross-vendor telemetry requirement outweighs browser payload, privacy, and
instrumentation complexity.
