# Codex Planner Agent Runtime Requirements

**Status:** current requirements, revised 2026-07-15 after the household rejected both the separate **Plan** / **Research recipe** experiences and the later assumption that the household should have only one Codex thread. The filename is retained for link stability. The previously staged candidate follows the superseded selector, split-context, ephemeral-thread design and does not satisfy this contract. Its prior proof remains historical evidence, not authorization to activate it as the runtime described here. Backend/API implementation of this contract is owned separately from the planner UI that consumes it.

**Depends on:** the server-owned household workspace and versioned, idempotent, transactional planner mutation service established by [family readiness](family-readiness-remediation-plan.md). The target reuses effect-fencing/readback primitives but supersedes the old household-global single-in-flight chat/transcript lifecycle with native per-thread turns.

**Historical evidence:** [the closed unknowns register](codex-agent-runtime-follow-up-unknowns.md) records what the prior candidate proved about the Codex protocol, release operator, dynamic planner tools, authentication, and failure fencing. Its split research/planning, ephemeral-thread, single-active-conversation, and multi-agent-denial dispositions are explicitly superseded here.

## Outcome

The household uses a small Codex-style thread wrapper inside the planner. The dedicated runtime may contain many persistent top-level Codex threads. Exactly one top-level thread is selected and shown at a time; navigating among planner views or opening another app tab does not create another conversation. The household can open native thread history, select a prior thread, or start a new one.

The selected thread has one Codex composer with no task-mode selector. The agent decides naturally whether a request needs planner context, a skill, hosted web search, planner reads, a preview, one or more planner effects, background workers, or only a conversational answer.

Codex owns the native thread graph, items, history, turns, and child-agent activity. The application owns only the shared selected-thread reference, a sanitized live/read view of Codex state, and planner-specific readiness/effect status. It does not maintain a second authoritative transcript. The planner database remains the only authority for weeks, meals, groceries, accepted effects, versions, idempotency receipts, planner history, undo, and recovery.

This is deliberately similar to working in the normal Codex task UI, but with a planner-scoped authority ceiling. It can use standalone skills, deployment-owned planner skills, hosted web search, the planner tool namespace, and native Codex background workers. It does not gain shell, direct filesystem or database access, browser/computer control, apps/connectors, direct MCP tools, or arbitrary network tools.

The wrapper exposes two distinct interaction kinds. Bounded `request_user_input` questions are answerable only by choosing one host-projected listed option; the wrapper never exposes Codex's free-form `Other` channel and rejects native secret-input requests. Command, file-change, permission, and MCP approval requests are never grantable: the host rejects them immediately and exposes only a sanitized read-only blocked notice so the household can understand why the turn is waiting or failed.

## Authority Split

| Concern | Authority | Consequence |
|---|---|---|
| Conversation catalogue, continuity, and item history | Native Codex top-level and child threads in the dedicated runtime | Thread list/read/start/resume/archive, turn start/steer, and streamed native items are the conversation authority. The app does not reconstruct, fork, or shadow that history in planner tables. |
| Currently displayed conversation | Server-owned selected top-level thread ID plus selection revision | Exactly one top-level thread is selected app-wide. Planner navigation and new tabs read that pointer; selecting history changes only the pointer and never copies or creates conversation content. |
| Household-visible chat | Sanitized on-demand Codex read/stream projection plus typed planner-effect/readiness decoration | Browsers see native messages, tool/worker activity, and explicit host status without receiving raw app-server authority or persisting another transcript. |
| Questions and approvals | Host-mediated typed interaction projection | A `request_user_input` question may be answered once by selecting one listed option; free-form and secret-input responses are not exposed. A command/file/permission/MCP approval is rejected by policy and appears only as a sanitized, non-actionable blocked notice. |
| Planner state and effects | Planner database and shared mutation service | Only accepted typed host commands can change planner state; model intent, thread state, search output, and transcript text are never planner authority. |
| Runtime and release selection | Host-only updater and release operator | Neither the browser nor embedded Codex can install, authenticate, select, roll back, or mutate a release. |
| Foreground request | Current accepted household message plus separately acquired explicit grants | Previous conversation, skills, web pages, planner state, and tool output may inform reasoning but cannot expand host authority. |

## Locked Decisions

1. **Native history, one selection.** The dedicated runtime may retain many persistent top-level threads. Exactly one is selected and displayed app-wide; the picker lists prior native threads and can start a new one.
2. **Thin wrapper, no duplicate transcript.** Codex owns messages, turns, item history, and thread topology. The app persists only the selected top-level thread reference/revision and planner effect state, never a shadow transcript or reconstructed conversation.
3. **One composer.** There is no Plan/Research selector and no public planner-versus-sourced-recipe intent union. Choosing a conversation from history is thread navigation, not task selection.
4. **Unified capability surface.** Each planner top-level thread has hosted web search, skills, and one dynamic `planner` namespace containing exactly `read`, `preview`, and `apply`.
5. **Native background workers.** Codex may create child-agent threads under a top-level thread. The wrapper shows their status and permits read-only drill-down like Codex; it does not invent a separate worker/task model or composer.
6. **Skills without authority expansion.** Keep the normal OS `HOME` so standalone skills under `~/.agents/skills` remain discoverable, and allow release-owned planner skills. The dedicated `CODEX_HOME` excludes the broad normal `~/.codex` config/plugin/MCP/app surface. A skill can guide reasoning but cannot add a tool, RPC method, permission, or planner command.
7. **Dedicated dynamic runtime.** Embedded Codex uses a dedicated `CODEX_HOME`, fixed app cwd, private app-server process, file-backed ChatGPT credentials, and the updater-managed current Codex. The app does not pin or package a Codex version.
8. **Web content is untrusted context.** Search and page content may directly influence reasoning in the same thread or its workers. The product accepts that semantic prompt-injection risk; web content still cannot bypass host schemas, planner versions, idempotency, transactions, or the fixed capability boundary.
9. **Broad planner authority through one service.** The owning top-level agent may make several dependent planner reads and effects. Workers may research or reason and return results to that agent, but on the current app-server they do not inherit dynamic planner tools and cannot directly create planner effects. Every top-level effect is host-executed through the same service as the UI and succeeds only from an accepted result plus authoritative readback.
10. **Selection is not execution.** Switching threads does not cancel or clone native work. At most one foreground turn runs per top-level thread; additional input to that running turn uses native `turn/steer`, while other top-level turns and their workers may continue in the background subject to the active Codex runtime's bounded concurrency.
11. **Global Codex remains separate ingress.** A normal global Codex session may use its existing capabilities and submit planner batches through the same thin local client and mutation service. It never edits SQLite directly.
12. **Conversation archive is required; planner archive stays narrow.** The history surface can archive a native Codex conversation through `thread/archive`. That is unrelated to the destructive planner command `archiveWeek`. The native-thread send API carries no planner authority grant, so embedded Codex cannot call `archiveWeek`; the existing typed planner/UI path remains available. A future agent-side archive grant requires its own explicit contract and proof rather than being inferred from prose or a native approval request.
13. **Questions and approvals are separate first-class states.** A bounded `request_user_input` question is answerable through a host-owned listed-option-only channel: exactly one existing option label per question, no free-form `Other`, and no native secret-input request. Command, file-change, permission, and MCP approval requests are recognized so their blocked state can be shown, but the host always declines or rejects them. There is no browser approval-decision route and no prompt or skill can turn one into an allowed action.

## Scope And Non-Goals

In scope:

- native top-level thread list/read/start/resume/archive, turn start/steer, history selection, restart, missing-thread handling, and explicit new-thread creation;
- one shared selected-thread pointer across planner navigation, browser tabs, and devices;
- a sanitized browser projection of native messages, reasoning summaries, human-friendly activity labels, and lifecycle status without a second transcript store;
- native child-agent status, results, failure, and read-only drill-down beneath the owning top-level thread;
- answerable listed-option user questions with no free-form response channel, and separately typed, read-only blocked approval notices;
- co-present top-level planner skills, hosted web search, planner dynamic tools, and worker orchestration;
- several dependent calls in one turn with durable effect fencing and recovery;
- typed informational recipe sources without a separate research-candidate quarantine;
- update-compatible capability and schema validation;
- preservation of the dedicated agent home and its native thread history across application releases.

Not in scope:

- general shell, filesystem, database, browser/computer, app, connector, MCP, or arbitrary-network authority;
- per-person accounts, private threads, personal attribution, or permissions;
- scheduled/autonomous planning, notifications, Chrome integration, site allowlists, or browser profiles;
- custom worker spawning controls, a worker composer, or an app-owned job system;
- top-level thread rename, pin, fork, delete, or search UI beyond the required history list, select, new, and archive actions;
- Tailscale exposure, remote-device deployment, or service-supervision redesign;
- provider-side retention guarantees or conversation erasure; and
- claiming that a recipe source is true, complete, authored by the displayed site, or semantically derived from only one page.

## Architecture Forces

| Force | Status | Requirement-shaped resolution |
|---|---|---|
| State and lifecycle | present | Codex owns top-level thread, turn, item, and child-agent lifecycles; the app owns only the selected-pointer lifecycle. New publishes a confirmed native thread, selection neither cancels nor clones work, and an unavailable selected thread becomes an explicit selection state. |
| Persistence | present | The dedicated Codex home exclusively owns thread graphs and item history. App storage owns the selected top-level thread ID/revision, bounded message-body-free mutation-admission markers and exact finite replay receipts, and planner state/effects/receipts. Releases preserve those authorities without a shadow conversation table or thread index. |
| Contracts and validation | present | Validate browser history/select/new/archive/send commands, app-server RPC/items, parent-child identity, user questions, blocked approval notices, effective skill/tool surfaces, web-derived planner arguments, and tool results. Unknown item variants degrade safely; unknown requests, tools, commands, fields, RPC methods, approval decisions, and grants fail closed. |
| Internal typing | present | Keep top-level thread, child-agent thread/job, turn, item, tool call, selection revision, request/idempotency, planner version, command type, and retry disposition distinct. Remove Plan/Research intent and app-owned transcript types from the target conversation contract. |
| Concurrency | present | Selection uses revision/OCC so stale tabs cannot send to an obsolete thread. Concurrency is per native top-level thread, not household-global; input during a running turn is native steering, and unselected turns/workers may continue. Late items remain bound to their originating thread. Planner writes retain OCC, immutable replay, changed-payload rejection, and atomic batches. |
| Caching | absent | Do not add semantic thread-history, selection, planner, or search caches. Client render buffers reconcile from Codex and cannot answer history while it is unavailable; current planner reads and authoritative post-effect readback remain required. Immutable idempotency replay is not a cache. |
| Failure and resilience | present | Never hold a planner transaction across Codex/search work. Ambiguous thread creation or send is never blindly replayed: a durable message-body-free admission is reconciled against native history only by its live owner or by a replacement runtime after exclusive startup adoption, and only a proven absent operation may be attempted again. A successful create/send co-commits an exact bounded replay receipt before clearing its admission. Committed effects survive later worker/reply failure; missing selected threads remain selectable-away-from; Codex failure leaves planner operation available. |
| Protocols and boundaries | present | Version and fingerprint native thread list/read/start/resume/archive, turn start/steer/client-message identity, streamed item and child-agent events, the combined capability surface, dynamic-tool callbacks, skill discovery, and RPC allowlists. Compatible Codex updates are accepted dynamically; incompatible changes fail only Codex readiness without a fallback binary or app-owned conversation. |

The state/lifecycle requirement should use the repository's lifecycle-state-machine pattern; exact duplicate in-flight callbacks may use single-flight, while selection and planner concurrency continue to use durable revision/OCC/idempotency rather than process-local coordination.

## Runtime Requirements

### 1. Deployment And Process Isolation

The selected deployment remains:

```text
~/meal-planner/
  app/       # selected application and fixed app-server cwd
  agent/     # dedicated CODEX_HOME: auth, config, AGENTS, planner runtime/thread state
  data/      # canonical planner SQLite authority
  releases/  # private immutable release evidence
  run/       # private transient sockets and process state
```

- The server resolves these roots from deployment-owned configuration. Browser input, caller cwd, `PATH` search, and planner messages cannot select them.
- Launch the server-owned updater path `$HOME/.local/bin/codex`; record and revalidate the resolved executable identity and active generated protocol. A compatible updater change is adopted without an application version pin. An incompatible change disables Codex-thread readiness only.
- Keep the real OS `HOME` so standalone skills under `$HOME/.agents/skills` remain discoverable. Because `CODEX_HOME` points at the dedicated authenticated home, normal `~/.codex` config, auth, sessions, logs, plugins, MCP, apps, and connectors do not enter the embedded runtime.
- Install any app-owned planner skills through the deployment-owned skill surface and bind their exact names/content hashes to the release. User-owned standalone skills are discovered dynamically rather than pinned to an application release; readiness inventories their effective names/sources and proves that adding or changing a skill cannot widen tools, RPC methods, permissions, or planner commands.
- `CODEX_HOME/AGENTS.md`, the planner skills, and the fixed app cwd are release-owned instruction sources. Loading those declared sources does not create a general-purpose filesystem capability.
- The spawned app-server process receives a minimal environment and no planner database path or application secrets. The browser never receives raw app-server RPC or credentials.
- The outbound host RPC allowlist excludes shell/exec, file change, approval grants, configuration mutation, plugin/marketplace, app, MCP, and permission methods. Inbound app-server requests accept only registered planner dynamic-tool callbacks and bounded `request_user_input`; the host projects only two or three unique listed options, ignores Codex's free-form `Other` channel, accepts exactly one listed label, and rejects secret-input requests. Command/file/permission/MCP approvals receive a protocol-valid decline or rejection plus a sanitized blocked notice, and every other request method fails closed.
- Invalid home, config, auth, skill, capability, or protocol state degrades only Codex-thread readiness. The planner UI and direct planner operations remain available.

### 2. Native Thread Catalogue And Selection

- The host mediates the native Codex thread list/read/start/resume/archive and turn start/steer/interrupt subset. Browser callers never receive a raw app-server channel or permission to invoke arbitrary methods. The typed household history API may archive an eligible top-level conversation; release-probe cleanup uses the same native operation through its separate host-only release path.
- The household picker contains non-archived top-level threads from the dedicated planner runtime. Child-agent threads remain beneath their owning top-level thread. Ephemeral QA probes never enter the catalogue; a required persistent release probe is journaled by opaque ID, archived through the native operator RPC, and verified absent from the default picker before activation.
- The app persists exactly one opaque selected `TopLevelThreadId` plus a selection revision, bounded thread-start/turn-send admission markers needed to reconcile transport ambiguity, and an exact finite horizon of successful create/send receipts. Admissions contain an opaque live-owner identity, operation/client identity, a payload hash that binds the request fields, and pre-call coordinates—never message text, assistant content, child-thread topology, or a shadow thread index. Only the exclusive replacement runtime may adopt admissions left by a crashed owner.
- A valid stored selection is read/resumed on startup. If selection metadata is absent while native history exists, the most recently updated eligible top-level thread becomes selected. With no history, the UI shows a blank new-thread composer and creates the native thread only when the first message is accepted.
- **New thread** creates one native non-ephemeral top-level thread and publishes it as selected only after Codex returns its identity. Before the native call, the host durably records the exact pre-call newest-root cohort. If the result is ambiguous or selection publication fails, a replacement connection compares native history with that admission: one exact newly created root is published, no candidate permits a fresh explicit attempt, and multiple candidates fail closed for operator/user selection. It never blindly creates a second thread.
- Selecting history validates that the ID is an eligible top-level thread, reads/resumes it, then updates the selection with revision/OCC. Two stale tabs cannot both publish different selections. Each submit is checked against the current pointer/revision, so only a stale client must reconcile before sending.
- Planner-view navigation and a newly opened app tab read the same selected pointer. A thread switch changes what is displayed; it does not create, clone, cancel, or inject content into either conversation.
- Native user, assistant, reasoning-summary, tool, search, worker, error, and lifecycle items are sanitized and rendered from Codex identity-bound list/read/stream data. Only reasoning summaries are exposed, never raw reasoning content or deltas. The server pairs stable machine kinds with human-friendly labels for planner reads/previews/applies, web activity, plans, workers, compaction, and generic unknown activity. Unknown display-only item variants degrade visibly; unknown app-server requests or tool callbacks fail closed.
- A pending browser submit is not persisted as conversation. Before `turn/start` or `turn/steer`, the host stores only bounded admission metadata including the unique client message identity, a hash binding the selected revision and request fields, and expected native turn coordinates—not the message body. After ambiguous transport loss, the owning connection or an exclusively adopted replacement reconciles that identity against native history: an admitted native item is followed, while proven absence permits the same explicit send request to proceed once. Success atomically records the request/client/turn binding in the finite replay horizon before clearing the admission. Planner effect/status may decorate the thread view, but it is typed host state rather than a fabricated assistant item.
- At most one foreground turn runs on a given top-level thread. Another top-level thread may run while unselected, and switching selection does not interrupt its turn or children. Submitting to the selected running thread uses native `turn/steer` and a unique client message identity, appending input to that turn rather than starting another.
- Ordinary app/app-server restart reloads the native catalogue, selected pointer, current items, and running/terminal status from their owning authorities. Stream reconnect re-reads Codex history; it never reconstructs from planner tables.
- If the selected thread is unavailable, corrupt, archived outside the wrapper, or no longer readable, the UI marks that selection unavailable and offers the remaining history plus **New thread**. It never seeds another thread from cached text or presents replacement memory as continuity.
- The first conforming release does not import the current app-owned transcript into Codex or retain it in the live application store. Existing transcript/chat rows remain only in the immutable pre-migration backup for recovery; they do not appear as native thread history, model context, or an active/labeled app conversation.

### 3. Unified Skills, Web, And Planner Tools

The normal thread starts with one fixed effective surface:

- hosted `web_search` enabled;
- standalone skills from the normal `$HOME/.agents/skills` surface plus any release-owned planner skills enabled;
- one dynamic `planner` namespace with exactly `read`, `preview`, and `apply`;
- only an unavoidable provider-owned inert helper such as `update_plan`, if the active Codex build registers it and the compatibility gate proves it has no planner, filesystem, or network effect.

No request field, UI mode, prompt classifier, or research/planner child-session transition swaps the top-level capabilities. The owning top-level agent may interleave `planner.read`, hosted search, worker delegation, `planner.preview`, and `planner.apply` in the order the task requires. Workers may use their empirically proven research/reasoning surface and return results to the parent, but the current app-server starts them with an empty dynamic-tool vector. The parent remains the only embedded caller of `planner.read`, `preview`, and `apply`.

Skills describe workflows and tool-use guidance. They do not add tools, expand the host RPC allowlist, change planner schemas, confer archive authority, or create access to a filesystem, database, browser, app, connector, MCP server, or general network client. A skill that requires an unavailable capability remains partially or wholly unusable; its instructions are not permission.

The planner tool schemas remain the model's authoritative command catalog: `preview` and `apply` expose every registered command discriminator and its required top-level fields, while the host owns canonical nested validation. Skills must not duplicate or redefine that catalog. They provide higher-level guidance for:

- planning and replanning a multi-week household calendar;
- web-backed recipe selection and adaptation into amount-first meal snapshots;
- grocery sources and recipe provenance;
- prep, cooking, timers, leftovers, and midweek changes; and
- feedback, closeout, and reusable planning lessons.

That behavioral coverage may be packaged as one or a small set of automatically discoverable planner skills. Packaging is not a user-visible mode and does not change the fixed tool surface. Readiness proves that declared app-owned skills reach the model, not merely that files exist, and that user-owned standalone skills remain dynamically discoverable without becoming release or capability authority.

### 4. Native Background Workers

- The model may use Codex-native child agents beneath any running top-level turn. There is no separate planner feature flag, Plan/Research task type, app-owned job table, or hidden replacement top-level conversation.
- The selected thread view shows bounded worker identity, status, parent relationship, summary/progress, failure, and completion events using native Codex items. A household member may open a worker thread for read-only inspection and return to the parent. The wrapper does not offer a second composer or direct worker spawning control.
- Child-agent messages and completion are worker activity only. They never satisfy or fabricate the top-level assistant reply; only the owning top-level turn's native assistant item/terminal state completes the public response.
- Switching the selected top-level thread does not cancel its running workers. The history list continues to show running/failed/completed status so the work is not mistaken for disappearance.
- A worker uses only the effective research/reasoning surface empirically supplied by the active Codex build, bounded by the parent's permission ceiling. On Codex 0.142.5 it does not inherit app-server dynamic tools, so it cannot call the planner namespace. It also cannot add shell, filesystem, direct database, browser/computer, apps/connectors, direct MCP, arbitrary network, authentication, or release-operation authority.
- Worker output returns through native parent/child items. The owning top-level agent decides whether to use that output in a later planner read, preview, or apply. The host rejects any planner callback attributed to a child thread. A future Codex build may change this only after the generated-schema and live compatibility gate explicitly proves safe inheritance and the requirements are revised; additive protocol drift alone does not grant it.
- Cancellation, timeout, parent-turn termination, selection change, app-server disconnect, or late worker completion cannot create a planner effect because workers have no planner dynamic tool. An already accepted top-level effect remains durable even if a worker or parent later fails.

### 5. Questions And Blocked Approvals

- The public interaction projection is a strict discriminated union. `user_input` represents one pending listed-option `request_user_input` request; `approval` represents one command, file-change, permission, or MCP request already rejected by host policy. They are not interchangeable UI states.
- A `user_input` item carries an opaque host interaction ID, bounded question text, two or three unique choices, `responseMode: "listed_option"`, `allowOther: false`, nullable auto-resolution time, and thread/turn/item identity. Omitted/null `autoResolutionMs` remains blocking until the household or native lifecycle resolves it; only an explicit provider-valid 60–240 second window arms an empty-answer timer. The response route accepts exactly one displayed option label per live question, exactly once. Duplicate, expired, wrong-thread, malformed, extra-field, multi-answer, unlisted, free-form, and native secret-input responses fail closed. `serverRequest/resolved` clears the matching pending item idempotently, including when request and resolution both arrive during startup hydration, so lifecycle cleanup cannot leave a stale answer surface.
- An `approval` item is informational and non-actionable. It exposes only the safe category, `rejected_by_policy` resolution, bounded display text, and owning thread/turn/item identity. It never exposes the requested command, file path, permission payload, MCP target, raw app-server request ID, arguments, environment, or a grant/deny control.
- The host sends the app-server's exact decline/rejection response before publishing the notice. If that response or connection fails, the turn shows a sanitized interaction failure; it never waits for or infers household authorization.
- Pending questions and blocked notices are bounded process-local interaction state, not conversation authority. Reconnect or sequence loss re-reads native thread state and never fabricates an answer or approval. No question, answer, or approval payload is copied into planner-effect authority.

### 6. Planner Authority And Effect Lifecycle

- The planner namespace remains exactly `read`, `preview`, and `apply`. The internal authority manifest and command registry remain host-only.
- `read` returns bounded canonical state and versions. `preview` is pure. `apply` accepts one command or an atomic ordered batch and delegates to the same planner mutation service as the UI and Global Codex ingress.
- Every command is parsed into the registered strict command union. Unknown fields, malformed nested values, unregistered command types, stale base versions, changed-payload idempotency reuse, and unauthorized grants reject with no unintended planner effect.
- Several accepted calls in one top-level turn are separate durable effects unless represented as one atomic batch. Each effect records actor, top-level thread/turn/call identity, version, event, receipt, bounded replay result, and authoritative readback before the host answers the tool call. A child-thread identity is not an accepted planner actor.
- No database transaction spans model reasoning or hosted search. Late callbacks, revoked completion tokens, duplicate call IDs, timeout, cancellation, and app-server disconnect cannot create an unrecorded or duplicate effect.
- If a terminal reply fails after effects, the UI distinguishes “effects applied; reply failed.” Recovery cannot re-run those effects. A later new foreground request may make additional changes normally.
- Native thread content and the browser view never become a planner replay or recovery source. Planner recovery uses the effect ledger, receipts, events, and canonical readback.

### 7. Web-Assisted Planning And Source References

Web search runs in the same top-level conversation/worker tree as planner work. There is no bounded research candidate passed into another context and no special sourced-recipe task type.

- Search/page content, snippets, source labels, and model summaries are untrusted inputs. They may influence the next planner call, which is the accepted product behavior.
- The host still validates every planner argument and protected-state rule. A page cannot invoke a tool, grant archive authority, change actor provenance, select a target outside the command, bypass OCC/idempotency, or write planner fields not represented by the registered command.
- `replaceMealRecipeFromSource` remains a strict typed planner command for replacing only recipe-owned fields of an eligible existing meal. It preserves protected scheduling/execution fields and rejects protected instruction/prep state as defined by the functional spine.
- A stored source reference remains informational: canonical HTTP(S) URL, human-readable identity, and observation time. It does not attest authorship, extraction fidelity, current page truth, or single-page semantic derivation.
- QA may record that a web-search event completed in the selected thread's authorized tree and bind that observation to its top-level thread, turn, and agent thread. If a worker performs research, its result must return to the parent before the parent can make a planner call. Raw provider frames, credentials, tokens, and unrestricted page bodies do not enter planner evidence or application logs. Persistent Codex thread/runtime retention is disclosed and protected as private agent-home content rather than described as erased.

### 8. Submission And Explicit Authority

- Chat submission contains only the selected top-level thread ID, selection revision, unique client user-message ID, and message. It contains no `planner`/`sourced_recipe` intent, planner version claim, view-context authority, archive grant, or generic client-supplied authority array. A stale selection revision rejects before creating a native item. The host chooses native `turn/start` or `turn/steer` from authoritative thread state.
- The browser shows one composer for the selected top-level thread. View context remains advisory and bounded; it does not constrain the agent from reading other planner state through `planner.read` when needed. Worker drill-down is read-only.
- The backend owns start-versus-steer selection, exact interrupt targeting, native history reconciliation, and the question/approval interaction projection. The browser supplies no app-server method name, turn-state claim, approval decision, or worker command.
- Planner `archiveWeek` remains unavailable through this embedded thread boundary and cannot be acquired through transport reconciliation, questions, native approvals, skills, or web content. The separate typed planner/UI route remains authoritative for that action.
- All other supported planner commands retain the foreground authority already granted to embedded Codex. Web use does not add a confirmation ceremony.

### 9. Global Codex Integration

The existing same-UID Unix-socket client remains an independent ingress with strict health, workspace, and planner-batch routes. It injects Global Codex provenance server-side, imports no database driver/path, uses the same planner mutation service, and remains available when embedded Codex is incompatible or unauthenticated. This path is not the embedded conversation and does not read or mutate its thread state.

### 10. Dynamic Updates, Retention, And Release

- The compatibility fingerprint covers the active generated schema for thread list/read/start/resume/archive, turn start/steer/interrupt, client user-message identity, streamed item/turn and child-agent events, reasoning-summary and activity projection, `request_user_input`, command/file/permission/MCP approval rejection, dynamic-tool callbacks, the exact combined capability surface, effective skill discovery, and inbound/outbound RPC allowlists.
- The compatibility gate must empirically prove native history/selection primitives, parent/worker topology, the combined top-level web/planner/skill/worker-orchestration surface, and the absence of planner dynamic tools on workers on each changed Codex identity. Its reusable evidence records the exact worker provider-tool manifest actually observed; a worker-side `planner` namespace is incompatible, not an automatically accepted future widening. No version allowlist or fallback binary replaces this proof.
- The no-auth disposable provider probe exercises one native root through worker spawn, exact bounded `wait_agent` mailbox completion, the worker's final report returned to the root, a bounded `request_user_input` answer, and dependent `planner.read`/`preview`/`apply` callbacks. It also proves the exact `approvalPolicy:"never"` readback and rejects any approval request emitted by negative fixtures. Generated-schema checks and backend protocol tests prove the method-specific command/file/permission/MCP decline responses and sanitized notices, because the capability-closed positive probe cannot honestly induce forbidden tools. Authenticated live smoke remains separately responsible for real ChatGPT, hosted web-search, and end-to-end household behavior; it does not replace these deterministic protocol negatives.
- Probe timeout or caller cancellation is transient `unavailable` evidence and may be retried. A concrete malformed or out-of-contract frame observed before cancellation remains `incompatible`; cancellation never rewrites that protocol finding.
- Threads remain Codex-owned across releases and run under the current compatible runtime surface. If a retained thread can be read but cannot accept a turn under the active surface, it remains visible with an unavailable-to-send status; the wrapper does not replace, rewrite, or hide it. Other compatible threads and planner operation remain usable.
- The authenticated dedicated home is retained across application stage, activation, rollback, and recovery. Release operations may verify/deploy config, AGENTS, and app-owned planner skills, but may not wipe, replace, roll back, or silently migrate native thread history. User-owned standalone skill content remains outside the application release identity.
- An application/data rollback revalidates its selected-thread pointer against the retained Codex catalogue. A stale pointer becomes an explicit unselected/unavailable state; rollback never rewrites Codex history or claims that an app transcript restored conversation continuity.
- The agent home is private runtime content, not part of planner backups or application logs. Release and retention evidence records safe metadata and declared content classes, never credential bytes, account identity, raw thread content, tokens, or credential-derived hashes.
- Persistent conversation, tool, and search material may be retained in the private Codex home and by the authenticated Codex/ChatGPT service according to the active runtime/provider behavior. This architecture makes no erasure promise. Removing a thread from household selection does not claim to delete the provider/runtime thread.
- Pre-activation authenticated QA must never send synthetic test content through a household thread or production planner data. It uses an ephemeral probe where possible. A required persistent probe is recorded by opaque ID in the host-only private release journal, archived through native `thread/archive`, and verified absent from the default picker before activation; crash recovery completes that archive before the candidate can activate. This bounded release-effect coordinate is not application conversation metadata or a shadow thread index. Post-activation observation may list/read native state without adding synthetic conversation.
- The existing journaled application/data release transaction remains host-only. A new implementation of this contract requires a brand-new staged candidate and its own exact evidence chain. Prior split-context release-candidate artifacts cannot authorize activation.

## Proof Contract

The existing proof framework in [TESTING.md](TESTING.md) is authoritative. The revised cells must prove:

| Contract | Required proof |
|---|---|
| Runtime compatibility and isolation | Current, compatible-update, timeout, and incompatible fixtures plus the actual installed Codex validate the dedicated home, fixed cwd, minimal environment, native thread/worker RPC subset, combined surface, exact observed worker manifest, transient-abort classification, and complete parent/child negative capability boundary. The disposable local-provider probe and authenticated live smoke are reported as separate evidence classes. |
| Native thread catalogue and selection | At least two native top-level threads can be created, listed, read/resumed, selected, and revisited; a multi-page catalogue fixture proves complete stable pagination without omission/duplication. Planner navigation/new tabs retain the shared selected pointer; selection races converge by revision; a missing thread is explicit; no action implicitly clones or cancels work. |
| Native history authority | Multiple clients render identity-bound native items and typed host status without app transcript/history rows. Reconnect reads Codex, pre-admission failure is not presented as conversation, and static ownership checks find no shadow thread index or message store. |
| Sanitized reasoning and activity | Persisted/read and live-event fixtures prove reasoning summaries and stable machine-kind/human-label pairs for planner, web, plan, worker, compaction, error, and unknown activity while raw reasoning, arguments, results, paths, credentials, and protocol request IDs remain absent. |
| Native background workers | A selected thread spawns native child work; parent-child identity, progress, failure, completion, switch-away-and-back, and read-only drill-down render correctly. A completed child without a parent assistant result cannot terminate/fabricate the public reply. The worker returns research/reasoning to its parent, receives no planner dynamic tool, and an injected child planner callback fails closed. The parent alone may turn the result into a planner effect. |
| Questions and blocked approvals | A listed-option `request_user_input` round trip proves exact once-only answer correlation, two-to-three-option bounds, rejection of free-form/unlisted/multi-answer/native-secret input, expiry, wrong-thread rejection, and native lifecycle resolution. Separate command/file/permission/MCP fixtures prove immediate protocol rejection and a sanitized non-actionable notice with no requested payload or approval endpoint. |
| Unified capability surface | One native thread tree demonstrates worker report-to-root, a bounded user-input round trip, and dependent `planner.read`/`preview`/`apply` in one turn; authenticated smoke separately demonstrates real hosted web search. No selector, intent discriminator, hidden research/planner context, worker planner namespace, or capability swap occurs. |
| Skill discovery and provenance | Release-owned planner skills are exact and source-bound; normal `$HOME/.agents/skills` entries remain dynamically discoverable; captured model input/readback plus live behavior proves skills reach the top-level agent. Any skill guidance observed in a worker is inventoried rather than assumed. Adversarial or changed skills cannot widen tools, grants, RPC, or planner commands. |
| Identity typing | Compile-time and runtime negatives prove top-level thread, child thread/job, turn, item, call, selection revision, request/idempotency, planner version, and sync revision cannot cross boundaries. The normal contract contains no Plan/Research discriminator or app-owned transcript type. |
| Dynamic planner protocol | Start versus steer selection, client user-message correlation, and unknown, duplicate, changed-payload, out-of-tree, child-attributed, timed-out, cancelled, late, and unexpected RPC/tool calls have the specified native/effect-fencing behavior. |
| Planner operation parity | UI, the embedded top-level agent, and Global Codex use the same typed command registry and mutation authority; batches, conflicts, receipts, events, and authoritative readback have no alternate kernel. Workers have no direct planner ingress. |
| Durable effect lifecycle | Real SQLite/crash tests prove top-level accepted effects, receipts, tool-call replay, response/reply loss, cancellation, and restart readback retain exact-once planner semantics without an app-owned user-send retry lifecycle; child-attributed calls have no effect. |
| Web-assisted planning | Hostile/malformed search content may influence reasoning but cannot escape planner schemas or authority. A real main/worker tree records completed search, worker-to-parent result flow where used, a parent-owned informational source and accepted planner effects, and second-client readback without a cross-context candidate. |
| No semantic cache | Static ownership checks and deterministic stale-state scenarios prove there is no thread-history, planner, or search semantic cache: switching/reconnect reads native state, planner changes force current read/OCC, requested search refresh reaches hosted search, and only immutable idempotency replay may return a stored decision. |
| Availability and loss | Auth, history read, search, app-server, worker, tool, restart, and compatibility failures leave planner read/write usable. Recoverable transport re-reads native state; missing/unavailable threads remain selectable away from; planner state remains intact. |
| Release retention | Stage/activation/rollback preserves the authenticated agent home and native catalogue, revalidates the selected pointer, deploys exact app-owned skill/config sources without pinning user skills, excludes synthetic probes from household history/production data, and binds a fresh candidate to its own evidence. |

## Acceptance Criteria

- **AC-1 — Thin native-thread wrapper:** CHAT-01, CHAT-02, CHAT-12, CHAT-15, CHAT-21, CHAT-22, CHAT-24, and CHAT-27 through CHAT-29 in [the signoff checklist](qa/family-planner-signoff-checklist.md) prove one selected native top-level thread at a time, native history/select/new/archive, deterministic startup, app-wide selection, restart/reconnect, ambiguous-create handling, no task selector, honest legacy migration, and no duplicate transcript authority.
- **AC-2 — Natural capability use:** the **Unified capability surface** and **Web-assisted planning** cells in [TESTING.md](TESTING.md) prove the agent can choose and interleave planner skills, web search, and `planner.read`/`preview`/`apply` without a public intent.
- **AC-3 — Planner safety:** the **Dynamic planner protocol**, **Planner operation parity**, and **Durable effect lifecycle** cells prove that top-level-agent effects use the shared typed/versioned/idempotent/transactional service and survive worker/reply/process failure exactly once, while child-attributed planner calls fail with no effect.
- **AC-4 — Conversation authority:** the **Native thread catalogue and selection** and **Native history authority** cells plus CHAT-21, CHAT-22, and CHAT-27 prove Codex owns history while the app owns only selection/effect state.
- **AC-5 — Skills without capability expansion:** the **Skill discovery and provenance** cell proves release-owned and normal standalone skills reach the top-level agent without adding capabilities or archive authority; any worker skill guidance is accepted only when the active runtime proves it and still cannot add planner tools.
- **AC-6 — Fixed negative boundary:** runtime isolation evidence proves no shell, general filesystem/database, browser/computer, app/connector, direct MCP, arbitrary network, authentication, or release-operation authority is model-visible or reachable by parent or worker. Native Codex multi-agent operation is allowed.
- **AC-7 — Dynamic Codex availability:** the **Runtime compatibility and isolation** and **Availability and loss** cells plus CHAT-30 prove compatible updater changes are accepted only after the native-thread/worker/combined gate; a retained incompatible thread remains visible/read-only beside usable threads, and failed Codex/search state disables only the affected Codex surface without pinning/fallback or impairing planner/Global ingress.
- **AC-8 — Release safety:** the **Release retention** and **Local release transaction** cells plus DEPLOY-03 and DEPLOY-05 prove a new candidate preserves the dedicated agent home/catalogue, revalidates selection, isolates synthetic probe content, and uses no historical split-context artifact as activation evidence.
- **AC-9 — Distinct archive boundaries:** native conversation archive is available through the history contract and never implies planner mutation authority; CHAT-03 and CLOSE-04 separately prove that destructive planner `archiveWeek` remains on its typed household/UI one-turn-grant path outside the embedded thread until the household explicitly changes that policy.
- **AC-10 — Typed fresh authority:** the **Identity typing** and **No semantic cache** cells plus CHAT-23 prove identifiers cannot cross domains and planner/search decisions are not made from a hidden stale semantic cache.
- **AC-11 — Native workers:** the **Native background workers** cell plus CHAT-25 and CHAT-26 prove worker activity is native, correctly nested, inspectable, and limited to returning research/reasoning to the parent; the worker does not inherit planner dynamic tools and cannot create planner effects.
- **AC-12 — Questions and approvals:** the **Questions and blocked approvals** cell proves questions are answerable exactly once while command/file/permission/MCP approvals are always rejected and exposed only as sanitized read-only notices.

## Current Delivery Boundary

The production UI and previously staged runtime remain non-conforming until the separately owned backend and UI lanes meet at this contract. The backend lane owns the native app-server client, history/list/read/new/select/archive API, server-owned start-versus-steer and interrupt behavior, selected-thread OCC, sanitized reasoning/activity/worker projection, questions, blocked approval notices, planner-effect fencing, and dynamic compatibility gate. The UI lane owns removing the old task selector and app transcript view and consuming those APIs with one selected thread visible at a time.

The additive backend may leave legacy chat/transcript tables physically present while the UI lane is active, but the native service must not read or write them as conversation authority. Full cutover must retire their live use and prove that the browser renders Codex-owned history. The embedded backend always rejects planner `archiveWeek`; its existing typed household/UI one-turn-grant path remains separate. Native conversation archive remains required and is not deferred.

No candidate satisfies this requirements document until integrated browser/runtime QA proves both lanes together on the updater-managed authenticated Codex runtime. Historical selector/split-context artifacts do not supply that proof.

## Remaining Proof Gate And Ownership

No product decision remains open. Native conversation archive is part of the required history API; only rename, pin, fork, delete, search, and direct worker controls remain deferred. The backend API task is specified by the [native-thread implementation plan](codex-native-thread-backend-implementation-plan.md), while the planner UI is owned by a separate task.

The updater-managed Codex app-server still must prove its exact list/read/start/resume/archive, turn start/steer/client-message identity, reasoning/activity and interaction shapes, parent/child events, concurrent per-thread behavior, top-level web/skills/planner/worker orchestration, worker research/reasoning return flow, and worker exclusion from the planner dynamic namespace. This is a blocking closeout/activation proof gate, not a reason to retain the old split design. If the boundary cannot reproduce under the dedicated configuration, requirements reopen; implementation may not fall back to app transcript reconstruction, a shadow job system, grantable approvals, child planner authority, or split ephemeral contexts.

## Challenge Disposition

The household rejected both task-mode segregation and an app-owned single-conversation architecture as unnecessary product complexity. The selected tradeoff is a thin wrapper over Codex's native thread/history/worker model with ordinary web-assisted reasoning and skills, while durable effects remain constrained by the host mutation boundary. Separate research/planning contexts, a task selector, candidate quarantine, a duplicate transcript store, and a custom worker system are removed rather than preserved as hidden implementation details. The wrapper does retain first-class interaction visibility: answerable listed-option questions with no free-form response channel, and separate non-actionable blocked approval notices.

The challenge retained the parts that still protect the outcome: dedicated runtime isolation, strict planner schemas, typed informational sources, selection/planner OCC, idempotency/transactions, one running turn per top-level thread, planner-effect fencing/readback after reply loss, updater compatibility checks, and the fixed authority ceiling for parent and child agents. It does not preserve the superseded app-owned chat retry lifecycle.

## Handoff

This document and the [functional spine](functional-spine.md) own the revised requirements. The [native-thread backend implementation plan](codex-native-thread-backend-implementation-plan.md) owns the backend/API build and proof loop; the UI remains separately owned. [TESTING.md](TESTING.md) and the [signoff checklist](qa/family-planner-signoff-checklist.md) own integrated proof. The [unknowns register](codex-agent-runtime-follow-up-unknowns.md) remains a historical protocol/release evidence source, not current authority for superseded thread/context or approval behavior.

Implementation proceeds directly against this contract. Closeout must run the exact runtime/interaction capability gate and integrated UI/browser proof before any new staged candidate may be activated.
