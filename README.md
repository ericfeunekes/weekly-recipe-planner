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
[functional spine](docs/functional-spine.md). Diagnostic JSON is explicitly
non-restorable; the future host-only SQLite operator is scoped in
[the data-recovery follow-up](docs/data-recovery-follow-up.md). Tailscale exposure and the
authenticated activation of the expanded Codex runtime remain separate release
gates.

This worktree contains the unreleased single-path Codex follow-up candidate.
The authority starts the updater-managed `$HOME/.local/bin/codex` app-server
over stdio with a dedicated `CODEX_HOME` and fixed app cwd; it does not pin a
Codex version or reuse normal `~/.codex` runtime state. Compatible updater
changes re-run the generated-schema/capability gate, while incompatible or
unauthenticated Codex state degrades chat only.

Codex runs read-only with approvals disabled. OAuth credentials and the raw
app-server protocol never enter the browser.

## Run Locally

Requires Node.js `>=22.15.0` and the updater-managed Codex launcher. Planner
state remains usable without Codex; embedded chat becomes ready only when the
private `PLANNER_CODEX_HOME` (default `$HOME/meal-planner/agent`) and fixed
`PLANNER_CODEX_CWD` (default `$HOME/meal-planner/app`) pass deployment,
provenance, capability, and dedicated ChatGPT-authentication checks. Normal
`~/.codex` credentials are not the embedded credential surface. Install
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

`npm run dev:web` and `npm run start:web` start only their respective web
processes; they are useful for web debugging but do not provide a ready planner
authority.

### Evidence-bound local release

The expanded Codex candidate is installed through one host-only release
transaction. Staging never selects the candidate and does not pin or package
Codex. It resolves exact Node `22.15.0` through `mise` (or the canonical
absolute `PLANNER_NODE_FLOOR_EXECUTABLE`), performs a clean install, and runs
lint plus the complete merge suite under that exact runtime before writing
`stage.json`. The staged and canonical npm dependency graphs must match:

```bash
npm run planner:release -- stage \
  --candidate-source "$PWD" \
  --baseline-commit c811adc2b2fd05d5573933e10ca77e60f2d0e7ba \
  --data-source <absolute-planner.sqlite> \
  --agent-source <absolute-retained-authenticated-agent-home>
```

On first installation the supplied commit must equal the release-managed value
in `deployment/release/first-install-baseline.json`; changing that prerequisite
is an explicit manifest update, not a caller override.

The command returns an activation ID. Activation derives every artifact path
from that ID, holds the runtime/data boundary offline, builds at the canonical
app path, and restores or reuses the authenticated dedicated home at
`$HOME/meal-planner/agent`. Its authentication-readback operator starts one
fresh updater-managed `codex app-server` with `CODEX_HOME` set to that home and cwd fixed at
`$HOME/meal-planner/app`, requires `account/read({refreshToken:true})`, then
runs the separately bounded planner capability smoke. Activation never starts or cancels login,
logs out, copies credentials, or pins Codex. It then runs installed D4 and D7
responsive Playwright/axe QA, writes a canonical content-hashed evidence
manifest bound by `qa.json`, rechecks that evidence and Codex activation, and
revalidates the exact Node/npm paths, versions, and hashes. Only then does it
publish `activation.json` and `current.json`:

```bash
npm run planner:release -- activate --transaction <activation-id> --authorized
npm run planner:release -- status --transaction <activation-id>
npm run planner:release -- recover --transaction <activation-id>
```

The only stale-pending exceptions are release-managed recovery from the exact
historical pre-adoption first-install shape and an explicit source-drift update.
The update path requires a pending-only journal with no release effects, the
same canonical database path/device/inode, a fresh replacement whose staged
database identity matches a live stopped-database inspection, and a changed old
identity. Stage a fresh replacement in the same installation mode, then
run `activate` with
`--supersede-pending <exact-stale-activation-id>` (or
`make deploy-activate ACTIVATION_ID=<new-id> SUPERSEDE_PENDING=<stale-id>`).
The installed replacement operator preserves and retires the old journal,
generation-CAS replaces `pending.json` without a gap, and recovery replays the
same recorded lineage. The durable checkpoint binds the recovery classification
and both database identities. The content-addressed operator handoff completes
first; the runtime ownership lease and SQLite write reservation are then held
before that checkpoint or any old-journal/pointer mutation, including recovery.
The flag rejects ordinary, unrelated, or already-progressed
transactions and is not a general pending-release deletion mechanism.

The equivalent guarded Make targets are `make deploy-setup`,
`make deploy-activate`, `make deploy-status`, `make deploy-recover`, and
`make deploy-rollback`. `make qa-local` exercises the mutable checkout for
development and deliberately produces no release evidence. There is no
standalone `deploy-qa` lifecycle.

An uninitialized source database is recorded but cannot be activated until the
owner explicitly confirms that an empty household authority is intended:

```bash
npm run planner:release -- activate \
  --transaction <activation-id> \
  --authorized \
  --confirm-uninitialized-authority
```

The confirmation is persisted before release effects, so installed-operator
handoff and recovery do not request it again. Supplying the flag for an
initialized source is rejected. After a committed release, install the
persistent current-user LaunchAgent:

```bash
make deploy-service-install
```

The generated plist is mode `0600`, points at the selected release's immutable
operator and evidence-bound Node executable, starts at login, and uses launchd
`KeepAlive`. It serves loopback port `8642` by default and verifies both
`/api/health` and `/api/workspace` before the command succeeds. Manage it with:

```bash
make deploy-service-status
make deploy-service-restart
make deploy-service-stop
make deploy-service-start
make deploy-service-uninstall
```

Run `make deploy-service-stop` before changing the selected release, then
`make deploy-service-restart` after activation so the plist is regenerated
against the new immutable operator. `make deploy-start` remains the foreground
diagnostic entrypoint. LaunchAgent health does not prove Tailscale access;
Tailscale Serve and ACL admission must be verified separately from a remote
device.

Installed start recomputes the frozen app and content-addressed operator tree
manifests and validates any pending journal's full hash/lifecycle chain before
executing either entrypoint.

Rollback is whole-release and host-only. Automatic data restore requires an
unchanged whole-store snapshot; otherwise the operator reports the exact
activation/current/restore identities required for explicit data-loss
authorization and retains the newer data directory. A crash after authorization
forces a fresh snapshot and new authorization if the selected store changed.
`GET /api/export` remains
a diagnostic, `restorable: false` support projection and is not a database
backup or release rollback input.

## Hosting Boundary

The ChatGPT-backed chat path is local. A Sites or Cloudflare Worker deployment
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

The command uses a disposable private `CODEX_HOME` and empty fixed cwd. It
generates and bounds the current protocol schema, verifies the exact
`:read-only`/no-network policy, live-hosted-search and planner manifests, dependent
dynamic calls, and empty MCP/app/plugin readback, then writes one redacted
mode-`0600` artifact. It does not authenticate, copy credentials, or make chat
ready. Existing output files are never overwritten. Every later
app-server spawn revalidates the accepted updater target, dedicated config and
instructions, absent system config, and empty project capability surface.

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
npm run smoke:live-chat -- \
  --authorized \
  --scenario all \
  --output outputs/qa/<run-id>/codex-follow-up/release-candidate.json
```

That probe never logs in or copies credentials. It uses an already configured,
authenticated dedicated home; drives the final configured runtime through its
public HTTP routes; proves dependent planner calls, live sourced-recipe
replacement, failure-after-effect recovery, second-client readback, and
embedded-runtime independence through the supported Global UDS client; then
writes a new private secret-free artifact. The artifact also binds observed
tool/negative-capability and effective config/instruction isolation evidence,
dedicated-home retention counts, and a manifest of the complete candidate source
tree. It does not inventory or fingerprint mutable normal-Codex state.

For a standalone local smoke, the read-only verifier can consume that artifact
without changing auth or deployment state:

```bash
npm run verify:codex-activation -- \
  --artifact outputs/qa/<run-id>/codex-follow-up/release-candidate.json
```

The release transaction invokes the same verifier automatically after installed
QA and immediately before it can publish activation/current receipts. The
verifier rechecks the accepted managed readiness coordinates, requires exact
executable/schema/config/instruction/account equality, and rejects any candidate
binding drift without changing authentication state. A standalone invocation
does not constitute release evidence. This one-time cutover binding does not pin
Codex; compatible updater-managed versions continue through the normal dynamic
gate after activation. Authenticated readback, real listener/UDS, activation,
and post-activation browser evidence remain separate required gates.
