/**
 * The full §4.8 loop: home-office computation → documented submission →
 * approval posts 5041/2190 → the owner-tagged bank payment (previously
 * refused by the §4.2 guard) now clears 2190 and marks submissions paid.
 * Health premiums route to 5030 — expensed exactly once (guardrail 7).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveSubmission,
  computeHomeOffice,
  createSubmission,
  markSubmissionsPaid,
  ReimbursementError,
} from "../../src/plan/reimbursements";
import { accountablePlans, appConfig, bankAccounts, bankTransactions, reimbursementSubmissions } from "../../src/db/schema";
import { classifyTransaction, ClassifyError } from "../../src/bank/classify";
import { importParsedTransactions } from "../../src/bank/import";
import { trialBalance } from "../../src/ledger/reports";
import { storeDocument } from "../../src/vault/store";
import { makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let planId: number;
let acctId: number;

async function makeDoc(name: string): Promise<bigint> {
  const { document } = await storeDocument(t.db, {
    filename: name,
    mime: "application/pdf",
    bytes: Buffer.from(`bytes of ${name}`),
  });
  return document.id;
}

beforeAll(async () => {
  process.env.VAULT_DIR = mkdtempSync(join(tmpdir(), "vault-"));
  t = await makeTestDb();
  const policy = await makeDoc("policy.pdf");
  const [plan] = await t.db
    .insert(accountablePlans)
    .values({
      adoptedOn: "2026-12-15",
      documentId: policy,
      categories: ["home_office", "phone", "internet", "health_insurance"],
    })
    .returning({ id: accountablePlans.id });
  planId = plan!.id;
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
});

describe("home-office computation", () => {
  it("computes the square-footage share to the cent", () => {
    const r = computeHomeOffice({
      totalSquareFeet: 800,
      businessSquareFeet: 120,
      annualRent: 3_600_000n, // $36,000
      annualUtilities: 240_000n,
      annualInsurance: 60_000n,
    });
    // 15% of $39,000.00 = $5,850.00
    expect(r.businessUsePct).toBe("15.00%");
    expect(r.amount).toBe(585_000n);
    expect(() =>
      computeHomeOffice({
        totalSquareFeet: 800,
        businessSquareFeet: 900,
        annualRent: 0n,
        annualUtilities: 0n,
        annualInsurance: 0n,
      }),
    ).toThrow(ReimbursementError);
  });
});

describe("submission → approval → payment", () => {
  it("rejects categories outside the plan", async () => {
    const doc = await makeDoc("supplies.pdf");
    await expect(
      createSubmission(t.db, {
        planId,
        taxYear: 2027,
        category: "supplies",
        amount: 1000n,
        documentId: doc,
      }),
    ).rejects.toThrow(/does not cover/);
  });

  it("approval posts Dr 5041 / Cr 2190; health premiums post to 5030 once", async () => {
    const ho = computeHomeOffice({
      totalSquareFeet: 800,
      businessSquareFeet: 120,
      annualRent: 3_600_000n,
      annualUtilities: 240_000n,
      annualInsurance: 60_000n,
    });
    const s1 = await createSubmission(t.db, {
      planId,
      taxYear: 2027,
      category: "home_office",
      amount: ho.amount,
      computation: ho.breakdown,
      documentId: await makeDoc("home-office-worksheet.pdf"),
    });
    await approveSubmission(t.db, s1, "2027-12-15");
    const s2 = await createSubmission(t.db, {
      planId,
      taxYear: 2027,
      category: "health_insurance",
      amount: 1_200_000n,
      documentId: await makeDoc("premium-notices.pdf"),
    });
    await approveSubmission(t.db, s2, "2027-12-15");
    const tb = await trialBalance(t.db, "2027-12-31");
    expect(tb.rows.find((r) => r.code === "5041")).toMatchObject({ debit: 585_000n });
    expect(tb.rows.find((r) => r.code === "5030")).toMatchObject({ debit: 1_200_000n });
    expect(tb.rows.find((r) => r.code === "2190")).toMatchObject({ credit: 1_785_000n });
    await expect(approveSubmission(t.db, s1, "2027-12-16")).rejects.toThrow(/posted/);
  });

  it("the reimbursement-tagged bank payment clears 2190 and marks submissions paid", async () => {
    await importParsedTransactions(t.db, {
      bankAccountId: acctId,
      source: "csv",
      txns: [{ date: "2027-12-20", amount: -1_785_000n, descriptionRaw: "ACH TO OWNER REIMB" }],
    });
    const [txn] = await t.db.select().from(bankTransactions);
    const { entryId } = await classifyTransaction(t.db, txn!.id, {
      targetAccountCode: "2190",
      ownerPaymentTag: "reimbursement",
    });
    expect(entryId).toBeGreaterThan(0n);
    const tb = await trialBalance(t.db, "2027-12-31");
    expect(tb.rows.find((r) => r.code === "2190")).toBeUndefined(); // cleared to zero
    const subs = await t.db.select().from(reimbursementSubmissions);
    expect(subs.every((s) => s.status === "paid")).toBe(true);
    expect(subs.every((s) => s.paidBankTransactionId === txn!.id)).toBe(true);
  });

  it("a payment exceeding approved coverage is still refused (guardrail 6)", async () => {
    await importParsedTransactions(t.db, {
      bankAccountId: acctId,
      source: "csv",
      txns: [{ date: "2027-12-22", amount: -50_000n, descriptionRaw: "ACH TO OWNER REIMB 2" }],
    });
    const txns = await t.db.select().from(bankTransactions);
    const fresh = txns.find((x) => x.status === "unreviewed")!;
    await expect(
      classifyTransaction(t.db, fresh.id, {
        targetAccountCode: "2190",
        ownerPaymentTag: "reimbursement",
      }),
    ).rejects.toThrow(ClassifyError);
  });

  it("partial payments leave uncovered submissions posted", async () => {
    const s = await createSubmission(t.db, {
      planId,
      taxYear: 2027,
      category: "phone",
      amount: 60_000n,
      documentId: await makeDoc("phone-bill.pdf"),
    });
    await approveSubmission(t.db, s, "2027-12-23");
    const marked = await markSubmissionsPaid(t.db, 999n, 10_000n); // too small
    expect(marked).toBe(0);
    const [row] = await t.db
      .select()
      .from(reimbursementSubmissions)
      .where(eq(reimbursementSubmissions.id, s));
    expect(row!.status).toBe("posted");
  });
});
