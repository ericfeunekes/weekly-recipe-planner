# Phase A Remediation Plan — Foundation Review Loop 1

## Review clusters

| Cluster | Root pattern and sibling extent | Carried disposition | Route and closure proof |
| --- | --- | --- | --- |
| Overlay scope | A generated overlay provider was mounted globally before any real overlay consumer existed. The sweep finds only `app/layout.tsx`; the fixture no longer imports an overlay primitive. | must-fix — DESIGN correct, CODE outside the frozen Phase A boundary, PROOF misleading | Remove global `TooltipProvider` and `Toaster` wiring. Keep generated primitive sources unmounted until the controls or rail phase proves them in real context. Confirm `rg` finds no non-primitive overlay mount and server/client tests still pass. |
| Fixture interaction proof | The fixture displayed disabled/focusable controls but its test asserted programmatic focus only. The scoped E2E file is the sole sibling. | must-fix — PROOF unproven | Assert Tab-driven focus order and disabled semantics on the actual phone/tablet/desktop fixture, alongside existing axe and containment proof. |
| Token and handoff record | The plan named semantic-token and adapter proof but did not make the inventory and completed evidence record coherent. The token mapping has one static guard in `rendered-html.test.mjs`; no other foundation test owns it. | must-fix — PROOF unproven | Add focused static assertions for the semantic theme map; expand the adapter manifest with status/owner/phase boundary; update the cycle record only after all proof and rereview are complete. |

## Proof-bar synthesis

This is in-process sibling and proof-bar synthesis because the affected seams
are local presentation composition and the repo already has the required
realistic-local infrastructure: production Vinext build, node contract suite,
and Playwright with real local HTTP/axe/viewport capture. No capability gap was
found. The full test suite requires loopback binding and is run outside the
sandbox; that is an execution-environment limitation, not a product gap.

## Revised completion contract

Prior contract: an isolated non-overlay fixture plus installed primitives,
with overlays deferred. Review showed the root layout had already made overlays
live and the interaction proof overstated what it exercised.

Revised contract: Phase A ships only additive Tailwind tokens, generated shadcn
source, a presentation-only action adapter, and an unlinked non-overlay fixture.
Global application behavior remains unchanged; tooltip, toast, dialog, sheet,
and menu runtime integration are explicitly deferred. The fixture proves
keyboard order, disabled state, axe, containment, and tokens at representative
widths. The plan records the exact vocabulary and its ownership.

## Rereview readiness

Reinvoke implementation review only after `app/layout.tsx` no longer mounts
overlay providers; the fixture E2E exercises Tab focus and disabled state at all
three viewports; semantic token assertions and the inventory are present; and
`npm test`, `npm run lint`, focused E2E, plus `git diff --check` pass.

## Closure record

The focused rereview confirmed the layout has no live overlay mount, the fixture
proves disabled state and real Tab progression, token assertions exist, and the
inventory names deferred overlay ownership. The cycle record in
`ui-platform-foundation-impl-plan.md` is the active evidence summary.
