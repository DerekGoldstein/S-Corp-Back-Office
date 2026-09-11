/**
 * MACRS depreciation as PURE ARITHMETIC — no percentage tables are stored
 * anywhere (guardrail 1: the only IRS data in this file is the definition of
 * the method itself). We compute by the declining-balance formula with the
 * switch to straight line, an IRS-permitted alternative to the Pub 946
 * percentage tables (which are themselves this arithmetic rounded to four
 * digits). On round bases the results coincide with the familiar table
 * values (5-yr 200DB HY: 20 / 32 / 19.2 / 11.52 / 11.52 / 5.76); on odd
 * bases the formula is exact to the cent and the schedule ALWAYS sums to
 * the basis (the final year absorbs the integer remainder).
 *
 * Conventions are also arithmetic: half-year = 4/8 of a year; mid-quarter
 * for quarter q = (9 − 2q)/8 (midpoint of quarter q to year end), per
 * §168(d). Everything runs in eighths of a year so both are exact.
 *
 * Scope: GDS personal property, 3/5/7/10/15/20-year classes. Real property
 * (mid-month, 27.5/39-yr) and listed-property/luxury-auto caps are out of
 * scope — the register refuses them rather than approximating.
 */
import type { Cents } from "../lib/cents";

export type MacrsMethod = "macrs_200db" | "macrs_150db" | "sl";
export type Convention = "half_year" | "mid_quarter";
export type RecoveryYears = 3 | 5 | 7 | 10 | 15 | 20;

export class MacrsError extends Error {}

/** Exact half-up division of positive bigints. */
function divHalfUp(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new MacrsError("division by non-positive denominator");
  return (num * 2n + den) / (den * 2n);
}

/** First-year fraction in eighths of a year for a convention. */
export function firstYearEighths(convention: Convention, quarter?: 1 | 2 | 3 | 4): bigint {
  if (convention === "half_year") return 4n;
  if (!quarter) throw new MacrsError("mid-quarter convention needs the placed-in-service quarter");
  return BigInt(9 - 2 * quarter); // Q1 7/8, Q2 5/8, Q3 3/8, Q4 1/8
}

export function quarterOf(isoDate: string): 1 | 2 | 3 | 4 {
  const m = Number(isoDate.slice(5, 7));
  return (Math.ceil(m / 3) as 1 | 2 | 3 | 4);
}

/**
 * The full year-by-year schedule for a depreciable basis (already reduced by
 * §179 and bonus). Index 0 is the placed-in-service year. Sums exactly to
 * `basis`; length is recoveryYears + 1 (a convention always pushes a tail
 * into the year after the recovery period).
 */
export function macrsSchedule(opts: {
  basis: Cents;
  method: MacrsMethod;
  recoveryYears: RecoveryYears;
  convention: Convention;
  quarter?: 1 | 2 | 3 | 4;
}): Cents[] {
  const { basis, method, recoveryYears, convention, quarter } = opts;
  if (basis < 0n) throw new MacrsError("basis must be non-negative");
  if (basis === 0n) return [];
  const life = BigInt(recoveryYears);
  const life8 = life * 8n; // recovery period in eighths of a year
  // Declining-balance factor: 200% => 2/1, 150% => 3/2; straight line has none.
  const dbNum = method === "macrs_200db" ? 2n : method === "macrs_150db" ? 3n : 0n;
  const dbDen = method === "macrs_150db" ? 2n : 1n;

  const first8 = firstYearEighths(convention, quarter);
  const out: Cents[] = [];
  let remaining = basis;
  let elapsed8 = 0n;
  for (let year = 1; remaining > 0n; year++) {
    if (year > recoveryYears + 2) throw new MacrsError("schedule failed to terminate");
    const frac8 = year === 1 ? first8 : life8 - elapsed8 < 8n ? life8 - elapsed8 : 8n;
    const remLife8 = life8 - elapsed8;
    let amount: Cents;
    if (remLife8 <= frac8) {
      amount = remaining; // recovery period ends inside this year: take the rest
    } else {
      // straight line on the remaining basis over the remaining life,
      // prorated by this year's fraction — recomputed yearly, so rounding
      // self-corrects and the switch happens exactly when SL >= DB
      const sl = divHalfUp(remaining * frac8, remLife8);
      if (dbNum === 0n) {
        amount = sl;
      } else {
        const db = divHalfUp(remaining * dbNum * frac8, dbDen * life * 8n);
        amount = db > sl ? db : sl;
      }
      if (amount > remaining) amount = remaining;
    }
    out.push(amount);
    remaining -= amount;
    elapsed8 += frac8;
  }
  return out;
}

/**
 * §168(d)(3) mid-quarter test for a placement-year cohort: mid-quarter
 * applies when more than 40% of the aggregate depreciable basis (after §179,
 * before bonus — Reg. §1.168(d)-1) is placed in service in the fourth
 * quarter. Strict inequality: exactly 40% stays half-year.
 */
export function midQuarterTest(
  cohort: Array<{ basisAfter179: Cents; quarter: 1 | 2 | 3 | 4 }>,
): Convention {
  const total = cohort.reduce((a, c) => a + c.basisAfter179, 0n);
  if (total <= 0n) return "half_year";
  const q4 = cohort.filter((c) => c.quarter === 4).reduce((a, c) => a + c.basisAfter179, 0n);
  return q4 * 5n > total * 2n ? "mid_quarter" : "half_year"; // q4/total > 40%
}
