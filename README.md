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
  survive reopening and project consistently across clients.
- UI and Codex changes share event history and recent undo.
- Grocery scope is weekly food only, with farm-box reconciliation.
- Closeout preserves repeat/modify/drop feedback and a planning lesson.

The app has one shared household surface without user accounts or private
threads. **Add note** stores text on an instruction step; **Send to ChatGPT**
posts the text and stable step context to the global transcript without also
saving it as a note.

## Implementation Status

The family runtime uses one local Node authority and one SQLite household
workspace. It owns optimistic concurrency, idempotent requests, shared planner
state, durable chat, history, and undo. The Vinext process renders the web
surface but does not own household data.

Development and production have deliberately different HTTP topology. In
development, Vinext is browser-facing and proxies `/api/*` to the authority. In
production, the authority is the browser-facing front controller: it handles
`/api/*` and proxies all other requests to a private Vinext process. See
[the family-readiness plan](docs/family-readiness-remediation-plan.md) and
[functional spine](docs/functional-spine.md). Tailscale exposure and the
expanded Codex runtime remain separate follow-ups.

The authority starts Codex app-server over stdio and reuses the Codex CLI's
ChatGPT login.

Codex runs read-only with approvals disabled. OAuth credentials and the raw
app-server protocol never enter the browser.

## Run Locally

Requires Node.js `>=22.15.0`, Codex CLI, and a ChatGPT-authenticated Codex
session.

```bash
codex login status
```

The expected status is `Logged in using ChatGPT`. Install dependencies and
start the development runtime:

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:3001`. Vinext listens only on that loopback address and
proxies `/api/*` to the authority at `http://127.0.0.1:8788`. Runtime health is
available through the browser-facing origin at
`http://127.0.0.1:3001/api/health`. Startup fails instead of silently moving
either process to another port.

For the production topology, build first and then start the composed runtime:

```bash
npm run build
npm start
```

Open `http://127.0.0.1:3000`; this is the only browser-facing production
origin. The front controller keeps Vinext private at `127.0.0.1:3002` and
serves health at `http://127.0.0.1:3000/api/health`. `PLANNER_PORT` changes the
public port, `PLANNER_HOST` may select `127.0.0.1` or `::1`, and
`PLANNER_DATA_DIR` changes the default `.planner-data` directory. All listeners
remain loopback-only.

`npm run dev:web` and `npm run start:web` start only their respective web
processes; they are useful for web debugging but do not provide a ready planner
authority.

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
npm run test:e2e
```

`npm test` enforces strict TypeScript, builds the Cloudflare Workers-compatible
Vinext output, and verifies the rendered site and locked command/view surface.
Playwright runs separately through `npm run test:e2e`. The authenticated,
disposable ChatGPT check is opt-in and remains outside deterministic tests:

```bash
npm run smoke:live-chat
```
