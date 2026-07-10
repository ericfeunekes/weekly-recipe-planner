# Weekly Recipe Planner

An iPad-first household meal operations app for executing a structured week.
The active week keeps meals, prep, groceries, farm-box substitutions,
leftovers, feedback, and recent changes on one shared surface.

## Product Shape

- Week overview is the default surface, with today visually prioritized.
- Past archived, current active, and future draft weeks are navigable.
- Meals use editable week-local recipe snapshots rather than a recipe library.
- Recipe instructions are stable, independently referenceable steps with
  ingredient amounts, shared completion, optional timers, and one note.
- Prep is a manually ordered list of references to those instruction steps;
  it never copies or reorders the recipe itself.
- Checking a step in Prep checks it on the meal day, while removing its prep
  reference leaves the instruction and completion state intact.
- Timer starts, notes, prep order, and the one shared household transcript
  survive a browser restart through local storage.
- UI and Codex changes share event history and recent undo.
- Grocery scope is weekly food only, with farm-box reconciliation.
- Closeout preserves repeat/modify/drop feedback and a planning lesson.

The app has one shared household surface without user accounts or private
threads. **Add note** stores text on an instruction step; **Send to ChatGPT**
posts the text and stable step context to the global transcript without also
saving it as a note.

The browser persists its current week and transcript in local storage. A loopback-only Node
bridge starts Codex app-server over stdio, reuses the Codex CLI's ChatGPT login,
and asks for a structured planner command. A composite prep-plan command lets
Codex select and order several canonical steps at once. The browser validates every command
and applies it through the same domain reducer used by direct UI actions.

Codex runs read-only with approvals disabled. OAuth credentials and the raw
app-server protocol never enter the browser.

## Run Locally

Requires Node.js `>=22.13.0`, Codex CLI, and a ChatGPT-authenticated Codex
session.

```bash
codex login status
```

The expected status is `Logged in using ChatGPT`. Then start both the web app
and local bridge:

```bash
npm ci
npm run dev
```

`npm run dev:web` starts the web surface without the bridge; chat will report
that local Codex is unavailable. The web preview uses the fixed local URL
`http://localhost:3001`; startup fails instead of silently moving to a port the
bridge does not trust. `npm run bridge` starts only the bridge on
`http://127.0.0.1:8788`.

## Hosting Boundary

The ChatGPT-backed chat path is local. A Sites or Cloudflare Worker deployment
cannot spawn the Codex binary or access the local Codex credential store. A
hosted version therefore needs either a separately secured companion service
or an API-key-backed OpenAI service; website visitor sign-in alone is not model
authorization.

## Verify

```bash
npm run typecheck
npm run lint
npm test
```

`npm test` enforces strict TypeScript, builds the Cloudflare Workers-compatible
Vinext output, and verifies the rendered site and locked command/view surface.
