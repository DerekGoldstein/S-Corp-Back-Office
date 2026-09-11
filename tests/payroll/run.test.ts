/**
 * End-to-end pay run through the REAL verified-table gate: synthetic tables
 * are written as files, loaded, owner-verified, and only then does the run
 * compute, persist, post its entry, and schedule deposits. Expected values
 * are the hand-computed ones from engine.test.ts.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { payrollDeposits, payrollRuns } from "../../src/db/schema";
import { runPayroll, reversePayrollRun } from "../../src/payroll/run";
import type { PayrollInput } from "../../src/payroll/engine";
import { loadTaxTables, verifyTaxTable } from "../../src/tax/tables";
import { trialBalance } from "../../src/ledger/reports";
import { makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let dir: string;

const SYNTHETIC: Record<string, unknown> = {
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
      ],
    },
  },
  nys50t_nys: {
    deduction_cents_by_status: { single: 800_000 },
    per_allowance_cents: 100_000,
    brackets_by_status: {
      single: [
        { over_cents: 0, base_cents: 0, rate: "0.04" },
        { over_cents: 2_000_000, base_cents: 80_000, rate: "0.06" },
      ],
    },
  },
  nys50t_nyc: {
    deduction_cents_by_status: { single: 500_000 },
    per_allowance_cents: 100_000,
    brackets_by_status: {
      single: [
        { over_cents: 0, base_cents: 0, rate: "0.03" },
        { over_cents: 5_000_000, base_cents: 150_000, rate: "0.035" },
      ],
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
  deposit_rules: {
    eftps_next_day_threshold_cents: 10_000_000,
    eftps_monthly_due_day: 15,
    nys1_threshold_cents: 70_000,
    nys1_business_days_standard: 5,
    nys1_business_days_fast: 3,
    nys1_fast_prior_withholding_cents: 1_500_000,
    futa_deposit_threshold_cents: 50_000,
  },
  holidays: { dates: ["2027-12-24", "2028-01-17"] },
};

const input: PayrollInput = {
  taxYear: 2027,
  payDate: "2027-12-23",
  grossWages: 15_000_000n,
  healthPremium2pct: 1_200_000n,
  suiIncludesHealth: false,
  deferral401k: 2_000_000n,
  catchUpEligible: false,
  employer401kTarget: 4_000_000n,
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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "payroll-tables-"));
  process.env.TAX_TABLES_DIR = dir;
  mkdirSync(join(dir, "2027"), { recursive: true });
  t = await makeTestDb();
});

afterAll(async () => {
  await t.drop();
  delete process.env.TAX_TABLES_DIR;
});

describe("runPayroll", () => {
  it("refuses to run while any table is unverified (§4.4 gate, end to end)", async () => {
    for (const [kind, payload] of Object.entries(SYNTHETIC)) {
      writeFileSync(
        join(dir, "2027", `${kind}.json`),
        JSON.stringify({ kind, source_url: `https://example.gov/${kind}`, payload }),
      );
    }
    await loadTaxTables(t.db, 2027);
    await expect(
      runPayroll(t.db, { input, grossSource: "override: test", priorYearNyWithholding: 0n }),
    ).rejects.toThrow(/not verified_by_owner/);
  });

  it("computes, persists, posts the §4.1 entry, and schedules deposits", async () => {
    const report = await loadTaxTables(t.db, 2027);
    for (const r of report) if (r.action !== "unchanged") await verifyTaxTable(t.db, r.id);
    // fresh load returns 'unchanged' rows too — verify all loaded ids
    const all = await t.pool.query("SELECT id, verified_by_owner FROM tax_table_versions");
    for (const row of all.rows) {
      if (!row.verified_by_owner) await verifyTaxTable(t.db, row.id as number);
    }
    const s = await runPayroll(t.db, {
      input,
      grossSource: "comp_computation:1",
      priorYearNyWithholding: 0n,
    });
    expect(s.result.netPay).toBe(5_547_500n);

    const [run] = await t.db.select().from(payrollRuns).where(eq(payrollRuns.id, s.runId));
    expect(run).toMatchObject({
      status: "posted",
      fitWages: 16_200_000n,
      ficaWages: 15_000_000n,
      netPay: 5_547_500n,
      journalEntryId: s.entryId,
    });
    expect(Object.keys(run!.tableVersionIds)).toHaveLength(9);

    const tb = await trialBalance(t.db, "2027-12-31");
    const row = (code: string) => tb.rows.find((r) => r.code === code);
    expect(row("5000")).toMatchObject({ debit: 15_000_000n });
    expect(row("5010")).toMatchObject({ debit: 1_000_000n + 300_000n + 6_300n + 48_900n });
    expect(row("5020")).toMatchObject({ debit: 4_000_000n });
    expect(row("2100")).toMatchObject({ credit: 4_940_000n });
    expect(row("2110")).toMatchObject({ credit: 2_000_000n });
    expect(row("2120")).toMatchObject({ credit: 600_000n });
    expect(row("2130")).toMatchObject({ credit: 758_000n });
    expect(row("2140")).toMatchObject({ credit: 454_500n });
    expect(row("2170")).toMatchObject({ credit: 2_000_000n });
    expect(row("2180")).toMatchObject({ credit: 4_000_000n });
    expect(row("1000")).toMatchObject({ credit: 5_547_500n }); // net pay out of cash
    expect(tb.totalDebits).toBe(tb.totalCredits);

    const deposits = await t.db
      .select()
      .from(payrollDeposits)
      .where(eq(payrollDeposits.payrollRunId, s.runId));
    expect(deposits.map((d) => d.authority).sort()).toEqual(["EFTPS", "FUTA", "NY-SUI", "NYS-1"]);
    expect(deposits.find((d) => d.authority === "EFTPS")).toMatchObject({
      amount: 7_540_000n,
      dueDate: "2028-01-18",
    });
    expect(deposits.find((d) => d.authority === "NYS-1")).toMatchObject({
      dueDate: "2027-12-31",
    });
  });

  it("reversal restores the trial balance and drops scheduled deposits", async () => {
    const runs = await t.db.select().from(payrollRuns);
    await reversePayrollRun(t.db, runs[0]!.id, "wrong deferral election");
    const tb = await trialBalance(t.db, "2027-12-31");
    expect(tb.rows.find((r) => r.code === "5000")).toBeUndefined();
    expect(tb.rows.find((r) => r.code === "2100")).toBeUndefined();
    const deposits = await t.db.select().from(payrollDeposits);
    expect(deposits).toHaveLength(0);
    const [run] = await t.db.select().from(payrollRuns).where(eq(payrollRuns.id, runs[0]!.id));
    expect(run!.status).toBe("reversed");
    expect(run!.journalEntryId).not.toBeNull(); // history preserved
  });

  it("rejects an unlabeled gross source", async () => {
    await expect(
      runPayroll(t.db, { input, grossSource: "whatever", priorYearNyWithholding: 0n }),
    ).rejects.toThrow(/comp_computation/);
  });
});
