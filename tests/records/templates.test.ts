import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { corporateRecords } from "../../src/db/schema";
import { createMethodology, freezeMethodology } from "../../src/time/comp";
import { chromiumPath } from "../../src/records/pdf";
import {
  generatePreYearConsent,
  generateRecord,
  renderAccountablePlanPolicy,
  standingDocumentGaps,
} from "../../src/records/templates";
import { readDocument, storeDocument } from "../../src/vault/store";
import { makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let methodologyId: number;

beforeAll(async () => {
  process.env.VAULT_DIR = mkdtempSync(join(tmpdir(), "vault-"));
  t = await makeTestDb();
  const m = await createMethodology(t.db, {
    version: 1,
    description: "hours × market median",
    parameters: { rateAggregation: "median" },
  });
  methodologyId = m.id;
  await freezeMethodology(t.db, methodologyId);
});

afterAll(async () => {
  await t.drop();
});

describe("templates", () => {
  it("renders the accountable-plan policy with the §1.62-2 elements", () => {
    const html = renderAccountablePlanPolicy({
      entityName: "Blaze Allen LLC",
      memberName: "Derek Goldstein",
      adoptedOn: "2026-12-15",
      effectiveFrom: "2027-01-01",
      substantiationWindowDays: 60,
      reimbursementWindowDays: 120,
      categories: ["home office", "phone", "internet", "supplies", "health insurance premiums"],
    });
    expect(html).toContain("Accountable Plan");
    expect(html).toContain("1.62-2");
    expect(html).toContain("60 days");
    expect(html).toContain("Return of excess");
    expect(html).toContain("home office");
    expect(html).toContain("not an\nofficial government form");
  });

  it("generates the pre-year consent from the live methodology and vaults it", async () => {
    const r = await generatePreYearConsent(t.db, {
      entityName: "Blaze Allen LLC",
      memberName: "Derek Goldstein",
      consentYear: 2027,
      signedOn: "2026-12-20",
      methodologyId,
      deferral401kElection: "the annual employee elective deferral limit",
      accountablePlanAdoptedOn: "2026-12-15",
      deMinimisElection: true,
    });
    expect(r.recordId).toBeGreaterThan(0);
    const [record] = await t.db
      .select()
      .from(corporateRecords)
      .where(eq(corporateRecords.id, r.recordId));
    expect(record).toMatchObject({ kind: "preyear_consent", taxYear: 2027, status: "generated" });
    const { document, bytes } = await readDocument(t.db, r.documentId);
    if (chromiumPath() !== null) {
      expect(r.mime).toBe("application/pdf");
      expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    } else {
      expect(r.mime).toBe("text/html");
    }
    expect(document.source).toBe("generated");
  });

  it("flags missing standing documents until they are vaulted", async () => {
    const before = await standingDocumentGaps(t.db);
    expect(before.map((g) => g.standingKind)).toContain("cp261");
    const { document } = await storeDocument(t.db, {
      filename: "cp261.pdf",
      mime: "application/pdf",
      bytes: Buffer.from("cp261 acceptance letter"),
    });
    await t.db.insert(corporateRecords).values({
      kind: "standing",
      standingKind: "cp261",
      title: "IRS S-election acceptance (CP261)",
      documentId: document.id,
    });
    const after = await standingDocumentGaps(t.db);
    expect(after.map((g) => g.standingKind)).not.toContain("cp261");
    expect(after.length).toBe(before.length - 1);
  });

  it("refuses a 'standing' record without its standing kind (DB check)", async () => {
    await expect(
      t.pool.query(
        `INSERT INTO corporate_records (kind, title) VALUES ('standing', 'mystery doc')`,
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

describe("de minimis election record", () => {
  it("generates via the generic path", async () => {
    const r = await generateRecord(t.db, {
      kind: "de_minimis_election",
      taxYear: 2027,
      title: "De minimis safe-harbor election statement data 2027",
      html: "<!doctype html><html><body><h1>De minimis election 2027</h1></body></html>",
      data: { taxYear: 2027 },
    });
    expect(r.recordId).toBeGreaterThan(0);
  });
});
