# Follow-Up Phase: Scoped Codex Planner Agent

**Status:** architecture and implementation-shaping unknowns finalized; the installed-binary capability composition is proven in a disposable no-auth harness. Implementation and authenticated/live runtime acceptance remain deferred until the current family-readiness phase lands. This document is not part of current family-readiness implementation or signoff.

**Depends on:** the server-owned household workspace, caller-owned transaction boundary, versioned/idempotent planner mutation service, durable shared transcript, and bounded single-in-flight chat lifecycle in `docs/family-readiness-remediation-plan.md`.

**Readiness record:** `docs/codex-agent-runtime-follow-up-unknowns.md` is **CLOSED**. It fixes the update-aware compatibility gate, capability controls, wire protocol, planner schemas, effect lifecycle, research payload, and global-client transport; it is the detailed source for field-level limits and evidence.

## Outcome

The embedded ChatGPT panel runs a private Codex app-server process configured for this planner. It can research recipes on the web and make several dependent planner calls during one foreground household chat turn. It has broad authority over the planner's supported domain actions, but every durable effect is host-executed through the same versioned, idempotent, transactional mutation service used by the UI.

A normal global Codex session may research with its existing capabilities and inject sourced recipes or planner batches through a thin local client over that same application service. Neither embedded nor global Codex edits SQLite or authoritative planner files directly.

Chrome, browser/computer control, tab groups, site allowlists, and browser-profile decisions are not required for this phase and remain later work.

## Locked Invariants

These decisions came from the delegated Codex-runtime discussion and are not reopened by implementation planning:

1. **Phase boundary.** The current family-readiness release retains a concise structured reply plus at most one typed planner command. Dedicated runtime isolation, web research, dynamic planner tools, and global-agent import land only in this follow-up.
2. **Dedicated runtime.** Embedded Codex uses a dedicated `CODEX_HOME`, a fixed deployment-owned app cwd, a private app-server process, ChatGPT authentication, and file-backed credentials. It is not a profile layered over the normal `~/.codex` runtime.
3. **Normal `HOME`, narrow Codex surface.** The process keeps the normal OS `HOME` so standalone skills under `$HOME/.agents/skills` remain discoverable. It does not inherit normal `~/.codex` config, auth, plugins, MCP servers, sessions, logs, or state.
4. **Capability boundary.** Embedded Codex may use brokered web search and registered planner dynamic tools. It has no shell/exec, general-purpose model-visible filesystem read/write or database read/write tool, Chrome/browser/computer control, apps/connectors, direct MCP tools, or arbitrary command-network path. Runtime-owned loading of declared deployment instructions and skill bodies is allowed and does not grant a general-purpose filesystem tool.
5. **Intent and untrusted data.** The frozen current foreground user request supplies task intent within the fixed planner capability manifest. Prior transcript, planner state, search results, fetched page content, and tool output are untrusted data and cannot expand that authority.
6. **Planner authority.** Several dependent reads, validations, and mutations may occur in one household turn. Every accepted effect uses the planner mutation service and authoritative host readback; the model never reports success from intent alone.
7. **Global-agent path.** A normal global Codex session may keep its usual capabilities, but planner injection crosses a thin local client boundary and receives the same validation, OCC, idempotency, event, and readback semantics. It never edits SQLite.
8. **Later surfaces stay later.** This phase does not design or prove Chrome/profile/allowlist integration, Tailscale deployment, user accounts, notifications, or unattended autonomy.

## Current Bridge Evidence, Not A Target Contract

The current bridge establishes useful protocol seams but does not prove this architecture:

- `site/bridge/server.mjs` starts one ephemeral app-server thread with a browser-supplied state snapshot, `sandbox: "read-only"`, `approvalPolicy: "never"`, and a terminal reply-plus-command schema.
- `site/bridge/app-server-client.mjs` starts `codex` from `process.cwd()`, forwards the complete `process.env`, and rejects every app-server request initiated by the server.
- `site/bridge/validation.mjs` bounds and validates the single terminal reply/command payload.

This follow-up must replace those launch, state-ownership, capability, and dynamic-tool behaviors. A read-only sandbox and prompt prose are not proof that shell, filesystem, apps, or MCP tools are unavailable.

## Architecture Forces

| Force | Status | Behavioral evidence | Resolution |
|---|---|---|---|
| State and lifecycle | present | A durable household turn can contain tool calls, accepted effects, failure, interruption, and a later terminal reply | Extend the host-owned chat lifecycle with fenced, durable tool-call outcomes; Codex thread state is never recovery authority |
| Persistence | present | Planner effects and transcript must survive process restart; auth must refresh without touching normal Codex state | Planner database owns product state; dedicated `CODEX_HOME` owns only isolated Codex auth/runtime artifacts |
| Contracts and validation | present | Browser input, tool arguments, global-client payloads, and web-derived recipe data cross untrusted boundaries | Validate and bound every edge into typed planner commands and source records; default-deny unknown commands/tools |
| Internal typing | present | IDs, versions, sources, calls, and commands must not be confused | Use typed/branded domain identifiers and host-generated turn/call provenance in the shipped schemas |
| Concurrency | present | UI, embedded Codex, and global Codex can write from the same planner version | Reuse whole-planner OCC, idempotency receipts, atomic per-call transactions, and authoritative conflict refresh |
| Failure and resilience | present | App-server, auth, search, dynamic calls, and terminal reply can fail independently | Never hold a database transaction across a model call; fence late calls; preserve accepted effects; keep planner readiness independent |
| Protocols and boundaries | present | App-server dynamic tools and capability controls are versioned/experimental integration surfaces | Track the updater-managed current Codex, revalidate on every binary/schema change, and fail only agent readiness when the required boundary no longer reproduces |
| Caching | absent | A mutation must use current canonical state and success requires authoritative readback | Do not add a semantic cache or stale-write path; bounded read models remain non-authoritative |

## Selected Architecture

### 1. Deployment And Process Isolation

Use this deployment shape:

```text
~/meal-planner/
  app/       # deployed app and fixed app-server thread cwd
  agent/     # dedicated CODEX_HOME: config, AGENTS, planner skills, auth, runtime state
  data/      # SQLite, WAL/SHM files, exports, and backups
```

- Resolve all three absolute roots from server-owned deployment configuration. Browser input, shell launch cwd, and `process.cwd()` never select them.
- Run app-server as the existing runtime OS user; this phase does not introduce another OS account. The dedicated home is private to that user (`0700`) and separate from app/data roots.
- Launch through the server-owned updater-managed launcher `$HOME/.local/bin/codex`, never browser input, `PATH` search, cwd, or arbitrary configuration. The launcher path stays fixed while its release target updates. Canonicalize that target at startup and record the resolved path, version, hash, and generated protocol fingerprint. Keep `HOME` for standalone-skill discovery and set the dedicated `CODEX_HOME`; include only required system path, locale, temp, and explicitly justified TLS/network variables. Do not forward the planner server's complete environment or database/application secrets.
- The fixed app cwd may contain deployment-owned planner content, but it must not add capability-bearing project `.codex/config.toml` or an untracked instruction source. `CODEX_HOME/AGENTS.md` is the canonical embedded behavior layer. Effective instruction, config, and skill sources are part of deployment readback.
- Keep normal `HOME` so the host can discover standalone skills under `$HOME/.agents/skills`, but do not give the model a general skill/filesystem reader. Disable the model-visible orchestrator skill namespace. At deployment, the host may preload only explicitly allowlisted planner-relevant skill bodies, integrity-recorded by path/hash, into the owned instruction context. Discovery or skill prose never widens the registered tool set.
- The dedicated home starts with no installed plugin or MCP surface. Disable orchestrator-owned skills/MCP plus apps/plugins and require empty MCP readback; normal `~/.codex` remains outside the config/state search path.
- Neither the dedicated home nor the data root is a thread workspace. Runtime-owned instruction/skill loading is allowed; registered model tools cannot read credentials, Codex runtime state, planner database/WAL/backups, or normal-home secrets.
- Start a private stdio app-server child for the planner. Never attach to Eric's normal app-server daemon and never expose raw app-server RPC to browser clients.
- The host client uses an outbound RPC allowlist. It never invokes `thread/shellCommand`, `command/exec`, `process/*`, marketplace/plugin/config mutation, app calls, or direct MCP calls. For inbound server requests it accepts only registered planner dynamic-tool calls and rejects every approval, exec, file-change, app, MCP, permission, or unknown request.
- Bad home/config/auth/capability state fails the embedded-agent readiness check closed. It does not fail planner/store startup or make the household workspace unavailable.

### 2. Authentication And Runtime State

- Store credentials in the dedicated home with `cli_auth_credentials_store = "file"` and `forced_login_method = "chatgpt"`.
- Prefer a fresh `CODEX_HOME=... codex login`. Copying only `auth.json` is an acceptable bootstrap fallback when necessary; it duplicates local credentials but does not create a distinct ChatGPT identity. Never copy the normal `~/.codex` tree.
- The durable household transcript is the sole cross-turn conversation authority. Each internal Codex execution uses a disposable/ephemeral thread seeded from the frozen canonical household turn input. Codex rollouts, logs, and thread state are diagnostics only and are never resumed as hidden planner conversation state.
- Ephemeral does not mean fileless. Tested 0.142.5 creates state/log/goal/memory SQLite scaffolding, and its bounded trace log can contain prompt/tool/search material even when no thread/rollout row persists. Each thread/process partition is continuously capped at 1,000 rows/about 10 MiB; startup maintenance deletes rows older than ten days, so age may exceed ten days between restarts. Keep the dedicated home `0700`, exclude it from planner backups and application-log ingestion, document the active build's observed behavior, re-inventory it after Codex updates, and never describe it as an erasure boundary.
- Logout, expiry, refresh, app-server exit, or malformed runtime state can make the assistant unavailable without changing planner readiness or corrupting product state.

### 3. Research And Planning Contexts

For a planner request that needs the web, use two isolated Codex contexts inside one durable household chat turn:

1. **Research context:** index-gated hosted web search is available; planner mutation tools are absent. It returns a bounded structured candidate with source provenance. Raw page content is not persisted in the planner, application logs, or shared transcript, though it may appear temporarily in the isolated Codex runtime's bounded local log store.
2. **Planner context:** planner dynamic tools are available; web search and raw page content are absent. It receives the frozen user request, canonical planner/transcript context, and the bounded sourced candidate, then may perform dependent reads, validations, and mutations.

A request that does not need research starts directly in the planner context. This separation prevents page content from directly invoking planner tools, but it does not prove prompt-injection immunity or perfect semantic fidelity. The accepted residual risk is that hostile source data can still influence candidate content. Host schemas, size limits, source provenance, the planner capability manifest, and foreground user initiation bound the impact.

The cross-context candidate is strict `additionalProperties:false` JSON capped at 32 KiB: schema version; host-materialized candidate ID; web source identity, HTTP(S) URL, and host retrieval time; a bounded title/yield; and 1–32 steps with bounded ingredient amount/name pairs, instruction, and optional duration. It has no HTML, Markdown, page body, excerpt, arbitrary metadata, or attachment field. Before acceptance the transcript stores only candidate ID/title, compact source, and step count.

Accepted intake materializes as an app-owned, week/meal-local `RecipeSnapshot` with `SourceRecipe` provenance through a typed planner command. The external page is not canonical, no research-candidate authority table is added, and this phase does not turn the product into a recipe-library-first system. Reusable recipe records arise only through the planner's explicit promotion behavior.

### 4. Dynamic Tool And Chat Lifecycle Ownership

The host registers one `planner` dynamic-tool namespace containing exactly six functions generated from one deployment-owned command registry and schema: `authority`, bounded `read`, pure `preview`, `apply`, `apply_batch`, and `refresh`. Read queries are limited to workspace, week, meal, and a sanitized recent-history tail. Apply carries one operation; batch carries 1–16 ordered operations. The model never supplies actor, provenance, turn/token/call identity, or request ID. Every result is a versioned bounded envelope with current planner/sync versions, server time, typed data, or a sanitized error plus an explicit retry disposition. Field shapes and limits are fixed in the closed readiness record.

There is no generic durable staging subsystem. Preview is a pure turn-local operation.

Every dynamic call has a host-owned identity bound to the durable household `turn_id`, active completion token, app-server `callId`, registered tool name, and canonical argument hash; JSON-RPC request `id` remains a separate transport correlation. Exact duplicates replay the immutable recorded outcome. Unknown tools, changed-payload/reused identities, cancellation, the 30-second local call deadline, connection loss, or a late token fail deterministically; timeout interrupts the turn and rotates the completion token.

Several successful mutation calls are allowed when a later call genuinely depends on authoritative IDs or readback from an earlier accepted call. Each accepted mutation call:

1. supplies the current planner base version obtained from authoritative readback;
2. enters the same caller-owned unit of work and mutation kernel used by the UI;
3. commits its planner update, event, receipt, actor/provenance, and sanitized tool outcome atomically;
4. returns authoritative result state/version before the model may claim success.

There is no transaction spanning multiple model calls or the terminal reply. If all intended changes are known together, the agent should prefer one atomic batch. When dependent calls commit separately, their already-accepted effects remain visible and individually audited even if a later call or final reply fails; only the latest eligible planner event is undoable under the existing recovery policy.

The follow-up extends the chat lifecycle accordingly:

- read/preview calls and rejected mutation attempts may repeat while the turn is running;
- each accepted effect is durably attached to the turn before its tool response is returned;
- model failure or restart after one or more effects records a terminal “effects applied; reply missing/failed” outcome instead of implying rollback;
- startup recovery reads back recorded effects and never auto-runs work;
- when a turn with no accepted effect fails, explicit Retry may start a fresh planner context against current canonical state;
- when any effect was accepted before interruption or reply failure, Retry is recovery-only: mutation tools are absent, the context reconstructs a reply from the durable effect ledger/readback, and any remaining desired mutation requires a new foreground user turn;
- completion tokens fence late tool calls and late terminal replies;
- the shared transcript stores the user request, compact sourced candidate, sanitized tool outcomes, and terminal reply/failure—not credentials, model reasoning, or unrestricted page contents.

One `planner_tool_calls` ledger keyed by `(turn_id, tool_call_id)` stores sequence, token/tool/argument identity, terminal status, bounded replay result, and optional operation/request/event/base/result-version linkage. Accepted mutation, receipt, event, tool outcome, effect sequence, and turn effect count commit together. `chat_turns` adds normal/recovery mode, completion-token hash, accepted-effect count/sequence, precise no-effect/after-effect terminal outcome, and recovery linkage. Startup abandons only pre-commit running calls; committed calls replay from the ledger.

This lifecycle extension belongs only to the follow-up. The current family phase keeps its simpler terminal reply plus at most one typed command, committed atomically as already planned.

### 5. Planner Authority And Batch Semantics

The embedded planner capability manifest is deployment-owned, generated from the same registry/schema as the application API, and default-deny: a new domain command is unavailable until deliberately mapped, validated, attributed, and tested. Startup fails if a registered command lacks policy. The fixed limits are 32 tool calls per turn, 16 commands per batch, 64 KiB arguments, 128 KiB results, and 20 recent history events.

The initial manifest covers ordinary recipe/snapshot, meal scheduling and editing, prep, grocery, leftover, note, feedback, timer, and week-lifecycle actions already owned by the planner domain. Latest-only undo and archive may be used only for an explicit foreground user request and must satisfy the same target/version guards as the UI. Seed reset, legacy import, arbitrary restore, backup/admin operations, development controls, and actor assignment are never exposed as agent tools.

One batch call carries one base planner version and a non-empty ordered list of typed commands. The host validates the whole envelope, reduces commands sequentially against an in-memory candidate, validates the final aggregate, and writes all-or-nothing in one transaction. One accepted batch produces one idempotency receipt, one planner-version increment, one event/change set, and one undo unit. Any command rejection or conflict commits none of the batch. The result includes canonical readback.

At follow-up landing, generalize the existing caller-owned kernel once to `applyPlannerOperations(tx, request.operations)`. Current UI/chat facades continue to pass an array of one; embedded/global batch facades pass 1–16. The pure reducer still handles one command at a time, while the application service loads once, reduces the ordered list in memory, validates once, and writes once. This is not a requirement for the current family release to accept multi-command input and it does not create a second mutation authority.

### 6. Global Codex Integration

- The global path is a thin CLI or equivalent local client of the same application service. It submits typed recipe or planner batches and receives the same OCC, idempotency, validation, events, receipts, and canonical readback.
- Use HTTP/1.1 over the fixed user-owned socket `$HOME/meal-planner/run/global-codex.sock`; private loopback is removed from this phase. The run directory is deployment-owned/current-UID `0700`, the socket is `0600`, and same-UID local access is the accepted admission boundary. Its `globalCodex` label is ingress provenance, not cryptographic proof that the caller process is Codex.
- The separate UDS route table exposes only health, workspace readback, and strict versioned planner-batch apply. It is never mounted under browser `/api`, Vite/Vinext/front-controller proxying, or the old bridge. It accepts no Origin/fetch metadata, upgrade/proxy behavior, socket/upstream target, state/transcript, database/SQL field, or caller-supplied actor.
- The adapter injects `{actorClass:"codex", actorSource:"global", admission:"same_uid_uds_v1"}` and calls the same `PlannerMutationService.applyBatch` facade as embedded Codex. The thin CLI imports only shared DTO/schema code and `node:http`; it has no server composition, SQLite driver/path, raw SQL, or fallback transport.
- One client UUID plus the ordered canonical batch supplies the idempotency hash. Transport uncertainty retries the same ID; changed payload reuse fails; a deliberate post-refresh attempt uses a new ID. Stale-socket handling verifies path type, owner, directory mode, and device/inode before one unlink/rebind attempt; UDS failure never degrades browser planner/store readiness.
- A dedicated MCP remains unnecessary unless a later remote/reusable integration justifies it. Stronger caller identity is a later transport upgrade, not a reason to keep a loopback branch now.

### 7. Capability Gate And Atomic Cutover

[Official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread) marks `dynamicTools` experimental and requires the client's experimental API capability. The disposable proof happened on 0.142.5 x86_64, SHA-256 `a96e76a616db98a9c7cb6bc1c8a52ec7cc90a553451ebe359ee63270fb1e9a9a`; that is an evidence coordinate, not a deployment pin.

Production follows the updater-managed current Codex. At every process start, canonicalize the trusted launcher target, read its version/hash, generate the experimental JSON schema into the dedicated runtime cache, and compare the required protocol subset and capability fingerprint with the last accepted result. A new target/version/schema automatically runs the disposable no-auth positive/negative compatibility gate before embedded-agent readiness. Compatible updates are accepted without an app configuration change or version allowlist. A breaking update disables only the embedded/global agent adapters, leaves planner/store/transcript available, and waits for an adapter update; it does not silently roll back Codex or weaken the boundary.

The disposable no-auth installed-binary spike closed the planning unknowns:

- normal `HOME` plus a fresh dedicated `CODEX_HOME` enumerated the expected standalone `$HOME/.agents/skills` while config readback contained only the dedicated config and empty system layer, not normal `~/.codex`;
- indexed research exposed exactly `[update_plan, web_search]`, with index-gated external access and no planner namespace;
- every planner request exposed exactly `[update_plan, planner]`, with no hosted search;
- shell/exec/patch, general filesystem/image, MCP, apps/plugins, browser/computer, and multi-agent tool classes were absent;
- one ephemeral turn completed call A, consumed its host-returned ID in dependent call B, and then completed normally; and
- the tested runtime rejects an invalid deferred dynamic-tool registration before a model request.

`update_plan` is unconditionally present in the tested build. It emits a planner-inert `PlanUpdate` event with no planner/filesystem/network effect, though its content may enter the private runtime log store. It is explicitly allowed in both contexts; the architecture does not pretend each context has literally one tool. Every new Codex build must reproduce that harmless classification or fail compatibility. App-server still implements dangerous client-callable RPC methods, so the host's inbound/outbound method allowlists remain a separate mandatory boundary.

The no-auth spike did not test ChatGPT login/refresh, a real model choosing the calls, or real indexed-search content. Those are opt-in runtime acceptance cells after implementation, not decisions that change the plan. Config/readback remains supporting evidence; deterministic forbidden-operation, sentinel, failure, and live authenticated probes are still required before activation. If the current build fails those later cells, stop agent activation rather than weakening the boundary.

The old bounded adapter remains the only live family path while isolation, dynamic tools, research mediation, global import, and lifecycle behavior are built and tested in a disposable opt-in harness. Final activation is one cutover: enable the dynamic adapter and remove/dead-code the old terminal-command path in the same change. Never ship two live Codex mutation paths.

## Delivery Sequence

1. **Codify the update-aware capability gate.** Commit the required protocol/capability fingerprint, dedicated-home config, indexed-research/planner tool manifests, host RPC allowlists, and disposable regression harness. Resolve and generate evidence from the updater-managed current Codex at install/startup; add authenticated readback as an opt-in acceptance cell without changing the live family path.
2. **Extend the host lifecycle.** Add fenced durable dynamic-call outcomes and restart/failure behavior while keeping planner readiness independent.
3. **Add planner tools and batch mutation.** Implement bounded read, pure preview, typed apply/batch, conflict refresh, per-call authoritative readback, and the default-deny command manifest through the shared service.
4. **Add mediated recipe research.** Implement research-only candidate extraction, provenance, bounded transfer into the planner context, and RecipeSnapshot intake.
5. **Expose the global-agent client.** Add the fixed same-UID UDS ingress and thin client for sourced recipe/planner batches.
6. **Prove and cut over once.** Run deterministic and opt-in live proof in a disposable store, then atomically activate the dynamic path and remove the old adapter.

## Proof Contract

| Contract | Required proof |
|---|---|
| Runtime isolation | Launch from the app directory, its parent, and an unrelated cwd; the server-owned updater path resolves to the same current target/version/hash within a run, while dedicated home, app cwd, child-env allowlist, effective config/instruction sources, and filesystem modes remain fixed; sentinel host/application secrets are absent |
| Update compatibility | Swapping the trusted launcher to a compatible newer fixture reruns schema/capability validation and restores agent readiness automatically; an incompatible schema/tool fixture leaves planner/store ready, marks only agent adapters incompatible, and never falls back to an older binary or prompt-only enforcement |
| Authentication separation | Real `account/read` reports ChatGPT auth from the dedicated home; normal `~/.codex` auth/config/session/plugin state hashes and mtimes are unchanged across embedded login, restart, refresh, and logout tests |
| Skill and config provenance | Real skills/instruction/config readback shows intended `$HOME/.agents/skills` plus deployment-owned planner sources, no capability-bearing project config, no inherited normal Codex plugin/MCP/config/auth/session surface, disabled model-visible skill namespace, and only allowlisted/integrity-recorded skill bodies preloaded by the host |
| Capability enforcement | Captured arrays are exactly `[update_plan, web_search]` for indexed research and `[update_plan, planner]` for planning; effective capability evidence and adversarial calls show forbidden shell/exec, general-purpose filesystem read/write, database read/write, browser/computer, app, MCP, multi-agent, and arbitrary network actions cannot execute |
| Dynamic protocol | Fake and real app-server turns exercise registered dependent calls, bounded arguments/results, unknown tools, duplicate IDs, changed-payload reuse, cancellation, timeout, late tokens, and host request-method allowlists |
| Per-call transaction parity | UI, embedded-agent, and global-agent calls converge on the same mutation service and produce equivalent domain outcomes, conflicts, idempotent replay, actor provenance, events, receipts, and readback; static ownership checks reject a second mutation kernel |
| Atomic batch | Ordered multi-command success produces one version/event/receipt/undo unit; mid-batch rejection, conflict, failpoints, replay, and restart produce no partial batch |
| Dependent effects | One turn performs at least two dependent successful mutations using authoritative IDs/readback; every effect is separately durable, attributed, versioned, idempotent, and visible to another client |
| Turn/effect failure | Deterministic process exits before/after tool receipt, mutation commit, tool response, and terminal reply prove accepted effects persist, late calls are fenced, and “effects applied; reply failed” is visible. After a create-like effect commits and the reply is lost, recovery-only Retry has no mutation tools and leaves effect/event/receipt counts exactly one |
| Research mediation | A hostile-page fixture and opt-in indexed search prove raw page content has no planner tools, transfer is bounded/source-attributed, malformed or excessive candidates fail, planner context sees no web tool/raw page, and unrestricted content is absent from planner database/shared transcript/application logs; dedicated Codex runtime logs remain private, bounded, and explicitly inventoried |
| Race handling | Two UI clients plus embedded/global agents contend from one planner version; accepted writes are preserved, conflicts refresh authoritatively, and no stale terminal success claim remains |
| Global-agent admission | The thin client package has no database path, driver, or database-specific operation; browser JavaScript cannot use its ingress or choose its actor; a normal Codex-driven call is attributed by the server and a second browser observes canonical readback |
| Availability | Missing/malformed home, expired auth, app-server exit, failed research, tool failure, and restart leave planner/store/transcript readable and embedded-agent status visibly unavailable or recoverable |
| Atomic cutover | Architecture/static checks and runtime route inventory prove exactly one live Codex mutation path before and after activation; the old bounded adapter cannot be invoked after cutover |

## Acceptance Criteria

- The current family-readiness completion contract has landed before follow-up activation.
- The embedded app-server always uses the canonical target of the server-owned updater-managed Codex path, dedicated Codex home, fixed app cwd, minimal child environment, and deployment-owned instruction/capability manifest.
- Every changed Codex target/version/schema reruns the compatibility gate; compatible updates activate automatically, while incompatible updates disable only agent readiness with no silent rollback or fallback.
- Fresh file-backed ChatGPT login survives restart without reading or modifying normal `~/.codex` state; the documented `auth.json` bootstrap fallback is separately labelled as credential copying, not identity isolation.
- The capability gate reproduces the exact allowed arrays—ambient `update_plan` plus indexed search or planner namespace—and the required negative boundary; prompt prose and read-only sandboxing are not accepted as proof.
- A foreground household request can use web research through the isolated research context, preserve bounded provenance, then perform several dependent planner calls with authoritative readback.
- Every accepted single command or batch uses the shared planner mutation service. Multiple accepted calls in one turn remain individually atomic, idempotent, attributed, and visible even if the reply later fails.
- Retry after any accepted effect is reply/readback recovery only; remaining changes require a new foreground user turn.
- A normal global Codex session can inject an equivalent sourced recipe or planner batch through the local client and receives the same validation/conflict semantics; the supported client performs no database operation.
- Planner and durable transcript operation remain available when Codex is unavailable.
- Final activation removes the old bounded adapter; no mixed or fallback authority path ships.

## Readiness Resolution And Remaining Acceptance

There are no implementation-shaping open questions. `docs/codex-agent-runtime-follow-up-unknowns.md` records the tested proof artifact, dynamic-update policy, config and tool manifests, dynamic-call protocol, six planner tools, field limits, operation/batch service, durable effect ledger, research candidate, and Unix-socket client contract.

The remaining acceptance observations can only be made against the implemented/live boundary and do not select a different architecture:

- fresh dedicated-home ChatGPT login, refresh, restart, and account readback without normal-home mutation;
- real indexed search and real-model dependent-call behavior under the captured tool manifests;
- production instruction/skill/config readback and forbidden-operation/sentinel results;
- the authenticated ChatGPT workspace/search operational-retention disclosure beyond local Codex behavior; and
- deterministic crash/race/timeout/cutover evidence against the shipped planner service.

Failure of any acceptance cell stops activation and may force a new architecture decision; it does not pull speculative alternatives into this plan. Chrome/profile/site allowlists, remote deployment, stronger-than-same-UID caller identity, and autonomous/background work remain explicitly later.

## Explicitly Deferred Beyond This Phase

- Chrome plugin or extension access, tab-group confinement, site allowlists, and browser-profile decisions.
- Tailscale Serve, service supervision, TLS, Tailnet ACLs, and remote-device deployment proof.
- Per-person accounts, private transcripts, permissions, or attribution beyond household/UI/embedded-Codex/global-Codex actors.
- Notifications, background browser work, automatic meal generation, and autonomous unattended changes.
- A general-purpose public MCP or remote automation API.

## Challenge Disposition

Independent intent, architecture/ownership/proof, simplicity, and architecture-coherence stances challenged the draft against the delegated decisions and current bridge.

Accepted revisions:

- made the mid-turn tool-effect lifecycle explicit instead of pretending it shared the current terminal-command atomic boundary;
- added deterministic call fencing, effect audit/readback, failure-after-effect behavior, batch semantics, environment/RPC allowlists, instruction/skill provenance, global-client admission, and a real capability gate;
- made retry after an accepted effect recovery-only so completion-token rotation cannot admit a duplicate semantic mutation;
- replaced ambiguous durable “staging” with pure preview;
- separated raw web research from planner tools and bounded RecipeSnapshot provenance;
- made the live cutover atomic and kept all follow-up runtime work out of current family signoff.

Rebutted or narrowed challenges:

- The simplicity proposal to allow at most one successful mutation per turn was rejected because the settled product contract requires several dependent calls, including later changes that may need authoritative IDs/readback from an earlier commit. One batch is preferred when the whole change is known; multiple separately atomic effects remain supported.
- A mandatory human confirmation step for every web-derived write was not added because it would narrow the settled broad foreground planner authority. Instead, research and planning contexts are separated and the remaining semantic-influence risk is stated rather than misrepresented as eliminated.
- Batch tools, dynamic-call lifecycle storage, and runtime isolation are not pulled into the current family implementation. This document freezes their future seam; implementation starts only after the shared service exists.

Second pass: the intent, architecture/ownership/proof, and architecture-coherence stances signed off after the multiple-dependent-effect contract, recovery-only post-effect retry, general-purpose filesystem/database denial, current-user intent boundary, latest-only undo wording, and same-UID global-client trust were made explicit. No challenge blocker remains.

No architecture question remains that should block the current family-readiness implementation or later follow-up planning. The live acceptance cells may still block follow-up activation, and that is the intentional fail-closed stop condition.

## Implementation-Planning Entry Point

Begin follow-up implementation planning only after the family-readiness phase has landed the authoritative planner API and shared bounded chat lifecycle. Start by committing the update-aware schema/capability gate and probe baseline, then map the already-fixed planner tools and lifecycle rows onto the shipped service; do not redesign them against the current browser reducer. Authentication remains an explicit opt-in runtime acceptance step, not planning work. Never weaken a locked boundary to make a newer binary or live test appear compatible.
