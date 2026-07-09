"use client";

import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Bot,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ClipboardCheck,
  Clock3,
  CookingPot,
  History,
  Home,
  ListChecks,
  MapPin,
  MessageCircle,
  Minus,
  PackageCheck,
  PencilLine,
  Plus,
  RotateCcw,
  Send,
  ShoppingBasket,
  Sparkles,
  Sprout,
  Utensils,
  X,
  type LucideIcon,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  executeDomainCommand,
  isSupportedSalmonMoveIntent,
  type DomainCommand,
  type GroceryItem,
  type Leftover,
  type Meal,
  type MealStatus,
  type PlannerData,
  type PrepTask,
} from "@/lib/planner-domain";

type View = "week" | "tonight" | "prep" | "groceries" | "closeout";
type Actor = "You" | "Codex";
type WeekState = "archived" | "active" | "draft";

type EventEntry = {
  id: string;
  actor: Actor;
  command: string;
  summary: string;
  target: string;
  changes: string[];
  before?: PlannerData;
  time: string;
};

type UndoState = {
  snapshot: PlannerData;
  summary: string;
  actor: Actor;
} | null;

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  changes?: string[];
};

const DAYS = [
  { name: "Monday", short: "Mon", date: "6" },
  { name: "Tuesday", short: "Tue", date: "7" },
  { name: "Wednesday", short: "Wed", date: "8" },
  { name: "Thursday", short: "Thu", date: "9" },
  { name: "Friday", short: "Fri", date: "10" },
  { name: "Saturday", short: "Sat", date: "11" },
  { name: "Sunday", short: "Sun", date: "12" },
] as const;

const TODAY_INDEX = 3;
const ACTIVE_WEEK_ID = "2026-07-06";
const STORAGE_KEY = "weekly-recipe-planner:v1";

const WEEK_OPTIONS: Array<{
  id: string;
  label: string;
  range: string;
  state: WeekState;
}> = [
  { id: "2026-06-29", label: "Jun 29", range: "Jun 29 - Jul 5", state: "archived" },
  { id: ACTIVE_WEEK_ID, label: "Jul 6", range: "Jul 6 - 12", state: "active" },
  { id: "2026-07-13", label: "Jul 13", range: "Jul 13 - 19", state: "draft" },
];

const INITIAL_DATA: PlannerData = {
  meals: [
    {
      id: "meal-mon",
      dayIndex: 0,
      title: "Harissa chicken traybake",
      subtitle: "Peppers, chickpeas, lemon yogurt",
      venue: "Home",
      status: "cooked",
      protein: "chicken",
      prepNote: "Marinated Sunday",
      leftoverNote: "2 lunch portions chilled",
      notes: "Keep one tray mild. Finish with parsley and lemon at the table.",
      ingredients: [
        "900 g boneless chicken thighs",
        "2 red peppers, sliced",
        "1 x 540 mL can chickpeas",
        "3 tbsp harissa paste",
        "1 lemon",
      ],
      instructions: [
        "Roast chicken, peppers, and chickpeas at 220 C for 28 minutes.",
        "Rest 5 minutes, then finish with lemon and parsley.",
        "Pack two lunch portions before serving dinner.",
      ],
    },
    {
      id: "meal-tue",
      dayIndex: 1,
      title: "Lemon chicken pitas",
      subtitle: "Cucumber, herbs, feta",
      venue: "Waeg",
      status: "cooked",
      protein: "chicken",
      prepNote: "Packed by 4:30 PM",
      leftoverNote: "1 portable lunch",
      notes: "Use the Monday chicken cold. Pack sauce separately.",
      ingredients: [
        "450 g cooked harissa chicken",
        "6 whole-wheat pitas",
        "1 English cucumber",
        "180 g feta",
        "1 cup lemon yogurt sauce",
      ],
      instructions: [
        "Slice the chicken and cucumber.",
        "Pack pitas, filling, and sauce separately in the cooler.",
        "Assemble just before eating.",
      ],
    },
    {
      id: "meal-wed",
      dayIndex: 2,
      title: "Chicken and greens grain bowls",
      subtitle: "Farm-box spinach, pickled cucumber",
      venue: "Home",
      status: "leftover",
      protein: "chicken",
      prepNote: "Use cooked farro",
      leftoverNote: "Clears Monday chicken",
      notes: "An intentional leftover night, not a backup plan.",
      ingredients: [
        "Remaining harissa chicken",
        "3 cups cooked farro",
        "Farm-box spinach",
        "Pickled cucumber",
      ],
      instructions: [
        "Warm the farro and chicken.",
        "Wilt spinach in the hot farro.",
        "Top with pickled cucumber and yogurt sauce.",
      ],
    },
    {
      id: "meal-thu",
      dayIndex: 3,
      title: "Miso salmon rice bowls",
      subtitle: "Snap peas, sesame, cucumber",
      venue: "Home",
      status: "cooking",
      protein: "salmon",
      prepNote: "Salmon thawed | rice at 5:15 PM",
      leftoverNote: "Reserve 2 salmon portions",
      notes: "Cook four extra salmon pieces for Saturday. Keep the cucumber crisp.",
      ingredients: [
        "680 g salmon fillet, cut in 6 pieces",
        "3 tbsp white miso",
        "2 tbsp low-sodium soy sauce",
        "2 cups jasmine rice",
        "300 g snap peas",
        "1 English cucumber",
      ],
      instructions: [
        "Start the rice and heat the oven to 220 C.",
        "Brush salmon with miso-soy glaze; roast for 9-11 minutes.",
        "Blister snap peas, slice cucumber, and build bowls.",
        "Cool two salmon portions promptly for Saturday.",
      ],
    },
    {
      id: "meal-fri",
      dayIndex: 4,
      title: "Chicken lo mein",
      subtitle: "Fresh noodles, bok choy, peppers",
      venue: "Home",
      status: "planned",
      protein: "chicken",
      prepNote: "Sauce mixed | 15 minutes",
      leftoverNote: "2 lunch portions expected",
      notes: "Use fresh lo mein noodles, not dried pasta.",
      ingredients: [
        "450 g fresh lo mein noodles",
        "400 g chicken thighs, sliced",
        "2 heads baby bok choy",
        "1 red pepper",
        "3 tbsp soy sauce",
      ],
      instructions: [
        "Sear chicken in a wide pan.",
        "Add vegetables, then fresh noodles and sauce.",
        "Toss over high heat until glossy and pack lunch portions.",
      ],
    },
    {
      id: "meal-sat",
      dayIndex: 5,
      title: "Open / flex night",
      subtitle: "Picnic, leftovers, or eat out",
      venue: "Flexible",
      status: "flex",
      protein: "none",
      prepNote: "No planned prep",
      leftoverNote: "Use salmon if plans stay home",
      notes: "Leave this open until Saturday afternoon.",
      ingredients: [],
      instructions: ["Check leftovers before deciding whether to cook."],
    },
    {
      id: "meal-sun",
      dayIndex: 6,
      title: "Salmon cakes and chopped salad",
      subtitle: "Herbs, lemon, crunchy greens",
      venue: "Home",
      status: "planned",
      protein: "salmon",
      prepNote: "Uses Thursday salmon",
      leftoverNote: "Closes the week cleanly",
      notes: "Use the reserved cooked salmon. No additional protein buy.",
      ingredients: [
        "2 reserved cooked salmon portions",
        "1 egg",
        "1/2 cup panko",
        "Flat-leaf parsley",
        "Farm-box greens",
      ],
      instructions: [
        "Flake salmon and mix with egg, panko, and parsley.",
        "Form six small cakes and chill for 10 minutes.",
        "Pan-sear and serve with chopped salad.",
      ],
    },
  ],
  prep: [
    {
      id: "prep-1",
      title: "Marinate harissa chicken",
      due: "Sun, Jul 5",
      mealId: "meal-mon",
      complete: true,
      duration: "10 min",
    },
    {
      id: "prep-2",
      title: "Pickle two cucumbers",
      due: "Mon, Jul 6",
      mealId: "meal-tue",
      complete: true,
      duration: "12 min",
    },
    {
      id: "prep-3",
      title: "Thaw 680 g salmon",
      due: "Thu, Jul 9",
      mealId: "meal-thu",
      complete: true,
      duration: "Overnight",
    },
    {
      id: "prep-4",
      title: "Cook double batch jasmine rice",
      due: "Thu, Jul 9",
      mealId: "meal-thu",
      complete: false,
      duration: "25 min",
    },
    {
      id: "prep-5",
      title: "Mix lo mein sauce",
      due: "Fri, Jul 10",
      mealId: "meal-fri",
      complete: false,
      duration: "5 min",
    },
    {
      id: "prep-6",
      title: "Flake reserved salmon",
      due: "Sun, Jul 12",
      mealId: "meal-sun",
      complete: false,
      duration: "8 min",
    },
  ],
  groceries: [
    { id: "g-1", section: "Produce", item: "English cucumbers", detail: "2 large", checked: true, farmBox: false },
    { id: "g-2", section: "Produce", item: "Flat-leaf parsley", detail: "2 bunches", checked: false, farmBox: true },
    { id: "g-3", section: "Produce", item: "Baby bok choy", detail: "2 heads", checked: false, farmBox: false },
    { id: "g-4", section: "Produce", item: "Snap peas", detail: "300 g", checked: false, farmBox: false },
    { id: "g-5", section: "Produce", item: "Tender greens", detail: "1 large bunch; spinach or chard", checked: false, farmBox: true },
    { id: "g-6", section: "Meat & seafood", item: "Boneless chicken thighs", detail: "1.35 kg total", checked: true, farmBox: false },
    { id: "g-7", section: "Meat & seafood", item: "Salmon fillet", detail: "680 g, skin-on is fine", checked: true, farmBox: false },
    { id: "g-8", section: "Dairy", item: "Plain Greek yogurt", detail: "750 g tub", checked: true, farmBox: false },
    { id: "g-9", section: "Dairy", item: "Feta", detail: "180-200 g block", checked: false, farmBox: false },
    { id: "g-10", section: "Pantry", item: "Fresh lo mein noodles", detail: "450 g refrigerated pack", checked: false, farmBox: false },
    { id: "g-11", section: "Pantry", item: "White miso", detail: "1 small tub", checked: true, farmBox: false },
    { id: "g-12", section: "Pantry", item: "Whole-wheat pitas", detail: "6-pack", checked: true, farmBox: false },
  ],
  leftovers: [
    {
      id: "leftover-mon",
      sourceMealId: "meal-mon",
      label: "Harissa chicken",
      portions: 2,
      state: "assigned",
      assignedDayIndex: 2,
      quality: "good",
    },
    {
      id: "leftover-tue",
      sourceMealId: "meal-tue",
      label: "Lemon chicken pita filling",
      portions: 1,
      state: "available",
    },
  ],
  farmBoxReconciled: false,
  weekArchived: false,
  draftReady: false,
  feedback: {
    "meal-mon": "repeat",
    "meal-tue": "modify",
  },
  weekLesson: "Portable dinners worked best when sauces and crunchy vegetables were packed separately.",
};

const INITIAL_EVENTS: EventEntry[] = [
  {
    id: "event-2",
    actor: "You",
    command: "completePrepTask",
    summary: "Marked salmon thawed",
    target: "prep-3",
    changes: ["Complete: false to true"],
    time: "Today, 8:12 AM",
  },
  {
    id: "event-1",
    actor: "Codex",
    command: "reconcileGroceries",
    summary: "Removed owned rice vinegar and sesame oil",
    target: "active-week-groceries",
    changes: ["Two owned pantry items removed"],
    time: "Monday, 9:06 AM",
  },
];

const INITIAL_CHAT: ChatMessage[] = [
  {
    id: "chat-1",
    role: "assistant",
    text: "I have the active week and its linked prep, groceries, and leftovers in context.",
  },
];

const STATUS_META: Record<
  MealStatus,
  { label: string; icon: LucideIcon; tone: string }
> = {
  planned: { label: "Planned", icon: CalendarDays, tone: "slate" },
  moved: { label: "Moved", icon: ArrowRight, tone: "amber" },
  cooking: { label: "Cooking", icon: CookingPot, tone: "coral" },
  cooked: { label: "Cooked", icon: CheckCircle2, tone: "green" },
  leftover: { label: "Leftovers", icon: PackageCheck, tone: "blue" },
  flex: { label: "Flex", icon: Minus, tone: "slate" },
};

const NAV_ITEMS: Array<{ id: View; label: string; icon: LucideIcon }> = [
  { id: "week", label: "Week", icon: CalendarDays },
  { id: "tonight", label: "Tonight", icon: CookingPot },
  { id: "prep", label: "Prep", icon: ListChecks },
  { id: "groceries", label: "Groceries", icon: ShoppingBasket },
  { id: "closeout", label: "Closeout", icon: Archive },
];

const DRAFT_MEALS = [
  "Ginger chicken lettuce cups",
  "Chicken pita picnic packs",
  "Roasted salmon with dill potatoes",
  "Salmon and cucumber rice bowls",
  "Chicken fried rice",
  "Open / flex night",
  "Leftovers and chopped salad",
];

function cloneInitialData() {
  return JSON.parse(JSON.stringify(INITIAL_DATA)) as PlannerData;
}

function eventTime() {
  return new Intl.DateTimeFormat("en-CA", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function useDialogFocus(onClose: () => void) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
    focusable()[0]?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previous?.focus();
    };
  }, []);

  return dialogRef;
}

function StatusBadge({ status }: { status: MealStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span className={`status-badge tone-${meta.tone}`}>
      <Icon size={13} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function ProgressRing({ value, label }: { value: number; label: string }) {
  return (
    <div className="progress-ring" style={{ "--progress": `${value * 3.6}deg` } as React.CSSProperties}>
      <span>{value}%</span>
      <small>{label}</small>
    </div>
  );
}

export default function PlannerApp() {
  const [view, setView] = useState<View>("week");
  const [data, setData] = useState<PlannerData>(() => cloneInitialData());
  const [events, setEvents] = useState<EventEntry[]>(INITIAL_EVENTS);
  const [undo, setUndo] = useState<UndoState>(null);
  const [selectedWeekId, setSelectedWeekId] = useState(ACTIVE_WEEK_ID);
  const [weekPickerOpen, setWeekPickerOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedMealId, setSelectedMealId] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(INITIAL_CHAT);
  const [groceryFilter, setGroceryFilter] = useState<"remaining" | "all">("remaining");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const restore = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved) as {
            data?: PlannerData;
            events?: EventEntry[];
          };
          if (parsed.data?.meals?.length === 7) {
            const seeded = cloneInitialData();
            setData({
              ...parsed.data,
              leftovers: parsed.data.leftovers ?? seeded.leftovers,
              draftReady: parsed.data.draftReady ?? false,
            });
          }
          if (parsed.events?.length) setEvents(parsed.events);
        }
      } catch {
        // Keep the seeded local week if stored state is missing or stale.
      }
      setHydrated(true);
    }, 0);

    return () => window.clearTimeout(restore);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ data, events }));
  }, [data, events, hydrated]);

  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(null), 9000);
    return () => window.clearTimeout(timer);
  }, [undo]);

  const activeWeek = WEEK_OPTIONS.find((week) => week.id === selectedWeekId) ?? WEEK_OPTIONS[1];
  const selectedWeekState: WeekState =
    selectedWeekId === ACTIVE_WEEK_ID && data.weekArchived
      ? "archived"
      : activeWeek.state;
  const selectedMeal = useMemo(
    () => data.meals.find((meal) => meal.id === selectedMealId) ?? null,
    [data.meals, selectedMealId],
  );
  const selectedAssignedLeftover = selectedMeal?.leftoverId
    ? data.leftovers.find((leftover) => leftover.id === selectedMeal.leftoverId) ?? null
    : null;
  const tonightMeal = data.meals.find((meal) => meal.dayIndex === TODAY_INDEX) ?? data.meals[3];
  const prepDone = data.prep.filter((task) => task.complete).length;
  const groceriesDone = data.groceries.filter((item) => item.checked).length;
  const cookedMeals = data.meals.filter((meal) => meal.status === "cooked" || meal.status === "leftover").length;

  const contextLabel =
    view === "tonight"
      ? `Tonight | ${tonightMeal.title}`
      : view === "groceries"
        ? "Groceries | farm-box reconciliation"
        : view === "prep"
          ? "Prep | active week"
          : view === "closeout"
            ? "Closeout | week of Jul 6"
            : "Week overview | Jul 6 - 12";

  function dispatchCommand(actor: Actor, command: DomainCommand) {
    const result = executeDomainCommand(data, command);
    if (!result.ok) return result;
    const before = data;
    setData(result.state);
    setUndo({ snapshot: before, summary: result.summary, actor });
    setEvents((current) => [
      {
        id: makeId("event"),
        actor,
        command: command.type,
        summary: result.summary,
        target: result.target,
        changes: result.changes,
        before,
        time: `Today, ${eventTime()}`,
      },
      ...current,
    ]);
    return result;
  }

  function undoLastChange() {
    if (!undo) return;
    const before = data;
    setData(undo.snapshot);
    setEvents((current) => [
      {
        id: makeId("event"),
        actor: "You",
        command: "undo",
        summary: `Undid: ${undo.summary}`,
        target: "active-week-state",
        changes: [`Restored the state before: ${undo.summary}`],
        before,
        time: `Today, ${eventTime()}`,
      },
      ...current,
    ]);
    setUndo(null);
  }

  function revertHistoryEvent(eventId: string) {
    const entry = events.find((event) => event.id === eventId);
    if (!entry?.before) return;
    const before = data;
    setData(entry.before);
    setUndo({ snapshot: before, summary: `Reverted ${entry.summary}`, actor: "You" });
    setEvents((current) => [
      {
        id: makeId("event"),
        actor: "You",
        command: "revertEvent",
        summary: `Reverted: ${entry.summary}`,
        target: entry.target || "active-week-state",
        changes: [`Restored the state stored with event ${entry.id}`],
        before,
        time: `Today, ${eventTime()}`,
      },
      ...current,
    ]);
  }

  function resetDemo() {
    window.localStorage.removeItem(STORAGE_KEY);
    setData(cloneInitialData());
    setEvents(INITIAL_EVENTS);
    setUndo(null);
    setSelectedWeekId(ACTIVE_WEEK_ID);
    setView("week");
  }

  function moveMeal(mealId: string, targetDayIndex: number, actor: Actor = "You") {
    dispatchCommand(actor, { type: "moveMeal", mealId, targetDayIndex });
  }

  function runCodexMove() {
    const result = dispatchCommand("Codex", { type: "moveSalmonToSaturday" });
    if (!result.ok) {
      setChatMessages((current) => [
        ...current,
        {
          id: makeId("chat"),
          role: "assistant",
          text: result.error,
        },
      ]);
      return;
    }

    setChatMessages((current) => [
      ...current,
      {
        id: makeId("chat"),
        role: "assistant",
        text: "Applied the plan change across the active week.",
        changes: result.changes,
      },
    ]);
  }

  function handleChatSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = chatInput.trim();
    if (!message) return;
    setChatMessages((current) => [
      ...current,
      { id: makeId("chat"), role: "user", text: message },
    ]);
    setChatInput("");

    if (isSupportedSalmonMoveIntent(message)) {
      runCodexMove();
    } else {
      setChatMessages((current) => [
        ...current,
        {
          id: makeId("chat"),
          role: "assistant",
          text: "No change was applied. This preview accepts the highlighted move command only.",
        },
      ]);
    }
  }

  function updateMealStatus(mealId: string, status: MealStatus) {
    dispatchCommand("You", { type: "updateMealStatus", mealId, status });
  }

  function updateMealSnapshot(
    mealId: string,
    changes: Pick<Meal, "title" | "venue" | "notes">,
  ) {
    dispatchCommand("You", { type: "updateMealSnapshot", mealId, changes });
  }

  function togglePrep(taskId: string) {
    dispatchCommand("You", { type: "completePrepTask", taskId });
  }

  function reschedulePrep(taskId: string) {
    dispatchCommand("You", { type: "reschedulePrepTask", taskId, due: "Fri, Jul 10" });
  }

  function toggleGrocery(itemId: string) {
    dispatchCommand("You", { type: "updateGroceryItem", itemId });
  }

  function reconcileFarmBox() {
    dispatchCommand("You", { type: "reconcileGroceries" });
  }

  function updateFeedback(mealId: string, value: "repeat" | "modify" | "drop") {
    dispatchCommand("You", { type: "captureFeedback", mealId, value });
  }

  function archiveWeek() {
    dispatchCommand("You", { type: "archiveWeek" });
  }

  function updateWeekLesson(weekLesson: string) {
    dispatchCommand("You", { type: "captureWeekLesson", weekLesson });
  }

  function updateLeftoverQuality(
    leftoverId: string,
    quality: "good" | "mixed" | "poor",
  ) {
    dispatchCommand("You", { type: "captureLeftoverQuality", leftoverId, quality });
  }

  function assignLeftover(leftoverId: string, dayIndex: number) {
    dispatchCommand("You", { type: "assignLeftover", leftoverId, dayIndex });
  }

  function consumeLeftover(leftoverId: string) {
    dispatchCommand("You", { type: "consumeLeftover", leftoverId });
  }

  function markDraftReady() {
    dispatchCommand("You", { type: "createWeekPlan" });
  }

  function moveWeek(direction: -1 | 1) {
    const index = WEEK_OPTIONS.findIndex((week) => week.id === selectedWeekId);
    const next = Math.max(0, Math.min(WEEK_OPTIONS.length - 1, index + direction));
    setSelectedWeekId(WEEK_OPTIONS[next].id);
    setChatOpen(false);
    setWeekPickerOpen(false);
  }

  const viewTitle =
    view === "week"
      ? "Week overview"
      : view === "tonight"
        ? "Tonight"
        : view === "prep"
          ? "Prep and batch cook"
          : view === "groceries"
            ? "Groceries and farm box"
            : "Week closeout";

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            <Utensils size={19} />
          </div>
          <div>
            <p className="brand-name">Weekly Recipe Planner</p>
            <p className="sync-note">
              <span className="sync-dot" /> Local state saved
            </p>
          </div>
        </div>

        <div className="week-control" aria-label="Selected week">
          <button
            className="icon-button"
            type="button"
            aria-label="Previous week"
            title="Previous week"
            onClick={() => moveWeek(-1)}
            disabled={selectedWeekId === WEEK_OPTIONS[0].id}
          >
            <ArrowLeft size={18} />
          </button>
          <div className="week-picker-wrap">
            <button
              className="week-picker-button"
              type="button"
              aria-expanded={weekPickerOpen}
              onClick={() => setWeekPickerOpen((open) => !open)}
            >
              <span>
                <strong>{activeWeek.range}</strong>
                <small>{selectedWeekState === "active" ? "Active week" : selectedWeekState === "draft" ? "Draft plan" : "Archived week"}</small>
              </span>
              <ChevronDown size={17} aria-hidden="true" />
            </button>
            {weekPickerOpen && (
              <div className="week-menu" role="menu">
                {WEEK_OPTIONS.map((week) => (
                  <button
                    key={week.id}
                    type="button"
                    role="menuitem"
                    className={week.id === selectedWeekId ? "week-menu-item active" : "week-menu-item"}
                    onClick={() => {
                      setSelectedWeekId(week.id);
                      setChatOpen(false);
                      setWeekPickerOpen(false);
                    }}
                  >
                    <span>
                      <strong>{week.range}</strong>
                      <small>{week.id === ACTIVE_WEEK_ID && data.weekArchived ? "archived" : week.state}</small>
                    </span>
                    {week.id === selectedWeekId && <Check size={16} aria-hidden="true" />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Next week"
            title="Next week"
            onClick={() => moveWeek(1)}
            disabled={selectedWeekId === WEEK_OPTIONS[WEEK_OPTIONS.length - 1].id}
          >
            <ArrowRight size={18} />
          </button>
        </div>

        <div className="header-actions">
          <button
            className="icon-button"
            type="button"
            aria-label="Open change history"
            title="Change history"
            onClick={() => setHistoryOpen(true)}
          >
            <History size={18} />
          </button>
          <button
            className={chatOpen ? "primary-button active" : "primary-button"}
            type="button"
            onClick={() => setChatOpen((open) => !open)}
            disabled={selectedWeekId !== ACTIVE_WEEK_ID || data.weekArchived}
          >
            <MessageCircle size={17} aria-hidden="true" />
            <span>Ask Codex</span>
          </button>
        </div>
      </header>

      <nav className="view-nav" aria-label="Planner views">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={view === item.id ? "nav-item active" : "nav-item"}
              aria-current={view === item.id ? "page" : undefined}
              disabled={data.weekArchived}
              onClick={() => {
                setView(item.id);
                if (selectedWeekId !== ACTIVE_WEEK_ID) setSelectedWeekId(ACTIVE_WEEK_ID);
              }}
            >
              <Icon size={18} aria-hidden="true" />
              <span>{item.label}</span>
              {item.id === "prep" && <small>{data.prep.length - prepDone}</small>}
              {item.id === "groceries" && <small>{data.groceries.length - groceriesDone}</small>}
            </button>
          );
        })}
      </nav>

      <main className="app-main">
        <div className="content-heading">
          <div>
            <p className="eyebrow">{selectedWeekState} | week of {activeWeek.label}</p>
            <h1>{selectedWeekId === ACTIVE_WEEK_ID ? data.weekArchived ? "Archived week" : viewTitle : activeWeek.state === "archived" ? "Archived week" : "Draft week"}</h1>
          </div>
          {selectedWeekId === ACTIVE_WEEK_ID && !data.weekArchived && (
            <div className="week-health" aria-label={`${cookedMeals} of 7 dinners settled`}>
              <span>{cookedMeals} of 7 dinners settled</span>
              <div className="mini-progress"><i style={{ width: `${(cookedMeals / 7) * 100}%` }} /></div>
            </div>
          )}
        </div>

        {selectedWeekId !== ACTIVE_WEEK_ID ? (
          <LifecycleWeek
            state={activeWeek.state}
            onOpenActive={() => setSelectedWeekId(ACTIVE_WEEK_ID)}
            draftReady={data.draftReady}
            onMarkDraftReady={markDraftReady}
          />
        ) : data.weekArchived ? (
          <ArchivedCurrentWeek data={data} onOpenHistory={() => setHistoryOpen(true)} />
        ) : (
          <div className={chatOpen ? "workspace chat-visible" : "workspace"}>
            <section className="primary-workspace">
              {view === "week" && (
                <WeekOverview
                  data={data}
                  prepDone={prepDone}
                  groceriesDone={groceriesDone}
                  onOpenMeal={setSelectedMealId}
                  onOpenView={setView}
                />
              )}
              {view === "tonight" && (
                <TonightView
                  meal={tonightMeal}
                  prep={data.prep.filter((task) => task.mealId === tonightMeal.id)}
                  leftovers={data.leftovers.filter((leftover) => leftover.sourceMealId === tonightMeal.id)}
                  onOpenMeal={setSelectedMealId}
                  onStatus={updateMealStatus}
                  onTogglePrep={togglePrep}
                  onAssignLeftover={assignLeftover}
                />
              )}
              {view === "prep" && (
                <PrepView
                  data={data}
                  onToggle={togglePrep}
                  onReschedule={reschedulePrep}
                  onOpenMeal={setSelectedMealId}
                />
              )}
              {view === "groceries" && (
                <GroceryView
                  data={data}
                  filter={groceryFilter}
                  onFilter={setGroceryFilter}
                  onToggle={toggleGrocery}
                  onReconcile={reconcileFarmBox}
                />
              )}
              {view === "closeout" && (
                <CloseoutView
                  data={data}
                  onFeedback={updateFeedback}
                  onLesson={updateWeekLesson}
                  onLeftoverQuality={updateLeftoverQuality}
                  onArchive={archiveWeek}
                />
              )}
            </section>

            <aside className={chatOpen ? "ops-rail chat-rail open" : "ops-rail"} aria-label={chatOpen ? "Codex planner" : "Week operations"}>
              {chatOpen ? (
                <ChatPanel
                  contextLabel={contextLabel}
                  input={chatInput}
                  messages={chatMessages}
                  onInput={setChatInput}
                  onSubmit={handleChatSubmit}
                  onClose={() => setChatOpen(false)}
                />
              ) : (
                <OperationsRail
                  data={data}
                  prepDone={prepDone}
                  groceriesDone={groceriesDone}
                  onOpenView={setView}
                  onOpenChat={() => setChatOpen(true)}
                />
              )}
            </aside>
          </div>
        )}
      </main>

      <nav className="mobile-nav" aria-label="Planner views">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={view === item.id ? "active" : ""}
              disabled={data.weekArchived}
              onClick={() => {
                setView(item.id);
                setSelectedWeekId(ACTIVE_WEEK_ID);
              }}
            >
              <Icon size={19} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {selectedMeal && (
        <MealDetail
          meal={selectedMeal}
          assignedLeftover={selectedAssignedLeftover}
          onClose={() => setSelectedMealId(null)}
          onMove={(day) => moveMeal(selectedMeal.id, day)}
          onStatus={(status) => updateMealStatus(selectedMeal.id, status)}
          onSave={(changes) => updateMealSnapshot(selectedMeal.id, changes)}
          onConsumeLeftover={consumeLeftover}
        />
      )}

      {historyOpen && (
        <HistoryPanel
          events={events}
          onClose={() => setHistoryOpen(false)}
          onReset={resetDemo}
          onRevert={revertHistoryEvent}
        />
      )}

      {undo && (
        <div className="undo-toast" role="status">
          <div className="actor-mark" data-actor={undo.actor.toLowerCase()}>
            {undo.actor === "Codex" ? <Bot size={16} /> : <PencilLine size={16} />}
          </div>
          <div>
            <strong>{undo.summary}</strong>
            <span>Changed by {undo.actor}</span>
          </div>
          <button type="button" onClick={undoLastChange}>
            <RotateCcw size={16} aria-hidden="true" /> Undo
          </button>
          <button className="toast-close" type="button" aria-label="Dismiss undo" onClick={() => setUndo(null)}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function WeekOverview({
  data,
  prepDone,
  groceriesDone,
  onOpenMeal,
  onOpenView,
}: {
  data: PlannerData;
  prepDone: number;
  groceriesDone: number;
  onOpenMeal: (id: string) => void;
  onOpenView: (view: View) => void;
}) {
  const ordered = [...data.meals].sort((a, b) => a.dayIndex - b.dayIndex);
  return (
    <div className="week-view">
      <div className="week-grid" aria-label="Meals for July 6 to 12">
        {ordered.map((meal) => {
          const day = DAYS[meal.dayIndex];
          const isToday = meal.dayIndex === TODAY_INDEX;
          return (
            <article key={meal.id} className={isToday ? "day-column today" : "day-column"}>
              <div className="day-heading">
                <div>
                  <span>{day.short}</span>
                  {isToday && <small>Today</small>}
                </div>
                <strong>{day.date}</strong>
              </div>
              <button className="meal-card" type="button" onClick={() => onOpenMeal(meal.id)}>
                <StatusBadge status={meal.status} />
                <span className="meal-title">{meal.title}</span>
                <span className="meal-subtitle">{meal.subtitle}</span>
                <span className="meal-meta"><MapPin size={13} /> {meal.venue}</span>
                <span className="meal-meta"><Clock3 size={13} /> {meal.prepNote}</span>
                <span className="meal-leftover"><PackageCheck size={13} /> {meal.leftoverNote}</span>
                <span className="open-detail">Open meal <ChevronRight size={14} /></span>
              </button>
            </article>
          );
        })}
      </div>
      <div className="mobile-pressure-strip">
        <button type="button" onClick={() => onOpenView("prep")}>
          <ListChecks size={17} /> Prep <strong>{prepDone}/{data.prep.length}</strong>
        </button>
        <button type="button" onClick={() => onOpenView("groceries")}>
          <ShoppingBasket size={17} /> Groceries <strong>{groceriesDone}/{data.groceries.length}</strong>
        </button>
      </div>
    </div>
  );
}

function OperationsRail({
  data,
  prepDone,
  groceriesDone,
  onOpenView,
  onOpenChat,
}: {
  data: PlannerData;
  prepDone: number;
  groceriesDone: number;
  onOpenView: (view: View) => void;
  onOpenChat: () => void;
}) {
  const nextPrep = data.prep.filter((task) => !task.complete).slice(0, 2);
  const remaining = data.groceries.length - groceriesDone;
  return (
    <div className="rail-content">
      <div className="rail-heading">
        <div>
          <p className="eyebrow">At a glance</p>
          <h2>Week pressure</h2>
        </div>
        <ProgressRing value={Math.round(((prepDone + groceriesDone) / (data.prep.length + data.groceries.length)) * 100)} label="ready" />
      </div>

      <section className="rail-section">
        <button className="section-link" type="button" onClick={() => onOpenView("prep")}>
          <span><ListChecks size={17} /> Prep</span>
          <span>{data.prep.length - prepDone} due <ChevronRight size={15} /></span>
        </button>
        <div className="rail-list">
          {nextPrep.map((task) => (
            <div key={task.id}>
              <Circle size={14} />
              <span><strong>{task.title}</strong><small>{task.due} | {task.duration}</small></span>
            </div>
          ))}
        </div>
      </section>

      <section className="rail-section">
        <button className="section-link" type="button" onClick={() => onOpenView("groceries")}>
          <span><ShoppingBasket size={17} /> Groceries</span>
          <span>{remaining} left <ChevronRight size={15} /></span>
        </button>
        <div className="farm-note">
          <Sprout size={18} />
          <span>
            <strong>{data.farmBoxReconciled ? "Farm box reconciled" : "Farm box needs review"}</strong>
            <small>{data.farmBoxReconciled ? "2 produce buys covered" : "Parsley and greens may be covered"}</small>
          </span>
        </div>
      </section>

      <section className="rail-section leftovers-section">
        <div className="section-label"><PackageCheck size={17} /> Leftovers</div>
        {data.leftovers.slice(0, 3).map((leftover) => (
          <div className="leftover-row" key={leftover.id}>
            <span>{leftover.label}</span>
            <strong>{leftover.portions} | {leftover.state}</strong>
          </div>
        ))}
      </section>

      <button className="codex-callout" type="button" onClick={onOpenChat}>
        <span className="bot-icon"><Bot size={18} /></span>
        <span><strong>Reshape this week</strong><small>Codex has the week in context</small></span>
        <ChevronRight size={17} />
      </button>
    </div>
  );
}

function ChatPanel({
  contextLabel,
  input,
  messages,
  onInput,
  onSubmit,
  onClose,
}: {
  contextLabel: string;
  input: string;
  messages: ChatMessage[];
  onInput: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-title">
          <span className="bot-icon"><Bot size={18} /></span>
          <span><strong>Codex</strong><small>Local command preview</small></span>
        </div>
        <button className="icon-button" type="button" aria-label="Close Codex" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="chat-context"><Sparkles size={14} /> {contextLabel}</div>
      <div className="chat-messages" aria-live="polite">
        {messages.map((message) => (
          <div key={message.id} className={`chat-message ${message.role}`}>
            <p>{message.text}</p>
            {message.changes && (
              <ul>
                {message.changes.map((change) => <li key={change}><Check size={13} /> {change}</li>)}
              </ul>
            )}
          </div>
        ))}
      </div>
      <button
        className="suggestion-button"
        type="button"
        onClick={() => onInput("Move Thursday's salmon to Saturday and make Thursday leftovers")}
      >
        Move Thursday&apos;s salmon to Saturday
      </button>
      <form className="chat-form" onSubmit={onSubmit}>
        <label htmlFor="codex-command" className="sr-only">Ask Codex to change the week</label>
        <textarea
          id="codex-command"
          value={input}
          onChange={(event) => onInput(event.target.value)}
          placeholder="Ask Codex to change this week..."
          rows={2}
        />
        <button type="submit" aria-label="Send to Codex" disabled={!input.trim()}>
          <Send size={17} />
        </button>
      </form>
    </div>
  );
}

function TonightView({
  meal,
  prep,
  leftovers,
  onOpenMeal,
  onStatus,
  onTogglePrep,
  onAssignLeftover,
}: {
  meal: Meal;
  prep: PrepTask[];
  leftovers: Leftover[];
  onOpenMeal: (id: string) => void;
  onStatus: (id: string, status: MealStatus) => void;
  onTogglePrep: (id: string) => void;
  onAssignLeftover: (leftoverId: string, dayIndex: number) => void;
}) {
  return (
    <div className="tonight-layout">
      <section className="tonight-main">
        <div className="tonight-hero">
          <div>
            <p className="eyebrow">Thursday, July 9 | {meal.venue}</p>
            <h2>{meal.title}</h2>
            <p>{meal.subtitle}</p>
          </div>
          <StatusBadge status={meal.status} />
        </div>
        <div className="tonight-actions">
          <button className="primary-button" type="button" onClick={() => onStatus(meal.id, "cooked")} disabled={meal.status === "cooked"}>
            <CheckCircle2 size={17} /> {meal.status === "cooked" ? "Dinner marked cooked" : "Mark dinner cooked"}
          </button>
          <button className="secondary-button" type="button" onClick={() => onOpenMeal(meal.id)}>
            <PencilLine size={17} /> Edit meal
          </button>
        </div>
        <div className="execution-grid">
          <section>
            <div className="section-title"><CookingPot size={18} /><h3>Cook in order</h3></div>
            <ol className="instruction-list">
              {meal.instructions.map((step, index) => (
                <li key={step}><span>{index + 1}</span><p>{step}</p></li>
              ))}
            </ol>
          </section>
          <section>
            <div className="section-title"><ClipboardCheck size={18} /><h3>Components</h3></div>
            <ul className="ingredient-list">
              {meal.ingredients.map((ingredient) => <li key={ingredient}><Check size={14} /> {ingredient}</li>)}
            </ul>
          </section>
        </div>
      </section>
      <aside className="tonight-side">
        <section className="plain-panel">
          <div className="section-title"><Clock3 size={18} /><h3>Due before dinner</h3></div>
          {prep.length ? prep.map((task) => (
            <label className="task-row compact" key={task.id}>
              <input type="checkbox" checked={task.complete} onChange={() => onTogglePrep(task.id)} />
              <span><strong>{task.title}</strong><small>{task.duration}</small></span>
            </label>
          )) : <p className="empty-copy">No prep tasks attached to this meal.</p>}
        </section>
        <section className="plain-panel leftover-plan">
          <div className="section-title"><PackageCheck size={18} /><h3>After dinner</h3></div>
          {leftovers.length ? leftovers.map((leftover) => (
            <div className="tonight-leftover" key={leftover.id}>
              <strong>{leftover.portions} portions {leftover.state}</strong>
              <p>Cool promptly, label, and keep lunch portions separate.</p>
              {leftover.state === "available" && (
                <button className="secondary-button full" type="button" onClick={() => onAssignLeftover(leftover.id, 6)}>
                  <PackageCheck size={16} /> Assign to Sunday
                </button>
              )}
            </div>
          )) : (
            <>
              <strong>{meal.leftoverNote}</strong>
              <p>Mark dinner cooked to record the planned portions as available.</p>
            </>
          )}
        </section>
        <section className="plain-panel">
          <div className="section-title"><MapPin size={18} /><h3>Serving note</h3></div>
          <p>{meal.notes}</p>
        </section>
      </aside>
    </div>
  );
}

function PrepView({
  data,
  onToggle,
  onReschedule,
  onOpenMeal,
}: {
  data: PlannerData;
  onToggle: (id: string) => void;
  onReschedule: (id: string) => void;
  onOpenMeal: (id: string) => void;
}) {
  const groups = [
    { title: "Done", tasks: data.prep.filter((task) => task.complete) },
    { title: "Today", tasks: data.prep.filter((task) => !task.complete && task.due.startsWith("Thu")) },
    { title: "Later this week", tasks: data.prep.filter((task) => !task.complete && !task.due.startsWith("Thu")) },
  ];
  return (
    <div className="list-surface">
      <div className="surface-summary">
        <div><p className="eyebrow">Batch plan</p><h2>{data.prep.filter((task) => !task.complete).length} tasks remaining</h2></div>
        <span className="summary-chip"><Clock3 size={15} /> 38 active minutes</span>
      </div>
      {groups.map((group) => (
        <section className="task-group" key={group.title}>
          <h3>{group.title}<span>{group.tasks.length}</span></h3>
          {group.tasks.length ? group.tasks.map((task) => {
            const meal = data.meals.find((item) => item.id === task.mealId);
            return (
              <div className={task.complete ? "task-row complete" : "task-row"} key={task.id}>
                <label>
                  <input type="checkbox" checked={task.complete} onChange={() => onToggle(task.id)} />
                  <span><strong>{task.title}</strong><small>{task.due} | {task.duration}</small></span>
                </label>
                <div className="task-actions">
                  {meal && <button type="button" onClick={() => onOpenMeal(meal.id)}>{meal.title}</button>}
                  {!task.complete && <button type="button" onClick={() => onReschedule(task.id)}><CalendarDays size={15} /> Move to Fri</button>}
                </div>
              </div>
            );
          }) : <p className="empty-copy">Nothing here.</p>}
        </section>
      ))}
    </div>
  );
}

function GroceryView({
  data,
  filter,
  onFilter,
  onToggle,
  onReconcile,
}: {
  data: PlannerData;
  filter: "remaining" | "all";
  onFilter: (filter: "remaining" | "all") => void;
  onToggle: (id: string) => void;
  onReconcile: () => void;
}) {
  const sections: GroceryItem["section"][] = ["Produce", "Meat & seafood", "Dairy", "Pantry"];
  const visible = data.groceries.filter((item) => filter === "all" || !item.checked);
  return (
    <div className="grocery-layout">
      <section className="grocery-list">
        <div className="surface-summary grocery-summary">
          <div><p className="eyebrow">Weekly food only</p><h2>{data.groceries.filter((item) => !item.checked).length} items left to buy</h2></div>
          <div className="segmented-control" aria-label="Grocery filter">
            <button type="button" aria-pressed={filter === "remaining"} className={filter === "remaining" ? "active" : ""} onClick={() => onFilter("remaining")}>To buy</button>
            <button type="button" aria-pressed={filter === "all"} className={filter === "all" ? "active" : ""} onClick={() => onFilter("all")}>All</button>
          </div>
        </div>
        {sections.map((section) => {
          const items = visible.filter((item) => item.section === section);
          if (!items.length) return null;
          return (
            <section className="grocery-section" key={section}>
              <h3>{section}<span>{items.length}</span></h3>
              {items.map((item) => (
                <label className={item.checked ? "grocery-row checked" : "grocery-row"} key={item.id}>
                  <input type="checkbox" checked={item.checked} onChange={() => onToggle(item.id)} />
                  <span><strong>{item.item}</strong><small>{item.detail}</small></span>
                  {item.farmBox && <span className="farm-tag"><Sprout size={13} /> Farm box</span>}
                </label>
              ))}
            </section>
          );
        })}
        {!visible.length && <div className="finished-state"><CheckCircle2 size={28} /><h3>Shopping is covered</h3><p>Switch to All to review checked items.</p></div>}
      </section>
      <aside className="farm-box-panel">
        <div className="farm-box-heading"><span><Sprout size={20} /></span><div><p className="eyebrow">Monday delivery</p><h2>Farm box</h2></div></div>
        <p>Match flexible produce before buying duplicates. This does not create a permanent pantry inventory.</p>
        <div className="box-contents">
          <div><CheckCircle2 size={16} /><span><strong>Baby spinach</strong><small>Covers tender greens</small></span></div>
          <div><CheckCircle2 size={16} /><span><strong>Flat-leaf parsley</strong><small>Covers 2 bunches</small></span></div>
          <div><Plus size={16} /><span><strong>Golden beets</strong><small>Add to Friday side</small></span></div>
        </div>
        <div className="reconcile-result">
          <span>Grocery delta</span>
          <strong>{data.farmBoxReconciled ? "2 items covered" : "-2 produce buys"}</strong>
        </div>
        <button className="primary-button full" type="button" onClick={onReconcile} disabled={data.farmBoxReconciled}>
          <Sprout size={17} /> {data.farmBoxReconciled ? "Farm box reconciled" : "Apply reconciliation"}
        </button>
      </aside>
    </div>
  );
}

function CloseoutView({
  data,
  onFeedback,
  onLesson,
  onLeftoverQuality,
  onArchive,
}: {
  data: PlannerData;
  onFeedback: (id: string, value: "repeat" | "modify" | "drop") => void;
  onLesson: (value: string) => void;
  onLeftoverQuality: (id: string, value: "good" | "mixed" | "poor") => void;
  onArchive: () => void;
}) {
  const reviewMeals = data.meals.filter((meal) => meal.status !== "flex");
  const reviewedMeals = reviewMeals.filter((meal) => data.feedback[meal.id]).length;
  const reviewedLeftovers = data.leftovers.filter((leftover) => leftover.quality).length;
  return (
    <div className="closeout-layout">
      <section className="feedback-list">
        <div className="surface-summary"><div><p className="eyebrow">Feedback</p><h2>What should carry forward?</h2></div><span className="summary-chip">Sunday closeout</span></div>
        {reviewMeals.map((meal) => (
          <div className="feedback-row" key={meal.id}>
            <div><strong>{meal.title}</strong><small>{meal.venue} | {STATUS_META[meal.status].label}</small></div>
            <div className="segmented-control feedback-control" role="radiogroup" aria-label={`Feedback for ${meal.title}`}>
              {(["repeat", "modify", "drop"] as const).map((value) => (
                <button key={value} type="button" role="radio" aria-checked={data.feedback[meal.id] === value} className={data.feedback[meal.id] === value ? "active" : ""} onClick={() => onFeedback(meal.id, value)}>{value}</button>
              ))}
            </div>
          </div>
        ))}
      </section>
      <aside className="closeout-notes">
        <label htmlFor="week-lesson"><span>Planning lesson</span><textarea key={data.weekLesson} id="week-lesson" defaultValue={data.weekLesson} onBlur={(event) => onLesson(event.target.value)} rows={5} /></label>
        <section className="leftover-feedback">
          <span className="field-label">Leftover quality</span>
          {data.leftovers.map((leftover) => (
            <div key={leftover.id}>
              <span><strong>{leftover.label}</strong><small>{leftover.portions} portions | {leftover.state}</small></span>
              <div className="segmented-control" role="radiogroup" aria-label={`Leftover quality for ${leftover.label}`}>
                {(["good", "mixed", "poor"] as const).map((quality) => (
                  <button key={quality} type="button" role="radio" aria-checked={leftover.quality === quality} className={leftover.quality === quality ? "active" : ""} onClick={() => onLeftoverQuality(leftover.id, quality)}>{quality}</button>
                ))}
              </div>
            </div>
          ))}
        </section>
        <div className="promotion-candidate"><Sparkles size={18} /><span><strong>Promotion candidate</strong><small>Miso salmon bowl snapshot with Saturday leftover path</small></span></div>
        <div className="closeout-check">{reviewedMeals === reviewMeals.length ? <Check size={16} /> : <Circle size={16} />} {reviewedMeals}/{reviewMeals.length} meal outcomes reviewed</div>
        <div className="closeout-check">{reviewedLeftovers === data.leftovers.length ? <Check size={16} /> : <Circle size={16} />} {reviewedLeftovers}/{data.leftovers.length} leftover paths reviewed</div>
        <div className="closeout-check"><Check size={16} /> Lesson ready for Codex</div>
        <button className="primary-button full" type="button" onClick={onArchive}><Archive size={17} /> Archive this week</button>
      </aside>
    </div>
  );
}

function MealDetail({
  meal,
  assignedLeftover,
  onClose,
  onMove,
  onStatus,
  onSave,
  onConsumeLeftover,
}: {
  meal: Meal;
  assignedLeftover: Leftover | null;
  onClose: () => void;
  onMove: (day: number) => void;
  onStatus: (status: MealStatus) => void;
  onSave: (changes: Pick<Meal, "title" | "venue" | "notes">) => void;
  onConsumeLeftover: (leftoverId: string) => void;
}) {
  const [title, setTitle] = useState(meal.title);
  const [venue, setVenue] = useState(meal.venue);
  const [notes, setNotes] = useState(meal.notes);
  const [targetDay, setTargetDay] = useState(String(meal.dayIndex));
  const dialogRef = useDialogFocus(onClose);
  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section ref={dialogRef} className="drawer meal-drawer" role="dialog" aria-modal="true" aria-labelledby="meal-detail-title">
        <div className="drawer-header">
          <div><p className="eyebrow">{DAYS[meal.dayIndex].name} | week-local snapshot</p><h2 id="meal-detail-title">Meal detail</h2></div>
          <button className="icon-button" type="button" aria-label="Close meal detail" onClick={onClose}><X size={19} /></button>
        </div>
        <div className="drawer-body">
          <div className="field-grid">
            <label><span>Meal name</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
            <label><span>Venue</span><input value={venue} onChange={(event) => setVenue(event.target.value)} /></label>
          </div>
          <label className="full-field"><span>Notes and adaptation</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} /></label>
          <div className="field-grid">
            <label><span>Status</span><select value={meal.status} onChange={(event) => onStatus(event.target.value as MealStatus)}>{Object.entries(STATUS_META).map(([value, meta]) => <option value={value} key={value}>{meta.label}</option>)}</select></label>
            <label><span>Move to</span><select value={targetDay} onChange={(event) => setTargetDay(event.target.value)}>{DAYS.map((day, index) => <option value={index} key={day.name}>{day.name}</option>)}</select></label>
          </div>
          <button className="secondary-button full" type="button" disabled={Number(targetDay) === meal.dayIndex} onClick={() => onMove(Number(targetDay))}><CalendarDays size={17} /> Move meal and linked prep</button>
          {assignedLeftover && (
            <section className="assigned-leftover">
              <PackageCheck size={18} />
              <span>
                <strong>{assignedLeftover.portions} portions from {assignedLeftover.label}</strong>
                <small>{assignedLeftover.state} for {DAYS[meal.dayIndex].name}</small>
              </span>
              <button type="button" className="secondary-button" disabled={assignedLeftover.state === "consumed"} onClick={() => onConsumeLeftover(assignedLeftover.id)}>
                <CheckCircle2 size={16} /> {assignedLeftover.state === "consumed" ? "Consumed" : "Mark consumed"}
              </button>
            </section>
          )}
          <section className="snapshot-section"><h3>Ingredients</h3><ul>{meal.ingredients.map((ingredient) => <li key={ingredient}>{ingredient}</li>)}</ul></section>
          <section className="snapshot-section"><h3>Instructions</h3><ol>{meal.instructions.map((instruction) => <li key={instruction}>{instruction}</li>)}</ol></section>
          <div className="source-note"><Home size={16} /><span><strong>Source snapshot</strong><small>Adapted for this week; the original recipe remains unchanged.</small></span></div>
        </div>
        <div className="drawer-footer">
          <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
          <button className="primary-button" type="button" onClick={() => { onSave({ title, venue, notes }); onClose(); }}><Check size={17} /> Save snapshot</button>
        </div>
      </section>
    </div>
  );
}

function HistoryPanel({
  events,
  onClose,
  onReset,
  onRevert,
}: {
  events: EventEntry[];
  onClose: () => void;
  onReset: () => void;
  onRevert: (eventId: string) => void;
}) {
  const dialogRef = useDialogFocus(onClose);
  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section ref={dialogRef} className="drawer history-drawer" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <div className="drawer-header"><div><p className="eyebrow">Event log</p><h2 id="history-title">Recent changes</h2></div><button className="icon-button" type="button" aria-label="Close history" onClick={onClose}><X size={19} /></button></div>
        <div className="history-list">
          {events.map((entry) => (
            <div className="history-entry" key={entry.id}>
              <div className="actor-mark" data-actor={entry.actor.toLowerCase()}>{entry.actor === "Codex" ? <Bot size={16} /> : <PencilLine size={16} />}</div>
              <div>
                <strong>{entry.summary}</strong>
                <span>{entry.actor} | {entry.command} | {entry.target || "active week"}</span>
                {entry.changes?.length ? <small>{entry.changes.join(" | ")}</small> : null}
                <small>{entry.time}</small>
                {entry.before && <button type="button" onClick={() => onRevert(entry.id)}><RotateCcw size={14} /> Revert to before</button>}
              </div>
            </div>
          ))}
        </div>
        <div className="drawer-footer"><button className="text-button danger" type="button" onClick={onReset}><RotateCcw size={16} /> Reset local demo</button></div>
      </section>
    </div>
  );
}

function ArchivedCurrentWeek({
  data,
  onOpenHistory,
}: {
  data: PlannerData;
  onOpenHistory: () => void;
}) {
  const ordered = [...data.meals].sort((a, b) => a.dayIndex - b.dayIndex);
  const feedbackCounts = (["repeat", "modify", "drop"] as const).map((value) => ({
    value,
    count: Object.values(data.feedback).filter((item) => item === value).length,
  }));
  const reviewedLeftovers = data.leftovers.filter((leftover) => leftover.quality).length;

  return (
    <div className="lifecycle-surface current-archive">
      <div className="archive-summary-band">
        <span className="archive-icon"><Archive size={23} /></span>
        <div>
          <p className="eyebrow">Read-only summary</p>
          <h2>July 6 - 12</h2>
          <p>{ordered.filter((meal) => ["cooked", "leftover", "flex"].includes(meal.status)).length} settled outcomes recorded, {reviewedLeftovers} of {data.leftovers.length} leftover paths reviewed.</p>
        </div>
      </div>
      <div className="archive-week-list">
        {ordered.map((meal) => (
          <div key={meal.id}>
            <span>{DAYS[meal.dayIndex].short}</span>
            <strong>{meal.title}</strong>
            <StatusBadge status={meal.status} />
          </div>
        ))}
      </div>
      <div className="archive-stats">
        {feedbackCounts.map((item) => (
          <span key={item.value}><strong>{item.count}</strong>{item.value}</span>
        ))}
      </div>
      <div className="lesson-band"><Sparkles size={18} /><span><strong>Planning lesson</strong><p>{data.weekLesson}</p></span></div>
      <button className="secondary-button" type="button" onClick={onOpenHistory}><History size={17} /> Open recoverable history</button>
    </div>
  );
}

function LifecycleWeek({
  state,
  onOpenActive,
  draftReady,
  onMarkDraftReady,
}: {
  state: WeekState;
  onOpenActive: () => void;
  draftReady: boolean;
  onMarkDraftReady: () => void;
}) {
  if (state === "archived") {
    return (
      <div className="lifecycle-surface">
        <div className="archive-summary-band"><span className="archive-icon"><Archive size={23} /></span><div><p className="eyebrow">Read-only summary</p><h2>June 29 - July 5</h2><p>Five dinners cooked, one flex night, and three recipes marked repeat.</p></div></div>
        <div className="archive-week-list">
          {["Harissa chicken skewers", "Salmon pasta salad", "Chicken tacos", "Leftovers", "Sheet-pan salmon", "Eat out", "Chicken leftovers"].map((meal, index) => <div key={meal}><span>{DAYS[index].short}</span><strong>{meal}</strong><CheckCircle2 size={16} /></div>)}
        </div>
        <div className="lesson-band"><Sparkles size={18} /><span><strong>Lesson promoted</strong><p>Keep one portable dinner assembled and one modular for weather changes.</p></span></div>
        <button className="primary-button" type="button" onClick={onOpenActive}>Return to active week <ArrowRight size={17} /></button>
      </div>
    );
  }
  return (
    <div className="lifecycle-surface">
      <div className="draft-heading"><div><p className="eyebrow">Future week | draft</p><h2>July 13 - 19</h2><p>Codex has proposed a two-protein week. Nothing is active yet.</p></div><span className="summary-chip">{draftReady ? "Ready" : "Needs review"}</span></div>
      <div className="draft-grid">{DRAFT_MEALS.map((meal, index) => <div key={meal}><span>{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][index]}</span><strong>{meal}</strong><small>{index === 1 ? "Waeg" : index === 5 ? "Flexible" : "Home"}</small></div>)}</div>
      <div className="draft-actions"><button className="secondary-button" type="button" onClick={onOpenActive}><ArrowLeft size={17} /> Active week</button><button className="primary-button" type="button" onClick={onMarkDraftReady} disabled={draftReady}><Check size={17} /> {draftReady ? "Plan ready" : "Mark plan ready"}</button></div>
    </div>
  );
}
