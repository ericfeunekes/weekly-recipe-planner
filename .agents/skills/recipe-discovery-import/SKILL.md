---
name: recipe-discovery-import
description: Source-faithful recipe import is unavailable in the current planner host. Use only to explain the boundary and route the household to a supported planning or adjustment workflow; do not search, capture, compare, or import a source recipe.
---

# Source-faithful recipe import is unavailable

The current planner host does not admit source-faithful recipe import. Do not
search for, open, retrieve, capture, compare, extract, or import external recipe
content for this workflow. Do not call `planner.preview` or `planner.apply` with
`replaceMealRecipeFromSource`, and do not report a source recipe as stored.

The existing direct typed replacement contract may carry an informational source
reference, but it is not an attestation of source fidelity and does not make web
import available through this host.

Resume source-faithful import only after host capability readback explicitly
proves that the applied replacement is bound to the exact observed candidate and
independent fidelity verdict. Until then, use `meal-planning` to plan an existing
meal or `recipe-adjustments` to make a deliberate non-source-faithful variation.
