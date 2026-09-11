/**
 * Pay stubs re-prove the run's arithmetic before rendering: a stub for a
 * tampered or unposted run refuses to exist; a good one carries the W-2
 * Box 1/14 health-premium memo and lands in the vault linked to its run.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPayStub, generatePayStub, renderPayStubHtml, PayStubError } from "../../src/payroll/paystub";
import { documentLinks, documents, payrollRuns } from "../../src/db/schema";
import { postEntry } from "../../src/ledger/posting";
import { makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let runId: bigint;

// Internally consistent synthetic run: gross 162,000.00; deferral 20,000.00;
// SS 10,044.00; Medicare 2,349.00; FIT 30,000.00; NYS 10,000.00; NYC 6,000.00
// → net = 162,000 − 78,393 = 83,607.00
const RUN = {
  taxYear: 2027,
  payDate: "2027-12-15",
  status: "posted",
  grossWages: 16_200_000n,
  grossSource: "comp computation v1",
  healthPremium: 1_200_000n,
  fitWages: 15_400_000n,
  nysWages: 14_200_000n,
  nycWages: 14_200_000n,
  ficaWages: 14_200_000n,
  futaWages: 700_000n,
  suiWages: 1_230_000n,
  eeDeferral401k: 2_000_000n,
  eeSocialSecurity: 1_004_400n,
  eeMedicare: 234_900n,
  eeAddlMedicare: 0n,
  fitWithheld: 3_000_000n,
  nysWithheld: 1_000_000n,
  nycWithheld: 600_000n,
  erSocialSecurity: 1_004_400n,
  erMedicare: 234_900n,
  erFuta: 42_000n,
  erSui: 50_000n,
  er401k: 4_000_000n,
  netPay: 8_360_700n,
  tableVersionIds: { fica: 3, fit_percentage_method: 4 },
  trace: {},
} as const;

beforeAll(async () => {
  process.env.VAULT_DIR = mkdtempSync(join(tmpdir(), "vault-"));
  process.env.CHROMIUM_PATH = "none"; // hermetic: HTML fallback
  t = await makeTestDb();
  // A posted run must reference its ledger entry (DB CHECK) — post a stand-in.
  const { entryId } = await postEntry(t.db, {
    entryDate: "2027-12-15",
    memo: "stand-in payroll entry for the stub fixture",
    sourceModule: "manual",
    lines: [
      { accountCode: "5000", debit: 16_200_000n },
      { accountCode: "1000", credit: 16_200_000n },
    ],
  });
  const [row] = await t.db
    .insert(payrollRuns)
    .values({ ...RUN, journalEntryId: entryId, tableVersionIds: { ...RUN.tableVersionIds }, trace: {} })
    .returning({ id: payrollRuns.id });
  runId = row!.id;
});

afterAll(async () => {
  await t.drop();
  delete process.env.CHROMIUM_PATH;
});

describe("buildPayStub", () => {
  it("builds a stub whose sections tie to the run", async () => {
    const s = await buildPayStub(t.db, runId);
    expect(s.netPay).toBe(8_360_700n);
    expect(s.taxes.reduce((a, x) => a + x.amount, 0n) + s.preTax[0]!.amount).toBe(
      16_200_000n - 8_360_700n,
    );
    const html = renderPayStubHtml(s);
    expect(html).toContain("83,607.00");
    expect(html).toContain("Box 1 and Box 14"); // guardrail 7 stated on the stub
    expect(html).toContain("fica#3");
  });

  it("refuses a run that does not tie (tampered net)", async () => {
    await t.pool.query("ALTER TABLE payroll_runs DISABLE TRIGGER USER");
    await t.pool.query("UPDATE payroll_runs SET net_pay = net_pay + 1 WHERE id = $1", [runId]);
    await t.pool.query("ALTER TABLE payroll_runs ENABLE TRIGGER USER");
    await expect(buildPayStub(t.db, runId)).rejects.toThrow(/does not tie/);
    await t.pool.query("ALTER TABLE payroll_runs DISABLE TRIGGER USER");
    await t.pool.query("UPDATE payroll_runs SET net_pay = net_pay - 1 WHERE id = $1", [runId]);
    await t.pool.query("ALTER TABLE payroll_runs ENABLE TRIGGER USER");
  });

  it("refuses non-posted runs", async () => {
    const [draft] = await t.db
      .insert(payrollRuns)
      .values({ ...RUN, status: "draft", tableVersionIds: {}, trace: {} })
      .returning({ id: payrollRuns.id });
    await expect(buildPayStub(t.db, draft!.id)).rejects.toThrow(PayStubError);
  });
});

describe("generatePayStub", () => {
  it("vaults the stub (HTML fallback here) linked to its run", async () => {
    const { documentId, mime } = await generatePayStub(t.db, runId);
    expect(mime).toBe("text/html");
    const [doc] = await t.db.select().from(documents).where(eq(documents.id, documentId));
    expect(doc!.year).toBe(2027);
    expect(doc!.source).toBe("generated");
    const links = await t.db
      .select()
      .from(documentLinks)
      .where(eq(documentLinks.documentId, documentId));
    expect(links.some((l) => l.linkedType === "payroll_run" && l.linkedId === runId.toString())).toBe(
      true,
    );
  });
});
