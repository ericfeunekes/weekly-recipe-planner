import assert from "node:assert/strict";
import test from "node:test";
import {
  executeDomainCommand,
  isDomainCommand,
  resolveInstructionStep,
} from "../lib/planner-domain.ts";

function instruction(id, text, options = {}) {
  return {
    id,
    inputs: [],
    instruction: text,
    complete: false,
    ...options,
  };
}

function state() {
  return {
    meals: [
      {
        id: "thu",
        dayIndex: 3,
        title: "Miso salmon",
        subtitle: "Rice bowl",
        venue: "Home",
        status: "planned",
        protein: "salmon",
        prepNote: "Thaw and cook rice",
        leftoverNote: "Reserve 2 portions",
        notes: "Keep the cucumber crisp.",
        ingredients: ["680 g salmon", "2 cups jasmine rice"],
        instructions: [
          instruction("thu-thaw", "Thaw the salmon in the refrigerator.", {
            complete: true,
            note: "Moved to the fridge Wednesday night.",
          }),
          instruction("thu-rice", "Cook the jasmine rice until tender.", {
            timerDurationSeconds: 18 * 60,
          }),
          instruction("thu-roast", "Glaze and roast the salmon.", {
            timerDurationSeconds: 10 * 60,
          }),
        ],
      },
      {
        id: "fri",
        dayIndex: 4,
        title: "Chicken lo mein",
        subtitle: "Fresh noodles",
        venue: "Home",
        status: "planned",
        protein: "chicken",
        prepNote: "Mix sauce",
        leftoverNote: "2 lunch portions",
        notes: "Use fresh noodles.",
        ingredients: ["450 g fresh lo mein noodles"],
        instructions: [
          instruction("fri-sauce", "Mix the lo mein sauce."),
          instruction("fri-noodles", "Cook the chicken, vegetables, and noodles."),
        ],
      },
      {
        id: "sat",
        dayIndex: 5,
        title: "Open / flex night",
        subtitle: "",
        venue: "Flexible",
        status: "flex",
        protein: "none",
        prepNote: "None",
        leftoverNote: "",
        notes: "",
        ingredients: [],
        instructions: [
          instruction("sat-decide", "Check leftovers before deciding whether to cook."),
        ],
      },
      {
        id: "sun",
        dayIndex: 6,
        title: "Salmon cakes",
        subtitle: "Chopped salad",
        venue: "Home",
        status: "planned",
        protein: "salmon",
        prepNote: "Flake reserved salmon",
        leftoverNote: "Closes the week",
        notes: "Use the reserved salmon.",
        ingredients: ["2 portions cooked salmon"],
        instructions: [
          instruction("sun-flake", "Flake the reserved salmon."),
          instruction("sun-shape", "Shape and chill the salmon cakes.", {
            timerDurationSeconds: 10 * 60,
          }),
        ],
      },
    ],
    prep: [
      { id: "prep-fri-sauce", stepId: "fri-sauce", due: "Sun, Jul 5", position: 0 },
      { id: "prep-thu-rice", stepId: "thu-rice", due: "Sun, Jul 5", position: 1 },
      { id: "prep-thu-thaw", stepId: "thu-thaw", due: "Wed, Jul 8", position: 2 },
      { id: "prep-sun-flake", stepId: "sun-flake", due: "Sun, Jul 12", position: 3 },
    ],
    groceries: [],
    leftovers: [
      { id: "left-thu", sourceMealId: "thu", label: "Salmon", portions: 2, state: "available" },
      { id: "left-fri", sourceMealId: "fri", label: "Chicken", portions: 2, state: "assigned", assignedDayIndex: 4 },
    ],
    farmBoxReconciled: false,
    weekArchived: false,
    draftReady: false,
    feedback: {},
    weekLesson: "",
  };
}

function recipeOrder(data, mealId) {
  return data.meals
    .find((meal) => meal.id === mealId)
    .instructions.map((step) => step.id);
}

function prepOrder(data) {
  return [...data.prep]
    .sort((left, right) => left.position - right.position)
    .map((reference) => reference.id);
}

test("a prep reference shares completion with its canonical recipe step", () => {
  const before = state();
  const reference = before.prep.find((item) => item.id === "prep-thu-rice");
  const result = executeDomainCommand(before, {
    type: "toggleInstructionStep",
    stepId: reference.stepId,
  });

  assert.equal(result.ok, true);
  assert.equal(resolveInstructionStep(result.state, reference.stepId).step.complete, true);
  assert.equal(
    result.state.meals
      .find((meal) => meal.id === "thu")
      .instructions.find((step) => step.id === reference.stepId).complete,
    true,
  );
  assert.deepEqual(
    result.state.prep.find((item) => item.id === reference.id),
    reference,
  );
  assert.equal(Object.hasOwn(reference, "complete"), false);
});

test("instruction notes can be updated and cleared on the canonical step", () => {
  const updated = executeDomainCommand(state(), {
    type: "updateInstructionStepNote",
    stepId: "thu-rice",
    note: "Use the rice cooker and hold on warm.",
  });

  assert.equal(updated.ok, true);
  assert.equal(
    resolveInstructionStep(updated.state, "thu-rice").step.note,
    "Use the rice cooker and hold on warm.",
  );

  const cleared = executeDomainCommand(updated.state, {
    type: "updateInstructionStepNote",
    stepId: "thu-rice",
    note: "",
  });
  assert.equal(cleared.ok, true);
  assert.equal(resolveInstructionStep(cleared.state, "thu-rice").step.note, "");
});

test("instruction timers persist an absolute start timestamp and can be reset", () => {
  const startedAt = Date.UTC(2026, 6, 9, 20, 15, 0);
  const started = executeDomainCommand(
    state(),
    { type: "startInstructionTimer", stepId: "thu-rice" },
    { now: () => startedAt },
  );

  assert.equal(started.ok, true);
  assert.equal(resolveInstructionStep(started.state, "thu-rice").step.timerStartedAt, startedAt);
  assert.equal(resolveInstructionStep(started.state, "thu-rice").step.timerDurationSeconds, 1080);

  const reset = executeDomainCommand(started.state, {
    type: "resetInstructionTimer",
    stepId: "thu-rice",
  });
  assert.equal(reset.ok, true);
  assert.equal(resolveInstructionStep(reset.state, "thu-rice").step.timerStartedAt, undefined);

  const beforeInvalidClock = state();
  const invalidClock = executeDomainCommand(
    beforeInvalidClock,
    { type: "startInstructionTimer", stepId: "thu-rice" },
    { now: () => -1 },
  );
  assert.equal(invalidClock.ok, false);
  assert.match(invalidClock.error, /current time is invalid/i);
  assert.equal(invalidClock.state, beforeInvalidClock);
});

test("setPrepPlan owns manual order and rejects duplicate or missing step references", () => {
  const before = state();
  const originalRecipeOrder = recipeOrder(before, "thu");
  const result = executeDomainCommand(before, {
    type: "setPrepPlan",
    entries: [
      { stepId: "sun-flake", due: "Sat, Jul 11" },
      { stepId: "thu-thaw", due: "Wed, Jul 8" },
      { stepId: "fri-sauce", due: "Thu, Jul 9" },
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.state.prep.map((reference) => reference.stepId), [
    "sun-flake",
    "thu-thaw",
    "fri-sauce",
  ]);
  assert.deepEqual(result.state.prep.map((reference) => reference.position), [0, 1, 2]);
  assert.deepEqual(result.state.prep.map((reference) => reference.id), [
    "prep-sun-flake",
    "prep-thu-thaw",
    "prep-fri-sauce",
  ]);
  assert.deepEqual(recipeOrder(result.state, "thu"), originalRecipeOrder);

  assert.equal(
    isDomainCommand({
      type: "setPrepPlan",
      entries: [
        { stepId: "thu-rice", due: "Sun, Jul 5" },
        { stepId: "thu-rice", due: "Thu, Jul 9" },
      ],
    }),
    false,
  );

  const missing = executeDomainCommand(before, {
    type: "setPrepPlan",
    entries: [{ stepId: "missing-step", due: "Sun, Jul 5" }],
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /instruction step not found: missing-step/i);
  assert.deepEqual(missing.state, before);
});

test("moving, rescheduling, and removing prep references preserve recipe order and completion", () => {
  const before = state();
  const originalRecipeOrder = recipeOrder(before, "thu");

  const moved = executeDomainCommand(before, {
    type: "movePrepReference",
    referenceId: "prep-thu-thaw",
    targetPosition: 0,
  });
  assert.equal(moved.ok, true);
  assert.deepEqual(prepOrder(moved.state), [
    "prep-thu-thaw",
    "prep-fri-sauce",
    "prep-thu-rice",
    "prep-sun-flake",
  ]);

  const rescheduled = executeDomainCommand(moved.state, {
    type: "reschedulePrepReference",
    referenceId: "prep-thu-thaw",
    due: "Thu, Jul 9",
  });
  assert.equal(rescheduled.ok, true);
  assert.equal(
    rescheduled.state.prep.find((reference) => reference.id === "prep-thu-thaw").due,
    "Thu, Jul 9",
  );

  const removed = executeDomainCommand(rescheduled.state, {
    type: "removePrepReference",
    referenceId: "prep-thu-thaw",
  });
  assert.equal(removed.ok, true);
  assert.deepEqual(prepOrder(removed.state), [
    "prep-fri-sauce",
    "prep-thu-rice",
    "prep-sun-flake",
  ]);
  assert.deepEqual(removed.state.prep.map((reference) => reference.position).sort(), [0, 1, 2]);
  assert.deepEqual(recipeOrder(removed.state, "thu"), originalRecipeOrder);
  assert.equal(resolveInstructionStep(removed.state, "thu-thaw").step.complete, true);
});

test("meal moves leave independently scheduled prep dates unchanged", () => {
  const before = state();
  const prepDates = Object.fromEntries(
    before.prep.map((reference) => [reference.id, reference.due]),
  );
  const result = executeDomainCommand(before, {
    type: "moveMeal",
    mealId: "fri",
    targetDayIndex: 3,
  });

  assert.equal(result.ok, true);
  assert.equal(result.state.meals.find((meal) => meal.id === "fri").dayIndex, 3);
  assert.equal(result.state.meals.find((meal) => meal.id === "thu").dayIndex, 4);
  assert.deepEqual(
    Object.fromEntries(result.state.prep.map((reference) => [reference.id, reference.due])),
    prepDates,
  );
  assert.equal(result.state.leftovers.find((item) => item.id === "left-fri").assignedDayIndex, 3);
});

test("remote planner command validation covers canonical steps and prep references", () => {
  const valid = [
    { type: "toggleInstructionStep", stepId: "thu-rice" },
    { type: "updateInstructionStepNote", stepId: "thu-rice", note: "" },
    { type: "startInstructionTimer", stepId: "thu-rice" },
    { type: "resetInstructionTimer", stepId: "thu-rice" },
    {
      type: "setPrepPlan",
      entries: [
        { stepId: "thu-rice", due: "Sun, Jul 5" },
        { stepId: "fri-sauce", due: "Thu, Jul 9" },
      ],
    },
    { type: "movePrepReference", referenceId: "prep-thu-rice", targetPosition: 0 },
    { type: "reschedulePrepReference", referenceId: "prep-thu-rice", due: "Thu, Jul 9" },
    { type: "removePrepReference", referenceId: "prep-thu-rice" },
    { type: "moveMeal", mealId: "thu", targetDayIndex: 5 },
    { type: "captureWeekLesson", weekLesson: "" },
  ];
  for (const command of valid) assert.equal(isDomainCommand(command), true, command.type);

  const invalid = [
    { type: "toggleInstructionStep", stepId: "" },
    { type: "updateInstructionStepNote", stepId: "thu-rice", note: "x".repeat(4_001) },
    { type: "startInstructionTimer", stepId: "thu-rice", startedAt: 1_783_628_100_000 },
    { type: "startInstructionTimer", stepId: "" },
    { type: "resetInstructionTimer", stepId: "thu-rice", surprise: true },
    {
      type: "setPrepPlan",
      entries: [
        { stepId: "thu-rice", due: "Sun, Jul 5" },
        { stepId: "thu-rice", due: "Thu, Jul 9" },
      ],
    },
    { type: "setPrepPlan", entries: [{ stepId: "thu-rice", due: "" }] },
    { type: "movePrepReference", referenceId: "prep-thu-rice", targetPosition: 64 },
    { type: "reschedulePrepReference", referenceId: "prep-thu-rice", due: "" },
    { type: "removePrepReference", referenceId: "prep-thu-rice", extra: true },
    { type: "moveMeal", mealId: "thu", targetDayIndex: 8 },
    { type: "archiveWeek", surprise: true },
    { type: "deleteEverything" },
    null,
  ];
  for (const command of invalid) {
    assert.equal(isDomainCommand(command), false, JSON.stringify(command));
  }
});

test("cooking creates a structured leftover record that can be assigned", () => {
  const cooked = executeDomainCommand(state(), {
    type: "updateMealStatus",
    mealId: "thu",
    status: "cooked",
  });
  assert.equal(cooked.ok, true);
  assert.ok(cooked.state.leftovers.find((item) => item.sourceMealId === "thu"));

  const withoutExisting = state();
  withoutExisting.leftovers = [];
  const created = executeDomainCommand(withoutExisting, {
    type: "updateMealStatus",
    mealId: "thu",
    status: "cooked",
  });
  assert.equal(created.ok, true);
  assert.equal(created.state.leftovers[0].portions, 2);

  const assigned = executeDomainCommand(created.state, {
    type: "assignLeftover",
    leftoverId: created.state.leftovers[0].id,
    dayIndex: 6,
  });
  assert.equal(assigned.ok, true);
  assert.equal(assigned.state.leftovers[0].state, "assigned");
  assert.equal(assigned.state.leftovers[0].assignedDayIndex, 6);
  assert.equal(
    Object.hasOwn(assigned.state.meals.find((meal) => meal.id === "sun"), "leftoverId"),
    false,
  );
  assert.equal(assigned.state.meals.find((meal) => meal.id === "sun").status, "leftover");

  const consumed = executeDomainCommand(assigned.state, {
    type: "consumeLeftover",
    leftoverId: assigned.state.leftovers[0].id,
  });
  assert.equal(consumed.ok, true);
  assert.equal(consumed.state.leftovers[0].state, "consumed");
  assert.equal(consumed.state.leftovers[0].assignedDayIndex, 6);
  assert.equal(consumed.state.meals.find((meal) => meal.id === "sun").status, "cooked");
});

test("leftover assignments require available inventory and an unoccupied destination", () => {
  const before = state();
  const nonAvailable = executeDomainCommand(before, {
    type: "assignLeftover",
    leftoverId: "left-fri",
    dayIndex: 6,
  });
  assert.equal(nonAvailable.ok, false);
  assert.match(nonAvailable.error, /only available leftovers/i);
  assert.equal(nonAvailable.state, before);

  const occupied = executeDomainCommand(before, {
    type: "assignLeftover",
    leftoverId: "left-thu",
    dayIndex: 4,
  });
  assert.equal(occupied.ok, false);
  assert.match(occupied.error, /already has assigned leftovers/i);
  assert.equal(occupied.state, before);
});

test("identical snapshot, prep, feedback, and quality commands are rejected as no-ops", () => {
  const snapshotState = state();
  const snapshotMeal = snapshotState.meals.find((meal) => meal.id === "thu");
  const snapshot = executeDomainCommand(snapshotState, {
    type: "updateMealSnapshot",
    mealId: snapshotMeal.id,
    changes: {
      title: snapshotMeal.title,
      venue: snapshotMeal.venue,
      notes: snapshotMeal.notes,
    },
  });
  assert.equal(snapshot.ok, false);
  assert.match(snapshot.error, /snapshot is unchanged/i);
  assert.equal(snapshot.state, snapshotState);

  const prepState = state();
  const prep = executeDomainCommand(prepState, {
    type: "setPrepPlan",
    entries: [...prepState.prep]
      .sort((left, right) => left.position - right.position)
      .map(({ stepId, due }) => ({ stepId, due })),
  });
  assert.equal(prep.ok, false);
  assert.match(prep.error, /prep plan is unchanged/i);
  assert.equal(prep.state, prepState);

  const feedbackState = state();
  feedbackState.feedback.thu = "repeat";
  const feedback = executeDomainCommand(feedbackState, {
    type: "captureFeedback",
    mealId: "thu",
    value: "repeat",
  });
  assert.equal(feedback.ok, false);
  assert.match(feedback.error, /feedback is unchanged/i);
  assert.equal(feedback.state, feedbackState);

  const qualityState = state();
  qualityState.leftovers[0].quality = "good";
  const quality = executeDomainCommand(qualityState, {
    type: "captureLeftoverQuality",
    leftoverId: "left-thu",
    quality: "good",
  });
  assert.equal(quality.ok, false);
  assert.match(quality.error, /quality is unchanged/i);
  assert.equal(quality.state, qualityState);
});

test("the reducer rejects malformed commands before executing domain behavior", () => {
  const before = state();
  before.weekArchived = true;
  const result = executeDomainCommand(before, {
    type: "archiveWeek",
    surprise: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /malformed planner command/i);
  assert.equal(result.state, before);
});

test("archiving makes active-week commands read-only", () => {
  const archived = executeDomainCommand(state(), { type: "archiveWeek" });
  assert.equal(archived.ok, true);
  assert.equal(archived.state.weekArchived, true);

  const attemptedEdit = executeDomainCommand(archived.state, {
    type: "toggleInstructionStep",
    stepId: "thu-rice",
  });
  assert.equal(attemptedEdit.ok, false);
  assert.match(attemptedEdit.error, /archived and read-only/i);
});

test("feedback cannot create an orphan record for an unknown meal", () => {
  const result = executeDomainCommand(state(), {
    type: "captureFeedback",
    mealId: "missing-meal",
    value: "repeat",
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /meal not found/i);
  assert.deepEqual(result.state.feedback, {});
});
