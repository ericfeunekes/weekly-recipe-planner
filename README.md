# Weekly Recipe Planner

An iPad-first household meal operations app for executing a structured week.
The active week keeps meals, prep, groceries, farm-box substitutions,
leftovers, feedback, and recent changes on one shared surface.

## Product Shape

- Week overview is the default surface, with today visually prioritized.
- Past archived, current active, and future draft weeks are navigable.
- Meals use editable week-local recipe snapshots rather than a recipe library.
- Prep and grocery actions update the same local planner state.
- UI and simulated Codex changes share event history and recent undo.
- Grocery scope is weekly food only, with farm-box reconciliation.
- Closeout preserves repeat/modify/drop feedback and a planning lesson.

The browser build persists its demo state in local storage. The contextual
Codex panel demonstrates the typed-command interaction contract; a production
ChatKit and Codex app-server bridge is not included in this static site.

## Run Locally

Requires Node.js `>=22.13.0`.

```bash
npm ci
npm run dev
```

## Verify

```bash
npm run lint
npm test
```

`npm test` builds the Cloudflare Workers-compatible Vinext output and verifies
that the rendered site and locked command/view surface are present.
