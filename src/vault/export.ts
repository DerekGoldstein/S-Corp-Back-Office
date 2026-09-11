/**
 * The CPA hand-off archive (§4.11): one zip per tax year containing the
 * latest version of every workpaper (as JSON), every review-package cover
 * memo, and every vault document that belongs to the year — tagged with the
 * year, or linked to a journal entry dated in it. Bytes come through
 * readDocument, so every file is integrity-checked against its sha256 on
 * the way out; the manifest lists each entry with its hash and provenance.
 */
import { sql as dsql } from "drizzle-orm";
import type { Dbx } from "../db/client";
import { buildZip, type ZipEntry } from "../lib/zip";
import { readDocument } from "./store";

export type ExportManifest = {
  taxYear: number;
  generatedAt: string;
  workpapers: Array<{ path: string; kind: string; quarter: number | null; version: number; status: string }>;
  documents: Array<{ path: string; id: string; sha256: string; via: string }>;
};

function safeName(filename: string): string {
  return filename.replaceAll(/[^\w.\-]+/g, "_").slice(0, 120) || "document";
}

export async function exportYearArchive(
  db: Dbx,
  taxYear: number,
): Promise<{ zip: Buffer; manifest: ExportManifest; filename: string }> {
  const entries: ZipEntry[] = [];
  const manifest: ExportManifest = {
    taxYear,
    generatedAt: new Date().toISOString(),
    workpapers: [],
    documents: [],
  };

  // Latest workpaper version per (kind, quarter) for the year.
  const wps = await db.execute<{
    kind: string;
    quarter: number | null;
    version: number;
    status: string;
    payload: unknown;
    tie_outs: unknown;
  }>(dsql`
    SELECT DISTINCT ON (kind, quarter) kind, quarter, version, status, payload, tie_outs
    FROM workpapers
    WHERE tax_year = ${taxYear}
    ORDER BY kind, quarter, version DESC
  `);
  for (const w of wps.rows) {
    const path = `workpapers/${w.kind}${w.quarter ? `-q${w.quarter}` : ""}-v${w.version}.json`;
    entries.push({
      path,
      bytes: Buffer.from(
        JSON.stringify(
          { kind: w.kind, taxYear, quarter: w.quarter, version: w.version, status: w.status, payload: w.payload, tieOuts: w.tie_outs },
          null,
          2,
        ),
        "utf8",
      ),
    });
    manifest.workpapers.push({ path, kind: w.kind, quarter: w.quarter, version: w.version, status: w.status });
  }

  // Vault documents: year-tagged, or linked to a journal entry dated in-year.
  const docs = await db.execute<{ id: bigint; via: string }>(dsql`
    SELECT d.id, 'year tag' AS via FROM documents d WHERE d.year = ${taxYear}
    UNION
    SELECT DISTINCT dl.document_id AS id, 'journal entry' AS via
    FROM document_links dl
    JOIN journal_entries e ON dl.linked_type = 'journal_entry' AND dl.linked_id = e.id::text
    WHERE e.entry_date BETWEEN ${`${taxYear}-01-01`} AND ${`${taxYear}-12-31`}
    ORDER BY id
  `);
  const seen = new Set<string>();
  for (const row of docs.rows) {
    const key = row.id.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const { document, bytes } = await readDocument(db, row.id); // sha256-verified read
    const path = `documents/${key}-${safeName(document.filename)}`;
    entries.push({ path, bytes });
    manifest.documents.push({ path, id: key, sha256: document.sha256, via: row.via });
  }

  entries.unshift({
    path: "manifest.json",
    bytes: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
  });
  return {
    zip: buildZip(entries),
    manifest,
    filename: `cpa-export-${taxYear}.zip`,
  };
}
