# Storybook Playwright Runtime Proof

Use this pattern when Storybook is the right browser surface for a runtime or
stateful UI behavior: the app route/auth/host shell is too heavy or orthogonal,
but component tests are too mocked to prove browser-visible behavior.

## What It Proves

Storybook Playwright can prove:

- the exact story iframe renders in a real browser;
- user interactions in the story drive the real story harness;
- runtime-backed providers, MSW scenarios, stream consumers, and framework
  primitives behave in the DOM;
- console/page errors do not include known runtime loop/snapshot failures;
- visible ordering, state, and content match the user-facing claim.

It does **not** prove production route/auth/host boot, deployed environment
state, or live-provider behavior. Keep those as separate proof lanes.

## Command Shape

Prefer a repo-owned Playwright config/project for the Storybook lane:

```bash
npx playwright test -c playwright.storybook.config.ts --project=<runtime-slice>
```

The config should start Storybook with the needed env, usually MSW enabled, and
open `iframe.html?id=<story-id>&viewMode=story` directly. Do not assert against
the Storybook manager shell when the proof claim is the rendered component.

Before trusting the lane, compare the current served `index.json` with the
story ids the spec opens. Runtime stories often get renamed or narrowed while
the Playwright spec still points at old controls or removed exports. A browser
test that times out waiting for a stale control is a stale-proof problem, not
evidence about the component under test.

If a sandboxed run fails before tests execute because Chromium cannot launch
with platform permission errors, retry the same command with the runtime's
approved browser/GUI escalation path. Record the first failure as a launcher
boundary, not as a product/test failure.

## Assertions

Assert user-visible behavior and stable semantic hooks:

- exact visible text/order when the claim is chronology;
- `data-testid`, ARIA roles, status text, or stable story controls when
  available;
- console/page errors filtered to the defect class being guarded;
- scenario status/control state when the story exposes it.

Avoid brittle assertions based on implementation-only CSS classes, DOM grouping,
or incidental wrapper order. If a CSS-class assertion fails but the error
snapshot shows the visible behavior is correct, patch the test toward visible
semantics rather than locking the old implementation detail back in.

For stateful stories, assert the user-visible invariant and also guard against
state leakage:

- count repeated user/assistant text when duplicate runs are the risk;
- assert raw metadata/tool/result-envelope fragments are absent when visual
  cleanliness is the claim;
- verify one story run does not depend on previous docs-page or iframe visits;
- prefer unique story/session ids or explicit MSW state reset over fixed ids
  reused across docs canvases.

## Relationship To Other Storybook Checks

Run both lanes when both claims matter:

- Static `build-storybook` proves the Storybook bundle compiles.
- Storybook Playwright proves selected stories work in a browser.
- Manual/readback QA of the user-visible docs page proves what the user is
  actually looking at. It can reveal docs-mode-only issues that isolated iframe
  Playwright tests intentionally do not cover.

Neither substitutes for the other. A Storybook browser test can pass while an
unrelated story fails to build, and a static build can pass without exercising
the runtime interaction path.

## Static Checkpoints Versus Runtime Stories

For streaming or other event-driven UI, keep two Storybook proof modes
separate:

- **Static checkpoint stories** may replay a recorded prefix through the
  reducer/stepper and seed a production-equivalent runtime with the resulting
  messages/state. They are excellent visual checkpoint evidence, but they do
  not prove send, transport, cache invalidation, or refetch behavior.
- **Runtime/MSW stories** should mount the actual runtime hook/harness and
  drive the local send/stream/reducer/cache path. Use these when the claim is
  that Storybook proves the production-shaped local runtime boundary, not just
  a projected checkpoint state.

When both exist, prefer Playwright coverage over the runtime/MSW story for
the broad "streaming path works locally" claim. Keep static checkpoint
Playwright cases for stable named states such as tool-active, stale owner, or
terminal cleanup. If a static long-recording checkpoint is brittle in browser
because of Storybook overlay/state issues but an equivalent runtime/MSW story
proves the broader path, remove or downgrade the brittle browser case rather
than weakening assertions across the suite.

For recordings with unsupported event families, do not create a synthetic
Storybook state under a recording-backed name. Add a separately named synthetic
debug/story state only when the fake has a specific purpose, and keep it out of
claims about recording-backed runtime coverage.

## Handoff Language

When reporting Storybook Playwright proof, say:

- which command/config/project ran;
- how many tests passed;
- whether the first attempt failed at browser launch and required escalation;
- whether any assertion had to be corrected from implementation detail to
  visible behavior;
- which proof boundary remains outside Storybook.
