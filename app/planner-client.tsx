"use client";

import {
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
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
  Minus,
  PackageCheck,
  PencilLine,
  Play,
  Plus,
  RotateCcw,
  Send,
  ShoppingBasket,
  Sparkles,
  Sprout,
  StickyNote,
  Trash2,
  Utensils,
  X,
  type LucideIcon,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  executeDomainCommand,
  isDomainCommand,
  type DomainCommand,
  type GroceryItem,
  type InstructionStep,
  type Leftover,
  type Meal,
  type MealStatus,
  type PlannerData,
  type PrepReference,
  resolveInstructionStep,
} from "@/lib/planner-domain";
import {
  formatPlannerEventTime,
  migrateChatMessages,
  migrateEventHistory,
  retainRecoverableEventHistory,
  type PlannerActor as Actor,
  type PlannerChatMessage as ChatMessage,
  type PlannerEventEntry as EventEntry,
} from "@/lib/planner-history";
import { buildChatPlannerState } from "@/lib/planner-chat-context";
import { migrateStoredPlannerData } from "@/lib/planner-persistence";

type View = "week" | "tonight" | "prep" | "groceries" | "closeout";
type WeekState = "archived" | "active" | "draft";

type UndoState = {
  snapshot: PlannerData;
  summary: string;
  actor: Actor;
} | null;

type BridgeState = "checking" | "ready" | "unavailable" | "wrong-auth";

type BridgeStatus = {
  state: BridgeState;
  detail: string;
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
const STORAGE_KEY = "weekly-recipe-planner:v2";
const LEGACY_STORAGE_KEY = "weekly-recipe-planner:v1";
const CODEX_BRIDGE_URL =
  process.env.NEXT_PUBLIC_CODEX_BRIDGE_URL ?? "http://127.0.0.1:8788";

const PREP_DATES = [
  "Sun, Jul 5",
  "Mon, Jul 6",
  "Tue, Jul 7",
  "Wed, Jul 8",
  "Thu, Jul 9",
  "Fri, Jul 10",
  "Sat, Jul 11",
  "Sun, Jul 12",
] as const;

function recipeStep(
  id: string,
  inputs: Array<[amount: string, ingredient: string]>,
  instruction: string,
  options: Partial<
    Pick<InstructionStep, "complete" | "timerDurationSeconds" | "timerStartedAt" | "note">
  > = {},
): InstructionStep {
  return {
    id,
    inputs: inputs.map(([amount, ingredient]) => ({ amount, ingredient })),
    instruction,
    complete: false,
    ...options,
  };
}

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
        recipeStep(
          "meal-mon-marinate",
          [["900 g", "boneless chicken thighs"], ["3 tbsp", "harissa paste"], ["1", "lemon"]],
          "Coat the chicken with harissa and lemon, then refrigerate until cooking.",
          { complete: true },
        ),
        recipeStep(
          "meal-mon-tray",
          [["2", "red peppers, sliced"], ["1 x 540 mL can", "chickpeas"]],
          "Arrange the peppers and chickpeas with the marinated chicken on a sheet pan.",
          { complete: true },
        ),
        recipeStep(
          "meal-mon-roast",
          [["1 tray", "prepared chicken, peppers, and chickpeas"]],
          "Roast at 220 C until the chicken is cooked through.",
          { complete: true, timerDurationSeconds: 28 * 60 },
        ),
        recipeStep(
          "meal-mon-rest",
          [["to finish", "lemon and parsley"]],
          "Rest the tray, then finish with lemon and parsley.",
          { complete: true, timerDurationSeconds: 5 * 60 },
        ),
        recipeStep(
          "meal-mon-pack",
          [["2 portions", "traybake"]],
          "Pack two lunch portions before serving dinner.",
          { complete: true },
        ),
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
        recipeStep(
          "meal-tue-pickle",
          [["1", "English cucumber"], ["1/2 cup", "quick-pickle brine"]],
          "Slice and quick-pickle the cucumber.",
          { complete: true, timerDurationSeconds: 12 * 60 },
        ),
        recipeStep(
          "meal-tue-slice",
          [["450 g", "cooked harissa chicken"]],
          "Slice the cooked chicken into pita-sized pieces.",
          { complete: true },
        ),
        recipeStep(
          "meal-tue-pack",
          [["6", "whole-wheat pitas"], ["180 g", "feta"], ["1 cup", "lemon yogurt sauce"]],
          "Pack the pitas, filling, feta, and sauce separately in the cooler.",
          { complete: true },
        ),
        recipeStep(
          "meal-tue-assemble",
          [["6", "packed pitas"]],
          "Assemble the pitas just before eating.",
          { complete: true },
        ),
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
        recipeStep(
          "meal-wed-warm",
          [["remaining", "harissa chicken"], ["3 cups", "cooked farro"]],
          "Warm the farro and chicken together.",
          { complete: true, timerDurationSeconds: 8 * 60 },
        ),
        recipeStep(
          "meal-wed-wilt",
          [["1 bunch", "farm-box spinach"]],
          "Wilt the spinach into the hot farro.",
          { complete: true },
        ),
        recipeStep(
          "meal-wed-finish",
          [["1 cup", "pickled cucumber"], ["to serve", "yogurt sauce"]],
          "Top the bowls with pickled cucumber and yogurt sauce.",
          { complete: true },
        ),
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
        recipeStep(
          "meal-thu-thaw",
          [["680 g", "salmon fillet"]],
          "Thaw the salmon in the refrigerator.",
          { complete: true, note: "Thawed Wednesday night." },
        ),
        recipeStep(
          "meal-thu-rice",
          [["2 cups", "jasmine rice"], ["3 cups", "water"]],
          "Rinse the rice, combine it with the water, and cook until tender.",
          { timerDurationSeconds: 18 * 60 },
        ),
        recipeStep(
          "meal-thu-oven",
          [],
          "Heat the oven to 220 C.",
        ),
        recipeStep(
          "meal-thu-glaze",
          [["3 tbsp", "white miso"], ["2 tbsp", "low-sodium soy sauce"]],
          "Mix the miso and soy sauce into a smooth glaze.",
        ),
        recipeStep(
          "meal-thu-roast",
          [["680 g", "thawed salmon"], ["all", "miso-soy glaze"]],
          "Brush the salmon with glaze and roast until just cooked.",
          { timerDurationSeconds: 10 * 60 },
        ),
        recipeStep(
          "meal-thu-build",
          [["300 g", "snap peas"], ["1", "English cucumber"]],
          "Blister the snap peas, slice the cucumber, and build the rice bowls.",
        ),
        recipeStep(
          "meal-thu-cool",
          [["2 portions", "cooked salmon"]],
          "Cool two salmon portions promptly for Sunday.",
        ),
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
        recipeStep(
          "meal-fri-sauce",
          [["3 tbsp", "soy sauce"], ["2 tbsp", "rice vinegar"], ["1 tbsp", "sesame oil"]],
          "Mix the lo mein sauce until combined.",
        ),
        recipeStep(
          "meal-fri-sear",
          [["400 g", "chicken thighs, sliced"]],
          "Sear the chicken in a wide pan until browned and cooked through.",
          { timerDurationSeconds: 7 * 60 },
        ),
        recipeStep(
          "meal-fri-noodles",
          [["2 heads", "baby bok choy"], ["1", "red pepper"], ["450 g", "fresh lo mein noodles"]],
          "Add the vegetables, then the fresh noodles and sauce.",
        ),
        recipeStep(
          "meal-fri-finish",
          [["2 portions", "finished lo mein"]],
          "Toss over high heat until glossy and pack the lunch portions.",
        ),
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
      instructions: [
        recipeStep(
          "meal-sat-decide",
          [["all", "available leftovers"]],
          "Check the available leftovers before deciding whether to cook.",
        ),
      ],
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
        recipeStep(
          "meal-sun-flake",
          [["2 portions", "reserved cooked salmon"]],
          "Flake the reserved salmon into a mixing bowl.",
        ),
        recipeStep(
          "meal-sun-mix",
          [["1", "egg"], ["1/2 cup", "panko"], ["1/4 cup", "flat-leaf parsley"]],
          "Mix the salmon with the egg, panko, and parsley.",
        ),
        recipeStep(
          "meal-sun-chill",
          [["6", "formed salmon cakes"]],
          "Form six small cakes and chill until firm.",
          { timerDurationSeconds: 10 * 60 },
        ),
        recipeStep(
          "meal-sun-sear",
          [["6", "chilled salmon cakes"], ["1 bowl", "chopped salad"]],
          "Pan-sear the cakes and serve them with the chopped salad.",
        ),
      ],
    },
  ],
  prep: [
    { id: "prep-1", stepId: "meal-mon-marinate", due: "Sun, Jul 5", position: 0 },
    { id: "prep-2", stepId: "meal-tue-pickle", due: "Sun, Jul 5", position: 1 },
    { id: "prep-3", stepId: "meal-thu-thaw", due: "Wed, Jul 8", position: 2 },
    { id: "prep-4", stepId: "meal-thu-rice", due: "Sun, Jul 5", position: 3 },
    { id: "prep-5", stepId: "meal-fri-sauce", due: "Sun, Jul 5", position: 4 },
    { id: "prep-6", stepId: "meal-sun-flake", due: "Sun, Jul 12", position: 5 },
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
    actor: "Household",
    command: "toggleInstructionStep",
    summary: "Marked salmon thawed",
    target: "meal-thu-thaw",
    changes: ["Complete: false to true"],
    occurredAt: Date.parse("2026-07-09T08:12:00-03:00"),
  },
  {
    id: "event-1",
    actor: "Codex",
    command: "reconcileGroceries",
    summary: "Removed owned rice vinegar and sesame oil",
    target: "active-week-groceries",
    changes: ["Two owned pantry items removed"],
    occurredAt: Date.parse("2026-07-06T09:06:00-03:00"),
  },
];

const INITIAL_CHAT: ChatMessage[] = [
  {
    id: "chat-1",
    role: "assistant",
    text: "I can reshape the active week while keeping prep, groceries, and leftovers linked.",
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
  return structuredClone(INITIAL_DATA);
}

function migrateStoredData(value: unknown): PlannerData {
  return migrateStoredPlannerData(value, cloneInitialData());
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

export default function PlannerApp() {
  const [view, setView] = useState<View>("week");
  const [data, setData] = useState<PlannerData>(() => cloneInitialData());
  const [events, setEvents] = useState<EventEntry[]>(INITIAL_EVENTS);
  const [undo, setUndo] = useState<UndoState>(null);
  const [selectedWeekId, setSelectedWeekId] = useState(ACTIVE_WEEK_ID);
  const [chatOpen, setChatOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedMealId, setSelectedMealId] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatInputContext, setChatInputContext] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(INITIAL_CHAT);
  const [chatPending, setChatPending] = useState(false);
  const [bridgeCheck, setBridgeCheck] = useState(0);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({
    state: "checking",
    detail: "Checking local Codex",
  });
  const [groceryFilter, setGroceryFilter] = useState<"remaining" | "all">("remaining");
  const [hydrated, setHydrated] = useState(false);
  const [persistenceFailed, setPersistenceFailed] = useState(false);
  const dataRef = useRef(data);
  const selectedWeekIdRef = useRef(selectedWeekId);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    selectedWeekIdRef.current = selectedWeekId;
  }, [selectedWeekId]);

  useEffect(() => {
    const restore = window.setTimeout(() => {
      try {
        const saved =
          window.localStorage.getItem(STORAGE_KEY) ??
          window.localStorage.getItem(LEGACY_STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved) as {
            data?: unknown;
            events?: unknown;
            chatMessages?: unknown;
          };
          if (parsed.data) {
            const migratedData = migrateStoredData(parsed.data);
            dataRef.current = migratedData;
            setData(migratedData);
          }
          const migratedEvents = migrateEventHistory(parsed.events, migrateStoredData);
          if (migratedEvents.length) setEvents(migratedEvents);
          setChatMessages(migrateChatMessages(parsed.chatMessages, INITIAL_CHAT));
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
    let failed = false;
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ data, events, chatMessages }),
      );
    } catch {
      failed = true;
    }

    const statusUpdate = window.setTimeout(() => setPersistenceFailed(failed), 0);
    return () => window.clearTimeout(statusUpdate);
  }, [chatMessages, data, events, hydrated]);

  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(null), 9000);
    return () => window.clearTimeout(timer);
  }, [undo]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    let active = true;

    void fetch(`${CODEX_BRIDGE_URL}/health`, { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json()) as {
          account?: { type?: string; planType?: string };
          auth?: { type?: string; mode?: string; planType?: string; message?: string };
          error?: string;
        };
        if (!active) return;
        const account = payload.account ?? payload.auth;
        const authType = account?.type ?? payload.auth?.mode;
        if (response.ok && authType === "chatgpt") {
          setBridgeStatus({
            state: "ready",
            detail: account?.planType
              ? `ChatGPT ${account.planType} connected`
              : "ChatGPT account connected",
          });
          return;
        }
        if (response.ok || response.status === 401) {
          setBridgeStatus({
            state: "wrong-auth",
            detail: payload.error ?? payload.auth?.message ?? "Codex needs a ChatGPT login",
          });
          return;
        }
        throw new Error(payload.error ?? `Bridge returned ${response.status}`);
      })
      .catch(() => {
        if (active) {
          setBridgeStatus({
            state: "unavailable",
            detail: "Local Codex bridge unavailable",
          });
        }
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [bridgeCheck]);

  const activeWeek = WEEK_OPTIONS.find((week) => week.id === selectedWeekId) ?? WEEK_OPTIONS[1];
  const selectedWeekState: WeekState =
    selectedWeekId === ACTIVE_WEEK_ID && data.weekArchived
      ? "archived"
      : activeWeek.state;
  const selectedMeal = useMemo(
    () => data.meals.find((meal) => meal.id === selectedMealId) ?? null,
    [data.meals, selectedMealId],
  );
  const selectedAssignedLeftover = selectedMeal
    ? data.leftovers.find(
        (leftover) =>
          leftover.state === "assigned" &&
          leftover.assignedDayIndex === selectedMeal.dayIndex,
      ) ?? null
    : null;
  const tonightMeal = data.meals.find((meal) => meal.dayIndex === TODAY_INDEX) ?? data.meals[3];
  const prepDone = data.prep.filter(
    (reference) => resolveInstructionStep(data, reference.stepId)?.step.complete,
  ).length;
  const groceriesDone = data.groceries.filter((item) => item.checked).length;
  const cookedMeals = data.meals.filter((meal) => meal.status === "cooked" || meal.status === "leftover").length;

  const contextLabel = selectedMeal
    ? `${DAYS[selectedMeal.dayIndex].name} | ${selectedMeal.title}`
    : selectedWeekId !== ACTIVE_WEEK_ID
      ? `${activeWeek.state} week | ${activeWeek.range}`
      : view === "tonight"
      ? `Tonight | ${tonightMeal.title}`
      : view === "groceries"
        ? "Groceries | farm-box reconciliation"
        : view === "prep"
          ? "Prep | active week"
          : view === "closeout"
            ? "Closeout | week of Jul 6"
            : "Week overview | Jul 6 - 12";

  function dispatchCommand(actor: Actor, command: DomainCommand) {
    const currentData = dataRef.current;
    const result = executeDomainCommand(currentData, command);
    if (!result.ok) return result;
    const before = currentData;
    dataRef.current = result.state;
    setData(result.state);
    setUndo({ snapshot: before, summary: result.summary, actor });
    setEvents((current) =>
      retainRecoverableEventHistory([{
        id: makeId("event"),
        actor,
        command: command.type,
        summary: result.summary,
        target: result.target,
        changes: result.changes,
        before,
        occurredAt: Date.now(),
      }, ...current]),
    );
    return result;
  }

  function undoLastChange() {
    if (!undo) return;
    const before = dataRef.current;
    dataRef.current = undo.snapshot;
    setData(undo.snapshot);
    setEvents((current) =>
      retainRecoverableEventHistory([{
        id: makeId("event"),
        actor: "Household",
        command: "undo",
        summary: `Undid: ${undo.summary}`,
        target: "active-week-state",
        changes: [`Restored the state before: ${undo.summary}`],
        before,
        occurredAt: Date.now(),
      }, ...current]),
    );
    setUndo(null);
  }

  function revertHistoryEvent(eventId: string) {
    const entry = events.find((event) => event.id === eventId);
    if (!entry?.before) return;
    const before = dataRef.current;
    dataRef.current = entry.before;
    setData(entry.before);
    setUndo({ snapshot: before, summary: `Reverted ${entry.summary}`, actor: "Household" });
    setEvents((current) =>
      retainRecoverableEventHistory([{
        id: makeId("event"),
        actor: "Household",
        command: "revertEvent",
        summary: `Reverted: ${entry.summary}`,
        target: entry.target || "active-week-state",
        changes: [`Restored the state stored with event ${entry.id}`],
        before,
        occurredAt: Date.now(),
      }, ...current]),
    );
  }

  function resetDemo() {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    const reset = cloneInitialData();
    dataRef.current = reset;
    setData(reset);
    setEvents(INITIAL_EVENTS);
    setChatMessages(INITIAL_CHAT);
    setPersistenceFailed(false);
    setChatInput("");
    setChatInputContext(null);
    setUndo(null);
    setSelectedWeekId(ACTIVE_WEEK_ID);
    setView("week");
  }

  function moveMeal(mealId: string, targetDayIndex: number, actor: Actor = "Household") {
    dispatchCommand(actor, { type: "moveMeal", mealId, targetDayIndex });
  }

  async function sendChatMessage(messageValue: string, messageContext = contextLabel) {
    const message = messageValue.trim();
    if (!message) return;
    if (chatPending || bridgeStatus.state !== "ready") {
      setChatOpen(true);
      setChatInput(message);
      setChatInputContext(messageContext);
      return;
    }
    const userMessage: ChatMessage = {
      id: makeId("chat"),
      role: "user",
      text: message,
      context: messageContext,
    };
    const conversation = [...chatMessages, userMessage];
    setChatMessages(conversation);
    setChatInput("");
    setChatInputContext(null);
    setChatPending(true);
    const requestWeekId = selectedWeekId;
    const requestWeekState = selectedWeekState;
    const mutationBaseState = dataRef.current;
    const requestState = buildChatPlannerState({
      activeWeekId: ACTIVE_WEEK_ID,
      activePlannerState: mutationBaseState,
      selectedWeek: {
        id: requestWeekId,
        label: activeWeek.label,
        range: activeWeek.range,
        state: requestWeekState,
      },
      draftMealTitles: DRAFT_MEALS,
    });
    const requestStateFingerprint = JSON.stringify(mutationBaseState);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 90000);

    try {
      const response = await fetch(`${CODEX_BRIDGE_URL}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message,
          state: requestState,
          context: messageContext,
          messages: chatMessages.slice(-12).map(({ role, text, context }) => ({
            role,
            text: (context ? `[${context}] ${text}` : text).slice(0, 4_000),
          })),
        }),
        signal: controller.signal,
      });
      const payload = (await response.json()) as {
        reply?: unknown;
        command?: unknown;
        error?: string;
      };
      if (!response.ok) {
        if (response.status === 401) {
          setBridgeStatus({
            state: "wrong-auth",
            detail: payload.error ?? "ChatGPT login required",
          });
        } else if (response.status === 503) {
          setBridgeStatus({
            state: "unavailable",
            detail: "Local Codex bridge unavailable",
          });
        }
        throw new Error(payload.error ?? `Codex bridge returned ${response.status}`);
      }
      if (typeof payload.reply !== "string" || !payload.reply.trim()) {
        throw new Error("Codex returned an invalid reply.");
      }
      if (payload.command !== null && payload.command !== undefined) {
        if (!isDomainCommand(payload.command)) {
          throw new Error("Codex proposed an unsupported planner command.");
        }
        if (selectedWeekIdRef.current !== requestWeekId) {
          setChatMessages((current) => [
            ...current,
            {
              id: makeId("chat"),
              role: "assistant",
              text: `${payload.reply}\n\nThe selected week changed while I was responding, so I did not apply this command. Send it again from the intended week.`,
            },
          ]);
          return;
        }
        const canApplyToSelectedWeek =
          (requestWeekId === ACTIVE_WEEK_ID && requestWeekState === "active") ||
          (requestWeekState === "draft" && payload.command.type === "createWeekPlan");
        if (!canApplyToSelectedWeek) {
          setChatMessages((current) => [
            ...current,
            {
              id: makeId("chat"),
              role: "assistant",
              text: `${payload.reply}\n\nI did not apply a planner change because this week is read-only.`,
            },
          ]);
          return;
        }
        if (JSON.stringify(dataRef.current) !== requestStateFingerprint) {
          setChatMessages((current) => [
            ...current,
            {
              id: makeId("chat"),
              role: "assistant",
              text: `${payload.reply}\n\nThe week changed while I was responding, so I did not apply this command. Send it again to use the current week.`,
            },
          ]);
          return;
        }
        const result = dispatchCommand("Codex", payload.command);
        setChatMessages((current) => [
          ...current,
          {
            id: makeId("chat"),
            role: "assistant",
            text: result.ok
              ? payload.reply as string
              : `${payload.reply}\n\nNo change was applied: ${result.error}`,
            changes: result.ok ? result.changes : undefined,
          },
        ]);
      } else {
        setChatMessages((current) => [
          ...current,
          { id: makeId("chat"), role: "assistant", text: payload.reply as string },
        ]);
      }
    } catch (error) {
      if (error instanceof TypeError) {
        setBridgeStatus({
          state: "unavailable",
          detail: "Local Codex bridge unavailable",
        });
      }
      const detail =
        error instanceof DOMException && error.name === "AbortError"
          ? "Codex took too long to respond. No change was applied."
          : error instanceof Error
            ? `${error.message} No change was applied.`
            : "Codex could not respond. No change was applied.";
      setChatMessages((current) => [
        ...current,
        {
          id: makeId("chat"),
          role: "assistant",
          text: detail,
        },
      ]);
    } finally {
      window.clearTimeout(timeout);
      setChatPending(false);
    }
  }

  async function handleChatSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendChatMessage(chatInput, chatInputContext ?? contextLabel);
  }

  function updateMealStatus(mealId: string, status: MealStatus) {
    dispatchCommand("Household", { type: "updateMealStatus", mealId, status });
  }

  function updateMealSnapshot(
    mealId: string,
    changes: Pick<Meal, "title" | "venue" | "notes">,
  ) {
    return dispatchCommand("Household", {
      type: "updateMealSnapshot",
      mealId,
      changes,
    }).ok;
  }

  function toggleInstructionStep(stepId: string) {
    dispatchCommand("Household", { type: "toggleInstructionStep", stepId });
  }

  function updateInstructionStepNote(stepId: string, note: string) {
    dispatchCommand("Household", { type: "updateInstructionStepNote", stepId, note });
  }

  function startInstructionTimer(stepId: string) {
    dispatchCommand("Household", { type: "startInstructionTimer", stepId });
  }

  function resetInstructionTimer(stepId: string) {
    dispatchCommand("Household", { type: "resetInstructionTimer", stepId });
  }

  function movePrepReference(referenceId: string, targetPosition: number) {
    dispatchCommand("Household", { type: "movePrepReference", referenceId, targetPosition });
  }

  function reschedulePrepReference(referenceId: string, due: string) {
    dispatchCommand("Household", { type: "reschedulePrepReference", referenceId, due });
  }

  function removePrepReference(referenceId: string) {
    dispatchCommand("Household", { type: "removePrepReference", referenceId });
  }

  function sendInstructionComment(meal: Meal, step: InstructionStep, message: string) {
    if (chatPending || bridgeStatus.state !== "ready") return false;
    setChatOpen(true);
    void sendChatMessage(
      message,
      `${DAYS[meal.dayIndex].name} | ${meal.title} | ${step.id}`,
    );
    return true;
  }

  function toggleGrocery(itemId: string) {
    dispatchCommand("Household", { type: "updateGroceryItem", itemId });
  }

  function reconcileFarmBox() {
    dispatchCommand("Household", { type: "reconcileGroceries" });
  }

  function updateFeedback(mealId: string, value: "repeat" | "modify" | "drop") {
    dispatchCommand("Household", { type: "captureFeedback", mealId, value });
  }

  function archiveWeek() {
    dispatchCommand("Household", { type: "archiveWeek" });
  }

  function updateWeekLesson(weekLesson: string) {
    dispatchCommand("Household", { type: "captureWeekLesson", weekLesson });
  }

  function updateLeftoverQuality(
    leftoverId: string,
    quality: "good" | "mixed" | "poor",
  ) {
    dispatchCommand("Household", { type: "captureLeftoverQuality", leftoverId, quality });
  }

  function assignLeftover(leftoverId: string, dayIndex: number) {
    dispatchCommand("Household", { type: "assignLeftover", leftoverId, dayIndex });
  }

  function consumeLeftover(leftoverId: string) {
    dispatchCommand("Household", { type: "consumeLeftover", leftoverId });
  }

  function markDraftReady() {
    dispatchCommand("Household", { type: "createWeekPlan" });
  }

  function moveWeek(direction: -1 | 1) {
    const index = WEEK_OPTIONS.findIndex((week) => week.id === selectedWeekId);
    const next = Math.max(0, Math.min(WEEK_OPTIONS.length - 1, index + direction));
    setSelectedWeekId(WEEK_OPTIONS[next].id);
  }

  const canSendInstructionComment = bridgeStatus.state === "ready" && !chatPending;

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
            <p className={persistenceFailed ? "sync-note failed" : "sync-note"}>
              <span className="sync-dot" /> {persistenceFailed ? "Local save failed" : "Local state saved"}
            </p>
          </div>
        </div>

        <div className="week-control">
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
          <label className="week-select">
            <span className="sr-only">Selected week</span>
            <select
              value={selectedWeekId}
              onChange={(event) => setSelectedWeekId(event.target.value)}
            >
              {WEEK_OPTIONS.map((week) => {
                const state = week.id === ACTIVE_WEEK_ID && data.weekArchived
                  ? "archived"
                  : week.state;
                return (
                  <option key={week.id} value={week.id}>
                    {week.range} - {state === "active" ? "Active week" : state === "draft" ? "Draft plan" : "Archived week"}
                  </option>
                );
              })}
            </select>
          </label>
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
            aria-label="Open ChatGPT"
            title="Open ChatGPT"
            onClick={() => setChatOpen(true)}
          >
            <MessageCircle size={17} aria-hidden="true" />
            <span>ChatGPT</span>
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

        <div className="workspace">
          <section className="primary-workspace">
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
              <>
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
                  leftovers={data.leftovers.filter((leftover) => leftover.sourceMealId === tonightMeal.id)}
                  onOpenMeal={setSelectedMealId}
                  onStatus={updateMealStatus}
                  onToggleStep={toggleInstructionStep}
                  onStartTimer={startInstructionTimer}
                  onResetTimer={resetInstructionTimer}
                  onAddNote={updateInstructionStepNote}
                  canSendToChat={canSendInstructionComment}
                  onSendToChat={(step, message) => sendInstructionComment(tonightMeal, step, message)}
                  onAssignLeftover={assignLeftover}
                />
              )}
              {view === "prep" && (
                <PrepView
                  data={data}
                  onToggleStep={toggleInstructionStep}
                  onStartTimer={startInstructionTimer}
                  onResetTimer={resetInstructionTimer}
                  onAddNote={updateInstructionStepNote}
                  canSendToChat={canSendInstructionComment}
                  onSendToChat={sendInstructionComment}
                  onMove={movePrepReference}
                  onReschedule={reschedulePrepReference}
                  onRemove={removePrepReference}
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
              </>
            )}
          </section>

          <aside className={chatOpen ? "ops-rail chat-rail open" : "ops-rail chat-rail"} aria-label="Shared ChatGPT planner">
            <ChatPanel
              bridgeStatus={bridgeStatus}
              contextLabel={chatInputContext ?? contextLabel}
              input={chatInput}
              pending={chatPending}
              messages={chatMessages}
              onInput={(value) => {
                setChatInput(value);
                if (!value) setChatInputContext(null);
              }}
              onSubmit={handleChatSubmit}
              onRetry={() => {
                setBridgeStatus({ state: "checking", detail: "Checking local Codex" });
                setBridgeCheck((value) => value + 1);
              }}
              onClose={() => setChatOpen(false)}
            />
          </aside>
        </div>
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
          onToggleStep={toggleInstructionStep}
          onStartTimer={startInstructionTimer}
          onResetTimer={resetInstructionTimer}
          onAddNote={updateInstructionStepNote}
          canSendToChat={canSendInstructionComment}
          onSendToChat={(step, message) => {
            const sent = sendInstructionComment(selectedMeal, step, message);
            if (sent) setSelectedMealId(null);
            return sent;
          }}
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

function ChatPanel({
  bridgeStatus,
  contextLabel,
  input,
  pending,
  messages,
  onInput,
  onSubmit,
  onRetry,
  onClose,
}: {
  bridgeStatus: BridgeStatus;
  contextLabel: string;
  input: string;
  pending: boolean;
  messages: ChatMessage[];
  onInput: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onRetry: () => void;
  onClose: () => void;
}) {
  const messagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = messagesRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages.length, pending]);

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-title">
          <span className="bot-icon"><Bot size={18} /></span>
          <span><strong>ChatGPT</strong><small>Shared household planner</small></span>
        </div>
        <button className="icon-button chat-close" type="button" aria-label="Close ChatGPT" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className={`bridge-status bridge-${bridgeStatus.state}`} role="status">
        <span aria-hidden="true" />
        <small>{bridgeStatus.detail}</small>
        {bridgeStatus.state !== "ready" && bridgeStatus.state !== "checking" && (
          <button className="icon-button" type="button" aria-label="Retry Codex connection" onClick={onRetry}>
            <RotateCcw size={14} />
          </button>
        )}
      </div>
      <div className="chat-context"><Sparkles size={14} /> {contextLabel}</div>
      <div ref={messagesRef} className="chat-messages" aria-live="polite" aria-busy={pending}>
        {messages.map((message) => (
          <div key={message.id} className={`chat-message ${message.role}`}>
            {message.context && <small className="chat-message-context">{message.context}</small>}
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
        onClick={() => onInput("Create a Sunday prep plan from this week's instruction steps")}
      >
        Build Sunday prep from this week
      </button>
      <form className="chat-form" onSubmit={onSubmit}>
        <label htmlFor="codex-command" className="sr-only">Send a message to ChatGPT</label>
        <textarea
          id="codex-command"
          value={input}
          onChange={(event) => onInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Ask about or change the plan..."
          rows={2}
        />
        <button
          type="submit"
          aria-label="Send to ChatGPT"
          disabled={!input.trim() || pending || bridgeStatus.state !== "ready"}
        >
          {pending ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}
        </button>
      </form>
    </div>
  );
}

function formatClock(seconds: number) {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function timerLabel(step: InstructionStep, now: number) {
  if (!step.timerDurationSeconds) return null;
  if (step.timerStartedAt === undefined) {
    return `${Math.round(step.timerDurationSeconds / 60)} min`;
  }
  const remaining = step.timerDurationSeconds - (now - step.timerStartedAt) / 1000;
  return remaining >= 0 ? formatClock(remaining) : `+${formatClock(Math.abs(remaining))}`;
}

function InstructionTimerReadout({ step }: { step: InstructionStep }) {
  const isRunning = step.timerStartedAt !== undefined;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isRunning) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [isRunning, step.timerStartedAt]);

  const displayNow = step.timerStartedAt === undefined
    ? now
    : Math.max(now, step.timerStartedAt);
  const label = timerLabel(step, displayNow) ?? "";

  return (
    <>
      <strong>{label}</strong>
      <span>{isRunning ? (label.startsWith("+") ? "overtime" : "remaining") : "timer"}</span>
    </>
  );
}

function InstructionStepCard({
  instanceId,
  meal,
  step,
  reference,
  prepCount,
  onToggle,
  onStartTimer,
  onResetTimer,
  onAddNote,
  canSendToChat,
  onSendToChat,
  onMove,
  onReschedule,
  onRemove,
  onOpenMeal,
}: {
  instanceId: string;
  meal: Meal;
  step: InstructionStep;
  reference?: PrepReference;
  prepCount?: number;
  onToggle: (stepId: string) => void;
  onStartTimer: (stepId: string) => void;
  onResetTimer: (stepId: string) => void;
  onAddNote: (stepId: string, note: string) => void;
  canSendToChat: boolean;
  onSendToChat: (step: InstructionStep, message: string) => boolean;
  onMove?: (referenceId: string, targetPosition: number) => void;
  onReschedule?: (referenceId: string, due: string) => void;
  onRemove?: (referenceId: string) => void;
  onOpenMeal?: (mealId: string) => void;
}) {
  const [comment, setComment] = useState("");
  const stepNumber = meal.instructions.findIndex((item) => item.id === step.id) + 1;
  const hasTimer = step.timerDurationSeconds !== undefined;
  const hasRunningTimer = step.timerStartedAt !== undefined;

  return (
    <article
      className={step.complete ? "instruction-step complete" : "instruction-step"}
      id={instanceId}
      data-step-id={step.id}
    >
      <div className="instruction-step-heading">
        <label className="step-checkbox">
          <input
            type="checkbox"
            checked={step.complete}
            onChange={() => onToggle(step.id)}
            aria-label={`${step.complete ? "Reopen" : "Complete"} step ${stepNumber}: ${step.instruction}`}
          />
          <span>Step {stepNumber}</span>
        </label>
        {reference ? (
          <div className="prep-reference-actions">
            <button
              className="icon-button"
              type="button"
              title="Move step earlier"
              aria-label="Move step earlier"
              disabled={reference.position === 0}
              onClick={() => onMove?.(reference.id, reference.position - 1)}
            >
              <ArrowUp size={16} />
            </button>
            <button
              className="icon-button"
              type="button"
              title="Move step later"
              aria-label="Move step later"
              disabled={reference.position === (prepCount ?? 1) - 1}
              onClick={() => onMove?.(reference.id, reference.position + 1)}
            >
              <ArrowDown size={16} />
            </button>
            <select
              value={reference.due}
              aria-label={`Prep date for ${step.instruction}`}
              onChange={(event) => onReschedule?.(reference.id, event.target.value)}
            >
              {PREP_DATES.map((date) => <option key={date} value={date}>{date}</option>)}
            </select>
            <button
              className="icon-button danger"
              type="button"
              title="Remove from prep"
              aria-label="Remove from prep"
              onClick={() => onRemove?.(reference.id)}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ) : null}
      </div>

      {reference && (
        <button className="step-meal-link" type="button" onClick={() => onOpenMeal?.(meal.id)}>
          {DAYS[meal.dayIndex].name} | {meal.title} <ChevronRight size={14} />
        </button>
      )}

      {step.inputs.length > 0 && (
        <div className="step-inputs" aria-label="Amounts for this step">
          {step.inputs.map((input, index) => (
            <span key={`${input.amount}-${input.ingredient}-${index}`}>
              <strong>{input.amount}</strong> {input.ingredient}
            </span>
          ))}
        </div>
      )}

      <p className="step-instruction">{step.instruction}</p>

      {hasTimer && (
        <div className={hasRunningTimer ? "step-timer running" : "step-timer"}>
          <Clock3 size={15} />
          <InstructionTimerReadout step={step} />
          <button
            className="icon-button"
            type="button"
            title={hasRunningTimer ? "Restart timer" : "Start timer"}
            aria-label={hasRunningTimer ? "Restart timer" : "Start timer"}
            disabled={step.complete}
            onClick={() => onStartTimer(step.id)}
          >
            <Play size={15} />
          </button>
          {hasRunningTimer && (
            <button
              className="icon-button"
              type="button"
              title="Reset timer"
              aria-label="Reset timer"
              onClick={() => onResetTimer(step.id)}
            >
              <RotateCcw size={14} />
            </button>
          )}
        </div>
      )}

      {step.note !== undefined && step.note !== "" && (
        <div className="step-note">
          <StickyNote size={15} />
          <p>{step.note}</p>
          <button
            className="icon-button"
            type="button"
            title="Remove note"
            aria-label="Remove note"
            onClick={() => onAddNote(step.id, "")}
          >
            <X size={14} />
          </button>
        </div>
      )}

      <details className="step-comment">
        <summary><MessageSquareText size={15} /> Add comment</summary>
        <div className="step-comment-body">
          <label htmlFor={`${instanceId}-comment`} className="sr-only">Comment on step {stepNumber}</label>
          <textarea
            id={`${instanceId}-comment`}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="What changed or what should ChatGPT consider?"
            rows={2}
          />
          <div className="step-comment-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={!comment.trim()}
              onClick={() => {
                onAddNote(step.id, comment.trim());
                setComment("");
              }}
            >
              <StickyNote size={15} /> Add note
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={!comment.trim() || !canSendToChat}
              onClick={() => {
                if (onSendToChat(step, comment.trim())) setComment("");
              }}
            >
              <Send size={15} /> Send to ChatGPT
            </button>
          </div>
        </div>
      </details>
    </article>
  );
}

function TonightView({
  meal,
  leftovers,
  onOpenMeal,
  onStatus,
  onToggleStep,
  onStartTimer,
  onResetTimer,
  onAddNote,
  canSendToChat,
  onSendToChat,
  onAssignLeftover,
}: {
  meal: Meal;
  leftovers: Leftover[];
  onOpenMeal: (id: string) => void;
  onStatus: (id: string, status: MealStatus) => void;
  onToggleStep: (id: string) => void;
  onStartTimer: (id: string) => void;
  onResetTimer: (id: string) => void;
  onAddNote: (id: string, note: string) => void;
  canSendToChat: boolean;
  onSendToChat: (step: InstructionStep, message: string) => boolean;
  onAssignLeftover: (leftoverId: string, dayIndex: number) => void;
}) {
  const completeSteps = meal.instructions.filter((step) => step.complete).length;
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
            <div className="section-title"><CookingPot size={18} /><h3>Instructions</h3><span>{completeSteps}/{meal.instructions.length} done</span></div>
            <div className="instruction-steps">
              {meal.instructions.map((step) => (
                <InstructionStepCard
                  key={step.id}
                  instanceId={`tonight-${step.id}`}
                  meal={meal}
                  step={step}
                  onToggle={onToggleStep}
                  onStartTimer={onStartTimer}
                  onResetTimer={onResetTimer}
                  onAddNote={onAddNote}
                  canSendToChat={canSendToChat}
                  onSendToChat={onSendToChat}
                />
              ))}
            </div>
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
        <section className="plain-panel prep-readiness">
          <div className="section-title"><ClipboardCheck size={18} /><h3>Step readiness</h3></div>
          <strong>{completeSteps} of {meal.instructions.length} already done</strong>
          <p>Steps completed from Prep stay checked here in their original recipe order.</p>
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
  onToggleStep,
  onStartTimer,
  onResetTimer,
  onAddNote,
  canSendToChat,
  onSendToChat,
  onMove,
  onReschedule,
  onRemove,
  onOpenMeal,
}: {
  data: PlannerData;
  onToggleStep: (id: string) => void;
  onStartTimer: (id: string) => void;
  onResetTimer: (id: string) => void;
  onAddNote: (id: string, note: string) => void;
  canSendToChat: boolean;
  onSendToChat: (meal: Meal, step: InstructionStep, message: string) => boolean;
  onMove: (id: string, targetPosition: number) => void;
  onReschedule: (id: string, due: string) => void;
  onRemove: (id: string) => void;
  onOpenMeal: (id: string) => void;
}) {
  const ordered = [...data.prep].sort((left, right) => left.position - right.position);
  const resolved = ordered.flatMap((reference) => {
    const target = resolveInstructionStep(data, reference.stepId);
    return target ? [{ reference, ...target }] : [];
  });
  const remaining = resolved.filter(({ step }) => !step.complete).length;
  return (
    <div className="list-surface">
      <div className="surface-summary">
        <div><p className="eyebrow">Manual run order</p><h2>{remaining} steps remaining</h2></div>
        <span className="summary-chip"><ListChecks size={15} /> {resolved.length} referenced steps</span>
      </div>
      <div className="prep-step-list">
        {resolved.map(({ reference, meal, step }) => (
          <InstructionStepCard
            key={reference.id}
            instanceId={`prep-${reference.id}`}
            meal={meal}
            step={step}
            reference={reference}
            prepCount={resolved.length}
            onToggle={onToggleStep}
            onStartTimer={onStartTimer}
            onResetTimer={onResetTimer}
            onAddNote={onAddNote}
            canSendToChat={canSendToChat}
            onSendToChat={(currentStep, message) => onSendToChat(meal, currentStep, message)}
            onMove={onMove}
            onReschedule={onReschedule}
            onRemove={onRemove}
            onOpenMeal={onOpenMeal}
          />
        ))}
        {!resolved.length && <p className="empty-copy">No steps are assigned to prep.</p>}
      </div>
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
  onToggleStep,
  onStartTimer,
  onResetTimer,
  onAddNote,
  canSendToChat,
  onSendToChat,
}: {
  meal: Meal;
  assignedLeftover: Leftover | null;
  onClose: () => void;
  onMove: (day: number) => void;
  onStatus: (status: MealStatus) => void;
  onSave: (changes: Pick<Meal, "title" | "venue" | "notes">) => boolean;
  onConsumeLeftover: (leftoverId: string) => void;
  onToggleStep: (stepId: string) => void;
  onStartTimer: (stepId: string) => void;
  onResetTimer: (stepId: string) => void;
  onAddNote: (stepId: string, note: string) => void;
  canSendToChat: boolean;
  onSendToChat: (step: InstructionStep, message: string) => boolean;
}) {
  const [title, setTitle] = useState(meal.title);
  const [venue, setVenue] = useState(meal.venue);
  const [notes, setNotes] = useState(meal.notes);
  const [targetDay, setTargetDay] = useState(String(meal.dayIndex));
  const dialogRef = useDialogFocus(onClose);
  const snapshot = { title: title.trim(), venue: venue.trim(), notes };
  const snapshotValid = snapshot.title.length > 0 && snapshot.venue.length > 0;
  const snapshotUnchanged =
    snapshot.title === meal.title &&
    snapshot.venue === meal.venue &&
    snapshot.notes === meal.notes;
  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section ref={dialogRef} className="drawer meal-drawer" role="dialog" aria-modal="true" aria-labelledby="meal-detail-title">
        <div className="drawer-header">
          <div><p className="eyebrow">{DAYS[meal.dayIndex].name} | week-local snapshot</p><h2 id="meal-detail-title">Meal detail</h2></div>
          <button className="icon-button" type="button" aria-label="Close meal detail" onClick={onClose}><X size={19} /></button>
        </div>
        <div className="drawer-body">
          <div className="field-grid">
            <label><span>Meal name</span><input value={title} maxLength={300} onChange={(event) => setTitle(event.target.value)} /></label>
            <label><span>Venue</span><input value={venue} maxLength={300} onChange={(event) => setVenue(event.target.value)} /></label>
          </div>
          <label className="full-field"><span>Notes and adaptation</span><textarea value={notes} maxLength={4_000} onChange={(event) => setNotes(event.target.value)} rows={3} /></label>
          <div className="field-grid">
            <label><span>Status</span><select value={meal.status} onChange={(event) => onStatus(event.target.value as MealStatus)}>{Object.entries(STATUS_META).map(([value, meta]) => <option value={value} key={value}>{meta.label}</option>)}</select></label>
            <label><span>Move to</span><select value={targetDay} onChange={(event) => setTargetDay(event.target.value)}>{DAYS.map((day, index) => <option value={index} key={day.name}>{day.name}</option>)}</select></label>
          </div>
          <button className="secondary-button full" type="button" disabled={Number(targetDay) === meal.dayIndex} onClick={() => onMove(Number(targetDay))}><CalendarDays size={17} /> Move meal</button>
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
          <section className="snapshot-section">
            <h3>Instructions</h3>
            <div className="instruction-steps drawer-instruction-steps">
              {meal.instructions.map((step) => (
                <InstructionStepCard
                  key={step.id}
                  instanceId={`detail-${step.id}`}
                  meal={meal}
                  step={step}
                  onToggle={onToggleStep}
                  onStartTimer={onStartTimer}
                  onResetTimer={onResetTimer}
                  onAddNote={onAddNote}
                  canSendToChat={canSendToChat}
                  onSendToChat={onSendToChat}
                />
              ))}
            </div>
          </section>
          <div className="source-note"><Home size={16} /><span><strong>Source snapshot</strong><small>Adapted for this week; the original recipe remains unchanged.</small></span></div>
        </div>
        <div className="drawer-footer">
          <button className="secondary-button" type="button" onClick={onClose}>Close</button>
          <button
            className="primary-button"
            type="button"
            disabled={!snapshotValid}
            onClick={() => {
              if (snapshotUnchanged || onSave(snapshot)) onClose();
            }}
          >
            <Check size={17} /> Save meal details
          </button>
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
                <small>{entry.occurredAt === undefined ? entry.time ?? "Unknown time" : formatPlannerEventTime(entry.occurredAt)}</small>
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
