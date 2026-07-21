import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Week is a prep-free dinner agenda while Prep remains a separate view", async () => {
  const [planner, prepView] = await Promise.all([
    readFile(new URL("../app/planner-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/planner-ui/prep-view.tsx", import.meta.url), "utf8"),
  ]);
  const weekViewStart = planner.indexOf("function WeekView(");
  const tonightViewStart = planner.indexOf("function TonightView(");
  assert.ok(weekViewStart >= 0 && tonightViewStart > weekViewStart, "WeekView source boundary exists");

  const weekView = planner.slice(weekViewStart, tonightViewStart);
  for (const forbiddenWeekConcern of ["prepSessions", "prepNote", "day-prep-indicator", "Batch prep", 'onNavigate("prep")']) {
    assert.doesNotMatch(weekView, new RegExp(forbiddenWeekConcern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(planner, /<PrepView/);
  assert.match(prepView, /export function PrepView/);
});
