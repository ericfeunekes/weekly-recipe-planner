import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CanonicalSeedError,
  LegacyV2ImportError,
  createCanonicalSeed,
  transformLegacyV2,
} from "../lib/household-bootstrap.ts";
import { householdDomain } from "../lib/household-domain.ts";

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("support/fixtures/browser-v2-workspace.json", import.meta.url),
    "utf8",
  ),
);

function context() {
  const counts = new Map();
  return {
    now: Date.parse("2026-07-10T12:00:00-03:00"),
    createId(prefix) {
      const count = (counts.get(prefix) ?? 0) + 1;
      counts.set(prefix, count);
      return `${prefix}-${count}`;
    },
  };
}

function copyFixture() {
  return structuredClone(FIXTURE);
}

test("strict v2 transform preserves planner and transcript state while normalizing leftover sources", () => {
  const payload = copyFixture();
  const before = structuredClone(payload);
  const result = transformLegacyV2(payload, context());

  assert.deepEqual(payload, before, "import must not mutate the browser snapshot");
  assert.equal(result.state.activeWeekId, "2026-07-06");
  assert.equal(result.state.weeks[0].status, "active");
  assert.equal(result.state.weeks[0].data.meals[0].date, "2026-07-06");
  assert.equal(result.state.weeks[0].data.meals[0].slot, "dinner");
  assert.equal(result.state.weeks[0].data.meals[0].status, "cooked");
  assert.equal(result.state.weeks[0].data.prepSessions[0].prepDate, "2026-07-05");
  const week = result.state.weeks[0];
  assert.equal(
    week.data.groceries.length,
    week.data.meals.reduce((count, meal) => count + meal.ingredients.length, 0),
    "import projects every canonical ingredient into groceries",
  );
  const chickenIngredient = week.data.meals[0].ingredients.find((ingredient) => ingredient.ingredient === "boneless chicken thighs");
  const chickenGrocery = week.data.groceries.find((grocery) => grocery.mealId === week.data.meals[0].id && grocery.ingredientId === chickenIngredient?.id);
  assert.deepEqual(chickenGrocery && {
    mealId: chickenGrocery.mealId,
    ingredientId: chickenGrocery.ingredientId,
    section: chickenGrocery.section,
    source: chickenGrocery.source,
    checked: chickenGrocery.checked,
  }, {
    mealId: week.data.meals[0].id,
    ingredientId: chickenIngredient?.id,
    section: "Meat & seafood",
    source: "shop",
    checked: false,
  });
  assert.equal(result.state.weeks[0].data.leftovers[0].assignedDate, "2026-07-08");
  assert.equal(result.state.weeks[0].data.meals[0].instructions[1].timerStartedAt, 1783353600000);
  assert.deepEqual(result.transcriptEntries, [
    {
      role: "assistant",
      text: "I can reshape the active week while keeping prep, groceries, and leftovers linked.",
      context: null,
    },
    {
      role: "user",
      text: "Move the rice step into Sunday prep.",
      context: {
        view: "week",
        weekId: "2026-07-06",
        mealId: "meal-mon",
      },
    },
  ]);
  assert.equal(result.discardedEventCount, 1);
  assert.deepEqual(householdDomain.validateState(result.state), { ok: true });
});

test("v2 transform normalizes legacy date-grouped prep positions into an ordered session", () => {
  const payload = copyFixture();
  payload.data.prep = [
    { id: "prep-rice", stepId: "meal-mon-rice", due: "Sun, Jul 5", position: 9 },
    { id: "prep-marinate", stepId: "meal-mon-marinate", due: "Sun, Jul 5", position: 3 },
  ];
  payload.events.push(null, { obsolete: true });
  const result = transformLegacyV2(payload, context());
  assert.deepEqual(
    result.state.weeks[0].data.prepSessions.map((session) => ({
      prepDate: session.prepDate,
      steps: session.steps.map(({ id, stepId }) => ({ id, stepId })),
    })),
    [
      {
        prepDate: "2026-07-05",
        steps: [
          { id: "prep-marinate", stepId: "meal-mon-marinate" },
          { id: "prep-rice", stepId: "meal-mon-rice" },
        ],
      },
    ],
  );
  assert.equal(result.discardedEventCount, 3);
});

test("v2 transform fails visibly and never substitutes seed data", () => {
  const invalidDate = copyFixture();
  invalidDate.data.prep[0].due = "Someday";
  assert.throws(
    () => transformLegacyV2(invalidDate, context()),
    (error) => {
      assert.ok(error instanceof LegacyV2ImportError);
      assert.match(error.fieldErrors["payload.data.prep[0].due"], /known/i);
      return true;
    },
  );

  const danglingStep = copyFixture();
  danglingStep.data.prep[0].stepId = "missing-step";
  assert.throws(
    () => transformLegacyV2(danglingStep, context()),
    (error) => {
      assert.ok(error instanceof LegacyV2ImportError);
      assert.ok(
        Object.keys(error.fieldErrors).some((path) => path.includes("prepSessions[0].steps[0].stepId")),
      );
      return true;
    },
  );

  const malformedLesson = copyFixture();
  malformedLesson.data.weekLesson = 42;
  assert.throws(
    () => transformLegacyV2(malformedLesson, context()),
    LegacyV2ImportError,
  );
});

test("archived v2 workspaces import without an active week", () => {
  const payload = copyFixture();
  payload.data.weekArchived = true;
  const result = transformLegacyV2(payload, context());
  assert.equal(result.state.activeWeekId, null);
  assert.equal(result.state.weeks[0].status, "archived");
});

test("canonical seed uses injected time and IDs and returns valid active state", () => {
  const seed = createCanonicalSeed(context());
  assert.equal(seed.activeWeekId, "2026-07-06");
  assert.equal(seed.weeks[0].status, "active");
  assert.equal(seed.weeks[0].data.meals.length, 2);
  assert.equal(seed.weeks[0].data.meals[0].id, "meal-1");
  assert.equal(seed.weeks[0].data.meals[0].date, "2026-07-10");
  assert.ok(seed.weeks[0].data.meals.some((meal) => meal.date === "2026-07-10"));
  assert.deepEqual(
    seed.weeks[0].data.prepSessions.map(({ prepDate, steps }) => ({ prepDate, stepCount: steps.length })),
    [
      { prepDate: "2026-07-05", stepCount: 1 },
      { prepDate: "2026-07-08", stepCount: 1 },
    ],
  );
  assert.deepEqual(householdDomain.validateState(seed), { ok: true });
});

test("canonical seed rejects a broken server ID factory", () => {
  assert.throws(
    () =>
      createCanonicalSeed({
        now: Date.parse("2026-07-10T12:00:00-03:00"),
        createId() {
          return "duplicate";
        },
      }),
    CanonicalSeedError,
  );
});
