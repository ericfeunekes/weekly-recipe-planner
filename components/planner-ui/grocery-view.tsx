"use client";

import { Utensils } from "lucide-react";
import { useState, type MouseEvent as ReactMouseEvent } from "react";

import type { HouseholdCommand } from "@/lib/household-command-contract";
import { GROCERY_COVERAGES, type GroceryCoverage, type GroceryItem, type Meal, type WeekPlan } from "@/lib/household-contract";
import { PlannerActionButton } from "@/components/planner-ui/action-button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type GroceryFilter = "to_buy" | "all" | GroceryCoverage | "done";

type GroceryMutateOptions = {
  onAccepted?: () => void;
};

export type GroceryViewProps = {
  week: WeekPlan;
  disabled: boolean;
  mutate: (command: HouseholdCommand, options?: GroceryMutateOptions) => Promise<boolean>;
  onOpenRecipe: (mealId: string, trigger: HTMLElement) => void;
};

const GROCERY_SOURCE_LABELS = {
  needs_source: "Needs source",
  shop: "Shop",
  farm_box: "Farm box",
  on_hand: "On hand",
} as const;

const GROCERY_SECTIONS: GroceryItem["section"][] = [
  "Produce",
  "Meat & seafood",
  "Dairy",
  "Pantry",
];

const GROCERY_FILTERS: Array<{ value: GroceryFilter; label: string }> = [
  { value: "to_buy", label: "To buy" },
  { value: "all", label: "All" },
  { value: "shop", label: "Shop" },
  { value: "farm_box", label: "Farm box" },
  { value: "on_hand", label: "On hand" },
  { value: "done", label: "Done" },
];

function GroceryFilterControl({ value, onChange }: { value: GroceryFilter; onChange: (value: GroceryFilter) => void }) {
  return (
    <ToggleGroup
      className="segmented-control"
      type="single"
      value={value}
      onValueChange={(nextValue) => { if (nextValue) onChange(nextValue as GroceryFilter); }}
      aria-label="Grocery filter"
      variant="outline"
      size="sm"
      spacing={0}
    >
      {GROCERY_FILTERS.map((option) => <ToggleGroupItem key={option.value} value={option.value}>{option.label}</ToggleGroupItem>)}
    </ToggleGroup>
  );
}

function isGroceryRowControlTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  return Boolean(element?.closest("button, input, select, label, a, textarea, [data-grocery-row-control]"));
}

function GroceryRecipeLink({ meal, onOpenRecipe }: { meal: Meal; onOpenRecipe: (mealId: string, trigger: HTMLElement) => void }) {
  return <button className="grocery-meal-link" type="button" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onOpenRecipe(meal.id, event.currentTarget); }}><Utensils size={11} /> {meal.title}</button>;
}

export function GroceryView({ week, disabled, mutate, onOpenRecipe }: GroceryViewProps) {
  const [filter, setFilter] = useState<GroceryFilter>("to_buy");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [bulkCoverage, setBulkCoverage] = useState<GroceryCoverage | "">("");
  const [moveNotice, setMoveNotice] = useState<{ coverage: GroceryCoverage; count: number } | null>(null);
  const visible = week.data.groceries.filter((entry) => {
    if (filter === "all") return true;
    if (filter === "done") return entry.checked;
    if (filter === "to_buy") return !entry.checked && entry.coverage === "shop";
    if (filter === "shop") return entry.coverage === "shop";
    return entry.coverage === filter;
  });
  const selectedGroceries = week.data.groceries.filter((entry) => selectedIds.has(entry.id));
  const visibleIdsInDisplayOrder = GROCERY_SECTIONS.flatMap((group) => visible.filter((entry) => entry.section === group).map((entry) => entry.id));
  const allVisibleSelected = Boolean(visibleIdsInDisplayOrder.length) && visibleIdsInDisplayOrder.every((id) => selectedIds.has(id));
  const clearSelection = () => {
    setSelectedIds(new Set());
    setSelectionAnchorId(null);
    setBulkCoverage("");
  };
  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      clearSelection();
      setSelectionMode(false);
      return;
    }
    setSelectedIds(new Set(visibleIdsInDisplayOrder));
    setSelectionAnchorId(visibleIdsInDisplayOrder[0] ?? null);
    setSelectionMode(true);
  };
  const selectRow = (itemId: string, event: ReactMouseEvent<HTMLElement>) => {
    if (disabled || isGroceryRowControlTarget(event.target)) return;
    const additive = event.ctrlKey || event.metaKey;
    const anchorIndex = selectionAnchorId ? visibleIdsInDisplayOrder.indexOf(selectionAnchorId) : -1;
    const itemIndex = visibleIdsInDisplayOrder.indexOf(itemId);
    if (event.shiftKey && anchorIndex >= 0 && itemIndex >= 0) {
      const rangeIds = visibleIdsInDisplayOrder.slice(Math.min(anchorIndex, itemIndex), Math.max(anchorIndex, itemIndex) + 1);
      setSelectedIds((current) => {
        const next = additive ? new Set(current) : new Set<string>();
        rangeIds.forEach((rangeId) => next.add(rangeId));
        return next;
      });
      return;
    }
    setSelectedIds((current) => {
      if (!additive) return new Set([itemId]);
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
    setSelectionAnchorId(itemId);
  };
  const moveGroceriesToCoverage = (itemIds: string[], coverage: GroceryCoverage) => {
    if (!itemIds.length) return;
    void mutate({ type: "setGroceryItemsCoverage", weekId: week.id, itemIds, coverage }, {
      onAccepted: () => {
        setMoveNotice({ coverage, count: itemIds.length });
        clearSelection();
      },
    });
  };
  const moveSelectedToCoverage = (coverage: GroceryCoverage) => moveGroceriesToCoverage(selectedGroceries.filter((entry) => entry.coverage !== coverage).map((entry) => entry.id), coverage);
  return (
    <div className="grocery-layout">
      <div className={`grocery-list ${selectionMode ? "selection-mode" : ""}`}>
        <div className="surface-summary grocery-summary">
          <div><p className="eyebrow">This week&apos;s dinners</p><h2>Shopping list</h2><p className="grocery-list-description">Check off what you have; each item keeps its recipe source for reference.</p></div>
          <div className="grocery-summary-controls"><GroceryFilterControl value={filter} onChange={(value) => { clearSelection(); setMoveNotice(null); setFilter(value); }} /></div>
        </div>
        <div className="grocery-list-selection-header">
          <label className="grocery-select-all"><input type="checkbox" checked={allVisibleSelected} disabled={disabled || !visibleIdsInDisplayOrder.length} onChange={toggleSelectAllVisible} /> Select all</label>
          {selectedGroceries.length ? <div className="grocery-selection-toolbar" role="status" data-testid="grocery-selection-toolbar"><strong>{selectedGroceries.length} {selectedGroceries.length === 1 ? "item" : "items"} selected</strong><select value={bulkCoverage} aria-label="Set selected grocery coverage" onChange={(event) => setBulkCoverage(event.target.value as GroceryCoverage | "")}><option value="">Set coverage…</option>{GROCERY_COVERAGES.map((coverage) => <option key={coverage} value={coverage}>{GROCERY_SOURCE_LABELS[coverage]}</option>)}</select><PlannerActionButton tone="secondary" type="button" disabled={disabled || !bulkCoverage || !selectedGroceries.some((entry) => entry.coverage !== bulkCoverage)} onClick={() => bulkCoverage && moveSelectedToCoverage(bulkCoverage)}>Set coverage</PlannerActionButton></div> : null}
        </div>
        {moveNotice ? <div className="grocery-move-notice" role="status" data-testid="grocery-move-notice"><span>Set {moveNotice.count} {moveNotice.count === 1 ? "ingredient" : "ingredients"} to {GROCERY_SOURCE_LABELS[moveNotice.coverage]}.</span><PlannerActionButton tone="quiet" type="button" onClick={() => { setFilter(moveNotice.coverage); setMoveNotice(null); }}>View {GROCERY_SOURCE_LABELS[moveNotice.coverage]}</PlannerActionButton></div> : null}
        {GROCERY_SECTIONS.map((group) => {
          const entries = visible.filter((entry) => entry.section === group);
          if (!entries.length) return null;
          return <section className="grocery-section" key={group}><h3>{group}<span>{entries.length}</span></h3>{entries.map((entry) => {
            const linkedMeal = week.data.meals.find((meal) => meal.id === entry.mealId);
            const ingredient = linkedMeal?.ingredients.find((candidate) => candidate.id === entry.ingredientId);
            if (!linkedMeal || !ingredient) return null;
            const item = ingredient.ingredient;
            return <div className={`grocery-row ${entry.checked ? "checked" : ""} ${selectedIds.has(entry.id) ? "selected" : ""}`} data-grocery-id={entry.id} key={entry.id} onMouseDown={(event) => { if (event.button !== 0) return; if (!selectionMode) setSelectionMode(true); selectRow(entry.id, event); }}><label className="grocery-check" data-grocery-row-control onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={entry.checked} disabled={disabled} aria-label={`Check ${item}`} onChange={(event) => void mutate({ type: "setGroceryItemChecked", weekId: week.id, itemId: entry.id, checked: event.target.checked })} /></label><div className="grocery-item-copy"><div className="grocery-primary-line"><div className="grocery-select-target"><strong>{item}</strong><span className="grocery-detail">{ingredient.amount || "No amount noted"}</span></div><span className="grocery-source-badge" title={`Coverage: ${GROCERY_SOURCE_LABELS[entry.coverage]}`}>{GROCERY_SOURCE_LABELS[entry.coverage]}</span></div><div className="grocery-recipe-links"><span>For</span><GroceryRecipeLink meal={linkedMeal} onOpenRecipe={onOpenRecipe} /></div></div></div>;
          })}</section>;
        })}
        {!visible.length ? <p className="empty-copy">No groceries match this filter.</p> : null}
      </div>
    </div>
  );
}
