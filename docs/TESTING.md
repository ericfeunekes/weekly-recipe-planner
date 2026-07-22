# Testing And QA Contract

This document is the deterministic proof authority for the current planner.
`docs/functional-spine.md` owns supported behavior and invariants;
`docs/QA.md` owns real-system exploration. Historical family-readiness and
Codex follow-up plans remain useful context, but their retired release commands,
activation journals, and one-time cutover procedures are not current proof
authority.

## Current Release Safety Cells

Every change to promotion, deployment, startup, or mounted routing activates
these cells in addition to the normal merge gate. A retained-data schema change
may merge under the separately defined schema-changing boundary below, but it
must not be promoted until these release cells and its migration release hold
are satisfied.

| Gate | Cell | Required boundary |
|---|---|---|
| Merge | Non-destructive deployment lifecycle | A disposable installed layout proves failures before the first service/app disturbance leave the current app and service untouched; once disturbance begins, every failure before replacement readiness restores the immediately previous app and a ready service. The matrix includes dependency/build failure, unload partial-effect/failure, first and second rename failure, readiness failure, interruption, and two concurrent release attempts. |
| Merge | Candidate readiness | The application selected by the current promotion attempt cannot pass readiness unless the application, store, native Codex compatibility boundary, and Global UDS are initialized. Readiness from the previously running app cannot satisfy the attempt. |
| Merge | Production-profile routing | The production build and front controller are exercised at `/recipe-planner/`; API, workspace, JavaScript, CSS, favicon, and social-preview metadata resolve under the mounted profile. |
| Merge | Gate integrity | The documented release entrypoint runs typecheck, production build, lint, deterministic tests, and the release lifecycle matrix. A missing script, empty test selection, or shared wrong constant is a failure. |
| RC | Disposable installed candidate | The candidate produced by the release entrypoint is installed under a temporary home with disposable SQLite data, started through the production front controller, and passes mounted health/workspace plus the representative browser smoke. |
| QA | Household route observation | After an authorized production release, the mounted household URL is visibly checked from a real browser and the prior release remains recoverable. See `docs/QA.md`. |

The merge and RC cells must not operate on `$HOME/meal-planner` or the family
database. Production observation is read-only except for an explicitly chosen,
reversible household action. Release code changes are incomplete if the
disposable installed-candidate cell cannot run.

### Schema-changing merge and release boundary

A feature that introduces a forward SQLite migration may merge when its normal
merge gate is green and deterministic proof covers a real-file upgrade,
pre-migration backup, restart, replay/undo, `PRAGMA quick_check`, and rejection
by the frozen previous binary without modifying the newer database. The feature
Issue and pull request must state the production release hold explicitly.

Merging such a feature is not authorization to migrate the household database
or run `make promote`. If the household schema is older than committed `main`,
production stays on the previous app and schema. Release remains blocked until:

1. an explicit release action is authorized for the exact schema transition;
2. its checked-in procedure proves a verified pre-migration backup, migration,
   integrity check, and authoritative application readback against disposable
   data before touching household data; and
3. the non-destructive app promotion/recovery and installed-candidate cells
   above are green for the candidate.

The migration implementation and disposable proof may live in the feature PR;
the household data action remains a later `shipping:release` boundary. App
deployment itself never migrates, copies, restores, or prunes household SQLite.

## Merge Gate

Every implementation merge must keep these deterministic cells green:

| Cell | Required boundary | Owning paths |
|---|---|---|
| Domain contracts | Pure canonical state transitions and invariants | `tests/domain-*.test.mjs` |
| Store transactions | Real temporary SQLite file, OCC, receipts, rollback, restart | `tests/store-*.test.mjs`, `tests/planner-service-*.test.mjs` |
| HTTP contracts | Real loopback application routes with fake Codex transport | `tests/http-*.test.mjs`, `tests/runtime-*.test.mjs` |
| Codex wrapper and effect bridge | Native thread/item lifecycle stays Codex-owned; the host persists only selection/effect admission, fences tool replay, and never auto-replays an ambiguous user send | `tests/codex-native-thread-service.test.mjs`, `tests/codex-native-planner-effect.test.mjs`, `tests/integration/native-codex-browser-composition.test.mjs`, and `tests/architecture/legacy-conversation-cutover.test.mjs` |
| Client contracts | Readback ordering, offline/conflict behavior, draft retention | `tests/client-*.test.mjs` |
| Architecture closure | No browser/shared-localStorage authority or alternate mutation path | `tests/architecture/**` |
| Accessibility and fixture capability | Direct Playwright axe integration plus closed D4/D7 runtime seeds | `tests/support/playwright-qa.ts`, `tests/support/e2e-runtime.mjs`, `tests/e2e-runtime-fixtures.test.mjs` |
| Baseline | Typecheck, production web build, lint, existing unit tests | `npm test`, `npm run lint` |

Owner lanes edit their own unit/contract test files. The proof lane owns only
shared support and cross-boundary paths: `tests/support/**`,
`tests/integration/**`, `tests/e2e/**`, and `tests/architecture/**`.

## Release-Candidate Gate

Before the controlled dinner pilot or broad family-ready claim:

- From the package/application root `site/`, run
  `mise exec -C /private/tmp node@22.15.0 -- npm --prefix "$PWD" test` against
  a real file database. Using the neutral working directory makes this proof
  independent of per-worktree mise trust state. The current Cloudflare Vite
  plugin imports `node:module.registerHooks`, which is unavailable in Node
  22.13.0; 22.15.0 is therefore the proven floor.
- Start both `dev` and local `start`; call `/api/health` through each public web
  origin.
- Run two independent Playwright browser contexts through conflict recovery,
  restart, offline/read-only, the exact dinner journey, mobile dialog behavior,
  and representative navigation.
- Verify export readback, strict v2 bootstrap, restart interruption, and no
  production shared writes in React/localStorage.
- Treat `meal-planner-diagnostic-export` (`restorable: false`) as support data,
  never a backup. General SQLite backup/restore remains the host-only work in
  [`docs/data-recovery-follow-up.md`](data-recovery-follow-up.md).

## Exploratory QA Gate

After deterministic proof is current-state:

- Exercise representative iPhone, iPad, and desktop viewports with console and
  network capture.
- Repeat the two-client dinner workflow against a disposable real database.
- Run the authenticated native Codex smoke separately from deterministic tests
  and record authentication/transport failures as environment evidence rather
  than weakening the generated-protocol fixture gate. The probe consumes an
  already authenticated dedicated home and never invokes login.
- The current deterministic suite does not provide a LaunchAgent lifecycle
  harness. For a deployment claim, add the disposable installed-layout coverage
  required by the release safety cells, then observe the authorized real service:
  verify health/workspace, terminate its child once to prove `KeepAlive`, and
  verify it again.
- Do not claim Tailscale reachability from local service evidence. Verify Serve,
  Tailnet ACL admission, and a real remote-device load independently.

Exploratory evidence is written to the gitignored directory
`outputs/qa/<run-id>/`. Every run contains `summary.md` with the commit SHA,
runtime commands, database fixture, viewports, outcomes, failures, and links to
its captured screenshots, console log, and network log. Authenticated native
Codex smoke results use a separate subsection and never store credentials, raw
auth material, or native thread/provider content. The checked-in
`npm run probe:codex-follow-up -- --no-auth` command owns unauthenticated
compatibility proof. There is currently no supported checked-in authenticated
smoke command; record that cell as `NOT RUN` rather than reviving the retired
`smoke:native-codex` or `smoke:live-chat` entrypoints or substituting an ad hoc
driver. Any future authenticated smoke targets disposable planner data and
remains outside `npm test`.
Closeout names the exact run directory used for the final claim.

## Codex Planner Runtime Requirements Gate

The embedded Codex runtime is a separate release contract governed by
`docs/codex-agent-runtime-follow-up-phase.md`. The 2026-07-15 revision requires
a thin wrapper over native Codex history with one app-wide selected top-level
thread, native workers, hosted web search, skills, and planner tools available
together. Production HTTP/runtime composition no longer exposes the historical
`/api/chat/*` or `/api/transcript` ingress. Historical SQLite chat tables remain
only so existing data can be imported and exported; current proof is native.
Native browser/runtime proof below still gates any revised-capability claim and
does not rewrite the completed family-readiness signoff.

### Follow-Up Merge Gate

| Cell | Required boundary |
|---|---|
| Runtime compatibility and isolation | Deterministic current/newer-compatible/incompatible Codex fixtures prove updater-aware thread list/read/start/resume/archive, turn start/steer/client-message identity, native worker/item schema, dedicated-home provenance, normal-home standalone-skill discovery, minimal launch environment, the exact combined positive surface, and the complete parent/child negative boundary. Incompatibility disables only the affected Codex surface. |
| Native thread catalogue and selection | At least two real non-ephemeral top-level threads can be created, listed, read/resumed, selected, and revisited; D10 proves every page/cursor of a 100-thread catalogue in stable order with no omission/duplication. With history but no pointer, startup deterministically selects the most recently updated eligible thread; with an empty catalogue, startup creates nothing and first accepted send creates/selects exactly one thread. Navigation/new tabs retain the app-wide pointer; revisioned two-client races converge; selection does not clone/cancel work. Failpoints after native create and before/after selection publication prove ambiguity refreshes history and never auto-retries creation. |
| Native history authority | Two clients render actual-ID-bound native items plus typed planner-effect/readiness status. Pre-admission failure is not conversation; reconnect re-reads Codex; static/runtime checks prove no planner transcript rows, shadow thread index, or hidden history reconstruction. |
| Native background workers | One native child agent reports parentage, progress, failure/completion, switch-away-and-back, and read-only drill-down. A child-completed/parent-result-absent fixture cannot fabricate or terminate the top-level assistant reply. The active runtime must prove the worker's exact provider-tool manifest; Codex 0.142.5 gives workers no planner dynamic tools, so cancellation, timeout, out-of-tree identity, and late completion cannot create a worker-owned planner effect. The parent alone may act on a returned worker result. |
| Skill discovery and provenance | Exact release-owned planner skills and dynamically discovered `$HOME/.agents/skills` entries reach the top-level agent in captured input/readback and live behavior. Any skill guidance actually observed on a worker is inventoried rather than assumed. User-skill changes do not pin the app, and adversarial skill content cannot add tools, RPC methods, grants, or planner commands. |
| Identity typing | Type-level negatives and runtime cases prove top-level thread, child thread/job, turn, item/call, selection revision, request/idempotency, planner version, and sync revision cannot be interchanged. The normal path contains no Plan/Research discriminator or app-owned transcript contract. |
| Dynamic planner protocol | Deterministic app-server scenarios prove native turn start/steer plus client-message correlation and exactly `planner.read`, `planner.preview`, and `planner.apply` on the owning top-level turn. An ordinary running turn steers; there is no browser grant or approval-decision field. Dependent parent calls consume authoritative results; unknown, duplicate, changed-payload, out-of-tree, timed-out, cancelled, and late calls fail with the specified fencing behavior. |
| Planner operation parity | UI, embedded, and global callers exercise the same typed-command registry and mutation authority. One to sixteen ordered operations commit as one version/event/receipt/undo unit or not at all, with authoritative readback and no alternate mutation kernel. |
| Durable effect lifecycle | Real temporary SQLite tests cover accepted top-level effects, rejection of child-attributed callbacks, crash points before and after commit/tool-response/reply, restart readback, and immutable tool-call replay. The wrapper never auto-replays an ambiguous user send; after effect/reply loss, any household follow-up is an ordinary new native turn over authoritative planner readback. |
| Unified capability surface | One native top-level thread tree exposes hosted web search, the exact planner namespace, and skills without a mode/intent switch or hidden research/planner context. It proves an interleaved `planner.read -> web_search -> planner.preview -> planner.apply` path, a worker-assisted path, and a conversational no-tool path. |
| Web-assisted planning | Hostile/malformed web content may influence reasoning but cannot escape planner schemas, versions, idempotency, protected-state rules, or fixed authority. A real turn binds a completed search observation, informational source reference, accepted effects, and second-client readback without a cross-context candidate or false provenance claim. |
| No semantic cache | Static ownership checks and deterministic stale-state cases prove there is no native-history/planner/search semantic cache: switches/reconnects read Codex, planner changes force current read/OCC, an explicit search refresh reaches hosted search again, and only immutable idempotency replay returns a stored decision. |
| Availability and loss | Missing/malformed home, expired auth, history-read/search/app-server/worker/tool failure, restart, and incompatible update leave planner read/write and Global UDS available. Recoverable transport re-reads native history; a readable historical thread that cannot accept the active surface remains visible/unavailable-to-send beside a usable thread, and either can be selected without planner damage or hidden replacement. |
| Global UDS ingress | A real user-owned Unix socket proves its fixed route set, same-UID permissions, strict payloads, injected provenance, idempotent replay, stale-socket handling, browser-route isolation, and no TCP or SQLite fallback. Its readiness remains independent of embedded Codex compatibility. |
| Single-path architecture | Structural checks prove Codex exclusively owns native conversation history, the app owns only one selected pointer, one planner mutation authority serves UI/top-level-agent/Global calls, child-attributed calls reject at that boundary, no Plan/Research split or shadow worker system exists, and no agent client imports the database or exposes forbidden authority. |
| Release retention | Promotion and recovery preserve the authenticated agent home/catalogue and native history while selecting only fixed `app` and `app.previous` slots. Synthetic QA uses a disposable home and database. |
| Production promotion and recovery | `make promote` is the sole candidate-producing command and gates a detached committed `main` before disturbing the service or selected app. `make recover` is recovery-only. Both require mounted health/workspace readiness; neither command migrates, copies, restores, or prunes the production database. |

Existing planner-service, effect-ledger, Global UDS, and release-operator tests may support these cells. The additive native-thread backend tests and current-binary probe now own the deterministic API, history/selection, worker-projection, combined-capability, and top-level skill-discovery portions. They do not close the separately owned browser cutover, authenticated hosted-search behavior, installed-runtime, or release cells; every claimed cell is rerun on the final integrated candidate.

The normal baseline remains typecheck, production build, lint, and the existing
deterministic suite. Fakes at the Codex boundary must be checked against the
active generated protocol/schema before they can support a compatibility claim.

### Current-Binary No-Auth Compatibility Gate

Run the deterministic no-listener readback/resource regressions first. They
exercise malformed config/account/skill/pagination/RPC frames, including
oversized and shutdown-late subprocess output, without requiring authentication:

```bash
node --disable-warning=ExperimentalWarning --experimental-strip-types --test \
  tests/codex-runtime-compatibility.test.mjs \
  tests/codex-runtime-deployment.test.mjs \
  tests/codex-runtime-executable.test.mjs \
  tests/codex-runtime-readback.test.mjs \
  tests/codex-runtime-resource-policy.test.mjs \
  tests/architecture/codex-runtime-boundaries.test.mjs
```

The checked-in probe targets the unified native-thread capability contract. Run
that supported probe rather than an ad hoc app-server driver:

```bash
npm run probe:codex-follow-up -- \
  --no-auth \
  --output outputs/qa/<run-id>/codex-follow-up/current-binary.json
```

The artifact must be a newly created mode-`0600` JSON file. Inspect that it
records the exact executable version/hash, generated thread-list/read/start/
resume/archive, turn-start/steer/client-message, and parent/child schema hashes,
allowed `:read-only` profile, the exact combined web/planner surface,
release-owned planner skill identities/hashes,
bounded normal standalone-skill discovery metadata, native thread/worker
observations, dependent-call observation, empty forbidden/unexpected capability sets,
provenance hashes, empty MCP/app/plugin rows, and
`normalAuthUnchanged:true`. It must remain inactive and unauthenticated. Do not
preserve raw config/instruction/skill content, credentials, environment values,
provider payloads, thread content, stderr, disposable paths, or raw/other
normal-home state beyond the bounded standalone-skill metadata above. A failed
cell disables the optional embedded runtime; never weaken a
budget or boundary to make the installed binary pass.

### Global UDS Operator Smoke

Against a disposable real-file planner runtime, verify the pre-existing
`$HOME/meal-planner` parent is current-UID `0700`, then use only the supported
client:

```bash
npm run planner:global -- health
npm run planner:global -- workspace
npm run planner:global -- apply < batch.json
```

Record the UUID and payload hash outside stdout, confirm a second identical
apply replays, confirm changed-payload UUID reuse rejects, and observe the
accepted state from an independent browser client. Preserve no socket path,
database path, transcript, credentials, or raw page content in the evidence.

### Historical Follow-Up Release-Candidate Gate (Non-Authoritative)

The former manifest, receipt, current-pointer, activation-artifact, and database-restore release design is retired and non-authoritative. Current release proof is exclusively `Current Release Safety Cells`; historical material must not be used to plan or operate releases.

### Codex Runtime Exploratory QA Gate

Record follow-up evidence under `outputs/qa/<run-id>/codex-follow-up/`, separate
from the family-readiness run. Inspect:

- one composer with no Plan/Research control and draft continuity across the
  responsive chat surfaces;
- at least two native top-level threads listed from Codex history; history/select/new,
  one app-wide selected pointer across planner navigation/new tabs, selection
  conflict convergence, and exact native context after app-server restart;
- a natural foreground request in which one selected thread tree uses hosted search,
  standalone/planner skills, and a native child worker, then replaces an existing meal recipe with a visible
  informational source reference through dependent planner calls and
  authoritative readback;
- native worker progress/failure/completion and read-only drill-down while its
  top-level thread is temporarily unselected, with no late or duplicate effect;
- a visible after-effect/reply-failed state whose accepted planner effects are
  read back exactly once; the wrapper does not replay the user send, and any
  household follow-up is an ordinary new native turn;
- a deliberately unavailable selected thread that remains visible while the
  household selects another native thread or explicitly starts a new one;
- the first revised release retaining old app transcript/chat rows only in the
  immutable migration backup, absent from the live target store and native history/model context;
- static and runtime evidence that planner storage has no authoritative
  transcript, assistant-message, child-thread, or shadow-history rows;
- embedded-agent unavailable and incompatible states while ordinary planner use
  and the global UDS client remain healthy; and
- an equivalent sourced recipe or planner batch submitted by a normal global
  Codex session through the supported client.

Live evidence may establish acceptance against the active Codex build, but it
must never weaken schemas, assertions, isolation, or failure behavior to obtain
a green result. Credentials, raw authentication material, unrestricted page
content, and raw normal-home Codex content, paths, inventories, or fingerprints
are never captured in QA artifacts. Normal-home exclusion is proved through
effective config/instruction/capability readback, not a snapshot of unrelated
mutable user state.
