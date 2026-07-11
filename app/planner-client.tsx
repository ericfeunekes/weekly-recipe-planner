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
  type FormEvent,
  type ReactNode,
} from "react";

import type { HouseholdCommand } from "@/lib/household-command-contract";
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
  type HealthResponse,
  type InitializedWorkspace,
  type PlannerEvent,
  type WorkspaceResponse,
} from "@/lib/planner-api-contract";
import type {
  ChatTurn,
  PlannerChatContext,
  PlannerView,
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

type ConnectionState = "loading" | "online" | "offline";
type Notice = { tone: "info" | "warning" | "error"; message: string } | null;
type Mutate = (
  command: HouseholdCommand,
  options?: { onAccepted?: () => void },
) => Promise<boolean>;
type SendContextMessage = (
  message: string,
  context: PlannerChatContext,
  onAccepted?: () => void,
) => Promise<boolean>;

const ServerOffsetContext = createContext(0);

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

function isoDateForTimeZone(now: number, timeZone: string): IsoDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}` as IsoDate;
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
}) {
  const { candidate, busy, notice, onFresh, onImport, onRetry } = props;
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
        {notice?.tone === "error" ? (
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
  const [plannerPending, setPlannerPending] = useState(false);
  const [chatPending, setChatPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [legacyCandidate, setLegacyCandidate] = useState<LegacyImportCandidate>({
    present: false,
    payload: null,
    error: null,
  });
  const mobile = useMobile();
  const etagRef = useRef<string | null>(null);
  const serverOffsetRef = useRef(0);
  const workspaceRef = useRef<WorkspaceResponse | null>(null);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const plannerMutationInFlight = useRef(false);
  const chatRequestInFlight = useRef(false);
  const appContentRef = useRef<HTMLDivElement>(null);
  const chatTriggerRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

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

  const refresh = useCallback(async (force = false): Promise<void> => {
    if (refreshInFlight.current) {
      await refreshInFlight.current;
      if (!force) return;
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
      } catch (error) {
        if (isAbortError(error)) return;
        setConnection("offline");
        if (!workspaceRef.current) setInitialError(errorMessage(error));
      }
    })().finally(() => {
      refreshInFlight.current = null;
    });
    refreshInFlight.current = task;
    return task;
  }, [acceptWorkspace]);

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
    element.inert = mobile && chatOpen;
    return () => {
      element.inert = false;
    };
  }, [mobile, chatOpen]);

  const bootstrap = useCallback(async (mode: "seed" | "import-v2") => {
    if (plannerMutationInFlight.current) return;
    if (mode === "import-v2" && !legacyCandidate.payload) return;
    plannerMutationInFlight.current = true;
    setPlannerPending(true);
    setNotice(null);
    try {
      const result = await bootstrapWorkspace(
        mode === "seed"
          ? { requestId: createRequestId(), mode: "seed" }
          : { requestId: createRequestId(), mode: "import-v2", payload: legacyCandidate.payload! },
      );
      acceptWorkspace(result.workspace);
      // Browser data is removed only after the server has durably accepted bootstrap.
      window.localStorage.removeItem(LEGACY_V2_STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_V1_STORAGE_KEY);
      setLegacyCandidate({ present: false, payload: null, error: null });
      setNotice({ tone: "info", message: result.imported ? "Browser plan imported." : "Shared planner created." });
      await refresh(true);
    } catch (error) {
      if (error instanceof PlannerApiError && error.workspace) acceptWorkspace(error.workspace);
      if (error instanceof PlannerApiError && error.code === "ALREADY_INITIALIZED") {
        setNotice({
          tone: "warning",
          message: "Another device initialized the planner first. Browser data was kept.",
        });
        await refresh(true);
      } else {
        setNotice({ tone: "error", message: errorMessage(error) });
      }
    } finally {
      plannerMutationInFlight.current = false;
      setPlannerPending(false);
    }
  }, [acceptWorkspace, legacyCandidate.payload, refresh]);

  const mutate: Mutate = useCallback(async (command, options) => {
    const current = workspaceRef.current;
    if (!current?.initialized || plannerMutationInFlight.current || connection !== "online") return false;
    const commandWeekId = "weekId" in command ? command.weekId : null;
    const commandWeek = commandWeekId
      ? current.state.weeks.find((week) => week.id === commandWeekId)
      : null;
    if (commandWeek?.status === "archived") {
      setNotice({ tone: "warning", message: "Archived weeks are read-only." });
      return false;
    }
    plannerMutationInFlight.current = true;
    setPlannerPending(true);
    setNotice(null);
    try {
      const result = await applyPlannerCommand({
        requestId: createRequestId(),
        basePlannerVersion: current.plannerVersion,
        command,
      });
      acceptWorkspace(result.workspace);
      if (result.decision.status === "accepted") {
        options?.onAccepted?.();
        await refresh(true);
        return true;
      }
      if (result.decision.status === "version_conflict") {
        setNotice({
          tone: "warning",
          message: "Someone else changed the plan. Their version is shown; your draft was kept.",
        });
      } else {
        setNotice({ tone: "error", message: result.decision.message });
      }
      return false;
    } catch (error) {
      if (error instanceof PlannerApiError && error.workspace) acceptWorkspace(error.workspace);
      if (error instanceof PlannerApiError && error.code === "NETWORK_ERROR") setConnection("offline");
      setNotice({ tone: "error", message: errorMessage(error) });
      return false;
    } finally {
      plannerMutationInFlight.current = false;
      setPlannerPending(false);
    }
  }, [acceptWorkspace, connection, refresh]);

  const sendContextMessage: SendContextMessage = useCallback(async (message, context, onAccepted) => {
    const current = workspaceRef.current;
    if (!current?.initialized || chatRequestInFlight.current || connection !== "online") return false;
    if (current.chatTurns.some((turn) => turn.status === "running")) {
      setNotice({ tone: "warning", message: "ChatGPT is already working on a household request. Your draft was kept." });
      return false;
    }
    if (health && health.codex.status !== "ready") {
      setNotice({ tone: "warning", message: "The shared planner is online, but ChatGPT is not available." });
      return false;
    }
    chatRequestInFlight.current = true;
    setChatPending(true);
    setNotice(null);
    try {
      const response = await submitChatTurn({
        requestId: createRequestId(),
        basePlannerVersion: current.plannerVersion,
        message,
        context,
      });
      acceptWorkspace(response.workspace);
      if (response.decision.status === "accepted") {
        onAccepted?.();
        await refresh(true);
        return true;
      }
      const decision = response.decision;
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
      if (error instanceof PlannerApiError && error.code === "NETWORK_ERROR") setConnection("offline");
      setNotice({ tone: "error", message: errorMessage(error) });
      return false;
    } finally {
      chatRequestInFlight.current = false;
      setChatPending(false);
    }
  }, [acceptWorkspace, connection, health, refresh]);

  const retryTurn = useCallback(async (turn: ChatTurn) => {
    const current = workspaceRef.current;
    if (!current?.initialized || chatRequestInFlight.current || connection !== "online") return;
    chatRequestInFlight.current = true;
    setChatPending(true);
    setNotice(null);
    try {
      const response = await retryChatTurn({
        requestId: createRequestId(),
        basePlannerVersion: current.plannerVersion,
        turnId: turn.turnId,
      });
      acceptWorkspace(response.workspace);
      if (response.decision.status !== "accepted") {
        setNotice({ tone: "warning", message: "That chat turn could not be retried yet." });
      }
      await refresh(true);
    } catch (error) {
      if (error instanceof PlannerApiError && error.workspace) acceptWorkspace(error.workspace);
      setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      chatRequestInFlight.current = false;
      setChatPending(false);
    }
  }, [acceptWorkspace, connection, refresh]);

  const runUndo = useCallback(async (event: PlannerEvent) => {
    const current = workspaceRef.current;
    if (!current?.initialized || plannerMutationInFlight.current || connection !== "online") return;
    plannerMutationInFlight.current = true;
    setPlannerPending(true);
    setNotice(null);
    try {
      const result = await undoLatest({
        requestId: createRequestId(),
        basePlannerVersion: current.plannerVersion,
        targetEventId: event.eventId,
      });
      acceptWorkspace(result.workspace);
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
      setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      plannerMutationInFlight.current = false;
      setPlannerPending(false);
    }
  }, [acceptWorkspace, connection, refresh]);

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
  const isReadOnly = connection !== "online" || plannerPending || week?.status === "archived";
  const progress = week ? progressForWeek(week) : { complete: 0, total: 0 };
  const heading = view === "tonight" ? "Tonight" : view === "closeout" ? "Close out" : `${view[0].toUpperCase()}${view.slice(1)}`;
  return (
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
            <button className="icon-button" type="button" title="Change history" onClick={() => setHistoryOpen(true)}>
              <History size={19} />
            </button>
            <button
              ref={chatTriggerRef}
              className="primary-button"
              type="button"
              onClick={() => {
                if (mobile) setChatOpen(true);
                else document.querySelector<HTMLTextAreaElement>('.chat-rail textarea[aria-label="Message ChatGPT"]')?.focus();
              }}
              aria-expanded={mobile ? chatOpen : undefined}
              aria-label={mobile ? "Open ChatGPT" : undefined}
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
                onClick={() => navigate(item.id)}
              >
                <Icon size={16} /> {item.label}
              </button>
            );
          })}
        </nav>

        <main className="app-main">
          {notice ? (
            <div className={`authority-banner ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
              <span>{notice.message}</span>
              <button className="icon-button" type="button" title="Dismiss" onClick={() => setNotice(null)}><X size={16} /></button>
            </div>
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

          {!week ? (
            <section className="lifecycle-surface empty-workspace">
              <CalendarDays size={30} />
              <h2>No weeks yet</h2>
              <p>Ask ChatGPT to build the first week plan.</p>
            </section>
          ) : (
            <div className="workspace">
              <section className="primary-workspace">
                {view === "week" ? (
                  <WeekView week={week} today={today} onOpenMeal={setSelectedMealId} onNavigate={navigate} />
                ) : view === "tonight" ? (
                  <TonightView
                    week={week}
                    today={today}
                    disabled={isReadOnly}
                    mutate={mutate}
                    sendContextMessage={sendContextMessage}
                    onOpenMeal={setSelectedMealId}
                  />
                ) : view === "prep" ? (
                  <PrepView
                    week={week}
                    disabled={isReadOnly}
                    mutate={mutate}
                    sendContextMessage={sendContextMessage}
                    onOpenMeal={setSelectedMealId}
                  />
                ) : view === "groceries" ? (
                  <GroceryView week={week} disabled={isReadOnly} mutate={mutate} />
                ) : (
                  <CloseoutView key={week.id} week={week} disabled={isReadOnly} mutate={mutate} />
                )}
              </section>
              {!mobile ? (
                <ChatPanel
                  workspace={initialized}
                  week={week}
                  view={view}
                  disabled={connection !== "online" || chatPending || (health !== null && health.codex.status !== "ready")}
                  health={health}
                  onSend={sendContextMessage}
                  onRetry={retryTurn}
                />
              ) : null}
            </div>
          )}
        </main>

        <nav className="mobile-nav" aria-label="Planner views">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} type="button" className={view === item.id ? "active" : ""} onClick={() => navigate(item.id)}>
                <Icon size={17} /><span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {selectedMeal && week ? (
          <MealDrawer
            key={selectedMeal.id}
            meal={selectedMeal}
            week={week}
            disabled={isReadOnly}
            mutate={mutate}
            sendContextMessage={sendContextMessage}
            onClose={() => setSelectedMealId(null)}
          />
        ) : null}
        {historyOpen ? (
          <HistoryDrawer
            workspace={initialized}
            disabled={connection !== "online" || plannerPending}
            onUndo={runUndo}
            onClose={() => setHistoryOpen(false)}
          />
        ) : null}
      </div>

      {mobile && chatOpen && week ? (
        <ModalChat onClose={() => setChatOpen(false)} restoreFocusRef={chatTriggerRef}>
          <ChatPanel
            workspace={initialized}
            week={week}
            view={view}
            disabled={connection !== "online" || chatPending || (health !== null && health.codex.status !== "ready")}
            health={health}
            onSend={sendContextMessage}
            onRetry={retryTurn}
            modal
            onClose={() => setChatOpen(false)}
          />
        </ModalChat>
      ) : null}
    </div>
    </ServerOffsetContext.Provider>
  );
}

function WeekView({ week, today, onOpenMeal, onNavigate }: { week: WeekPlan; today: IsoDate; onOpenMeal: (id: string) => void; onNavigate: (view: PlannerView) => void }) {
  const dates = Array.from({ length: 7 }, (_, index) => addIsoDateDays(week.id, index));
  return (
    <div className="week-view">
      <div className="week-grid">
        {dates.map((date) => {
          const meal = week.data.meals.find((item) => item.date === date && item.slot === "dinner");
          return (
            <div key={date} className={`day-column ${date === today ? "today" : ""}`}>
              <div className="day-heading">
                <div><span>{dayName(date, "short")}</span>{date === today ? <small>Today</small> : null}</div>
                <strong>{Number(date.slice(-2))}</strong>
              </div>
              {meal ? (
                <button className="meal-card" type="button" onClick={() => onOpenMeal(meal.id)}>
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
  onOpenMeal: (id: string) => void;
}) {
  const { week, today, disabled, mutate, sendContextMessage, onOpenMeal } = props;
  const meal = week.data.meals.find((item) => item.date === today && item.slot === "dinner");
  if (!weekContainsDate(week.id, today) || !meal) {
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
            <p>{meal.subtitle}</p>
          </div>
          <span className={`status-badge ${statusTone(meal.status)}`}>{meal.status}</span>
        </div>
        <div className="tonight-actions">
          <button className="secondary-button" type="button" onClick={() => onOpenMeal(meal.id)}><PencilLine size={16} /> Recipe</button>
          {meal.status !== "cooking" && meal.status !== "cooked" ? (
            <button className="primary-button" type="button" disabled={disabled} onClick={() => void mutate({ type: "updateMealStatus", weekId: week.id, mealId: meal.id, status: "cooking" })}><Play size={16} /> Start cooking</button>
          ) : null}
          {meal.status !== "cooked" ? (
            <button className="secondary-button" type="button" disabled={disabled} onClick={() => void mutate({ type: "updateMealStatus", weekId: week.id, mealId: meal.id, status: "cooked" })}><Check size={16} /> Mark cooked</button>
          ) : null}
        </div>
        <div className="section-title"><ListChecks size={17} /><h3>Instructions</h3><span>{complete}/{meal.instructions.length} done</span></div>
        <div className="instruction-steps">
          {meal.instructions.map((step) => (
            <StepCard
              key={step.id}
              step={step}
              meal={meal}
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
  const elapsed = step.timerStartedAt === undefined ? 0 : Math.floor((now + serverOffset - step.timerStartedAt) / 1_000);
  const remaining = Math.max(0, step.timerDurationSeconds - elapsed);
  const minutes = Math.floor(remaining / 60).toString().padStart(2, "0");
  const seconds = (remaining % 60).toString().padStart(2, "0");
  return <strong>{minutes}:{seconds}</strong>;
}

function StepCard(props: {
  step: InstructionStep;
  meal: Meal;
  week: WeekPlan;
  disabled: boolean;
  mutate: Mutate;
  sendContextMessage: SendContextMessage;
  contextView: PlannerView;
  actions?: ReactNode;
  editable?: boolean;
}) {
  const { step, meal, week, disabled, mutate, sendContextMessage, contextView, actions, editable = false } = props;
  const [comment, setComment] = useState("");
  const [instruction, setInstruction] = useState(step.instruction);
  const [inputs, setInputs] = useState(step.inputs.map((input) => `${input.amount} | ${input.ingredient}`).join("\n"));
  const [timerMinutes, setTimerMinutes] = useState(step.timerDurationSeconds ? String(step.timerDurationSeconds / 60) : "");
  const chatContext: PlannerChatContext = { view: contextView, weekId: week.id, mealId: meal.id, stepId: step.id };
  const parsedInputs = inputs.split("\n").filter((line) => line.trim()).map((line) => {
    const [amount, ...ingredient] = line.split("|");
    return { amount: amount.trim(), ingredient: ingredient.join("|").trim() };
  });
  const timerMinutesNumber = timerMinutes.trim() === "" ? null : Number(timerMinutes);
  const timerValid =
    timerMinutesNumber === null ||
    (Number.isFinite(timerMinutesNumber) && timerMinutesNumber > 0 && timerMinutesNumber <= 1_440);
  const timerSeconds = timerMinutesNumber === null ? null : Math.max(1, Math.round(timerMinutesNumber * 60));
  return (
    <article className={`instruction-step ${step.complete ? "complete" : ""}`}>
      <div className="instruction-step-heading">
        <label className="step-checkbox">
          <input
            type="checkbox"
            checked={step.complete}
            disabled={disabled}
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
          <span>{step.timerStartedAt !== undefined ? "running" : "timer"}</span>
          <button
            className="icon-button"
            type="button"
            title={step.timerStartedAt !== undefined ? "Reset timer" : "Start timer"}
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
            disabled={disabled}
            onClick={() => void mutate({ type: "updateInstructionStepNote", weekId: week.id, stepId: step.id, note: "" })}
          ><X size={14} /></button>
        </div>
      ) : null}
      {editable ? (
        <details className="step-comment">
          <summary><PencilLine size={14} /> Edit instruction</summary>
          <div className="step-comment-body">
            <label className="full-field"><span>Amounts, one per line: amount | ingredient</span><textarea value={inputs} onChange={(event) => setInputs(event.target.value)} /></label>
            <label className="full-field"><span>Instruction</span><textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} /></label>
            <label className="full-field"><span>Timer minutes (optional, up to 1,440)</span><input type="number" min="0.5" max="1440" step="0.5" value={timerMinutes} onChange={(event) => setTimerMinutes(event.target.value)} /></label>
            <button
              className="secondary-button"
              type="button"
              disabled={disabled || !instruction.trim() || !timerValid}
              onClick={() => void mutate({
                type: "updateInstructionStep",
                weekId: week.id,
                stepId: step.id,
                changes: { inputs: parsedInputs, instruction: instruction.trim(), timerDurationSeconds: timerSeconds },
              })}
            ><Check size={15} /> Save instruction</button>
          </div>
        </details>
      ) : null}
      <details className="step-comment">
        <summary><MessageSquareText size={14} /> Add note or ask ChatGPT</summary>
        <div className="step-comment-body">
          <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="What changed, or what should ChatGPT help with?" />
          <div className="step-comment-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={disabled || !comment.trim()}
              onClick={() => void mutate(
                { type: "updateInstructionStepNote", weekId: week.id, stepId: step.id, note: comment.trim() },
                { onAccepted: () => setComment("") },
              )}
            ><StickyNote size={14} /> Add note</button>
            <button
              className="primary-button"
              type="button"
              disabled={disabled || !comment.trim()}
              onClick={() => void sendContextMessage(comment.trim(), chatContext, () => setComment(""))}
            ><Bot size={14} /> Send to ChatGPT</button>
          </div>
        </div>
      </details>
    </article>
  );
}

function PrepView(props: {
  week: WeekPlan;
  disabled: boolean;
  mutate: Mutate;
  sendContextMessage: SendContextMessage;
  onOpenMeal: (id: string) => void;
}) {
  const { week, disabled, mutate, sendContextMessage, onOpenMeal } = props;
  const [stepId, setStepId] = useState("");
  const [prepDate, setPrepDate] = useState<IsoDate>(addIsoDateDays(week.id, -1));
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
          <select value={stepId} onChange={(event) => setStepId(event.target.value)} aria-label="Instruction to add to prep">
            <option value="">Choose a recipe step</option>
            {available.map(({ meal, step }) => <option key={step.id} value={step.id}>{meal.title}: {step.instruction}</option>)}
          </select>
          <select value={prepDate} onChange={(event) => setPrepDate(event.target.value as IsoDate)} aria-label="Prep date">
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
              { onAccepted: () => setStepId("") },
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
                const actions = (
                  <div className="prep-reference-actions">
                    <button className="step-meal-link" type="button" onClick={() => onOpenMeal(resolved.meal.id)}>{resolved.meal.title}<ChevronRight size={13} /></button>
                    <button className="icon-button" type="button" title="Move up" disabled={disabled || index === 0} onClick={() => void mutate({ type: "movePrepReference", weekId: week.id, referenceId: reference.id, targetPosition: index - 1 })}><ArrowUp size={14} /></button>
                    <button className="icon-button" type="button" title="Move down" disabled={disabled || index === references.length - 1} onClick={() => void mutate({ type: "movePrepReference", weekId: week.id, referenceId: reference.id, targetPosition: index + 1 })}><ArrowDown size={14} /></button>
                    <select value={reference.prepDate} disabled={disabled} aria-label="Move prep step to date" onChange={(event) => void mutate({ type: "reschedulePrepReference", weekId: week.id, referenceId: reference.id, prepDate: event.target.value as IsoDate })}>
                      {dates.map((target) => <option key={target} value={target}>{formatCalendarDate(target, { weekday: "short", day: "numeric" })}</option>)}
                    </select>
                    <button className="icon-button danger" type="button" title="Remove from prep" disabled={disabled} onClick={() => void mutate({ type: "removePrepReference", weekId: week.id, referenceId: reference.id })}><Trash2 size={14} /></button>
                  </div>
                );
                return <StepCard key={reference.id} step={resolved.step} meal={resolved.meal} week={week} disabled={disabled} mutate={mutate} sendContextMessage={sendContextMessage} contextView="prep" actions={actions} />;
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
  const visible = week.data.groceries.filter((entry) => filter === "all" || (filter === "done" ? entry.checked : !entry.checked));
  const checked = week.data.groceries.filter((entry) => entry.checked).length;
  return (
    <div className="grocery-layout">
      <div className="grocery-list">
        <div className="surface-summary grocery-summary">
          <div><p className="eyebrow">Shared shopping list</p><h2>Groceries</h2></div>
          <div className="segmented-control" aria-label="Grocery filter">
            {(["all", "open", "done"] as const).map((value) => <button key={value} type="button" className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{value}</button>)}
          </div>
        </div>
        <div className="grocery-add-row">
          <select value={section} onChange={(event) => setSection(event.target.value as GroceryItem["section"])} aria-label="Grocery section">{GROCERY_SECTIONS.map((value) => <option key={value}>{value}</option>)}</select>
          <input value={item} onChange={(event) => setItem(event.target.value)} placeholder="Item" aria-label="New grocery item" />
          <input value={detail} onChange={(event) => setDetail(event.target.value)} placeholder="Amount or detail" aria-label="Grocery detail" />
          <button className="secondary-button" type="button" disabled={disabled || !item.trim()} onClick={() => void mutate(
            { type: "addGroceryItem", weekId: week.id, item: { section, item: item.trim(), detail: detail.trim(), farmBox: false } },
            { onAccepted: () => { setItem(""); setDetail(""); } },
          )}><Plus size={15} /> Add</button>
        </div>
        {GROCERY_SECTIONS.map((group) => {
          const entries = visible.filter((entry) => entry.section === group);
          if (!entries.length) return null;
          return (
            <section className="grocery-section" key={group}>
              <h3>{group}<span>{entries.length}</span></h3>
              {entries.map((entry) => (
                <div className={`grocery-row ${entry.checked ? "checked" : ""}`} key={entry.id}>
                  <input type="checkbox" checked={entry.checked} disabled={disabled} aria-label={`Check ${entry.item}`} onChange={(event) => void mutate({ type: "setGroceryItemChecked", weekId: week.id, itemId: entry.id, checked: event.target.checked })} />
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
  return (
    <div className="leftover-feedback">
      {week.data.leftovers.map((leftover) => {
        const source = week.data.meals.find((meal) => meal.id === leftover.sourceMealId);
        const dates = Array.from({ length: 7 }, (_, index) => addIsoDateDays(week.id, index)).filter((date) => !source || date > source.date);
        const target = targets[leftover.id] ?? dates[0];
        return (
          <div key={leftover.id}>
            <span><strong>{leftover.label} · {leftover.portions} portions</strong><small>{leftover.state}{leftover.assignedDate ? ` for ${leftover.assignedDate}` : ""}</small></span>
            <div className="segmented-control">
              {LEFTOVER_QUALITIES.map((quality) => <button key={quality} type="button" className={leftover.quality === quality ? "active" : ""} disabled={disabled} onClick={() => void mutate({ type: "captureLeftoverQuality", weekId: week.id, leftoverId: leftover.id, quality })}>{quality}</button>)}
            </div>
            {leftover.state === "available" && dates.length ? (
              <div className="inline-control-row">
                <select value={target} disabled={disabled} onChange={(event) => setTargets((current) => ({ ...current, [leftover.id]: event.target.value as IsoDate }))}>{dates.map((date) => <option key={date} value={date}>{formatCalendarDate(date, { weekday: "short", month: "short", day: "numeric" })}</option>)}</select>
                <button className="secondary-button" type="button" disabled={disabled} onClick={() => void mutate({ type: "assignLeftover", weekId: week.id, leftoverId: leftover.id, targetDate: target, slot: "dinner" })}>Assign</button>
              </div>
            ) : null}
            {leftover.state === "assigned" ? <button className="secondary-button" type="button" disabled={disabled} onClick={() => void mutate({ type: "consumeLeftover", weekId: week.id, leftoverId: leftover.id })}><Check size={15} /> Mark eaten</button> : null}
          </div>
        );
      })}
      {!week.data.leftovers.length ? <p className="empty-copy">Cooking a meal with planned leftovers will add it here.</p> : null}
    </div>
  );
}

function CloseoutView({ week, disabled, mutate }: { week: WeekPlan; disabled: boolean; mutate: Mutate }) {
  const [lesson, setLesson] = useState(week.data.weekLesson);
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
            <div className="segmented-control feedback-control">
              {FEEDBACK_VALUES.map((value) => <button key={value} type="button" className={week.data.feedback[meal.id] === value ? "active" : ""} disabled={disabled} onClick={() => void mutate({ type: "captureFeedback", weekId: week.id, mealId: meal.id, value })}>{value}</button>)}
            </div>
          </div>
        ))}
      </div>
      <aside className="closeout-notes">
        <label><span>What should next week remember?</span><textarea value={lesson} onChange={(event) => setLesson(event.target.value)} placeholder="A short planning lesson" /></label>
        <button className="secondary-button" type="button" disabled={disabled || lesson === week.data.weekLesson} onClick={() => void mutate({ type: "captureWeekLesson", weekId: week.id, weekLesson: lesson })}><StickyNote size={15} /> Save lesson</button>
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
  onClose: () => void;
}) {
  const { meal, week, disabled, mutate, sendContextMessage, onClose } = props;
  const [title, setTitle] = useState(meal.title);
  const [subtitle, setSubtitle] = useState(meal.subtitle);
  const [venue, setVenue] = useState(meal.venue);
  const [prepNote, setPrepNote] = useState(meal.prepNote);
  const [leftoverNote, setLeftoverNote] = useState(meal.leftoverNote);
  const [notes, setNotes] = useState(meal.notes);
  const [ingredients, setIngredients] = useState(meal.ingredients.join("\n"));
  const [targetDate, setTargetDate] = useState<IsoDate>(meal.date);
  const [newInstruction, setNewInstruction] = useState("");
  const [newInputs, setNewInputs] = useState("");
  const [newTimer, setNewTimer] = useState("");
  const dates = Array.from({ length: 7 }, (_, index) => addIsoDateDays(week.id, index));
  const newTimerMinutes = newTimer.trim() === "" ? null : Number(newTimer);
  const newTimerValid =
    newTimerMinutes === null ||
    (Number.isFinite(newTimerMinutes) && newTimerMinutes > 0 && newTimerMinutes <= 1_440);
  const save = () => void mutate(
    {
      type: "updateMealSnapshot",
      weekId: week.id,
      mealId: meal.id,
      changes: {
        title: title.trim(), subtitle: subtitle.trim(), venue: venue.trim(), prepNote: prepNote.trim(), leftoverNote: leftoverNote.trim(), notes: notes.trim(),
        ingredients: ingredients.split("\n").map((line) => line.trim()).filter(Boolean),
      },
    },
  );
  return (
    <ModalDrawer title={meal.title} className="meal-drawer" onClose={onClose}>
      <div className="drawer-body">
        {week.status === "archived" ? <p className="inline-alert warning">Archived weeks are read-only.</p> : null}
        <div className="field-grid">
          <label><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label><span>Venue</span><input value={venue} onChange={(event) => setVenue(event.target.value)} /></label>
        </div>
        <label className="full-field"><span>Subtitle</span><input value={subtitle} onChange={(event) => setSubtitle(event.target.value)} /></label>
        <label className="full-field"><span>Ingredients, one per line</span><textarea rows={5} value={ingredients} onChange={(event) => setIngredients(event.target.value)} /></label>
        <label className="full-field"><span>Recipe note</span><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <div className="field-grid">
          <label><span>Prep note</span><textarea value={prepNote} onChange={(event) => setPrepNote(event.target.value)} /></label>
          <label><span>Leftover note</span><textarea value={leftoverNote} onChange={(event) => setLeftoverNote(event.target.value)} /></label>
        </div>
        <button className="primary-button" type="button" disabled={disabled || !title.trim() || !venue.trim()} onClick={save}><Check size={15} /> Save recipe details</button>
        <div className="snapshot-section">
          <h3>Schedule and status</h3>
          <div className="inline-control-row">
            <select value={targetDate} disabled={disabled} onChange={(event) => setTargetDate(event.target.value as IsoDate)}>{dates.map((date) => <option key={date} value={date}>{formatCalendarDate(date, { weekday: "long", month: "short", day: "numeric" })}</option>)}</select>
            <button className="secondary-button" type="button" disabled={disabled || targetDate === meal.date} onClick={() => void mutate({ type: "moveMeal", weekId: week.id, mealId: meal.id, targetDate, slot: "dinner" })}>Move dinner</button>
          </div>
          <div className="segmented-control status-control">{MEAL_STATUSES.map((status) => <button key={status} type="button" className={meal.status === status ? "active" : ""} disabled={disabled || meal.status === status} onClick={() => void mutate({ type: "updateMealStatus", weekId: week.id, mealId: meal.id, status })}>{status}</button>)}</div>
        </div>
        <div className="snapshot-section">
          <h3>Instructions</h3>
          <div className="instruction-steps drawer-instruction-steps">
            {meal.instructions.map((step, index) => (
              <StepCard
                key={step.id}
                step={step}
                meal={meal}
                week={week}
                disabled={disabled}
                mutate={mutate}
                sendContextMessage={sendContextMessage}
                contextView="week"
                editable
                actions={<div className="prep-reference-actions">
                  <button className="icon-button" type="button" title="Move instruction up" disabled={disabled || index === 0} onClick={() => void mutate({ type: "moveInstructionStep", weekId: week.id, stepId: step.id, targetPosition: index - 1 })}><ArrowUp size={14} /></button>
                  <button className="icon-button" type="button" title="Move instruction down" disabled={disabled || index === meal.instructions.length - 1} onClick={() => void mutate({ type: "moveInstructionStep", weekId: week.id, stepId: step.id, targetPosition: index + 1 })}><ArrowDown size={14} /></button>
                  <button className="icon-button danger" type="button" title="Delete instruction" disabled={disabled || week.data.prep.some((reference) => reference.stepId === step.id)} onClick={() => void mutate({ type: "removeInstructionStep", weekId: week.id, stepId: step.id })}><Trash2 size={14} /></button>
                </div>}
              />
            ))}
          </div>
          <div className="instruction-step new-step-form">
            <label className="full-field"><span>Amounts: amount | ingredient</span><textarea value={newInputs} onChange={(event) => setNewInputs(event.target.value)} /></label>
            <label className="full-field"><span>New instruction</span><textarea value={newInstruction} onChange={(event) => setNewInstruction(event.target.value)} /></label>
            <label className="full-field"><span>Timer minutes (optional, up to 1,440)</span><input type="number" min="0.5" max="1440" step="0.5" value={newTimer} onChange={(event) => setNewTimer(event.target.value)} /></label>
            <button className="secondary-button" type="button" disabled={disabled || !newInstruction.trim() || !newTimerValid} onClick={() => {
              if (!newTimerValid) return;
              const timer = newTimerMinutes === null ? undefined : Math.max(1, Math.round(newTimerMinutes * 60));
              void mutate(
                {
                  type: "addInstructionStep", weekId: week.id, mealId: meal.id, position: meal.instructions.length,
                  step: {
                    inputs: newInputs.split("\n").filter((line) => line.trim()).map((line) => { const [amount, ...ingredient] = line.split("|"); return { amount: amount.trim(), ingredient: ingredient.join("|").trim() }; }),
                    instruction: newInstruction.trim(), ...(timer ? { timerDurationSeconds: timer } : {}),
                  },
                },
                { onAccepted: () => { setNewInstruction(""); setNewInputs(""); setNewTimer(""); } },
              );
            }}><Plus size={15} /> Add instruction</button>
          </div>
        </div>
      </div>
      <div className="drawer-footer"><button className="secondary-button" type="button" onClick={onClose}>Close</button></div>
    </ModalDrawer>
  );
}

function ChatPanel(props: {
  workspace: InitializedWorkspace;
  week: WeekPlan;
  view: PlannerView;
  disabled: boolean;
  health: HealthResponse | null;
  onSend: SendContextMessage;
  onRetry: (turn: ChatTurn) => void;
  modal?: boolean;
  onClose?: () => void;
}) {
  const { workspace, week, view, disabled, health, onSend, onRetry, modal = false, onClose } = props;
  const [message, setMessage] = useState("");
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
  const context: PlannerChatContext = { view, weekId: week.id };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!message.trim()) return;
    void onSend(message.trim(), context, () => setMessage(""));
  };
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length, running?.status]);
  const codexReady = health?.codex.status === "ready";
  return (
    <aside className={`ops-rail chat-rail ${modal ? "open" : ""}`} aria-label={modal ? undefined : "ChatGPT household chat"}>
      <div className="chat-panel">
        <div className="chat-header">
          <div className="chat-title"><span className="bot-icon"><Bot size={18} /></span><span><strong>ChatGPT</strong><small>Shared household transcript</small></span></div>
          {modal ? <button className="icon-button chat-close" type="button" title="Close chat" onClick={onClose}><X size={18} /></button> : null}
        </div>
        <div className={`bridge-status ${codexReady ? "bridge-ready" : "bridge-unavailable"}`}>
          <span /><small>{health ? (codexReady ? "ChatGPT ready" : "Planner ready · ChatGPT unavailable") : "Checking ChatGPT"}</small>
        </div>
        <div className="chat-context"><Home size={12} /> {view} · week {week.id}</div>
        <div className="chat-messages" aria-live="polite">
          {!entries.length ? <p className="empty-copy">Ask about this week or request a planner change.</p> : null}
          {entries.map((entry) => (
            <div key={entry.entryId} className={`chat-message ${entry.role}`}>
              {entry.context ? <span className="chat-message-context">{entry.context.view} · {entry.context.weekId}</span> : null}
              <p>{entry.text}</p>
            </div>
          ))}
          {running ? <div className="chat-message"><span className="chat-message-context">Working</span><p><LoaderCircle className="spin inline-spinner" size={14} /> ChatGPT is updating the shared plan…</p></div> : null}
          <div ref={endRef} />
        </div>
        {retryable ? <button className="suggestion-button" type="button" disabled={disabled || Boolean(running)} onClick={() => onRetry(retryable)}><RotateCcw size={14} /> Retry the interrupted ChatGPT request</button> : null}
        <form className="chat-form" onSubmit={submit}>
          <textarea data-autofocus={modal ? "true" : undefined} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Ask or change the plan…" aria-label="Message ChatGPT" />
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
  onClose: () => void;
}) {
  const { workspace, disabled, onUndo, onClose } = props;
  const events = [...workspace.events].sort((left, right) => right.sequence - left.sequence);
  const latest = events[0];
  const canUndo = latest && latest.command.type !== "undoLatest";
  return (
    <ModalDrawer title="Recent changes" className="history-drawer" onClose={onClose}>
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

function ModalDrawer({ title, className = "", onClose, children }: { title: string; className?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose);
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
    const focusable = () => root ? Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')) : [];
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
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      const focusTarget = restoreFocus?.isConnected
        ? restoreFocus
        : previous?.isConnected
          ? previous
          : null;
      if (focusTarget) window.requestAnimationFrame(() => focusTarget.focus());
    };
  }, [ref, restoreFocusRef]);
}
