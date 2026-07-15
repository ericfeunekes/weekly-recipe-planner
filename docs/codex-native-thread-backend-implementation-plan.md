# Native Codex Thread Backend Implementation Plan

**Status:** backend slice implemented and in closeout. The planner UI is owned
by a separate task. This plan does not edit `app/**`.

## Completion Contract

The application server exposes a closed, typed HTTP/long-poll wrapper over one
long-lived updater-managed Codex app-server. A frontend can list, select, read,
create, archive, send to, steer, and interrupt persistent native Codex threads;
render messages, reasoning summaries, plans, web/tool activity, and workers;
answer pending Codex questions through a listed-option-only response channel; and render command, file, permission,
and MCP approval requests as separate sanitized blocked notices. Codex remains
the only conversation-history authority. The planner persists only the
selected-thread revision, bounded native mutation-admission markers, and native
planner-effect receipts/fences.

Shell, file change, direct filesystem/database, browser/computer, arbitrary
network, app/connector, MCP, and permission-escalation capabilities remain
unavailable. If the app-server nevertheless requests command, file, MCP, or
permission approval, the host rejects it before exposing a non-actionable
notice. `request_user_input` is the only interaction for which the browser may
submit a response, and that response must select exactly one displayed option
label per question; Codex's free-form `Other` channel is not exposed. Raw reasoning content, raw app-server RPC, request
correlation IDs, approval payloads, tool arguments/results, filesystem paths,
and credentials never reach the browser.

## Exact Protocol Baseline

The current generated experimental schema and matching `rust-v0.142.5` source
prove the required shapes for:

- `thread/list`, `thread/read`, `thread/start`, `thread/resume`, and
  `thread/archive`;
- `turn/start`, `turn/steer`, and `turn/interrupt`, including
  `clientUserMessageId` and `expectedTurnId`;
- `item/started`, `item/completed`, message/plan/reasoning deltas, thread/turn
  lifecycle notifications, `collabAgentToolCall`, and `subAgentActivity`;
- `item/tool/call` and `item/tool/requestUserInput`; and
- the command/file/permissions approval requests that the planner must reject.

`thread/turns/items/list` is declared but returns unsupported in 0.142.5 and is
not used. `thread/read(includeTurns:true)` is the native persisted-history
authority, but Codex documents that reconstruction as lossy for some live agent
interactions. The app keeps only a bounded process-local change-reason history
and pending-interaction registry. A connection-epoch change or revision gap
tells clients to re-read native history; the change signal is never treated as
a durable transcript.

## Public Backend Contract

Add `lib/codex-thread-contract.ts` with exact request validators and sanitized
DTOs for these fixed routes:

| Route | Result |
|---|---|
| `GET /api/codex/threads` | selected ID/revision, connection coordinates, and paginated eligible top-level native threads |
| `GET /api/codex/thread?threadId=...` | sanitized top-level or read-only child thread, turns, items, worker summaries, and pending interactions |
| `POST /api/codex/threads/new` | create one persistent native thread and CAS-publish selection |
| `POST /api/codex/threads/select` | validate/resume a native thread and CAS-publish selection |
| `POST /api/codex/threads/archive` | archive a native conversation and reconcile selection |
| `POST /api/codex/turns/send` | verify selection and choose native start or steer |
| `POST /api/codex/turns/interrupt` | verify selection and interrupt the exact active native turn |
| `GET /api/codex/interactions` | a strict union of answerable pending user questions and separate sanitized read-only blocked approval notices |
| `POST /api/codex/interactions/respond` | verify selection/thread binding and answer one current question request exactly once |
| `GET /api/codex/events?connectionEpoch=...&afterRevision=...&waitMs=...` | bounded activity/interaction change signal with revision, reason kinds, resync flag, and optional long-poll wait |

The event route returns a connection epoch, current revision, bounded reason
kinds, `changed`, and `resyncRequired`; consumers then read authoritative native
state. It waits no longer than the existing front-controller timeout and
therefore needs no WebSocket/SSE proxy special case. There is no generic RPC
route. Mutation routes use the existing origin/fetch
metadata admission. IDs, cursors, messages, answers, revisions, item counts,
and aggregate bytes have closed bounds and reject unknown fields.

Questions and approvals remain separate first-class interaction DTOs even
though one bounded collection route carries their discriminated union. Only a
`user_input` item has a response path. An `approval` item reports its safe
category and `rejected_by_policy` resolution; no public contract accepts an
approval decision.

Human-facing labels are server-owned stable projections paired with machine
kinds: planner read/preview/apply, hosted search/open/find, plan, reasoning
summary, worker spawn/message/resume/wait/close, context compaction, and generic
unknown activity. Only `reasoning.summary` is exposed; `reasoning.content` and
raw reasoning deltas are discarded.

## Runtime And Authority Design

Add an isolated `server/codex/**` subtree:

1. `app-server-client.ts` owns one initialized JSONL process, multiplexes a
   closed method union, rejects malformed/oversized frames, rejects all pending
   requests on loss, and never auto-replays an ambiguous mutation.
2. `activity-projection.ts` validates/sanitizes persisted items and live
   notifications. It maintains only a bounded epoch/revision signal for
   long-poll invalidation.
3. `interaction-registry.ts` maps an opaque browser interaction ID to one live
   app-server `request_user_input` request. It rejects native secret-input
   questions, projects only two or three unique listed options, disables the
   free-form `Other` response, accepts exactly one displayed label per question,
   keeps omitted/null auto-resolution blocking, honors only an explicit provider-valid
   auto-resolution window, settles `serverRequest/resolved` idempotently across
   startup and steady state, and enforces one response. Command/file/permission/MCP requests never
   enter the answerable registry: the session rejects them immediately and
   publishes only a bounded sanitized approval notice in the public interaction
   union.
4. `planner-effect-host.ts` accepts only the exact `planner` dynamic namespace.
   It validates that the caller is the eligible owning top-level fixed-cwd
   app-server thread, reserves/replays an exact native `(thread, turn, call,
   tool, argumentHash)` fence, and invokes the existing planner
   read/preview/apply service. A callback attributed to a child thread fails
   closed because Codex 0.142.5 starts workers with an empty dynamic-tool vector;
   workers return research/reasoning to the parent, and the parent alone may
   make the resulting planner call. Apply request IDs are deterministic from
   native identity; immutable planner receipts make crash replay idempotent. The
   additive backend rejects planner `archiveWeek`; this thread API carries no
   planner authority grant, while the separate typed planner/UI path remains
   available. Native conversation archive through `thread/archive` is
   implemented here and is unrelated to that planner command.
5. `thread-service.ts` owns selection CAS and per-thread admission locks. It
   lists only non-ephemeral fixed-cwd `appServer` roots, resolves direct children
   through native parent filters, validates selection before any send, chooses
   `turn/steer` only for an exact active regular turn, and never blindly replays
   create/archive/send/steer/interrupt after transport ambiguity. Durable
   thread-start and turn-send admissions let the live owner—or a replacement
   runtime after exclusive startup adoption—reconcile a timed-out call against
   native history by exact client identity. A foreign live service cannot read,
   clear, complete, or take over that admission. Reconciliation publishes the
   already-created result or proves absence before allowing another attempt.

On first read, an absent selection is CAS-initialized to the most recently
updated eligible root when one exists; no-history remains an explicit null
selection. A selected thread that later becomes unreadable or externally
archived remains an explicit unavailable selection until the household selects
another thread or creates a new one. Archive clears the pointer with the same
expected revision only when the archived thread is still selected; it never
silently chooses a replacement.

Thread eligibility is established before execution from validated start/resume,
list/read, and parent/child events and kept only in a process-local graph. A
dynamic callback never performs a nested app-server request while the server is
waiting for that callback. On reconnect the service rehydrates eligible roots
and children before resuming execution; an unknown caller fails closed.

Persistent top-level thread parameters are fixed by the host: non-ephemeral,
dedicated cwd/home, read-only permission profile, approval policy `never`, no
environments or workspace roots, hosted web search, standalone skill
instructions, native worker orchestration, and exactly the planner dynamic
namespace. Workers use the app-server's bounded research/reasoning surface and
return results to the parent; they do not inherit dynamic planner tools.
Forbidden feature and MCP/app/plugin surfaces are explicitly disabled. Updates
are admitted by the existing semantic schema/capability fingerprint, not by a
Codex version pin.

## Persistence

Migration 006 adds:

- singleton selected native thread ID, monotonic selection revision, and update
  time; and
- native planner-tool fence rows containing opaque native identity, tool and
  argument hashes, bounded result envelope, mutation receipt/event coordinates,
  state, and timestamps.

Migration 007 adds only bounded ambiguity admissions:

- one singleton thread-start admission containing the pre-call newest-root
  cohort, live-owner identity, and operation identity; and
- one per-thread turn-send admission containing the exact client message
  identity, live-owner identity, a request hash binding the selected-thread
  revision, expected turn/start-versus-steer state, and timestamps.

Migration 008 adds an exact finite horizon of successful create/send receipts.
A create receipt binds the request hash, native thread, and published selection
revision. A send receipt additionally binds the unique client message and
authoritative native turn. Receipt insertion, selection publication where
applicable, and admission deletion share one SQLite transaction. The oldest
settled insertion falls outside the horizon once 256 receipts are retained;
there is no probabilistic retirement filter or claim of replay beyond that
explicit window.

Those rows contain no message body, answer, reasoning, tool payload, worker
content, or conversation index. They do contain request hashes and opaque
request/client/native identities needed for exact replay. Selection publication
or send completion, receipt insertion, and admission clearance co-commit, so a
crash cannot publish a result while leaving it eligible for blind replay.

The store enforces a bounded call count per native turn. A same-process exact
duplicate shares one in-flight owner. After restart, an exact row still marked
running may be reclaimed once and safely re-executed: read/preview are pure and
apply reuses the deterministic planner request ID, so the mutation service
returns its immutable receipt. Planner mutation, receipt/event creation, and
terminal native-call fence completion co-commit in the same SQLite transaction;
a crash before that commit leaves no planner effect. A changed tool or argument
hash never reclaims the row.

There is no native message, assistant text, reasoning text, search result,
worker graph, thread index, question table, or approval table. Pending questions
and blocked approval notices are bounded live interaction state; native history
remains the durable conversation view. Existing legacy chat/transcript tables
remain untouched during this additive backend slice so the separately owned UI
cutover can occur without a mixed-worktree break; they are not read or written
by the native service.

## Four Implementation Waves

### Wave 1 — Contract and protocol client

- Add the closed DTO/validator module, item/activity projection, JSONL client,
  interaction registry, and a stateful native fake app-server.
- Expand compatibility schema files/RPC policy for the native subset and reject
  breaking drift while accepting additive Codex changes.
- Proof: protocol envelope, all native lifecycle methods, client message IDs,
  activity projection, raw-reasoning exclusion, user-input response correlation,
  and separate sanitized forbidden-approval rejection.

### Wave 2 — Selection and planner effects (complete)

- Add migration 006 and store methods for selection CAS and exact native
  planner-tool reservation/completion/replay.
- Implement the planner effect host through the existing mutation service.
- Proof: reopen/CAS races, no transcript persistence, read/preview/apply,
  duplicate replay, changed-argument conflict, crash after reservation, crash
  after accepted mutation, child-attributed callback rejection, worker-result to
  parent-owned effect flow, and forbidden planner archive.

### Wave 3 — Native service and HTTP/long-poll composition (complete)

- Implement catalogue/read/create/select/archive/send/steer/interrupt,
  answerable-question and blocked-approval interaction projection, bounded
  long-poll event, and runtime lifecycle composition.
- Add fixed routes to the current application router without changing UI files.
- Update deployment-owned Codex config/instructions to the unified top-level
  web+skills+planner+worker-orchestration surface while preserving the
  forbidden boundary.
- Proof: two tabs and two threads, stale selection, per-thread concurrency,
  background unselected turn, restart/re-read, ambiguous mutation behavior,
  child hierarchy, long-poll epoch/revision resync, origin/method/body
  rejection, and planner health independence when Codex is unavailable.

### Wave 4 — Exact runtime gate and closeout (source-complete; integrated UI/live release proof separate)

- Extend the disposable capability probe for persistent native lifecycle,
  combined surface, worker events, user input, and separately typed forbidden
  approval notices. Never authenticate or mutate the production dedicated home
  in unit/probe tests.
- Persist the exact worker tool manifest observed by that probe. The compatible
  manifest excludes the planner namespace; a future runtime that adds it is
  incompatible until requirements and proof are deliberately revised. Exercise
  worker spawn-to-bounded-`wait_agent` mailbox completion, final report-to-root, `request_user_input`, and dependent planner
  `read`/`preview`/`apply`; classify deadline aborts as transient while retaining
  concrete protocol violations.
- Treat native-worker exclusion from the planner dynamic namespace, bounded
  research/reasoning return flow, and the forbidden capability boundary as a
  blocking empirical gate, not an inference from generated item schemas. A
  future Codex update may expose worker dynamic-tool inheritance only after a
  requirements revision and explicit safe compatibility proof.
- Run typecheck, focused tests, production build, full deterministic tests,
  lint, and `git diff --check`; independently review architecture, failure
  boundaries, secret safety, and proof fidelity; fix to convergence.
- Report the additive backend source identity and the remaining separately owned
  UI-cutover/browser-live-proof work without activating or releasing production.

## Proof-to-Claim Map

| Claim | Required evidence |
|---|---|
| Native conversation authority | Stateful schema-faithful fake proves create/list/read/resume/archive across process restart; the actual disposable app-server proves the generated method schemas, fixed authority readback, native root/worker identity, and the combined provider turn; no app transcript write |
| One selected thread across clients | Durable revision/CAS tests with stale concurrent callers and restart |
| Natural single composer backend | One send route chooses start/steer; no mode/intent/capability selector in the new contract |
| Thinking/activity exposure | Persisted and live projection tests for summaries, plans, web, tools, workers, errors, and raw-reasoning exclusion |
| Human-friendly tool names | Exact machine-kind/label table tests plus bounded generic unknown projection |
| Questions | Listed-option user-question round trip with blocking versus explicit auto-resolution, duplicate/stale/wrong-thread/expired rejection, startup resolution ordering, and no approval-decision shape |
| Blocked approvals | Separate typed command/file/permission/MCP notices prove immediate protocol rejection, `rejected_by_policy`, and absence of raw payloads or any grant route |
| Planner effects remain safe | Same mutation kernel, deterministic top-level request identity, receipt replay/conflict, exact native call fence, authoritative readback, and child-attributed callback rejection |
| Compatible Codex updates remain dynamic | Expanded semantic schema/capability gate accepts additive drift and rejects missing/changed required shapes without version allowlist |

## Explicitly Separate Work

The UI task consumes this backend to remove Plan/Research controls and the old
app transcript. Installed-browser/live-auth release proof and production
activation occur only after that UI cutover is reconciled. This backend task
does not modify `app/**`, authenticate, stage, activate, recover, or release.
