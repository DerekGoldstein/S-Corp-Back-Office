import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appConfig, bankAccounts, bankTransactions, importBatches } from "../../src/db/schema";
import { importCsvFile, importOfxFile } from "../../src/bank/import";
import { documentsFor } from "../../src/vault/store";
import { makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let acctId: number;

const fixture = (name: string) => readFileSync(join(process.cwd(), "tests/fixtures", name));

beforeAll(async () => {
  process.env.VAULT_DIR = mkdtempSync(join(tmpdir(), "vault-"));
  t = await makeTestDb();
  const cash = await t.pool.query("SELECT id FROM accounts WHERE code = '1000'");
  const [a] = await t.db
    .insert(bankAccounts)
    .values({
      name: "Chase operating",
      ledgerAccountId: cash.rows[0].id,
      importProfile: {
        dateColumn: "Posting Date",
        dateFormat: "MDY",
        descriptionColumns: ["Description"],
        amountColumn: "Amount",
      },
    })
    .returning({ id: bankAccounts.id });
  acctId = a!.id;
  await t.db.insert(appConfig).values({ key: "owner_payee_regex", value: "TO OWNER" });
});

afterAll(async () => {
  await t.drop();
});

describe("csv import", () => {
  it("imports all rows including identical same-day charges, vaults the file", async () => {
    const summary = await importCsvFile(t.db, acctId, fixture("chase.csv"), "chase-oct.csv");
    expect(summary).toMatchObject({ rowCount: 4, newCount: 4, duplicateCount: 0 });
    expect(summary.documentId).not.toBeNull();
    const docs = await documentsFor(t.db, "import_batch", summary.batchId);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.filename).toBe("chase-oct.csv");
  });

  it("re-importing the same file is a perfect no-op", async () => {
    const summary = await importCsvFile(t.db, acctId, fixture("chase.csv"), "chase-oct.csv");
    expect(summary).toMatchObject({ rowCount: 4, newCount: 0, duplicateCount: 4 });
    const all = await t.db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.bankAccountId, acctId));
    expect(all).toHaveLength(4);
  });
});

describe("ofx import", () => {
  it("dedupes against the CSV-imported rows only by its own FITID space", async () => {
    const summary = await importOfxFile(t.db, acctId, fixture("sample.ofx"), "chase-oct.ofx");
    // same underlying purchases, but OFX hashes by FITID — they import as their own rows;
    // real usage picks ONE feed per account (profile or OFX), which the UI enforces.
    expect(summary.newCount).toBe(3);
    const again = await importOfxFile(t.db, acctId, fixture("sample.ofx"), "chase-oct.ofx");
    expect(again).toMatchObject({ newCount: 0, duplicateCount: 3 });
  });
});

describe("owner payee detection", () => {
  it("marks matching descriptions from app_config.owner_payee_regex", async () => {
    const csv =
      "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n" +
      'DEBIT,11/01/2026,"ZELLE TO OWNER",-500.00,ACH,, \n';
    await importCsvFile(t.db, acctId, Buffer.from(csv), "nov.csv");
    const rows = await t.db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.isOwnerPayee, true));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.descriptionRaw).toBe("ZELLE TO OWNER");
  });
});

describe("batch bookkeeping", () => {
  it("records counts and warnings on the batch row", async () => {
    const csv =
      "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n" +
      'DEBIT,13/45/2026,"BAD DATE",-1.00,ACH,,\n' +
      'DEBIT,11/02/2026,"OK ROW",-2.00,ACH,,\n';
    const summary = await importCsvFile(t.db, acctId, Buffer.from(csv), "warn.csv");
    expect(summary).toMatchObject({ rowCount: 1, newCount: 1 });
    expect(summary.warnings).toHaveLength(1);
    const [batch] = await t.db
      .select()
      .from(importBatches)
      .where(eq(importBatches.id, summary.batchId));
    expect(batch).toMatchObject({ newCount: 1, warningCount: 1 });
  });
});
