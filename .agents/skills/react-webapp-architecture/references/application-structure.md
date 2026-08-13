# Application Structure

## Dependency Direction

Preserve this one-way dependency flow:

```text
app/bootstrap and routes
        ↓
feature/domain presentation
        ↓
shared UI and utilities

feature/domain presentation ──→ API/data/contracts infrastructure
app/bootstrap and routes ─────→ API/data/contracts infrastructure
```

Shared UI must not import a feature, route, or application bootstrap module.
API/data infrastructure must not import presentation modules. Feature modules
must not import route definitions. Allow dependencies to point toward stable,
lower-level contracts rather than back toward composition roots.

Use dependency-cruiser to encode these directions in standalone applications.
When Nx already owns the workspace graph, express the same constraints through
Nx tags and module-boundary rules rather than adding a competing authority.

## App Bootstrap And Routes

Keep the application layer small. It owns:

- provider and runtime initialization;
- the TanStack Router route tree;
- global layouts and error/not-found boundaries;
- URL parsing, search-parameter validation, and navigation;
- route loaders that prefetch or ensure Query data; and
- route-level authorization redirects when the server contract supports them.

Keep a route loader a cache/orchestration seam. Reuse the same query options or
query-key factory as the component instead of defining a second fetch path.
Route components should assemble a feature surface and handle route state, not
contain transport clients or large feature implementations.

## Feature Or Domain Presentation

Co-locate feature-specific components, hooks, query use cases, and presentation
models when they change together. This role may coordinate a use case—for
example, submit a mutation and navigate after success—but the API or owning
runtime remains the semantic authority for permissions, invariants, and final
business state.

Do not require the directory name `features`. `domains`, `modules`, or another
established repository term is valid when the ownership boundary remains clear.

A composition does not become shared merely because several routes render it.
If it expresses one feature's language and use case, keep it with that feature.

## Shared UI And Utilities

Own the shadcn configuration, Base UI-backed primitives, tokens, themes,
accessibility behavior, and general composition patterns in the repository's
shared component library. Shared components expose application-neutral APIs;
they do not fetch feature data or import feature contracts.

Allow a shared component with one current consumer when it centralizes a
system-wide concern such as focus behavior, keyboard interaction, typography,
color tokens, layout primitives, or accessibility semantics. Avoid premature
generalization of ordinary feature markup.

Give shared components Storybook states for meaningful variants, interaction
states, loading/empty/error states when applicable, and accessibility-relevant
behavior. Use Storybook to prove the component contract; verify the real route
separately when the claim crosses application composition or live boundaries.

## API, Data, And Contracts Infrastructure

Centralize:

- the transport client and authentication/header integration;
- generated types or Zod boundary schemas;
- stable query-key factories and reusable query options;
- mutation adapters and cache invalidation policy;
- error normalization; and
- conversions between wire contracts and frontend models.

Do not create a generic repository layer that only renames endpoint calls.
Extract infrastructure where it owns a real cross-feature contract or policy.
Keep domain-specific query orchestration with the owning feature when no shared
policy exists.

## Cutover And Enforcement

When restructuring an app, map existing modules to the four roles, identify
imports that violate the desired direction, and define a finite cutover. Delete
the replaced path in the same change unless an accepted compatibility
requirement states otherwise.

Enforce architecture through:

- TypeScript path aliases that describe stable roles rather than bypass them;
- dependency-cruiser or Nx module-boundary rules;
- lint rules against deep private imports;
- public module entrypoints only where they stabilize a real boundary;
- tests at the owner of behavior; and
- a short durable frontend architecture document referenced by `AGENTS.md`.

Do not use index barrels everywhere. A public entrypoint is useful at a role or
package boundary; internal modules should remain directly navigable.
