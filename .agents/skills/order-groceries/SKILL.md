---
name: order-groceries
description: Builds and reconciles a household grocery cart from an approved planner week and a chosen store. Use when the user asks to shop, add groceries to a cart, order groceries, use PC Express, or transfer grocery reminders into a store cart. Do not use merely to group or review grocery items; use grocery-organization instead.
---

# Order Groceries

This skill turns the approved, recipe-derived shopping projection into a
reviewable store cart. It does not place an order or check out.

## Choose the store first

Always ask the user which store to use before opening a shopping surface or
adding an item. Do this even when a prior run, current plan, or surrounding
conversation mentions PC Express or another store. Treat the chosen store as a
run-scoped decision, not a household default.

- For PC Express / Atlantic Superstore, load
  [PC Express](references/pc-express.md).
- For another store with a reference, load that store's reference.
- If the store has no reference, inspect its live surface, preserve a concise
  reference after the run, and do not borrow availability or product rules from
  PC Express.

If no authenticated, user-authorized store surface is available, prepare the
reviewable handoff and name the missing capability. Never substitute a
different store without the user's direction.

## Establish the shopping scope

Read the current production planner week and use its unchecked grocery objects
as the recipe-derived source of truth. Preserve recipe ingredient names,
amounts, meal links, and shopping-source grouping; do not replace the planner
with a hand-maintained recalculated list.

When the user also supplies a reminder list or other grocery capture, classify
it separately before any cart mutation:

- An explicit alternate source, including a named store, `local source`, farm
  stand, market, delivery service, or pickup instruction, excludes the item
  from this store run unless the user explicitly overrides it.
- An unassigned item is a candidate addition, not an automatic transfer. State
  the candidate additions and ask for approval to add them when the request was
  only to read, review, or classify the reminder list.
- Do not mark planner groceries complete merely because a reminder mentions a
  similar item.

## Reconcile before and during cart work

Before the first mutation, capture the visible cart lines, quantities,
subscription status, substitution settings, and subtotal. Existing cart items
belong to the user: do not remove, alter, or recreate them unless explicitly
requested.

For each planner or approved reminder item:

1. Search the selected store and verify the visible product name, package size,
   price, availability, and add control.
2. Prefer the exact ingredient. If only a different package or acceptable
   product is available, add the closest reasonable option and record the
   variance separately: requested ingredient and amount, selected product and
   package, and any remainder or surplus. Never alter source recipes or planner
   ingredient rows to match the store package.
3. Read back the cart after the add. Verify the intended line and quantity and
   that unrelated pre-existing lines and subscription state remain intact.

Treat a cart header count as a hint only. Cart proof is the rendered line-item
list, quantities, and subtotal. If a navigation, login, location change, or
refresh yields a different cart, stop adding. Reopen the cart, compare it with
the pre-mutation snapshot, and ask the user before any recovery that could
change pre-existing items or a subscription.

## Handoff

Leave the cart open for the user to review. Do not proceed to checkout,
authorize payment, or place an order without a separate explicit instruction.
Report:

- selected store and fulfillment/location state;
- planner items added, unavailable, and deliberately excluded;
- separately approved reminder additions;
- package/product variances and substitutions;
- cart line-item readback and estimated subtotal; and
- any unresolved source, inventory, or cart-state issue.

Use `grocery-organization` for upstream grouping and inventory assumptions;
return there if grocery objects need correction. Use `meal-planning` or
`recipe-discovery-import` if the missing item reflects an omitted meal
component rather than a store availability issue.
