export type Rational = Readonly<{ numerator: number; denominator: number }>;
export type QuantityDimension = "count" | "mass" | "volume";

export type StructuredIngredientAmount = Readonly<{
  amount: string;
  unit: string | null;
  /** Exact source spelling, returned whenever derivation abstains. */
  source?: string | null;
}>;

export type IngredientQuantityPart =
  | Readonly<{ kind: "quantity"; dimension: QuantityDimension; quantity: Rational; unit: string | null; display: string }>
  | Readonly<{ kind: "literal"; literal: string; reason: "amount" | "unit" | "incompatible" | "overflow" }>;

export type IngredientQuantitySum =
  | Readonly<{ ok: true; quantity: Rational; unit: string; display: string }>
  | Readonly<{ ok: false; reason: "empty" | "unparseable" | "missing-unit" | "incompatible-unit" | "overflow" }>;

export type WeeklyRequirementOccurrence = Readonly<{
  occurrenceId: string;
  mealId: string;
  mealTitle: string;
  ingredient: string;
  qualifier?: string | null;
  amount: string;
  unit: string | null;
  source: string | null;
  role: "weekly_requirement" | "output" | "leftover";
  concept?: Readonly<{ id: string; label: string }> | null;
  execution: Readonly<{
    id: string;
    section: string;
    coverage: "needs_source" | "shop" | "farm_box" | "on_hand";
    checked: boolean;
  }>;
}>;

export type WeeklyRequirementChild = Readonly<{
  executionId: string;
  occurrenceId: string;
  mealId: string;
  mealTitle: string;
  ingredient: string;
  qualifier: string | null;
  amount: StructuredIngredientAmount;
  coverage: WeeklyRequirementOccurrence["execution"]["coverage"];
  checked: boolean;
}>;

export type WeeklyRequirementGroup = Readonly<{
  key: string;
  section: string;
  conceptId: string | null;
  label: string;
  quantities: readonly IngredientQuantityPart[];
  children: readonly WeeklyRequirementChild[];
}>;

type BigRational = { numerator: bigint; denominator: bigint };
type Unit = Readonly<{ dimension: QuantityDimension; canonical: string | null; factor: BigRational }>;
const ONE = { numerator: BigInt(1), denominator: BigInt(1) } as const;
const UNITS: Readonly<Record<string, Unit>> = {
  "": { dimension: "count", canonical: null, factor: ONE },
  count: { dimension: "count", canonical: null, factor: ONE },
  each: { dimension: "count", canonical: null, factor: ONE },
  mg: { dimension: "mass", canonical: "mg", factor: ONE },
  g: { dimension: "mass", canonical: "g", factor: { numerator: BigInt(1_000), denominator: BigInt(1) } },
  kg: { dimension: "mass", canonical: "kg", factor: { numerator: BigInt(1_000_000), denominator: BigInt(1) } },
  oz: { dimension: "mass", canonical: "oz", factor: { numerator: BigInt("28349523125"), denominator: BigInt(1_000_000) } },
  lb: { dimension: "mass", canonical: "lb", factor: { numerator: BigInt("453592370000"), denominator: BigInt(1_000_000) } },
  tsp: { dimension: "volume", canonical: "tsp", factor: { numerator: BigInt(5), denominator: BigInt(1) } },
  tbsp: { dimension: "volume", canonical: "tbsp", factor: { numerator: BigInt(15), denominator: BigInt(1) } },
  "fl oz": { dimension: "volume", canonical: "fl oz", factor: { numerator: BigInt("2957352956250"), denominator: BigInt("100000000000") } },
  cup: { dimension: "volume", canonical: "cup", factor: { numerator: BigInt(250), denominator: BigInt(1) } },
  ml: { dimension: "volume", canonical: "mL", factor: ONE },
  l: { dimension: "volume", canonical: "L", factor: { numerator: BigInt(1_000), denominator: BigInt(1) } },
};

function gcd(left: bigint, right: bigint): bigint {
  let a = left < BigInt(0) ? -left : left;
  let b = right < BigInt(0) ? -right : right;
  while (b !== BigInt(0)) [a, b] = [b, a % b];
  return a || BigInt(1);
}

function normalize(value: BigRational): BigRational | null {
  if (value.denominator === BigInt(0)) return null;
  const sign = value.denominator < BigInt(0) ? BigInt(-1) : BigInt(1);
  const numerator = value.numerator * sign;
  const denominator = value.denominator * sign;
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function toPublic(value: BigRational | null): Rational | null {
  if (!value || value.numerator > BigInt(Number.MAX_SAFE_INTEGER) || value.numerator < BigInt(Number.MIN_SAFE_INTEGER) || value.denominator > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { numerator: Number(value.numerator), denominator: Number(value.denominator) };
}

function parseAmount(value: string): BigRational | null {
  const trimmed = value.trim();
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/u.exec(trimmed);
  if (mixed) return normalize({ numerator: BigInt(mixed[1]) * BigInt(mixed[3]) + BigInt(mixed[2]), denominator: BigInt(mixed[3]) });
  const fraction = /^(\d+)\/(\d+)$/u.exec(trimmed);
  if (fraction) return normalize({ numerator: BigInt(fraction[1]), denominator: BigInt(fraction[2]) });
  const decimal = /^(\d+)(?:\.(\d+))?$/u.exec(trimmed);
  if (!decimal) return null;
  const decimals = decimal[2] ?? "";
  return normalize({ numerator: BigInt(`${decimal[1]}${decimals}`), denominator: BigInt(10) ** BigInt(decimals.length) });
}

function unitFor(value: string | null): Unit | null {
  if (value === null) return UNITS[""];
  const key = value.trim().toLocaleLowerCase("en-CA");
  return UNITS[key === "cups" ? "cup" : key === "lbs" ? "lb" : key] ?? null;
}

function sourceLiteral(input: StructuredIngredientAmount): string {
  return input.source ?? [input.amount, input.unit].filter((part) => part !== null && part !== "").join(" ");
}

function display(quantity: Rational, unit: string | null): string {
  const whole = Math.floor(quantity.numerator / quantity.denominator);
  const remainder = quantity.numerator % quantity.denominator;
  const number = remainder === 0 ? String(whole) : whole === 0 ? `${remainder}/${quantity.denominator}` : `${whole} ${remainder}/${quantity.denominator}`;
  return unit === null ? number : `${number} ${unit}`;
}

export function deriveIngredientQuantity(input: StructuredIngredientAmount): IngredientQuantityPart {
  try {
    const amount = parseAmount(input.amount);
    if (!amount) return { kind: "literal", literal: sourceLiteral(input), reason: "amount" };
    const unit = unitFor(input.unit);
    if (!unit) return { kind: "literal", literal: sourceLiteral(input), reason: "unit" };
    const quantity = toPublic(amount);
    if (!quantity) return { kind: "literal", literal: sourceLiteral(input), reason: "overflow" };
    return { kind: "quantity", dimension: unit.dimension, quantity, unit: unit.canonical, display: display(quantity, unit.canonical) };
  } catch {
    return { kind: "literal", literal: sourceLiteral(input), reason: "overflow" };
  }
}

function add(left: BigRational, right: BigRational): BigRational | null {
  return normalize({ numerator: left.numerator * right.denominator + right.numerator * left.denominator, denominator: left.denominator * right.denominator });
}

function totalQuantities(inputs: readonly StructuredIngredientAmount[]): IngredientQuantityPart[] {
  const dimensionCounts = new Map<QuantityDimension, number>();
  for (const input of inputs) {
    const dimension = unitFor(input.unit)?.dimension;
    if (dimension) dimensionCounts.set(dimension, (dimensionCounts.get(dimension) ?? 0) + 1);
  }
  const hasMultipleDimensions = dimensionCounts.size > 1;
  const totals = new Map<QuantityDimension, BigRational>();
  const units = new Map<QuantityDimension, string | null>();
  const order: Array<{ dimension: QuantityDimension } | { literal: IngredientQuantityPart }> = [];
  const seenDimensions = new Set<QuantityDimension>();
  for (const input of inputs) {
    const amount = parseAmount(input.amount);
    const unit = unitFor(input.unit);
    if (!amount || !unit) {
      order.push({ literal: deriveIngredientQuantity(input) });
      continue;
    }
    if (hasMultipleDimensions && dimensionCounts.get(unit.dimension) === 1) {
      order.push({ literal: { kind: "literal", literal: sourceLiteral(input), reason: "incompatible" } });
      continue;
    }
    const scaled = normalize({ numerator: amount.numerator * unit.factor.numerator, denominator: amount.denominator * unit.factor.denominator });
    const next = scaled && add(totals.get(unit.dimension) ?? { numerator: BigInt(0), denominator: BigInt(1) }, scaled);
    if (!next) {
      order.push({ literal: { kind: "literal", literal: sourceLiteral(input), reason: "overflow" } });
      continue;
    }
    totals.set(unit.dimension, next);
    if (!seenDimensions.has(unit.dimension)) {
      seenDimensions.add(unit.dimension);
      order.push({ dimension: unit.dimension });
    }
    const existing = units.get(unit.dimension);
    units.set(unit.dimension, existing === undefined ? unit.canonical : existing === unit.canonical ? existing : unit.dimension === "mass" ? "g" : unit.dimension === "volume" ? "mL" : null);
  }
  const quantities = new Map<QuantityDimension, IngredientQuantityPart[]>();
  for (const dimension of ["count", "mass", "volume"] as const) {
    const base = totals.get(dimension);
    if (!base) continue;
    const outputUnit = units.get(dimension) ?? null;
    const definition = unitFor(outputUnit);
    const quantity = toPublic(definition && normalize({ numerator: base.numerator * definition.factor.denominator, denominator: base.denominator * definition.factor.numerator }));
    if (quantity) quantities.set(dimension, [{ kind: "quantity", dimension, quantity, unit: outputUnit, display: display(quantity, outputUnit) }]);
    else quantities.set(dimension, inputs.filter((input) => unitFor(input.unit)?.dimension === dimension).map((input) => ({ kind: "literal" as const, literal: sourceLiteral(input), reason: "overflow" as const })));
  }
  return order.flatMap((part) => "literal" in part ? [part.literal] : quantities.get(part.dimension) ?? []);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Pure read projection with content-derived ordering. */
export function projectWeeklyGroceryRequirements(occurrences: readonly WeeklyRequirementOccurrence[]): WeeklyRequirementGroup[] {
  const groups = new Map<string, { section: string; conceptId: string | null; label: string; children: WeeklyRequirementChild[] }>();
  for (const occurrence of occurrences) {
    if (occurrence.role !== "weekly_requirement") continue;
    const conceptId = occurrence.concept?.id ?? null;
    const key = conceptId === null ? `occurrence:${occurrence.occurrenceId}` : `concept:${occurrence.execution.section}:${conceptId}`;
    let group = groups.get(key);
    if (!group) {
      group = { section: occurrence.execution.section, conceptId, label: occurrence.concept?.label ?? occurrence.ingredient, children: [] };
      groups.set(key, group);
    }
    const candidateLabel = occurrence.concept?.label ?? occurrence.ingredient;
    if (compare(candidateLabel, group.label) < 0) group.label = candidateLabel;
    group.children.push({
      executionId: occurrence.execution.id,
      occurrenceId: occurrence.occurrenceId,
      mealId: occurrence.mealId,
      mealTitle: occurrence.mealTitle,
      ingredient: occurrence.ingredient,
      qualifier: occurrence.qualifier ?? null,
      amount: { amount: occurrence.amount, unit: occurrence.unit, source: occurrence.source },
      coverage: occurrence.execution.coverage,
      checked: occurrence.execution.checked,
    });
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const children = [...group.children].sort((left, right) => compare(left.mealTitle, right.mealTitle) || compare(left.mealId, right.mealId) || compare(left.occurrenceId, right.occurrenceId));
      return { ...group, key, children, quantities: totalQuantities(children.map((child) => child.amount)) };
    })
    .sort((left, right) => compare(left.section, right.section) || compare(left.label, right.label) || compare(left.key, right.key));
}

/** Compatibility adapter for the existing Prep projection until #14 supplies structured units. */
export function sumIngredientQuantities(amounts: readonly string[]): IngredientQuantitySum {
  if (amounts.length === 0) return { ok: false, reason: "empty" };
  const structured: StructuredIngredientAmount[] = [];
  for (const literal of amounts) {
    const match = /^(\d+(?:\.\d+)?|\d+\/\d+|\d+\s+\d+\/\d+)\s+(fl oz|mg|kg|lbs?|oz|g|tsp|tbsp|cups?|ml|l)$/iu.exec(literal.trim());
    if (!match) return { ok: false, reason: /^\d+(?:\.\d+)?$|^\d+\/\d+$/u.test(literal.trim()) ? "missing-unit" : "unparseable" };
    structured.push({ amount: match[1], unit: match[2], source: literal });
  }
  const dimensions = new Set(structured.map((input) => unitFor(input.unit)?.dimension));
  if (dimensions.size !== 1) return { ok: false, reason: "incompatible-unit" };
  const [part] = totalQuantities(structured);
  if (!part || part.kind === "literal") return { ok: false, reason: "overflow" };
  const compatibilityUnit = part.unit ?? "";
  const compatibilityDisplay = compatibilityUnit === "cup" && part.quantity.numerator !== part.quantity.denominator
    ? `${part.display}s`
    : part.display;
  return { ok: true, quantity: part.quantity, unit: compatibilityUnit, display: compatibilityDisplay };
}
