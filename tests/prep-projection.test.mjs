import assert from "node:assert/strict";
import test from "node:test";

import {
  preparedInBatchStepIds,
  projectCombinedPrepDraft,
  projectCombinedPrepEntry,
} from "../lib/prep-projection.ts";

function state() {
  return {
    householdTimeZone: "America/Halifax",
    activeWeekId: "2026-07-06",
    weeks: [{
      id: "2026-07-06",
      weekStartDate: "2026-07-06",
      status: "active",
      data: {
        meals: [
          {
            id: "meal-one", date: "2026-07-06", title: "Curry", subtitle: "", venue: "Home", status: "planned", protein: "none", prepNote: "", leftoverNote: "", notes: "",
            ingredients: [{ id: "rice-one", amount: "1 cup", ingredient: "Jasmine Rice" }],
            instructions: [{ id: "step-one", inputs: [{ ingredientId: "rice-one", amount: "1 cup", ingredient: "Jasmine Rice" }], instruction: "Cook rice.", complete: false }],
          },
          {
            id: "meal-two", date: "2026-07-07", title: "Bowls", subtitle: "", venue: "Home", status: "planned", protein: "none", prepNote: "", leftoverNote: "", notes: "",
            ingredients: [{ id: "rice-two", amount: "1/2 cup", ingredient: " jasmine   rice " }],
            instructions: [{ id: "step-two", inputs: [{ ingredientId: "rice-two", amount: "1/2 cup", ingredient: " jasmine   rice " }], instruction: "Cook more rice.", complete: false }],
          },
          {
            id: "meal-three", date: "2026-07-08", title: "Salad", subtitle: "", venue: "Home", status: "planned", protein: "none", prepNote: "", leftoverNote: "", notes: "",
            ingredients: [{ id: "herb", amount: "1 bunch", ingredient: "Cilantro" }],
            instructions: [{ id: "step-three", inputs: [{ ingredientId: "herb", amount: "1 bunch", ingredient: "Cilantro" }], instruction: "Chop cilantro.", complete: false }],
          },
        ],
        prepSessions: [], groceries: [], leftovers: [], feedback: {}, weekLesson: "",
      },
    }],
  };
}

function combined(overrides = {}) {
  return {
    id: "combined-rice", kind: "combined",
    sources: [
      { stepId: "step-one", ingredientIds: ["rice-one"] },
      { stepId: "step-two", ingredientIds: ["rice-two"] },
    ],
    instruction: "Prepare rice.", complete: false, needsReview: false,
    ...overrides,
  };
}

test("combined Prep projection resolves ordered current lineage and conservative literal grouping", () => {
  const projection = projectCombinedPrepEntry(state(), combined());
  assert.deepEqual(projection.invalidLineage, []);
  assert.deepEqual(projection.sources.map((source) => source.mealTitle), ["Curry", "Bowls"]);
  assert.equal(projection.aggregates.length, 1);
  assert.equal(projection.aggregates[0].key, "literal:jasmine rice");
  assert.equal(projection.aggregates[0].display, "1 1/2 cups Jasmine Rice");
});

test("combined Prep projection keeps differently named and unsupported literals separate", () => {
  const projection = projectCombinedPrepEntry(state(), combined({
    sources: [
      { stepId: "step-one", ingredientIds: ["rice-one"] },
      { stepId: "step-three", ingredientIds: ["herb"] },
    ],
  }));
  assert.equal(projection.aggregates.length, 2);
  assert.equal(projection.aggregates[1].display, "1 bunch Cilantro");
  assert.equal(projection.aggregates[1].quantity.ok, false);
});

test("combined Prep projection follows live literals and reports broken lineage explicitly", () => {
  const live = state();
  live.weeks[0].data.meals[0].ingredients[0].amount = "2 cups";
  const projection = projectCombinedPrepEntry(live, combined());
  assert.equal(projection.aggregates[0].display, "2 1/2 cups Jasmine Rice");

  const broken = projectCombinedPrepEntry(state(), combined({
    sources: [{ stepId: "step-one", ingredientIds: ["missing"] }, { stepId: "gone", ingredientIds: [] }],
  }));
  assert.deepEqual(broken.invalidLineage, [
    { code: "missing-ingredient", stepId: "step-one", ingredientId: "missing" },
    { code: "missing-step", stepId: "gone" },
  ]);
});

test("draft projection and prepared badges are independent from canonical completion", () => {
  const workspace = state();
  const draft = projectCombinedPrepDraft(workspace, ["step-one", "step-two"]);
  assert.equal(draft.aggregates[0].display, "1 1/2 cups Jasmine Rice");

  workspace.weeks[0].data.prepSessions = [{
    id: "session", prepDate: "2026-07-05", steps: [combined({ complete: true })],
  }, {
    id: "review-session", prepDate: "2026-07-06", steps: [combined({ id: "review", complete: true, needsReview: true, sources: [{ stepId: "step-three", ingredientIds: ["herb"] }] })],
  }];
  assert.deepEqual([...preparedInBatchStepIds(workspace)], ["step-one", "step-two"]);
  assert.equal(workspace.weeks[0].data.meals[0].instructions[0].complete, false);
});

test("draft projection deduplicates ingredient occurrences like canonical materialization", () => {
  const workspace = state();
  workspace.weeks[0].data.meals[0].instructions[0].inputs.push({
    ingredientId: "rice-one", amount: "1 cup", ingredient: "Jasmine Rice",
  });
  const draft = projectCombinedPrepDraft(workspace, ["step-one", "step-two"]);
  assert.equal(draft.aggregates[0].display, "1 1/2 cups Jasmine Rice");
  assert.deepEqual(draft.sources[0].ingredients.map((ingredient) => ingredient.ingredientId), ["rice-one"]);
});

test("entry and draft projections cannot resolve colliding step IDs from another week", () => {
  const workspace = state();
  const targetEntry = combined();
  workspace.weeks[0].data.prepSessions = [{ id: "session", prepDate: "2026-07-05", steps: [targetEntry] }];
  workspace.weeks.push({
    ...workspace.weeks[0],
    id: "2026-07-13",
    weekStartDate: "2026-07-13",
    data: {
      ...workspace.weeks[0].data,
      prepSessions: [],
      meals: [{
        ...workspace.weeks[0].data.meals[0],
        id: "other-meal",
        title: "Wrong week",
        ingredients: [{ id: "rice-one", amount: "99 cups", ingredient: "Jasmine Rice" }],
        instructions: [{ id: "step-one", inputs: [{ ingredientId: "rice-one", amount: "99 cups", ingredient: "Jasmine Rice" }], instruction: "Wrong step.", complete: false }],
      }],
    },
  });

  const entryProjection = projectCombinedPrepEntry(workspace, targetEntry);
  assert.equal(entryProjection.sources[0].mealTitle, "Curry");
  assert.equal(entryProjection.aggregates[0].display, "1 1/2 cups Jasmine Rice");
  const draftProjection = projectCombinedPrepDraft(workspace, ["step-one", "step-two"]);
  assert.equal(draftProjection.sources[0].mealTitle, "Curry");
  assert.equal(draftProjection.aggregates[0].display, "1 1/2 cups Jasmine Rice");
});
