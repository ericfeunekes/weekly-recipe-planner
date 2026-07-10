import type { PlannerData } from "./planner-domain";

export type PlannerWeekContext = {
  id: string;
  label: string;
  range: string;
  state: "archived" | "active" | "draft";
};

export function buildChatPlannerState({
  activeWeekId,
  activePlannerState,
  selectedWeek,
  draftMealTitles,
}: {
  activeWeekId: string;
  activePlannerState: PlannerData;
  selectedWeek: PlannerWeekContext;
  draftMealTitles: string[];
}): Record<string, unknown> {
  if (selectedWeek.id === activeWeekId) return activePlannerState;

  if (selectedWeek.state === "draft") {
    return {
      selectedWeek,
      dataAvailability: "Only the draft meal titles shown in the planner are available.",
      draftMealTitles,
      draftReady: activePlannerState.draftReady,
    };
  }

  return {
    selectedWeek,
    dataAvailability: "No detailed meal snapshot is stored for this archived week.",
  };
}
