/**
 * Golden fixture: a hand-computed mini-ledger. Every expected number below
 * was derived by hand in cents; if a report ever disagrees, the report is
 * wrong (or the fixture changed — re-derive by hand, never regenerate).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInvestee } from "../../src/ledger/investees";
import { postEntry, postReversal } from "../../src/ledger/posting";
import {
  accountRegister,
  balanceSheet,
  generalLedgerDetail,
  profitAndLoss,
  trialBalance,
} from "../../src/ledger/reports";
import { makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let investeeCode: string;
let investeeId: number;
let docId: bigint;

beforeAll(async () => {
  t = await makeTestDb();
  const created = await createInvestee(t.db, {
    name: "Factoring LLC",
    entityType: "partnership",
    ownershipPct: "50",
    acquiredOn: "2024-08-01",
  });
  investeeCode = created.accountCode;
  investeeId = created.investee.id;
  const doc = await t.pool.query(
    `INSERT INTO documents (filename, mime, sha256, size_bytes)
     VALUES ('meal-receipt.jpg','image/jpeg','fixture-sha-1',100) RETURNING id`,
  );
  docId = BigInt(doc.rows[0].id);

  // 1) 10-01 owner capital: Dr 1000 $1,000.00 / Cr 3000
  await postEntry(t.db, {
    entryDate: "2026-10-01",
    memo: "owner capital contribution",
    sourceModule: "manual",
    lines: [
      { accountCode: "1000", debit: 100000n },
      { accountCode: "3000", credit: 100000n },
    ],
  });
  // 2) 10-05 consulting receipt: Dr 1000 $5,000.00 / Cr 4000
  await postEntry(t.db, {
    entryDate: "2026-10-05",
    memo: "consulting invoice paid",
    sourceModule: "bank",
    sourceId: 1n,
    lines: [
      { accountCode: "1000", debit: 500000n },
      { accountCode: "4000", credit: 500000n },
    ],
  });
  // 3) 10-07 software: Dr 5100 $49.00 / Cr 1000 (reversed in Nov)
  const sw = await postEntry(t.db, {
    entryDate: "2026-10-07",
    memo: "software subscription",
    sourceModule: "bank",
    sourceId: 2n,
    lines: [
      { accountCode: "5100", debit: 4900n },
      { accountCode: "1000", credit: 4900n },
    ],
  });
  // 4) 10-15 investee wire $2,500.00: Dr 1000 / Cr 15xx (never revenue)
  await postEntry(t.db, {
    entryDate: "2026-10-15",
    memo: "distribution wire from Factoring LLC",
    sourceModule: "bank",
    sourceId: 3n,
    lines: [
      { accountCode: "1000", debit: 250000n },
      { accountCode: investeeCode, credit: 250000n, investeeId },
    ],
  });
  // 5) 10-20 meal $101.00 with receipt: Dr 5130 / Cr 1000
  await postEntry(t.db, {
    entryDate: "2026-10-20",
    memo: "client lunch",
    sourceModule: "bank",
    sourceId: 4n,
    documentIds: [docId],
    lines: [
      { accountCode: "5130", debit: 10100n },
      { accountCode: "1000", credit: 10100n },
    ],
  });
  // 6) 11-01 distribution $1,200.00: Dr 3200 / Cr 1000
  await postEntry(t.db, {
    entryDate: "2026-11-01",
    memo: "shareholder distribution",
    sourceModule: "bank",
    sourceId: 5n,
    lines: [
      { accountCode: "3200", debit: 120000n },
      { accountCode: "1000", credit: 120000n },
    ],
  });
  // 7) 11-05 reversal of the software charge (refund)
  await postReversal(t.db, sw.entryId, "2026-11-05", "software refund");
  // 8) 11-10 professional fees $300.00 (under the $500 document threshold)
  await postEntry(t.db, {
    entryDate: "2026-11-10",
    memo: "registered agent",
    sourceModule: "bank",
    sourceId: 6n,
    lines: [
      { accountCode: "5110", debit: 30000n },
      { accountCode: "1000", credit: 30000n },
    ],
  });
});

afterAll(async () => {
  await t.drop();
});

function row(tb: Awaited<ReturnType<typeof trialBalance>>, code: string) {
  return tb.rows.find((r) => r.code === code);
}

describe("trial balance", () => {
  it("matches the hand-computed October 31 statement to the cent", async () => {
    const tb = await trialBalance(t.db, "2026-10-31");
    expect(tb.totalDebits).toBe(tb.totalCredits);
    // cash: 1,000 + 5,000 − 49 + 2,500 − 101 = 8,350.00
    expect(row(tb, "1000")).toMatchObject({ debit: 835000n, credit: 0n });
    // investment carrying value went −2,500.00 (wire before any K-1 income)
    expect(row(tb, investeeCode)).toMatchObject({ debit: 0n, credit: 250000n });
    expect(row(tb, "3000")).toMatchObject({ credit: 100000n });
    expect(row(tb, "4000")).toMatchObject({ credit: 500000n });
    expect(row(tb, "5100")).toMatchObject({ debit: 4900n });
    expect(row(tb, "5130")).toMatchObject({ debit: 10100n });
    expect(tb.totalDebits).toBe(850000n);
  });

  it("shows the reversal cancelling software by November 30", async () => {
    const tb = await trialBalance(t.db, "2026-11-30");
    expect(row(tb, "5100")).toBeUndefined(); // zero balances hidden by default
    expect(row(tb, "1000")).toMatchObject({ debit: 689900n });
    expect(row(tb, "3200")).toMatchObject({ debit: 120000n });
    const withZeros = await trialBalance(t.db, "2026-11-30", { includeZero: true });
    expect(row(withZeros as never, "5100")).toMatchObject({ debit: 0n, credit: 0n });
  });
});

describe("profit and loss", () => {
  it("computes Q4 net income: 5,000 − (101 + 300) = 4,599.00", async () => {
    const pnl = await profitAndLoss(t.db, "2026-10-01", "2026-12-31");
    expect(pnl.totalRevenue).toBe(500000n);
    expect(pnl.totalExpenses).toBe(40100n);
    expect(pnl.netIncome).toBe(459900n);
    // the reversed software expense nets to zero and disappears
    expect(pnl.expenses.map((e) => e.code)).toEqual(["5110", "5130"]);
  });

  it("respects the date range (October only)", async () => {
    const pnl = await profitAndLoss(t.db, "2026-10-01", "2026-10-31");
    expect(pnl.netIncome).toBe(500000n - 4900n - 10100n);
  });
});

describe("balance sheet", () => {
  it("balances at December 31: assets 4,399.00 = liabilities 0 + equity", async () => {
    const bs = await balanceSheet(t.db, "2026-12-31");
    expect(bs.totalAssets).toBe(439900n);
    expect(bs.totalLiabilities).toBe(0n);
    expect(bs.unclosedNetIncome).toBe(459900n);
    expect(bs.totalEquity).toBe(439900n);
    expect(bs.balanced).toBe(true);
  });
});

describe("general ledger detail and register", () => {
  it("lists entries in date order with dimensions", async () => {
    const detail = await generalLedgerDetail(t.db, {
      from: "2026-10-01",
      to: "2026-12-31",
      accountCode: investeeCode,
    });
    expect(detail).toHaveLength(1);
    expect(detail[0]).toMatchObject({ credit: 250000n, investeeId });
  });

  it("runs a cash register with correct opening/closing balances", async () => {
    const reg = await accountRegister(t.db, "1000", "2026-11-01", "2026-11-30");
    expect(reg.openingBalance).toBe(835000n);
    expect(reg.closingBalance).toBe(689900n);
    const balances = reg.lines.map((l) => l.runningBalance);
    expect(balances).toEqual([715000n, 719900n, 689900n]);
  });
});
