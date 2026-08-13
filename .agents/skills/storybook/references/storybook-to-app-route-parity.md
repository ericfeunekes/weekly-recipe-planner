# Storybook To App Route Parity

Use this when a user reports that a component looks right in Storybook but wrong
in the actual app route, host shell, or local dev URL.

## Core Lesson

Storybook proves the component or harness surface it renders. It does not prove
that the production route has the same parent slots, viewport constraints,
runtime scenario, config, or shell layout. If the user's evidence is from an app
route, verify that route before saying the Storybook fix works.

## Typical Failure Pattern

- A leaf or composition story has the correct max width, spacing, or state.
- The app route renders the same inner component inside a different shell or
  viewport.
- The true owner of the missing behavior is one layer higher or lower than the
  story being inspected.
- Automated Storybook tests pass because they never open the route that the
  user is looking at.

Example class: assistant message prose has a max width, but the app route still
looks left-aligned because the thread/message-list column is full width. The
fix belongs in the thread viewport's message column, not only in the prose
primitive.

## Verification Pattern

1. Reproduce the user-visible route or host URL, with the same query params,
   hash route, mock scenario, and submit/action sequence.
2. Inspect the DOM geometry at the owner boundary:
   - outer shell/main area;
   - message zone or content slot;
   - thread viewport;
   - message column;
   - message bubble/prose primitive.
3. Read computed width, max-width, margins, and bounding boxes for the exact
   element that should enforce the layout.
4. Compare against the Storybook story that passed. If Storybook proves only a
   child primitive, add a composition/app-route proof for the parent owner.
5. Add a regression assertion at the owner that actually fixes the issue, not
   only at the visible symptom.

## In-App Browser Running-App Proof

When the user asks for QA in the Codex in-app browser, treat that as part of the
completion contract. A separate Storybook run, static build, or headless
Playwright probe can support debugging, but it is not the requested proof.

Use this sequence:

1. Try to attach to or open the user-visible app route in the in-app browser.
2. If the current in-app tab is not exposed, open the same route through the
   in-app browser rather than switching immediately to a different browser.
3. If the local HTTPS dev server hits a certificate/interstitial boundary, do
   not bypass the interstitial. Start a repo-supported HTTP/non-HTTPS local dev
   instance or equivalent same-app mock route on another port and load that in
   the in-app browser.
4. Drive the same recording, scenario, query params, hash route, and user
   action sequence that produced the report. Do not validate only the landing
   state if the bug appears after a submit/replay step.
5. Inspect the rendered app DOM and computed styles at the real route, then
   capture a screenshot/readback from that in-app browser tab.
6. Report the exact URL/protocol/port used and why it is equivalent. For
   example: "HTTPS localhost was blocked by the local certificate, so I ran the
   same mocked app over HTTP on port 3001 and drove the same replay recording in
   the in-app browser."

This pattern captures the fix for setup friction without hard-coding a durable
"browser cannot load localhost" rule. The durable rule is: preserve the
requested running-app/browser proof boundary and use a safe equivalent local
route when certificate or protocol setup blocks the default URL.

## Evidence Language

Say which layer was proven:

- "Storybook composition proof: the message column has max width."
- "App-route proof: the same route shows the centered message column inside the
  shell."
- "Not yet proven: production auth/host/live backend."

Avoid saying "Storybook is green, so the app is fixed" when the user's evidence
came from the app route.
