"use client";

import { CheckCircle2, GripVertical, Plus, Trash2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type ComponentType, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from "react";

import type { HouseholdCommand } from "@/lib/household-command-contract";
import type { PreviewPlannerOperationsResponse } from "@/lib/planner-operation-contract";
import { isPrepSessionCombinedStep, type InstructionStep, type IsoDate, type Meal, type WeekPlan } from "@/lib/household-contract";
import { addIsoDateDays } from "@/lib/household-domain";
import { preparedInBatchStepIds, projectCombinedPrepDraft, projectCombinedPrepEntry } from "@/lib/prep-projection";
import { PlannerActionButton, PlannerIconButton } from "@/components/planner-ui/action-button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type PrepMutateOptions = { basePlannerVersion?: number; onAccepted?: (plannerVersion: number) => void };
export type PrepViewProps = {
  week: WeekPlan;
  disabled: boolean;
  mutate: (command: HouseholdCommand, options?: PrepMutateOptions) => Promise<boolean>;
  sendContextMessage: (message: string, onAccepted?: () => void) => Promise<boolean>;
  onOpenRecipeSummary: (id: string, trigger: HTMLElement) => void;
  // The existing direct-row control remains a shared client composition while this view owns Prep state.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  SessionStepRow: ComponentType<any>;
  formatCalendarDate: (value: string, options: Intl.DateTimeFormatOptions) => string;
  findStep: (week: WeekPlan, stepId: string) => { step: InstructionStep; meal: Meal; position: number } | null;
  stepControlTarget: (meal: Meal, step: InstructionStep, stepNumber: number) => string;
  plannerVersion: number;
  previewOperations: (request: { basePlannerVersion: number; operations: Array<{ command: HouseholdCommand }> }) => Promise<PreviewPlannerOperationsResponse>;
};
type PrepDragState =
  | { kind: "recipe"; stepIds: string[] }
  | { kind: "session"; sourcePrepDate: IsoDate; entryIds: string[] }
  | null;

type PrepPointerDrag = Exclude<PrepDragState, null> & { startX: number; startY: number };

type PrepDropInsertion = { prepDate: IsoDate; position: number } | null;

type PreviewedPrepAction = {
  kind: "combine" | "discard";
  command: HouseholdCommand;
  basePlannerVersion: number;
  onAccepted?: "close-combine" | "close-edit" | "close-delete";
};

function previewFailureMessage(decision: PreviewPlannerOperationsResponse["decision"]): string {
  if (decision.status === "domain_rejected") return decision.message;
  if (decision.status === "version_conflict") {
    return `Plan changed from version ${decision.expectedVersion} to ${decision.actualVersion}. Preview again.`;
  }
  return "Preview is ready.";
}

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

function prepStepControlTarget(meal: Meal, step: InstructionStep, stepNumber: number): string {
  const instruction = step.instruction.length > 90 ? `${step.instruction.slice(0, 87)}…` : step.instruction;
  return `step ${stepNumber} for ${meal.title}: ${instruction}`;
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
  onRecipeStepPointerDragStart,
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
  onRecipeStepPointerDragStart: (stepId: string, event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const selectedMeal = week.data.meals.find((meal) => meal.id === selectedMealId) ?? week.data.meals[0];
  const selectedCount = selectedMeal?.instructions.filter((step) => selectedStepIds.has(step.id)).length ?? 0;
  const assignedPrepStepIds = new Set(week.data.prepSessions.flatMap((session) =>
    session.steps.flatMap((entry) => isPrepSessionCombinedStep(entry)
      ? entry.sources.map((source) => source.stepId)
      : [entry.stepId]),
  ));
  return (
    <div className="prep-recipe-source" aria-label="Recipe instructions">
      <p className="eyebrow">Recipe instructions</p>
      <p className="prep-source-help">Choose a recipe, then drag its steps onto a prep date or into {targetSessionLabel ?? "the selected prep date"}. Use Other dates to add a date before you drag.</p>
      <ToggleGroup className="prep-recipe-picker" type="single" value={selectedMeal?.id} onValueChange={(mealId) => { if (mealId) onSelectMeal(mealId); }} aria-label="Recipes">
        {week.data.meals.map((meal) => {
          const unassignedCount = meal.instructions.filter((step) => !step.complete && !assignedPrepStepIds.has(step.id)).length;
          return <ToggleGroupItem key={meal.id} value={meal.id}><span>{meal.title}</span>{unassignedCount ? <small>{unassignedCount} to prep</small> : null}</ToggleGroupItem>;
        })}
      </ToggleGroup>
      {selectedMeal ? <div className="prep-recipe-steps">
        <strong>{selectedMeal.title}</strong>
        {selectedCount ? <p className="prep-source-selection-summary"><strong>{selectedCount} selected</strong><span>Drag any selected instruction onto a prep date.</span></p> : null}
        {selectedMeal.instructions.map((step, index) => {
          const assigned = assignedPrepStepIds.has(step.id);
          return <button
          key={step.id}
          className={`prep-source-step ${step.complete ? "complete" : ""} ${assigned ? "assigned" : "unassigned"} ${selectedStepIds.has(step.id) ? "selected" : ""}`}
          type="button"
          disabled={disabled || assigned}
          draggable={!disabled && !assigned}
          aria-pressed={selectedStepIds.has(step.id)}
          aria-label={`Drag ${prepStepControlTarget(selectedMeal, step, index + 1)} onto a prep date${assigned ? "; already assigned to prep" : "; not assigned to prep"}`}
          onClick={(event) => { if (!assigned) onSelectStep(step.id, event); }}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            onRecipeStepPointerDragStart(step.id, event);
          }}
          onDragStart={(event) => {
            const stepIds = onRecipeStepDragStart(step.id);
            event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData("application/x-prep-recipe-step", step.id);
            event.dataTransfer.setData("application/x-prep-recipe-steps", JSON.stringify(stepIds));
          }}
          onDragEnd={onRecipeStepDragEnd}
        ><GripVertical size={14} /><span>{step.instruction}</span><small>{assigned ? "Assigned" : "To prep"}</small></button>;
        })}
      </div> : null}
    </div>
  );
}

export function PrepView(props: PrepViewProps) {
  const { SessionStepRow, formatCalendarDate, findStep } = props;
  const { week, disabled, mutate, sendContextMessage, onOpenRecipeSummary } = props;
  const [selectedMealId, setSelectedMealId] = useState(week.data.meals[0]?.id ?? "");
  const [selectedPrepDate, setSelectedPrepDate] = useState<IsoDate>(() => [...week.data.prepSessions].map((session) => session.prepDate).sort()[0] ?? week.id);
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(() => new Set());
  const [entrySelectionAnchorId, setEntrySelectionAnchorId] = useState<string | null>(null);
  const [selectedSourceStepIds, setSelectedSourceStepIds] = useState<Set<string>>(() => new Set());
  const [sourceSelectionAnchorId, setSourceSelectionAnchorId] = useState<string | null>(null);
  const [moveTargetPrepDate, setMoveTargetPrepDate] = useState("");
  const [dragState, setDragState] = useState<PrepDragState>(null);
  const [dropTargetPrepDate, setDropTargetPrepDate] = useState<IsoDate | null>(null);
  const [dropInsertion, setDropInsertion] = useState<PrepDropInsertion>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [prepDeleteDialogOpen, setPrepDeleteDialogOpen] = useState(false);
  const [combineOpen, setCombineOpen] = useState(false);
  const [combinedInstruction, setCombinedInstruction] = useState("");
  const [previewAction, setPreviewAction] = useState<PreviewedPrepAction | null>(null);
  const [previewDecision, setPreviewDecision] = useState<PreviewPlannerOperationsResponse["decision"] | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [editEntryId, setEditEntryId] = useState<string | null>(null);
  const sourceRestoreRef = useRef<HTMLButtonElement>(null);
  const sourceDialogRef = useRef<HTMLElement>(null);
  const previewRequestRef = useRef(0);
  const pointerDragRef = useRef<PrepPointerDrag | null>(null);
  const pointerDragActiveRef = useRef(false);
  const prepWeekEnd = addIsoDateDays(week.id, 6);
  const prepTimelineDates = Array.from(new Set([...week.data.prepSessions.map((session) => session.prepDate), selectedPrepDate])).sort() as IsoDate[];
  const selectedMeal = week.data.meals.find((meal) => meal.id === selectedMealId) ?? week.data.meals[0] ?? null;
  const sessionEntries = week.data.prepSessions.flatMap((session) => session.steps);
  const completedEntries = sessionEntries.filter((entry) => isPrepSessionCombinedStep(entry) ? entry.complete : findStep(week, entry.stepId)?.step.complete).length;
  const selectedSourceStepIdsInOrder = selectedMeal?.instructions.filter((step) => selectedSourceStepIds.has(step.id)).map((step) => step.id) ?? [];
  const prepSessionsByDay = new Map<string, typeof week.data.prepSessions>();
  week.data.prepSessions.forEach((session) => {
    prepSessionsByDay.set(session.prepDate, [...(prepSessionsByDay.get(session.prepDate) ?? []), session]);
  });
  const selectedSessions = prepSessionsByDay.get(selectedPrepDate) ?? [];
  const selectedSession = selectedSessions[0] ?? null;
  const selectedSessionDateLabel = formatCalendarDate(selectedPrepDate, { weekday: "short", month: "short", day: "numeric" });
  const selectedEntryIdsInOrder = selectedSession?.steps.filter((entry) => selectedEntryIds.has(entry.id)).map((entry) => entry.id) ?? [];
  const selectedDirectSourceStepIds = selectedSession?.steps
    .filter((entry): entry is Extract<typeof entry, { stepId: string }> => selectedEntryIds.has(entry.id) && "stepId" in entry)
    .map((entry) => entry.stepId) ?? [];
  const projectionState = { householdTimeZone: "UTC", activeWeekId: week.id, weeks: [week] };
  const preparedStepIds = preparedInBatchStepIds(projectionState);
  const combinePreview = projectCombinedPrepDraft(projectionState, selectedDirectSourceStepIds);
  const selectedSessionDropPosition = dropInsertion && dropInsertion.prepDate === selectedPrepDate
    ? dropInsertion.position
    : null;
  const canMoveSelectedEntries = Boolean(
    selectedSession &&
    moveTargetPrepDate &&
    moveTargetPrepDate !== selectedPrepDate &&
    selectedEntryIdsInOrder.length,
  );
  const clearEntrySelection = () => {
    setSelectedEntryIds(new Set());
    setEntrySelectionAnchorId(null);
    setMoveTargetPrepDate("");
  };
  const clearSourceSelection = () => {
    setSelectedSourceStepIds(new Set());
    setSourceSelectionAnchorId(null);
  };
  const invalidatePreview = () => {
    previewRequestRef.current += 1;
    setPreviewAction(null);
    setPreviewDecision(null);
    setPreviewPending(false);
  };
  const closeSourceDialog = () => {
    setSourceOpen(false);
    requestAnimationFrame(() => sourceRestoreRef.current?.focus());
  };
  const showPrepDate = (prepDate: IsoDate) => {
    setSelectedPrepDate(prepDate);
  };
  const endDrag = () => {
    pointerDragRef.current = null;
    pointerDragActiveRef.current = false;
    setDragState(null);
    setDropTargetPrepDate(null);
    setDropInsertion(null);
    if (typeof document !== "undefined") document.body.classList.remove("recipe-step-dragging");
  };
  useEffect(() => () => {
    if (typeof document !== "undefined") document.body.classList.remove("recipe-step-dragging");
  }, []);
  useEffect(() => {
    if (!sourceOpen) return;
    sourceDialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSourceDialog();
        return;
      }
      if (event.key === "Tab") {
        const dialog = sourceDialogRef.current;
        if (!dialog) return;
        const focusable = [...dialog.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
        )].filter((element) => element.getAttribute("aria-hidden") !== "true");
        if (!focusable.length) {
          event.preventDefault();
          dialog.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !dialog.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sourceOpen]);
  const toggleSessionEntry = (entryId: string, selected: boolean) => {
    setSelectedEntryIds((current) => {
      const next = new Set(current);
      if (selected) next.add(entryId);
      else next.delete(entryId);
      return next;
    });
    setEntrySelectionAnchorId(entryId);
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
      if (!additive) {
        const next = new Set(current);
        if (next.has(stepId)) next.delete(stepId);
        else next.add(stepId);
        return next;
      }
      const next = new Set(current);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
    setSourceSelectionAnchorId(stepId);
  };
  const addStepsToDate = (prepDate: IsoDate, stepIds: string[], targetPosition: number) => {
    if (!stepIds.length) return;
    void mutate(
      { type: "addPrepStepsToDate", weekId: week.id, prepDate, stepIds, targetPosition },
      { onAccepted: () => { clearSourceSelection(); showPrepDate(prepDate); } },
    );
  };
  const moveEntriesToDate = (sourcePrepDate: IsoDate, prepDate: IsoDate, entryIds: string[], targetPosition: number) => {
    const source = week.data.prepSessions.find((candidate) => candidate.prepDate === sourcePrepDate);
    if (!source || !entryIds.length) return;
    void mutate(
      { type: "movePrepStepsToDate", weekId: week.id, sourcePrepDate, prepDate, entryIds, targetPosition },
      {
        onAccepted: () => {
          clearEntrySelection();
          showPrepDate(prepDate);
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
    if (!selectedSession || !moveTargetPrepDate || !canMoveSelectedEntries) return;
    const targetSession = prepSessionsByDay.get(moveTargetPrepDate)?.[0];
    moveEntriesToDate(selectedPrepDate, moveTargetPrepDate as IsoDate, selectedEntryIdsInOrder, targetSession?.steps.length ?? 0);
  };
  const runPreview = (action: PreviewedPrepAction) => {
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    setPreviewAction(action);
    setPreviewDecision(null);
    setPreviewPending(true);
    void props.previewOperations({ basePlannerVersion: action.basePlannerVersion, operations: [{ command: action.command }] })
      .then((response) => {
        if (previewRequestRef.current === requestId) setPreviewDecision(response.decision);
      })
      .catch((error: unknown) => {
        if (previewRequestRef.current === requestId) {
          setPreviewDecision({ status: "domain_rejected", operationIndex: 0, message: error instanceof Error ? error.message : "Preview failed." });
        }
      })
      .finally(() => {
        if (previewRequestRef.current === requestId) setPreviewPending(false);
      });
  };
  const previewDiscard = (command: HouseholdCommand, onAccepted?: PreviewedPrepAction["onAccepted"]) => {
    runPreview({ kind: "discard", command, basePlannerVersion: props.plannerVersion, onAccepted });
  };
  const confirmRemoveSelectedSession = () => {
    if (!selectedSession) return;
    const command: HouseholdCommand = {
      type: "clearPrepDate",
      weekId: week.id,
      prepDate: selectedPrepDate,
      ...(selectedSession.steps.some((entry) => isPrepSessionCombinedStep(entry) && entry.complete) ? { discardFulfillment: true } : {}),
    };
    if ("discardFulfillment" in command) {
      setPrepDeleteDialogOpen(false);
      previewDiscard(command, "close-delete");
    } else {
      setPrepDeleteDialogOpen(false);
      clearEntrySelection();
      void mutate(command);
    }
  };
  const openCombine = () => {
    if (selectedDirectSourceStepIds.length < 2 || selectedDirectSourceStepIds.length > 16) return;
    setCombinedInstruction(combinePreview.aggregates.map((aggregate) => `Prepare ${aggregate.display}`).join("; ") || "Prepare selected ingredients");
    invalidatePreview();
    setCombineOpen(true);
  };
  const previewCombine = () => {
    if (!selectedSession || !combinedInstruction.trim()) return;
    const command: HouseholdCommand = { type: "combinePrepStepsOnDate", weekId: week.id, prepDate: selectedPrepDate, sourceStepIds: selectedDirectSourceStepIds, instruction: combinedInstruction.trim(), targetPosition: selectedSession.steps.length };
    runPreview({ kind: "combine", command, basePlannerVersion: props.plannerVersion, onAccepted: "close-combine" });
  };
  const applyPreviewedAction = () => {
    if (!previewAction || previewDecision?.status !== "previewed" || previewDecision.plannerVersion !== previewAction.basePlannerVersion || props.plannerVersion !== previewAction.basePlannerVersion) return;
    const action = previewAction;
    void mutate(action.command, {
      basePlannerVersion: action.basePlannerVersion,
      onAccepted: () => {
        if (action.onAccepted === "close-combine") {
          clearEntrySelection();
          setCombineOpen(false);
        } else if (action.onAccepted === "close-edit") {
          setEditEntryId(null);
        } else if (action.onAccepted === "close-delete") {
          clearEntrySelection();
        }
        invalidatePreview();
      },
    });
  };
  const reorderEntry = (entryId: string, index: number, direction: -1 | 1) => {
    if (!selectedSession) return;
    const targetPosition = direction < 0 ? index - 1 : index + 2;
    moveEntriesToDate(selectedPrepDate, selectedPrepDate, [entryId], targetPosition);
  };
  const dragHasRecipeSteps = (event: ReactDragEvent<HTMLElement>) =>
    !disabled && (dragState?.kind === "recipe" || Array.from(event.dataTransfer.types).includes("application/x-prep-recipe-step"));
  const dragHasSessionEntries = (event: ReactDragEvent<HTMLElement>) =>
    !disabled && (dragState?.kind === "session" || Array.from(event.dataTransfer.types).includes("application/x-prep-date-entries"));
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
      : { kind: "session" as const, sourcePrepDate: selectedPrepDate, entryIds: parsePrepDragIds(event.dataTransfer.getData("application/x-prep-date-entries")) };
  const applyPrepDrop = (drag: Exclude<PrepDragState, null>, prepDate: IsoDate, targetPosition: number) => {
    if (drag.kind === "recipe") addStepsToDate(prepDate, drag.stepIds, targetPosition);
    else moveEntriesToDate(drag.sourcePrepDate, prepDate, drag.entryIds, targetPosition);
    showPrepDate(prepDate);
    endDrag();
  };
  const receivePrepDrop = (event: ReactDragEvent<HTMLElement>, prepDate: IsoDate, targetPosition: number) => {
    if (!isPrepDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const drag = dragHasRecipeSteps(event)
      ? { kind: "recipe" as const, stepIds: dragRecipeStepIds(event) }
      : dragSessionEntries(event);
    if (drag.kind === "recipe" ? drag.stepIds.length : drag.entryIds.length) {
      applyPrepDrop(drag, prepDate, targetPosition);
    } else {
      endDrag();
    }
  };
  const startRecipeStepDrag = (stepId: string) => {
    const stepIds = selectedSourceStepIds.has(stepId) && selectedSourceStepIdsInOrder.length ? selectedSourceStepIdsInOrder : [stepId];
    setDragState({ kind: "recipe", stepIds });
    if (typeof document !== "undefined") document.body.classList.add("recipe-step-dragging");
    return stepIds;
  };
  const startSessionDrag = (entryIds: string[]) => {
    if (!selectedSession) return;
    setDragState({ kind: "session", sourcePrepDate: selectedPrepDate, entryIds });
  };
  const beginPointerDrag = (drag: Exclude<PrepDragState, null>, event: ReactMouseEvent<HTMLElement>) => {
    pointerDragRef.current = { ...drag, startX: event.clientX, startY: event.clientY };
    pointerDragActiveRef.current = false;
  };
  const pointerDropTarget = (clientX: number, clientY: number) => {
    const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const dateTarget = target?.closest<HTMLElement>("[data-prep-date]");
    const prepDate = dateTarget?.dataset.prepDate as IsoDate | undefined;
    if (!prepDate) return null;
    const rowTarget = target?.closest<HTMLElement>("[data-prep-queue-position]");
    if (!rowTarget || rowTarget.dataset.prepQueueDate !== selectedPrepDate) {
      return { prepDate, targetPosition: prepSessionsByDay.get(prepDate)?.[0]?.steps.length ?? 0 };
    }
    const bounds = rowTarget.getBoundingClientRect();
    const position = Number(rowTarget.dataset.prepQueuePosition) + (clientY < bounds.top + bounds.height / 2 ? 0 : 1);
    return { prepDate, targetPosition: position };
  };
  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const pending = pointerDragRef.current;
      if (!pending) return;
      if (!pointerDragActiveRef.current) {
        const distance = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
        if (distance < 6) return;
        pointerDragActiveRef.current = true;
        setDragState(pending.kind === "recipe" ? { kind: "recipe", stepIds: pending.stepIds } : { kind: "session", sourcePrepDate: pending.sourcePrepDate, entryIds: pending.entryIds });
        document.body.classList.add("recipe-step-dragging");
      }
      const target = pointerDropTarget(event.clientX, event.clientY);
      setDropTargetPrepDate(target?.prepDate ?? null);
      if (target && pending.kind === "session" && target.prepDate === selectedPrepDate && selectedSession) {
        setDropInsertion({ prepDate: selectedPrepDate, position: target.targetPosition });
      } else {
        setDropInsertion(null);
      }
    };
    const onMouseUp = (event: MouseEvent) => {
      const pending = pointerDragRef.current;
      const active = pointerDragActiveRef.current;
      if (!pending || !active) {
        pointerDragRef.current = null;
        return;
      }
      const target = pointerDropTarget(event.clientX, event.clientY);
      if (target) applyPrepDrop(pending, target.prepDate, target.targetPosition);
      else endDrag();
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  });
  const changePrepDate = (prepDate: IsoDate) => {
    clearEntrySelection();
    showPrepDate(prepDate);
  };
  return (
    <div className="list-surface">
      <div className="surface-summary">
        <div><p className="eyebrow">Active-week batch work</p><h2>Prep dates</h2></div>
        <div className="surface-summary-actions">
          <span className="summary-chip"><CheckCircle2 size={14} /> {completedEntries}/{sessionEntries.length} done</span>
        </div>
      </div>
      <div className="prep-session-workspace">
        <div className="prep-session-list">
          <div className="prep-session-tabs">
            <div className="prep-session-tab-navigation">
              <div className="prep-session-tablist" role="tablist" aria-label="Prep dates">
                {prepTimelineDates.map((prepDate) => {
                  const sessions = prepSessionsByDay.get(prepDate) ?? [];
                  const stepCount = sessions.reduce((count, session) => count + session.steps.length, 0);
                  const selected = prepDate === selectedPrepDate;
                  const dateLabel = formatCalendarDate(prepDate, { weekday: "short", month: "short", day: "numeric" });
                  return <button
                    key={prepDate}
                    id={`prep-date-tab-${prepDate}`}
                    className={`prep-session-tab${selected ? " active" : ""}${stepCount ? " has-prep" : ""}${dropTargetPrepDate === prepDate ? " drop-target" : ""}`}
                    type="button"
                    role="tab"
                    data-prep-date={prepDate}
                    aria-label={stepCount ? `Open ${stepCount} prep ${stepCount === 1 ? "step" : "steps"} on ${dateLabel}` : `Open empty prep date ${dateLabel}`}
                    aria-selected={selected}
                    aria-controls={`prep-date-panel-${prepDate}`}
                    onClick={() => changePrepDate(prepDate)}
                    onDragEnter={(event) => {
                      if (isPrepDrag(event)) setDropTargetPrepDate(prepDate);
                    }}
                    onDragOver={(event) => {
                      if (!isPrepDrag(event)) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = dragHasRecipeSteps(event) ? "copy" : "move";
                      setDropTargetPrepDate(prepDate);
                    }}
                    onDrop={(event) => receivePrepDrop(event, prepDate, sessions[0]?.steps.length ?? 0)}
                  ><span>{dateLabel}</span>{stepCount ? <strong>{stepCount}</strong> : null}</button>;
                })}
              </div>
            </div>
            <div className="prep-session-actions">
              <details className="prep-date-tools">
                <summary className="prep-session-control">Other dates</summary>
                <div>
                  <label className="prep-date-jump"><span className="sr-only">Jump to prep date</span><input aria-label="Jump to prep date" type="date" max={prepWeekEnd} value={selectedPrepDate} onChange={(event) => {
                    const nextDate = event.target.value as IsoDate;
                    if (!nextDate || nextDate > prepWeekEnd) return;
                    showPrepDate(nextDate);
                  }} /></label>
                </div>
              </details>
              <PlannerActionButton ref={sourceRestoreRef} className="prep-session-control prep-session-add-steps" tone="secondary" type="button" disabled={disabled || !week.data.meals.length} title={`Add recipe steps to ${selectedSessionDateLabel}`} aria-label={`Add recipe steps to ${selectedSessionDateLabel}`} onClick={() => setSourceOpen(true)}><Plus size={15} /> Add steps</PlannerActionButton>
              {!disabled && selectedSession ? <PlannerIconButton className="prep-session-tab-delete" tone="attention" type="button" title={`Delete ${selectedSessionDateLabel} prep`} aria-label={`Delete ${selectedSessionDateLabel} prep`} onClick={() => setPrepDeleteDialogOpen(true)}><Trash2 size={15} /></PlannerIconButton> : null}
            </div>
          </div>
          <div className="prep-list-selection-header">
            {selectedSession?.steps.length ? <label className="prep-select-all"><input type="checkbox" checked={selectedEntryIdsInOrder.length === selectedSession.steps.length} disabled={disabled} onChange={(event) => event.target.checked ? selectAllSessionEntries() : clearEntrySelection()} /> Select all</label> : null}
            {selectedEntryIdsInOrder.length ? <div className="prep-selection-toolbar" role="status"><strong>{selectedEntryIdsInOrder.length} selected</strong><PlannerActionButton tone="secondary" type="button" disabled={disabled || selectedDirectSourceStepIds.length < 2 || selectedDirectSourceStepIds.length > 16} onClick={openCombine}>Combine selected</PlannerActionButton><input className="prep-selection-move-target" aria-label="Move selected prep steps to" type="date" max={prepWeekEnd} value={moveTargetPrepDate} onChange={(event) => setMoveTargetPrepDate(event.target.value)} /><PlannerActionButton className="prep-selection-move" tone="secondary" type="button" disabled={disabled || !canMoveSelectedEntries} aria-label="Move selected prep steps" onClick={moveSelectedEntries}>Move</PlannerActionButton></div> : null}
          </div>
          <section
            id={`prep-date-panel-${selectedPrepDate}`}
            className={`prep-session${dropTargetPrepDate === selectedPrepDate ? " drop-target" : ""}`}
            role="tabpanel"
            aria-labelledby={`prep-date-tab-${selectedPrepDate}`}
            onDragOver={(event) => {
              if (!isPrepDrag(event)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = dragHasRecipeSteps(event) ? "copy" : "move";
              setDropTargetPrepDate(selectedPrepDate);
              if (selectedSession) setDropInsertion({ prepDate: selectedPrepDate, position: selectedSession.steps.length });
            }}
            onDrop={(event) => receivePrepDrop(event, selectedPrepDate, selectedSession?.steps.length ?? 0)}
          >
            <div className="prep-step-list">
              {selectedSession?.steps.map((entry, index) => {
                if (isPrepSessionCombinedStep(entry)) {
                  const projection = projectCombinedPrepEntry(projectionState, entry);
                  const editing = editEntryId === entry.id;
                  const selected = selectedEntryIds.has(entry.id);
                  const draggedEntryIds = selected ? selectedEntryIdsInOrder : [entry.id];
                  return <article key={entry.id} className={`instruction-step prep-queue-step${entry.complete ? " complete" : ""}${selected ? " selected" : ""}`} data-testid="prep-combined-step" data-prep-date={selectedPrepDate} data-prep-queue-date={selectedPrepDate} data-prep-queue-position={index} draggable={!disabled} onMouseDown={(event) => { if (event.button !== 0 || isPrepRowControlTarget(event.target)) return; beginPointerDrag({ kind: "session", sourcePrepDate: selectedPrepDate, entryIds: draggedEntryIds }, event); selectSessionEntry(entry.id, event); }} onDragStart={(event) => { if (disabled || isPrepRowControlTarget(event.target)) return; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-prep-date-entries", JSON.stringify(draggedEntryIds)); startSessionDrag(draggedEntryIds); }} onDragEnd={endDrag} onDragOver={(event) => { if (!isPrepDrag(event)) return; event.preventDefault(); setDropTargetPrepDate(selectedPrepDate); setDropInsertion({ prepDate: selectedPrepDate, position: event.clientY < event.currentTarget.getBoundingClientRect().top + event.currentTarget.getBoundingClientRect().height / 2 ? index : index + 1 }); }} onDrop={(event) => receivePrepDrop(event, selectedPrepDate, event.clientY < event.currentTarget.getBoundingClientRect().top + event.currentTarget.getBoundingClientRect().height / 2 ? index : index + 1)}>
                    <div className="prep-queue-access-controls" data-prep-row-control><label><input type="checkbox" checked={selected} disabled={disabled} aria-label={`Select combined prep batch ${entry.instruction}`} onChange={(event) => toggleSessionEntry(entry.id, event.target.checked)} /> Select</label><PlannerActionButton tone="secondary" type="button" disabled={disabled || index === 0} aria-label={`Move combined prep batch ${entry.instruction} up`} onClick={() => reorderEntry(entry.id, index, -1)}>Up</PlannerActionButton><PlannerActionButton tone="secondary" type="button" disabled={disabled || index === selectedSession.steps.length - 1} aria-label={`Move combined prep batch ${entry.instruction} down`} onClick={() => reorderEntry(entry.id, index, 1)}>Down</PlannerActionButton></div>
                    <div className="instruction-line-main prep-queue-main"><label className="instruction-line-checkbox"><input type="checkbox" checked={entry.complete} disabled={disabled || entry.needsReview} aria-label={`${entry.complete ? "Reopen" : "Complete"} combined prep batch`} onChange={(event) => void mutate({ type: "setCombinedPrepStepComplete", weekId: week.id, entryId: entry.id, complete: event.target.checked })} /></label><div><strong>{entry.instruction}</strong><p>{entry.needsReview ? "Needs review — source instructions changed." : entry.complete ? "Prepared in batch" : "Batch prep"}</p>{projection.aggregates.map((aggregate) => <p key={aggregate.key}>{aggregate.display}</p>)}{projection.sources.map((source) => <small key={source.stepId}>{source.mealTitle}: {source.instruction}</small>)}</div></div>
                    {editing ? <div className="instruction-inline-comment"><textarea aria-label="Combined prep instruction" value={combinedInstruction} onChange={(event) => setCombinedInstruction(event.target.value)} /><div className="step-comment-actions"><PlannerActionButton tone="secondary" type="button" onClick={() => setEditEntryId(null)}>Cancel</PlannerActionButton><PlannerActionButton tone="secondary" type="button" disabled={disabled || !combinedInstruction.trim()} onClick={() => entry.complete ? previewDiscard({ type: "updateCombinedPrepStep", weekId: week.id, entryId: entry.id, instruction: combinedInstruction.trim(), discardFulfillment: true }, "close-edit") : void mutate({ type: "updateCombinedPrepStep", weekId: week.id, entryId: entry.id, instruction: combinedInstruction.trim() }, { onAccepted: () => setEditEntryId(null) })}>Save batch</PlannerActionButton></div></div> : <div className="instruction-line-actions"><PlannerActionButton tone="secondary" type="button" disabled={disabled} onClick={() => { setCombinedInstruction(entry.instruction); setEditEntryId(entry.id); }}>Edit</PlannerActionButton><PlannerActionButton tone="secondary" type="button" disabled={disabled} onClick={() => entry.complete ? previewDiscard({ type: "expandCombinedPrepStep", weekId: week.id, entryId: entry.id, discardFulfillment: true }) : void mutate({ type: "expandCombinedPrepStep", weekId: week.id, entryId: entry.id, discardFulfillment: false })}>Expand</PlannerActionButton><PlannerActionButton tone="attention" type="button" disabled={disabled} onClick={() => entry.complete ? previewDiscard({ type: "removePrepStepsFromDate", weekId: week.id, prepDate: selectedPrepDate, entryIds: [entry.id], discardFulfillment: true }) : void mutate({ type: "removePrepStepsFromDate", weekId: week.id, prepDate: selectedPrepDate, entryIds: [entry.id] })}>Remove</PlannerActionButton></div>}
                  </article>;
                }
                const resolved = findStep(week, entry.stepId);
                if (!resolved) return null;
                return <div key={entry.id} className="prep-queue-row-wrap" data-prep-date={selectedPrepDate} data-prep-queue-date={selectedPrepDate} data-prep-queue-position={index}>
                  {selectedSessionDropPosition === index ? <div className="prep-insertion-indicator" role="presentation" /> : null}
                  <div className="prep-queue-access-controls" data-prep-row-control><label><input type="checkbox" checked={selectedEntryIds.has(entry.id)} disabled={disabled} aria-label={`Select prep instruction ${resolved.step.instruction}`} onChange={(event) => toggleSessionEntry(entry.id, event.target.checked)} /> Select</label><PlannerActionButton tone="secondary" type="button" disabled={disabled || index === 0} aria-label={`Move prep instruction ${resolved.step.instruction} up`} onClick={() => reorderEntry(entry.id, index, -1)}>Up</PlannerActionButton><PlannerActionButton tone="secondary" type="button" disabled={disabled || index === selectedSession.steps.length - 1} aria-label={`Move prep instruction ${resolved.step.instruction} down`} onClick={() => reorderEntry(entry.id, index, 1)}>Down</PlannerActionButton></div>
                  <SessionStepRow
                    entry={entry}
                    prepDate={selectedPrepDate}
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
                    onPointerDragStart={(entryIds: string[], event: ReactMouseEvent<HTMLElement>) => beginPointerDrag({ kind: "session", sourcePrepDate: selectedPrepDate, entryIds }, event)}
                    onDragOver={(event: ReactDragEvent<HTMLElement>, targetPosition: number) => {
                      if (!isPrepDrag(event)) return;
                      event.preventDefault();
                      event.stopPropagation();
                      event.dataTransfer.dropEffect = dragHasRecipeSteps(event) ? "copy" : "move";
                      setDropTargetPrepDate(selectedPrepDate);
                      setDropInsertion({ prepDate: selectedPrepDate, position: targetPosition });
                    }}
                    onDrop={(event: ReactDragEvent<HTMLElement>, targetPosition: number) => receivePrepDrop(event, selectedPrepDate, targetPosition)}
                  />
                  {preparedStepIds.has(entry.stepId) ? <span className="summary-chip">Prepared in batch</span> : null}
                </div>;
              })}
              {selectedSession && selectedSessionDropPosition === selectedSession.steps.length ? <div className="prep-insertion-indicator" role="presentation" /> : null}
              {!selectedSession?.steps.length ? <p className="empty-copy">Drag recipe instructions onto {selectedSessionDateLabel}.</p> : null}
            </div>
          </section>
        </div>
      </div>
      {sourceOpen && typeof document !== "undefined" ? createPortal(<div className="prep-source-backdrop" onMouseDown={closeSourceDialog}>
        <aside ref={sourceDialogRef} className="prep-source-window" role="dialog" aria-modal="true" aria-label="Recipe instructions" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <header className="prep-source-window-heading">
          <div><p className="eyebrow">Batch prep</p><h3>Recipe instructions</h3></div>
          <PlannerIconButton type="button" title="Close recipe steps" aria-label="Close recipe steps" onClick={closeSourceDialog}><X size={16} /></PlannerIconButton>
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
          onRecipeStepPointerDragStart={(stepId, event) => {
            const stepIds = selectedSourceStepIds.has(stepId) && selectedSourceStepIdsInOrder.length ? selectedSourceStepIdsInOrder : [stepId];
            beginPointerDrag({ kind: "recipe", stepIds }, event);
          }}
        />
        {selectedSourceStepIdsInOrder.length ? <div className="prep-source-window-actions">
          <PlannerActionButton
            tone="primary"
            type="button"
            disabled={disabled}
            aria-label={`Add selected recipe steps to ${selectedSessionDateLabel}`}
            onClick={() => {
              addStepsToDate(selectedPrepDate, selectedSourceStepIdsInOrder, selectedSession?.steps.length ?? 0);
              closeSourceDialog();
            }}
          >Add {selectedSourceStepIdsInOrder.length} selected</PlannerActionButton>
        </div> : null}
        </aside>
      </div>, document.body) : null}
      <Dialog open={prepDeleteDialogOpen} onOpenChange={setPrepDeleteDialogOpen}>
        <DialogContent showCloseButton={false} aria-label={`Delete ${selectedSessionDateLabel} prep`}>
          <DialogHeader>
            <DialogTitle>Delete prep for {selectedSessionDateLabel}?</DialogTitle>
            <DialogDescription>This removes the {selectedSession?.steps.length ?? 0} assigned prep {selectedSession?.steps.length === 1 ? "step" : "steps"} from this date. Recipe instructions are not deleted.{selectedSession?.steps.some((entry) => isPrepSessionCombinedStep(entry) && entry.complete) ? " Completed batch fulfillment will be discarded." : ""}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <PlannerActionButton tone="secondary" type="button" onClick={() => setPrepDeleteDialogOpen(false)}>Cancel</PlannerActionButton>
            <PlannerActionButton tone="attention" type="button" onClick={confirmRemoveSelectedSession}>Delete prep date</PlannerActionButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={combineOpen} onOpenChange={(open) => { setCombineOpen(open); if (!open) invalidatePreview(); }}>
        <DialogContent aria-label="Combine selected prep instructions">
          <DialogHeader><DialogTitle>Combine selected instructions</DialogTitle><DialogDescription>Review the conservative ingredient preview, then author the batch wording.</DialogDescription></DialogHeader>
          <div className="instruction-inline-comment"><textarea aria-label="Combined prep instruction" value={combinedInstruction} onChange={(event) => { setCombinedInstruction(event.target.value); invalidatePreview(); }} />{combinePreview.aggregates.map((aggregate) => <p key={aggregate.key}>{aggregate.display}</p>)}{combinePreview.sources.map((source) => <small key={source.stepId}>{source.mealTitle}: {source.instruction}</small>)}{previewAction?.kind === "combine" && previewDecision?.status === "previewed" ? <div role="status"><strong>Preview ready</strong>{previewDecision.outcomes.map((outcome) => <div key={outcome.operationIndex}><p>{outcome.summary}</p><p>Target: {outcome.target}</p><ul>{outcome.changes.map((change) => <li key={change}>{change}</li>)}</ul></div>)}</div> : previewAction?.kind === "combine" && previewDecision ? <p role="alert">{previewFailureMessage(previewDecision)}</p> : null}</div>
          <DialogFooter><PlannerActionButton tone="secondary" type="button" onClick={() => { setCombineOpen(false); invalidatePreview(); }}>Cancel</PlannerActionButton><PlannerActionButton tone="secondary" type="button" disabled={disabled || previewPending || !combinedInstruction.trim()} onClick={previewCombine}>{previewPending && previewAction?.kind === "combine" ? "Previewing…" : "Preview"}</PlannerActionButton><PlannerActionButton tone="primary" type="button" disabled={disabled || previewAction?.kind !== "combine" || previewDecision?.status !== "previewed" || previewDecision.plannerVersion !== previewAction.basePlannerVersion || previewAction.basePlannerVersion !== props.plannerVersion} onClick={applyPreviewedAction}>Apply combined batch</PlannerActionButton></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={previewAction?.kind === "discard"} onOpenChange={(open) => { if (!open) invalidatePreview(); }}>
        <DialogContent aria-label="Discard prepared batch fulfillment"><DialogHeader><DialogTitle>Discard prepared batch?</DialogTitle><DialogDescription>This changes only the batch fulfillment record; canonical recipe completion remains unchanged. Review every authoritative effect before continuing.</DialogDescription></DialogHeader>{previewPending ? <p role="status">Previewing authoritative changes…</p> : previewDecision?.status === "previewed" ? <div role="status"><strong>Preview ready</strong>{previewDecision.outcomes.map((outcome) => <div key={outcome.operationIndex}><p>{outcome.summary}</p><p>Target: {outcome.target}</p><ul>{outcome.changes.map((change) => <li key={change}>{change}</li>)}</ul></div>)}</div> : previewDecision ? <p role="alert">{previewFailureMessage(previewDecision)}</p> : null}<DialogFooter><PlannerActionButton tone="secondary" type="button" onClick={invalidatePreview}>Cancel</PlannerActionButton><PlannerActionButton tone="attention" type="button" disabled={disabled || previewDecision?.status !== "previewed" || previewAction?.basePlannerVersion !== props.plannerVersion} onClick={applyPreviewedAction}>Discard and continue</PlannerActionButton></DialogFooter></DialogContent>
      </Dialog>
    </div>
  );
}
