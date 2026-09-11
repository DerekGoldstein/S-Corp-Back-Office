/**
 * Form worksheets from the synthetic December run (values hand-computed in
 * engine.test.ts). The W-2 Box 1 tie-out deliberately catches the unbooked
 * 5030 premium first — then goes green once the premium is expensed exactly
 * once, which is guardrail 7 doing its job.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postEntry } from "../../src/ledger/posting";
import { runPayroll } from "../../src/payroll/run";
import {
  build940,
  build941Q4,
  buildPayrollWorksheets,
  buildW2,
} from "../../src/payroll/worksheets";
import type { PayrollInput } from "../../src/payroll/engine";
import { loadTaxTables, verifyTaxTable } from "../../src/tax/tables";
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
  holidays: { dates: ["2027-12-24"] },
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
  dir = mkdtempSync(join(tmpdir(), "ws-tables-"));
  process.env.TAX_TABLES_DIR = dir;
  mkdirSync(join(dir, "2027"), { recursive: true });
  for (const [kind, payload] of Object.entries(SYNTHETIC)) {
    writeFileSync(
      join(dir, "2027", `${kind}.json`),
      JSON.stringify({ kind, source_url: `https://example.gov/${kind}`, payload }),
    );
  }
  t = await makeTestDb();
  const report = await loadTaxTables(t.db, 2027);
  for (const r of report) await verifyTaxTable(t.db, r.id);
  await runPayroll(t.db, {
    input,
    grossSource: "comp_computation:1",
    priorYearNyWithholding: 0n,
  });
});

afterAll(async () => {
  await t.drop();
  delete process.env.TAX_TABLES_DIR;
});

function get(ws: { lines: Array<{ code: string; cents: bigint }> }, code: string): bigint {
  const l = ws.lines.find((x) => x.code === code);
  if (!l) throw new Error(`${code} missing`);
  return l.cents;
}

describe("W-2 worksheet", () => {
  it("catches the unbooked 5030 premium via the Box 1 tie-out, then goes green", async () => {
    const before = await buildW2(t.db, 2027);
    expect(get(before, "W2.1")).toBe(14_200_000n); // fit wages − deferral
    expect(get(before, "W2.3")).toBe(10_000_000n); // capped, excludes health
    expect(get(before, "W2.5")).toBe(15_000_000n);
    expect(get(before, "W2.12D")).toBe(2_000_000n);
    expect(get(before, "W2.14")).toBe(1_200_000n);
    expect(before.tieOuts[0]!.pass).toBe(false); // premium not yet expensed anywhere
    // the entity paid the insurer during the year: Dr 5030 / Cr 1000 (once!)
    const doc = await t.pool.query(
      `INSERT INTO documents (filename,mime,sha256,size_bytes)
       VALUES ('premium-notice.pdf','application/pdf','ws-prem',10) RETURNING id`,
    );
    await postEntry(t.db, {
      entryDate: "2027-06-01",
      memo: "health insurance premiums (2% shareholder)",
      sourceModule: "manual",
      documentIds: [BigInt(doc.rows[0].id)],
      lines: [
        { accountCode: "5030", debit: 1_200_000n },
        { accountCode: "1000", credit: 1_200_000n },
      ],
    });
    const after = await buildW2(t.db, 2027);
    expect(after.tieOuts[0]).toMatchObject({ pass: true }); // Box 1 = 5000+5030−deferral
    expect(after.tieOuts[1]).toMatchObject({ pass: true }); // Box 5 excludes health
    expect(get(after, "W2.16")).toBe(14_200_000n);
    expect(get(after, "W2.17")).toBe(758_000n);
    expect(get(after, "W2.19")).toBe(454_500n);
  });
});

describe("941 Q4 worksheet", () => {
  it("computes the quarter's lines and ties to the EFTPS deposit", async () => {
    const ws = await build941Q4(t.db, 2027);
    expect(get(ws, "941.2")).toBe(14_200_000n);
    expect(get(ws, "941.3")).toBe(4_940_000n);
    expect(get(ws, "941.5a.1")).toBe(10_000_000n);
    expect(get(ws, "941.5a.2")).toBe(2_000_000n);
    expect(get(ws, "941.5c.2")).toBe(600_000n);
    expect(get(ws, "941.12")).toBe(7_540_000n);
    expect(get(ws, "941.13")).toBe(7_540_000n);
    expect(ws.tieOuts[0]!.pass).toBe(true);
    expect(ws.flags.some((f) => f.includes("SEASONAL"))).toBe(true);
  });
});

describe("940 worksheet", () => {
  it("exempts the health fringe and caps the wage base", async () => {
    const ws = await build940(t.db, 2027);
    expect(get(ws, "940.3")).toBe(16_200_000n);
    expect(get(ws, "940.4")).toBe(1_200_000n);
    expect(get(ws, "940.7")).toBe(700_000n);
    expect(get(ws, "940.12")).toBe(6_300n); // includes the 0.3% credit reduction
  });
});

describe("all four persist as workpaper versions", () => {
  it("saves w2/941/940/nys45 with quarters where applicable", async () => {
    const { worksheets, savedIds } = await buildPayrollWorksheets(t.db, 2027);
    expect(savedIds).toHaveLength(4);
    expect(worksheets.map((w) => w.kind).sort()).toEqual(["940", "941", "nys45", "w2"]);
    const r = await t.pool.query(
      `SELECT kind, quarter, version FROM workpapers ORDER BY kind`,
    );
    const q941 = r.rows.find((x: { kind: string }) => x.kind === "941");
    expect(q941.quarter).toBe(4);
    // second build bumps versions independently per kind
    const again = await buildPayrollWorksheets(t.db, 2027);
    expect(again.savedIds).toHaveLength(4);
  });
});
