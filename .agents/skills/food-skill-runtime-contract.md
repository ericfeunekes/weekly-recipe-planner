# Food-Skill Runtime Contract

The embedded agent must treat the planner host as the only durable-effect
authority. For a planner mutation, it reads canonical state, previews the
ordered operation batch against the returned planner version, applies only the
accepted batch, then reports the host readback.

Current supported planner facts:

- A meal can be updated, moved, reordered, and replaced with a sourced recipe
  candidate.
- Prep is a date-owned queue of references to canonical instruction steps.
- Groceries are derived 1:1 from meal recipe ingredient objects. Their current
  operations organize source/check state, not new grocery text or calculations.
- Closeout currently supports a meal-level `repeat` / `modify` / `drop` value,
  leftover quality, and a week lesson; rich cook notes, taste history,
  recipe-library promotion, and a canonical recipe library need their own
  explicit operations.

Use public web search for public sources. The current runtime does not expose
Chrome Bridge, browser/computer control, apps, or connectors. Do not use the
Chrome plugin as a substitute. If a future runtime explicitly exposes Chrome
Bridge for an authenticated personal-browser task, use that boundary; otherwise
report it unavailable. Never attempt direct browser, filesystem, database,
shell, connector, or API access.
