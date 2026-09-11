import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bankAccounts } from "../../src/db/schema";
import { importParsedTransactions } from "../../src/bank/import";
import { classifyTransaction } from "../../src/bank/classify";
import {
  completeReconciliation,
  computeReconciliation,
  createReconciliation,
  isReconciledThrough,
  ReconcileError,
} from "../../src/bank/reconcile";
import { makeTestDb, type TestDb } from "../helpers/db";
import { bankTransactions } from "../../src/db/schema";
import { eq } from "drizzle-orm";

let t: TestDb;
let acctId: number;
let txnIds: bigint[] = [];

beforeAll(async () => {
  t = await makeTestDb();
  const cash = await t.pool.query("SELECT id FROM accounts WHERE code = '1000'");
  const [a] = await t.db
    .insert(bankAccounts)
    .values({ name: "Chase operating", ledgerAccountId: cash.rows[0].id })
    .returning({ id: bankAccounts.id });
  acctId = a!.id;
  await importParsedTransactions(t.db, {
    bankAccountId: acctId,
    source: "csv",
    txns: [
      { date: "2026-10-05", amount: 500000n, descriptionRaw: "CLIENT PAYMENT" },
      { date: "2026-10-07", amount: -4900n, descriptionRaw: "ACME SOFTWARE" },
      { date: "2026-10-20", amount: -10100n, descriptionRaw: "OFFICE SUPPLIES STORE" },
    ],
  });
  const rows = await t.db
    .select()
    .from(bankTransactions)
    .where(eq(bankTransactions.bankAccountId, acctId));
  txnIds = rows.map((r) => r.id);
  await classifyTransaction(t.db, txnIds[0]!, { targetAccountCode: "4000" });
  await classifyTransaction(t.db, txnIds[1]!, { targetAccountCode: "5100" });
  // txnIds[2] stays unreviewed
});

afterAll(async () => {
  await t.drop();
});

describe("reconciliation", () => {
  it("itemizes the difference as the unposted transactions", async () => {
    // statement balance reflects all three txns: 5,000 − 49 − 101 = 4,850.00
    const recId = await createReconciliation(t.db, acctId, "2026-10-31", 485000n);
    const c = await computeReconciliation(t.db, recId);
    expect(c.ledgerBalance).toBe(495100n); // only the two posted ones
    expect(c.difference).toBe(-10100n);
    expect(c.openItems).toHaveLength(1);
    expect(c.unexplained).toBe(0n); // fully explained by the open item
    await expect(completeReconciliation(t.db, recId)).rejects.toThrow(ReconcileError);
    // classify the straggler → difference zero → complete
    await classifyTransaction(t.db, txnIds[2]!, { targetAccountCode: "5044" }).catch(async () => {
      // 5044 requires a document — use a plain expense account instead
      await classifyTransaction(t.db, txnIds[2]!, { targetAccountCode: "5100" });
    });
    const c2 = await computeReconciliation(t.db, recId);
    expect(c2.difference).toBe(0n);
    await completeReconciliation(t.db, recId);
    await expect(completeReconciliation(t.db, recId)).rejects.toThrow(/already completed/);
    const stamped = await t.db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.reconciliationId, recId));
    expect(stamped).toHaveLength(3);
  });

  it("flags unexplained differences (missing imports)", async () => {
    const recId = await createReconciliation(t.db, acctId, "2026-11-30", 480000n);
    const c = await computeReconciliation(t.db, recId);
    // ledger still 4,850.00, statement says 4,800.00, nothing unposted → −50.00 unexplained
    expect(c.difference).toBe(-5000n);
    expect(c.openItems).toHaveLength(0);
    expect(c.unexplained).toBe(-5000n);
    await expect(completeReconciliation(t.db, recId)).rejects.toThrow(/missing import|difference/);
  });

  it("tracks reconciled-through state for period locking", async () => {
    expect(await isReconciledThrough(t.db, acctId, 2026, 10)).toBe(true);
    expect(await isReconciledThrough(t.db, acctId, 2026, 11)).toBe(false);
  });
});
