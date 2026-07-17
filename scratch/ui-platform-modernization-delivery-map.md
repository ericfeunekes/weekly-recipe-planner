# UI Platform Modernization — Delivery Map

## Source requirement

`docs/functional-spine.md` now defines a prep-free Week overview, a cooking-ticket
Tonight / Day view, and a visually rebuilt but semantically native Codex rail.
`docs/TESTING.md` remains the proof authority. The user chose an incremental
Tailwind/shadcn migration rather than a second bespoke CSS system or a generic
chat replacement.

## Whole-design constraints

- Planner state and planner mutations remain owned by the existing typed
  planner authority. No browser-local authority or parallel mutation route is
  introduced.
- Prep remains its own canonical-instruction workspace. Week exposes no Prep
  indicator, count, pressure summary, or shortcut at any viewport.
- Codex remains the authority for history, items, turns, worker topology,
  questions, approvals, and interruption. The app remains a thin projection.
- The visual system is migrated incrementally: a surface is moved only when
  its responsive, accessibility, and runtime behavior have current proof.

## Forces register

| Force | Status | Evidence | Resolution |
| --- | --- | --- | --- |
| State and lifecycle | present | A household starts cooking, completes canonical steps, runs timers, and moves a meal through cooking and leftovers from both Day and Prep. | Preserve the documented planner lifecycle and prove shared step readback; no new visual state authority. |
| Persistence | present | The same planner data must survive restart and be readable from Week, Day, Prep, and Codex effects. | Keep the planner store and mutation service authoritative; visual work changes projections only. |
| Contracts and validation | present | Native Codex items, questions, approvals, and planner effects cross the rail boundary with strict safe projections. | Preserve the existing native runtime contract and its contract-test cells; primitives only own accessible presentation. |
| Internal typing | present | Meal, step, thread, turn, and worker identities must not be confused across redesigned controls. | Retain established typed client contracts; do not introduce generic chat-message authority. |
| Concurrency | present | More than one household client can change planner data while a selected Codex thread streams effects. | Preserve existing OCC, reread, and selected-thread revision behavior; prove the client/runtime boundaries. |
| Caching | absent | Week and Day must show authoritative planner readback rather than a newly stale visual cache. | Do not add a UI cache layer. |
| Failure and resilience | present | Offline/read-only conditions and interrupted Codex turns must remain explicit during the redesign. | Preserve existing retry/interruption behavior and cover it in client/runtime proof. |
| Protocols and boundaries | present | The UI projects both planner HTTP state and native Codex app-server state. | Maintain the existing transport/source boundary; no ChatKit bridge or replacement protocol. |

## Dependency graph

**Phase A — trustworthy shared visual foundation** has no predecessor. It
establishes the token and accessible-control vocabulary consumed by every later
surface without changing planner or Codex authority.

**Phase B — prep-free Week agenda** and **Phase D — native Codex rail
presentation** depend on Phase A’s stable visual vocabulary. **Phase C — Day
cooking ticket** depends on the Week-selected-day route established in Phase B.
Their behavior contracts are separate and can be reviewed independently; this
execution will run them serially so each has a visible browser proof cycle in
the shared working tree.

**Phase E — shared-control convergence and CSS retirement** depends on the
surfaces it retires. It removes only styling made redundant by the proven prior
phases and closes with whole-app proof.

Every phase runs the same micro-cycle before the next one begins: scoped build,
targeted automated/runtime proof, browser evidence at phone/tablet/desktop as
applicable, independent implementation review, and remediation plus re-proof
when review finds a blocker. The current evidence and review disposition are
recorded in that phase’s implementation plan rather than inferred from a prior
phase.

## User-owned decisions already settled

- The Week surface is the weak view: remove Prep from it entirely, not from the
  product.
- Day uses a service-ticket / cooking-document treatment; Week uses the mobile
  agenda direction already discussed. The active cooking marker is restrained,
  not a dominant red rail.
- Tailwind and shadcn-style primitives reduce hand-rolled CSS and accessibility
  burden. The Codex rail keeps native product semantics rather than adopting a
  generic chat system.
- Delivery is one goal made of build → proof → review micro-cycles, not a single
  unreviewed rewrite.

## Phase map

| Phase | Stakeholder-recognizable outcome | Depends on | Proof gate cells |
| --- | --- | --- | --- |
| A | Household operators have a coherent accessible Tailwind + initialized shadcn primitive foundation, semantic tokens, and small local adapters that every later surface consumes. | — | Merge: client/accessibility tests exercise the token and adapter vocabulary independently of Week, Day, or rail behavior, plus a design-system inventory; RC: dev/start health; QA: responsive primitive fixture check. |
| B | A household can scan and open the week as a prep-free dinner agenda on phone, tablet, and desktop, and select a day through the existing execution route. | A | Merge: client and architecture-closure tests explicitly prove no Prep indicator, count, pressure summary, or shortcut in the Week surface at D4 and D7 viewports; RC: representative dinner journey; QA: responsive visual comparison against the agreed paper/celery/teal/saffron direction. |
| C | A cook can enter the selected day from Week and run its meal from a compact day ticket while canonical step, timer, and leftovers state remains shared with Prep. | B | Merge: domain/client contracts cover both time-driven Tonight and Week-selected non-today Day entry; RC: dinner journey and two-client recovery; QA: cooking flow at target viewports, with red limited to a quiet active-state accent. |
| D | A household can use the rebuilt desktop rail and mobile drawer without losing native history/select/new, one composer, items, task history, worker drill-down, listed questions, non-actionable approval presentation, interruption, or planner-effect readback. | A | Merge: Codex wrapper/effect-bridge, rail interaction, no-generic-chat-affordance, and accessibility contracts; RC: native smoke; QA: authenticated native Codex observation. |
| E | Shared controls are consistent, duplicate control patterns are audited, and only proven-redundant legacy CSS is retired. | B, C, D | Merge: baseline and architecture closure; RC: full responsive paths; QA: cross-viewport visual regression sweep. |

## Risks and stop rule

Do not bulk-delete legacy CSS, replace Codex source/transport modules, or alter
the Prep domain in this delivery. Stop and ask only if a proof failure reveals
a product-contract fork rather than a local repair, or if the existing dirty
worktree makes a shared-file merge unsafe.

## Challenge disposition

Two independent challenge stances reviewed this map after it was drafted.

- **User-intent audit accepted:** the map now carries the user’s no-Prep-in-Week
  rule, Tailwind plus initialized shadcn foundation, component reuse, Week and
  Day visual direction, quieter red active state, native Codex semantics, and
  micro-cycle delivery. It also corrected an obsolete Week statement in the
  functional spine. A first revision had Week promise a Day ticket before that
  ticket phase; Phase B now establishes the selected-day route and Phase C owns
  the ticket.
- **Proof-boundary challenge accepted:** Phase A now has independent
  token/adapter proof; Phase B has explicit negative D4/D7 Week Prep proof;
  Phase C covers a selected non-today Day as well as Tonight; and Phase D names
  its native rail interaction and anti-generic-chat contracts. Both stances
  signed off after these revisions.

The remaining dirty worktree is an execution constraint, not a justification
to weaken proof or silently overwrite concurrent Prep/domain changes.
