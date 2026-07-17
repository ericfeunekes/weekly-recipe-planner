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
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

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
  FEEDBACK_VALUES,
  GROCERY_SOURCES,
  LEFTOVER_QUALITIES,
  MEAL_STATUSES,
  type GroceryItem,
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
import { CodexThreadRail } from "./codex-thread-rail";
import { OfflineAuthorityNotice } from "./offline-authority-notice";
import type { PlannerView } from "./planner-view";

type ConnectionState = "loading" | "online" | "offline";
type Notice = { tone: "info" | "warning" | "error"; message: string } | null;
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

type MealSnapshotRecoveryCommand = Extract<HouseholdCommand, { type: "updateMealSnapshot" }>;

function hasExactRecordKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isMealSnapshotRecoveryCommand(value: unknown): value is MealSnapshotRecoveryCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  if (!hasExactRecordKeys(command, ["type", "weekId", "mealId", "changes"]) ||
      command.type !== "updateMealSnapshot" ||
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
    "ingredients",
    "yieldText",
  ])) return false;
  return typeof changes.title === "string" && changes.title.length <= MAX_MEAL_TITLE_LENGTH &&
    typeof changes.subtitle === "string" && changes.subtitle.length <= MAX_MEAL_SUBTITLE_LENGTH &&
    typeof changes.venue === "string" && changes.venue.length <= MAX_MEAL_VENUE_LENGTH &&
    typeof changes.prepNote === "string" && changes.prepNote.length <= MAX_COMMAND_TEXT_LENGTH &&
    typeof changes.leftoverNote === "string" && changes.leftoverNote.length <= MAX_COMMAND_TEXT_LENGTH &&
    typeof changes.notes === "string" && changes.notes.length <= MAX_COMMAND_TEXT_LENGTH &&
    Array.isArray(changes.ingredients) && changes.ingredients.length <= MAX_INGREDIENT_LINES &&
    changes.ingredients.every((ingredient) =>
      typeof ingredient === "string" && ingredient.length <= MAX_INGREDIENT_LINE_LENGTH
    ) &&
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
        (isMealSnapshotRecoveryCommand(operation.editableDraft) ||
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
  moveMeal: "Move meal",
  reorderMeals: "Reorder meals",
  swapMealDays: "Swap meal days",
  updateMealStatus: "Change meal status",
  updateMealSnapshot: "Save recipe details",
  replaceMealRecipeFromSource: "Replace sourced recipe",
  addInstructionStep: "Add recipe step",
  updateInstructionStep: "Save recipe step",
  moveInstructionStep: "Reorder recipe step",
  removeInstructionStep: "Delete recipe step",
  setInstructionStepComplete: "Change recipe step completion",
  updateInstructionStepNote: "Save recipe step note",
  startInstructionTimer: "Start recipe timer",
  pauseInstructionTimer: "Pause recipe timer",
  resetInstructionTimer: "Reset recipe timer",
  setInstructionTimerRemaining: "Set recipe timer",
  createPrepSession: "Create prep session",
  updatePrepSession: "Update prep session",
  movePrepSession: "Reorder prep session",
  removePrepSession: "Remove prep session",
  addPrepSessionStep: "Add prep-session step",
  addPrepSessionSteps: "Add prep-session steps",
  movePrepSessionStep: "Reorder prep-session step",
  movePrepSessionSteps: "Move prep-session steps",
  removePrepSessionStep: "Remove prep-session step",
  setPrepPlan: "Save prep plan",
  movePrepReference: "Reorder prep step",
  reschedulePrepReference: "Reschedule prep step",
  removePrepReference: "Remove prep step",
  moveGroceryItemsToSource: "Move selected groceries",
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
    const resolved = entry ? findStep(week, entry.stepId) : null;
    if (resolved) target = stepControlTarget(resolved.meal, resolved.step, resolved.position + 1);
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
    compose(canonical: T): T {
      return composeCompositeDraft(canonical, compositeDraft);
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
  { id: "tonight", label: "Tonight", icon: CookingPot },
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
const MAX_INGREDIENT_TEXT_LENGTH =
  MAX_INGREDIENT_LINES * (MAX_INGREDIENT_LINE_LENGTH + 1);

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
          <button className="secondary-button" type="button" aria-label={`Retry ${pendingRetryLabel}`} disabled={retryDisabled} onClick={onRetryPending}>
            <RotateCcw size={14} /> Retry action
          </button>
        ) : null}
        {pendingRetryLabel && onDiscardPending ? (
          <button className="text-button" type="button" onClick={onDiscardPending}>Discard retry</button>
        ) : null}
        {!pendingRetryLabel && recoveryActionLabel && onRecoveryAction ? (
          <button className="secondary-button" type="button" disabled={recoveryActionDisabled} onClick={onRecoveryAction}>
            <RotateCcw size={14} /> {recoveryActionLabel}
          </button>
        ) : null}
        {!pendingRetryLabel && onDismiss ? (
          <button className="icon-button" type="button" title="Dismiss" onClick={onDismiss}><X size={16} /></button>
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
    <div className={`segmented-control ${className}`.trim()} role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const optionDisabled = typeof disabled === "function" ? disabled(option.value) : disabled;
        return (
          <button
            key={option.value}
            type="button"
            aria-label={option.ariaLabel}
            aria-pressed={value === option.value}
            className={value === option.value ? "active" : ""}
            disabled={optionDisabled}
            onClick={() => onChange(option.value)}
          >{option.label}</button>
        );
      })}
    </div>
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
          <button
            className="primary-button"
            type="button"
            disabled={busy || candidate.payload === null}
            onClick={onImport}
          >
            {busy ? <LoaderCircle className="spin" size={17} /> : <PackageCheck size={17} />}
            Import browser planner
          </button>
          <button className="secondary-button" type="button" disabled={busy} onClick={onFresh}>
            <Plus size={17} /> Start Fresh
          </button>
        </div>
        {pendingRetryLabel && onRetryPending ? (
          <div className="bootstrap-recovery-actions">
            <button className="text-button" type="button" disabled={busy} onClick={onRetryPending}>
              Retry {pendingRetryLabel.toLowerCase()}
            </button>
            {onDiscardPending ? (
              <button className="text-button" type="button" disabled={busy} onClick={onDiscardPending}>
                Discard retry
              </button>
            ) : null}
          </div>
        ) : onClearLocalRecovery ? (
          <button className="text-button" type="button" disabled={localRecoveryBusy} onClick={onClearLocalRecovery}>
            Review latest plan and clear local recovery
          </button>
        ) : notice?.tone === "error" ? (
          <button className="text-button" type="button" onClick={onRetry}>Retry connection</button>
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
        {error ? <button className="primary-button" type="button" onClick={onRetry}>Retry</button> : null}
      </section>
    </main>
  );
}

export default function PlannerApp() {
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("loading");
  const [initialError, setInitialError] = useState<string | null>(null);
  const [serverOffset, setServerOffset] = useState(0);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [view, setView] = useState<PlannerView>("week");
  const [selectedWeekId, setSelectedWeekId] = useState<WeekId | null>(null);
  const [selectedMealId, setSelectedMealId] = useState<string | null>(null);
  const [recipeSummaryMealId, setRecipeSummaryMealId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [timersOpen, setTimersOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [codexCollapsed, setCodexCollapsed] = useState(false);
  const [codexDraft, setCodexDraft] = useState("");
  const [codexFocusKey, setCodexFocusKey] = useState(0);
  const [plannerPending, setPlannerPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
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
  const serverOffsetRef = useRef(0);
  const workspaceRef = useRef<WorkspaceResponse | null>(null);
  const refreshInFlight = useRef<Promise<boolean> | null>(null);
  const plannerMutationInFlight = useRef(false);
  const pendingRetryRef = useRef<PendingAuthorityRetry[]>([]);
  const pendingRetryVolatileRef = useRef(new Map<string, PendingRetryVolatile>());
  const appContentRef = useRef<HTMLDivElement>(null);
  const chatTriggerRef = useRef<HTMLButtonElement>(null);
  const historyTriggerRef = useRef<HTMLButtonElement>(null);
  const mealTriggerRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const primaryWorkspaceRef = useRef<HTMLElement>(null);

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
        retry.kind === "planner" && retry.request.command.type === "updateMealSnapshot"
      );
      if (pendingMeal?.kind === "planner" && pendingMeal.request.command.type === "updateMealSnapshot") {
        setSelectedWeekId(pendingMeal.request.command.weekId);
        setSelectedMealId(pendingMeal.request.command.mealId);
      }
    } catch (error) {
      const message = errorMessage(error);
      pendingRetryRef.current = [];
      setPendingRetries([]);
      setJournalError(message);
      setNotice({ tone: "error", message });
    }
  }, []);

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
  const selectedMealAvailable = Boolean(
    selectedMealId &&
    workspace?.initialized &&
    (
      workspace.state.weeks.find((item) => item.id === selectedWeekId) ??
      workspace.state.weeks.at(-1)
    )?.data.meals.some((meal) => meal.id === selectedMealId),
  );
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
    : selectedMealAvailable
    ? "meal"
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

  const acceptWorkspace = useCallback((incoming: WorkspaceResponse) => {
    const current = workspaceRef.current;
    if (!shouldAcceptWorkspace(current, incoming)) return;
    workspaceRef.current = incoming;
    setWorkspace(incoming);
    if (incoming.initialized) {
      setSelectedWeekId((selected) => {
        if (selected && incoming.state.weeks.some((week) => week.id === selected)) return selected;
        const now = Date.now() + serverOffsetRef.current;
        const today = isoDateForTimeZone(now, incoming.state.householdTimeZone);
        return (
          incoming.state.activeWeekId ??
          incoming.state.weeks.find((week) => weekContainsDate(week.id, today))?.id ??
          incoming.state.weeks.at(-1)?.id ??
          null
        );
      });
    }
  }, []);

  const refresh = useCallback(async (force = false): Promise<boolean> => {
    if (refreshInFlight.current) {
      const succeeded = await refreshInFlight.current;
      if (!force) return succeeded;
    }
    const task = (async () => {
      try {
        const result = await readWorkspace({ etag: force ? null : etagRef.current });
        if (result.etag) {
          etagRef.current = result.etag;
        }
        if (result.serverDate !== null) {
          const offset = result.serverDate - Date.now();
          serverOffsetRef.current = offset;
          setServerOffset(offset);
        }
        if (result.kind === "workspace") acceptWorkspace(result.workspace);
        setConnection("online");
        setInitialError(null);
        return true;
      } catch (error) {
        if (isAbortError(error)) return false;
        setConnection("offline");
        if (!workspaceRef.current) setInitialError(errorMessage(error));
        return false;
      }
    })().finally(() => {
      refreshInFlight.current = null;
    });
    refreshInFlight.current = task;
    return task;
  }, [acceptWorkspace]);

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
    void refresh(true);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    const interval = window.setInterval(() => setClockNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 2_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(interval);
    };
  }, [refresh]);

  useEffect(() => {
    const element = appContentRef.current as (HTMLDivElement & { inert: boolean }) | null;
    if (!element) return;
    element.inert = activeOverlay !== null;
    return () => {
      element.inert = false;
    };
  }, [activeOverlay]);

  const openMeal = useCallback((mealId: string, trigger: HTMLElement) => {
    mealTriggerRef.current = trigger;
    setHistoryOpen(false);
    setTimersOpen(false);
    setChatOpen(false);
    setRecipeSummaryMealId(null);
    setSelectedMealId(mealId);
  }, []);

  const openRecipeSummary = useCallback((mealId: string, trigger: HTMLElement) => {
    mealTriggerRef.current = trigger;
    setHistoryOpen(false);
    setTimersOpen(false);
    setChatOpen(false);
    setSelectedMealId(null);
    setRecipeSummaryMealId(mealId);
  }, []);

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
  const week =
    initialized.state.weeks.find((item) => item.id === selectedWeekId) ??
    initialized.state.weeks.at(-1) ??
    null;
  const now = clockNow + serverOffset;
  const today = isoDateForTimeZone(now, initialized.state.householdTimeZone);
  const activeTimers = week?.data.meals.flatMap((meal) =>
    meal.instructions
      .filter((step) => step.timerDurationSeconds !== undefined && step.timerStartedAt !== undefined)
      .map((step) => ({ meal, step })),
  ) ?? [];
  const selectedMeal = week?.data.meals.find((meal) => meal.id === selectedMealId) ?? null;
  const recipeSummaryMeal = week?.data.meals.find((meal) => meal.id === recipeSummaryMealId) ?? null;
  const recoveryDraftCommand = plannerRetry?.kind === "planner" &&
      (isMealSnapshotRecoveryCommand(plannerRetry.operation.editableDraft) ||
        isHouseholdCommand(plannerRetry.operation.editableDraft))
    ? plannerRetry.operation.editableDraft
    : plannerRetry?.kind === "planner"
      ? plannerRetry.request.command
      : null;
  const recoveryMealCommand = recoveryDraftCommand?.type === "updateMealSnapshot" &&
      selectedMeal && week &&
      recoveryDraftCommand.weekId === week.id &&
      recoveryDraftCommand.mealId === selectedMeal.id
    ? recoveryDraftCommand
    : null;
  const isReadOnly = connection !== "online" || plannerPending || Boolean(plannerRetry) || week?.status === "archived";
  const progress = week ? progressForWeek(week) : { complete: 0, total: 0 };
  const heading = view === "tonight" ? "Tonight" : view === "closeout" ? "Close out" : `${view[0].toUpperCase()}${view.slice(1)}`;
  const authorityNotice: Notice = pendingRetry
    ? { tone: pendingRetry.tone, message: pendingRetry.message }
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
      <div className="app-shell">
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
                  setSelectedWeekId(event.target.value as WeekId);
                  setSelectedMealId(null);
                }}
              >
                {initialized.state.weeks.map((item) => (
                  <option key={item.id} value={item.id}>{weekLabel(item)}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="header-actions">
            <button ref={historyTriggerRef} className="icon-button" type="button" title="Change history" onClick={() => {
              setSelectedMealId(null);
              setChatOpen(false);
              setTimersOpen(false);
              setHistoryOpen(true);
            }}>
              <List size={19} />
            </button>
            <div className="header-timer-control">
              <button
                className="icon-button"
                type="button"
                title={activeTimers.length ? `${activeTimers.length} active timer${activeTimers.length === 1 ? "" : "s"}` : "Active timers"}
                aria-label={activeTimers.length ? `Active timers: ${activeTimers.length}` : "Active timers"}
                aria-expanded={timersOpen}
                aria-haspopup="dialog"
                onClick={() => {
                  setSelectedMealId(null);
                  setChatOpen(false);
                  setHistoryOpen(false);
                  setTimersOpen((open) => !open);
                }}
              >
                <Clock3 size={19} />
                {activeTimers.length ? <span className="header-timer-count" aria-hidden="true">{activeTimers.length}</span> : null}
              </button>
              {timersOpen ? (
                <div className="header-timer-menu" role="dialog" aria-label="Active timers">
                  <div className="header-timer-menu-heading">
                    <strong>Active timers</strong>
                    <button className="icon-button" type="button" title="Close active timers" aria-label="Close active timers" onClick={() => setTimersOpen(false)}><X size={15} /></button>
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
            {mobile ? <button
              ref={chatTriggerRef}
              className="icon-button mobile-codex-trigger"
              type="button"
              onClick={() => {
                setSelectedMealId(null);
                setHistoryOpen(false);
                setTimersOpen(false);
                setChatOpen((open) => !open);
              }}
              aria-expanded={chatOpen}
              aria-label={chatOpen ? "Close Codex" : "Open Codex"}
              title={chatOpen ? "Close Codex" : "Open Codex"}
            ><ChevronLeft size={19} /></button> : null}
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

        <main className={`app-main ${!mobile && codexCollapsed ? "codex-collapsed" : ""}`}>
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
                  <button
                    className="text-button lifecycle-button"
                    type="button"
                    disabled={connection !== "online" || plannerPending}
                    onClick={() => void mutate(
                      initialized.state.activeWeekId
                        ? { type: "handoffWeek", currentWeekId: initialized.state.activeWeekId, nextWeekId: week.id }
                        : { type: "activateWeek", weekId: week.id },
                    )}
                  >Make active</button>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="workspace">
            <section ref={primaryWorkspaceRef} className="primary-workspace">
              {!week ? (
                <section className="lifecycle-surface empty-workspace">
                  <CalendarDays size={30} />
                  <h2>No weeks yet</h2>
                  <p>Open Codex to build the first week plan.</p>
                </section>
              ) : view === "week" ? (
                  <WeekView
                    week={week}
                    today={today}
                    onOpenMeal={openMeal}
                    onOpenRecipeSummary={openRecipeSummary}
                    onNavigate={navigate}
                  />
                ) : view === "tonight" ? (
                  <TonightView
                    week={week}
                    today={today}
                    disabled={isReadOnly}
                    mutate={mutate}
                    sendContextMessage={sendContextMessage}
                    onOpenMeal={openMeal}
                  />
                ) : view === "prep" ? (
                  <PrepView
                    key={week.id}
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

      {activeOverlay === "meal" && selectedMeal && week ? (
          <MealDrawer
            key={`${selectedMeal.id}:${plannerRetry?.operation.state === "resolved_conflict"
              ? plannerRetry.operation.requestId
              : "stable"}`}
            meal={selectedMeal}
            week={week}
            disabled={isReadOnly}
            mutate={mutate}
            sendContextMessage={sendContextMessage}
            recoveryCommand={recoveryMealCommand}
            onRecoveryDraftChange={updatePlannerRecoveryDraft}
            restoreFocusRef={mealTriggerRef}
            {...plannerAuthorityRecovery}
            onClose={() => {
              setSelectedMealId(null);
              mealTriggerRef.current = null;
            }}
          />
        ) : null}
      {activeOverlay === "recipe-summary" && recipeSummaryMeal && week ? (
          <RecipeSummaryDrawer
            meal={recipeSummaryMeal}
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
            modal
            onClose={() => setChatOpen(false)}
          />
        </ModalChat>
      ) : null}
      </div>
      </ServerOffsetContext.Provider>
    </PlannerVersionContext.Provider>
  );
}

function MealEditorTrigger({
  mealId,
  onOpenMeal,
  className,
  children,
}: {
  mealId: string;
  onOpenMeal: (id: string, trigger: HTMLElement) => void;
  className: string;
  children: ReactNode;
}) {
  return <button className={className} type="button" onClick={(event) => onOpenMeal(mealId, event.currentTarget)}>{children}</button>;
}

function IngredientList({ meal, emptyClassName }: { meal: Meal; emptyClassName?: string }) {
  return meal.ingredients.length ? (
    <ul className="ingredient-list">
      {meal.ingredients.map((item) => <li key={item.id}><Check size={13} /> {[item.amount, item.ingredient].filter(Boolean).join(" ")}</li>)}
    </ul>
  ) : <p className={emptyClassName}>No ingredients listed.</p>;
}

function WeekView({ week, today, onOpenMeal, onOpenRecipeSummary, onNavigate }: {
  week: WeekPlan;
  today: IsoDate;
  onOpenMeal: (id: string, trigger: HTMLElement) => void;
  onOpenRecipeSummary: (id: string, trigger: HTMLElement) => void;
  onNavigate: (view: PlannerView) => void;
}) {
  const dates = Array.from({ length: 7 }, (_, index) => addIsoDateDays(week.id, index));
  return (
    <div className="week-view">
      <div className="week-grid">
        {dates.map((date) => {
          const prepSessions = week.data.prepSessions.filter((session) => session.prepDate === date);
          const prepStepCount = prepSessions.reduce((count, session) => count + session.steps.length, 0);
          const prepLabel = `${prepSessions.length} ${prepSessions.length === 1 ? "batch-prep session" : "batch-prep sessions"} · ${prepStepCount} ${prepStepCount === 1 ? "step" : "steps"}`;
          return (
            <div key={date} className={`day-column ${date === today ? "today" : ""}`}>
              <div className="day-heading">
                <div><span>{dayName(date, "short")}</span>{date === today ? <small>Today</small> : null}</div>
                <strong>{Number(date.slice(-2))}</strong>
              </div>
              {prepSessions.length ? <button className="day-prep-indicator" type="button" aria-label={`Open ${prepLabel}`} onClick={() => onNavigate("prep")}><ListChecks size={13} /><span>Batch prep</span><strong>{prepStepCount}</strong></button> : null}
              {week.data.meals.filter((item) => item.date === date).map((meal) => (
                  <article key={meal.id} className="meal-card" aria-label={`${meal.title} on ${dayName(date)}`}>
                    <span className={`status-badge ${statusTone(meal.status)}`}>{meal.status}</span>
                    <strong className="meal-title">{meal.title}</strong>
                    <span className="meal-subtitle">{meal.subtitle}</span>
                    <span className="meal-meta"><MapPin size={12} /> {meal.venue}</span>
                    {meal.prepNote ? <span className="meal-meta"><CheckCircle2 size={12} /> {meal.prepNote}</span> : null}
                    {meal.leftoverNote ? <span className="meal-leftover"><PackageCheck size={12} /> {meal.leftoverNote}</span> : null}
                    <div className="meal-card-actions">
                      <RecipeSummaryLink className="meal-card-preview" meal={meal} onOpenRecipeSummary={onOpenRecipeSummary}>Open recipe <ChevronRight size={14} /></RecipeSummaryLink>
                      <MealEditorTrigger className="meal-card-editor" mealId={meal.id} onOpenMeal={onOpenMeal}><PencilLine size={14} /> Edit meal</MealEditorTrigger>
                    </div>
                  </article>
              ))}
              {week.data.meals.some((item) => item.date === date) ? null : <div className="meal-card empty-meal" aria-label={`${dayName(date)} has no meals`}><Circle size={19} /><strong className="meal-title">No meals planned</strong><span className="meal-subtitle">Add as many meals as you need.</span></div>}
            </div>
          );
        })}
      </div>
      <div className="mobile-pressure-strip">
        <button type="button" onClick={() => onNavigate("prep")}><ListChecks size={15} /> Prep <strong>{week.data.prepSessions.flatMap((session) => session.steps).filter((entry) => findStep(week, entry.stepId)?.step.complete).length}/{week.data.prepSessions.flatMap((session) => session.steps).length}</strong></button>
        <button type="button" onClick={() => onNavigate("groceries")}><ShoppingBasket size={15} /> Groceries <strong>{week.data.groceries.filter((item) => item.checked).length}/{week.data.groceries.length}</strong></button>
      </div>
    </div>
  );
}

function TonightView(props: {
  week: WeekPlan;
  today: IsoDate;
  disabled: boolean;
  mutate: Mutate;
  sendContextMessage: SendContextMessage;
  onOpenMeal: (id: string, trigger: HTMLElement) => void;
}) {
  const { week, today, disabled, mutate, sendContextMessage, onOpenMeal } = props;
  const meal = week.data.meals.find((item) => item.date === today);
  const assignedLeftover = week.data.leftovers.find(
    (leftover) =>
      leftover.state === "assigned" &&
      leftover.assignedDate === today,
  );
  if (!weekContainsDate(week.id, today)) {
    return (
      <div className="finished-state">
        <CalendarDays size={34} />
        <h3>No dinner in this selected week</h3>
        <p>Select the week containing today or use the week view.</p>
      </div>
    );
  }
  if (assignedLeftover) {
    return (
      <div className="finished-state assigned-leftover">
        <PackageCheck size={34} />
        <p className="eyebrow">{dayName(today)} dinner · leftovers</p>
        <h3>{assignedLeftover.label}</h3>
        <p>{assignedLeftover.portions} portions are assigned to tonight.</p>
        <button
          className="primary-button"
          type="button"
          disabled={disabled}
          onClick={() => void mutate({
            type: "consumeLeftover",
            weekId: week.id,
            leftoverId: assignedLeftover.id,
          })}
        ><Check size={16} /> Mark eaten</button>
      </div>
    );
  }
  if (!meal) {
    return (
      <div className="finished-state">
        <CalendarDays size={34} />
        <h3>No dinner in this selected week</h3>
        <p>Select the week containing today or use the week view.</p>
      </div>
    );
  }
  const complete = meal.instructions.filter((step) => step.complete).length;
  return (
    <div className="tonight-layout">
      <div className="tonight-main">
        <div className="tonight-hero">
          <div>
            <p className="eyebrow">{dayName(today)} dinner · {meal.venue}</p>
            <h2>{meal.title}</h2>
            <p className="meal-subtitle">{meal.subtitle}</p>
            {meal.yieldText ? <p className="recipe-yield">Yield: {meal.yieldText}</p> : null}
            <RecipeSource meal={meal} />
          </div>
          <span className={`status-badge ${statusTone(meal.status)}`}>{meal.status}</span>
        </div>
        <div className="tonight-actions">
          <MealEditorTrigger className="secondary-button" mealId={meal.id} onOpenMeal={onOpenMeal}><PencilLine size={16} /> Edit meal</MealEditorTrigger>
          {meal.status !== "cooking" && meal.status !== "cooked" ? (
            <button className="primary-button" type="button" disabled={disabled} onClick={() => void mutate({ type: "updateMealStatus", weekId: week.id, mealId: meal.id, status: "cooking" })}><Play size={16} /> Start cooking</button>
          ) : null}
          {meal.status !== "cooked" ? (
            <button className="secondary-button" type="button" disabled={disabled} onClick={() => void mutate({ type: "updateMealStatus", weekId: week.id, mealId: meal.id, status: "cooked" })}><Check size={16} /> Mark cooked</button>
          ) : null}
        </div>
        <div className="section-title"><ListChecks size={17} /><h3>Instructions</h3><span>{complete}/{meal.instructions.length} done</span></div>
        <div className="instruction-steps">
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
            />
          ))}
        </div>
      </div>
      <aside className="tonight-side">
        <div className="plain-panel"><div className="section-title"><ShoppingBasket size={16} /><h3>Ingredients</h3></div>
          <IngredientList meal={meal} />
        </div>
        <div className="plain-panel"><div className="section-title"><StickyNote size={16} /><h3>Recipe note</h3></div><p>{meal.notes || "No recipe note."}</p></div>
        <div className="plain-panel leftover-plan"><div className="section-title"><PackageCheck size={16} /><h3>Leftovers</h3></div><strong>{meal.leftoverNote || "No leftover plan."}</strong></div>
      </aside>
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
    <button
      className="icon-button"
      type="button"
      title={`${label} timer`}
      aria-label={`${label} timer for ${controlTarget}`}
      disabled={disabled}
      onClick={() => onAction(action)}
    ><Icon size={14} /></button>
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

function InstructionStepContent({ step }: { step: InstructionStep }) {
  return (
    <div className="instruction-line-content">
      <p className="step-instruction">{step.instruction}</p>
      {step.inputs.length ? <div className="step-inputs">{step.inputs.map((input, index) => <span key={`${input.amount}-${input.ingredient}-${index}`}><strong>{input.amount}</strong> {input.ingredient}</span>)}</div> : null}
    </div>
  );
}

function InstructionStepCommentComposer({
  step,
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
      <button className="secondary-button" type="button" onClick={close}>Cancel</button>
      {step.note ? <button
        className="secondary-button"
        type="button"
        disabled={disabled}
        onClick={() => onUpdateStepNote("", noteDraft.mutationOptions(() => {
          setComment("");
          close();
        }))}
      >Clear comment</button> : null}
      <button
        className="secondary-button"
        type="button"
        disabled={disabled || !comment.trim()}
        aria-label={`Save comment for ${controlTarget}`}
        onClick={() => onUpdateStepNote(comment.trim(), noteDraft.mutationOptions(close))}
      ><StickyNote size={14} /> Save comment</button>
      <button
        className="primary-button"
        type="button"
        disabled={disabled || !comment.trim()}
        aria-label={`Ask Codex about ${controlTarget}`}
        onClick={() => {
          const submittedComment = comment.trim();
          void sendContextMessage(submittedComment).then((accepted) => {
            if (!accepted) return;
            setComment((current) => {
              if (current.trim() !== submittedComment) return current;
              noteDraft.versionRef.current = null;
              close();
              return "";
            });
          });
        }}
      ><Bot size={14} /> Ask Codex</button>
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
      onMouseDown={onMouseDown}
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
        <InstructionStepContent step={step} />
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
  const controlTarget = stepControlTarget(meal, step, stepNumber);
  const [commentOpen, setCommentOpen] = useState(false);
  const [editAttempted, setEditAttempted] = useState(false);
  const canonicalInstructionDraft = {
    inputs: step.inputs.map((input) => `${input.amount} | ${input.ingredient}`).join("\n"),
    instruction: step.instruction,
    timerMinutes: step.timerDurationSeconds ? String(step.timerDurationSeconds / 60) : "",
  };
  const instructionDraft = useVersionedDraft<typeof canonicalInstructionDraft>();
  const {
    inputs: draftInputs,
    instruction: draftInstruction,
    timerMinutes: draftTimerMinutes,
  } = instructionDraft.compose(canonicalInstructionDraft);
  const parsedInputs = draftInputs.split("\n").filter((line) => line.trim()).map((line) => {
    const [amount, ...ingredient] = line.split("|");
    return { amount: amount.trim(), ingredient: ingredient.join("|").trim() };
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
        type: "updateInstructionStep",
        weekId: week.id,
        stepId: step.id,
        changes: { inputs: parsedInputs, instruction: draftInstruction.trim(), timerDurationSeconds: timerSeconds },
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
        {!archived ? <button
          className={`icon-button instruction-comment-trigger ${step.note ? "has-note" : ""}`}
          type="button"
          title={step.note ? "Edit step comment" : "Add step comment"}
          aria-label={`${step.note ? "Edit" : "Add"} comment for ${controlTarget}`}
          aria-expanded={commentOpen}
          disabled={disabled}
          onClick={() => setCommentOpen((current) => !current)}
        ><MessageSquareText size={15} /></button> : null}
      </div>}
    >
      {editable && !archived ? (
        <details className="step-comment">
          <summary aria-label={`Edit ${controlTarget}`}><PencilLine size={14} /> Edit instruction</summary>
          <div className="step-comment-body">
            <label className="full-field"><span>Amounts, one per line: amount | ingredient</span><textarea aria-label={`Amounts for ${controlTarget}`} maxLength={MAX_STEP_INPUT_TEXT_LENGTH} value={draftInputs} aria-invalid={editAttempted && Boolean(editIssues.inputs)} aria-describedby={editAttempted && editIssues.inputs ? inputErrorId : undefined} onChange={(event) => instructionDraft.edit(canonicalInstructionDraft, "inputs", event.target.value)} />{editAttempted && editIssues.inputs ? <small id={inputErrorId} className="field-error" role="alert">{editIssues.inputs}</small> : null}</label>
            <label className="full-field"><span>Instruction</span><textarea aria-label={`Instruction text for ${controlTarget}`} maxLength={MAX_COMMAND_TEXT_LENGTH} value={draftInstruction} aria-invalid={editAttempted && Boolean(editIssues.instruction)} aria-describedby={editAttempted && editIssues.instruction ? instructionErrorId : undefined} onChange={(event) => instructionDraft.edit(canonicalInstructionDraft, "instruction", event.target.value)} />{editAttempted && editIssues.instruction ? <small id={instructionErrorId} className="field-error" role="alert">{editIssues.instruction}</small> : null}</label>
            <label className="full-field"><span>Timer minutes (optional, up to 1,440)</span><input aria-label={`Timer minutes for ${controlTarget}`} type="number" min="0.5" max="1440" step="0.5" value={draftTimerMinutes} aria-invalid={editAttempted && Boolean(editIssues.timer)} aria-describedby={editAttempted && editIssues.timer ? timerErrorId : undefined} onChange={(event) => instructionDraft.edit(canonicalInstructionDraft, "timerMinutes", event.target.value)} />{editAttempted && editIssues.timer ? <small id={timerErrorId} className="field-error" role="alert">{editIssues.timer}</small> : null}</label>
            <button
              className="secondary-button"
              type="button"
              disabled={disabled}
              aria-label={`Save ${controlTarget}`}
              onClick={saveInstruction}
            ><Check size={15} /> Save instruction</button>
          </div>
        </details>
      ) : null}
      {!archived && commentOpen ? <InstructionStepCommentComposer
        step={step}
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
  | { kind: "session"; sessionId: string; entryIds: string[] }
  | null;

type PrepDropInsertion = { sessionId: string; position: number } | null;

function isPrepRowControlTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  return Boolean(element?.closest("button, input, select, label, a, textarea, [data-prep-row-control]"));
}

function parsePrepDragIds(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function PrepSessionStepRow(props: {
  entry: PrepSessionStep;
  sessionId: string;
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
  onDragOver: (event: ReactDragEvent<HTMLElement>, targetPosition: number) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>, targetPosition: number) => void;
}) {
  const {
    entry,
    sessionId,
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
  const dragLabel = `Drag ${selectedEntryIds.length} selected ${selectedEntryIds.length === 1 ? "instruction" : "instructions"} to another prep session`;
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
        onSelect(entry.id, event);
      }}
      leading={selected ? <button
        className="prep-drag-handle"
        type="button"
        draggable={!rowDisabled}
        disabled={rowDisabled}
        aria-label={dragLabel}
        title="Drag selected instructions to another prep date"
        data-prep-row-control
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDragStart={(event) => {
          if (rowDisabled) return;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-prep-session-entries", JSON.stringify(selectedEntryIds));
          event.dataTransfer.setData("text/plain", "prep-session-selection");
          onDragStarted(selectedEntryIds);
        }}
        onDragEnd={onDragEnded}
      ><GripVertical size={17} /></button> : <span className="prep-drag-spacer" aria-hidden="true" />}
      trailing={<div className="prep-overflow">
        <button
          className="icon-button prep-overflow-trigger"
          type="button"
          aria-label={`More options for ${controlTarget}`}
          aria-expanded={menuOpen}
          disabled={rowDisabled}
          onClick={() => setMenuOpen((current) => !current)}
        ><EllipsisVertical size={17} /></button>
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
              runMutation({ type: "removePrepSessionStep", weekId: week.id, sessionId, entryId: entry.id });
            }}
          ><Trash2 size={14} /> Remove from prep</button>
        </div> : null}
      </div>}
    >
      {commentOpen ? <InstructionStepCommentComposer
        step={step}
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

function PrepRecipeSource({
  week,
  disabled,
  selectedMealId,
  onSelectMeal,
  targetSessionLabel,
  selectedStepIds,
  onSelectStep,
  onRecipeStepDragStart,
  onRecipeStepDragEnd,
}: {
  week: WeekPlan;
  disabled: boolean;
  selectedMealId: string;
  onSelectMeal: (mealId: string) => void;
  targetSessionLabel: string | null;
  selectedStepIds: Set<string>;
  onSelectStep: (stepId: string, event: ReactMouseEvent<HTMLElement>) => void;
  onRecipeStepDragStart: (stepId: string) => string[];
  onRecipeStepDragEnd: () => void;
}) {
  const selectedMeal = week.data.meals.find((meal) => meal.id === selectedMealId) ?? week.data.meals[0];
  const selectedCount = selectedMeal?.instructions.filter((step) => selectedStepIds.has(step.id)).length ?? 0;
  return (
    <div className="prep-recipe-source" aria-label="Recipe instructions">
      <p className="eyebrow">Recipe instructions</p>
      <p className="prep-source-help">Choose a recipe, then drag its steps onto a prep date or into {targetSessionLabel ?? "the selected prep session"}.</p>
      <div className="prep-recipe-picker" role="list" aria-label="Recipes">
        {week.data.meals.map((meal) => <button key={meal.id} type="button" className={meal.id === selectedMeal?.id ? "active" : ""} aria-pressed={meal.id === selectedMeal?.id} onClick={() => onSelectMeal(meal.id)}>{meal.title}</button>)}
      </div>
      {selectedMeal ? <div className="prep-recipe-steps">
        <strong>{selectedMeal.title}</strong>
        {selectedCount ? <p className="prep-source-selection-summary"><strong>{selectedCount} selected</strong><span>Drag any selected instruction onto a prep date.</span></p> : null}
        {selectedMeal.instructions.map((step, index) => <button
          key={step.id}
          className={`prep-source-step ${step.complete ? "complete" : ""} ${selectedStepIds.has(step.id) ? "selected" : ""}`}
          type="button"
          draggable={!disabled}
          aria-pressed={selectedStepIds.has(step.id)}
          aria-label={`Drag ${stepControlTarget(selectedMeal, step, index + 1)} into a prep session`}
          onClick={(event) => onSelectStep(step.id, event)}
          onDragStart={(event) => {
            const stepIds = onRecipeStepDragStart(step.id);
            event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData("application/x-prep-recipe-step", step.id);
            event.dataTransfer.setData("application/x-prep-recipe-steps", JSON.stringify(stepIds));
          }}
          onDragEnd={onRecipeStepDragEnd}
        ><GripVertical size={14} /><span>{step.instruction}</span>{step.complete ? <Check size={14} /> : null}</button>)}
      </div> : null}
    </div>
  );
}

function PrepView(props: {
  week: WeekPlan;
  disabled: boolean;
  mutate: Mutate;
  sendContextMessage: SendContextMessage;
  onOpenRecipeSummary: (id: string, trigger: HTMLElement) => void;
}) {
  const { week, disabled, mutate, sendContextMessage, onOpenRecipeSummary } = props;
  const [selectedMealId, setSelectedMealId] = useState(week.data.meals[0]?.id ?? "");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(week.data.prepSessions[0]?.id ?? null);
  const [sessionLabel, setSessionLabel] = useState("");
  const [sessionDate, setSessionDate] = useState("");
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(() => new Set());
  const [entrySelectionAnchorId, setEntrySelectionAnchorId] = useState<string | null>(null);
  const [selectedSourceStepIds, setSelectedSourceStepIds] = useState<Set<string>>(() => new Set());
  const [sourceSelectionAnchorId, setSourceSelectionAnchorId] = useState<string | null>(null);
  const [moveTargetSessionId, setMoveTargetSessionId] = useState("");
  const [dragState, setDragState] = useState<PrepDragState>(null);
  const [dropTargetSessionId, setDropTargetSessionId] = useState<string | null>(null);
  const [dropInsertion, setDropInsertion] = useState<PrepDropInsertion>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const sourceRestoreRef = useRef<HTMLButtonElement>(null);
  const sessionTabListRef = useRef<HTMLDivElement>(null);
  const prepDraft = useVersionedDraft();
  const selectedSession = week.data.prepSessions.find((session) => session.id === selectedSessionId) ?? week.data.prepSessions[0] ?? null;
  const selectedMeal = week.data.meals.find((meal) => meal.id === selectedMealId) ?? week.data.meals[0] ?? null;
  const selectedSessionDateLabel = selectedSession
    ? selectedSession.prepDate
      ? formatCalendarDate(selectedSession.prepDate, { weekday: "short", month: "short", day: "numeric" })
      : "Undated"
    : null;
  const sessionEntries = week.data.prepSessions.flatMap((session) => session.steps);
  const completedEntries = sessionEntries.filter((entry) => findStep(week, entry.stepId)?.step.complete).length;
  const selectedEntryIdsInOrder = selectedSession?.steps.filter((entry) => selectedEntryIds.has(entry.id)).map((entry) => entry.id) ?? [];
  const selectedSourceStepIdsInOrder = selectedMeal?.instructions.filter((step) => selectedSourceStepIds.has(step.id)).map((step) => step.id) ?? [];
  const selectedSessionDropPosition = dropInsertion?.sessionId === selectedSession?.id ? dropInsertion.position : null;
  const prepSessionsByDay = new Map<string, typeof week.data.prepSessions>();
  week.data.prepSessions.forEach((session) => {
    const key = session.prepDate ?? "undated";
    prepSessionsByDay.set(key, [...(prepSessionsByDay.get(key) ?? []), session]);
  });
  const prepSessionDays = [...prepSessionsByDay.entries()].map(([key, sessions]) => ({
    key,
    sessions,
    label: key === "undated" ? "Undated" : formatCalendarDate(key as IsoDate, { weekday: "short", month: "short", day: "numeric" }),
  }));
  const moveTargetSession = week.data.prepSessions.find((session) => session.id === moveTargetSessionId) ?? null;
  const canMoveSelectedEntries = Boolean(
    selectedSession &&
    moveTargetSession &&
    moveTargetSession.id !== selectedSession.id &&
    selectedEntryIdsInOrder.some((entryId) => {
      const entry = selectedSession.steps.find((candidate) => candidate.id === entryId);
      return entry && !moveTargetSession.steps.some((candidate) => candidate.stepId === entry.stepId);
    }),
  );
  const clearEntrySelection = () => {
    setSelectedEntryIds(new Set());
    setEntrySelectionAnchorId(null);
    setMoveTargetSessionId("");
  };
  const clearSourceSelection = () => {
    setSelectedSourceStepIds(new Set());
    setSourceSelectionAnchorId(null);
  };
  const endDrag = () => {
    setDragState(null);
    setDropTargetSessionId(null);
    setDropInsertion(null);
    if (typeof document !== "undefined") document.body.classList.remove("recipe-step-dragging");
  };
  useEffect(() => () => {
    if (typeof document !== "undefined") document.body.classList.remove("recipe-step-dragging");
  }, []);
  const createSession = () => {
    const label = sessionLabel.trim();
    if (!label) return;
    void mutate(
      { type: "createPrepSession", weekId: week.id, label, prepDate: sessionDate ? sessionDate as IsoDate : null },
      prepDraft.mutationOptions(() => { setSessionLabel(""); setSessionDate(""); }),
    );
  };
  const selectSessionEntry = (entryId: string, event: ReactMouseEvent<HTMLElement>) => {
    if (disabled || !selectedSession || isPrepRowControlTarget(event.target)) return;
    const visibleIds = selectedSession.steps.map((entry) => entry.id);
    const additive = event.ctrlKey || event.metaKey;
    const anchorIndex = entrySelectionAnchorId ? visibleIds.indexOf(entrySelectionAnchorId) : -1;
    const itemIndex = visibleIds.indexOf(entryId);
    if (event.shiftKey && anchorIndex >= 0 && itemIndex >= 0) {
      const rangeIds = visibleIds.slice(Math.min(anchorIndex, itemIndex), Math.max(anchorIndex, itemIndex) + 1);
      setSelectedEntryIds((current) => {
        const next = additive ? new Set(current) : new Set<string>();
        rangeIds.forEach((id) => next.add(id));
        return next;
      });
      return;
    }
    setSelectedEntryIds((current) => {
      if (!additive) return new Set([entryId]);
      const next = new Set(current);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
    setEntrySelectionAnchorId(entryId);
  };
  const selectSourceStep = (stepId: string, event: ReactMouseEvent<HTMLElement>) => {
    if (disabled || !selectedMeal) return;
    const visibleIds = selectedMeal.instructions.map((step) => step.id);
    const additive = event.ctrlKey || event.metaKey;
    const anchorIndex = sourceSelectionAnchorId ? visibleIds.indexOf(sourceSelectionAnchorId) : -1;
    const itemIndex = visibleIds.indexOf(stepId);
    if (event.shiftKey && anchorIndex >= 0 && itemIndex >= 0) {
      const rangeIds = visibleIds.slice(Math.min(anchorIndex, itemIndex), Math.max(anchorIndex, itemIndex) + 1);
      setSelectedSourceStepIds((current) => {
        const next = additive ? new Set(current) : new Set<string>();
        rangeIds.forEach((id) => next.add(id));
        return next;
      });
      return;
    }
    setSelectedSourceStepIds((current) => {
      if (!additive) return new Set([stepId]);
      const next = new Set(current);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
    setSourceSelectionAnchorId(stepId);
  };
  const addSteps = (sessionId: string, stepIds: string[], targetPosition: number) => {
    const session = week.data.prepSessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    const absentStepIds = stepIds.filter((stepId) => findStep(week, stepId) && !session.steps.some((entry) => entry.stepId === stepId));
    if (!absentStepIds.length) return;
    void mutate(
      { type: "addPrepSessionSteps", weekId: week.id, sessionId, stepIds: absentStepIds, targetPosition },
      { onAccepted: clearSourceSelection },
    );
  };
  const moveEntries = (sourceSessionId: string, sessionId: string, entryIds: string[], targetPosition: number) => {
    const source = week.data.prepSessions.find((candidate) => candidate.id === sourceSessionId);
    const destination = week.data.prepSessions.find((candidate) => candidate.id === sessionId);
    if (!source || !destination) return;
    const candidates = source.steps.filter((entry) => entryIds.includes(entry.id));
    const movableEntryIds = source === destination
      ? candidates.map((entry) => entry.id)
      : candidates.filter((entry) => !destination.steps.some((candidate) => candidate.stepId === entry.stepId)).map((entry) => entry.id);
    if (!movableEntryIds.length) return;
    void mutate(
      { type: "movePrepSessionSteps", weekId: week.id, sourceSessionId, sessionId, entryIds: movableEntryIds, targetPosition },
      {
        onAccepted: () => {
          clearEntrySelection();
          setSelectedSessionId(sessionId);
        },
      },
    );
  };
  const selectAllSessionEntries = () => {
    if (!selectedSession?.steps.length) return;
    setSelectedEntryIds(new Set(selectedSession.steps.map((entry) => entry.id)));
    setEntrySelectionAnchorId(selectedSession.steps[0]?.id ?? null);
  };
  const moveSelectedEntries = () => {
    if (!selectedSession || !moveTargetSession || !canMoveSelectedEntries) return;
    moveEntries(selectedSession.id, moveTargetSession.id, selectedEntryIdsInOrder, moveTargetSession.steps.length);
  };
  const removeSelectedSession = () => {
    if (!selectedSession) return;
    const sessionIndex = week.data.prepSessions.findIndex((session) => session.id === selectedSession.id);
    clearEntrySelection();
    setSelectedSessionId(week.data.prepSessions[sessionIndex + 1]?.id ?? week.data.prepSessions[sessionIndex - 1]?.id ?? null);
    void mutate({ type: "removePrepSession", weekId: week.id, sessionId: selectedSession.id });
  };
  const scrollSessionTabs = (distance: number) => {
    sessionTabListRef.current?.scrollBy({ left: distance, behavior: "smooth" });
  };
  const dragHasRecipeSteps = (event: ReactDragEvent<HTMLElement>) =>
    !disabled && (dragState?.kind === "recipe" || Array.from(event.dataTransfer.types).includes("application/x-prep-recipe-step"));
  const dragHasSessionEntries = (event: ReactDragEvent<HTMLElement>) =>
    !disabled && (dragState?.kind === "session" || Array.from(event.dataTransfer.types).includes("application/x-prep-session-entries"));
  const isPrepDrag = (event: ReactDragEvent<HTMLElement>) => dragHasRecipeSteps(event) || dragHasSessionEntries(event);
  const dragRecipeStepIds = (event: ReactDragEvent<HTMLElement>) =>
    dragState?.kind === "recipe"
      ? dragState.stepIds
      : parsePrepDragIds(event.dataTransfer.getData("application/x-prep-recipe-steps")).length
        ? parsePrepDragIds(event.dataTransfer.getData("application/x-prep-recipe-steps"))
        : [event.dataTransfer.getData("application/x-prep-recipe-step")].filter(Boolean);
  const dragSessionEntries = (event: ReactDragEvent<HTMLElement>) =>
    dragState?.kind === "session"
      ? dragState
      : { kind: "session" as const, sessionId: selectedSession?.id ?? "", entryIds: parsePrepDragIds(event.dataTransfer.getData("application/x-prep-session-entries")) };
  const receivePrepDrop = (event: ReactDragEvent<HTMLElement>, sessionId: string, targetPosition: number) => {
    if (!isPrepDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (dragHasRecipeSteps(event)) addSteps(sessionId, dragRecipeStepIds(event), targetPosition);
    else {
      const sessionDrag = dragSessionEntries(event);
      if (sessionDrag.sessionId) moveEntries(sessionDrag.sessionId, sessionId, sessionDrag.entryIds, targetPosition);
    }
    setSelectedSessionId(sessionId);
    endDrag();
  };
  const receivePrepDropOnDate = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isPrepDrag(event)) return;
    const targetTab = Array.from(sessionTabListRef.current?.querySelectorAll<HTMLButtonElement>(".prep-session-tab") ?? [])
      .find((tab) => {
        const bounds = tab.getBoundingClientRect();
        return event.clientX >= bounds.left && event.clientX <= bounds.right;
      });
    const sessionId = targetTab?.dataset.prepSessionId;
    const session = sessionId ? week.data.prepSessions.find((candidate) => candidate.id === sessionId) : null;
    if (!session) return;
    receivePrepDrop(event, session.id, session.steps.length);
  };
  const startRecipeStepDrag = (stepId: string) => {
    const stepIds = selectedSourceStepIds.has(stepId) && selectedSourceStepIdsInOrder.length ? selectedSourceStepIdsInOrder : [stepId];
    setDragState({ kind: "recipe", stepIds });
    if (typeof document !== "undefined") document.body.classList.add("recipe-step-dragging");
    return stepIds;
  };
  const startSessionDrag = (entryIds: string[]) => {
    if (!selectedSession) return;
    setDragState({ kind: "session", sessionId: selectedSession.id, entryIds });
  };
  const changeSession = (sessionId: string) => {
    clearEntrySelection();
    setSelectedSessionId(sessionId);
  };
  return (
    <div className="list-surface">
      <div className="surface-summary">
        <div><p className="eyebrow">Active-week batch work</p><h2>Prep sessions</h2></div>
        <div className="surface-summary-actions">
          <span className="summary-chip"><CheckCircle2 size={14} /> {completedEntries}/{sessionEntries.length} done</span>
        </div>
      </div>
      {week.status !== "archived" ? (
        <div className="prep-session-create">
          <input aria-label="Prep session name" maxLength={MAX_COMMAND_TEXT_LENGTH} placeholder="Session name, e.g. Sunday batch" value={sessionLabel} onChange={(event) => { prepDraft.begin(); setSessionLabel(event.target.value); }} />
          <input aria-label="Prep session date" type="date" value={sessionDate} onChange={(event) => { prepDraft.begin(); setSessionDate(event.target.value); }} />
          <button className="secondary-button" type="button" disabled={disabled || !sessionLabel.trim()} onClick={createSession}><Plus size={15} /> New session</button>
        </div>
      ) : null}
      <div className="prep-session-workspace">
        <div className="prep-session-list">
          {week.data.prepSessions.length ? <>
            <nav className="prep-session-day-schedule" aria-label="Batch prep planned days">
              <span className="prep-session-day-schedule-label"><CalendarDays size={14} /> Prep planned</span>
              <div className="prep-session-day-schedule-days">
                {prepSessionDays.map((day) => {
                  const selected = day.sessions.some((session) => session.id === selectedSession?.id);
                  const sessionCount = day.sessions.length;
                  return <button
                    key={day.key}
                    className={`prep-session-day${selected ? " active" : ""}`}
                    type="button"
                    aria-label={`Open ${sessionCount} prep ${sessionCount === 1 ? "session" : "sessions"} planned for ${day.label}`}
                    onClick={() => changeSession(day.sessions[0]!.id)}
                  ><span>{day.label}</span><strong>{sessionCount}</strong></button>;
                })}
              </div>
            </nav>
            <div className="prep-session-tabs">
              <div className="prep-session-tab-navigation">
                <button className="icon-button prep-session-tab-scroll" type="button" aria-label="Scroll prep sessions earlier" title="Earlier prep sessions" onClick={() => scrollSessionTabs(-240)}><ChevronLeft size={15} /></button>
                <div
                  ref={sessionTabListRef}
                  className="prep-session-tablist"
                  role="tablist"
                  aria-label="Prep sessions"
                  onDragOver={(event) => {
                    if (!isPrepDrag(event)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = dragHasRecipeSteps(event) ? "copy" : "move";
                  }}
                  onDrop={receivePrepDropOnDate}
                >
                  {week.data.prepSessions.map((session) => {
                    const selected = session.id === selectedSession?.id;
                    const dateLabel = session.prepDate ? formatCalendarDate(session.prepDate, { weekday: "short", month: "short", day: "numeric" }) : "Undated";
                    return <button
                      key={session.id}
                      id={`prep-session-tab-${session.id}`}
                      className={`prep-session-tab${selected ? " active" : ""}${dropTargetSessionId === session.id ? " drop-target" : ""}`}
                      type="button"
                      role="tab"
                      data-prep-session-id={session.id}
                      aria-label={`${session.label} · ${dateLabel} · ${session.steps.length} ${session.steps.length === 1 ? "step" : "steps"}`}
                      aria-selected={selected}
                      aria-controls={`prep-session-panel-${session.id}`}
                      onClick={() => changeSession(session.id)}
                      onDragEnter={(event) => {
                        if (isPrepDrag(event)) setDropTargetSessionId(session.id);
                      }}
                      onDragOver={(event) => {
                        if (!isPrepDrag(event)) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = dragHasRecipeSteps(event) ? "copy" : "move";
                        setDropTargetSessionId(session.id);
                      }}
                      onDrop={(event) => receivePrepDrop(event, session.id, session.steps.length)}
                    ><span>{dateLabel}</span></button>;
                  })}
                </div>
                <button className="icon-button prep-session-tab-scroll" type="button" aria-label="Scroll prep sessions later" title="Later prep sessions" onClick={() => scrollSessionTabs(240)}><ChevronRight size={15} /></button>
              </div>
              <div className="prep-session-actions">
                <button ref={sourceRestoreRef} className="secondary-button prep-session-add-steps" type="button" disabled={disabled || !week.data.meals.length || !selectedSession} title={selectedSessionDateLabel ? `Add recipe steps to ${selectedSessionDateLabel}` : "Choose a prep session first"} aria-label={selectedSessionDateLabel ? `Add recipe steps to ${selectedSessionDateLabel}` : "Choose a prep session first"} onClick={() => setSourceOpen(true)}><ListChecks size={15} /> Add steps</button>
                {selectedSession ? <button className="secondary-button prep-session-select-all" type="button" disabled={disabled || !selectedSession.steps.length} aria-label={`Select all ${selectedSession.steps.length} prep ${selectedSession.steps.length === 1 ? "step" : "steps"}`} onClick={selectAllSessionEntries}><ListChecks size={15} /> Select all</button> : null}
                {!disabled && selectedSession ? <button className="icon-button danger prep-session-tab-delete" type="button" title={`Delete ${selectedSession.label}`} aria-label={`Delete ${selectedSession.label}`} onClick={removeSelectedSession}><Trash2 size={15} /></button> : null}
              </div>
            </div>
            {selectedSession ? <section
              id={`prep-session-panel-${selectedSession.id}`}
              className={`prep-session${dropTargetSessionId === selectedSession.id ? " drop-target" : ""}`}
              role="tabpanel"
              aria-labelledby={`prep-session-tab-${selectedSession.id}`}
              onDragOver={(event) => {
                if (!isPrepDrag(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = dragHasRecipeSteps(event) ? "copy" : "move";
                setDropTargetSessionId(selectedSession.id);
                setDropInsertion({ sessionId: selectedSession.id, position: selectedSession.steps.length });
              }}
              onDrop={(event) => {
                receivePrepDrop(event, selectedSession.id, selectedSession.steps.length);
              }}
            >
              {selectedEntryIdsInOrder.length ? <div className="prep-selection-summary" role="status"><strong>{selectedEntryIdsInOrder.length} selected</strong><span>Drag, or move them together.</span><select className="prep-selection-move-target" aria-label="Move selected prep steps to" value={moveTargetSessionId} onChange={(event) => setMoveTargetSessionId(event.target.value)}><option value="">Move to…</option>{week.data.prepSessions.filter((session) => session.id !== selectedSession.id).map((session) => <option key={session.id} value={session.id}>{session.prepDate ? formatCalendarDate(session.prepDate, { weekday: "short", month: "short", day: "numeric" }) : "Undated"}</option>)}</select><button className="secondary-button prep-selection-move" type="button" disabled={disabled || !canMoveSelectedEntries} aria-label="Move selected prep steps" onClick={moveSelectedEntries}>Move</button><button className="text-button" type="button" onClick={clearEntrySelection}>Clear</button></div> : null}
              <div className="prep-step-list">
                {selectedSession.steps.map((entry, index) => {
                const resolved = findStep(week, entry.stepId);
                if (!resolved) return null;
                return <div key={entry.id} className="prep-queue-row-wrap">
                  {selectedSessionDropPosition === index ? <div className="prep-insertion-indicator" role="presentation" /> : null}
                  <PrepSessionStepRow
                    entry={entry}
                    sessionId={selectedSession.id}
                    step={resolved.step}
                    meal={resolved.meal}
                    stepNumber={resolved.position + 1}
                    queuePosition={index}
                    week={week}
                    disabled={disabled}
                    mutate={mutate}
                    sendContextMessage={sendContextMessage}
                    onOpenRecipeSummary={onOpenRecipeSummary}
                    selected={selectedEntryIds.has(entry.id)}
                    selectedEntryIds={selectedEntryIdsInOrder}
                    dragState={dragState}
                    onSelect={selectSessionEntry}
                    onDragStarted={startSessionDrag}
                    onDragEnded={endDrag}
                    onDragOver={(event, targetPosition) => {
                      if (!isPrepDrag(event)) return;
                      event.preventDefault();
                      event.stopPropagation();
                      event.dataTransfer.dropEffect = dragHasRecipeSteps(event) ? "copy" : "move";
                      setDropTargetSessionId(selectedSession.id);
                      setDropInsertion({ sessionId: selectedSession.id, position: targetPosition });
                    }}
                    onDrop={(event, targetPosition) => receivePrepDrop(event, selectedSession.id, targetPosition)}
                  />
                </div>;
              })}
                {selectedSessionDropPosition === selectedSession.steps.length ? <div className="prep-insertion-indicator" role="presentation" /> : null}
                {!selectedSession.steps.length ? <p className="empty-copy">Drag recipe instructions here.</p> : null}
              </div>
            </section> : null}
          </> : null}
          {!week.data.prepSessions.length ? <p className="empty-copy">Create a prep session, then drag recipe instructions into it.</p> : null}
        </div>
      </div>
      {sourceOpen && typeof document !== "undefined" ? createPortal(<aside className="prep-source-window" role="dialog" aria-label="Recipe instructions">
        <header className="prep-source-window-heading">
          <div><p className="eyebrow">Batch prep</p><h3>Recipe instructions</h3></div>
          <button className="icon-button" type="button" title="Close recipe steps" aria-label="Close recipe steps" onClick={() => setSourceOpen(false)}><X size={16} /></button>
        </header>
        <PrepRecipeSource
          week={week}
          disabled={disabled}
          selectedMealId={selectedMealId}
          onSelectMeal={(mealId) => { clearSourceSelection(); setSelectedMealId(mealId); }}
          targetSessionLabel={selectedSessionDateLabel}
          selectedStepIds={selectedSourceStepIds}
          onSelectStep={selectSourceStep}
          onRecipeStepDragStart={startRecipeStepDrag}
          onRecipeStepDragEnd={endDrag}
        />
      </aside>, document.body) : null}
    </div>
  );
}

const GROCERY_SOURCE_LABELS = {
  shop: "Shop",
  farm_box: "Farm box",
  on_hand: "On hand",
} as const;

type GroceryFilter = "to_buy" | "all" | "shop" | "farm_box" | "on_hand" | "done";

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
  const [bulkSource, setBulkSource] = useState<GroceryItem["source"] | "">("");
  const [draggingSelection, setDraggingSelection] = useState(false);
  const [dragTarget, setDragTarget] = useState<GroceryItem["source"] | null>(null);
  const [moveNotice, setMoveNotice] = useState<{ source: GroceryItem["source"]; count: number } | null>(null);
  const visible = week.data.groceries.filter((entry) => {
    if (filter === "all") return true;
    if (filter === "done") return entry.checked;
    if (filter === "to_buy") return !entry.checked && entry.source === "shop";
    if (filter === "shop") return entry.source === "shop";
    return entry.source === filter;
  });
  const selectedGroceries = week.data.groceries.filter((entry) => selectedIds.has(entry.id));
  const visibleIdsInDisplayOrder = GROCERY_SECTIONS.flatMap((group) =>
    visible.filter((entry) => entry.section === group).map((entry) => entry.id),
  );
  const clearSelection = () => {
    setSelectedIds(new Set());
    setSelectionAnchorId(null);
    setBulkSource("");
  };
  const closeSelectionMode = () => {
    clearSelection();
    setSelectionMode(false);
    setDraggingSelection(false);
    setDragTarget(null);
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
  const moveGroceriesToSource = (itemIds: string[], nextSource: GroceryItem["source"]) => {
    if (!itemIds.length) return;
    void mutate(
      {
        type: "moveGroceryItemsToSource",
        weekId: week.id,
        itemIds,
        source: nextSource,
      },
      {
        onAccepted: () => {
          setMoveNotice({ source: nextSource, count: itemIds.length });
          clearSelection();
          setDraggingSelection(false);
          setDragTarget(null);
        },
      },
    );
  };
  const moveSelectedToSource = (nextSource: GroceryItem["source"]) => {
    const itemIds = selectedGroceries
      .filter((entry) => entry.source !== nextSource)
      .map((entry) => entry.id);
    moveGroceriesToSource(itemIds, nextSource);
  };
  return (
    <div className="grocery-layout">
      <div className={`grocery-list ${selectionMode ? "selection-mode" : ""}`}>
        <div className="surface-summary grocery-summary">
          <div><p className="eyebrow">This week&apos;s recipes</p><h2>Recipe ingredients</h2><p className="grocery-list-description">Only ingredients connected to this week’s dinners belong here.</p></div>
          <div className="grocery-summary-controls">
            <SegmentedControl
              ariaLabel="Grocery filter"
              options={GROCERY_FILTERS}
              value={filter}
              onChange={(value) => { clearSelection(); setMoveNotice(null); setFilter(value); }}
            />
            <button className="secondary-button grocery-selection-toggle" type="button" aria-pressed={selectionMode} onClick={() => selectionMode ? closeSelectionMode() : setSelectionMode(true)}>
              <ListChecks size={15} /> {selectionMode ? "Cancel" : "Move items"}
            </button>
          </div>
        </div>
        {selectionMode ? <div className="grocery-bulk-actions" aria-label="Bulk grocery actions" data-testid="grocery-bulk-actions">
          <div className="grocery-selection-summary"><strong>{selectedGroceries.length} selected</strong><span>Click an ingredient row to select it. Drag a selected item to a source tab, or choose a source below.</span></div>
          <div className="grocery-source-targets" aria-label="Grocery source tabs">
            {GROCERY_SOURCES.map((targetSource) => {
              const canMove = selectedGroceries.some((entry) => entry.source !== targetSource);
              return <button
                key={targetSource}
                className={draggingSelection && dragTarget === targetSource ? "drag-over" : ""}
                data-testid={`grocery-source-target-${targetSource}`}
                disabled={disabled || !canMove}
                type="button"
                onClick={() => moveSelectedToSource(targetSource)}
                onDragOver={(event) => {
                  if (!draggingSelection || disabled || !canMove) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDragTarget(targetSource);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (!disabled && canMove) moveSelectedToSource(targetSource);
                  setDraggingSelection(false);
                  setDragTarget(null);
                }}
                title={`Move selected groceries to ${GROCERY_SOURCE_LABELS[targetSource]}`}
              >{GROCERY_SOURCE_LABELS[targetSource]}</button>;
            })}
          </div>
          <div className="grocery-bulk-dropdown">
            <select value={bulkSource} aria-label="Move selected groceries to source" onChange={(event) => setBulkSource(event.target.value as GroceryItem["source"] | "")}>
              <option value="">Move to source…</option>
              {GROCERY_SOURCES.map((targetSource) => <option key={targetSource} value={targetSource}>{GROCERY_SOURCE_LABELS[targetSource]}</option>)}
            </select>
            <button className="secondary-button" type="button" disabled={disabled || !bulkSource || !selectedGroceries.some((entry) => entry.source !== bulkSource)} onClick={() => bulkSource && moveSelectedToSource(bulkSource)}>Move</button>
          </div>
        </div> : null}
        {moveNotice ? <div className="grocery-move-notice" role="status" data-testid="grocery-move-notice">
          <span>Moved {moveNotice.count} {moveNotice.count === 1 ? "ingredient" : "ingredients"} to {GROCERY_SOURCE_LABELS[moveNotice.source]}.</span>
          <button type="button" className="text-button" onClick={() => { setFilter(moveNotice.source); setMoveNotice(null); }}>View {GROCERY_SOURCE_LABELS[moveNotice.source]}</button>
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
                        <select
                          className="grocery-source-select"
                          value={entry.source}
                          disabled={disabled}
                          aria-label={`Source for ${item}`}
                          data-grocery-row-control
                          onMouseDown={(event) => event.stopPropagation()}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => moveGroceriesToSource([entry.id], event.target.value as GroceryItem["source"])}
                      >
                          {GROCERY_SOURCES.map((value) => <option key={value} value={value}>{GROCERY_SOURCE_LABELS[value]}</option>)}
                        </select>
                      </div>
                      <div className="grocery-recipe-links"><span>For</span><RecipeSummaryLink meal={linkedMeal} onOpenRecipeSummary={onOpenRecipeSummary} /></div>
                    </div>
                    {selectionMode ? selectedIds.has(entry.id) ? <button
                      className="icon-button grocery-drag-handle"
                      type="button"
                      draggable={!disabled}
                      disabled={disabled}
                      aria-label={`Drag ${selectedGroceries.length} selected ${selectedGroceries.length === 1 ? "grocery" : "groceries"} to a source tab`}
                      title="Drag selected groceries to Shop, Farm box, or On hand"
                      data-grocery-row-control
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={(event) => event.stopPropagation()}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", "grocery-selection");
                        setDraggingSelection(true);
                      }}
                      onDragEnd={() => {
                        setDraggingSelection(false);
                        setDragTarget(null);
                      }}
                    ><GripVertical size={15} /></button> : <span className="grocery-drag-spacer" aria-hidden="true" /> : null}
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
  const [targets, setTargets] = useState<Record<string, IsoDate>>({});
  const assignmentDraft = useVersionedDraft();
  return (
    <div className="leftover-feedback">
      {week.data.leftovers.map((leftover) => {
        const source = week.data.meals.find((meal) => meal.id === leftover.sourceMealId);
        const dates = Array.from({ length: 7 }, (_, index) => addIsoDateDays(week.id, index)).filter((date) => !source || date > source.date);
        const target = targets[leftover.id] ?? dates[0];
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
            {leftover.state === "available" && dates.length ? (
              <div className="inline-control-row">
                <select aria-label={`Dinner date for ${leftover.label} leftovers`} value={target} disabled={disabled} onChange={(event) => { assignmentDraft.begin(); setTargets((current) => ({ ...current, [leftover.id]: event.target.value as IsoDate })); }}>{dates.map((date) => <option key={date} value={date}>{formatCalendarDate(date, { weekday: "short", month: "short", day: "numeric" })}</option>)}</select>
                <button className="secondary-button" type="button" aria-label={`Assign ${leftover.label} leftovers`} disabled={disabled} onClick={() => void mutate({ type: "assignLeftover", weekId: week.id, leftoverId: leftover.id, targetDate: target }, assignmentDraft.mutationOptions())}>Assign</button>
              </div>
            ) : null}
            {leftover.state === "assigned" ? <button className="secondary-button" type="button" aria-label={`Mark ${leftover.label} leftovers eaten`} disabled={disabled} onClick={() => void mutate({ type: "consumeLeftover", weekId: week.id, leftoverId: leftover.id })}><Check size={15} /> Mark eaten</button> : null}
          </div>
        );
      })}
      {!week.data.leftovers.length ? <p className="empty-copy">Cooking a meal with planned leftovers will add it here.</p> : null}
    </div>
  );
}

function CloseoutView({ week, disabled, mutate }: { week: WeekPlan; disabled: boolean; mutate: Mutate }) {
  const [lesson, setLesson] = useState(week.data.weekLesson);
  const lessonDraft = useVersionedDraft();
  const draftLesson = lessonDraft.versionRef.current === null
    ? week.data.weekLesson
    : lesson;
  const feedbackComplete = week.data.meals.filter((meal) => week.data.feedback[meal.id]).length;
  if (week.status === "archived") {
    return (
      <div className="lifecycle-surface current-archive">
        <span className="archive-icon"><Archive size={24} /></span>
        <p className="eyebrow">Read-only record</p><h2>Week archived</h2>
        <div className="archive-stats"><span><strong>{week.data.meals.length}</strong> meals</span><span><strong>{feedbackComplete}</strong> ratings</span><span><strong>{week.data.leftovers.length}</strong> leftovers</span></div>
        {week.data.weekLesson ? <div className="lesson-band"><StickyNote size={16} /><span><strong>Planning lesson</strong><p>{week.data.weekLesson}</p></span></div> : null}
      </div>
    );
  }
  return (
    <div className="closeout-layout">
      <div className="feedback-list">
        <div className="surface-summary"><div><p className="eyebrow">Keep the useful signal</p><h2>Family feedback</h2></div><span className="summary-chip">{feedbackComplete}/{week.data.meals.length} rated</span></div>
        {week.data.meals.map((meal) => (
          <div className="feedback-row" key={meal.id}>
            <div><strong>{meal.title}</strong><small>{formatCalendarDate(meal.date, { weekday: "long" })} · {meal.status}</small></div>
            <SegmentedControl
              ariaLabel={`Feedback for ${meal.title}`}
              className="feedback-control"
              disabled={disabled}
              options={FEEDBACK_VALUES.map((value) => ({ value, label: value, ariaLabel: `Rate ${meal.title} ${value}` }))}
              value={week.data.feedback[meal.id]}
              onChange={(value) => void mutate({ type: "captureFeedback", weekId: week.id, mealId: meal.id, value })}
            />
          </div>
        ))}
      </div>
      <aside className="closeout-notes">
        <label><span>What should next week remember?</span><textarea maxLength={MAX_COMMAND_TEXT_LENGTH} value={draftLesson} onChange={(event) => { lessonDraft.begin(); setLesson(event.target.value); }} placeholder="A short planning lesson" /><small className="field-limit">{draftLesson.length.toLocaleString("en-CA")}/{MAX_COMMAND_TEXT_LENGTH.toLocaleString("en-CA")}</small></label>
        <button className="secondary-button" type="button" disabled={disabled || draftLesson === week.data.weekLesson} onClick={() => void mutate({ type: "captureWeekLesson", weekId: week.id, weekLesson: draftLesson }, lessonDraft.mutationOptions())}><StickyNote size={15} /> Save lesson</button>
        <span className="field-label">Leftovers</span>
        <LeftoverControls week={week} disabled={disabled} mutate={mutate} />
        <span className="closeout-check"><CheckCircle2 size={14} /> Archiving freezes this week as a read-only family record.</span>
        <button className="primary-button" type="button" disabled={disabled || week.status !== "active"} onClick={() => void mutate({ type: "archiveWeek", weekId: week.id })}><Archive size={16} /> Archive active week</button>
      </aside>
    </div>
  );
}

function RecipeSource({ meal }: { meal: Meal }) {
  if (!meal.sourceRecipe) return null;
  return (
    <p className="recipe-source">
      <span>Informational recipe source</span>
      <a href={meal.sourceRecipe.url} target="_blank" rel="noopener noreferrer">
        {meal.sourceRecipe.identity}
      </a>
    </p>
  );
}

function RecipeSummaryDrawer({
  meal,
  restoreFocusRef,
  onClose,
}: {
  meal: Meal;
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
          <IngredientList meal={meal} emptyClassName="recipe-summary-copy" />
        </section>

        <section className="snapshot-section">
          <div className="section-title"><CookingPot size={16} /><h3>Instructions</h3><span>{meal.instructions.length} steps</span></div>
          {meal.instructions.length ? (
            <ol className="recipe-summary-steps">
              {meal.instructions.map((step, index) => (
                <li key={step.id} className="recipe-summary-step">
                  <span className="recipe-summary-step-number" aria-hidden="true">{index + 1}</span>
                  <div>
                    <InstructionStepContent step={step} />
                    {step.timerDurationSeconds ? <small className="recipe-summary-timer">Timer: {Math.ceil(step.timerDurationSeconds / 60)} min</small> : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : <p className="recipe-summary-copy">No instructions listed.</p>}
        </section>

        {meal.notes ? <section className="snapshot-section"><div className="section-title"><StickyNote size={16} /><h3>Recipe note</h3></div><p className="recipe-summary-copy">{meal.notes}</p></section> : null}
        {meal.prepNote ? <section className="snapshot-section"><div className="section-title"><ListChecks size={16} /><h3>Prep note</h3></div><p className="recipe-summary-copy">{meal.prepNote}</p></section> : null}
        {meal.leftoverNote ? <section className="snapshot-section"><div className="section-title"><PackageCheck size={16} /><h3>Leftovers</h3></div><p className="recipe-summary-copy">{meal.leftoverNote}</p></section> : null}
      </div>
      <div className="drawer-footer"><button className="secondary-button" type="button" onClick={onClose}>Close</button></div>
    </ModalDrawer>
  );
}

function MealDrawer(props: {
  meal: Meal;
  week: WeekPlan;
  disabled: boolean;
  mutate: Mutate;
  sendContextMessage: SendContextMessage;
  recoveryCommand: Extract<HouseholdCommand, { type: "updateMealSnapshot" }> | null;
  onRecoveryDraftChange: (
    command: Extract<HouseholdCommand, { type: "updateMealSnapshot" }>,
  ) => void;
  restoreFocusRef: { current: HTMLElement | null };
  onClose: () => void;
} & AuthorityRecoveryProps) {
  const {
    meal,
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
  const canonicalRecipeDraft = {
    title: visibleRecoveryCommand?.changes.title ?? meal.title,
    subtitle: visibleRecoveryCommand?.changes.subtitle ?? meal.subtitle,
    venue: visibleRecoveryCommand?.changes.venue ?? meal.venue,
    prepNote: visibleRecoveryCommand?.changes.prepNote ?? meal.prepNote,
    leftoverNote: visibleRecoveryCommand?.changes.leftoverNote ?? meal.leftoverNote,
    notes: visibleRecoveryCommand?.changes.notes ?? meal.notes,
    ingredients: (visibleRecoveryCommand?.changes.ingredients ?? meal.ingredients.map((ingredient) => [ingredient.amount, ingredient.ingredient].filter(Boolean).join(" "))).join("\n"),
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
    ingredients: draftIngredients,
  } = recipeDraft.compose(canonicalRecipeDraft);
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
    ingredients: draftIngredients,
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
      ingredients: draftIngredients,
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
        ingredients: next.ingredients.split("\n").map((line) => line.trim()).filter(Boolean),
        yieldText: visibleRecoveryCommand.changes.yieldText ?? null,
      },
    });
  };
  const save = () => {
    setSaveAttempted(true);
    if (hasValidationIssues(mealIssues)) return;
    void mutate(
      {
        type: "updateMealSnapshot",
        weekId: week.id,
        mealId: meal.id,
        changes: {
          title: draftTitle.trim(), subtitle: draftSubtitle.trim(), venue: draftVenue.trim(), prepNote: draftPrepNote.trim(), leftoverNote: draftLeftoverNote.trim(), notes: draftNotes.trim(),
          ingredients: draftIngredients.split("\n").map((line) => line.trim()).filter(Boolean),
          yieldText: meal.yieldText ?? null,
        },
      },
      recipeDraft.mutationOptions(() => setSaveAttempted(false)),
    );
  };
  const addInstruction = () => {
    setNewStepAttempted(true);
    if (hasValidationIssues(newStepIssues)) return;
    const timer = newTimerMinutes === null ? undefined : Math.max(1, Math.round(newTimerMinutes * 60));
    void mutate(
      {
        type: "addInstructionStep", weekId: week.id, mealId: meal.id, position: meal.instructions.length,
        step: {
          inputs: newInputs.split("\n").filter((line) => line.trim()).map((line) => { const [amount, ...ingredient] = line.split("|"); return { amount: amount.trim(), ingredient: ingredient.join("|").trim() }; }),
          instruction: newInstruction.trim(), ...(timer ? { timerDurationSeconds: timer } : {}),
        },
      },
      newStepDraft.mutationOptions(() => { setNewInstruction(""); setNewInputs(""); setNewTimer(""); setNewStepAttempted(false); }),
    );
  };
  return (
    <ModalDrawer title={meal.title} className="meal-drawer" onClose={onClose} restoreFocusRef={restoreFocusRef}>
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
        <label className="full-field"><span>Ingredients, one per line</span><textarea aria-label="Ingredients" disabled={archived} rows={5} maxLength={MAX_INGREDIENT_TEXT_LENGTH} value={draftIngredients} aria-invalid={saveAttempted && Boolean(mealIssues.ingredients)} aria-describedby={saveAttempted && mealIssues.ingredients ? "meal-ingredients-error" : undefined} onChange={(event) => editRecipeField("ingredients", event.target.value)} /><FieldError id="meal-ingredients-error" message={saveAttempted ? mealIssues.ingredients : undefined} /></label>
        <label className="full-field"><span>Recipe note</span><textarea aria-label="Recipe note" disabled={archived} rows={3} maxLength={MAX_COMMAND_TEXT_LENGTH} value={draftNotes} aria-invalid={saveAttempted && Boolean(mealIssues.notes)} aria-describedby={saveAttempted && mealIssues.notes ? "meal-notes-error" : undefined} onChange={(event) => editRecipeField("notes", event.target.value)} /><FieldError id="meal-notes-error" message={saveAttempted ? mealIssues.notes : undefined} /></label>
        <div className="field-grid">
          <label><span>Prep note</span><textarea aria-label="Prep note" disabled={archived} maxLength={MAX_COMMAND_TEXT_LENGTH} value={draftPrepNote} aria-invalid={saveAttempted && Boolean(mealIssues.prepNote)} aria-describedby={saveAttempted && mealIssues.prepNote ? "meal-prep-note-error" : undefined} onChange={(event) => editRecipeField("prepNote", event.target.value)} /><FieldError id="meal-prep-note-error" message={saveAttempted ? mealIssues.prepNote : undefined} /></label>
          <label><span>Leftover note</span><textarea aria-label="Leftover note" disabled={archived} maxLength={MAX_COMMAND_TEXT_LENGTH} value={draftLeftoverNote} aria-invalid={saveAttempted && Boolean(mealIssues.leftoverNote)} aria-describedby={saveAttempted && mealIssues.leftoverNote ? "meal-leftover-note-error" : undefined} onChange={(event) => editRecipeField("leftoverNote", event.target.value)} /><FieldError id="meal-leftover-note-error" message={saveAttempted ? mealIssues.leftoverNote : undefined} /></label>
        </div>
        <button className="primary-button" type="button" disabled={disabled} onClick={save}><Check size={15} /> Save recipe details</button>
        <div className="snapshot-section">
          <h3>Schedule and status</h3>
          <div className="inline-control-row">
            <select aria-label={`Meal date for ${meal.title}`} value={draftTargetDate} disabled={disabled} onChange={(event) => { moveDraft.begin(); setTargetDate(event.target.value as IsoDate); }}>{dates.map((date) => <option key={date} value={date}>{formatCalendarDate(date, { weekday: "long", month: "short", day: "numeric" })}</option>)}</select>
            <button className="secondary-button" type="button" disabled={disabled || draftTargetDate === meal.date} onClick={() => void mutate({ type: "moveMeal", weekId: week.id, mealId: meal.id, targetDate: draftTargetDate }, moveDraft.mutationOptions())}>Move meal</button>
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
                  <button className="icon-button" type="button" title={`Move ${stepControlTarget(meal, step, index + 1)} up`} disabled={disabled || index === 0} onClick={() => void mutate({ type: "moveInstructionStep", weekId: week.id, stepId: step.id, targetPosition: index - 1 })}><ArrowUp size={14} /></button>
                  <button className="icon-button" type="button" title={`Move ${stepControlTarget(meal, step, index + 1)} down`} disabled={disabled || index === meal.instructions.length - 1} onClick={() => void mutate({ type: "moveInstructionStep", weekId: week.id, stepId: step.id, targetPosition: index + 1 })}><ArrowDown size={14} /></button>
                  <button className="icon-button danger" type="button" title={`Delete ${stepControlTarget(meal, step, index + 1)}`} disabled={disabled || week.data.prepSessions.some((session) => session.steps.some((entry) => entry.stepId === step.id))} onClick={() => void mutate({ type: "removeInstructionStep", weekId: week.id, stepId: step.id })}><Trash2 size={14} /></button>
                </div>}
              />
            ))}
          </div>
          {!archived ? <div className="instruction-step new-step-form">
            <label className="full-field"><span>Amounts: amount | ingredient</span><textarea aria-label="New amounts" maxLength={MAX_STEP_INPUT_TEXT_LENGTH} value={newInputs} aria-invalid={newStepAttempted && Boolean(newStepIssues.inputs)} aria-describedby={newStepAttempted && newStepIssues.inputs ? "new-step-inputs-error" : undefined} onChange={(event) => { newStepDraft.begin(); setNewInputs(event.target.value); }} /><FieldError id="new-step-inputs-error" message={newStepAttempted ? newStepIssues.inputs : undefined} /></label>
            <label className="full-field"><span>New instruction</span><textarea aria-label="New instruction" maxLength={MAX_COMMAND_TEXT_LENGTH} value={newInstruction} aria-invalid={newStepAttempted && Boolean(newStepIssues.instruction)} aria-describedby={newStepAttempted && newStepIssues.instruction ? "new-step-instruction-error" : undefined} onChange={(event) => { newStepDraft.begin(); setNewInstruction(event.target.value); }} /><FieldError id="new-step-instruction-error" message={newStepAttempted ? newStepIssues.instruction : undefined} /></label>
            <label className="full-field"><span>Timer minutes (optional, up to 1,440)</span><input aria-label="New timer minutes" type="number" min="0.5" max="1440" step="0.5" value={newTimer} aria-invalid={newStepAttempted && Boolean(newStepIssues.timer)} aria-describedby={newStepAttempted && newStepIssues.timer ? "new-step-timer-error" : undefined} onChange={(event) => { newStepDraft.begin(); setNewTimer(event.target.value); }} /><FieldError id="new-step-timer-error" message={newStepAttempted ? newStepIssues.timer : undefined} /></label>
            <button className="secondary-button" type="button" disabled={disabled} onClick={addInstruction}><Plus size={15} /> Add instruction</button>
          </div> : null}
        </div>
      </div>
      <div className="drawer-footer"><button className="secondary-button" type="button" onClick={onClose}>Close</button></div>
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
              {index === 0 && canUndo ? <button type="button" disabled={disabled} onClick={() => onUndo(event)}><RotateCcw size={13} /> Undo latest change</button> : null}
            </div>
          </div>
        ))}
      </div>
    </ModalDrawer>
  );
}

function ModalDrawer({
  title,
  className = "",
  onClose,
  restoreFocusRef,
  children,
}: {
  title: string;
  className?: string;
  onClose: () => void;
  restoreFocusRef?: { current: HTMLElement | null };
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose, restoreFocusRef);
  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={ref} className={`drawer ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="drawer-header"><div><p className="eyebrow">Shared workspace</p><h2>{title}</h2></div><button className="icon-button" type="button" title="Close" onClick={onClose}><X size={19} /></button></div>
        {children}
      </div>
    </div>
  );
}

function ModalChat({ onClose, restoreFocusRef, children }: { onClose: () => void; restoreFocusRef: { current: HTMLButtonElement | null }; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose, restoreFocusRef);
  return (
    <div className="mobile-chat-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={ref} className="mobile-chat-dialog" role="dialog" aria-modal="true" aria-label="Codex task">{children}</div>
    </div>
  );
}

function useDialogFocus(
  ref: { current: HTMLElement | null },
  onClose: () => void,
  restoreFocusRef?: { current: HTMLElement | null },
) {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreFocus = restoreFocusRef?.current;
    const root = ref.current;
    const focusable = () => root
      ? Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'))
        .filter((element) => element.getClientRects().length > 0 && !element.closest("[inert]"))
      : [];
    const preferred = root?.querySelector<HTMLElement>("[data-autofocus]");
    (preferred ?? focusable()[0])?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!root || !(event.target instanceof Node) || root.contains(event.target)) return;
      focusable()[0]?.focus();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !root || root.contains(document.activeElement)) return;
      const items = focusable();
      (event.shiftKey ? items.at(-1) : items[0])?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("focusin", onFocusIn);
      const restoreAfterUnmount = (attempt = 0) => {
        const activeDialog = document.querySelector('[role="dialog"][aria-modal="true"]');
        if (activeDialog === root) {
          if (attempt < 8) window.setTimeout(() => restoreAfterUnmount(attempt + 1), 16);
          return;
        }
        if (activeDialog) return;
        const fallback = Array.from(document.querySelectorAll<HTMLElement>(
          '[title="Change history"], .mobile-nav button, .view-nav button, .header-actions button',
        )).find((element) => element.getClientRects().length > 0 && !element.closest("[inert]"));
        const isRestorable = (element: HTMLElement | null | undefined) => Boolean(
          element?.isConnected &&
          element !== document.body &&
          element !== document.documentElement &&
          element.getClientRects().length > 0 &&
          !element.closest("[inert]"),
        );
        const focusTarget = isRestorable(restoreFocus)
          ? restoreFocus
          : isRestorable(previous)
            ? previous
            : fallback;
        if (!focusTarget || focusTarget.closest("[inert]")) {
          if (attempt < 8) window.setTimeout(() => restoreAfterUnmount(attempt + 1), 16);
          return;
        }
        focusTarget.focus();
      };
      window.setTimeout(restoreAfterUnmount, 0);
    };
  }, [ref, restoreFocusRef]);
}
