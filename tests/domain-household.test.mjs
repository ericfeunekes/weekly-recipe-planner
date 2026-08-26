import assert from "node:assert/strict";
import test from "node:test";

import { createCanonicalSeed } from "../lib/household-bootstrap.ts";
import {
  addIsoDateDays,
  householdDomain,
} from "../lib/household-domain.ts";
import {
  MAX_GROCERY_ITEMS,
  MAX_INGREDIENT_LINES,
  MAX_MEALS_PER_WEEK,
} from "../lib/household-command-contract.ts";
import { ingredientCandidateDigest } from "../lib/ingredient-catalogue.ts";

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

function retainOccurrences(meal, overrides = {}) {
  return meal.ingredients.map((ingredient) => ({
    kind: "retain",
    occurrenceId: ingredient.id,
    source: ingredient.source,
    amount: ingredient.amount,
    unit: ingredient.unit,
    ingredient: ingredient.ingredient,
    qualifier: ingredient.qualifier,
    conceptId: ingredient.conceptId,
    ...overrides[ingredient.id],
  }));
}

function recipeChanges(meal, overrides = {}) {
  return {
    title: meal.title,
    subtitle: meal.subtitle,
    venue: meal.venue,
    prepNote: meal.prepNote,
    leftoverNote: meal.leftoverNote,
    notes: meal.notes,
    yieldText: meal.yieldText ?? null,
    ...overrides,
  };
}

test("date-first prep commands reject duplicate instruction selections before materializing references", () => {
  let createIdCalls = 0;
  const seedContext = createContext();
  const state = createCanonicalSeed(seedContext);
  const week = activeWeek(state);
  const stepId = week.data.meals[0].instructions[0].id;
  const prepDate = addIsoDateDays(week.id, -2);
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
      type: "addPrepStepsToDate",
      weekId: week.id,
      prepDate,
      stepIds: [stepId, stepId],
      targetPosition: 0,
    },
    context,
  );

  assert.equal(result.ok, false);
  assert.equal(result.state, state);
  assert.match(result.message, /each instruction once/i);
  assert.equal(createIdCalls, 0);
});

test("cooked meals reject resolution-batch occurrence creation without mutation", () => {
  const context = createContext();
  let state = createCanonicalSeed(context);
  const week = activeWeek(state);
  const meal = week.data.meals[0];
  state = accepted(householdDomain.execute(state, {
    type: "updateMealStatus", weekId: week.id, mealId: meal.id, status: "cooked",
  }, { ...context, cookingAnchor: { eventId: "cooked-event", plannerVersion: 1 } })).state;
  const frozen = structuredClone(state);
  const occurrence = { kind: "create", correlationId: "frozen-new", source: "1 lemon", amount: "1", unit: null, ingredient: "lemon", qualifier: null, conceptId: null, canonicalIngredientId: null };
  const inputs = [{ correlationId: "frozen-new", mealId: meal.id, source: occurrence.source, amount: occurrence.amount, unit: occurrence.unit, ingredient: occurrence.ingredient, qualifier: occurrence.qualifier, conceptId: occurrence.conceptId, canonicalIngredientId: occurrence.canonicalIngredientId }];
  const result = householdDomain.execute(state, {
    type: "applyIngredientResolutionBatch", weekId: week.id,
    catalogueRevision: state.ingredientCatalogue.revision, inputDigest: ingredientCandidateDigest(inputs),
    decisions: [{ correlationId: "frozen-new", mealId: meal.id, occurrence, decision: { kind: "unresolved" } }],
  }, context);
  assert.equal(result.ok, false);
  assert.deepEqual(result.state, frozen);
  assert.match(result.message, /frozen/i);
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
        type: "editMealRecipe",
        weekId,
        mealId: chicken.id,
        changes: recipeChanges(chicken, { title: "Harissa chicken and chickpeas", venue: "Picnic", notes: "Pack the yogurt separately." }),
        occurrences: [...retainOccurrences(chicken), {
          kind: "create", correlationId: "lemon-yogurt", source: "1 cup lemon yogurt", amount: "1", unit: "cup", ingredient: "lemon yogurt", qualifier: null, conceptId: null, canonicalIngredientId: null,
        }],
        removedOccurrenceIds: [],
      },
      context,
    ),
  );
  assert.deepEqual(state, original, "execution must not mutate the caller's state");
  state = result.state;
  assert.equal(activeWeek(state).data.meals[0].venue, "Picnic");
  const lemonYogurtId = result.createdIds["lemon-yogurt"];
  assert.ok(lemonYogurtId);

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
          inputs: [{ kind: "retain", occurrenceId: lemonYogurtId, amount: "1 cup", ingredient: "lemon yogurt" }],
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
        type: "editInstructionStep",
        weekId,
        stepId: addedStepId,
        changes: {
          inputs: [{ kind: "retain", occurrenceId: lemonYogurtId, amount: "1 cup", ingredient: "lemon yogurt sauce" }],
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
      { type: "setInstructionTimerRemaining", weekId, stepId: addedStepId, remainingSeconds: 420 },
      context,
    ),
  );
  state = result.state;
  assert.equal(activeWeek(state).data.meals[0].instructions[0].timerDurationSeconds, 300);
  assert.equal(activeWeek(state).data.meals[0].instructions[0].timerRemainingSeconds, 420);
  assert.equal(activeWeek(state).data.meals[0].instructions[0].timerStartedAt, undefined);
  result = accepted(
    householdDomain.execute(
      state,
      { type: "startInstructionTimer", weekId, stepId: addedStepId },
      context,
    ),
  );
  state = result.state;
  const laterContext = { ...context, now: NOW + 60_000 };
  result = accepted(
    householdDomain.execute(
      state,
      { type: "pauseInstructionTimer", weekId, stepId: addedStepId },
      laterContext,
    ),
  );
  state = result.state;
  assert.equal(activeWeek(state).data.meals[0].instructions[0].timerDurationSeconds, 300);
  assert.equal(activeWeek(state).data.meals[0].instructions[0].timerRemainingSeconds, 360);
  assert.equal(activeWeek(state).data.meals[0].instructions[0].timerStartedAt, undefined);
  assert.equal(activeWeek(state).data.meals[0].instructions[0].timerPaused, true);
  result = accepted(
    householdDomain.execute(
      state,
      { type: "startInstructionTimer", weekId, stepId: addedStepId },
      laterContext,
    ),
  );
  state = result.state;
  assert.equal(activeWeek(state).data.meals[0].instructions[0].timerStartedAt, laterContext.now);
  assert.equal(activeWeek(state).data.meals[0].instructions[0].timerPaused, undefined);
  const editedContext = { ...context, now: NOW + 90_000 };
  result = accepted(
    householdDomain.execute(
      state,
      { type: "setInstructionTimerRemaining", weekId, stepId: addedStepId, remainingSeconds: 120 },
      editedContext,
    ),
  );
  state = result.state;
  assert.equal(activeWeek(state).data.meals[0].instructions[0].timerDurationSeconds, 300);
  assert.equal(activeWeek(state).data.meals[0].instructions[0].timerRemainingSeconds, 120);
  assert.equal(activeWeek(state).data.meals[0].instructions[0].timerStartedAt, editedContext.now);
  result = accepted(
    householdDomain.execute(
      state,
      { type: "resetInstructionTimer", weekId, stepId: addedStepId },
      laterContext,
    ),
  );
  state = result.state;
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

  const sundayBefore = addIsoDateDays(weekId, -2);
  result = accepted(
    householdDomain.execute(
      state,
      { type: "addPrepStepsToDate", weekId, prepDate: sundayBefore, stepIds: [firstStep.id], targetPosition: 0 },
      context,
    ),
  );
  state = result.state;
  const firstEntryId = result.createdIds["prepDateStep.0"];
  assert.ok(firstEntryId);
  result = accepted(
    householdDomain.execute(
      state,
      { type: "addPrepStepsToDate", weekId, prepDate: weekId, stepIds: [secondStep.id], targetPosition: 0 },
      context,
    ),
  );
  state = result.state;
  const secondEntryId = result.createdIds["prepDateStep.0"];
  assert.ok(secondEntryId);
  result = accepted(
    householdDomain.execute(
      state,
      { type: "addPrepStepsToDate", weekId, prepDate: sundayBefore, stepIds: [secondStep.id], targetPosition: 0 },
      context,
    ),
  );
  state = result.state;
  assert.deepEqual(
    activeWeek(state).data.prepSessions.find((session) => session.prepDate === sundayBefore).steps.map((entry) => entry.stepId),
    [secondStep.id, firstStep.id],
    "a prep date can schedule distinct canonical steps in an explicit queue order",
  );
  result = accepted(
    householdDomain.execute(
      state,
      { type: "movePrepStepsToDate", weekId, sourcePrepDate: sundayBefore, prepDate: sundayBefore, entryIds: [firstEntryId], targetPosition: 0 },
      context,
    ),
  );
  state = result.state;
  assert.deepEqual(
    activeWeek(state).data.prepSessions.find((session) => session.prepDate === sundayBefore).steps.map((entry) => entry.stepId),
    [firstStep.id, secondStep.id],
    "a prep date's queue can be reordered without changing recipe order",
  );
  result = accepted(
    householdDomain.execute(
      state,
      { type: "removePrepStepsFromDate", weekId, prepDate: weekId, entryIds: [secondEntryId] },
      context,
    ),
  );
  state = result.state;
  assert.ok(activeWeek(state).data.meals[0].instructions.some((step) => step.id === firstStep.id));
  assert.equal(
    activeWeek(state).data.prepSessions.some((session) => session.prepDate === weekId),
    false,
    "removing a final prep reference clears its date queue but preserves the canonical instruction",
  );

  const tuesday = addIsoDateDays(weekId, 1);
  result = accepted(
    householdDomain.execute(
      state,
      { type: "addPrepStepsToDate", weekId, prepDate: tuesday, stepIds: [firstStep.id, secondStep.id], targetPosition: 0 },
      context,
    ),
  );
  state = result.state;
  const tuesdayEntries = activeWeek(state).data.prepSessions.find((session) => session.prepDate === tuesday).steps;
  result = accepted(
    householdDomain.execute(
      state,
      { type: "movePrepStepsToDate", weekId, sourcePrepDate: tuesday, prepDate: weekId, entryIds: [tuesdayEntries[1].id, tuesdayEntries[0].id], targetPosition: 0 },
      context,
    ),
  );
  state = result.state;
  assert.deepEqual(
    activeWeek(state).data.prepSessions.find((session) => session.prepDate === weekId).steps.map((entry) => entry.stepId),
    [firstStep.id, secondStep.id],
    "a multi-step date move preserves source queue order even if its selection arrives out of order",
  );
  const mondayEntries = activeWeek(state).data.prepSessions.find((session) => session.prepDate === weekId).steps;
  result = accepted(
    householdDomain.execute(
      state,
      { type: "movePrepStepsToDate", weekId, sourcePrepDate: weekId, prepDate: weekId, entryIds: [mondayEntries[0].id], targetPosition: 2 },
      context,
    ),
  );
  state = result.state;
  assert.deepEqual(
    activeWeek(state).data.prepSessions.find((session) => session.prepDate === weekId).steps.map((entry) => entry.stepId),
    [secondStep.id, firstStep.id],
    "a date queue accepts the end boundary used by the visible insertion indicator",
  );

  const earlierPrepDate = addIsoDateDays(weekId, -14);
  const entriesToMoveEarlier = activeWeek(state).data.prepSessions.find((session) => session.prepDate === weekId).steps.map((entry) => entry.id);
  result = accepted(
    householdDomain.execute(
      state,
      { type: "movePrepStepsToDate", weekId, sourcePrepDate: weekId, prepDate: earlierPrepDate, entryIds: entriesToMoveEarlier, targetPosition: 0 },
      context,
    ),
  );
  state = result.state;
  const earlierSession = activeWeek(state).data.prepSessions.find((session) => session.prepDate === earlierPrepDate);
  assert.ok(earlierSession, "moving to an earlier calendar date creates that date's prep queue");
  assert.deepEqual(earlierSession.steps.map((entry) => entry.stepId), [secondStep.id, firstStep.id]);
  result = accepted(
    householdDomain.execute(state, { type: "clearPrepDate", weekId, prepDate: earlierPrepDate }, context),
  );
  state = result.state;
  assert.equal(activeWeek(state).data.prepSessions.some((session) => session.prepDate === earlierPrepDate), false);
  const afterMealWeek = householdDomain.execute(
    state,
    { type: "addPrepStepsToDate", weekId, prepDate: addIsoDateDays(weekId, 7), stepIds: [firstStep.id], targetPosition: 0 },
    context,
  );
  assert.equal(afterMealWeek.ok, false, "prep may be earlier, but never after the owning meal week");

  const ingredientCount = activeWeek(state).data.meals.reduce((count, meal) => count + meal.ingredients.length, 0);
  assert.equal(activeWeek(state).data.groceries.length, ingredientCount, "every canonical ingredient has one grocery execution row");
  const grocery = activeWeek(state).data.groceries.find((item) => item.mealId === chicken.id);
  assert.ok(grocery);
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "setGroceryItemChecked",
        weekId,
        itemId: grocery.id,
        checked: true,
      },
      context,
    ),
  );
  state = result.state;
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "setGroceryItemsCoverage",
        weekId,
        itemIds: [grocery.id],
        coverage: "on_hand",
      },
      context,
    ),
  );
  state = result.state;
  const retainedGrocery = activeWeek(state).data.groceries.find((item) => item.id === grocery.id);
  assert.ok(retainedGrocery);
  assert.equal(retainedGrocery.mealId, chicken.id);
  assert.equal(retainedGrocery.checked, true);
  assert.equal(retainedGrocery.coverage, "on_hand");

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

test("grocery projection rejects missing and duplicate canonical ingredient identities", () => {
  const context = createContext();
  const state = createCanonicalSeed(context);
  const week = activeWeek(state);
  const grocery = week.data.groceries[0];
  assert.ok(grocery);

  const missingIngredient = structuredClone(state);
  missingIngredient.weeks[0].data.groceries[0].ingredientId = "ingredient-missing";
  assert.equal(householdDomain.validateState(missingIngredient).ok, false);

  const duplicateIngredient = structuredClone(state);
  duplicateIngredient.weeks[0].data.groceries.push({ ...grocery, id: "grocery-duplicate" });
  assert.equal(householdDomain.validateState(duplicateIngredient).ok, false);

  const unsupportedSource = structuredClone(state);
  unsupportedSource.weeks[0].data.groceries[0].coverage = "delivery";
  assert.equal(householdDomain.validateState(unsupportedSource).ok, false);
});

test("a fully populated scheduled week projects every canonical ingredient", () => {
  const context = createContext();
  const state = createCanonicalSeed(context);
  const weekStartDate = "2026-07-13";
  const meals = Array.from({ length: MAX_MEALS_PER_WEEK }, (_, mealIndex) => ({
    date: addIsoDateDays(weekStartDate, mealIndex % 7),
    title: `Maximum grocery meal ${mealIndex + 1}`,
    subtitle: "",
    venue: "Home",
    protein: "none",
    prepNote: "",
    leftoverNote: "",
    notes: "",
    occurrences: Array.from(
      { length: MAX_INGREDIENT_LINES },
      (_, ingredientIndex) => ({ kind: "create", correlationId: `ingredient-${mealIndex}-${ingredientIndex}`, source: null, amount: `${ingredientIndex + 1}`, unit: "g", ingredient: `ingredient ${mealIndex + 1}-${ingredientIndex + 1}`, qualifier: null, conceptId: null, canonicalIngredientId: null }),
    ),
    instructions: [],
  }));

  const result = accepted(householdDomain.execute(state, {
    type: "createWeekPlan",
    weekStartDate,
    plan: { meals },
  }, context));
  const createdWeek = result.state.weeks.find((week) => week.id === weekStartDate);
  assert.ok(createdWeek);
  assert.equal(createdWeek.data.groceries.length, meals.length * MAX_INGREDIENT_LINES);
  assert.equal(createdWeek.data.groceries.length, MAX_GROCERY_ITEMS);
  assert.equal(
    new Set(createdWeek.data.groceries.map((grocery) => `${grocery.mealId}\u0000${grocery.ingredientId}`)).size,
    createdWeek.data.groceries.length,
  );
  assert.deepEqual(householdDomain.validateState(result.state), { ok: true });
});

test("bulk grocery coverage changes are atomic and preserve grocery identities", () => {
  const context = createContext();
  const original = createCanonicalSeed(context);
  const week = activeWeek(original);
  const selected = week.data.groceries.filter((item) => item.coverage === "needs_source").slice(0, 2);
  assert.equal(selected.length, 2);
  const expected = new Map(selected.map((item) => [item.id, {
    checked: item.checked,
    section: item.section,
    mealId: item.mealId,
    ingredientId: item.ingredientId,
  }]));

  const moved = accepted(
    householdDomain.execute(
      original,
      {
        type: "setGroceryItemsCoverage",
        weekId: week.id,
        itemIds: selected.map((item) => item.id),
        coverage: "farm_box",
      },
      context,
    ),
  );
  for (const itemId of expected.keys()) {
    const item = activeWeek(moved.state).data.groceries.find((candidate) => candidate.id === itemId);
    assert.ok(item);
    assert.equal(item.coverage, "farm_box");
    assert.deepEqual(
      { checked: item.checked, section: item.section, mealId: item.mealId, ingredientId: item.ingredientId },
      expected.get(itemId),
    );
  }

  for (const command of [
    {
      type: "setGroceryItemsCoverage",
      weekId: week.id,
      itemIds: [selected[0].id, "grocery-missing"],
      coverage: "on_hand",
    },
    {
      type: "setGroceryItemsCoverage",
      weekId: week.id,
      itemIds: selected.map((item) => item.id),
      coverage: "needs_source",
    },
  ]) {
    const rejected = householdDomain.execute(original, command, context);
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.state, original, "a rejected bulk move must leave every selected item untouched");
  }
});

test("step deletion is reference-safe and archived weeks reject week-local mutation", () => {
  const context = createContext();
  let state = createCanonicalSeed(context);
  const week = activeWeek(state);
  const referencedStepId = week.data.prepSessions[0].steps[0].stepId;
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

test("leftover assignment adds another meal on an occupied day", () => {
  const context = createContext();
  let state = createCanonicalSeed(context);
  let week = activeWeek(state);
  const source = week.data.meals.find((meal) => meal.title === "Harissa chicken traybake");
  const destination = week.data.meals.find((meal) => meal.title === "Miso salmon rice bowls");
  assert.ok(source);
  assert.ok(destination);
  assert.equal(
    week.data.groceries.some((grocery) => grocery.mealId === destination.id),
    true,
    "the displaced dinner starts with grocery provenance",
  );

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
  assert.equal(replaced.title, destination.title);
  assert.equal(week.data.groceries.some((grocery) => grocery.mealId === destination.id), true);
  const leftoverMealId = result.createdIds.mealId;
  replaced = week.data.meals.find((meal) => meal.id === leftoverMealId);
  assert.equal(replaced.status, "leftover");
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
  replaced = week.data.meals.find((meal) => meal.id === leftoverMealId);
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

test("leftover assignment does not displace meals referenced by other leftovers", () => {
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
    assert.equal(blocked.ok, true, dependentState);
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
    occurrences: [{
      kind: "create", correlationId: "lentils", source: "1 cup brown lentils, rinsed", amount: "1", unit: "cup", ingredient: "lentils", qualifier: "brown, rinsed", conceptId: "lentil", canonicalIngredientId: 7,
    }],
    steps: [{
      inputs: [
        { occurrenceCorrelationId: "lentils", amount: "1 cup", ingredient: "lentils" },
        { occurrenceCorrelationId: "lentils", amount: "1 cup", ingredient: "lentils" },
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
  week.data.prepSessions = [];
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
  assert.deepEqual(replaced.ingredients.map((occurrence) => ({
    source: occurrence.source,
    amount: occurrence.amount,
    unit: occurrence.unit,
    ingredient: occurrence.ingredient,
    qualifier: occurrence.qualifier,
    conceptId: occurrence.conceptId,
    canonicalIngredientId: occurrence.canonicalIngredientId,
  })), [{
    source: "1 cup brown lentils, rinsed",
    amount: "1",
    unit: "cup",
    ingredient: "lentils",
    qualifier: "brown, rinsed",
    conceptId: "lentil",
    canonicalIngredientId: 7,
  }]);
  assert.equal(replaced.ingredients[0].role, "weekly_requirement");
  assert.deepEqual(replaced.sourceRecipe, sourcedRecipe().source);
  assert.equal(replaced.instructions.length, 1);
  assert.equal(replaced.instructions[0].complete, false);
  assert.equal(replaced.instructions[0].id, result.createdIds["instructionStep.0"]);
  assert.equal(replaced.instructions[0].inputs.length, 2);
  assert.equal(replaced.instructions[0].inputs[0].occurrenceId, replaced.ingredients[0].id);
  assert.equal(replaced.instructions[0].inputs[1].occurrenceId, replaced.ingredients[0].id);
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

test("recipe edits clear or update yield without laundering source provenance", () => {
  for (const yieldText of [null, "6 servings"]) {
    const { state, week, meal, context } = replacementReadyState();
    meal.yieldText = "Old household yield";
    meal.sourceRecipe = structuredClone(sourcedRecipe().source);
    const sourceBefore = structuredClone(meal.sourceRecipe);
    const result = accepted(householdDomain.execute(state, {
      type: "editMealRecipe",
      weekId: week.id,
      mealId: meal.id,
      changes: recipeChanges(meal, { title: `${meal.title} refreshed`, yieldText }),
      occurrences: retainOccurrences(meal),
      removedOccurrenceIds: [],
    }, context));
    const updated = activeWeek(result.state).data.meals.find((candidate) => candidate.id === meal.id);
    assert.equal(updated.yieldText, yieldText === null ? undefined : yieldText);
    assert.deepEqual(updated.sourceRecipe, sourceBefore);
  }
});

test("recipe edits retain, reorder, duplicate, split, replace, and atomically unlink occurrences", () => {
  const context = createContext();
  const state = createCanonicalSeed(context);
  const week = activeWeek(state);
  const meal = week.data.meals[0];
  const roastStep = meal.instructions.find((step) => step.instruction.includes("Roast the chicken"));
  assert.ok(roastStep);
  const peppers = meal.ingredients.find((ingredient) => ingredient.ingredient === "red peppers");
  assert.ok(peppers);
  const peppersGrocery = week.data.groceries.find((grocery) => grocery.ingredientId === peppers.id);
  assert.ok(peppersGrocery);
  const nonCore = accepted(householdDomain.execute(state, {
    type: "editMealRecipe", weekId: week.id, mealId: meal.id, changes: recipeChanges(meal),
    occurrences: retainOccurrences(meal, { [peppers.id]: { amount: "3" } }), removedOccurrenceIds: [],
  }, context));
  assert.equal(activeWeek(nonCore.state).data.groceries.find((grocery) => grocery.id === peppersGrocery.id).coverage, "farm_box", "amount-only edits preserve coverage");
  const result = accepted(householdDomain.execute(nonCore.state, {
    type: "editMealRecipe",
    weekId: week.id,
    mealId: meal.id,
    changes: recipeChanges(meal),
    occurrences: [
      ...retainOccurrences(activeWeek(nonCore.state).data.meals.find((candidate) => candidate.id === meal.id), { [peppers.id]: { ingredient: "red onions", conceptId: "red-onion" } }).reverse(),
      { kind: "create", correlationId: "duplicate-pepper", source: "1 red pepper", amount: "1", unit: null, ingredient: "red peppers", qualifier: null, conceptId: null, canonicalIngredientId: null },
      { kind: "create", correlationId: "split-pepper-a", source: "1/2 red pepper", amount: "1/2", unit: null, ingredient: "red peppers", qualifier: null, conceptId: null, canonicalIngredientId: null },
      { kind: "create", correlationId: "split-pepper-b", source: "1/2 red pepper", amount: "1/2", unit: null, ingredient: "red peppers", qualifier: null, conceptId: null, canonicalIngredientId: null },
    ],
    removedOccurrenceIds: [],
  }, context));
  let updated = activeWeek(result.state).data.meals.find((candidate) => candidate.id === meal.id);
  assert.deepEqual(updated.ingredients.slice(-3).map((ingredient) => ingredient.id), [result.createdIds["duplicate-pepper"], result.createdIds["split-pepper-a"], result.createdIds["split-pepper-b"]]);
  assert.equal(updated.ingredients.find((ingredient) => ingredient.id === peppers.id).ingredient, "red onions");
  assert.equal(activeWeek(result.state).data.groceries.find((grocery) => grocery.id === peppersGrocery.id).coverage, "needs_source", "core literal edits reset coverage");
  assert.equal(updated.instructions.find((step) => step.id === roastStep.id).inputs.some((input) => input.occurrenceId === peppers.id), true);
  const remove = accepted(householdDomain.execute(result.state, {
    type: "editMealRecipe", weekId: week.id, mealId: meal.id, changes: recipeChanges(updated),
    occurrences: [...retainOccurrences(updated).filter((edit) => edit.occurrenceId !== peppers.id), {
      kind: "create", correlationId: "replacement-onion", source: "3 red onions", amount: "3", unit: null, ingredient: "red onions", qualifier: null, conceptId: null, canonicalIngredientId: null,
    }],
    removedOccurrenceIds: [peppers.id],
  }, context));
  updated = activeWeek(remove.state).data.meals.find((candidate) => candidate.id === meal.id);
  assert.equal(updated.ingredients.some((ingredient) => ingredient.id === peppers.id), false);
  assert.equal(updated.ingredients.at(-1).id, remove.createdIds["replacement-onion"], "replace creates a distinct occurrence ID");
  assert.equal(updated.instructions.find((step) => step.id === roastStep.id).inputs.some((input) => input.occurrenceId === peppers.id), false, "linked inputs are removed atomically");
});

test("new instruction inputs create exactly one occurrence for zero or multiple core matches", () => {
  const context = createContext();
  const state = createCanonicalSeed(context);
  const week = activeWeek(state);
  const meal = week.data.meals[0];
  const existing = meal.ingredients[0];
  const duplicateId = "hard-coded-duplicate-occurrence";
  meal.ingredients.push({ ...existing, id: duplicateId });
  week.data.groceries.push({
    id: "hard-coded-duplicate-grocery",
    mealId: meal.id,
    ingredientId: duplicateId,
    section: week.data.groceries.find((item) => item.ingredientId === existing.id)?.section ?? "Pantry",
    coverage: "needs_source",
    checked: false,
  });
  const beforeIds = meal.ingredients.map((occurrence) => occurrence.id);
  const result = accepted(householdDomain.execute(state, {
    type: "addInstructionStep",
    weekId: week.id,
    mealId: meal.id,
    position: meal.instructions.length,
    step: {
      inputs: [
        { kind: "create", correlationId: "ambiguous-core", amount: "1", ingredient: existing.ingredient },
        { kind: "create", correlationId: "zero-core", amount: "2", ingredient: "hard-coded-new-ingredient" },
      ],
      instruction: "Prepare both new instruction inputs.",
    },
  }, context));
  const nextMeal = activeWeek(result.state).data.meals.find((candidate) => candidate.id === meal.id);
  const createdIds = result.occurrenceResolutions.map(({ occurrenceId }) => occurrenceId);
  assert.equal(createdIds.length, 2);
  assert.equal(new Set(createdIds).size, 2);
  assert.equal(createdIds.some((id) => beforeIds.includes(id)), false, "an ambiguous duplicate never picks the first occurrence");
  assert.deepEqual(nextMeal.instructions.at(-1).inputs.map(({ occurrenceId }) => occurrenceId), createdIds);
  assert.deepEqual(result.occurrenceResolutions.map(({ correlationId }) => correlationId), ["ambiguous-core", "zero-core"]);
  assert.deepEqual(nextMeal.ingredients.slice(-2).map(({ id, ingredient }) => ({ id, ingredient })), [
    { id: createdIds[0], ingredient: existing.ingredient },
    { id: createdIds[1], ingredient: "hard-coded-new-ingredient" },
  ]);
  const nextGroceries = activeWeek(result.state).data.groceries;
  for (const occurrenceId of createdIds) {
    assert.equal(nextGroceries.filter((item) => item.mealId === meal.id && item.ingredientId === occurrenceId).length, 1);
  }
});

test("week creation rejects operation-wide duplicate occurrence correlations before materializing IDs", () => {
  const context = createContext();
  const state = createCanonicalSeed(context);
  const occurrence = {
    kind: "create", correlationId: "same-correlation", source: null, amount: "1", unit: null,
    ingredient: "rice", qualifier: null, conceptId: null, canonicalIngredientId: null,
  };
  const meal = (date) => ({
    date, title: "Rice", subtitle: "", venue: "Home", protein: "none",
    prepNote: "", leftoverNote: "", notes: "", occurrences: [occurrence], instructions: [],
  });
  const result = householdDomain.execute(state, {
    type: "createWeekPlan",
    weekStartDate: "2026-07-13",
    plan: { meals: [meal("2026-07-13"), meal("2026-07-14")] },
  }, context);
  assert.equal(result.ok, false);
  assert.match(result.message, /correlations must be unique/iu);
  assert.deepEqual(result.state, state);
});

test("each protected canonical state class and immutable target lifecycle rejects replacement", () => {
  const mutateCases = [
    ["completed", ({ meal }) => { meal.instructions[0].complete = true; }],
    ["note", ({ meal }) => { meal.instructions[0].note = "keep"; }],
    ["timer", ({ meal }) => { meal.instructions[0].timerStartedAt = NOW; }],
    ["paused timer", ({ meal }) => {
      meal.instructions[0].timerDurationSeconds = 300;
      meal.instructions[0].timerPaused = true;
    }],
    ["prep", ({ week, meal }) => {
      week.data.prepSessions.push({
        id: "prep-protected",
        prepDate: addIsoDateDays(week.id, -1),
        steps: [{ id: "prep-protected-step", stepId: meal.instructions[0].id }],
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
