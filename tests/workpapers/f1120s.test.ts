/**
 * The 1120-S workpaper on the closed golden year (same fixture as
 * close.test.ts). Hand-computed line values, in cents:
 *
 *   p1.1a 500,000 · p1.19 = software 4,900 + meals deductible 5,050 = 9,950
 *   p1.21 = 490,050 = K.1 = K.18
 *   K.16a 20,000 · K.16c = 5,051 (5900) + 3,000 (4615) = 8,051 · K.16d 120,000
 *   M-1: 501,999 book + 8,051 nondeductible − 20,000 exempt = 490,050 = K.18 ✓
 *   M-2 AAA: 0 + (490,050 − 5,051) − 120,000 = 364,999 = ledger 3100 ✓
 *   M-2 OAA: 0 + (20,000 − 3,000) = 17,000 = ledger 3110 ✓
 *   Schedule L ending: cash 1,381,999 = paid-in 1,000,000 + AAA + OAA ✓
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildF1120s, finalizeWorkpaper, saveWorkpaper, WorkpaperError } from "../../src/workpapers/f1120s";
import { closeYear } from "../../src/ledger/close";
import { postEntry } from "../../src/ledger/posting";
import { expectDbReject, makeTestDb, type TestDb } from "../helpers/db";

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
     VALUES ('meals.jpg','image/jpeg','wp-sha-1',10) RETURNING id`,
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
});

function get(lines: Array<{ code: string; cents: bigint }>, code: string): bigint {
  const l = lines.find((x) => x.code === code);
  if (!l) throw new Error(`line ${code} missing`);
  return l.cents;
}

describe("1120-S workpaper on the closed golden year", () => {
  it("page 1 includes the meals reclass but not the equity-roll close entries", async () => {
    const wp = await buildF1120s(t.db, 2026);
    expect(get(wp.page1, "p1.1a")).toBe(500000n);
    expect(get(wp.page1, "p1.19")).toBe(9950n); // 4,900 software + 5,050 deductible meals
    expect(get(wp.page1, "p1.6")).toBe(500000n);
    expect(get(wp.page1, "p1.20")).toBe(9950n);
    expect(get(wp.page1, "p1.21")).toBe(490050n);
    const p119 = wp.page1.find((l) => l.code === "p1.19")!;
    expect(p119.accounts).toEqual(["5100", "5130"]);
    expect(p119.dollars).toBe(100); // 99.50 rounds to 100 whole dollars for keying
  });

  it("Schedule K preserves character and reconciles line 18", async () => {
    const wp = await buildF1120s(t.db, 2026);
    expect(get(wp.scheduleK, "K.1")).toBe(490050n);
    expect(get(wp.scheduleK, "K.16a")).toBe(20000n);
    expect(get(wp.scheduleK, "K.16c")).toBe(8051n); // 5900 + 4615
    expect(get(wp.scheduleK, "K.16d")).toBe(120000n);
    expect(get(wp.scheduleK, "K.18")).toBe(490050n);
  });

  it("M-1 closes the loop: book + nondeductible − exempt = Schedule K income", async () => {
    const wp = await buildF1120s(t.db, 2026);
    expect(get(wp.m1, "M1.1")).toBe(501999n);
    expect(get(wp.m1, "M1.3")).toBe(8051n);
    expect(get(wp.m1, "M1.5")).toBe(20000n);
    expect(get(wp.m1, "M1.8")).toBe(490050n);
  });

  it("M-2 mirrors the close and ties to the ledger AAA/OAA", async () => {
    const wp = await buildF1120s(t.db, 2026);
    expect(get(wp.m2.aaa, "M2.a.1")).toBe(0n);
    expect(get(wp.m2.aaa, "M2.a.net")).toBe(485001n - 2n + 0n); // 490,050 − 5,051 = 484,999
    expect(get(wp.m2.aaa, "M2.a.7")).toBe(120000n);
    expect(get(wp.m2.aaa, "M2.a.8")).toBe(364999n);
    expect(get(wp.m2.oaa, "M2.d.net")).toBe(17000n);
    expect(get(wp.m2.oaa, "M2.d.8")).toBe(17000n);
  });

  it("every tie-out is green", async () => {
    const wp = await buildF1120s(t.db, 2026);
    for (const tieOut of wp.tieOuts) {
      expect(tieOut, tieOut.name + ": " + tieOut.detail).toMatchObject({ pass: true });
    }
    // Schedule L ending: cash and the equity side agree to the cent
    expect(get(wp.scheduleL.ending, "L.1")).toBe(1381999n);
    expect(get(wp.scheduleL.ending, "L.23")).toBe(1000000n);
    expect(get(wp.scheduleL.ending, "L.24")).toBe(381999n); // AAA 364,999 + OAA 17,000
  });

  it("saves versions and refuses finalize without a sign-off; final is immutable", async () => {
    const wp = await buildF1120s(t.db, 2026);
    const v1 = await saveWorkpaper(t.db, "f1120s", 2026, wp, wp.tieOuts);
    expect(v1.version).toBe(1);
    await expect(finalizeWorkpaper(t.db, v1.id, "  ")).rejects.toThrow(WorkpaperError);
    await finalizeWorkpaper(t.db, v1.id, "owner + CPA (test)");
    await expectDbReject(
      t.pool,
      `UPDATE workpapers SET payload = '{}'::jsonb WHERE id = ${v1.id}`,
      /final and immutable/,
    );
    const v2 = await saveWorkpaper(t.db, "f1120s", 2026, wp, wp.tieOuts);
    expect(v2.version).toBe(2);
  });
});
