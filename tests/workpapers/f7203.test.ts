/**
 * Form 7203 + TB export on the closed golden year. The §1367 identity is
 * the punchline: with nothing suspended and no excess distributions,
 * ending stock basis EQUALS paid-in + AAA + OAA to the cent:
 *   1,000,000 + K.18 490,050 + exempt 20,000 − dist 120,000 − nondeduct
 *   8,051 = 1,381,999 = 1,000,000 + 364,999 + 17,000.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildF7203, F7203Error } from "../../src/workpapers/f7203";
import { exportTrialBalanceCsv, TbExportError } from "../../src/package/tbexport";
import { closeYear } from "../../src/ledger/close";
import { postEntry } from "../../src/ledger/posting";
import { loadTaxTables, verifyTaxTable } from "../../src/tax/tables";
import { readDocument } from "../../src/vault/store";
import { makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let dir: string;

async function post(
  date: string,
  memo: string,
  lines: Array<{ accountCode: string; debit?: bigint; credit?: bigint }>,
  documentIds?: bigint[],
) {
  return postEntry(t.db, { entryDate: date, memo, sourceModule: "manual", lines, documentIds });
}

beforeAll(async () => {
  process.env.VAULT_DIR = mkdtempSync(join(tmpdir(), "vault-"));
  dir = mkdtempSync(join(tmpdir(), "tb-tables-"));
  process.env.TAX_TABLES_DIR = dir;
  mkdirSync(join(dir, "2026"), { recursive: true });
  t = await makeTestDb();
  const doc = await t.pool.query(
    `INSERT INTO documents (filename, mime, sha256, size_bytes)
     VALUES ('meals.jpg','image/jpeg','f7203-sha',10) RETURNING id`,
  );
  const docId = BigInt(doc.rows[0].id);
  await post("2026-01-15", "capital", [
    { accountCode: "1000", debit: 1000000n },
    { accountCode: "3000", credit: 1000000n },
  ]);
  await post("2026-03-01", "consulting", [
    { accountCode: "1000", debit: 500000n },
    { accountCode: "4000", credit: 500000n },
  ]);
  await post("2026-04-01", "tax-exempt income", [
    { accountCode: "1000", debit: 20000n },
    { accountCode: "4600", credit: 20000n },
  ]);
  await post(
    "2026-05-10",
    "meals",
    [
      { accountCode: "5130", debit: 10101n },
      { accountCode: "1000", credit: 10101n },
    ],
    [docId],
  );
  await post("2026-06-01", "software", [
    { accountCode: "5100", debit: 4900n },
    { accountCode: "1000", credit: 4900n },
  ]);
  await post("2026-07-01", "nondeductible related to exempt", [
    { accountCode: "4615", debit: 3000n },
    { accountCode: "1000", credit: 3000n },
  ]);
  await post("2026-08-01", "distribution", [
    { accountCode: "3200", debit: 120000n },
    { accountCode: "1000", credit: 120000n },
  ]);
  await closeYear(t.db, 2026);
});

afterAll(async () => {
  await t.drop();
  delete process.env.TAX_TABLES_DIR;
});

describe("Form 7203 stock basis", () => {
  it("rolls basis with the §1367 ordering and ties to equity to the cent", async () => {
    const r = await buildF7203(t.db, 2026);
    expect(r.row).toMatchObject({
      beginningBasis: 0n,
      contributions: 1000000n,
      incomeItems: 490050n,
      taxExemptIncome: 20000n,
      distributionsApplied: 120000n,
      excessDistributions: 0n,
      nondeductiblesApplied: 8051n,
      lossesAllowed: 0n,
      suspendedLosses: 0n,
      endingBasis: 1381999n,
    });
    for (const tie of r.tieOuts) {
      expect(tie, `${tie.name}: ${tie.detail}`).toMatchObject({ pass: true });
    }
  });

  it("refuses re-rolls and out-of-order years", async () => {
    await expect(buildF7203(t.db, 2026)).rejects.toThrow(F7203Error);
    await expect(buildF7203(t.db, 2030)).rejects.toThrow(/order/);
  });
});

describe("CPA trial-balance export", () => {
  it("refuses to export while any nonzero account lacks a product code", async () => {
    writeFileSync(
      join(dir, "2026", "tb_export_codes.json"),
      JSON.stringify({
        kind: "tb_export_codes",
        source_url: "CPA product docs (test)",
        payload: { product: "lacerte", codes: { "1000": "100" } },
      }),
    );
    const report = await loadTaxTables(t.db, 2026);
    for (const r of report) if (r.action !== "unchanged") await verifyTaxTable(t.db, r.id);
    await expect(exportTrialBalanceCsv(t.db, 2026)).rejects.toThrow(TbExportError);
    await expect(exportTrialBalanceCsv(t.db, 2026)).rejects.toThrow(/3000/);
  });

  it("exports the coded CSV and vaults it", async () => {
    writeFileSync(
      join(dir, "2026", "tb_export_codes.json"),
      JSON.stringify({
        kind: "tb_export_codes",
        source_url: "CPA product docs (test)",
        payload: {
          product: "lacerte",
          codes: { "1000": "100", "3000": "290", "3100": "292", "3110": "293" },
        },
      }),
    );
    const report = await loadTaxTables(t.db, 2026);
    for (const r of report) if (r.action !== "unchanged") await verifyTaxTable(t.db, r.id);
    const exp = await exportTrialBalanceCsv(t.db, 2026);
    expect(exp.product).toBe("lacerte");
    expect(exp.rowCount).toBe(4); // post-close: cash + three equity accounts
    expect(exp.csv).toContain("1000,Operating checking,100,13819.99,");
    expect(exp.csv).toContain("3100,");
    expect(exp.csv.trim().split("\n").pop()).toContain("TOTAL,,,13819.99,13819.99");
    const saved = await readDocument(t.db, exp.documentId);
    expect(saved.bytes.toString("utf8")).toBe(exp.csv);
  });
});
