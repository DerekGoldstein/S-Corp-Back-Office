/**
 * Monthly reconciliation (§4.2): ledger cash vs. statement closing balance,
 * with every open item listed. Completing requires a zero difference —
 * "reconciled to the cent" is the acceptance bar, and period locks depend
 * on it.
 */
import { and, eq, lte, sql as dsql } from "drizzle-orm";
import type { Dbx } from "../db/client";
import {
  accounts as accountsTable,
  auditLog,
  bankAccounts,
  bankTransactions,
  reconciliations,
} from "../db/schema";
import type { Cents } from "../lib/cents";

export class ReconcileError extends Error {}

export type OpenItem = {
  txnId: bigint;
  txnDate: string;
  amount: Cents;
  description: string;
  status: string;
};

export type ReconciliationComputation = {
  reconciliationId: number;
  bankAccountId: number;
  statementDate: string;
  statementBalance: Cents;
  ledgerBalance: Cents;
  difference: Cents;
  /** Unposted (unreviewed/proposed/flagged) txns dated on or before the statement date. */
  openItems: OpenItem[];
  /** difference minus the open items' total — nonzero means missing imports or foreign entries. */
  unexplained: Cents;
};

export async function createReconciliation(
  db: Dbx,
  bankAccountId: number,
  statementDate: string,
  statementBalance: Cents,
): Promise<number> {
  const [row] = await db
    .insert(reconciliations)
    .values({ bankAccountId, statementDate, statementBalance })
    .returning({ id: reconciliations.id });
  return row!.id;
}

export async function computeReconciliation(
  db: Dbx,
  reconciliationId: number,
): Promise<ReconciliationComputation> {
  const [rec] = await db
    .select()
    .from(reconciliations)
    .where(eq(reconciliations.id, reconciliationId));
  if (!rec) throw new ReconcileError(`reconciliation ${reconciliationId} not found`);
  const [account] = await db
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.id, rec.bankAccountId));
  const ledger = await db.execute<{ balance: bigint | null }>(dsql`
    SELECT (COALESCE(sum(l.debit),0) - COALESCE(sum(l.credit),0))::bigint AS balance
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE l.account_id = ${account!.ledgerAccountId} AND e.entry_date <= ${rec.statementDate}
  `);
  const ledgerBalance = ledger.rows[0]?.balance ?? 0n;
  const open = await db
    .select()
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.bankAccountId, rec.bankAccountId),
        lte(bankTransactions.txnDate, rec.statementDate),
      ),
    );
  const openItems: OpenItem[] = open
    .filter((t) => t.status === "unreviewed" || t.status === "proposed" || t.status === "flagged")
    .map((t) => ({
      txnId: t.id,
      txnDate: t.txnDate,
      amount: t.amount,
      description: t.descriptionRaw,
      status: t.status,
    }));
  const difference = rec.statementBalance - ledgerBalance;
  const openTotal = openItems.reduce((a, b) => a + b.amount, 0n);
  return {
    reconciliationId,
    bankAccountId: rec.bankAccountId,
    statementDate: rec.statementDate,
    statementBalance: rec.statementBalance,
    ledgerBalance,
    difference,
    openItems,
    unexplained: difference - openTotal,
  };
}

/**
 * Complete = statement equals ledger exactly and nothing is left unposted
 * for the month. Posted/transfer txns through the date get stamped with the
 * reconciliation for the CPA package's lineage.
 */
export async function completeReconciliation(db: Dbx, reconciliationId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [rec] = await tx
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.id, reconciliationId))
      .for("update");
    if (!rec) throw new ReconcileError(`reconciliation ${reconciliationId} not found`);
    if (rec.status === "completed") {
      throw new ReconcileError(`reconciliation ${reconciliationId} is already completed`);
    }
    const c = await computeReconciliation(tx, reconciliationId);
    if (c.openItems.length > 0) {
      throw new ReconcileError(
        `cannot complete: ${c.openItems.length} transactions through ${c.statementDate} are still unposted`,
      );
    }
    if (c.difference !== 0n) {
      throw new ReconcileError(
        `cannot complete: statement ${c.statementBalance} != ledger ${c.ledgerBalance} ` +
          `(difference ${c.difference} cents) — find the missing import or bank error`,
      );
    }
    await tx
      .update(reconciliations)
      .set({
        status: "completed",
        ledgerBalance: c.ledgerBalance,
        difference: 0n,
        snapshot: {
          statementBalance: c.statementBalance.toString(),
          ledgerBalance: c.ledgerBalance.toString(),
          completed: true,
        },
        completedAt: new Date(),
      })
      .where(eq(reconciliations.id, reconciliationId));
    await tx.execute(dsql`
      UPDATE bank_transactions
      SET reconciliation_id = ${reconciliationId}
      WHERE bank_account_id = ${c.bankAccountId}
        AND txn_date <= ${c.statementDate}
        AND reconciliation_id IS NULL
        AND status IN ('posted','transfer')
    `);
    await tx.insert(auditLog).values({
      actor: "owner",
      action: "complete_reconciliation",
      objectType: "reconciliation",
      objectId: String(reconciliationId),
      detail: {
        statementDate: c.statementDate,
        balance: c.statementBalance.toString(),
      },
    });
  });
}

/**
 * True when every month from the account's first activity through
 * `year-month` has a completed reconciliation. An account with no
 * transactions has nothing to reconcile.
 */
export async function isReconciledThrough(
  db: Dbx,
  bankAccountId: number,
  year: number,
  month: number,
): Promise<boolean> {
  const first = await db.execute<{ min: string | null }>(dsql`
    SELECT min(txn_date)::text AS min FROM bank_transactions
    WHERE bank_account_id = ${bankAccountId}
  `);
  const firstDate = first.rows[0]?.min ?? null;
  if (firstDate === null) return true;
  const rows = await db
    .select()
    .from(reconciliations)
    .where(
      and(eq(reconciliations.bankAccountId, bankAccountId), eq(reconciliations.status, "completed")),
    );
  const completed = new Set(rows.map((r) => r.statementDate.slice(0, 7)));
  let y = Number(firstDate.slice(0, 4));
  let m = Number(firstDate.slice(5, 7));
  while (y < year || (y === year && m <= month)) {
    if (!completed.has(`${y}-${String(m).padStart(2, "0")}`)) return false;
    m++;
    if (m === 13) {
      m = 1;
      y++;
    }
  }
  return true;
}
