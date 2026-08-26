import { Check } from "lucide-react";

import type { IngredientAmountLine, InstructionStep, Meal } from "@/lib/household-contract";
import {
  ingredientOccurrenceDisplayText,
  isGroceryRequirementRole,
} from "@/lib/ingredient-occurrence";

type RecipeIngredientListProps = {
  items: readonly IngredientAmountLine[];
  variant?: "recipe" | "step";
  emptyMessage?: string;
  emptyClassName?: string;
  checkedById?: ReadonlyMap<string, boolean>;
  disabled?: boolean;
  onCheckedChange?: (ingredientId: string, checked: boolean) => void;
};

/**
 * The canonical ingredient renderer for a recipe and its instruction steps.
 * A recipe owns the complete list; a step owns the inputs it consumes.
 */
export function RecipeIngredientList({
  items,
  variant = "recipe",
  emptyMessage = "No ingredients listed.",
  emptyClassName,
  checkedById,
  disabled = false,
  onCheckedChange,
}: RecipeIngredientListProps) {
  if (!items.length) return emptyClassName ? <p className={emptyClassName}>{emptyMessage}</p> : null;

  if (variant === "step") {
    return (
      <div className="step-inputs">
        {items.map((item, index) => (
          <span key={"occurrenceId" in item && typeof item.occurrenceId === "string" ? `${item.occurrenceId}:${index}` : `${item.amount}-${item.ingredient}-${index}`}>
            {"source" in item && typeof item.source === "string" && item.source ? <span className="block text-[11px] text-[var(--ink-soft)]">{item.source}</span> : null}
            <span>{ingredientOccurrenceDisplayText({ ...item, source: null })}</span>
          </span>
        ))}
      </div>
    );
  }

  return (
    <ul className="ingredient-list">
      {items.map((item, index) => {
        const ingredientId = "id" in item && typeof item.id === "string" ? item.id : null;
        const groceryControlId = ingredientId !== null &&
          "role" in item && isGroceryRequirementRole(item.role) &&
          checkedById?.has(ingredientId) === true
          ? ingredientId
          : null;
        return (
        <li key={ingredientId ?? `${item.amount}-${item.ingredient}-${index}`}>
          {groceryControlId && onCheckedChange ? (
            <input
              className="mt-0.5 size-4 shrink-0 accent-[var(--green)]"
              type="checkbox"
              checked={checkedById?.get(groceryControlId) ?? false}
              disabled={disabled}
              aria-label={`Check ${item.ingredient}`}
              onChange={(event) => onCheckedChange(groceryControlId, event.target.checked)}
            />
          ) : <Check size={13} />}
          <span className="min-w-0">
            {"source" in item && typeof item.source === "string" && item.source ? <span className="block text-[11px] text-[var(--ink-soft)]">{item.source}</span> : null}
            <span>{ingredientOccurrenceDisplayText({ ...item, source: null })}</span>
          </span>
        </li>
        );
      })}
    </ul>
  );
}

/** Source provenance is informational; the dated meal snapshot remains editable. */
export function RecipeProvenance({ meal }: { meal: { sourceRecipe?: { kind: string; identity: string; revision?: string } } }) {
  if (!meal.sourceRecipe) return null;
  const source = meal.sourceRecipe;
  return <p className="recipe-source"><span>Editable meal copy</span><span>{source.kind === "canonical" && source.revision ? `${source.identity} · pinned ${source.revision.slice(0, 12)}` : source.identity}</span></p>;
}

/**
 * The stable instruction copy and ingredient-input block shared by Day, Prep,
 * and recipe summaries. Contexts add their own checkbox, timer, and actions.
 */
export function RecipeInstructionContent({ step, meal }: { step: InstructionStep; meal: Meal }) {
  const ingredientsById = new Map(meal.ingredients.map((ingredient) => [ingredient.id, ingredient]));
  const inputs = step.inputs.map((input) => {
    const occurrence = ingredientsById.get(input.occurrenceId);
    if (!occurrence) return input;
    const amountAlreadyIncludesUnit = occurrence.unit !== null && input.amount.toLocaleLowerCase().includes(occurrence.unit.toLocaleLowerCase());
    return { ...occurrence, amount: input.amount, ingredient: input.ingredient, unit: amountAlreadyIncludesUnit ? null : occurrence.unit };
  });
  return (
    <div className="instruction-line-content">
      <p className="step-instruction">{step.instruction}</p>
      <RecipeIngredientList items={inputs} variant="step" />
    </div>
  );
}
