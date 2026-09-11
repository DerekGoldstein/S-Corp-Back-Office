/**
 * The register end to end against real Postgres: add → annual posting
 * (Dr 5050 / Cr 1610) with the cohort mid-quarter test frozen onto assets,
 * §179/bonus gated by the verified `depreciation` table, ordering enforced,
 * reversal → repost, the 4562 workpaper tying to the ledger to the cent —
 * including a deliberately RED register-vs-1600 tie-out (purchases were
 * never classified to 1600 in this fixture, and the workpaper must say so).
 * All limit values here are SYNTHETIC test data, not real-year figures.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AssetError,
  addAsset,
  computeYearDepreciation,
  listAssets,
  postAnnualDepreciation,
  postedForYear,
  recordDisposal,
} from "../../src/assets/register";
import { buildF4562 } from "../../src/workpapers/f4562";
import { loadTaxTables, verifyTaxTable } from "../../src/tax/tables";
import { postReversal } from "../../src/ledger/posting";
import { trialBalance } from "../../src/ledger/reports";
import { storeDocument } from "../../src/vault/store";
import { makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let dir: string;

const SYNTHETIC_LIMITS = {
  section179_limit_cents: 5_000_000, // $50,000 — synthetic
  section179_phaseout_start_cents: 20_000_000, // $200,000 — synthetic
  bonus_pct: "40%", // synthetic
};

async function makeDoc(name: string): Promise<bigint> {
  const { document } = await storeDocument(t.db, {
    filename: name,
    mime: "application/pdf",
    bytes: Buffer.from(`invoice ${name}`),
  });
  return document.id;
}

async function verifiedTables(year: number): Promise<void> {
  mkdirSync(join(dir, String(year)), { recursive: true });
  writeFileSync(
    join(dir, String(year), "depreciation.json"),
    JSON.stringify({
      kind: "depreciation",
      source_url: "https://example.gov/synthetic-depreciation",
      payload: SYNTHETIC_LIMITS,
    }),
  );
  const report = await loadTaxTables(t.db, year);
  for (const r of report) if (r.action !== "unchanged") await verifyTaxTable(t.db, r.id);
}

beforeAll(async () => {
  process.env.VAULT_DIR = mkdtempSync(join(tmpdir(), "vault-"));
  dir = mkdtempSync(join(tmpdir(), "dep-tables-"));
  process.env.TAX_TABLES_DIR = dir;
  t = await makeTestDb();
});

afterAll(async () => {
  await t.drop();
  delete process.env.TAX_TABLES_DIR;
});

describe("addAsset validation", () => {
  it("refuses pre-election assets, odd recovery periods, and over-basis §179", async () => {
    const doc = await makeDoc("old.pdf");
    await expect(
      addAsset(t.db, {
        description: "pre-election laptop",
        placedInService: "2026-11-01",
        cost: 100_000n,
        method: "macrs_200db",
        recoveryYears: 5,
        documentId: doc,
      }),
    ).rejects.toThrow(/opening balances/);
    await expect(
      addAsset(t.db, {
        description: "building",
        placedInService: "2027-02-01",
        cost: 100_000n,
        method: "sl",
        recoveryYears: 39 as never,
        documentId: doc,
      }),
    ).rejects.toThrow(/real property/);
    await expect(
      addAsset(t.db, {
        description: "over-elected",
        placedInService: "2027-02-01",
        cost: 100_000n,
        section179: 200_000n,
        method: "macrs_200db",
        recoveryYears: 5,
        documentId: doc,
      }),
    ).rejects.toThrow(/within the depreciable basis/);
    await expect(
      addAsset(t.db, {
        description: "half-personal camera",
        placedInService: "2027-02-01",
        cost: 100_000n,
        businessUsePct: "50%",
        takeBonus: true,
        method: "macrs_200db",
        recoveryYears: 5,
        documentId: doc,
      }),
    ).rejects.toThrow(/more-than-50% business use/);
  });
});

describe("annual posting", () => {
  it("2027: no elections, cohort stays half-year (Q4 under 40%), posts Dr 5050 / Cr 1610", async () => {
    await addAsset(t.db, {
      description: "laptop",
      placedInService: "2027-03-10",
      cost: 300_000n, // $3,000 5-yr: year 1 HY = 3000*2/5*1/2 = $600.00
      method: "macrs_200db",
      recoveryYears: 5,
      documentId: await makeDoc("laptop.pdf"),
    });
    await addAsset(t.db, {
      description: "desk",
      placedInService: "2027-11-05",
      cost: 140_000n, // $1,400 7-yr: year 1 HY = 1400*2/7*1/2 = $200.00
      method: "macrs_200db",
      recoveryYears: 7,
      documentId: await makeDoc("desk.pdf"),
    });
    // Q4 share: 1400/4400 = 31.8% <= 40% → half-year for the cohort
    const { total, assets } = await postAnnualDepreciation(t.db, 2027);
    expect(assets).toBe(2);
    expect(total).toBe(80_000n);
    const tb = await trialBalance(t.db, "2027-12-31");
    expect(tb.rows.find((r) => r.code === "5050")).toMatchObject({ debit: 80_000n });
    expect(tb.rows.find((r) => r.code === "1610")).toMatchObject({ credit: 80_000n });
    const frozen = await listAssets(t.db);
    expect(frozen.every((a) => a.convention === "half_year")).toBe(true);
    await expect(postAnnualDepreciation(t.db, 2027)).rejects.toThrow(/already posted/);
  });

  it("2028: a Q4 §179+bonus election makes its cohort mid-quarter; limits come from the verified table", async () => {
    await verifiedTables(2028);
    await addAsset(t.db, {
      description: "server rig",
      placedInService: "2028-12-01",
      cost: 1_000_000n, // $10,000: 179 $3,000 → 7,000; bonus 40% → 2,800; MACRS basis 4,200
      section179: 300_000n,
      takeBonus: true,
      method: "macrs_200db",
      recoveryYears: 5,
      documentId: await makeDoc("server.pdf"),
    });
    // server rig year 1 (MQ Q4): 4200*2/5*(1.5/12) = $210.00
    // laptop year 2: 2400*2/5 = $960.00; desk year 2: 1200*2/7 = $342.86
    const comp = await computeYearDepreciation(t.db, 2028);
    expect(comp.cohortConvention).toBe("mid_quarter");
    expect(comp.section179Total).toBe(300_000n);
    expect(comp.bonusTotal).toBe(280_000n);
    expect(comp.total).toBe(601_000n + 96_000n + 34_286n);
    const { total } = await postAnnualDepreciation(t.db, 2028);
    expect(total).toBe(731_286n);
    const rig = (await listAssets(t.db)).find((a) => a.description === "server rig")!;
    expect(rig.convention).toBe("mid_quarter");
    expect(rig.bonusApplied).toBe(280_000n);
    const tb = await trialBalance(t.db, "2028-12-31");
    expect(tb.rows.find((r) => r.code === "1610")).toMatchObject({ credit: 811_286n });
  });

  it("reversing the year's entry allows an identical repost", async () => {
    const [row] = await postedForYear(t.db, 2028);
    await postReversal(t.db, row!.journal_entry_id, "2028-12-31", "re-run depreciation");
    expect(await postedForYear(t.db, 2028)).toHaveLength(0);
    const { total } = await postAnnualDepreciation(t.db, 2028);
    expect(total).toBe(731_286n);
  });
});

describe("form 4562 workpaper", () => {
  it("ties line 22 and 1610 to the ledger and honestly REDS the unposted-1600 tie-out", async () => {
    const wp = await buildF4562(t.db, 2028);
    expect(wp.line22_total).toBe("7,312.86");
    expect(wp.part1.line12_deduction).toBe("3,000.00");
    expect(wp.line14_bonus).toBe("2,800.00");
    expect(wp.part3_macrs.length).toBeGreaterThanOrEqual(2);
    const [t22, t1600, t1610] = wp.tieOuts;
    expect(t22!.pass).toBe(true); // 5050 activity 2028 = 731,286 (reversal pair cancels)
    expect(t1600!.pass).toBe(false); // purchases never classified to 1600 in this fixture
    expect(t1610!.pass).toBe(true); // cumulative subledger = 1610 balance
  });
});

describe("guard rails", () => {
  it("a §179 election over the year limit refuses to post", async () => {
    await verifiedTables(2029);
    await addAsset(t.db, {
      description: "render farm",
      placedInService: "2029-06-01",
      cost: 6_000_000n,
      section179: 5_500_000n, // over the synthetic $50,000 limit
      method: "macrs_200db",
      recoveryYears: 5,
      documentId: await makeDoc("farm.pdf"),
    });
    await expect(postAnnualDepreciation(t.db, 2029)).rejects.toThrow(/exceed the 2029 dollar limit/);
  });

  it("a disposal inside the year refuses automatic depreciation (CPA-manual)", async () => {
    const desk = (await listAssets(t.db)).find((a) => a.description === "desk")!;
    await recordDisposal(t.db, desk.id, "2029-05-01");
    await expect(computeYearDepreciation(t.db, 2029)).rejects.toThrow(AssetError);
    await expect(computeYearDepreciation(t.db, 2029)).rejects.toThrow(/disposed in 2029/);
  });
});
