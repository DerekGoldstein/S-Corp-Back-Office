/**
 * Payroll compute engine (§4.4) — PURE: verified tables and inputs in,
 * result + trace out. No rate lives here; every number comes from the
 * per-year tables the owner verified. Money is bigint cents; rates are
 * decimal strings multiplied exactly (rational math, half-up at each
 * documented step). The §4.4 order is followed literally, and every step
 * names the wage base it uses.
 */
import type { Cents } from "../lib/cents";
import { formatCents } from "../lib/cents";

export class PayrollError extends Error {}

// --- exact rate math --------------------------------------------------------

/** "0.062" → {num: 62n, den: 1000n}; refuses floats-by-accident like "6.2e-2". */
export function parseRate(rate: string): { num: bigint; den: bigint } {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(rate);
  if (!m) throw new PayrollError(`unparseable rate ${JSON.stringify(rate)} (decimal string required)`);
  const frac = m[2] ?? "";
  return { num: BigInt(m[1]! + frac), den: 10n ** BigInt(frac.length) };
}

/** amount × rate, half-up to the cent. */
export function applyRate(amount: Cents, rate: string): Cents {
  const { num, den } = parseRate(rate);
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const out = (abs * num + den / 2n) / den;
  return neg ? -out : out;
}

function minC(a: Cents, b: Cents): Cents {
  return a < b ? a : b;
}
function maxC(a: Cents, b: Cents): Cents {
  return a > b ? a : b;
}

// --- table payload shapes (verified per year; see data/tax-tables/README) ---

export type FicaTable = {
  social_security_rate: string;
  social_security_wage_base_cents: number;
  medicare_rate: string;
  additional_medicare_rate: string;
  additional_medicare_threshold_cents: number;
};

export type Bracket = { over_cents: number; base_cents: number; rate: string };

export type Pub15tTable = {
  /** annual-period percentage-method schedules, keyed by filing status,
   *  standard vs step-2-checkbox — straight from the year's Pub 15-T */
  schedules: Record<string, Bracket[]>;
};

export type NyWithholdingTable = {
  deduction_cents_by_status: Record<string, number>;
  per_allowance_cents: number;
  brackets_by_status: Record<string, Bracket[]>;
};

export type FutaTable = {
  rate: string;
  wage_base_cents: number;
  ny_credit_reduction_rate: string; // "0" when NY is not a credit-reduction state
};

export type SuiTable = {
  wage_base_cents: number;
  employer_rate: string; // from the NYS DOL rate notice
  reemployment_fund_rate: string;
};

export type Limits401kTable = {
  elective_deferral_limit_cents: number;
  catch_up_50_limit_cents: number;
  annual_additions_415c_limit_cents: number;
  compensation_cap_cents: number;
  employer_pct_of_comp: string; // per the plan document (config decision, Q6)
};

export type PayrollTables = {
  fica: FicaTable;
  pub15t: Pub15tTable;
  nys50t_nys: NyWithholdingTable;
  nys50t_nyc: NyWithholdingTable;
  futa: FutaTable;
  ny_sui: SuiTable;
  limits_401k: Limits401kTable;
};

// --- inputs -----------------------------------------------------------------

export type FilingStatus = "single" | "married_joint" | "head_of_household";

export type PayrollInput = {
  taxYear: number;
  payDate: string;
  grossWages: Cents; // from §4.3 (or logged override)
  healthPremium2pct: Cents; // §4.4: FIT/NYS/NYC wages + W-2 Box 1/14 only
  suiIncludesHealth: boolean; // NYS DOL answer, stored as configuration
  deferral401k: Cents;
  catchUpEligible: boolean;
  employer401kTarget: Cents;
  /** plan-document compensation for the employer 25% cap (config, Q6) */
  employerCompBase: Cents;
  w4: {
    filingStatus: FilingStatus;
    step2: boolean;
    step3AnnualCredits: Cents;
    step4aOtherIncome: Cents;
    step4bDeductions: Cents;
    step4cExtra: Cents;
  };
  it2104: {
    nysAllowances: number;
    nycAllowances: number;
    nysExtra: Cents;
    nycExtra: Cents;
    nycResident: boolean;
  };
  /** §4.7 December over-withholding recommendation lands here */
  additionalFitWithholding: Cents;
  ytd?: { ficaWages: Cents; futaWages: Cents; suiWages: Cents };
};

export type PayrollResult = {
  wageBases: {
    fit: Cents;
    nys: Cents;
    nyc: Cents;
    fica: Cents;
    futa: Cents;
    sui: Cents;
  };
  employee: {
    socialSecurity: Cents;
    medicare: Cents;
    additionalMedicare: Cents;
    fitWithheld: Cents;
    nysWithheld: Cents;
    nycWithheld: Cents;
    deferral401k: Cents;
  };
  employer: {
    socialSecurity: Cents;
    medicare: Cents;
    futa: Cents;
    sui: Cents;
    contribution401k: Cents;
  };
  netPay: Cents;
  limits: {
    deferralCap: Cents;
    employerCap: Cents;
    annualAdditionsCap: Cents;
    employerHeadroom: Cents;
  };
  warnings: string[];
  trace: Array<{ step: string; base?: string; detail: string; amount: string }>;
};

function bracketTax(taxable: Cents, brackets: Bracket[], what: string): Cents {
  if (taxable <= 0n) return 0n;
  const sorted = [...brackets].sort((a, b) => a.over_cents - b.over_cents);
  let chosen: Bracket | undefined;
  for (const b of sorted) {
    if (taxable > BigInt(b.over_cents)) chosen = b;
  }
  if (!chosen) return 0n;
  const excess = taxable - BigInt(chosen.over_cents);
  const tax = BigInt(chosen.base_cents) + applyRate(excess, chosen.rate);
  if (tax < 0n) throw new PayrollError(`${what}: negative bracket tax`);
  return tax;
}

/** §4.4 pay-run computation, steps 1–8, annual pay period. */
export function computePayroll(input: PayrollInput, tables: PayrollTables): PayrollResult {
  const warnings: string[] = [];
  const trace: PayrollResult["trace"] = [];
  const t = (step: string, detail: string, amount: Cents, base?: string) =>
    trace.push({ step, base, detail, amount: formatCents(amount) });

  if (input.grossWages <= 0n) throw new PayrollError("gross wages must be positive");
  if (input.healthPremium2pct < 0n || input.deferral401k < 0n) {
    throw new PayrollError("negative inputs");
  }

  // 1–2: gross + health premium into the income-tax bases ONLY (guardrail 7)
  const gross = input.grossWages;
  const health = input.healthPremium2pct;
  const fitWages = gross + health;
  const nysWages = gross + health;
  const nycWages = input.it2104.nycResident ? gross + health : 0n;
  const ficaWages = gross;
  const futaWages = gross;
  const suiWages = input.suiIncludesHealth ? gross + health : gross;
  t("2.wage_bases", "2% health added to FIT/NYS/NYC only; FICA/FUTA exclude it; SUI per DOL config", health, "health");

  // 3: 401(k) deferral — income-tax bases only, never FICA/FUTA/SUI
  const limits = tables.limits_401k;
  const deferralCap =
    BigInt(limits.elective_deferral_limit_cents) +
    (input.catchUpEligible ? BigInt(limits.catch_up_50_limit_cents) : 0n);
  if (input.deferral401k > deferralCap) {
    throw new PayrollError(
      `401(k) deferral ${formatCents(input.deferral401k)} exceeds the ${input.taxYear} cap ${formatCents(deferralCap)}`,
    );
  }
  if (input.deferral401k > gross) throw new PayrollError("deferral exceeds gross wages");
  const fitTaxable = fitWages - input.deferral401k;
  const nysTaxable = nysWages - input.deferral401k;
  const nycTaxable = nycWages > 0n ? nycWages - input.deferral401k : 0n;
  t("3.deferral", "reduces FIT/NYS/NYC taxable wages only", input.deferral401k);

  // 4: employee FICA on fica_wages, SS capped by YTD, Additional Medicare over threshold
  const fica = tables.fica;
  const ytdFica = input.ytd?.ficaWages ?? 0n;
  const ssBase = BigInt(fica.social_security_wage_base_cents);
  const ssTaxable = maxC(0n, minC(ficaWages, ssBase - minC(ytdFica, ssBase)));
  const eeSS = applyRate(ssTaxable, fica.social_security_rate);
  const eeMedicare = applyRate(ficaWages, fica.medicare_rate);
  const amThreshold = BigInt(fica.additional_medicare_threshold_cents);
  const amTaxable =
    maxC(0n, ytdFica + ficaWages - amThreshold) - maxC(0n, ytdFica - amThreshold);
  const eeAdditionalMedicare = applyRate(amTaxable, fica.additional_medicare_rate);
  t("4.ee_ss", `on ${formatCents(ssTaxable)} (wage base ${formatCents(ssBase)}, ytd ${formatCents(ytdFica)})`, eeSS, "fica");
  t("4.ee_medicare", "on full fica wages", eeMedicare, "fica");
  t("4.ee_addl_medicare", `on ${formatCents(amTaxable)} over the ${formatCents(amThreshold)} threshold`, eeAdditionalMedicare, "fica");

  // 5: FIT per Pub 15-T percentage method (annual period), W-4 2020+
  const scheduleKey = `${input.w4.filingStatus}_${input.w4.step2 ? "step2" : "standard"}`;
  const schedule = tables.pub15t.schedules[scheduleKey];
  if (!schedule) {
    throw new PayrollError(
      `pub15t table has no schedule ${scheduleKey} — the year's table file is incomplete`,
    );
  }
  const adjustedAnnualWage = maxC(
    0n,
    fitTaxable + input.w4.step4aOtherIncome - input.w4.step4bDeductions,
  );
  let fit = bracketTax(adjustedAnnualWage, schedule, "FIT");
  fit = maxC(0n, fit - input.w4.step3AnnualCredits);
  fit = fit + input.w4.step4cExtra + input.additionalFitWithholding;
  t(
    "5.fit",
    `pub15t ${scheduleKey} on AAW ${formatCents(adjustedAnnualWage)}; −step3 credits, +step4c, +§4.7 override ${formatCents(input.additionalFitWithholding)}`,
    fit,
    "fit",
  );

  // 6: NYS and NYC withholding (exact-calculation shapes)
  const nysT = tables.nys50t_nys;
  const statusKey = input.w4.filingStatus === "married_joint" ? "married" : "single";
  const nysDeduction = BigInt(nysT.deduction_cents_by_status[statusKey] ?? 0);
  const nysAllowances = BigInt(input.it2104.nysAllowances) * BigInt(nysT.per_allowance_cents);
  const nysTaxableAfter = maxC(0n, nysTaxable - nysDeduction - nysAllowances);
  const nysBrackets = nysT.brackets_by_status[statusKey];
  if (!nysBrackets) throw new PayrollError(`nys50t_nys missing brackets for ${statusKey}`);
  const nys = bracketTax(nysTaxableAfter, nysBrackets, "NYS") + input.it2104.nysExtra;
  t("6.nys", `on ${formatCents(nysTaxableAfter)} after deduction/allowances`, nys, "nys");
  let nyc = 0n;
  if (input.it2104.nycResident) {
    const nycT = tables.nys50t_nyc;
    const nycDeduction = BigInt(nycT.deduction_cents_by_status[statusKey] ?? 0);
    const nycAllowances = BigInt(input.it2104.nycAllowances) * BigInt(nycT.per_allowance_cents);
    const nycTaxableAfter = maxC(0n, nycTaxable - nycDeduction - nycAllowances);
    const nycBrackets = nycT.brackets_by_status[statusKey];
    if (!nycBrackets) throw new PayrollError(`nys50t_nyc missing brackets for ${statusKey}`);
    nyc = bracketTax(nycTaxableAfter, nycBrackets, "NYC") + input.it2104.nycExtra;
    t("6.nyc", `on ${formatCents(nycTaxableAfter)} after deduction/allowances`, nyc, "nyc");
  }

  // 7: net pay (health is non-cash here; owner-paid premiums flow via §4.8)
  const netPay =
    gross - eeSS - eeMedicare - eeAdditionalMedicare - fit - nys - nyc - input.deferral401k;
  if (netPay < 0n) {
    throw new PayrollError(
      `net pay is negative (${formatCents(netPay)}) — the §4.7 withholding override exceeds what the wage can carry; reduce it and pay the residual by 1040-ES`,
    );
  }
  t("7.net_pay", "gross − EE taxes − withholding − deferral", netPay);

  // 8: employer side
  const erSS = applyRate(ssTaxable, fica.social_security_rate);
  const erMedicare = applyRate(ficaWages, fica.medicare_rate); // no employer Additional Medicare
  const futaT = tables.futa;
  const ytdFuta = input.ytd?.futaWages ?? 0n;
  const futaBase = BigInt(futaT.wage_base_cents);
  const futaTaxable = maxC(0n, minC(futaWages, futaBase - minC(ytdFuta, futaBase)));
  const futa =
    applyRate(futaTaxable, futaT.rate) + applyRate(futaTaxable, futaT.ny_credit_reduction_rate);
  const suiT = tables.ny_sui;
  const ytdSui = input.ytd?.suiWages ?? 0n;
  const suiBase = BigInt(suiT.wage_base_cents);
  const suiTaxable = maxC(0n, minC(suiWages, suiBase - minC(ytdSui, suiBase)));
  const sui =
    applyRate(suiTaxable, suiT.employer_rate) +
    applyRate(suiTaxable, suiT.reemployment_fund_rate);
  t("8.er_ss", "mirrors employee SS", erSS, "fica");
  t("8.er_medicare", "no employer Additional Medicare", erMedicare, "fica");
  t("8.futa", `on ${formatCents(futaTaxable)} incl. NY credit reduction`, futa, "futa");
  t("8.sui", `on ${formatCents(suiTaxable)} at the DOL-assigned rate + re-employment fund`, sui, "sui");

  // 8b: employer 401(k) cap: 25%-of-plan-comp and 415(c) (catch-up excluded)
  const compBase = minC(input.employerCompBase, BigInt(limits.compensation_cap_cents));
  const pctCap = applyRate(compBase, limits.employer_pct_of_comp);
  const regularDeferral = minC(input.deferral401k, BigInt(limits.elective_deferral_limit_cents));
  const additionsCap = BigInt(limits.annual_additions_415c_limit_cents) - regularDeferral;
  const employerCap = maxC(0n, minC(pctCap, additionsCap));
  let employer401k = input.employer401kTarget;
  if (employer401k > employerCap) {
    warnings.push(
      `employer 401(k) target ${formatCents(input.employer401kTarget)} exceeds the computed cap ` +
        `${formatCents(employerCap)} (25%-of-comp ${formatCents(pctCap)}, 415(c) headroom ` +
        `${formatCents(additionsCap)}) — clamped; deadline is the return due date incl. extensions`,
    );
    employer401k = employerCap;
  }
  t("8.er_401k", `cap = min(25%×comp ${formatCents(pctCap)}, 415c ${formatCents(additionsCap)})`, employer401k);

  return {
    wageBases: { fit: fitWages, nys: nysWages, nyc: nycWages, fica: ficaWages, futa: futaWages, sui: suiWages },
    employee: {
      socialSecurity: eeSS,
      medicare: eeMedicare,
      additionalMedicare: eeAdditionalMedicare,
      fitWithheld: fit,
      nysWithheld: nys,
      nycWithheld: nyc,
      deferral401k: input.deferral401k,
    },
    employer: {
      socialSecurity: erSS,
      medicare: erMedicare,
      futa,
      sui,
      contribution401k: employer401k,
    },
    netPay,
    limits: {
      deferralCap,
      employerCap,
      annualAdditionsCap: BigInt(limits.annual_additions_415c_limit_cents),
      employerHeadroom: employerCap - employer401k,
    },
    warnings,
    trace,
  };
}

// --- deposit schedule (§4.4) ------------------------------------------------

export type DepositRulesTable = {
  eftps_next_day_threshold_cents: number; // $100,000 rule
  eftps_monthly_due_day: number; // 15th of the following month
  nys1_threshold_cents: number; // $700
  nys1_business_days_standard: number; // 5
  nys1_business_days_fast: number; // 3
  nys1_fast_prior_withholding_cents: number; // $15,000 prior-year
  futa_deposit_threshold_cents: number; // $500
};

export type DepositItem = {
  authority: "EFTPS" | "NYS-1" | "FUTA" | "NY-SUI";
  amount: Cents;
  dueDate: string;
  rule: string;
  liabilityAccounts: string[];
};

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function isBusinessDay(d: string, holidays: ReadonlySet<string>): boolean {
  const dow = new Date(Date.parse(`${d}T00:00:00Z`)).getUTCDay();
  return dow !== 0 && dow !== 6 && !holidays.has(d);
}

function nextBusinessDay(d: string, holidays: ReadonlySet<string>): string {
  let x = d;
  for (let i = 0; i < 15; i++) {
    x = addDays(x, 1);
    if (isBusinessDay(x, holidays)) return x;
  }
  throw new PayrollError(`no business day within 15 days after ${d}`);
}

function addBusinessDays(d: string, n: number, holidays: ReadonlySet<string>): string {
  let x = d;
  for (let i = 0; i < n; i++) x = nextBusinessDay(x, holidays);
  return x;
}

export function computeDepositSchedule(
  result: PayrollResult,
  args: {
    payDate: string;
    rules: DepositRulesTable;
    holidays: ReadonlySet<string>;
    priorYearNyWithholding: Cents;
  },
): DepositItem[] {
  const { rules, holidays, payDate } = args;
  const items: DepositItem[] = [];

  const eftps =
    result.employee.fitWithheld +
    result.employee.socialSecurity +
    result.employer.socialSecurity +
    result.employee.medicare +
    result.employee.additionalMedicare +
    result.employer.medicare;
  if (eftps > 0n) {
    const nextDay = eftps >= BigInt(rules.eftps_next_day_threshold_cents);
    let dueDate: string;
    let rule: string;
    if (nextDay) {
      dueDate = nextBusinessDay(payDate, holidays);
      rule = `accumulated ≥ ${formatCents(BigInt(rules.eftps_next_day_threshold_cents))}: next business day`;
    } else {
      const [y, m] = [Number(payDate.slice(0, 4)), Number(payDate.slice(5, 7))];
      const ny = m === 12 ? y + 1 : y;
      const nm = m === 12 ? 1 : m + 1;
      const nominal = `${ny}-${String(nm).padStart(2, "0")}-${String(rules.eftps_monthly_due_day).padStart(2, "0")}`;
      dueDate = isBusinessDay(nominal, holidays) ? nominal : nextBusinessDay(nominal, holidays);
      rule = `monthly depositor: ${rules.eftps_monthly_due_day}th of the following month`;
    }
    items.push({
      authority: "EFTPS",
      amount: eftps,
      dueDate,
      rule,
      liabilityAccounts: ["2100", "2110", "2120"],
    });
  }

  const ny = result.employee.nysWithheld + result.employee.nycWithheld;
  if (ny >= BigInt(rules.nys1_threshold_cents)) {
    const fast = args.priorYearNyWithholding >= BigInt(rules.nys1_fast_prior_withholding_cents);
    const days = fast ? rules.nys1_business_days_fast : rules.nys1_business_days_standard;
    items.push({
      authority: "NYS-1",
      amount: ny,
      dueDate: addBusinessDays(payDate, days, holidays),
      rule: `withheld ≥ ${formatCents(BigInt(rules.nys1_threshold_cents))}: within ${days} business days`,
      liabilityAccounts: ["2130", "2140"],
    });
  }

  if (result.employer.futa > 0n) {
    const quarterly = result.employer.futa > BigInt(rules.futa_deposit_threshold_cents);
    const year = Number(payDate.slice(0, 4));
    const nominal = `${year + 1}-01-31`; // Q4 run: quarterly deposit and Form 940 converge
    const dueDate = isBusinessDay(nominal, holidays) ? nominal : nextBusinessDay(nominal, holidays);
    items.push({
      authority: "FUTA",
      amount: result.employer.futa,
      dueDate,
      rule: quarterly
        ? `over ${formatCents(BigInt(rules.futa_deposit_threshold_cents))}: deposit for the quarter`
        : "under the threshold: pay with Form 940",
      liabilityAccounts: ["2150"],
    });
  }

  if (result.employer.sui > 0n) {
    const year = Number(payDate.slice(0, 4));
    const nominal = `${year + 1}-01-31`; // Q4 NYS-45
    const dueDate = isBusinessDay(nominal, holidays) ? nominal : nextBusinessDay(nominal, holidays);
    items.push({
      authority: "NY-SUI",
      amount: result.employer.sui,
      dueDate,
      rule: "paid with the quarterly NYS-45",
      liabilityAccounts: ["2160"],
    });
  }
  return items;
}
