import assert from "node:assert/strict";
import test from "node:test";

import { validateHouseholdState } from "../lib/household-domain.ts";
import {
  createE2eFixtureSeed,
  E2E_FIXTURE_IDS,
  normalizeE2eFixture,
} from "./support/e2e-runtime.mjs";

let fixtureId = 0;
const context = {
  now: Date.parse("2026-07-07T18:00:00-03:00"),
  createId(prefix) {
    fixtureId += 1;
    return `fixture-${prefix}-${fixtureId}`;
  },
};

test("the E2E seed selector is closed before a runtime can start", () => {
  assert.deepEqual(E2E_FIXTURE_IDS, ["D4", "D7"]);
  assert.equal(normalizeE2eFixture(), "D4");
  assert.equal(normalizeE2eFixture("D7"), "D7");
  assert.throws(() => normalizeE2eFixture("zero-week"), /Unsupported E2E fixture/);
});

test("D7 is a valid initialized zero-week seed and D4 remains canonical", () => {
  const d7 = createE2eFixtureSeed("D7", context);
  assert.equal(validateHouseholdState(d7).ok, true);
  assert.deepEqual(d7, {
    householdTimeZone: "America/Halifax",
    activeWeekId: null,
    weeks: [],
  });
  const d4 = createE2eFixtureSeed("D4", context);
  assert.equal(validateHouseholdState(d4).ok, true);
  assert.equal(d4.weeks.length, 1);
  assert.equal(typeof d4.activeWeekId, "string");
});
