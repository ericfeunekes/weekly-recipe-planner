---
name: storybook
description: Use when creating, reviewing, or visually QAing Storybook stories for UI components, especially when design parity, Figma references, story iframe verification, runtime-backed stories, or local Storybook server setup matter.
metadata:
  version: "0.1.1"
---

# Storybook UI QA

Use this skill when a UI task depends on Storybook as the proof surface: adding
component stories, checking whether a story matches a design, comparing a
Storybook render to Figma or local design docs, or debugging why a Storybook
page looks blank.

This skill is about **component proof and visual readback**, not general browser
automation. Use `agent-browser` or a repo browser tool to drive the page after
this skill defines what to verify.

## Core Rules

- If you change a component or story, visually self-review it before reporting
  completion. Capture or inspect a screenshot of the exact target story iframe
  and confirm it is not an error page, stale render, or blank canvas. Do not
  tell the user to check Storybook until you have done this yourself.
- Treat this screenshot/readback as a **handoff gate**, not optional polish.
  Do not commit, push, open a PR, or send the branch to another human as ready
  for UI review until the changed story states have clean visual proof, or until
  you explicitly report the Storybook/render blocker instead.
- Distinguish **visual inspection evidence** from **durable QA artifacts**. You
  usually need to inspect or temporarily capture the story canvas to know what
  rendered; you do not always need to save those screenshots or a QA markdown
  file into the repo. Persist QA artifacts only when the repo contract, PR
  template, user request, or handoff requires them. Otherwise summarize the
  checked story IDs, Figma nodes, viewport, and result in the conversation and
  remove temporary screenshot folders before handoff.
- If the screenshot/readback fails, stop calling the UI work done. Report the
  blocker and keep debugging the story/server/render path. A user opening
  Storybook and seeing an error after you said "done" is a failed closeout, not
  a minor proof gap.
- Verify the **specific story iframe**, not just the Storybook manager shell.
  A `200` at `/` only proves the manager is serving; the selected
  `iframe.html?id=<story-id>&viewMode=story` can still be a Vite error page.
- Confirm the server on the Storybook port belongs to the **current worktree**.
  Port reuse across worktrees can show stale stories that look like the current
  branch but are actually served from another checkout.
- Treat an empty `index.json` or an iframe error path that names another
  checkout as a server-identity/setup failure, not as visual evidence. Re-check
  the listener and current story index before capturing screenshots.
- Verify restarts by process identity, not by command success. A repo stop/start
  target or PID file can report success while a different stale Storybook
  process still owns the port; compare `lsof -i :<port>` with the PID file or
  process cwd before trusting the iframe. If the port remains contaminated, use
  a fresh unused port and prove that port's listener and `index.json`. See
  `references/port-identity-and-stale-module-proof.md`.
- Do not claim design parity from repo docs alone. For any Figma-backed story
  or component state, inspect the current live Figma node/frame directly in the
  same pass before saying it matches, is validated, or is visually complete. Use
  repo docs only as routing aids. Do not assume Figma access is blocked: try the
  repo-configured Figma/MCP/API path for the relevant node first. If live Figma
  access is actually unavailable after that attempt, say so and label Figma
  parity incomplete instead of treating cached docs as sign-off.
- Treat Storybook stories as evidence only when they render production
  components or a named architecture harness. Label design mocks, legacy
  stories, synthetic fixtures, and runtime-backed stories differently.
- Treat user comments like "why is this here?", "shouldn't there be more
  states?", or "is this in the right folder?" as Storybook coverage/taxonomy
  findings, not just cosmetic feedback. Re-check the served sidebar/title
  against the repo's architecture levels, rename or retire "legacy" states that
  are not current evidence, and add the missing state matrix before calling the
  story surface complete. See
  `references/story-taxonomy-and-appendage-audit.md`.
- If Storybook review reveals that active component names encode migration
  history (`Adapter`, `New`, `V2`, compatibility `Container`) rather than
  current ownership, fix the class-level naming and module boundary comments in
  code/tests/docs, not only the Storybook title. See
  `references/ui-layer-naming-and-boundary-comments.md`.
- Audit the rendered canvas for stray framework/library appendages: default
  utility buttons, scroll controls, debug labels, raw primitive text, or
  story-only controls that are not part of the designed product surface. If an
  appendage appears, remove it or wrap it in a designed component and add a
  negative Storybook/component assertion so it cannot return unnoticed. See
  `references/story-taxonomy-and-appendage-audit.md`.
- Keep the story canvas visually honest about what is the product component
  versus harness scaffolding. For snapshot/state stories, render the actual
  imported component or composition under test with required providers/MSW state
  and avoid extra instructional headers, debug panels, fake buttons, or
  story-only status chrome inside the component surface. If a harness control is
  necessary to drive an interaction, keep it clearly outside the claimed product
  surface and do not hand that story to the user as the app UI unless the
  product also renders that control. Prefer preselected MSW/runtime states for
  static snapshots over "click Send to reach the state" stories unless the
  interaction itself is the claim. See
  `references/story-canvas-harness-discipline.md`.
- Correct state is not sufficient if the story bypasses the component's
  established visual primitives. When a runtime/snapshot story renders a
  loading, thinking, status, action, source, citation, or shell slot, compare
  that element against the primitive/component story or live design reference
  that owns the visual language. If the snapshot uses a custom wrapper, border,
  label, or layout that the primitive story does not use, fix the product
  component or story to compose the existing primitive instead of documenting
  the mismatch as acceptable. See
  `references/primitive-aligned-runtime-snapshots.md`.
- Do not treat a green Storybook runner as visual QA for a snapshot story until
  you also open the exact iframe and confirm the initial canvas is already in
  the named state. A `play` function may click or wait through a debug harness
  while the user-visible story still starts with incorrect or story-only
  content.
- When a runtime-backed story is the intended proof surface, prefer a
  repo-owned Storybook Playwright lane over ad hoc browser clicking. Open exact
  story iframes, drive story controls, assert visible behavior/console health,
  and keep the proof boundary clear: this proves browser-visible Storybook
  runtime behavior, not production route/auth/live-provider behavior. See
  `references/storybook-playwright-runtime-proof.md`.
- Keep story names, descriptions, selected checkpoints, and assertions aligned
  to the same contract state. A story named `stale-no-owner`, `fallback`,
  `empty`, `terminal`, `error`, or similar must not assert the opposite
  semantic state just because the current implementation renders it. If a
  stale/no-owner story accepts an active tool, sub-agent, or phase-specific
  label, the story is a false-green proof of the wrong contract. See
  `references/contract-named-runtime-states.md`.
- Treat runtime-backed Storybook failures as possible product-path evidence
  until classified. If a runtime story exposes a hook-order error, provider
  warning, message-adapter crash, cache/session bleed, or transcript/render
  mismatch in production components, do not wave it off as Storybook noise just
  because the failing assertion was incidental to the current visual change.
  Classify whether the failure is in the runtime harness, stale story state, or
  the imported product path; fix product-path defects that block the claimed
  story proof, or explicitly narrow the claim. See
  `references/runtime-storybook-adjacent-defects.md`.
- Do not let Storybook become the primary proof for a non-UI substrate
  contract. For reducers, parsers, stream accumulators, runtime state machines,
  or persistence/projection owners, first prove the owner state with unit,
  replay, integration, route, or recorded-stream tests that assert the final or
  checkpointed state. Use Storybook/Playwright afterward to prove known states
  render correctly or to smoke a browser-visible regression. If you report
  Storybook evidence for a substrate change, label it as rendering/browser
  smoke unless the story actually drives the same runtime owner path. For
  event-stream metadata, transcript/read-model projection, or terminal refetch
  contracts, use `references/substrate-vs-rendering-proof.md`.
- For runtime-backed docs pages, do not treat the docs page as equivalent to
  the isolated story iframe. Docs pages can mount several canvases at once,
  auto-run story `play` functions, and share MSW/runtime state across canvases;
  they are useful for discovery and user-visible inspection, but canonical
  assertions should target the exact `iframe.html?id=<story-id>&viewMode=story`
  story. If a user reports duplicate content or a flash in docs mode, compare
  the docs page to isolated iframes before deciding whether the issue is docs
  composition, stale server state, reused story/session identity, or product
  rendering. See `references/runtime-docs-vs-iframe-state.md`.
- For composed surfaces with slots, placeholders prove only slot reservation.
  If the completion claim includes the child component's rendering, measurement,
  state, or interaction behavior, add a story that mounts the child through its
  production component or a named production-equivalent harness. Keep placeholder
  stories as layout-only states and do not use them as final visual proof for
  the composed shipped surface.
- Keep the canonical/current story honest about deferred controls. If
  production intentionally renders an out-of-scope action as disabled,
  non-interactive, omitted, or placeholder chrome, the default primitive and
  composition stories used as completion evidence should show that same state.
  A future interactive variant is fine, but it must be separately named and
  described as future/design-only rather than used as shipped proof.
- When the claim is about Storybook architecture level, story placement, or a
  primitive-vs-composition split, validate that claim with `agent-browser`
  before reporting completion. Open or query the actual served Storybook
  surface, inspect `index.json` for the story IDs/titles, and snapshot at least
  one representative primitive story plus the composition story. Source code,
  build output, or a remembered CSF title is not enough.
- If the user is looking at the Codex in-app browser or cites its current URL,
  validate the claim in that same user-visible browser surface with the
  `browser` plugin. A separate `agent-browser` session can prove a server is
  capable of rendering the right story, but it does not prove the page the user
  sees has refreshed or escaped stale Storybook manager assets.
- When the user points to a Storybook docs URL, verify both surfaces before
  answering: the user-visible docs page (same browser tab when possible) and
  the isolated iframe for each story involved. A green Playwright run against
  iframes does not mean the docs page is free of confusing multi-canvas state,
  and a docs-page artifact does not necessarily mean the isolated story is
  wired incorrectly.
- When the user's complaint is about the **app route** or a host shell, do not
  stop at Storybook even if the story proves the component. Verify the
  production-like route that the user sees and inspect the owning layout
  geometry there. Storybook can prove a component's message column, but the app
  route can still miss the shell/viewport/container class that enforces
  whitespace. See `references/storybook-to-app-route-parity.md`.
- When the user explicitly asks for running-app QA in the Codex in-app browser,
  that requested browser surface is part of the proof contract. Do not replace
  it with Storybook, static builds, or a separate headless browser and call the
  claim proven. If the default HTTPS local route is blocked by a browser
  certificate/interstitial or protocol mismatch, use the repo's safe local
  HTTP/non-HTTPS dev mode or an equivalent same-app mock route on another port,
  then state the exact URL/protocol used and why it is an equivalent running-app
  proof. See `references/storybook-to-app-route-parity.md`.
- For open/closed shell, drawer, sidebar, or navigation states, require a
  deterministic state seam or an executable interaction assertion. A timed
  best-effort DOM click can help debug locally, but it is not durable proof
  unless the story fails when the expected open/closed content is absent.
- Keep Storybook documentation in its evidence lane. Storybook matrices should
  record story IDs, states, data sources, viewports, and proof lanes; do not
  turn a Storybook doc into a second requirements/backlog owner when an
  architecture, component, or feature doc already owns the behavior. If a
  Storybook gap needs to become durable work, route it to the owning domain doc
  and point back to the evidence row.
- Do not present a current shell/route proof as done when the story lives under
  a retired, legacy, debug, or compatibility namespace. A temporary compatibility
  story can unblock inspection, but the durable evidence surface should be moved
  to a current architecture-level title, or the mismatch must be reported as a
  follow-up risk rather than documented as the final proof location.
- Start at the lowest useful layer: primitive story, component story,
  composition, runtime-backed flow, then host/app surface.
- Primitive-first means each leaf primitive owns its own Storybook namespace,
  state matrix, and focused tests. Do not group many unrelated leaf primitives
  under one broad "Primitives" story and call that primitive evidence. If the
  user or repo architecture names separate leaves such as user text, assistant
  text, citation badge, source row/list, action row, or loading marker, give
  each one its own `Chat/00 Primitives/<LeafName>` style surface, then assemble
  them later in `01 Components` / `02 Compositions`.
- Match the story level to the user-visible claim. If the user asks to inspect
  a full shell, routed app surface, header/sidebar, open/closed navigation, or
  other cross-component integration, do not hand them a leaf/component story
  that only renders the inner panel. Either open an existing shell/app-surface
  story or add a focused shell story with the needed states before presenting
  Storybook as the proof surface.
- If a story depends on generated config or installed dependencies, verify those
  prerequisites before diagnosing component code.
- For markdown/content stories, verify the rendered DOM shape, not just the
  input fixture. Example: if a story claims table coverage, assert or inspect a
  real `<table>` render; raw pipe-delimited text means the markdown renderer
  lacks GFM support or equivalent table handling. For assistant/LLM prose,
  include representative markdown breadth before claiming the primitive is
  ready: GFM tables, code blocks, literal dollar-sign accounting text that must
  not become LaTeX/math, and a partial streaming state such as a complete
  paragraph followed by an incomplete table. The partial state should be
  genuinely incomplete when that is the risk, for example a table row with a
  missing cell, not just a valid final markdown table with shorter content.
- For citation/source story states, prove coordination as behavior, not just
  co-rendering. If inline references and source rows are linked, add component
  tests and Storybook states for both directions: reference hover/focus
  highlights the source row; source hover/focus highlights the inline
  reference; clicking a reference flashes and scrolls to the source row when
  needed. URL-backed source rows may be links, but their active treatment should
  still read as a row highlight rather than default text-link underline unless
  the design explicitly shows underline. Do not encode the first source row as
  permanently selected merely because the Figma sample captures a hover/active
  row; default, hover/active, and flash states should be separate stories.
- Prefer recording-backed partial stream states over invented partial text when
  realistic recordings exist. Slice the recording at meaningful checkpoints,
  derive the rendered client/MSW state from the reducer/runtime shape, and pair
  it with existing transcript context so Storybook proves a plausible in-flight
  UI rather than a hand-written approximation.
- For delayed/replay stories, make the delay support the story's proof point
  rather than mirroring every low-level event at the same speed. A long
  recording with a flat human-visible delay can make Storybook look hung; use
  staged timing when the claim is "the slot appears, then terminal content
  takes over." See `references/recording-backed-stream-states.md`.
- For streaming/runtime snapshot stories, wire each distinct snapshot into the
  executable Storybook test surface when the story is part of the proof claim.
  Do not leave a runtime story as manual-only by accident. Give each named
  checkpoint its own story export and play assertion: pre-answer tool/thinking
  states should assert transient chrome is visible and durable assistant content
  is absent; partial-answer states should assert assistant content is visible
  and transient chrome is hidden. If the production component receives a
  derived handoff signal such as "active assistant content exists", derive and
  pass that signal through the Storybook runtime wrapper too; a manually
  hydrated prop story is weaker evidence and should be labeled as such.
- When a user wants the broad streaming claim to be true, add a stronger
  Storybook proof lane instead of only narrowing language. Keep checkpoint
  snapshots for deterministic visual states, but add at least one story that
  drives the repo's runtime path (`send -> stream/MSW -> reducer/cache -> UI`)
  when the claim includes runtime behavior. Label pre-projected checkpoint
  stories as checkpoint/component evidence; reserve "runtime-backed" for
  stories that mount the real runtime wrapper or equivalent production-path
  harness.
- For streaming slot ownership over time, do not rely on a pile of unrelated
  static snapshots or one-off reducer helpers. Add one shared event-stepper
  fixture that advances the same `streamingRun + transcript` pair one event at
  a time, then use it for reducer/state assertions, component rerender
  assertions, and checkpoint snapshots. This proves ownership swaps, stale
  timed ticks, and assistant-content handoff without creating parallel stream
  models. See `references/streaming-transition-stepper-proof.md`.
- For assistant-message streaming, extend the same stepper proof to message
  identity and rendered append behavior. Assert that the first orchestrator
  delta creates exactly one assistant message and later deltas update that same
  rendered message instead of adding a duplicate assistant bubble. This belongs
  in a real runtime/message-zone test when the product path uses a framework
  message adapter, not only in transcript-unit assertions. See
  `references/streaming-transition-stepper-proof.md`.
- Persist Storybook streaming checkpoint snapshots from real AG-UI recordings
  only. Select named checkpoint boundaries from the recording, replay them
  through the shared stepper/reducer/transcript projection, and explain in code
  comments why each event boundary was chosen so future recording updates can
  adjust selectors deliberately. For timed handoff snapshots, start from a
  recording prefix and apply the real stepper tick; do not hand-build
  `streamingRun`, transcript, or `ChatMessage[]` state. See
  `references/agui-recording-checkpoint-maintenance.md`.
- When a dependency upgrade changes the exported recording/fixture API or adds
  new stream fixtures, audit the full fixture inventory before updating
  stories. Build a capability matrix for every exported fixture: event
  families, text/tool/custom/error coverage, terminal status, non-orchestrator
  text, reasoning events, long-stream suitability, and metadata-in-text leaks.
  Then map each Storybook/component/e2e state to a fixture that actually
  contains the required event family. Do not keep stale story names or
  assertions from the old recording set just because the old IDs were replaced.
  See `references/agui-recording-checkpoint-maintenance.md`.
- If the desired streaming snapshot is absent from the current AG-UI
  recordings, do not synthesize it just to fill the Storybook matrix. Keep the
  named checkpoint explicit, make it fail loudly or mark it unsupported, and
  document what event family the future recording must include. This is
  especially important for reasoning-slot states: a tool/sub-agent recording is
  not evidence for `REASONING_*` ownership.
- Stateful runtime stories that use MSW, query caches, session ids, local
  storage, or transcript/session memory must isolate identity per story mount or
  explicitly reset the backing store. Reusing a fixed session/story id across
  docs canvases, reloads, and repeated iframe visits can create duplicate
  messages or stale state that looks like a product bug. Prefer deterministic
  checkpoint snapshots for docs pages; keep full progressive/replay flows in
  interaction tests or isolated stories with reset/unique identity seams.
- When a production message surface uses a framework/runtime adapter, prove that
  adapter path separately from prop-hydrated primitives. A direct markdown
  component story can prove leaf rendering and token styling, but it does not
  prove a shipped `MessagePrimitive.Content`, runtime message-part context,
  action-bar lifecycle, or stream-status contract. Add a runtime-backed story,
  component test, or Storybook runner assertion before claiming integration.
- If the user or plan narrows the slice to component/primitive proof only, keep
  Storybook evidence in that layer. A component story may be sufficient for
  token styling, safe props, hover/focus/click interactions, and visual parity,
  while production hooks, transcript adapters, framework action-bar lifecycle,
  and app-shell data population remain explicit follow-up. Do not call those
  follow-ups blockers for the component story unless the story/docs claim
  shipped runtime integration.
- For list-heavy content, verify visible and computed markers. Tailwind/reset
  styles can preserve indentation while suppressing bullets or numbers; check
  `list-style-type` for `ul`/`ol` and inspect the screenshot before calling the
  story correct.
- If Storybook dev mode is unreliable because of watcher/file-descriptor
  failures, use a static Storybook build as the visual QA surface instead of
  sending the user to a broken dev server. Serve the built `storybook-static`
  directory, then verify the exact `iframe.html?id=<story-id>&viewMode=story`
  URL and screenshot from that static server.
- Do not commit, push, or hand work back as complete until the exact changed
  story states have clean visual proof. If local Storybook cannot produce proof,
  report the blocker explicitly instead of letting the reviewer discover it in
  the browser.
- If the user asks "did you validate it?", answer from the completed evidence
  boundary. Figma MCP/code inspection plus component tests is not visual
  validation; say "not yet" until the current Storybook iframe has been
  screenshotted or visually inspected.
- If the user asks whether a story split or hierarchy is true, answer only
  after `agent-browser` has observed the running/static Storybook surface. If
  you have only edited files or built Storybook, say the claim is not validated
  yet.

## Start Checklist

1. Read the repo’s Storybook/runbook docs and nearest `AGENTS.md`.
2. Identify the story level and exact story ID you are targeting. Name what the
   story proves and what it does **not** prove before opening it for the user;
   for example, a container/composer story does not prove the outer shell,
   header, route wrapper, or sidebar states.
3. Start Storybook through the repo’s supported command.
4. Verify:
   - dependencies exist (`node_modules/.bin/storybook` or repo equivalent)
   - generated config exists if the repo imports it
   - the expected port is free or is served from the current worktree; if a PID
     file exists, check it matches the listener that `lsof` reports
   - manager URL returns `200`
   - target `iframe.html` returns `200` and visible story content, not an error
   - the screenshot/DOM reflects the current source after recent edits; if it
     still shows old classes or copy, treat the dev server as stale
5. For Figma-backed stories, inspect or capture the live Figma node/frame before
   making visual claims. Record the file/node/frame and inspection method.
6. Capture a screenshot of the target iframe or story canvas before making
   visual claims.
7. Inspect the screenshot against the live Figma image/context and, for
   semantic content, inspect the DOM shape behind it (tables, lists, headings,
   buttons, disabled states).
8. For story hierarchy or architecture-level claims, use `agent-browser` to
   verify the served `index.json` and relevant Storybook pages/iframes show the
   expected titles, story IDs, and visible content.
9. If verification fails, report the failure and keep working the setup/render
   issue; do not describe the story as ready or visually reviewed.

## Design Source Discipline

When comparing to Figma or another design source:

- Use the latest live design source whenever a Figma-backed story claims design
  parity or visual completion, not only when the user explicitly asks.
- If live Figma access is unavailable, state the limitation and compare only
  against cached repo docs or local exports. Call the Figma-parity proof
  incomplete.
- Prefer design tokens and named CSS variables over raw color values.
- Distinguish “baseline current-payload story renders” from “visual parity is
  achieved.” A working story can still be visually wrong.
- See `references/live-figma-parity.md` for the live-Figma plus Storybook
  comparison loop and state-separation pitfalls.
- See `references/story-canvas-harness-discipline.md` for keeping proof stories
  limited to actual imported product components plus clearly separated
  providers/MSW/runtime harnesses.
- See `references/storybook-architecture-level-validation.md` for validating
  primitive/component/composition placement with `agent-browser` before claiming
  the hierarchy is correct.
- See `references/primitive-first-story-surfaces.md` for the expected split
  between leaf primitive stories, focused tests, and assembled component or
  composition stories.
- See `references/primitive-aligned-runtime-snapshots.md` for checking that
  runtime/state snapshots still render through the visual primitive layer, not
  custom runtime-only chrome.
- See `references/ui-layer-naming-and-boundary-comments.md` for renaming active
  component layers after Storybook taxonomy review and adding ownership comments
  that prevent old adapter/container names from returning.

## Runtime And Payload Discipline

Do not seed Storybook with placeholder payloads and call that production proof.
For message, streaming, or agentic UI surfaces:

- Use the current generated SDK, runtime adapter, or transcript contract as the
  payload authority.
- Keep transient runtime activity separate from durable message content unless
  the current contract says otherwise.
- Add future-state stories only when they are explicitly labeled as design
  exploration or blocked/gap evidence.
- For partial streaming stories, prefer a deterministic fixture derived from a
  real recording up to a named event/checkpoint. If a repo has reducer or MSW
  helpers, use them to replay only that prefix and export the resulting client
  state; do not manually invent state that bypasses the actual runtime reducer.
- If a recording-backed app/story visibly leaks metadata-shaped fragments such
  as confidence JSON, provenance blobs, or tool payload text, inspect the raw
  recording events before blaming markdown rendering. Classify whether the
  fragments are durable orchestrator/message text, transient non-orchestrator
  text that should be hidden, or non-text metadata that the replay adapter
  accidentally appended. Do not add a UI sanitizer until that boundary is
  known. See `references/recording-backed-stream-states.md`.

## Common Pitfalls

- Storybook manager loads but the iframe is a Vite overlay.
- A stale Storybook process from another worktree owns the target port.
- The repo's Storybook stop/start target updates the PID file but does not stop
  the process actually listening on the port. The next iframe still serves the
  old worktree or old transformed module.
- Storybook `index.json` lists a story, but the browser-imported CSF module
  does not export it; this is often stale Vite/Storybook cache or a stale
  process, so inspect the transformed module before blaming the component.
  For newly added or renamed stories, verify both `index.json` and the
  transformed `*.stories.tsx` module before assuming the manager sidebar is
  enough.
  A common symptom is an iframe error that says "Couldn't find story matching
  id ... after importing a CSF file" while `index.json` lists the id. Treat that
  as stale iframe/module evidence: stop every listener on the old Storybook
  ports, clear local Storybook/Vite caches, restart on a fresh port if needed,
  then reopen the exact iframe before using the screenshot/readback as proof.
- Storybook `index.json` lists a newly added story, but the virtual
  `storybook-stories.js` importer map does not include the file and the iframe
  shows `importers[path] is not a function`. Restarting may not be enough when
  Vite/Storybook cache is stale; clear the local Storybook cache and restart,
  or move the state into an already-imported story file when speed matters.
- After a rebase, story titles, import paths, or story IDs may change even when
  your story export still exists. Re-query `index.json` and open the current
  story ID before declaring visual proof; do not reuse a pre-rebase iframe URL
  from memory or from earlier screenshots.
- Missing `generated/config.json` looks like a story failure.
- Missing `node_modules` starts a detached wrapper that exits immediately.
- Browser cache shows an old error after prerequisites are fixed; restart the
  Storybook server and reload the exact iframe.
- A visual screenshot still shows old layout/classes after a source edit. Probe
  the rendered DOM/computed styles and verify the serving process; do not keep
  tuning the component against stale output.
- A Storybook state combines mutually exclusive lifecycle states from Figma
  (for example a transient thinking indicator plus a completed response). Split
  the stories first, then compare each story to its own live Figma node/frame.
- File watcher exhaustion (`EMFILE: too many open files, watch`) means the
  local Storybook dev server is not reliable proof. Do not ask the user to
  inspect it until the watcher/setup issue is resolved or a static-build
  screenshot path has produced a clean render.

## References

- For a concrete local debugging and verification sequence, read
  `references/storybook-local-verification.md`.
- For shell/app-surface story selection and the `importers[path]` cache
  mismatch, read `references/shell-story-level-and-importer-cache.md`.
- For PID-file/listener mismatches, contaminated ports, and stale transformed
  modules after a nominal restart, read
  `references/port-identity-and-stale-module-proof.md`.
- For Figma-backed component parity checks, read
  `references/live-figma-parity.md`.
- For primitive-vs-composition and Storybook hierarchy claims, read
  `references/storybook-architecture-level-validation.md`.
- For primitive-first component libraries, read
  `references/primitive-first-story-surfaces.md`.
- For composed surfaces that pass a real child through a slot, read
  `references/slot-placeholder-vs-production-harness.md`.
- For assistant prose / markdown-rich content story coverage, read
  `references/markdown-rich-assistant-prose.md`.
- For recording-backed partial stream stories and MSW fixtures, read
  `references/recording-backed-stream-states.md`.
- If a live provider is down but UI streaming behavior still needs inspection,
  use a clearly named delayed MSW replay from the same recording-backed fixture
  path. Label it as local/MSW proof, keep non-delayed replay for fast tests, and
  do not report it as live-provider evidence. See
  `references/recording-backed-stream-states.md`.
- For streaming slot ownership, assistant-message append behavior, and pruning
  weaker duplicate tests after adding one shared event-stepper, read
  `references/streaming-transition-stepper-proof.md`.
- For persisted AG-UI recording checkpoint snapshots, selector comments, and
  unsupported recording states such as missing `REASONING_*` events, read
  `references/agui-recording-checkpoint-maintenance.md`.
- For contract-named runtime states whose assertions drift from their names,
  descriptions, or checkpoints, read
  `references/contract-named-runtime-states.md`.
- For Storybook Playwright runtime proof, browser-launch escalation, and
  avoiding brittle CSS-class assertions, read
  `references/storybook-playwright-runtime-proof.md`.
- For runtime-backed Storybook failures that reveal adjacent product defects,
  read `references/runtime-storybook-adjacent-defects.md`.
- For user browser comments on Storybook elements, read
  `references/browser-comment-storybook-review.md`.
