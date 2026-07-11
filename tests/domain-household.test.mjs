import assert from "node:assert/strict";
import test from "node:test";

import { createCanonicalSeed } from "../lib/household-bootstrap.ts";
import {
  addIsoDateDays,
  householdDomain,
} from "../lib/household-domain.ts";

const NOW = Date.parse("2026-07-10T12:00:00-03:00");

function createContext() {
  const counts = new Map();
  return {
    now: NOW,
    createId(prefix) {
      const count = (counts.get(prefix) ?? 0) + 1;
      counts.set(prefix, count);
      return `${prefix}-${count}`;
    },
  };
}

function accepted(result) {
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
  return result;
}

function activeWeek(state) {
  return state.weeks.find((week) => week.id === state.activeWeekId);
}

test("household domain executes every week-local command through one pure boundary", () => {
  const context = createContext();
  let state = createCanonicalSeed(context);
  const original = structuredClone(state);
  let week = activeWeek(state);
  const weekId = week.id;
  const chicken = week.data.meals[0];
  const salmon = week.data.meals[1];
  const firstStep = chicken.instructions[0];
  const secondStep = chicken.instructions[1];

  let result = accepted(
    householdDomain.execute(
      state,
      {
        type: "updateMealSnapshot",
        weekId,
        mealId: chicken.id,
        changes: {
          title: "Harissa chicken and chickpeas",
          subtitle: chicken.subtitle,
          venue: "Picnic",
          prepNote: chicken.prepNote,
          leftoverNote: chicken.leftoverNote,
          notes: "Pack the yogurt separately.",
          ingredients: [...chicken.ingredients, "1 cup lemon yogurt"],
        },
      },
      context,
    ),
  );
  assert.deepEqual(state, original, "execution must not mutate the caller's state");
  state = result.state;
  assert.equal(activeWeek(state).data.meals[0].venue, "Picnic");

  week = activeWeek(state);
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "addInstructionStep",
        weekId,
        mealId: chicken.id,
        position: week.data.meals[0].instructions.length,
        step: {
          inputs: [{ amount: "1 cup", ingredient: "lemon yogurt" }],
          instruction: "Pack the yogurt in a separate container.",
        },
      },
      context,
    ),
  );
  state = result.state;
  const addedStepId = result.createdIds.instructionStepId;
  assert.ok(addedStepId);

  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "updateInstructionStep",
        weekId,
        stepId: addedStepId,
        changes: {
          inputs: [{ amount: "1 cup", ingredient: "lemon yogurt sauce" }],
          instruction: "Chill the sauce, then pack it separately.",
          timerDurationSeconds: 300,
        },
      },
      context,
    ),
  );
  state = result.state;
  result = accepted(
    householdDomain.execute(
      state,
      { type: "moveInstructionStep", weekId, stepId: addedStepId, targetPosition: 0 },
      context,
    ),
  );
  state = result.state;
  assert.equal(activeWeek(state).data.meals[0].instructions[0].id, addedStepId);

  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "updateInstructionStepNote",
        weekId,
        stepId: addedStepId,
        note: "Use the small blue container.",
      },
      context,
    ),
  );
  state = result.state;
  result = accepted(
    householdDomain.execute(
      state,
      { type: "startInstructionTimer", weekId, stepId: addedStepId },
      context,
    ),
  );
  state = result.state;
  assert.equal(activeWeek(state).data.meals[0].instructions[0].timerStartedAt, NOW);
  result = accepted(
    householdDomain.execute(
      state,
      { type: "setInstructionStepComplete", weekId, stepId: addedStepId, complete: true },
      context,
    ),
  );
  state = result.state;
  assert.equal(activeWeek(state).data.meals[0].instructions[0].timerStartedAt, undefined);
  result = accepted(
    householdDomain.execute(
      state,
      { type: "setInstructionStepComplete", weekId, stepId: addedStepId, complete: false },
      context,
    ),
  );
  state = result.state;
  result = accepted(
    householdDomain.execute(
      state,
      { type: "startInstructionTimer", weekId, stepId: addedStepId },
      context,
    ),
  );
  state = result.state;
  result = accepted(
    householdDomain.execute(
      state,
      { type: "resetInstructionTimer", weekId, stepId: addedStepId },
      context,
    ),
  );
  state = result.state;
  assert.equal(activeWeek(state).data.meals[0].instructions[0].timerStartedAt, undefined);
  result = accepted(
    householdDomain.execute(
      state,
      { type: "updateInstructionStepNote", weekId, stepId: addedStepId, note: "" },
      context,
    ),
  );
  state = result.state;
  result = accepted(
    householdDomain.execute(
      state,
      { type: "removeInstructionStep", weekId, stepId: addedStepId },
      context,
    ),
  );
  state = result.state;

  const sundayBefore = addIsoDateDays(weekId, -1);
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "setPrepPlan",
        weekId,
        entries: [
          { stepId: firstStep.id, prepDate: sundayBefore },
          { stepId: secondStep.id, prepDate: sundayBefore },
        ],
      },
      context,
    ),
  );
  state = result.state;
  week = activeWeek(state);
  assert.deepEqual(week.data.prep.map((reference) => reference.position), [0, 1]);
  const firstReference = week.data.prep[0];
  const secondReference = week.data.prep[1];
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "movePrepReference",
        weekId,
        referenceId: secondReference.id,
        targetPosition: 0,
      },
      context,
    ),
  );
  state = result.state;
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "reschedulePrepReference",
        weekId,
        referenceId: firstReference.id,
        prepDate: weekId,
      },
      context,
    ),
  );
  state = result.state;
  assert.deepEqual(
    activeWeek(state).data.prep.map(({ prepDate, position }) => ({ prepDate, position })),
    [
      { prepDate: sundayBefore, position: 0 },
      { prepDate: weekId, position: 0 },
    ],
  );
  result = accepted(
    householdDomain.execute(
      state,
      { type: "removePrepReference", weekId, referenceId: firstReference.id },
      context,
    ),
  );
  state = result.state;
  assert.ok(activeWeek(state).data.meals[0].instructions.some((step) => step.id === firstStep.id));

  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "addGroceryItem",
        weekId,
        item: {
          section: "Dairy",
          item: "Greek yogurt",
          detail: "750 g",
          farmBox: false,
        },
      },
      context,
    ),
  );
  state = result.state;
  const addedGroceryId = result.createdIds.groceryItemId;
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "updateGroceryItem",
        weekId,
        itemId: addedGroceryId,
        changes: {
          section: "Dairy",
          item: "Plain Greek yogurt",
          detail: "1 x 750 g tub",
          farmBox: false,
        },
      },
      context,
    ),
  );
  state = result.state;
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "setGroceryItemChecked",
        weekId,
        itemId: addedGroceryId,
        checked: true,
      },
      context,
    ),
  );
  state = result.state;
  result = accepted(
    householdDomain.execute(
      state,
      { type: "removeGroceryItem", weekId, itemId: addedGroceryId },
      context,
    ),
  );
  state = result.state;
  const retainedGrocery = activeWeek(state).data.groceries[0];
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "reconcileGroceries",
        weekId,
        items: [
          {
            id: retainedGrocery.id,
            section: retainedGrocery.section,
            item: retainedGrocery.item,
            detail: retainedGrocery.detail,
            farmBox: retainedGrocery.farmBox,
            checked: true,
          },
          {
            section: "Produce",
            item: "Farm-box greens",
            detail: "1 bunch",
            farmBox: true,
            checked: true,
          },
        ],
      },
      context,
    ),
  );
  state = result.state;
  assert.equal(activeWeek(state).data.groceries.length, 2);
  assert.ok(result.createdIds["groceryItem.1"]);
  assert.equal(activeWeek(state).data.farmBoxReconciled, true);

  result = accepted(
    householdDomain.execute(
      state,
      { type: "captureFeedback", weekId, mealId: chicken.id, value: "repeat" },
      context,
    ),
  );
  state = result.state;
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "captureWeekLesson",
        weekId,
        weekLesson: "Pack sauces separately and keep the prep list short.",
      },
      context,
    ),
  );
  state = result.state;

  result = accepted(
    householdDomain.execute(
      state,
      { type: "updateMealStatus", weekId, mealId: salmon.id, status: "cooked" },
      context,
    ),
  );
  state = result.state;
  const leftoverId = result.createdIds.leftoverId;
  assert.ok(leftoverId);
  result = accepted(
    householdDomain.execute(
      state,
      { type: "captureLeftoverQuality", weekId, leftoverId, quality: "good" },
      context,
    ),
  );
  state = result.state;
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "assignLeftover",
        weekId,
        leftoverId,
        targetDate: addIsoDateDays(weekId, 6),
        slot: "dinner",
      },
      context,
    ),
  );
  state = result.state;
  result = accepted(
    householdDomain.execute(
      state,
      { type: "consumeLeftover", weekId, leftoverId },
      context,
    ),
  );
  state = result.state;
  assert.equal(activeWeek(state).data.leftovers.find((item) => item.id === leftoverId).state, "consumed");
  assert.deepEqual(householdDomain.validateState(state), { ok: true });
});

test("step deletion is reference-safe and archived weeks reject week-local mutation", () => {
  const context = createContext();
  let state = createCanonicalSeed(context);
  const week = activeWeek(state);
  const referencedStepId = week.data.prep[0].stepId;
  const blocked = householdDomain.execute(
    state,
    { type: "removeInstructionStep", weekId: week.id, stepId: referencedStepId },
    context,
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /prep/i);

  state = accepted(
    householdDomain.execute(state, { type: "archiveWeek", weekId: week.id }, context),
  ).state;
  const archivedEdit = householdDomain.execute(
    state,
    {
      type: "captureWeekLesson",
      weekId: week.id,
      weekLesson: "This must not land.",
    },
    context,
  );
  assert.equal(archivedEdit.ok, false);
  assert.match(archivedEdit.message, /read-only/i);
});
