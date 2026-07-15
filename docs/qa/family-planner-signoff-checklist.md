# Family Planner QA Signoff Checklist

**Status:** Test inventory complete after three independent review passes and two adversarial challenges; execution is tracked in `outputs/qa/2026-07-12-schema4-candidate/qa-report.md`

**Target:** Current schema-4/Codex candidate running from a frozen disposable local snapshot

**Production data:** Never used or mutated

**Signoff rule:** A green automated suite is supporting evidence, not a substitute for executing this checklist against the visible application.

The row-level statuses below remain the reusable signoff baseline; they are not a claim that every story ran in the 2026-07-12 candidate pass. The execution report identifies the exercised journeys, confirmed failures, automated coverage mapping, and residual gaps.

## Test Model

### Household roles

| Role | Primary concern |
| --- | --- |
| Planner | Builds and changes the week, recipes, groceries, and future plan |
| Prep cook | Executes advance steps in a time-ordered list, including timers and notes |
| Dinner cook | Opens Tonight, sees completed prep, and finishes the meal |
| Family member | Reads and updates the same plan or transcript from another device |
| Household operator | Recovers from offline, restart, conflicts, and interrupted ChatGPT work |

### Canonical data profiles

| Profile | Description |
| --- | --- |
| D0 | Uninitialized database, no legacy browser snapshot |
| D1 | Uninitialized database with a valid `weekly-recipe-planner:v2` browser snapshot |
| D2 | Seeded active week with meals, prep, groceries, leftovers, and empty slots |
| D3 | D2 plus a planned future week and an archived prior week |
| D4 | Overflow fixture with seven dense dinners, all eight prep dates, all grocery sections, many leftovers/events/transcript entries, maximum valid values, and one unbroken URL/token |
| D5 | D2 opened by two independent browser contexts |
| D6 | D2 with deterministic ChatGPT ready, busy, unavailable, incompatible, and interrupted states |
| D7 | Initialized workspace with zero weeks |
| D8 | Current-night assigned leftovers plus all meal status tones |
| D9 | Populated schema-v1, v2, and v3 databases with events, undo state, transcript, and running/interrupted turns |
| D10 | Scale fixture with 52 weeks, near-limit entities, 500 events, and 100 chat turns |
| D11 | Disposable installed layout under a temporary `HOME`, with exact previous/candidate app-data-config pairs and release receipts |
| D12 | Recovery fixture where `planner.sqlite` is unavailable and only a canonical export remains |

### Result and evidence

Use `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`, or `NOT APPLICABLE`. Every failure needs a screenshot or recording plus reproduction steps. Every pass used for signoff needs a screenshot, trace, API readback, or network/log reference. Evidence belongs under `outputs/qa/<run-id>/`. The execution manifest records `scenario_id`, data profile, frozen source identity, viewport, browser/version, result, screenshot, video/trace, geometry JSON, accessibility report, HAR/log, and notes.

## User Story Checklist

### Bootstrap And Durable State

| ID | Priority | User story and actions | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| BOOT-01 | P0 | On D0, open the app and choose Start Fresh. | One initialized shared workspace appears; repeated clicks cannot create a second authority. | Before/after screenshot and workspace readback | NOT RUN |
| BOOT-02 | P0 | On D1, review the detected legacy plan and choose Import. | Meals, canonical step state, groceries, leftovers, and transcript import once; obsolete event history is not misrepresented. | Import screen, populated views, API counts | NOT RUN |
| BOOT-03 | P0 | Open D1 in two clients; race Import and Start Fresh, drop the Import winner's committed response, then reload both. Repeat with each action winning. | Exactly one initializes; the loser receives authoritative state; browser legacy data is removed only after confirmed import success and otherwise remains recoverable. | Two-client recording, local storage, and responses | NOT RUN |
| BOOT-04 | P0 | Present malformed/unsupported legacy data, exact 262,143/262,145-byte bodies, chunked bodies without `Content-Length`, and truncated JSON. | Bounded 4xx errors are actionable; Start Fresh remains available; no partial database is created; local legacy data survives 400/413 responses. | Error screenshot, byte/status log, and database readback | NOT RUN |
| BOOT-05 | P0 | Reload immediately after successful bootstrap and restart the authority. | The same workspace and version return without another setup prompt. | Reload/restart recording and readback | NOT RUN |
| BOOT-06 | P0 | Lose the bootstrap response after commit, reload before retry, then retry the exact original request ID and payload. | The same envelope resolves idempotently to the existing workspace without duplicate weeks/events or silent replacement by an equivalent new request. | Network failure trace, envelope, and counts | NOT RUN |
| BOOT-07 | P1 | Load while the authority is unavailable, then restore it. | A useful loading/error state appears and Retry reaches either setup or the initialized planner. | Loading/error/recovered screenshots | NOT RUN |
| BOOT-08 | P1 | Open an initialized workspace while stale legacy browser data still exists. | The app never offers to overwrite the initialized authority; stale local data is preserved only for recovery. | UI screenshot and local-state observation | NOT RUN |
| BOOT-09 | P0 | For each D9 database, terminate during backup, every migration transaction, legacy normalization, and final validation; reopen twice. | Store remains at the last complete schema or advances exactly once; verified backup is usable; undo state remains valid; `quick_check` is `ok`. | Source/backup hashes, migration rows, workspace/event counts | NOT RUN |

### Navigation And Week Lifecycle

| ID | Priority | User story and actions | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| NAV-01 | P0 | Navigate Week, Tonight, Prep, Groceries, and Close out on desktop. | Each control selects one view, updates `aria-current`, focuses the H1, and resets scroll to the top. | Recording and focus/scroll readback | NOT RUN |
| NAV-02 | P0 | Repeat NAV-01 with the fixed mobile navigation. | Every destination remains reachable without covered controls or content hidden behind the bar. | Phone recording | NOT RUN |
| NAV-03 | P1 | Resize phone to tablet and back while a view and draft are active. | The same view and draft survive; navigation and chat change form without duplicate UI. | Resize recording | NOT RUN |
| NAV-04 | P0 | Switch among active, planned, and archived weeks. | The selected week changes all views consistently; status is unmistakable; drafts do not leak across weeks. | Multi-week screenshots and field readback | NOT RUN |
| NAV-05 | P0 | Select an archived week and inspect every view and drawer. | Week-local planner controls are read-only and reject mutation, while the unrelated global transcript remains usable. | View/drawer/chat screenshots | NOT RUN |
| NAV-06 | P0 | Select a planned week and choose Make active while another week is active. | One atomic handoff archives the old week and activates the selected week. | Before/after API and history | NOT RUN |
| NAV-07 | P1 | Race week handoff from two clients. | One lifecycle wins, one client receives a version conflict and authoritative state, and at most one week is active. | Two-client trace and API readback | NOT RUN |
| NAV-08 | P1 | Select a week that does not contain today and open Tonight. | The empty-state explanation directs the user back to the correct week without rendering the wrong dinner. | Screenshot at all core viewports | NOT RUN |
| NAV-10 | P1 | Open and close Meal, History, and mobile ChatGPT surfaces by button, Escape, and backdrop where supported. | Focus enters the surface, remains trapped where modal, returns to the trigger/fallback, and body scroll is restored. | Keyboard recording and focus readback | NOT RUN |
| NAV-11 | P0 | Select a planned week when `activeWeekId` is null and choose Make active. | The planned week becomes the only active week without requiring a handoff source. | Before/after lifecycle readback | NOT RUN |
| NAV-12 | P0 | Open D7. | The user has a viable way to create the first week. The current "Ask ChatGPT" copy with no rendered chat is a blocking dead end unless the state is made unreachable. | Screenshot and reachability proof | NOT RUN |

### Week, Meal, And Recipe Editing

| ID | Priority | User story and actions | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| WEEK-01 | P0 | Open D2 Week view. | Seven Monday-Sunday dinner columns render with correct dates, today marker, statuses, leftovers, and open slots. | Desktop/tablet/phone screenshots | NOT RUN |
| WEEK-02 | P0 | Open each populated meal card. | The correct meal drawer opens with matching title, recipe, steps, status, source, and date. | Drawer screenshots and IDs | NOT RUN |
| WEEK-03 | P1 | Inspect a day with no meal and a day assigned leftovers. | Empty dinner and assigned leftover are visually distinct and do not open the wrong recipe. | Screenshots | NOT RUN |
| MEAL-01 | P0 | Edit title, venue, subtitle, ingredients, notes, prep note, and leftover note; save. | One shared meal snapshot persists and appears in Week, Tonight, and the reopened drawer. | Before/after screenshots and API readback | NOT RUN |
| MEAL-02 | P0 | Submit blank required values; exercise maximum valid UI input and injected API maximum-plus-one input. | Inline errors associate with fields, browser `maxLength` is visible/consistent, API overflow rejects, and no partial mutation occurs. Ingredients remain free-text lines. | Error screenshots and unchanged version | NOT RUN |
| MEAL-03 | P1 | Save exact maximum-length valid meal content from D4. | Content persists, wraps without overlap, and remains editable on all viewports. | Overflow screenshots and readback | NOT RUN |
| MEAL-04 | P0 | Move a dinner to an open date. | Week and Tonight update atomically; event history identifies the move. | Before/after week screenshots | NOT RUN |
| MEAL-05 | P0 | Move a dinner onto another eligible occupied dinner. | The meals swap dates/slots deterministically, both statuses/history update correctly, and neither disappears or duplicates. | Before/after UI and workspace readback | NOT RUN |
| MEAL-06 | P1 | Change a meal through planned, moved, cooking, cooked, leftover, and skipped/flex statuses. | Status badges and available actions remain coherent in every view. | Status montage | NOT RUN |
| MEAL-07 | P0 | Start cooking from Tonight and then mark cooked. | Status persists across clients and reload; leftover availability follows the canonical rule once. | Two-client recording and readback | NOT RUN |
| MEAL-08 | P1 | Open an informational sourced recipe link. | It is visibly labeled informational and opens the exact HTTP(S) source in a separate tab without losing planner state. | Screenshot and target/href inspection | NOT RUN |
| MEAL-09 | P0 | Replace a recipe through sourced-recipe research when no protected execution state exists. | Recipe-owned fields and source update; date, slot, status, venue, notes, prep/leftover notes, and meal identity remain protected. | Before/after API projection and UI | NOT RUN |
| MEAL-10 | P0 | Attempt recipe replacement while a step is complete, timed, noted, or referenced by prep. | Replacement refuses before mutation and explains the protected state; explicit cleanup must be a separate accepted action. | Failure screenshot and unchanged meal | NOT RUN |
| MEAL-11 | P1 | Lose the response after a recipe edit commits, then use exact-envelope recovery. | The draft is retained until authoritative readback; exact retry cannot apply a second edit. Discard is not offered for ambiguous committed-response recovery. | Network trace and history count | NOT RUN |
| MEAL-12 | P1 | Edit the same meal from two clients using different fields. | One accepted version wins; the stale client sees a conflict and preserves its draft for deliberate reconciliation. | Two-client recording | NOT RUN |
| MEAL-13 | P0 | Attempt to move/swap a meal or destination with tracked leftovers, or collide with assigned leftovers. | The protected move is rejected clearly; meals, leftovers, prep, and feedback remain unchanged. | Failure evidence and workspace readback | NOT RUN |
| MEAL-14 | P1 | Inspect and attempt to edit/clear recipe yield. | Yield display/preservation is verified; absence of a direct yield editor is recorded as a product gap rather than silently treated as covered. | Drawer screenshot and command-surface readback | NOT RUN |

### Instruction Steps And Timers

| ID | Priority | User story and actions | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| STEP-01 | P0 | Complete a step from Tonight. | The same canonical step is checked in Meal and Prep immediately and after reload. | Cross-view and reload recording | NOT RUN |
| STEP-02 | P0 | Reopen a completed step from Prep. | Completion clears in Tonight and Meal without changing prep order or instruction order. | Cross-view screenshots | NOT RUN |
| STEP-03 | P0 | Start a timer, navigate away, reload, restart, then complete and reopen the step. | Start time persists and display derives from current time; completion clears a running timer; reopening does not restart it; no auto-completion occurs. | Timed recording and API readback | NOT RUN |
| STEP-04 | P0 | Reset a running or elapsed timer. | Only timer start state clears; duration, note, completion, and instruction remain intact. | Before/after readback | NOT RUN |
| STEP-05 | P1 | Use timers at 0.5 minutes and 1,440 minutes; reject below, above, or invalid values. | Boundary values persist and invalid values show accessible errors with no mutation. | Field/error screenshots | NOT RUN |
| STEP-06 | P0 | Add a step note. | The note appears on the canonical step in every referencing view and creates one event. | Cross-view screenshots and history | NOT RUN |
| STEP-07 | P0 | Clear a step note. | Only the optional note clears; instruction, timer, completion, and prep reference remain. | Before/after screenshots | NOT RUN |
| STEP-08 | P0 | Use Send to ChatGPT from a step comment without Add note. | The global transcript receives one message with stable step context; the step note does not change. | Chat/step screenshots and API readback | NOT RUN |
| STEP-09 | P0 | Use Add note from a step comment without Send to ChatGPT. | The note changes and no transcript entry is created. | Step/chat screenshots and counts | NOT RUN |
| STEP-10 | P0 | Edit amount lines, free-text instruction, and optional timer duration. | Amounts render above the instruction in recipe order everywhere; shared execution state is preserved. | Before/after screenshots and readback | NOT RUN |
| STEP-11 | P0 | Add a new instruction step. | A stable new step appears once in recipe order and can be referenced by prep. | Drawer/Prep screenshots | NOT RUN |
| STEP-12 | P1 | Reorder steps in Meal. | Recipe order changes while Prep manual order remains unchanged. | Before/after order evidence | NOT RUN |
| STEP-13 | P0 | Remove a step with no prep reference, including one that is complete, timed, or noted. | Exactly that step is deleted, recipe order compacts, and no unrelated step changes. The destructive loss of its execution state is made explicit. | Readback and history | NOT RUN |
| STEP-14 | P0 | Attempt to remove a prep-referenced step. | Deletion is blocked until the reference is separately removed; no dangling prep reference is created. | Error and integrity evidence | NOT RUN |
| STEP-15 | P1 | Enter maximum valid amount/instruction/note content. | Text wraps, controls remain reachable, and no container changes size unexpectedly while editing. | D4 viewport screenshots | NOT RUN |
| STEP-16 | P1 | Race completion or timer actions from two clients. | Final state is canonical, stale commands conflict safely, and history has no duplicate effect. | Two-client trace | NOT RUN |
| STEP-17 | P1 | Run one timer on devices skewed by plus/minus 10 minutes; take one offline, alter its clock, cross Halifax DST, restart, and reconnect. | Server-anchored time converges, never displays negative, survives restart, and cannot remain running on a completed step. | Per-device clock/display and API evidence | NOT RUN |

### Advance Prep

| ID | Priority | User story and actions | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| PREP-01 | P0 | Add an eligible recipe step to a valid prep date. | One reference appears on that date with recipe identity and canonical step content. | Prep screenshot and readback | NOT RUN |
| PREP-02 | P0 | Add several references across Sunday-before through Sunday-ending the week. | Dates group chronologically and each group keeps its manual order. | Full Prep screenshots | NOT RUN |
| PREP-03 | P1 | Verify UI offers only valid prep dates and excludes already referenced steps; inject outside-window and duplicate commands at API/domain boundary. | UI prevents invalid selection and the authority rejects bypass attempts without duplicate/orphaned references. | Choice screenshot and API readback | NOT RUN |
| PREP-04 | P0 | Move a reference up and down repeatedly. | Only prep position changes; recipe instruction order and other dates remain unchanged. | Before/after order evidence | NOT RUN |
| PREP-05 | P0 | Reschedule a reference to another valid date. | It moves to the target group at a deterministic position and remains the same canonical reference. | Before/after screenshot and ID | NOT RUN |
| PREP-06 | P0 | Remove a reference from prep. | Only the reference is removed; instruction, completion, timer, and note remain on the meal. | Prep/Meal screenshots | NOT RUN |
| PREP-07 | P0 | Complete, note, and time a step from Prep; use its recipe link to edit instruction content in the Meal drawer. | Every action updates the canonical step and projects to Prep, Tonight, and Meal. | Cross-view recording | NOT RUN |
| PREP-08 | P1 | Follow the recipe link from a long mobile prep list. | Touch target is at least 44px, correct drawer opens, and returning preserves scroll/order. | Phone recording and bounding box | NOT RUN |
| PREP-09 | P1 | Run D4 with many references and long recipe/step labels. | No horizontal overflow, overlapping reorder controls, clipped dates, or inaccessible remove button. | Viewport screenshots | NOT RUN |
| PREP-10 | P1 | Change prep order while another client completes the same step. | Both independent changes survive when valid or one conflicts with a recoverable authoritative readback. | Two-client trace | NOT RUN |

### Groceries, Farm Box, Leftovers, And Closeout

| ID | Priority | User story and actions | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| GROC-01 | P0 | Add a grocery item with section and detail. | It appears once in the correct section and on the other client. | Two-client screenshots | NOT RUN |
| GROC-02 | P0 | Submit blank/whitespace input, maximum valid UI input, and injected API maximum-plus-one values. | Invalid input is blocked accessibly; `maxLength` is coherent; valid boundary input persists/wraps; API overflow has zero effect. | Error/overflow screenshots | NOT RUN |
| GROC-03 | P0 | Check and uncheck a grocery item. | Shared state updates immediately; All/Open/Done filters show correct counts and membership. | Filter recording | NOT RUN |
| GROC-04 | P0 | Remove an item, including while a filter is active. | The correct item disappears once and filter state remains coherent. | Before/after screenshots | NOT RUN |
| GROC-05 | P1 | Lose an Add or Check response after commit. | Pending retry preserves the draft or intended state and cannot duplicate the item/event. | Network trace and readback | NOT RUN |
| GROC-06 | P1 | Add same-named groceries in different sections/details. | Stable IDs keep actions attached to the selected item; labels remain distinguishable enough to operate safely. | Screenshot and command readback | NOT RUN |
| GROC-07 | P0 | Use Reconcile current list in the Grocery view after the list reflects owned produce. | Exact before/after grocery readback reconciles atomically, the flag persists, and a second click is disabled. | Before/after screenshot/readback and receipt | NOT RUN |
| GROC-08 | P1 | Open a large D4 grocery list on phone/tablet/desktop. | Sections, filters, checkboxes, delete controls, and add form remain usable without layout overflow. | Viewport screenshots | NOT RUN |
| GROC-09 | P1 | Preview and apply farm-box substitutions through ChatGPT or Global Codex. | Accepted/added/removed items match the preview and no unrelated grocery is changed. | Diff screenshot and receipt | NOT RUN |
| GROC-10 | P1 | Try to edit an existing grocery's name/detail/section. | The command capability is verified, and the missing family UI path is recorded explicitly as a product gap. | UI inventory and command readback | NOT RUN |
| LEFT-01 | P0 | Cook a meal that yields leftovers. | One leftover record becomes available with correct label and portions. | Closeout/API evidence | NOT RUN |
| LEFT-02 | P0 | Rate leftover quality good, mixed, and poor. | Exactly one quality is selected and persists across reload. | Segmented-control screenshots | NOT RUN |
| LEFT-03 | P0 | Assign available leftovers to an open dinner. | The Week and Tonight surfaces show the assigned leftover instead of a meal. | Cross-view screenshots | NOT RUN |
| LEFT-04 | P0 | Assign leftovers onto an eligible not-started occupied dinner. | The destination meal is deterministically replaced, its prep/feedback is cleaned, and the leftover dinner projects consistently. | Before/after UI and workspace readback | NOT RUN |
| LEFT-05 | P0 | Mark assigned leftovers eaten. | Assignment clears into consumed state once and the dinner slot no longer presents an actionable duplicate. | Before/after screenshots | NOT RUN |
| LEFT-06 | P0 | Attempt assignment onto started/completed dinner, assigned leftovers, or a meal that sources tracked leftovers. | Assignment is rejected; destination meal, prep, feedback, and all leftover records remain intact. | Failure and integrity evidence | NOT RUN |
| CLOSE-01 | P0 | Record repeat/modify/drop feedback on each meal. | Exactly one value per meal persists and remains associated with the correct snapshot. | Closeout screenshot/readback | NOT RUN |
| CLOSE-02 | P0 | Save, edit, clear, and max-fill the week lesson. | One canonical lesson persists with accessible limits and no cross-week draft leakage. | Field/readback evidence | NOT RUN |
| CLOSE-03 | P0 | Archive the active week after closeout. | Week becomes archived and read-only, history records it, and no second archive occurs. | Before/after screenshots and event | NOT RUN |
| CLOSE-04 | P1 | Attempt archive with stale state or while ChatGPT has no archive grant. | Direct stale action conflicts; ordinary ChatGPT turn cannot archive; no hidden lifecycle mutation occurs. | Chat/history/API evidence | NOT RUN |
| CLOSE-05 | P1 | View closeout with no leftovers, no feedback, or already archived. | Empty/read-only states explain what remains without broken or misleading controls. | State screenshots | NOT RUN |

### ChatGPT, Research, And Shared Transcript

| ID | Priority | User story and actions | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| CHAT-01 | P0 | Send an ordinary Plan message from each primary view. | The one global transcript records correct week/view context and Tonight meal/leftover context. Arbitrary selected-object context is not falsely claimed. | Transcript and API context readback | NOT RUN |
| CHAT-02 | P0 | Switch between Plan and Research recipe with a draft present. | Draft text is preserved; research hides archive grant; Plan restores it unchecked. | Recording | NOT RUN |
| CHAT-03 | P0 | Grant archive permission for one Plan turn. | Grant applies only to that accepted turn, resets after send, and retry cannot acquire a new grant. | UI and turn readback | NOT RUN |
| CHAT-04 | P0 | Run a successful multi-tool Plan turn with several dependent applies. | Each accepted apply commits as its own ordered, fenced version/event/receipt/effect unit before reply; dependent calls consume accepted readback versions; no effect duplicates. | Transcript, receipts, effects, and view evidence | NOT RUN |
| CHAT-05 | P0 | Run sourced-recipe research. | Research progress is visible; one validated source candidate transfers to planner context; source/yield are informational and visible. | Progress/replacement recording | NOT RUN |
| CHAT-06 | P0 | Terminate the research child or authority before binding/reservation and after compact-candidate attachment but before effect. | Turn terminates with zero effect; retry researches fresh; no recipe/planner mutation or raw page persistence occurs. | Turn/workspace/table scan evidence | NOT RUN |
| CHAT-07 | P0 | Terminate planner child/authority after effect commit but before tool response, during reply insert, and after terminal CAS. | UI says changes are durable; Recover reconstructs the reply without executing or researching again. | Recording and event/effect counts | NOT RUN |
| CHAT-08 | P0 | Submit while another foreground turn is running. | One turn owns the slot; the second is rejected as busy without a duplicate transcript/effect. | Two-client trace | NOT RUN |
| CHAT-09 | P0 | Make ChatGPT unavailable after readiness but during submit, returning an injected 503. | Draft and selected intent remain; planner controls remain usable. Steady-state disabled Send is covered by CHAT-10. | Screenshot and field readback | NOT RUN |
| CHAT-10 | P0 | Cycle checking, unauthenticated, incompatible, unavailable, and ready states. | Status copy is accurate; Send is gated except when ready; planner remains usable in every state. | State montage | NOT RUN |
| CHAT-11 | P1 | Change viewport between modal and rail with an unsent chat draft. | Draft and intent stay in the same active client session without leaking into durable transcript. | Resize recording | NOT RUN |
| CHAT-12 | P0 | Use mobile ChatGPT, then open the transcript on tablet/desktop. | The same durable transcript and assistant result appear; there is no per-device thread. | Cross-device screenshots | NOT RUN |
| CHAT-13 | P1 | Enter empty, whitespace-only, maximum valid UI, and injected API over-limit messages. | Invalid sends stay blocked; limit is visible; maximum content wraps; authority rejects bypass overflow with zero transcript/turn effect. | Boundary screenshots and API counts | NOT RUN |
| CHAT-14 | P1 | Render long source identity, assistant reply, error, and recovery controls. | Chat remains scrollable; composer/send remain reachable; no message or control overflows. | D4 viewport screenshots | NOT RUN |
| CHAT-15 | P0 | Crash/restart the authority while a turn is running. | Startup marks it interrupted; one explicit recovery yields one terminal reply and no duplicate planner effect. | Restart recording and turn rows | NOT RUN |
| CHAT-16 | P1 | Lose only the submit response while the turn commits. | Authoritative polling/readback resolves the accepted turn; a repeated request cannot create another turn. | Network trace and transcript count | NOT RUN |
| CHAT-17 | P0 | Research candidate A, then preview/apply a replacement with A's exact source tuple but altered title, yield, steps, ingredients, or timers. | Both calls return `NOT_AUTHORIZED`; planner version, meal, events, receipts, and accepted effect count remain unchanged. | Candidate/replacement hashes and before/after readback | NOT RUN |
| CHAT-18 | P0 | Exercise prompt injection, malformed/max-plus-one candidates, timeout, and crash after compact attachment; scan application tables, export, and retained logs. | Invalid candidates have zero effect; raw page/injection text never persists; no-effect retry researches fresh and post-effect retry never researches. | Full-table/log scan and turn/effect counts | NOT RUN |
| CHAT-19 | P1 | Reload with an unsent draft. | No transcript entry is created; whether the local draft is restored or explicitly discarded is recorded as a product decision rather than inferred from resize behavior. | Before/after reload recording | NOT RUN |
| CHAT-20 | P0 | Keep text in the global composer and a step-comment draft; use Add note, step Send, and rejected/busy step Send. | Add note does not clear global chat; step Send does not clear global composer; rejected/busy step Send retains its own draft. | Both-draft screenshots and transcript/note counts | NOT RUN |

### History, Undo, Synchronization, And Recovery

| ID | Priority | User story and actions | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| HIST-01 | P0 | Open Recent changes after UI and ChatGPT mutations. | Events are newest-first, readable, identify Household/Codex, command summary, target, and time. | Drawer screenshot and API page | NOT RUN |
| HIST-02 | P0 | Undo the latest eligible UI mutation. | Exact inverse applies once, affected views refresh, and history records the undo. | Before/after recording | NOT RUN |
| HIST-03 | P0 | Undo the latest eligible ChatGPT mutation. | The same undo authority applies; transcript remains historical while planner state reverts. | Chat/history/view evidence | NOT RUN |
| HIST-04 | P0 | Attempt undo after dependent later change, from stale client, twice, and after archive/handoff followed by a concurrent write. | Unsafe/duplicate undo is rejected; valid lifecycle undo preserves one-active-week invariants and records the exact `reverts_event_id`. | Event graph and failure trace | NOT RUN |
| HIST-05 | P1 | Scroll a long event history and open/close on phone. | Drawer content scrolls independently, close control remains available, and focus returns correctly. | Phone recording | NOT RUN |
| HIST-06 | P0 | Undo archive as the latest event. | Lifecycle restores atomically with exactly one active-week invariant while transcript remains historical. | Before/after event and lifecycle readback | NOT RUN |
| SYNC-01 | P0 | Execute the entity-specific two-client stories indexed by MEAL, STEP, PREP, GROC, LEFT, CLOSE, HIST, and CHAT. | Every canonical entity projects to the peer without a device-local fork; failures remain attributable to their source story. | Cross-story two-client coverage index | NOT RUN |
| SYNC-02 | P0 | Take client A offline with unsaved drafts and attempt mutations. | Last shared state remains visible, editing is disabled, and local drafts survive until reconnect/discard. | Offline recording | NOT RUN |
| SYNC-03 | P0 | Reconnect client A after client B changes shared state. | Client A reconciles to authoritative state and preserves only drafts that can still be deliberately applied. | Reconnect recording | NOT RUN |
| SYNC-04 | P0 | Inject a version conflict for recipe, grocery, prep, and lifecycle actions. | No 500/SQLite leakage; UI explains retry/discard; latest-version retry uses refreshed authority. | Conflict screenshots and network log | NOT RUN |
| SYNC-05 | P0 | Lose a mutation response after commit and reload before retry. | The exact request ID/payload remains resolvable after reload, server state remains single-effect, and retry/discard is explicit; loss of the pending envelope is a failure. | Reload/network trace and envelope | NOT RUN |
| SYNC-06 | P0 | Restart the authority while two clients are open. | Durable workspace/transcript/timers return; clients reconnect; unfinished chat is interrupted rather than silently rerun. | Restart recording and health | NOT RUN |
| SYNC-07 | P1 | Switch weeks while a local recipe, grocery, prep, lesson, or chat draft exists. | Drafts reset or remain scoped according to the control; none applies to a different week accidentally. | Field and event evidence | NOT RUN |
| SYNC-08 | P1 | Submit rapid repeated clicks/keys on mutation controls. | Buttons gate in-flight work and idempotency prevents duplicate entities/effects. | Recording and event counts | NOT RUN |
| SYNC-09 | P0 | Race two browsers, embedded Codex, and Global UDS from one base version using archive, handoff, undo, recipe replacement, and grocery mutation. | One canonical commit per version; losers receive authoritative conflicts; provenance is valid; no duplicate receipt/effect or second active week exists. | Per-ingress trace and final integrity readback | NOT RUN |

### Storage, Restore, And Deployment Recovery

| ID | Priority | User story and actions | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| RESTORE-01 | P0 | Populate every durable entity, export, remove the disposable database, and attempt recovery using only supported product/operator surfaces. | Complete state/event/transcript/chat identity restores, or the product explicitly warns before signoff that canonical export is not a restorable backup. | Export hash, restore command, structural diff, versions, `quick_check` | NOT RUN |
| STORE-01 | P0 | Inject real `ENOSPC`/I/O failure during workspace, event, receipt, accepted Codex effect, and WAL checkpoint writes. | No partial unit commits; prior state remains readable; readiness fails visibly if uncertain; exact-request replay succeeds after space returns. | Fault trace, DB/WAL sizes, table/receipt/event counts | NOT RUN |
| STORE-02 | P0 | Start with corrupt JSON rows, corrupt SQLite, unsupported newer schema, and conflicting partial schema. | Startup fails closed without mutation or seed substitution and identifies the recovery/backup boundary. | Startup log, file hashes, `quick_check` | NOT RUN |
| DEPLOY-01 | P0 | Freeze candidate manifest, Git state, operator hash, baseline, Codex executable/schema/config/instruction identities, and selected source database before staging. | Any coordinate drift rejects staging/activation. | Immutable identity manifest | NOT RUN |
| DEPLOY-02 | P0 | Using D11, terminate activation at every durable release checkpoint and run public recovery. | Pre-commit recovers exact prior app/data/config; post-commit retains exact candidate pair; no external effect is guessed or repeated. | Receipt chain, directory/DB hashes, pointer generations | NOT RUN |
| DEPLOY-03 | P0 | After activation, make new planner/chat/tool writes and request rollback, including interrupted rollback. | Automatic data restore requires unchanged whole-store hash; otherwise newer data is retained and exact data-loss authorization is required. | Activation/current/restore hashes and rollback receipts | NOT RUN |
| DEPLOY-04 | P0 | Start the exact initialized selected clone before resetting QA data; then run deterministic journeys, activation verification, pointer commit, restart, and rollback. | Rendered week/version/schema and every artifact bind to one immutable receipt chain; selected runtime restarts successfully. | Installed screenshots, QA artifact, current pointer, health | NOT RUN |
| LEARN-01 | P1 | Look for promotion of a successful recipe/planning lesson and a restorable household export. | Missing family-facing promotion/export/restore affordances are recorded explicitly; no unimplemented workflow is counted as covered. | UI inventory and functional-spine comparison | NOT RUN |

## Visual Coverage Matrix

Every applicable cell expands into a result-manifest row with ID `WRP-{SURFACE}-{STATE}{NN}-{VP}`. State codes are `LD` loading, `EM` empty, `ER` error/degraded, `PO` populated, `OV` overflow, and `IN` interactive. Viewport suffixes are `P375`, `P428`, `T768`, `D1280`, and `W1920`. Unimplemented states receive `NOT APPLICABLE` with a reason; they are never silently omitted.

Every cell requires a viewport screenshot and geometry JSON asserting document width, overlap, sticky/fixed position, final-content clearance above mobile navigation, and composer visibility where applicable. Overflow cells also require top, bottom, and separate full-page captures; full-page images never substitute for viewport evidence. Interactive cells require before/focus/after screenshots plus video. Phone/tablet cells also measure touch targets and safe-area/fixed-navigation behavior.

| Surface | Empty | Loading | Error/offline | Populated | Overflow | Interactive overlays |
| --- | --- | --- | --- | --- | --- | --- |
| Bootstrap | D0 no legacy | Initial read/bootstrap busy | Authority failure, corrupt import, interrupted retry | D1 valid import candidate | Long labels/errors | Import/Fresh/Retry and busy transitions |
| Shared shell | D7 initialized/no weeks | Saving and ChatGPT working indicators | Offline, notice, conflict, pending retry with Retry/Discard/Dismiss | Active/planned/archived picker | Long week labels/banners | Nav, Make active, week switch, visible H1 focus |
| Week | Seven open dinners | NOT APPLICABLE: no per-view loader | Archived/offline shell | D2/D3 mixed meals and D8 leftovers/status tones | D4 seven dense meals | Open recipe, pressure strip, scroll clearance |
| Tonight | Outside week / no meal | NOT APPLICABLE: no per-view loader | Offline/pending mutation | Recipe states plus D8 assigned leftovers | D4 recipe/steps/source | Status, checkbox, note, timer, meal drawer |
| Prep | No references / archived form absent | NOT APPLICABLE: no per-view loader | Validation/conflict/offline | Multiple dated groups | D4 all eight dates/long steps | Add, reorder, reschedule, remove, drawer, timer |
| Groceries | No items / empty filter | NOT APPLICABLE: no per-view loader | Validation/conflict/offline | All sections, mixed completion, farm-box state | D4 long list/details | Add, filters, check/remove/reconcile/draft |
| Close out | No ratings/leftovers | NOT APPLICABLE: no per-view loader | Read-only/error/conflict | Partial feedback, leftover lifecycle, archived summary | D4 names/leftovers/lesson | Rate, lesson, assign/consume, archive |
| ChatGPT rail: T768/D1280/W1920 | Empty transcript | Health checking and planner/research running | Unavailable/incompatible, unapplied conflict, interrupted/retry, effect recovery | Short mixed-role transcript | D4 long tail/messages/context/errors | Intent, grant, send/retry, scroll/focus |
| ChatGPT modal: P375/P428 | Empty transcript | Health checking and planner/research running | Rail errors plus pending retry and offline recovery | Short mixed-role transcript | D4 long tail/messages/context/errors | Open/close, trap, Escape, keyboard, resize |
| Meal drawer | No ingredients/instructions/notes | Save pending/disabled | Validation/offline/conflict/archived | Normal and sourced recipe | D4 fields/steps/editors | Trap/restore, move/status/edit/reorder/timer/delete |
| History drawer | No events | NOT APPLICABLE: no drawer loader | Offline/pending retry/undo conflict | Household/Codex events and undo state | D4 long event tail | Trap, Escape/backdrop, scrolling, undo, restore |

### Required viewports

| ID | Viewport | Purpose |
| --- | --- | --- |
| VP-375 | 375x812 | Small iPhone and worst-case bottom navigation/chat width |
| VP-428 | 428x926 | Large phone and long-content wrapping |
| VP-768 | 768x1024 | iPad portrait with persistent ChatGPT rail |
| VP-1280 | 1280x900 | Standard desktop operations surface |
| VP-1920 | 1920x1080 | Wide desktop density, max-width, and unused-space behavior |

### Breakpoint And Short-Height Probes

| ID | Viewports | Risk |
| --- | --- | --- |
| BP-840 | 840x900 and 841x900 | Week switches from vertical list to seven-column grid beside the chat rail |
| BP-700 | 700x900 and 701x900 | Chat switches from modal to persistent hybrid rail |
| BP-620 | 620x900 and 621x900 | Feedback, fields, and action rows change composition |
| BP-980 | 980x900 and 981x900 | Workspace/grid density transition |
| BP-1180 | 1180x900 and 1181x900 | Desktop rail/content density transition |
| BP-SHORT | 375x667 and 1280x700 | Composer, bottom navigation, drawers, and final content at limited height |

## Accessibility And Usability Checks

| ID | Priority | Check | Expected result | Status |
| --- | --- | --- | --- | --- |
| A11Y-01 | P0 | Keyboard-only traverse buttons, links, summaries, fields, nav, programmatically focused H1, and every overlay. | Logical order, visible focus not hidden by fixed UI, correct mobile-nav order, no trap outside modal, no unreachable command. | NOT RUN |
| A11Y-02 | P0 | Inspect headings, landmarks, current navigation, dialogs, alerts, status, groups, and field labels. | Semantics describe the visible structure and dynamic state accurately. | NOT RUN |
| A11Y-03 | P0 | Trigger every validation error. | Error is associated with its field, announced, and not communicated by color alone. | NOT RUN |
| A11Y-04 | P0 | Measure every interactive target, especially ChatGPT intent labels, segmented controls, timers, prep icons, nav, recipe links, checkboxes, and close buttons. | Every target is at least 44x44 CSS pixels or has a documented justified exception and safe separation. | NOT RUN |
| A11Y-05 | P1 | Check text, controls, status tones, disabled states, focus rings, and links with contrast tooling. | At least 4.5:1 normal text and 3:1 large text, UI components, and focus indicators. | NOT RUN |
| A11Y-06 | P1 | Test 400% desktop zoom or equivalent 320 CSS-pixel reflow plus large mobile text. | Content reflows without two-dimensional scrolling or loss of functionality. | NOT RUN |
| A11Y-07 | P1 | Exercise reduced-motion preference. | Spinners/transitions remain understandable and nonessential animation is reduced. | NOT RUN |
| A11Y-08 | P1 | Inspect accessible names for duplicate meal/step/grocery controls. | Each destructive or state-changing action names its exact target. | NOT RUN |
| A11Y-09 | P1 | Apply WCAG text-spacing overrides. | Content remains readable and controls do not clip, overlap, or hide text. | NOT RUN |
| A11Y-10 | P0 | Prove modal background unavailability, body-lock restoration, Escape/backdrop behavior, focus restoration, safe-area handling, and on-screen-keyboard composer visibility. | Each chat/meal/history modal satisfies the full dialog contract on phone and desktop presentations. | NOT RUN |
| A11Y-11 | P1 | Run axe and capture accessibility-tree snapshots for each primary surface and dialog. | No serious/critical violations; landmarks, headings, live regions, labels, errors, groups, and link semantics are correct. | NOT RUN |
| A11Y-12 | P1 | Inspect status, today, offline, selected, and progress indicators without color. | Meaning remains available through text, icon, shape, or programmatic state. | NOT RUN |

## Performance And Resilience Checks

| ID | Priority | Check | Expected result | Status |
| --- | --- | --- | --- | --- |
| PERF-01 | P1 | Measure bootstrap, initial populated load, and view navigation on the disposable local runtime. | Record p50/p95 and visible-feedback timing against budgets fixed in the run manifest before execution. | NOT RUN |
| PERF-02 | P1 | Exercise D4 and D10 through scroll, mutation, history, export, restart, and chat. | Record response bytes, DB/WAL growth every 50 writes, p50/p95 latency, RSS, and restart time against predeclared budgets. | NOT RUN |
| PERF-03 | P1 | Leave the app open through timer ticks, transcript polling, and repeated refreshes. | Memory/CPU/network activity stays bounded and the layout remains stable. | NOT RUN |
| PERF-04 | P0 | Capture console errors, page errors, failed requests, and all 5xx responses for the complete run. | Only deliberately injected failures occur and each is tied to an expected scenario. | NOT RUN |
| PERF-05 | P1 | Exercise rapid reads/mutations through two browsers, embedded Codex, and Global UDS. | Record latency and resource use; no SQLite busy leak, deadlock, stalled UI, duplicate effect, or unbounded retry loop. | NOT RUN |
| PERF-06 | P1 | Run D10 through workspace read, mutation, export, restart, history, and chat. | Numeric response-size, database-growth, latency, memory, and restart budgets are met or produce a finding. | NOT RUN |

## Signoff Gates

- The frozen source identity, local runtime commands, ports, disposable data path, browser/version, and viewport sizes are recorded.
- All P0 stories are `PASS`, or each failure is fixed and re-run before signoff.
- `BOOT-09`, `RESTORE-01`, `STORE-01`, `CHAT-17`, `SYNC-09`, and all `DEPLOY-*` rows are mandatory release gates; screenshots alone cannot satisfy them.
- Every primary surface has populated visual evidence at all five required viewports.
- Empty, loading, error/offline, overflow, and interactive states are covered wherever applicable, with explicit `NOT APPLICABLE` rationale rather than silent omission.
- Keyboard/focus, touch target, long-content, console/network, two-client, restart, timer persistence, and ChatGPT readiness/recovery gates are complete.
- Database hashes, `quick_check`, receipt/event/effect counts, and immutable release-chain hashes accompany durability and deployment claims.
- Findings use `VQA-NNN` or `EXP-NNN`, contain reproduction steps and evidence, and are severity-ranked.
- The final report separates automated proof, runtime observation, visual judgment, and untested gaps.
