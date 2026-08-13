# Primitive-First Story Surfaces

Use this when a UI task is decomposing a designed feature into reusable
Storybook primitives before assembling components or compositions.

## Core Rule

Primitive-first Storybook work is not satisfied by one broad story file that
exports many loosely related states. If the UI has distinct leaf primitives,
each leaf needs its own Storybook namespace, its own state coverage, and its own
focused tests before higher-level stories assemble them.

Examples of separate leaf surfaces:

- `Chat/00 Primitives/UserMessageBubble`
- `Chat/00 Primitives/AssistantProse`
- `Chat/00 Primitives/InlineCitationBadge`
- `Chat/00 Primitives/AssistantSourcesFooter`
- `Chat/00 Primitives/AssistantMessageActionRow`
- `Chat/00 Primitives/AssistantThinkingIndicator`

The assembled transcript, response card, shell, or full page belongs in a
component/composition namespace such as `Chat/01 Components/...` or
`Chat/02 Compositions/...`.

## Required Shape

For each leaf primitive:

1. Create a dedicated `*.stories.tsx` with a title ending in the leaf name, not
   a generic grouped title like `MessagePrimitives`.
2. Include states that exercise the leaf's own contract: default, long/overflow,
   disabled/unavailable, empty, interaction, or narrow-host states as relevant.
   For deferred product actions, make the default/current story match the
   shipped state: disabled, non-interactive, omitted, or placeholder chrome.
   Put any future-clickable version in a separately named story such as
   `FutureInteractive` and label it as not yet production-owned.
3. Add a focused `*.component.test.tsx` for that leaf's behavior and accessible
   contract. Do not rely only on a grouped test file that happens to import all
   the primitives.
4. If Figma-backed, inspect the live Figma node for that leaf and cite the
   node/frame in the story docs or visual-QA artifact.
5. Use `agent-browser` or the repo browser surface to verify the served
   Storybook index and iframe show the leaf as its own surface.

For assembled components/compositions:

1. Import and compose the leaf primitives.
2. Keep runtime/provider behavior out unless the story is explicitly
   runtime-backed.
3. Label the story as component/composition evidence, not primitive evidence.
4. Verify at least one representative assembled iframe after the leaf surfaces
   pass.

## Pitfalls

- A file named `MessagePrimitives.tsx` can export many primitives, but the
  Storybook taxonomy should still expose those leaves independently.
- A docs page for one grouped meta export can make unrelated leaves look like
  states of a single component; split them before claiming primitive-first.
- Storybook manager caches can show stale titles. Verify the served `index.json`
  and the actual iframe or use a fresh static port before telling the user the
  hierarchy is fixed.
- Story-local `fn()` handlers can accidentally turn a deferred production
  placeholder into an enabled-looking control. If a future flow is out of
  scope, the primary primitive and assembled stories should not pass a callback
  just to make the control clickable.
- If a markdown renderer replacement is only a future target, label the
  assistant-text story as typography/layout proof, not renderer proof.
