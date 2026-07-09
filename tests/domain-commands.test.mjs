import assert from "node:assert/strict";
import test from "node:test";
import {
  executeDomainCommand,
  isSupportedSalmonMoveIntent,
} from "../lib/planner-domain.ts";

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
        prepNote: "Thaw",
        leftoverNote: "Reserve 2 portions",
        notes: "",
        ingredients: [],
        instructions: [],
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
        notes: "",
        ingredients: [],
        instructions: [],
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
        instructions: [],
      },
      {
        id: "sun",
        dayIndex: 6,
        title: "Sunday dinner",
        subtitle: "Open",
        venue: "Home",
        status: "planned",
        protein: "none",
        prepNote: "None",
        leftoverNote: "",
        notes: "",
        ingredients: [],
        instructions: [],
      },
    ],
    prep: [
      { id: "prep-thu", title: "Thaw salmon", due: "Thu, Jul 9", mealId: "thu", complete: false, duration: "Overnight" },
      { id: "prep-fri", title: "Mix sauce", due: "Fri, Jul 10", mealId: "fri", complete: false, duration: "5 min" },
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

test("meal moves swap both meal instances and their linked prep", () => {
  const result = executeDomainCommand(state(), {
    type: "moveMeal",
    mealId: "fri",
    targetDayIndex: 3,
  });

  assert.equal(result.ok, true);
  assert.equal(result.state.meals.find((meal) => meal.id === "fri").dayIndex, 3);
  assert.equal(result.state.meals.find((meal) => meal.id === "thu").dayIndex, 4);
  assert.equal(result.state.prep.find((task) => task.id === "prep-fri").due, "Thu, Jul 9");
  assert.equal(result.state.prep.find((task) => task.id === "prep-thu").due, "Fri, Jul 10");
  assert.equal(result.state.leftovers.find((item) => item.id === "left-fri").assignedDayIndex, 3);
});

test("Codex intent rejects negation and unrelated prose", () => {
  assert.equal(isSupportedSalmonMoveIntent("Move Thursday's salmon to Saturday"), true);
  assert.equal(isSupportedSalmonMoveIntent("Please move the salmon to Saturday"), true);
  assert.equal(isSupportedSalmonMoveIntent("Do not move the salmon to Saturday"), false);
  assert.equal(isSupportedSalmonMoveIntent("We might eat salmon on Saturday"), false);
});

test("cooking creates a structured leftover record that can be assigned", () => {
  const cooked = executeDomainCommand(state(), {
    type: "updateMealStatus",
    mealId: "thu",
    status: "cooked",
  });
  assert.equal(cooked.ok, true);
  const recorded = cooked.state.leftovers.find((item) => item.sourceMealId === "thu");
  assert.ok(recorded);

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
  assert.equal(assigned.state.meals.find((meal) => meal.id === "sun").leftoverId, created.state.leftovers[0].id);
  assert.equal(assigned.state.meals.find((meal) => meal.id === "sun").status, "leftover");

  const consumed = executeDomainCommand(assigned.state, {
    type: "consumeLeftover",
    leftoverId: assigned.state.leftovers[0].id,
  });
  assert.equal(consumed.ok, true);
  assert.equal(consumed.state.leftovers[0].state, "consumed");
  assert.equal(consumed.state.meals.find((meal) => meal.id === "sun").status, "cooked");
});

test("archiving makes active-week commands read-only", () => {
  const archived = executeDomainCommand(state(), { type: "archiveWeek" });
  assert.equal(archived.ok, true);
  assert.equal(archived.state.weekArchived, true);

  const attemptedEdit = executeDomainCommand(archived.state, {
    type: "updateGroceryItem",
    itemId: "missing",
  });
  assert.equal(attemptedEdit.ok, false);
  assert.match(attemptedEdit.error, /archived and read-only/i);
});
