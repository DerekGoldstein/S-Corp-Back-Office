/**
 * §4.11 end to end on a rich fixture: golden close year + a posted K-1 with
 * basis + frozen comp methodology. Box 19 is deliberately left unreconciled
 * so the red-item path (owner notes, guardrail 8) is exercised.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildReviewPackage,
  finalizePackage,
  PackageError,
  recordCpaSignoff,
  runTieOuts,
} from "../../src/package/tieouts";
import { closeYear } from "../../src/ledger/close";
import { createInvestee } from "../../src/ledger/investees";
import { postEntry } from "../../src/ledger/posting";
import { confirmK1, createK1, postK1, rollForwardBasis, setK1Fields } from "../../src/k1/k1";
import { createMethodology, ensureDefaultTaskTypes, freezeMethodology } from "../../src/time/comp";
import { readDocument } from "../../src/vault/store";
import { makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let investeeId: number;

beforeAll(async () => {
  process.env.VAULT_DIR = mkdtempSync(join(tmpdir(), "vault-"));
  t = await makeTestDb();
  const inv = await createInvestee(t.db, {
    name: "Factoring LLC",
    entityType: "partnership",
    ownershipPct: "50",
    acquiredOn: "2026-01-15",
    initialContribution: 100000n,
  });
  investeeId = inv.investee.id;
  await postEntry(t.db, {
    entryDate: "2026-01-20",
    memo: "capital",
    sourceModule: "manual",
    lines: [
      { accountCode: "1000", debit: 1000000n },
      { accountCode: "3000", credit: 1000000n },
    ],
  });
  await postEntry(t.db, {
    entryDate: "2026-03-01",
    memo: "consulting",
    sourceModule: "manual",
    lines: [
      { accountCode: "1000", debit: 500000n },
      { accountCode: "4000", credit: 500000n },
    ],
  });
  const doc = await t.pool.query(
    `INSERT INTO documents (filename, mime, sha256, size_bytes)
     VALUES ('k1-2026.pdf','application/pdf','pkg-k1',10) RETURNING id`,
  );
  const k1id = await createK1(t.db, {
    investeeId,
    taxYear: 2026,
    documentId: BigInt(doc.rows[0].id),
  });
  await setK1Fields(
    t.db,
    k1id,
    [
      { boxCode: "1", valueCents: 250000n },
      { boxCode: "19A", valueCents: 150000n }, // no wires classified → red box-19
    ],
    "owner",
  );
  await confirmK1(t.db, k1id);
  await postK1(t.db, k1id);
  await rollForwardBasis(t.db, investeeId, 2026);
  await ensureDefaultTaskTypes(t.db);
  const m = await createMethodology(t.db, {
    version: 1,
    description: "median market rates",
    parameters: { rateAggregation: "median" },
  });
  await freezeMethodology(t.db, m.id);
  await closeYear(t.db, 2026);
});

afterAll(async () => {
  await t.drop();
});

describe("tie-out runner", () => {
  it("runs every check and reports the deliberate box-19 gap as the only red", async () => {
    const tieOuts = await runTieOuts(t.db, 2026);
    const red = tieOuts.filter((x) => !x.pass);
    expect(red).toHaveLength(1);
    expect(red[0]!.key).toBe(`box19_${investeeId}`);
    expect(red[0]!.detail).toContain("1,500.00");
    const keys = tieOuts.map((x) => x.key);
    expect(keys).toContain("cash_reconciled");
    expect(keys).toContain("periods_locked");
    expect(keys).toContain("comp_evidence");
    expect(keys).toContain(`k1_${investeeId}`);
    expect(tieOuts.find((x) => x.key === "periods_locked")!.pass).toBe(true);
  });
});

describe("review package (guardrail 8)", () => {
  it("builds v1 with a vaulted cover memo listing the open item first", async () => {
    const pkg = await buildReviewPackage(t.db, 2026);
    expect(pkg.version).toBe(1);
    expect(pkg.redCount).toBe(1);
    const memo = await readDocument(t.db, pkg.coverDocumentId);
    const text = memo.bytes.toString("utf8");
    expect(text).toContain("OPEN ITEMS — start here (1)");
    expect(text).toContain("box 19");
    expect(text).toContain("🟢");
  });

  it("refuses 'final' with a red tie-out, and 'final with open items' without a note", async () => {
    const pkg = await buildReviewPackage(t.db, 2026);
    await expect(finalizePackage(t.db, pkg.packageId, "final")).rejects.toThrow(PackageError);
    await expect(finalizePackage(t.db, pkg.packageId, "final")).rejects.toThrow(/guardrail 8/);
    await expect(
      finalizePackage(t.db, pkg.packageId, "final_with_open_items"),
    ).rejects.toThrow(/owner note/);
  });

  it("finalizes with open items once every red row carries an owner note; version is then immutable", async () => {
    const pkg = await buildReviewPackage(t.db, 2026, {
      [`box19_${investeeId}`]:
        "distribution wire arrived Jan 2 (in transit at 12/31) — reconciles in January",
    });
    await finalizePackage(t.db, pkg.packageId, "final_with_open_items");
    await expect(
      t.pool.query(`UPDATE review_packages SET tie_outs='[]'::jsonb WHERE id=${pkg.packageId}`),
    ).rejects.toThrow(/immutable/);
    await recordCpaSignoff(t.db, pkg.packageId, "Reviewed; open item is timing only. — CPA");
    const r = await t.pool.query(
      `SELECT cpa_comments, signed_off_at FROM review_packages WHERE id=${pkg.packageId}`,
    );
    expect(r.rows[0].cpa_comments).toContain("timing only");
    expect(r.rows[0].signed_off_at).not.toBeNull();
  });

  it("a rerun after fixing produces the next version with all green and takes 'final'", async () => {
    // the missing wire arrives and is classified to the 15xx account;
    // December is unlocked (audited) for the correction and relocked after
    await t.pool.query(`SELECT unlock_period(2026::smallint, 12::smallint, 'wire in transit at 12/31')`);
    await t.pool.query(`
      WITH e AS (
        INSERT INTO journal_entries (entry_date, memo, source_module, source_id)
        VALUES ('2026-12-30','distribution wire','bank', 424242) RETURNING id
      ), l1 AS (
        INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit)
        SELECT id, 1, (SELECT id FROM accounts WHERE code='1000'), 150000, 0 FROM e
      )
      INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, investee_id)
      SELECT id, 2, (SELECT id FROM accounts WHERE investee_id = ${investeeId}), 0, 150000, ${investeeId} FROM e
    `);
    await t.pool.query(`
      UPDATE periods SET locked = true, locked_at = now() WHERE tax_year = 2026 AND month = 12
    `);
    const pkg = await buildReviewPackage(t.db, 2026);
    expect(pkg.version).toBeGreaterThanOrEqual(3);
    expect(pkg.redCount).toBe(0);
    await finalizePackage(t.db, pkg.packageId, "final");
  });
});
