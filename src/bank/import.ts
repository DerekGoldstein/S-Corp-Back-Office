/**
 * File import into the immutable bank_transactions table (§4.2). Idempotent:
 * hash dedupe makes re-importing an overlapping export a no-op. The uploaded
 * file itself is vaulted and linked to the batch for statement→posting
 * lineage in the CPA package.
 */
import { eq } from "drizzle-orm";
import type { Dbx } from "../db/client";
import { appConfig, bankAccounts, bankTransactions, importBatches } from "../db/schema";
import { parseBankCsv } from "./import-csv";
import { parseOfx } from "./import-ofx";
import { computeImportHashes, normalizeDescription, type ParsedTxn } from "./normalize";
import { storeDocument, linkDocument } from "../vault/store";

export class ImportError extends Error {}

export type ImportSummary = {
  batchId: bigint;
  rowCount: number;
  newCount: number;
  duplicateCount: number;
  warnings: string[];
  documentId: bigint | null;
};

async function ownerPayeeRegex(db: Dbx): Promise<RegExp | null> {
  const rows = await db.select().from(appConfig).where(eq(appConfig.key, "owner_payee_regex"));
  const v = rows[0]?.value;
  if (v === undefined || v === "") return null;
  try {
    return new RegExp(v, "i");
  } catch {
    throw new ImportError(`app_config.owner_payee_regex is not a valid regex: ${v}`);
  }
}

export async function importParsedTransactions(
  db: Dbx,
  args: {
    bankAccountId: number;
    source: "csv" | "ofx";
    txns: ParsedTxn[];
    warnings?: string[];
    filename?: string;
    fileBytes?: Buffer | Uint8Array;
  },
): Promise<ImportSummary> {
  const [account] = await db
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.id, args.bankAccountId));
  if (!account) throw new ImportError(`bank account ${args.bankAccountId} not found`);
  const hashes = computeImportHashes(args.bankAccountId, args.txns);
  const ownerRe = await ownerPayeeRegex(db);
  const warnings = [...(args.warnings ?? [])];

  return await db.transaction(async (tx) => {
    let documentId: bigint | null = null;
    if (args.fileBytes !== undefined && args.fileBytes.length > 0) {
      const { document } = await storeDocument(tx, {
        filename: args.filename ?? `import.${args.source}`,
        mime: args.source === "csv" ? "text/csv" : "application/x-ofx",
        bytes: args.fileBytes,
        source: "upload",
      });
      documentId = document.id;
    }
    const [batch] = await tx
      .insert(importBatches)
      .values({
        bankAccountId: args.bankAccountId,
        source: args.source,
        documentId,
        filename: args.filename ?? null,
        rowCount: args.txns.length,
      })
      .returning({ id: importBatches.id });
    const batchId = batch!.id;
    if (documentId !== null) {
      await linkDocument(tx, documentId, "import_batch", batchId);
    }

    let newCount = 0;
    for (const [i, t] of args.txns.entries()) {
      const inserted = await tx
        .insert(bankTransactions)
        .values({
          bankAccountId: args.bankAccountId,
          source: args.source,
          importHash: hashes[i]!,
          importBatchId: batchId,
          txnDate: t.date,
          amount: t.amount,
          descriptionRaw: t.descriptionRaw,
          descriptionNorm: normalizeDescription(t.descriptionRaw),
          isOwnerPayee: ownerRe !== null && ownerRe.test(t.descriptionRaw),
        })
        // dedupe indexes are partial (WHERE import_hash IS NOT NULL), which
        // ON CONFLICT (cols) cannot infer — the bare form catches them
        .onConflictDoNothing()
        .returning({ id: bankTransactions.id });
      if (inserted.length > 0) newCount++;
    }
    const duplicateCount = args.txns.length - newCount;
    await tx
      .update(importBatches)
      .set({
        newCount,
        duplicateCount,
        warningCount: warnings.length,
        warnings: warnings.length > 0 ? warnings : null,
      })
      .where(eq(importBatches.id, batchId));
    return {
      batchId,
      rowCount: args.txns.length,
      newCount,
      duplicateCount,
      warnings,
      documentId,
    };
  });
}

/** One-call CSV import using the account's stored profile. */
export async function importCsvFile(
  db: Dbx,
  bankAccountId: number,
  fileBytes: Buffer | Uint8Array,
  filename?: string,
): Promise<ImportSummary> {
  const [account] = await db
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.id, bankAccountId));
  if (!account) throw new ImportError(`bank account ${bankAccountId} not found`);
  const profile = account.importProfile;
  if (!profile) {
    throw new ImportError(
      `bank account ${account.name} has no CSV import profile configured (Settings → bank accounts)`,
    );
  }
  const { txns, warnings } = parseBankCsv(Buffer.from(fileBytes).toString("utf8"), profile);
  return importParsedTransactions(db, {
    bankAccountId,
    source: "csv",
    txns,
    warnings,
    filename,
    fileBytes,
  });
}

/** One-call OFX/QFX import. */
export async function importOfxFile(
  db: Dbx,
  bankAccountId: number,
  fileBytes: Buffer | Uint8Array,
  filename?: string,
): Promise<ImportSummary> {
  const { txns, warnings } = parseOfx(Buffer.from(fileBytes).toString("utf8"));
  return importParsedTransactions(db, {
    bankAccountId,
    source: "ofx",
    txns,
    warnings,
    filename,
    fileBytes,
  });
}
