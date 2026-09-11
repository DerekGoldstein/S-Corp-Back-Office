/** End-to-end classification guards: the §4.2/§8 rules with real Postgres. */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appConfig,
  bankAccounts,
  bankTransactions,
  classificationRules,
  ruleSuggestions,
} from "../../src/db/schema";
import { importParsedTransactions } from "../../src/bank/import";
import {
  classifyTransaction,
  ClassifyError,
  flagTransaction,
} from "../../src/bank/classify";
import { acceptSuggestion, generateRuleSuggestions, runRules } from "../../src/bank/rules";
import { matchTransfers, unmatchTransfer } from "../../src/bank/transfers";
import { createInvestee } from "../../src/ledger/investees";
import { trialBalance } from "../../src/ledger/reports";
import { makeTestDb, type TestDb } from "../helpers/db";
import type { ParsedTxn } from "../../src/bank/normalize";

let t: TestDb;
let acctA: number; // operating (1000)
let acctB: number; // reserve (1010)
let investeeId: number;
let investeeCode: string;

async function importOne(bankAccountId: number, txn: ParsedTxn): Promise<bigint> {
  await importParsedTransactions(t.db, { bankAccountId, source: "csv", txns: [txn] });
  const rows = await t.db
    .select()
    .from(bankTransactions)
    .where(eq(bankTransactions.bankAccountId, bankAccountId))
    .orderBy(bankTransactions.id);
  return rows[rows.length - 1]!.id;
}

async function expectClassifyError(p: Promise<unknown>, code: string, pattern?: RegExp) {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ClassifyError);
  expect((err as ClassifyError).code).toBe(code);
  if (pattern) expect((err as ClassifyError).message).toMatch(pattern);
}

beforeAll(async () => {
  t = await makeTestDb();
  const inv = await createInvestee(t.db, {
    name: "Factoring LLC",
    entityType: "partnership",
    ownershipPct: "50",
    acquiredOn: "2024-08-01",
    counterpartyRegex: "FACTORING LLC",
  });
  investeeId = inv.investee.id;
  investeeCode = inv.accountCode;
  const ids = await t.pool.query(
    "SELECT id, code FROM accounts WHERE code IN ('1000','1010') ORDER BY code",
  );
  const a1000 = ids.rows[0].id as number;
  const a1010 = ids.rows[1].id as number;
  const [a] = await t.db
    .insert(bankAccounts)
    .values({ name: "Chase operating", ledgerAccountId: a1000 })
    .returning({ id: bankAccounts.id });
  const [b] = await t.db
    .insert(bankAccounts)
    .values({ name: "Chase reserve", ledgerAccountId: a1010 })
    .returning({ id: bankAccounts.id });
  acctA = a!.id;
  acctB = b!.id;
  await t.db.insert(appConfig).values({ key: "owner_payee_regex", value: "DEREK|TO OWNER" });
});

afterAll(async () => {
  await t.drop();
});

describe("classification happy path", () => {
  it("posts an inflow to revenue with the txn dimension on both lines", async () => {
    const id = await importOne(acctA, {
      date: "2026-10-05",
      amount: 500000n,
      descriptionRaw: "CLIENT PAYMENT WIRE",
    });
    const { entryId } = await classifyTransaction(t.db, id, { targetAccountCode: "4000" });
    const lines = await t.pool.query(
      "SELECT bank_transaction_id::text FROM journal_lines WHERE entry_id = $1",
      [entryId.toString()],
    );
    expect(lines.rows).toHaveLength(2);
    expect(lines.rows.every((r: { bank_transaction_id: string }) => r.bank_transaction_id === id.toString())).toBe(true);
    const [txn] = await t.db.select().from(bankTransactions).where(eq(bankTransactions.id, id));
    expect(txn).toMatchObject({ status: "posted", journalEntryId: entryId });
  });

  it("refuses to classify the same transaction twice", async () => {
    const rows = await t.db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.status, "posted"));
    await expectClassifyError(
      classifyTransaction(t.db, rows[0]!.id, { targetAccountCode: "5100" }),
      "state",
    );
  });
});

describe("§4.2 forced patterns", () => {
  it("investee wires are never revenue; the right target auto-carries the dimension", async () => {
    const id = await importOne(acctA, {
      date: "2026-10-15",
      amount: 250000n,
      descriptionRaw: "WIRE IN - FACTORING LLC DISTRIBUTION",
    });
    await expectClassifyError(
      classifyTransaction(t.db, id, { targetAccountCode: "4000" }),
      "investee_wire",
      /NEVER revenue/,
    );
    const { entryId } = await classifyTransaction(t.db, id, { targetAccountCode: investeeCode });
    const lines = await t.pool.query(
      "SELECT investee_id FROM journal_lines WHERE entry_id = $1 AND credit > 0",
      [entryId.toString()],
    );
    expect(lines.rows[0].investee_id).toBe(investeeId);
  });

  it("EFTPS debits must clear a payroll liability, never an expense", async () => {
    const id = await importOne(acctA, {
      date: "2026-12-16",
      amount: -150000n,
      descriptionRaw: "EFTPS TREAS 941 PAYMENT",
    });
    await expectClassifyError(
      classifyTransaction(t.db, id, { targetAccountCode: "5200" }),
      "clearing_pattern",
      /2100\/2110\/2120/,
    );
    await classifyTransaction(t.db, id, { targetAccountCode: "2100" });
  });

  it("owner outflows require a tag, and the tag pins the target account", async () => {
    const id = await importOne(acctA, {
      date: "2026-11-01",
      amount: -120000n,
      descriptionRaw: "ZELLE TO OWNER DEREK",
    });
    await expectClassifyError(
      classifyTransaction(t.db, id, { targetAccountCode: "5100" }),
      "owner_tag_required",
    );
    await expectClassifyError(
      classifyTransaction(t.db, id, {
        targetAccountCode: "5100",
        ownerPaymentTag: "distribution",
      }),
      "tag_target",
      /3200/,
    );
    const { entryId } = await classifyTransaction(t.db, id, {
      targetAccountCode: "3200",
      ownerPaymentTag: "distribution",
    });
    expect(entryId).toBeGreaterThan(0n);
  });

  it("reimbursement payments need approved submissions covering them (guardrail 6)", async () => {
    const id = await importOne(acctA, {
      date: "2026-12-20",
      amount: -50000n,
      descriptionRaw: "ACH TO OWNER DEREK REIMBURSEMENT",
    });
    await expectClassifyError(
      classifyTransaction(t.db, id, {
        targetAccountCode: "2190",
        ownerPaymentTag: "reimbursement",
      }),
      "reimbursement_unapproved",
      /approve the submission/,
    );
  });

  it("net pay must match the payroll entry, not re-post", async () => {
    const id = await importOne(acctA, {
      date: "2026-12-24",
      amount: -700000n,
      descriptionRaw: "PAYROLL TO OWNER DEREK",
    });
    await expectClassifyError(
      classifyTransaction(t.db, id, { ownerPaymentTag: "payroll_net_pay" }),
      "match_entry",
      /payroll journal entry/,
    );
  });

  it("cash-account targets are rejected toward transfer matching", async () => {
    const id = await importOne(acctA, {
      date: "2026-11-03",
      amount: -100000n,
      descriptionRaw: "ONLINE TRANSFER TO SAVINGS",
    });
    await expectClassifyError(
      classifyTransaction(t.db, id, { targetAccountCode: "1010" }),
      "transfer_target",
      /transfer matching/,
    );
  });

  it("personal transactions get flagged, never classified (§8)", async () => {
    const id = await importOne(acctA, {
      date: "2026-11-04",
      amount: -3500n,
      descriptionRaw: "NETFLIX.COM",
    });
    await flagTransaction(t.db, id, "personal subscription — move card at the bank");
    const [txn] = await t.db.select().from(bankTransactions).where(eq(bankTransactions.id, id));
    expect(txn).toMatchObject({ status: "flagged" });
    await expectClassifyError(
      classifyTransaction(t.db, id, { targetAccountCode: "5100" }),
      "state",
    );
  });
});

describe("rules engine", () => {
  it("auto_post rules post through the full guard pipeline; failures fall back to proposed", async () => {
    const softwareAcct = await t.pool.query("SELECT id FROM accounts WHERE code = '5100'");
    const badAcct = await t.pool.query("SELECT id FROM accounts WHERE code = '4500'");
    await t.db.insert(classificationRules).values([
      {
        name: "GitHub",
        descriptionRegex: "^GITHUB",
        targetAccountId: softwareAcct.rows[0].id,
        autoPost: true,
        priority: 10,
      },
      {
        name: "bad rule into pass-through",
        descriptionRegex: "^STRIPE PAYOUT",
        targetAccountId: badAcct.rows[0].id,
        autoPost: true,
        priority: 20,
      },
      {
        name: "insurance (no auto)",
        descriptionRegex: "^HISCOX",
        targetAccountId: (
          await t.pool.query("SELECT id FROM accounts WHERE code = '5140'")
        ).rows[0].id,
        autoPost: false,
        priority: 30,
      },
    ]);
    await importOne(acctA, { date: "2026-11-05", amount: -400n, descriptionRaw: "GITHUB INC" });
    await importOne(acctA, {
      date: "2026-11-06",
      amount: 90000n,
      descriptionRaw: "STRIPE PAYOUT X1",
    });
    await importOne(acctA, { date: "2026-11-07", amount: -6200n, descriptionRaw: "HISCOX INSURANCE" });
    const result = await runRules(t.db);
    expect(result.autoPosted).toBe(1);
    expect(result.autoFailed).toHaveLength(1);
    expect(result.autoFailed[0]!.reason).toMatch(/cannot be posted from source 'bank'/);
    expect(result.proposed).toBe(2); // the failed auto rule + the HISCOX rule
    const proposed = await t.db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.status, "proposed"));
    expect(proposed).toHaveLength(2);
  });

  it("suggests a rule after two similar manual classifications and accepts it", async () => {
    const id1 = await importOne(acctA, {
      date: "2026-11-10",
      amount: -1500n,
      descriptionRaw: "NOTION LABS",
    });
    const id2 = await importOne(acctA, {
      date: "2026-12-10",
      amount: -1500n,
      descriptionRaw: "NOTION LABS",
    });
    await classifyTransaction(t.db, id1, { targetAccountCode: "5100" });
    await classifyTransaction(t.db, id2, { targetAccountCode: "5100" });
    const created = await generateRuleSuggestions(t.db);
    expect(created).toBe(1);
    const [s] = await t.db
      .select()
      .from(ruleSuggestions)
      .where(eq(ruleSuggestions.status, "pending"));
    expect(s!.descriptionRegex).toBe("^NOTION LABS$");
    expect(s!.sampleTxnIds).toHaveLength(2);
    const { ruleId } = await acceptSuggestion(t.db, s!.id, { autoPost: true });
    // next identical import auto-posts under the new rule
    await importOne(acctA, { date: "2027-01-10", amount: -1500n, descriptionRaw: "NOTION LABS" });
    const run = await runRules(t.db);
    expect(run.autoPosted).toBe(1);
    const [rule] = await t.db
      .select()
      .from(classificationRules)
      .where(eq(classificationRules.id, ruleId));
    expect(rule!.timesApplied).toBe(1);
    // and generating again does not duplicate the suggestion
    expect(await generateRuleSuggestions(t.db)).toBe(0);
  });
});

describe("transfers", () => {
  it("matches offsetting txns across accounts into one shared entry", async () => {
    const outId = await importOne(acctA, {
      date: "2026-11-20",
      amount: -100000n,
      descriptionRaw: "ONLINE TRANSFER TO XXXX1010",
    });
    const inId = await importOne(acctB, {
      date: "2026-11-21",
      amount: 100000n,
      descriptionRaw: "ONLINE TRANSFER FROM XXXX1000",
    });
    const matches = await matchTransfers(t.db);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ outflowTxnId: outId, inflowTxnId: inId });
    const [outTxn] = await t.db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, outId));
    const [inTxn] = await t.db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, inId));
    expect(outTxn).toMatchObject({ status: "transfer", transferPeerId: inId });
    expect(inTxn!.journalEntryId).toBe(outTxn!.journalEntryId);
    // trial balance: cash moved 1000 → 1010, nothing hit income/expense
    const tb = await trialBalance(t.db, "2026-11-30");
    expect(tb.rows.find((r) => r.code === "1010")).toMatchObject({ debit: 100000n });
    // unmatch restores both and reverses the entry
    await unmatchTransfer(t.db, outId, "wrong pair");
    const tb2 = await trialBalance(t.db, "2026-11-30");
    expect(tb2.rows.find((r) => r.code === "1010")).toBeUndefined();
  });
});
