import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeCompensation,
  CompError,
  createMethodology,
  ensureDefaultTaskTypes,
  freezeMethodology,
  renderCompMemoPack,
} from "../../src/time/comp";
import { addRateSource, addTimeEntry, parseIcs } from "../../src/time/timelog";
import { corroborationMetrics } from "../../src/db/schema";
import { expectDbReject, makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let methodologyId: number;

beforeAll(async () => {
  t = await makeTestDb();
  await ensureDefaultTaskTypes(t.db);
  const m = await createMethodology(t.db, {
    version: 1,
    description: "Hours × market median by task type, sourced from postings/surveys.",
    parameters: { rateAggregation: "median" },
  });
  methodologyId = m.id;

  // 2027 hours: 100.00 underwriting, 40.50 deal review, 10.25 admin
  for (let i = 0; i < 10; i++) {
    await addTimeEntry(t.db, {
      entryDate: `2027-0${(i % 9) + 1}-15`,
      hours: "10.00",
      taskTypeName: "credit underwriting",
    });
  }
  await addTimeEntry(t.db, {
    entryDate: "2027-03-02",
    hours: "20.25",
    taskTypeName: "deal review",
  });
  await addTimeEntry(t.db, {
    entryDate: "2027-06-09",
    hours: "20.25",
    taskTypeName: "deal review",
  });
  await addTimeEntry(t.db, {
    entryDate: "2027-12-01",
    hours: "10.25",
    taskTypeName: "admin/compliance",
  });

  // rates: underwriting median of (90, 100, 130) = 100.00/hr
  for (const [rate, cite] of [
    [9000n, "posting A"],
    [10000n, "survey B"],
    [13000n, "posting C"],
  ] as const) {
    await addRateSource(t.db, {
      taskTypeName: "credit underwriting",
      hourlyRate: rate,
      sourceKind: "survey",
      citation: cite,
      capturedOn: "2026-12-01",
    });
  }
  // deal review median of (150, 175) = 162.505 → half-up 162.51? no: (15000+17500+1)/2 = 16250.5 → 16250? integer: (15000+17500+1n)/2n = 16250n... document below
  await addRateSource(t.db, {
    taskTypeName: "deal review",
    hourlyRate: 15000n,
    sourceKind: "job_posting",
    citation: "posting D",
    conversionNote: "salary/2080",
    capturedOn: "2026-12-01",
  });
  await addRateSource(t.db, {
    taskTypeName: "deal review",
    hourlyRate: 17501n,
    sourceKind: "survey",
    citation: "survey E",
    capturedOn: "2026-12-05",
  });
  // admin: single source 60.00
  await addRateSource(t.db, {
    taskTypeName: "admin/compliance",
    hourlyRate: 6000n,
    sourceKind: "other",
    citation: "assistant market rate memo",
    capturedOn: "2026-12-01",
  });
  await t.db.insert(corroborationMetrics).values({
    period: "2027",
    metric: "deals_reviewed",
    value: "24",
    sourceNote: "investee pipeline report",
  });
});

afterAll(async () => {
  await t.drop();
});

describe("computeCompensation", () => {
  it("computes Σ hours × aggregated rate with exact cents and a full trace", async () => {
    const r = await computeCompensation(t.db, { taxYear: 2027, methodologyId });
    // underwriting: 100.00h × $100.00 = $10,000.00
    // deal review: 40.50h × median(150.00, 175.01) = 40.50 × 162.51 (16250.5 half-up 16251) = 658,165.5 → half-up 658,166 = $6,581.66
    // admin: 10.25h × $60.00 = $615.00
    const uw = r.lines.find((l) => l.taskType === "credit underwriting")!;
    expect(uw.aggregatedRate).toBe("100.00");
    expect(uw.amount).toBe("10,000.00");
    const dr = r.lines.find((l) => l.taskType === "deal review")!;
    expect(dr.hours).toBe("40.50");
    expect(dr.aggregatedRate).toBe("162.51");
    expect(dr.amount).toBe("6,581.66");
    const admin = r.lines.find((l) => l.taskType === "admin/compliance")!;
    expect(admin.amount).toBe("615.00");
    expect(r.total).toBe(1000000n + 658166n + 61500n);
    expect(r.warnings).toHaveLength(1); // not frozen yet
  });

  it("errors when logged hours have no priced rate source", async () => {
    await addTimeEntry(t.db, {
      entryDate: "2027-07-01",
      hours: "5.00",
      taskTypeName: "deal sourcing",
    });
    await expect(computeCompensation(t.db, { taxYear: 2027, methodologyId })).rejects.toThrow(
      CompError,
    );
    await expect(computeCompensation(t.db, { taxYear: 2027, methodologyId })).rejects.toThrow(
      /deal sourcing/,
    );
    await addRateSource(t.db, {
      taskTypeName: "deal sourcing",
      hourlyRate: 12000n,
      sourceKind: "survey",
      citation: "survey F",
      capturedOn: "2026-12-01",
    });
  });

  it("freeze is one-way and the DB makes frozen methodologies immutable", async () => {
    await freezeMethodology(t.db, methodologyId);
    const r = await computeCompensation(t.db, { taxYear: 2027, methodologyId });
    expect(r.methodologyFrozen).toBe(true);
    expect(r.warnings).toHaveLength(0);
    await expect(freezeMethodology(t.db, methodologyId)).rejects.toThrow(/already frozen/);
    await expectDbReject(
      t.pool,
      `UPDATE comp_methodologies SET description = 'edited' WHERE id = ${methodologyId}`,
      /frozen/,
    );
    await expectDbReject(
      t.pool,
      `DELETE FROM comp_methodologies WHERE id = ${methodologyId}`,
      /frozen/,
    );
  });

  it("renders the comp-memo pack with rates, citations, and corroboration", async () => {
    const r = await computeCompensation(t.db, { taxYear: 2027, methodologyId });
    const md = await renderCompMemoPack(t.db, r.computationId);
    expect(md).toContain("Reasonable-compensation memo");
    expect(md).toContain("credit underwriting");
    expect(md).toContain("survey B");
    expect(md).toContain("deals_reviewed");
    expect(md).toContain("frozen");
  });
});

describe("ics corroboration import", () => {
  it("parses same-day VEVENTs into hour suggestions", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "DTSTART;TZID=America/New_York:20270302T090000",
      "DTEND;TZID=America/New_York:20270302T113000",
      "SUMMARY:Deal review — Factoring",
      "  LLC pipeline", // folded: first space is the fold marker, second is content

      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART:20270303T100000",
      "DTEND:20270304T110000",
      "SUMMARY:multi-day (skipped)",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const events = parseIcs(ics);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      date: "2027-03-02",
      hours: "2.50",
      summary: "Deal review — Factoring LLC pipeline",
    });
  });
});
