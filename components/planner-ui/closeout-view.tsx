"use client";

import { Archive, Check, CheckCircle2, StickyNote } from "lucide-react";
import { useState } from "react";

import { MAX_COMMAND_TEXT_LENGTH, type HouseholdCommand } from "@/lib/household-command-contract";
import { FEEDBACK_VALUES, LEFTOVER_QUALITIES, type Meal, type WeekPlan } from "@/lib/household-contract";
import { useVersionedDraft } from "@/app/versioned-draft";
import { PlannerActionButton } from "@/components/planner-ui/action-button";
import { SegmentedControl } from "@/components/planner-ui/segmented-control";

type CloseoutMutateOptions = {
  basePlannerVersion?: number;
  conflictStrategy?: "recompose";
  onAccepted?: (plannerVersion: number) => void;
  onConflict?: (plannerVersion: number) => void;
};
type CloseoutMutate = (command: HouseholdCommand, options?: CloseoutMutateOptions) => Promise<boolean>;

function LeftoverControls({ week, disabled, mutate }: { week: WeekPlan; disabled: boolean; mutate: CloseoutMutate }) {
  return (
    <div className="leftover-feedback">
      {week.data.leftovers.map((leftover) => (
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
      ))}
      {!week.data.leftovers.length ? <p className="empty-copy">Cooking a meal with planned leftovers will add it here.</p> : null}
    </div>
  );
}

function MealFeedbackRow({ meal, week, disabled, mutate, formatCalendarDate }: { meal: Meal; week: WeekPlan; disabled: boolean; mutate: CloseoutMutate; formatCalendarDate: (value: string, options: Intl.DateTimeFormatOptions) => string }) {
  return <div className="feedback-row">
    <div><strong>{meal.title}</strong><small>{formatCalendarDate(meal.date, { weekday: "long" })} · {meal.status}</small></div>
    <SegmentedControl ariaLabel={`Feedback for ${meal.title}`} className="feedback-control" disabled={disabled} options={FEEDBACK_VALUES.map((value) => ({ value, label: value, ariaLabel: `Rate ${meal.title} ${value}` }))} value={week.data.feedback[meal.id]} onChange={(value) => void mutate({ type: "captureFeedback", weekId: week.id, mealId: meal.id, value })} />
  </div>;
}

export function CloseoutView({ week, disabled, mutate, formatCalendarDate }: { week: WeekPlan; disabled: boolean; mutate: CloseoutMutate; formatCalendarDate: (value: string, options: Intl.DateTimeFormatOptions) => string }) {
  const [lesson, setLesson] = useState(week.data.weekLesson);
  const lessonDraft = useVersionedDraft();
  const draftLesson = lessonDraft.versionRef.current === null ? week.data.weekLesson : lesson;
  const feedbackMeals = week.data.meals.filter((meal) => meal.status === "cooked");
  const feedbackComplete = feedbackMeals.filter((meal) => week.data.feedback[meal.id]).length;
  const archivedFeedbackCount = week.data.meals.filter((meal) => week.data.feedback[meal.id]).length;
  if (week.status === "archived") {
    return <div className="lifecycle-surface current-archive">
      <span className="archive-icon"><Archive size={24} /></span>
      <p className="eyebrow">Read-only record</p><h2>Week archived</h2>
      <div className="archive-stats"><span><strong>{week.data.meals.length}</strong> meals</span><span><strong>{archivedFeedbackCount}</strong> ratings</span><span><strong>{week.data.leftovers.length}</strong> leftovers</span></div>
      {week.data.weekLesson ? <div className="lesson-band"><StickyNote size={16} /><span><strong>Planning lesson</strong><p>{week.data.weekLesson}</p></span></div> : null}
    </div>;
  }
  return <div className="closeout-layout">
    <div className="feedback-list">
      <div className="surface-summary"><div><p className="eyebrow">Keep the useful signal</p><h2>Cooked meal feedback</h2></div><span className="summary-chip">{feedbackComplete}/{feedbackMeals.length} rated</span></div>
      {feedbackMeals.map((meal) => <MealFeedbackRow key={meal.id} meal={meal} week={week} disabled={disabled} mutate={mutate} formatCalendarDate={formatCalendarDate} />)}
      {!feedbackMeals.length ? <p className="empty-copy">Cook a meal first, then capture the signal worth carrying into the next plan.</p> : null}
    </div>
    <aside className="closeout-notes">
      <section className="closeout-note-section"><span className="field-label">Leftovers</span><LeftoverControls week={week} disabled={disabled} mutate={mutate} /></section>
      <section className="closeout-note-section">
        <label><span>What should next week remember?</span><textarea maxLength={MAX_COMMAND_TEXT_LENGTH} value={draftLesson} onChange={(event) => { lessonDraft.begin(); setLesson(event.target.value); }} placeholder="A short planning lesson" /><small className="field-limit">{draftLesson.length.toLocaleString("en-CA")}/{MAX_COMMAND_TEXT_LENGTH.toLocaleString("en-CA")}</small></label>
        <PlannerActionButton tone="secondary" type="button" disabled={disabled || draftLesson === week.data.weekLesson} onClick={() => void mutate({ type: "captureWeekLesson", weekId: week.id, weekLesson: draftLesson }, lessonDraft.mutationOptions())}><StickyNote size={15} /> Save lesson</PlannerActionButton>
      </section>
      <span className="closeout-check"><CheckCircle2 size={14} /> Archiving freezes this week as a read-only family record.</span>
      <PlannerActionButton tone="primary" type="button" disabled={disabled || week.status !== "active"} onClick={() => void mutate({ type: "archiveWeek", weekId: week.id })}><Archive size={16} /> Archive active week</PlannerActionButton>
    </aside>
  </div>;
}
