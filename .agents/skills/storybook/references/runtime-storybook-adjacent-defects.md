# Runtime Storybook Adjacent Defects

Use this reference when a runtime-backed Storybook story fails while exercising
production components, providers, message adapters, MSW/runtime streams, query
caches, or framework primitives.

## Core Lesson

A runtime Storybook failure is not automatically "just Storybook." When the
story mounts the production component path, browser-lane errors can reveal real
adjacent defects that unit/component tests missed.

Examples:

- React hook-order errors that only appear when the same runtime message
  component transitions between roles or content shapes.
- Provider/cache/session leakage across progressive stories.
- Message adapter assumptions that pass prop-hydrated stories but fail when the
  real runtime updates the same message identity.
- Story play assertions that accidentally expose stale expectations in the
  production rendering contract.

## Classification Flow

1. **Confirm the story is production-path enough to matter.**
   - Does it import the real component/composition?
   - Does it use the real runtime/MSW/query/cache adapter for the claim?
   - Is the failing UI inside the product surface rather than outside harness
     chrome?

2. **Classify the failure before editing assertions.**
   - **Harness/setup failure:** stale server, wrong story id, cache/session leak,
     unsupported browser launch, missing MSW scenario.
   - **Stale assertion:** story expected old copy/state, but rendered UI matches
     the current contract.
   - **Product-path defect:** imported component violates React/runtime rules,
     crashes under real adapter updates, leaks wrong content, or hides/shows the
     wrong surface.

3. **Fix according to class.**
   - Harness/setup: repair the story runner, isolate identity, or rerun on a
     clean server/iframe.
   - Stale assertion: update the story to the current contract and keep the
     proof boundary clear.
   - Product-path defect: fix the production component, not the story, when the
     defect blocks the claimed runtime proof.

## Hook-Order Pattern

Runtime-backed stories can expose a React hook-order bug when a framework
reuses a component instance across changing message roles or content states.
The common shape:

```tsx
const [state] = useState(...)

if (role === "user") return <UserBubble />

const derived = useMemo(...)
return <AssistantMessage />
```

This violates hook ordering if the same component instance first renders as
`user` and later as `assistant`. Move all hooks above role-based early returns,
or split roles into separate child components so each child has a stable hook
shape:

```tsx
const [state] = useState(...)
const derived = useMemo(...)

if (role === "user") return <UserBubble />
if (role === "system") return null
return <AssistantMessage derived={derived} />
```

Do not suppress this warning in Storybook. If the story uses the real runtime
message path, the warning is evidence that the product component is unsafe
under real runtime updates.

## Proof Discipline

- Keep substrate/state-machine proof in unit or integration tests first.
- Use runtime Storybook/Playwright to prove browser-visible rendering and
  runtime-adapter behavior.
- If runtime Storybook fails for an adjacent product defect, fix that defect or
  state that visual proof is blocked. Do not report the original UI change as
  visually proven while the story renders an error boundary.
- If a story assertion changed because the contract changed, update both the
  story play assertion and any Storybook Playwright/e2e assertion that points at
  the same story.
