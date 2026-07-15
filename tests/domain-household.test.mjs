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

test("setPrepPlan rejects duplicate step IDs before materializing prep references", () => {
  let createIdCalls = 0;
  const seedContext = createContext();
  const state = createCanonicalSeed(seedContext);
  const week = activeWeek(state);
  const stepId = week.data.meals[0].instructions[0].id;
  const prepDate = addIsoDateDays(week.id, -1);
  const context = {
    now: NOW,
    createId(prefix) {
      createIdCalls += 1;
      return `${prefix}-unexpected-${createIdCalls}`;
    },
  };

  const result = householdDomain.execute(
    state,
    {
      type: "setPrepPlan",
      weekId: week.id,
      entries: [
        { stepId, prepDate },
        { stepId, prepDate },
      ],
    },
    context,
  );

  assert.deepEqual(result, {
    ok: false,
    state,
    message: "Prep plan contains a duplicate instruction step.",
    fieldErrors: {
      "entries[1].stepId": "Each instruction step may appear in prep once.",
    },
  });
  assert.equal(createIdCalls, 0);
});

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
          yieldText: chicken.yieldText ?? null,
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

test("occupied leftover assignment replaces the destination recipe through consumption", () => {
  const context = createContext();
  let state = createCanonicalSeed(context);
  let week = activeWeek(state);
  const source = week.data.meals.find((meal) => meal.title === "Harissa chicken traybake");
  const destination = week.data.meals.find((meal) => meal.title === "Miso salmon rice bowls");
  assert.ok(source);
  assert.ok(destination);
  const displacedStepIds = new Set(destination.instructions.map((step) => step.id));

  let result = accepted(
    householdDomain.execute(
      state,
      {
        type: "updateMealStatus",
        weekId: week.id,
        mealId: source.id,
        status: "cooked",
      },
      context,
    ),
  );
  state = result.state;
  const leftoverId = result.createdIds.leftoverId;
  assert.ok(leftoverId);

  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "assignLeftover",
        weekId: week.id,
        leftoverId,
        targetDate: destination.date,
        slot: destination.slot,
      },
      context,
    ),
  );
  state = result.state;
  week = activeWeek(state);
  let replaced = week.data.meals.find((meal) => meal.id === destination.id);
  assert.equal(replaced.title, source.title);
  assert.equal(replaced.status, "leftover");
  assert.equal(replaced.protein, "none");
  assert.deepEqual(replaced.ingredients, []);
  assert.deepEqual(replaced.instructions, []);
  assert.equal(
    week.data.prep.some((reference) => displacedStepIds.has(reference.stepId)),
    false,
  );
  assert.deepEqual(householdDomain.validateState(state), { ok: true });

  result = accepted(
    householdDomain.execute(
      state,
      { type: "consumeLeftover", weekId: week.id, leftoverId },
      context,
    ),
  );
  state = result.state;
  week = activeWeek(state);
  replaced = week.data.meals.find((meal) => meal.id === destination.id);
  assert.equal(replaced.title, source.title);
  assert.equal(replaced.status, "cooked");
  assert.match(replaced.subtitle, /portions from Harissa chicken traybake/);
  assert.equal(week.data.leftovers.find((item) => item.id === leftoverId).state, "consumed");
  const leftoverCount = week.data.leftovers.length;
  state = accepted(
    householdDomain.execute(
      state,
      { type: "updateMealStatus", weekId: week.id, mealId: replaced.id, status: "planned" },
      context,
    ),
  ).state;
  result = accepted(
    householdDomain.execute(
      state,
      { type: "updateMealStatus", weekId: week.id, mealId: replaced.id, status: "cooked" },
      context,
    ),
  );
  state = result.state;
  assert.equal(result.createdIds.leftoverId, undefined);
  assert.equal(activeWeek(state).data.leftovers.length, leftoverCount);
  assert.deepEqual(householdDomain.validateState(state), { ok: true });
});

test("empty-slot leftover assignment materializes a dinner that survives consumption", () => {
  const context = createContext();
  let state = createCanonicalSeed(context);
  let week = activeWeek(state);
  const source = week.data.meals.find((meal) => meal.title === "Harissa chicken traybake");
  assert.ok(source);
  const emptyDate = addIsoDateDays(week.id, 6);
  assert.equal(week.data.meals.some((meal) => meal.date === emptyDate), false);

  let result = accepted(
    householdDomain.execute(
      state,
      {
        type: "updateMealStatus",
        weekId: week.id,
        mealId: source.id,
        status: "cooked",
      },
      context,
    ),
  );
  state = result.state;
  const leftoverId = result.createdIds.leftoverId;
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "assignLeftover",
        weekId: week.id,
        leftoverId,
        targetDate: emptyDate,
        slot: "dinner",
      },
      context,
    ),
  );
  state = result.state;
  const createdMealId = result.createdIds.mealId;
  assert.ok(createdMealId);
  week = activeWeek(state);
  let leftoverDinner = week.data.meals.find((meal) => meal.id === createdMealId);
  assert.equal(leftoverDinner.date, emptyDate);
  assert.equal(leftoverDinner.status, "leftover");
  assert.equal(leftoverDinner.protein, "none");

  state = accepted(
    householdDomain.execute(
      state,
      { type: "consumeLeftover", weekId: week.id, leftoverId },
      context,
    ),
  ).state;
  week = activeWeek(state);
  leftoverDinner = week.data.meals.find((meal) => meal.id === createdMealId);
  assert.equal(leftoverDinner.date, emptyDate);
  assert.equal(leftoverDinner.status, "cooked");
  assert.equal(week.data.leftovers.find((leftover) => leftover.id === leftoverId).state, "consumed");
  assert.deepEqual(householdDomain.validateState(state), { ok: true });
});

test("leftover portion parsing ignores calendar dates without a serving label", () => {
  const context = createContext();
  const state = createCanonicalSeed(context);
  const week = activeWeek(state);
  const source = week.data.meals.find((meal) => meal.title === "Harissa chicken traybake");
  source.leftoverNote = "Leftovers from 2026-07-07";
  const result = accepted(
    householdDomain.execute(
      state,
      {
        type: "updateMealStatus",
        weekId: week.id,
        mealId: source.id,
        status: "cooked",
      },
      context,
    ),
  );
  const leftover = activeWeek(result.state).data.leftovers.find(
    (candidate) => candidate.id === result.createdIds.leftoverId,
  );
  assert.equal(leftover.portions, 2);
});

test("occupied leftover assignment preserves meals referenced by other leftovers", () => {
  const context = createContext();
  let state = createCanonicalSeed(context);
  let week = activeWeek(state);
  const source = week.data.meals.find((meal) => meal.title === "Miso salmon rice bowls");
  const destination = week.data.meals.find((meal) => meal.title === "Harissa chicken traybake");
  assert.ok(source);
  assert.ok(destination);
  const sourceDate = addIsoDateDays(week.id, 2);
  const destinationDate = destination.date;
  const dependentLeftoverDate = addIsoDateDays(week.id, 6);

  state = accepted(
    householdDomain.execute(
      state,
      {
        type: "moveMeal",
        weekId: week.id,
        mealId: source.id,
        targetDate: sourceDate,
        slot: source.slot,
      },
      context,
    ),
  ).state;

  let result = accepted(
    householdDomain.execute(
      state,
      {
        type: "updateMealStatus",
        weekId: week.id,
        mealId: source.id,
        status: "cooked",
      },
      context,
    ),
  );
  state = result.state;
  const sourceLeftoverId = result.createdIds.leftoverId;
  assert.ok(sourceLeftoverId);

  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "updateMealStatus",
        weekId: week.id,
        mealId: destination.id,
        status: "cooked",
      },
      context,
    ),
  );
  state = result.state;
  const destinationLeftoverId = result.createdIds.leftoverId;
  assert.ok(destinationLeftoverId);

  const lockedSourceState = structuredClone(state);
  const statusDowngrade = householdDomain.execute(
    state,
    {
      type: "updateMealStatus",
      weekId: week.id,
      mealId: destination.id,
      status: "planned",
    },
    context,
  );
  assert.equal(statusDowngrade.ok, false);
  assert.match(statusDowngrade.message, /tracked leftovers/i);
  assert.deepEqual(statusDowngrade.state, lockedSourceState);

  const sourceMove = householdDomain.execute(
    state,
    {
      type: "moveMeal",
      weekId: week.id,
      mealId: destination.id,
      targetDate: addIsoDateDays(week.id, 5),
      slot: "dinner",
    },
    context,
  );
  assert.equal(sourceMove.ok, false);
  assert.match(sourceMove.message, /tracked leftovers/i);
  assert.deepEqual(sourceMove.state, lockedSourceState);
  assert.deepEqual(householdDomain.validateState(state), { ok: true });

  for (const dependentState of ["available", "assigned", "consumed"]) {
    let scenario = structuredClone(state);
    if (dependentState !== "available") {
      scenario = accepted(
        householdDomain.execute(
          scenario,
          {
            type: "assignLeftover",
            weekId: week.id,
            leftoverId: destinationLeftoverId,
            targetDate: dependentLeftoverDate,
            slot: "dinner",
          },
          context,
        ),
      ).state;
    }
    if (dependentState === "consumed") {
      scenario = accepted(
        householdDomain.execute(
          scenario,
          {
            type: "consumeLeftover",
            weekId: week.id,
            leftoverId: destinationLeftoverId,
          },
          context,
        ),
      ).state;
    }
    const beforeAssignment = structuredClone(scenario);

    const blocked = householdDomain.execute(
      scenario,
      {
        type: "assignLeftover",
        weekId: week.id,
        leftoverId: sourceLeftoverId,
        targetDate: destinationDate,
        slot: destination.slot,
      },
      context,
    );
    assert.equal(blocked.ok, false, dependentState);
    assert.match(blocked.message, /tracked leftovers/i, dependentState);
    assert.deepEqual(blocked.state, beforeAssignment, dependentState);
    week = activeWeek(blocked.state);
    const dependentLeftover = week.data.leftovers.find(
      (leftover) => leftover.id === destinationLeftoverId,
    );
    assert.equal(dependentLeftover.sourceMealId, destination.id, dependentState);
    assert.equal(dependentLeftover.state, dependentState, dependentState);
    assert.deepEqual(householdDomain.validateState(blocked.state), { ok: true });
  }
});

function sourcedRecipe() {
  return {
    title: "Primary-page lentil soup",
    yieldText: "4 bowls",
    source: {
      kind: "web",
      identity: "Example Kitchen",
      url: "https://example.com/recipes/lentil-soup",
      retrievedAt: 1_750_000_000_000,
    },
    steps: [{
      inputs: [
        { amount: "1 cup", ingredient: "lentils" },
        { amount: "1 cup", ingredient: "lentils" },
      ],
      instruction: "Simmer the lentils.",
      timerDurationSeconds: 900,
    }],
  };
}

function replacementReadyState() {
  const context = createContext();
  const state = createCanonicalSeed(context);
  const week = activeWeek(state);
  const meal = week.data.meals[0];
  week.data.prep = [];
  for (const step of meal.instructions) {
    step.complete = false;
    delete step.note;
    delete step.timerStartedAt;
  }
  meal.status = "planned";
  return { state, week, meal, context };
}

test("sourced replacement changes only recipe fields with ordered duplicate inputs and shared IDs", () => {
  const { state, week, meal, context } = replacementReadyState();
  const preserved = {
    id: meal.id,
    date: meal.date,
    slot: meal.slot,
    status: meal.status,
    subtitle: meal.subtitle,
    venue: meal.venue,
    protein: meal.protein,
    prepNote: meal.prepNote,
    leftoverNote: meal.leftoverNote,
    notes: meal.notes,
  };
  const result = accepted(householdDomain.execute(state, {
    type: "replaceMealRecipeFromSource",
    weekId: week.id,
    mealId: meal.id,
    recipe: sourcedRecipe(),
  }, context));
  const replaced = activeWeek(result.state).data.meals.find((candidate) => candidate.id === meal.id);
  assert.deepEqual({
    id: replaced.id,
    date: replaced.date,
    slot: replaced.slot,
    status: replaced.status,
    subtitle: replaced.subtitle,
    venue: replaced.venue,
    protein: replaced.protein,
    prepNote: replaced.prepNote,
    leftoverNote: replaced.leftoverNote,
    notes: replaced.notes,
  }, preserved);
  assert.equal(replaced.title, "Primary-page lentil soup");
  assert.equal(replaced.yieldText, "4 bowls");
  assert.deepEqual(replaced.ingredients, ["1 cup lentils", "1 cup lentils"]);
  assert.deepEqual(replaced.sourceRecipe, sourcedRecipe().source);
  assert.equal(replaced.instructions.length, 1);
  assert.equal(replaced.instructions[0].complete, false);
  assert.equal(replaced.instructions[0].id, result.createdIds["instructionStep.0"]);
});

test("sourced replacement omission clears an existing yield while persisting source metadata", () => {
  const { state, week, meal, context } = replacementReadyState();
  meal.yieldText = "Old household yield";
  const recipe = sourcedRecipe();
  delete recipe.yieldText;
  const result = accepted(householdDomain.execute(state, {
    type: "replaceMealRecipeFromSource",
    weekId: week.id,
    mealId: meal.id,
    recipe,
  }, context));
  const replaced = activeWeek(result.state).data.meals.find((candidate) => candidate.id === meal.id);
  assert.equal(replaced.yieldText, undefined);
  assert.deepEqual(replaced.sourceRecipe, recipe.source);
});

test("generic meal snapshots clear or update yield without laundering source provenance", () => {
  for (const yieldText of [null, "6 servings"]) {
    const { state, week, meal, context } = replacementReadyState();
    meal.yieldText = "Old household yield";
    meal.sourceRecipe = structuredClone(sourcedRecipe().source);
    const sourceBefore = structuredClone(meal.sourceRecipe);
    const result = accepted(householdDomain.execute(state, {
      type: "updateMealSnapshot",
      weekId: week.id,
      mealId: meal.id,
      changes: {
        title: `${meal.title} refreshed`,
        subtitle: meal.subtitle,
        venue: meal.venue,
        prepNote: meal.prepNote,
        leftoverNote: meal.leftoverNote,
        notes: meal.notes,
        ingredients: meal.ingredients,
        yieldText,
      },
    }, context));
    const updated = activeWeek(result.state).data.meals.find((candidate) => candidate.id === meal.id);
    assert.equal(updated.yieldText, yieldText === null ? undefined : yieldText);
    assert.deepEqual(updated.sourceRecipe, sourceBefore);
  }
});

test("each protected canonical state class and immutable target lifecycle rejects replacement", () => {
  const mutateCases = [
    ["completed", ({ meal }) => { meal.instructions[0].complete = true; }],
    ["note", ({ meal }) => { meal.instructions[0].note = "keep"; }],
    ["timer", ({ meal }) => { meal.instructions[0].timerStartedAt = NOW; }],
    ["prep", ({ week, meal }) => {
      week.data.prep.push({
        id: "prep-protected",
        stepId: meal.instructions[0].id,
        prepDate: addIsoDateDays(week.id, -1),
        position: 0,
      });
    }],
    ["meal status", ({ meal }) => { meal.status = "cooking"; }],
    ["week status", ({ state, week }) => {
      week.status = "archived";
      state.activeWeekId = null;
    }],
  ];
  for (const [label, mutate] of mutateCases) {
    const fixture = replacementReadyState();
    mutate(fixture);
    const result = householdDomain.execute(fixture.state, {
      type: "replaceMealRecipeFromSource",
      weekId: fixture.week.id,
      mealId: fixture.meal.id,
      recipe: sourcedRecipe(),
    }, fixture.context);
    assert.equal(result.ok, false, label);
    assert.equal(result.state, fixture.state, label);
  }
});
