/**
 * NYC GCT highest-of-four-bases with synthetic tables, hand-computed:
 *   eni_rate 10% · alt: (ENI + comp − 1,000.00) × 30% × 10% ·
 *   capital: 0.2% capped at 500.00 · GCT FDM: 25/75/150 by receipts ·
 *   CT-3-S FDM: 19/175 by receipts.
 * Then the ledger-driven build on a small year: revenue 5,000.00, officer
 * comp 3,000.00 → p1.21 = 2,000.00 = ENI (no prior 5200):
 *   eni base 200.00 · alt (2,000+3,000−1,000)×30%×10% = 120.00 ·
 *   capital: cash 2,000.00 × 0.2% = 4.00 · fdm 25.00 → ENI base wins.
 *   CT-3-S fdm 19.00. Accrual: Dr 5200 219.00 / Cr 2200 200.00, 2210 19.00.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postEntry } from "../../src/ledger/posting";
import { computeGct, buildEntityTaxes, fdmLookup, GctError, type GctTable } from "../../src/workpapers/gct";
import { buildF1120s } from "../../src/workpapers/f1120s";
import { loadTaxTables, verifyTaxTable } from "../../src/tax/tables";
import { trialBalance } from "../../src/ledger/reports";
import { makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let dir: string;

const gctTable: GctTable = {
  eni_rate: "0.10",
  alt_base: { pct_of_eni_plus_comp: "0.30", exclusion_cents: 100_000 },
  capital_base: { rate: "0.002", cap_cents: 50_000 },
  fdm_brackets: [
    { receipts_over_cents: 0, tax_cents: 2_500 },
    { receipts_over_cents: 10_000_000, tax_cents: 7_500 },
    { receipts_over_cents: 100_000_000, tax_cents: 15_000 },
  ],
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "gct-tables-"));
  process.env.TAX_TABLES_DIR = dir;
  mkdirSync(join(dir, "2026"), { recursive: true });
  writeFileSync(
    join(dir, "2026", "gct.json"),
    JSON.stringify({ kind: "gct", source_url: "https://example.gov/nyc-4s", payload: gctTable }),
  );
  writeFileSync(
    join(dir, "2026", "ct3s.json"),
    JSON.stringify({
      kind: "ct3s",
      source_url: "https://example.gov/ct-3-s",
      payload: {
        fdm_brackets: [
          { receipts_over_cents: 0, tax_cents: 1_900 },
          { receipts_over_cents: 10_000_000, tax_cents: 17_500 },
        ],
      },
    }),
  );
  t = await makeTestDb();
  const report = await loadTaxTables(t.db, 2026);
  for (const r of report) await verifyTaxTable(t.db, r.id);
  await postEntry(t.db, {
    entryDate: "2026-03-01",
    memo: "consulting",
    sourceModule: "manual",
    lines: [
      { accountCode: "1000", debit: 500000n },
      { accountCode: "4000", credit: 500000n },
    ],
  });
  await postEntry(t.db, {
    entryDate: "2026-12-20",
    memo: "officer comp (test)",
    sourceModule: "manual",
    lines: [
      { accountCode: "5000", debit: 300000n },
      { accountCode: "1000", credit: 300000n },
    ],
  });
});

afterAll(async () => {
  await t.drop();
  delete process.env.TAX_TABLES_DIR;
});

describe("computeGct picks the highest base", () => {
  const base = { eni: 200000n, officerComp: 300000n, businessCapital: 200000n, nycReceipts: 500000n };

  it("ENI base wins on these inputs", () => {
    const r = computeGct(base, gctTable);
    expect(r.bases).toEqual({ eniTax: 20000n, altTax: 12000n, capitalTax: 400n, fdm: 2500n });
    expect(r.winner).toBe("eni");
    expect(r.tax).toBe(20000n);
  });

  it("the alternative base catches low-ENI/high-comp years", () => {
    const r = computeGct({ ...base, eni: 0n, officerComp: 2_000_000n }, gctTable);
    // (0 + 20,000.00 − 1,000.00) × 30% × 10% = 570.00 vs eni 0, capital 4.00, fdm 25.00
    expect(r.bases.altTax).toBe(57000n);
    expect(r.winner).toBe("alternative");
  });

  it("capital base caps; FDM floors a dormant year", () => {
    const r = computeGct(
      { eni: 0n, officerComp: 0n, businessCapital: 100_000_000n, nycReceipts: 0n },
      gctTable,
    );
    expect(r.bases.capitalTax).toBe(50_000n); // 0.2% would be 200,000 — capped
    expect(r.winner).toBe("capital");
    const dormant = computeGct({ eni: 0n, officerComp: 0n, businessCapital: 0n, nycReceipts: 0n }, gctTable);
    expect(dormant.winner).toBe("fdm");
    expect(dormant.tax).toBe(2500n);
  });

  it("FDM brackets step with receipts", () => {
    expect(fdmLookup(0n, gctTable.fdm_brackets, "t")).toBe(2500n);
    expect(fdmLookup(10_000_000n, gctTable.fdm_brackets, "t")).toBe(7500n);
    expect(fdmLookup(999_999_999n, gctTable.fdm_brackets, "t")).toBe(15000n);
  });
});

describe("buildEntityTaxes from the ledger", () => {
  it("computes, accrues 5200 → 2200/2210, ties out, and the 1120-S picks up the deduction", async () => {
    const wp = await buildEntityTaxes(t.db, 2026);
    expect(wp.inputs.eni).toBe("2,000.00");
    expect(wp.gct.winner).toBe("eni");
    expect(wp.gct.tax).toBe(20000n);
    expect(wp.ct3sFdm).toBe(1900n);
    expect(wp.accrualEntryId).not.toBeNull();
    for (const tie of wp.tieOuts) expect(tie, tie.detail).toMatchObject({ pass: true });
    const tb = await trialBalance(t.db, "2026-12-31");
    expect(tb.rows.find((r) => r.code === "2200")).toMatchObject({ credit: 20000n });
    expect(tb.rows.find((r) => r.code === "2210")).toMatchObject({ credit: 1900n });
    expect(tb.rows.find((r) => r.code === "5200")).toMatchObject({ debit: 21900n });
    // federal side: p1.12 carries the deduction, p1.21 drops accordingly
    const f = await buildF1120s(t.db, 2026);
    expect(f.page1.find((l) => l.code === "p1.12")!.cents).toBe(21900n);
    expect(f.page1.find((l) => l.code === "p1.21")!.cents).toBe(200000n - 21900n);
  });

  it("refuses to double-accrue", async () => {
    await expect(buildEntityTaxes(t.db, 2026)).rejects.toThrow(GctError);
    await expect(buildEntityTaxes(t.db, 2026)).rejects.toThrow(/reverse it/);
  });

  it("recomputing after inputs change stays consistent (addback keeps GCT stable)", async () => {
    // reverse the accrual, recompute: ENI-before-state-taxes is unchanged
    const r = await t.pool.query(
      `SELECT id FROM journal_entries WHERE source_module='tax_accrual' ORDER BY id DESC LIMIT 1`,
    );
    await t.pool.query(`SELECT post_reversal(${r.rows[0].id}, '2026-12-31', 'recompute')`);
    const wp = await buildEntityTaxes(t.db, 2026);
    expect(wp.gct.tax).toBe(20000n); // addback of 5200 keeps the base identical
  });
});
