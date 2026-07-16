# Family Readiness Remediation Plan

Status: implemented and family-readiness signed off at `217e81306160346fc944712175059bece5da23d0` on 2026-07-11; Tailscale exposure and the expanded Codex runtime remain separate follow-up work

Closeout evidence: the exact candidate passed Node 22.15 typecheck/build and 138 deterministic tests, lint, both Playwright family flows, authenticated Codex smoke, development and production health checks, durable browser-plan import/restart readback, and multi-viewport visual QA under `outputs/qa/2026-07-11-family-readiness/`.

## Locked Invariants

These constraints are not challenge variables. A proposed simplification or alternative is blocked unless it satisfies them or cites a later explicit user decision that overrides them.

| Name | Locked invariant | Source |
|---|---|---|
| Shared Household Authority | The planner, prep state, groceries, timers, notes, history, and chat are one household workspace without per-person accounts or private copies. | User decisions in this task; `docs/functional-spine.md` |
| No Silent Lost Writes | Concurrent family actions cannot silently overwrite an accepted change. Conflicts and retries require deterministic server-owned resolution and authoritative readback. | User direction to use shared state with standard race resolution |
| Canonical Shared Steps | An instruction step has a stable ID, zero or more ingredient-amount lines displayed above one free-text instruction, one shared completion Boolean, an optional duration plus persisted timer start, and one optional note. Prep stores only ordered references to those steps. Removing or reordering a prep reference never removes, copies, completes, or reorders the recipe step. Timers do not notify or complete a step automatically. | User-defined prep simplification; `docs/functional-spine.md` |
| One Global Transcript | Chat is one shared household transcript. Step text submitted through **Send to ChatGPT** enters that transcript; **Add note** updates the step without also sending chat. | User decision in this task; `docs/functional-spine.md` |
| Dinner Execution | The family-pilot gate must prove the real workflow with a manually ordered, cross-recipe prep list: reorder and remove references, complete work ahead of time, reopen on the meal day to see completed versus remaining steps, keep a timer running across reload without notification or auto-completion, propagate groceries and cooked/leftover state, and observe committed changes from another client. | User's family-dinner readiness request and accepted QA scope |
| Real Multi-Week Model | Past, current, and future weeks have canonical IDs and states. Calendar navigation cannot remain a client-side set of placeholders. The authority design implements planned/active/archived transitions once, while the family-dinner pilot need not exercise the whole lifecycle UI. | Locked decisions in `docs/functional-spine.md` |
| Tailscale Later | Tailscale Serve, service installation, TLS, Tailnet ACLs, and remote-device reachability are not part of this application implementation or its completion claim. | Explicit user deferral |
| Codex Runtime Follow-Up | Dedicated `CODEX_HOME`, embedded web research, dynamic multi-tool planner actions, global-Codex import, and Chrome integration stay out of this implementation plan. The current family-readiness release retains one structured reply plus at most one typed planner command. | User decision on 2026-07-10; `docs/codex-agent-runtime-follow-up-phase.md` |

## Frozen Contract

- The planner is one shared household workspace. Planner state, prep completion, timers, groceries, notes, feedback, event history, undo, and the ChatGPT transcript are authoritative and visible to every independent client that can reach the same application server.
- UI actions and Codex-issued typed commands use the same mutation boundary and have equivalent mutation authority.
- Concurrent writes must not silently overwrite accepted work. The system must define optimistic concurrency, idempotent retry, deterministic conflict handling, and authoritative readback.
- Tailscale Serve exposure and deployment are a later lane. This remediation covers an application shape that can be placed behind that boundary, but does not configure or prove Tailscale access.
- The family-dinner pilot and the broader family-release claim are separate gates. The pilot proves shared dinner execution. Calendar correctness, destructive reset removal, input feedback, stored-data invariants, mobile ChatGPT dialog behavior, and top-level navigation scroll remain required before the broader QA remediation is called complete.

## Remediation Lane Manifest

| Cluster | Lane purpose | Agent | Expected output | Status |
|---|---|---|---|---|
| Shared household authority and races | Structural audit of state ownership, command/event transaction boundary, and minimum server/store shape | `/root/shared_state_architecture` | Boundary matrix, race model, structural route, locators | complete |
| Shared-state proof bar | Discover realistic local proof for persistence, concurrent clients, retries, timers, and recovery | `/root/shared_state_proof` | Existing infra, missing proof cells, capability-gap judgment | complete |
| Client-owned snapshot siblings | Sweep every non-transactional whole-record authority and stale-snapshot overwrite path | `/root/snapshot_sibling_sweep` | Locator and disposition per sibling, including empty sweeps | complete |
| Boundary/error UX siblings | Sweep silent command rejection, input-bound mismatches, destructive actions, temporal constants, and modal/navigation siblings | `/root/boundary_ux_sweep` | Locator and disposition per sibling, including empty sweeps | complete |
| Boundary/error UX proof bar | Discover realistic local proof for calendar, validation, recovery, modal focus, scroll, and destructive workflows | `/root/boundary_ux_proof` | Existing infra, missing proof cells, capability-gap judgment | complete |
| Architecture challenge | Reject or defend authority boundaries, OCC, sync, SQLite, and chat lifecycle ownership | `/root/architecture_challenge` | Grounded objections and required plan changes | complete |
| Proof challenge | Attack concurrency, crash, recovery, browser, and live-boundary proof sufficiency | `/root/proof_challenge` | Missing proof cells and false confidence risks | complete |
| Intent/pragmatism challenge | Check transcript/user decisions and smallest shippable family workflow | `/root/intent_pragmatism_challenge` | Scope violations, missing requirements, sequencing objections | complete |
| Formal transcript audit | Re-read the full user conversation and protect exact prep, timer, chat, and dinner intent | `/root/family_plan_intent_auditor` | Transcript-backed blockers and second-pass signoff | complete; signed off |
| Formal scope challenge | Defend the smallest coherent authority/chat/dinner release and cut unrelated gates | `/root/family_plan_scope_challenge` | Accepted cuts, rebuttals, and second-pass signoff | complete; signed off |
| Formal architecture/proof challenge | Attack executable state, runtime, migration, transaction, and proof boundaries | `/root/family_plan_arch_proof`, `/root/arch_second_pass` | Load-bearing blockers and second-pass signoff | complete; signed off |

## Review Snapshot

The QA pass found that the single-browser cooking workflow is broadly functional, but the family-readiness contract fails because the browser owns the complete state record and chat transcript, Today/Tonight is fixed to a stale date, stale tabs can overwrite accepted work, reset is irreversible, several validation failures are silent, persisted-data recovery tolerates invalid invariants, and the mobile ChatGPT sheet does not behave as a modal dialog.

The upstream QA did not use the formal DESIGN/CODE/PROOF axis vocabulary. This plan carries its explicit release meaning rather than reclassifying it:

| Review finding | Carried disposition |
|---|---|
| Browser-local state, independent-client isolation, stale-tab overwrite, and shared chat authority | Release blockers; must fix before claiming shared household readiness |
| Hardcoded Today/Tonight | Release blocker; must fix before dinner execution |
| Reset without confirmation, stale whole-snapshot undo/history restore, and mobile ChatGPT focus escape | Major; must fix in this pass |
| Invalid prep dates, weak stored-data invariants, damaged-history fallback, and silent 4,001-character loss | Medium integrity findings accepted by the user for this pass |
| Retained scroll across top-level views | Minor accepted improvement; in scope because the user accepted the QA points |
| Tailscale Serve configuration, service installation, and remote-device reachability | Explicitly moved by the user to a later deployment lane |
| Dedicated Codex home, web research, multi-call planner tools, and external Codex import | Moved to `docs/codex-agent-runtime-follow-up-phase.md`; Chrome is recorded there only as a later non-goal |

No prior remediation plan exists for this surface, so the recurrence/root-closure checkpoint does not apply yet.

## Selected Architecture

Build one local modular-monolith application server backed by one SQLite database. Keep the pure typed-command reducer pattern and compatible transition logic, but refactor the state/command vocabulary for canonical weeks, ISO dates, slots, and server-owned IDs. Remove authoritative state, history, undo, transcript, and Codex command application from React.

All application processes remain loopback-only. In development, Vite is the browser-facing origin and proxies `/api/*` to the application/API process. In local production, the Node application process is the browser-facing front controller: it handles `/api/*` itself and reverse-proxies every other request to an internal `vinext start` web process. Tailscale Serve can later expose that one composed origin without binding the Codex app-server transport directly to the LAN. This plan proves shared state only among clients that reach that origin; remote-device reachability remains a deployment claim.

### Architecture Decisions

1. **Server authority:** SQLite is canonical for the singleton household workspace. Browser state is a disposable read model.
2. **Storage shape:** Store one canonical `HouseholdPlannerState` JSON aggregate containing timezone, nullable active-week ID, canonical week IDs/start dates/statuses, and week-local planner data. Relational tables hold events, command receipts, chat lifecycle, transcript entries, and migrations. The workspace row does not duplicate timezone or active-week values as competing columns. Normalizing every meal/step table or adopting event sourcing adds no current query value.
3. **Runtime:** Use built-in `node:sqlite`, set and explicitly test the repo's declared minimum Node version at `>=22.15.0`, and use explicit SQL migrations, `WAL`, `foreign_keys=ON`, `busy_timeout`, `synchronous=FULL`, and `quick_check` at startup. The checkpoint raised the former 22.13.0 floor because the installed Cloudflare Vite plugin imports `node:module.registerHooks`, which is absent there and present in Node 22.15.0. Do not restore D1/Drizzle for this local Codex-backed authority.
4. **Planner concurrency:** Use one `planner_version` for planner commands. Whole-planner optimistic concurrency is conservative but sound for a small household; do not add per-entity merges or CRDTs.
5. **Shared invalidation:** Use a separate monotonic `sync_revision` for every shared change, including transcript and chat-turn state, so chat activity does not make planner commands stale.
6. **Idempotency:** Every command and chat submission has a client-generated request ID. A repeated ID with the same canonical payload returns its stored result; reuse with another payload is rejected.
7. **Propagation:** Use one conditional `GET /api/workspace` every 2 seconds while visible, immediate focus refresh, and authoritative post-command readback. One complete workspace representation plus one monotonic revision avoids partial-resource merge rules at household scale. Older event/transcript pages load only when requested. Defer split-resource polling or SSE until measured payload or latency justifies it.
8. **Offline behavior:** Show the last read model as explicitly offline/read-only. Do not queue planner commands or chat turns for later replay.
9. **Undo:** Support latest-committed-event undo only, guarded by current `planner_version`. Remove arbitrary historical whole-snapshot restore from the normal UI.
10. **Legacy bootstrap:** Never silently choose a browser snapshot or install seed during startup. While the database is uninitialized, `GET /api/workspace` returns a blocking `initialized: false` state and planner controls remain disabled until a person explicitly submits either Import or Start Fresh. One transactional bootstrap then imports the exact `{data, events, chatMessages}` payload stored under `weekly-recipe-planner:v2` through a version-specific transform or installs the canonical seed. Because that prototype omitted week identity, the v2 transform assigns its known Monday start `2026-07-06`, maps day indexes from that date, converts known display prep dates to ISO dates, and assigns the `dinner` slot. It projects arbitrary legacy transcript messages into transcript inputs. Legacy event records are counted and discarded as history because they contain only display summaries and obsolete command names, not enough trusted data to reconstruct canonical typed commands or undo bases; their resulting completion/note/timer state remains in the imported aggregate. The transform then runs strict canonical validation. Two simultaneous bootstrap attempts produce one winner and one authoritative readback; the browser retains its snapshot until its import is accepted and preserves it for recovery if another client initializes first. Bootstrap is permanently disabled after initialization.
11. **HTTP boundary:** Keep the API loopback-only, same-origin through the web proxy, JSON-only for mutations, and strict about `Origin`/fetch metadata. Do not expose permissive CORS or let browsers assign the `Codex` actor.

Rejected alternatives:

- `storage` events or `BroadcastChannel`: cannot share across devices and preserve browser authority.
- Whole-snapshot `PUT`: retains last-write-wins overwrite behavior.
- Per-entity merge, CRDT, or event sourcing: unnecessary complexity for current household scale.
- D1: splits the local Codex/data authority and couples this pass to a deferred deployment choice.
- Browser-supplied planner state/transcript for ChatGPT: stale and untrusted by construction.
- SSE/WebSockets: add connection/recovery protocol complexity before household-scale polling has shown a problem.

## Authority Boundary

| Layer | Owns | Must not own |
|---|---|---|
| React UI | View, selected week/meal/drawer, filters, form drafts, pending/error presentation | Durable planner data, transcript, event log, undo snapshots, command execution |
| HTTP routes | Envelope validation, status/error mapping, household actor assignment | Direct SQLite writes or domain mutation |
| Planner command service | OCC, idempotency, and orchestration through the shared mutation kernel | UI state, raw SQL, or Codex protocol details |
| Transactional mutation kernel | One materialized reducer command plus workspace/event/receipt writes inside a caller-owned unit of work | Opening nested transactions, accepting multiple commands, or calling external services |
| Chat-turn service | One shared in-flight turn, canonical bounded prompt construction, Codex adapter call, fenced completion, and transcript persistence | Direct planner mutation outside the shared kernel or an automatic recovery queue |
| Domain reducer | Pure command validation and state transition with injected server time and server-materialized IDs | Persistence, network, ID generation, actor trust, retries |
| SQLite store | Migrations, transactions, version checks, durable rows, constraints, and readback | Domain-policy branching outside typed store operations |
| Codex adapter | ChatGPT-authenticated app-server protocol and structured reply/command | Planner authority, transcript authority, browser credentials |

The implementation may combine small files, but these ownership boundaries must remain visible: one SQLite store with `transaction(fn)`, one planner application service exposing the shared mutation kernel, one chat service, one HTTP router, one Codex adapter, and one typed browser client. Separate `unit-of-work`, `planner-mutation`, and `planner-command-service` files are not required if a smaller module keeps the same dependency direction and test boundary.

The shipped runtime topology is part of the change:

- `scripts/dev.mjs` launches the application/API process plus `vinext dev`, propagates shutdown, and fails when either exits. Vite `server.proxy` handles `/api/*` only in this development topology.
- A matching `scripts/start.mjs` launches `vinext start` on an internal loopback port and the Node application/front-controller process on the public loopback port. The front controller handles `/api/*` and reverse-proxies all other HTTP requests to Vinext. It owns real forwarding/error/timeout behavior; the plan does not assume Vite `server.proxy` works in production.
- `server/index.mjs` owns startup, migrations, readiness, front-controller HTTP shutdown, SQLite, and composition of planner/chat/Codex services. The browser never calls the internal Vinext or Codex transport ports directly.
- Responsibilities currently in `bridge/server.mjs` are split explicitly: HTTP/origin validation moves to the API router, canonical prompt/output-schema work moves to chat/Codex services, and process transport remains in the Codex adapter. `bridge/validation.mjs` either becomes shared contract code or is removed after callers move.
- `worker/index.ts` remains a web-only Vinext/Cloudflare entry and never owns household data. `build` may still build that web surface; local `start` must compose it with the Node authority. Cloud hosting is not the family runtime in this phase.
- `package.json`, README, and scripts name the real family runtime and its data directory. A successful web-only build is not application-readiness proof.
- `app/planner-client.tsx` owns rendering and device-local state only; `app/planner-api.ts` owns HTTP synchronization. The domain/command modules remain framework-free but receive a real contract refactor, not only an aggregate wrapper.
- A small architecture test scans every production root and entrypoint for forbidden ownership: React/localStorage shared writes, UI reducer execution, browser-supplied actor/state/transcript, whole-state replacement, or direct chat/store writes outside their owners. Behavioral route tests remain the primary proof.

## Store And API Contract

Minimum schema:

```text
workspace(
  id = 'household', schema_version, planner_version, sync_revision,
  state_json, created_at, updated_at
)

planner_events(
  sequence, event_id, request_id, actor, command_json,
  base_version, result_version, summary, target, changes_json,
  before_state_json, reverts_event_id, chat_turn_id, occurred_at
)

command_receipts(
  operation_kind, request_id, payload_hash, http_status, decision_json, created_at,
  primary key(operation_kind, request_id)
)

chat_turns(
  turn_id, request_id, turn_sequence, status, user_entry_id, context_json,
  input_planner_version, reply_entry_id, proposed_command_json,
  mutation_outcome, retry_of_turn_id, error_code, error_detail,
  created_at, started_at, completed_at
)

transcript_entries(
  sequence, entry_id, role, text, context_json, turn_id, occurred_at
)

schema_migrations(version, applied_at)
```

The initial migration declares, rather than merely documents, singleton-workspace checks, unique event result versions, event/chat foreign keys, one revert per target event, unique turn and transcript sequences, retry linkage, and a partial unique constraint permitting at most one `running` chat turn. `foreign_keys=ON` is accompanied by real foreign keys.

`GET /api/workspace` returns one complete planner aggregate plus replaceable recent event, transcript, and chat-turn tails under one `syncRevision` ETag. A changed response replaces those tails as complete units, so an in-place `running -> terminal` chat update cannot be missed by a sequence cursor. Older history/transcript pages are explicit on-demand reads and are not part of the polling merge algorithm. Server time comes from the HTTP `Date` header. No endpoint accepts browser-supplied planner state, history snapshots, actor, free-form prompt context, or transcript except the versioned one-time bootstrap payload.

`POST /api/commands` accepts:

```json
{
  "requestId": "uuid",
  "basePlannerVersion": 12,
  "command": { "type": "setInstructionStepComplete", "weekId": "2026-07-06", "stepId": "...", "complete": true }
}
```

The HTTP command service opens one `BEGIN IMMEDIATE` unit of work and calls `applyPlannerCommand(tx, request)` with exactly one typed command. One accepted command has one request receipt, one before-state undo basis, one event, and exactly one planner/sync version increment. `handoffWeek` is one domain command that atomically changes both week statuses and `activeWeekId`; it is not a generic batch. The kernel never opens its own transaction, so chat completion can compose planner mutation and terminal turn persistence atomically. No transaction is held during the external Codex call. Multi-command batch behavior belongs only to the deferred Codex-runtime follow-up.

Inside the unit of work the kernel:

1. Validates and canonicalizes the request, hashing normalized JSON that includes operation kind, base version, and the command. Week scope exists only inside commands that need it, so create/lifecycle commands cannot disagree with a top-level target. It looks up the `(operation_kind, requestId)` receipt and replays the immutable decision only when the hash matches.
2. Loads the singleton workspace and requires the supplied `basePlannerVersion`.
3. Resolves every week ID carried by the command against canonical state, except the missing week being created by `createWeekPlan`, then returns `409 VERSION_CONFLICT` when the planner version differs. It never silently rebases a non-commutative command.
4. Materializes any server-owned IDs, actor, and time, executes the pure reducer once, and validates post-state invariants.
5. On success, updates the aggregate with `UPDATE ... RETURNING`, increments `planner_version` and `sync_revision` exactly once, appends one event including its undo basis, and stores one receipt. Event base/result versions are consecutive and each result version is unique.
6. Commits before returning the result; the next conditional poll/focus read observes the new workspace revision even if the HTTP response is lost.

Two writers from one version therefore produce exactly one winner and one deterministic conflict. A response lost after commit is recovered by replaying the same request ID without duplicating the change or event.

All schema-valid decisions, including version conflicts and domain rejections, reserve their request ID. A deliberate retry after refresh uses a new ID. A replay returns the immutable stored decision plus the current workspace readback, so an old stored `409` never masquerades as current state. Schema-invalid requests do not reserve an ID. Codex planner mutations use a stable internal request ID derived from `turn_id`.

Replace state-dependent toggles with explicit intent commands:

- `toggleInstructionStep` -> `setInstructionStepComplete(stepId, complete)`
- grocery checkoff -> `setGroceryItemChecked(itemId, checked)`

Numeric prep moves remain guarded by the whole planner version; any intervening change requires authoritative refresh and a deliberate retry. Text drafts remain in the UI on rejection/conflict rather than being cleared.

Race UX is explicit and uniform: every version conflict refreshes authoritative state, preserves the user's draft or intended action, and shows one Review/Retry path. A Boolean setter whose readback already equals the requested value may display converged success, but the client never silently resubmits. Transport retry reuses the same request ID; deliberate retry after a stored conflict uses a new one.

Every externally visible planner mutation or chat transition increments `sync_revision` in the same transaction as its rows. Planner mutations also increment `planner_version` exactly once. The client accepts only complete workspace responses whose revision is at least its last applied revision, preventing an older poll from regressing newer command readback.

## Chat Turn Lifecycle

The database owns the one global transcript. The browser submits only message text, a request ID, the observed planner version, and structured context IDs such as view, week, meal, or instruction step. The server validates those IDs against canonical state and renders prompt text itself; arbitrary browser context text is never trusted. If the observed planner version is stale, submission returns `CONTEXT_STALE` before calling Codex, refreshes the workspace, and preserves the draft.

On an accepted submit, one transaction inserts the user transcript entry and one shared running turn, increments `sync_revision`, and commits before the external call. The prompt contains canonical state relevant to the validated context plus a bounded tail of the most recent 12 persisted transcript entries. The full global transcript remains durable and pageable for display; it is not resent to the model on every turn.

Lifecycle entity: one `chat_turn`.

Actors: browser submitter, chat-turn service, Codex adapter, startup recovery.

States: `running`, `completed`, `failed`, `interrupted`.

Terminal outcome metadata distinguishes `no_command`, `applied`, `version_conflict`, `domain_rejected`, `model_failed`, and `timed_out` without multiplying public states.

| From | Event and guard | Next | Durable effect and idempotency |
|---|---|---|---|
| none | `submit(requestId)` when active slot is free and context version matches | running | Insert one user entry and sequenced turn; repeated same payload resolves the same turn's current state; changed payload conflicts |
| none | `submit(requestId)` while another turn runs | none | Store/replay a `TURN_BUSY` decision receipt, reserve no turn, and retain the caller's draft; a deliberate later submit uses a new ID |
| running | `modelReply` with no command and row still running | completed | Insert one assistant entry and persist terminal outcome once |
| running | `modelReply` with command, row still running, planner version unchanged | completed | In one unit of work call the mutation kernel with one command, insert the assistant entry, and persist terminal `applied`; all commit or none do |
| running | `modelReply` with command but planner advanced | completed | Persist reply plus `version_conflict`, release slot, apply no planner mutation |
| running | `modelError` or timeout while row is running | failed | Persist one canonical failure and release the slot |
| running | server startup finds unfinished row | interrupted | Persist interruption and release the slot; never auto-rerun |
| terminal | any late completion | unchanged | Conditional terminal write affects no row; ignore with telemetry |
| failed/interrupted | explicit `retry(retryRequestId)` | unchanged plus new running turn | Create one new idempotent turn referencing the prior user entry and current canonical state; do not duplicate the transcript message |

A partial uniqueness constraint permits only one running turn. Simultaneous submissions therefore produce one accepted turn and one `TURN_BUSY`, not two ambiguous transcript branches. Terminal writes use `WHERE status = 'running'`, which fences a result arriving after timeout/failure without a second token. Process restart cannot resume the ephemeral Codex call, so startup marks it interrupted and the user deliberately retries against current canonical state. The stable internal planner-command request ID is derived from the accepted `turn_id`, so response loss around terminal commit cannot duplicate its mutation. A replayed submit receipt identifies the turn and returns its current lifecycle state rather than replaying a stale stored `running` body.

All chat lifecycle writes go through the chat service transition API. The architecture guard fails when production code writes chat status, transcript rows, terminal outcome, or retry linkage elsewhere.

## Canonical Household State

The aggregate is not an anonymous single week:

```text
HouseholdPlannerState {
  householdTimeZone
  activeWeekId         // nullable; zero or one active week
  weeks[] {
    id                 // canonical Monday ISO date
    weekStartDate      // ISO date
    status             // planned | active | archived
    data               // week-local planner data; meals use ISO date + explicit slot
  }
}
```

`selectedWeekId` remains device-local. Every week-local command carries a `weekId` that must exist in the canonical aggregate; creation and multi-week lifecycle commands carry only the identities their transition requires. Week-local commands run the refactored pure reducer against that week and replace only that week inside the workspace transaction. Archive and next-week creation update canonical lifecycle metadata through typed commands, not static client constants.

The current reducer pattern is retained, but its current vocabulary is not. Before cutover, freeze and implement these contract changes:

- Replace `dayIndex` moves with `moveMeal(mealId, targetDate, slot)`. The initial slot enum contains `dinner`. Moving to an empty date/slot leaves the source empty; moving to an occupied target swaps assignments. Empty days are valid.
- Replace the zero-argument `createWeekPlan` flag flip with `createWeekPlan(weekStartDate, planInput)`. The application service materializes stable IDs before invoking the reducer.
- Remove `weekArchived` and `draftReady` from week-local data; lifecycle belongs only to the week envelope.
- Replace all state-dependent checkbox toggles with explicit setters. Keep prep move/reschedule/remove commands reference-based.
- The shared command surface also owns meal snapshot edits; add/update/move/remove instruction steps; add/update/remove groceries; and one grocery-reconciliation command that replaces the week list under OCC while preserving supplied IDs and materializing IDs for new rows. Browser and Codex callers may not bypass these commands with raw record writes.
- `InstructionStep` and `PrepReference` follow the exact locked semantics above. Prep references are grouped chronologically by date and positions are contiguous within each date; the list for a date is one manual cross-recipe sequence, never an automatically scheduled or recipe-grouped copy. Rescheduling normalizes the source date and appends the reference to the end of the destination date.

One executable week transition function owns:

| From | Event | To |
|---|---|---|
| missing | `createWeekPlan(weekStartDate)` | planned |
| planned | `activateWeek` when no week is active | active |
| active + planned next | `handoffWeek(current, next)` | current archived + next active |
| active | `archiveWeek` | archived + no active week |
| archived | any week-local mutation | conflict/read-only |

Activation/archive/handoff writes, `activeWeekId`, and all affected statuses commit together. The authority implementation and transition unit tests land with the cutover; the family-dinner pilot does not wait for exhaustive lifecycle browser UX, which is a broader-release gate.

## Domain Invariants

Enforce these after legacy import and after every accepted command:

- All meal, instruction-step, prep-reference, grocery, leftover, event, and chat IDs are unique in their scopes.
- Week IDs/start dates are valid Monday ISO dates, unique, and match; zero or one week is active and nullable `activeWeekId` agrees with it.
- Meal assignments use valid ISO date/slot keys inside their week; a date/slot is uniquely occupied, while empty days and explicit flex meals are allowed. The first release supports the `dinner` slot.
- Every instruction step has a stable ID, amount lines, one instruction, Boolean completion, optional timer duration/start, and optional note. Every prep reference contains only step ID, prep date, and manual position contiguous within that prep date; it cannot copy completion, timer, note, amount, or instruction state.
- Prep dates are ISO `YYYY-MM-DD` domain values from the Sunday immediately before a Monday week start through the Sunday ending that week, inclusive, not display strings.
- Every leftover references an existing source meal. `assigned` requires one valid target day; non-assigned states cannot retain a contradictory assignment.
- Feedback keys reference existing meals.
- Timer starts are safe server timestamps; reopening derives elapsed/remaining time. Timers neither notify nor automatically complete a step. Explicit reset clears the start, and explicitly completing a step also clears a running start; unchecking it never restarts the timer.
- Archived weeks reject planner commands except the explicitly supported next-week transition.
- Stored event undo snapshots are server-produced valid planner states. Client-provided history snapshots are never trusted.
- Invalid legacy import fails as a whole with actionable field errors; it never silently becomes seed data and then saves as if imported.

## Remediation Clusters

### 1. Shared Household Authority And Lost Writes

**Root pattern:** React owns a stale-capable whole planner/event/transcript envelope and unconditionally rewrites it. All UI commands, Codex commands, undo, history restore, reset, hydration fallback, transcript append, and timer mutations inherit that authority.

**Sibling extent:** Confirmed across `app/planner-client.tsx` hydration/save, UI dispatch, ChatGPT fingerprint/application, chat transcript updates, undo, history restore, reset, migration fallback, and timer commands. Sweep-confirmed empty: no revision, CAS, transaction, cross-device store, `storage` listener, `BroadcastChannel`, lock, ETag, or conflict test exists. The pure reducer and bridge are adjacent consumers, not independent state writers.

**Disposition:** Release blocker, must fix.

**Route:** Architectural class fix through the selected server/store/command boundary. Delete live planner persistence from localStorage after explicit migration. UI and Codex call the same command service; Codex actor attribution is assigned internally.

**Proof:** Real file-backed SQLite tests plus two clients racing through the actual HTTP route, duplicate replay before/after restart, injected transaction rollback, simulated response loss after commit, independent API readback, and two browser contexts observing and resolving a conflict.

### 2. Long-Running Shared Chat And Stale Codex Mutations

**Root pattern:** A long external model call is coordinated by one browser's in-memory flags and state fingerprint, while transcript order and command application have no durable owner.

**Sibling extent:** Browser-supplied state/transcript, same-tab-only stale guard, simultaneous device submissions, duplicate HTTP submission, timeout followed by late result, server restart during a turn, and transcript-only writes that currently overwrite planner data.

**Disposition:** Part of the shared-state release blocker.

**Route:** Lifecycle class fix using the executable single-in-flight state machine above. The server validates structured context IDs and constructs a bounded canonical prompt; proposed commands pass through the transactional mutation kernel. Concurrent submit returns `TURN_BUSY` without losing the draft; restart marks the turn interrupted; retry is explicit; conditional terminal writes fence late results.

**Proof:** State/event table, duplicate submit, two-submit running-turn race, visible `TURN_BUSY`, stale context rejected before model call, timeout/late completion fencing, startup interruption, explicit retry without a duplicate user entry, atomic planner-command plus transcript/terminal commit with injected rollback points, second-client running-to-terminal readback, and one separate live ChatGPT-login smoke on this Mac.

### 3. Temporal Values Are Presentation Strings Instead Of Domain Data

**Root pattern:** Hardcoded day arrays, one fixed `TODAY_INDEX`, literal Tonight copy, and free-form prep `due` values let presentation text act as domain identity.

**Sibling extent:** Today highlighting, Tonight meal selection, ChatGPT Tonight context, week/closeout labels, prep options, prep reschedule commands, and Codex `setPrepPlan` output all depend on fixed or free-form strings.

**Disposition:** Today/Tonight is a release blocker; invalid prep date is an accepted medium integrity finding.

**Route:** Class fix. Add `weekStartDate` and household timezone to canonical state/config. Use branded/validated ISO dates in domain commands and state. Derive day index and formatted labels from server time plus timezone. When today is outside the selected week, select the containing week or show an explicit no-meal state; never fall back to an arbitrary array element. Generate prep choices from the week date range.

**Proof:** Injected-clock tests for each weekday, Sunday/Monday boundary, DST-adjacent dates in `America/Halifax`, outside-week behavior, Friday July 10 regression, command-schema rejection of display strings/out-of-range dates, and browser assertions that Week, Tonight, and ChatGPT context agree.

### 4. Command Rejection And Recovery Are Not User-Visible Contracts

**Root pattern:** Callers often discard `CommandResult`, clear uncontrolled/controlled inputs before success, or treat tolerant migration fallback as accepted data.

**Sibling extent:** Instruction notes, week lesson blur, main chat submit, step Send to ChatGPT, meal save, any command wrapper returning `void`, invalid planner collection fallback, invalid chat entry fallback, and damaged history snapshots. The sweep also found Meal Detail closing on a readiness Boolean before asynchronous chat acceptance, losing unsaved meal fields, and a step comment clearing an unrelated shared ChatGPT draft.

**Disposition:** Accepted medium integrity findings; must fix in this pass.

**Route:** Class fix. One async client command function returns a typed `success | domain_error | version_conflict | unavailable | busy` result. Forms clear/close only on accepted persistence, retain drafts on failure/busy/conflict, match `maxLength` to server schemas, and render field/global errors. Step-to-chat submission owns its own draft and cannot clear the main composer. Meal Detail does not close or discard unsaved meal fields until the chat turn is durably accepted and the focus destination exists. Strict server invariants own stored data; migration cannot silently substitute seeds. Chat submit persists through the chat API before clearing.

**Proof:** Shared-schema unit boundaries plus representative max/max+1 browser fields; rejection/busy/conflict without clearing or premature drawer close; independent main/step chat drafts; unsaved meal fields preserved; visible domain/conflict errors; invalid import with unchanged workspace; corrupt database startup fail-closed; and stale workspace-response rejection.

### 5. Destructive Recovery Restores Whole Stale Snapshots

**Root pattern:** Reset, recent undo, and arbitrary history revert replace the whole planner without confirmation or a version precondition.

**Sibling extent:** Local reset delete/reseed, undo snapshot assignment, history `before` restore, hydration fallback that can reseed, UI interaction before deferred hydration completes, and any future import/restore action.

**Disposition:** Major; must fix.

**Route:** Do not enable planner controls until the first authoritative server read or explicit import choice completes. Remove `Reset local demo` from normal family UI and expose seed reset only behind an explicit development flag. Make undo a target-specific request `{targetEventId, basePlannerVersion, requestId}`. The server verifies that the target is the latest eligible planner-mutating event, its result version equals the current planner version, and it has not already been reverted; it then appends a new event with `reverts_event_id` rather than rewriting history. All ordinary planner commands, including an immediately latest archive, are eligible; undo events themselves are not undoable. Chat transcript/turn outcomes remain historical truth when their applied planner command is later undone. Keep older history read-only. Future backup restore is a separate confirmed operation that first creates a backup and requires current-version CAS.

**Proof:** Latest target-specific undo success; wrong target, stale, duplicate, already-reverted, undo-of-undo, and non-latest conflicts; archive eligibility; concurrent command cannot be erased; transcript remains; reset absent in family mode; development reset requires confirmation and creates a backup; server restart preserves event/undo eligibility.

### 6. Modal And Navigation Ownership Is Scattered

**Root pattern:** The mobile ChatGPT rail is visually modal without dialog semantics/focus ownership, and multiple call sites directly change top-level views without owning scroll behavior.

**Sibling extent:** Chat open/close, Meal Detail and History (positive reference implementations), mobile nav, pressure-strip navigation, week arrows/selection, archive/reset returns, and any direct `setView` caller.

**Disposition:** Mobile focus is Major; retained scroll is Minor and accepted.

**Route:** Reuse one dialog-focus primitive for mobile ChatGPT: `role=dialog`, `aria-modal`, initial focus, inert background, body scroll lock, Tab containment, Escape close, and trigger focus restoration, including the case where the original opener unmounts. Centralize desktop nav, mobile nav, overview shortcuts, week arrows/selector, lifecycle returns, archive, and development reset through one navigation function that resets scroll and focuses the new view heading; device-local drawer/view state remains outside the shared store.

**Proof:** Repo-owned browser tests at representative mobile and desktop widths for initial focus, forward/reverse Tab containment, background `inert`, body scroll lock, Escape, trigger restoration including opener removal, and desktop non-modal behavior. Exercise representative top-level navigation from a scrolled source and assert target heading focus at scroll zero while transcript scroll is unchanged; include broader responsive/overflow smoke at 768 and 1280 px.

## Challenge Disposition

The formal challenge mirrored the plan as: replace browser/localStorage authority with one loopback SQLite modular monolith; preserve typed pure transitions; use whole-workspace OCC, idempotent requests, polling, one shared transcript/chat lifecycle, latest-only undo, and one atomic client cutover; then prove the household dinner workflow and the remaining accepted QA findings.

Accepted objections and resulting changes:

- Corrected the completion claim from "across family devices" to every client that can reach the same server; actual device reachability is deployment-later.
- Split a shared-dinner technical gate from the broader family-ready release instead of making infrastructure, lifecycle UX, operations, and every visual polish cell one monolithic gate.
- Collapsed three independently polled resources and page-merge rules into one conditional workspace read with one monotonic revision and replaceable tails.
- Reduced module ceremony while retaining store, planner mutation, chat lifecycle, route, adapter, and client ownership boundaries.
- Removed silent semantic auto-resubmission. Conflicts preserve intent, refresh, and require Review/Retry; a readback that already equals an explicit setter may display converged success.
- Removed duplicate canonical timezone/active-week columns, changed the active invariant to zero-or-one, and added an executable handoff/archive lifecycle.
- Reclassified the current reducer as a reusable pattern requiring a real command/state refactor for ISO date/slot identity, empty targets, server-owned IDs, and real week creation.
- Made legacy bootstrap a specific transactional v2 transform, including display-date and arbitrary transcript-message projection plus a two-client initialization race.
- Separated durable transcript entries from mutable chat turns, bounded model prompt history, validated structured context IDs, and replaced completion tokens with conditional terminal transitions.
- Added the real runtime/process/proxy/build topology so `npm run dev/start` cannot succeed as a web-only shell around an unused authority server, including Vite proxying only for development and a Node front controller for local production.
- Replaced the one-checkbox dinner proof with the transcript-required cross-recipe, manual-order, reference-removal, next-day readback, amount-first step, and non-notifying timer workflow.
- Removed current-phase generic batch implementation/proof; it exists only in the deferred Codex-runtime plan. Atomic multi-record operations such as week handoff remain single typed domain commands.
- Pruned exhaustive child-process/SIGKILL, every-field boundary, and every-pixel/navigation matrices in favor of HTTP races, injected transaction failures, restart readback, representative browser states, and the exact dinner journey.
- Raised the Node floor from `>=22.13.0` to `>=22.15.0` after an exact-minimum build proved the current Cloudflare Vite plugin requires `node:module.registerHooks`; moved online pre-migration backup to the first migration that can modify an existing database.
- Recast family readiness as one parallel release train: Gate A and Gate B are evidence/claim checkpoints, not serial implementation phases. Broad-release lifecycle, recovery, mobile, navigation, and validation work starts as soon as the shared contracts freeze.

Rebutted objections:

- Multi-week identity, lifecycle transitions, and exact legacy bootstrap cannot be designed as later alternative authority paths. They land in the authority cutover, although exhaustive lifecycle UI proof can follow the dinner technical gate.
- The architecture guard remains because ownership currently spans React, localStorage, bridge, web worker, scripts, routes, and the new server. It is narrowed to forbidden authority paths across all production roots and paired with behavioral tests rather than broad source-shape allowlists.
- Whole-workspace OCC, one server-owned SQLite authority, caller-owned transactions, immutable receipts, atomic client cutover, one durable in-flight chat turn, and latest-only undo remain load-bearing. Per-entity merge, CRDTs, an offline queue, and SSE are not justified.
- Mobile dialog and navigation fixes remain required before the broad family-ready claim because the user accepted those QA findings. They are independent lanes, not prerequisites for proving the shared mutation design.

Deferred without weakening this plan:

- Tailscale Serve, TLS/ACLs, remote-device smoke, service installation/supervision, backup retention, and host-reboot claims.
- Dedicated `CODEX_HOME`, web-enabled embedded research, multi-call dynamic planner tools, global-Codex import, and Chrome control. The current release keeps one structured reply plus at most one typed command.
- SSE/WebSockets, background timer notifications, automatic prep scheduling, full inventory, and broad performance work until measured need.

Second-pass transcript, scope/simplicity, and architecture/proof reviewers signed off after the accepted fixes, including removal of current-phase generic batch behavior and correction of the distinct development versus local-production proxy topologies. No product decision remains open in this plan. Implementation planning must still turn the gates below into bounded tasks; passing the shared-dinner technical gate alone is not permission to claim every accepted QA finding fixed.

## Data Safety And Operations

- Store data outside build output using `PLANNER_DATA_DIR`; ignore local database, WAL, SHM, and backup files in Git.
- Run schema migrations transactionally before accepting traffic. Schema `001` creates a new database and has nothing to back up. Starting with the first migration that can modify an existing database, take an online SQLite backup and verify it can be opened before migration.
- Add schema-versioned JSON export before the broad family-ready gate, after durable household data exists. Never copy a live SQLite/WAL file directly. Automated retention belongs to the later installed-service/deployment lane.
- Run SQLite `quick_check` at startup. On corruption, fail planner readiness visibly and preserve the file; never reseed automatically.
- `/api/health` reports web/application/store readiness separately from optional Codex authentication. Planner operation remains available when ChatGPT is unavailable.
- OS service supervision, Tailscale Serve configuration, TLS, ACLs, and remote-device smoke are deferred to the later deployment lane.

## Parallel Delivery Graph And Claim Gates

Family readiness is one release train, not a sequence of implementation phases. Gate A and Gate B control what may be claimed; they do not delay unrelated work. After one short contract checkpoint, six ownership lanes run concurrently, broad-release work starts immediately, and the implementation converges at one atomic authority cutover.

```text
Contract checkpoint
  |-- Lane 1: canonical domain -------------------|
  |-- Lane 2: store and mutation authority -------|
  |-- Lane 3: HTTP and runtime composition -------|--> atomic authority cutover --> Gate A claim
  |-- Lane 4: chat and Codex adapter -------------|              |
  |-- Lane 5: browser and UX integration ---------|              `--> full convergence --> Gate B claim
  `-- Lane 6: proof and architecture closure -----|
```

### Synchronization Barrier 1: Contract Checkpoint

The lead freezes only the interfaces every lane consumes:

- `HouseholdPlannerState`, exact instruction-step/prep-reference semantics, branded and runtime-validated ISO week/date/dinner-slot identity, executable week transitions, explicit setters, complete recipe/grocery mutation commands, and server-materialized IDs.
- Single-command request, operation-kind/receipt, event/undo, OCC, error, workspace-read, chat-turn decision, transcript, bootstrap, full export, and health contracts.
- Schema `001` ownership and constraints, the exact v2 input/output and legacy-event discard policy, test clocks/failpoints, and stable Codex-adapter/test-fixture ports.

This is a short synchronization barrier, not a build phase. Interface-bearing changes merge through the lead as soon as they are coherent; downstream lanes do not independently reinterpret a contract.

Before implementation worktrees are created, make this barrier a real Git fact:

1. The Git root is `site/`, not the parent planning folder. After a scoped review and user authorization, intentionally commit the current dirty `site/` baseline without folding contract work into it.
2. Promote this plan to `docs/family-readiness-remediation-plan.md` and the functional spine to `docs/functional-spine.md`; those tracked copies become the implementation decision surface received by every worktree, while the parent `scratch/` files remain planning history.
3. Commit the frozen contracts, schema ownership, service ports, and test ports as a separate contract-checkpoint commit.
4. Record that exact commit SHA and named ref; every implementation worktree starts from it. Do not fan out from the current dirty `main` tip or from different lane-specific interpretations of the checkpoint.

Post-checkpoint interface ownership is exclusive:

- Lane 1 owns canonical household/domain DTOs and command schemas.
- Lane 2 owns planner application-service ports, mutation results, OCC/receipt/event contracts, and store test ports.
- Lane 3 owns HTTP request/response DTOs, workspace/error envelopes, runtime configuration, and health contracts.
- Lane 4 owns chat-turn/transcript DTOs, Codex adapter contracts, and chat lifecycle results.
- Lane 5 owns browser-only client types and view models; it consumes but does not redefine server contracts.
- Lane 6 owns cross-boundary fixture/harness contracts under test support. Production clocks/failpoints remain owned by the production lane that implements them.

Any post-checkpoint change to another lane's interface file goes through the lead and is integrated before dependent work continues.

The legacy browser and bridge remain buildable until the atomic cutover. Lane 1
implements the canonical reducer behind `lib/household-domain.ts` and leaves
`lib/planner-domain.ts` as the live legacy reducer until Lane 5 removes that
path during its exclusive cutover. Lane 3 exclusively owns retirement of
`bridge/server.mjs` and the new HTTP/runtime surface. Lane 4 exclusively owns
`bridge/app-server-client.mjs`, `bridge/validation.mjs`, and extraction of the
Codex adapter/output validator; the lead removes any residual legacy bridge
files only after both owners have landed their replacements.

### Six Parallel Ownership Lanes

| Lane | Owns | Can start after | Integration constraint |
|---|---|---|---|
| 1. Canonical domain | New `lib/household-domain.ts` implementation, command contracts, household/week/date/slot models, lifecycle transitions, exact step/reference invariants, v2 transform, and domain tests; legacy `lib/planner-domain.ts` stays frozen until cutover | Contract checkpoint | Publishes pure interfaces; no SQL, HTTP, React, or Codex protocol ownership |
| 2. Store and mutation authority | SQLite schema/migrations, store, `applyPlannerCommand`, OCC, idempotent receipts, events, latest-only undo, bootstrap transaction, recovery/export primitives, chat-persistence port implementation, and store/service tests | Contract checkpoint | Owns all SQL and transaction semantics; consumes the v2 transformer and canonical domain port, and never reaches into React or Codex transport |
| 3. HTTP and runtime composition | Workspace/command/chat/bootstrap/export/health/history/transcript routes, origin checks, Vite development proxy, production Node front controller, `bridge/server.mjs` retirement, scripts, process shutdown, package/runtime wiring, and route tests | Frozen route/service ports | Calls application services only; owns `package.json`/lockfile and runtime entrypoints to prevent cross-lane dependency churn |
| 4. Chat and Codex adapter | Durable transcript/turn lifecycle through `ChatPersistencePort`, bounded canonical prompt, structured context validation, busy/stale/interrupted/retry behavior, `bridge/app-server-client.mjs`, `bridge/validation.mjs` extraction/retirement, new adapter integration, and fake/live adapter tests | Frozen chat, persistence, and planner-command ports | Calls the single-command mutation service; never writes SQL and does not write planner/store rows outside caller-owned transactions |
| 5. Browser and UX integration | All `app/**`, including the typed API client, workspace polling/readback, offline/conflict UX, calendar/date rendering, lifecycle UI, validation/draft retention, chat panel/mobile drawer, navigation/scroll, and the final authority cutover | Frozen HTTP DTOs; may develop against fakes | Sole browser owner and atomic-cutover owner; no other lane edits `app/**` until it explicitly hands over extracted disjoint components |
| 6. Proof and architecture closure | Captured v2 fixtures, exact-minimum-Node job, cross-boundary API races/failpoints/restart tests, Playwright two-context harness, dinner journey, responsive/accessibility coverage, and static ownership checks | Contract checkpoint; tests may target fakes until seams land | Owns shared test support/config plus separate integration/e2e/architecture files; requests production seams and dependency changes from their owners |

All six lanes run toward the same release. Work previously listed under Gate B is distributed from the start: lifecycle semantics in Lane 1, export/recovery in Lane 2, mobile/navigation/validation in Lane 5, and broad proof in Lane 6.

The current browser surface is the practical fanout limit: `app/planner-client.tsx` is 2,336 lines and `app/globals.css` is 2,415 lines. A seventh UX lane is allowed only after Lane 5 extracts stable components into disjoint files and hands over explicit ownership; before that, splitting the browser work creates merge conflict rather than speed.

Test ownership is also path-disjoint:

- Lanes 1-5 own unit/contract tests for their production modules and never edit another production lane's test files.
- Lane 6 owns `tests/support/**`, `tests/integration/**`, `tests/e2e/**`, `tests/architecture/**`, Playwright configuration, and end-to-end fixtures. It does not edit owner unit tests to make cross-boundary proof pass.
- Lane 3 alone changes `package.json` and `package-lock.json`; other lanes request dependency changes through it.

### Continuous Integration Cadence

- The lead integrates interface-bearing changes continuously and runs contract/seam tests after each merge; lanes do not wait for a large end-of-wave merge.
- Store, runtime, chat, and browser lanes build against frozen ports and fakes, then replace fakes with real services as each seam lands.
- Gate B implementation does not wait for Gate A. Only its final integrated browser proof waits for the authority cutover.
- With the current four-agent team limit, keep three workers plus the lead active and rotate queued lanes whenever a dependency clears. More worktrees may exist, but only disjoint owners should write concurrently.
- Before worktree fanout, complete the baseline and contract-checkpoint commits above. Until that exact base exists, parallel work in the shared checkout requires strict path ownership and no branch switching.

### Synchronization Barrier 2: Atomic Authority Cutover

Once domain, store, runtime, chat, and browser seams pass their contract tests, Lane 5 receives an explicit exclusive integration window and switches the user-visible app in one change:

1. Start from the authoritative workspace/bootstrap read and disable interaction until it resolves.
2. Route every planner, timer, note, transcript, undo, lifecycle, and Codex command through the server.
3. Remove live shared localStorage writes, arbitrary restore, and family reset while retaining only device-local preferences and the v2 snapshot until bootstrap acceptance.
4. Enable polling/focus/post-command readback and explicit offline/conflict behavior.
5. Prove no production path retains mixed authority before exposing the build.

### Claim Gate A: Controlled Shared-Dinner Pilot

Gate A may be claimed only after the cutover, deterministic store/API/chat proof, and the exact two-context dinner journey below. It proves the shared authority and dinner workflow; it does not claim every accepted QA point is closed.

### Claim Gate B: Broad Family-Ready Release

Gate B may be claimed only after all six lanes converge and the full realistic-local matrix, lifecycle/recovery/export behavior, mobile/navigation/validation coverage, documentation readback, responsive/exploratory QA, and separate opt-in live ChatGPT smoke pass. Gate B work starts with the other lanes; only this claim waits for the final evidence.

## Realistic-Local Proof Matrix

| Contract | Required proof |
|---|---|
| Canonical domain | Unit/property examples cover ISO week/date/dinner-slot moves into empty and occupied targets, zero-or-one active week, atomic handoff/archive, server-materialized IDs, and explicit setters. Schema/API examples prove a prep reference cannot contain copied step fields |
| No lost accepted writes | Two independent clients call the real `/api/commands` route from one base version. Assert unordered outcomes `{accepted, VERSION_CONFLICT}`, one version/event, no leaked `SQLITE_BUSY`, and loser readback equal to the winner. Browser conflict preserves intent and requires explicit Retry |
| Atomic command | Inject exceptions after workspace update, event insert, receipt insert, and before commit. Each leaves workspace/event/receipt/version unchanged. An accepted command increments versions once and has one event/undo basis; `handoffWeek` proves one command can update all lifecycle fields atomically |
| Idempotent retry | Same-ID same-payload replay before and after process reopen, changed-payload reuse rejection, simulated response loss after commit, stored rejection replay plus current readback, and new-ID deliberate retry |
| Bootstrap and recovery | Use a captured v2 fixture with display prep dates and arbitrary transcript entries. Prove exact transform, whole-import rollback, two-client bootstrap winner/loser, permanent disablement, restart readback, `quick_check`, and visible corrupt-store failure without reseed |
| Timer handoff | Inject clocks. Start a duration timer, reload and observe from a second client, prove derived remaining/elapsed time, explicit reset, and that elapsed duration neither notifies nor completes the step |
| UI/Codex parity | Direct UI and fake-adapter Codex paths invoke the same mutation kernel, produce the same state semantics, and differ only in server-assigned actor. Current Codex output remains one reply plus at most one command |
| Shared chat lifecycle | Pure transitions plus real two-submit race, duplicate submit, `TURN_BUSY`, `CONTEXT_STALE` before model call, timeout/late conditional-write fence, startup interruption, retry without duplicate user entry, and second-client running-to-terminal observation |
| Atomic chat command | Inject failures after planner mutation and after assistant/terminal persistence but before commit. Workspace, event, command receipt, assistant entry, turn outcome, and revisions all roll back or all commit |
| Bounded canonical prompt | Fake adapter captures server-rendered validated context and at most the last 12 transcript entries; a long durable transcript remains pageable and browser-supplied prompt/context/state is rejected |
| Propagation and offline | Post-command readback, conditional 304, focus refresh, stale lower-revision response rejection, and same-turn lifecycle update. After hydration, cut the API and prove explicit read-only state, retained drafts, no queued/replayed commands/chat, then refresh before mutation on reconnect |
| Calendar correctness | Inject each weekday plus Sunday/Monday and DST-adjacent Halifax boundaries. Browser Week, Tonight, prep dates, and ChatGPT context agree; the dinner journey runs only after this is green |
| Week lifecycle | Transition-table unit tests land with authority. Gate B adds representative browser create/activate/handoff/archive/read-only and one concurrent lifecycle conflict; no placeholder week is presented as canonical |
| Safe recovery and validation | Latest target-specific undo success plus wrong/stale/duplicate/non-latest rejection; no family reset/arbitrary restore; representative text max/max+1, invalid dates and import errors retain drafts/state; export round-trip at Gate B |
| Chat and navigation UI | Desktop/iPad always shows the shared side panel; mobile uses an actual modal drawer with initial focus, Tab containment, inert background, Escape, and focus restoration. Representative top-level routes reset scroll/focus without changing transcript scroll |
| Architecture closure | Static scan across every production root and entrypoint proves no shared React/localStorage writes, UI reducer execution, browser-owned actor/state/transcript, whole-state replace/reset/restore, or direct store/chat lifecycle writes outside owners. Route/runtime tests prove behavior |
| Real ChatGPT boundary | One opt-in smoke against a disposable database proves current ChatGPT login transport, persisted transcript/turn, Codex-attributed event, and second-client visibility. It is reported separately from deterministic release tests |

The dinner vertical slice is specific, not a generic checkbox smoke:

1. Seed at least two meals with canonical steps and amount lines. On Sunday, create one manually ordered prep list containing steps from both meals.
2. Reorder the cross-recipe references, reschedule one, and remove another. Verify removal changes only the prep reference: the underlying step, its completion/timer/note, and both recipes' instruction order remain unchanged.
3. Complete a Tuesday meal step from Prep and start another step's timer. Reload and observe the same state in a second browser context; elapsed time alone does not complete the step.
4. Open Tuesday's Tonight view. The prep-completed step is already checked, remaining steps are visible, ingredient amount lines render above each free-text instruction, and recipe order is unchanged.
5. Use **Add note** and prove only the canonical step note changes. Use **Send to ChatGPT** with stable week/meal/step IDs and prove only the one global transcript changes, visible from the other client; neither action clears the other composer or creates a user/thread identity.
6. Run one deterministic Codex command through the same mutation service, then propagate a grocery check and cooked/leftover state to the other client.

Existing Node tests, pure reducer pattern, injectable clock, loopback server factory, and browser tooling are useful foundations, but they do not prove this architecture. Add `@playwright/test` directly and keep the opt-in live ChatGPT smoke outside the deterministic gate.

## Revised Completion Contract

**Prior contract:** the app's cooking workflows work in one browser and persist through localStorage; ChatGPT can return a typed command to that browser.

**Revised application-layer family-readiness contract forced by QA and the user's shared-state decision:**

- One server-owned household workspace survives restart and is the only authority for planner, events, timers, notes, feedback, undo eligibility, and transcript.
- Multiple clients that reach that server observe committed changes promptly; no accepted command is silently lost, duplicated, or overwritten.
- Planner commands have atomic OCC/idempotency semantics, and conflicts are visible with authoritative readback.
- The planner has real canonical multi-week/date/dinner-slot identity. Prep is one manually ordered cross-recipe list of references to canonical amount-first instruction steps; completion, notes, and persisted timers project consistently into meal-day views without automatic scheduling, notifications, or timer-driven completion.
- ChatGPT receives validated canonical context plus a bounded global-transcript tail, exposes one durable shared in-flight turn with explicit stale/busy/interrupted/retry behavior, and applies any command through the same transaction kernel as the UI.
- The shared chat panel remains available on desktop/iPad and as a modal drawer on mobile. **Add note** and **Send to ChatGPT** have the exact separate semantics in the locked contract.
- Today/Tonight and prep dates are derived from real ISO dates and the household timezone.
- Invalid input/import/store data fails visibly without clearing user work or silently reseeding.
- Undo cannot erase intervening work; family mode has no one-click reset.
- Mobile ChatGPT owns focus correctly and top-level navigation starts in a coherent position.
- Automated store/API/concurrency/restart/browser proof, the exact two-client dinner journey, and a separately reported opt-in live ChatGPT smoke pass.

This contract intentionally does **not** claim that another device can reach the app over Tailscale, that the service survives host logout/reboot, or that Tailnet ACL/TLS behavior is correct. Those claims belong to the later deployment/readback lane.

## Next-Review Readiness Bar

Do not re-invoke review until all of the following are true:

- No production planner, event, undo, timer, or transcript write remains in React/localStorage.
- The only current planner mutation kernel is caller-owned-transaction `applyPlannerCommand(tx, request)` for exactly one typed command. The only chat/transcript lifecycle writer is the chat service. Generic batch mutation remains absent until the deferred Codex phase.
- Every typed command has explicit OCC/idempotency behavior and validator/schema parity; toggle commands are gone.
- The current reducer/state vocabulary has been refactored to canonical week/date/dinner-slot semantics, zero-or-one active week, server-materialized IDs, and exact instruction/prep-reference ownership.
- SQLite schema `001`, startup integrity, exact v2 bootstrap, restart/interruption handling, and future-migration backup rule are implemented against a real file adapter and tested on Node 22.15.0.
- `dev` and local `start` compose the web and application processes with their distinct proxy mechanisms; `/api/health` succeeds through each browser-facing origin; web-only build success is not mistaken for application readiness.
- The realistic-local HTTP race, atomic failure, retry, bootstrap, restart, timer, undo, offline, bounded-prompt, and chat lifecycle matrix is green.
- Repo-owned Playwright tests prove two-context synchronization/conflict, the exact cross-recipe dinner journey, always-available chat semantics, mobile dialog focus, and representative navigation behavior.
- README and functional requirements describe the server authority, race semantics, offline read-only behavior, latest-only undo, shared transcript, and deferred Tailscale boundary accurately.
- A final `git status`, staged/package diff, and package script readback prove all migrations, fixtures, and tests referenced by the verification commands are in the shippable surface.
- Runtime QA shows two browser contexts sharing a real database with no console/page errors or unexpected network failures; the real ChatGPT smoke is run separately against a disposable database.

## Deferred Follow-Up: Scoped Codex Planner Agent

**Status:** explicitly excluded from family-readiness implementation and signoff on 2026-07-10. Family readiness subsequently landed at `217e81306160346fc944712175059bece5da23d0` and closed its proof gaps at `c811adc2b2fd05d5573933e10ca77e60f2d0e7ba`; the latter exact commit is the follow-up release baseline, and neither commit is part of the follow-up change set. The separate architecture and closed unknowns register are in `docs/codex-agent-runtime-follow-up-phase.md` and `docs/codex-agent-runtime-follow-up-unknowns.md`. All four follow-up waves are implemented as a separate single-path candidate, including identity-bound authenticated readback and the guarded local release transaction. Follow-up release status is intentionally not carried in this family plan: its private release-artifact chain, current pointer, and post-activation QA are authoritative. None of those later outcomes changes or reopens family-readiness signoff.

**2026-07-15 follow-up supersession:** the household subsequently replaced the follow-up candidate's Plan/Research selector and disjoint ephemeral contexts, then clarified that the product is a small wrapper over native Codex history rather than one app-owned permanent conversation. The target now permits many top-level native threads, keeps exactly one app-wide selection, exposes native background workers, discovers normal standalone plus app-owned planner skills, and keeps hosted web search and planner tools together. Codex owns conversation history; the app owns only selection metadata and planner effect state. [The current runtime requirements](codex-agent-runtime-follow-up-phase.md) own that replacement. The remaining text in this section records the historical family-readiness boundary and prior candidate; it is not current activation authority. This requirements change does not reopen the landed family-readiness contract.

The superseded candidate's approved delivery map was six units clustered into four waves: updater-safe runtime isolation and shared ordered planner authority in parallel; crash-safe embedded execution and independent global UDS ingress; mediated sourced-recipe intake; then authenticated-readback single-path cutover. The current requirements and historical closed-decision register are `docs/codex-agent-runtime-follow-up-phase.md` and `docs/codex-agent-runtime-follow-up-unknowns.md`; parent-workspace scratch is historical and is not a shipped release input. Implementing either candidate does not retroactively add its capability, authentication, effect-lifecycle, listener, or browser proof cells to family-readiness signoff.

The dedicated Codex runtime, web-enabled recipe research, composable dynamic planner tools, and global-Codex import path belong only to that follow-up. Chrome control, tab groups, site allowlists, and browser-profile decisions remain later than the follow-up.

This family-readiness implementation retains only the existing bounded ChatGPT contract:

- The server owns canonical planner state, the shared transcript, chat lifecycle, and command application.
- One embedded turn returns a concise reply plus at most one typed planner command through the existing structured-output contract.
- Any returned command uses the same OCC/idempotent mutation service as direct UI actions and commits atomically with the terminal turn outcome.
- The current command and embedded-chat routes use the shared single-command kernel. They do not implement batch mutation, dynamic tools, or multi-command input.
- Chat remains optional: planner/store readiness does not depend on Codex availability or authentication.
- The current release has no mid-turn planner effects, dynamic-tool call receipts, research/planning context split, global-agent ingress, or alternate Codex mutation path.
- The current release makes no claim of a dedicated `CODEX_HOME`, isolated Codex config/plugins, web research, external recipe injection, or Chrome access.

The follow-up retires the family phase's app-owned transcript as conversation authority and wraps native Codex threads instead. It reuses the durable effect/mutation boundary so several dependent main- or child-agent calls may commit separately before the terminal reply; every accepted effect remains fenced, recorded, idempotent, and visible if the reply later fails. Its thread-selection rows, worker surface, tools, and recovery behavior belong to the follow-up candidate, not to the historical family-readiness completion claim.

Family readiness can proceed and remain signed off independently because its authoritative workspace, OCC/idempotency kernel, and planner-effect fencing/readback primitives are the stable dependency boundary. The Codex-runtime candidate reuses those services while replacing the bounded app-owned chat/transcript lifecycle; that does not change what family readiness had to prove. It may replace the bounded adapter only after its own deterministic release transaction, restoration or reuse of the existing authenticated dedicated home, one fresh updater-managed authentication-readback app-server, separately bounded planner capability smoke, exact installed-path activation, and post-activation QA pass; failure of those gates degrades or blocks only follow-up activation.
