import assert from "node:assert/strict";
import test from "node:test";

import { plannerActionVariants } from "../components/planner-ui/action-variants.ts";

test("planner UI action tones stay bounded to shared primitive variants", () => {
  assert.deepEqual(Object.keys(plannerActionVariants), ["primary", "quiet", "attention"]);
  assert.deepEqual(plannerActionVariants.primary, { variant: "default", className: "rounded-sm" });
  assert.deepEqual(plannerActionVariants.quiet, { variant: "secondary", className: "rounded-sm" });
  assert.deepEqual(plannerActionVariants.attention, { variant: "destructive", className: "rounded-sm" });
});
