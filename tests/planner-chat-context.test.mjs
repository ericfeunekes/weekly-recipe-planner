import assert from "node:assert/strict";
import test from "node:test";

import { createCanonicalSeed } from "../lib/household-bootstrap.ts";
import { plannerChatContextForView } from "../app/planner-chat-context.ts";

const NOW = Date.parse("2026-07-10T12:00:00-03:00");

function seededWeek() {
  let sequence = 0;
  const state = createCanonicalSeed({
    now: NOW,
    createId(prefix) {
      sequence += 1;
      return `${prefix}-${sequence}`;
    },
  });
  return structuredClone(state.weeks[0]);
}

test("Tonight chat targets the assigned leftover rendered over an occupied meal", () => {
  const week = seededWeek();
  const meal = week.data.meals[1];
  week.data.leftovers.push({
    id: "leftover-occupied",
    sourceMealId: week.data.meals[0].id,
    label: "Shared leftovers",
    portions: 2,
    state: "assigned",
    assignedDate: meal.date,
    assignedSlot: "dinner",
  });

  assert.deepEqual(plannerChatContextForView("tonight", week, meal.date), {
    view: "tonight",
    weekId: week.id,
    leftoverId: "leftover-occupied",
  });
});

test("Tonight chat uses the meal only when no assigned leftover owns the slot", () => {
  const week = seededWeek();
  const meal = week.data.meals[0];
  assert.deepEqual(plannerChatContextForView("tonight", week, meal.date), {
    view: "tonight",
    weekId: week.id,
    mealId: meal.id,
  });
});
