import assert from "node:assert/strict";
import test from "node:test";

import { deriveTimerDisplay } from "../app/timer-display.ts";

test("timer display is derived from server time and exposes elapsed state", () => {
  const start = Date.parse("2026-07-10T18:00:00-03:00");
  assert.deepEqual(deriveTimerDisplay(60, undefined, start), {
    remainingSeconds: 60,
    status: "timer",
  });
  assert.deepEqual(deriveTimerDisplay(60, start, start + 15_000), {
    remainingSeconds: 45,
    status: "running",
  });
  assert.deepEqual(deriveTimerDisplay(60, start, start + 90_000), {
    remainingSeconds: 0,
    status: "elapsed",
  });
});
