import assert from "node:assert/strict";
import test from "node:test";
import { buildChatPlannerState } from "../lib/planner-chat-context.ts";

const activePlannerState = {
  meals: [{ id: "active-secret", title: "Active week dinner" }],
  prep: [],
  groceries: [],
  leftovers: [],
  farmBoxReconciled: false,
  weekArchived: false,
  draftReady: true,
  feedback: {},
  weekLesson: "Active week detail",
};

test("active-week chat receives the canonical planner state", () => {
  const context = buildChatPlannerState({
    activeWeekId: "active",
    activePlannerState,
    selectedWeek: {
      id: "active",
      label: "Jul 6",
      range: "Jul 6 - 12",
      state: "active",
    },
    draftMealTitles: [],
  });

  assert.equal(context, activePlannerState);
});

test("draft-week chat receives only that draft's visible data", () => {
  const context = buildChatPlannerState({
    activeWeekId: "active",
    activePlannerState,
    selectedWeek: {
      id: "draft",
      label: "Jul 13",
      range: "Jul 13 - 19",
      state: "draft",
    },
    draftMealTitles: ["Draft chicken", "Draft salmon"],
  });

  assert.deepEqual(context.draftMealTitles, ["Draft chicken", "Draft salmon"]);
  assert.equal(context.draftReady, true);
  assert.doesNotMatch(JSON.stringify(context), /active-secret|Active week dinner|Active week detail/);
});

test("archived placeholder chat never receives active-week data", () => {
  const context = buildChatPlannerState({
    activeWeekId: "active",
    activePlannerState,
    selectedWeek: {
      id: "archived",
      label: "Jun 29",
      range: "Jun 29 - Jul 5",
      state: "archived",
    },
    draftMealTitles: [],
  });

  assert.match(context.dataAvailability, /No detailed meal snapshot/);
  assert.doesNotMatch(JSON.stringify(context), /active-secret|Active week dinner|Active week detail/);
});
