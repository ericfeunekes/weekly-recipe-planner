export type MealStatus =
  | "planned"
  | "moved"
  | "cooking"
  | "cooked"
  | "leftover"
  | "flex";

export type Meal = {
  id: string;
  dayIndex: number;
  title: string;
  subtitle: string;
  venue: string;
  status: MealStatus;
  protein: "chicken" | "salmon" | "none";
  prepNote: string;
  leftoverNote: string;
  notes: string;
  ingredients: string[];
  instructions: string[];
  leftoverId?: string;
};

export type PrepTask = {
  id: string;
  title: string;
  due: string;
  mealId: string;
  complete: boolean;
  duration: string;
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
  assignedDayIndex?: number;
  quality?: "good" | "mixed" | "poor";
};

export type PlannerData = {
  meals: Meal[];
  prep: PrepTask[];
  groceries: GroceryItem[];
  leftovers: Leftover[];
  farmBoxReconciled: boolean;
  weekArchived: boolean;
  draftReady: boolean;
  feedback: Record<string, "repeat" | "modify" | "drop">;
  weekLesson: string;
};

export type DomainCommand =
  | { type: "moveMeal"; mealId: string; targetDayIndex: number }
  | { type: "moveSalmonToSaturday" }
  | { type: "updateMealStatus"; mealId: string; status: MealStatus }
  | {
      type: "updateMealSnapshot";
      mealId: string;
      changes: Pick<Meal, "title" | "venue" | "notes">;
    }
  | { type: "completePrepTask"; taskId: string }
  | { type: "reschedulePrepTask"; taskId: string; due: string }
  | { type: "updateGroceryItem"; itemId: string }
  | { type: "reconcileGroceries" }
  | {
      type: "captureFeedback";
      mealId: string;
      value: "repeat" | "modify" | "drop";
    }
  | { type: "captureWeekLesson"; weekLesson: string }
  | {
      type: "captureLeftoverQuality";
      leftoverId: string;
      quality: "good" | "mixed" | "poor";
    }
  | { type: "assignLeftover"; leftoverId: string; dayIndex: number }
  | { type: "consumeLeftover"; leftoverId: string }
  | { type: "archiveWeek" }
  | { type: "createWeekPlan" };

export type CommandResult =
  | {
      ok: true;
      state: PlannerData;
      summary: string;
      target: string;
      changes: string[];
    }
  | {
      ok: false;
      state: PlannerData;
      error: string;
    };

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_DUE = [
  "Mon, Jul 6",
  "Tue, Jul 7",
  "Wed, Jul 8",
  "Thu, Jul 9",
  "Fri, Jul 10",
  "Sat, Jul 11",
  "Sun, Jul 12",
];

function success(
  state: PlannerData,
  summary: string,
  target: string,
  changes: string[],
): CommandResult {
  return { ok: true, state, summary, target, changes };
}

function failure(state: PlannerData, error: string): CommandResult {
  return { ok: false, state, error };
}

function leftoverPortions(meal: Meal) {
  const match = meal.leftoverNote.match(/\b(\d+)\b/);
  return match ? Number(match[1]) : 2;
}

export function executeDomainCommand(
  state: PlannerData,
  command: DomainCommand,
): CommandResult {
  if (state.weekArchived && command.type !== "createWeekPlan") {
    return failure(state, "This week is archived and read-only.");
  }

  switch (command.type) {
    case "moveMeal": {
      const moving = state.meals.find((meal) => meal.id === command.mealId);
      const target = state.meals.find(
        (meal) => meal.dayIndex === command.targetDayIndex,
      );
      if (!moving || !target) return failure(state, "Meal or target day not found.");
      if (moving.id === target.id) return failure(state, "The meal is already on that day.");

      const originalDayIndex = moving.dayIndex;
      const next: PlannerData = {
        ...state,
        meals: state.meals.map((meal) => {
          if (meal.id === moving.id) {
            return { ...meal, dayIndex: command.targetDayIndex, status: "moved" };
          }
          if (meal.id === target.id) {
            return {
              ...meal,
              dayIndex: originalDayIndex,
              status: meal.status === "flex" ? "flex" : "moved",
            };
          }
          return meal;
        }),
        prep: state.prep.map((task) => {
          if (task.mealId === moving.id) {
            return { ...task, due: DAY_DUE[command.targetDayIndex] };
          }
          if (task.mealId === target.id) {
            return { ...task, due: DAY_DUE[originalDayIndex] };
          }
          return task;
        }),
        leftovers: state.leftovers.map((leftover) => {
          if (leftover.assignedDayIndex === command.targetDayIndex) {
            return { ...leftover, assignedDayIndex: originalDayIndex };
          }
          if (leftover.assignedDayIndex === originalDayIndex) {
            return { ...leftover, assignedDayIndex: command.targetDayIndex };
          }
          return leftover;
        }),
      };

      return success(
        next,
        `Swapped ${moving.title} with ${target.title}`,
        `${moving.id}, ${target.id}`,
        [
          `${moving.title}: ${DAYS[originalDayIndex]} to ${DAYS[command.targetDayIndex]}`,
          `${target.title}: ${DAYS[command.targetDayIndex]} to ${DAYS[originalDayIndex]}`,
          "Linked prep and leftover assignments moved with both meals",
        ],
      );
    }

    case "moveSalmonToSaturday": {
      const salmon = state.meals.find(
        (meal) => meal.protein === "salmon" && meal.dayIndex === 3,
      );
      const saturday = state.meals.find((meal) => meal.dayIndex === 5);
      if (!salmon || !saturday) {
        return failure(state, "That salmon move is already reflected in the week.");
      }

      const next: PlannerData = {
        ...state,
        meals: state.meals.map((meal) => {
          if (meal.id === salmon.id) {
            return {
              ...meal,
              dayIndex: 5,
              status: "moved",
              venue: "Home or picnic",
              prepNote: "Pack glaze separately if taking out",
            };
          }
          if (meal.id === saturday.id) {
            return {
              ...meal,
              dayIndex: 3,
              title: "Harissa chicken leftovers",
              subtitle: "Farro, farm-box greens, yogurt",
              venue: "Home",
              status: "leftover",
              protein: "chicken",
              prepNote: "Reheat 12 minutes",
              leftoverNote: "Clears remaining chicken",
              notes: "Assigned when salmon moved to Saturday.",
              ingredients: [
                "Remaining harissa chicken",
                "Cooked farro",
                "Farm-box greens",
              ],
              instructions: [
                "Warm chicken and farro.",
                "Wilt greens and finish with yogurt sauce.",
              ],
              leftoverId: "leftover-mon",
            };
          }
          return meal;
        }),
        prep: state.prep.map((task) =>
          task.mealId === salmon.id
            ? { ...task, due: DAY_DUE[5], complete: false }
            : task,
        ),
        leftovers: state.leftovers.map((leftover) =>
          leftover.sourceMealId === "meal-mon"
            ? { ...leftover, state: "assigned", assignedDayIndex: 3 }
            : leftover,
        ),
      };

      return success(
        next,
        "Moved Thursday salmon to Saturday and assigned Thursday leftovers",
        `${salmon.id}, ${saturday.id}`,
        [
          "Thursday: Harissa chicken leftovers",
          "Saturday: Miso salmon rice bowls",
          "Salmon prep moved to Saturday",
        ],
      );
    }

    case "updateMealStatus": {
      const meal = state.meals.find((item) => item.id === command.mealId);
      if (!meal) return failure(state, "Meal not found.");
      if (meal.status === command.status) return failure(state, "Status is unchanged.");
      const leftovers = [...state.leftovers];
      if (
        command.status === "cooked" &&
        meal.protein !== "none" &&
        !leftovers.some((leftover) => leftover.sourceMealId === meal.id)
      ) {
        leftovers.push({
          id: `leftover-${meal.id}`,
          sourceMealId: meal.id,
          label: meal.title,
          portions: leftoverPortions(meal),
          state: "available",
        });
      }
      const next = {
        ...state,
        leftovers,
        meals: state.meals.map((item) =>
          item.id === command.mealId
            ? { ...item, status: command.status }
            : item,
        ),
      };
      const changes = [`Status: ${meal.status} to ${command.status}`];
      if (leftovers.length > state.leftovers.length) {
        changes.push(`${leftoverPortions(meal)} leftover portions recorded as available`);
      }
      return success(
        next,
        `Marked ${meal.title} ${command.status}`,
        meal.id,
        changes,
      );
    }

    case "updateMealSnapshot": {
      const meal = state.meals.find((item) => item.id === command.mealId);
      if (!meal) return failure(state, "Meal not found.");
      return success(
        {
          ...state,
          meals: state.meals.map((item) =>
            item.id === command.mealId
              ? { ...item, ...command.changes }
              : item,
          ),
        },
        `Updated ${command.changes.title}`,
        meal.id,
        ["Week-local title, venue, and notes saved"],
      );
    }

    case "completePrepTask": {
      const task = state.prep.find((item) => item.id === command.taskId);
      if (!task) return failure(state, "Prep task not found.");
      return success(
        {
          ...state,
          prep: state.prep.map((item) =>
            item.id === command.taskId
              ? { ...item, complete: !item.complete }
              : item,
          ),
        },
        `${task.complete ? "Reopened" : "Completed"} ${task.title}`,
        task.id,
        [`Complete: ${task.complete} to ${!task.complete}`],
      );
    }

    case "reschedulePrepTask": {
      const task = state.prep.find((item) => item.id === command.taskId);
      if (!task) return failure(state, "Prep task not found.");
      return success(
        {
          ...state,
          prep: state.prep.map((item) =>
            item.id === command.taskId ? { ...item, due: command.due } : item,
          ),
        },
        `Moved ${task.title} to ${command.due}`,
        task.id,
        [`Due: ${task.due} to ${command.due}`],
      );
    }

    case "updateGroceryItem": {
      const grocery = state.groceries.find((item) => item.id === command.itemId);
      if (!grocery) return failure(state, "Grocery item not found.");
      return success(
        {
          ...state,
          groceries: state.groceries.map((item) =>
            item.id === command.itemId
              ? { ...item, checked: !item.checked }
              : item,
          ),
        },
        `${grocery.checked ? "Returned" : "Checked off"} ${grocery.item}`,
        grocery.id,
        [`Checked: ${grocery.checked} to ${!grocery.checked}`],
      );
    }

    case "reconcileGroceries": {
      if (state.farmBoxReconciled) return failure(state, "The farm box is already reconciled.");
      return success(
        {
          ...state,
          farmBoxReconciled: true,
          groceries: state.groceries.map((item) =>
            item.farmBox ? { ...item, checked: true } : item,
          ),
        },
        "Reconciled parsley and tender greens from the farm box",
        "active-week-groceries",
        ["Flat-leaf parsley covered", "Tender greens covered"],
      );
    }

    case "captureFeedback": {
      return success(
        {
          ...state,
          feedback: { ...state.feedback, [command.mealId]: command.value },
        },
        `Set meal feedback to ${command.value}`,
        command.mealId,
        [`Feedback: ${state.feedback[command.mealId] ?? "unset"} to ${command.value}`],
      );
    }

    case "captureWeekLesson": {
      if (command.weekLesson === state.weekLesson) return failure(state, "Planning lesson is unchanged.");
      return success(
        { ...state, weekLesson: command.weekLesson },
        "Updated the week planning lesson",
        "week-lesson",
        ["Planning lesson revised"],
      );
    }

    case "captureLeftoverQuality": {
      const leftover = state.leftovers.find((item) => item.id === command.leftoverId);
      if (!leftover) return failure(state, "Leftover record not found.");
      return success(
        {
          ...state,
          leftovers: state.leftovers.map((item) =>
            item.id === command.leftoverId
              ? { ...item, quality: command.quality }
              : item,
          ),
        },
        `Rated ${leftover.label} leftovers ${command.quality}`,
        leftover.id,
        [`Quality: ${leftover.quality ?? "unset"} to ${command.quality}`],
      );
    }

    case "assignLeftover": {
      const leftover = state.leftovers.find((item) => item.id === command.leftoverId);
      if (!leftover) return failure(state, "Leftover record not found.");
      const destination = state.meals.find((meal) => meal.dayIndex === command.dayIndex);
      if (!destination) return failure(state, "Destination meal not found.");
      return success(
        {
          ...state,
          meals: state.meals.map((meal) =>
            meal.id === destination.id
              ? {
                  ...meal,
                  status: "leftover",
                  leftoverId: leftover.id,
                  subtitle: `${leftover.portions} portions from ${leftover.label}`,
                  leftoverNote: `Assigned from ${DAYS[state.meals.find((item) => item.id === leftover.sourceMealId)?.dayIndex ?? 0]}`,
                }
              : meal,
          ),
          leftovers: state.leftovers.map((item) =>
            item.id === command.leftoverId
              ? { ...item, state: "assigned", assignedDayIndex: command.dayIndex }
              : item,
          ),
        },
        `Assigned ${leftover.label} leftovers to ${DAYS[command.dayIndex]}`,
        leftover.id,
        [
          `State: ${leftover.state} to assigned`,
          `Assigned day: ${DAYS[command.dayIndex]}`,
          `${destination.title} linked to leftover record ${leftover.id}`,
        ],
      );
    }

    case "consumeLeftover": {
      const leftover = state.leftovers.find((item) => item.id === command.leftoverId);
      if (!leftover) return failure(state, "Leftover record not found.");
      if (leftover.state !== "assigned") {
        return failure(state, "Only assigned leftovers can be consumed.");
      }
      return success(
        {
          ...state,
          meals: state.meals.map((meal) =>
            meal.leftoverId === leftover.id
              ? { ...meal, status: "cooked" }
              : meal,
          ),
          leftovers: state.leftovers.map((item) =>
            item.id === leftover.id ? { ...item, state: "consumed" } : item,
          ),
        },
        `Marked ${leftover.label} leftovers consumed`,
        leftover.id,
        ["State: assigned to consumed", "Destination meal marked cooked"],
      );
    }

    case "archiveWeek": {
      return success(
        { ...state, weekArchived: true },
        "Archived the week with recorded outcomes and planning lessons",
        "week-2026-07-06",
        ["Lifecycle: active to archived", "Active-week commands locked"],
      );
    }

    case "createWeekPlan": {
      if (state.draftReady) return failure(state, "The draft is already ready.");
      return success(
        { ...state, draftReady: true },
        "Marked the July 13 draft ready",
        "week-2026-07-13",
        ["Draft readiness: review to ready"],
      );
    }
  }
}

export function isSupportedSalmonMoveIntent(input: string) {
  const normalized = input.trim().toLowerCase().replaceAll("’", "'");
  return (
    /^(please\s+)?move\b/.test(normalized) &&
    normalized.includes("salmon") &&
    normalized.includes("saturday") &&
    !/\b(do not|don't|dont|never)\b/.test(normalized)
  );
}
