export const HOUSEHOLD_ID = "household" as const;
export const DEFAULT_HOUSEHOLD_TIME_ZONE = "America/Halifax" as const;
export const MEAL_SLOTS = ["dinner"] as const;
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

import type { SourceRecipe } from "./sourced-recipe-contract.ts";

declare const ISO_DATE_BRAND: unique symbol;
declare const WEEK_ID_BRAND: unique symbol;

export type IsoDate = string & { readonly [ISO_DATE_BRAND]: true };
export type WeekId = IsoDate & { readonly [WEEK_ID_BRAND]: true };
export type MealSlot = (typeof MEAL_SLOTS)[number];
export type WeekStatus = (typeof WEEK_STATUSES)[number];
export type MealStatus = (typeof MEAL_STATUSES)[number];
export type FeedbackValue = (typeof FEEDBACK_VALUES)[number];
export type LeftoverQuality = (typeof LEFTOVER_QUALITIES)[number];

export type IngredientAmountLine = {
  amount: string;
  ingredient: string;
};

export type InstructionStep = {
  id: string;
  inputs: IngredientAmountLine[];
  instruction: string;
  complete: boolean;
  timerDurationSeconds?: number;
  timerStartedAt?: number;
  note?: string;
};

export type Meal = {
  id: string;
  date: IsoDate;
  slot: MealSlot;
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
  ingredients: string[];
  instructions: InstructionStep[];
};

export type PrepReference = {
  id: string;
  stepId: string;
  prepDate: IsoDate;
  position: number;
};

export type GroceryItem = {
  id: string;
  section: "Produce" | "Meat & seafood" | "Dairy" | "Pantry";
  item: string;
  detail: string;
  checked: boolean;
  farmBox: boolean;
};

export type Leftover = {
  id: string;
  sourceMealId: string;
  label: string;
  portions: number;
  state: "available" | "assigned" | "consumed";
  assignedDate?: IsoDate;
  assignedSlot?: MealSlot;
  quality?: LeftoverQuality;
};

export type WeekPlannerData = {
  meals: Meal[];
  prep: PrepReference[];
  groceries: GroceryItem[];
  leftovers: Leftover[];
  farmBoxReconciled: boolean;
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
  "id" | "status" | "instructions" | "sourceRecipe"
> & {
  status?: MealStatus;
  instructions: InstructionStepPlanInput[];
};

export type GroceryItemPlanInput = Omit<GroceryItem, "id" | "checked"> & {
  checked?: boolean;
};

export type WeekPlanInput = {
  meals: MealPlanInput[];
  groceries: GroceryItemPlanInput[];
  weekLesson?: string;
};

export type MealSnapshotInput = Pick<
  Meal,
  | "title"
  | "subtitle"
  | "venue"
  | "prepNote"
  | "leftoverNote"
  | "notes"
  | "ingredients"
> & { yieldText: string | null };

export type InstructionStepContentInput = Omit<
  InstructionStepPlanInput,
  "note" | "timerDurationSeconds"
> & {
  timerDurationSeconds: number | null;
};

export type GroceryItemContentInput = Pick<
  GroceryItem,
  "section" | "item" | "detail" | "farmBox"
>;

export type GroceryReconciliationItem = GroceryItemContentInput & {
  id?: string;
  checked: boolean;
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

// Prep is grouped chronologically by date and manually ordered within each date.
// A week's valid prep interval is the Sunday before its Monday start through
// the Sunday ending that week, inclusive.
export const PREP_DAYS_BEFORE_WEEK_START = 1;
export const PREP_DAYS_AFTER_WEEK_START = 6;
