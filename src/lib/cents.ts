/**
 * Money = integer cents as native bigint, end to end (CLAUDE.md).
 * bigint mixes with number only by throwing — which is exactly the guardrail
 * we want: no float can silently touch an amount. The ledger keeps cents;
 * IRS whole-dollar rounding happens only in workpapers via roundToWholeDollars,
 * and every rounding step is recorded in the computation trace by callers.
 */

export type Cents = bigint;

export const ZERO: Cents = 0n;

const DOLLARS_RE = /^([+-]?)\$?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/;
const PAREN_RE = /^\((.*)\)$/; // (123.45) = negative, common in bank CSVs

/** Parse a dollars string ("1,234.56", "-45.6", "(12.00)", "$3") to cents. */
export function parseDollars(input: string): Cents {
  let s = input.trim();
  if (s === "") throw new Error("empty amount");
  let negate = false;
  const paren = PAREN_RE.exec(s);
  if (paren) {
    negate = true;
    s = paren[1]!.trim();
  }
  const m = DOLLARS_RE.exec(s);
  if (!m) throw new Error(`unparseable dollar amount: ${JSON.stringify(input)}`);
  const sign = m[1] === "-" !== negate ? -1n : 1n;
  const whole = BigInt(m[2]!.replaceAll(",", ""));
  const fracRaw = m[3] ?? "";
  const frac = BigInt(fracRaw.padEnd(2, "0") || "0");
  return sign * (whole * 100n + frac);
}

/** Strict conversion of an integer (cents) in number/string/bigint form. */
export function asCents(v: number | string | bigint): Cents {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`not an integer cent amount: ${v}`);
    return BigInt(v);
  }
  if (!/^[+-]?\d+$/.test(v.trim())) throw new Error(`not an integer cent amount: ${v}`);
  return BigInt(v.trim());
}

/** "1,234.56" / "-0.07"; always two decimals, no currency symbol. */
export function formatCents(c: Cents): string {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${wholeStr}.${frac}`;
}

/** "$1,234.56" / "($0.07)" accounting style for reports. */
export function formatAccounting(c: Cents): string {
  const s = `$${formatCents(c < 0n ? -c : c)}`;
  return c < 0n ? `(${s})` : s;
}

export function sumCents(xs: Iterable<Cents>): Cents {
  let total = 0n;
  for (const x of xs) total += x;
  return total;
}

/**
 * Split a total by integer weights with the largest-remainder method.
 * The parts always sum exactly to the total; remainders are distributed to
 * the largest fractional shares first (ties: earliest index).
 */
export function allocate(total: Cents, weights: readonly bigint[]): Cents[] {
  if (weights.length === 0) throw new Error("allocate: no weights");
  if (weights.some((w) => w < 0n)) throw new Error("allocate: negative weight");
  const weightSum = sumCents(weights);
  if (weightSum === 0n) throw new Error("allocate: zero total weight");
  const neg = total < 0n;
  const absTotal = neg ? -total : total;
  const base = weights.map((w) => (absTotal * w) / weightSum);
  const remainders = weights.map((w, i) => ({ i, r: (absTotal * w) % weightSum }));
  let leftover = absTotal - sumCents(base);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (leftover === 0n) break;
    base[i] = base[i]! + 1n;
    leftover -= 1n;
  }
  return neg ? base.map((x) => -x) : base;
}

/**
 * The meals 50% limitation split (approved design decision): the DISALLOWED
 * half takes the odd cent — deducting the smaller half is the conservative
 * reading. splitHalf(101) = { deductible: 50, disallowed: 51 }.
 */
export function splitHalf(total: Cents): { deductible: Cents; disallowed: Cents } {
  if (total < 0n) throw new Error("splitHalf expects a non-negative total");
  const deductible = total / 2n;
  return { deductible, disallowed: total - deductible };
}

/**
 * IRS whole-dollar rounding (workpapers only, never the ledger):
 * 49 cents down, 50 cents up, half away from zero. Returns cents.
 */
export function roundToWholeDollars(c: Cents): Cents {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  const rounded = ((abs + 50n) / 100n) * 100n;
  return neg ? -rounded : rounded;
}

/** For JSON payloads / traces: cents as decimal string. */
export function centsToJSON(c: Cents): string {
  return c.toString();
}
