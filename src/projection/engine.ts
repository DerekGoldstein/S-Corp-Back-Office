/**
 * Owner-level projection (§4.7). The S-corp pays no federal quarterly income
 * tax — the pain is the owner's 1040-ES / IT-2105 — and December payroll
 * withholding is treated by the IRS as paid evenly through the year, so a
 * single over-withholding on the December check cures Q1–Q3 shortfalls.
 * This engine produces exactly that recommendation.
 *
 * PROJECTION, not preparation: brackets and safe-harbor percentages come
 * from verified per-year tables; simplifications (QBI approximation, no
 * NIIT/AMT) are declared in `assumptions` on every result. The owner and
 * CPA see the assumptions with the number, never a silently wrong figure.
 */
import type { Cents } from "../lib/cents";
import { formatCents } from "../lib/cents";
import { applyRate, type Bracket } from "../payroll/engine";

export class ProjectionError extends Error {}

export type Fed1040Table = {
  brackets_by_status: Record<string, Bracket[]>;
  standard_deduction_cents_by_status: Record<string, number>;
  additional_medicare_rate: string;
  additional_medicare_threshold_by_status: Record<string, number>;
  qbi_rate: string; // §199A simplified: rate × min(QBI, taxable before QBI)
};

export type NyPersonalTable = {
  nys_brackets_by_status: Record<string, Bracket[]>;
  nys_standard_deduction_cents_by_status: Record<string, number>;
  nyc_brackets_by_status: Record<string, Bracket[]>;
};

export type SafeHarborTable = {
  current_year_pct: string; // "0.90"
  prior_year_pct: string; // "1.00"
  prior_year_pct_high_agi: string; // "1.10"
  high_agi_threshold_cents: number;
};

export type ProjectionTables = {
  fed_1040: Fed1040Table;
  ny_personal: NyPersonalTable;
  safe_harbor: SafeHarborTable;
};

export type ProjectionInput = {
  taxYear: number;
  filingStatus: "single" | "married_joint" | "head_of_household";
  nycResident: boolean;
  /** planned W-2 Box 1 (gross + 2% health − deferral) */
  plannedBox1Wages: Cents;
  /** medicare wages for the owner-level Additional Medicare check */
  plannedMedicareWages: Cents;
  /** entity ordinary income passing through (YTD annualized + expected) */
  passThroughOrdinary: Cents;
  /** separately stated pass-through (interest, gains, ...) */
  passThroughPortfolio: Cents;
  /** other household income (spouse W-2, bank interest, ...) */
  otherIncome: Cents;
  /** 2%-shareholder premiums → self-employed health insurance deduction */
  healthPremiums: Cents;
  otherAdjustments: Cents; // other above-the-line deductions
  itemizedDeductions: Cents; // 0 = use standard
  /** withholding already done or planned before December (usually 0) */
  ytdFederalWithholding: Cents;
  ytdNysWithholding: Cents;
  ytdNycWithholding: Cents;
  federalEstimatedPaymentsMade: Cents;
  nyEstimatedPaymentsMade: Cents;
  priorYearFederalTax: Cents;
  priorYearAgi: Cents;
  priorYearNyTax: Cents;
  /** most FIT the December check can carry (net pay floor) */
  maxDecemberFederalWithholding: Cents;
  maxDecemberNyWithholding: Cents;
};

export type ProjectionResult = {
  agi: Cents;
  federalTaxableIncome: Cents;
  qbiDeduction: Cents;
  federalTax: Cents;
  additionalMedicare: Cents;
  nysTax: Cents;
  nycTax: Cents;
  federalSafeHarborTarget: Cents;
  nySafeHarborTarget: Cents;
  recommendedDecemberFederalWithholding: Cents;
  residualFederalEstimated: Cents;
  recommendedDecemberNyWithholding: Cents;
  residualNyEstimated: Cents;
  assumptions: string[];
  trace: Array<{ step: string; detail: string; amount: string }>;
};

function bracketTax(taxable: Cents, brackets: Bracket[], what: string): Cents {
  if (taxable <= 0n) return 0n;
  let chosen: Bracket | undefined;
  for (const b of [...brackets].sort((a, z) => a.over_cents - z.over_cents)) {
    if (taxable > BigInt(b.over_cents)) chosen = b;
  }
  if (!chosen) return 0n;
  return BigInt(chosen.base_cents) + applyRate(taxable - BigInt(chosen.over_cents), chosen.rate);
}

const max0 = (x: Cents): Cents => (x > 0n ? x : 0n);
const minC = (a: Cents, b: Cents): Cents => (a < b ? a : b);

export function computeProjection(
  input: ProjectionInput,
  tables: ProjectionTables,
): ProjectionResult {
  const trace: ProjectionResult["trace"] = [];
  const t = (step: string, detail: string, amount: Cents) =>
    trace.push({ step, detail, amount: formatCents(amount) });
  const assumptions = [
    "PROJECTION for estimated-payment planning — not return preparation.",
    "QBI (§199A) approximated as rate × min(qualified pass-through income, taxable income before QBI); wage/UBIA limitations and the SSTB phase-out are not modeled.",
    "NIIT, AMT, and credits are not modeled — add expected amounts to prior-year figures if material.",
    "NYS/NYC computed with standard deductions and resident brackets; no NY itemized adjustments.",
  ];
  const status = input.filingStatus;
  const fed = tables.fed_1040;

  // --- AGI ------------------------------------------------------------------
  const totalIncome =
    input.plannedBox1Wages +
    input.passThroughOrdinary +
    input.passThroughPortfolio +
    input.otherIncome;
  const agi = totalIncome - input.healthPremiums - input.otherAdjustments;
  t("agi", "wages + pass-through + other − SEHI − adjustments", agi);

  // --- federal --------------------------------------------------------------
  const standard = BigInt(fed.standard_deduction_cents_by_status[status] ?? 0);
  const deduction = input.itemizedDeductions > standard ? input.itemizedDeductions : standard;
  const taxableBeforeQbi = max0(agi - deduction);
  const qbiBase = max0(input.passThroughOrdinary); // consulting S-corp income + investee ordinary
  const qbiDeduction = applyRate(minC(qbiBase, taxableBeforeQbi), fed.qbi_rate);
  const federalTaxableIncome = max0(taxableBeforeQbi - qbiDeduction);
  const fedBrackets = fed.brackets_by_status[status];
  if (!fedBrackets) throw new ProjectionError(`fed_1040 table missing ${status} brackets`);
  const regularTax = bracketTax(federalTaxableIncome, fedBrackets, "federal");
  const amThreshold = BigInt(fed.additional_medicare_threshold_by_status[status] ?? 0);
  const additionalMedicare = applyRate(
    max0(input.plannedMedicareWages - amThreshold),
    fed.additional_medicare_rate,
  );
  const federalTax = regularTax + additionalMedicare;
  t("federal", `taxable ${formatCents(federalTaxableIncome)} after QBI ${formatCents(qbiDeduction)}`, federalTax);

  // --- NY -------------------------------------------------------------------
  const ny = tables.ny_personal;
  const nysStandard = BigInt(ny.nys_standard_deduction_cents_by_status[status] ?? 0);
  const nyTaxable = max0(agi - nysStandard);
  const nysBrackets = ny.nys_brackets_by_status[status];
  if (!nysBrackets) throw new ProjectionError(`ny_personal table missing NYS ${status} brackets`);
  const nysTax = bracketTax(nyTaxable, nysBrackets, "NYS");
  let nycTax = 0n;
  if (input.nycResident) {
    const nycBrackets = ny.nyc_brackets_by_status[status];
    if (!nycBrackets) throw new ProjectionError(`ny_personal table missing NYC ${status} brackets`);
    nycTax = bracketTax(nyTaxable, nycBrackets, "NYC");
  }
  t("ny", `NYS taxable ${formatCents(nyTaxable)}`, nysTax + nycTax);

  // --- safe harbor ----------------------------------------------------------
  const sh = tables.safe_harbor;
  const priorPct =
    input.priorYearAgi > BigInt(sh.high_agi_threshold_cents)
      ? sh.prior_year_pct_high_agi
      : sh.prior_year_pct;
  const federalSafeHarborTarget = minC(
    applyRate(federalTax, sh.current_year_pct),
    applyRate(input.priorYearFederalTax, priorPct),
  );
  const nySafeHarborTarget = minC(
    applyRate(nysTax + nycTax, sh.current_year_pct),
    applyRate(input.priorYearNyTax, priorPct),
  );
  t("safe_harbor", `lesser of ${sh.current_year_pct}×current or ${priorPct}×prior`, federalSafeHarborTarget);

  // --- December withholding recommendation ------------------------------------
  // Withholding is treated as paid evenly through the year, so the December
  // check can cure Q1–Q3; estimated payments cannot (they count when paid).
  const federalNeed = max0(
    federalSafeHarborTarget - input.ytdFederalWithholding - input.federalEstimatedPaymentsMade,
  );
  const recommendedDecemberFederalWithholding = minC(
    federalNeed,
    input.maxDecemberFederalWithholding,
  );
  const residualFederalEstimated = federalNeed - recommendedDecemberFederalWithholding;
  const nyNeed = max0(
    nySafeHarborTarget -
      input.ytdNysWithholding -
      input.ytdNycWithholding -
      input.nyEstimatedPaymentsMade,
  );
  const recommendedDecemberNyWithholding = minC(nyNeed, input.maxDecemberNyWithholding);
  const residualNyEstimated = nyNeed - recommendedDecemberNyWithholding;
  t(
    "december",
    "withholding override to request on the December run (§4.4 step 5)",
    recommendedDecemberFederalWithholding,
  );
  if (residualFederalEstimated > 0n || residualNyEstimated > 0n) {
    assumptions.push(
      `wages cannot carry the full need: pay the residual by 1040-ES (${formatCents(residualFederalEstimated)}) / IT-2105 (${formatCents(residualNyEstimated)}) — timing matters for those.`,
    );
  }

  return {
    agi,
    federalTaxableIncome,
    qbiDeduction,
    federalTax,
    additionalMedicare,
    nysTax,
    nycTax,
    federalSafeHarborTarget,
    nySafeHarborTarget,
    recommendedDecemberFederalWithholding,
    residualFederalEstimated,
    recommendedDecemberNyWithholding,
    residualNyEstimated,
    assumptions,
    trace,
  };
}
