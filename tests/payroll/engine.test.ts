/**
 * Engine tests run on SYNTHETIC tables with clean round numbers — they prove
 * the machinery (§4.4 step order, wage-base separation, caps, rounding),
 * not any year's rates. Real 2027 tables arrive via the verified-table gate,
 * and the December golden fixture is then re-derived by hand (M-series plan).
 *
 * December run, hand-computed (cents):
 *   gross 15,000,000 · health 1,200,000 (FIT/NYS/NYC only) · deferral
 *   2,000,000 (at cap) · FIT base 16,200,000 → taxable 14,200,000
 *   EE SS 10% of 10,000,000 cap = 1,000,000 · Medicare 2% = 300,000
 *   FIT: 500,000 + 20%×9,200,000 = 2,340,000 + 4c 100,000 + override
 *     2,500,000 = 4,940,000
 *   NYS: (14,200,000 − 800,000 − 100,000) → 80,000 + 6%×11,300,000 = 758,000
 *   NYC: (14,200,000 − 500,000) → 150,000 + 3.5%×8,700,000 = 454,500
 *   net = 15,000,000 − 1,000,000 − 300,000 − 4,940,000 − 758,000 − 454,500
 *         − 2,000,000 = 5,547,500
 *   FUTA (0.6%+0.3% credit reduction on 700,000) = 6,300 · SUI 4%+0.075% on
 *   1,200,000 = 48,900 · ER 401(k): min(25%×16,200,000=4,050,000,
 *   415c 6,000,000−2,000,000=4,000,000) = 4,000,000 (target 4,500,000 clamps)
 */
import { describe, expect, it } from "vitest";
import {
  applyRate,
  computeDepositSchedule,
  computePayroll,
  parseRate,
  PayrollError,
  type DepositRulesTable,
  type PayrollInput,
  type PayrollTables,
} from "../../src/payroll/engine";

const tables: PayrollTables = {
  fica: {
    social_security_rate: "0.10",
    social_security_wage_base_cents: 10_000_000,
    medicare_rate: "0.02",
    additional_medicare_rate: "0.01",
    additional_medicare_threshold_cents: 20_000_000,
  },
  pub15t: {
    schedules: {
      single_standard: [
        { over_cents: 0, base_cents: 0, rate: "0.10" },
        { over_cents: 5_000_000, base_cents: 500_000, rate: "0.20" },
        { over_cents: 15_000_000, base_cents: 2_500_000, rate: "0.30" },
      ],
      single_step2: [
        { over_cents: 0, base_cents: 0, rate: "0.15" },
        { over_cents: 5_000_000, base_cents: 750_000, rate: "0.25" },
      ],
      married_joint_standard: [{ over_cents: 0, base_cents: 0, rate: "0.08" }],
    },
  },
  nys50t_nys: {
    deduction_cents_by_status: { single: 800_000, married: 1_600_000 },
    per_allowance_cents: 100_000,
    brackets_by_status: {
      single: [
        { over_cents: 0, base_cents: 0, rate: "0.04" },
        { over_cents: 2_000_000, base_cents: 80_000, rate: "0.06" },
      ],
      married: [{ over_cents: 0, base_cents: 0, rate: "0.04" }],
    },
  },
  nys50t_nyc: {
    deduction_cents_by_status: { single: 500_000, married: 1_000_000 },
    per_allowance_cents: 100_000,
    brackets_by_status: {
      single: [
        { over_cents: 0, base_cents: 0, rate: "0.03" },
        { over_cents: 5_000_000, base_cents: 150_000, rate: "0.035" },
      ],
      married: [{ over_cents: 0, base_cents: 0, rate: "0.03" }],
    },
  },
  futa: { rate: "0.006", wage_base_cents: 700_000, ny_credit_reduction_rate: "0.003" },
  ny_sui: { wage_base_cents: 1_200_000, employer_rate: "0.04", reemployment_fund_rate: "0.00075" },
  limits_401k: {
    elective_deferral_limit_cents: 2_000_000,
    catch_up_50_limit_cents: 500_000,
    annual_additions_415c_limit_cents: 6_000_000,
    compensation_cap_cents: 30_000_000,
    employer_pct_of_comp: "0.25",
  },
};

const decemberRun: PayrollInput = {
  taxYear: 2027,
  payDate: "2027-12-23",
  grossWages: 15_000_000n,
  healthPremium2pct: 1_200_000n,
  suiIncludesHealth: false,
  deferral401k: 2_000_000n,
  catchUpEligible: false,
  employer401kTarget: 4_500_000n,
  employerCompBase: 16_200_000n,
  w4: {
    filingStatus: "single",
    step2: false,
    step3AnnualCredits: 0n,
    step4aOtherIncome: 0n,
    step4bDeductions: 0n,
    step4cExtra: 100_000n,
  },
  it2104: { nysAllowances: 1, nycAllowances: 0, nysExtra: 0n, nycExtra: 0n, nycResident: true },
  additionalFitWithholding: 2_500_000n,
};

describe("rate math", () => {
  it("multiplies exactly with half-up rounding", () => {
    expect(parseRate("0.062")).toEqual({ num: 62n, den: 1000n });
    expect(applyRate(10_000n, "0.062")).toBe(620n);
    expect(applyRate(101n, "0.5")).toBe(51n); // 50.5 → half-up 51
    expect(applyRate(99n, "0.333")).toBe(33n); // 32.967 → 33
    expect(() => parseRate("6.2e-2")).toThrow(PayrollError);
  });
});

describe("computePayroll — the December run", () => {
  const r = computePayroll(decemberRun, tables);

  it("separates the six wage bases (health in income-tax bases only)", () => {
    expect(r.wageBases).toEqual({
      fit: 16_200_000n,
      nys: 16_200_000n,
      nyc: 16_200_000n,
      fica: 15_000_000n,
      futa: 15_000_000n,
      sui: 15_000_000n,
    });
  });

  it("computes every employee-side amount to the cent", () => {
    expect(r.employee.socialSecurity).toBe(1_000_000n);
    expect(r.employee.medicare).toBe(300_000n);
    expect(r.employee.additionalMedicare).toBe(0n);
    expect(r.employee.fitWithheld).toBe(4_940_000n);
    expect(r.employee.nysWithheld).toBe(758_000n);
    expect(r.employee.nycWithheld).toBe(454_500n);
    expect(r.netPay).toBe(5_547_500n);
  });

  it("computes employer taxes and clamps the 401(k) to the 415(c) headroom", () => {
    expect(r.employer.socialSecurity).toBe(1_000_000n);
    expect(r.employer.medicare).toBe(300_000n);
    expect(r.employer.futa).toBe(6_300n);
    expect(r.employer.sui).toBe(48_900n);
    expect(r.employer.contribution401k).toBe(4_000_000n);
    expect(r.limits.employerCap).toBe(4_000_000n);
    expect(r.warnings.some((w) => w.includes("clamped"))).toBe(true);
    expect(r.trace.length).toBeGreaterThan(8);
  });

  it("everything reconciles: gross = net + EE taxes + withholding + deferral", () => {
    const e = r.employee;
    expect(
      r.netPay +
        e.socialSecurity +
        e.medicare +
        e.additionalMedicare +
        e.fitWithheld +
        e.nysWithheld +
        e.nycWithheld +
        e.deferral401k,
    ).toBe(decemberRun.grossWages);
  });
});

describe("edge behavior", () => {
  it("caps Social Security by YTD wages and applies Additional Medicare over the threshold", () => {
    const r = computePayroll(
      {
        ...decemberRun,
        additionalFitWithholding: 0n,
        ytd: { ficaWages: 9_500_000n, futaWages: 700_000n, suiWages: 1_200_000n },
      },
      tables,
    );
    expect(r.employee.socialSecurity).toBe(50_000n); // 10% of the remaining 500,000
    // ytd 9.5M + 15M = 24.5M crosses the 20M threshold → 4.5M × 1%
    expect(r.employee.additionalMedicare).toBe(45_000n);
    expect(r.employer.futa).toBe(0n); // FUTA base exhausted by YTD
    expect(r.employer.sui).toBe(0n);
  });

  it("respects SUI-includes-health config and non-resident NYC", () => {
    const r = computePayroll(
      {
        ...decemberRun,
        suiIncludesHealth: true,
        it2104: { ...decemberRun.it2104, nycResident: false },
      },
      tables,
    );
    expect(r.wageBases.sui).toBe(16_200_000n);
    expect(r.wageBases.nyc).toBe(0n);
    expect(r.employee.nycWithheld).toBe(0n);
  });

  it("uses the step-2 schedule and catch-up when flagged", () => {
    const r = computePayroll(
      {
        ...decemberRun,
        deferral401k: 2_500_000n,
        catchUpEligible: true,
        w4: { ...decemberRun.w4, step2: true },
      },
      tables,
    );
    // step2 schedule on AAW 16.2M − 2.5M = 13.7M: 750,000 + 25%×8,700,000
    expect(r.employee.fitWithheld).toBe(750_000n + 2_175_000n + 100_000n + 2_500_000n);
    expect(r.limits.deferralCap).toBe(2_500_000n);
  });

  it("rejects over-cap deferrals and negative net pay with §4.7 guidance", () => {
    expect(() => computePayroll({ ...decemberRun, deferral401k: 2_100_000n }, tables)).toThrow(
      /exceeds the 2027 cap/,
    );
    expect(() =>
      computePayroll({ ...decemberRun, additionalFitWithholding: 9_000_000n }, tables),
    ).toThrow(/1040-ES/);
  });
});

describe("deposit schedule", () => {
  const rules: DepositRulesTable = {
    eftps_next_day_threshold_cents: 10_000_000,
    eftps_monthly_due_day: 15,
    nys1_threshold_cents: 70_000,
    nys1_business_days_standard: 5,
    nys1_business_days_fast: 3,
    nys1_fast_prior_withholding_cents: 1_500_000,
    futa_deposit_threshold_cents: 50_000,
  };
  const holidays = new Set(["2027-12-24", "2028-01-17"]);

  it("monthly EFTPS rule rolls the 15th past weekends and holidays", () => {
    const r = computePayroll(decemberRun, tables);
    const schedule = computeDepositSchedule(r, {
      payDate: "2027-12-23",
      rules,
      holidays,
      priorYearNyWithholding: 0n,
    });
    const eftps = schedule.find((s) => s.authority === "EFTPS")!;
    // FIT 4.94M + SS 2M + Medicare 0.6M = 7.54M < 10M → monthly
    expect(eftps.amount).toBe(7_540_000n);
    // Jan 15 2028 = Saturday → Mon Jan 17 is a holiday → Tue Jan 18
    expect(eftps.dueDate).toBe("2028-01-18");
    const nys1 = schedule.find((s) => s.authority === "NYS-1")!;
    expect(nys1.amount).toBe(1_212_500n);
    // 5 business days after Thu Dec 23 (Fri 24 is a holiday): 27,28,29,30,31
    expect(nys1.dueDate).toBe("2027-12-31");
    expect(schedule.find((s) => s.authority === "FUTA")!.rule).toMatch(/Form 940/);
    expect(schedule.find((s) => s.authority === "NY-SUI")!.dueDate).toBe("2028-01-31");
  });

  it("the $100k rule makes the deposit due the next business day", () => {
    const big = computePayroll(
      { ...decemberRun, additionalFitWithholding: 5_000_000n },
      tables,
    );
    const schedule = computeDepositSchedule(big, {
      payDate: "2027-12-23",
      rules,
      holidays,
      priorYearNyWithholding: 0n,
    });
    const eftps = schedule.find((s) => s.authority === "EFTPS")!;
    expect(eftps.amount).toBe(10_040_000n);
    // next business day after Thu Dec 23: Fri 24 holiday, weekend → Mon Dec 27
    expect(eftps.dueDate).toBe("2027-12-27");
    expect(eftps.rule).toMatch(/next business day/);
  });

  it("the fast NYS-1 window applies when prior-year withholding was high", () => {
    const r = computePayroll(decemberRun, tables);
    const schedule = computeDepositSchedule(r, {
      payDate: "2027-12-23",
      rules,
      holidays,
      priorYearNyWithholding: 2_000_000n,
    });
    const nys1 = schedule.find((s) => s.authority === "NYS-1")!;
    // 3 business days: Dec 27, 28, 29
    expect(nys1.dueDate).toBe("2027-12-29");
    expect(nys1.rule).toMatch(/3 business days/);
  });
});
