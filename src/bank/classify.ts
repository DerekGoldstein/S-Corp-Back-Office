/**
 * Classification = turning a bank transaction into a journal entry (§4.2).
 * Nothing posts without the owner's confirmation or an owner-flagged
 * auto_post rule, and BOTH paths run this same function — the guards here
 * (investee wires, owner tags, liability clearing) plus the posting-service
 * pipeline beneath are what make guardrails 2/3/6 real.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq, sql as dsql } from "drizzle-orm";
import type { Dbx } from "../db/client";
import {
  accounts as accountsTable,
  auditLog,
  bankAccounts,
  bankTransactions,
  classificationRules,
  investees as investeesTable,
  journalEntries,
  journalLines,
} from "../db/schema";
import { postEntry, PostingError } from "../ledger/posting";
import { documentsFor } from "../vault/store";

export class ClassifyError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "state"
      | "owner_tag_required"
      | "investee_wire"
      | "clearing_pattern"
      | "transfer_target"
      | "tag_target"
      | "reimbursement_unapproved"
      | "match_entry",
  ) {
    super(message);
    this.name = "ClassifyError";
  }
}

export type OwnerTag = "payroll_net_pay" | "distribution" | "reimbursement";

export type ClassifyDecision = {
  targetAccountCode?: string;
  memo?: string;
  investeeId?: number;
  ownerPaymentTag?: OwnerTag;
  documentIds?: bigint[];
  ruleId?: number;
  /** payroll_net_pay: link to the already-posted payroll entry instead of creating one. */
  matchEntryId?: bigint;
  auto?: boolean;
};

type ClearingPattern = { name: string; regex: string; allowedCodes: string[] };

let clearingCache: Array<ClearingPattern & { re: RegExp }> | undefined;

export function clearingPatterns(): Array<ClearingPattern & { re: RegExp }> {
  if (!clearingCache) {
    const raw = JSON.parse(
      readFileSync(resolve(process.cwd(), "data/clearing-patterns.json"), "utf8"),
    ) as { patterns: ClearingPattern[] };
    clearingCache = raw.patterns.map((p) => ({ ...p, re: new RegExp(p.regex, "i") }));
  }
  return clearingCache;
}

export async function classifyTransaction(
  db: Dbx,
  txnId: bigint,
  decision: ClassifyDecision,
): Promise<{ entryId: bigint }> {
  return await db.transaction(async (tx) => {
    const txnRows = await tx
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, txnId))
      .for("update");
    const txn = txnRows[0];
    if (!txn) throw new ClassifyError(`bank transaction ${txnId} not found`, "not_found");
    if (txn.status !== "unreviewed" && txn.status !== "proposed") {
      throw new ClassifyError(
        `transaction ${txnId} is ${txn.status}; only unreviewed/proposed transactions can be classified (post a reversal to correct)`,
        "state",
      );
    }
    const [bankAccount] = await tx
      .select()
      .from(bankAccounts)
      .where(eq(bankAccounts.id, txn.bankAccountId));
    const [cashAccount] = await tx
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.id, bankAccount!.ledgerAccountId));
    const cashCode = cashAccount!.code;
    const outflow = txn.amount < 0n;
    const absAmount = outflow ? -txn.amount : txn.amount;

    // --- owner-payment tag (guardrail 3): refuse untagged outflows to owner
    if (txn.isOwnerPayee && outflow && decision.ownerPaymentTag === undefined) {
      throw new ClassifyError(
        `this payment goes to the owner — tag it as payroll net pay, a shareholder distribution, or an accountable-plan reimbursement before posting`,
        "owner_tag_required",
      );
    }

    // --- payroll net pay: match the already-posted payroll entry, never re-expense
    if (decision.ownerPaymentTag === "payroll_net_pay") {
      return await matchNetPay(tx, txn, cashAccount!.id, absAmount, decision);
    }

    if (decision.targetAccountCode === undefined) {
      throw new ClassifyError("a target account is required", "tag_target");
    }
    const [target] = await tx
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.code, decision.targetAccountCode));
    if (!target) {
      throw new ClassifyError(`unknown account ${decision.targetAccountCode}`, "not_found");
    }

    // --- transfers are never income/expense: block cash-account targets
    const ledgerCashIds = await tx
      .select({ id: bankAccounts.ledgerAccountId })
      .from(bankAccounts);
    if (ledgerCashIds.some((r) => r.id === target.id)) {
      throw new ClassifyError(
        `account ${target.code} is another bank account's cash — use transfer matching, not classification`,
        "transfer_target",
      );
    }

    // --- investee wires are never revenue (guardrail 3)
    let investeeDim = decision.investeeId;
    if (!outflow) {
      const invRows = await tx.select().from(investeesTable);
      const wireFrom = invRows.find(
        (i) =>
          i.counterpartyRegex !== null && new RegExp(i.counterpartyRegex, "i").test(txn.descriptionNorm),
      );
      if (wireFrom) {
        if (target.investeeId !== wireFrom.id) {
          const [correct] = await tx
            .select({ code: accountsTable.code })
            .from(accountsTable)
            .where(eq(accountsTable.investeeId, wireFrom.id));
          throw new ClassifyError(
            `this wire is from investee ${wireFrom.name}: it reduces the investment asset ` +
              `(credit ${correct?.code ?? "its 15xx account"}) and is NEVER revenue — ` +
              `income is recognized only from the confirmed K-1`,
            "investee_wire",
          );
        }
        investeeDim = wireFrom.id;
      }
    }
    if (target.investeeId !== null) investeeDim = target.investeeId;

    // --- EFTPS/NYS/SUI/401(k) debits clear liabilities, never expense
    if (outflow) {
      const hit = clearingPatterns().find((p) => p.re.test(txn.descriptionNorm));
      if (hit && !hit.allowedCodes.includes(target.code)) {
        throw new ClassifyError(
          `"${txn.descriptionRaw}" matches ${hit.name}: it must clear one of ` +
            `${hit.allowedCodes.join("/")} (a payroll/tax liability), never ${target.code}`,
          "clearing_pattern",
        );
      }
    }

    // --- owner tag ↔ target consistency
    if (decision.ownerPaymentTag === "distribution" && target.code !== "3200") {
      throw new ClassifyError(
        `a shareholder distribution posts to 3200, not ${target.code}`,
        "tag_target",
      );
    }
    if (decision.ownerPaymentTag === "reimbursement") {
      if (target.code !== "2190") {
        throw new ClassifyError(
          `an accountable-plan reimbursement payment clears 2190, not ${target.code}`,
          "tag_target",
        );
      }
      await assertReimbursementCovered(tx, absAmount);
    }

    // documents already attached to the bank transaction satisfy the guard too
    const attached = await documentsFor(tx, "bank_transaction", txnId);
    const documentIds = [
      ...new Set<bigint>([...(decision.documentIds ?? []), ...attached.map((d) => d.id)]),
    ];

    const memo = decision.memo?.trim() || txn.descriptionRaw;
    const draft = {
      entryDate: txn.txnDate,
      memo,
      sourceModule: "bank" as const,
      sourceId: txnId,
      documentIds,
      lines: outflow
        ? [
            {
              accountCode: target.code,
              debit: absAmount,
              investeeId: investeeDim,
              bankTransactionId: txnId,
            },
            { accountCode: cashCode, credit: absAmount, bankTransactionId: txnId },
          ]
        : [
            { accountCode: cashCode, debit: absAmount, bankTransactionId: txnId },
            {
              accountCode: target.code,
              credit: absAmount,
              investeeId: investeeDim,
              bankTransactionId: txnId,
            },
          ],
    };
    const { entryId } = await postEntry(tx, draft);

    await tx
      .update(bankTransactions)
      .set({
        status: "posted",
        journalEntryId: entryId,
        ownerPaymentTag: decision.ownerPaymentTag ?? null,
        matchedRuleId: decision.ruleId ?? txn.matchedRuleId,
        proposal: null,
      })
      .where(eq(bankTransactions.id, txnId));
    if (decision.ownerPaymentTag === "reimbursement") {
      const { markSubmissionsPaid } = await import("../plan/reimbursements");
      await markSubmissionsPaid(tx, txnId, absAmount);
    }
    if (decision.ruleId !== undefined) {
      await tx
        .update(classificationRules)
        .set({ timesApplied: dsql`times_applied + 1` })
        .where(eq(classificationRules.id, decision.ruleId));
    }
    await tx.insert(auditLog).values({
      actor: decision.auto ? "rules_engine" : "owner",
      action: "classify",
      objectType: "bank_transaction",
      objectId: txnId.toString(),
      detail: {
        target: target.code,
        memo,
        auto: decision.auto ?? false,
        ruleId: decision.ruleId ?? null,
        ownerPaymentTag: decision.ownerPaymentTag ?? null,
        entryId: entryId.toString(),
      },
    });
    return { entryId };
  });
}

/** Net pay was already credited to cash by the payroll entry: link, don't re-post. */
async function matchNetPay(
  tx: Dbx,
  txn: typeof bankTransactions.$inferSelect,
  cashAccountId: number,
  absAmount: bigint,
  decision: ClassifyDecision,
): Promise<{ entryId: bigint }> {
  if (decision.matchEntryId === undefined) {
    throw new ClassifyError(
      "net pay clears the payroll entry that already credited cash — pick the payroll journal entry to match (matchEntryId)",
      "match_entry",
    );
  }
  const [entry] = await tx
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.id, decision.matchEntryId));
  if (!entry || entry.sourceModule !== "payroll") {
    throw new ClassifyError(
      `entry ${decision.matchEntryId} is not a payroll entry`,
      "match_entry",
    );
  }
  const lines = await tx
    .select()
    .from(journalLines)
    .where(eq(journalLines.entryId, decision.matchEntryId));
  const cashCredit = lines.find((l) => l.accountId === cashAccountId && l.credit === absAmount);
  if (!cashCredit) {
    throw new ClassifyError(
      `payroll entry ${decision.matchEntryId} has no ${absAmount}-cent cash credit to match this net-pay debit`,
      "match_entry",
    );
  }
  await tx
    .update(bankTransactions)
    .set({
      status: "posted",
      journalEntryId: decision.matchEntryId,
      ownerPaymentTag: "payroll_net_pay",
      proposal: null,
    })
    .where(eq(bankTransactions.id, txn.id));
  await tx.insert(auditLog).values({
    actor: decision.auto ? "rules_engine" : "owner",
    action: "classify_match_net_pay",
    objectType: "bank_transaction",
    objectId: txn.id.toString(),
    detail: { entryId: decision.matchEntryId.toString() },
  });
  return { entryId: decision.matchEntryId };
}

/** Guardrail 6: a reimbursement payment must be covered by approved submissions (2190). */
async function assertReimbursementCovered(tx: Dbx, absAmount: bigint): Promise<void> {
  const result = await tx.execute<{ balance: bigint | null }>(dsql`
    SELECT (COALESCE(sum(l.credit),0) - COALESCE(sum(l.debit),0))::bigint AS balance
    FROM journal_lines l
    JOIN accounts a ON a.id = l.account_id
    WHERE a.code = '2190'
  `);
  const balance = result.rows[0]?.balance ?? 0n;
  if (balance < absAmount) {
    throw new ClassifyError(
      `no approved accountable-plan submissions cover this payment: 2190 balance is ` +
        `${balance} cents but the payment is ${absAmount} cents — approve the submission ` +
        `(with its document) first (§4.8)`,
      "reimbursement_unapproved",
    );
  }
}

/** Zero-commingling (§8): personal transactions are flagged, never classified. */
export async function flagTransaction(db: Dbx, txnId: bigint, note: string): Promise<void> {
  if (note.trim() === "") throw new ClassifyError("a flag note is required", "state");
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, txnId))
      .for("update");
    const txn = rows[0];
    if (!txn) throw new ClassifyError(`bank transaction ${txnId} not found`, "not_found");
    if (txn.status !== "unreviewed" && txn.status !== "proposed") {
      throw new ClassifyError(`transaction is ${txn.status}; cannot flag`, "state");
    }
    await tx
      .update(bankTransactions)
      .set({ status: "flagged", flagNote: note, proposal: null })
      .where(eq(bankTransactions.id, txnId));
    await tx.insert(auditLog).values({
      actor: "owner",
      action: "flag_personal",
      objectType: "bank_transaction",
      objectId: txnId.toString(),
      detail: { note },
    });
  });
}
