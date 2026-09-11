/**
 * Seed the chart of accounts from data/coa/chart-of-accounts.json.
 * Idempotent: missing accounts are inserted; existing accounts get their
 * non-identity fields (name, mappings, document rules, active) refreshed.
 * Identity fields (type, tax_treatment, m2_col) on accounts with posted
 * lines are protected by the DB trigger — attempting to change them fails
 * loudly, which is the intended behavior.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { asCents } from "../lib/cents";
import { makeDb, defaultDatabaseUrl, type Dbx } from "./client";
import { accounts } from "./schema";

type SeedAccount = {
  code: string;
  name: string;
  type: "asset" | "contra_asset" | "liability" | "equity" | "contra_equity" | "revenue" | "expense";
  taxTreatment:
    | "taxable_ordinary"
    | "separately_stated"
    | "deductible"
    | "deductible_50pct"
    | "nondeductible"
    | "tax_exempt"
    | "not_tax";
  m2Col?: "aaa" | "oaa";
  form1120sLine?: string;
  scheduleKLine?: string;
  requiresDocument?: boolean;
  documentThreshold?: string;
};

export async function seedChartOfAccounts(db: Dbx): Promise<{ inserted: number; updated: number }> {
  const raw = readFileSync(resolve(process.cwd(), "data/coa/chart-of-accounts.json"), "utf8");
  const parsed = JSON.parse(raw) as { accounts: SeedAccount[] };
  let inserted = 0;
  let updated = 0;
  for (const a of parsed.accounts) {
    const values = {
      code: a.code,
      name: a.name,
      type: a.type,
      taxTreatment: a.taxTreatment,
      m2Col: a.m2Col ?? null,
      form1120sLine: a.form1120sLine ?? null,
      scheduleKLine: a.scheduleKLine ?? null,
      requiresDocument: a.requiresDocument ?? false,
      documentThreshold: a.documentThreshold !== undefined ? asCents(a.documentThreshold) : null,
    };
    const existing = await db.select().from(accounts).where(eq(accounts.code, a.code));
    if (existing.length === 0) {
      await db.insert(accounts).values(values);
      inserted++;
    } else {
      const row = existing[0]!;
      const changed =
        row.name !== values.name ||
        row.form1120sLine !== values.form1120sLine ||
        row.scheduleKLine !== values.scheduleKLine ||
        row.requiresDocument !== values.requiresDocument ||
        row.documentThreshold !== values.documentThreshold ||
        row.type !== values.type ||
        row.taxTreatment !== values.taxTreatment ||
        row.m2Col !== values.m2Col;
      if (changed) {
        await db.update(accounts).set(values).where(eq(accounts.code, a.code));
        updated++;
      }
    }
  }
  return { inserted, updated };
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("seed.ts")) {
  const { pool, db } = makeDb(defaultDatabaseUrl());
  seedChartOfAccounts(db)
    .then(async (r) => {
      console.log(`chart of accounts: ${r.inserted} inserted, ${r.updated} updated`);
      await pool.end();
    })
    .catch(async (err) => {
      console.error(err instanceof Error ? err.message : err);
      await pool.end();
      process.exit(1);
    });
}
