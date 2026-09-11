/**
 * The whole first S-corp year through the PUBLIC APIs, in order: bank
 * imports → guarded classifications (revenue, expense, asset purchase to
 * 1600, tagged owner payments) → accountable-plan approval clearing 2190 →
 * the annual payroll run through the verified-table gate → registered
 * asset depreciation → year-end close with period locks → 1120-S and 4562
 * workpapers with every tie-out green → the review package whose ONLY red
 * rows are the two we earned (December unreconciled, no frozen comp
 * methodology) → guardrail-8 finalization both ways → the CPA export zip
 * parsed back with CRCs. Every module is unit-tested elsewhere; this test
 * exists to catch the seams. All tables are SYNTHETIC.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accountablePlans,
  appConfig,
  bankAccounts,
  bankTransactions,
} from "../../src/db/schema";
import { importParsedTransactions } from "../../src/bank/import";
import { classifyTransaction } from "../../src/bank/classify";
import { completeReconciliation, createReconciliation } from "../../src/bank/reconcile";
import { approveSubmission, createSubmission } from "../../src/plan/reimbursements";
import { runPayroll } from "../../src/payroll/run";
import type { PayrollInput } from "../../src/payroll/engine";
import { addAsset, postAnnualDepreciation } from "../../src/assets/register";
import { closeYear } from "../../src/ledger/close";
import { trialBalance } from "../../src/ledger/reports";
import { buildF1120s, saveWorkpaper } from "../../src/workpapers/f1120s";
import { buildF4562 } from "../../src/workpapers/f4562";
import { buildReviewPackage, finalizePackage, PackageError } from "../../src/package/tieouts";
import { exportYearArchive } from "../../src/vault/export";
import { readZip } from "../../src/lib/zip";
import { loadTaxTables, verifyTaxTable } from "../../src/tax/tables";
import { storeDocument } from "../../src/vault/store";
import { makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let acctId: number;

// Same synthetic set as tests/payroll/run.test.ts (values are test data).
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
  depreciation: {
    section179_limit_cents: 5_000_000,
    section179_phaseout_start_cents: 20_000_000,
    bonus_pct: "40%",
  },
};

const payrollInput: PayrollInput = {
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

async function doc(name: string): Promise<bigint> {
  const { document } = await storeDocument(t.db, {
    filename: name,
    mime: "application/pdf",
    bytes: Buffer.from(`bytes of ${name}`),
    year: 2027,
  });
  return document.id;
}

async function lastUnreviewed(): Promise<bigint> {
  const txns = await t.db.select().from(bankTransactions);
  const fresh = txns.filter((x) => x.status === "unreviewed");
  return fresh[fresh.length - 1]!.id;
}

beforeAll(async () => {
  process.env.VAULT_DIR = mkdtempSync(join(tmpdir(), "vault-"));
  const dir = mkdtempSync(join(tmpdir(), "tables-"));
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
  const cash = await t.pool.query("SELECT id FROM accounts WHERE code = '1000'");
  const [ba] = await t.db
    .insert(bankAccounts)
    .values({ name: "Chase operating", ledgerAccountId: cash.rows[0].id })
    .returning({ id: bankAccounts.id });
  acctId = ba!.id;
  await t.db.insert(appConfig).values({ key: "owner_payee_regex", value: "TO OWNER" });
});

afterAll(async () => {
  await t.drop();
  delete process.env.TAX_TABLES_DIR;
});

describe("tax year 2027, end to end", () => {
  it("runs the whole year and hands the CPA a tied-out package", async () => {
    // --- through the year: revenue, an expense, the asset purchase --------
    await importParsedTransactions(t.db, {
      bankAccountId: acctId,
      source: "csv",
      txns: [
        { date: "2027-03-01", amount: 3_000_000n, descriptionRaw: "WIRE ACME CLIENT" },
        { date: "2027-03-05", amount: -120_000n, descriptionRaw: "GITHUB ANNUAL" },
        { date: "2027-03-10", amount: -300_000n, descriptionRaw: "APPLE STORE MACBOOK" },
      ],
    });
    const txns = await t.db.select().from(bankTransactions);
    const byDesc = (s: string) => txns.find((x) => x.descriptionRaw.includes(s))!.id;
    await classifyTransaction(t.db, byDesc("ACME"), { targetAccountCode: "4000" });
    await classifyTransaction(t.db, byDesc("GITHUB"), { targetAccountCode: "5100" });
    await classifyTransaction(t.db, byDesc("MACBOOK"), { targetAccountCode: "1600" });

    // the purchase gets its register row (same cost, invoice attached)
    await addAsset(t.db, {
      description: "MacBook Pro",
      placedInService: "2027-03-10",
      cost: 300_000n,
      method: "macrs_200db",
      recoveryYears: 5,
      documentId: await doc("macbook-invoice.pdf"),
    });

    // --- December: reimbursement batch, payroll, distribution, depreciation
    const [plan] = await t.db
      .insert(accountablePlans)
      .values({
        adoptedOn: "2026-12-15",
        documentId: await doc("plan-policy.pdf"),
        categories: ["home_office", "health_insurance"],
      })
      .returning({ id: accountablePlans.id });
    const sub = await createSubmission(t.db, {
      planId: plan!.id,
      taxYear: 2027,
      category: "home_office",
      amount: 585_000n,
      documentId: await doc("home-office-worksheet.pdf"),
    });
    await approveSubmission(t.db, sub, "2027-12-15");
    // the 2% shareholder health premium reaches 5030 through THIS flow,
    // exactly once (guardrail 7) — payroll only carries its W-2 wage effect
    const health = await createSubmission(t.db, {
      planId: plan!.id,
      taxYear: 2027,
      category: "health_insurance",
      amount: 1_200_000n,
      documentId: await doc("premium-notices.pdf"),
    });
    await approveSubmission(t.db, health, "2027-12-15");

    await importParsedTransactions(t.db, {
      bankAccountId: acctId,
      source: "csv",
      txns: [
        { date: "2027-12-20", amount: -585_000n, descriptionRaw: "ACH TO OWNER REIMB" },
        { date: "2027-12-21", amount: -1_200_000n, descriptionRaw: "ACH TO OWNER REIMB HEALTH" },
      ],
    });
    const reimbTxns = await t.db.select().from(bankTransactions);
    for (const x of reimbTxns.filter((r) => r.status === "unreviewed")) {
      await classifyTransaction(t.db, x.id, {
        targetAccountCode: "2190",
        ownerPaymentTag: "reimbursement",
      });
    }

    const run = await runPayroll(t.db, {
      input: payrollInput,
      grossSource: "comp_computation:1",
      priorYearNyWithholding: 0n,
    });
    expect(run.result.netPay).toBe(5_547_500n);

    await importParsedTransactions(t.db, {
      bankAccountId: acctId,
      source: "csv",
      txns: [{ date: "2027-12-28", amount: -2_000_000n, descriptionRaw: "ACH TO OWNER DRAW" }],
    });
    await classifyTransaction(t.db, await lastUnreviewed(), {
      targetAccountCode: "3200",
      ownerPaymentTag: "distribution",
    });

    // remit the December 401(k) (EE deferral + ER contribution) to the custodian
    await importParsedTransactions(t.db, {
      bankAccountId: acctId,
      source: "csv",
      txns: [
        { date: "2027-12-29", amount: -2_000_000n, descriptionRaw: "ACH FIDELITY 401K EE" },
        { date: "2027-12-30", amount: -4_000_000n, descriptionRaw: "ACH FIDELITY 401K ER" },
      ],
    });
    const all = await t.db.select().from(bankTransactions);
    const ee401k = all.find((x) => x.descriptionRaw.includes("401K EE"))!.id;
    const er401k = all.find((x) => x.descriptionRaw.includes("401K ER"))!.id;
    await classifyTransaction(t.db, ee401k, { targetAccountCode: "2170" });
    await classifyTransaction(t.db, er401k, { targetAccountCode: "2180" });

    const dep = await postAnnualDepreciation(t.db, 2027);
    expect(dep.total).toBe(60_000n); // $3,000 5-yr 200DB half-year, year 1

    // --- the books balance and the §4.8 loop really closed ---------------
    const tb = await trialBalance(t.db, "2027-12-31");
    expect(tb.totalDebits).toBe(tb.totalCredits);
    const row = (code: string) => tb.rows.find((r) => r.code === code);
    expect(row("2190")).toBeUndefined(); // cleared to zero by the tagged payment
    expect(row("1600")).toMatchObject({ debit: 300_000n });
    expect(row("1610")).toMatchObject({ credit: 60_000n });
    expect(row("3200")).toMatchObject({ debit: 2_000_000n });

    // --- monthly reconciliations (statement = ledger; all activity posted)
    // Mar–Nov end at 30,000 − 1,200 − 3,000 = 25,800.00; December adds the
    // reimbursement, the net pay, the draw, and the 401(k) remittances:
    // 25,800 − 5,850 − 12,000 − 55,475 − 20,000 − 60,000 = −127,525.00 (synthetic;
    // arithmetically consistent).
    const monthEnd = (m: number) => `2027-${String(m).padStart(2, "0")}-${new Date(2027, m, 0).getDate()}`;
    for (let m = 3; m <= 12; m++) {
      const stmt = m < 12 ? 2_580_000n : -12_752_500n;
      const recId = await createReconciliation(t.db, acctId, monthEnd(m), stmt);
      await completeReconciliation(t.db, recId);
    }

    // --- close, workpapers, package, export -------------------------------
    const close = await closeYear(t.db, 2027, { lockPeriods: true });
    // revenue 30,000 − (software 1,200 + reimb 5,850 + health 12,000 +
    // depreciation 600 + wages 150,000 + er taxes 13,552 + er 401(k)
    // 40,000). The premium sits in 5030 exactly once via §4.8; the payroll
    // entry carried only its W-2 wage-base effect (guardrail 7).
    expect(close.netIncome).toBe(3_000_000n - 22_320_200n);

    const wp = await buildF1120s(t.db, 2027);
    for (const tie of wp.tieOuts) expect(tie, tie.name).toMatchObject({ pass: true });
    await saveWorkpaper(t.db, "f1120s", 2027, wp, wp.tieOuts); // as the year-end screen does

    const f4562 = await buildF4562(t.db, 2027);
    for (const tie of f4562.tieOuts) expect(tie, tie.name).toMatchObject({ pass: true });

    const pkg = await buildReviewPackage(t.db, 2027);
    const red = pkg.tieOuts.filter((x) => !x.pass).map((x) => x.key).sort();
    expect(red).toEqual(["comp_evidence"]); // exactly what we earned (no frozen methodology)

    await expect(finalizePackage(t.db, pkg.packageId, "final")).rejects.toThrow(PackageError);
    const noted = await buildReviewPackage(t.db, 2027, {
      comp_evidence: "methodology freeze deferred in this synthetic fixture",
    });
    await finalizePackage(t.db, noted.packageId, "final_with_open_items");

    const { zip } = await exportYearArchive(t.db, 2027);
    const files = readZip(zip);
    const names = [...files.keys()];
    expect(names).toContain("manifest.json");
    expect(names.some((n) => n.startsWith("workpapers/f1120s"))).toBe(true);
    expect(names.some((n) => n.startsWith("workpapers/f4562"))).toBe(true);
    expect(names.some((n) => n.includes("macbook-invoice"))).toBe(true);
    expect(names.some((n) => n.includes("home-office-worksheet"))).toBe(true);
  });
});
