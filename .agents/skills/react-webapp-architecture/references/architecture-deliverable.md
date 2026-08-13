# Architecture Deliverable

Write the durable architecture contract so a cold-start contributor can place
new code without reconstructing the design from examples.

## Required Sections

1. **Purpose and scope** — the application surface governed by the document and
   the backend/runtime authorities it consumes.
2. **Current evidence** — inspected repository structure, existing conventions,
   dependencies, and constraints. Label inference separately.
3. **Canonical stack** — the baseline and capability-triggered additions.
4. **Ownership map** — app/routes, feature/domain presentation, shared UI and
   utilities, and API/data/contracts infrastructure.
5. **Dependency rules** — allowed directions, forbidden imports, public
   boundaries, and automated enforcement.
6. **State authority** — URL, remote, local, form, client-shared, workflow,
   streaming, and server truth.
7. **Shared component contract** — shadcn/Base UI ownership, tokens,
   accessibility, Storybook states, and promotion criteria.
8. **Testing and proof** — owner-level tests, Storybook scope, routed browser
   proof, and live-boundary proof.
9. **Capability decisions** — adopted packages, triggers, explicit
   non-adoptions, and exceptions.
10. **Cutover** — modules to move or delete, sequence, compatibility
    requirements, and completion boundary.

## Decision Table

Use a compact table for capability choices:

| Capability | Decision | Trigger | Authority/owner | Proof |
|---|---|---|---|---|
| Remote state | TanStack Query | Application calls an API | API/data plus server | request/cache integration tests |
| Workflow control | XState only when guarded lifecycle exists | invalid transitions or supervision matter | feature/runtime control layer | transition and replay tests |

Include non-adoptions when a nearby package would otherwise be repeatedly
reconsidered. Do not fill the document with evaluated libraries that have no
plausible role in the application.

## Enforcement Map

For every load-bearing rule, name its enforcement surface:

| Rule | Enforcement |
|---|---|
| Routes remain composition roots | dependency-cruiser/Nx plus code review |
| Shared UI cannot import features | dependency rule |
| Runtime schemas use Zod | boundary implementation and tests |
| Shared components expose meaningful states | Storybook and component tests |
| Server remains business authority | API contract and boundary tests |

Written claims alone are not enforcement. Prefer a type, dependency rule, test,
or runtime boundary; keep prose for the architectural reason and placement
guidance.

## AGENTS Routing

Add a short `AGENTS.md` route that tells agents when to read the frontend
architecture document—for example, before adding or changing routes, shared
components, frontend state, API/query infrastructure, or application-wide
capabilities. Keep the durable decisions in the architecture document rather
than duplicating them into `AGENTS.md`.

## Review Questions

- Can every module be assigned one primary role?
- Can a route be understood without reading transport implementation details?
- Is every state value stored with its authority rather than mirrored?
- Do shared components own a system contract, not merely repeated markup?
- Does every specialized library solve a present capability?
- Are lifecycle machines modeling permitted transitions rather than moving
  raw data?
- Can automated rules detect the most damaging dependency violations?
- Does the cutover remove the superseded path?
