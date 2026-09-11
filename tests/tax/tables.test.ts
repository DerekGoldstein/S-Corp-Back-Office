import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getVerifiedTable,
  loadTaxTables,
  requireVerifiedTables,
  TaxTableError,
  verifyTaxTable,
} from "../../src/tax/tables";
import { expectDbReject, makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let dir: string;

function writeFica(values: { rate: number | null; base: number | null }): void {
  writeFileSync(
    join(dir, "2027", "fica.json"),
    JSON.stringify({
      kind: "fica",
      source_url: "https://example.gov/2027-fica",
      effective_from: "2027-01-01",
      payload: {
        _instructions: "test fixture",
        social_security_rate: values.rate,
        social_security_wage_base_cents: values.base,
      },
    }),
  );
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tax-tables-"));
  mkdirSync(join(dir, "2027"), { recursive: true });
  process.env.TAX_TABLES_DIR = dir;
  t = await makeTestDb();
});

afterAll(async () => {
  await t.drop();
  delete process.env.TAX_TABLES_DIR;
});

describe("tax-table registry (§4.4 gate)", () => {
  it("loads placeholder files as unverified; the gate refuses to serve them", async () => {
    writeFica({ rate: null, base: null });
    const report = await loadTaxTables(t.db, 2027);
    expect(report).toEqual([{ kind: "fica", action: "loaded_unverified", id: expect.any(Number) }]);
    await expect(getVerifiedTable(t.db, 2027, "fica")).rejects.toThrow(/not verified_by_owner/);
    await expect(getVerifiedTable(t.db, 2027, "fica")).rejects.toThrow(/refuses to run/);
  });

  it("refuses to verify a payload that still contains placeholders", async () => {
    const report = await loadTaxTables(t.db, 2027); // unchanged
    expect(report[0]!.action).toBe("unchanged");
    await expect(verifyTaxTable(t.db, report[0]!.id)).rejects.toThrow(/placeholder/);
  });

  it("verifies real values and serves them; re-loading unchanged is a no-op", async () => {
    writeFica({ rate: 0.062, base: 18450000 });
    const [loaded] = await loadTaxTables(t.db, 2027);
    await verifyTaxTable(t.db, loaded!.id);
    const { payload } = await getVerifiedTable<{ social_security_rate: number }>(
      t.db,
      2027,
      "fica",
    );
    expect(payload.social_security_rate).toBe(0.062);
    const again = await loadTaxTables(t.db, 2027);
    expect(again[0]!.action).toBe("unchanged");
  });

  it("a changed file supersedes the verified version and everything fails loudly until re-verified", async () => {
    writeFica({ rate: 0.062, base: 19000000 }); // wage base "updated"
    const [loaded] = await loadTaxTables(t.db, 2027);
    expect(loaded!.action).toBe("superseded_verified");
    await expect(getVerifiedTable(t.db, 2027, "fica")).rejects.toThrow(/CHANGED without re-verification/);
    await expect(requireVerifiedTables(t.db, 2027, ["fica"])).rejects.toThrow(/not ready/);
    await verifyTaxTable(t.db, loaded!.id);
    const { payload } = await getVerifiedTable<{ social_security_wage_base_cents: number }>(
      t.db,
      2027,
      "fica",
    );
    expect(payload.social_security_wage_base_cents).toBe(19000000);
  });

  it("missing kinds and missing years fail with §4.4 guidance", async () => {
    await expect(getVerifiedTable(t.db, 2027, "pub15t")).rejects.toThrow(/no pub15t table loaded/);
    await expect(loadTaxTables(t.db, 2031)).rejects.toThrow(TaxTableError);
  });

  it("verified rows are immutable in the database itself", async () => {
    const r = await t.pool.query(
      `SELECT id FROM tax_table_versions WHERE verified_by_owner ORDER BY id DESC LIMIT 1`,
    );
    const id = r.rows[0].id as number;
    await expectDbReject(
      t.pool,
      `UPDATE tax_table_versions SET payload = '{}'::jsonb WHERE id = ${id}`,
      /immutable/,
    );
    await expectDbReject(
      t.pool,
      `UPDATE tax_table_versions SET verified_by_owner = false, verified_at = NULL WHERE id = ${id}`,
      /cannot be revoked/,
    );
    await expectDbReject(t.pool, `DELETE FROM tax_table_versions WHERE id = ${id}`, /immutable/);
  });

  it("the real 2027 placeholder files in the repo load and are refused verification", async () => {
    delete process.env.TAX_TABLES_DIR;
    const report = await loadTaxTables(t.db, 2027);
    expect(report.length).toBeGreaterThanOrEqual(3); // fica, futa, limits_401k
    for (const r of report.filter((x) => x.action !== "unchanged")) {
      await expect(verifyTaxTable(t.db, r.id)).rejects.toThrow(/placeholder/);
    }
    process.env.TAX_TABLES_DIR = dir;
  });
});
