/**
 * Year-end close, hand-computed in cents:
 *   revenue 500,000 (4000) + tax-exempt 20,000 (4600, OAA)
 *   meals 10,101 (5130 — odd total: splitHalf keeps 5,050 deductible,
 *     moves 5,051 disallowed to 5900), software 4,900 (5100),
 *   nondeductible-related-to-exempt 3,000 (4615, OAA)
 *   distributions 120,000 (3200)
 *
 *   NI = 520,000 − (5,050 + 5,051 + 4,900 + 3,000) = 501,999
 *   OAA = 20,000 − 3,000 = 17,000
 *   AAA = 501,999 − 17,000 = 484,999; after distributions 364,999
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePreconditions, closeYear, CloseError, reopenYear } from "../../src/ledger/close";
import { postEntry } from "../../src/ledger/posting";
import { balanceSheet, trialBalance } from "../../src/ledger/reports";
import { makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;

async function post(
  date: string,
  memo: string,
  lines: Array<{ accountCode: string; debit?: bigint; credit?: bigint }>,
  documentIds?: bigint[],
) {
  return postEntry(t.db, { entryDate: date, memo, sourceModule: "manual", lines, documentIds });
}

beforeAll(async () => {
  t = await makeTestDb();
  const doc = await t.pool.query(
    `INSERT INTO documents (filename, mime, sha256, size_bytes)
     VALUES ('meals.jpg','image/jpeg','close-sha-1',10) RETURNING id`,
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
});

afterAll(async () => {
  await t.drop();
});

describe("closeYear", () => {
  it("has clean preconditions with no bank accounts and an empty queue", async () => {
    expect(await closePreconditions(t.db, 2026)).toEqual([]);
  });

  it("reclasses meals, splits AAA/OAA, closes distributions — to the cent", async () => {
    const s = await closeYear(t.db, 2026);
    expect(s.mealsReclassed).toBe(5051n); // odd cent disallowed
    expect(s.netIncome).toBe(501999n);
    expect(s.oaaPortion).toBe(17000n); // 200.00 exempt − 30.00 related nondeductible
    expect(s.aaaPortion).toBe(484999n);
    expect(s.distributionsClosed).toBe(120000n);

    const tb = await trialBalance(t.db, "2026-12-31");
    const row = (code: string) => tb.rows.find((r) => r.code === code);
    expect(row("3100")).toMatchObject({ credit: 364999n }); // AAA − distributions
    expect(row("3110")).toMatchObject({ credit: 17000n });
    expect(row("3200")).toBeUndefined(); // closed to zero
    expect(row("3900")).toBeUndefined();
    expect(row("4000")).toBeUndefined();
    expect(row("5130")).toBeUndefined();
    expect(row("5900")).toBeUndefined();

    const bs = await balanceSheet(t.db, "2026-12-31");
    expect(bs.unclosedNetIncome).toBe(0n);
    expect(bs.balanced).toBe(true);
    // cash: 10,000.00 + 5,000.00 + 200.00 − 101.01 − 49.00 − 30.00 − 1,200.00 = 13,819.99
    expect(bs.totalAssets).toBe(1381999n);
    expect(bs.totalEquity).toBe(1381999n);
  });

  it("locks the year: nothing can post into it afterwards", async () => {
    await expect(
      post("2026-09-15", "late entry", [
        { accountCode: "5100", debit: 100n },
        { accountCode: "1000", credit: 100n },
      ]),
    ).rejects.toThrow(/locked/);
  });

  it("refuses a second close", async () => {
    await expect(closeYear(t.db, 2026)).rejects.toThrow(CloseError);
    await expect(closeYear(t.db, 2026)).rejects.toThrow(/already/);
  });

  it("reopenYear restores pre-close balances exactly, then re-closes to the same result", async () => {
    await reopenYear(t.db, 2026, "found a missing receipt");
    const tb = await trialBalance(t.db, "2026-12-31");
    const row = (code: string) => tb.rows.find((r) => r.code === code);
    expect(row("3100")).toBeUndefined();
    expect(row("3110")).toBeUndefined();
    expect(row("4000")).toMatchObject({ credit: 500000n });
    expect(row("5130")).toMatchObject({ debit: 10101n }); // reclass reversed
    expect(row("3200")).toMatchObject({ debit: 120000n });
    const s2 = await closeYear(t.db, 2026);
    expect(s2.netIncome).toBe(501999n);
    expect(s2.aaaPortion).toBe(484999n);
  });
});
