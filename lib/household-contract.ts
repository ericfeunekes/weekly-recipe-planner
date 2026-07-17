export const HOUSEHOLD_ID = "household" as const;
export const DEFAULT_HOUSEHOLD_TIME_ZONE = "America/Halifax" as const;
// A date can hold one meal in each named slot. Keeping slots explicit lets the
// planner distinguish a full day from an accidental duplicate.
export const WEEK_STATUSES = ["planned", "active", "archived"] as const;
export const MEAL_STATUSES = [
  "planned",
  "moved",
  "cooking",
  "cooked",
  "leftover",
  "flex",
] as const;
export const FEEDBACK_VALUES = ["repeat", "modify", "drop"] as const;
export const LEFTOVER_QUALITIES = ["good", "mixed", "poor"] as const;
export const GROCERY_SOURCES = ["shop", "farm_box", "on_hand"] as const;

import type { SourceRecipe } from "./sourced-recipe-contract.ts";

declare const ISO_DATE_BRAND: unique symbol;
declare const WEEK_ID_BRAND: unique symbol;

export type IsoDate = string & { readonly [ISO_DATE_BRAND]: true };
export type WeekId = IsoDate & { readonly [WEEK_ID_BRAND]: true };
export type WeekStatus = (typeof WEEK_STATUSES)[number];
export type MealStatus = (typeof MEAL_STATUSES)[number];
export type FeedbackValue = (typeof FEEDBACK_VALUES)[number];
export type LeftoverQuality = (typeof LEFTOVER_QUALITIES)[number];
export type GrocerySource = (typeof GROCERY_SOURCES)[number];
export type GrocerySection = "Produce" | "Meat & seafood" | "Dairy" | "Pantry";

export type IngredientAmountLine = {
  amount: string;
  ingredient: string;
};

export type RecipeIngredient = IngredientAmountLine & {
  id: string;
};

export type IngredientUse = IngredientAmountLine & {
  ingredientId: string;
};

export type InstructionStep = {
  id: string;
  inputs: IngredientUse[];
  instruction: string;
  complete: boolean;
  timerDurationSeconds?: number;
  timerStartedAt?: number;
  timerPaused?: boolean;
  note?: string;
};

export type Meal = {
  id: string;
  date: IsoDate;
  /** @deprecated Legacy display-only field. New meals have no named slot. */
  slot?: string;
  title: string;
  yieldText?: string;
  sourceRecipe?: SourceRecipe;
  subtitle: string;
  venue: string;
  status: MealStatus;
  protein: "chicken" | "salmon" | "none";
  prepNote: string;
  leftoverNote: string;
  notes: string;
  ingredients: RecipeIngredient[];
  instructions: InstructionStep[];
};

export type PrepSessionStep = {
  id: string;
  stepId: string;
};

export type PrepSession = {
  id: string;
  label: string;
  prepDate?: IsoDate;
  steps: PrepSessionStep[];
};

export type GroceryItem = {
  id: string;
  /**
   * Grocery execution state is attached to one canonical recipe-ingredient
   * occurrence. The name, amount, and recipe link are derived from this pair
   * at read time; they must never become a competing editable grocery copy.
   */
  mealId: string;
  ingredientId: string;
  section: GrocerySection;
  checked: boolean;
  source: GrocerySource;
};

export type Leftover = {
  id: string;
  sourceMealId: string;
  label: string;
  portions: number;
  state: "available" | "assigned" | "consumed";
  assignedDate?: IsoDate;
  /** @deprecated Legacy display-only field. */
  assignedSlot?: string;
  assignedMealId?: string;
  quality?: LeftoverQuality;
};

export type WeekPlannerData = {
  meals: Meal[];
  prepSessions: PrepSession[];
  groceries: GroceryItem[];
  leftovers: Leftover[];
  feedback: Record<string, FeedbackValue>;
  weekLesson: string;
};

export type WeekPlan = {
  id: WeekId;
  weekStartDate: IsoDate;
  status: WeekStatus;
  data: WeekPlannerData;
};

export type HouseholdPlannerState = {
  householdTimeZone: string;
  activeWeekId: WeekId | null;
  weeks: WeekPlan[];
};

export type InstructionStepPlanInput = {
  inputs: IngredientAmountLine[];
  instruction: string;
  timerDurationSeconds?: number;
  note?: string;
};

export type MealPlanInput = Omit<
  Meal,
  "id" | "status" | "ingredients" | "instructions" | "sourceRecipe"
> & {
  status?: MealStatus;
  ingredients: string[];
  instructions: InstructionStepPlanInput[];
};

export type WeekPlanInput = {
  meals: MealPlanInput[];
  weekLesson?: string;
};

export type MealSnapshotInput = Pick<
  Meal,
  "title" | "subtitle" | "venue" | "prepNote" | "leftoverNote" | "notes"
> & {
  ingredients: string[];
  yieldText: string | null;
};

export type InstructionStepContentInput = Omit<
  InstructionStepPlanInput,
  "note" | "timerDurationSeconds"
> & {
  timerDurationSeconds: number | null;
};

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string") return false;
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function isWeekId(value: unknown): value is WeekId {
  if (!isIsoDate(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 1;
}

export function parseIsoDate(value: unknown): IsoDate {
  if (!isIsoDate(value)) throw new TypeError("Expected an ISO calendar date.");
  return value;
}

export function parseWeekId(value: unknown): WeekId {
  if (!isWeekId(value)) throw new TypeError("Expected a Monday ISO week ID.");
  return value;
}

// Prep sessions are ordered worklists owned by a meal-planning week. The work
// itself can happen on any earlier calendar day, or any day through the Sunday
// that ends its owning meal week.
export const PREP_DAYS_AFTER_WEEK_START = 6;
