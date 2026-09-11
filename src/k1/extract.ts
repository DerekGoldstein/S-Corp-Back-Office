/**
 * K-1 PDF extraction via the Anthropic API (§4.5): the uploaded Schedule K-1
 * (Form 1065) PDF goes to Claude as a document input with a STRICT schema
 * covering Parts I–III (coded sub-items included) and the Part II capital
 * account; every field returns a confidence flag, and low-confidence fields
 * block confirmation until the owner touches them (guardrail 5).
 *
 * Model ID lives in app_config ('anthropic_model_id'), never in code
 * (guardrail 11). The API caller is injectable so tests run offline.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Dbx } from "../db/client";
import { appConfig, k1s } from "../db/schema";
import { readDocument } from "../vault/store";
import { K1Error, setK1Fields } from "./k1";

/** Default per current docs (claude-api skill, checked at build time). */
const DEFAULT_MODEL = "claude-opus-5";

export const K1ExtractedField = z.object({
  box_code: z
    .string()
    .describe(
      "Box identifier: '1'..'23' for Part III (append the letter code for coded boxes, e.g. '11A', '13J', '18C', '19A', '20A'); 'J.profit_beginning'/'J.profit_ending' style for Part II item J percentages; 'L.beginning', 'L.contributions', 'L.income', 'L.withdrawals', 'L.ending' for the item L capital account; 'N.beginning'/'N.ending' for item N.",
    ),
  label: z.string().describe("The printed caption for this box"),
  value_cents: z
    .number()
    .int()
    .nullable()
    .describe(
      "Money amounts as INTEGER CENTS (dollars × 100; parentheses mean negative). null for non-money fields.",
    ),
  value_text: z
    .string()
    .nullable()
    .describe("Non-money values (percentages, checkboxes, text); null for money fields"),
  confidence: z
    .enum(["high", "low"])
    .describe(
      "low when the value is blurry, ambiguous, handwritten, partially cut off, or you are not certain — the owner must review every low field",
    ),
});

export const K1Extraction = z.object({
  tax_year: z.number().int().describe("The tax year printed on the K-1"),
  partnership_name: z.string(),
  partnership_ein: z.string().nullable(),
  fields: z.array(K1ExtractedField).describe("Every populated box in Parts I–III and item L/J/N"),
  notes: z
    .string()
    .describe("Anything unusual: attached statements, codes you could not map, missing pages"),
});

export type K1ExtractionT = z.infer<typeof K1Extraction>;

const EXTRACTION_PROMPT = `Extract every populated field from this Schedule K-1 (Form 1065).

Rules:
- Cover Parts I, II, and III. Include the coded sub-items of boxes 11, 13, 15, 17, 18, and 20 by appending the letter code (e.g. 13J). Include Part II items J (profit/loss/capital percentages), L (the capital-account analysis: beginning, contributions, current-year income, withdrawals/distributions, ending — tax-basis method), and N.
- Money amounts: INTEGER CENTS (dollars × 100). Parentheses mean negative. Never round to whole dollars.
- Percentages and checkboxes go in value_text, not value_cents.
- Skip boxes that are blank or zero.
- Mark confidence "low" whenever you are not completely certain of a value — a human reviews every low-confidence field against the PDF before anything posts.
- If a statement is attached for a box, extract the box total and mention the statement in notes.`;

export type ExtractCaller = (args: {
  model: string;
  pdfBase64: string;
  prompt: string;
}) => Promise<K1ExtractionT>;

/** Real API caller (requires ANTHROPIC_API_KEY or an `ant auth` profile). */
export const anthropicCaller: ExtractCaller = async ({ model, pdfBase64, prompt }) => {
  const client = new Anthropic();
  const response = await client.messages.parse({
    model,
    max_tokens: 16000,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(K1Extraction) },
  });
  if (response.stop_reason === "refusal") {
    throw new K1Error("extraction refused by the model — review the PDF manually");
  }
  if (!response.parsed_output) {
    throw new K1Error("extraction returned no parseable output — enter fields manually");
  }
  return response.parsed_output;
};

export async function configuredModel(db: Dbx): Promise<string> {
  const rows = await db.select().from(appConfig).where(eq(appConfig.key, "anthropic_model_id"));
  const v = rows[0]?.value;
  return v !== undefined && v !== "" ? v : DEFAULT_MODEL;
}

export type ExtractSummary = {
  fieldCount: number;
  lowConfidenceCount: number;
  model: string;
  notes: string;
};

/**
 * Extract the K-1's PDF into k1_fields (confidence per field, owner_touched
 * false). The review screen then shows PDF and fields side by side; nothing
 * posts before the owner confirms.
 */
export async function extractK1(
  db: Dbx,
  k1Id: bigint,
  opts: { caller?: ExtractCaller } = {},
): Promise<ExtractSummary> {
  const [k1] = await db.select().from(k1s).where(eq(k1s.id, k1Id));
  if (!k1) throw new K1Error(`K-1 ${k1Id} not found`);
  if (k1.status !== "in_review") {
    throw new K1Error(`K-1 ${k1Id} is ${k1.status}; extraction only runs during review`);
  }
  const { document, bytes } = await readDocument(db, k1.documentId);
  if (document.mime !== "application/pdf") {
    throw new K1Error(`document ${document.id} is ${document.mime}, not a PDF`);
  }
  const model = await configuredModel(db);
  const caller = opts.caller ?? anthropicCaller;
  const extraction = await caller({
    model,
    pdfBase64: bytes.toString("base64"),
    prompt: EXTRACTION_PROMPT,
  });
  if (extraction.tax_year !== k1.taxYear) {
    throw new K1Error(
      `the PDF reads tax year ${extraction.tax_year} but this K-1 record is for ${k1.taxYear} — wrong file?`,
    );
  }
  await setK1Fields(
    db,
    k1Id,
    extraction.fields.map((f) => ({
      boxCode: f.box_code,
      valueCents: f.value_cents !== null ? BigInt(f.value_cents) : undefined,
      valueText: f.value_text ?? undefined,
      confidence: f.confidence,
    })),
    "extraction",
  );
  await db
    .update(k1s)
    .set({ extractionModel: model, extractedAt: new Date() })
    .where(eq(k1s.id, k1Id));
  return {
    fieldCount: extraction.fields.length,
    lowConfidenceCount: extraction.fields.filter((f) => f.confidence === "low").length,
    model,
    notes: extraction.notes,
  };
}
