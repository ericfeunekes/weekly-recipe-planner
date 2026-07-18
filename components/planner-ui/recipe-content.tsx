import { Check } from "lucide-react";

import type { IngredientAmountLine, InstructionStep } from "@/lib/household-contract";

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
          <span key={`${item.amount}-${item.ingredient}-${index}`}>
            <strong>{item.amount}</strong> {item.ingredient}
          </span>
        ))}
      </div>
    );
  }

  return (
    <ul className="ingredient-list">
      {items.map((item, index) => {
        const ingredientId = "id" in item && typeof item.id === "string" ? item.id : null;
        return (
        <li key={`${item.amount}-${item.ingredient}-${index}`}>
          {ingredientId && onCheckedChange ? (
            <input
              className="mt-0.5 size-4 shrink-0 accent-[var(--green)]"
              type="checkbox"
              checked={checkedById?.get(ingredientId) ?? false}
              disabled={disabled}
              aria-label={`Check ${item.ingredient}`}
              onChange={(event) => onCheckedChange(ingredientId, event.target.checked)}
            />
          ) : <Check size={13} />}
          {[item.amount, item.ingredient].filter(Boolean).join(" ")}
        </li>
        );
      })}
    </ul>
  );
}

/**
 * The stable instruction copy and ingredient-input block shared by Day, Prep,
 * and recipe summaries. Contexts add their own checkbox, timer, and actions.
 */
export function RecipeInstructionContent({ step }: { step: InstructionStep }) {
  return (
    <div className="instruction-line-content">
      <p className="step-instruction">{step.instruction}</p>
      <RecipeIngredientList items={step.inputs} variant="step" />
    </div>
  );
}
