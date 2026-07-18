import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveDayDate } from "../app/day-selection.ts";

test("Day date resolution preserves valid selections and clamps to the selected week", () => {
  assert.equal(resolveDayDate("2026-07-06", "2026-07-07", "2026-07-09"), "2026-07-09");
  assert.equal(resolveDayDate("2026-07-13", "2026-07-07", "2026-07-09"), "2026-07-13");
  assert.equal(resolveDayDate("2026-07-06", "2026-07-07", null), "2026-07-07");
  assert.equal(resolveDayDate(null, "2026-07-07", "2026-07-09"), "2026-07-07");
});

test("explicit week selection clears the ephemeral Day selection", async () => {
  const planner = await readFile(new URL("../app/planner-client.tsx", import.meta.url), "utf8");
  assert.match(planner, /setSelectedWeekId\(event\.target\.value as WeekId\);\s*setSelectedDayDate\(null\);/);
});
