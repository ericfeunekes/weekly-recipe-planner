---
type: recipe
id: lemon-pepper-salmon
status: active
source: web
source-ref: "https://example.com/lemon-pepper-salmon"
source-locator: "Recipe card"
source-path: retained/lemon-pepper-salmon.txt
source-start-line: 4
source-end-line: 28
source-sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
source-retrieved-at: 2026-08-09
fidelity-verdict: exact
fidelity-review: reviews/lemon-pepper-salmon.md
adapted-from: family/lemon-salmon
cuisine: North American
servings: 4
time-active-min: 10
time-total-min: 30
taste-tags: [bright, savory]
dietary-tags: [gluten-free]
---

# Lemon Pepper Salmon

## Ingredients

```yaml
- id: 1
  source: "4 (4-6 ounce) salmon fillets"
  amount: "4"
  unit: fillet
  ingredient: salmon
  qualifier: "4-6 ounce"

- id: 2
  source: "1 tablespoon minced garlic"
  amount: "1"
  unit: tablespoon
  ingredient: garlic
  qualifier: minced

- id: 3
  source: "Salt to taste"
  amount:
  unit:
  ingredient: salt
  qualifier: to taste
```

## Instructions

```yaml
- id: 1
  ingredient-ids: []
  instruction: Preheat the oven to 400°F.

- id: 2
  ingredient-ids: [1, 2, 3]
  instruction: Rub the garlic over the salmon.

- id: 3
  ingredient-ids: [1]
  instruction: Bake until the salmon flakes easily.
  timer-seconds: 900
```

## Notes

- Serve with rice and roasted vegetables.
- Butter can replace the olive oil.
