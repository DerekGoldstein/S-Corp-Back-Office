/**
 * Calendar dates verified by hand for 2027 (Jan 1, 2027 is a Friday):
 *   Jan 31 2027 = Sunday → Feb 1 (Mon) — but the test holiday table marks
 *     Feb 1 a holiday → Feb 2 (Tue)
 *   Apr 30 = Friday (stays) · Jul 31 = Saturday → Aug 2 (Mon)
 *   Oct 31 = Sunday → Nov 1 (Mon) · Mar 15 = Monday (stays)
 *   Biennial (formed Aug 2024): 2026 ✓ (Aug 31 2026, Monday), 2027 ✗, 2028 ✓
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CalendarError,
  completeCalendarItem,
  generateCalendar,
  listCalendar,
  loadCalendarRules,
  rollToBusinessDay,
} from "../../src/calendar/calendar";
import { loadTaxTables, verifyTaxTable } from "../../src/tax/tables";
import { appConfig } from "../../src/db/schema";
import { makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let dir: string;

async function loadHolidays(year: number, dates: string[]): Promise<void> {
  mkdirSync(join(dir, String(year)), { recursive: true });
  writeFileSync(
    join(dir, String(year), "holidays.json"),
    JSON.stringify({
      kind: "holidays",
      source_url: "https://www.opm.gov/ + NYS (test fixture)",
      payload: { dates },
    }),
  );
  const report = await loadTaxTables(t.db, year);
  for (const r of report) {
    if (r.action !== "unchanged") await verifyTaxTable(t.db, r.id);
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "cal-tables-"));
  process.env.TAX_TABLES_DIR = dir;
  t = await makeTestDb();
  await loadCalendarRules(t.db);
  await loadHolidays(2027, ["2027-01-01", "2027-02-01", "2027-07-05", "2027-12-24"]);
  await loadHolidays(2026, ["2026-01-01", "2026-07-03", "2026-12-25"]);
});

afterAll(async () => {
  await t.drop();
  delete process.env.TAX_TABLES_DIR;
});

describe("business-day rollover", () => {
  it("rolls weekends and holidays forward", () => {
    const holidays = new Set(["2027-02-01"]);
    expect(rollToBusinessDay("2027-01-29", holidays)).toBe("2027-01-29"); // Friday
    expect(rollToBusinessDay("2027-01-30", holidays)).toBe("2027-02-02"); // Sat → Mon holiday → Tue
    expect(rollToBusinessDay("2027-01-31", holidays)).toBe("2027-02-02"); // Sun → same
  });
});

describe("generateCalendar 2027", () => {
  it("refuses to generate without a verified holidays table", async () => {
    await expect(generateCalendar(t.db, 2031)).rejects.toThrow(/no holidays table/);
  });

  it("creates the year's items with rolled dates; conditionals are n/a until configured", async () => {
    const report = await generateCalendar(t.db, 2027);
    expect(report.created).toBeGreaterThan(0);
    expect(report.na).toBeGreaterThan(0); // ptet_estimates + 5500-EZ conditions unset
    const items = await listCalendar(t.db, 2027);
    const bySlugLabel = (s: string) => items.filter((i) => i.label.includes(s));

    // owner estimates: Apr 15 (Thu), Jun 15 (Tue), Sep 15 (Wed), Jan 15 (Fri) — none roll
    const es = bySlugLabel("1040-ES");
    expect(es.map((i) => i.dueDate).sort()).toEqual([
      "2027-01-15",
      "2027-04-15",
      "2027-06-15",
      "2027-09-15",
    ]);
    // PTET election decision: Mar 15 2027 is a Monday
    expect(bySlugLabel("PTET election")[0]!.dueDate).toBe("2027-03-15");
    // pre-year consent: Dec 31 2027 is a Friday
    expect(bySlugLabel("Pre-year written consent")[0]!.dueDate).toBe("2027-12-31");
    // PTET estimates exist but n/a (condition unset)
    const ptet = bySlugLabel("PTET estimated");
    expect(ptet).toHaveLength(4);
    expect(ptet.every((i) => i.status === "na")).toBe(true);
    // biennial statement is not a 2027 item (even years only)
    expect(bySlugLabel("biennial")).toHaveLength(0);
    // payroll annual filings only apply from 2028
    expect(bySlugLabel("Form 941")).toHaveLength(0);
  });

  it("is idempotent", async () => {
    const again = await generateCalendar(t.db, 2027);
    expect(again.created).toBe(0);
    expect(again.na).toBe(0);
    expect(again.skipped).toBeGreaterThan(0);
  });

  it("activating the PTET condition makes the next generated year's estimates live", async () => {
    await t.db.insert(appConfig).values({ key: "ptet_elected", value: "1" });
    await loadHolidays(2028, ["2028-01-01", "2028-07-04", "2028-12-25"]);
    const r = await generateCalendar(t.db, 2028);
    expect(r.created).toBeGreaterThan(0);
    const items = await listCalendar(t.db, 2028);
    const ptet = items.filter((i) => i.label.includes("PTET estimated"));
    expect(ptet).toHaveLength(4);
    expect(ptet.every((i) => i.status === "upcoming")).toBe(true);
    // 2028 has the biennial statement (Aug 31 2028 = Thursday) and payroll filings
    expect(items.some((i) => i.label.includes("biennial"))).toBe(true);
    const jan31 = items.find((i) => i.label.includes("Form 941"))!;
    // Jan 31 2028 is a Monday — stays; labeled for tax year 2027
    expect(jan31.dueDate).toBe("2028-01-31");
    expect(jan31.label).toContain("tax year 2027");
  });
});

describe("completion with filing confirmations", () => {
  it("attaches the confirmation document and completes the item", async () => {
    const items = await listCalendar(t.db, 2027);
    const item = items.find((i) => i.status === "upcoming")!;
    const doc = await t.pool.query(
      `INSERT INTO documents (filename, mime, sha256, size_bytes)
       VALUES ('confirmation.pdf','application/pdf','cal-sha-1',10) RETURNING id`,
    );
    await completeCalendarItem(t.db, item.id, {
      documentId: BigInt(doc.rows[0].id),
      note: "filed online, confirmation attached",
    });
    const after = (await listCalendar(t.db, 2027)).find((i) => i.id === item.id)!;
    expect(after.status).toBe("done");
    expect(after.documentId).not.toBeNull();
    await expect(completeCalendarItem(t.db, item.id, {})).rejects.toThrow(CalendarError);
  });
});
