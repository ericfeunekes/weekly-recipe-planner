# PC Express / Atlantic Superstore

Use this reference only after the user explicitly selects PC Express or
Atlantic Superstore for the current run.

## Entry and scope

Use the authenticated PC Express / Atlantic Superstore shopping surface. Read
the selected fulfillment method, postal code or store, delivery/pickup window,
and existing cart before searching. Those choices affect price and
availability; do not silently change them.

Existing cart lines may include subscriptions. A subscription indicator is not
permission to change its cadence, quantity, or cart status. If cart state after
a refresh differs from the captured state, pause for user direction rather
than trying to recreate it.

## Product selection

Search one ingredient at a time. Confirm the rendered product name, package
size, availability, and price before adding it.

- Fresh variable-weight products may be selected when their displayed expected
  weight reasonably covers the requested amount; record the expected-weight
  variance.
- When exact count packages are unavailable, prefer the smallest suitable
  package and record the extra quantity.
- When a requested product type is unavailable, do not silently swap a
  materially different product. Present the closest options or ask.
- Respect out-of-stock state. Do not select a disabled product or treat a
  search result as availability proof.

## Cart validation

After every add, return to the cart or otherwise read the rendered cart lines.
Verify the intended product and quantity as well as all pre-existing lines.
The number in the cart header can mean product lines or units depending on the
page state; use the itemized cart and subtotal as the authoritative readback.

Leave substitutions at the user's existing setting. Do not enable, disable, or
edit substitution choices without direction.

Stop at the cart review page. `Checkout` or `Proceed to checkout` is outside
this skill's authority.
