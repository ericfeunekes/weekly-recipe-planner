import type { WeekId, WeekPlan } from "../lib/household-contract.ts";
import { weekContainsDate } from "../lib/household-domain.ts";

export const LAST_VALID_WEEK_STORAGE_KEY = "weekly-recipe-planner.last-valid-week";

export type PlannerLocation =
  | { kind: "root" }
  | { kind: "week"; weekId: WeekId }
  | { kind: "recipe"; weekId: WeekId; mealId: string }
  | { kind: "groceries"; weekId: WeekId }
  | { kind: "closeout"; weekId: WeekId }
  | { kind: "legacy-day"; weekId: WeekId; date: string }
  | { kind: "unknown" };

export function parsePlannerLocation(pathname: string): PlannerLocation {
  if (pathname === "/") return { kind: "root" };
  const recipe = /^\/weeks\/([^/]+)\/recipes\/([^/]+)$/u.exec(pathname);
  if (recipe) return { kind: "recipe", weekId: recipe[1] as WeekId, mealId: recipe[2] };
  const groceries = /^\/weeks\/([^/]+)\/groceries$/u.exec(pathname);
  if (groceries) return { kind: "groceries", weekId: groceries[1] as WeekId };
  const closeout = /^\/weeks\/([^/]+)\/closeout$/u.exec(pathname);
  if (closeout) return { kind: "closeout", weekId: closeout[1] as WeekId };
  const legacyDay = /^\/weeks\/([^/]+)\/day\/([^/]+)$/u.exec(pathname);
  if (legacyDay) return { kind: "legacy-day", weekId: legacyDay[1] as WeekId, date: legacyDay[2] };
  const week = /^\/weeks\/([^/]+)$/u.exec(pathname);
  if (week) return { kind: "week", weekId: week[1] as WeekId };
  return { kind: "unknown" };
}

export function weekPath(weekId: WeekId): string {
  return `/weeks/${encodeURIComponent(weekId)}`;
}

export function recipePath(weekId: WeekId, mealId: string): string {
  return `${weekPath(weekId)}/recipes/${encodeURIComponent(mealId)}`;
}

export function groceriesPath(weekId: WeekId): string {
  return `${weekPath(weekId)}/groceries`;
}

export function closeoutPath(weekId: WeekId): string {
  return `${weekPath(weekId)}/closeout`;
}

export function resolveRememberedWeekId(
  weeks: readonly WeekPlan[],
  rememberedWeekId: string | null,
  authoritativeDefaultWeekId: WeekId | null,
): WeekId | null {
  return rememberedWeekId && weeks.some((week) => week.id === rememberedWeekId)
    ? rememberedWeekId as WeekId
    : authoritativeDefaultWeekId;
}

export type ResolvedPlannerLocation =
  | { kind: "week"; week: WeekPlan; legacyDate: string | null }
  | { kind: "recipe"; week: WeekPlan; mealId: string }
  | { kind: "groceries"; week: WeekPlan }
  | { kind: "closeout"; week: WeekPlan }
  | { kind: "unavailable"; week: WeekPlan | null; message: string };

export function resolvePlannerLocation(
  location: PlannerLocation,
  weeks: readonly WeekPlan[],
  defaultWeekId: WeekId | null,
): ResolvedPlannerLocation {
  const fallback = (defaultWeekId ? weeks.find((week) => week.id === defaultWeekId) : null) ?? weeks.at(-1) ?? null;
  if (location.kind === "root") {
    return fallback ? { kind: "week", week: fallback, legacyDate: null } : { kind: "unavailable", week: null, message: "No weeks are available." };
  }
  if (location.kind === "unknown") return { kind: "unavailable", week: fallback, message: "That planner location is unavailable." };
  const week = weeks.find((candidate) => candidate.id === location.weekId) ?? null;
  if (!week) return { kind: "unavailable", week: fallback, message: "That week is unavailable." };
  if (location.kind === "week") return { kind: "week", week, legacyDate: null };
  if (location.kind === "groceries") return { kind: "groceries", week };
  if (location.kind === "closeout") return { kind: "closeout", week };
  if (location.kind === "legacy-day") {
    const validDate = /^\d{4}-\d{2}-\d{2}$/u.test(location.date) &&
      weekContainsDate(week.id, location.date as import("../lib/household-contract.ts").IsoDate);
    return validDate
      ? { kind: "week", week, legacyDate: location.date }
      : { kind: "unavailable", week, message: "That legacy Day location is unavailable." };
  }
  if (week.status === "archived") {
    return { kind: "unavailable", week, message: "That recipe is unavailable for this week." };
  }
  if (!week.data.meals.some((meal) => meal.id === location.mealId)) {
    return { kind: "unavailable", week, message: "That recipe is unavailable for this week." };
  }
  return { kind: "recipe", week, mealId: location.mealId };
}
