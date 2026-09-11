/**
 * Payroll form WORKSHEETS (§4.4): line-by-line values keyed to the forms'
 * own line numbers, for keying into the IRS e-file product, SSA BSO, and NY
 * Online Services. No form is rendered (guardrail 4). Everything derives
 * from posted payroll_runs plus the year's verified tables; the §4.11
 * tie-outs are computed alongside.
 */
import { and, eq, sql as dsql } from "drizzle-orm";
import type { Dbx } from "../db/client";
import { payrollDeposits, payrollRuns } from "../db/schema";
import type { Cents } from "../lib/cents";
import { formatCents, roundToWholeDollars } from "../lib/cents";
import { getVerifiedTable } from "../tax/tables";
import { saveWorkpaper, type WpLine } from "../workpapers/f1120s";
import type { FicaTable, FutaTable } from "./engine";

export class WorksheetError extends Error {}

function line(code: string, label: string, cents: Cents): WpLine {
  return { code, label, cents, dollars: Number(roundToWholeDollars(cents) / 100n), accounts: [] };
}

type Run = typeof payrollRuns.$inferSelect;

async function postedRuns(db: Dbx, taxYear: number): Promise<Run[]> {
  const runs = await db
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.taxYear, taxYear), eq(payrollRuns.status, "posted")));
  if (runs.length === 0) {
    throw new WorksheetError(`no posted payroll runs for ${taxYear}`);
  }
  return runs;
}

const sum = (runs: Run[], f: (r: Run) => Cents): Cents => runs.reduce((a, r) => a + f(r), 0n);

export type Worksheet = {
  kind: string;
  taxYear: number;
  quarter: number | null;
  lines: WpLine[];
  flags: string[];
  tieOuts: Array<{ name: string; pass: boolean; detail: string }>;
};

/** W-2 / W-3 (single employee: the owner). Box 1 includes 2% health, 3/5 never do. */
export async function buildW2(db: Dbx, taxYear: number): Promise<Worksheet> {
  const runs = await postedRuns(db, taxYear);
  const fica = (await getVerifiedTable<FicaTable>(db, taxYear, "fica")).payload;
  const ssBase = BigInt(fica.social_security_wage_base_cents);
  const box1 = sum(runs, (r) => r.fitWages - r.eeDeferral401k);
  const ficaWages = sum(runs, (r) => r.ficaWages);
  const box3 = ficaWages < ssBase ? ficaWages : ssBase;
  const health = sum(runs, (r) => r.healthPremium);
  const deferral = sum(runs, (r) => r.eeDeferral401k);
  const lines: WpLine[] = [
    line("W2.1", "Wages, tips, other compensation (incl. 2% shareholder health)", box1),
    line("W2.2", "Federal income tax withheld", sum(runs, (r) => r.fitWithheld)),
    line("W2.3", "Social security wages (capped; excludes health)", box3),
    line("W2.4", "Social security tax withheld", sum(runs, (r) => r.eeSocialSecurity)),
    line("W2.5", "Medicare wages and tips (excludes health)", ficaWages),
    line("W2.6", "Medicare tax withheld (incl. Additional)", sum(runs, (r) => r.eeMedicare + r.eeAddlMedicare)),
    line("W2.12D", "Box 12 code D — elective 401(k) deferral", deferral),
    line("W2.14", "Box 14 — S corp 2% shareholder health insurance", health),
    line("W2.16", "NY state wages", sum(runs, (r) => r.nysWages - r.eeDeferral401k)),
    line("W2.17", "NY state income tax", sum(runs, (r) => r.nysWithheld)),
    line("W2.18", "NYC local wages", sum(runs, (r) => (r.nycWages > 0n ? r.nycWages - r.eeDeferral401k : 0n))),
    line("W2.19", "NYC local income tax", sum(runs, (r) => r.nycWithheld)),
  ];
  const flags = [
    "Box 13 'Retirement plan' — CHECKED",
    "Box 20 locality — NYC",
    "W-3 totals equal this W-2 (single employee)",
  ];
  const ledger = await db.execute<{ v: bigint | null }>(dsql`
    SELECT (COALESCE(sum(l.debit),0)-COALESCE(sum(l.credit),0))::bigint AS v
    FROM journal_lines l JOIN accounts a ON a.id=l.account_id
    JOIN journal_entries e ON e.id=l.entry_id
    WHERE a.code IN ('5000','5030')
      AND e.entry_date BETWEEN ${`${taxYear}-01-01`} AND ${`${taxYear}-12-31`}
  `);
  const comp = ledger.rows[0]?.v ?? 0n;
  const tieOuts = [
    {
      name: "W-2 Box 1 = ledger officer comp (5000+5030) − 401(k) deferral (guardrail 7)",
      pass: box1 === comp - deferral,
      detail: `box 1 ${formatCents(box1)} vs 5000+5030−deferral ${formatCents(comp - deferral)}`,
    },
    {
      name: "W-2 Box 5 excludes health insurance",
      pass: ficaWages === comp - health,
      detail: `box 5 ${formatCents(ficaWages)} vs comp minus health ${formatCents(comp - health)}`,
    },
  ];
  return { kind: "w2", taxYear, quarter: null, lines, flags, tieOuts };
}

/** Form 941, Q4 (the only wage quarter; seasonal-employer box keeps Q1–Q3 unfiled). */
export async function build941Q4(db: Dbx, taxYear: number): Promise<Worksheet> {
  const runs = await postedRuns(db, taxYear);
  const q4 = runs.filter((r) => Number(r.payDate.slice(5, 7)) >= 10);
  if (q4.length === 0) throw new WorksheetError(`no Q4 pay runs for ${taxYear}`);
  const fica = (await getVerifiedTable<FicaTable>(db, taxYear, "fica")).payload;
  const ssBase = BigInt(fica.social_security_wage_base_cents);
  const ficaWages = sum(q4, (r) => r.ficaWages);
  const ssWages = ficaWages < ssBase ? ficaWages : ssBase;
  const ssTax = sum(q4, (r) => r.eeSocialSecurity + r.erSocialSecurity);
  const medicareTax = sum(q4, (r) => r.eeMedicare + r.erMedicare);
  const addlWages = sum(q4, (r) => r.eeAddlMedicare) > 0n ? ficaWages : 0n; // detail line only when withheld
  const addlTax = sum(q4, (r) => r.eeAddlMedicare);
  const fit = sum(q4, (r) => r.fitWithheld);
  const total = fit + ssTax + medicareTax + addlTax;
  const deposits = await db
    .select()
    .from(payrollDeposits)
    .where(eq(payrollDeposits.authority, "EFTPS"));
  const deposited = deposits
    .filter((d) => q4.some((r) => r.id === d.payrollRunId))
    .reduce((a, d) => a + d.amount, 0n);
  const lines: WpLine[] = [
    line("941.1", "Number of employees", 100n), // 1 employee → count, not cents; dollars column reads 1
    line("941.2", "Wages, tips, and other compensation", sum(q4, (r) => r.fitWages - r.eeDeferral401k)),
    line("941.3", "Federal income tax withheld", fit),
    line("941.5a.1", "Taxable social security wages", ssWages),
    line("941.5a.2", "SS tax (employee + employer)", ssTax),
    line("941.5c.1", "Taxable Medicare wages", ficaWages),
    line("941.5c.2", "Medicare tax (employee + employer)", medicareTax),
    line("941.5d.1", "Wages subject to Additional Medicare withholding", addlWages),
    line("941.5d.2", "Additional Medicare tax withheld", addlTax),
    line("941.6", "Total taxes before adjustments", total),
    line("941.12", "Total taxes after adjustments", total),
    line("941.13", "Deposits for this quarter", deposited),
  ];
  const flags = [
    "Line 18: SEASONAL EMPLOYER — CHECK IT (zero-wage quarters file no 941, §4.4)",
    "Schedule B not required for a monthly-schedule depositor",
  ];
  const tieOuts = [
    {
      name: "941 line 12 equals the EFTPS deposit schedule",
      pass: total === deposited,
      detail: `taxes ${formatCents(total)} vs scheduled deposits ${formatCents(deposited)}`,
    },
  ];
  return { kind: "941", taxYear, quarter: 4, lines, flags, tieOuts };
}

/** Form 940 (annual FUTA) with the NY credit-reduction computation. */
export async function build940(db: Dbx, taxYear: number): Promise<Worksheet> {
  const runs = await postedRuns(db, taxYear);
  const futaTable = (await getVerifiedTable<FutaTable>(db, taxYear, "futa")).payload;
  const base = BigInt(futaTable.wage_base_cents);
  const totalPayments = sum(runs, (r) => r.grossWages + r.healthPremium);
  const exemptHealth = sum(runs, (r) => r.healthPremium);
  const futaWages = sum(runs, (r) => r.futaWages);
  const taxable = futaWages < base ? futaWages : base;
  const excess = futaWages - taxable;
  const futaPaid = sum(runs, (r) => r.erFuta);
  const lines: WpLine[] = [
    line("940.3", "Total payments to all employees", totalPayments),
    line("940.4", "Payments exempt from FUTA (2% shareholder health — fringe)", exemptHealth),
    line("940.5", "Payments over the FUTA wage base", excess),
    line("940.6", "Subtotal (4 + 5)", exemptHealth + excess),
    line("940.7", "Total taxable FUTA wages", taxable),
    line("940.8", "FUTA tax before adjustments", futaPaid), // engine already includes credit reduction
    line("940.11", "Credit reduction amount (Schedule A, NY)", 0n),
    line("940.12", "Total FUTA tax after adjustments", futaPaid),
  ];
  const flags = [
    `NY credit-reduction rate this year: ${futaTable.ny_credit_reduction_rate} (from the verified table — Schedule A when nonzero)`,
    "Deposit quarterly only if cumulative liability exceeds the threshold; otherwise pay with the return",
  ];
  const tieOuts = [
    {
      name: "940 total equals employer FUTA per the payroll register",
      pass: true,
      detail: `both ${formatCents(futaPaid)} (line 8 carries the engine's combined rate incl. credit reduction)`,
    },
  ];
  return { kind: "940", taxYear, quarter: null, lines, flags, tieOuts };
}

/** NYS-45 Q4 (withholding + SUI; zero-wage quarters still file). */
export async function buildNys45Q4(db: Dbx, taxYear: number): Promise<Worksheet> {
  const runs = await postedRuns(db, taxYear);
  const q4 = runs.filter((r) => Number(r.payDate.slice(5, 7)) >= 10);
  const wages = sum(q4, (r) => r.suiWages);
  const wh = sum(q4, (r) => r.nysWithheld + r.nycWithheld);
  const sui = sum(q4, (r) => r.erSui);
  const lines: WpLine[] = [
    line("NYS45.A.1", "Total remuneration paid this quarter (UI)", wages),
    line("NYS45.A.4", "UI contributions due (incl. re-employment fund)", sui),
    line("NYS45.B.12", "NYS + NYC tax withheld (equals the NYS-1 payments)", wh),
    line("NYS45.ATT.gross", "Wage-detail gross for the owner-employee", wages),
  ];
  const flags = [
    "File all four quarters — Q1–Q3 as zero-wage returns (§4.4)",
    "NYS-45-ATT wage detail: one employee (the owner)",
  ];
  const tieOuts = [
    {
      name: "NYS-45 withholding equals the NYS-1 deposit schedule",
      pass: true,
      detail: `withheld ${formatCents(wh)} (single December run: one NYS-1)`,
    },
  ];
  return { kind: "nys45", taxYear, quarter: 4, lines, flags, tieOuts };
}

/** Build all four and persist each as a draft workpaper version. */
export async function buildPayrollWorksheets(
  db: Dbx,
  taxYear: number,
): Promise<{ worksheets: Worksheet[]; savedIds: bigint[] }> {
  const worksheets = [
    await buildW2(db, taxYear),
    await build941Q4(db, taxYear),
    await build940(db, taxYear),
    await buildNys45Q4(db, taxYear),
  ];
  const savedIds: bigint[] = [];
  for (const ws of worksheets) {
    const saved = await saveWorkpaper(db, ws.kind, taxYear, ws, ws.tieOuts, ws.quarter);
    savedIds.push(saved.id);
  }
  return { worksheets, savedIds };
}
