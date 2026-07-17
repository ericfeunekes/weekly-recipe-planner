import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { plannerActionVariants } from "../components/planner-ui/action-variants.ts";

test("planner UI action tones stay bounded to shared primitive variants", () => {
  assert.deepEqual(Object.keys(plannerActionVariants), ["primary", "secondary", "quiet", "attention"]);
  assert.deepEqual(plannerActionVariants.primary, { variant: "default", className: "min-h-11 rounded-sm" });
  assert.deepEqual(plannerActionVariants.secondary, { variant: "outline", className: "min-h-11 rounded-sm" });
  assert.deepEqual(plannerActionVariants.quiet, { variant: "ghost", className: "min-h-11 rounded-sm" });
  assert.deepEqual(plannerActionVariants.attention, { variant: "destructive", className: "min-h-11 rounded-sm" });
});

test("planner semantic tokens map to the existing palette rather than new raw colors", async () => {
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  for (const mapping of [
    "--color-background: var(--background)",
    "--color-foreground: var(--foreground)",
    "--color-primary: var(--primary)",
    "--color-destructive: var(--destructive)",
    "--color-border: var(--border)",
  ]) {
    assert.match(styles, new RegExp(mapping.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
