/**
 * Form 7203 worksheet (§4.6): the OWNER's stock basis in the S-corp,
 * required on the 1040 in any year with distributions. §1367 ordering:
 * basis rises with contributions and every Schedule K income item
 * (tax-exempt included), then falls by distributions (excess over basis is
 * capital gain, basis floors at zero), then nondeductibles, then losses
 * (excess suspends and carries). Ties to M-2 and to 3200 distributions
 * (§4.11). Debt basis is out of scope until a shareholder loan exists.
 */
import { and, eq, sql as dsql } from "drizzle-orm";
import type { Dbx } from "../db/client";
import { shareholderBasisYears } from "../db/schema";
import type { Cents } from "../lib/cents";
import { formatCents } from "../lib/cents";
import { buildF1120s, saveWorkpaper, type WpLine } from "./f1120s";

export class F7203Error extends Error {}

const max0 = (x: Cents): Cents => (x > 0n ? x : 0n);
const minC = (a: Cents, b: Cents): Cents => (a < b ? a : b);

export type F7203Result = {
  taxYear: number;
  row: typeof shareholderBasisYears.$inferSelect;
  tieOuts: Array<{ name: string; pass: boolean; detail: string }>;
};

export async function buildF7203(db: Dbx, taxYear: number): Promise<F7203Result> {
  const existing = await db
    .select()
    .from(shareholderBasisYears)
    .where(eq(shareholderBasisYears.taxYear, taxYear));
  if (existing.length > 0) {
    throw new F7203Error(`${taxYear} stock basis already rolled — delete/recompute deliberately`);
  }
  const [prior] = await db
    .select()
    .from(shareholderBasisYears)
    .where(eq(shareholderBasisYears.taxYear, taxYear - 1));
  const anyPrior = await db.select().from(shareholderBasisYears);
  if (!prior && anyPrior.length > 0) {
    throw new F7203Error(`roll years in order: ${taxYear - 1} is missing`);
  }
  const beginning = prior?.endingBasis ?? 0n;
  const priorSuspended = prior?.suspendedLosses ?? 0n;

  // paid-in capital contributed during the year (3000 credits net of debits)
  const contrib = await db.execute<{ v: bigint | null }>(dsql`
    SELECT (COALESCE(sum(l.credit),0)-COALESCE(sum(l.debit),0))::bigint AS v
    FROM journal_lines l JOIN accounts a ON a.id=l.account_id
    JOIN journal_entries e ON e.id=l.entry_id
    WHERE a.code = '3000'
      AND e.entry_date BETWEEN ${`${taxYear}-01-01`} AND ${`${taxYear}-12-31`}
  `);
  const contributions = max0(contrib.rows[0]?.v ?? 0n);

  const wp = await buildF1120s(db, taxYear);
  const k = (code: string): Cents => wp.scheduleK.find((l) => l.code === code)?.cents ?? 0n;
  const incomeItems = k("K.18"); // ordinary + separately stated income net of deductions...
  // K.18 already nets §179/charitable; split: treat positive K.18 as income,
  // negative as loss, and carry K.16c nondeductibles separately.
  const income = max0(incomeItems);
  const currentLoss = max0(-incomeItems);
  const taxExempt = k("K.16a");
  const distributions = k("K.16d");
  const nondeductibles = k("K.16c");
  const lossesWithCarry = currentLoss + priorSuspended;

  let remaining = beginning + contributions + income + taxExempt;
  const distributionsApplied = minC(distributions, remaining);
  const excessDistributions = distributions - distributionsApplied;
  remaining -= distributionsApplied;
  const nondeductiblesApplied = minC(nondeductibles, remaining);
  remaining -= nondeductiblesApplied;
  const lossesAllowed = minC(lossesWithCarry, remaining);
  const suspended = lossesWithCarry - lossesAllowed;
  const ending = remaining - lossesAllowed;

  const [row] = await db
    .insert(shareholderBasisYears)
    .values({
      taxYear,
      beginningBasis: beginning,
      contributions,
      incomeItems: income,
      taxExemptIncome: taxExempt,
      distributionsApplied,
      excessDistributions,
      nondeductiblesApplied,
      lossesAllowed,
      suspendedLosses: suspended,
      endingBasis: ending,
      trace: {
        ordering:
          "1367: +contributions +K income +tax-exempt, -distributions (excess = capital gain), -nondeductibles, -losses (excess suspended)",
        beginning: formatCents(beginning),
        priorSuspended: formatCents(priorSuspended),
        income: formatCents(income),
        currentLoss: formatCents(currentLoss),
        taxExempt: formatCents(taxExempt),
        distributions: formatCents(distributions),
        excessDistributions: formatCents(excessDistributions),
        ending: formatCents(ending),
      },
    })
    .returning();

  // §4.11: 7203 reconciles to M-2 and to distributions (3200)
  const m2aaa = wp.m2.aaa.find((l) => l.code === "M2.a.8")?.cents ?? 0n;
  const m2oaa = wp.m2.oaa.find((l) => l.code === "M2.d.8")?.cents ?? 0n;
  const paidIn = await db.execute<{ v: bigint | null }>(dsql`
    SELECT (COALESCE(sum(l.credit),0)-COALESCE(sum(l.debit),0))::bigint AS v
    FROM journal_lines l JOIN accounts a ON a.id=l.account_id
    JOIN journal_entries e ON e.id=l.entry_id
    WHERE a.code = '3000' AND e.entry_date <= ${`${taxYear}-12-31`}
  `);
  const equity = (paidIn.rows[0]?.v ?? 0n) + m2aaa + m2oaa;
  // §1367 identity: basis exceeds book equity by exactly the cumulative
  // distributions-in-excess-of-basis plus the outstanding suspended losses
  // (books take full losses and full distributions; basis cannot go below 0).
  const allRows = await db.select().from(shareholderBasisYears);
  const cumExcess = allRows
    .filter((r) => r.taxYear <= taxYear)
    .reduce((a, r) => a + r.excessDistributions, 0n);
  const tieOuts = [
    {
      name: "7203 distributions equal Schedule K.16d / ledger 3200",
      pass: distributionsApplied + excessDistributions === distributions,
      detail: `7203 ${formatCents(distributionsApplied + excessDistributions)} vs K.16d ${formatCents(distributions)}`,
    },
    {
      name: "7203 ending basis = equity (paid-in + AAA + OAA) + cumulative excess distributions + suspended losses",
      pass: ending === equity + cumExcess + suspended,
      detail:
        `basis ${formatCents(ending)} vs equity ${formatCents(equity)} + excess ` +
        `${formatCents(cumExcess)} + suspended ${formatCents(suspended)}`,
    },
  ];
  const lines: WpLine[] = [
    { code: "7203.1", label: "Stock basis at beginning of year", cents: beginning, dollars: Number(beginning / 100n), accounts: [] },
    { code: "7203.2", label: "Basis from capital contributions", cents: contributions, dollars: Number(contributions / 100n), accounts: ["3000"] },
    { code: "7203.3", label: "Income items (Schedule K) + tax-exempt", cents: income + taxExempt, dollars: Number((income + taxExempt) / 100n), accounts: [] },
    { code: "7203.6", label: "Distributions (excess is capital gain)", cents: distributions, dollars: Number(distributions / 100n), accounts: ["3200"] },
    { code: "7203.8", label: "Nondeductible expenses", cents: nondeductiblesApplied, dollars: Number(nondeductiblesApplied / 100n), accounts: [] },
    { code: "7203.11", label: "Allowable losses", cents: lossesAllowed, dollars: Number(lossesAllowed / 100n), accounts: [] },
    { code: "7203.15", label: "Stock basis at end of year", cents: ending, dollars: Number(ending / 100n), accounts: [] },
  ];
  await saveWorkpaper(db, "f7203", taxYear, { taxYear, lines, trace: row!.trace }, tieOuts);
  return { taxYear, row: row!, tieOuts };
}
