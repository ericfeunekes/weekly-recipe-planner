export type Rational = {
  numerator: number;
  denominator: number;
};

export type IngredientQuantityFailure =
  | "empty"
  | "unparseable"
  | "missing-unit"
  | "incompatible-unit"
  | "overflow";

export type IngredientQuantitySum =
  | {
      ok: true;
      quantity: Rational;
      unit: string;
      display: string;
    }
  | {
      ok: false;
      reason: IngredientQuantityFailure;
    };

type ParsedQuantity = {
  quantity: Rational;
  unit: Unit;
};

type Unit = {
  dimension: "mass" | "volume";
  canonical: string;
  factor: Rational;
};

const UNITS: Record<string, Unit> = {
  mg: { dimension: "mass", canonical: "mg", factor: { numerator: 1, denominator: 1 } },
  g: { dimension: "mass", canonical: "g", factor: { numerator: 1_000, denominator: 1 } },
  kg: { dimension: "mass", canonical: "kg", factor: { numerator: 1_000_000, denominator: 1 } },
  oz: { dimension: "mass", canonical: "oz", factor: { numerator: 28_349_523_125, denominator: 1_000_000 } },
  lb: { dimension: "mass", canonical: "lb", factor: { numerator: 453_592_370_000, denominator: 1_000_000 } },
  lbs: { dimension: "mass", canonical: "lb", factor: { numerator: 453_592_370_000, denominator: 1_000_000 } },
  tsp: { dimension: "volume", canonical: "tsp", factor: { numerator: 5, denominator: 1 } },
  tbsp: { dimension: "volume", canonical: "tbsp", factor: { numerator: 15, denominator: 1 } },
  "fl oz": { dimension: "volume", canonical: "fl oz", factor: { numerator: 2_957_352_956_250, denominator: 100_000_000_000 } },
  cup: { dimension: "volume", canonical: "cup", factor: { numerator: 250, denominator: 1 } },
  ml: { dimension: "volume", canonical: "mL", factor: { numerator: 1, denominator: 1 } },
  l: { dimension: "volume", canonical: "L", factor: { numerator: 1_000, denominator: 1 } },
};

type BigRational = { numerator: bigint; denominator: bigint };

function normalizeBig(value: BigRational): BigRational | null {
  if (value.denominator === BigInt(0)) return null;
  const sign = value.denominator < BigInt(0) ? BigInt(-1) : BigInt(1);
  const numerator = value.numerator * sign;
  const denominator = value.denominator * sign;
  const divisor = greatestCommonDivisorBig(numerator < BigInt(0) ? -numerator : numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function greatestCommonDivisorBig(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== BigInt(0)) [a, b] = [b, a % b];
  return a || BigInt(1);
}

function fromBig(value: BigRational | null): Rational | null {
  if (!value || value.numerator > BigInt(Number.MAX_SAFE_INTEGER) || value.numerator < BigInt(Number.MIN_SAFE_INTEGER) ||
      value.denominator > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { numerator: Number(value.numerator), denominator: Number(value.denominator) };
}

function normalize(value: Rational): Rational | null {
  if (!Number.isSafeInteger(value.numerator) || !Number.isSafeInteger(value.denominator) || value.denominator === 0) {
    return null;
  }
  return fromBig(normalizeBig({ numerator: BigInt(value.numerator), denominator: BigInt(value.denominator) }));
}

function asBig(value: Rational): BigRational {
  return { numerator: BigInt(value.numerator), denominator: BigInt(value.denominator) };
}

function add(left: Rational, right: Rational): Rational | null {
  const a = asBig(left);
  const b = asBig(right);
  return fromBig(normalizeBig({
    numerator: a.numerator * b.denominator + b.numerator * a.denominator,
    denominator: a.denominator * b.denominator,
  }));
}

function multiply(left: Rational, right: Rational): Rational | null {
  const a = asBig(left);
  const b = asBig(right);
  return fromBig(normalizeBig({ numerator: a.numerator * b.numerator, denominator: a.denominator * b.denominator }));
}

function divide(left: Rational, right: Rational): Rational | null {
  const a = asBig(left);
  const b = asBig(right);
  return fromBig(normalizeBig({ numerator: a.numerator * b.denominator, denominator: a.denominator * b.numerator }));
}

function parseNumber(value: string): Rational | null {
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/u.exec(value);
  if (mixed) {
    const denominator = BigInt(mixed[3]);
    return fromBig(normalizeBig({
      numerator: BigInt(mixed[1]) * denominator + BigInt(mixed[2]),
      denominator,
    }));
  }
  const fraction = /^(\d+)\/(\d+)$/u.exec(value);
  if (fraction) {
    return fromBig(normalizeBig({ numerator: BigInt(fraction[1]), denominator: BigInt(fraction[2]) }));
  }
  const decimal = /^(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!decimal) return null;
  const decimalPart = decimal[2] ?? "";
  return fromBig(normalizeBig({
    numerator: BigInt(`${decimal[1]}${decimalPart}`),
    denominator: BigInt(10) ** BigInt(decimalPart.length),
  }));
}

function parseQuantity(value: string): ParsedQuantity | IngredientQuantityFailure {
  const trimmed = value.trim();
  if (!trimmed) return "empty";
  const numberOnly = /^(\d+(?:\.\d+)?|\d+\/\d+|\d+\s+\d+\/\d+)$/u.test(trimmed);
  if (numberOnly) return "missing-unit";
  const match = /^(\d+(?:\.\d+)?|\d+\/\d+|\d+\s+\d+\/\d+)\s+(fl oz|mg|kg|lbs?|oz|g|tsp|tbsp|cups?|ml|mL|l|L)$/iu.exec(trimmed);
  if (!match) return "unparseable";
  const quantity = parseNumber(match[1]);
  if (!quantity) return "unparseable";
  const rawUnit = match[2].toLocaleLowerCase("en-CA");
  const unitKey = rawUnit === "lbs" ? "lb" : rawUnit === "cups" ? "cup" : rawUnit;
  const unit = UNITS[unitKey];
  return unit ? { quantity, unit } : "unparseable";
}

function pluralizedUnit(unit: string, quantity: Rational): string {
  if (["mg", "g", "kg", "oz", "lb", "tsp", "tbsp", "mL", "L", "fl oz"].includes(unit)) return unit;
  if (quantity.numerator === quantity.denominator) return unit;
  return `${unit}s`;
}

export function formatIngredientQuantity(quantity: Rational, unit: string): string {
  const normalized = normalize(quantity);
  if (!normalized) return "Amount unavailable";
  const whole = Math.floor(normalized.numerator / normalized.denominator);
  const remainder = normalized.numerator % normalized.denominator;
  const number = remainder === 0
    ? whole.toString()
    : whole === 0
      ? `${remainder}/${normalized.denominator}`
      : `${whole} ${remainder}/${normalized.denominator}`;
  return `${number} ${pluralizedUnit(unit, normalized)}`;
}

/**
 * Adds only standardized quantities. Any modifier, range, yield state, or
 * unrecognized unit deliberately returns an abstention for literal display.
 */
function sumIngredientQuantitiesUnchecked(amounts: readonly string[]): IngredientQuantitySum {
  if (amounts.length === 0) return { ok: false, reason: "empty" };
  const parsed: ParsedQuantity[] = [];
  for (const amount of amounts) {
    const result = parseQuantity(amount);
    if (typeof result === "string") return { ok: false, reason: result };
    parsed.push(result);
  }
  const first = parsed[0];
  if (parsed.some((value) => value.unit.dimension !== first.unit.dimension)) {
    return { ok: false, reason: "incompatible-unit" };
  }
  const displayUnit = parsed.every((value) => value.unit.canonical === first.unit.canonical)
    ? first.unit.canonical
    : first.unit.dimension === "mass" ? "g" : "mL";
  const displayDefinition = UNITS[displayUnit.toLocaleLowerCase("en-CA")];
  let quantity: Rational = { numerator: 0, denominator: 1 };
  for (const value of parsed) {
    const factored = multiply(value.quantity, value.unit.factor);
    const converted = factored && divide(factored, displayDefinition.factor);
    const next = converted && add(quantity, converted);
    if (!next) return { ok: false, reason: "overflow" };
    quantity = next;
  }
  return { ok: true, quantity, unit: displayUnit, display: formatIngredientQuantity(quantity, displayUnit) };
}

export function sumIngredientQuantities(amounts: readonly string[]): IngredientQuantitySum {
  try {
    return sumIngredientQuantitiesUnchecked(amounts);
  } catch {
    // This helper is a display projection over user-authored literals. Resource
    // limits or unsupported numeric forms must abstain, never break Prep.
    return { ok: false, reason: "overflow" };
  }
}
