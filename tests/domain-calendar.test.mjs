import assert from "node:assert/strict";
import test from "node:test";

import { createCanonicalSeed } from "../lib/household-bootstrap.ts";
import {
  addIsoDateDays,
  householdDomain,
  mondayForIsoDate,
  weekContainsDate,
  weekContainsPrepDate,
} from "../lib/household-domain.ts";
import { parseIsoDate, parseWeekId } from "../lib/household-contract.ts";

const NOW = Date.parse("2026-07-10T12:00:00-03:00");

function context() {
  let sequence = 0;
  return {
    now: NOW,
    createId(prefix) {
      sequence += 1;
      return `${prefix}-${sequence}`;
    },
  };
}

function accepted(result) {
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
  return result;
}

test("calendar helpers retain ISO semantics across month and DST boundaries", () => {
  assert.equal(mondayForIsoDate(parseIsoDate("2026-03-08")), "2026-03-02");
  assert.equal(addIsoDateDays(parseIsoDate("2026-03-08"), 1), "2026-03-09");
  assert.equal(addIsoDateDays(parseIsoDate("2026-12-31"), 1), "2027-01-01");
  const weekId = parseWeekId("2026-07-06");
  assert.equal(weekContainsDate(weekId, parseIsoDate("2026-07-12")), true);
  assert.equal(weekContainsDate(weekId, parseIsoDate("2026-07-13")), false);
  assert.equal(weekContainsPrepDate(weekId, parseIsoDate("2026-07-05")), true);
  assert.equal(weekContainsPrepDate(weekId, parseIsoDate("2026-07-04")), false);
});

test("meal moves support empty targets and occupied-slot swaps", () => {
  const commandContext = context();
  let state = createCanonicalSeed(commandContext);
  const weekId = state.activeWeekId;
  const week = state.weeks[0];
  const chickenId = week.data.meals[0].id;
  const salmonId = week.data.meals[1].id;
  const emptyTuesday = addIsoDateDays(weekId, 1);
  const occupiedDinnerDate = week.data.meals[1].date;

  let result = accepted(
    householdDomain.execute(
      state,
      { type: "moveMeal", weekId, mealId: chickenId, targetDate: emptyTuesday, slot: "dinner" },
      commandContext,
    ),
  );
  state = result.state;
  assert.equal(state.weeks[0].data.meals.find((meal) => meal.id === chickenId).date, emptyTuesday);
  assert.equal(state.weeks[0].data.meals.some((meal) => meal.date === weekId), false);

  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "moveMeal",
        weekId,
        mealId: chickenId,
        targetDate: occupiedDinnerDate,
        slot: "dinner",
      },
      commandContext,
    ),
  );
  state = result.state;
  const meals = state.weeks[0].data.meals;
  assert.equal(meals.find((meal) => meal.id === chickenId).date, occupiedDinnerDate);
  assert.equal(meals.find((meal) => meal.id === salmonId).date, emptyTuesday);
});

test("week creation, handoff, archive, and activation preserve zero-or-one active week", () => {
  const commandContext = context();
  let state = createCanonicalSeed(commandContext);
  const currentWeekId = state.activeWeekId;
  const nextWeekId = addIsoDateDays(currentWeekId, 7);
  let result = accepted(
    householdDomain.execute(
      state,
      {
        type: "createWeekPlan",
        weekStartDate: nextWeekId,
        plan: {
          meals: [
            {
              date: nextWeekId,
              slot: "dinner",
              title: "Flexible Monday dinner",
              subtitle: "Use what is available",
              venue: "Home",
              protein: "none",
              prepNote: "",
              leftoverNote: "",
              notes: "",
              ingredients: [],
              instructions: [],
            },
          ],
          groceries: [],
        },
      },
      commandContext,
    ),
  );
  state = result.state;
  assert.ok(result.createdIds["meal.0"]);
  assert.equal(state.weeks.find((week) => week.id === nextWeekId).status, "planned");

  result = accepted(
    householdDomain.execute(
      state,
      { type: "handoffWeek", currentWeekId, nextWeekId },
      commandContext,
    ),
  );
  state = result.state;
  assert.equal(state.activeWeekId, nextWeekId);
  assert.equal(state.weeks.find((week) => week.id === currentWeekId).status, "archived");
  assert.equal(state.weeks.find((week) => week.id === nextWeekId).status, "active");

  state = accepted(
    householdDomain.execute(state, { type: "archiveWeek", weekId: nextWeekId }, commandContext),
  ).state;
  assert.equal(state.activeWeekId, null);
  const thirdWeekId = addIsoDateDays(nextWeekId, 7);
  state = accepted(
    householdDomain.execute(
      state,
      {
        type: "createWeekPlan",
        weekStartDate: thirdWeekId,
        plan: { meals: [], groceries: [] },
      },
      commandContext,
    ),
  ).state;
  state = accepted(
    householdDomain.execute(state, { type: "activateWeek", weekId: thirdWeekId }, commandContext),
  ).state;
  assert.equal(state.activeWeekId, thirdWeekId);
  assert.equal(state.weeks.filter((week) => week.status === "active").length, 1);
  assert.deepEqual(householdDomain.validateState(state), { ok: true });
});

test("aggregate validation rejects duplicate slots, bad prep positions, and active-week drift", () => {
  const state = createCanonicalSeed(context());
  const invalid = structuredClone(state);
  const week = invalid.weeks[0];
  week.data.meals[1].date = week.data.meals[0].date;
  week.data.prep[0].position = 2;
  invalid.activeWeekId = null;
  week.data.meals[0].instructions[0].complete = true;
  week.data.meals[0].instructions[0].timerDurationSeconds = 60;
  week.data.meals[0].instructions[0].timerStartedAt = NOW;

  const validation = householdDomain.validateState(invalid);
  assert.equal(validation.ok, false);
  assert.ok(validation.issues.some((issue) => /already occupied/i.test(issue.message)));
  assert.ok(validation.issues.some((issue) => /contiguous/i.test(issue.message)));
  assert.ok(validation.issues.some((issue) => /identify the active week/i.test(issue.message)));
  assert.ok(validation.issues.some((issue) => /completed step/i.test(issue.message)));
});

test("aggregate validation enforces canonical prep order and exact reference shape", () => {
  const state = createCanonicalSeed(context());
  const outOfOrder = structuredClone(state);
  outOfOrder.weeks[0].data.prep.reverse();
  const orderValidation = householdDomain.validateState(outOfOrder);
  assert.equal(orderValidation.ok, false);
  assert.ok(orderValidation.issues.some((issue) => /grouped chronologically/i.test(issue.message)));

  const copiedStepFields = {
    complete: true,
    timerDurationSeconds: 60,
    timerStartedAt: NOW,
    note: "Copied note",
    inputs: [{ amount: "1", ingredient: "copied input" }],
    instruction: "Copied instruction",
  };
  for (const [field, value] of Object.entries(copiedStepFields)) {
    const withCopiedField = structuredClone(state);
    withCopiedField.weeks[0].data.prep[0][field] = value;
    const validation = householdDomain.validateState(withCopiedField);
    assert.equal(validation.ok, false, `prep references must reject copied ${field}`);
    assert.ok(validation.issues.some((issue) => /unsupported fields/i.test(issue.message)));
  }
});

test("leftover assignments require later dates and lock their source meal", () => {
  const commandContext = context();
  let state = createCanonicalSeed(commandContext);
  const weekId = state.activeWeekId;
  const salmon = state.weeks[0].data.meals[1];
  let result = accepted(
    householdDomain.execute(
      state,
      { type: "updateMealStatus", weekId, mealId: salmon.id, status: "cooked" },
      commandContext,
    ),
  );
  state = result.state;
  const beforeEarlyAssignment = structuredClone(state);
  const earlyAssignment = householdDomain.execute(
    state,
    {
      type: "assignLeftover",
      weekId,
      leftoverId: result.createdIds.leftoverId,
      targetDate: weekId,
      slot: "dinner",
    },
    commandContext,
  );
  assert.equal(earlyAssignment.ok, false);
  assert.deepEqual(earlyAssignment.state, beforeEarlyAssignment);
  assert.match(earlyAssignment.message, /after their source/i);
  assert.ok(Object.values(earlyAssignment.fieldErrors ?? {}).some((message) => /later date/i.test(message)));

  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "assignLeftover",
        weekId,
        leftoverId: result.createdIds.leftoverId,
        targetDate: addIsoDateDays(weekId, 6),
        slot: "dinner",
      },
      commandContext,
    ),
  );
  state = result.state;
  const beforeMove = structuredClone(state);
  const rejected = householdDomain.execute(
    state,
    {
      type: "moveMeal",
      weekId,
      mealId: salmon.id,
      targetDate: addIsoDateDays(weekId, 6),
      slot: "dinner",
    },
    commandContext,
  );
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.state, beforeMove);
  assert.ok(Object.values(rejected.fieldErrors ?? {}).some((message) => /recorded date/i.test(message)));

  const invalidStoredState = structuredClone(state);
  invalidStoredState.weeks[0].data.leftovers[0].assignedDate = weekId;
  const validation = householdDomain.validateState(invalidStoredState);
  assert.equal(validation.ok, false);
  assert.ok(validation.issues.some((issue) => /after their source/i.test(issue.message)));
});
