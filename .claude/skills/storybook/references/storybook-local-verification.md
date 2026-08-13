# Storybook Local Verification Notes

This reference captures a portable debugging sequence from a session where the
Storybook manager served but the target story was not the current branch’s
render.

## Verify The Serving Worktree

When a Storybook URL is open but content looks stale or wrong:

```bash
lsof -nP -iTCP:<port> -sTCP:LISTEN
lsof -nP -p <pid> | head -40
```

Check the process `cwd`. If it points at another worktree, stop that process
before starting Storybook for the current branch. Do not diagnose the component
against another checkout’s Storybook server.

## Verify Manager And Iframe Separately

```bash
curl -I http://127.0.0.1:<port>
curl -I 'http://127.0.0.1:<port>/iframe.html?id=<story-id>&viewMode=story'
curl -s 'http://127.0.0.1:<port>/iframe.html?id=<story-id>&viewMode=story' | head
```

The manager can return `200` while the iframe returns `500` or renders a Vite
error overlay. Use the iframe body and Storybook log to identify the actual
failure.

Also verify the story index has real entries before treating the server as
ready:

```bash
curl -s "http://127.0.0.1:<port>/index.json" \
  | jq '.entries | length'
```

An empty `entries` object means the manager shell is not usable proof yet. Wait
for indexing to finish, inspect the Storybook log, or verify you are not talking
to a different process. If the iframe body contains an absolute path from
another checkout, the port is owned by a stale worktree even when the manager
page itself looks healthy.

Do not assume the port you requested is the port Storybook actually bound. Some
repo wrappers choose or reuse a different port and print the authoritative URL
only after preview startup. If a probe to the requested port fails, inspect the
Storybook log for the "Storybook ready" URL, then query that URL's
`index.json`. Continue verification from the port proven by the ready log and
index readback, not from the launch command's requested port.

## Screenshot Before Closeout

For component/story changes, the closeout proof must include a screenshot or
equivalent visual inspection of the exact target story. A typecheck, story
index entry, manager-shell `200`, or `iframe.html` HTML shell is not enough.
Confirm the screenshot shows the intended component state, not:

- a Vite or Storybook error overlay;
- "Couldn't find story matching id ...";
- a stale render from an old Storybook/Vite cache;
- content served from a different worktree that happens to own the same port.

If the screenshot shows a problem, keep debugging and report the issue as a
blocker or finding instead of asking the user to open Storybook.

If you cannot obtain a clean screenshot because the local Storybook server is
failing, say that plainly. Do not soften it into "ready except visual QA" when
the user's next action would be opening a broken story.

This is also a commit/push handoff gate. If the branch is being handed to a
teammate, do the screenshot/readback first. A pushed branch that leaves the
reviewer to discover a Storybook error, stale module, or missing visual state
has failed the UI QA workflow even if typecheck and build passed.

## Static Build Fallback For Watcher Failures

When Storybook dev mode is stuck in file watcher failures such as:

```text
Watchpack Error (watcher): Error: EMFILE: too many open files, watch
```

do not keep restarting dev mode and do not tell the user to inspect the page.
Use a static Storybook build as the proof surface:

```bash
mise exec -- npm run build-storybook
uv run python -m http.server <port> --directory storybook-static
```

Then verify the exact iframe:

```bash
curl -I "http://127.0.0.1:<port>/iframe.html?id=<story-id>&viewMode=story"
```

Capture the screenshot from that static iframe. If the static build succeeds
and the screenshot shows the intended rendered state, this is a valid visual QA
fallback for component work because it avoids the unreliable watcher layer.

## Common Setup Fixes

- Missing dependencies: install through the repo’s documented dependency flow.
- Missing generated config: run the repo’s config generation command before
  restarting Storybook.
- Cached Vite error after fixing setup: restart Storybook and reload the exact
  iframe.
- Stale Storybook process from another worktree: identify the listener with
  `lsof`, check the process `cwd`, stop that process, then restart from the
  current worktree.
- Empty `index.json`: do not capture screenshots yet. Wait for indexing,
  inspect `storybook.log`, and confirm the listener belongs to the current
  worktree. A manager `200` with zero indexed stories is not visual evidence.
- Stale Storybook/Vite CSF cache: when `index.json` lists a story but the
  iframe says `Couldn't find story matching id ... after importing a CSF file`,
  fetch the transformed story module and inspect its exports:

  ```bash
  curl -s "http://127.0.0.1:<port>/src/path/to/Story.stories.tsx" \
    | rg "StoryExportName|__namedExportsOrder"
  ```

If the export is missing from the transformed module while present in the
source file, stop Storybook, clear the local Storybook/Vite cache, restart,
and re-check the exact iframe.

For newly added stories, verify both sides:

```bash
curl -s "http://127.0.0.1:<port>/index.json" \
  | jq '.entries["<story-id>"]'
curl -s "http://127.0.0.1:<port>/src/path/to/Story.stories.tsx" \
  | rg "ExportName|__namedExportsOrder"
```

If `index.json` lists the story but the transformed module omits the export,
the sidebar can advertise a story that the preview cannot render. Clear cache
or use the static-build fallback before asking anyone else to open it.
- Watcher exhaustion: repeated `EMFILE: too many open files, watch` means
  Storybook is not a trustworthy live proof surface. Stop stale Storybook/Vite
  processes, raise the file descriptor limit if the repo supports it, or use the
  static-build fallback above. Do not report visual completion from a server
  stuck in EMFILE errors.

Example failure class to recognize:

```text
Failed to resolve import "../../../generated/config.json"
```

This is a setup prerequisite problem, not a visual component regression.

Example stale-index class to recognize:

```text
Couldn't find story matching id '...' after importing a CSF file.
The file was indexed as if the story was there, but then after importing the
file in the browser we didn't find the story.
```

This is usually an index/import disagreement, not a design bug. Verify the
transformed CSF module and clear stale cache/processes before changing the
component.

## Content-Specific Story Proof

When a story is meant to cover rich content, verify the rendered structure:

- Markdown tables must render as an actual table element, not raw pipe text.
  With `react-markdown`-based renderers this usually requires `remark-gfm` or
  an equivalent GFM/table plugin.
- Nested lists must preserve hierarchy in the DOM, not just visually indent by
  copied whitespace.
- CSS resets can remove list markers while leaving indentation. Inspect
  `list-style-type` for `ul`/`ol`; expected examples are `disc` / `circle` for
  nested bullets and `decimal` / `lower-alpha` for nested ordered lists when the
  story claims those states.
- Headings/subheadings must use the intended typography tokens in the rendered
  component, not only in story fixture text.

Use browser inspection or a targeted Playwright/agent-browser probe to assert
the DOM shape when screenshots alone could miss the semantic regression.

Example probe shape:

```js
Array.from(document.querySelectorAll("ul, ol")).map((el) => {
  const style = getComputedStyle(el);
  return {
    tag: el.tagName,
    listStyleType: style.listStyleType,
    paddingLeft: style.paddingLeft,
    text: el.textContent?.trim(),
  };
});
```

## Design/Figma Refresh

When the user asks whether a story matches latest Figma, do not rely only on
repo-captured Figma notes. Use the repo’s configured Figma MCP/API path if
available. If a session does not expose the Figma MCP tools or the credential
is not usable, say so and label any comparison as based on cached docs or local
exports only.

Do not encode “Figma is unavailable” as a durable rule. The durable lesson is:
try the configured live design source first, and state the evidence basis.
