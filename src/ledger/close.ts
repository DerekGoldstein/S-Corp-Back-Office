/**
 * Year-end close (§4.1, §6) — the embedded-logic version of what would
 * otherwise be manual year-end math (owner decision 2026-09-11):
 *
 *   1. Meals reclass: the disallowed 50% of every deductible_50pct account
 *      moves to 5900 (odd cent to the disallowed side), so each 1120-S line
 *      is one account-balance query with no report-time percentage math.
 *   2. Close every revenue/expense account's year activity to 3900.
 *   3. Split 3900: the m2_col='oaa' net (tax-exempt income less related
 *      nondeductibles) goes to 3110 OAA; the remainder to 3100 AAA.
 *   4. Close 3200 distributions into 3100.
 *   5. Lock the year's periods.
 *
 * The M-2 workpaper applies the statutory ordering (distributions can't take
 * AAA below zero on the form) — the ledger nets them, and reconciles.
 * reopenYear reverses the close entries and unlocks, fully audited.
 */
import { and, eq, gte, lte, sql as dsql } from "drizzle-orm";
import type { Dbx } from "../db/client";
import { auditLog, bankAccounts, bankTransactions, journalEntries } from "../db/schema";
import { splitHalf, type Cents } from "../lib/cents";
import { isReconciledThrough } from "../bank/reconcile";
import { postEntry, postReversal, type DraftLine } from "./posting";
import { lockPeriod, unlockPeriod } from "./periods";

export class CloseError extends Error {}

export type ClosePrecondition = { ok: boolean; issue: string };

export type CloseSummary = {
  taxYear: number;
  mealsReclassed: Cents;
  netIncome: Cents;
  oaaPortion: Cents;
  aaaPortion: Cents;
  distributionsClosed: Cents;
  entryIds: bigint[];
};

type YearBalance = {
  id: number;
  code: string;
  m2_col: "aaa" | "oaa" | null;
  tax_treatment: string;
  bal: bigint; // debit − credit over the year
};

async function yearBalances(db: Dbx, taxYear: number): Promise<YearBalance[]> {
  const r = await db.execute<YearBalance>(dsql`
    SELECT a.id, a.code, a.m2_col::text AS m2_col, a.tax_treatment::text AS tax_treatment,
           (COALESCE(sum(l.debit),0) - COALESCE(sum(l.credit),0))::bigint AS bal
    FROM accounts a
    JOIN journal_lines l ON l.account_id = a.id
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE a.type IN ('revenue','expense')
      AND e.entry_date BETWEEN ${`${taxYear}-01-01`} AND ${`${taxYear}-12-31`}
    GROUP BY a.id, a.code, a.m2_col, a.tax_treatment
    HAVING COALESCE(sum(l.debit),0) - COALESCE(sum(l.credit),0) <> 0
  `);
  return r.rows;
}

/** Close entries for the year that have NOT been reversed (reopen undoes a close). */
async function closeEntriesFor(db: Dbx, taxYear: number): Promise<Array<{ id: bigint }>> {
  const r = await db.execute<{ id: bigint }>(dsql`
    SELECT e.id FROM journal_entries e
    WHERE e.source_module = 'close'
      AND e.entry_date BETWEEN ${`${taxYear}-01-01`} AND ${`${taxYear}-12-31`}
      AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id)
    ORDER BY e.id
  `);
  return r.rows;
}

/** Everything that must be true before the year can close (brief §6). */
export async function closePreconditions(db: Dbx, taxYear: number): Promise<ClosePrecondition[]> {
  const issues: ClosePrecondition[] = [];
  const open = await db.execute<{ n: number }>(dsql`
    SELECT count(*)::int AS n FROM bank_transactions
    WHERE status IN ('unreviewed','proposed')
      AND txn_date BETWEEN ${`${taxYear}-01-01`} AND ${`${taxYear}-12-31`}
  `);
  if ((open.rows[0]?.n ?? 0) > 0) {
    issues.push({
      ok: false,
      issue: `${open.rows[0]!.n} bank transaction(s) in ${taxYear} still unposted — clear the queue`,
    });
  }
  const flagged = await db.execute<{ n: number }>(dsql`
    SELECT count(*)::int AS n FROM bank_transactions
    WHERE status = 'flagged'
      AND txn_date BETWEEN ${`${taxYear}-01-01`} AND ${`${taxYear}-12-31`}
  `);
  if ((flagged.rows[0]?.n ?? 0) > 0) {
    issues.push({
      ok: false,
      issue: `${flagged.rows[0]!.n} flagged personal transaction(s) unresolved — fix at the bank and re-import or note`,
    });
  }
  for (const b of await db.select().from(bankAccounts)) {
    if (!b.active) continue;
    if (!(await isReconciledThrough(db, b.id, taxYear, 12))) {
      issues.push({
        ok: false,
        issue: `${b.name} is not reconciled through ${taxYear}-12 — complete monthly reconciliations`,
      });
    }
  }
  const already = await closeEntriesFor(db, taxYear);
  if (already.length > 0) {
    issues.push({ ok: false, issue: `${taxYear} already has close entries — reopen first` });
  }
  return issues;
}

export async function closeYear(
  db: Dbx,
  taxYear: number,
  opts: { lockPeriods?: boolean } = {},
): Promise<CloseSummary> {
  const issues = await closePreconditions(db, taxYear);
  if (issues.length > 0) {
    throw new CloseError(`cannot close ${taxYear}:\n- ` + issues.map((i) => i.issue).join("\n- "));
  }
  const closeDate = `${taxYear}-12-31`;
  return await db.transaction(async (tx) => {
    const entryIds: bigint[] = [];

    // 1) meals 50% reclass (all deductible_50pct accounts)
    let mealsReclassed = 0n;
    const before = await yearBalances(tx, taxYear);
    const mealLines: DraftLine[] = [];
    for (const a of before) {
      if (a.tax_treatment !== "deductible_50pct" || a.bal <= 0n) continue;
      const { disallowed } = splitHalf(a.bal);
      if (disallowed === 0n) continue;
      mealsReclassed += disallowed;
      mealLines.push({ accountCode: a.code, credit: disallowed });
    }
    if (mealLines.length > 0) {
      const { entryId } = await postEntry(tx, {
        entryDate: closeDate,
        memo: `close ${taxYear}: 50% meals limitation reclass to nondeductible (odd cent disallowed)`,
        sourceModule: "close",
        lines: [{ accountCode: "5900", debit: mealsReclassed }, ...mealLines],
      });
      entryIds.push(entryId);
    }

    // 2) close all revenue/expense to 3900
    const balances = await yearBalances(tx, taxYear);
    let netIncome = 0n;
    let oaaPortion = 0n;
    const closeLines: DraftLine[] = [];
    for (const a of balances) {
      netIncome += -a.bal; // credit balances are income
      if (a.m2_col === "oaa") oaaPortion += -a.bal;
      closeLines.push(
        a.bal > 0n ? { accountCode: a.code, credit: a.bal } : { accountCode: a.code, debit: -a.bal },
      );
    }
    if (closeLines.length === 0) throw new CloseError(`${taxYear} has no activity to close`);
    closeLines.push(
      netIncome >= 0n
        ? { accountCode: "3900", credit: netIncome }
        : { accountCode: "3900", debit: -netIncome },
    );
    {
      const { entryId } = await postEntry(tx, {
        entryDate: closeDate,
        memo: `close ${taxYear}: revenue and expense to net income`,
        sourceModule: "close",
        lines: closeLines.filter((l) => (l.debit ?? 0n) !== 0n || (l.credit ?? 0n) !== 0n),
      });
      entryIds.push(entryId);
    }

    // 3) split 3900 → OAA (tax-exempt net) and AAA (remainder)
    if (oaaPortion !== 0n) {
      const { entryId } = await postEntry(tx, {
        entryDate: closeDate,
        memo: `close ${taxYear}: tax-exempt net to OAA`,
        sourceModule: "close",
        lines:
          oaaPortion > 0n
            ? [
                { accountCode: "3900", debit: oaaPortion },
                { accountCode: "3110", credit: oaaPortion },
              ]
            : [
                { accountCode: "3110", debit: -oaaPortion },
                { accountCode: "3900", credit: -oaaPortion },
              ],
      });
      entryIds.push(entryId);
    }
    const aaaPortion = netIncome - oaaPortion;
    if (aaaPortion !== 0n) {
      const { entryId } = await postEntry(tx, {
        entryDate: closeDate,
        memo: `close ${taxYear}: net income to AAA`,
        sourceModule: "close",
        lines:
          aaaPortion > 0n
            ? [
                { accountCode: "3900", debit: aaaPortion },
                { accountCode: "3100", credit: aaaPortion },
              ]
            : [
                { accountCode: "3100", debit: -aaaPortion },
                { accountCode: "3900", credit: -aaaPortion },
              ],
      });
      entryIds.push(entryId);
    }

    // 4) distributions → AAA
    const dist = await tx.execute<{ bal: bigint }>(dsql`
      SELECT (COALESCE(sum(l.debit),0) - COALESCE(sum(l.credit),0))::bigint AS bal
      FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE a.code = '3200'
    `);
    const distributionsClosed = dist.rows[0]?.bal ?? 0n;
    if (distributionsClosed !== 0n) {
      const { entryId } = await postEntry(tx, {
        entryDate: closeDate,
        memo: `close ${taxYear}: shareholder distributions to AAA`,
        sourceModule: "close",
        lines:
          distributionsClosed > 0n
            ? [
                { accountCode: "3100", debit: distributionsClosed },
                { accountCode: "3200", credit: distributionsClosed },
              ]
            : [
                { accountCode: "3200", debit: -distributionsClosed },
                { accountCode: "3100", credit: -distributionsClosed },
              ],
      });
      entryIds.push(entryId);
    }

    // 5) lock the year
    if (opts.lockPeriods !== false) {
      for (let m = 1; m <= 12; m++) await lockPeriod(tx, taxYear, m);
    }

    const summary: CloseSummary = {
      taxYear,
      mealsReclassed,
      netIncome,
      oaaPortion,
      aaaPortion,
      distributionsClosed,
      entryIds,
    };
    await tx.insert(auditLog).values({
      actor: "owner",
      action: "close_year",
      objectType: "tax_year",
      objectId: String(taxYear),
      detail: {
        mealsReclassed: mealsReclassed.toString(),
        netIncome: netIncome.toString(),
        oaaPortion: oaaPortion.toString(),
        aaaPortion: aaaPortion.toString(),
        distributionsClosed: distributionsClosed.toString(),
        entryIds: entryIds.map((e) => e.toString()),
      },
    });
    return summary;
  });
}

/** Undo a close: unlock the year, reverse its close entries (audited). */
export async function reopenYear(db: Dbx, taxYear: number, reason: string): Promise<void> {
  if (reason.trim() === "") throw new CloseError("reopening a year requires a reason");
  await db.transaction(async (tx) => {
    const entries = await closeEntriesFor(tx, taxYear);
    if (entries.length === 0) throw new CloseError(`${taxYear} has no close entries`);
    for (let m = 1; m <= 12; m++) await unlockPeriod(tx, taxYear, m, `reopen ${taxYear}: ${reason}`);
    for (const e of entries.sort((a, b) => Number(b.id - a.id))) {
      await postReversal(tx, e.id, `${taxYear}-12-31`, `reopen ${taxYear}: ${reason}`);
    }
    await tx.insert(auditLog).values({
      actor: "owner",
      action: "reopen_year",
      objectType: "tax_year",
      objectId: String(taxYear),
      detail: { reason, reversed: entries.length },
    });
  });
}
