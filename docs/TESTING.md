# Testing And QA Contract

This document is the proof authority for the family-readiness implementation.
The detailed behavior and proof matrix live in
`docs/family-readiness-remediation-plan.md`; this file assigns those claims to
repeatable gates and repository paths.

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
- The deterministic LaunchAgent tests prove plist binding and lifecycle command
  behavior with a fake `launchctl`; they do not prove host launchd supervision.
  For a deployment claim, install the real service, verify health/workspace,
  terminate its child once to prove `KeepAlive`, and verify it again.
- Do not claim Tailscale reachability from local service evidence. Verify Serve,
  Tailnet ACL admission, and a real remote-device load independently.

Exploratory evidence is written to the gitignored directory
`outputs/qa/<run-id>/`. Every run contains `summary.md` with the commit SHA,
runtime commands, database fixture, viewports, outcomes, failures, and links to
its captured screenshots, console log, and network log. Authenticated native
Codex smoke results use a separate subsection and never store credentials, raw
auth material, or native thread/provider content. The historical entrypoint
name `scripts/smoke-live-chat.mjs` remains for compatibility, while
`npm run smoke:native-codex` is the canonical command and
`npm run smoke:live-chat` is an alias. The smoke always targets disposable
planner data and remains outside `npm test`.
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
| Release retention | Stage, activation, interruption, recovery, and rollback preserve the authenticated agent home/catalogue, revalidate selected metadata, keep synthetic QA ephemeral or journal/archive a required persistent probe before activation, and retain old app transcript rows only in the immutable pre-migration backup rather than the live target store or native history. |
| Local release transaction | Real private directories and SQLite files prove the exact stage/installed/auth/RC/QA/activation hash chain, content-addressed recovery operator, authority-lifetime ownership, one-time legacy drain, one-base `VACUUM INTO` capture, canonical-path build, app/data/config selection, intent/completed crash recovery, sole `current.json` commit, paired rollback pointer publication, newer-data retention, and refusal of an unproved data restore. Authenticated QA uses only an ephemeral probe or a persistent probe whose opaque native ID is journaled, archived, and verified absent from the default picker before activation; disposable planner data leaves household threads, selection, and planner data unchanged. Model/runtime architecture checks prove the operator is not reachable through any planner, Codex, HTTP, or UDS capability. Owned by `tests/local-release-operator.test.mjs`, `tests/planner-release-lifecycle.test.mjs`, `tests/integration/local-release-transaction.test.mjs`, the focused store/runtime/auth tests, and the release-boundary architecture checks. |

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

### Follow-Up Release-Candidate Gate

Before activating the dynamic embedded path:

1. Stage the exact candidate source, previous-family commit, explicit database,
   content-addressed operator, clean dependency graph, buildability, lint, merge suite,
   and deployment config/instruction identities in one private transaction. A
   staged build is preflight evidence only; it is not an installed-payload claim
   because Vinext currently emits build-root paths. Stage resolves and hashes
   exact Node `v22.15.0`, uses that binary to run npm, requires empty stderr
   after targeted type-stripping warning suppression, and rechecks the exact
   Node/npm executable/version/hash after the complete candidate suite and again
   around canonical installation and installed QA. The canonical install's npm
   graph must equal the staged graph. A newer operator runtime is not substitute
   evidence.

```bash
npm run planner:release -- stage \
  --candidate-source "$PWD" \
  --baseline-commit c811adc2b2fd05d5573933e10ca77e60f2d0e7ba \
  --data-source <absolute-planner.sqlite> \
  --agent-source <absolute-retained-authenticated-agent-home>
```

For first installation, `deployment/release/first-install-baseline.json` is the
release-managed authority for that exact prerequisite commit. An uninitialized
database is staged normally, but activation additionally requires
`--confirm-uninitialized-authority`; that confirmation is journaled before any
operator, pending-pointer, ownership, or filesystem effect and is then consumed
by handoff/recovery without another prompt. The flag is invalid for the accepted
initialized schema-4 source.

If an interrupted activation left the exact historical pre-adoption first-install
shape, or an update failed after publishing `pending.json` but before any release
effect, do not delete or rewrite it. Source-drift update recovery additionally
requires the same canonical database path/device/inode, a changed old identity,
and a fresh replacement whose stage exactly matches a live stopped-database
inspection. Stage the replacement in the same installation mode, including the
authenticated agent source for first install, then authorize that exact pending
ID only on replacement activation:

```bash
npm run planner:release -- activate \
  --transaction <replacement-activation-id> \
  --authorized \
  --supersede-pending <exact-stale-activation-id>
```

This is not a general abandon command. The installed content-addressed
replacement operator accepts only a reconciled pending-only journal with either
an exact operator-reuse checkpoint or completed operator-install intent/effect,
records the old transaction as `intervention_required`, and generation-CAS
replaces the pending pointer without an absent interval. Replacement state,
the recovery classification, old and replacement data identities, old
stage/journal hashes, and both pointer identities are durable before any old
journal or pointer mutation; recovery is proven on both sides of each intent
and effect. The content-addressed operator handoff precedes runtime ownership;
the stopped-runtime checks and SQLite write reservation are held before
checkpointing or replaying any old-journal/pointer mutation. Direct activation
or recovery of an ineligible historical
pre-adoption transaction remains fenced before operator handoff or filesystem
effects.

2. Use the returned activation ID for the single authorized transaction. It
   drains the legacy runtime, holds the source SQLite write reservation, derives
   rollback and candidate data from one `VACUUM INTO` snapshot, builds the
   candidate only at canonical `$HOME/meal-planner/app`, selects the private
   app/data/config pair, and retains ownership through authenticated readback,
   RC, QA, and the sole `current.json` commit.

```bash
npm run planner:release -- activate \
  --transaction <activation-id> \
  --authorized
```

3. Restore or reuse the existing authenticated dedicated home at
   `$HOME/meal-planner/agent`. The authentication-readback operator starts one
   fresh updater-managed `codex app-server` with `CODEX_HOME` set to that home and cwd fixed at
   `$HOME/meal-planner/app`, then requires
   `account/read({refreshToken:true})` to return the expected non-null ChatGPT
   account before the separately bounded planner capability smoke runs. It
   preserves real OS `HOME` and its `$HOME/.agents/skills` discovery surface
   while excluding normal `~/.codex` config/plugin/MCP/auth/session sources.
   Exact deployment-owned planner skills plus dynamically inventoried standalone
   skills may appear in effective readback. Activation never invokes login,
   logout, or login cancellation; copies credentials; or pins Codex. The
   compatibility-named `auth-lifecycle.json` now records this bounded readiness
   result only, with no email, device code/URL, raw response, token, credential
   content, or credential-derived hash/fingerprint. Identity or
   deployment-provenance drift before spawn or readback stops the readiness
   effect and publishes no readiness artifact; it never substitutes the
   updater's new target under old evidence.

The checked-in smoke now emits the exact schema-v2 native-thread evidence
contract. A new candidate's operator invokes it from the canonical installed
app:

```bash
npm run smoke:native-codex -- \
  --authorized \
  --scenario all \
  --output "$HOME/meal-planner/releases/<activation-id>/release-candidate.json"
```

- construct the complete unreleased single-path candidate first, including its final public HTTP/composition and legacy deletion, so live proof exercises the exact canonical app that will be selected; do not expose the candidate through the public production port or canonical Global UDS before commit;
- run the compatibility gate against the updater-managed current Codex and
  preserve the resolved path, version, hash, generated schema fingerprint, tool
  manifests, and negative-capability results;
- use the dedicated `CODEX_HOME` and the compatibility-named lifecycle artifact
  to prove that one fresh updater-managed authentication-readback app-server can
  proactively read the restored or reused authenticated account. This count is
  scoped to that readback operator; separate inactive compatibility/provenance
  probes and the planner capability smoke have their own bounded processes.
  Effective readback must exclude the normal `~/.codex` surface while allowing
  `$HOME/.agents/skills`; the gate must not fingerprint mutable skill contents;
- exercise at least two real persistent top-level threads across list/history,
  pagination, selection, archive, multiple turns, process restart, typed
  question handling, interrupt, native activity projection, and one native
  child worker, with hosted search, skills, worker result-to-parent flow, and an
  authoritative parent planner effect co-present; prove exact admission replay,
  changed-payload rejection, second-client readback, and native-state retention
  against a disposable planner store;
- prove authenticated smoke uses an ephemeral probe where possible; if a
  persistent probe is required, journal only its opaque ID, archive it through
  the native RPC, and verify it absent from the default picker before activation.
  Never write household native threads, selected-thread metadata, or production
  planner data;
- exercise the real Unix-socket client independently and prove an incompatible
  embedded-runtime fixture leaves planner/store/native history and global ingress
  available; and
- bind the complete `stage -> installed -> auth-lifecycle -> release-candidate
  -> qa -> activation -> current pointer` chain. Run installed-path verification
  and private production QA before household/global exposure; any failure before
  commit must atomically re-select the prior app/data/config pair. Then rerun the
  shared two-client race and restart cells without a source edit or runtime
  selector.

Installed QA binds `releaseCandidateEvidenceSchemaVersion: 2`, reads the native
`/api/codex/threads` boundary before and after runtime restart, and requires the
connection epoch to change while the response remains exact-contract valid. Its
focused server boundary suite is `tests/http-application.test.mjs`,
`tests/codex-native-thread-service.test.mjs`, and
`tests/architecture/legacy-conversation-cutover.test.mjs`; historical chat
tables remain data-compatibility evidence only.

Private installed browser QA has two explicit evidence cells. First, one
installed-only Playwright check reads the exact initialized selected-data clone
before reset and binds its planner version, sync revision, schema, active week,
and rendered selected-week UI; `qa.json` calls this
`selectedCloneBrowserReadback` and binds the exact clone as
`selectedCloneSha256`. The harness then resets only that disposable
clone and runs the existing Codex and family-dinner specs as
`freshDeterministicJourneys`. Those deterministic conflict, recovery, restart,
and device journeys do not claim to have used preexisting family state.
The installed D4 run also executes the five-route reload-safe operation-journal
matrix, including copied-tab replay and storage-failure/no-network proof.

Installed QA also runs the closed D4 canonical-week and D7 initialized
zero-week seeds at widths `320`, `375x400`, `428`, `620`, `700`, `701`, `768`,
`840`, `841`, `980`, `1280`, and `1920` CSS pixels. The D7
selector enters only through the runtime `seedFactory`; unknown selectors fail
before runtime start and no test-only HTTP mutation exists. Each viewport emits
PNG, geometry, and direct `@axe-core/playwright` evidence. The transaction
requires every D4/D7-by-viewport tuple, decodes PNG chunks/pixels, and validates
dimensions, zero axe violations, hashes, and canonical relative paths before
binding the manifest SHA-256 into `qa.json`.

The authenticated candidate artifact also records the observed tool and
negative-capability projection, effective config/instruction isolation evidence,
authenticated account kind, bounded dedicated-home retention counts, complete
candidate source manifest, and predecessor artifact hashes. It does not inventory
or fingerprint mutable normal-Codex state. Immediately before the sole pointer
commit, the operator runs from the final app:

```bash
npm run verify:codex-activation -- \
  --artifact "$HOME/meal-planner/releases/<activation-id>/release-candidate.json"
```

The transaction invokes this verifier after installed/visual QA and immediately
before `activation.json`; this is not a separate continuation lifecycle. The
read-only verifier requires schema v2, rechecks the stable native top-level and
worker tool surfaces, hosted-search mode, planner and skills namespaces,
standalone-skill identity, and exact executable/path/version/hash/schema/config/
instruction/account coordinates, then requires the immutable stage candidate
manifest to match the live receipt.
It does not log in, log out, cancel authentication, copy credentials, pin Codex,
deploy, or activate.
Mismatch or any source edit reruns the live gate or stops. This binds the one-time
cutover without pinning later compatible updater-managed Codex versions, which
continue through the ordinary dynamic compatibility gate.

The release transaction re-reads immutable `installed.json` before and after
private QA, publishes immutable `activation.json`, then atomically replaces
`current.json` as the only commit. Its exhaustive deterministic matrix exercises
every lifecycle checkpoint and injected crash boundary: concurrent mutable
pointer writers, crash-released SQLite writer mutexes, malformed pending journals,
start-time frozen app/operator drift, concurrent start or
release ownership, failed clean install/build, manifest drift, missing or
corrupt prior release, backup failure, migration failure, first and second app
rename failure, installed-coordinate drift, QA failure, app-only/data-only
rollback attempts, interrupted recovery, exact replay, rollback pointer
publication, and post-commit planner/selected-thread/effect/tool/receipt changes.
The same matrix covers authenticated-home adoption before the production
dynamic readback, stale-pending supersession through the installed operator,
malformed reconciled histories, invalid replacement states, stale-old fencing,
and intent/effect crashes on both sides of the no-gap pending-pointer CAS.
It also injects crashes after persistent-probe thread creation, opaque-ID journal
intent, native archive request/completion, and default-list exclusion readback;
recovery resumes the same archive effect, and activation cannot commit while a
probe remains selectable.
Automatic data restore requires a fresh closed whole-store snapshot SHA-256 to
equal the activation snapshot; otherwise restore fails unless the operator
supplies the exact activation/current/restore authorization, and the newer data
directory remains retained. Recovery takes another fresh snapshot before a new
destructive intent and requires new authorization if the store changed. `run/`, Codex
credentials, normal-home state, and the updater-managed Codex target never enter
the release payload or database backup.

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
