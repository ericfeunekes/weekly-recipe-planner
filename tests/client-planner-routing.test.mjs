import assert from "node:assert/strict";
import test from "node:test";

import { createCanonicalSeed } from "../lib/household-bootstrap.ts";
import { parsePlannerLocation, recipePath, resolvePlannerLocation, weekPath } from "../app/planner-routing.ts";

function fixture() {
  let sequence = 0;
  const state = createCanonicalSeed({
    now: Date.parse("2026-07-07T18:00:00-03:00"),
    createId(prefix) { sequence += 1; return `${prefix}-${sequence}`; },
  });
  const week = structuredClone(state.weeks[0]);
  const duplicate = structuredClone(week.data.meals[0]);
  duplicate.id = "second-meal-same-day";
  duplicate.title = week.data.meals[0].title;
  week.data.meals.push(duplicate);
  return week;
}

test("Week and Recipe locations preserve opaque meal identity", () => {
  const week = fixture();
  const first = week.data.meals[0];
  const second = week.data.meals.at(-1);
  assert.equal(weekPath(week.id), `/weeks/${week.id}`);
  assert.equal(recipePath(week.id, second.id), `/weeks/${week.id}/recipes/${second.id}`);
  assert.deepEqual(parsePlannerLocation(recipePath(week.id, second.id)), { kind: "recipe", weekId: week.id, mealId: second.id });
  assert.equal(resolvePlannerLocation(parsePlannerLocation(recipePath(week.id, second.id)), [week], week.id).mealId, second.id);
  assert.notEqual(second.id, first.id);
});

test("invalid and cross-week Recipe targets never select another meal", () => {
  const week = fixture();
  const missing = resolvePlannerLocation(parsePlannerLocation(`/weeks/${week.id}/recipes/missing`), [week], week.id);
  assert.equal(missing.kind, "unavailable");
  assert.equal(missing.week?.id, week.id);
  const crossWeek = resolvePlannerLocation(parsePlannerLocation("/weeks/2026-07-13/recipes/meal-1"), [week], week.id);
  assert.equal(crossWeek.kind, "unavailable");
});

test("legacy Day resolves to Week context without selecting a meal", () => {
  const week = fixture();
  const resolved = resolvePlannerLocation(parsePlannerLocation(`/weeks/${week.id}/day/${week.data.meals[0].date}`), [week], week.id);
  assert.deepEqual(resolved.kind, "week");
  assert.equal(resolved.legacyDate, week.data.meals[0].date);
  assert.equal("mealId" in resolved, false);
});
