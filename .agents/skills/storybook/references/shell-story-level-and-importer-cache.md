# Shell Story Level And Importer Cache

Use this reference when a Storybook session is meant to show a composed shell,
route-level surface, or open/closed navigation state.

## Lesson

Do not substitute an inner component story for a shell claim. A story for a
chat panel, composer, card, drawer body, or other inner component can render
correctly while omitting the header, outer shell, route wrapper, sidebar rail,
or host chrome that the user is asking to inspect.

Before opening Storybook for the user:

1. State the claim the story is supposed to prove.
2. Pick the matching architecture level: component, composition, runtime flow,
   or host/app surface.
3. If the claim includes shell chrome or navigation state, verify a story that
   renders the production shell or a named shell harness.
4. Include explicit states such as `Closed`, `Open`, `Hover`, `Error`, and
   `Loading` when those are part of the user-visible contract.
5. Make state setup deterministic. For open/closed navigation, prefer a
   controlled story harness or a `play`/browser interaction that asserts the
   expected open content. Avoid `setTimeout(...querySelector(...).click())`
   setups that silently no-op when labels, locale, timing, or DOM structure
   changes.
6. Verify the exact iframe for each state, not just the manager page or docs
   route.

If the only existing story is one level too low, add or update a shell-level
story rather than telling the user to inspect the lower-level story.

When placing shell proof in Storybook, avoid hiding a current shell story under
a retired, legacy, debug, or compatibility namespace unless the story is
explicitly temporary and labelled that way. If the user is trying to inspect a
current routed shell, the Storybook sidebar should make that current proof
surface discoverable at the matching architecture level, not under a name that
teaches future reviewers to treat it as retired evidence. A compatibility file
can be a short-term importer-cache workaround, but update docs/final wording to
call it temporary and prefer moving the story to a current shell/host-surface
namespace when the cache/importer issue is resolved.

## Shell Architecture Drift

If a branch is rebased or refreshed while you are adding shell stories, re-check
the production shell component before preserving your story harness. The target
may have moved from an ad hoc wrapper to a named outer shell, host surface, or
route-level composition while you were working.

When this happens:

1. Prefer the current production shell/component boundary over the older harness
   from your local changes.
2. Keep only story-specific provider/platform shims needed to render that
   current shell in isolation.
3. Re-open the exact shell story iframe after the rebase, because a story that
   rendered before the shell move may now be proving a superseded structure.
4. If conflict resolution is involved, do not take an entire file's "ours" or
   "theirs" blindly; preserve the new shell architecture and reapply only the
   story states or docs that still match it.

## Story ID Drift After Rebase

Storybook story IDs are derived from story title and export names. A rebase can
rename or move the story file/title even when your story export survives. If you
reuse a pre-rebase iframe URL, the iframe can truthfully report that the story
does not exist while the updated story is available under a different ID.

After any rebase, title change, or story-file move:

1. Query `index.json` again and filter for the export name or visible story
   name.
2. Use the `id` returned by the current `index.json`, not the old URL.
3. Open and verify the exact current iframe.
4. Update any docs, comments, or final evidence that named the old story ID.

## Retired Or Legacy Namespaces

If a story renders the right component but lives under a `Retired`, `Legacy`,
`Compatibility`, or otherwise deprecated Storybook namespace, do not present it
as clean current-surface proof without calling out the mismatch. A temporary
harness under a retired namespace may unblock local visual inspection, but it
should not become the durable evidence location for a current route/app shell.

For current shell or route proof, prefer one of:

1. A story whose title hierarchy matches the current architecture level, such as
   host/app surface or route shell.
2. A clearly named architecture harness documented as current, not retired.
3. A short-lived compatibility story only if the mismatch is explicitly labeled
   as temporary and tracked as follow-up cleanup.

When the user asks why expected chrome is missing, treat a retired/compatibility
namespace as a likely story-selection or evidence-organization problem even if
the iframe technically renders.

Useful probe:

```bash
curl -s "http://localhost:<port>/index.json" \
  | jq -r '.entries | to_entries[] | select(.value.exportName=="RouteShellOpenHistory") | .key'
```

## User Correction Signal

If the user asks why they cannot see a sidebar, header, route chrome, open or
closed navigation state, host wrapper, or other shell-level affordance, assume
the Storybook story selection is wrong until proven otherwise. Do not defend
the inner component story. Switch to, create, or update a shell/app-surface
story that renders the production outer shell or a named harness around it,
then verify both the closed/default state and the explicitly open state when
the interaction has more than one visible mode.

## Importer Cache Symptom

When adding a new story while Storybook is already running, the manager/index
can list the new story but the preview iframe can fail with:

```text
TypeError: importers[path] is not a function
```

This means the Storybook index and the Vite virtual importer map are out of
sync. Check both:

```bash
curl -s 'http://localhost:<port>/index.json' | rg '<story-id-or-file>'
curl -s 'http://localhost:<port>/@id/__x00__virtual:/@storybook/builder-vite/storybook-stories.js' | rg '<story-file>'
```

If `index.json` contains the story but `storybook-stories.js` does not contain
the story file:

1. Stop Storybook using the repo target.
2. Clear the repo-local Storybook/Vite cache if the repo allows it.
3. Restart Storybook through the repo target.
4. Re-check the exact iframe.

If the cache remains inconsistent and the user is waiting, move the new state
into an already-imported story file as a temporary unblocker, then verify the
iframe again. Do not claim the story is ready while the iframe still shows the
importer error.

## Static Build As Visual QA Authority

Sometimes the dev Storybook server remains polluted after HMR, cache, or MSW
state issues even though the story compiles and the scoped Storybook/Vitest
runner passes. A common symptom is that the dev iframe keeps showing an old
error overlay or stale transformed module after the current story source is
correct.

Do not harden that transient dev-server state into a general "Storybook is
broken" rule. Treat it as a server-state problem and switch the visual QA
authority to a clean static build:

1. Run the repo's static build command, usually `npm run build-storybook` or
   the documented wrapper.
2. Serve `storybook-static` on a clean temporary port with cache disabled when
   possible.
3. Query that static server's `index.json` for the current story IDs.
4. Open the exact static `iframe.html?id=<story-id>&viewMode=story` URL.
5. Use the static iframe screenshot/readback as visual evidence, and report the
   dev-server iframe as stale/unreliable rather than asking the user to inspect
   it.

This fallback is only valid after the static build succeeds and the static
iframe renders the expected content. If the static iframe also fails, keep
debugging the story/harness.
