# Storybook Architecture-Level Validation

Use this when the work claims that stories are split correctly across
architecture levels such as `00 Primitives`, `01 Components`, `02
Compositions`, runtime, or host surfaces.

## Rule

Do not claim a primitive/component/composition split is correct from source
files alone. Validate the served Storybook surface in a browser first. If the
user is looking at the Codex in-app browser, validate that exact browser surface
with the `browser` plugin; a separate `agent-browser` session is not enough to
prove what the user sees.

This matters because Storybook can be stale, the manager can show old entries,
CSF files can build into unexpected IDs, and a visually valid composition can
still be filed under the wrong architecture level.

## Minimal Proof Loop

1. Start or serve Storybook using the repo-supported path. If dev Storybook is
   unreliable, build static Storybook and serve `storybook-static`.
2. Open the served Storybook manager or iframe with the relevant browser tool:
   use `browser` for the Codex in-app browser when the user is watching that
   tab, and use `agent-browser` for standalone/local browser proof when no
   user-visible in-app tab is the target.
3. Query the served story index, not local source assumptions:

   ```bash
   agent-browser open "http://127.0.0.1:6010/?path=/story/<story-id>"
   curl -s http://127.0.0.1:6010/index.json
   ```

4. Confirm the relevant entries have the expected `title`, `name`, and story
   IDs. For example, a primitive-first message split should show leaf stories
   under `Chat/00 Primitives/...` and assembled response states under
   `Chat/02 Compositions/...`.
5. Open at least one representative primitive iframe and one representative
   composition iframe with the same browser surface you will cite.
6. Run a DOM snapshot or capture screenshots to confirm the visible content
   matches the claimed level. A primitive story should render only the leaf or
   small component; a composition story may assemble multiple primitives.
7. If the manager sidebar or docs iframe remains stale, do not keep arguing from
   `index.json`. Re-open the exact iframe, reload the in-app tab, or serve the
   freshly built static Storybook on a clean no-cache port and then re-verify
   the user-visible browser.

## What To Report

Report the served story IDs and what each level proves. Also report what is not
proved. For example:

- `chat-00-primitives-message--assistant-text` proves the assistant text leaf
  typography only.
- `chat-02-compositions-messageresponse--full-response-static-state` proves the
  assembled static response state.
- Neither story proves runtime streaming, cache behavior, route integration, or
  a new markdown renderer unless those paths are explicitly wired and verified.

## Pitfalls

- Do not say "opened Storybook" when you only opened the manager shell. Open the
  specific iframe or inspect the served index.
- Do not call a hierarchy change done after `build-storybook` alone. The build
  can contain the right bundle while the browser session is still pointed at a
  stale dev server.
- Do not answer a screenshot showing stale manager/sidebar state by saying it is
  only a bad deep link. Inspect the current user-visible browser. Storybook can
  have a correct `index.json` while the manager iframe still renders an old or
  missing docs/story ID.
- Do not let a composition story masquerade as primitive evidence. If the story
  assembles multiple leaf surfaces, it belongs at the component/composition
  level even when the underlying code file is named "Primitives".
