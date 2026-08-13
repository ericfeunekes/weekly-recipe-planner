---
name: react-webapp-architecture
description: Defines and enforces the canonical architecture for React web applications using TypeScript, Vite, TanStack Router and Query, Tailwind, shadcn/ui, shared components, and Storybook. Use when starting, restructuring, or reviewing a React frontend; deciding route, feature, component, API, state, form, table, chart, upload, streaming, or AI-assistant ownership; or writing durable frontend architecture guidance. Do not use to implement visual components or stories, install a skill bundle, or design backend domain architecture.
metadata:
  version: "0.2.0"
---

# React Web App Architecture

Establish one coherent frontend architecture before implementation spreads
ownership across routes, components, stores, and API clients. Inspect the
existing repository and accepted product requirements first. Preserve a
demonstrated local exception only when it has an explicit reason and owner;
otherwise converge on this skill's defaults.

## Canonical Baseline

Use React, TypeScript, Vite, TanStack Router, Tailwind, shadcn/ui with Base UI
primitives, a repository-owned shared component library, and Storybook.

For every application backed by an API, use TanStack Query as the foundation
for remote state. Static, content-only, and genuinely local-only surfaces have
no remote state to cache and may omit it. Query owns remote cache behavior; it
does not make the browser the semantic authority for server rules.

Treat these choices as a compatible system, not a package menu. Do not replace
one because another package is fashionable. Record an exception only when a
measured requirement makes the default unsuitable.

## Route The Design Source Before Architecture Execution

Before selecting an implementation or design skill, identify the live design
authority. A live Figma file or node is authoritative through the official Figma
platform plugin/MCP and that live source. An existing repository or product
design system is authoritative through repository and running-application
evidence. A truly greenfield surface uses the OpenAI Product Design platform
plugin first.

`frontend-app-builder` is available only through the separately named
`react-webapp-greenfield-builder` preset, and only as a one-pass fallback when
the Product Design platform plugin is unavailable or the user explicitly chooses
it. Never run the builder and then Product Design for the same design decision.
Platform-plugin cache or configuration presence is not runtime proof; verify the
live authority before reporting it available. Platform plugins/MCPs are not
`npx skills` bundle members.

## Resolve Neighbor Instruction Authority

Accepted repository architecture and this skill govern framework and package
selection, module and import boundaries, state authority, forms, tables,
charts, and server authority. Neighbor implementation skills operate inside
that architecture:

- `shadcn` owns shadcn component mechanics, styling, and composition. It cannot
  select a package that conflicts with this architecture. Its Recharts-backed
  Chart is not selected because ECharts is canonical.
- Other component, performance, testing, and guideline skills may improve their
  named concern without changing these architecture authorities.

When a neighbor appears to conflict, apply this ownership rule explicitly. Do
not silently follow whichever skill was read last.

For a greenfield application, apply the baseline directly. For a brownfield
application, identify the current router, remote-cache owner, primitive family,
build/runtime owner, and client-store authorities first. Do not install the
baseline beside a competing authority. Either preserve an accepted existing
authority or define a clean replacement and migration cutover.

## Enforce Four Ownership Roles

Assign every frontend module to one primary role:

1. **App bootstrap and routes** assemble providers, layouts, route trees,
   navigation, URL state, loaders, and route boundaries.
2. **Feature or domain presentation** owns use-case orchestration and
   feature-specific UI, but not authoritative server business rules.
3. **Shared UI and utilities** own reusable primitives, design tokens,
   accessibility behavior, and genuinely cross-feature utilities.
4. **API, data, and contracts infrastructure** owns transport, generated or
   runtime-validated contracts, query-key factories, cache policy, and adapters
   between server representations and frontend models.

Keep routes thin. A route composes capabilities and translates URL state; it
must not become the home of reusable UI, transport details, or feature rules.
TanStack Router supports this boundary but cannot enforce it alone. Use
dependency rules and review to prevent inward layers from importing routes or
feature internals.

Do not require a directory named `features`. Map the roles onto the repository's
clear existing vocabulary. A shared primitive may begin with one consumer when
it centralizes tokens, accessibility, or a system-wide contract. A
feature-specific composition stays feature-owned even when several routes use
it.

## Place State With Its Authority

Classify each state value before choosing a library:

- URL/shareable navigation state → TanStack Router.
- Remote server state and request lifecycle → TanStack Query.
- Local ephemeral view state → React state.
- Form interaction and validation lifecycle → React Hook Form plus Zod.
- Real cross-component synchronous client state → Zustand.
- Guarded workflow or lifecycle state → XState.
- Normalized reactive client collections → TanStack DB, only after an explicit
  architectural decision.
- Authoritative business state → the server or owning runtime.

Do not mirror Query or Router state into a client store. For streaming, keep
transport and accumulated content with the stream/runtime owner; use XState
only for control state whose transitions, cancellation, retries, approvals, or
concurrent actors need an explicit lifecycle.

## Apply Defaults By Capability

Use the selected default when the capability exists; do not install every
library pre-emptively. The capability reference explains the adoption boundary
and exceptions.

At adoption time, verify the selected package's current stable release,
maintenance status, peer compatibility, license, and target-runtime behavior.
This skill defines durable choices and boundaries, not frozen versions.

| Concern | Default |
|---|---|
| Runtime schemas | Zod; Standard Schema for interoperability |
| Forms | React Hook Form |
| Tables | TanStack Table v8 |
| Large lists/grids | TanStack Virtual after measurement |
| Charts | ECharts behind shared wrappers |
| Nontrivial uploads | Uppy |
| Rich text | Tiptap |
| Offline/local-first SQL sync | PowerSync |
| Browser diagnostics | Sentry |
| Server telemetry | OpenTelemetry |
| Dependency enforcement | dependency-cruiser, unless Nx owns the workspace |
| Unit/component tests | Vitest, Testing Library, user-event, MSW, axe |
| Browser and route tests | Playwright; Storybook/Vitest or Browser Mode for component states |

Storybook is the shared component library's state catalog and component proof
surface. It is not proof of a deployed route, authentication boundary, or live
backend integration.

## Produce An Enforceable Decision

For architecture work, return or write:

1. the inspected current-state evidence and constraints;
2. the selected ownership map and dependency directions;
3. state authority by category;
4. capability decisions, including explicit non-adoptions;
5. enforcement points in linting, dependency rules, tests, Storybook, and docs;
6. migration/cutover boundaries when restructuring an existing app; and
7. unresolved product decisions only when repository evidence cannot settle
   them.

Prefer a complete cutover over parallel old and new frontend paths. Do not
invent compatibility layers without an accepted requirement or demonstrated
failure mode.

## Load Conditional References

Read every selected reference completely before acting.

| Topic | File | When to read |
|---|---|---|
| Module and dependency structure | [references/application-structure.md](references/application-structure.md) | Defining directories, imports, route boundaries, shared components, or enforcement |
| State, data, forms, and workflows | [references/state-and-data.md](references/state-and-data.md) | Choosing ownership for server state, client state, forms, schemas, lifecycle, or streaming |
| Capability and library standards | [references/capability-standards.md](references/capability-standards.md) | Selecting tables, virtualization, uploads, charts, editors, local-first, testing, observability, or TanStack packages |
| AI assistants and streaming | [references/ai-and-streaming.md](references/ai-and-streaming.md) | Architecting chat, agents, streaming UI, tools, protocols, approvals, or durable agent workflows |
| Deliverable shape | [references/architecture-deliverable.md](references/architecture-deliverable.md) | Writing or reviewing the durable architecture contract |
| Provenance | [references/provenance.md](references/provenance.md) | Maintaining or revising this skill's load-bearing defaults |

## Neighbor Boundaries

The first six neighbors below are standalone skills and are not bundled in
`repo-setup-improve`. Route to them when the frontend bundle has installed
them; otherwise keep this skill's stop boundary and use the repository's owning
implementation workflow.

- Use `skill:shadcn` to add, style, or debug shadcn components.
- Use `skill:vercel-composition-patterns` for component API and composition
  refactors after ownership is settled.
- Use `skill:vercel-react-best-practices` for React performance implementation
  guidance.
- Use `skill:frontend-testing-debugging` to diagnose and verify rendered
  frontend behavior through browser-first loops.
- Use `skill:web-design-guidelines` to review implemented UI for interface,
  accessibility, and UX guideline compliance.
- Use `skill:storybook` to create or visually prove Storybook
  stories.
- Use `skill:qa` for visual or exploratory QA.
- Use `repo-setup-improve:skill-bundle-setup` for a durable named bundle, or
  `skill:skill-library-management` for an ad hoc install or update. This skill
  owns architecture, not skill installation.
- Use `skill:code-analysis:architecture` for broad, non-React structural audits.
- Use the owning backend architecture skill for service and domain architecture.
