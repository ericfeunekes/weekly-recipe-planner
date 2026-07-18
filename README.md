# Weekly Recipe Planner

![Weekly Recipe Planner — recipe cards, prep checklist, and mise en place](public/hero.png)

An iPad-first household meal operations app for executing a structured week.
The active week keeps meals, prep, groceries with source and recipe links,
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
- Timer starts, notes, and prep order survive reopening and remain consistent
  across clients. The Codex surface reads native thread history
  rather than persisting another transcript in planner state.
- UI and Codex changes share event history and recent undo.
- Grocery scope is weekly food only, with source filters for Shop, Farm box,
  and On hand items.
- Closeout preserves repeat/modify/drop feedback and a planning lesson.

The app has one shared household surface without user accounts or private
threads. Multiple household-visible native Codex threads may exist, with one
selected in the app at a time. **Save comment** stores text on an instruction step;
**Ask Codex** posts the text and stable step context to the selected
thread without also saving it as a note.

## Implementation Status

The family runtime uses one local Node authority and one SQLite household
workspace. It owns optimistic concurrency, idempotent requests, shared planner
state, the currently implemented durable chat lifecycle, history, and undo. The
Vinext process renders the web surface but does not own household data. The
native-thread target below will retire the app transcript as conversation
authority while retaining the planner effect ledger.

Development and production have deliberately different HTTP topology. In
development, Vinext is browser-facing and proxies `/api/*` to the authority. In
production, the authority is the browser-facing front controller: it handles
`/api/*` and proxies all other requests to a private Vinext process. See
[the family-readiness plan](docs/family-readiness-remediation-plan.md) and
[functional spine](docs/functional-spine.md). The current embedded-agent target
is defined by [the Codex planner runtime requirements](docs/codex-agent-runtime-follow-up-phase.md):
a thin UI over native Codex thread history, exactly one app-wide selected
top-level thread, native background workers, standalone/planner skills, hosted
web search, and planner tools available together. Diagnostic JSON is explicitly
non-restorable; the future host-only SQLite operator is scoped in
[the data-recovery follow-up](docs/data-recovery-follow-up.md). Tailscale exposure and the
authenticated activation of the expanded Codex runtime remain separate release
gates.

This worktree contains the additive native Codex thread backend: a typed HTTP
wrapper for native history/list/read/new/select/archive, start-versus-steer,
interrupt, completed reasoning summaries, safe activity labels, workers,
answerable listed-option questions with no free-form response channel, and separately typed blocked approvals. It
also contains the unified updater-managed capability gate. The browser now
uses that API as a native Codex thread wrapper: it has one shared selected
top-level thread, native history, and no app-owned transcript or task-mode
selector.

The Codex process keeps approvals disabled and has no general write surface;
planner mutations are available only through the strict host-owned dynamic
tools. OAuth credentials and the raw app-server protocol never enter the
browser.

## Run Locally

Requires Node.js `>=22.15.0` and the updater-managed Codex launcher. Planner
state remains usable without Codex; embedded chat becomes ready only when the
private `PLANNER_CODEX_HOME` (default `$HOME/meal-planner/agent`) and fixed
`PLANNER_CODEX_CWD` (default `$HOME/meal-planner/app`) pass deployment,
provenance, capability, and dedicated ChatGPT-authentication checks. Normal
`~/.codex` credentials/config/plugins are not the embedded surface; the normal
OS `HOME` remains available for standalone skill discovery under
`~/.agents/skills`. Install
dependencies and start the development runtime:

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

### Snapshot-backed QA deployment

Use Portless to run a browser QA copy at a stable local URL without competing
for a numbered port or writing to the household database:

```bash
make qa-deploy
```

The command snapshots the built runtime and a verified SQLite copy of
`.planner-data/planner.sqlite` into a private temporary directory, then starts
a detached front-controller/runtime pair against that immutable QA copy. It is
reachable at `http://weekly-recipe-planner-qa.localhost:1355` even after the
shell that started it exits. `make qa-deploy` replaces the prior managed QA
copy only after its new build succeeds; use `make qa-status` to check it and
`make qa-stop` to terminate its tracked process group and remove the snapshot.
The single Portless proxy is a shared local daemon, so stopping this QA target
does not disrupt other Portless routes. Supply `QA_NAME`, `QA_PORTLESS_PORT`,
or `QA_DATA_SOURCE=/absolute/planner.sqlite` when a separate QA deployment or
data source is required. QA uses the configured native Codex runtime against
its isolated planner snapshot; only the shared global Codex socket is disabled.

`npm run dev:web` and `npm run start:web` start only their respective web
processes; they are useful for web debugging but do not provide a ready planner
authority.

### Normal production deployment

There is one production release path:

```bash
make promote
```

Run it from any checkout. It creates a detached temporary worktree at the
committed local `main` ref, builds there, atomically replaces only
`$HOME/meal-planner/app`, starts the one current-user LaunchAgent, checks the
loopback health/workspace routes, checks the real Tailscale
`/api/workspace` route, and always removes the temporary worktree. Uncommitted
work in the calling checkout cannot enter production.

The direct deployer uses the shared Tailscale location
`https://robie-imac.tailae8a7b.ts.net/recipe-planner/` by default. Set
`PLANNER_TAILNET_ORIGIN` when the machine's Tailscale hostname differs, or set
`PLANNER_TAILNET_URL` when its public path differs. The prior app directory is retained under
`$HOME/meal-planner/backups`; if startup or either readiness check fails, the
prior app is restored and the service remains stopped for inspection.

`make deploy` is an implementation primitive used by `make promote`; do not use
it as the operator release command. There are no release manifests, staging
suites, activation IDs, or separate service commands. The household database
stays at `$HOME/meal-planner/data/planner.sqlite`; deployment replaces
application code only. The LaunchAgent listens only on loopback port `8642` by
default. Stop it with `launchctl bootout gui/$(id -u)/com.ericfeunekes.meal-planner`.


## Hosting Boundary

The native Codex thread path is local. A Sites or Cloudflare Worker deployment
cannot spawn the Codex binary or access the local Codex credential store. A
hosted version therefore needs either a separately secured companion service
or an API-key-backed OpenAI service; website visitor sign-in alone is not model
authorization.

## Global Codex Planner Client

The local authority exposes a separate planner-only HTTP/1.1 service at the
fixed same-user socket `$HOME/meal-planner/run/global-codex.sock`. Deployment
must pre-create the canonical `$HOME/meal-planner` directory, owned by the
current user with mode `0700`; the application safely creates only its `run`
child. The client has no TCP, browser, actor, database, or target override.

```bash
npm run planner:global -- health
npm run planner:global -- workspace
npm run planner:global -- apply < batch.json
```

An apply document contains contract version `1`, a UUID request ID, the current
base planner version, and one to sixteen typed operations. Retry transport
uncertainty only with the identical UUID and ordered payload; use authoritative
workspace readback and a new UUID for a changed attempt.

## No-Auth Codex Compatibility Probe

Wave 1 packages a no-auth operator gate for the updater-managed Codex binary:

```bash
npm run probe:codex-follow-up -- \
  --no-auth \
  --output outputs/qa/<run-id>/codex-follow-up/current-binary.json
```

The command uses a disposable private `CODEX_HOME`, generates and bounds the
current thread list/read/start/resume/archive, turn start/steer/client-message,
and parent/child protocol, validates the fixed read-only/no-network authority,
and drives one deterministic native root through worker completion, a bounded
question answer, and dependent planner calls. It records the exact observed
worker provider-tool manifest and standalone-skill discovery metadata in one
redacted mode-`0600` artifact. It does not authenticate, copy credentials, make
Codex ready, or by itself prove the browser thread-wrapper behavior. Existing output
files are never overwritten.

## Verify

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
```

`npm test` enforces strict TypeScript, builds the Cloudflare Workers-compatible
Vinext output, and verifies the rendered site and locked command/view surface.
Playwright runs separately through `npm run test:e2e`. The authenticated native
Codex check is opt-in and remains outside deterministic tests:

```bash
npm run smoke:native-codex -- \
  --authorized \
  --scenario all \
  --output outputs/qa/<run-id>/codex-follow-up/release-candidate.json
```

The historical `smoke:live-chat` command is retained as a compatibility alias;
both commands execute the same schema-v2 native-thread proof. The probe never
logs in or copies credentials. It uses an already authenticated dedicated home,
drives the final configured runtime through public HTTP, and proves native
thread creation/history/pagination/selection/archive, restart readback, an
interrupt, typed questions, the approval-policy boundary, activity projection,
a native child worker, hosted search, one authoritative planner effect, exact
admission replay, changed-payload rejection, second-client readback, Global UDS
independence, and incompatible-runtime isolation. Probe threads are archived
and excluded from the active/default picker. The private mode-`0600` artifact
contains hashes and bounded counts, never raw thread, credential, planner, or
provider content.

For a standalone local smoke, the read-only verifier can consume that artifact
without changing auth or deployment state:

```bash
npm run verify:codex-activation -- \
  --artifact outputs/qa/<run-id>/codex-follow-up/release-candidate.json
```

The verifier requires schema v2 and rechecks the exact stable native top-level
and worker tool surfaces, hosted-search mode, planner and skills namespaces,
standalone-skill identity, executable/schema/config/instruction/account
coordinates, and candidate source immediately before activation. The release
transaction also binds the evidence schema through the candidate and installed
QA manifests. A standalone invocation never constitutes release evidence, and
the binding does not pin Codex: compatible updater-managed versions continue
through the dynamic gate after activation.
