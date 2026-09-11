/**
 * Document vault (§4.10): originals stored immutably, content-addressed by
 * sha256 under VAULT_DIR (default var/vault). The documents table is the
 * catalog; document_links attach a document to any record. Integrity is
 * verified on every read.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import type { Dbx } from "../db/client";
import { documentLinks, documents, type DocumentRow } from "../db/schema";

export class VaultError extends Error {}

export function vaultDir(): string {
  return resolve(process.cwd(), process.env.VAULT_DIR ?? "var/vault");
}

function pathForSha(sha: string): string {
  return join(vaultDir(), sha.slice(0, 2), sha);
}

export type StoreDocumentInput = {
  filename: string;
  mime: string;
  bytes: Buffer | Uint8Array;
  source?: "upload" | "email_inbox" | "generated";
  year?: number;
};

/** Idempotent: the same bytes always resolve to the same document row. */
export async function storeDocument(
  db: Dbx,
  input: StoreDocumentInput,
): Promise<{ document: DocumentRow; existed: boolean }> {
  if (input.bytes.length === 0) throw new VaultError("refusing to store an empty document");
  const sha = createHash("sha256").update(input.bytes).digest("hex");
  const existing = await db.select().from(documents).where(eq(documents.sha256, sha));
  if (existing.length > 0) return { document: existing[0]!, existed: true };
  const path = pathForSha(sha);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, input.bytes, { flag: "wx" });
  }
  const [document] = await db
    .insert(documents)
    .values({
      filename: input.filename,
      mime: input.mime,
      sha256: sha,
      sizeBytes: BigInt(input.bytes.length),
      source: input.source ?? "upload",
      year: input.year ?? null,
    })
    .returning();
  return { document: document!, existed: false };
}

/** Read + verify: a hash mismatch means the vault was tampered with. */
export async function readDocument(
  db: Dbx,
  documentId: bigint,
): Promise<{ document: DocumentRow; bytes: Buffer }> {
  const rows = await db.select().from(documents).where(eq(documents.id, documentId));
  const document = rows[0];
  if (!document) throw new VaultError(`document ${documentId} not found`);
  const path = pathForSha(document.sha256);
  if (!existsSync(path)) throw new VaultError(`document ${documentId} missing from vault: ${path}`);
  const bytes = readFileSync(path);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== document.sha256) {
    throw new VaultError(
      `document ${documentId} failed integrity check (stored ${document.sha256.slice(0, 12)}, read ${sha.slice(0, 12)})`,
    );
  }
  return { document, bytes };
}

export async function linkDocument(
  db: Dbx,
  documentId: bigint,
  linkedType: string,
  linkedId: string | bigint | number,
): Promise<void> {
  await db
    .insert(documentLinks)
    .values({ documentId, linkedType, linkedId: String(linkedId) })
    .onConflictDoNothing();
}

export async function documentsFor(
  db: Dbx,
  linkedType: string,
  linkedId: string | bigint | number,
): Promise<DocumentRow[]> {
  const rows = await db
    .select({ d: documents })
    .from(documentLinks)
    .innerJoin(documents, eq(documents.id, documentLinks.documentId))
    .where(
      and(eq(documentLinks.linkedType, linkedType), eq(documentLinks.linkedId, String(linkedId))),
    );
  return rows.map((r) => r.d);
}
