import { createHash } from "node:crypto";
import type { Cents } from "../lib/cents";

/**
 * Description normalization v1 — FROZEN. import_hash is derived from this,
 * so changing it would re-import history as "new" transactions. Any future
 * improvement must ship as v2 alongside v1, never replace it.
 */
export function normalizeDescription(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, " ").trim();
}

/** One parsed transaction from any file source. */
export type ParsedTxn = {
  date: string; // YYYY-MM-DD
  amount: Cents; // signed; + = inflow
  descriptionRaw: string;
  fitid?: string; // OFX financial institution txn id, unique per account
};

/**
 * Dedupe hashes (§4.2):
 * - OFX rows carry a bank-issued FITID → hash(account | fitid).
 * - CSV rows hash the (date, amount, normalized description) tuple, with an
 *   occurrence index so two identical same-day charges both survive while
 *   re-importing an overlapping export stays a no-op (banks list identical
 *   rows in a stable order, so occurrence numbers reproduce across exports).
 */
export function computeImportHashes(bankAccountId: number, txns: ParsedTxn[]): string[] {
  const seen = new Map<string, number>();
  return txns.map((t) => {
    if (t.fitid !== undefined && t.fitid !== "") {
      return sha(`ofx|${bankAccountId}|${t.fitid}`);
    }
    const key = `${t.date}|${t.amount}|${normalizeDescription(t.descriptionRaw)}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return sha(`csv1|${bankAccountId}|${key}|${n}`);
  });
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
