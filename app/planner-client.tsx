"use client";

import {
  Archive,
  ArrowDown,
  ArrowUp,
  Bot,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  ClipboardCheck,
  Clock3,
  CookingPot,
  History,
  Home,
  ListChecks,
  LoaderCircle,
  MapPin,
  MessageCircle,
  MessageSquareText,
  PackageCheck,
  PencilLine,
  Play,
  Plus,
  RotateCcw,
  Send,
  ShoppingBasket,
  Sprout,
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
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
} from "react";

import {
  MAX_COMMAND_TEXT_LENGTH,
  MAX_GROCERY_ITEM_LENGTH,
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
  LEFTOVER_QUALITIES,
  MEAL_STATUSES,
  type GroceryItem,
  type InstructionStep,
  type IsoDate,
  type Meal,
  type WeekId,
  type WeekPlan,
} from "@/lib/household-contract";
import { addIsoDateDays, weekContainsDate } from "@/lib/household-domain";
import {
  LEGACY_V2_STORAGE_KEY,
  type ApplyPlannerCommandRequest,
  type BootstrapWorkspaceRequest,
  type HealthResponse,
  type InitializedWorkspace,
  type PlannerEvent,
  type UndoLatestRequest,
  type WorkspaceResponse,
} from "@/lib/planner-api-contract";
import type {
  ChatTurnIntent,
  ChatTurn,
  PlannerChatContext,
  PlannerView,
  RetryChatTurnRequest,
  SubmitChatTurnRequest,
} from "@/lib/planner-chat-contract";
import {
  LEGACY_V1_STORAGE_KEY,
  PlannerApiError,
  applyPlannerCommand,
  bootstrapWorkspace,
  createRequestId,
  isAbortError,
  readHealth,
  readLegacyImport,
  readWorkspace,
  retryChatTurn,
  shouldAcceptWorkspace,
  submitChatTurn,
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
  validateGroceryDraft,
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
import { plannerChatContextForView } from "./planner-chat-context";
import { isoDateForTimeZone } from "./calendar-time";

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
  | {
      kind: "chat-submit";
      request: SubmitChatTurnRequest;
      onAccepted?: () => void;
    }
  | { kind: "chat-retry"; request: RetryChatTurnRequest }
  | { kind: "undo"; request: UndoLatestRequest }
);
type PendingRetryChannel = "planner" | "chat";
type PendingRetryVolatile = {
  options?: MutateOptions;
  onAccepted?: () => void;
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

function pendingRetryChannel(retry: PendingAuthorityRetry): PendingRetryChannel {
  return retry.kind === "chat-submit" || retry.kind === "chat-retry" ? "chat" : "planner";
}

function pendingRetryFromOperation(
  operation: PendingAuthorityOperation,
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
  if (operation.kind === "chat-submit") {
    const original = request as SubmitChatTurnRequest;
    return {
      ...shared,
      kind: operation.kind,
      request: {
        ...original,
        message: resolved && typeof operation.editableDraft === "string"
          ? operation.editableDraft
          : original.message,
      },
    };
  }
  if (operation.kind === "chat-retry") {
    return { ...shared, kind: operation.kind, request: request as RetryChatTurnRequest };
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
  context: PlannerChatContext,
  onAccepted?: () => void,
  intent?: ChatTurnIntent,
) => Promise<boolean>;

const DEFAULT_CHAT_INTENT: ChatTurnIntent = Object.freeze({
  kind: "planner",
  archiveContextWeek: false,
});

const PLANNER_ACTION_LABELS = {
  moveMeal: "Move dinner",
  updateMealStatus: "Change dinner status",
  updateMealSnapshot: "Save recipe details",
  replaceMealRecipeFromSource: "Replace sourced recipe",
  addInstructionStep: "Add recipe step",
  updateInstructionStep: "Save recipe step",
  moveInstructionStep: "Reorder recipe step",
  removeInstructionStep: "Delete recipe step",
  setInstructionStepComplete: "Change recipe step completion",
  updateInstructionStepNote: "Save recipe step note",
  startInstructionTimer: "Start recipe timer",
  resetInstructionTimer: "Reset recipe timer",
  setPrepPlan: "Save prep plan",
  movePrepReference: "Reorder prep step",
  reschedulePrepReference: "Reschedule prep step",
  removePrepReference: "Remove prep step",
  addGroceryItem: "Add grocery item",
  updateGroceryItem: "Update grocery item",
  removeGroceryItem: "Remove grocery item",
  setGroceryItemChecked: "Change grocery item completion",
  reconcileGroceries: "Reconcile groceries",
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
  } else if (week && "referenceId" in command) {
    const reference = week.data.prep.find((candidate) => candidate.id === command.referenceId);
    const resolved = reference ? findStep(week, reference.stepId) : null;
    if (resolved) target = stepControlTarget(resolved.meal, resolved.step, resolved.position + 1);
  } else if (week && "itemId" in command) {
    target = week.data.groceries.find((candidate) => candidate.id === command.itemId)?.item;
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
    action = `Mark dinner ${command.status}`;
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
    const media = window.matchMedia("(max-width: 700px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
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
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [view, setView] = useState<PlannerView>("week");
  const [selectedWeekId, setSelectedWeekId] = useState<WeekId | null>(null);
  const [selectedMealId, setSelectedMealId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessage, setChatMessage] = useState("");
  const [chatIntent, setChatIntent] = useState<ChatTurnIntent>(DEFAULT_CHAT_INTENT);
  const [plannerPending, setPlannerPending] = useState(false);
  const [chatPending, setChatPending] = useState(false);
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
  const chatRequestInFlight = useRef(false);
  const pendingRetryRef = useRef<PendingAuthorityRetry[]>([]);
  const pendingRetryVolatileRef = useRef(new Map<string, PendingRetryVolatile>());
  const chatMessageRef = useRef(chatMessage);
  const appContentRef = useRef<HTMLDivElement>(null);
  const chatTriggerRef = useRef<HTMLButtonElement>(null);
  const historyTriggerRef = useRef<HTMLButtonElement>(null);
  const mealTriggerRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const setChatMessageWithRecovery = useCallback<Dispatch<SetStateAction<string>>>((action) => {
    const next = typeof action === "function" ? action(chatMessageRef.current) : action;
    chatMessageRef.current = next;
    setChatMessage(next);
    const pending = pendingRetryRef.current.find((retry) =>
      pendingRetryChannel(retry) === "chat" && retry.operation.state !== "prepared"
    );
    if (pending?.kind !== "chat-submit") return;
    try {
      updateAuthorityOperationDraft(pending.operation, next);
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    }
  }, []);

  const syncPendingRetries = useCallback(() => {
    try {
      const operations = readAuthorityOperations()
        .filter((operation) => !(
          operation.state === "prepared" &&
          (operation.kind === "chat-submit" || operation.kind === "chat-retry"
            ? chatRequestInFlight.current
            : plannerMutationInFlight.current)
        ))
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
        if (retry.kind === "chat-submit" && volatile?.onAccepted) {
          return { ...retry, onAccepted: volatile.onAccepted };
        }
        return retry;
      });
      pendingRetryRef.current = retries;
      setPendingRetries(retries);
      setJournalError(null);
      const pendingChat = retries.find((retry) => retry.kind === "chat-submit");
      if (pendingChat?.kind === "chat-submit") {
        const recoveryMessage = typeof pendingChat.operation.editableDraft === "string"
          ? pendingChat.operation.editableDraft
          : pendingChat.request.message;
        const next = chatMessageRef.current || recoveryMessage;
        chatMessageRef.current = next;
        setChatMessage(next);
      }
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
        onAccepted?: () => void;
      };
      if (
        typeof candidate.kind === "string" &&
        typeof candidate.request?.requestId === "string"
      ) {
        pendingRetryVolatileRef.current.set(
          `${candidate.kind}:${candidate.request.requestId}`,
          {
            ...(candidate.options ? { options: candidate.options } : {}),
            ...(candidate.onAccepted ? { onAccepted: candidate.onAccepted } : {}),
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

  const discardResolvedPendingRetry = useCallback((channel: PendingRetryChannel) => {
    for (const retry of pendingRetryRef.current) {
      if (
        pendingRetryChannel(retry) === channel &&
        retry.operation.state === "resolved_conflict"
      ) {
        discardAuthorityOperation(retry.operation);
      }
    }
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
  const chatRetry = pendingRetries.find((retry) => pendingRetryChannel(retry) === "chat") ?? null;
  const pendingRetry = plannerRetry ?? chatRetry;
  const selectedMealAvailable = Boolean(
    selectedMealId &&
    workspace?.initialized &&
    (
      workspace.state.weeks.find((item) => item.id === selectedWeekId) ??
      workspace.state.weeks.at(-1)
    )?.data.meals.some((meal) => meal.id === selectedMealId),
  );
  const activeOverlay = selectedMealAvailable
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
    const update = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        setHealth(await readHealth());
      } catch {
        setHealth(null);
      }
    };
    void update();
    const interval = window.setInterval(() => void update(), 15_000);
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
    mealTriggerRef.current = trigger;
    setHistoryOpen(false);
    setChatOpen(false);
    setSelectedMealId(mealId);
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

  const executeChatSubmit = useCallback(async (
    request: SubmitChatTurnRequest,
    onAccepted?: () => void,
  ): Promise<boolean> => {
    if (chatRequestInFlight.current) return false;
    chatRequestInFlight.current = true;
    setChatPending(true);
    setNotice(null);
    try {
      const response = await submitChatTurn(request, {
        label: "Send ChatGPT message",
        submittedDraft: request.message,
      });
      acceptWorkspace(response.workspace);
      clearPendingRetry("chat");
      if (response.decision.status === "accepted") {
        const mutationOutcome = response.decision.turn.mutationOutcome;
        if (mutationOutcome === "version_conflict") {
          setNotice({
            tone: "warning",
            message: "ChatGPT replied, but its planner change was not applied because the plan changed. Review the latest plan and ask again.",
          });
        } else if (mutationOutcome === "domain_rejected") {
          setNotice({
            tone: "warning",
            message: "ChatGPT replied, but the planner rejected its proposed change. Review the latest plan and ask again.",
          });
        }
        onAccepted?.();
        await refresh(true);
        return true;
      }
      const decision = response.decision;
      if (decision.status === "codex_unavailable") {
        discardResolvedPendingRetry("chat");
      } else {
        clearPendingRetry("chat");
      }
      const messageText =
        decision.status === "turn_busy"
          ? "ChatGPT is finishing another household request. Your message was kept."
          : decision.status === "context_stale"
            ? "The planner changed before ChatGPT could start. Review the latest plan and send again."
            : decision.status === "request_id_reuse"
              ? "This chat request was already used."
              : decision.status === "not_found" || decision.status === "domain_rejected" || decision.status === "codex_unavailable"
                ? decision.message
                : "ChatGPT could not accept the request.";
      setNotice({ tone: decision.status === "codex_unavailable" ? "warning" : "error", message: messageText });
      return false;
    } catch (error) {
      if (error instanceof PlannerApiError && error.workspace) acceptWorkspace(error.workspace);
      if (isAmbiguousPostError(error)) {
        setPendingRetry({
          kind: "chat-submit",
          label: "Send ChatGPT message",
          tone: "error",
          message: "The ChatGPT response was interrupted. Reconnect, then resolve that exact request.",
          request,
          onAccepted,
        });
        if (error.code === "NETWORK_ERROR") setConnection("offline");
        setNotice({
          tone: "error",
          message: "The ChatGPT response was interrupted. Reconnect, then resolve that exact request.",
        });
      } else {
        discardResolvedPendingRetry("chat");
        setNotice({ tone: "error", message: errorMessage(error) });
      }
      return false;
    } finally {
      chatRequestInFlight.current = false;
      setChatPending(false);
    }
  }, [acceptWorkspace, clearPendingRetry, discardResolvedPendingRetry, refresh, setPendingRetry]);

  const sendContextMessage: SendContextMessage = useCallback(async (
    message,
    context,
    onAccepted,
    intent = DEFAULT_CHAT_INTENT,
  ) => {
    const current = workspaceRef.current;
    if (
      !current?.initialized ||
      chatRequestInFlight.current ||
      connection !== "online" ||
      blockForPendingRetry("chat")
    ) return false;
    if (current.chatTurns.some((turn) => turn.status === "running")) {
      setNotice({ tone: "warning", message: "ChatGPT is already working on a household request. Your draft was kept." });
      return false;
    }
    if (health && health.codex.status !== "ready") {
      setNotice({ tone: "warning", message: "The shared planner is online, but ChatGPT is not available." });
      return false;
    }
    return executeChatSubmit({
      requestId: createRequestId(),
      basePlannerVersion: current.plannerVersion,
      message,
      context,
      intent,
    }, onAccepted);
  }, [blockForPendingRetry, connection, executeChatSubmit, health]);

  const executeChatRetry = useCallback(async (request: RetryChatTurnRequest) => {
    if (chatRequestInFlight.current) return;
    chatRequestInFlight.current = true;
    setChatPending(true);
    setNotice(null);
    try {
      const response = await retryChatTurn(request, {
        label: "Retry ChatGPT request",
        submittedDraft: request,
      });
      acceptWorkspace(response.workspace);
      clearPendingRetry("chat");
      if (response.decision.status !== "accepted") {
        setNotice({ tone: "warning", message: "That chat turn could not be retried yet." });
      }
      await refresh(true);
    } catch (error) {
      if (error instanceof PlannerApiError && error.workspace) acceptWorkspace(error.workspace);
      if (isAmbiguousPostError(error)) {
        setPendingRetry({
          kind: "chat-retry",
          label: "Retry ChatGPT request",
          tone: "error",
          message: "The ChatGPT retry response was interrupted. Reconnect, then resolve that exact request.",
          request,
        });
        if (error.code === "NETWORK_ERROR") setConnection("offline");
        setNotice({ tone: "error", message: "The ChatGPT retry response was interrupted. Reconnect, then resolve that exact request." });
      } else {
        clearPendingRetry("chat");
        setNotice({ tone: "error", message: errorMessage(error) });
      }
    } finally {
      chatRequestInFlight.current = false;
      setChatPending(false);
    }
  }, [acceptWorkspace, clearPendingRetry, refresh, setPendingRetry]);

  const retryTurn = useCallback(async (turn: ChatTurn) => {
    const current = workspaceRef.current;
    if (
      !current?.initialized ||
      chatRequestInFlight.current ||
      connection !== "online" ||
      blockForPendingRetry("chat")
    ) return;
    await executeChatRetry({
      requestId: createRequestId(),
      basePlannerVersion: current.plannerVersion,
      turnId: turn.turnId,
    });
  }, [blockForPendingRetry, connection, executeChatRetry]);

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
    if (pending.kind === "chat-submit") {
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
          kind: "chat-submit",
          path: pending.operation.path,
          body: request,
          label: pending.label,
          submittedDraft: request.message,
        });
      }
      await executeChatSubmit(request, pending.onAccepted ?? (() => {
        setChatMessageWithRecovery((current) =>
          current.trim() === request.message ? "" : current
        );
      }));
      return;
    }
    if (pending.kind === "chat-retry") {
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
          kind: "chat-retry",
          path: pending.operation.path,
          body: request,
          label: pending.label,
          submittedDraft: request,
        });
      }
      await executeChatRetry(request);
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
  }, [connection, executeBootstrap, executeChatRetry, executeChatSubmit, executePlannerMutation, executeUndo, setChatMessageWithRecovery]);

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
  const selectedMeal = week?.data.meals.find((meal) => meal.id === selectedMealId) ?? null;
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
    retryDisabled: connection !== "online" || plannerPending || chatPending,
    onDiscardPending: plannerRetry?.operation.state === "resolved_conflict"
      ? () => discardPendingOperation("planner")
      : undefined,
    onDismissNotice: () => setNotice(null),
    offline: connection === "offline",
    onReconnect: () => void refresh(true),
  };
  const chatAuthorityRecovery: AuthorityRecoveryProps = {
    notice: chatRetry ? { tone: chatRetry.tone, message: chatRetry.message } : notice,
    pendingRetryLabel: chatRetry?.label,
    onRetryPending: () => void retryPendingOperation("chat"),
    retryDisabled: connection !== "online" || plannerPending || chatPending,
    onDiscardPending: chatRetry?.operation.state === "resolved_conflict"
      ? () => discardPendingOperation("chat")
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
                {connection === "offline" ? "Offline · read-only" : plannerPending ? "Saving shared change…" : chatPending ? "ChatGPT working · planner available" : "Shared plan current"}
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
              setHistoryOpen(true);
            }}>
              <History size={19} />
            </button>
            <button
              ref={chatTriggerRef}
              className="primary-button"
              type="button"
              onClick={() => {
                if (mobile) {
                  setSelectedMealId(null);
                  setHistoryOpen(false);
                  setChatOpen(true);
                }
                else document.querySelector<HTMLTextAreaElement>('.chat-rail textarea[aria-label="Message ChatGPT"]')?.focus();
              }}
              aria-expanded={mobile ? chatOpen : undefined}
              aria-label={mobile ? "Open ChatGPT" : "Focus ChatGPT chat"}
            >
              <MessageCircle size={17} /><span>ChatGPT</span>
            </button>
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

        <main className="app-main">
          {authorityNotice ? (
            <AuthorityNotice
              notice={authorityNotice}
              pendingRetryLabel={pendingRetry?.label}
              onRetryPending={() => void retryPendingOperation(
                pendingRetry ? pendingRetryChannel(pendingRetry) : undefined,
              )}
              retryDisabled={connection !== "online" || plannerPending || chatPending}
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
            <div className="authority-banner warning" role="status">
              <span>You are seeing the last shared plan. Editing is paused until the server reconnects.</span>
              <button className="secondary-button" type="button" onClick={() => void refresh(true)}>Reconnect</button>
            </div>
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
            <section className="primary-workspace">
              {!week ? (
                <section className="lifecycle-surface empty-workspace">
                  <CalendarDays size={30} />
                  <h2>No weeks yet</h2>
                  <p>Ask ChatGPT to build the first week plan.</p>
                </section>
              ) : view === "week" ? (
                  <WeekView week={week} today={today} onOpenMeal={openMeal} onNavigate={navigate} />
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
                    onOpenMeal={openMeal}
                  />
                ) : view === "groceries" ? (
                  <GroceryView key={week.id} week={week} disabled={isReadOnly} mutate={mutate} />
                ) : (
                  <CloseoutView key={week.id} week={week} disabled={isReadOnly} mutate={mutate} />
              )}
            </section>
            {!mobile ? (
              <ChatPanel
                workspace={initialized}
                week={week}
                view={view}
                today={today}
                disabled={connection !== "online" || chatPending || Boolean(chatRetry) || (health !== null && health.codex.status !== "ready")}
                health={health}
                message={chatMessage}
                onMessageChange={setChatMessageWithRecovery}
                intent={chatIntent}
                onIntentChange={setChatIntent}
                onSend={sendContextMessage}
                onRetry={retryTurn}
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
          <ChatPanel
            workspace={initialized}
            week={week}
            view={view}
            today={today}
            disabled={connection !== "online" || chatPending || Boolean(chatRetry) || (health !== null && health.codex.status !== "ready")}
            health={health}
            message={chatMessage}
            onMessageChange={setChatMessageWithRecovery}
            intent={chatIntent}
            onIntentChange={setChatIntent}
            onSend={sendContextMessage}
            onRetry={retryTurn}
            {...chatAuthorityRecovery}
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

function WeekView({ week, today, onOpenMeal, onNavigate }: { week: WeekPlan; today: IsoDate; onOpenMeal: (id: string, trigger: HTMLElement) => void; onNavigate: (view: PlannerView) => void }) {
  const dates = Array.from({ length: 7 }, (_, index) => addIsoDateDays(week.id, index));
  return (
    <div className="week-view">
      <div className="week-grid">
        {dates.map((date) => {
          const meal = week.data.meals.find((item) => item.date === date && item.slot === "dinner");
          const assignedLeftover = week.data.leftovers.find(
            (leftover) =>
              leftover.state === "assigned" &&
              leftover.assignedDate === date &&
              leftover.assignedSlot === "dinner",
          );
          return (
            <div key={date} className={`day-column ${date === today ? "today" : ""}`}>
              <div className="day-heading">
                <div><span>{dayName(date, "short")}</span>{date === today ? <small>Today</small> : null}</div>
                <strong>{Number(date.slice(-2))}</strong>
              </div>
              {assignedLeftover ? (
                <div className="meal-card leftover-meal" aria-label={`${dayName(date)} dinner is ${assignedLeftover.label}`}>
                  <span className="status-badge"><PackageCheck size={12} /> leftovers</span>
                  <strong className="meal-title">{assignedLeftover.label}</strong>
                  <span className="meal-subtitle">{assignedLeftover.portions} portions ready to use.</span>
                  <span className="meal-meta">Assigned family dinner</span>
                </div>
              ) : meal ? (
                <button className="meal-card" type="button" onClick={(event) => onOpenMeal(meal.id, event.currentTarget)}>
                  <span className={`status-badge ${statusTone(meal.status)}`}>{meal.status}</span>
                  <strong className="meal-title">{meal.title}</strong>
                  <span className="meal-subtitle">{meal.subtitle}</span>
                  <span className="meal-meta"><MapPin size={12} /> {meal.venue}</span>
                  {meal.prepNote ? <span className="meal-meta"><CheckCircle2 size={12} /> {meal.prepNote}</span> : null}
                  {meal.leftoverNote ? <span className="meal-leftover"><PackageCheck size={12} /> {meal.leftoverNote}</span> : null}
                  <span className="open-detail">Open recipe <ChevronRight size={14} /></span>
                </button>
              ) : (
                <div className="meal-card empty-meal" aria-label={`${dayName(date)} dinner is empty`}>
                  <Circle size={19} />
                  <strong className="meal-title">Dinner is open</strong>
                  <span className="meal-subtitle">No meal is assigned to this slot.</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mobile-pressure-strip">
        <button type="button" onClick={() => onNavigate("prep")}><ListChecks size={15} /> Prep <strong>{week.data.prep.filter((ref) => findStep(week, ref.stepId)?.step.complete).length}/{week.data.prep.length}</strong></button>
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
  const meal = week.data.meals.find((item) => item.date === today && item.slot === "dinner");
  const assignedLeftover = week.data.leftovers.find(
    (leftover) =>
      leftover.state === "assigned" &&
      leftover.assignedDate === today &&
      leftover.assignedSlot === "dinner",
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
            {meal.sourceRecipe ? (
              <p className="recipe-source">
                <span>Informational recipe source</span>
                <a href={meal.sourceRecipe.url} target="_blank" rel="noopener noreferrer">
                  {meal.sourceRecipe.identity}
                </a>
              </p>
            ) : null}
          </div>
          <span className={`status-badge ${statusTone(meal.status)}`}>{meal.status}</span>
        </div>
        <div className="tonight-actions">
          <button className="secondary-button" type="button" onClick={(event) => onOpenMeal(meal.id, event.currentTarget)}><PencilLine size={16} /> Recipe</button>
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
              contextView="tonight"
            />
          ))}
        </div>
      </div>
      <aside className="tonight-side">
        <div className="plain-panel"><div className="section-title"><ShoppingBasket size={16} /><h3>Ingredients</h3></div>
          {meal.ingredients.length ? <ul className="ingredient-list">{meal.ingredients.map((item) => <li key={item}><Check size={13} /> {item}</li>)}</ul> : <p>No ingredients listed.</p>}
        </div>
        <div className="plain-panel"><div className="section-title"><StickyNote size={16} /><h3>Recipe note</h3></div><p>{meal.notes || "No recipe note."}</p></div>
        <div className="plain-panel leftover-plan"><div className="section-title"><PackageCheck size={16} /><h3>Leftovers</h3></div><strong>{meal.leftoverNote || "No leftover plan."}</strong></div>
      </aside>
    </div>
  );
}

function Timer({ step }: { step: InstructionStep }) {
  const serverOffset = useContext(ServerOffsetContext);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (step.timerStartedAt === undefined) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [step.timerStartedAt]);
  if (!step.timerDurationSeconds) return null;
  const display = deriveTimerDisplay(
    step.timerDurationSeconds,
    step.timerStartedAt,
    now + serverOffset,
  );
  const minutes = Math.floor(display.remainingSeconds / 60).toString().padStart(2, "0");
  const seconds = (display.remainingSeconds % 60).toString().padStart(2, "0");
  return (
    <>
      <strong>{minutes}:{seconds}</strong>
      <span>{display.status}</span>
    </>
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
  contextView: PlannerView;
  actions?: ReactNode;
  editable?: boolean;
}) {
  const { step, meal, stepNumber, week, disabled, mutate, sendContextMessage, contextView, actions, editable = false } = props;
  const archived = week.status === "archived";
  const controlTarget = stepControlTarget(meal, step, stepNumber);
  const [comment, setComment] = useState("");
  const [editAttempted, setEditAttempted] = useState(false);
  const canonicalInstructionDraft = {
    inputs: step.inputs.map((input) => `${input.amount} | ${input.ingredient}`).join("\n"),
    instruction: step.instruction,
    timerMinutes: step.timerDurationSeconds ? String(step.timerDurationSeconds / 60) : "",
  };
  const instructionDraft = useVersionedDraft<typeof canonicalInstructionDraft>();
  const noteDraft = useVersionedDraft();
  const {
    inputs: draftInputs,
    instruction: draftInstruction,
    timerMinutes: draftTimerMinutes,
  } = instructionDraft.compose(canonicalInstructionDraft);
  const chatContext: PlannerChatContext = { view: contextView, weekId: week.id, mealId: meal.id, stepId: step.id };
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
    <article className={`instruction-step ${step.complete ? "complete" : ""}`} aria-label={controlTarget}>
      <div className="instruction-step-heading">
        <label className="step-checkbox">
          <input
            type="checkbox"
            checked={step.complete}
            disabled={disabled}
            aria-label={`${step.complete ? "Reopen" : "Complete"} ${controlTarget}`}
            onChange={(event) => void mutate({ type: "setInstructionStepComplete", weekId: week.id, stepId: step.id, complete: event.target.checked })}
          />
          {step.complete ? "Done" : "To do"}
        </label>
        {actions}
      </div>
      {step.inputs.length ? <div className="step-inputs">{step.inputs.map((input, index) => <span key={`${input.amount}-${input.ingredient}-${index}`}><strong>{input.amount}</strong> {input.ingredient}</span>)}</div> : null}
      <p className="step-instruction">{step.instruction}</p>
      {step.timerDurationSeconds ? (
        <div className={`step-timer ${step.timerStartedAt !== undefined ? "running" : ""}`}>
          <Clock3 size={14} /><Timer step={step} />
          <button
            className="icon-button"
            type="button"
            title={step.timerStartedAt !== undefined ? "Reset timer" : "Start timer"}
            aria-label={`${step.timerStartedAt !== undefined ? "Reset" : "Start"} timer for ${controlTarget}`}
            disabled={disabled || step.complete}
            onClick={() => void mutate({ type: step.timerStartedAt !== undefined ? "resetInstructionTimer" : "startInstructionTimer", weekId: week.id, stepId: step.id })}
          >
            {step.timerStartedAt !== undefined ? <RotateCcw size={14} /> : <Play size={14} />}
          </button>
        </div>
      ) : null}
      {step.note ? (
        <div className="step-note">
          <StickyNote size={14} /><p>{step.note}</p>
          <button
            className="icon-button"
            type="button"
            title="Clear step note"
            aria-label={`Clear note for ${controlTarget}`}
            disabled={disabled}
            onClick={() => void mutate({ type: "updateInstructionStepNote", weekId: week.id, stepId: step.id, note: "" })}
          ><X size={14} /></button>
        </div>
      ) : null}
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
      {!archived ? <details className="step-comment">
        <summary aria-label={`Add note or ask ChatGPT about ${controlTarget}`}><MessageSquareText size={14} /> Add note or ask ChatGPT</summary>
        <div className="step-comment-body">
          <textarea aria-label={`Note or ChatGPT request for ${controlTarget}`} maxLength={MAX_COMMAND_TEXT_LENGTH} value={comment} onChange={(event) => { noteDraft.begin(); setComment(event.target.value); }} placeholder="What changed, or what should ChatGPT help with?" />
          <small className="field-limit">{comment.length.toLocaleString("en-CA")}/{MAX_COMMAND_TEXT_LENGTH.toLocaleString("en-CA")}</small>
          <div className="step-comment-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={disabled || !comment.trim()}
              aria-label={`Add note for ${controlTarget}`}
              onClick={() => void mutate(
                { type: "updateInstructionStepNote", weekId: week.id, stepId: step.id, note: comment.trim() },
                noteDraft.mutationOptions(() => setComment("")),
              )}
            ><StickyNote size={14} /> Add note</button>
            <button
              className="primary-button"
              type="button"
              disabled={disabled || !comment.trim()}
              aria-label={`Send ${controlTarget} to ChatGPT`}
              onClick={() => {
                const submittedComment = comment.trim();
                void sendContextMessage(submittedComment, chatContext, () => {
                  setComment((current) => {
                    if (current.trim() !== submittedComment) return current;
                    noteDraft.versionRef.current = null;
                    return "";
                  });
                });
              }}
            ><Bot size={14} /> Send to ChatGPT</button>
          </div>
        </div>
      </details> : null}
    </article>
  );
}

function PrepView(props: {
  week: WeekPlan;
  disabled: boolean;
  mutate: Mutate;
  sendContextMessage: SendContextMessage;
  onOpenMeal: (id: string, trigger: HTMLElement) => void;
}) {
  const { week, disabled, mutate, sendContextMessage, onOpenMeal } = props;
  const [stepId, setStepId] = useState("");
  const [prepDate, setPrepDate] = useState<IsoDate>(addIsoDateDays(week.id, -1));
  const prepDraft = useVersionedDraft();
  const dates = Array.from({ length: 8 }, (_, index) => addIsoDateDays(week.id, index - 1));
  const existing = new Set(week.data.prep.map((reference) => reference.stepId));
  const available = week.data.meals.flatMap((meal) => meal.instructions.filter((step) => !existing.has(step.id)).map((step) => ({ meal, step })));
  const sorted = [...week.data.prep].sort((left, right) => left.prepDate.localeCompare(right.prepDate) || left.position - right.position);
  return (
    <div className="list-surface">
      <div className="surface-summary">
        <div><p className="eyebrow">Independent recipe steps</p><h2>Prep in the order you choose</h2></div>
        <span className="summary-chip"><CheckCircle2 size={14} /> {sorted.filter((reference) => findStep(week, reference.stepId)?.step.complete).length}/{sorted.length} done</span>
      </div>
      {week.status !== "archived" ? (
        <div className="prep-add-row">
          <select value={stepId} onChange={(event) => { prepDraft.begin(); setStepId(event.target.value); }} aria-label="Instruction to add to prep">
            <option value="">Choose a recipe step</option>
            {available.map(({ meal, step }) => <option key={step.id} value={step.id}>{meal.title}: {step.instruction}</option>)}
          </select>
          <select value={prepDate} onChange={(event) => { prepDraft.begin(); setPrepDate(event.target.value as IsoDate); }} aria-label="Prep date">
            {dates.map((date) => <option key={date} value={date}>{formatCalendarDate(date, { weekday: "short", month: "short", day: "numeric" })}</option>)}
          </select>
          <button
            className="secondary-button"
            type="button"
            disabled={disabled || !stepId}
            onClick={() => void mutate(
              {
                type: "setPrepPlan",
                weekId: week.id,
                entries: [...sorted.map((reference) => ({ stepId: reference.stepId, prepDate: reference.prepDate })), { stepId, prepDate }],
              },
              prepDraft.mutationOptions(() => setStepId("")),
            )}
          ><Plus size={15} /> Add to prep</button>
        </div>
      ) : null}
      <div className="prep-step-list">
        {dates.map((date) => {
          const references = sorted.filter((reference) => reference.prepDate === date);
          if (!references.length) return null;
          return (
            <section className="prep-day-group" key={date}>
              <div className="section-title"><CalendarDays size={16} /><h3>{formatCalendarDate(date, { weekday: "long", month: "short", day: "numeric" })}</h3><span>{references.length} steps</span></div>
              {references.map((reference, index) => {
                const resolved = findStep(week, reference.stepId);
                if (!resolved) return null;
                const target = stepControlTarget(resolved.meal, resolved.step, resolved.position + 1);
                const actions = (
                  <div className="prep-reference-actions prep-schedule-actions">
                    <button className="step-meal-link" type="button" aria-label={`Open recipe for ${target}`} onClick={(event) => onOpenMeal(resolved.meal.id, event.currentTarget)}>{resolved.meal.title}<ChevronRight size={13} /></button>
                    <button className="icon-button" type="button" title={`Move ${target} up`} disabled={disabled || index === 0} onClick={() => void mutate({ type: "movePrepReference", weekId: week.id, referenceId: reference.id, targetPosition: index - 1 })}><ArrowUp size={14} /></button>
                    <button className="icon-button" type="button" title={`Move ${target} down`} disabled={disabled || index === references.length - 1} onClick={() => void mutate({ type: "movePrepReference", weekId: week.id, referenceId: reference.id, targetPosition: index + 1 })}><ArrowDown size={14} /></button>
                    <select value={reference.prepDate} disabled={disabled} aria-label={`Prep date for ${target}`} onChange={(event) => void mutate({ type: "reschedulePrepReference", weekId: week.id, referenceId: reference.id, prepDate: event.target.value as IsoDate })}>
                      {dates.map((target) => <option key={target} value={target}>{formatCalendarDate(target, { weekday: "short", day: "numeric" })}</option>)}
                    </select>
                    <button className="icon-button danger" type="button" title={`Remove ${target} from prep`} disabled={disabled} onClick={() => void mutate({ type: "removePrepReference", weekId: week.id, referenceId: reference.id })}><Trash2 size={14} /></button>
                  </div>
                );
                return <StepCard key={reference.id} step={resolved.step} meal={resolved.meal} stepNumber={resolved.position + 1} week={week} disabled={disabled} mutate={mutate} sendContextMessage={sendContextMessage} contextView="prep" actions={actions} />;
              })}
            </section>
          );
        })}
        {!sorted.length ? <p className="empty-copy">No steps are scheduled for prep. Add any recipe step above.</p> : null}
      </div>
    </div>
  );
}

function GroceryView({ week, disabled, mutate }: { week: WeekPlan; disabled: boolean; mutate: Mutate }) {
  const [filter, setFilter] = useState<"all" | "open" | "done">("all");
  const [item, setItem] = useState("");
  const [detail, setDetail] = useState("");
  const [section, setSection] = useState<GroceryItem["section"]>("Produce");
  const [addAttempted, setAddAttempted] = useState(false);
  const groceryDraft = useVersionedDraft();
  const visible = week.data.groceries.filter((entry) => filter === "all" || (filter === "done" ? entry.checked : !entry.checked));
  const checked = week.data.groceries.filter((entry) => entry.checked).length;
  const addIssues = validateGroceryDraft({ item, detail });
  const addGrocery = () => {
    setAddAttempted(true);
    if (hasValidationIssues(addIssues)) return;
    void mutate(
      { type: "addGroceryItem", weekId: week.id, item: { section, item: item.trim(), detail: detail.trim(), farmBox: false } },
      groceryDraft.mutationOptions(() => { setItem(""); setDetail(""); setAddAttempted(false); }),
    );
  };
  return (
    <div className="grocery-layout">
      <div className="grocery-list">
        <div className="surface-summary grocery-summary">
          <div><p className="eyebrow">Shared shopping list</p><h2>Groceries</h2></div>
          <div className="segmented-control" aria-label="Grocery filter">
            {(["all", "open", "done"] as const).map((value) => <button key={value} type="button" aria-pressed={filter === value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{value}</button>)}
          </div>
        </div>
        {week.status !== "archived" ? <div className="grocery-add-row">
          <select value={section} onChange={(event) => { groceryDraft.begin(); setSection(event.target.value as GroceryItem["section"]); }} aria-label="Grocery section">{GROCERY_SECTIONS.map((value) => <option key={value}>{value}</option>)}</select>
          <label className="compact-field"><input maxLength={MAX_GROCERY_ITEM_LENGTH} value={item} onChange={(event) => { groceryDraft.begin(); setItem(event.target.value); }} placeholder="Item" aria-label="New grocery item" aria-invalid={addAttempted && Boolean(addIssues.item)} aria-describedby={addAttempted && addIssues.item ? "grocery-item-error" : undefined} />{addAttempted && addIssues.item ? <small id="grocery-item-error" className="field-error" role="alert">{addIssues.item}</small> : null}</label>
          <label className="compact-field"><input maxLength={MAX_COMMAND_TEXT_LENGTH} value={detail} onChange={(event) => { groceryDraft.begin(); setDetail(event.target.value); }} placeholder="Amount or detail" aria-label="Grocery detail" aria-invalid={addAttempted && Boolean(addIssues.detail)} aria-describedby={addAttempted && addIssues.detail ? "grocery-detail-error" : undefined} />{addAttempted && addIssues.detail ? <small id="grocery-detail-error" className="field-error" role="alert">{addIssues.detail}</small> : null}</label>
          <button className="secondary-button" type="button" disabled={disabled} onClick={addGrocery}><Plus size={15} /> Add</button>
        </div> : null}
        {GROCERY_SECTIONS.map((group) => {
          const entries = visible.filter((entry) => entry.section === group);
          if (!entries.length) return null;
          return (
            <section className="grocery-section" key={group}>
              <h3>{group}<span>{entries.length}</span></h3>
              {entries.map((entry) => (
                <div className={`grocery-row ${entry.checked ? "checked" : ""}`} key={entry.id}>
                  <label className="grocery-check">
                    <input type="checkbox" checked={entry.checked} disabled={disabled} aria-label={`Check ${entry.item}`} onChange={(event) => void mutate({ type: "setGroceryItemChecked", weekId: week.id, itemId: entry.id, checked: event.target.checked })} />
                  </label>
                  <span><strong>{entry.item}</strong><small>{entry.detail || "No amount noted"}</small></span>
                  {entry.farmBox ? <span className="farm-tag"><Sprout size={12} /> Farm box</span> : (
                    <button className="icon-button danger" type="button" title={`Remove ${entry.item}`} disabled={disabled} onClick={() => void mutate({ type: "removeGroceryItem", weekId: week.id, itemId: entry.id })}><Trash2 size={14} /></button>
                  )}
                </div>
              ))}
            </section>
          );
        })}
        {!visible.length ? <p className="empty-copy">No groceries match this filter.</p> : null}
      </div>
      <aside className="farm-box-panel">
        <div className="farm-box-heading"><span><Sprout size={21} /></span><div><p className="eyebrow">Inventory pass</p><h2>Farm box</h2></div></div>
        <p>Items marked as farm-box produce stay visible. Reconcile only after the list reflects what is already on hand.</p>
        <div className="reconcile-result"><span>{checked} of {week.data.groceries.length} checked</span><strong>{week.data.farmBoxReconciled ? "Reconciled" : "Not reconciled"}</strong></div>
        <button
          className="primary-button full"
          type="button"
          disabled={disabled || week.data.farmBoxReconciled}
          onClick={() => void mutate({
            type: "reconcileGroceries",
            weekId: week.id,
            items: week.data.groceries.map((entry) => ({ id: entry.id, section: entry.section, item: entry.item, detail: entry.detail, checked: entry.checked, farmBox: entry.farmBox })),
          })}
        ><CheckCircle2 size={16} /> {week.data.farmBoxReconciled ? "Groceries reconciled" : "Reconcile current list"}</button>
      </aside>
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
            <div className="segmented-control" aria-label={`Quality for ${leftover.label} leftovers`}>
              {LEFTOVER_QUALITIES.map((quality) => <button key={quality} type="button" aria-label={`Rate ${leftover.label} leftovers ${quality}`} aria-pressed={leftover.quality === quality} className={leftover.quality === quality ? "active" : ""} disabled={disabled} onClick={() => void mutate({ type: "captureLeftoverQuality", weekId: week.id, leftoverId: leftover.id, quality })}>{quality}</button>)}
            </div>
            {leftover.state === "available" && dates.length ? (
              <div className="inline-control-row">
                <select aria-label={`Dinner date for ${leftover.label} leftovers`} value={target} disabled={disabled} onChange={(event) => { assignmentDraft.begin(); setTargets((current) => ({ ...current, [leftover.id]: event.target.value as IsoDate })); }}>{dates.map((date) => <option key={date} value={date}>{formatCalendarDate(date, { weekday: "short", month: "short", day: "numeric" })}</option>)}</select>
                <button className="secondary-button" type="button" aria-label={`Assign ${leftover.label} leftovers`} disabled={disabled} onClick={() => void mutate({ type: "assignLeftover", weekId: week.id, leftoverId: leftover.id, targetDate: target, slot: "dinner" }, assignmentDraft.mutationOptions())}>Assign</button>
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
            <div className="segmented-control feedback-control" aria-label={`Feedback for ${meal.title}`}>
              {FEEDBACK_VALUES.map((value) => <button key={value} type="button" aria-label={`Rate ${meal.title} ${value}`} aria-pressed={week.data.feedback[meal.id] === value} className={week.data.feedback[meal.id] === value ? "active" : ""} disabled={disabled} onClick={() => void mutate({ type: "captureFeedback", weekId: week.id, mealId: meal.id, value })}>{value}</button>)}
            </div>
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
    ingredients: (visibleRecoveryCommand?.changes.ingredients ?? meal.ingredients).join("\n"),
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
        {offline ? (
          <div className="authority-banner warning" role="status">
            <span>Editing is paused until the server reconnects.</span>
            <button className="secondary-button" type="button" onClick={onReconnect}>Reconnect</button>
          </div>
        ) : null}
        {week.status === "archived" ? <p className="inline-alert warning">Archived weeks are read-only.</p> : null}
        {meal.yieldText ? <p className="recipe-yield">Yield: {meal.yieldText}</p> : null}
        {meal.sourceRecipe ? (
          <p className="recipe-source">
            <span>Informational recipe source</span>
            <a href={meal.sourceRecipe.url} target="_blank" rel="noopener noreferrer">
              {meal.sourceRecipe.identity}
            </a>
          </p>
        ) : null}
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
            <select aria-label={`Dinner date for ${meal.title}`} value={draftTargetDate} disabled={disabled} onChange={(event) => { moveDraft.begin(); setTargetDate(event.target.value as IsoDate); }}>{dates.map((date) => <option key={date} value={date}>{formatCalendarDate(date, { weekday: "long", month: "short", day: "numeric" })}</option>)}</select>
            <button className="secondary-button" type="button" disabled={disabled || draftTargetDate === meal.date} onClick={() => void mutate({ type: "moveMeal", weekId: week.id, mealId: meal.id, targetDate: draftTargetDate, slot: "dinner" }, moveDraft.mutationOptions())}>Move dinner</button>
          </div>
          <div className="segmented-control status-control">{MEAL_STATUSES.map((status) => <button key={status} type="button" aria-pressed={meal.status === status} className={meal.status === status ? "active" : ""} disabled={disabled || meal.status === status} onClick={() => void mutate({ type: "updateMealStatus", weekId: week.id, mealId: meal.id, status })}>{status}</button>)}</div>
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
                contextView="week"
                editable={!archived}
                actions={<div className="prep-reference-actions recipe-step-actions">
                  <button className="icon-button" type="button" title={`Move ${stepControlTarget(meal, step, index + 1)} up`} disabled={disabled || index === 0} onClick={() => void mutate({ type: "moveInstructionStep", weekId: week.id, stepId: step.id, targetPosition: index - 1 })}><ArrowUp size={14} /></button>
                  <button className="icon-button" type="button" title={`Move ${stepControlTarget(meal, step, index + 1)} down`} disabled={disabled || index === meal.instructions.length - 1} onClick={() => void mutate({ type: "moveInstructionStep", weekId: week.id, stepId: step.id, targetPosition: index + 1 })}><ArrowDown size={14} /></button>
                  <button className="icon-button danger" type="button" title={`Delete ${stepControlTarget(meal, step, index + 1)}`} disabled={disabled || week.data.prep.some((reference) => reference.stepId === step.id)} onClick={() => void mutate({ type: "removeInstructionStep", weekId: week.id, stepId: step.id })}><Trash2 size={14} /></button>
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

function ChatPanel(props: {
  workspace: InitializedWorkspace;
  week: WeekPlan | null;
  view: PlannerView;
  today: IsoDate;
  disabled: boolean;
  health: HealthResponse | null;
  message: string;
  onMessageChange: Dispatch<SetStateAction<string>>;
  intent: ChatTurnIntent;
  onIntentChange: Dispatch<SetStateAction<ChatTurnIntent>>;
  onSend: SendContextMessage;
  onRetry: (turn: ChatTurn) => void;
  notice?: Notice;
  onDismissNotice?: () => void;
  pendingRetryLabel?: string;
  onRetryPending?: () => void;
  retryDisabled?: boolean;
  onDiscardPending?: () => void;
  offline?: boolean;
  onReconnect?: () => void;
  modal?: boolean;
  onClose?: () => void;
}) {
  const {
    workspace,
    week,
    view,
    today,
    disabled,
    health,
    message,
    onMessageChange,
    intent,
    onIntentChange,
    onSend,
    onRetry,
    notice,
    onDismissNotice,
    pendingRetryLabel,
    onRetryPending,
    retryDisabled,
    onDiscardPending,
    offline = false,
    onReconnect,
    modal = false,
    onClose,
  } = props;
  const endRef = useRef<HTMLDivElement>(null);
  const entries = [...workspace.transcriptEntries].sort((left, right) => left.sequence - right.sequence);
  const turns = [...workspace.chatTurns].sort((left, right) => right.turnSequence - left.turnSequence);
  const running = turns.find((turn) => turn.status === "running");
  const retriedTurnIds = new Set(turns.flatMap((turn) => turn.retryOfTurnId ? [turn.retryOfTurnId] : []));
  const retryable = turns.find(
    (turn) =>
      (turn.status === "failed" || turn.status === "interrupted") &&
      !retriedTurnIds.has(turn.turnId),
  );
  const unappliedTurns = turns.filter(
    (turn) =>
      turn.status === "completed" &&
      (turn.mutationOutcome === "version_conflict" || turn.mutationOutcome === "domain_rejected"),
  );
  const tonightMeal = view === "tonight" && week
    ? week.data.meals.find((meal) => meal.date === today && meal.slot === "dinner")
    : null;
  const tonightLeftover = view === "tonight" && week
    ? week.data.leftovers.find(
        (leftover) =>
          leftover.state === "assigned" &&
          leftover.assignedDate === today &&
          leftover.assignedSlot === "dinner",
      )
    : null;
  const context = plannerChatContextForView(view, week, today);
  const activeIntent = week ? intent : DEFAULT_CHAT_INTENT;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const submittedMessage = message.trim();
    if (!submittedMessage) return;
    void onSend(submittedMessage, context, () => {
      onMessageChange((current) => current.trim() === submittedMessage ? "" : current);
      onIntentChange(DEFAULT_CHAT_INTENT);
    }, activeIntent);
  };
  useEffect(() => {
    if (!week && intent.kind !== "planner") onIntentChange(DEFAULT_CHAT_INTENT);
  }, [intent.kind, onIntentChange, week]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length, running?.status]);
  const codexReady = health?.codex.status === "ready";
  const codexStatusLabel = !health || health.codex.state === "checking"
    ? "Checking ChatGPT"
    : health.codex.state === "compatible"
      ? "ChatGPT ready"
      : health.codex.state === "unauthenticated"
        ? "Planner ready · ChatGPT needs sign-in"
        : health.codex.state === "incompatible"
          ? "Planner ready · ChatGPT runtime incompatible"
          : "Planner ready · ChatGPT unavailable";
  const recoveryOnlyRetry = Boolean(
    retryable && (retryable.acceptedEffectCount > 0 || retryable.mode === "recovery"),
  );
  const retryLabel = recoveryOnlyRetry
    ? "Recover the reply (planner changes will not run again)"
    : "Retry the interrupted ChatGPT request";
  return (
    <aside className={`ops-rail chat-rail ${modal ? "open" : ""}`} aria-label={modal ? undefined : "ChatGPT household chat"}>
      <div className="chat-panel">
        <div className="chat-header">
          <div className="chat-title"><span className="bot-icon"><Bot size={18} /></span><span><strong>ChatGPT</strong><small>Shared household transcript</small></span></div>
          {modal ? <button className="icon-button chat-close" type="button" title="Close chat" onClick={onClose}><X size={18} /></button> : null}
        </div>
        <div className={`bridge-status ${codexReady ? "bridge-ready" : "bridge-unavailable"}`}>
          <span /><small>{codexStatusLabel}</small>
        </div>
        <div className="chat-context"><Home size={12} /> {view}{week ? ` · week ${week.id}` : " · household workspace"}{tonightLeftover ? ` · ${tonightLeftover.label} leftovers` : tonightMeal ? ` · ${tonightMeal.title}` : ""}</div>
        {modal && notice ? (
          <AuthorityNotice
            notice={notice}
            pendingRetryLabel={pendingRetryLabel}
            onRetryPending={onRetryPending}
            retryDisabled={retryDisabled}
            onDiscardPending={onDiscardPending}
            onDismiss={onDismissNotice}
            className="chat-inline-notice"
          />
        ) : null}
        {modal && offline ? (
          <div className="authority-banner warning chat-inline-notice" role="status">
            <span>You are seeing the last shared plan. Editing is paused until the server reconnects.</span>
            <button className="secondary-button" type="button" onClick={onReconnect}>Reconnect</button>
          </div>
        ) : null}
        <div
          className="chat-messages"
          role="log"
          aria-label="Shared ChatGPT transcript"
          aria-live="polite"
          tabIndex={0}
        >
          {!entries.length ? <p className="empty-copy">{week ? "Ask about this week or request a planner change." : "Ask ChatGPT to create the first shared week plan."}</p> : null}
          {entries.map((entry) => (
            <div key={entry.entryId} className={`chat-message ${entry.role}`}>
              {entry.context ? <span className="chat-message-context">{entry.context.view}{entry.context.weekId ? ` · ${entry.context.weekId}` : " · household"}</span> : null}
              <p>{entry.text}</p>
            </div>
          ))}
          {unappliedTurns.map((turn) => (
            <div key={`unapplied-${turn.turnId}`} className="chat-message unapplied">
              <span className="chat-message-context">Planner change not applied</span>
              <p>{turn.mutationOutcome === "version_conflict"
                ? "The shared plan changed first. Review it, then ask ChatGPT again."
                : "The proposed change did not fit the current plan. Review it, then ask ChatGPT again."}</p>
            </div>
          ))}
          {retryable ? (
            <div className={`chat-message ${recoveryOnlyRetry ? "effect-recovery" : "unapplied"}`}>
              <span className="chat-message-context">
                {recoveryOnlyRetry ? "Planner changes saved · reply interrupted" : "ChatGPT request interrupted"}
              </span>
              <p>{recoveryOnlyRetry
                ? "The accepted planner changes are already durable. Recovery reconstructs the reply without running them again."
                : "No planner changes were accepted. Retry starts a new attempt."}</p>
            </div>
          ) : null}
          {running ? <div className="chat-message"><span className="chat-message-context">Working</span><p><LoaderCircle className="spin inline-spinner" size={14} /> {running.researchKind === "sourced_recipe" ? "ChatGPT is researching a recipe…" : "ChatGPT is updating the shared plan…"}</p></div> : null}
          <div ref={endRef} />
        </div>
        {retryable ? <button className="suggestion-button" type="button" disabled={disabled || Boolean(running)} onClick={() => onRetry(retryable)}><RotateCcw size={14} /> {retryLabel}</button> : null}
        <fieldset className="chat-intent-controls" disabled={disabled || Boolean(running)}>
          <legend>ChatGPT task</legend>
          <label className={activeIntent.kind === "planner" ? "active" : ""}>
            <input
              type="radio"
              name={`chat-intent-${modal ? "modal" : "rail"}`}
              checked={activeIntent.kind === "planner"}
              onChange={() => onIntentChange(DEFAULT_CHAT_INTENT)}
            />
            Plan
          </label>
          <label className={activeIntent.kind === "sourced_recipe" ? "active" : ""} aria-disabled={!week}>
            <input
              type="radio"
              name={`chat-intent-${modal ? "modal" : "rail"}`}
              checked={activeIntent.kind === "sourced_recipe"}
              disabled={!week}
              onChange={() => onIntentChange({ kind: "sourced_recipe" })}
            />
            Research recipe
          </label>
        </fieldset>
        {activeIntent.kind === "planner" && week ? (
          <label className="archive-chat-grant">
            <input
              type="checkbox"
              checked={activeIntent.archiveContextWeek}
              disabled={disabled || Boolean(running)}
              onChange={(event) => onIntentChange({
                kind: "planner",
                archiveContextWeek: event.target.checked,
              })}
            />
            Allow archiving week {week.id} for this message
          </label>
        ) : activeIntent.kind === "sourced_recipe" ? (
          <p className="chat-research-note">Search the web, then replace one meal only after the source is validated.</p>
        ) : <p className="chat-research-note">ChatGPT can create the first week without inventing a selected week context.</p>}
        <form className="chat-form" onSubmit={submit}>
          <label className="chat-input-field"><textarea data-autofocus={modal ? "true" : undefined} maxLength={MAX_COMMAND_TEXT_LENGTH} value={message} onChange={(event) => onMessageChange(event.target.value)} placeholder="Ask or change the plan…" aria-label="Message ChatGPT" /><small className="field-limit">{message.length.toLocaleString("en-CA")}/{MAX_COMMAND_TEXT_LENGTH.toLocaleString("en-CA")}</small></label>
          <button type="submit" title="Send to ChatGPT" disabled={disabled || Boolean(running) || !message.trim()}>{disabled || running ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}</button>
        </form>
      </div>
    </aside>
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
      {offline ? (
        <div className="authority-banner warning" role="status">
          <span>Editing is paused until the server reconnects.</span>
          <button className="secondary-button" type="button" onClick={onReconnect}>Reconnect</button>
        </div>
      ) : null}
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
      <div ref={ref} className="mobile-chat-dialog" role="dialog" aria-modal="true" aria-label="ChatGPT household chat">{children}</div>
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
