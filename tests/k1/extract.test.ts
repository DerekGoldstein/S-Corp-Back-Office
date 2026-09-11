/** Extraction service with a stubbed model caller — no network in tests. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appConfig, k1Fields, k1s } from "../../src/db/schema";
import { confirmK1, createK1 } from "../../src/k1/k1";
import { extractK1, K1Extraction, type ExtractCaller } from "../../src/k1/extract";
import { createInvestee } from "../../src/ledger/investees";
import { storeDocument } from "../../src/vault/store";
import { makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let k1Id: bigint;

const stubCaller: ExtractCaller = async ({ model, pdfBase64, prompt }) => {
  expect(model).toBe("claude-opus-5"); // config default per current docs
  expect(pdfBase64.length).toBeGreaterThan(0);
  expect(prompt).toContain("INTEGER CENTS");
  return K1Extraction.parse({
    tax_year: 2026,
    partnership_name: "Factoring LLC",
    partnership_ein: "12-3456789",
    fields: [
      { box_code: "1", label: "Ordinary business income", value_cents: 250000, value_text: null, confidence: "high" },
      { box_code: "5", label: "Interest income", value_cents: 6000, value_text: null, confidence: "high" },
      { box_code: "13J", label: "Section 59(e)(2)", value_cents: 1200, value_text: null, confidence: "low" },
      { box_code: "19A", label: "Distributions", value_cents: 150000, value_text: null, confidence: "low" },
      { box_code: "L.ending", label: "Ending capital", value_cents: 200000, value_text: null, confidence: "high" },
      { box_code: "J.profit_ending", label: "Profit share", value_cents: null, value_text: "50%", confidence: "high" },
    ],
    notes: "statement attached for box 13",
  });
};

beforeAll(async () => {
  process.env.VAULT_DIR = mkdtempSync(join(tmpdir(), "vault-"));
  t = await makeTestDb();
  const inv = await createInvestee(t.db, {
    name: "Factoring LLC",
    entityType: "partnership",
    ownershipPct: "50",
    acquiredOn: "2026-01-15",
  });
  const { document } = await storeDocument(t.db, {
    filename: "k1-2026.pdf",
    mime: "application/pdf",
    bytes: Buffer.from("%PDF-1.4 fake k1 bytes"),
  });
  k1Id = await createK1(t.db, {
    investeeId: inv.investee.id,
    taxYear: 2026,
    documentId: document.id,
  });
});

afterAll(async () => {
  await t.drop();
});

describe("extractK1", () => {
  it("writes every field with per-field confidence, untouched by the owner", async () => {
    const summary = await extractK1(t.db, k1Id, { caller: stubCaller });
    expect(summary).toMatchObject({
      fieldCount: 6,
      lowConfidenceCount: 2,
      model: "claude-opus-5",
    });
    const fields = await t.db.select().from(k1Fields).where(eq(k1Fields.k1Id, k1Id));
    expect(fields).toHaveLength(6);
    const box1 = fields.find((f) => f.boxCode === "1")!;
    expect(box1).toMatchObject({ valueCents: 250000n, confidence: "high", ownerTouched: false });
    const box13j = fields.find((f) => f.boxCode === "13J")!;
    expect(box13j.confidence).toBe("low");
    const j = fields.find((f) => f.boxCode === "J.profit_ending")!;
    expect(j).toMatchObject({ valueCents: null, valueText: "50%" });
    const [k1] = await t.db.select().from(k1s).where(eq(k1s.id, k1Id));
    expect(k1!.extractionModel).toBe("claude-opus-5");
    expect(k1!.extractedAt).not.toBeNull();
  });

  it("low-confidence extracted fields block confirmation until touched (guardrail 5)", async () => {
    await expect(confirmK1(t.db, k1Id)).rejects.toThrow(/low-confidence/);
    await expect(confirmK1(t.db, k1Id)).rejects.toThrow(/box 13J/);
  });

  it("honors the configured model id (config, not code — guardrail 11)", async () => {
    await t.db
      .insert(appConfig)
      .values({ key: "anthropic_model_id", value: "claude-test-model" })
      .onConflictDoUpdate({
        target: appConfig.key,
        set: { value: "claude-test-model" },
      });
    let seen = "";
    await extractK1(t.db, k1Id, {
      caller: async (args) => {
        seen = args.model;
        return stubCaller({ ...args, model: "claude-opus-5" });
      },
    });
    expect(seen).toBe("claude-test-model");
  });

  it("rejects a PDF whose printed year disagrees with the record", async () => {
    await expect(
      extractK1(t.db, k1Id, {
        caller: async (a) => ({ ...(await stubCaller({ ...a, model: "claude-opus-5" })), tax_year: 2025 }),
      }),
    ).rejects.toThrow(/wrong file/);
  });
});
