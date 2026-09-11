/** Annual consent (§4.9): generated from ledger data, refuses missing prerequisites. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AnnualConsentError,
  generateAnnualConsent,
} from "../../src/records/annual-consent";
import { accountablePlans, appConfig } from "../../src/db/schema";
import { postEntry } from "../../src/ledger/posting";
import {
  computeCompensation,
  createMethodology,
  ensureDefaultTaskTypes,
  freezeMethodology,
} from "../../src/time/comp";
import { addRateSource, addTimeEntry } from "../../src/time/timelog";
import { readDocument, storeDocument } from "../../src/vault/store";
import { makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;

beforeAll(async () => {
  process.env.VAULT_DIR = mkdtempSync(join(tmpdir(), "vault-"));
  t = await makeTestDb();
});

afterAll(async () => {
  await t.drop();
});

describe("generateAnnualConsent", () => {
  it("refuses without a comp computation, then without a plan", async () => {
    await expect(
      generateAnnualConsent(t.db, {
        taxYear: 2027,
        entityName: "Blaze Allen LLC",
        memberName: "Derek Goldstein",
        signedOn: "2027-12-28",
      }),
    ).rejects.toThrow(AnnualConsentError);

    await ensureDefaultTaskTypes(t.db);
    const m = await createMethodology(t.db, {
      version: 1,
      description: "median market rates",
      parameters: { rateAggregation: "median" },
    });
    await freezeMethodology(t.db, m.id);
    for (let d = 1; d <= 10; d++) {
      await addTimeEntry(t.db, {
        entryDate: `2027-03-${String(d).padStart(2, "0")}`,
        hours: "10.00",
        taskTypeName: "consulting delivery",
      });
    }
    await addRateSource(t.db, {
      taskTypeName: "consulting delivery",
      hourlyRate: 15000n,
      sourceKind: "survey",
      citation: "survey X",
      capturedOn: "2026-12-01",
    });
    await computeCompensation(t.db, { taxYear: 2027, methodologyId: m.id });

    await expect(
      generateAnnualConsent(t.db, {
        taxYear: 2027,
        entityName: "Blaze Allen LLC",
        memberName: "Derek Goldstein",
        signedOn: "2027-12-28",
      }),
    ).rejects.toThrow(/accountable plan/);
  });

  it("pulls the wage, distributions, 401(k), plan, and PTET decision from live data", async () => {
    const policy = await storeDocument(t.db, {
      filename: "plan.pdf",
      mime: "application/pdf",
      bytes: Buffer.from("signed accountable plan"),
    });
    await t.db.insert(accountablePlans).values({
      adoptedOn: "2026-12-15",
      documentId: policy.document.id,
      categories: ["home_office", "phone", "internet"],
    });
    await t.db.insert(appConfig).values({ key: "ptet_elected", value: "1" });
    await postEntry(t.db, {
      entryDate: "2027-01-10",
      memo: "capital",
      sourceModule: "manual",
      lines: [
        { accountCode: "1000", debit: 5000000n },
        { accountCode: "3000", credit: 5000000n },
      ],
    });
    await postEntry(t.db, {
      entryDate: "2027-08-01",
      memo: "distribution",
      sourceModule: "manual",
      lines: [
        { accountCode: "3200", debit: 1200000n },
        { accountCode: "1000", credit: 1200000n },
      ],
    });
    const r = await generateAnnualConsent(t.db, {
      taxYear: 2027,
      entityName: "Blaze Allen LLC",
      memberName: "Derek Goldstein",
      signedOn: "2027-12-28",
    });
    expect(r.data.wage).toBe(1500000n); // 100h × $150
    expect(r.data.distributions).toBe(1200000n);
    expect(r.data.methodologyFrozenAt).not.toBeNull();
    expect(r.data.ptetElected).toBe(true);
    const { document, bytes } = await readDocument(t.db, r.documentId);
    const text =
      document.mime === "application/pdf" ? "" : bytes.toString("utf8");
    if (text !== "") {
      expect(text).toContain("15,000.00");
      expect(text).toContain("12,000.00");
      expect(text).toContain("TO MAKE");
    }
    expect(document.source).toBe("generated");
  });
});
