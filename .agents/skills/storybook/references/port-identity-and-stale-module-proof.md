# Port Identity And Stale Module Proof

Use this reference when Storybook appears to start or restart, but screenshots,
DOM probes, or iframe errors suggest the page is not rendering the current
source.

## Failure Pattern

The dangerous shape is not "Storybook is down." It is a false-positive proof
surface:

- The manager page or `index.json` returns `200`.
- A repo start command reports a new PID file.
- The iframe renders a plausible component state.
- But the port is still owned by an older process from another worktree, or the
  preview is serving a stale transformed module after HMR/restart churn.

Do not use screenshots from that state as visual evidence. They may look close
enough to the current branch to hide the fact that you are reviewing old code.

## Identity Checks

Before trusting a Storybook iframe, prove the listener and the intended
worktree agree:

```bash
cat .storybook.pid 2>/dev/null || true
lsof -nP -iTCP:<port> -sTCP:LISTEN
lsof -nP -p <listener-pid> | head -40
curl -s "http://127.0.0.1:<port>/index.json" | jq '.entries | length'
```

Compare the PID from `.storybook.pid` with the PID from `lsof`. If they differ,
the repo stop/start target did not control the process that owns the port. Stop
or avoid that listener before capturing evidence.

If the iframe body or error mentions an absolute path from another checkout,
that is conclusive server-identity failure. Stop diagnosing component code and
fix the server boundary.

## Fresh-Port Recovery

When a port is contaminated and stopping it safely is not the current task, use
a fresh unused port:

```bash
STORYBOOK_PORT=<fresh-port> make storybook-start-bg
curl -s "http://127.0.0.1:<fresh-port>/index.json" | jq '.entries | length'
lsof -nP -iTCP:<fresh-port> -sTCP:LISTEN
```

Wait until `index.json` has entries. A manager shell with an empty `entries`
object is not ready evidence. If the preview takes minutes to build, wait; do
not substitute the already-contaminated port because it is faster.

## Stale Module Checks

After editing a component, a screenshot that still shows old layout, classes, or
copy is a proof failure until explained. Use a DOM/computed-style probe before
changing code again:

```js
const target = [...document.querySelectorAll("span,button,header,div")].find(
  (el) => el.textContent?.includes("Expected visible text"),
);
const r = target?.getBoundingClientRect();
return {
  className: target?.getAttribute("class"),
  display: target ? getComputedStyle(target).display : null,
  rect: r && { x: r.x, y: r.y, width: r.width, height: r.height },
};
```

If the DOM still contains old classes, the visual proof surface is stale. Verify
the listener PID/cwd, restart on a fresh port, clear Storybook/Vite cache if the
repo supports it, or fall back to a static Storybook build.

## Visual Claim Discipline

When asked whether primitives "match Figma" or are "properly set up," separate
the evidence levels:

- Figma MCP/design-context read proves the intended source shape.
- Component tests prove deterministic behavior and accessibility-facing states.
- Storybook iframe screenshots prove rendered visual/layout behavior.
- Constrained-width screenshots prove the composed shell owns its layout under
  real host pressure.

Answer "not fully yet" if only the first two are done. After screenshot QA, name
the exact story IDs, viewports, and screenshot paths used as evidence.

## Resource Cleanup And Open-File Recovery

Storybook/browser QA can leave several long-running processes, file watchers,
trace writers, and browser profiles open. If later file reads, shell commands,
or test launches fail with an OS-level open-file limit, treat it as cleanup
debt from the QA harness rather than a broken tool.

Recovery pattern:

1. Stop the repo-owned Storybook server with its supported stop target.
2. Verify the port is actually free with `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
3. Close or kill stale Storybook/Playwright/browser processes only when they are
   clearly the current QA harness owner, not arbitrary user browser sessions.
4. Remove transient `test-results/` or screenshot folders unless the active
   proof contract asked to retain them.
5. Retry the original file read or proof command.

Capture the fix as "clean up stale QA processes and retry". Do not harden the
transient symptom into a durable claim that the browser, Storybook, or shell
tooling does not work.
