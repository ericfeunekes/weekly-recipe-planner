import type { WeekId, WeekPlan } from "../lib/household-contract.ts";

export const LAST_VALID_WEEK_STORAGE_KEY = "weekly-recipe-planner.last-valid-week";

export type PlannerLocation =
  | { kind: "root" }
  | { kind: "week"; weekId: WeekId }
  | { kind: "prep"; weekId: WeekId }
  | { kind: "recipe"; weekId: WeekId; mealId: string }
  | { kind: "groceries"; weekId: WeekId }
  | { kind: "closeout"; weekId: WeekId }
  | { kind: "retired-day" }
  | { kind: "unknown" };

type RememberedPlannerLocation = Exclude<PlannerLocation, { kind: "root" } | { kind: "retired-day" } | { kind: "unknown" }>;

export function parsePlannerLocation(pathname: string): PlannerLocation {
  if (pathname === "/") return { kind: "root" };
  const prep = /^\/weeks\/([^/]+)\/prep$/u.exec(pathname);
  if (prep) return { kind: "prep", weekId: prep[1] as WeekId };
  const recipe = /^\/weeks\/([^/]+)\/recipes\/([^/]+)$/u.exec(pathname);
  if (recipe) return { kind: "recipe", weekId: recipe[1] as WeekId, mealId: recipe[2] };
  const groceries = /^\/weeks\/([^/]+)\/groceries$/u.exec(pathname);
  if (groceries) return { kind: "groceries", weekId: groceries[1] as WeekId };
  const closeout = /^\/weeks\/([^/]+)\/closeout$/u.exec(pathname);
  if (closeout) return { kind: "closeout", weekId: closeout[1] as WeekId };
  if (/^\/weeks\/[^/]+\/day\/[^/]+$/u.test(pathname)) return { kind: "retired-day" };
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

export function prepPath(weekId: WeekId): string {
  return `${weekPath(weekId)}/prep`;
}

export function groceriesPath(weekId: WeekId): string {
  return `${weekPath(weekId)}/groceries`;
}

export function closeoutPath(weekId: WeekId): string {
  return `${weekPath(weekId)}/closeout`;
}

export function plannerLocationPath(location: RememberedPlannerLocation): string {
  if (location.kind === "week") return weekPath(location.weekId);
  if (location.kind === "prep") return prepPath(location.weekId);
  if (location.kind === "recipe") return recipePath(location.weekId, location.mealId);
  if (location.kind === "groceries") return groceriesPath(location.weekId);
  return closeoutPath(location.weekId);
}

export function parseRememberedPlannerLocation(value: string | null): RememberedPlannerLocation | null {
  if (!value) return null;
  if (!value.startsWith("{")) return { kind: "week", weekId: value as WeekId };
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.weekId !== "string" || candidate.weekId.length === 0) return null;
    if (candidate.kind === "week" || candidate.kind === "prep" || candidate.kind === "groceries" || candidate.kind === "closeout") {
      return { kind: candidate.kind, weekId: candidate.weekId as WeekId };
    }
    if (candidate.kind === "recipe" && typeof candidate.mealId === "string" && candidate.mealId.length > 0) {
      return { kind: "recipe", weekId: candidate.weekId as WeekId, mealId: candidate.mealId };
    }
    return null;
  } catch {
    return null;
  }
}

export function serializeRememberedPlannerLocation(location: RememberedPlannerLocation): string {
  return JSON.stringify(location);
}

export type ResolvedPlannerLocation =
  | { kind: "week"; week: WeekPlan }
  | { kind: "prep"; week: WeekPlan }
  | { kind: "recipe"; week: WeekPlan; mealId: string }
  | { kind: "groceries"; week: WeekPlan }
  | { kind: "closeout"; week: WeekPlan }
  | { kind: "unavailable"; week: WeekPlan | null; message: string };

export function rememberedPlannerLocation(
  location: ResolvedPlannerLocation,
): RememberedPlannerLocation | null {
  if (location.kind === "unavailable") return null;
  return location.kind === "recipe"
    ? { kind: "recipe", weekId: location.week.id, mealId: location.mealId }
    : { kind: location.kind, weekId: location.week.id };
}

export function resolvePlannerLocation(
  location: PlannerLocation,
  weeks: readonly WeekPlan[],
  defaultWeekId: WeekId | null,
): ResolvedPlannerLocation {
  const fallback = (defaultWeekId ? weeks.find((week) => week.id === defaultWeekId) : null) ?? weeks.at(-1) ?? null;
  if (location.kind === "root") {
    return fallback ? { kind: "week", week: fallback } : { kind: "unavailable", week: null, message: "No weeks are available." };
  }
  if (location.kind === "retired-day") return { kind: "unavailable", week: null, message: "Day is no longer a planner destination." };
  if (location.kind === "unknown") return { kind: "unavailable", week: fallback, message: "That planner location is unavailable." };
  const week = weeks.find((candidate) => candidate.id === location.weekId) ?? null;
  if (!week) return { kind: "unavailable", week: fallback, message: "That week is unavailable." };
  if (location.kind === "week") return { kind: "week", week };
  if (location.kind === "prep") return { kind: "prep", week };
  if (location.kind === "groceries") return { kind: "groceries", week };
  if (location.kind === "closeout") return { kind: "closeout", week };
  if (week.status === "archived") {
    return { kind: "unavailable", week, message: "That recipe is unavailable for this week." };
  }
  if (!week.data.meals.some((meal) => meal.id === location.mealId)) {
    return { kind: "unavailable", week, message: "That recipe is unavailable for this week." };
  }
  return { kind: "recipe", week, mealId: location.mealId };
}
