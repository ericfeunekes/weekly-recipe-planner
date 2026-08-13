# Runtime Storybook Docs Pages Vs Isolated Iframes

Use this reference when debugging runtime-backed Storybook stories, especially
stories backed by MSW, query caches, streaming sessions, localStorage, or
component runtimes.

## Core Distinction

Storybook docs pages and isolated story iframes are different proof surfaces:

- `?path=/docs/...` can render multiple canvases on the same page.
- Each docs canvas may mount a runtime/provider/MSW story instance.
- `play` functions may auto-run in docs mode depending on Storybook settings.
- Stateful harnesses can share process-global MSW/session memory across those
  canvases.
- The isolated iframe
  `iframe.html?id=<story-id>&viewMode=story` renders one story and is the
  canonical surface for executable assertions.

Therefore:

- Use docs pages for discovery and broad visual scanning.
- Use isolated iframes for proof claims and Playwright assertions.
- If a user reports an issue in docs mode, inspect both docs mode and isolated
  iframes before deciding the owner.

## Failure Patterns

### Duplicate Content

Common causes:

- A docs page renders multiple canvases of similar runtime stories.
- A stateful MSW/session harness uses a fixed session id, so repeated mounts or
  repeated sends append to the same in-memory transcript.
- Recorded stream events use a different run/session identity than the
  terminal transcript refetch, so the client preserves the in-flight run and
  also accepts the server run as a second run.
- The running Storybook server is stale and still serves old story modules.

Useful checks:

- Query the served `index.json` and confirm the current story ids match source.
- Compare the listener PID/cwd with the repo PID file; do not trust the PID file
  alone.
- Open the isolated iframe for the reported story and count the relevant
  visible text.
- Inspect whether the story's runtime/session id is unique per mount or the
  MSW handler resets state between stories.
- For recorded streams, verify event `runId`/`threadId` align with the mock
  transcript run/session returned after terminal refetch.

### Flash Of Raw Markdown Or Metadata

Common causes:

- The docs page is showing an intermediate or stale canvas while another canvas
  updates.
- A story is hydrating from raw text before the production/runtime markdown
  adapter takes ownership.
- The recording contains metadata/tool/result-envelope fragments that are
  currently emitted as orchestrator text.
- The story's proof claim uses a full replay fixture even though only a
  checkpoint snapshot is visually clean.

Useful checks:

- Capture the exact docs surface the user sees and an isolated iframe for the
  same story.
- Search the recording or fixture for the raw fragment to determine whether it
  is fixture content or renderer output.
- Add/adjust a Playwright assertion for the raw fragment only if that story is
  intended to prove the full visible output.
- If the raw fragment is known unsupported metadata leakage, either route a
  product fix or remove that full replay story from completion evidence and
  keep checkpoint snapshots as the current proof surface.

## Preferred Remediation

- For docs-visible runtime snapshots, prefer deterministic checkpoint state
  derived from the canonical replay path over click-to-run full streams.
- Give each stateful story mount a unique identity, or reset its state store
  before the story starts.
- Keep full progressive replay proof in Playwright/runtime tests where the test
  owns setup, action timing, and cleanup.
- Update Storybook Playwright specs whenever story exports change. A green
  previous spec against removed controls is stale evidence, not coverage.
- Report proof boundaries precisely: docs visual scan, isolated iframe visual
  proof, Storybook Playwright browser proof, static Storybook build, app route
  e2e, or live deployed QA.
