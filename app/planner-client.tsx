"use client";

import {
  Archive,
  ArrowDown,
  ArrowUp,
  Bot,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  ClipboardCheck,
  Clock3,
  CookingPot,
  Copy,
  EllipsisVertical,
  GripVertical,
  Home,
  List,
  ListChecks,
  LoaderCircle,
  MapPin,
  MessageSquareText,
  PackageCheck,
  PencilLine,
  Pause,
  Play,
  Plus,
  RotateCcw,
  ShoppingBasket,
  Split,
  StickyNote,
  Trash2,
  Utensils,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { RouterProvider, createRootRoute, createRoute, createRouter, useNavigate, useRouterState } from "@tanstack/react-router";

import {
  MAX_COMMAND_TEXT_LENGTH,
  MAX_ID_LENGTH,
  MAX_INGREDIENT_LINE_LENGTH,
  MAX_INGREDIENT_LINES,
  MAX_MEAL_SUBTITLE_LENGTH,
  MAX_MEAL_TITLE_LENGTH,
  MAX_MEAL_VENUE_LENGTH,
  MAX_STEP_INPUT_AMOUNT_LENGTH,
  MAX_STEP_INPUT_INGREDIENT_LENGTH,
  MAX_STEP_INPUTS,
  isHouseholdCommand,
  type HouseholdCommand,
} from "@/lib/household-command-contract";
import {
  isIngredientOccurrenceEdit,
  normalizedCoreIngredientLiteral,
  type InstructionInputEdit,
} from "@/lib/ingredient-occurrence";
import {
  FEEDBACK_VALUES,
  GROCERY_COVERAGES,
  LEFTOVER_QUALITIES,
  MEAL_STATUSES,
  isPrepSessionCombinedStep,
  type GroceryItem,
  type GroceryCoverage,
  type InstructionStep,
  type IsoDate,
  type Meal,
  type PrepSessionStep,
  type WeekId,
  type WeekPlan,
} from "@/lib/household-contract";
import { addIsoDateDays, weekContainsDate } from "@/lib/household-domain";
import {
  LEGACY_V2_STORAGE_KEY,
  type ApplyPlannerCommandRequest,
  type BootstrapWorkspaceRequest,
  type InitializedWorkspace,
  type PlannerEvent,
  type UndoLatestRequest,
  type WorkspaceResponse,
} from "@/lib/planner-api-contract";
import {
  LEGACY_V1_STORAGE_KEY,
  PlannerApiError,
  applyPlannerCommand,
  bootstrapWorkspace,
  createRequestId,
  isAbortError,
  readLegacyImport,
  readWorkspace,
  previewPlannerOperations,
  shouldAcceptWorkspace,
  undoLatest,
  type LegacyImportCandidate,
} from "./planner-api";
import {
  AUTHORITY_OPERATION_JOURNAL_EVENT,
  clearAuthorityOperationJournalAfterReadback,
  discardAuthorityOperation,
  operationKey,
  readAuthorityOperations,
  replaceResolvedAuthorityOperation,
  updateAuthorityOperationDraft,
  type PendingAuthorityOperation,
} from "./authority-operation-journal";
import {
  hasValidationIssues,
  validateMealDraft,
  validateStepDraft,
} from "./planner-validation";
import { deriveTimerDisplay } from "./timer-display";
import {
  composeCompositeDraft,
  editCompositeDraft,
  settleCompositeDraft,
  type CompositeDraft,
} from "./versioned-draft";
import { isoDateForTimeZone } from "./calendar-time";
import {
  LAST_VALID_WEEK_STORAGE_KEY,
  parsePlannerLocation,
  recipePath,
  resolvePlannerLocation,
  resolveRememberedWeekId,
  weekPath,
} from "./planner-routing";
import { CodexThreadRail } from "./codex-thread-rail";
import { PlannerActionButton, PlannerIconButton } from "@/components/planner-ui/action-button";
import { RecipeIngredientList, RecipeInstructionContent } from "@/components/planner-ui/recipe-content";
import { PrepView } from "@/components/planner-ui/prep-view";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { OfflineAuthorityNotice } from "./offline-authority-notice";
import type { PlannerView } from "./planner-view";

type ConnectionState = "loading" | "online" | "offline";
type Notice = { tone: "info" | "warning" | "error"; message: string } | null;
type WorkspaceQueryData = {
  workspace: WorkspaceResponse;
  serverDate: number | null;
};
const WORKSPACE_QUERY_KEY = ["planner", "workspace"] as const;

type MutateOptions = {
  basePlannerVersion?: number;
  conflictStrategy?: "recompose";
  onAccepted?: (plannerVersion: number) => void;
  onConflict?: (plannerVersion: number) => void;
};
type PendingAuthorityRetry = {
  operation: PendingAuthorityOperation;
  label: string;
  message: string;
  tone: "warning" | "error";
} & (
  | {
      kind: "planner";
      mode: "same-envelope" | "latest-version";
      request: ApplyPlannerCommandRequest;
      options?: MutateOptions;
    }
  | { kind: "bootstrap"; request: BootstrapWorkspaceRequest }
  | { kind: "undo"; request: UndoLatestRequest }
);
type PendingRetryChannel = "planner";
type PendingRetryVolatile = {
  options?: MutateOptions;
};

type MealRecipeRecoveryCommand = Extract<HouseholdCommand, { type: "editMealRecipe" }>;

function hasExactRecordKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isMealRecipeRecoveryCommand(value: unknown): value is MealRecipeRecoveryCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  if (!hasExactRecordKeys(command, ["type", "weekId", "mealId", "changes", "occurrences", "removedOccurrenceIds"]) ||
      command.type !== "editMealRecipe" ||
      typeof command.weekId !== "string" || command.weekId.length === 0 || command.weekId.length > MAX_ID_LENGTH ||
      typeof command.mealId !== "string" || command.mealId.length === 0 || command.mealId.length > MAX_ID_LENGTH ||
      command.changes === null || typeof command.changes !== "object" || Array.isArray(command.changes)) {
    return false;
  }
  const changes = command.changes as Record<string, unknown>;
  if (!hasExactRecordKeys(changes, [
    "title",
    "subtitle",
    "venue",
    "prepNote",
    "leftoverNote",
    "notes",
    "yieldText",
  ])) return false;
  return typeof changes.title === "string" && changes.title.length <= MAX_MEAL_TITLE_LENGTH &&
    typeof changes.subtitle === "string" && changes.subtitle.length <= MAX_MEAL_SUBTITLE_LENGTH &&
    typeof changes.venue === "string" && changes.venue.length <= MAX_MEAL_VENUE_LENGTH &&
    typeof changes.prepNote === "string" && changes.prepNote.length <= MAX_COMMAND_TEXT_LENGTH &&
    typeof changes.leftoverNote === "string" && changes.leftoverNote.length <= MAX_COMMAND_TEXT_LENGTH &&
    typeof changes.notes === "string" && changes.notes.length <= MAX_COMMAND_TEXT_LENGTH &&
    Array.isArray(command.occurrences) && command.occurrences.length <= MAX_INGREDIENT_LINES &&
    command.occurrences.every(isIngredientOccurrenceEdit) &&
    Array.isArray(command.removedOccurrenceIds) && command.removedOccurrenceIds.length <= MAX_INGREDIENT_LINES &&
    command.removedOccurrenceIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH) &&
    new Set(command.removedOccurrenceIds).size === command.removedOccurrenceIds.length &&
    (changes.yieldText === null ||
      (typeof changes.yieldText === "string" && changes.yieldText.length <= 80));
}

type SupportedPlannerOperation = PendingAuthorityOperation & {
  kind: "planner" | "bootstrap" | "undo";
};

function isSupportedPlannerOperation(operation: PendingAuthorityOperation): operation is SupportedPlannerOperation {
  return operation.kind === "planner" || operation.kind === "bootstrap" || operation.kind === "undo";
}

function pendingRetryChannel(retry: PendingAuthorityRetry): PendingRetryChannel {
  void retry;
  return "planner";
}

function pendingRetryFromOperation(
  operation: SupportedPlannerOperation,
): PendingAuthorityRetry {
  const request: unknown = JSON.parse(operation.serializedBody);
  const resolved = operation.state === "resolved_conflict";
  const message = resolved
    ? operation.resolution?.message ?? `“${operation.label}” was not accepted. Review the latest shared plan.`
    : `The response for “${operation.label}” was interrupted. Reconnect, then resolve that exact request.`;
  const shared = {
    operation,
    label: operation.label,
    tone: resolved ? "warning" as const : "error" as const,
    message,
  };
  if (operation.kind === "planner") {
    const original = request as ApplyPlannerCommandRequest;
    const editableCommand = resolved &&
        (isMealRecipeRecoveryCommand(operation.editableDraft) ||
          isHouseholdCommand(operation.editableDraft)) &&
        operation.editableDraft.type === original.command.type
      ? operation.editableDraft
      : original.command;
    return {
      ...shared,
      kind: operation.kind,
      mode: resolved ? "latest-version" : "same-envelope",
      request: { ...original, command: editableCommand },
    };
  }
  if (operation.kind === "bootstrap") {
    return { ...shared, kind: operation.kind, request: request as BootstrapWorkspaceRequest };
  }
  return { ...shared, kind: operation.kind, request: request as UndoLatestRequest };
}
type AuthorityRecoveryProps = {
  notice: Notice;
  pendingRetryLabel?: string;
  onRetryPending: () => void;
  retryDisabled: boolean;
  onDiscardPending?: () => void;
  onDismissNotice: () => void;
  offline: boolean;
  onReconnect: () => void;
};
type Mutate = (
  command: HouseholdCommand,
  options?: MutateOptions,
) => Promise<boolean>;
type SendContextMessage = (
  message: string,
  onAccepted?: () => void,
) => Promise<boolean>;

const PLANNER_ACTION_LABELS = {
  previewIngredientCandidates: "Review ingredient candidates",
  addIngredientOccurrence: "Add ingredient",
  resolveIngredientOccurrence: "Resolve ingredient",
  applyIngredientResolutionBatch: "Apply ingredient review",
  createIngredientConcept: "Create ingredient concept",
  addIngredientVocabulary: "Add ingredient vocabulary",
  renameIngredientConcept: "Rename ingredient concept",
  mergeIngredientConcepts: "Merge ingredient concepts",
  moveMeal: "Move meal",
  reorderMeals: "Reorder meals",
  swapMealDays: "Swap meal days",
  updateMealStatus: "Change meal status",
  editMealRecipe: "Save recipe details",
  replaceMealRecipeFromSource: "Replace sourced recipe",
  addInstructionStep: "Add recipe step",
  editInstructionStep: "Save recipe step",
  moveInstructionStep: "Reorder recipe step",
  removeInstructionStep: "Delete recipe step",
  setInstructionStepComplete: "Change recipe step completion",
  updateInstructionStepNote: "Save recipe step note",
  startInstructionTimer: "Start recipe timer",
  pauseInstructionTimer: "Pause recipe timer",
  resetInstructionTimer: "Reset recipe timer",
  setInstructionTimerRemaining: "Set recipe timer",
  addPrepStepsToDate: "Add prep steps to date",
  combinePrepStepsOnDate: "Combine prep steps",
  updateCombinedPrepStep: "Update combined prep batch",
  setCombinedPrepStepComplete: "Change combined prep completion",
  expandCombinedPrepStep: "Expand combined prep batch",
  movePrepStepsToDate: "Move prep steps to date",
  removePrepStepsFromDate: "Remove prep steps from date",
  clearPrepDate: "Clear prep date",
  setGroceryItemsCoverage: "Set grocery coverage",
  setGroceryItemChecked: "Change grocery item completion",
  captureFeedback: "Save dinner feedback",
  captureWeekLesson: "Save week lesson",
  captureLeftoverQuality: "Save leftover quality",
  assignLeftover: "Assign leftovers",
  consumeLeftover: "Mark leftovers consumed",
  archiveWeek: "Archive week",
  createWeekPlan: "Create week plan",
  activateWeek: "Activate week",
  handoffWeek: "Activate next week",
} satisfies Record<HouseholdCommand["type"], string>;

function plannerActionLabel(
  command: HouseholdCommand,
  state?: InitializedWorkspace["state"],
): string {
  const week = "weekId" in command
    ? state?.weeks.find((candidate) => candidate.id === command.weekId)
    : undefined;
  let target: string | undefined;
  if (week && "stepId" in command) {
    const resolved = findStep(week, command.stepId);
    if (resolved) target = stepControlTarget(resolved.meal, resolved.step, resolved.position + 1);
  } else if (week && "entryId" in command) {
    const entry = week.data.prepSessions.flatMap((session) => session.steps).find((candidate) => candidate.id === command.entryId);
    if (entry && "stepId" in entry) {
      const resolved = findStep(week, entry.stepId);
      if (resolved) target = stepControlTarget(resolved.meal, resolved.step, resolved.position + 1);
    } else if (entry && "instruction" in entry) {
      target = entry.instruction;
    }
  } else if (week && "itemId" in command) {
    const grocery = week.data.groceries.find((candidate) => candidate.id === command.itemId);
    target = grocery
      ? week.data.meals.find((meal) => meal.id === grocery.mealId)
        ?.ingredients.find((ingredient) => ingredient.id === grocery.ingredientId)?.ingredient
      : undefined;
  } else if (week && "leftoverId" in command) {
    target = week.data.leftovers.find((candidate) => candidate.id === command.leftoverId)?.label;
  } else if (week && "mealId" in command) {
    target = week.data.meals.find((candidate) => candidate.id === command.mealId)?.title;
  }
  let action: string;
  if (command.type === "setInstructionStepComplete") {
    action = command.complete ? "Mark recipe step done" : "Reopen recipe step";
  } else if (command.type === "setGroceryItemChecked") {
    action = command.checked ? "Check grocery item" : "Reopen grocery item";
  } else if (command.type === "updateMealStatus") {
    action = `Mark meal ${command.status}`;
  } else {
    action = PLANNER_ACTION_LABELS[command.type];
  }
  return target ? `${action}: ${target}` : action;
}

function isAmbiguousPostError(error: unknown): error is PlannerApiError {
  return error instanceof PlannerApiError &&
    (error.code === "NETWORK_ERROR" || error.code === "INVALID_RESPONSE");
}

function mergeIdentityRows<Row extends object>(
  canonicalRows: readonly Row[],
  baselineRows: readonly Row[],
  localRows: readonly Row[],
  identity: (row: Row) => string,
): Row[] {
  const rowsEqual = (left: Row, right: Row) => {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)] as Array<keyof Row>);
    return [...keys].every((key) => Object.is(left[key], right[key]));
  };
  const baselineIds = baselineRows.map(identity);
  if (new Set(baselineIds).size === baselineIds.length) {
    const baselineById = new Map(baselineRows.map((row) => [identity(row), row]));
    const canonicalById = new Map(canonicalRows.map((row) => [identity(row), row]));
    const localIds = new Set(localRows.map(identity));
    const merged = localRows.flatMap((localRow) => {
      const rowId = identity(localRow);
      const baselineRow = baselineById.get(rowId);
      if (!baselineRow) return [localRow];
      const canonicalRow = canonicalById.get(rowId);
      if (!canonicalRow) return [];
      const next = { ...canonicalRow };
      for (const field of Object.keys(localRow) as Array<keyof Row>) {
        if (!Object.is(localRow[field], baselineRow[field])) next[field] = localRow[field];
      }
      return [next];
    });
    for (const canonicalRow of canonicalRows) {
      const rowId = identity(canonicalRow);
      if (!baselineById.has(rowId) && !localIds.has(rowId)) merged.push(canonicalRow);
    }
    return merged;
  }
  const alignToBaseline = (rows: readonly Row[]) => {
    type Cell = { cost: number; matches: Array<number | null> };
    const table: Cell[][] = Array.from({ length: baselineRows.length + 1 }, () =>
      Array.from({ length: rows.length + 1 }, () => ({ cost: Number.POSITIVE_INFINITY, matches: [] })));
    table[0][0] = { cost: 0, matches: [] };
    for (let baselineIndex = 0; baselineIndex <= baselineRows.length; baselineIndex += 1) {
      for (let rowIndex = 0; rowIndex <= rows.length; rowIndex += 1) {
        const current = table[baselineIndex][rowIndex];
        if (!Number.isFinite(current.cost)) continue;
        if (baselineIndex < baselineRows.length) {
          const next = table[baselineIndex + 1][rowIndex];
          if (current.cost + 1 < next.cost) table[baselineIndex + 1][rowIndex] = { cost: current.cost + 1, matches: current.matches };
        }
        if (rowIndex < rows.length) {
          const next = table[baselineIndex][rowIndex + 1];
          if (current.cost + 1 < next.cost) table[baselineIndex][rowIndex + 1] = { cost: current.cost + 1, matches: [...current.matches, null] };
        }
        if (baselineIndex < baselineRows.length && rowIndex < rows.length &&
            identity(baselineRows[baselineIndex]) === identity(rows[rowIndex])) {
          const matchCost = rowsEqual(baselineRows[baselineIndex], rows[rowIndex]) ? 0 : 2;
          const next = table[baselineIndex + 1][rowIndex + 1];
          if (current.cost + matchCost <= next.cost) {
            table[baselineIndex + 1][rowIndex + 1] = {
              cost: current.cost + matchCost,
              matches: [...current.matches, baselineIndex],
            };
          }
        }
      }
    }
    return rows.map((row, index) => ({ row, baselineIndex: table[baselineRows.length][rows.length].matches[index] ?? null }));
  };
  const canonicalEntries = alignToBaseline(canonicalRows);
  const canonicalByBaseline = new Map(canonicalEntries.flatMap(({ row, baselineIndex }) =>
    baselineIndex === null ? [] : [[baselineIndex, row] as const]));
  const localEntries = alignToBaseline(localRows);
  const merged = localEntries.flatMap(({ row: localRow, baselineIndex }) => {
    if (baselineIndex === null) return [localRow];
    const baselineRow = baselineRows[baselineIndex];
    const canonicalRow = canonicalByBaseline.get(baselineIndex);
    if (!canonicalRow) return rowsEqual(localRow, baselineRow) ? [] : [localRow];
    const next = { ...canonicalRow };
    for (const field of Object.keys(localRow) as Array<keyof Row>) {
      if (!Object.is(localRow[field], baselineRow[field])) next[field] = localRow[field];
    }
    return [next];
  });
  const localAdditions = localEntries.filter(({ baselineIndex }) => baselineIndex === null).map(({ row }) => row);
  for (const { row: canonicalRow, baselineIndex } of canonicalEntries) {
    if (baselineIndex === null && !localAdditions.some((localRow) =>
      identity(localRow) === identity(canonicalRow) && rowsEqual(localRow, canonicalRow))) merged.push(canonicalRow);
  }
  const baselineIdentityCounts = new Map<string, number>();
  const canonicalIdentityCounts = new Map<string, number>();
  for (const row of baselineRows) {
    const key = identity(row);
    baselineIdentityCounts.set(key, (baselineIdentityCounts.get(key) ?? 0) + 1);
  }
  for (const row of canonicalRows) {
    const key = identity(row);
    canonicalIdentityCounts.set(key, (canonicalIdentityCounts.get(key) ?? 0) + 1);
  }
  const restoredAmbiguousGroups = new Set<string>();
  for (const localRow of localRows) {
    const key = identity(localRow);
    const identicalBaselines = baselineRows.filter((row) => identity(row) === key);
    const canonicalGroup = canonicalRows.filter((row) => identity(row) === key);
    const deletionIsAmbiguous = identicalBaselines.length > 1 &&
      identicalBaselines.every((row) => rowsEqual(row, identicalBaselines[0])) &&
      (canonicalIdentityCounts.get(key) ?? 0) < (baselineIdentityCounts.get(key) ?? 0);
    const isDistinctLocalEdit = !identicalBaselines.some((row) => rowsEqual(row, localRow));
    if (!deletionIsAmbiguous || !isDistinctLocalEdit || restoredAmbiguousGroups.has(key)) continue;
    const localGroup = localRows.filter((row) => identity(row) === key);
    const canonicalOnlyDeleted = canonicalGroup.every((row) => rowsEqual(row, identicalBaselines[0]));
    const reconciledGroup = canonicalOnlyDeleted
      ? localGroup
      : (() => {
          const unmatchedCanonical = [...canonicalGroup];
          const unmatchedLocalEdits = localGroup.filter((row) => !rowsEqual(row, identicalBaselines[0])).filter((row) => {
            const representedIndex = unmatchedCanonical.findIndex((canonicalRow) => rowsEqual(canonicalRow, row));
            if (representedIndex < 0) return true;
            unmatchedCanonical.splice(representedIndex, 1);
            return false;
          });
          return [...canonicalGroup, ...unmatchedLocalEdits];
        })();
    const firstMatchingIndex = merged.findIndex((row) => identity(row) === key);
    const retained = merged.filter((row) => identity(row) !== key);
    retained.splice(firstMatchingIndex < 0 ? retained.length : firstMatchingIndex, 0, ...reconciledGroup);
    merged.splice(0, merged.length, ...retained);
    restoredAmbiguousGroups.add(key);
  }
  return merged;
}

const ServerOffsetContext = createContext(0);
const PlannerVersionContext = createContext(0);

function useVersionedDraft<T extends object = Record<never, never>>() {
  const plannerVersion = useContext(PlannerVersionContext);
  const versionRef = useRef<number | null>(null);
  const editRevisionRef = useRef(0);
  const compositeDraftRef = useRef<CompositeDraft<T> | null>(null);
  const [compositeDraft, setCompositeDraft] = useState<CompositeDraft<T> | null>(null);
  return {
    versionRef,
    begin() {
      versionRef.current ??= plannerVersion;
      editRevisionRef.current += 1;
    },
    edit<K extends keyof T>(canonical: T, field: K, value: T[K]) {
      versionRef.current ??= plannerVersion;
      editRevisionRef.current += 1;
      const next = editCompositeDraft(compositeDraftRef.current, canonical, field, value);
      compositeDraftRef.current = next;
      setCompositeDraft(next);
    },
    compose(canonical: T, merge?: (canonical: T, draft: CompositeDraft<T>) => T): T {
      return compositeDraft && merge
        ? merge(canonical, compositeDraft)
        : composeCompositeDraft(canonical, compositeDraft);
    },
    mutationOptions(onAccepted?: () => void): MutateOptions {
      const submittedRevision = editRevisionRef.current;
      const submittedCompositeDraft = compositeDraftRef.current;
      return {
        basePlannerVersion: versionRef.current ?? plannerVersion,
        conflictStrategy: "recompose",
        onAccepted(nextPlannerVersion) {
          const settledCompositeDraft = settleCompositeDraft(
            compositeDraftRef.current,
            submittedCompositeDraft,
          );
          compositeDraftRef.current = settledCompositeDraft;
          setCompositeDraft(settledCompositeDraft);
          const hasNewerDraft = settledCompositeDraft !== null ||
            (submittedCompositeDraft === null && editRevisionRef.current !== submittedRevision);
          if (!hasNewerDraft) {
            versionRef.current = null;
            editRevisionRef.current = 0;
            onAccepted?.();
          } else {
            versionRef.current = nextPlannerVersion;
          }
        },
        onConflict(nextPlannerVersion) {
          versionRef.current = nextPlannerVersion;
        },
      };
    },
  };
}

const NAV_ITEMS: Array<{ id: PlannerView; label: string; icon: LucideIcon }> = [
  { id: "week", label: "Week", icon: CalendarDays },
  { id: "prep", label: "Prep", icon: ListChecks },
  { id: "groceries", label: "Groceries", icon: ShoppingBasket },
  { id: "closeout", label: "Close out", icon: ClipboardCheck },
];

const GROCERY_SECTIONS: GroceryItem["section"][] = [
  "Produce",
  "Meat & seafood",
  "Dairy",
  "Pantry",
];
const MAX_STEP_INPUT_TEXT_LENGTH =
  MAX_STEP_INPUTS * (MAX_STEP_INPUT_AMOUNT_LENGTH + MAX_STEP_INPUT_INGREDIENT_LENGTH + 4);
function formatCalendarDate(
  value: string,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "UTC" }).format(
    new Date(`${value}T12:00:00.000Z`),
  );
}

function weekLabel(week: WeekPlan): string {
  const end = addIsoDateDays(week.id, 6);
  return `${formatCalendarDate(week.id, { month: "short", day: "numeric" })} - ${formatCalendarDate(end, { month: "short", day: "numeric" })} · ${week.status}`;
}

function dayName(value: IsoDate, length: "long" | "short" = "long"): string {
  return formatCalendarDate(value, { weekday: length });
}

function timeLabel(value: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusTone(status: Meal["status"]): string {
  if (status === "cooked") return "tone-green";
  if (status === "cooking") return "tone-coral";
  if (status === "leftover") return "tone-blue";
  if (status === "moved") return "tone-amber";
  return "tone-slate";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The planner failed unexpectedly.";
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <small id={id} className="field-error" role="alert">{message}</small> : null;
}

function AuthorityNotice(props: {
  notice: Exclude<Notice, null>;
  pendingRetryLabel?: string;
  onRetryPending?: () => void;
  retryDisabled?: boolean;
  onDiscardPending?: () => void;
  onDismiss?: () => void;
  recoveryActionLabel?: string;
  onRecoveryAction?: () => void;
  recoveryActionDisabled?: boolean;
  className?: string;
}) {
  const {
    notice,
    pendingRetryLabel,
    onRetryPending,
    retryDisabled = false,
    onDiscardPending,
    onDismiss,
    recoveryActionLabel,
    onRecoveryAction,
    recoveryActionDisabled = false,
    className = "",
  } = props;
  return (
    <div className={`authority-banner ${notice.tone} ${className}`.trim()} role={notice.tone === "error" ? "alert" : "status"}>
      <span>{notice.message}</span>
      <div className="authority-banner-actions">
        {pendingRetryLabel && onRetryPending ? (
          <PlannerActionButton tone="secondary" type="button" aria-label={`Retry ${pendingRetryLabel}`} disabled={retryDisabled} onClick={onRetryPending}>
            <RotateCcw size={14} /> Retry action
          </PlannerActionButton>
        ) : null}
        {pendingRetryLabel && onDiscardPending ? (
          <PlannerActionButton tone="quiet" type="button" onClick={onDiscardPending}>Discard retry</PlannerActionButton>
        ) : null}
        {!pendingRetryLabel && recoveryActionLabel && onRecoveryAction ? (
          <PlannerActionButton tone="secondary" type="button" disabled={recoveryActionDisabled} onClick={onRecoveryAction}>
            <RotateCcw size={14} /> {recoveryActionLabel}
          </PlannerActionButton>
        ) : null}
        {!pendingRetryLabel && onDismiss ? (
          <PlannerIconButton type="button" title="Dismiss" onClick={onDismiss}><X size={16} /></PlannerIconButton>
        ) : null}
      </div>
    </div>
  );
}

type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  ariaLabel?: string;
};

function SegmentedControl<T extends string>({
  ariaLabel,
  className = "",
  disabled = false,
  onChange,
  options,
  value,
}: {
  ariaLabel: string;
  className?: string;
  disabled?: boolean | ((option: T) => boolean);
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  value: T | undefined;
}) {
  return (
    <ToggleGroup
      className={`segmented-control ${className}`.trim()}
      type="single"
      value={value}
      onValueChange={(nextValue) => {
        if (nextValue) onChange(nextValue as T);
      }}
      aria-label={ariaLabel}
      variant="outline"
      size="sm"
      spacing={0}
    >
      {options.map((option) => {
        const optionDisabled = typeof disabled === "function" ? disabled(option.value) : disabled;
        return (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            aria-label={option.ariaLabel}
            disabled={optionDisabled}
          >{option.label}</ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}

function findStep(
  week: WeekPlan,
  stepId: string,
): { step: InstructionStep; meal: Meal; position: number } | null {
  for (const meal of week.data.meals) {
    const position = meal.instructions.findIndex((step) => step.id === stepId);
    if (position >= 0) return { step: meal.instructions[position], meal, position };
  }
  return null;
}

function stepControlTarget(meal: Meal, step: InstructionStep, stepNumber: number): string {
  const instruction = step.instruction.length > 90
    ? `${step.instruction.slice(0, 87)}…`
    : step.instruction;
  return `step ${stepNumber} for ${meal.title}: ${instruction}`;
}

function progressForWeek(week: WeekPlan): { complete: number; total: number } {
  const steps = week.data.meals.flatMap((meal) => meal.instructions);
  return { complete: steps.filter((step) => step.complete).length, total: steps.length };
}

function useMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 840px)");
    const update = () => setMobile(window.innerWidth <= 840);
    update();
    media.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return mobile;
}

function BootstrapScreen(props: {
  candidate: LegacyImportCandidate;
  busy: boolean;
  notice: Notice;
  onImport: () => void;
  onFresh: () => void;
  onRetry: () => void;
  pendingRetryLabel?: string;
  onRetryPending?: () => void;
  onDiscardPending?: () => void;
  onClearLocalRecovery?: () => void;
  localRecoveryBusy?: boolean;
}) {
  const {
    candidate,
    busy,
    notice,
    onFresh,
    onImport,
    onRetry,
    pendingRetryLabel,
    onRetryPending,
    onDiscardPending,
    onClearLocalRecovery,
    localRecoveryBusy = false,
  } = props;
  return (
    <main className="bootstrap-shell">
      <section className="bootstrap-panel" aria-labelledby="bootstrap-title">
        <span className="brand-mark" aria-hidden="true"><Utensils size={21} /></span>
        <p className="eyebrow">Shared household planner</p>
        <h1 id="bootstrap-title">Set up this planner once</h1>
        <p>
          Choose the browser plan already on this device or begin with a fresh shared plan.
          Nothing is imported automatically.
        </p>
        {candidate.error ? <p className="inline-alert error" role="alert">{candidate.error}</p> : null}
        {notice ? <p className={`inline-alert ${notice.tone}`} role="status">{notice.message}</p> : null}
        <div className="bootstrap-actions">
          <PlannerActionButton
            tone="primary"
            type="button"
            disabled={busy || candidate.payload === null}
            onClick={onImport}
          >
            {busy ? <LoaderCircle className="spin" size={17} /> : <PackageCheck size={17} />}
            Import browser planner
          </PlannerActionButton>
          <PlannerActionButton tone="secondary" type="button" disabled={busy} onClick={onFresh}>
            <Plus size={17} /> Start Fresh
          </PlannerActionButton>
        </div>
        {pendingRetryLabel && onRetryPending ? (
          <div className="bootstrap-recovery-actions">
            <PlannerActionButton tone="quiet" type="button" disabled={busy} onClick={onRetryPending}>
              Retry {pendingRetryLabel.toLowerCase()}
            </PlannerActionButton>
            {onDiscardPending ? (
              <PlannerActionButton tone="quiet" type="button" disabled={busy} onClick={onDiscardPending}>
                Discard retry
              </PlannerActionButton>
            ) : null}
          </div>
        ) : onClearLocalRecovery ? (
          <PlannerActionButton tone="quiet" type="button" disabled={localRecoveryBusy} onClick={onClearLocalRecovery}>
            Review latest plan and clear local recovery
          </PlannerActionButton>
        ) : notice?.tone === "error" ? (
          <PlannerActionButton tone="quiet" type="button" onClick={onRetry}>Retry connection</PlannerActionButton>
        ) : null}
        <small>{LEGACY_V2_STORAGE_KEY}</small>
      </section>
    </main>
  );
}

function InitialLoading({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <main className="bootstrap-shell">
      <section className="bootstrap-panel compact" aria-live="polite">
        {error ? <Circle size={25} /> : <LoaderCircle className="spin" size={25} />}
        <h1>{error ? "Planner unavailable" : "Opening the shared planner"}</h1>
        <p>{error ?? "Reading the latest household workspace."}</p>
        {error ? <PlannerActionButton tone="primary" type="button" onClick={onRetry}>Retry</PlannerActionButton> : null}
      </section>
    </main>
  );
}

const plannerRootRoute = createRootRoute({ component: PlannerAppContent });
const plannerIndexRoute = createRoute({ getParentRoute: () => plannerRootRoute, path: "/" });
const plannerWeekRoute = createRoute({ getParentRoute: () => plannerRootRoute, path: "/weeks/$weekId" });
const plannerRecipeRoute = createRoute({ getParentRoute: () => plannerRootRoute, path: "/weeks/$weekId/recipes/$mealId" });
const plannerLegacyDayRoute = createRoute({ getParentRoute: () => plannerRootRoute, path: "/weeks/$weekId/day/$date" });
function createPlannerRouter() {
  return createRouter({
    routeTree: plannerRootRoute.addChildren([plannerIndexRoute, plannerWeekRoute, plannerRecipeRoute, plannerLegacyDayRoute]),
    basepath: import.meta.env?.BASE_URL === "/" ? undefined : import.meta.env?.BASE_URL?.replace(/\/$/u, ""),
  });
}

export default function PlannerApp() {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: "always",
      },
    },
  }));
  const [mounted, setMounted] = useState(false);
  // Vinext renders this client surface on the server; Router needs browser history.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);
  if (!mounted) return <InitialLoading error={null} onRetry={() => {}} />;
  return <QueryClientProvider client={queryClient}><PlannerRouterMount /></QueryClientProvider>;
}

function PlannerRouterMount() {
  const [router] = useState(createPlannerRouter);
  return <RouterProvider router={router} />;
}

function PlannerAppContent() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const routerNavigate = useNavigate();
  const location = useMemo(() => parsePlannerLocation(pathname), [pathname]);
  const selectedWeekId = location.kind === "week" || location.kind === "recipe" || location.kind === "legacy-day"
    ? location.weekId
    : null;
  const queryClient = useQueryClient();
  const [connection, setConnection] = useState<ConnectionState>("loading");
  const [initialError, setInitialError] = useState<string | null>(null);
  const [serverOffset, setServerOffset] = useState(0);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [view, setView] = useState<PlannerView>("week");
  const [recipeSummaryMealId, setRecipeSummaryMealId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [timersOpen, setTimersOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [codexCollapsed, setCodexCollapsed] = useState(true);
  const [codexDraft, setCodexDraft] = useState("");
  const [codexFocusKey, setCodexFocusKey] = useState(0);
  const [plannerPending, setPlannerPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [routeNotice, setRouteNotice] = useState<string | null>(null);
  const [pendingRetries, setPendingRetries] = useState<PendingAuthorityRetry[]>([]);
  const [journalError, setJournalError] = useState<string | null>(null);
  const [journalRecoveryPending, setJournalRecoveryPending] = useState(false);
  const [legacyCandidate, setLegacyCandidate] = useState<LegacyImportCandidate>({
    present: false,
    payload: null,
    error: null,
  });
  const mobile = useMobile();
  const etagRef = useRef<string | null>(null);
  const browserOfflineRef = useRef(false);
  const serverOffsetRef = useRef(0);
  const workspaceRef = useRef<WorkspaceResponse | null>(null);
  const plannerMutationInFlight = useRef(false);
  const pendingRetryRef = useRef<PendingAuthorityRetry[]>([]);
  const pendingRetryVolatileRef = useRef(new Map<string, PendingRetryVolatile>());
  const appContentRef = useRef<HTMLDivElement>(null);
  const chatTriggerRef = useRef<HTMLButtonElement>(null);
  const historyTriggerRef = useRef<HTMLButtonElement>(null);
  const mealTriggerRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const primaryWorkspaceRef = useRef<HTMLElement>(null);

  const workspaceQuery = useQuery({
    queryKey: WORKSPACE_QUERY_KEY,
    queryFn: async (): Promise<WorkspaceQueryData> => {
      try {
        const result = await readWorkspace({ etag: etagRef.current });
        if (result.etag) etagRef.current = result.etag;
        if (result.serverDate !== null) {
          const offset = result.serverDate - Date.now();
          serverOffsetRef.current = offset;
          setServerOffset(offset);
        }
        const current = queryClient.getQueryData<WorkspaceQueryData>(WORKSPACE_QUERY_KEY);
        const data = result.kind === "workspace"
          ? {
              workspace: !current || shouldAcceptWorkspace(current.workspace, result.workspace)
                ? result.workspace
                : current.workspace,
              serverDate: result.serverDate,
            }
          : current
            ? { ...current, serverDate: result.serverDate ?? current.serverDate }
            : null;
        if (!data) throw new Error("The planner returned no initial workspace.");
        if (!browserOfflineRef.current) setConnection("online");
        setInitialError(null);
        return data;
      } catch (error) {
        if (!isAbortError(error)) {
          setConnection("offline");
          if (!workspaceRef.current) setInitialError(errorMessage(error));
        }
        throw error;
      }
    },
    refetchInterval: 2_000,
    refetchIntervalInBackground: false,
  });
  const workspace = workspaceQuery.data?.workspace ?? null;

  const syncPendingRetries = useCallback(() => {
    try {
      const operations = readAuthorityOperations()
        .filter(isSupportedPlannerOperation)
        .filter((operation) => !(operation.state === "prepared" && plannerMutationInFlight.current))
        .sort((left, right) => left.createdAt - right.createdAt);
      const liveKeys = new Set(operations.map(operationKey));
      for (const key of pendingRetryVolatileRef.current.keys()) {
        if (!liveKeys.has(key)) pendingRetryVolatileRef.current.delete(key);
      }
      const retries = operations.map((operation) => {
        const retry = pendingRetryFromOperation(operation);
        const volatile = pendingRetryVolatileRef.current.get(operationKey(operation));
        if (retry.kind === "planner" && volatile?.options) {
          return { ...retry, options: volatile.options };
        }
        return retry;
      });
      pendingRetryRef.current = retries;
      setPendingRetries(retries);
      setJournalError(null);
      const pendingMeal = retries.find((retry) =>
        retry.kind === "planner" && retry.request.command.type === "editMealRecipe"
      );
      if (pendingMeal?.kind === "planner" && pendingMeal.request.command.type === "editMealRecipe") {
        void routerNavigate({ to: recipePath(pendingMeal.request.command.weekId, pendingMeal.request.command.mealId) });
      }
    } catch (error) {
      const message = errorMessage(error);
      pendingRetryRef.current = [];
      setPendingRetries([]);
      setJournalError(message);
      setNotice({ tone: "error", message });
    }
  }, [routerNavigate]);

  const setPendingRetry = useCallback((retry: unknown) => {
    if (retry !== null && typeof retry === "object" && "kind" in retry && "request" in retry) {
      const candidate = retry as {
        kind?: unknown;
        request?: { requestId?: unknown };
        options?: MutateOptions;
      };
      if (
        typeof candidate.kind === "string" &&
        typeof candidate.request?.requestId === "string"
      ) {
        pendingRetryVolatileRef.current.set(
          `${candidate.kind}:${candidate.request.requestId}`,
          {
            ...(candidate.options ? { options: candidate.options } : {}),
          },
        );
      }
    }
    syncPendingRetries();
  }, [syncPendingRetries]);

  const clearPendingRetry = useCallback((channel: PendingRetryChannel) => {
    void channel;
    syncPendingRetries();
  }, [syncPendingRetries]);

  const updatePlannerRecoveryDraft = useCallback((command: HouseholdCommand) => {
    const pending = pendingRetryRef.current.find((retry) =>
      pendingRetryChannel(retry) === "planner" &&
      retry.operation.state !== "prepared" &&
      retry.kind === "planner"
    );
    if (!pending || pending.kind !== "planner") return;
    if (pending.request.command.type !== command.type) return;
    try {
      updateAuthorityOperationDraft(pending.operation, command);
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    }
  }, []);

  const blockForPendingRetry = useCallback((channel: PendingRetryChannel) => {
    if (journalError) {
      setNotice({ tone: "error", message: journalError });
      return true;
    }
    const pending = pendingRetryRef.current.find((retry) => pendingRetryChannel(retry) === channel);
    if (!pending) return false;
    setNotice({
      tone: "warning",
      message: `Resolve “${pending.label}” before starting another shared change.`,
    });
    return true;
  }, [journalError]);

  const plannerRetry = pendingRetries.find((retry) => pendingRetryChannel(retry) === "planner") ?? null;
  const pendingRetry = plannerRetry;
  const recipeSummaryMealAvailable = Boolean(
    recipeSummaryMealId &&
    workspace?.initialized &&
    (
      workspace.state.weeks.find((item) => item.id === selectedWeekId) ??
      workspace.state.weeks.at(-1)
    )?.data.meals.some((meal) => meal.id === recipeSummaryMealId),
  );
  const activeOverlay = recipeSummaryMealAvailable
    ? "recipe-summary"
    : historyOpen && workspace?.initialized
      ? "history"
      : mobile && chatOpen && workspace?.initialized
        ? "chat"
        : null;

  useEffect(() => {
    const initialSync = window.setTimeout(syncPendingRetries, 0);
    window.addEventListener(AUTHORITY_OPERATION_JOURNAL_EVENT, syncPendingRetries);
    return () => {
      window.clearTimeout(initialSync);
      window.removeEventListener(AUTHORITY_OPERATION_JOURNAL_EVENT, syncPendingRetries);
    };
  }, [syncPendingRetries]);

  const navigate = useCallback((nextView: PlannerView) => {
    setView(nextView);
    setTimersOpen(false);
    primaryWorkspaceRef.current?.scrollTo({ top: 0, behavior: "auto" });
    window.scrollTo({ top: 0, behavior: "auto" });
    window.requestAnimationFrame(() => headingRef.current?.focus());
  }, []);

  const openRecipe = useCallback((weekId: WeekId, mealId: string, trigger?: HTMLElement) => {
    if (trigger) mealTriggerRef.current = trigger;
    setRouteNotice(null);
    setHistoryOpen(false);
    setTimersOpen(false);
    setChatOpen(false);
    setRecipeSummaryMealId(null);
    void routerNavigate({ to: recipePath(weekId, mealId) });
  }, [routerNavigate]);

  const acceptWorkspace = useCallback((incoming: WorkspaceResponse) => {
    const current = workspaceRef.current;
    if (!shouldAcceptWorkspace(current, incoming)) return;
    workspaceRef.current = incoming;
    queryClient.setQueryData<WorkspaceQueryData>(WORKSPACE_QUERY_KEY, (cached) => ({
      workspace: incoming,
      serverDate: cached?.serverDate ?? null,
    }));
  }, [queryClient]);

  const refresh = useCallback(async (force = false): Promise<boolean> => {
    // A Codex planner.apply has already changed shared state. Drop the
    // conditional-read validator so its following read is authoritative even
    // when the browser's local revision is otherwise still current.
    if (force) {
      browserOfflineRef.current = false;
      etagRef.current = null;
    }
    try {
      await queryClient.invalidateQueries(
        { queryKey: WORKSPACE_QUERY_KEY, refetchType: "active" },
        { throwOnError: true },
      );
      return true;
    } catch (error) {
      if (isAbortError(error)) return false;
      setConnection("offline");
      if (!workspaceRef.current) setInitialError(errorMessage(error));
      return false;
    }
  }, [queryClient]);

  useEffect(() => {
    const markOffline = () => {
      browserOfflineRef.current = true;
      setConnection("offline");
      void refresh(false);
    };
    window.addEventListener("offline", markOffline);
    return () => {
      window.removeEventListener("offline", markOffline);
    };
  }, [refresh]);

  useEffect(() => {
    if (!workspaceQuery.data) return;
    workspaceRef.current = workspaceQuery.data.workspace;
  }, [workspaceQuery.data]);

  useEffect(() => {
    if (!workspace?.initialized || connection !== "online") return;
    const today = isoDateForTimeZone(Date.now() + serverOffsetRef.current, workspace.state.householdTimeZone);
    const authoritativeDefaultWeekId = workspace.state.activeWeekId ??
      workspace.state.weeks.find((week) => weekContainsDate(week.id, today))?.id ??
      workspace.state.weeks.at(-1)?.id ?? null;
    const fallbackWeekId = resolveRememberedWeekId(
      workspace.state.weeks,
      window.localStorage.getItem(LAST_VALID_WEEK_STORAGE_KEY),
      authoritativeDefaultWeekId,
    );
    const resolved = resolvePlannerLocation(location, workspace.state.weeks, fallbackWeekId);
    if (resolved.week) window.localStorage.setItem(LAST_VALID_WEEK_STORAGE_KEY, resolved.week.id);
    if (location.kind === "root" && resolved.week) {
      void routerNavigate({ to: weekPath(resolved.week.id), replace: true });
      return;
    }
    if (location.kind === "legacy-day" && resolved.kind === "week") {
      const frame = window.requestAnimationFrame(() => {
        void routerNavigate({ to: weekPath(resolved.week.id), replace: true });
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (resolved.kind === "unavailable") {
      setRouteNotice(resolved.message);
      if (resolved.week) void routerNavigate({ to: weekPath(resolved.week.id), replace: true });
      return;
    }
  }, [connection, location, routerNavigate, workspace]);

  const clearLocalRecoveryAfterReadback = useCallback(async () => {
    if (!journalError || journalRecoveryPending) return;
    setJournalRecoveryPending(true);
    try {
      const readbackSucceeded = await refresh(true);
      const authoritativeWorkspace = workspaceRef.current;
      if (!readbackSucceeded || !authoritativeWorkspace) {
        setNotice({
          tone: "error",
          message: "The latest shared plan could not be read. Local recovery data was kept.",
        });
        return;
      }
      clearAuthorityOperationJournalAfterReadback(authoritativeWorkspace.schemaVersion);
      syncPendingRetries();
      setNotice({
        tone: "info",
        message: "Latest shared plan reviewed. Damaged local recovery data was cleared.",
      });
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      setJournalRecoveryPending(false);
    }
  }, [journalError, journalRecoveryPending, refresh, syncPendingRetries]);

  useEffect(() => {
    const timer = window.setTimeout(() => setLegacyCandidate(readLegacyImport(window.localStorage)), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setClockNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const element = appContentRef.current as (HTMLDivElement & { inert: boolean }) | null;
    if (!element) return;
    element.inert = activeOverlay !== null;
    return () => {
      element.inert = false;
    };
  }, [activeOverlay]);

  const openMeal = useCallback((mealId: string, trigger: HTMLElement) => {
    const week = workspaceRef.current?.initialized
      ? workspaceRef.current.state.weeks.find((candidate) => candidate.id === selectedWeekId) ?? null
      : null;
    if (week) openRecipe(week.id, mealId, trigger);
  }, [openRecipe, selectedWeekId]);

  const openRecipeSummary = useCallback((mealId: string, trigger: HTMLElement) => {
    const week = workspaceRef.current?.initialized
      ? workspaceRef.current.state.weeks.find((candidate) => candidate.id === selectedWeekId) ?? null
      : null;
    if (week) openRecipe(week.id, mealId, trigger);
  }, [openRecipe, selectedWeekId]);

  const executeBootstrap = useCallback(async (request: BootstrapWorkspaceRequest) => {
    if (plannerMutationInFlight.current) return;
    plannerMutationInFlight.current = true;
    setPlannerPending(true);
    setNotice(null);
    try {
      const result = await bootstrapWorkspace(request, {
        label: "Set up shared planner",
        submittedDraft: request,
      });
      acceptWorkspace(result.workspace);
      clearPendingRetry("planner");
      // Browser data is removed only after the server has durably accepted bootstrap.
      window.localStorage.removeItem(LEGACY_V2_STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_V1_STORAGE_KEY);
      setLegacyCandidate({ present: false, payload: null, error: null });
      setNotice({ tone: "info", message: result.imported ? "Browser plan imported." : "Shared planner created." });
      await refresh(true);
    } catch (error) {
      if (error instanceof PlannerApiError && error.workspace) acceptWorkspace(error.workspace);
      if (error instanceof PlannerApiError && error.code === "ALREADY_INITIALIZED") {
        clearPendingRetry("planner");
        setNotice({
          tone: "warning",
          message: "Another device initialized the planner first. Browser data was kept.",
        });
        await refresh(true);
      } else if (isAmbiguousPostError(error)) {
        setPendingRetry({
          kind: "bootstrap",
          label: "Set up shared planner",
          tone: "error",
          message: "The setup response was interrupted. Reconnect, then retry the same setup request.",
          request,
        });
        if (error.code === "NETWORK_ERROR") setConnection("offline");
        setNotice({
          tone: "error",
          message: "The setup response was interrupted. Reconnect, then retry the same setup request.",
        });
      } else {
        clearPendingRetry("planner");
        setNotice({ tone: "error", message: errorMessage(error) });
      }
    } finally {
      plannerMutationInFlight.current = false;
      setPlannerPending(false);
    }
  }, [acceptWorkspace, clearPendingRetry, refresh, setPendingRetry]);

  const bootstrap = useCallback(async (mode: "seed" | "import-v2") => {
    if (blockForPendingRetry("planner") || plannerMutationInFlight.current) return;
    const importPayload = legacyCandidate.payload;
    if (mode === "import-v2" && !importPayload) return;
    const request: BootstrapWorkspaceRequest = mode === "seed"
      ? { requestId: createRequestId(), mode: "seed" }
      : { requestId: createRequestId(), mode: "import-v2", payload: importPayload! };
    await executeBootstrap(request);
  }, [blockForPendingRetry, executeBootstrap, legacyCandidate.payload]);

  const executePlannerMutation = useCallback(async (
    request: ApplyPlannerCommandRequest,
    options?: MutateOptions,
  ): Promise<boolean> => {
    if (plannerMutationInFlight.current) return false;
    const current = workspaceRef.current;
    const actionLabel = plannerActionLabel(
      request.command,
      current?.initialized ? current.state : undefined,
    );
    plannerMutationInFlight.current = true;
    setPlannerPending(true);
    setNotice(null);
    try {
      const result = await applyPlannerCommand(request, {
        label: actionLabel,
        submittedDraft: request.command,
      });
      acceptWorkspace(result.workspace);
      if (result.decision.status === "accepted") {
        clearPendingRetry("planner");
        options?.onAccepted?.(result.workspace.plannerVersion);
        await refresh(true);
        return true;
      }
      if (result.decision.status === "version_conflict") {
        options?.onConflict?.(result.workspace.plannerVersion);
        if (options?.conflictStrategy === "recompose") {
          const resolvedOperation = readAuthorityOperations().find((operation) =>
            operation.kind === "planner" &&
            operation.requestId === request.requestId &&
            operation.state === "resolved_conflict"
          );
          if (resolvedOperation) discardAuthorityOperation(resolvedOperation);
          clearPendingRetry("planner");
          setNotice({
            tone: "warning",
            message: `Someone else changed the plan. “${actionLabel}” was not saved. Your draft was kept and refreshed with their changes; review it, then save again.`,
          });
        } else {
          setPendingRetry({
            kind: "planner",
            label: actionLabel,
            tone: "warning",
            message: `Someone else changed the plan. “${actionLabel}” was not saved. Review the latest plan, then retry it.`,
            mode: "latest-version",
            request,
            options,
          });
          setNotice({
            tone: "warning",
            message: `Someone else changed the plan. “${actionLabel}” was not saved. Review the latest plan, then retry it.`,
          });
        }
      } else {
        clearPendingRetry("planner");
        setNotice({ tone: "error", message: result.decision.message });
      }
      return false;
    } catch (error) {
      if (error instanceof PlannerApiError && error.workspace) acceptWorkspace(error.workspace);
      if (isAmbiguousPostError(error)) {
        setPendingRetry({
          kind: "planner",
          label: actionLabel,
          tone: "error",
          message: `The response for “${actionLabel}” was interrupted. Reconnect, then resolve that exact request.`,
          mode: "same-envelope",
          request,
          options,
        });
        if (error.code === "NETWORK_ERROR") setConnection("offline");
        setNotice({
          tone: "error",
          message: `The response for “${actionLabel}” was interrupted. Reconnect, then resolve that exact request.`,
        });
      } else {
        clearPendingRetry("planner");
        setNotice({ tone: "error", message: errorMessage(error) });
      }
      return false;
    } finally {
      plannerMutationInFlight.current = false;
      setPlannerPending(false);
    }
  }, [acceptWorkspace, clearPendingRetry, refresh, setPendingRetry]);

  const mutate: Mutate = useCallback(async (command, options) => {
    const current = workspaceRef.current;
    if (
      !current?.initialized ||
      plannerMutationInFlight.current ||
      connection !== "online" ||
      blockForPendingRetry("planner")
    ) return false;
    const visiblePlannerVersion = workspace?.initialized
      ? workspace.plannerVersion
      : current.plannerVersion;
    const commandWeekId = "weekId" in command ? command.weekId : null;
    const commandWeek = commandWeekId
      ? current.state.weeks.find((week) => week.id === commandWeekId)
      : null;
    if (commandWeek?.status === "archived") {
      setNotice({ tone: "warning", message: "Archived weeks are read-only." });
      return false;
    }
    return executePlannerMutation({
      requestId: createRequestId(),
      basePlannerVersion: options?.basePlannerVersion ?? visiblePlannerVersion,
      command,
    }, options);
  }, [blockForPendingRetry, connection, executePlannerMutation, workspace]);

  const sendContextMessage: SendContextMessage = useCallback(async (
    message,
    onAccepted,
  ) => {
    const next = message.trim();
    if (!next) return false;
    setCodexDraft((current) => current.trim() ? `${current.trim()}\n\n${next}` : next);
    setCodexCollapsed(false);
    if (mobile) setChatOpen(true);
    setCodexFocusKey((current) => current + 1);
    onAccepted?.();
    return true;
  }, [mobile]);

  const executeUndo = useCallback(async (request: UndoLatestRequest) => {
    if (plannerMutationInFlight.current) return;
    plannerMutationInFlight.current = true;
    setPlannerPending(true);
    setNotice(null);
    try {
      const result = await undoLatest(request, {
        label: "Undo latest change",
        submittedDraft: request,
      });
      acceptWorkspace(result.workspace);
      clearPendingRetry("planner");
      if (result.decision.status === "accepted") {
        setHistoryOpen(false);
        await refresh(true);
      } else {
        setNotice({
          tone: result.decision.status === "version_conflict" ? "warning" : "error",
          message:
            result.decision.status === "domain_rejected"
              ? result.decision.message
              : "The workspace changed before undo. The latest plan is shown.",
        });
      }
    } catch (error) {
      if (error instanceof PlannerApiError && error.workspace) acceptWorkspace(error.workspace);
      if (isAmbiguousPostError(error)) {
        setPendingRetry({
          kind: "undo",
          label: "Undo latest change",
          tone: "error",
          message: "The undo response was interrupted. Reconnect, then resolve that exact request.",
          request,
        });
        if (error.code === "NETWORK_ERROR") setConnection("offline");
        setNotice({ tone: "error", message: "The undo response was interrupted. Reconnect, then resolve that exact request." });
      } else {
        clearPendingRetry("planner");
        setNotice({ tone: "error", message: errorMessage(error) });
      }
    } finally {
      plannerMutationInFlight.current = false;
      setPlannerPending(false);
    }
  }, [acceptWorkspace, clearPendingRetry, refresh, setPendingRetry]);

  const runUndo = useCallback(async (event: PlannerEvent) => {
    const current = workspaceRef.current;
    if (
      !current?.initialized ||
      plannerMutationInFlight.current ||
      connection !== "online" ||
      blockForPendingRetry("planner")
    ) return;
    await executeUndo({
      requestId: createRequestId(),
      basePlannerVersion: current.plannerVersion,
      targetEventId: event.eventId,
    });
  }, [blockForPendingRetry, connection, executeUndo]);

  const retryPendingOperation = useCallback(async (channel?: PendingRetryChannel) => {
    const pending = channel
      ? pendingRetryRef.current.find((retry) => pendingRetryChannel(retry) === channel)
      : pendingRetryRef.current[0];
    if (!pending) return;
    if (pending.kind !== "bootstrap" && connection !== "online") return;
    const current = workspaceRef.current;
    const resolved = pending.operation.state === "resolved_conflict";
    if (pending.kind === "planner") {
      const request = resolved
        ? {
            ...pending.request,
            requestId: createRequestId(),
            basePlannerVersion: current?.initialized
              ? current.plannerVersion
              : pending.request.basePlannerVersion,
          }
        : pending.request;
      if (resolved) {
        replaceResolvedAuthorityOperation(pending.operation, {
          kind: "planner",
          path: pending.operation.path,
          body: request,
          label: pending.label,
          submittedDraft: request.command,
        });
      }
      await executePlannerMutation(request, pending.options);
      return;
    }
    if (pending.kind === "bootstrap") {
      const request = resolved
        ? { ...pending.request, requestId: createRequestId() }
        : pending.request;
      if (resolved) {
        replaceResolvedAuthorityOperation(pending.operation, {
          kind: "bootstrap",
          path: pending.operation.path,
          body: request,
          label: pending.label,
          submittedDraft: request,
        });
      }
      await executeBootstrap(request);
      return;
    }
    const request = resolved
      ? {
          ...pending.request,
          requestId: createRequestId(),
          basePlannerVersion: current?.initialized
            ? current.plannerVersion
            : pending.request.basePlannerVersion,
        }
      : pending.request;
    if (resolved) {
      replaceResolvedAuthorityOperation(pending.operation, {
        kind: "undo",
        path: pending.operation.path,
        body: request,
        label: pending.label,
        submittedDraft: request,
      });
    }
    await executeUndo(request);
  }, [connection, executeBootstrap, executePlannerMutation, executeUndo]);

  const discardPendingOperation = useCallback((channel?: PendingRetryChannel) => {
    const pending = channel
      ? pendingRetryRef.current.find((retry) => pendingRetryChannel(retry) === channel)
      : pendingRetryRef.current[0];
    if (!pending || pending.operation.state !== "resolved_conflict") return;
    try {
      discardAuthorityOperation(pending.operation);
      syncPendingRetries();
      setNotice(null);
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    }
  }, [syncPendingRetries]);

  if (!workspace) return <InitialLoading error={initialError} onRetry={() => void refresh(true)} />;
  if (!workspace.initialized) {
    return (
      <BootstrapScreen
        candidate={legacyCandidate}
        busy={plannerPending}
        notice={notice}
        onImport={() => void bootstrap("import-v2")}
        onFresh={() => void bootstrap("seed")}
        onRetry={() => void refresh(true)}
        pendingRetryLabel={plannerRetry?.kind === "bootstrap" ? plannerRetry.label : undefined}
        onRetryPending={() => void retryPendingOperation("planner")}
        onDiscardPending={plannerRetry?.kind === "bootstrap" && plannerRetry.operation.state === "resolved_conflict"
          ? () => discardPendingOperation("planner")
          : undefined}
        onClearLocalRecovery={journalError ? () => void clearLocalRecoveryAfterReadback() : undefined}
        localRecoveryBusy={journalRecoveryPending}
      />
    );
  }

  const initialized = workspace;
  const defaultWeekId = initialized.state.activeWeekId ?? initialized.state.weeks.at(-1)?.id ?? null;
  const resolvedLocation = resolvePlannerLocation(location, initialized.state.weeks, defaultWeekId);
  const week = resolvedLocation.week;
  const now = clockNow + serverOffset;
  const today = isoDateForTimeZone(now, initialized.state.householdTimeZone);
  const activeTimers = week?.data.meals.flatMap((meal) =>
    meal.instructions
      .filter((step) => step.timerDurationSeconds !== undefined && step.timerStartedAt !== undefined)
      .map((step) => ({ meal, step })),
  ) ?? [];
  const selectedMeal = resolvedLocation.kind === "recipe"
    ? resolvedLocation.week.data.meals.find((meal) => meal.id === resolvedLocation.mealId) ?? null
    : null;
  const recipeSummaryMeal = week?.data.meals.find((meal) => meal.id === recipeSummaryMealId) ?? null;
  const recoveryDraftCommand = plannerRetry?.kind === "planner" &&
      (isMealRecipeRecoveryCommand(plannerRetry.operation.editableDraft) ||
        isHouseholdCommand(plannerRetry.operation.editableDraft))
    ? plannerRetry.operation.editableDraft
    : plannerRetry?.kind === "planner"
      ? plannerRetry.request.command
      : null;
  const recoveryMealCommand = recoveryDraftCommand?.type === "editMealRecipe" &&
      selectedMeal && week &&
      recoveryDraftCommand.weekId === week.id &&
      recoveryDraftCommand.mealId === selectedMeal.id
    ? recoveryDraftCommand
    : null;
  const isReadOnly = connection !== "online" || plannerPending || Boolean(plannerRetry) || week?.status === "archived";
  const progress = week ? progressForWeek(week) : { complete: 0, total: 0 };
  const heading = resolvedLocation.kind === "recipe" ? "Recipe" : view === "closeout" ? "Close out" : `${view[0].toUpperCase()}${view.slice(1)}`;
  const authorityNotice: Notice = pendingRetry
    ? { tone: pendingRetry.tone, message: pendingRetry.message }
    : routeNotice
      ? { tone: "warning", message: routeNotice }
      : notice;
  const plannerAuthorityRecovery: AuthorityRecoveryProps = {
    notice: plannerRetry ? { tone: plannerRetry.tone, message: plannerRetry.message } : notice,
    pendingRetryLabel: plannerRetry?.label,
    onRetryPending: () => void retryPendingOperation("planner"),
    retryDisabled: connection !== "online" || plannerPending,
    onDiscardPending: plannerRetry?.operation.state === "resolved_conflict"
      ? () => discardPendingOperation("planner")
      : undefined,
    onDismissNotice: () => setNotice(null),
    offline: connection === "offline",
    onReconnect: () => void refresh(true),
  };
  return (
    <PlannerVersionContext.Provider value={initialized.plannerVersion}>
      <ServerOffsetContext.Provider value={serverOffset}>
      <div className="app-shell max-[700px]:!h-dvh max-[700px]:!overflow-hidden">
      <div ref={appContentRef}>
        <header className="app-header">
          <div className="brand-block">
            <span className="brand-mark" aria-hidden="true"><Utensils size={21} /></span>
            <div>
              <p className="brand-name">Family dinner planner</p>
              <p className={`sync-note ${connection === "offline" ? "failed" : ""}`}>
                <span className="sync-dot" />
                {connection === "offline" ? "Offline · read-only" : plannerPending ? "Saving shared change…" : "Shared plan current"}
              </p>
            </div>
          </div>
          <div className="week-control">
            <label className="week-select">
              <span className="sr-only">Selected week</span>
              <select
                value={week?.id ?? ""}
                onChange={(event) => {
                  setRouteNotice(null);
                  void routerNavigate({ to: weekPath(event.target.value as WeekId) });
                }}
              >
                {initialized.state.weeks.map((item) => (
                  <option key={item.id} value={item.id}>{weekLabel(item)}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="header-actions">
            <PlannerIconButton ref={historyTriggerRef} type="button" title="Change history" aria-pressed={historyOpen} onClick={() => {
              setChatOpen(false);
              setTimersOpen(false);
              setHistoryOpen(true);
            }}>
              <List size={19} />
            </PlannerIconButton>
            <div className="header-timer-control">
              <PlannerIconButton
                type="button"
                title={activeTimers.length ? `${activeTimers.length} active timer${activeTimers.length === 1 ? "" : "s"}` : "Active timers"}
                aria-label={activeTimers.length ? `Active timers: ${activeTimers.length}` : "Active timers"}
                aria-expanded={timersOpen}
                aria-haspopup="dialog"
                onClick={() => {
                  setChatOpen(false);
                  setHistoryOpen(false);
                  setTimersOpen((open) => !open);
                }}
              >
                <Clock3 size={19} />
                {activeTimers.length ? <span className="header-timer-count" aria-hidden="true">{activeTimers.length}</span> : null}
              </PlannerIconButton>
              {timersOpen ? (
                <div className="header-timer-menu" role="dialog" aria-label="Active timers">
                  <div className="header-timer-menu-heading">
                    <strong>Active timers</strong>
                    <PlannerIconButton type="button" title="Close active timers" aria-label="Close active timers" onClick={() => setTimersOpen(false)}><X size={15} /></PlannerIconButton>
                  </div>
                  {activeTimers.length ? (
                    <div className="header-timer-list">
                      {activeTimers.map(({ meal, step }) => (
                        <HeaderTimerItem
                          key={step.id}
                          meal={meal}
                          step={step}
                          disabled={isReadOnly || step.complete}
                          onOpenMeal={(mealId, trigger) => {
                            setTimersOpen(false);
                            openMeal(mealId, trigger);
                          }}
                          onAction={(type) => void mutate({ type, weekId: week!.id, stepId: step.id })}
                        />
                      ))}
                    </div>
                  ) : <p className="header-timer-empty">No timers are running.</p>}
                </div>
              ) : null}
            </div>
            {mobile ? <PlannerIconButton
              ref={chatTriggerRef}
              className="mobile-codex-trigger"
              type="button"
              onClick={() => {
                setHistoryOpen(false);
                setTimersOpen(false);
                setChatOpen(true);
              }}
              aria-expanded={chatOpen}
              aria-label="Open Codex"
              title="Open Codex"
            ><ChevronLeft size={19} /></PlannerIconButton> : null}
          </div>
        </header>

        <nav className="view-nav" aria-label="Planner views">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={`nav-item ${view === item.id ? "active" : ""}`}
                type="button"
                aria-current={view === item.id ? "page" : undefined}
                onClick={() => navigate(item.id)}
              >
                <Icon size={16} /> {item.label}
              </button>
            );
          })}
        </nav>

        <main className={`app-main max-[700px]:!m-0 max-[700px]:!flex max-[700px]:!h-[calc(100dvh-138px)] max-[700px]:!flex-col max-[700px]:!overflow-hidden ${!mobile && codexCollapsed ? "codex-collapsed" : ""}`}>
          {authorityNotice ? (
            <AuthorityNotice
              notice={authorityNotice}
              pendingRetryLabel={pendingRetry?.label}
              onRetryPending={() => void retryPendingOperation(
                pendingRetry ? pendingRetryChannel(pendingRetry) : undefined,
              )}
              retryDisabled={connection !== "online" || plannerPending}
              onDiscardPending={pendingRetry?.operation.state === "resolved_conflict"
                ? () => discardPendingOperation(pendingRetryChannel(pendingRetry))
                : undefined}
              onDismiss={pendingRetry ? undefined : () => setNotice(null)}
              recoveryActionLabel={journalError ? "Review latest plan and clear local recovery" : undefined}
              onRecoveryAction={journalError ? () => void clearLocalRecoveryAfterReadback() : undefined}
              recoveryActionDisabled={journalRecoveryPending}
            />
          ) : null}
          {connection === "offline" ? (
            <OfflineAuthorityNotice
              message="You are seeing the last shared plan. Editing is paused until the server reconnects."
              onReconnect={() => void refresh(true)}
            />
          ) : null}
          <div className="content-heading">
            <div>
              <p className="eyebrow">{week ? weekLabel(week) : "No week selected"}</p>
              <h1 ref={headingRef} tabIndex={-1}>{heading}</h1>
            </div>
            {week ? (
              <div className="week-health">
                <span>{progress.complete} of {progress.total} recipe steps done</span>
                <span className="mini-progress"><i style={{ width: `${progress.total ? (progress.complete / progress.total) * 100 : 0}%` }} /></span>
                {week.status === "planned" ? (
                  <PlannerActionButton
                    tone="quiet"
                    className="lifecycle-button"
                    type="button"
                    disabled={connection !== "online" || plannerPending}
                    onClick={() => void mutate(
                      initialized.state.activeWeekId
                        ? { type: "handoffWeek", currentWeekId: initialized.state.activeWeekId, nextWeekId: week.id }
                        : { type: "activateWeek", weekId: week.id },
                    )}
                  >Make active</PlannerActionButton>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="workspace max-[700px]:!min-h-0 max-[700px]:!flex-1">
            <section ref={primaryWorkspaceRef} className="primary-workspace max-[700px]:!h-full max-[700px]:!overflow-y-auto max-[700px]:[overscroll-behavior:contain]">
              {!week ? (
                <section className="lifecycle-surface empty-workspace">
                  <CalendarDays size={30} />
                  <h2>No weeks yet</h2>
                  <p>Open Codex to build the first week plan.</p>
                </section>
              ) : resolvedLocation.kind === "recipe" && selectedMeal ? (
                  <MealDrawer
                    key={selectedMeal.id}
                    inline
                    meal={selectedMeal}
                    week={week}
                    disabled={isReadOnly}
                    mutate={mutate}
                    sendContextMessage={sendContextMessage}
                    recoveryCommand={recoveryMealCommand}
                    onRecoveryDraftChange={updatePlannerRecoveryDraft}
                    restoreFocusRef={mealTriggerRef}
                    {...plannerAuthorityRecovery}
                    onClose={() => void routerNavigate({ to: weekPath(week.id) })}
                  />
                ) : view === "week" ? (
                  <WeekView
                    week={week}
                    today={today}
                    legacyDate={resolvedLocation.kind === "week" ? resolvedLocation.legacyDate as IsoDate | null : null}
                    onOpenRecipeSummary={openRecipeSummary}
                    onNavigate={navigate}
                  />
                ) : view === "prep" ? (
                  <PrepView
                    key={week.id}
                    SessionStepRow={PrepSessionStepRow}
                    formatCalendarDate={formatCalendarDate}
                    findStep={findStep}
                  stepControlTarget={stepControlTarget}
                    plannerVersion={initialized.plannerVersion}
                    previewOperations={previewPlannerOperations}
                    week={week}
                    disabled={isReadOnly}
                    mutate={mutate}
                    sendContextMessage={sendContextMessage}
                    onOpenRecipeSummary={openRecipeSummary}
                  />
                ) : view === "groceries" ? (
                  <GroceryView
                    key={week.id}
                    week={week}
                    disabled={isReadOnly}
                    mutate={mutate}
                    onOpenRecipeSummary={openRecipeSummary}
                  />
                ) : (
                  <CloseoutView key={week.id} week={week} disabled={isReadOnly} mutate={mutate} />
              )}
            </section>
            {!mobile ? (
              <CodexThreadRail
                draft={codexDraft}
                onDraftChange={setCodexDraft}
                focusKey={codexFocusKey}
                collapsed={codexCollapsed}
                onCollapsedChange={setCodexCollapsed}
                offline={connection !== "online"}
                onReconnect={() => void refresh(true)}
                onPlannerApplied={() => void refresh(true)}
                onClose={() => setCodexCollapsed(true)}
              />
            ) : null}
          </div>
        </main>

        <nav className="mobile-nav" aria-label="Planner views">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} type="button" className={view === item.id ? "active" : ""} aria-current={view === item.id ? "page" : undefined} onClick={() => navigate(item.id)}>
                <Icon size={17} /><span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {activeOverlay === "recipe-summary" && recipeSummaryMeal && week ? (
          <RecipeSummaryDrawer
            meal={recipeSummaryMeal}
            week={week}
            disabled={isReadOnly}
            mutate={mutate}
            restoreFocusRef={mealTriggerRef}
            onClose={() => {
              setRecipeSummaryMealId(null);
              mealTriggerRef.current = null;
            }}
          />
        ) : null}
      {activeOverlay === "history" ? (
          <HistoryDrawer
            workspace={initialized}
            disabled={connection !== "online" || plannerPending || Boolean(plannerRetry)}
            onUndo={runUndo}
            restoreFocusRef={historyTriggerRef}
            {...plannerAuthorityRecovery}
            onClose={() => setHistoryOpen(false)}
          />
        ) : null}

      {activeOverlay === "chat" ? (
        <ModalChat onClose={() => setChatOpen(false)} restoreFocusRef={chatTriggerRef}>
          <CodexThreadRail
            draft={codexDraft}
            onDraftChange={setCodexDraft}
            focusKey={codexFocusKey}
            collapsed={false}
            onCollapsedChange={() => setChatOpen(false)}
            offline={connection !== "online"}
            onReconnect={() => void refresh(true)}
            onPlannerApplied={() => void refresh(true)}
            modal
          />
        </ModalChat>
      ) : null}
      </div>
      </ServerOffsetContext.Provider>
    </PlannerVersionContext.Provider>
  );
}

function MealIngredientList({
  meal,
  week,
  disabled,
  mutate,
  emptyClassName,
}: {
  meal: Meal;
  week: WeekPlan;
  disabled: boolean;
  mutate: Mutate;
  emptyClassName?: string;
}) {
  const groceryByIngredientId = new Map(
    week.data.groceries
      .filter((item) => item.mealId === meal.id)
      .map((item) => [item.ingredientId, item]),
  );
  return (
    <RecipeIngredientList
      items={meal.ingredients}
      emptyClassName={emptyClassName}
      checkedById={new Map([...groceryByIngredientId].map(([ingredientId, item]) => [ingredientId, item.checked]))}
      disabled={disabled}
      onCheckedChange={(ingredientId, checked) => {
        const item = groceryByIngredientId.get(ingredientId);
        if (item) void mutate({ type: "setGroceryItemChecked", weekId: week.id, itemId: item.id, checked });
      }}
    />
  );
}

function MealEditorTrigger({
  mealId,
  onOpenMeal,
  className,
  tone = "quiet",
  children,
}: {
  mealId: string;
  onOpenMeal: (id: string, trigger: HTMLElement) => void;
  className?: string;
  tone?: "primary" | "secondary" | "quiet" | "attention";
  children: ReactNode;
}) {
  return <PlannerActionButton className={className} tone={tone} type="button" onClick={(event) => onOpenMeal(mealId, event.currentTarget)}>{children}</PlannerActionButton>;
}

function WeekView({ week, today, legacyDate, onOpenRecipeSummary, onNavigate }: {
  week: WeekPlan;
  today: IsoDate;
  legacyDate: IsoDate | null;
  onOpenRecipeSummary: (id: string, trigger: HTMLElement) => void;
  onNavigate: (view: PlannerView) => void;
}) {
  const dates = Array.from({ length: 7 }, (_, index) => addIsoDateDays(week.id, index));
  const [visibleDayCount, setVisibleDayCount] = useState<1 | 3 | 5 | 7>(7);
  const [windowStart, setWindowStart] = useState(0);
  const legacyDayRef = useRef<HTMLDivElement>(null);
  const displayedDayCount = legacyDate ? 7 : visibleDayCount;
  const displayedWindowStart = legacyDate ? 0 : windowStart;
  const maxWindowStart = dates.length - displayedDayCount;
  const visibleDates = dates.slice(displayedWindowStart, displayedWindowStart + displayedDayCount);

  const changeVisibleDayCount = (nextCount: 1 | 3 | 5 | 7) => {
    setVisibleDayCount(nextCount);
    setWindowStart((current) => Math.min(current, dates.length - nextCount));
  };
  useEffect(() => {
    if (!legacyDate) return;
    legacyDayRef.current?.focus();
  }, [legacyDate]);

  return (
    <div className="week-view">
      <div className="week-view-toolbar">
        <span className="week-view-toolbar-label">Show</span>
        <ToggleGroup
          type="single"
          value={String(displayedDayCount)}
          onValueChange={(value) => {
            if (value === "1" || value === "3" || value === "5" || value === "7") changeVisibleDayCount(Number(value) as 1 | 3 | 5 | 7);
          }}
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Number of days shown in Week"
        >
          {[1, 3, 5, 7].map((count) => <ToggleGroupItem key={count} value={String(count)} aria-label={`Show ${count} ${count === 1 ? "day" : "days"}`}>{count}</ToggleGroupItem>)}
        </ToggleGroup>
        {displayedDayCount < 7 ? <div className="week-window-shifts" aria-label="Move visible days">
          <Button type="button" variant="outline" size="icon-sm" aria-label="Show earlier days" disabled={displayedWindowStart === 0} onClick={() => setWindowStart((current) => Math.max(0, current - 1))}><ChevronLeft /></Button>
          <Button type="button" variant="outline" size="icon-sm" aria-label="Show later days" disabled={displayedWindowStart === maxWindowStart} onClick={() => setWindowStart((current) => Math.min(maxWindowStart, current + 1))}><ChevronRight /></Button>
        </div> : null}
      </div>
      <div className="week-grid" style={{ "--week-visible-days": displayedDayCount } as React.CSSProperties}>
        {visibleDates.map((date) => {
          return (
            <div key={date} ref={date === legacyDate ? legacyDayRef : undefined} tabIndex={date === legacyDate ? -1 : undefined} className={`day-column ${date === today ? "today" : ""}`}>
              <div className="day-heading">
                <div><span>{dayName(date, "short")}</span>{date === today ? <small>Today</small> : null}</div>
                <strong>{Number(date.slice(-2))}</strong>
              </div>
              {week.data.meals.filter((item) => item.date === date).map((meal) => (
                  <article key={meal.id} className="meal-card" aria-label={`${meal.title} on ${dayName(date)}`}>
                    <button
                      className="meal-card-primary"
                      type="button"
                      aria-label={`Open ${meal.title} recipe`}
                      onClick={(event) => onOpenRecipeSummary(meal.id, event.currentTarget)}
                    >
                      <span className={`status-badge ${statusTone(meal.status)}`}>{meal.status}</span>
                      <strong className="meal-title">{meal.title}</strong>
                      <span className="meal-subtitle">{meal.subtitle}</span>
                      <span className="meal-meta"><MapPin size={12} /> {meal.venue}</span>
                      {meal.leftoverNote ? <span className="meal-leftover"><PackageCheck size={12} /> {meal.leftoverNote}</span> : null}
                    </button>
                    <div className="meal-card-actions">
                      <RecipeSummaryLink className="meal-card-preview" meal={meal} onOpenRecipeSummary={onOpenRecipeSummary}>Peek recipe <ChevronRight size={14} /></RecipeSummaryLink>
                    </div>
                  </article>
              ))}
              {week.data.meals.some((item) => item.date === date) ? null : <div className="meal-card empty-meal" aria-label={`${dayName(date)} has no meals`}><Circle size={19} /><strong className="meal-title">No meals planned</strong><span className="meal-subtitle">Add as many meals as you need.</span></div>}
            </div>
          );
        })}
      </div>
      <div className="mobile-pressure-strip">
        <button type="button" onClick={() => onNavigate("groceries")}><ShoppingBasket size={15} /> Groceries <strong>{week.data.groceries.filter((item) => item.checked).length}/{week.data.groceries.length}</strong></button>
      </div>
    </div>
  );
}

function useTimerDisplay(step: InstructionStep) {
  const serverOffset = useContext(ServerOffsetContext);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (step.timerStartedAt === undefined) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [step.timerStartedAt]);
  return deriveTimerDisplay(
    step.timerDurationSeconds ?? 0,
    step.timerStartedAt,
    now + serverOffset,
    step.timerPaused === true,
  );
}

type TimerDisplay = ReturnType<typeof deriveTimerDisplay>;

function timerParts(remainingSeconds: number) {
  return {
    minutes: Math.floor(remainingSeconds / 60).toString(),
    seconds: (remainingSeconds % 60).toString().padStart(2, "0"),
  };
}

function Timer({ display }: { display: TimerDisplay }) {
  const { minutes, seconds } = timerParts(display.remainingSeconds);
  return (
    <>
      <strong>{minutes.padStart(2, "0")}:{seconds}</strong>
      <span className="timer-status">{display.status}</span>
    </>
  );
}

type TimerControlAction = "startInstructionTimer" | "pauseInstructionTimer" | "resetInstructionTimer";

function TimerAction(props: {
  step: InstructionStep;
  display: TimerDisplay;
  controlTarget: string;
  disabled: boolean;
  onAction: (type: TimerControlAction) => void;
}) {
  const { step, display, controlTarget, disabled, onAction } = props;
  const action: TimerControlAction = display.status === "elapsed"
    ? "resetInstructionTimer"
    : display.status === "running"
      ? "pauseInstructionTimer"
      : "startInstructionTimer";
  const label = action === "pauseInstructionTimer" ? "Pause" : action === "resetInstructionTimer" ? "Reset" : step.timerPaused ? "Resume" : "Start";
  const Icon = action === "pauseInstructionTimer" ? Pause : action === "resetInstructionTimer" ? RotateCcw : Play;
  return (
    <PlannerIconButton
      type="button"
      title={`${label} timer`}
      aria-label={`${label} timer for ${controlTarget}`}
      disabled={disabled}
      onClick={() => onAction(action)}
    ><Icon size={14} /></PlannerIconButton>
  );
}

function HeaderTimerItem(props: {
  meal: Meal;
  step: InstructionStep;
  disabled: boolean;
  onOpenMeal: (id: string, trigger: HTMLElement) => void;
  onAction: (type: TimerControlAction) => void;
}) {
  const { meal, step, disabled, onOpenMeal, onAction } = props;
  const display = useTimerDisplay(step);
  const { minutes, seconds } = timerParts(display.remainingSeconds);
  return (
    <div className="header-timer-item">
      <div className="header-timer-copy">
        <MealEditorTrigger className="header-timer-recipe" mealId={meal.id} onOpenMeal={onOpenMeal}>{meal.title}<ChevronRight size={14} /></MealEditorTrigger>
        <p>{step.instruction}</p>
      </div>
      <div className="header-timer-controls">
        <strong>{minutes.padStart(2, "0")}:{seconds}</strong>
        <TimerAction
          step={step}
          display={display}
          controlTarget={`${meal.title}: ${step.instruction}`}
          disabled={disabled}
          onAction={onAction}
        />
      </div>
    </div>
  );
}

function EditablePrepTimer(props: {
  step: InstructionStep;
  display: TimerDisplay;
  disabled: boolean;
  controlTarget: string;
  onSetRemaining: (remainingSeconds: number) => void;
}) {
  const { step, display, disabled, controlTarget, onSetRemaining } = props;
  const currentParts = timerParts(display.remainingSeconds);
  const timerKey = `${step.timerDurationSeconds ?? 0}:${step.timerStartedAt ?? "stopped"}:${step.timerPaused ? "paused" : "ready"}`;
  const [draft, setDraft] = useState<{
    minutes: string;
    seconds: string;
    timerKey: string;
  } | null>(null);
  const activeDraft = draft?.timerKey === timerKey ? draft : null;

  const beginEditing = () => {
    setDraft((current) => current?.timerKey === timerKey
      ? current
      : { ...currentParts, timerKey });
  };
  const discardDraft = () => setDraft(null);
  const commitDraft = () => {
    if (!activeDraft) {
      discardDraft();
      return;
    }
    const minutes = Number(activeDraft.minutes);
    const seconds = Number(activeDraft.seconds);
    const remainingSeconds = minutes * 60 + seconds;
    if (
      !Number.isSafeInteger(minutes) ||
      !Number.isSafeInteger(seconds) ||
      minutes < 0 ||
      seconds < 0 ||
      seconds > 59 ||
      remainingSeconds < 1 ||
      remainingSeconds > 86_400
    ) {
      discardDraft();
      return;
    }
    if (remainingSeconds !== display.remainingSeconds) onSetRemaining(remainingSeconds);
    discardDraft();
  };
  const value = activeDraft ?? currentParts;
  const onSegmentKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      discardDraft();
      event.currentTarget.blur();
    }
  };
  return (
    <span
      className="editable-timer-display"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commitDraft();
      }}
    >
      <input
        aria-label={`Timer minutes for ${controlTarget}`}
        className="timer-segment timer-minutes"
        disabled={disabled}
        inputMode="numeric"
        maxLength={4}
        onChange={(event) => setDraft((current) => ({
          ...(current?.timerKey === timerKey ? current : { ...currentParts, timerKey }),
          minutes: event.target.value.replace(/[^0-9]/g, ""),
        }))}
        onFocus={(event) => {
          beginEditing();
          event.currentTarget.select();
        }}
        onKeyDown={onSegmentKeyDown}
        pattern="[0-9]*"
        value={value.minutes}
      />
      <span aria-hidden="true">:</span>
      <input
        aria-label={`Timer seconds for ${controlTarget}`}
        className="timer-segment timer-seconds"
        disabled={disabled}
        inputMode="numeric"
        maxLength={2}
        onChange={(event) => setDraft((current) => ({
          ...(current?.timerKey === timerKey ? current : { ...currentParts, timerKey }),
          seconds: event.target.value.replace(/[^0-9]/g, ""),
        }))}
        onFocus={(event) => {
          beginEditing();
          event.currentTarget.select();
        }}
        onKeyDown={onSegmentKeyDown}
        pattern="[0-9]*"
        value={value.seconds}
      />
      <span className="timer-status">{display.status}</span>
    </span>
  );
}

function recipeCodexContext(week: WeekPlan, meal: Meal, step: InstructionStep, message: string): string {
  return `[Planner recipe context: weekId=${week.id}; mealId=${meal.id}; stepId=${step.id}]\n\n${message}`;
}

function InstructionStepCommentComposer({
  step,
  week,
  meal,
  controlTarget,
  disabled,
  onClose,
  onUpdateStepNote,
  sendContextMessage,
  className = "instruction-inline-comment",
  actionsClassName = "step-comment-actions",
  showLimit = true,
}: {
  step: InstructionStep;
  week: WeekPlan;
  meal: Meal;
  controlTarget: string;
  disabled: boolean;
  onClose: () => void;
  onUpdateStepNote: (note: string, options: MutateOptions) => void;
  sendContextMessage: SendContextMessage;
  className?: string;
  actionsClassName?: string;
  showLimit?: boolean;
}) {
  const [comment, setComment] = useState(step.note ?? "");
  const noteDraft = useVersionedDraft();
  const close = () => onClose();
  return <div className={className}>
    <textarea
      aria-label={`Note or Codex request for ${controlTarget}`}
      maxLength={MAX_COMMAND_TEXT_LENGTH}
      value={comment}
      disabled={disabled}
      onChange={(event) => {
        noteDraft.begin();
        setComment(event.target.value);
      }}
      placeholder="What changed, or what should Codex help with?"
    />
    {showLimit ? <small className="field-limit">{comment.length.toLocaleString("en-CA")}/{MAX_COMMAND_TEXT_LENGTH.toLocaleString("en-CA")}</small> : null}
    <div className={actionsClassName}>
      <PlannerActionButton tone="secondary" type="button" onClick={close}>Cancel</PlannerActionButton>
      {step.note ? <PlannerActionButton
        tone="secondary"
        type="button"
        disabled={disabled}
        onClick={() => onUpdateStepNote("", noteDraft.mutationOptions(() => {
          setComment("");
          close();
        }))}
      >Clear comment</PlannerActionButton> : null}
      <PlannerActionButton
        tone="secondary"
        type="button"
        disabled={disabled || !comment.trim()}
        aria-label={`Save comment for ${controlTarget}`}
        onClick={() => onUpdateStepNote(comment.trim(), noteDraft.mutationOptions(close))}
      ><StickyNote size={14} /> Save comment</PlannerActionButton>
      <PlannerActionButton
        tone="primary"
        type="button"
        disabled={disabled || !comment.trim()}
        aria-label={`Ask Codex about ${controlTarget}`}
        onClick={() => {
          const submittedComment = comment.trim();
          void sendContextMessage(recipeCodexContext(week, meal, step, submittedComment)).then((accepted) => {
            if (!accepted) return;
            setComment((current) => {
              if (current.trim() !== submittedComment) return current;
              noteDraft.versionRef.current = null;
              close();
              return "";
            });
          });
        }}
      ><Bot size={14} /> Ask Codex</PlannerActionButton>
    </div>
  </div>;
}

function InstructionStepLine(props: {
  className?: string;
  dataTestId?: string;
  mainClassName?: string;
  step: InstructionStep;
  meal: Meal;
  stepNumber: number;
  disabled: boolean;
  onComplete: (complete: boolean) => void;
  onTimerAction: (type: TimerControlAction) => void;
  leading?: ReactNode;
  trailing?: ReactNode;
  editableTimer?: boolean;
  onSetRemaining?: (remainingSeconds: number) => void;
  onMouseDown?: (event: ReactMouseEvent<HTMLElement>) => void;
  draggable?: boolean;
  onDragStart?: (event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd?: (event: ReactDragEvent<HTMLElement>) => void;
  onDragOver?: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop?: (event: ReactDragEvent<HTMLElement>) => void;
  children?: ReactNode;
}) {
  const {
    className = "",
    dataTestId,
    mainClassName = "",
    step,
    meal,
    stepNumber,
    disabled,
    onComplete,
    onTimerAction,
    leading,
    trailing,
    editableTimer = false,
    onSetRemaining,
    onMouseDown,
    draggable = false,
    onDragStart,
    onDragEnd,
    onDragOver,
    onDrop,
    children,
  } = props;
  const controlTarget = stepControlTarget(meal, step, stepNumber);
  const display = useTimerDisplay(step);
  return (
    <article
      className={`instruction-step instruction-step-line ${leading ? "has-leading" : ""} ${className} ${step.complete ? "complete" : ""}`}
      aria-label={controlTarget}
      data-testid={dataTestId}
      draggable={draggable}
      onMouseDown={onMouseDown}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className={`instruction-line-main ${mainClassName}`.trim()}>
        {leading ? <div className="instruction-line-leading">{leading}</div> : null}
        <label className="instruction-line-checkbox">
          <input
            type="checkbox"
            checked={step.complete}
            disabled={disabled}
            aria-label={`${step.complete ? "Reopen" : "Complete"} ${controlTarget}`}
            onChange={(event) => onComplete(event.target.checked)}
          />
        </label>
        <RecipeInstructionContent step={step} />
        {trailing ? <div className="instruction-line-trailing">{trailing}</div> : null}
      </div>
      {step.timerDurationSeconds ? (
        <div className={`step-timer instruction-line-timer ${step.timerStartedAt !== undefined ? "running" : ""}`}>
          <Clock3 size={14} />
          {editableTimer && onSetRemaining ? (
            <EditablePrepTimer step={step} display={display} disabled={disabled || step.complete} controlTarget={controlTarget} onSetRemaining={onSetRemaining} />
          ) : <Timer display={display} />}
          <TimerAction
            step={step}
            display={display}
            controlTarget={controlTarget}
            disabled={disabled || step.complete}
            onAction={onTimerAction}
          />
        </div>
      ) : null}
      {children}
    </article>
  );
}

function StepCard(props: {
  step: InstructionStep;
  meal: Meal;
  stepNumber: number;
  week: WeekPlan;
  disabled: boolean;
  mutate: Mutate;
  sendContextMessage: SendContextMessage;
  actions?: ReactNode;
  editable?: boolean;
}) {
  const { step, meal, stepNumber, week, disabled, mutate, sendContextMessage, actions, editable = false } = props;
  const archived = week.status === "archived";
  const preparedInBatch = week.data.prepSessions.some((session) => session.steps.some((entry) =>
    isPrepSessionCombinedStep(entry) && entry.complete && !entry.needsReview &&
    entry.sources.some((source) => source.stepId === step.id)
  ));
  const controlTarget = stepControlTarget(meal, step, stepNumber);
  const [commentOpen, setCommentOpen] = useState(false);
  const [editAttempted, setEditAttempted] = useState(false);
  const canonicalInstructionDraft: {
    inputs: InstructionInputEdit[];
    instruction: string;
    timerMinutes: string;
  } = {
    inputs: step.inputs.map((input) => ({
      kind: "retain" as const,
      occurrenceId: input.occurrenceId,
      amount: input.amount,
      ingredient: input.ingredient,
    })),
    instruction: step.instruction,
    timerMinutes: step.timerDurationSeconds ? String(step.timerDurationSeconds / 60) : "",
  };
  const instructionDraft = useVersionedDraft<typeof canonicalInstructionDraft>();
  const {
    inputs: draftInputs,
    instruction: draftInstruction,
    timerMinutes: draftTimerMinutes,
  } = instructionDraft.compose(canonicalInstructionDraft, (canonical, draft) => {
    const composed = { ...canonical, ...draft.dirtyValues };
    if (draft.dirtyValues.inputs) {
      const identity = (input: InstructionInputEdit) => input.kind === "retain"
        ? `retain:${input.occurrenceId}`
        : `create:${input.correlationId}`;
      composed.inputs = mergeIdentityRows(
        canonical.inputs,
        draft.baseline.inputs,
        draft.dirtyValues.inputs,
        identity,
      );
    }
    return composed;
  });
  const timerMinutesNumber = draftTimerMinutes.trim() === "" ? null : Number(draftTimerMinutes);
  const timerSeconds = timerMinutesNumber === null ? null : Math.max(1, Math.round(timerMinutesNumber * 60));
  const editIssues = validateStepDraft({
    inputs: draftInputs,
    instruction: draftInstruction,
    timerMinutes: draftTimerMinutes,
  });
  const inputErrorId = `step-${step.id}-inputs-error`;
  const instructionErrorId = `step-${step.id}-instruction-error`;
  const timerErrorId = `step-${step.id}-timer-error`;
  const saveInstruction = () => {
    setEditAttempted(true);
    if (hasValidationIssues(editIssues)) return;
    void mutate(
      {
        type: "editInstructionStep",
        weekId: week.id,
        stepId: step.id,
        changes: { inputs: draftInputs, instruction: draftInstruction.trim(), timerDurationSeconds: timerSeconds },
      },
      instructionDraft.mutationOptions(() => setEditAttempted(false)),
    );
  };
  return (
    <InstructionStepLine
      className="recipe-instruction-step"
      step={step}
      meal={meal}
      stepNumber={stepNumber}
      disabled={disabled}
      onComplete={(complete) => void mutate({ type: "setInstructionStepComplete", weekId: week.id, stepId: step.id, complete })}
      onTimerAction={(type) => void mutate({ type, weekId: week.id, stepId: step.id })}
      trailing={<div className="instruction-line-actions">
        {actions}
        {!archived ? <PlannerIconButton
          className={`instruction-comment-trigger ${step.note ? "has-note" : ""}`}
          type="button"
          title={step.note ? "Edit step comment" : "Add step comment"}
          aria-label={`${step.note ? "Edit" : "Add"} comment for ${controlTarget}`}
          aria-expanded={commentOpen}
          disabled={disabled}
          onClick={() => setCommentOpen((current) => !current)}
        ><MessageSquareText size={15} /></PlannerIconButton> : null}
      </div>}
    >
      {preparedInBatch ? <span className="summary-chip">Prepared in batch</span> : null}
      {editable && !archived ? (
        <details className="step-comment">
          <summary aria-label={`Edit ${controlTarget}`}><PencilLine size={14} /> Edit instruction</summary>
          <div className="step-comment-body">
            <fieldset className="instruction-input-editor" aria-describedby={editAttempted && editIssues.inputs ? inputErrorId : undefined}>
              <legend>Ingredient amounts</legend>
              {draftInputs.map((input, index) => (
                <div className="instruction-input-row" key={`${input.kind === "retain" ? input.occurrenceId : input.correlationId}:${index}`}>
                  <input aria-label={`Amount ${index + 1} for ${controlTarget}`} maxLength={MAX_STEP_INPUT_AMOUNT_LENGTH} value={input.amount} onChange={(event) => instructionDraft.edit(canonicalInstructionDraft, "inputs", draftInputs.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, amount: event.target.value } : candidate))} />
                  <input aria-label={`Ingredient ${index + 1} for ${controlTarget}`} maxLength={MAX_STEP_INPUT_INGREDIENT_LENGTH} value={input.ingredient} onChange={(event) => instructionDraft.edit(canonicalInstructionDraft, "inputs", draftInputs.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, ingredient: event.target.value } : candidate))} />
                  <PlannerIconButton type="button" tone="attention" title={`Remove ingredient input ${index + 1}`} aria-label={`Remove ingredient input ${index + 1}`} disabled={disabled} onClick={() => instructionDraft.edit(canonicalInstructionDraft, "inputs", draftInputs.filter((_, candidateIndex) => candidateIndex !== index))}><Trash2 size={14} /></PlannerIconButton>
                </div>
              ))}
              <PlannerActionButton tone="quiet" type="button" disabled={disabled} onClick={() => instructionDraft.edit(canonicalInstructionDraft, "inputs", [...draftInputs, { kind: "create" as const, correlationId: createRequestId(), amount: "", ingredient: "" }])}><Plus size={14} /> Add amount</PlannerActionButton>
              {editAttempted && editIssues.inputs ? <small id={inputErrorId} className="field-error" role="alert">{editIssues.inputs}</small> : null}
            </fieldset>
            <label className="full-field"><span>Instruction</span><textarea aria-label={`Instruction text for ${controlTarget}`} maxLength={MAX_COMMAND_TEXT_LENGTH} value={draftInstruction} aria-invalid={editAttempted && Boolean(editIssues.instruction)} aria-describedby={editAttempted && editIssues.instruction ? instructionErrorId : undefined} onChange={(event) => instructionDraft.edit(canonicalInstructionDraft, "instruction", event.target.value)} />{editAttempted && editIssues.instruction ? <small id={instructionErrorId} className="field-error" role="alert">{editIssues.instruction}</small> : null}</label>
            <label className="full-field"><span>Timer minutes (optional, up to 1,440)</span><input aria-label={`Timer minutes for ${controlTarget}`} type="number" min="0.5" max="1440" step="0.5" value={draftTimerMinutes} aria-invalid={editAttempted && Boolean(editIssues.timer)} aria-describedby={editAttempted && editIssues.timer ? timerErrorId : undefined} onChange={(event) => instructionDraft.edit(canonicalInstructionDraft, "timerMinutes", event.target.value)} />{editAttempted && editIssues.timer ? <small id={timerErrorId} className="field-error" role="alert">{editIssues.timer}</small> : null}</label>
            <PlannerActionButton
              tone="secondary"
              type="button"
              disabled={disabled}
              aria-label={`Save ${controlTarget}`}
              onClick={saveInstruction}
            ><Check size={15} /> Save instruction</PlannerActionButton>
          </div>
        </details>
      ) : null}
      {!archived && commentOpen ? <InstructionStepCommentComposer
        step={step}
        week={week}
        meal={meal}
        controlTarget={controlTarget}
        disabled={disabled}
        onClose={() => setCommentOpen(false)}
        onUpdateStepNote={(note, options) => { void mutate({ type: "updateInstructionStepNote", weekId: week.id, stepId: step.id, note }, options); }}
        sendContextMessage={sendContextMessage}
      /> : null}
    </InstructionStepLine>
  );
}

type PrepDragState =
  | { kind: "recipe"; stepIds: string[] }
  | { kind: "session"; sourcePrepDate: IsoDate; entryIds: string[] }
  | null;

function isPrepRowControlTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  return Boolean(element?.closest("button, input, select, label, a, textarea, [data-prep-row-control]"));
}

function PrepSessionStepRow(props: {
  entry: PrepSessionStep;
  prepDate: IsoDate;
  step: InstructionStep;
  meal: Meal;
  stepNumber: number;
  queuePosition: number;
  week: WeekPlan;
  disabled: boolean;
  mutate: Mutate;
  sendContextMessage: SendContextMessage;
  onOpenRecipeSummary: (id: string, trigger: HTMLElement) => void;
  selected: boolean;
  selectedEntryIds: string[];
  dragState: PrepDragState;
  onSelect: (entryId: string, event: ReactMouseEvent<HTMLElement>) => void;
  onDragStarted: (entryIds: string[]) => void;
  onDragEnded: () => void;
  onPointerDragStart: (entryIds: string[], event: ReactMouseEvent<HTMLElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLElement>, targetPosition: number) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>, targetPosition: number) => void;
}) {
  const {
    entry,
    prepDate,
    step,
    meal,
    stepNumber,
    queuePosition,
    week,
    disabled,
    mutate,
    sendContextMessage,
    onOpenRecipeSummary,
    selected,
    selectedEntryIds,
    dragState,
    onSelect,
    onDragStarted,
    onDragEnded,
    onPointerDragStart,
    onDragOver,
    onDrop,
  } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [commentOpen, setCommentOpen] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const controlTarget = stepControlTarget(meal, step, stepNumber);
  const rowDisabled = disabled || actionPending;
  const runMutation = (command: HouseholdCommand, options?: MutateOptions) => {
    if (rowDisabled) return;
    setActionPending(true);
    void mutate(command, options).finally(() => setActionPending(false));
  };
  const openComment = () => {
    if (rowDisabled) return;
    setCommentOpen(true);
    setMenuOpen(false);
  };
  const isDragging = dragState?.kind === "session" && dragState.entryIds.includes(entry.id);
  const draggedEntryIds = selected ? selectedEntryIds : [entry.id];
  const dragLabel = `Drag ${draggedEntryIds.length} selected ${draggedEntryIds.length === 1 ? "instruction" : "instructions"} to another prep date`;
  return (
    <InstructionStepLine
      className={`prep-queue-step ${selected ? "selected" : ""} ${isDragging ? "dragging" : ""}`}
      dataTestId="prep-session-step"
      mainClassName="prep-queue-main"
      step={step}
      meal={meal}
      stepNumber={stepNumber}
      disabled={rowDisabled}
      onComplete={(complete) => runMutation({ type: "setInstructionStepComplete", weekId: week.id, stepId: step.id, complete })}
      onTimerAction={(type) => runMutation({ type, weekId: week.id, stepId: step.id })}
      editableTimer
      onSetRemaining={(remainingSeconds) => runMutation({ type: "setInstructionTimerRemaining", weekId: week.id, stepId: step.id, remainingSeconds })}
      draggable={!rowDisabled}
      onDragStart={(event) => {
        if (rowDisabled || isPrepRowControlTarget(event.target)) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-prep-date-entries", JSON.stringify(draggedEntryIds));
        event.dataTransfer.setData("text/plain", "prep-date-selection");
        onDragStarted(draggedEntryIds);
      }}
      onDragEnd={onDragEnded}
      onDragOver={(event) => {
        if (rowDisabled) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const targetPosition = event.clientY < bounds.top + bounds.height / 2 ? queuePosition : queuePosition + 1;
        onDragOver(event, targetPosition);
      }}
      onDrop={(event) => {
        if (rowDisabled) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const targetPosition = event.clientY < bounds.top + bounds.height / 2 ? queuePosition : queuePosition + 1;
        onDrop(event, targetPosition);
      }}
      onMouseDown={(event) => {
        if (event.button !== 0 || isPrepRowControlTarget(event.target)) return;
        onPointerDragStart(draggedEntryIds, event);
        onSelect(entry.id, event);
      }}
      leading={selected ? <span className="prep-drag-handle" aria-hidden="true" title={dragLabel}><GripVertical size={17} /></span> : <span className="prep-drag-spacer" aria-hidden="true" />}
      trailing={<div className="prep-overflow">
        <PlannerIconButton
          className="prep-overflow-trigger"
          type="button"
          aria-label={`More options for ${controlTarget}`}
          aria-expanded={menuOpen}
          disabled={rowDisabled}
          onClick={() => setMenuOpen((current) => !current)}
        ><EllipsisVertical size={17} /></PlannerIconButton>
        {menuOpen ? <div className="prep-overflow-menu" role="menu" aria-label={`Options for ${controlTarget}`}>
          <RecipeSummaryLink
            className="grocery-meal-link prep-menu-recipe"
            meal={meal}
            role="menuitem"
            onBeforeOpen={() => setMenuOpen(false)}
            onOpenRecipeSummary={onOpenRecipeSummary}
          />
          <button type="button" role="menuitem" disabled={rowDisabled} onClick={openComment}><MessageSquareText size={14} /> {step.note ? "Edit comment" : "Add comment"}</button>
          <button
            className="danger"
            type="button"
            role="menuitem"
            disabled={rowDisabled}
            onClick={() => {
              setMenuOpen(false);
              runMutation({ type: "removePrepStepsFromDate", weekId: week.id, prepDate, entryIds: [entry.id] });
            }}
          ><Trash2 size={14} /> Remove from prep</button>
        </div> : null}
      </div>}
    >
      {commentOpen ? <InstructionStepCommentComposer
        step={step}
        week={week}
        meal={meal}
        controlTarget={controlTarget}
        disabled={rowDisabled}
        onClose={() => setCommentOpen(false)}
        onUpdateStepNote={(note, options) => runMutation({ type: "updateInstructionStepNote", weekId: week.id, stepId: step.id, note }, options)}
        sendContextMessage={sendContextMessage}
        className="instruction-inline-comment prep-inline-comment"
        showLimit={false}
      /> : null}
    </InstructionStepLine>
  );
}

const GROCERY_SOURCE_LABELS = {
  needs_source: "Needs source",
  shop: "Shop",
  farm_box: "Farm box",
  on_hand: "On hand",
} as const;

type GroceryFilter = "to_buy" | "all" | GroceryCoverage | "done";

const GROCERY_FILTERS: Array<{ value: GroceryFilter; label: string }> = [
  { value: "to_buy", label: "To buy" },
  { value: "all", label: "All" },
  { value: "shop", label: "Shop" },
  { value: "farm_box", label: "Farm box" },
  { value: "on_hand", label: "On hand" },
  { value: "done", label: "Done" },
];

function RecipeSummaryLink({
  meal,
  onOpenRecipeSummary,
  className = "grocery-meal-link",
  role,
  onBeforeOpen,
  children,
}: {
  meal: Meal;
  onOpenRecipeSummary: (mealId: string, trigger: HTMLElement) => void;
  className?: string;
  role?: "menuitem";
  onBeforeOpen?: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      className={className}
      type="button"
      role={role}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onBeforeOpen?.();
        onOpenRecipeSummary(meal.id, event.currentTarget);
      }}
    >{children ?? <><Utensils size={11} /> {meal.title}</>}</button>
  );
}

function isGroceryRowControlTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  return Boolean(element?.closest("button, input, select, label, a, textarea, [data-grocery-row-control]"));
}

function GroceryView({
  week,
  disabled,
  mutate,
  onOpenRecipeSummary,
}: {
  week: WeekPlan;
  disabled: boolean;
  mutate: Mutate;
  onOpenRecipeSummary: (mealId: string, trigger: HTMLElement) => void;
}) {
  const [filter, setFilter] = useState<GroceryFilter>("to_buy");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [bulkCoverage, setBulkCoverage] = useState<GroceryCoverage | "">("");
  const [moveNotice, setMoveNotice] = useState<{ coverage: GroceryCoverage; count: number } | null>(null);
  const visible = week.data.groceries.filter((entry) => {
    if (filter === "all") return true;
    if (filter === "done") return entry.checked;
    if (filter === "to_buy") return !entry.checked && entry.coverage === "shop";
    if (filter === "shop") return entry.coverage === "shop";
    return entry.coverage === filter;
  });
  const selectedGroceries = week.data.groceries.filter((entry) => selectedIds.has(entry.id));
  const visibleIdsInDisplayOrder = GROCERY_SECTIONS.flatMap((group) =>
    visible.filter((entry) => entry.section === group).map((entry) => entry.id),
  );
  const allVisibleSelected = Boolean(visibleIdsInDisplayOrder.length) && visibleIdsInDisplayOrder.every((id) => selectedIds.has(id));
  const clearSelection = () => {
    setSelectedIds(new Set());
    setSelectionAnchorId(null);
    setBulkCoverage("");
  };
  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      clearSelection();
      setSelectionMode(false);
      return;
    }
    setSelectedIds(new Set(visibleIdsInDisplayOrder));
    setSelectionAnchorId(visibleIdsInDisplayOrder[0] ?? null);
    setSelectionMode(true);
  };
  const selectRow = (itemId: string, event: ReactMouseEvent<HTMLElement>, allowControlTarget = false) => {
    if (disabled) return;
    if (!allowControlTarget && isGroceryRowControlTarget(event.target)) return;
    const additive = event.ctrlKey || event.metaKey;
    const anchorIndex = selectionAnchorId ? visibleIdsInDisplayOrder.indexOf(selectionAnchorId) : -1;
    const itemIndex = visibleIdsInDisplayOrder.indexOf(itemId);
    if (event.shiftKey && anchorIndex >= 0 && itemIndex >= 0) {
      const rangeIds = visibleIdsInDisplayOrder.slice(
        Math.min(anchorIndex, itemIndex),
        Math.max(anchorIndex, itemIndex) + 1,
      );
      setSelectedIds((current) => {
        const next = additive ? new Set(current) : new Set<string>();
        rangeIds.forEach((rangeId) => next.add(rangeId));
        return next;
      });
      return;
    }
    setSelectedIds((current) => {
      if (!additive) return new Set([itemId]);
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
    setSelectionAnchorId(itemId);
  };
  const moveGroceriesToCoverage = (itemIds: string[], coverage: GroceryCoverage) => {
    if (!itemIds.length) return;
    void mutate(
      {
        type: "setGroceryItemsCoverage",
        weekId: week.id,
        itemIds,
        coverage,
      },
      {
        onAccepted: () => {
          setMoveNotice({ coverage, count: itemIds.length });
          clearSelection();
        },
      },
    );
  };
  const moveSelectedToCoverage = (coverage: GroceryCoverage) => {
    const itemIds = selectedGroceries
      .filter((entry) => entry.coverage !== coverage)
      .map((entry) => entry.id);
    moveGroceriesToCoverage(itemIds, coverage);
  };
  return (
    <div className="grocery-layout">
      <div className={`grocery-list ${selectionMode ? "selection-mode" : ""}`}>
        <div className="surface-summary grocery-summary">
          <div><p className="eyebrow">This week&apos;s dinners</p><h2>Shopping list</h2><p className="grocery-list-description">Check off what you have; each item keeps its recipe source for reference.</p></div>
          <div className="grocery-summary-controls">
            <SegmentedControl
              ariaLabel="Grocery filter"
              options={GROCERY_FILTERS}
              value={filter}
              onChange={(value) => { clearSelection(); setMoveNotice(null); setFilter(value); }}
            />
          </div>
        </div>
        <div className="grocery-list-selection-header">
          <label className="grocery-select-all"><input type="checkbox" checked={allVisibleSelected} disabled={disabled || !visibleIdsInDisplayOrder.length} onChange={toggleSelectAllVisible} /> Select all</label>
          {selectedGroceries.length ? <div className="grocery-selection-toolbar" role="status" data-testid="grocery-selection-toolbar"><strong>{selectedGroceries.length} {selectedGroceries.length === 1 ? "item" : "items"} selected</strong><select value={bulkCoverage} aria-label="Set selected grocery coverage" onChange={(event) => setBulkCoverage(event.target.value as GroceryCoverage | "")}><option value="">Set coverage…</option>{GROCERY_COVERAGES.map((coverage) => <option key={coverage} value={coverage}>{GROCERY_SOURCE_LABELS[coverage]}</option>)}</select><PlannerActionButton tone="secondary" type="button" disabled={disabled || !bulkCoverage || !selectedGroceries.some((entry) => entry.coverage !== bulkCoverage)} onClick={() => bulkCoverage && moveSelectedToCoverage(bulkCoverage)}>Set coverage</PlannerActionButton></div> : null}
        </div>
        {moveNotice ? <div className="grocery-move-notice" role="status" data-testid="grocery-move-notice">
          <span>Set {moveNotice.count} {moveNotice.count === 1 ? "ingredient" : "ingredients"} to {GROCERY_SOURCE_LABELS[moveNotice.coverage]}.</span>
          <PlannerActionButton tone="quiet" type="button" onClick={() => { setFilter(moveNotice.coverage); setMoveNotice(null); }}>View {GROCERY_SOURCE_LABELS[moveNotice.coverage]}</PlannerActionButton>
        </div> : null}
        {GROCERY_SECTIONS.map((group) => {
          const entries = visible.filter((entry) => entry.section === group);
          if (!entries.length) return null;
          return (
            <section className="grocery-section" key={group}>
              <h3>{group}<span>{entries.length}</span></h3>
              {entries.map((entry) => {
                const linkedMeal = week.data.meals.find((meal) => meal.id === entry.mealId);
                const ingredient = linkedMeal?.ingredients.find((candidate) => candidate.id === entry.ingredientId);
                if (!linkedMeal || !ingredient) return null;
                const item = ingredient.ingredient;
                const detail = ingredient.amount;
                return (
                  <div
                    className={`grocery-row ${entry.checked ? "checked" : ""} ${selectedIds.has(entry.id) ? "selected" : ""}`}
                    data-grocery-id={entry.id}
                    key={entry.id}
                    onMouseDown={(event) => {
                      if (event.button !== 0) return;
                      if (isGroceryRowControlTarget(event.target)) return;
                      if (!selectionMode) setSelectionMode(true);
                      selectRow(entry.id, event);
                    }}
                  >
                    <label className="grocery-check" data-grocery-row-control onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
                      <input type="checkbox" checked={entry.checked} disabled={disabled} aria-label={`Check ${item}`} onChange={(event) => void mutate({ type: "setGroceryItemChecked", weekId: week.id, itemId: entry.id, checked: event.target.checked })} />
                    </label>
                    <div className="grocery-item-copy">
                      <div className="grocery-primary-line">
                        <div className="grocery-select-target"><strong>{item}</strong><span className="grocery-detail">{detail || "No amount noted"}</span></div>
                        <span className="grocery-source-badge" title={`Coverage: ${GROCERY_SOURCE_LABELS[entry.coverage]}`}>{GROCERY_SOURCE_LABELS[entry.coverage]}</span>
                      </div>
                      <div className="grocery-recipe-links"><span>For</span><RecipeSummaryLink meal={linkedMeal} onOpenRecipeSummary={onOpenRecipeSummary} /></div>
                    </div>
                  </div>
                );
              })}
            </section>
          );
        })}
        {!visible.length ? <p className="empty-copy">No groceries match this filter.</p> : null}
      </div>
    </div>
  );
}

function LeftoverControls({ week, disabled, mutate }: { week: WeekPlan; disabled: boolean; mutate: Mutate }) {
  return (
    <div className="leftover-feedback">
      {week.data.leftovers.map((leftover) => {
        return (
          <div key={leftover.id}>
            <span><strong>{leftover.label} · {leftover.portions} portions</strong><small>{leftover.state}{leftover.assignedDate ? ` for ${leftover.assignedDate}` : ""}</small></span>
            <SegmentedControl
              ariaLabel={`Quality for ${leftover.label} leftovers`}
              disabled={disabled}
              options={LEFTOVER_QUALITIES.map((quality) => ({ value: quality, label: quality, ariaLabel: `Rate ${leftover.label} leftovers ${quality}` }))}
              value={leftover.quality}
              onChange={(quality) => void mutate({ type: "captureLeftoverQuality", weekId: week.id, leftoverId: leftover.id, quality })}
            />
            {leftover.state === "assigned" ? <PlannerActionButton tone="secondary" type="button" aria-label={`Mark ${leftover.label} leftovers eaten`} disabled={disabled} onClick={() => void mutate({ type: "consumeLeftover", weekId: week.id, leftoverId: leftover.id })}><Check size={15} /> Mark eaten</PlannerActionButton> : null}
          </div>
        );
      })}
      {!week.data.leftovers.length ? <p className="empty-copy">Cooking a meal with planned leftovers will add it here.</p> : null}
    </div>
  );
}

function MealFeedbackRow({ meal, week, disabled, mutate }: { meal: Meal; week: WeekPlan; disabled: boolean; mutate: Mutate }) {
  return <div className="feedback-row">
    <div><strong>{meal.title}</strong><small>{formatCalendarDate(meal.date, { weekday: "long" })} · {meal.status}</small></div>
    <SegmentedControl ariaLabel={`Feedback for ${meal.title}`} className="feedback-control" disabled={disabled} options={FEEDBACK_VALUES.map((value) => ({ value, label: value, ariaLabel: `Rate ${meal.title} ${value}` }))} value={week.data.feedback[meal.id]} onChange={(value) => void mutate({ type: "captureFeedback", weekId: week.id, mealId: meal.id, value })} />
  </div>;
}

function CloseoutView({ week, disabled, mutate }: { week: WeekPlan; disabled: boolean; mutate: Mutate }) {
  const [lesson, setLesson] = useState(week.data.weekLesson);
  const lessonDraft = useVersionedDraft();
  const draftLesson = lessonDraft.versionRef.current === null
    ? week.data.weekLesson
    : lesson;
  const feedbackMeals = week.data.meals.filter((meal) => meal.status === "cooked");
  const feedbackComplete = feedbackMeals.filter((meal) => week.data.feedback[meal.id]).length;
  const archivedFeedbackCount = week.data.meals.filter((meal) => week.data.feedback[meal.id]).length;
  if (week.status === "archived") {
    return (
      <div className="lifecycle-surface current-archive">
        <span className="archive-icon"><Archive size={24} /></span>
        <p className="eyebrow">Read-only record</p><h2>Week archived</h2>
        <div className="archive-stats"><span><strong>{week.data.meals.length}</strong> meals</span><span><strong>{archivedFeedbackCount}</strong> ratings</span><span><strong>{week.data.leftovers.length}</strong> leftovers</span></div>
        {week.data.weekLesson ? <div className="lesson-band"><StickyNote size={16} /><span><strong>Planning lesson</strong><p>{week.data.weekLesson}</p></span></div> : null}
      </div>
    );
  }
  return (
    <div className="closeout-layout">
      <div className="feedback-list">
        <div className="surface-summary"><div><p className="eyebrow">Keep the useful signal</p><h2>Cooked meal feedback</h2></div><span className="summary-chip">{feedbackComplete}/{feedbackMeals.length} rated</span></div>
        {feedbackMeals.map((meal) => <MealFeedbackRow key={meal.id} meal={meal} week={week} disabled={disabled} mutate={mutate} />)}
        {!feedbackMeals.length ? <p className="empty-copy">Cook a meal first, then capture the signal worth carrying into the next plan.</p> : null}
      </div>
      <aside className="closeout-notes">
        <section className="closeout-note-section">
          <span className="field-label">Leftovers</span>
          <LeftoverControls week={week} disabled={disabled} mutate={mutate} />
        </section>
        <section className="closeout-note-section">
          <label><span>What should next week remember?</span><textarea maxLength={MAX_COMMAND_TEXT_LENGTH} value={draftLesson} onChange={(event) => { lessonDraft.begin(); setLesson(event.target.value); }} placeholder="A short planning lesson" /><small className="field-limit">{draftLesson.length.toLocaleString("en-CA")}/{MAX_COMMAND_TEXT_LENGTH.toLocaleString("en-CA")}</small></label>
          <PlannerActionButton tone="secondary" type="button" disabled={disabled || draftLesson === week.data.weekLesson} onClick={() => void mutate({ type: "captureWeekLesson", weekId: week.id, weekLesson: draftLesson }, lessonDraft.mutationOptions())}><StickyNote size={15} /> Save lesson</PlannerActionButton>
        </section>
        <span className="closeout-check"><CheckCircle2 size={14} /> Archiving freezes this week as a read-only family record.</span>
        <PlannerActionButton tone="primary" type="button" disabled={disabled || week.status !== "active"} onClick={() => void mutate({ type: "archiveWeek", weekId: week.id })}><Archive size={16} /> Archive active week</PlannerActionButton>
      </aside>
    </div>
  );
}

function RecipeSource({ meal }: { meal: Meal }) {
  if (!meal.sourceRecipe) return null;
  if (meal.sourceRecipe.kind === "canonical") {
    return (
      <div>
        <p className="recipe-source">
          <span>Canonical recipe</span>
          <span>{meal.sourceRecipe.identity} · pinned {meal.sourceRecipe.revision.slice(0, 12)}</span>
        </p>
        {meal.sourceRecipe.notes ? (
          <div className="mt-3 whitespace-pre-wrap text-sm text-[var(--color-text-muted)]">
            <span className="mb-1 block font-semibold text-[var(--color-text)]">Canonical notes</span>
            {meal.sourceRecipe.notes}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <p className="recipe-source">
      <span>Recipe source</span>
      <a href={meal.sourceRecipe.url} target="_blank" rel="noopener noreferrer">
        Open {meal.sourceRecipe.identity} <ChevronRight size={13} aria-hidden="true" />
      </a>
    </p>
  );
}

function RecipeSummaryDrawer({
  meal,
  week,
  disabled,
  mutate,
  restoreFocusRef,
  onClose,
}: {
  meal: Meal;
  week: WeekPlan;
  disabled: boolean;
  mutate: Mutate;
  restoreFocusRef: { current: HTMLElement | null };
  onClose: () => void;
}) {
  return (
    <ModalDrawer title={meal.title} className="recipe-summary-drawer" onClose={onClose} restoreFocusRef={restoreFocusRef}>
      <div className="drawer-body recipe-summary-body" tabIndex={0} data-autofocus="true" aria-label={`${meal.title} recipe summary`}>
        <p className="eyebrow">Recipe summary</p>
        <p className="recipe-summary-meta">{formatCalendarDate(meal.date, { weekday: "long", month: "short", day: "numeric" })} dinner · {meal.venue}</p>
        {meal.subtitle ? <p className="recipe-summary-subtitle">{meal.subtitle}</p> : null}
        {meal.yieldText ? <p className="recipe-yield">Yield: {meal.yieldText}</p> : null}
        <RecipeSource meal={meal} />

        <section className="snapshot-section">
          <div className="section-title"><ShoppingBasket size={16} /><h3>Ingredients</h3></div>
          <MealIngredientList meal={meal} week={week} disabled={disabled} mutate={mutate} emptyClassName="recipe-summary-copy" />
        </section>

        <section className="snapshot-section">
          <div className="section-title"><CookingPot size={16} /><h3>Instructions</h3><span>{meal.instructions.length} steps</span></div>
          {meal.instructions.length ? (
            <div className="grid gap-0">
              {meal.instructions.map((step, index) => (
                <InstructionStepLine
                  key={step.id}
                  className="border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0"
                  step={step}
                  meal={meal}
                  stepNumber={index + 1}
                  disabled={disabled}
                  onComplete={(complete) => void mutate({ type: "setInstructionStepComplete", weekId: week.id, stepId: step.id, complete })}
                  onTimerAction={(type) => void mutate({ type, weekId: week.id, stepId: step.id })}
                />
              ))}
            </div>
          ) : <p className="recipe-summary-copy">No instructions listed.</p>}
        </section>

        {meal.notes ? <section className="snapshot-section"><div className="section-title"><StickyNote size={16} /><h3>Recipe note</h3></div><p className="recipe-summary-copy">{meal.notes}</p></section> : null}
        {meal.prepNote ? <section className="snapshot-section"><div className="section-title"><ListChecks size={16} /><h3>Prep note</h3></div><p className="recipe-summary-copy">{meal.prepNote}</p></section> : null}
        {meal.leftoverNote ? <section className="snapshot-section"><div className="section-title"><PackageCheck size={16} /><h3>Leftovers</h3></div><p className="recipe-summary-copy">{meal.leftoverNote}</p></section> : null}
      </div>
      <div className="drawer-footer"><PlannerActionButton tone="secondary" type="button" onClick={onClose}>Close</PlannerActionButton></div>
    </ModalDrawer>
  );
}

function MealDrawer(props: {
  inline?: boolean;
  meal: Meal;
  week: WeekPlan;
  disabled: boolean;
  mutate: Mutate;
  sendContextMessage: SendContextMessage;
  recoveryCommand: Extract<HouseholdCommand, { type: "editMealRecipe" }> | null;
  onRecoveryDraftChange: (
    command: Extract<HouseholdCommand, { type: "editMealRecipe" }>,
  ) => void;
  restoreFocusRef: { current: HTMLElement | null };
  onClose: () => void;
} & AuthorityRecoveryProps) {
  const {
    meal,
    inline = false,
    week,
    disabled,
    mutate,
    sendContextMessage,
    recoveryCommand,
    onRecoveryDraftChange,
    restoreFocusRef,
    onClose,
    notice,
    pendingRetryLabel,
    onRetryPending,
    retryDisabled,
    onDiscardPending,
    onDismissNotice,
    offline,
    onReconnect,
  } = props;
  const archived = week.status === "archived";
  const [retainedRecoveryCommand] = useState(recoveryCommand);
  const visibleRecoveryCommand = recoveryCommand ?? retainedRecoveryCommand;
  const [targetDate, setTargetDate] = useState<IsoDate>(meal.date);
  const [newInstruction, setNewInstruction] = useState("");
  const [newInputs, setNewInputs] = useState("");
  const [newTimer, setNewTimer] = useState("");
  const [saveAttempted, setSaveAttempted] = useState(false);
  const [newStepAttempted, setNewStepAttempted] = useState(false);
  const occurrenceDrafts = visibleRecoveryCommand?.occurrences ?? meal.ingredients.map((ingredient) => ({
    kind: "retain" as const,
    occurrenceId: ingredient.id,
    source: ingredient.source,
    amount: ingredient.amount,
    unit: ingredient.unit,
    ingredient: ingredient.ingredient,
    qualifier: ingredient.qualifier,
    conceptId: ingredient.conceptId,
  }));
  const canonicalRecipeDraft = {
    title: visibleRecoveryCommand?.changes.title ?? meal.title,
    subtitle: visibleRecoveryCommand?.changes.subtitle ?? meal.subtitle,
    venue: visibleRecoveryCommand?.changes.venue ?? meal.venue,
    prepNote: visibleRecoveryCommand?.changes.prepNote ?? meal.prepNote,
    leftoverNote: visibleRecoveryCommand?.changes.leftoverNote ?? meal.leftoverNote,
    notes: visibleRecoveryCommand?.changes.notes ?? meal.notes,
    occurrences: occurrenceDrafts,
  };
  const recipeDraft = useVersionedDraft<typeof canonicalRecipeDraft>();
  const moveDraft = useVersionedDraft();
  const newStepDraft = useVersionedDraft();
  const {
    title: draftTitle,
    subtitle: draftSubtitle,
    venue: draftVenue,
    prepNote: draftPrepNote,
    leftoverNote: draftLeftoverNote,
    notes: draftNotes,
    occurrences: draftOccurrences,
  } = recipeDraft.compose(canonicalRecipeDraft, (canonical, draft) => {
    const composed = { ...canonical, ...draft.dirtyValues };
    if (draft.dirtyValues.occurrences) {
      const identity = (occurrence: (typeof canonical.occurrences)[number]) => occurrence.kind === "retain"
        ? `retain:${occurrence.occurrenceId}`
        : `create:${occurrence.correlationId}`;
      composed.occurrences = mergeIdentityRows(
        canonical.occurrences,
        draft.baseline.occurrences,
        draft.dirtyValues.occurrences,
        identity,
      );
    }
    return composed;
  });
  const draftTargetDate = moveDraft.versionRef.current === null ? meal.date : targetDate;
  const dates = Array.from({ length: 7 }, (_, index) => addIsoDateDays(week.id, index));
  const newTimerMinutes = newTimer.trim() === "" ? null : Number(newTimer);
  const mealIssues = validateMealDraft({
    title: draftTitle,
    subtitle: draftSubtitle,
    venue: draftVenue,
    prepNote: draftPrepNote,
    leftoverNote: draftLeftoverNote,
    notes: draftNotes,
    ingredients: draftOccurrences.map((occurrence) => ({
      source: occurrence.source ?? "",
      amount: occurrence.amount,
      unit: occurrence.unit ?? "",
      ingredient: occurrence.ingredient,
      qualifier: occurrence.qualifier ?? "",
    })),
  });
  const newStepIssues = validateStepDraft({ inputs: newInputs, instruction: newInstruction, timerMinutes: newTimer });
  const editRecipeField = <Key extends keyof typeof canonicalRecipeDraft>(
    field: Key,
    value: (typeof canonicalRecipeDraft)[Key],
  ) => {
    recipeDraft.edit(canonicalRecipeDraft, field, value);
    if (!visibleRecoveryCommand) return;
    const next = {
      title: draftTitle,
      subtitle: draftSubtitle,
      venue: draftVenue,
      prepNote: draftPrepNote,
      leftoverNote: draftLeftoverNote,
      notes: draftNotes,
      occurrences: draftOccurrences,
      [field]: value,
    };
    onRecoveryDraftChange({
      ...visibleRecoveryCommand,
      changes: {
        title: next.title.trim(),
        subtitle: next.subtitle.trim(),
        venue: next.venue.trim(),
        prepNote: next.prepNote.trim(),
        leftoverNote: next.leftoverNote.trim(),
        notes: next.notes.trim(),
        yieldText: visibleRecoveryCommand.changes.yieldText ?? null,
      },
      occurrences: next.occurrences,
      removedOccurrenceIds: meal.ingredients
        .map((ingredient) => ingredient.id)
        .filter((occurrenceId) => !next.occurrences.some((occurrence) =>
          occurrence.kind === "retain" && occurrence.occurrenceId === occurrenceId
        )),
    });
  };
  const updateOccurrence = (
    index: number,
    field: "source" | "amount" | "unit" | "ingredient" | "qualifier",
    value: string,
  ) => {
    const occurrences = draftOccurrences.map((occurrence, currentIndex) =>
      currentIndex === index
        ? {
            ...occurrence,
            [field]: value || null,
            ...(field === "ingredient" && occurrence.kind === "retain" &&
              normalizedCoreIngredientLiteral(occurrence.ingredient) !== normalizedCoreIngredientLiteral(value)
              ? { conceptId: null }
              : {}),
          }
        : occurrence,
    );
    // Amount and core are strings in the wire contract, including an empty amount.
    if (field === "amount" || field === "ingredient") {
      occurrences[index] = { ...occurrences[index], [field]: value };
    }
    editRecipeField("occurrences", occurrences);
  };
  const addOccurrence = () => editRecipeField("occurrences", [
    ...draftOccurrences,
    {
      kind: "create" as const,
      correlationId: createRequestId(),
      source: null,
      amount: "",
      unit: null,
      ingredient: "",
      qualifier: null,
      conceptId: null,
      canonicalIngredientId: null,
    },
  ]);
  const copyOccurrence = (index: number) => {
    const source = draftOccurrences[index];
    const copy = {
      kind: "create" as const,
      correlationId: createRequestId(),
      source: source.source,
      amount: source.amount,
      unit: source.unit,
      ingredient: source.ingredient,
      qualifier: source.qualifier,
      conceptId: source.conceptId,
      canonicalIngredientId: null,
    };
    editRecipeField("occurrences", [
      ...draftOccurrences.slice(0, index + 1),
      copy,
      ...draftOccurrences.slice(index + 1),
    ]);
  };
  const removeOccurrence = (index: number) => {
    editRecipeField("occurrences", draftOccurrences.filter((_, currentIndex) => currentIndex !== index));
  };
  const moveOccurrence = (index: number, targetIndex: number) => {
    const occurrences = [...draftOccurrences];
    const [moved] = occurrences.splice(index, 1);
    occurrences.splice(targetIndex, 0, moved);
    editRecipeField("occurrences", occurrences);
  };
  const save = () => {
    setSaveAttempted(true);
    if (hasValidationIssues(mealIssues)) return;
    void mutate(
      {
        type: "editMealRecipe",
        weekId: week.id,
        mealId: meal.id,
        changes: {
          title: draftTitle.trim(), subtitle: draftSubtitle.trim(), venue: draftVenue.trim(), prepNote: draftPrepNote.trim(), leftoverNote: draftLeftoverNote.trim(), notes: draftNotes.trim(),
          yieldText: meal.yieldText ?? null,
        },
        occurrences: draftOccurrences,
        removedOccurrenceIds: meal.ingredients
          .map((ingredient) => ingredient.id)
          .filter((occurrenceId) => !draftOccurrences.some((occurrence) =>
            occurrence.kind === "retain" && occurrence.occurrenceId === occurrenceId
          )),
      },
      recipeDraft.mutationOptions(() => setSaveAttempted(false)),
    );
  };
  const addInstruction = () => {
    setNewStepAttempted(true);
    if (hasValidationIssues(newStepIssues)) return;
    const timer = newTimerMinutes === null ? undefined : Math.max(1, Math.round(newTimerMinutes * 60));
    const inputs = newInputs.split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const [amount, ...ingredient] = line.split("|");
        return {
          kind: "create" as const,
          correlationId: createRequestId(),
          amount: amount.trim(),
          ingredient: ingredient.join("|").trim(),
        };
      });
    void mutate(
      {
        type: "addInstructionStep",
        weekId: week.id,
        mealId: meal.id,
        position: meal.instructions.length,
        step: { inputs, instruction: newInstruction.trim(), ...(timer ? { timerDurationSeconds: timer } : {}) },
      },
      newStepDraft.mutationOptions(() => {
        setNewInstruction("");
        setNewInputs("");
        setNewTimer("");
        setNewStepAttempted(false);
      }),
    );
  };
  return (
    <ModalDrawer inline={inline} title={meal.title} className="meal-drawer" onClose={onClose} restoreFocusRef={restoreFocusRef}>
      <div className="drawer-body" tabIndex={0} aria-label={`${meal.title} recipe details`}>
        {notice ? (
          <AuthorityNotice
            notice={notice}
            pendingRetryLabel={pendingRetryLabel}
            onRetryPending={onRetryPending}
            retryDisabled={retryDisabled}
            onDiscardPending={onDiscardPending}
            onDismiss={pendingRetryLabel ? undefined : onDismissNotice}
          />
        ) : null}
        {offline ? <OfflineAuthorityNotice onReconnect={onReconnect} /> : null}
        {week.status === "archived" ? <p className="inline-alert warning">Archived weeks are read-only.</p> : null}
        {meal.yieldText ? <p className="recipe-yield">Yield: {meal.yieldText}</p> : null}
        <RecipeSource meal={meal} />
        <div className="field-grid">
          <label><span>Title</span><input aria-label="Title" disabled={archived} maxLength={MAX_MEAL_TITLE_LENGTH} value={draftTitle} aria-invalid={saveAttempted && Boolean(mealIssues.title)} aria-describedby={saveAttempted && mealIssues.title ? "meal-title-error" : undefined} onChange={(event) => editRecipeField("title", event.target.value)} /><FieldError id="meal-title-error" message={saveAttempted ? mealIssues.title : undefined} /></label>
          <label><span>Venue</span><input aria-label="Venue" disabled={archived} maxLength={MAX_MEAL_VENUE_LENGTH} value={draftVenue} aria-invalid={saveAttempted && Boolean(mealIssues.venue)} aria-describedby={saveAttempted && mealIssues.venue ? "meal-venue-error" : undefined} onChange={(event) => editRecipeField("venue", event.target.value)} /><FieldError id="meal-venue-error" message={saveAttempted ? mealIssues.venue : undefined} /></label>
        </div>
        <label className="full-field"><span>Subtitle</span><input aria-label="Subtitle" disabled={archived} maxLength={MAX_MEAL_SUBTITLE_LENGTH} value={draftSubtitle} aria-invalid={saveAttempted && Boolean(mealIssues.subtitle)} aria-describedby={saveAttempted && mealIssues.subtitle ? "meal-subtitle-error" : undefined} onChange={(event) => editRecipeField("subtitle", event.target.value)} /><FieldError id="meal-subtitle-error" message={saveAttempted ? mealIssues.subtitle : undefined} /></label>
        <section className="full-field occurrence-editor" aria-labelledby="meal-ingredients-heading">
          <div className="occurrence-editor-heading">
            <span id="meal-ingredients-heading">Ingredients</span>
            <small>Each row is one recipe occurrence. Editing a row keeps its identity; removing it also removes linked instruction inputs.</small>
          </div>
          <div className="occurrence-editor-rows" aria-describedby={saveAttempted && mealIssues.ingredients ? "meal-ingredients-error" : undefined}>
            {draftOccurrences.map((occurrence, index) => (
              <fieldset className="occurrence-editor-row" key={occurrence.kind === "retain" ? occurrence.occurrenceId : occurrence.correlationId}>
                <legend className="sr-only">Ingredient {index + 1}</legend>
                <label><span>Source</span><input aria-label={`Ingredient ${index + 1} source`} disabled={archived} maxLength={MAX_INGREDIENT_LINE_LENGTH} value={occurrence.source ?? ""} onChange={(event) => updateOccurrence(index, "source", event.target.value)} /></label>
                <label><span>Amount</span><input aria-label={`Ingredient ${index + 1} amount`} disabled={archived} maxLength={MAX_INGREDIENT_LINE_LENGTH} value={occurrence.amount} onChange={(event) => updateOccurrence(index, "amount", event.target.value)} /></label>
                <label><span>Unit</span><input aria-label={`Ingredient ${index + 1} unit`} disabled={archived} maxLength={MAX_INGREDIENT_LINE_LENGTH} value={occurrence.unit ?? ""} onChange={(event) => updateOccurrence(index, "unit", event.target.value)} /></label>
                <label><span>Ingredient</span><input aria-label={`Ingredient ${index + 1} core`} disabled={archived} maxLength={MAX_INGREDIENT_LINE_LENGTH} value={occurrence.ingredient} onChange={(event) => updateOccurrence(index, "ingredient", event.target.value)} /></label>
                <label><span>Qualifier</span><input aria-label={`Ingredient ${index + 1} qualifier`} disabled={archived} maxLength={MAX_INGREDIENT_LINE_LENGTH} value={occurrence.qualifier ?? ""} onChange={(event) => updateOccurrence(index, "qualifier", event.target.value)} /></label>
                <PlannerIconButton type="button" title={`Move ingredient ${index + 1} up`} aria-label={`Move ingredient ${index + 1} up`} disabled={disabled || index === 0} onClick={() => moveOccurrence(index, index - 1)}><ArrowUp size={14} /></PlannerIconButton>
                <PlannerIconButton type="button" title={`Move ingredient ${index + 1} down`} aria-label={`Move ingredient ${index + 1} down`} disabled={disabled || index === draftOccurrences.length - 1} onClick={() => moveOccurrence(index, index + 1)}><ArrowDown size={14} /></PlannerIconButton>
                <PlannerIconButton type="button" title={`Duplicate ingredient ${index + 1}`} aria-label={`Duplicate ingredient ${index + 1} as a new occurrence`} disabled={disabled} onClick={() => copyOccurrence(index)}><Copy size={14} /></PlannerIconButton>
                <PlannerIconButton type="button" title={`Split ingredient ${index + 1}`} aria-label={`Split ingredient ${index + 1}; this row keeps its identity`} disabled={disabled} onClick={() => copyOccurrence(index)}><Split size={14} /></PlannerIconButton>
                <PlannerIconButton type="button" tone="attention" title={`Remove ingredient ${index + 1}`} aria-label={`Remove ingredient ${index + 1} and linked instruction inputs`} disabled={disabled} onClick={() => removeOccurrence(index)}><Trash2 size={14} /></PlannerIconButton>
              </fieldset>
            ))}
          </div>
          <PlannerActionButton tone="secondary" type="button" disabled={disabled} onClick={addOccurrence}><Plus size={15} /> Add ingredient</PlannerActionButton>
          <FieldError id="meal-ingredients-error" message={saveAttempted ? mealIssues.ingredients : undefined} />
        </section>
        <section className="snapshot-section" aria-labelledby="meal-grocery-execution-heading">
          <div className="section-title"><ShoppingBasket size={16} /><h3 id="meal-grocery-execution-heading">Grocery execution</h3></div>
          <MealIngredientList meal={meal} week={week} disabled={disabled} mutate={mutate} />
        </section>
        <label className="full-field"><span>Recipe note</span><textarea aria-label="Recipe note" disabled={archived} rows={3} maxLength={MAX_COMMAND_TEXT_LENGTH} value={draftNotes} aria-invalid={saveAttempted && Boolean(mealIssues.notes)} aria-describedby={saveAttempted && mealIssues.notes ? "meal-notes-error" : undefined} onChange={(event) => editRecipeField("notes", event.target.value)} /><FieldError id="meal-notes-error" message={saveAttempted ? mealIssues.notes : undefined} /></label>
        <div className="field-grid">
          <label><span>Prep note</span><textarea aria-label="Prep note" disabled={archived} maxLength={MAX_COMMAND_TEXT_LENGTH} value={draftPrepNote} aria-invalid={saveAttempted && Boolean(mealIssues.prepNote)} aria-describedby={saveAttempted && mealIssues.prepNote ? "meal-prep-note-error" : undefined} onChange={(event) => editRecipeField("prepNote", event.target.value)} /><FieldError id="meal-prep-note-error" message={saveAttempted ? mealIssues.prepNote : undefined} /></label>
          <label><span>Leftover note</span><textarea aria-label="Leftover note" disabled={archived} maxLength={MAX_COMMAND_TEXT_LENGTH} value={draftLeftoverNote} aria-invalid={saveAttempted && Boolean(mealIssues.leftoverNote)} aria-describedby={saveAttempted && mealIssues.leftoverNote ? "meal-leftover-note-error" : undefined} onChange={(event) => editRecipeField("leftoverNote", event.target.value)} /><FieldError id="meal-leftover-note-error" message={saveAttempted ? mealIssues.leftoverNote : undefined} /></label>
        </div>
        <PlannerActionButton tone="primary" type="button" disabled={disabled} onClick={save}><Check size={15} /> Save recipe details</PlannerActionButton>
        <div className="snapshot-section">
          <h3>Schedule and status</h3>
          <div className="inline-control-row">
            <select aria-label={`Meal date for ${meal.title}`} value={draftTargetDate} disabled={disabled} onChange={(event) => { moveDraft.begin(); setTargetDate(event.target.value as IsoDate); }}>{dates.map((date) => <option key={date} value={date}>{formatCalendarDate(date, { weekday: "long", month: "short", day: "numeric" })}</option>)}</select>
            <PlannerActionButton tone="secondary" type="button" disabled={disabled || draftTargetDate === meal.date} onClick={() => void mutate({ type: "moveMeal", weekId: week.id, mealId: meal.id, targetDate: draftTargetDate }, moveDraft.mutationOptions())}>Move meal</PlannerActionButton>
          </div>
          <SegmentedControl
            ariaLabel={`Status for ${meal.title}`}
            className="status-control"
            disabled={(status) => disabled || meal.status === status}
            options={MEAL_STATUSES.map((status) => ({ value: status, label: status }))}
            value={meal.status}
            onChange={(status) => void mutate({ type: "updateMealStatus", weekId: week.id, mealId: meal.id, status })}
          />
        </div>
        <div className="snapshot-section">
          <h3>Instructions</h3>
          <div className="instruction-steps drawer-instruction-steps">
            {meal.instructions.map((step, index) => (
              <StepCard
                key={step.id}
                step={step}
                meal={meal}
                stepNumber={index + 1}
                week={week}
                disabled={disabled}
                mutate={mutate}
                sendContextMessage={sendContextMessage}
                editable={!archived}
                actions={<div className="prep-reference-actions recipe-step-actions">
                  <PlannerIconButton type="button" title={`Move ${stepControlTarget(meal, step, index + 1)} up`} disabled={disabled || index === 0} onClick={() => void mutate({ type: "moveInstructionStep", weekId: week.id, stepId: step.id, targetPosition: index - 1 })}><ArrowUp size={14} /></PlannerIconButton>
                  <PlannerIconButton type="button" title={`Move ${stepControlTarget(meal, step, index + 1)} down`} disabled={disabled || index === meal.instructions.length - 1} onClick={() => void mutate({ type: "moveInstructionStep", weekId: week.id, stepId: step.id, targetPosition: index + 1 })}><ArrowDown size={14} /></PlannerIconButton>
                  <PlannerIconButton tone="attention" type="button" title={`Delete ${stepControlTarget(meal, step, index + 1)}`} disabled={disabled || week.data.prepSessions.some((session) => session.steps.some((entry) => "stepId" in entry ? entry.stepId === step.id : entry.sources.some((source) => source.stepId === step.id)))} onClick={() => void mutate({ type: "removeInstructionStep", weekId: week.id, stepId: step.id })}><Trash2 size={14} /></PlannerIconButton>
                </div>}
              />
            ))}
          </div>
          {!archived ? <div className="instruction-step new-step-form">
            <label className="full-field"><span>Amounts: amount | ingredient</span><textarea aria-label="New amounts" maxLength={MAX_STEP_INPUT_TEXT_LENGTH} value={newInputs} aria-invalid={newStepAttempted && Boolean(newStepIssues.inputs)} aria-describedby={newStepAttempted && newStepIssues.inputs ? "new-step-inputs-error" : undefined} onChange={(event) => { newStepDraft.begin(); setNewInputs(event.target.value); }} /><FieldError id="new-step-inputs-error" message={newStepAttempted ? newStepIssues.inputs : undefined} /></label>
            <label className="full-field"><span>New instruction</span><textarea aria-label="New instruction" maxLength={MAX_COMMAND_TEXT_LENGTH} value={newInstruction} aria-invalid={newStepAttempted && Boolean(newStepIssues.instruction)} aria-describedby={newStepAttempted && newStepIssues.instruction ? "new-step-instruction-error" : undefined} onChange={(event) => { newStepDraft.begin(); setNewInstruction(event.target.value); }} /><FieldError id="new-step-instruction-error" message={newStepAttempted ? newStepIssues.instruction : undefined} /></label>
            <label className="full-field"><span>Timer minutes (optional, up to 1,440)</span><input aria-label="New timer minutes" type="number" min="0.5" max="1440" step="0.5" value={newTimer} aria-invalid={newStepAttempted && Boolean(newStepIssues.timer)} aria-describedby={newStepAttempted && newStepIssues.timer ? "new-step-timer-error" : undefined} onChange={(event) => { newStepDraft.begin(); setNewTimer(event.target.value); }} /><FieldError id="new-step-timer-error" message={newStepAttempted ? newStepIssues.timer : undefined} /></label>
            <PlannerActionButton tone="secondary" type="button" disabled={disabled} onClick={addInstruction}><Plus size={15} /> Add instruction</PlannerActionButton>
          </div> : null}
        </div>
      </div>
      <div className="drawer-footer"><PlannerActionButton tone="secondary" type="button" onClick={onClose}>Close</PlannerActionButton></div>
    </ModalDrawer>
  );
}

function HistoryDrawer(props: {
  workspace: InitializedWorkspace;
  disabled: boolean;
  onUndo: (event: PlannerEvent) => void;
  restoreFocusRef: { current: HTMLElement | null };
  onClose: () => void;
} & AuthorityRecoveryProps) {
  const {
    workspace,
    disabled,
    onUndo,
    restoreFocusRef,
    onClose,
    notice,
    pendingRetryLabel,
    onRetryPending,
    retryDisabled,
    onDiscardPending,
    onDismissNotice,
    offline,
    onReconnect,
  } = props;
  const events = [...workspace.events].sort((left, right) => right.sequence - left.sequence);
  const latest = events[0];
  const canUndo = latest && latest.command.type !== "undoLatest";
  return (
    <ModalDrawer title="Recent changes" className="history-drawer" onClose={onClose} restoreFocusRef={restoreFocusRef}>
      {notice ? (
        <AuthorityNotice
          notice={notice}
          pendingRetryLabel={pendingRetryLabel}
          onRetryPending={onRetryPending}
          retryDisabled={retryDisabled}
          onDiscardPending={onDiscardPending}
          onDismiss={pendingRetryLabel ? undefined : onDismissNotice}
        />
      ) : null}
      {offline ? <OfflineAuthorityNotice onReconnect={onReconnect} /> : null}
      <div className="history-list">
        {!events.length ? <p className="empty-copy">No planner changes yet.</p> : null}
        {events.map((event, index) => (
          <div className="history-entry" key={event.eventId}>
            <span className="actor-mark" data-actor={event.actor.toLowerCase()}>{event.actor === "Codex" ? <Bot size={15} /> : <Home size={15} />}</span>
            <div><strong>{event.summary}</strong><span>{event.changes.join(" · ")}</span><small>{timeLabel(event.occurredAt, workspace.state.householdTimeZone)}</small>
              {index === 0 && canUndo ? <PlannerActionButton tone="quiet" type="button" disabled={disabled} onClick={() => onUndo(event)}><RotateCcw size={13} /> Undo latest change</PlannerActionButton> : null}
            </div>
          </div>
        ))}
      </div>
    </ModalDrawer>
  );
}

function ModalDrawer({
  inline = false,
  title,
  className = "",
  onClose,
  restoreFocusRef,
  children,
}: {
  inline?: boolean;
  title: string;
  className?: string;
  onClose: () => void;
  restoreFocusRef?: { current: HTMLElement | null };
  children: ReactNode;
}) {
  if (inline) {
    return <section className={`drawer ${className}`} aria-label={`${title} recipe`}>
      <div className="drawer-header"><div><p className="eyebrow">Shared workspace</p><h2>{title}</h2></div><PlannerIconButton type="button" title="Back to Week" onClick={onClose}><X size={19} /></PlannerIconButton></div>
      {children}
    </section>;
  }
  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className={`drawer ${className}`}
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocusRef?.current?.focus();
        }}
      >
        <SheetHeader className="drawer-header"><div><p className="eyebrow">Shared workspace</p><SheetTitle>{title}</SheetTitle></div><PlannerIconButton type="button" title="Close" onClick={onClose}><X size={19} /></PlannerIconButton></SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}

function ModalChat({ onClose, restoreFocusRef, children }: { onClose: () => void; restoreFocusRef: { current: HTMLButtonElement | null }; children: ReactNode }) {
  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        side="bottom"
        className="mobile-chat-dialog"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocusRef.current?.focus();
        }}
      >
        <SheetTitle className="sr-only">Codex task</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  );
}
