/**
 * Synthetic-table projection, hand-computed (cents):
 *   income 45,700,000 − SEHI 1,200,000 → AGI 44,500,000
 *   − standard 1,500,000 → 43,000,000 · QBI 20%×min(30,000,000, 43,000,000)
 *   = 6,000,000 → taxable 37,000,000
 *   fed: 3,800,000 + 32%×17,000,000 = 9,240,000 (no Additional Medicare at
 *   15,000,000 wages) · NYS: 40,000 + 6%×42,700,000 = 2,602,000 · NYC 3%×
 *   43,700,000 = 1,311,000
 *   safe harbor (prior AGI over the high-AGI line → 110%):
 *     fed min(90%×9,240,000 = 8,316,000, 110%×8,000,000 = 8,800,000) = 8,316,000
 *     NY  min(90%×3,913,000 = 3,521,700, 110%×3,500,000 = 3,850,000) = 3,521,700
 *   December: fed need 8,316,000 − 1,000,000 est = 7,316,000, wage capacity
 *   6,000,000 → recommend 6,000,000, residual 1,316,000 by 1040-ES.
 */
import { describe, expect, it } from "vitest";
import {
  computeProjection,
  ProjectionError,
  type ProjectionInput,
  type ProjectionTables,
} from "../../src/projection/engine";

const tables: ProjectionTables = {
  fed_1040: {
    brackets_by_status: {
      single: [
        { over_cents: 0, base_cents: 0, rate: "0.10" },
        { over_cents: 5_000_000, base_cents: 500_000, rate: "0.22" },
        { over_cents: 20_000_000, base_cents: 3_800_000, rate: "0.32" },
      ],
    },
    standard_deduction_cents_by_status: { single: 1_500_000 },
    additional_medicare_rate: "0.009",
    additional_medicare_threshold_by_status: { single: 20_000_000 },
    qbi_rate: "0.20",
  },
  ny_personal: {
    nys_brackets_by_status: {
      single: [
        { over_cents: 0, base_cents: 0, rate: "0.04" },
        { over_cents: 1_000_000, base_cents: 40_000, rate: "0.06" },
      ],
    },
    nys_standard_deduction_cents_by_status: { single: 800_000 },
    nyc_brackets_by_status: { single: [{ over_cents: 0, base_cents: 0, rate: "0.03" }] },
  },
  safe_harbor: {
    current_year_pct: "0.90",
    prior_year_pct: "1.00",
    prior_year_pct_high_agi: "1.10",
    high_agi_threshold_cents: 15_000_000,
  },
};

const input: ProjectionInput = {
  taxYear: 2027,
  filingStatus: "single",
  nycResident: true,
  plannedBox1Wages: 14_200_000n,
  plannedMedicareWages: 15_000_000n,
  passThroughOrdinary: 30_000_000n,
  passThroughPortfolio: 1_000_000n,
  otherIncome: 500_000n,
  healthPremiums: 1_200_000n,
  otherAdjustments: 0n,
  itemizedDeductions: 0n,
  ytdFederalWithholding: 0n,
  ytdNysWithholding: 0n,
  ytdNycWithholding: 0n,
  federalEstimatedPaymentsMade: 1_000_000n,
  nyEstimatedPaymentsMade: 0n,
  priorYearFederalTax: 8_000_000n,
  priorYearAgi: 40_000_000n,
  priorYearNyTax: 3_500_000n,
  maxDecemberFederalWithholding: 6_000_000n,
  maxDecemberNyWithholding: 5_000_000n,
};

describe("projection engine", () => {
  const r = computeProjection(input, tables);

  it("computes AGI, QBI, and the three taxes to the cent", () => {
    expect(r.agi).toBe(44_500_000n);
    expect(r.qbiDeduction).toBe(6_000_000n);
    expect(r.federalTaxableIncome).toBe(37_000_000n);
    expect(r.federalTax).toBe(9_240_000n);
    expect(r.additionalMedicare).toBe(0n);
    expect(r.nysTax).toBe(2_602_000n);
    expect(r.nycTax).toBe(1_311_000n);
  });

  it("takes the lesser safe harbor with the high-AGI 110% prior option", () => {
    expect(r.federalSafeHarborTarget).toBe(8_316_000n);
    expect(r.nySafeHarborTarget).toBe(3_521_700n);
  });

  it("recommends December withholding up to wage capacity, residual to 1040-ES", () => {
    expect(r.recommendedDecemberFederalWithholding).toBe(6_000_000n);
    expect(r.residualFederalEstimated).toBe(1_316_000n);
    expect(r.recommendedDecemberNyWithholding).toBe(3_521_700n);
    expect(r.residualNyEstimated).toBe(0n);
    expect(r.assumptions.some((a) => a.includes("1040-ES"))).toBe(true);
    expect(r.assumptions[0]).toMatch(/PROJECTION/);
  });

  it("applies owner-level Additional Medicare over the filing-status threshold", () => {
    const high = computeProjection({ ...input, plannedMedicareWages: 25_000_000n }, tables);
    expect(high.additionalMedicare).toBe(45_000n); // 0.9% × 5,000,000
    expect(high.federalTax).toBe(9_240_000n + 45_000n);
  });

  it("uses 100% of prior-year tax under the AGI threshold when it is lower", () => {
    const low = computeProjection(
      { ...input, priorYearAgi: 10_000_000n, priorYearFederalTax: 5_000_000n },
      tables,
    );
    expect(low.federalSafeHarborTarget).toBe(5_000_000n);
  });

  it("prefers itemized deductions when they beat the standard", () => {
    const itemized = computeProjection({ ...input, itemizedDeductions: 2_000_000n }, tables);
    // taxable before QBI drops 500,000 → QBI unchanged (min still passThrough)
    expect(itemized.federalTaxableIncome).toBe(36_500_000n);
  });

  it("fails loudly on a table missing the filing status", () => {
    expect(() =>
      computeProjection({ ...input, filingStatus: "married_joint" }, tables),
    ).toThrow(ProjectionError);
  });
});
