/**
 * Transfers between the entity's own accounts are matched pairwise and
 * posted as one Dr/Cr-cash entry shared by both transactions (§4.2) —
 * never income or expense.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Dbx } from "../db/client";
import {
  accounts as accountsTable,
  auditLog,
  bankAccounts,
  bankTransactions,
} from "../db/schema";
import { postEntry, postReversal } from "../ledger/posting";

const DAY_MS = 86_400_000;

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;
}

export type TransferMatch = {
  outflowTxnId: bigint;
  inflowTxnId: bigint;
  entryId: bigint;
  amount: bigint;
};

/**
 * Greedy pairwise matching: unreviewed txns in different accounts with
 * offsetting amounts within `windowDays`. Earliest candidates pair first.
 */
export async function matchTransfers(db: Dbx, windowDays = 3): Promise<TransferMatch[]> {
  return await db.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.status, "unreviewed"))
      .for("update");
    candidates.sort((a, b) => a.txnDate.localeCompare(b.txnDate) || Number(a.id - b.id));
    const accountsById = new Map(
      (await tx.select().from(bankAccounts)).map((a) => [a.id, a]),
    );
    const cashCodeById = new Map(
      (
        await tx
          .select({ id: accountsTable.id, code: accountsTable.code })
          .from(accountsTable)
          .where(
            inArray(
              accountsTable.id,
              [...accountsById.values()].map((a) => a.ledgerAccountId),
            ),
          )
      ).map((r) => [r.id, r.code]),
    );
    const used = new Set<bigint>();
    const matches: TransferMatch[] = [];
    for (const out of candidates) {
      if (out.amount >= 0n || used.has(out.id)) continue;
      const inn = candidates.find(
        (c) =>
          !used.has(c.id) &&
          c.id !== out.id &&
          c.bankAccountId !== out.bankAccountId &&
          c.amount === -out.amount &&
          daysBetween(c.txnDate, out.txnDate) <= windowDays,
      );
      if (!inn) continue;
      used.add(out.id);
      used.add(inn.id);
      const srcAccount = accountsById.get(out.bankAccountId)!;
      const dstAccount = accountsById.get(inn.bankAccountId)!;
      const srcCode = cashCodeById.get(srcAccount.ledgerAccountId)!;
      const dstCode = cashCodeById.get(dstAccount.ledgerAccountId)!;
      const amount = -out.amount;
      const { entryId } = await postEntry(tx, {
        entryDate: out.txnDate,
        memo: `Transfer ${srcAccount.name} → ${dstAccount.name}`,
        sourceModule: "bank",
        sourceId: out.id,
        lines: [
          { accountCode: dstCode, debit: amount, bankTransactionId: inn.id },
          { accountCode: srcCode, credit: amount, bankTransactionId: out.id },
        ],
      });
      await tx
        .update(bankTransactions)
        .set({ status: "transfer", transferPeerId: inn.id, journalEntryId: entryId })
        .where(eq(bankTransactions.id, out.id));
      await tx
        .update(bankTransactions)
        .set({ status: "transfer", transferPeerId: out.id, journalEntryId: entryId })
        .where(eq(bankTransactions.id, inn.id));
      await tx.insert(auditLog).values({
        actor: "rules_engine",
        action: "match_transfer",
        objectType: "bank_transaction",
        objectId: out.id.toString(),
        detail: { peer: inn.id.toString(), entryId: entryId.toString(), amount: amount.toString() },
      });
      matches.push({ outflowTxnId: out.id, inflowTxnId: inn.id, entryId, amount });
    }
    return matches;
  });
}

/** Undo a bad automatic match back to unreviewed (reverses the entry). */
export async function unmatchTransfer(db: Dbx, txnId: bigint, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, txnId))
      .for("update");
    const txn = rows[0];
    if (!txn || txn.status !== "transfer" || txn.transferPeerId === null) {
      throw new Error(`transaction ${txnId} is not a matched transfer`);
    }
    await postReversal(tx, txn.journalEntryId!, txn.txnDate, `unmatch transfer: ${reason}`);
    for (const id of [txn.id, txn.transferPeerId]) {
      await tx
        .update(bankTransactions)
        .set({ status: "unreviewed", transferPeerId: null, journalEntryId: null })
        .where(eq(bankTransactions.id, id));
    }
    await tx.insert(auditLog).values({
      actor: "owner",
      action: "unmatch_transfer",
      objectType: "bank_transaction",
      objectId: txnId.toString(),
      detail: { reason },
    });
  });
}
