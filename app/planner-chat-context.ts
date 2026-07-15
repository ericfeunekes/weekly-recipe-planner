import type { IsoDate, WeekPlan } from "../lib/household-contract.ts";
import type { PlannerChatContext, PlannerView } from "../lib/planner-chat-contract.ts";

export function plannerChatContextForView(
  view: PlannerView,
  week: WeekPlan | null,
  today: IsoDate,
): PlannerChatContext {
  if (week === null) return { view };
  if (view !== "tonight") return { view, weekId: week.id };

  const leftover = week.data.leftovers.find(
    (candidate) =>
      candidate.state === "assigned" &&
      candidate.assignedDate === today &&
      candidate.assignedSlot === "dinner",
  );
  if (leftover) return { view, weekId: week.id, leftoverId: leftover.id };

  const meal = week.data.meals.find(
    (candidate) => candidate.date === today && candidate.slot === "dinner",
  );
  return meal
    ? { view, weekId: week.id, mealId: meal.id }
    : { view, weekId: week.id };
}
