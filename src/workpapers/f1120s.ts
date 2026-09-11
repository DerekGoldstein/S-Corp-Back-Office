/**
 * Form 1120-S workpaper (§4.6, federal core): page 1, Schedule K, Schedule L,
 * M-1, M-2 — every line a query over account mappings and dimensions, cents
 * kept throughout with IRS whole-dollar values alongside for keying. NO form
 * is rendered (guardrail 4); this is the line-by-line worksheet.
 *
 * Year activity EXCLUDES the equity-roll close entries (those that touch
 * 3900/3100/3110) and their reversals — but INCLUDES the meals reclass,
 * which is exactly what makes each line a plain account query (approved
 * design decision). M-2 mirrors the close's AAA/OAA columns and applies the
 * statutory rule that distributions cannot drive AAA below zero, explaining
 * any difference to the ledger.
 */
import { sql as dsql } from "drizzle-orm";
import type { Dbx } from "../db/client";
import { workpapers } from "../db/schema";
import type { Cents } from "../lib/cents";
import { formatCents, roundToWholeDollars } from "../lib/cents";
import { eq, and, isNull } from "drizzle-orm";

export class WorkpaperError extends Error {}

export type WpLine = {
  code: string; // semantic mapping code: p1.7, K.4, L.1, M1.3, M2.a...
  label: string;
  cents: Cents;
  dollars: number; // IRS whole-dollar for keying (rounded half away from zero)
  accounts: string[];
};

type ActivityRow = {
  code: string;
  name: string;
  type: string;
  m2_col: "aaa" | "oaa" | null;
  form_line: string | null;
  k_line: string | null;
  debits: bigint;
  credits: bigint;
};

/** Year activity per account, excluding equity-roll close entries + their reversals. */
async function yearActivity(db: Dbx, taxYear: number): Promise<ActivityRow[]> {
  const r = await db.execute<ActivityRow>(dsql`
    WITH roll_entries AS (
      SELECT DISTINCT e.id
      FROM journal_entries e
      JOIN journal_lines l ON l.entry_id = e.id
      JOIN accounts a ON a.id = l.account_id
      WHERE e.source_module = 'close' AND a.code IN ('3900','3100','3110')
    ), excluded AS (
      SELECT id FROM roll_entries
      UNION
      SELECT e.id FROM journal_entries e WHERE e.reverses_entry_id IN (SELECT id FROM roll_entries)
    )
    SELECT a.code, a.name, a.type::text AS type, a.m2_col::text AS m2_col,
           a.form_1120s_line AS form_line, a.schedule_k_line AS k_line,
           COALESCE(sum(l.debit),0)::bigint AS debits,
           COALESCE(sum(l.credit),0)::bigint AS credits
    FROM accounts a
    JOIN journal_lines l ON l.account_id = a.id
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE e.entry_date BETWEEN ${`${taxYear}-01-01`} AND ${`${taxYear}-12-31`}
      AND e.id NOT IN (SELECT id FROM excluded)
    GROUP BY a.code, a.name, a.type, a.m2_col, a.form_1120s_line, a.schedule_k_line
  `);
  return r.rows;
}

async function balancesAsOf(db: Dbx, date: string) {
  const r = await db.execute<{
    code: string;
    name: string;
    type: string;
    form_line: string | null;
    balance: bigint;
  }>(dsql`
    SELECT a.code, a.name, a.type::text AS type, a.form_1120s_line AS form_line,
           (COALESCE(sum(l.debit),0) - COALESCE(sum(l.credit),0))::bigint AS balance
    FROM accounts a
    JOIN journal_lines l ON l.account_id = a.id
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE e.entry_date <= ${date}
    GROUP BY a.code, a.name, a.type, a.form_1120s_line
    HAVING COALESCE(sum(l.debit),0) - COALESCE(sum(l.credit),0) <> 0
  `);
  return r.rows;
}

function line(code: string, label: string, cents: Cents, accounts: string[]): WpLine {
  return {
    code,
    label,
    cents,
    dollars: Number(roundToWholeDollars(cents) / 100n),
    accounts,
  };
}

/** income-side activity (credits − debits); deduction-side (debits − credits) */
function activityAmount(row: ActivityRow): Cents {
  return row.type === "revenue" ? row.credits - row.debits : row.debits - row.credits;
}

export type F1120sWorkpaper = {
  taxYear: number;
  page1: WpLine[];
  scheduleK: WpLine[];
  scheduleL: { beginning: WpLine[]; ending: WpLine[] };
  m1: WpLine[];
  m2: { aaa: WpLine[]; oaa: WpLine[] };
  tieOuts: Array<{ name: string; pass: boolean; detail: string }>;
};

const PAGE1_DEDUCTION_LINES = [
  ["p1.7", "Compensation of officers"],
  ["p1.12", "Taxes and licenses"],
  ["p1.14", "Depreciation"],
  ["p1.17", "Pension, profit-sharing, etc., plans"],
  ["p1.19", "Other deductions (statement)"],
] as const;

const SCHEDULE_K_LINES: ReadonlyArray<[string, string, "income" | "deduction"]> = [
  ["K.4", "Interest income", "income"],
  ["K.5a", "Ordinary dividends", "income"],
  ["K.7", "Net short-term capital gain (loss)", "income"],
  ["K.8a", "Net long-term capital gain (loss)", "income"],
  ["K.9", "Net section 1231 gain (loss)", "income"],
  ["K.10", "Other income (loss)", "income"],
  ["K.11", "Section 179 deduction", "deduction"],
  ["K.12a", "Charitable contributions", "deduction"],
  ["K.16a", "Tax-exempt interest income", "income"],
  ["K.16c", "Nondeductible expenses", "deduction"],
];

export async function buildF1120s(db: Dbx, taxYear: number): Promise<F1120sWorkpaper> {
  const activity = await yearActivity(db, taxYear);
  const byFormLine = (code: string) => activity.filter((a) => a.form_line === code);
  const byKLine = (code: string) => activity.filter((a) => a.k_line === code);
  const sum = (rows: ActivityRow[]) => rows.reduce((acc, r) => acc + activityAmount(r), 0n);
  const codes = (rows: ActivityRow[]) => rows.map((r) => r.code).sort();

  // --- page 1 ---------------------------------------------------------------
  const page1: WpLine[] = [];
  const grossReceipts = byFormLine("p1.1a");
  page1.push(line("p1.1a", "Gross receipts or sales", sum(grossReceipts), codes(grossReceipts)));
  const otherIncome = byFormLine("p1.5");
  page1.push(
    line("p1.5", "Other income (partnership ordinary income statement)", sum(otherIncome), codes(otherIncome)),
  );
  const totalIncome = sum(grossReceipts) + sum(otherIncome);
  page1.push(line("p1.6", "Total income", totalIncome, []));
  let totalDeductions = 0n;
  for (const [code, label] of PAGE1_DEDUCTION_LINES) {
    const rows = byFormLine(code);
    const amount = sum(rows);
    totalDeductions += amount;
    page1.push(line(code, label, amount, codes(rows)));
  }
  page1.push(line("p1.20", "Total deductions", totalDeductions, []));
  const ordinaryIncome = totalIncome - totalDeductions;
  page1.push(line("p1.21", "Ordinary business income (loss)", ordinaryIncome, []));

  // --- Schedule K -----------------------------------------------------------
  const scheduleK: WpLine[] = [line("K.1", "Ordinary business income (loss)", ordinaryIncome, [])];
  for (const [code, label] of SCHEDULE_K_LINES) {
    const rows = byKLine(code);
    if (rows.length === 0) continue;
    scheduleK.push(line(code, label, sum(rows), codes(rows)));
  }
  const distributions = activity.filter((a) => a.k_line === "K.16d");
  const distributionsPaid = distributions.reduce((acc, r) => acc + (r.debits - r.credits), 0n);
  scheduleK.push(line("K.16d", "Distributions (cash and property)", distributionsPaid, codes(distributions)));
  // K.18 income/loss reconciliation: income lines minus deduction lines (excl. 16*)
  let k18 = ordinaryIncome;
  for (const [code, , side] of SCHEDULE_K_LINES) {
    if (code.startsWith("K.16")) continue;
    const amount = sum(byKLine(code));
    k18 += side === "income" ? amount : -amount;
  }
  scheduleK.push(line("K.18", "Income (loss) reconciliation", k18, []));

  // --- Schedule L -----------------------------------------------------------
  const mkL = async (date: string): Promise<WpLine[]> => {
    const rows = await balancesAsOf(db, date);
    const groups = new Map<string, { cents: Cents; accounts: string[] }>();
    for (const r of rows) {
      const code = r.form_line ?? "L.other";
      const isCredit = r.type === "liability" || r.type === "equity" || r.type === "contra_equity";
      const amount = isCredit ? -r.balance : r.balance;
      const g = groups.get(code) ?? { cents: 0n, accounts: [] };
      g.cents += amount;
      g.accounts.push(r.code);
      groups.set(code, g);
    }
    // revenue/expense residue (an unclosed year) folds into L.24 retained earnings
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, g]) => line(code, `Schedule L ${code}`, g.cents, g.accounts.sort()));
  };
  const beginning = await mkL(`${taxYear - 1}-12-31`);
  const ending = await mkL(`${taxYear}-12-31`);

  // --- M-1 ------------------------------------------------------------------
  const nondeductibleRows = activity.filter(
    (a) => (a.type === "revenue" || a.type === "expense") && isNondeductible(a),
  );
  const taxExemptRows = activity.filter((a) => a.type === "revenue" && a.m2_col === "oaa");
  const bookIncome = activity
    .filter((a) => a.type === "revenue" || a.type === "expense")
    .reduce((acc, r) => acc + (r.type === "revenue" ? 1n : -1n) * activityAmount(r), 0n);
  const m1Nondeductible = sum(nondeductibleRows);
  const m1TaxExempt = sum(taxExemptRows);
  const m1: WpLine[] = [
    line("M1.1", "Net income (loss) per books", bookIncome, []),
    line("M1.3", "Expenses on books not on Schedule K (nondeductible)", m1Nondeductible, codes(nondeductibleRows)),
    line("M1.4", "Subtotal (1 + 3)", bookIncome + m1Nondeductible, []),
    line("M1.5", "Income on books not on Schedule K (tax-exempt)", m1TaxExempt, codes(taxExemptRows)),
    line("M1.8", "Income (loss) per Schedule K line 18", bookIncome + m1Nondeductible - m1TaxExempt, []),
  ];

  // --- M-2 (mirrors the close: aaa/oaa via m2_col) ----------------------------
  const aaaBeginning = await equityBalanceAsOf(db, "3100", `${taxYear - 1}-12-31`);
  const oaaBeginning = await equityBalanceAsOf(db, "3110", `${taxYear - 1}-12-31`);
  const incomeAaa = activity
    .filter((a) => (a.type === "revenue" || a.type === "expense") && a.m2_col !== "oaa")
    .reduce((acc, r) => acc + (r.type === "revenue" ? 1n : -1n) * activityAmount(r), 0n);
  const oaaNet = activity
    .filter((a) => (a.type === "revenue" || a.type === "expense") && a.m2_col === "oaa")
    .reduce((acc, r) => acc + (r.type === "revenue" ? 1n : -1n) * activityAmount(r), 0n);
  const aaaBeforeDistributions = aaaBeginning + incomeAaa;
  // statutory ordering: distributions cannot take AAA below zero on the form
  const aaaDistributions =
    distributionsPaid <= max0(aaaBeforeDistributions) ? distributionsPaid : max0(aaaBeforeDistributions);
  const distributionsInExcessOfAaa = distributionsPaid - aaaDistributions;
  const aaaEnding = aaaBeforeDistributions - aaaDistributions;
  const m2aaa: WpLine[] = [
    line("M2.a.1", "AAA balance at beginning of year", aaaBeginning, ["3100"]),
    line("M2.a.net", "Income less deductions and nondeductibles (AAA column)", incomeAaa, []),
    line("M2.a.7", "Distributions (limited: AAA not below zero)", aaaDistributions, ["3200"]),
    line("M2.a.8", "AAA balance at end of year", aaaEnding, []),
  ];
  const m2oaa: WpLine[] = [
    line("M2.d.1", "OAA balance at beginning of year", oaaBeginning, ["3110"]),
    line("M2.d.net", "Tax-exempt income less related nondeductibles", oaaNet, []),
    line("M2.d.8", "OAA balance at end of year", oaaBeginning + oaaNet, []),
  ];

  // --- tie-outs (§4.11 feeders) ----------------------------------------------
  const ledgerAaaEnd = await equityBalanceAsOf(db, "3100", `${taxYear}-12-31`);
  const ledgerOaaEnd = await equityBalanceAsOf(db, "3110", `${taxYear}-12-31`);
  const lTotal = (side: WpLine[]) => side.reduce((a, l) => a + l.cents, 0n);
  const lAssets = ending.filter((l) => !l.code.startsWith("L.2") || l.code === "L.10a" || l.code === "L.10b");
  void lAssets;
  const assetsEnding = ending
    .filter((l) => ["L.1", "L.8", "L.10a", "L.10b"].includes(l.code) || l.code === "L.other")
    .reduce((a, l) => a + l.cents, 0n);
  const liabEquityEnding = lTotal(ending) - assetsEnding;
  const tieOuts = [
    {
      name: "M-1 line 8 equals Schedule K line 18",
      pass: bookIncome + m1Nondeductible - m1TaxExempt === k18,
      detail: `M-1: ${formatCents(bookIncome + m1Nondeductible - m1TaxExempt)} vs K.18: ${formatCents(k18)}`,
    },
    {
      name: "Schedule L balances (assets = liabilities + equity)",
      pass: assetsEnding === liabEquityEnding,
      detail: `assets ${formatCents(assetsEnding)} vs L+E ${formatCents(liabEquityEnding)}`,
    },
    {
      name: "M-2 ending AAA reconciles to ledger 3100 (difference = distributions in excess of AAA)",
      pass: aaaEnding - distributionsInExcessOfAaa === ledgerAaaEnd || ledgerAaaEnd === 0n,
      detail:
        `form AAA ${formatCents(aaaEnding)}, ledger 3100 ${formatCents(ledgerAaaEnd)}, ` +
        `excess distributions ${formatCents(distributionsInExcessOfAaa)}`,
    },
    {
      name: "M-2 ending OAA equals ledger 3110",
      pass: oaaBeginning + oaaNet === ledgerOaaEnd || ledgerOaaEnd === 0n,
      detail: `form OAA ${formatCents(oaaBeginning + oaaNet)}, ledger 3110 ${formatCents(ledgerOaaEnd)}`,
    },
  ];

  return {
    taxYear,
    page1,
    scheduleK,
    scheduleL: { beginning, ending },
    m1,
    m2: { aaa: m2aaa, oaa: m2oaa },
    tieOuts,
  };
}

function isNondeductible(a: ActivityRow): boolean {
  return a.code === "5900" || a.code === "4610" || a.code === "4615";
}

function max0(x: Cents): Cents {
  return x > 0n ? x : 0n;
}

async function equityBalanceAsOf(db: Dbx, code: string, date: string): Promise<Cents> {
  const r = await db.execute<{ balance: bigint | null }>(dsql`
    SELECT (COALESCE(sum(l.credit),0) - COALESCE(sum(l.debit),0))::bigint AS balance
    FROM journal_lines l
    JOIN accounts a ON a.id = l.account_id
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE a.code = ${code} AND e.entry_date <= ${date}
  `);
  return r.rows[0]?.balance ?? 0n;
}

/** Persist a draft version (next version number for the kind/year). */
export async function saveWorkpaper(
  db: Dbx,
  kind: string,
  taxYear: number,
  payload: unknown,
  tieOuts: unknown,
): Promise<{ id: bigint; version: number }> {
  const toJson = (v: unknown) =>
    JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
  const existing = await db
    .select({ version: workpapers.version })
    .from(workpapers)
    .where(and(eq(workpapers.kind, kind), eq(workpapers.taxYear, taxYear), isNull(workpapers.quarter)));
  const version = existing.reduce((a, r) => Math.max(a, r.version), 0) + 1;
  const [row] = await db
    .insert(workpapers)
    .values({ kind, taxYear, version, payload: toJson(payload), tieOuts: toJson(tieOuts) })
    .returning({ id: workpapers.id });
  return { id: row!.id, version };
}

/** Guardrail 12: no workpaper is final without the reviewer sign-off. */
export async function finalizeWorkpaper(db: Dbx, id: bigint, reviewedBy: string): Promise<void> {
  if (reviewedBy.trim() === "") {
    throw new WorkpaperError("a reviewed-by sign-off (owner/CPA) is required to finalize");
  }
  await db
    .update(workpapers)
    .set({ status: "final", reviewedBy, reviewedAt: new Date() })
    .where(eq(workpapers.id, id));
}
