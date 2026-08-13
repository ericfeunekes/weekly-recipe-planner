# Live Figma Parity For Storybook Stories

Use this reference when a Storybook story claims to implement, validate, or
match a Figma-backed state.

## Required Evidence Pair

Every Figma-backed visual claim needs two fresh artifacts from the same pass:

1. **Live Figma source evidence** — inspect or capture the current Figma
   file/node/frame through the repo-configured MCP/API path. Record the file key
   and node/frame ID. Cached repo docs can point to the node; they are not proof.
2. **Rendered Storybook evidence** — open the exact
   `iframe.html?id=<story-id>&viewMode=story` URL and capture or inspect the
   rendered story. The manager page is not enough.

If either side is missing, answer with the exact incomplete boundary, such as
`Storybook renders, but live Figma parity is unproved`.

## Comparison Loop

1. Identify the canonical Figma states and their node IDs.
2. Identify the matching Storybook story IDs.
3. Inspect live Figma first using the repo-configured Figma/MCP/API path. Do
   not write "if Figma is blocked" as a residual caveat before attempting the
   read. If access is actually blocked after the accepted access path is tried,
   stop the parity claim and label the proof incomplete.
4. Inspect the Storybook iframe screenshot and DOM shape.
5. Compare state, layout, typography, spacing, colors, icons, overflow, and
   action affordances.
6. Patch obvious deltas, then re-run code checks and re-capture Storybook.
7. Report remaining deltas explicitly instead of calling the story validated.

## Lifecycle-State Pitfall

Do not merge mutually exclusive Figma states into one "full" story. A transient
loading/thinking row is execution chrome and should not appear in the completed
message-response story unless the live design shows both at once. Split stories
by lifecycle state first, then compare:

- prompt sent / thinking: user prompt plus loader/status only
- completed response: durable response content, sources, and actions only

## Stale Storybook Pitfall

If a screenshot still shows old fixture text, old classes, or old layout after
editing the story, treat the visual proof surface as stale. Do not keep tuning
against that screenshot. Verify the serving process and story index. If dev
Storybook is unreliable, run a static build and serve `storybook-static`, then
capture the static iframe.

## Completion Wording

Use precise evidence wording:

- `Live Figma inspected: <file/node>. Storybook iframe captured: <story-id>.
  Remaining deltas: ...`
- `Storybook opens, but Figma parity is incomplete because live Figma was not
  inspected.`
- `State model corrected; visual parity still has the following gaps: ...`
