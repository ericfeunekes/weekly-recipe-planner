import { isDomainCommand, type DomainCommand } from "./planner-command-contract.ts";

export { isDomainCommand };
export type { DomainCommand };

export type MealStatus =
  | "planned"
  | "moved"
  | "cooking"
  | "cooked"
  | "leftover"
  | "flex";

export type StepInput = {
  amount: string;
  ingredient: string;
};

export type InstructionStep = {
  id: string;
  inputs: StepInput[];
  instruction: string;
  complete: boolean;
  timerDurationSeconds?: number;
  timerStartedAt?: number;
  note?: string;
};

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
  instructions: InstructionStep[];
};

export type PrepReference = {
  id: string;
  stepId: string;
  due: string;
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
  assignedDayIndex?: number;
  quality?: "good" | "mixed" | "poor";
};

export type PlannerData = {
  meals: Meal[];
  prep: PrepReference[];
  groceries: GroceryItem[];
  leftovers: Leftover[];
  farmBoxReconciled: boolean;
  weekArchived: boolean;
  draftReady: boolean;
  feedback: Record<string, "repeat" | "modify" | "drop">;
  weekLesson: string;
};

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

export function resolveInstructionStep(
  state: PlannerData,
  stepId: string,
): { meal: Meal; step: InstructionStep } | null {
  for (const meal of state.meals) {
    const step = meal.instructions.find((item) => item.id === stepId);
    if (step) return { meal, step };
  }
  return null;
}

function updateInstructionStep(
  state: PlannerData,
  stepId: string,
  update: (step: InstructionStep) => InstructionStep,
): PlannerData {
  return {
    ...state,
    meals: state.meals.map((meal) => ({
      ...meal,
      instructions: meal.instructions.map((step) =>
        step.id === stepId ? update(step) : step,
      ),
    })),
  };
}

function normalizePrepPositions(prep: PrepReference[]) {
  return [...prep]
    .sort((left, right) => left.position - right.position)
    .map((reference, position) => ({ ...reference, position }));
}

export function executeDomainCommand(
  state: PlannerData,
  command: DomainCommand,
  { now = Date.now }: { now?: () => number } = {},
): CommandResult {
  if (!isDomainCommand(command)) {
    return failure(state, "Malformed planner command.");
  }

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
          "Prep references kept their independently scheduled dates",
          "Linked leftover assignments moved with both meals",
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
      if (
        meal.title === command.changes.title &&
        meal.venue === command.changes.venue &&
        meal.notes === command.changes.notes
      ) {
        return failure(state, "Meal snapshot is unchanged.");
      }
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

    case "toggleInstructionStep": {
      const resolved = resolveInstructionStep(state, command.stepId);
      if (!resolved) return failure(state, "Instruction step not found.");
      const nextComplete = !resolved.step.complete;
      return success(
        updateInstructionStep(state, command.stepId, (step) => ({
          ...step,
          complete: nextComplete,
          timerStartedAt: nextComplete ? undefined : step.timerStartedAt,
        })),
        `${nextComplete ? "Completed" : "Reopened"} ${resolved.step.instruction}`,
        resolved.step.id,
        [`Complete: ${resolved.step.complete} to ${nextComplete}`],
      );
    }

    case "updateInstructionStepNote": {
      const resolved = resolveInstructionStep(state, command.stepId);
      if (!resolved) return failure(state, "Instruction step not found.");
      if ((resolved.step.note ?? "") === command.note) {
        return failure(state, "Step note is unchanged.");
      }
      return success(
        updateInstructionStep(state, command.stepId, (step) => ({
          ...step,
          note: command.note,
        })),
        `${command.note ? "Updated" : "Cleared"} step note`,
        resolved.step.id,
        [command.note ? `Note: ${command.note}` : "Note removed"],
      );
    }

    case "startInstructionTimer": {
      const resolved = resolveInstructionStep(state, command.stepId);
      if (!resolved) return failure(state, "Instruction step not found.");
      if (!resolved.step.timerDurationSeconds) {
        return failure(state, "This instruction step does not have a timer.");
      }
      if (resolved.step.complete) {
        return failure(state, "Reopen the instruction step before starting its timer.");
      }
      const startedAt = now();
      if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
        return failure(state, "Current time is invalid.");
      }
      return success(
        updateInstructionStep(state, command.stepId, (step) => ({
          ...step,
          timerStartedAt: startedAt,
        })),
        `Started ${resolved.step.timerDurationSeconds}-second timer`,
        resolved.step.id,
        ["Timer start saved so it continues across reloads"],
      );
    }

    case "resetInstructionTimer": {
      const resolved = resolveInstructionStep(state, command.stepId);
      if (!resolved) return failure(state, "Instruction step not found.");
      if (resolved.step.timerStartedAt === undefined) {
        return failure(state, "The timer is not running.");
      }
      return success(
        updateInstructionStep(state, command.stepId, (step) => ({
          ...step,
          timerStartedAt: undefined,
        })),
        "Reset instruction timer",
        resolved.step.id,
        ["Persisted timer start cleared"],
      );
    }

    case "setPrepPlan": {
      const missing = command.entries.find(
        (entry) => !resolveInstructionStep(state, entry.stepId),
      );
      if (missing) return failure(state, `Instruction step not found: ${missing.stepId}`);
      const currentPrep = [...state.prep].sort(
        (left, right) => left.position - right.position,
      );
      if (
        currentPrep.length === command.entries.length &&
        currentPrep.every(
          (reference, position) =>
            reference.stepId === command.entries[position].stepId &&
            reference.due === command.entries[position].due,
        )
      ) {
        return failure(state, "Prep plan is unchanged.");
      }
      const existing = new Map(state.prep.map((reference) => [reference.stepId, reference]));
      const prep = command.entries.map((entry, position) => ({
        id: existing.get(entry.stepId)?.id ?? `prep-${entry.stepId}`,
        stepId: entry.stepId,
        due: entry.due,
        position,
      }));
      return success(
        { ...state, prep },
        `Set prep plan with ${prep.length} steps`,
        "active-week-prep",
        ["Prep order follows the supplied step order", "Recipe instruction order was unchanged"],
      );
    }

    case "movePrepReference": {
      const ordered = normalizePrepPositions(state.prep);
      const currentPosition = ordered.findIndex(
        (reference) => reference.id === command.referenceId,
      );
      if (currentPosition < 0) return failure(state, "Prep reference not found.");
      if (command.targetPosition >= ordered.length) {
        return failure(state, "Prep position is outside the current plan.");
      }
      if (currentPosition === command.targetPosition) {
        return failure(state, "Prep reference is already in that position.");
      }
      const [moving] = ordered.splice(currentPosition, 1);
      ordered.splice(command.targetPosition, 0, moving);
      const prep = ordered.map((reference, position) => ({ ...reference, position }));
      return success(
        { ...state, prep },
        "Reordered prep step",
        moving.id,
        [`Position: ${currentPosition + 1} to ${command.targetPosition + 1}`],
      );
    }

    case "reschedulePrepReference": {
      const reference = state.prep.find((item) => item.id === command.referenceId);
      if (!reference) return failure(state, "Prep reference not found.");
      if (reference.due === command.due) return failure(state, "Prep date is unchanged.");
      return success(
        {
          ...state,
          prep: state.prep.map((item) =>
            item.id === command.referenceId ? { ...item, due: command.due } : item,
          ),
        },
        `Moved prep step to ${command.due}`,
        reference.id,
        [`Due: ${reference.due} to ${command.due}`],
      );
    }

    case "removePrepReference": {
      const reference = state.prep.find((item) => item.id === command.referenceId);
      if (!reference) return failure(state, "Prep reference not found.");
      return success(
        {
          ...state,
          prep: normalizePrepPositions(
            state.prep.filter((item) => item.id !== command.referenceId),
          ),
        },
        "Removed step from prep",
        reference.id,
        ["The recipe instruction and its completion state were preserved"],
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
      const meal = state.meals.find((item) => item.id === command.mealId);
      if (!meal) return failure(state, "Meal not found.");
      if (state.feedback[command.mealId] === command.value) {
        return failure(state, "Meal feedback is unchanged.");
      }
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
      if (leftover.quality === command.quality) {
        return failure(state, "Leftover quality is unchanged.");
      }
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
      if (leftover.state !== "available") {
        return failure(state, "Only available leftovers can be assigned.");
      }
      const destination = state.meals.find((meal) => meal.dayIndex === command.dayIndex);
      if (!destination) return failure(state, "Destination meal not found.");
      if (
        state.leftovers.some(
          (item) =>
            item.state === "assigned" && item.assignedDayIndex === command.dayIndex,
        )
      ) {
        return failure(state, "The destination day already has assigned leftovers.");
      }
      return success(
        {
          ...state,
          meals: state.meals.map((meal) =>
            meal.id === destination.id
              ? {
                  ...meal,
                  status: "leftover",
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
      if (leftover.state !== "assigned" || leftover.assignedDayIndex === undefined) {
        return failure(state, "Only assigned leftovers can be consumed.");
      }
      const destination = state.meals.find(
        (meal) => meal.dayIndex === leftover.assignedDayIndex,
      );
      if (!destination) return failure(state, "Destination meal not found.");
      return success(
        {
          ...state,
          meals: state.meals.map((meal) =>
            meal.dayIndex === leftover.assignedDayIndex ? { ...meal, status: "cooked" } : meal,
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

    default:
      return failure(state, "Unsupported planner command.");
  }
}
