/**
 * Form 4562 WORKPAPER (never the form — guardrail 2): what was actually
 * DEDUCTED, rebuilt from the posted depreciation subledger, tied to the
 * ledger to the cent. Three tie-outs: line 22 equals the year's 5050
 * activity; the register's cost equals the 1600 balance (a red tie-out here
 * means an asset purchase is still sitting unclassified — or was expensed);
 * cumulative subledger depreciation equals the 1610 balance. Stated
 * assumptions ship with the payload: the §179(b)(3) business-income
 * limitation is NOT applied here (CPA confirms the taxable-income ceiling),
 * and listed-property Part V is out of scope.
 */
import { sql as dsql } from "drizzle-orm";
import type { Dbx } from "../db/client";
import type { Cents } from "../lib/cents";
import { formatCents } from "../lib/cents";
import { getVerifiedTable, TaxTableError } from "../tax/tables";
import type { DepreciationTable } from "../assets/register";
import { saveWorkpaper } from "./f1120s";

export type F4562Workpaper = {
  taxYear: number;
  part1: {
    line1_dollar_limit: string | null;
    line2_cost_of_179_property: string;
    line3_phaseout_threshold: string | null;
    line5_reduced_limit: string | null;
    line6_elections: Array<{ description: string; cost: string; elected: string }>;
    line12_deduction: string;
  };
  line14_bonus: string;
  part3_macrs: Array<{
    classLine: string; // e.g. "19b (5-year)"
    method: string;
    convention: string;
    basis: string;
    deduction: string;
  }>;
  line22_total: string;
  assumptions: string[];
  tieOuts: Array<{ name: string; pass: boolean; detail: string }>;
};

async function ledger5050Activity(db: Dbx, taxYear: number): Promise<Cents> {
  const r = await db.execute<{ activity: bigint }>(dsql`
    WITH roll_entries AS (
      SELECT DISTINCT e.id
      FROM journal_entries e
      JOIN journal_lines l ON l.entry_id = e.id
      JOIN accounts a ON a.id = l.account_id
      WHERE e.source_module = 'close' AND a.code IN ('3900','3100','3110')
    ), excluded AS (
      SELECT id FROM roll_entries
      UNION
      SELECT e.id FROM journal_entries e
      WHERE e.reverses_entry_id IN (SELECT id FROM roll_entries)
    )
    SELECT COALESCE(sum(l.debit) - sum(l.credit), 0)::bigint AS activity
    FROM journal_lines l
    JOIN accounts a ON a.id = l.account_id
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE a.code = '5050'
      AND e.entry_date BETWEEN ${`${taxYear}-01-01`} AND ${`${taxYear}-12-31`}
      AND e.id NOT IN (SELECT id FROM excluded)
  `);
  return BigInt(r.rows[0]?.activity ?? 0n);
}

async function balanceAsOf(db: Dbx, code: string, date: string): Promise<Cents> {
  const r = await db.execute<{ balance: bigint }>(dsql`
    SELECT COALESCE(sum(l.debit) - sum(l.credit), 0)::bigint AS balance
    FROM journal_lines l
    JOIN accounts a ON a.id = l.account_id
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE a.code = ${code} AND e.entry_date <= ${date}
  `);
  return BigInt(r.rows[0]?.balance ?? 0n);
}

export async function buildF4562(db: Dbx, taxYear: number): Promise<F4562Workpaper> {
  // Posted, unreversed subledger rows are the source of truth.
  const posted = await db.execute<{
    asset_id: bigint;
    description: string;
    cost: bigint;
    placed_in_service: string;
    recovery_years: number;
    amount: bigint;
    detail: Record<string, string | number | null>;
  }>(dsql`
    SELECT p.asset_id, f.description, f.cost::bigint AS cost, f.placed_in_service::text,
           f.recovery_years, p.amount::bigint AS amount, p.detail
    FROM depreciation_postings p
    JOIN fixed_assets f ON f.id = p.asset_id
    WHERE p.tax_year = ${taxYear}
      AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = p.journal_entry_id)
    ORDER BY p.asset_id
  `);

  const rows = posted.rows.map((r) => ({
    ...r,
    s179: BigInt(String(r.detail.section179 ?? "0")),
    bonus: BigInt(String(r.detail.bonus ?? "0")),
    macrsBasis: BigInt(String(r.detail.macrsBasis ?? "0")),
    macrsDeduction: BigInt(String(r.detail.macrsDeduction ?? "0")),
    method: String(r.detail.method ?? ""),
    convention: String(r.detail.convention ?? ""),
  }));

  const s179Total = rows.reduce((s, r) => s + r.s179, 0n);
  const bonusTotal = rows.reduce((s, r) => s + r.bonus, 0n);
  const total = rows.reduce((s, r) => s + BigInt(r.amount), 0n);

  // Year limits shown when elections exist (the posting already enforced them).
  let limits: DepreciationTable | null = null;
  if (s179Total > 0n || bonusTotal > 0n) {
    try {
      limits = (await getVerifiedTable<DepreciationTable>(db, taxYear, "depreciation")).payload;
    } catch (err) {
      if (!(err instanceof TaxTableError)) throw err;
    }
  }

  const electors = rows.filter((r) => r.s179 > 0n);
  const byClass = new Map<string, { basis: Cents; deduction: Cents; method: string; convention: string }>();
  for (const r of rows) {
    const key = `${r.recovery_years}|${r.method}|${r.convention}`;
    const cur = byClass.get(key) ?? { basis: 0n, deduction: 0n, method: r.method, convention: r.convention };
    cur.basis += r.macrsBasis;
    cur.deduction += r.macrsDeduction;
    byClass.set(key, cur);
  }

  const ledgerActivity = await ledger5050Activity(db, taxYear);
  const bal1600 = await balanceAsOf(db, "1600", `${taxYear}-12-31`);
  const bal1610 = await balanceAsOf(db, "1610", `${taxYear}-12-31`); // contra: credit balance is negative here
  const registerCost = await db.execute<{ total: bigint }>(dsql`
    SELECT COALESCE(sum(cost),0)::bigint AS total FROM fixed_assets
    WHERE placed_in_service <= ${`${taxYear}-12-31`} AND disposed_on IS NULL
  `);
  const cumulativeDep = await db.execute<{ total: bigint }>(dsql`
    SELECT COALESCE(sum(p.amount),0)::bigint AS total
    FROM depreciation_postings p
    WHERE p.tax_year <= ${taxYear}
      AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = p.journal_entry_id)
  `);
  const regCost = BigInt(registerCost.rows[0]?.total ?? 0n);
  const cumDep = BigInt(cumulativeDep.rows[0]?.total ?? 0n);

  const tieOuts = [
    {
      name: "4562 line 22 equals depreciation expense (5050) year activity",
      pass: total === ledgerActivity,
      detail: `line 22 ${formatCents(total)} vs ledger ${formatCents(ledgerActivity)}`,
    },
    {
      name: "asset register cost equals fixed assets (1600) balance",
      pass: regCost === bal1600,
      detail: `register ${formatCents(regCost)} vs 1600 ${formatCents(bal1600)} — a difference means a purchase is unclassified or was expensed`,
    },
    {
      name: "cumulative subledger depreciation equals accumulated depreciation (1610)",
      pass: cumDep === -bal1610,
      detail: `subledger ${formatCents(cumDep)} vs 1610 ${formatCents(-bal1610)}`,
    },
  ];

  const wp: F4562Workpaper = {
    taxYear,
    part1: {
      line1_dollar_limit: limits ? formatCents(BigInt(limits.section179_limit_cents)) : null,
      line2_cost_of_179_property: formatCents(electors.reduce((s, r) => s + BigInt(r.cost), 0n)),
      line3_phaseout_threshold: limits ? formatCents(BigInt(limits.section179_phaseout_start_cents)) : null,
      line5_reduced_limit: limits
        ? formatCents(
            (() => {
              const lim = BigInt(limits.section179_limit_cents);
              const thr = BigInt(limits.section179_phaseout_start_cents);
              const placed = rows
                .filter((r) => r.placed_in_service.startsWith(String(taxYear)))
                .reduce((s, r) => s + BigInt(r.cost), 0n);
              const over = placed > thr ? placed - thr : 0n;
              return lim > over ? lim - over : 0n;
            })(),
          )
        : null,
      line6_elections: electors.map((r) => ({
        description: r.description,
        cost: formatCents(BigInt(r.cost)),
        elected: formatCents(r.s179),
      })),
      line12_deduction: formatCents(s179Total),
    },
    line14_bonus: formatCents(bonusTotal),
    part3_macrs: [...byClass.entries()]
      .sort(([a], [b]) => Number(a.split("|")[0]) - Number(b.split("|")[0]))
      .map(([key, v]) => ({
        classLine: `19 (${key.split("|")[0]}-year)`,
        method: v.method,
        convention: v.convention,
        basis: formatCents(v.basis),
        deduction: formatCents(v.deduction),
      })),
    line22_total: formatCents(total),
    assumptions: [
      "§179(b)(3) business-income limitation NOT applied here — CPA confirms the taxable-income ceiling on review",
      "listed property (Part V) and luxury-auto caps out of scope; no such assets may be entered in the register",
      "GDS personal property only; disposal-year assets are excluded and handled manually with the CPA (§1245 recapture)",
    ],
    tieOuts,
  };
  await saveWorkpaper(db, "f4562", taxYear, wp, tieOuts);
  return wp;
}
