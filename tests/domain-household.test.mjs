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

test("legacy setPrepPlan rejects duplicate step IDs before materializing session references", () => {
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

  assert.equal(result.ok, false);
  assert.equal(result.state, state);
  assert.match(result.message, /legacy prep plan/i);
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
      { type: "setInstructionTimerRemaining", weekId, stepId: addedStepId, remainingSeconds: 420 },
      context,
    ),
  );
  state = result.state;
  assert.equal(activeWeek(state).data.meals[0].instructions[0].timerDurationSeconds, 420);
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
  assert.equal(activeWeek(state).data.meals[0].instructions[0].timerDurationSeconds, 360);
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
  assert.equal(activeWeek(state).data.meals[0].instructions[0].timerDurationSeconds, 120);
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

  const sundayBefore = addIsoDateDays(weekId, -1);
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "createPrepSession",
        weekId,
        label: "Sunday batch",
        prepDate: sundayBefore,
      },
      context,
    ),
  );
  state = result.state;
  const sundaySessionId = result.createdIds.prepSessionId;
  assert.ok(sundaySessionId);
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "createPrepSession",
        weekId,
        label: "Finish on Monday",
        prepDate: weekId,
      },
      context,
    ),
  );
  state = result.state;
  const mondaySessionId = result.createdIds.prepSessionId;
  assert.ok(mondaySessionId);
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "addPrepSessionStep",
        weekId,
        sessionId: sundaySessionId,
        stepId: firstStep.id,
        targetPosition: 0,
      },
      context,
    ),
  );
  state = result.state;
  const firstEntryId = result.createdIds.prepSessionStepId;
  assert.ok(firstEntryId);
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "addPrepSessionStep",
        weekId,
        sessionId: mondaySessionId,
        stepId: secondStep.id,
        targetPosition: 0,
      },
      context,
    ),
  );
  state = result.state;
  const secondEntryId = result.createdIds.prepSessionStepId;
  assert.ok(secondEntryId);
  week = activeWeek(state);
  assert.deepEqual(
    week.data.prepSessions
      .filter((session) => session.id === sundaySessionId || session.id === mondaySessionId)
      .map(({ label, prepDate, steps }) => ({ label, prepDate, steps: steps.map((entry) => entry.stepId) })),
    [
      { label: "Sunday batch", prepDate: sundayBefore, steps: [firstStep.id] },
      { label: "Finish on Monday", prepDate: weekId, steps: [secondStep.id] },
    ],
  );
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "addPrepSessionStep",
        weekId,
        sessionId: sundaySessionId,
        stepId: secondStep.id,
        targetPosition: 0,
      },
      context,
    ),
  );
  state = result.state;
  assert.deepEqual(
    activeWeek(state).data.prepSessions.find((session) => session.id === sundaySessionId).steps.map((entry) => entry.stepId),
    [
      secondStep.id,
      firstStep.id,
    ],
    "a session can project the same canonical step used by another session",
  );
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "movePrepSessionStep",
        weekId,
        sessionId: sundaySessionId,
        entryId: firstEntryId,
        targetPosition: 0,
      },
      context,
    ),
  );
  state = result.state;
  assert.deepEqual(
    activeWeek(state).data.prepSessions.find((session) => session.id === sundaySessionId).steps.map((entry) => entry.stepId),
    [
      firstStep.id,
      secondStep.id,
    ],
    "session references can be reordered without changing recipe order",
  );
  result = accepted(
    householdDomain.execute(
      state,
      { type: "removePrepSessionStep", weekId, sessionId: mondaySessionId, entryId: secondEntryId },
      context,
    ),
  );
  state = result.state;
  assert.ok(activeWeek(state).data.meals[0].instructions.some((step) => step.id === firstStep.id));
  assert.deepEqual(
    activeWeek(state).data.prepSessions.find((session) => session.id === mondaySessionId).steps,
    [],
    "removing a session reference never removes the canonical instruction",
  );

  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "createPrepSession",
        weekId,
        label: "Tuesday batch",
        prepDate: addIsoDateDays(weekId, 1),
      },
      context,
    ),
  );
  state = result.state;
  const tuesdaySessionId = result.createdIds.prepSessionId;
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "addPrepSessionSteps",
        weekId,
        sessionId: tuesdaySessionId,
        stepIds: [firstStep.id, secondStep.id],
        targetPosition: 0,
      },
      context,
    ),
  );
  state = result.state;
  const tuesdayEntries = activeWeek(state).data.prepSessions.find((session) => session.id === tuesdaySessionId).steps;
  assert.deepEqual(tuesdayEntries.map((entry) => entry.stepId), [firstStep.id, secondStep.id]);
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "movePrepSessionSteps",
        weekId,
        sourceSessionId: tuesdaySessionId,
        sessionId: mondaySessionId,
        entryIds: [tuesdayEntries[1].id, tuesdayEntries[0].id],
        targetPosition: 0,
      },
      context,
    ),
  );
  state = result.state;
  assert.deepEqual(
    activeWeek(state).data.prepSessions.find((session) => session.id === mondaySessionId).steps.map((entry) => entry.stepId),
    [firstStep.id, secondStep.id],
    "a multi-step move preserves recipe order even if its selection arrived out of order",
  );
  const mondayEntries = activeWeek(state).data.prepSessions.find((session) => session.id === mondaySessionId).steps;
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "movePrepSessionSteps",
        weekId,
        sourceSessionId: mondaySessionId,
        sessionId: mondaySessionId,
        entryIds: [mondayEntries[0].id],
        targetPosition: 2,
      },
      context,
    ),
  );
  state = result.state;
  assert.deepEqual(
    activeWeek(state).data.prepSessions.find((session) => session.id === mondaySessionId).steps.map((entry) => entry.stepId),
    [secondStep.id, firstStep.id],
    "a multi-step move accepts the end boundary used by the visible insertion indicator",
  );

  const earlierPrepDate = addIsoDateDays(weekId, -14);
  const entriesToMoveEarlier = activeWeek(state).data.prepSessions.find((session) => session.id === mondaySessionId).steps.map((entry) => entry.id);
  result = accepted(
    householdDomain.execute(
      state,
      {
        type: "movePrepStepsToDate",
        weekId,
        sourceSessionId: mondaySessionId,
        prepDate: earlierPrepDate,
        entryIds: entriesToMoveEarlier,
        targetPosition: 0,
      },
      context,
    ),
  );
  state = result.state;
  const earlierSession = activeWeek(state).data.prepSessions.find((session) => session.prepDate === earlierPrepDate);
  assert.ok(earlierSession, "moving to an earlier calendar date creates that date's prep queue");
  assert.deepEqual(
    earlierSession.steps.map((entry) => entry.stepId),
    [secondStep.id, firstStep.id],
    "earlier-date prep keeps the queue order while recipe instructions remain canonical",
  );
  const afterMealWeek = householdDomain.execute(
    state,
    {
      type: "addPrepStepsToDate",
      weekId,
      prepDate: addIsoDateDays(weekId, 7),
      stepIds: [firstStep.id],
      targetPosition: 0,
    },
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
        type: "moveGroceryItemsToSource",
        weekId,
        itemIds: [grocery.id],
        source: "on_hand",
      },
      context,
    ),
  );
  state = result.state;
  const retainedGrocery = activeWeek(state).data.groceries.find((item) => item.id === grocery.id);
  assert.ok(retainedGrocery);
  assert.equal(retainedGrocery.mealId, chicken.id);
  assert.equal(retainedGrocery.checked, true);
  assert.equal(retainedGrocery.source, "on_hand");

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
  unsupportedSource.weeks[0].data.groceries[0].source = "delivery";
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
    ingredients: Array.from(
      { length: MAX_INGREDIENT_LINES },
      (_, ingredientIndex) => `${ingredientIndex + 1} g ingredient ${mealIndex + 1}-${ingredientIndex + 1}`,
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

test("bulk grocery source moves are atomic and preserve grocery identities", () => {
  const context = createContext();
  const original = createCanonicalSeed(context);
  const week = activeWeek(original);
  const selected = week.data.groceries.filter((item) => item.source === "shop").slice(0, 2);
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
        type: "moveGroceryItemsToSource",
        weekId: week.id,
        itemIds: selected.map((item) => item.id),
        source: "farm_box",
      },
      context,
    ),
  );
  for (const itemId of expected.keys()) {
    const item = activeWeek(moved.state).data.groceries.find((candidate) => candidate.id === itemId);
    assert.ok(item);
    assert.equal(item.source, "farm_box");
    assert.deepEqual(
      { checked: item.checked, section: item.section, mealId: item.mealId, ingredientId: item.ingredientId },
      expected.get(itemId),
    );
  }

  for (const command of [
    {
      type: "moveGroceryItemsToSource",
      weekId: week.id,
      itemIds: [selected[0].id, "grocery-missing"],
      source: "on_hand",
    },
    {
      type: "moveGroceryItemsToSource",
      weekId: week.id,
      itemIds: selected.map((item) => item.id),
      source: "shop",
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
  assert.deepEqual(
    replaced.ingredients.map(({ amount, ingredient }) => ({ amount, ingredient })),
    [{ amount: "1 cup", ingredient: "lentils" }],
  );
  assert.deepEqual(replaced.sourceRecipe, sourcedRecipe().source);
  assert.equal(replaced.instructions.length, 1);
  assert.equal(replaced.instructions[0].complete, false);
  assert.equal(replaced.instructions[0].id, result.createdIds["instructionStep.0"]);
  assert.equal(replaced.instructions[0].inputs.length, 2);
  assert.equal(replaced.instructions[0].inputs[0].ingredientId, replaced.ingredients[0].id);
  assert.equal(replaced.instructions[0].inputs[1].ingredientId, replaced.ingredients[0].id);
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

test("meal snapshot folds legacy ingredient aliases without losing a canonical step link", () => {
  const context = createContext();
  const state = createCanonicalSeed(context);
  const week = activeWeek(state);
  const meal = week.data.meals[0];
  const roastStep = meal.instructions.find((step) => step.instruction.includes("Roast the chicken"));
  assert.ok(roastStep);
  const peppersInput = roastStep.inputs.find((input) => input.ingredient === "red peppers");
  assert.ok(peppersInput);
  meal.ingredients.push({ id: "legacy-peppers", amount: "2 red", ingredient: "peppers" });
  peppersInput.ingredientId = "legacy-peppers";
  week.data.groceries.push({
    id: "legacy-grocery-peppers",
    mealId: meal.id,
    ingredientId: "legacy-peppers",
    section: "Produce",
    source: "shop",
    checked: false,
  });

  const result = accepted(householdDomain.execute(state, {
    type: "updateMealSnapshot",
    weekId: week.id,
    mealId: meal.id,
    changes: {
      title: meal.title,
      subtitle: meal.subtitle,
      venue: meal.venue,
      prepNote: meal.prepNote,
      leftoverNote: meal.leftoverNote,
      notes: meal.notes,
      ingredients: meal.ingredients
        .map(({ amount, ingredient }) => [amount, ingredient].filter(Boolean).join(" "))
        .filter((line, index, lines) => lines.indexOf(line) === index),
      yieldText: meal.yieldText ?? null,
    },
  }, context));
  const normalizedMeal = activeWeek(result.state).data.meals.find((candidate) => candidate.id === meal.id);
  const redPeppers = normalizedMeal.ingredients.filter((ingredient) => ingredient.ingredient === "red peppers");
  assert.deepEqual(redPeppers.map(({ amount }) => amount), ["2"]);
  const normalizedRoastStep = normalizedMeal.instructions.find((step) => step.id === roastStep.id);
  assert.equal(
    normalizedRoastStep.inputs.find((input) => input.ingredient === "red peppers").ingredientId,
    redPeppers[0].id,
  );
});

test("each protected canonical state class and immutable target lifecycle rejects replacement", () => {
  const mutateCases = [
    ["completed", ({ meal }) => { meal.instructions[0].complete = true; }],
    ["note", ({ meal }) => { meal.instructions[0].note = "keep"; }],
    ["timer", ({ meal }) => { meal.instructions[0].timerStartedAt = NOW; }],
    ["prep", ({ week, meal }) => {
      week.data.prepSessions.push({
        id: "prep-protected",
        label: "Protected prep",
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
