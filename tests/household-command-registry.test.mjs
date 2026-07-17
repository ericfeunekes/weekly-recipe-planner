import assert from "node:assert/strict";
import test from "node:test";

import Ajv from "ajv";

import {
  HOUSEHOLD_COMMAND_AUTHORITY_MANIFEST,
  HOUSEHOLD_COMMAND_PROVIDER_SCHEMA,
  HOUSEHOLD_COMMAND_REGISTRY,
  HOUSEHOLD_COMMAND_SCHEMA,
  MAX_GROCERY_ITEMS,
  MAX_INGREDIENT_LINES,
  MAX_MEALS_PER_WEEK,
  isHouseholdCommand,
  normalizeHouseholdCommand,
} from "../lib/household-command-contract.ts";

const weekId = "2026-07-06";
const id = "id-1";
const step = {
  inputs: [{ amount: "1 cup", ingredient: "rice" }],
  instruction: "Rinse the rice.",
};

const fixtures = {
  moveMeal: { type: "moveMeal", weekId, mealId: id, targetDate: "2026-07-07" },
  reorderMeals: { type: "reorderMeals", weekId, date: "2026-07-07", mealIds: [id, "id-2"] },
  swapMealDays: { type: "swapMealDays", weekId, firstDate: "2026-07-06", secondDate: "2026-07-07" },
  updateMealStatus: { type: "updateMealStatus", weekId, mealId: id, status: "cooking" },
  updateMealSnapshot: { type: "updateMealSnapshot", weekId, mealId: id, changes: { title: "Rice", subtitle: "", venue: "Home", prepNote: "", leftoverNote: "", notes: "", ingredients: [], yieldText: null } },
  replaceMealRecipeFromSource: {
    type: "replaceMealRecipeFromSource",
    weekId,
    mealId: id,
    recipe: {
      title: "Sourced rice",
      source: {
        kind: "web",
        identity: "Example Kitchen",
        url: "https://example.com/recipes/rice",
        retrievedAt: 1_750_000_000_000,
      },
      steps: [step],
    },
  },
  addInstructionStep: { type: "addInstructionStep", weekId, mealId: id, position: 0, step },
  updateInstructionStep: { type: "updateInstructionStep", weekId, stepId: id, changes: { inputs: [], instruction: "Rest.", timerDurationSeconds: null } },
  moveInstructionStep: { type: "moveInstructionStep", weekId, stepId: id, targetPosition: 0 },
  removeInstructionStep: { type: "removeInstructionStep", weekId, stepId: id },
  setInstructionStepComplete: { type: "setInstructionStepComplete", weekId, stepId: id, complete: true },
  updateInstructionStepNote: { type: "updateInstructionStepNote", weekId, stepId: id, note: "Watch closely." },
  startInstructionTimer: { type: "startInstructionTimer", weekId, stepId: id },
  pauseInstructionTimer: { type: "pauseInstructionTimer", weekId, stepId: id },
  resetInstructionTimer: { type: "resetInstructionTimer", weekId, stepId: id },
  setInstructionTimerRemaining: { type: "setInstructionTimerRemaining", weekId, stepId: id, remainingSeconds: 300 },
  addPrepStepsToDate: { type: "addPrepStepsToDate", weekId, prepDate: "2026-06-29", stepIds: ["step-1", "step-2"], targetPosition: 0 },
  movePrepStepsToDate: { type: "movePrepStepsToDate", weekId, sourcePrepDate: "2026-06-28", prepDate: "2026-06-29", entryIds: ["entry-1", "entry-2"], targetPosition: 0 },
  removePrepStepsFromDate: { type: "removePrepStepsFromDate", weekId, prepDate: "2026-06-29", entryIds: ["entry-1", "entry-2"] },
  clearPrepDate: { type: "clearPrepDate", weekId, prepDate: "2026-06-29" },
  moveGroceryItemsToSource: { type: "moveGroceryItemsToSource", weekId, itemIds: [id, "id-2"], source: "shop" },
  setGroceryItemChecked: { type: "setGroceryItemChecked", weekId, itemId: id, checked: true },
  captureFeedback: { type: "captureFeedback", weekId, mealId: id, value: "repeat" },
  captureWeekLesson: { type: "captureWeekLesson", weekId, weekLesson: "Prep earlier." },
  captureLeftoverQuality: { type: "captureLeftoverQuality", weekId, leftoverId: id, quality: "good" },
  assignLeftover: { type: "assignLeftover", weekId, leftoverId: id, targetDate: "2026-07-08" },
  consumeLeftover: { type: "consumeLeftover", weekId, leftoverId: id },
  archiveWeek: { type: "archiveWeek", weekId },
  createWeekPlan: { type: "createWeekPlan", weekStartDate: "2026-07-13", plan: { meals: [] } },
  activateWeek: { type: "activateWeek", weekId },
  handoffWeek: { type: "handoffWeek", currentWeekId: weekId, nextWeekId: "2026-07-13" },
};

test("one registry derives every command validator, schema variant, and authority policy", () => {
  const registryKeys = Object.keys(HOUSEHOLD_COMMAND_REGISTRY).sort();
  assert.deepEqual(registryKeys, Object.keys(fixtures).sort());
  for (const [type, entry] of Object.entries(HOUSEHOLD_COMMAND_REGISTRY)) {
    assert.deepEqual(
      [...entry.schema.required].sort(),
      Object.keys(entry.schema.properties).sort(),
      `${type} exposes every top-level command field as required`,
    );
  }
  assert.deepEqual(
    HOUSEHOLD_COMMAND_SCHEMA.anyOf.map((schema) => schema.properties.type.const).sort(),
    registryKeys,
  );
  assert.deepEqual(Object.keys(HOUSEHOLD_COMMAND_AUTHORITY_MANIFEST.commands).sort(), registryKeys);
  assert.equal(HOUSEHOLD_COMMAND_AUTHORITY_MANIFEST.commands.archiveWeek.exposure, "explicit_foreground");
  assert.equal(HOUSEHOLD_COMMAND_AUTHORITY_MANIFEST.permanentlyDeniedOperations.includes("undoLatest"), true);
});

test("source provenance can enter only through sourced replacement, never create or snapshot update", () => {
  const ajv = new Ajv({ allErrors: true, schemaId: "auto" });
  const validateCanonical = ajv.compile(HOUSEHOLD_COMMAND_SCHEMA);
  const validateProvider = ajv.compile(HOUSEHOLD_COMMAND_PROVIDER_SCHEMA);
  const sourceRecipe = fixtures.replaceMealRecipeFromSource.recipe.source;
  const injectedUpdate = {
    ...fixtures.updateMealSnapshot,
    changes: { ...fixtures.updateMealSnapshot.changes, sourceRecipe },
  };
  const canonicalCreate = {
    type: "createWeekPlan",
    weekStartDate: "2026-07-13",
    plan: {
      meals: [{
        date: "2026-07-13",
        title: "Injected recipe",
        subtitle: "",
        venue: "Home",
        protein: "none",
        prepNote: "",
        leftoverNote: "",
        notes: "",
        ingredients: [],
        instructions: [step],
      }],
    },
  };
  const injectedCreate = structuredClone(canonicalCreate);
  injectedCreate.plan.meals[0].sourceRecipe = sourceRecipe;
  for (const [label, baseline, command] of [
    ["updateMealSnapshot", fixtures.updateMealSnapshot, injectedUpdate],
    ["createWeekPlan", canonicalCreate, injectedCreate],
  ]) {
    assert.equal(isHouseholdCommand(baseline), true, `${label} runtime baseline`);
    assert.equal(validateCanonical(baseline), true, `${label} canonical schema baseline`);
    assert.equal(isHouseholdCommand(command), false, `${label} runtime`);
    assert.equal(validateCanonical(command), false, `${label} canonical schema`);
  }

  assert.equal(validateProvider(fixtures.updateMealSnapshot), true, "snapshot provider baseline");
  assert.equal(validateProvider(injectedUpdate), false, "snapshot provider source injection");
  const providerCreate = structuredClone(canonicalCreate);
  providerCreate.plan.weekLesson = null;
  providerCreate.plan.meals[0].status = null;
  providerCreate.plan.meals[0].yieldText = null;
  providerCreate.plan.meals[0].instructions[0].timerDurationSeconds = null;
  providerCreate.plan.meals[0].instructions[0].note = null;
  assert.equal(validateProvider(providerCreate), true, "create provider baseline");
  providerCreate.plan.meals[0].sourceRecipe = sourceRecipe;
  assert.equal(validateProvider(providerCreate), false, "create provider source injection");
});

test("draft-07 Ajv independently compiles every canonical command variant", () => {
  const ajv = new Ajv({ allErrors: true, schemaId: "auto" });
  const validate = ajv.compile(HOUSEHOLD_COMMAND_SCHEMA);
  for (const [type, fixture] of Object.entries(fixtures)) {
    assert.equal(isHouseholdCommand(fixture), true, `${type} runtime guard`);
    assert.equal(validate(fixture), true, `${type} generated schema: ${ajv.errorsText(validate.errors)}`);
    const extra = { ...fixture, unexpected: true };
    assert.equal(isHouseholdCommand(extra), false, `${type} runtime extra-field rejection`);
    assert.equal(validate(extra), false, `${type} schema extra-field rejection`);
  }
});

test("provider-strict schema is derived without changing canonical optionality", () => {
  const ajv = new Ajv({ allErrors: true, schemaId: "auto" });
  const validateProvider = ajv.compile(HOUSEHOLD_COMMAND_PROVIDER_SCHEMA);
  const providerCommand = {
    type: "createWeekPlan",
    weekStartDate: "2026-07-13",
    plan: {
      meals: [],
      weekLesson: null,
    },
  };
  assert.equal(validateProvider(providerCommand), true, ajv.errorsText(validateProvider.errors));
  const normalized = normalizeHouseholdCommand(providerCommand);
  assert.deepEqual(normalized, {
    type: "createWeekPlan",
    weekStartDate: "2026-07-13",
    plan: { meals: [] },
  });
  assert.equal(isHouseholdCommand(normalized), true);
  for (const command of [
    { type: "addGroceryItem", weekId, item: { section: "Produce", item: "Carrots", detail: "1 bunch", source: "shop", mealIds: [] } },
    { type: "updateGroceryItem", weekId, itemId: id, changes: { section: "Produce", item: "Carrots", detail: "1 bunch", source: "shop", mealIds: [] } },
    { type: "removeGroceryItem", weekId, itemId: id },
  ]) assert.equal(isHouseholdCommand(command), false);
});

test("bulk grocery source moves require a bounded, unique selection and supported destination", () => {
  const baseline = fixtures.moveGroceryItemsToSource;
  for (const command of [
    { ...baseline, itemIds: [] },
    { ...baseline, itemIds: [id, id] },
    { ...baseline, itemIds: Array.from({ length: MAX_GROCERY_ITEMS + 1 }, (_, index) => `id-${index}`) },
    { ...baseline, source: "delivery" },
  ]) {
    assert.equal(isHouseholdCommand(command), false);
  }
});

test("grocery capacity derives from the published maximum plan cardinality", () => {
  assert.equal(MAX_GROCERY_ITEMS, MAX_MEALS_PER_WEEK * MAX_INGREDIENT_LINES);
  const command = {
    type: "createWeekPlan",
    weekStartDate: "2026-07-13",
    plan: {
      meals: Array.from({ length: MAX_MEALS_PER_WEEK }, (_, mealIndex) => ({
        date: `2026-07-${String(13 + (mealIndex % 7)).padStart(2, "0")}`,
        title: `Capacity meal ${mealIndex + 1}`,
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
      })),
    },
  };
  const validate = new Ajv({ allErrors: true, schemaId: "auto" }).compile(HOUSEHOLD_COMMAND_SCHEMA);
  assert.equal(isHouseholdCommand(command), true);
  assert.equal(validate(command), true);
  const overCapacity = structuredClone(command);
  overCapacity.plan.meals.push(structuredClone(command.plan.meals[0]));
  assert.equal(isHouseholdCommand(overCapacity), false);
  assert.equal(validate(overCapacity), false);
});
