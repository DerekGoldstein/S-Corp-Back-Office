/**
 * THE single posting path (CLAUDE.md): every module that writes to the
 * journal goes through postEntry / postReversal. Feature code never INSERTs
 * into journal_entries/journal_lines directly — the guard pipeline here is
 * how guardrails 2/3/6 and the document requirement are enforced at the app
 * layer, with the database re-enforcing the structural invariants beneath.
 */
import { inArray, sql } from "drizzle-orm";
import type { Dbx } from "../db/client";
import {
  accounts as accountsTable,
  documentLinks,
  journalEntries,
  journalLines,
  type Account,
} from "../db/schema";
import { type Cents, ZERO } from "../lib/cents";

export type SourceModule =
  | "manual"
  | "bank"
  | "payroll"
  | "k1"
  | "reimbursement"
  | "fixed_asset"
  | "tax_accrual"
  | "close"
  | "reversal";

export type DraftLine = {
  accountCode: string;
  debit?: Cents;
  credit?: Cents;
  memo?: string;
  investeeId?: number;
  payrollRunId?: bigint;
  k1Id?: bigint;
  bankTransactionId?: bigint;
  taxYear?: number;
};

export type DraftEntry = {
  entryDate: string; // YYYY-MM-DD
  memo: string;
  sourceModule: Exclude<SourceModule, "reversal">; // reversals via postReversal only
  sourceId?: bigint;
  lines: DraftLine[];
  /** Vault documents satisfying requires_document accounts; linked to the entry. */
  documentIds?: bigint[];
};

export class PostingError extends Error {
  constructor(
    message: string,
    readonly code:
      | "structure"
      | "unknown_account"
      | "inactive_account"
      | "restricted_target"
      | "document_required"
      | "dimension"
      | "period_locked"
      | "db",
  ) {
    super(message);
    this.name = "PostingError";
  }
}

/**
 * Account families only specific modules may post to. The bank classifier
 * can never reach pass-through income (investee wires are never revenue),
 * equity roll accounts move only at close (plus manual opening balances),
 * and officer compensation comes only from payroll runs.
 */
const TARGET_RULES: ReadonlyArray<{
  match: (code: string) => boolean;
  allowed: readonly SourceModule[];
  why: string;
}> = [
  {
    match: (c) => /^4[56]\d\d$/.test(c),
    allowed: ["k1", "close", "manual"],
    why: "pass-through income/deduction accounts accept postings only from confirmed K-1s (investee wires credit the 15xx investment asset, never revenue)",
  },
  {
    match: (c) => c === "3100" || c === "3110" || c === "3900",
    allowed: ["close", "manual"],
    why: "AAA/OAA/net-income roll accounts move only at year-end close (or a manual opening balance)",
  },
  {
    match: (c) => c === "3200",
    allowed: ["bank", "close", "manual"],
    why: "shareholder distributions post from owner-tagged bank transactions",
  },
  {
    match: (c) => c === "5000" || c === "5010" || c === "5020",
    allowed: ["payroll", "manual"],
    why: "compensation and employer payroll costs post from payroll runs",
  },
];

function lineAmount(l: DraftLine): Cents {
  return (l.debit ?? ZERO) + (l.credit ?? ZERO);
}

/** Drizzle wraps DB errors; collect the whole cause chain for classification. */
function fullMessage(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  while (e instanceof Error) {
    parts.push(e.message);
    e = e.cause;
  }
  return parts.join(" | ") || String(err);
}

export function validateDraftStructure(draft: DraftEntry): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.entryDate)) {
    throw new PostingError(`entry_date must be YYYY-MM-DD, got ${draft.entryDate}`, "structure");
  }
  if (draft.memo.trim() === "") throw new PostingError("memo is required", "structure");
  if (draft.lines.length < 2) {
    throw new PostingError("an entry needs at least two lines", "structure");
  }
  let debits = ZERO;
  let credits = ZERO;
  for (const [i, l] of draft.lines.entries()) {
    const d = l.debit ?? ZERO;
    const c = l.credit ?? ZERO;
    if (d < ZERO || c < ZERO) {
      throw new PostingError(`line ${i + 1}: negative amounts are not allowed`, "structure");
    }
    if ((d > ZERO) === (c > ZERO)) {
      throw new PostingError(
        `line ${i + 1}: exactly one of debit/credit must be positive`,
        "structure",
      );
    }
    debits += d;
    credits += c;
  }
  if (debits !== credits) {
    throw new PostingError(
      `entry is unbalanced: debits ${debits} != credits ${credits} (cents)`,
      "structure",
    );
  }
}

async function loadAccounts(db: Dbx, codes: string[]): Promise<Map<string, Account>> {
  const rows = await db
    .select()
    .from(accountsTable)
    .where(inArray(accountsTable.code, codes));
  return new Map(rows.map((r) => [r.code, r]));
}

export function runTargetGuards(draft: DraftEntry, accts: Map<string, Account>): void {
  for (const l of draft.lines) {
    const a = accts.get(l.accountCode);
    if (!a) throw new PostingError(`unknown account code ${l.accountCode}`, "unknown_account");
    if (!a.active) {
      throw new PostingError(`account ${a.code} ${a.name} is inactive`, "inactive_account");
    }
    for (const rule of TARGET_RULES) {
      if (rule.match(a.code) && !rule.allowed.includes(draft.sourceModule)) {
        throw new PostingError(
          `account ${a.code} (${a.name}) cannot be posted from source '${draft.sourceModule}': ${rule.why}`,
          "restricted_target",
        );
      }
    }
    if (a.investeeId !== null && l.investeeId !== a.investeeId) {
      throw new PostingError(
        `account ${a.code} belongs to investee ${a.investeeId}; the line must carry that investee dimension`,
        "dimension",
      );
    }
    if (a.requiresDocument) {
      const threshold = a.documentThreshold;
      const applies = threshold === null || lineAmount(l) >= threshold;
      if (applies && (draft.documentIds === undefined || draft.documentIds.length === 0)) {
        throw new PostingError(
          `account ${a.code} (${a.name}) requires an attached document` +
            (threshold !== null ? ` at or above ${threshold} cents` : "") +
            "; attach the receipt/notice before posting",
          "document_required",
        );
      }
    }
  }
}

export async function postEntry(db: Dbx, draft: DraftEntry): Promise<{ entryId: bigint }> {
  validateDraftStructure(draft);
  const codes = [...new Set(draft.lines.map((l) => l.accountCode))];
  const accts = await loadAccounts(db, codes);
  runTargetGuards(draft, accts);
  const defaultTaxYear = Number(draft.entryDate.slice(0, 4));

  try {
    return await db.transaction(async (tx) => {
      const [entry] = await tx
        .insert(journalEntries)
        .values({
          entryDate: draft.entryDate,
          memo: draft.memo,
          sourceModule: draft.sourceModule,
          sourceId: draft.sourceId ?? null,
          createdBy: "owner",
        })
        .returning({ id: journalEntries.id });
      const entryId = entry!.id;
      await tx.insert(journalLines).values(
        draft.lines.map((l, i) => ({
          entryId,
          lineNo: i + 1,
          accountId: accts.get(l.accountCode)!.id,
          debit: l.debit ?? ZERO,
          credit: l.credit ?? ZERO,
          memo: l.memo ?? null,
          investeeId: l.investeeId ?? null,
          payrollRunId: l.payrollRunId ?? null,
          k1Id: l.k1Id ?? null,
          bankTransactionId: l.bankTransactionId ?? null,
          taxYear: l.taxYear ?? defaultTaxYear,
        })),
      );
      if (draft.documentIds !== undefined && draft.documentIds.length > 0) {
        await tx
          .insert(documentLinks)
          .values(
            draft.documentIds.map((documentId) => ({
              documentId,
              linkedType: "journal_entry",
              linkedId: entryId.toString(),
            })),
          )
          .onConflictDoNothing();
      }
      return { entryId };
    });
  } catch (err) {
    if (err instanceof PostingError) throw err;
    const msg = fullMessage(err);
    if (msg.includes("is locked")) throw new PostingError(msg, "period_locked");
    throw new PostingError(`posting failed: ${msg}`, "db");
  }
}

/** Corrections only ever happen here — mirrored entry via the DB function. */
export async function postReversal(
  db: Dbx,
  entryId: bigint,
  entryDate: string,
  memo: string,
): Promise<{ entryId: bigint }> {
  try {
    const result = await db.execute<{ id: bigint | string }>(
      sql`SELECT post_reversal(${entryId}, ${entryDate}::date, ${memo}) AS id`,
    );
    const row = result.rows[0];
    if (!row) throw new Error("post_reversal returned nothing");
    return { entryId: BigInt(row.id) };
  } catch (err) {
    if (err instanceof PostingError) throw err;
    const msg = fullMessage(err);
    if (msg.includes("is locked")) throw new PostingError(msg, "period_locked");
    if (msg.includes("journal_entries_reversed_once")) {
      throw new PostingError(`entry ${entryId} has already been reversed`, "structure");
    }
    throw new PostingError(`reversal failed: ${msg}`, "db");
  }
}
