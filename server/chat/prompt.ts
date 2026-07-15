import type { InitializedWorkspace } from "../../lib/planner-api-contract.ts";
import type { PlannerChatContext } from "../../lib/planner-chat-contract.ts";

export function resolveCanonicalContext(
  workspace: InitializedWorkspace,
  context: PlannerChatContext,
) {
  if (context.weekId === undefined) {
    return {
      view: context.view,
      householdTimeZone: workspace.state.householdTimeZone,
      activeWeekId: workspace.state.activeWeekId,
      selectedWeek: null,
      selectedMealId: null,
      selectedStepId: null,
      selectedLeftoverId: null,
    };
  }
  const week = workspace.state.weeks.find((candidate) => candidate.id === context.weekId);
  if (!week) return null;

  const meal = context.mealId
    ? week.data.meals.find((candidate) => candidate.id === context.mealId)
    : null;
  if (context.mealId && !meal) return null;

  const step = context.stepId
    ? meal?.instructions.find((candidate) => candidate.id === context.stepId)
    : null;
  if (context.stepId && !step) return null;

  const leftover = context.leftoverId
    ? week.data.leftovers.find((candidate) => candidate.id === context.leftoverId)
    : null;
  if (context.leftoverId && !leftover) return null;

  return {
    view: context.view,
    householdTimeZone: workspace.state.householdTimeZone,
    activeWeekId: workspace.state.activeWeekId,
    selectedWeek: week,
    selectedMealId: meal?.id ?? null,
    selectedStepId: step?.id ?? null,
    selectedLeftoverId: leftover?.id ?? null,
  };
}
