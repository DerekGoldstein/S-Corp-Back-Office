/**
 * Tax-table registry (§4.4 pattern, guardrail 1): per-year JSON files under
 * data/tax-tables/<year>/ load as immutable versioned rows. Nothing computes
 * from a table until the owner verifies it against the official source, and
 * a file change silently superseding a verified version makes every consumer
 * FAIL LOUDLY until the new version is re-verified.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import type { Dbx } from "../db/client";
import { auditLog, taxTableVersions } from "../db/schema";

export class TaxTableError extends Error {}

export type TaxTableFile = {
  kind: string;
  source_url: string;
  effective_from?: string;
  effective_to?: string;
  payload: Record<string, unknown>;
};

export type LoadReport = Array<{
  kind: string;
  action: "loaded_unverified" | "unchanged" | "superseded_verified";
  id: number;
}>;

export function taxTablesDir(): string {
  return resolve(process.cwd(), process.env.TAX_TABLES_DIR ?? "data/tax-tables");
}

/** Load every JSON file for the year; new content becomes a new UNVERIFIED row. */
export async function loadTaxTables(db: Dbx, taxYear: number): Promise<LoadReport> {
  const dir = join(taxTablesDir(), String(taxYear));
  if (!existsSync(dir)) {
    throw new TaxTableError(
      `no table directory for ${taxYear} (${dir}) — create it from data/tax-tables/README.md`,
    );
  }
  const report: LoadReport = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const raw = readFileSync(join(dir, file), "utf8");
    const parsed = JSON.parse(raw) as TaxTableFile;
    if (!parsed.kind || !parsed.source_url || parsed.payload === undefined) {
      throw new TaxTableError(`${file}: needs kind, source_url, payload`);
    }
    const sha = createHash("sha256").update(raw).digest("hex");
    const rows = await db
      .select()
      .from(taxTableVersions)
      .where(and(eq(taxTableVersions.taxYear, taxYear), eq(taxTableVersions.kind, parsed.kind)))
      .orderBy(asc(taxTableVersions.id));
    const existing = rows.find((r) => r.sha256 === sha);
    if (existing) {
      report.push({ kind: parsed.kind, action: "unchanged", id: existing.id });
      continue;
    }
    const hadVerified = rows.some((r) => r.verifiedByOwner);
    const [inserted] = await db
      .insert(taxTableVersions)
      .values({
        taxYear,
        kind: parsed.kind,
        sourceUrl: parsed.source_url,
        effectiveFrom: parsed.effective_from ?? null,
        effectiveTo: parsed.effective_to ?? null,
        payload: parsed.payload,
        sha256: sha,
      })
      .returning({ id: taxTableVersions.id });
    report.push({
      kind: parsed.kind,
      action: hadVerified ? "superseded_verified" : "loaded_unverified",
      id: inserted!.id,
    });
  }
  return report;
}

function findNulls(value: unknown, path: string, out: string[]): void {
  if (value === null) {
    out.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findNulls(v, `${path}[${i}]`, out));
  } else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      findNulls(v, path === "" ? k : `${path}.${k}`, out);
    }
  }
}

/** Owner verification: refuses placeholder payloads (null values). */
export async function verifyTaxTable(db: Dbx, id: number): Promise<void> {
  const [row] = await db.select().from(taxTableVersions).where(eq(taxTableVersions.id, id));
  if (!row) throw new TaxTableError(`tax table row ${id} not found`);
  if (row.verifiedByOwner) return;
  const nulls: string[] = [];
  findNulls(row.payload, "", nulls);
  const realNulls = nulls.filter((n) => !n.startsWith("_"));
  if (realNulls.length > 0) {
    throw new TaxTableError(
      `refusing to verify ${row.kind}/${row.taxYear}: placeholder (null) values remain at ` +
        `${realNulls.slice(0, 5).join(", ")} — fill them from ${row.sourceUrl} first`,
    );
  }
  await db
    .update(taxTableVersions)
    .set({ verifiedByOwner: true, verifiedAt: new Date() })
    .where(eq(taxTableVersions.id, id));
  await db.insert(auditLog).values({
    actor: "owner",
    action: "verify_tax_table",
    objectType: "tax_table_version",
    objectId: String(id),
    detail: { kind: row.kind, taxYear: row.taxYear, sha256: row.sha256 },
  });
}

/**
 * THE gate (§4.4): returns the latest version's payload only when that
 * version is owner-verified. A newer unverified version above a verified one
 * — a table file changed without re-verification — also fails loudly.
 */
export async function getVerifiedTable<T = Record<string, unknown>>(
  db: Dbx,
  taxYear: number,
  kind: string,
): Promise<{ id: number; payload: T; sourceUrl: string }> {
  const rows = await db
    .select()
    .from(taxTableVersions)
    .where(and(eq(taxTableVersions.taxYear, taxYear), eq(taxTableVersions.kind, kind)))
    .orderBy(asc(taxTableVersions.id));
  if (rows.length === 0) {
    throw new TaxTableError(
      `no ${kind} table loaded for ${taxYear} — load data/tax-tables/${taxYear}/ and verify it (§4.4)`,
    );
  }
  const latest = rows[rows.length - 1]!;
  if (!latest.verifiedByOwner) {
    const priorVerified = rows.some((r) => r.verifiedByOwner);
    throw new TaxTableError(
      priorVerified
        ? `${kind}/${taxYear} CHANGED without re-verification: version #${latest.id} supersedes ` +
          `a verified version — re-verify against ${latest.sourceUrl} before anything computes from it`
        : `${kind}/${taxYear} is loaded but not verified_by_owner — the app refuses to run ` +
          `payroll/workpapers on unverified tables (§4.4); verify version #${latest.id}`,
    );
  }
  return { id: latest.id, payload: latest.payload as T, sourceUrl: latest.sourceUrl };
}

/** Convenience for modules needing several tables at once. */
export async function requireVerifiedTables(
  db: Dbx,
  taxYear: number,
  kinds: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const problems: string[] = [];
  for (const kind of kinds) {
    try {
      const { payload } = await getVerifiedTable(db, taxYear, kind);
      out.set(kind, payload);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (problems.length > 0) {
    throw new TaxTableError(`tax tables not ready for ${taxYear}:\n- ` + problems.join("\n- "));
  }
  return out;
}
