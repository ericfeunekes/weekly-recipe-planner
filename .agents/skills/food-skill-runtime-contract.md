# Food-Skill Runtime Contract

The embedded agent must treat the planner host as the only durable-effect
authority. For a planner mutation, it reads canonical state, previews the
ordered operation batch against the returned planner version, applies only the
accepted batch, then reports the host readback.

Current supported planner facts:

- A meal can be updated, moved, and reordered. Although the generic command
  registry accepts a shape-valid sourced replacement, the native planner path
  does not bind it to an observed source capture and reviewer verdict, so food
  skills must treat sourced replacement as unavailable.
- Prep is a date-owned queue of references to canonical instruction steps.
- Groceries are derived 1:1 from meal recipe ingredient objects. Their current
  operations organize source/check state, not new grocery text or calculations.
- Closeout currently supports a meal-level `repeat` / `modify` / `drop` value,
  leftover quality, and a week lesson; rich cook notes, taste history,
  recipe-library promotion, and a canonical recipe library need their own
  explicit operations.
- The host contains a candidate-binding helper, but the native planner
  preview/apply path does not invoke it and does not capture the source recipe or
  reviewer verdict. Upstream mechanical and independent verification can
  prepare a candidate, but no food skill may preview or apply that sourced
  replacement until capability readback proves host enforcement.

Actual household food planning uses the persistent production planner. A
Portless worktree may validate code and the release-owned skill bundle, but it
is not an alternate household plan. Before reporting success, read the
production workspace and open the rendered target week: a successful operation
does not prove that the household can see the intended meal, ingredients,
instructions, sources, or timing.

Use public web search for public sources. The current runtime does not expose
Chrome Bridge, browser/computer control, apps, or connectors. Do not use the
Chrome plugin as a substitute. If a future runtime explicitly exposes Chrome
Bridge for an authenticated personal-browser task, use that boundary; otherwise
report it unavailable. Never attempt direct browser, filesystem, database,
shell, connector, or API access.
