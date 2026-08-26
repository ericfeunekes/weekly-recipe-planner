import { ArrowDown, ArrowUp, Copy, Plus, Split, Trash2 } from "lucide-react";

import { PlannerActionButton, PlannerIconButton } from "@/components/planner-ui/action-button";
import { MAX_INGREDIENT_LINE_LENGTH } from "@/lib/household-command-contract";
import type { IngredientOccurrenceEdit } from "@/lib/ingredient-occurrence";

type IngredientAuthoringProps = {
  occurrences: readonly IngredientOccurrenceEdit[];
  disabled: boolean;
  invalid?: boolean;
  describedBy?: string;
  onChange: (index: number, field: "source" | "amount" | "unit" | "ingredient" | "qualifier", value: string) => void;
  onMove: (index: number, targetIndex: number) => void;
  onCopy: (index: number) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
};

/** Controlled occurrence rows. Identity and mutation authority stay with the meal editor. */
export function IngredientAuthoring({ occurrences, disabled, invalid = false, describedBy, onChange, onMove, onCopy, onRemove, onAdd }: IngredientAuthoringProps) {
  return <section className="full-field occurrence-editor" aria-labelledby="meal-ingredients-heading">
    <div className="occurrence-editor-heading">
      <span id="meal-ingredients-heading">Ingredients</span>
      <small>Each row is one recipe occurrence. Editing a row keeps its identity; removing it also removes linked instruction inputs.</small>
    </div>
    <div className="occurrence-editor-rows" aria-describedby={describedBy}>
      {occurrences.map((occurrence, index) => <fieldset className="occurrence-editor-row" key={occurrence.kind === "retain" ? occurrence.occurrenceId : occurrence.correlationId}>
        <legend className="sr-only">Ingredient {index + 1}</legend>
        <label><span>Source</span><input aria-label={`Ingredient ${index + 1} source`} disabled={disabled} maxLength={MAX_INGREDIENT_LINE_LENGTH} value={occurrence.source ?? ""} onChange={(event) => onChange(index, "source", event.target.value)} /></label>
        <label><span>Amount</span><input aria-label={`Ingredient ${index + 1} amount`} disabled={disabled} maxLength={MAX_INGREDIENT_LINE_LENGTH} value={occurrence.amount} onChange={(event) => onChange(index, "amount", event.target.value)} /></label>
        <label><span>Unit</span><input aria-label={`Ingredient ${index + 1} unit`} disabled={disabled} maxLength={MAX_INGREDIENT_LINE_LENGTH} value={occurrence.unit ?? ""} onChange={(event) => onChange(index, "unit", event.target.value)} /></label>
        <label><span>Ingredient</span><input aria-label={`Ingredient ${index + 1} core`} disabled={disabled} maxLength={MAX_INGREDIENT_LINE_LENGTH} value={occurrence.ingredient} onChange={(event) => onChange(index, "ingredient", event.target.value)} /></label>
        <label><span>Qualifier</span><input aria-label={`Ingredient ${index + 1} qualifier`} disabled={disabled} maxLength={MAX_INGREDIENT_LINE_LENGTH} value={occurrence.qualifier ?? ""} onChange={(event) => onChange(index, "qualifier", event.target.value)} /></label>
        <PlannerIconButton type="button" title={`Move ingredient ${index + 1} up`} aria-label={`Move ingredient ${index + 1} up`} disabled={disabled || index === 0} onClick={() => onMove(index, index - 1)}><ArrowUp size={14} /></PlannerIconButton>
        <PlannerIconButton type="button" title={`Move ingredient ${index + 1} down`} aria-label={`Move ingredient ${index + 1} down`} disabled={disabled || index === occurrences.length - 1} onClick={() => onMove(index, index + 1)}><ArrowDown size={14} /></PlannerIconButton>
        <PlannerIconButton type="button" title={`Duplicate ingredient ${index + 1}`} aria-label={`Duplicate ingredient ${index + 1} as a new occurrence`} disabled={disabled} onClick={() => onCopy(index)}><Copy size={14} /></PlannerIconButton>
        <PlannerIconButton type="button" title={`Split ingredient ${index + 1}`} aria-label={`Split ingredient ${index + 1}; this row keeps its identity`} disabled={disabled} onClick={() => onCopy(index)}><Split size={14} /></PlannerIconButton>
        <PlannerIconButton type="button" tone="attention" title={`Remove ingredient ${index + 1}`} aria-label={`Remove ingredient ${index + 1} and linked instruction inputs`} disabled={disabled} onClick={() => onRemove(index)}><Trash2 size={14} /></PlannerIconButton>
      </fieldset>)}
    </div>
    <PlannerActionButton tone="secondary" type="button" disabled={disabled} onClick={onAdd}><Plus size={15} /> Add ingredient</PlannerActionButton>
    {invalid ? <small className="field-error" role="alert">Review the ingredient rows.</small> : null}
  </section>;
}
