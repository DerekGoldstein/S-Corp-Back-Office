/**
 * K-1 cycle, hand-computed:
 * 2026 — box1 +2,500.00, box5 +60.00, box9a −400.00 (LT loss), box12 §179
 * 200.00, box18A exempt 100.00, box18C nondeductible 50.00, box19A
 * distributions 1,500.00, item L ending 2,000.00.
 * Posting: asset net = 2500 + 60 − 400 − 200 + 100 − 50 = 2,010.00 debit.
 * Basis (initial contribution 1,000.00): 0 + 1,000 + 2,560 + 100 = 3,660 →
 * −1,500 dist → 2,160 → −50 nondeduct → 2,110 → losses 600 allowed → ending
 * 1,510.00, nothing suspended.
 * 2027 — box1 −3,000.00, 19A 600.00: 1,510 − 600 = 910 allowed loss, 2,090
 * suspended, ending 0.
 * 2028 — box1 +500.00, 19A 800.00: 500 available, 500 applied, 300.00 EXCESS
 * distribution (gain flag); prior suspended 2,090 stays suspended; ending 0.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  box19Reconciliation,
  confirmK1,
  createK1,
  K1Error,
  postK1,
  rollForwardBasis,
  setK1Fields,
} from "../../src/k1/k1";
import { createInvestee } from "../../src/ledger/investees";
import { postEntry } from "../../src/ledger/posting";
import { trialBalance } from "../../src/ledger/reports";
import { makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let investeeId: number;
let assetCode: string;
let docId: bigint;
let k1id2026: bigint;

async function makeDoc(name: string): Promise<bigint> {
  const r = await t.pool.query(
    `INSERT INTO documents (filename, mime, sha256, size_bytes)
     VALUES ($1,'application/pdf',$1,10) RETURNING id`,
    [name],
  );
  return BigInt(r.rows[0].id);
}

beforeAll(async () => {
  t = await makeTestDb();
  const inv = await createInvestee(t.db, {
    name: "Factoring LLC",
    entityType: "partnership",
    ownershipPct: "50",
    acquiredOn: "2026-01-15",
    initialContribution: 100000n,
  });
  investeeId = inv.investee.id;
  assetCode = inv.accountCode;
  docId = await makeDoc("k1-2026.pdf");
  // the wire that arrived during 2026, classified per §4.2 (credit 15xx)
  await postEntry(t.db, {
    entryDate: "2026-07-01",
    memo: "distribution wire",
    sourceModule: "bank",
    sourceId: 99n,
    lines: [
      { accountCode: "1000", debit: 140000n },
      { accountCode: assetCode, credit: 140000n, investeeId },
    ],
  });
});

afterAll(async () => {
  await t.drop();
});

describe("K-1 creation and review gate", () => {
  it("rejects K-1s for non-partnership investees", async () => {
    const c = await createInvestee(t.db, {
      name: "Widget C Corp",
      entityType: "c_corporation",
      ownershipPct: "10",
      acquiredOn: "2026-01-01",
    });
    await expect(
      createK1(t.db, { investeeId: c.investee.id, taxYear: 2026, documentId: docId }),
    ).rejects.toThrow(/only partnerships issue/);
  });

  it("blocks confirmation while low-confidence extracted fields are untouched (guardrail 5)", async () => {
    k1id2026 = await createK1(t.db, { investeeId, taxYear: 2026, documentId: docId });
    await setK1Fields(
      t.db,
      k1id2026,
      [
        { boxCode: "1", valueCents: 250000n, confidence: "low" },
        { boxCode: "5", valueCents: 6000n, confidence: "high" },
        { boxCode: "9a", valueCents: -40000n, confidence: "high" },
        { boxCode: "12", valueCents: 20000n, confidence: "high" },
        { boxCode: "18A", valueCents: 10000n, confidence: "high" },
        { boxCode: "18C", valueCents: 5000n, confidence: "high" },
        { boxCode: "19A", valueCents: 150000n, confidence: "low" },
        { boxCode: "L.ending", valueCents: 200000n, confidence: "high" },
      ],
      "extraction",
    );
    await expect(confirmK1(t.db, k1id2026)).rejects.toThrow(/low-confidence/);
    await expect(confirmK1(t.db, k1id2026)).rejects.toThrow(/box 1, box 19A/);
    // owner reviews both against the PDF (one corrected to the same value)
    await setK1Fields(
      t.db,
      k1id2026,
      [
        { boxCode: "1", valueCents: 250000n },
        { boxCode: "19A", valueCents: 150000n },
      ],
      "owner",
    );
    await confirmK1(t.db, k1id2026);
  });

  it("freezes fields after confirmation", async () => {
    await expect(
      setK1Fields(t.db, k1id2026, [{ boxCode: "1", valueCents: 1n }], "owner"),
    ).rejects.toThrow(/frozen/);
  });
});

describe("posting (character preserved)", () => {
  it("posts one entry with each box on its separately-stated account", async () => {
    const { entryId } = await postK1(t.db, k1id2026);
    const tb = await trialBalance(t.db, "2026-12-31");
    const row = (code: string) => tb.rows.find((r) => r.code === code);
    expect(row("4500")).toMatchObject({ credit: 250000n });
    expect(row("4510")).toMatchObject({ credit: 6000n });
    expect(row("4550")).toMatchObject({ debit: 40000n }); // LT loss keeps character
    expect(row("4580")).toMatchObject({ debit: 20000n });
    expect(row("4600")).toMatchObject({ credit: 10000n });
    expect(row("4610")).toMatchObject({ debit: 5000n });
    // asset: −1,400.00 wire + 2,010.00 K-1 net = +610.00
    expect(row(assetCode)).toMatchObject({ debit: 61000n });
    const dims = await t.pool.query(
      `SELECT count(*)::int AS n FROM journal_lines
       WHERE entry_id = $1 AND (investee_id IS NULL OR k1_id IS NULL)`,
      [entryId.toString()],
    );
    expect(dims.rows[0].n).toBe(0); // every line carries the dimensions
    await expect(postK1(t.db, k1id2026)).rejects.toThrow(/only confirmed/);
  });

  it("rejects unmapped box codes instead of guessing character", async () => {
    const doc = await makeDoc("k1-weird.pdf");
    const inv2 = await createInvestee(t.db, {
      name: "Other Partners LP",
      entityType: "partnership",
      ownershipPct: "5",
      acquiredOn: "2026-01-01",
    });
    const id = await createK1(t.db, { investeeId: inv2.investee.id, taxYear: 2026, documentId: doc });
    await setK1Fields(t.db, id, [{ boxCode: "13Z", valueCents: 100n }], "owner");
    await confirmK1(t.db, id);
    await expect(postK1(t.db, id)).rejects.toThrow(/unrecognized box code/i);
  });
});

describe("box 19 reconciliation", () => {
  it("compares K-1 distributions to the classified wires and reports the gap", async () => {
    const r = await box19Reconciliation(t.db, k1id2026);
    expect(r.k1Distributions).toBe(150000n);
    expect(r.bankClassifiedWires).toBe(140000n);
    expect(r.difference).toBe(10000n);
    expect(r.explanationNeeded).toBe(true);
  });
});

describe("outside basis roll-forward (§705 ordering)", () => {
  it("2026: distributions, nondeductibles, then losses — ending 1,510.00", async () => {
    const row = await rollForwardBasis(t.db, investeeId, 2026);
    expect(row.beginningBasis).toBe(0n);
    expect(row.contributions).toBe(100000n);
    expect(row.incomeItems).toBe(256000n);
    expect(row.taxExemptIncome).toBe(10000n);
    expect(row.distributionsApplied).toBe(150000n);
    expect(row.excessDistributions).toBe(0n);
    expect(row.nondeductiblesApplied).toBe(5000n);
    expect(row.lossDeductionItems).toBe(60000n);
    expect(row.suspendedLosses).toBe(0n);
    expect(row.endingBasis).toBe(151000n);
    expect(row.reportedCapitalAccount).toBe(200000n); // item L — never conflated
  });

  it("2027: a big loss is limited to remaining basis; the rest suspends", async () => {
    const doc = await makeDoc("k1-2027.pdf");
    const id = await createK1(t.db, { investeeId, taxYear: 2027, documentId: doc });
    await setK1Fields(
      t.db,
      id,
      [
        { boxCode: "1", valueCents: -300000n },
        { boxCode: "19A", valueCents: 60000n },
      ],
      "owner",
    );
    await confirmK1(t.db, id);
    const row = await rollForwardBasis(t.db, investeeId, 2027);
    expect(row.beginningBasis).toBe(151000n);
    expect(row.distributionsApplied).toBe(60000n);
    expect(row.lossDeductionItems).toBe(91000n);
    expect(row.suspendedLosses).toBe(209000n);
    expect(row.endingBasis).toBe(0n);
  });

  it("2028: distributions in excess of basis are flagged; suspended losses carry", async () => {
    const doc = await makeDoc("k1-2028.pdf");
    const id = await createK1(t.db, { investeeId, taxYear: 2028, documentId: doc });
    await setK1Fields(
      t.db,
      id,
      [
        { boxCode: "1", valueCents: 50000n },
        { boxCode: "19A", valueCents: 80000n },
      ],
      "owner",
    );
    await confirmK1(t.db, id);
    const row = await rollForwardBasis(t.db, investeeId, 2028);
    expect(row.beginningBasis).toBe(0n);
    expect(row.incomeItems).toBe(50000n);
    expect(row.distributionsApplied).toBe(50000n);
    expect(row.excessDistributions).toBe(30000n); // capital gain to report — open item
    expect(row.suspendedLosses).toBe(209000n);
    expect(row.endingBasis).toBe(0n);
  });

  it("requires years to roll in order and a confirmed K-1", async () => {
    await expect(rollForwardBasis(t.db, investeeId, 2030)).rejects.toThrow(K1Error);
  });
});
