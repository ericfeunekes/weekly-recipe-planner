# Provenance And Maintenance

## Why These Rules Exist

This skill consolidates a capability-by-capability review and explicit user
decisions into one repeatable architecture contract. Its fixed baseline exists
to prevent each application from reopening compatible foundation choices. Its
conditional standards prevent the opposite failure: installing every package
from a vendor family without a demonstrated capability.

The four ownership roles and state-authority table address recurring ambiguity
between routes, shared components, feature orchestration, API clients, remote
cache, client stores, and workflow state. The rules intentionally avoid
mandating a directory name because ownership is the invariant; vocabulary may
follow a repository's established structure.

The XState streaming rule follows an explicit correction: a lifecycle machine
can improve streaming control correctness, but it must not become the owner of
token data, transport mechanics, or backend truth.

The ECharts, Zod, React Hook Form, Uppy, and AI composition choices are
deliberate defaults, not unresolved comparisons. CopilotKit is intentionally
not selected. ChatKit intentionally represents the low-customization packaged
option.

## Scope

These rules govern frontend application architecture. They do not govern
backend domain design, visual design execution, package installation, or
Storybook QA mechanics. Neighbor skills own those jobs.

## Design-Source Authority

The architecture core is source-neutral: it does not select the visual design
authority. A live Figma source remains authoritative through the official Figma
platform plugin/MCP. An existing product design system remains authoritative
through repository and running-app evidence. For truly greenfield work, the
OpenAI Product Design platform plugin is the first authority.

`frontend-app-builder` is fallback-only through the named
`react-webapp-greenfield-builder` preset. It may be used as a one-pass fallback
only when Product Design is unavailable or explicitly not chosen. It cannot
replace Figma, repository/product-design-system, or Product Design authority,
and must never be run before Product Design for the same decision. A plugin/MCP
cache or configuration entry does not establish runtime availability; live
invocation/read evidence does. Platform plugins/MCPs are deliberately not npx
bundle members.

## Neighbor Instruction Compatibility

Selected implementation skills are intentionally subordinate to the accepted
architecture for decisions outside their concern. If the explicit builder
fallback is selected, its visual concept and fidelity priority remains limited to
that fallback execution; it cannot replace Figma, repository/Product Design,
framework, packages, module boundaries, state, data, or server ownership. The
`shadcn` skill governs component mechanics without selecting Recharts over the
canonical ECharts decision. This explicit scope reconciliation is part of the
preset contract, not an install-order rule.

## Revision Criteria

Revise a default when one of these occurs:

- the selected project is retired or no longer maintained;
- a stable major release materially changes the compatibility or ownership
  model assumed here;
- repeated application evidence shows the default produces a structural cost;
- a new requirement cannot be met without a parallel architecture; or
- the user explicitly changes the canonical standard.

Before replacing a default, compare capabilities, integration with the rest of
the stack, maintenance and licensing, migration cost, performance at the
relevant boundary, accessibility, and operational ownership. Record the new
decision and remove superseded guidance in the same change.
