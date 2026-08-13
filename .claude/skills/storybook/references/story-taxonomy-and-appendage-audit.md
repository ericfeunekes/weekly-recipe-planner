# Story Taxonomy And Appendage Audit

Use this when a Storybook review surfaces questions like:

- "Shouldn't this story have more states?"
- "Why is this under this Storybook folder?"
- "Why do we have a legacy story in the current surface?"
- "Where did this extra button/control/label come from?"

These are not minor comments. They often mean the story surface is not a
trustworthy evidence surface yet.

## Taxonomy Audit

1. Compare the served Storybook title and sidebar group to the repo's local
   architecture levels. Do not rely only on the CSF `title` in source; query
   the running `index.json` or inspect the browser sidebar.
2. Put leaf primitives under primitive/component levels, composed product
   surfaces under composition levels, and provider/MSW/cache/live-runtime
   stories under runtime levels.
3. Do not keep "Legacy" stories in a current evidence namespace. Either:
   - rename them as explicit fallback/current behavior,
   - move them under a retired/legacy namespace, or
   - delete them when they no longer represent a supported state.
4. If a composed surface is used as completion evidence, include the state
   matrix the component can actually be in: empty/landing, fallback/no child,
   active/progress, populated, overflow/error/disabled as applicable.
5. Make story names describe the state, not the implementation class. A story
   called `ThreadSectionNew` or `ContainerV2` is less useful than a story group
   named for the product surface and state it proves.

## Appendage Audit

Inspect the rendered canvas and ask: "Would this exact control/text appear in
the shipped product surface?" If not, it is an appendage, even if it comes from
a real library primitive.

Common appendages:

- raw framework/library utility buttons such as scroll-to-bottom controls
- "Show code", debug panels, status labels, or harness controls inside the
  product canvas rather than outside it
- default primitive text that was never designed
- stale story controls left from click-to-run harnesses after switching to
  snapshot stories
- placeholder chrome that still looks interactive

For appendages:

1. Identify whether the owner is the product component, the story harness, or
   the Storybook manager/docs UI.
2. Remove or hide product-surface appendages unless they are a designed
   component state.
3. If the affordance is needed, wrap it in the product's designed primitive and
   give it its own state coverage.
4. Add negative assertions in component tests and Storybook Playwright tests
   for unwanted appendages that a user already caught.
5. Re-open the same user-visible docs page and the isolated iframe after
   restarting Storybook; stale servers frequently keep old appendages visible
   after source fixes.

## Evidence Language

Good:

- "The composed thread surface is under `Chat/02 Compositions`, and the runtime
  checkpoint snapshots remain under `Chat/03 Runtime`."
- "The docs page and isolated iframe no longer render the raw scroll control;
  component and Storybook browser tests assert it is absent."

Bad:

- "The test passed, so Storybook is fine."
- "That control is from the library, not us."
- "Legacy Empty is harmless." If it appears in a current evidence namespace,
  it communicates current product behavior.
