# Follow-Up Phase: Scoped Codex Planner Agent

**Status:** architecture and implementation-shaping unknowns are finalized. Family-readiness implementation landed at `217e81306160346fc944712175059bece5da23d0` and its exact closeout baseline is `c811adc2b2fd05d5573933e10ca77e60f2d0e7ba`. All four waves are implemented as one single-path release candidate. The runtime follows the updater-managed current Codex dynamically and does not pin or package a Codex version. Authenticated readback consumes the same accepted identity-bound execution capability as runtime sessions, so updater or deployment-provenance drift before the readiness app-server spawn or account readback fails closed without publishing mixed-identity evidence. Release completion is not self-certified by this document: only the exact private `stage -> installed -> auth-lifecycle -> release-candidate -> qa -> activation -> current` chain, current pointer, and post-activation observation can claim an active release. The `auth-lifecycle` compatibility label now denotes authentication readiness, not a login/logout ceremony. This follow-up remains outside family-readiness signoff.

**Depends on:** the server-owned household workspace, caller-owned transaction boundary, versioned/idempotent planner mutation service, durable shared transcript, and bounded single-in-flight chat lifecycle in `docs/family-readiness-remediation-plan.md`.

**Readiness record:** `docs/codex-agent-runtime-follow-up-unknowns.md` is **CLOSED**. It fixes the update-aware compatibility gate, capability controls, wire protocol, planner schemas, effect lifecycle, research payload, live intent/readiness projection, and global-client transport; it is the detailed source for field-level limits and evidence.

## Outcome

The embedded ChatGPT panel runs a private Codex app-server process configured for this planner. It can research recipes on the web and make several dependent planner calls during one foreground household chat turn. It has broad authority over the planner's supported domain actions, but every durable effect is host-executed through the same versioned, idempotent, transactional mutation service used by the UI.

A normal global Codex session may research with its existing capabilities and inject sourced recipes or planner batches through a thin local client over that same application service. Neither embedded nor global Codex edits SQLite or authoritative planner files directly.

Chrome, browser/computer control, tab groups, site allowlists, and browser-profile decisions are not required for this phase and remain later work.

## Locked Invariants

These decisions came from the delegated Codex-runtime discussion and are not reopened by implementation planning:

1. **Phase boundary.** The current family-readiness release retains a concise structured reply plus at most one typed planner command. Dedicated runtime isolation, web research, dynamic planner tools, and global-agent import land only in this follow-up.
2. **Dedicated runtime.** Embedded Codex uses a dedicated `CODEX_HOME`, a fixed deployment-owned app cwd, a private app-server process, ChatGPT authentication, and file-backed credentials. It is not a profile layered over the normal `~/.codex` runtime.
3. **Normal `HOME`, narrow Codex surface.** The process keeps the normal OS `HOME` so standalone skills under `$HOME/.agents/skills` remain discoverable. It does not inherit normal `~/.codex` config, auth, plugins, MCP servers, sessions, logs, or state.
4. **Capability boundary.** Embedded Codex may use brokered web search and one planner namespace containing exactly `read`, `preview`, and `apply`. Every allowed command-type alternative is visible directly in the `preview`/`apply` schemas, and their generated descriptions list the required top-level fields; canonical nested value validation remains host-side. The authority manifest stays internal, `read` handles conflict refresh, and `apply` handles one or an atomic ordered batch. It has no shell/exec, general-purpose model-visible filesystem read/write or database read/write tool, Chrome/browser/computer control, apps/connectors, direct MCP tools, or arbitrary command-network path. Runtime-owned loading of declared deployment instructions and skill bodies is allowed and does not grant a general-purpose filesystem tool.
5. **Intent and untrusted data.** The frozen current foreground user request supplies task intent within the fixed planner capability manifest. Prior transcript, planner state, search results, fetched page content, and tool output are untrusted data and cannot expand that authority.
6. **Planner authority.** Several dependent reads, validations, and mutations may occur in one household turn. Every accepted effect uses the planner mutation service and authoritative host readback; the model never reports success from intent alone.
7. **Global-agent path.** A normal global Codex session may keep its usual capabilities, but planner injection crosses a thin local client boundary and receives the same validation, OCC, idempotency, event, and readback semantics. It never edits SQLite.
8. **Later surfaces stay later.** This phase does not design or prove Chrome/profile/allowlist integration, Tailscale deployment, user accounts, notifications, or unattended autonomy.

## Historical Bridge Evidence And Candidate Cutover

The bounded bridge established useful protocol seams but did not prove this architecture:

- It launched `codex` from caller cwd with the complete process environment and used a terminal reply-plus-one-command schema.
- It rejected every app-server-initiated request, so it could not support the locked dependent dynamic-tool contract.
- Its temporary auth-linked policy surface was evidence for feasibility, not the selected dedicated-home deployment boundary.

The unreleased candidate has deleted that bridge, adapter, output schema, factories, and legacy-only tests. `site/server/index.ts` now composes the fail-soft managed runtime directly into the durable dynamic chat service; research and planner execution use disjoint restricted sessions, and architecture checks reject any legacy constructor or selector. A read-only sandbox and prompt prose still do not count as capability proof: activation depends on the generated-schema/readback gate and the authorized live matrix.

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

### 1a. Local Release Selection And Paired Rollback

Initial activation is an operator-owned offline release transaction, not a runtime selector and not service supervision. The transaction owns only release selection and the paired planner-data handoff. The running planner never edits release state, and the embedded runtime never gains an install, authentication, backup, or rollback tool.

- `$HOME/meal-planner/app` is the one selected application and remains a real canonical directory, not a symlink. `$HOME/meal-planner/releases` is a current-UID private staging/receipt root. The dedicated `agent` home, planner `data`, and ephemeral `run` root remain outside application-directory replacement. The updater-owned `$HOME/.local/bin/codex` target is never packaged, restored, or pinned by an app release.
- The private hash chain is `stage -> installed -> auth-lifecycle -> release-candidate -> qa -> activation -> current pointer`; `auth-lifecycle` is retained as a compatibility filename and chain label but now records only authentication readiness. Stage binds the exact source, lockfile, clean-install dependency graph, Node/npm, buildability, merge-suite, deployment-config, instruction, and content-addressed recovery-operator identities. Because current Vinext output contains build-root paths, the final `npm ci`, production build, and immutable installed manifest are created only after source is copied to canonical `$HOME/meal-planner/app`; no relocated staging build counts as installed proof.
- The first dynamic activation requires a verified compensation baseline. Because the accepted authority is already schema 4 and the landed family prerequisite understands only schema 1, a pre-commit first-install failure returns to the untouched external schema-4 authority with no installed pointer; after the first commit, safety is Codex fail-soft deactivation while retaining the compatible app/data. Exact prior-pair rollback begins with later installed releases. The family commit remains audited prerequisite evidence, not a falsely runnable schema-4 fallback. The exact first-install prerequisite commit is release-managed by `deployment/release/first-install-baseline.json`; stage rejects a caller-selected substitute. One explicit pre-activation planner database remains mandatory. The release owner holds one SQLite write reservation, derives rollback and candidate data from the same verified `VACUUM INTO` snapshot, and never silently chooses a checkout database, creates/seeds a different authority, or invents a synthetic activation/down-migration. Stage records an explicitly selected uninitialized store, but activation requires the separate `--confirm-uninitialized-authority` decision, persisted before release effects and reused by handoff/recovery. The flag is rejected for initialized stores.
- The authority process itself holds one current-UID private runtime/release lease for its entire SQLite lifetime. First cutover also proves the legacy family runtime and its known listeners are stopped, then retains the source-database write reservation through the sole commit or verified rollback because the legacy runtime does not know the new lease. With writers stopped, app, data, and release-managed config/instructions are selected as one journaled compensation set. The public production port and canonical Global UDS remain unexposed during private QA.
- Every filesystem effect has durable intent and completion records with exact pre/post identities. Recovery replays only an exact pre-state, accepts only an exact post-state, or blocks as intervention-required. Immutable previous-activation and rollback receipts plus an atomic `current.json` replacement re-select the previous release before `rolled_back`; no crash path may leave a mixed app/data/config pair or fall back inside the running process.
- Atomic replacement of `current.json`, referencing a fully synced activation receipt and operator identity, is the only activation commit point. Automatic later data restore requires a fresh closed whole-store snapshot SHA-256 to equal the activation snapshot; otherwise exact data-loss authorization is required and the newer data directory is parked and retained before restoration.
- Installed startup supports both the foreground diagnostic supervisor and a generated current-user LaunchAgent. The LaunchAgent is rebound to the selected immutable operator and evidence-bound Node executable, starts at login, uses `KeepAlive`, and verifies health plus workspace readback. Reboot survival still requires live host proof; Tailscale and remote reachability remain separate deployment gates.

Authentication readiness is separate evidence inside this transaction. Production restores or reuses the already authenticated `$HOME/meal-planner/agent`, preserves the real OS `HOME` for standalone `$HOME/.agents/skills` discovery, and excludes normal-`~/.codex` config/plugin/MCP/auth/session sources from effective readback. Its readback operator starts exactly one fresh identity-bound updater-managed `codex app-server` with the dedicated `CODEX_HOME` and cwd fixed at `$HOME/meal-planner/app`, opts out of every declared server notification and rejects any notification that still arrives, then requires `account/read({refreshToken:true})` to return the expected non-null ChatGPT account before the planner capability smoke. That one-process count is scoped to the authentication-readback operator; separate inactive compatibility/provenance probes and the planner capability smoke use their own bounded processes. Immediately before spawn and readback, the execution provider revalidates updater identity plus deployment provenance and executes only the private content-addressed snapshot; drift suppresses the readiness artifact, and recovery must evaluate the then-current target again. This one-attempt binding is not a version pin. The compatibility-named `auth-lifecycle.json` records only bounded identities and outcomes; it never inventories or fingerprints mutable normal-Codex state and never records email, device code/URL, raw responses, tokens, credential content, or credential-derived hashes/fingerprints. Effective config/instruction/capability readback proves that normal-`~/.codex` sources were not inherited. Activation never invokes login, logout, or login cancellation; copies credentials; or pins Codex. The earlier two-login/logout sequence is historical one-time credential-lifecycle feasibility evidence only and is not an active release, activation, recovery, or rollback gate.

### 2. Authentication And Runtime State

- Store credentials in the dedicated home with `cli_auth_credentials_store = "file"` and `forced_login_method = "chatgpt"`.
- Credential provisioning is outside activation. Reuse the canonical authenticated dedicated home, or atomically restore a preserved whole-home copy; never copy `auth.json` or the normal `~/.codex` tree as part of activation. If no usable dedicated home exists, stop and provision it through a separate explicit operator workflow.
- The durable household transcript is the sole cross-turn conversation authority. Each internal Codex execution uses a disposable/ephemeral thread seeded from the frozen canonical household turn input. Codex rollouts, logs, and thread state are diagnostics only and are never resumed as hidden planner conversation state.
- Ephemeral does not mean fileless. Tested 0.142.5 creates state/log/goal/memory SQLite scaffolding, and its bounded trace log can contain prompt/tool/search material even when no thread/rollout row persists. Each thread/process partition is continuously capped at 1,000 rows/about 10 MiB; startup maintenance deletes rows older than ten days, so age may exceed ten days between restarts. Keep the dedicated home `0700`, exclude it from planner backups and application-log ingestion, document the active build's observed behavior, re-inventory it after Codex updates, and never describe it as an erasure boundary.
- Missing or expired credentials, refresh failure, app-server exit, or malformed runtime state can make the assistant unavailable without changing planner readiness or corrupting product state.

### 3. Research And Planning Contexts

For a planner request that needs the web, use two isolated Codex contexts inside one durable household chat turn:

1. **Research context:** live hosted web search is available; planner mutation tools are absent. It returns a bounded structured candidate with one informational primary-page source reference. No separately carried or unrestricted page/search artifact persists in planner state, application logs, or shared transcript, though research material may appear temporarily in the isolated Codex runtime's bounded local log store.
2. **Planner context:** planner dynamic tools are available; web search and separately carried page/search artifacts are absent. It receives the frozen user request, canonical planner/transcript context, and only the bounded sourced-candidate fields, whose strings may be source-derived or verbatim, then may perform dependent reads, validations, and mutations.

A request that does not need research starts directly in the planner context. This separation prevents page content from directly invoking planner tools, but it does not prove prompt-injection immunity, authorship, extraction fidelity, or semantic equivalence after adaptation. The accepted residual risk is that hostile source data can still influence candidate content. Host schemas, size limits, the informational source reference, the planner capability manifest, and foreground user initiation bound the impact.

The cross-context candidate is strict `additionalProperties:false` JSON capped at 32 KiB: schema version; host-materialized candidate ID; web source identity, HTTP(S) URL, and host retrieval time; a bounded title/yield; and 1–32 steps with 0–12 bounded ingredient amount/name pairs per step, no more than 128 pairs across the whole candidate, instruction, and optional duration. The aggregate bound matches the existing canonical `Meal.ingredients` ceiling and does not widen ordinary create/update inputs. The exact size is `Buffer.byteLength(JSON.stringify(candidate), "utf8")` after every host field is materialized and the complete object validates. Amount and ingredient use one shared non-empty, single-line validator: each value must already equal its trimmed form and remain within its field limit. No search/page artifact or separately carried HTML, Markdown, page-body, excerpt, metadata, or attachment field crosses into planning. Candidate strings remain untrusted and may be source-derived or verbatim within their limits; the host does not claim to detect semantic multi-page blending or textual origin. Before acceptance the transcript stores only candidate ID/title, compact source, and step count.

Accepted intake uses one caller-neutral typed command and no candidate lookup authority:

`{type:"replaceMealRecipeFromSource",weekId,mealId,recipe:{title,yieldText?,source:{kind:"web",identity,url,retrievedAt},steps:[{inputs:[{amount,ingredient}],instruction,timerDurationSeconds?}]}}`.

The command is self-contained and omits `candidateId`. The source URL must equal the standard `URL` serialization of an `http:` or `https:` URL no longer than 2,048 characters, with no credentials or fragment; `retrievedAt` is an integer Unix epoch millisecond. `SourceRecipe` is an informational source reference, not an attestation: it records the primary page declared as the starting recipe. Research instructions require one primary starting page, but compliance is an accepted semantic residual rather than a deterministic validation result. For embedded intake, the host parses the URL, requires the supplied string to equal standard `URL` serialization byte-for-byte, then freezes the complete source tuple; it does not normalize a non-canonical input into acceptance. The host materializes `retrievedAt` and requires exact tuple equality on both `preview` and `apply`; lost full-candidate memory makes either call inadmissible. The planner may change only title, yield, step inputs, instruction, and timer duration under the foreground request. It cannot change or omit the frozen source tuple or write any other meal field through this command. The host enforces that structural boundary but does not claim semantic derivation. A normal global or household caller may submit the same strict command directly and supplies a validated but unattested observation time. Source reference content never supplies actor/admission provenance.

Canonical state remains the existing flat meal-local snapshot rather than gaining a second nested recipe authority. `Meal` adds optional `yieldText` and optional `sourceRecipe:{kind:"web",identity,url,retrievedAt}`. `replaceMealRecipeFromSource` is the only command that may attach or change `sourceRecipe`; `MealPlanInput`, `updateMealSnapshot`, and every other command schema exclude that field, and ordinary recipe edits preserve an existing source reference. `MealPlanInput` must explicitly exclude `sourceRecipe` rather than inheriting it through `Omit<Meal,...>`. Generic `updateMealSnapshot` requires `yieldText:string|null`, where `null` clears it; replacement omission also clears yield. Replacement writes title, clear-or-set yield, an ordered instruction list with IDs generated by the shared mutation service, the source reference, and `ingredients` as the ordered flattening of every accepted step input exactly as `"<amount> <ingredient>"` after the shared validator. It does not deduplicate quantity lines. New steps start incomplete, have no note or running timer, and retain only an optional bounded timer duration. It preserves meal ID, date, slot, status, subtitle, venue, protein, prep note, leftover note, and meal notes.

The shared command did not widen the bounded family-release adapter. In the unreleased follow-up candidate it is available only through the shared household/global contracts and the mediated sourced-recipe path; the legacy reply-plus-command schema and producer no longer exist.

The target week must be planned or active and the target meal must currently be `planned` or `moved`. Replacement rejects rather than silently discard any completed step, instruction note, running timer, or prep reference to an existing step. Replacement eligibility is evaluated against the canonical pre-batch target state: an ordered batch cannot clear protected execution state and replace the recipe atomically. Cleanup requires a separately committed, explicitly represented operation; replacement then uses refreshed authoritative state and version in a later apply. Those guards concern instruction-owned execution state; meal/prep/leftover note strings are preserved. Missing/archived targets and malformed/non-canonical HTTP(S) sources reject with no planner, event, or version effect; the ordinary immutable rejection receipt remains allowed.

Before planner execution, the durable household turn stores only `researchCandidate:{schemaVersion:1,candidateId,title,source:{kind,identity,url,retrievedAt},stepCount}` as part of shared chat/transcript readback. The full candidate remains turn-local memory and may occur in the private bounded Codex runtime log; it gets no table or durable authority row. If that memory is lost before acceptance, an explicit no-effect Retry performs research again. The accepted command/event and canonical meal store the bounded recipe adaptation and source; the external page is never canonical. This phase does not create a reusable recipe library. Reusable recipe records remain later work unless the planner gains a separately specified explicit promotion behavior.

### 4. Dynamic Tool And Chat Lifecycle Ownership

The host registers one `planner` dynamic-tool namespace containing exactly three functions generated from one deployment-owned command registry: bounded `read`, pure `preview`, and transactional `apply`. To stay below Codex 0.142.5's dynamic-tool compaction boundary, the `preview` and `apply` model-facing schemas expose the exact allowed command-type alternatives and their generated descriptions list each alternative's required top-level fields. Canonical nested field types, enums, limits, optionality, and extra-field rejection remain host-validator authority; malformed calls reject without planner, event, or version effects. The internal default-deny authority manifest is not a model-facing tool. Both accept 1–16 ordered operations, so one operation is the single-command case and several operations are one atomic batch. `read` covers normal reads and post-conflict refresh for workspace, week, meal, or a sanitized recent-history tail. The model never supplies actor, provenance, turn/token/call identity, or request ID. Every result is a versioned bounded envelope with current planner/sync versions, server time, typed data, or a sanitized error plus an explicit retry disposition. Field shapes and limits are fixed in the closed readiness record and enforced by the host.

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
- the shared transcript stores the user request, compact sourced candidate, sanitized tool outcomes, and terminal reply/failure—not credentials, model reasoning, or separately carried/unrestricted page-search artifacts.

One `planner_tool_calls` ledger keyed by `(turn_id, tool_call_id)` stores sequence, token/tool/argument identity, terminal status, bounded replay result, and optional operation/request/event/base/result-version linkage. Accepted mutation, receipt, event, tool outcome, effect sequence, and turn effect count commit together. `chat_turns` adds normal/recovery mode, completion-token hash, accepted-effect count/sequence, precise no-effect/after-effect terminal outcome, and recovery linkage. Startup abandons only pre-commit running calls; committed calls replay from the ledger.

This lifecycle extension belongs only to the follow-up. The current family phase keeps its simpler terminal reply plus at most one typed command, committed atomically as already planned.

### 4a. Live Submission Intent And Readiness

At cutover, browser chat submission gains one required closed `intent` union. `{kind:"planner",archiveContextWeek:boolean}` selects the planner-only context. `{kind:"sourced_recipe"}` selects the research-only context followed by the planner-only context and is structurally incapable of carrying archive authority. Missing, unknown, extra-key, or mixed intent shapes reject at the HTTP boundary; freeform text never selects research or expands authority.

The browser renders explicit per-send controls beside the chat composer and resets them only after an accepted submission. It never sends a generic foreground-grant array or a grant target. During the same transaction that accepts the request's base planner version and creates the durable turn, the host maps `archiveContextWeek:true` to exactly `{commandType:"archiveWeek",target:request.context.weekId}` and otherwise freezes an empty authority set. Retry inherits the already persisted authority and research kind; recovery after any accepted effect has empty authority and no research or planner tools. A future command marked `explicit_foreground` remains unavailable until this closed acquisition contract is deliberately extended.

After the legacy adapter is removed, `/api/health.codex` is the sole embedded-agent readiness signal. It contains the coarse readiness status plus dynamic-runtime state, dedicated-home authentication, and protocol compatibility. The transitional `codexFollowUp` field and legacy status probe are deleted in the same cutover. The browser continues to gate chat from `health.codex.status`; planner/store/browser read access and global UDS health remain independently derived.

Research and planner sessions acquire execution through one runtime-owned provider rather than retaining a captured binary forever. Before each child process the provider uses the currently compatible/authenticated execution. `IDENTITY_CHANGED` or `PROVENANCE_CHANGED` invalidates only the exact observed execution, moves readiness to checking, and joins one compatibility re-evaluation. A pre-process spawn may retry once with the newly accepted execution; no model call or planner effect is replayed, and a stale caller cannot invalidate newer evidence.

### 5. Planner Authority And Batch Semantics

The embedded planner capability manifest is deployment-owned, generated from the same registry/schema as the application API, and default-deny: a new domain command is unavailable until deliberately mapped, validated, attributed, and tested. Startup fails if a registered command lacks policy. The fixed limits are 32 tool calls per turn, 16 operations per `apply`, 64 KiB arguments, 128 KiB results, and 20 recent history events.

The initial manifest covers ordinary recipe/snapshot, meal scheduling and editing, prep, grocery, leftover, note, feedback, timer, and week-lifecycle actions already owned by the planner domain. Archive may be used only for an explicit foreground user request and must satisfy the same target/version guards as the UI. Latest-only undo remains the existing guarded UI/application recovery service: an accepted agent batch is one undoable event, but undo itself is not a model-visible planner command or batch operation. Seed reset, legacy import, arbitrary restore, backup/admin operations, development controls, and actor assignment are never exposed as agent tools.

One batch call carries one base planner version and a non-empty ordered list of typed commands. The host validates the whole envelope, reduces commands sequentially against an in-memory candidate, validates the final aggregate, and writes all-or-nothing in one transaction. One accepted batch produces one idempotency receipt, one planner-version increment, one event/change set, and one undo unit. A version conflict or indexed command rejection reserves the well-formed request's immutable decision receipt but commits no workspace, event, version, or undo effect; schema-invalid input reserves nothing. One-operation events retain the existing public command/summary/target/change shape, while a multi-operation event uses the locked `plannerBatch` envelope and aggregation in the readiness record. The result includes complete canonical readback and every new event includes host-assigned structured provenance.

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

Production follows the updater-managed current Codex. At every process start, canonicalize the trusted launcher target, read its version/hash, generate the experimental JSON schema into the dedicated runtime cache, and compare the required protocol subset and capability fingerprint with the last accepted result. A new target/version/schema automatically runs the disposable no-auth positive/negative compatibility gate before embedded-agent readiness. Compatible updates are accepted without an app configuration change or version allowlist. A breaking update disables only the embedded Codex runtime adapter, leaves planner/store/transcript and the independent global UDS ingress available, and waits for an embedded-adapter update; it does not silently roll back Codex or weaken the boundary.

The disposable no-auth installed-binary spike closed the planning unknowns:

- normal `HOME` plus a fresh dedicated `CODEX_HOME` enumerated the expected standalone `$HOME/.agents/skills` while config readback contained only the dedicated config and a schema-required empty system layer whose named file was absent, not normal `~/.codex`;
- live research exposed exactly `[update_plan, web_search]`, with external hosted-search access and no planner namespace or either known index-gate field;
- every planner request exposed exactly `[update_plan, planner]`, with no hosted search;
- shell/exec/patch, general filesystem/image, MCP, apps/plugins, browser/computer, and multi-agent tool classes were absent;
- one ephemeral turn completed call A, consumed its host-returned ID in dependent call B, and then completed normally; and
- the tested runtime rejects an invalid deferred dynamic-tool registration before a model request.

`update_plan` is unconditionally present in the tested build. It emits a planner-inert `PlanUpdate` event with no planner/filesystem/network effect, though its content may enter the private runtime log store. It is explicitly allowed in both contexts; the architecture does not pretend each context has literally one tool. Every new Codex build must reproduce that harmless classification or fail compatibility. App-server still implements dangerous client-callable RPC methods, so the host's inbound/outbound method allowlists remain a separate mandatory boundary.

The no-auth spike did not test refresh/readback from an existing file-backed ChatGPT credential, a real model choosing the calls, or real live-search content. Those are opt-in runtime acceptance cells after implementation, not decisions that change the plan. Config/readback remains supporting evidence; deterministic forbidden-operation, sentinel, failure, and live authenticated probes are still required before activation. If the current build fails those later cells, stop agent activation rather than weakening the boundary.

The currently used family release remains unchanged while the complete replacement is built and tested in this unreleased worktree. Inside the candidate there is already exactly one embedded path—the managed dynamic service—and the old terminal-command bridge is absent. Initial activation is therefore a whole-release replacement after the live gates, not an in-process flag flip or a period with two mutation paths.

Initial activation is bound to the live release-candidate evidence, not merely to a compatible runtime class. The unreleased candidate contains the final public HTTP/composition and legacy deletion so authenticated proof exercises the exact path that will run. Its secret-free artifact records canonical executable path/version/hash/schema fingerprint, config/instruction provenance hashes and effective isolation readback, authenticated account kind, observed tool and negative-capability evidence, bounded dedicated-home retention counts, and a complete candidate-source manifest. It does not snapshot mutable normal-Codex state. Immediately before replacing the currently used release, `npm run verify:codex-activation -- --artifact <path>` rechecks the same accepted readiness coordinates and recomputes the whole source manifest; it does not log in, log out, cancel authentication, copy credentials, pin Codex, or deploy. Mismatch or any source edit reruns the live gate or stops activation. After that one-time cutover binding succeeds, updater-managed compatible changes follow the normal dynamic compatibility gate without becoming a permanent version pin.

## Delivery Sequence

Phase-planning decomposed this follow-up into six shippable units in four delivery waves. Eric approved this cut after independent intent, architecture/scope, and proof/operator challenge. Runtime isolation and ordered planner authority land in parallel; embedded execution and global ingress then fan out from their actual prerequisites; research follows embedded execution; authenticated cutover closes the release.

1. **Updater-safe inactive runtime foundation.** Make the updater-managed current Codex reproducibly compatible or embedded-only unavailable without activating planner mutation.
2. **Shared atomic ordered-operation authority.** Give every supported caller the same one-to-sixteen-operation atomic planner semantics without depending on Codex runtime behavior.
3. **Crash-safe three-tool embedded execution.** Join the two foundations into an inactive `read`/`preview`/`apply` path with durable dependent effects and recovery-only post-effect Retry.
4. **Independent global planner ingress.** Expose the same planner authority through the fixed same-UID Unix-socket client independently of embedded readiness.
5. **Mediated sourced-recipe intake.** Add the disjoint research/planning contexts and existing-meal informational primary-page source-reference replacement against the inactive path.
6. **Authenticated activation and single-path cutover.** The complete unreleased candidate now has the final intent/health contract, managed production composition, browser surface, operator probe, and legacy deletion. It must still pass the authorized live acceptance contract and exact activation-coordinate recheck before it replaces the currently used release.

Phases 1 and 2 are Wave 1 and may proceed in parallel. Phases 3 and 4 are Wave 2 and may proceed as soon as their stated prerequisites land. Phase 5 is Wave 3. Phase 6 is Wave 4.

Implementation status is deliberately narrower than activation status:

- Waves 1–3 have deterministic contract, store, subprocess-fixture, and architecture proof.
- Wave 4 has the full single-path source candidate, closed public intent, canonical health projection, managed updater reacquisition, source/recovery UI, exact-path authenticated smoke entrypoint, complete private RC artifact contract, and read-only activation verifier.
- Historical pre-stage proof includes the whole-tree gate, current-binary no-auth readback, real HTTP and UDS composition, multi-ingress concurrency, restart, six source Playwright journeys, and exact installed-path QA. Those runs are useful regression evidence but never substitute for the release transaction's exact-current-tree artifacts.
- The auth executable-binding remediation has focused unit, architecture, real-process updater-swap, and release-composition proof. The single readiness app-server executes only a private snapshot of the accepted identity; a target or provenance change before spawn or readback aborts the effect and publishes no readiness artifact.
- Each release must independently reproduce typecheck/build/lint, deterministic tests, source browser proof, installed-path QA, current-binary readback, restored-or-reused dedicated-home account readback, authenticated capability/search/planner evidence, activation-coordinate verification, atomic pointer publication, and post-activation observation.
- Immutable release artifacts and `current.json`, not status prose or a green command from an older tree, are the authority for which of those release gates actually passed.

## Proof Contract

| Contract | Required proof |
|---|---|
| Runtime isolation | Launch from the app directory, its parent, and an unrelated cwd; the server-owned updater path resolves to the same current target/version/hash within a run, while dedicated home, app cwd, child-env allowlist, effective config/instruction sources, and filesystem modes remain fixed; sentinel host/application secrets are absent |
| Local release transaction | A stage/installed/auth/RC/QA/activation hash chain proves exact source/install/build/config/operator identities. Real private directories and SQLite files exercise authority-held ownership, legacy drain, one-base `VACUUM INTO` capture, canonical-path build, app/data/config selection, intent/completed recovery, sole `current.json` commit, paired rollback pointer publication, newer-data retention, and refusal of an unproved data restore. No symlink selector, runtime fallback, or packaged/pinned Codex binary is used. |
| Update compatibility | Swapping the trusted launcher to a compatible newer fixture reruns schema/capability validation and restores embedded-agent readiness automatically; an incompatible schema/tool fixture leaves planner/store and global UDS ingress ready, marks only the embedded runtime adapter incompatible, and never falls back to an older binary or prompt-only enforcement |
| Authentication separation | Real OS `HOME` preserves standalone skill discovery while the final dedicated `CODEX_HOME` excludes normal-`~/.codex` sources. A restored or reused authenticated dedicated home supplies one fresh updater-managed authentication-readback app-server at the fixed app cwd; proactive `account/read({refreshToken:true})` and the separately bounded planner capability smoke succeed, effective readback contains no inherited normal-`~/.codex` surface, and activation performs no login, logout, cancellation, credential copy, Codex pin, or normal-home inventory/fingerprint. |
| Skill and config provenance | Real skills/instruction/config readback shows intended `$HOME/.agents/skills` plus deployment-owned planner sources, no capability-bearing project config, no inherited normal Codex plugin/MCP/config/auth/session surface, disabled model-visible skill namespace, and only allowlisted/integrity-recorded skill bodies preloaded by the host |
| Capability enforcement | Captured arrays are exactly `[update_plan, web_search]` for live research and `[update_plan, planner]` for planning; hosted search has external access and omits both known index-gate request fields; the shipped `planner` namespace contains exactly `read`, `preview`, and `apply`, with every allowed command-type alternative in the latter two schemas and the exact required top-level fields in their generated descriptions; canonical nested values remain host-validated; effective capability evidence and adversarial calls show forbidden shell/exec, general-purpose filesystem read/write, database read/write, browser/computer, app, MCP, multi-agent, and general-purpose network actions outside the authorized hosted-search tool cannot execute |
| Dynamic protocol | Fake and real app-server turns exercise registered dependent calls, bounded arguments/results, unknown tools, duplicate IDs, changed-payload reuse, cancellation, timeout, late tokens, and host request-method allowlists |
| Per-call transaction parity | UI, embedded-agent, and global-agent calls converge on the same mutation service and produce equivalent domain outcomes, conflicts, idempotent replay, actor provenance, events, receipts, and readback; static ownership checks reject a second mutation kernel |
| Atomic batch | Ordered multi-command success produces one version/event/receipt/undo unit; mid-batch rejection, conflict, failpoints, replay, and restart produce no partial batch |
| Dependent effects | One turn performs at least two dependent successful mutations using authoritative IDs/readback; every effect is separately durable, attributed, versioned, idempotent, and visible to another client |
| Turn/effect failure | Deterministic process exits before/after tool receipt, mutation commit, tool response, and terminal reply prove accepted effects persist, late calls are fenced, and “effects applied; reply failed” is visible. After a create-like effect commits and the reply is lost, recovery-only Retry has no mutation tools and leaves effect/event/receipt counts exactly one |
| Research mediation | A hostile-page fixture and opt-in live search prove the research context has no planner tools, transfer contains only bounded candidate fields with one informational primary-page reference, malformed or excessive candidates fail, and the planner context has no web tool or separately carried page/search artifact. Deterministic proof covers forbidden artifact/field exclusion, exact embedded source-tuple rejection on both preview and apply, lost-candidate rejection, no `sourceRecipe` ingress through create/update commands, exact field mapping and non-recipe-field preservation, all four protected-state classes, the pre-batch cleanup prohibition, and no planner/event/version effect on rejection. Separately carried/unrestricted page-search artifacts are absent from planner state/shared transcript/application logs; dedicated Codex runtime logs remain private, bounded, and explicitly inventoried. Fixtures prove structural binding and persistence, not textual origin, semantic single-source derivation, or web-content truth. |
| Race handling | Two UI clients plus embedded/global agents contend from one planner version; accepted writes are preserved, conflicts refresh authoritatively, and no stale terminal success claim remains |
| Global-agent admission | The thin client package has no database path, driver, or database-specific operation; browser JavaScript cannot use its ingress or choose its actor; a normal Codex-driven call is attributed by the server and a second browser observes canonical readback |
| Availability | Missing/malformed home, expired auth, app-server exit, failed research, tool failure, and restart leave planner/store/transcript readable and embedded-agent status visibly unavailable or recoverable |
| Atomic cutover | Architecture/static checks and runtime route inventory prove exactly one live Codex mutation path before and after activation; the old bounded adapter cannot be invoked after cutover |

## Acceptance Criteria

- The current family-readiness completion contract has landed before follow-up activation.
- The embedded app-server always uses the canonical target of the server-owned updater-managed Codex path, dedicated Codex home, fixed app cwd, minimal child environment, and deployment-owned instruction/capability manifest.
- The selected application is installed through the private journaled release transaction. Its complete installed payload reproduces the RC-bound source/install/build receipt; initial data selection is explicit; app and SQLite rollback remain paired; and no pending candidate is exposed to household/global writers before installed verification and post-selection QA commit.
- Every changed Codex target/version/schema reruns the compatibility gate; compatible updates activate automatically, while incompatible updates disable only embedded-agent readiness with no silent rollback or fallback and no effect on independent global UDS ingress.
- The restored or reused file-backed ChatGPT credential succeeds through proactive `account/read({refreshToken:true})` on one fresh updater-managed authentication-readback app-server; effective readback excludes normal `~/.codex`, the gate does not inventory or fingerprint that mutable state, and activation neither provisions nor copies credentials.
- The capability gate reproduces the exact allowed arrays—ambient `update_plan` plus live hosted search or a planner namespace containing only `read`, `preview`, and `apply`—and the required negative boundary; prompt prose and read-only sandboxing are not accepted as proof.
- A foreground household request can use web research through the isolated research context, preserve a bounded informational primary-page source reference, then perform several dependent planner calls with authoritative readback.
- Every accepted single command or batch uses the shared planner mutation service. Multiple accepted calls in one turn remain individually atomic, idempotent, attributed, and visible even if the reply later fails.
- Retry after any accepted effect is reply/readback recovery only; remaining changes require a new foreground user turn.
- A normal global Codex session can inject an equivalent sourced recipe or planner batch through the local client and receives the same validation/conflict semantics; the supported client performs no database operation.
- Planner and durable transcript operation remain available when Codex is unavailable.
- Final activation removes the old bounded adapter; no mixed or fallback authority path ships.

## Readiness Resolution And Remaining Acceptance

There are no implementation-shaping open questions. `docs/codex-agent-runtime-follow-up-unknowns.md` records the tested proof artifact, dynamic-update policy, config and tool manifests, dynamic-call protocol, the three planner tools, field limits, operation/batch service, durable effect ledger, research candidate, live intent/readiness projection, and Unix-socket client contract.

The remaining acceptance observations require the implemented live boundary and do not select a different architecture:

- restored-or-reused dedicated-home ChatGPT account refresh/readback from one fresh updater-managed authentication-readback app-server, without auth-mutation requests or inherited normal-`~/.codex` sources;
- real live search and real-model dependent-call behavior under the captured tool manifests;
- production instruction/skill/config readback and forbidden-operation/sentinel results;
- the authenticated ChatGPT workspace/search operational-retention disclosure beyond local Codex behavior; and
- exact public HTTP, Unix-socket, multi-ingress, restart, and browser/device evidence in an environment that permits real listeners;
- the authorized failure-after-effect/recovery and activation-coordinate artifact from the current updater-managed runtime; and
- the staged/installed payload receipt, paired app/database rollback matrix, and explicit migration of the chosen family database into the installed data authority; and
- post-selection and post-activation reruns against the identical evidence-bound candidate before household exposure.

Failure of any acceptance cell stops activation and may force a new architecture decision; it does not pull speculative alternatives into this plan. Chrome/profile/site allowlists, remote deployment, stronger-than-same-UID caller identity, and autonomous/background work remain explicitly later.

## Explicitly Deferred Beyond This Phase

- Chrome plugin or extension access, tab-group confinement, site allowlists, and browser-profile decisions.
- Tailscale Serve, service supervision, TLS, Tailnet ACLs, and remote-device deployment proof.
- Per-person accounts, private transcripts, permissions, or attribution beyond household/UI/embedded-Codex/global-Codex actors.
- Notifications, background browser work, automatic meal generation, and autonomous unattended changes.
- A general-purpose public MCP or remote automation API.

## Challenge Disposition

Independent intent, architecture/ownership/proof, simplicity, and architecture-coherence stances challenged the draft against the delegated decisions and historical bridge; Phase 6 received a separate challenge-to-convergence pass before implementation.

Accepted revisions:

- made the mid-turn tool-effect lifecycle explicit instead of pretending it shared the current terminal-command atomic boundary;
- added deterministic call fencing, effect audit/readback, failure-after-effect behavior, batch semantics, environment/RPC allowlists, instruction/skill provenance, global-client admission, and a real capability gate;
- made retry after an accepted effect recovery-only so completion-token rotation cannot admit a duplicate semantic mutation;
- replaced ambiguous durable “staging” with pure preview;
- separated the web-search/page-artifact context from planner tools and bounded the RecipeSnapshot informational source reference;
- made the live cutover atomic and kept all follow-up runtime work out of current family signoff.

Rebutted or narrowed challenges:

- The simplicity proposal to allow at most one successful mutation per turn was rejected because the settled product contract requires several dependent calls, including later changes that may need authoritative IDs/readback from an earlier commit. One batch is preferred when the whole change is known; multiple separately atomic effects remain supported.
- A mandatory human confirmation step for every web-derived write was not added because it would narrow the settled broad foreground planner authority. Instead, research and planning contexts are separated and the remaining semantic-influence risk is stated rather than misrepresented as eliminated.
- Batch tools, dynamic-call lifecycle storage, and runtime isolation were not pulled into family-readiness signoff. They now consume the shared service in the separate follow-up candidate.

Second pass: the intent, architecture/ownership/proof, and architecture-coherence stances signed off after the multiple-dependent-effect contract, recovery-only post-effect retry, general-purpose filesystem/database denial, current-user intent boundary, latest-only undo wording, and same-UID global-client trust were made explicit. No challenge blocker remains.

No architecture question remains that should block the current family-readiness implementation or later follow-up planning. The live acceptance cells may still block follow-up activation, and that is the intentional fail-closed stop condition.

## Implementation And Activation Entry Point

This document, `docs/codex-agent-runtime-follow-up-unknowns.md`, and the tracked contracts/tests are the durable implementation record. Historical per-wave plans remain only in parent-workspace scratch and are not shipped release inputs. Source construction may proceed independently of authentication because it consumes the authoritative planner API and durable lifecycle rather than changing their family-readiness contract. Initial activation may proceed only with restored or reused dedicated credentials, one fresh updater-managed authentication-readback app-server, the frozen `npm run smoke:live-chat -- --authorized --scenario all --output <new-path>` workflow, the separate Global UDS/browser matrix, and a green `npm run verify:codex-activation -- --artifact <same-path>` result against the unchanged source candidate and immediately re-read executable/schema/config/instruction/account coordinates. Credential provisioning remains separate explicit operator work; never weaken a boundary or pin a Codex release to manufacture a pass.
