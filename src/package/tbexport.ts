/**
 * Trial-balance export in the CPA's tax-software import format (§4.11):
 * the review becomes an import plus a scan. The product's account→tax-code
 * table is per-year verified data (`tb_export_codes`, from the CPA's answer
 * to open question #8); any nonzero account without a code is a hard error
 * headed for the open-items list — never a silently dropped balance.
 */
import type { Dbx } from "../db/client";
import { formatCents } from "../lib/cents";
import { trialBalance } from "../ledger/reports";
import { getVerifiedTable } from "../tax/tables";
import { storeDocument } from "../vault/store";

export class TbExportError extends Error {}

export type TbExportCodesTable = {
  product: string; // 'lacerte' | 'ultratax' | 'proseries' | 'drake' | 'cch_axcess' | ...
  codes: Record<string, string>; // account code -> product tax-line code
};

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export type TbExport = {
  product: string;
  csv: string;
  rowCount: number;
  documentId: bigint;
};

export async function exportTrialBalanceCsv(db: Dbx, taxYear: number): Promise<TbExport> {
  const { payload } = await getVerifiedTable<TbExportCodesTable>(db, taxYear, "tb_export_codes");
  if (!payload.product || typeof payload.codes !== "object") {
    throw new TbExportError("tb_export_codes table needs { product, codes }");
  }
  const tb = await trialBalance(db, `${taxYear}-12-31`);
  const unmapped = tb.rows.filter((r) => payload.codes[r.code] === undefined);
  if (unmapped.length > 0) {
    throw new TbExportError(
      `no ${payload.product} tax code for account(s) ${unmapped.map((r) => r.code).join(", ")} — ` +
        `add them to the tb_export_codes table (CPA open item; never drop a balance silently)`,
    );
  }
  const lines = [
    "account,description,tax_code,debit,credit",
    ...tb.rows.map((r) =>
      [
        r.code,
        csvCell(r.name),
        payload.codes[r.code]!,
        r.debit > 0n ? formatCents(r.debit).replaceAll(",", "") : "",
        r.credit > 0n ? formatCents(r.credit).replaceAll(",", "") : "",
      ].join(","),
    ),
    `TOTAL,,,${formatCents(tb.totalDebits).replaceAll(",", "")},${formatCents(tb.totalCredits).replaceAll(",", "")}`,
  ];
  const csv = lines.join("\n") + "\n";
  const { document } = await storeDocument(db, {
    filename: `tb-export-${payload.product}-${taxYear}.csv`,
    mime: "text/csv",
    bytes: Buffer.from(csv, "utf8"),
    source: "generated",
    year: taxYear,
  });
  return { product: payload.product, csv, rowCount: tb.rows.length, documentId: document.id };
}
