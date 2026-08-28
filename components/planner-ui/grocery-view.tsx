"use client";

import { Utensils } from "lucide-react";
import { useState, type MouseEvent as ReactMouseEvent } from "react";

import type { HouseholdCommand } from "@/lib/household-command-contract";
import { GROCERY_COVERAGES, type GroceryCoverage, type GrocerySection, type IngredientCatalogue, type Meal, type WeekPlan } from "@/lib/household-contract";
import { projectGroceryRequirements, type GroceryFilter } from "@/lib/grocery-projection";
import { PlannerActionButton } from "@/components/planner-ui/action-button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";


type GroceryMutateOptions = {
  onAccepted?: () => void;
};

export type GroceryViewProps = {
  week: WeekPlan;
  ingredientCatalogue: IngredientCatalogue;
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


const GROCERY_FILTERS: Array<{ value: GroceryFilter; label: string }> = [
  { value: "to_buy", label: "To buy" },
  { value: "all", label: "All" },
  { value: "needs_source", label: "Needs source" },
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

export function GroceryView({ week, ingredientCatalogue, disabled, mutate, onOpenRecipe }: GroceryViewProps) {
  const [filter, setFilter] = useState<GroceryFilter>("to_buy");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [bulkCoverage, setBulkCoverage] = useState<GroceryCoverage | "">("");
  const [bulkSection, setBulkSection] = useState<GrocerySection | "">("");
  const [moveNotice, setMoveNotice] = useState<{ coverage: GroceryCoverage; count: number } | null>(null);
  const projection = projectGroceryRequirements(week, ingredientCatalogue, filter);
  const visible = projection.sections.flatMap((section) => section.groups.flatMap((group) => group.children));
  const selectedGroceries = week.data.groceries.filter((entry) => selectedIds.has(entry.id));
  const visibleIdsInDisplayOrder = visible.map((entry) => entry.executionId);
  const allVisibleSelected = Boolean(visibleIdsInDisplayOrder.length) && visibleIdsInDisplayOrder.every((id) => selectedIds.has(id));
  const clearSelection = () => {
    setSelectedIds(new Set());
    setSelectionAnchorId(null);
    setBulkCoverage("");
    setBulkSection("");
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
  const moveSelectedToSection = (section: GrocerySection) => {
    const itemIds = selectedGroceries.filter((entry) => entry.section !== section).map((entry) => entry.id);
    if (itemIds.length) void mutate({ type: "setGroceryItemsSection", weekId: week.id, itemIds, section }, { onAccepted: clearSelection });
  };
  return (
    <div className="grocery-layout">
      <div className={`grocery-list ${selectionMode ? "selection-mode" : ""}`}>
        <div className="surface-summary grocery-summary">
          <div><p className="eyebrow">This week&apos;s dinners</p><h2>Shopping list</h2><p className="grocery-list-description">Check off what you have; each item keeps its recipe source for reference.</p></div>
          <div className="grocery-summary-controls"><GroceryFilterControl value={filter} onChange={(value) => { clearSelection(); setMoveNotice(null); setFilter(value); }} /></div>
        </div>
        <div className="grocery-list-selection-header">
          <label className="grocery-select-all"><input type="checkbox" checked={allVisibleSelected} disabled={disabled || !visibleIdsInDisplayOrder.length} onChange={toggleSelectAllVisible} /> Select all</label>
          {selectedGroceries.length ? <div className="grocery-selection-toolbar w-full flex-wrap" role="status" data-testid="grocery-selection-toolbar"><strong>{selectedGroceries.length} {selectedGroceries.length === 1 ? "item" : "items"} selected</strong><select value={bulkCoverage} aria-label="Set selected grocery coverage" onChange={(event) => setBulkCoverage(event.target.value as GroceryCoverage | "")}><option value="">Set coverage…</option>{GROCERY_COVERAGES.map((coverage) => <option key={coverage} value={coverage}>{GROCERY_SOURCE_LABELS[coverage]}</option>)}</select><PlannerActionButton tone="secondary" type="button" disabled={disabled || !bulkCoverage || !selectedGroceries.some((entry) => entry.coverage !== bulkCoverage)} onClick={() => bulkCoverage && moveSelectedToCoverage(bulkCoverage)}>Set coverage</PlannerActionButton><select value={bulkSection} aria-label="Set selected grocery section" onChange={(event) => setBulkSection(event.target.value as GrocerySection | "")}><option value="">Set section…</option>{["Produce", "Meat & seafood", "Dairy", "Pantry"].map((section) => <option key={section} value={section}>{section}</option>)}</select><PlannerActionButton tone="secondary" type="button" disabled={disabled || !bulkSection || !selectedGroceries.some((entry) => entry.section !== bulkSection)} onClick={() => bulkSection && moveSelectedToSection(bulkSection)}>Set section</PlannerActionButton></div> : null}
        </div>
        {moveNotice ? <div className="grocery-move-notice" role="status" data-testid="grocery-move-notice"><span>Set {moveNotice.count} {moveNotice.count === 1 ? "ingredient" : "ingredients"} to {GROCERY_SOURCE_LABELS[moveNotice.coverage]}.</span><PlannerActionButton tone="quiet" type="button" onClick={() => { setFilter(moveNotice.coverage); setMoveNotice(null); }}>View {GROCERY_SOURCE_LABELS[moveNotice.coverage]}</PlannerActionButton></div> : null}
        {projection.sections.map(({ section, groups }) => {
          const count = groups.reduce((total, group) => total + group.children.length, 0);
          return <section className="grocery-section" key={section}><h3>{section}<span>{count}</span></h3>{groups.map((group) => <div key={group.key} className="grocery-group"><h4>{group.label} <span>{group.quantities.map((part) => part.kind === "quantity" ? part.display : part.literal).join(" + ")} · {group.provenanceCount} requirements</span></h4>{group.children.map((entry) => {
            const linkedMeal = week.data.meals.find((meal) => meal.id === entry.mealId)!;
            const amount = [entry.amount.amount, entry.amount.unit].filter(Boolean).join(" ") || entry.amount.source || "No amount noted";
            const item = [entry.ingredient, entry.qualifier].filter(Boolean).join(", ");
            return <div className={`grocery-row ${entry.checked ? "checked" : ""} ${selectedIds.has(entry.executionId) ? "selected" : ""}`} data-grocery-id={entry.executionId} key={entry.executionId} onMouseDown={(event) => { if (event.button !== 0) return; if (!selectionMode) setSelectionMode(true); selectRow(entry.executionId, event); }}><label className="grocery-check" data-grocery-row-control onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={entry.checked} disabled={disabled} aria-label={`Check ${entry.ingredient}`} onChange={(event) => void mutate({ type: "setGroceryItemChecked", weekId: week.id, itemId: entry.executionId, checked: event.target.checked })} /></label><div className="grocery-item-copy"><div className="grocery-primary-line"><div className="grocery-select-target" title={entry.amount.source ?? undefined} aria-label={entry.amount.source ? `${item}. Source: ${entry.amount.source}` : undefined}><strong>{item}</strong><span className="grocery-detail">{amount}</span></div><span className="grocery-source-badge" title={`Coverage: ${GROCERY_SOURCE_LABELS[entry.coverage]}`}>{GROCERY_SOURCE_LABELS[entry.coverage]}</span></div><div className="grocery-recipe-links"><span>For</span>{week.status === "archived" ? <span>{linkedMeal.title}{entry.sourceRecipe?.kind === "canonical" && entry.sourceRecipe.revision ? ` · ${entry.sourceRecipe.identity} · pinned ${entry.sourceRecipe.revision.slice(0, 12)}` : ""}</span> : <GroceryRecipeLink meal={linkedMeal} onOpenRecipe={onOpenRecipe} />}</div></div></div>;
          })}</div>)}</section>;
        })}
        {!visible.length ? <p className="empty-copy">No groceries match this filter.</p> : null}
      </div>
    </div>
  );
}
