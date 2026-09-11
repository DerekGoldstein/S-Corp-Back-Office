/**
 * Rules engine (§4.2): description regex + amount range + account →
 * proposed classification; owner-flagged auto_post rules post through the
 * SAME classify pipeline (guards included). After two similar manual
 * classifications, a rule is suggested.
 */
import { and, eq, isNull, sql as dsql } from "drizzle-orm";
import type { Dbx } from "../db/client";
import {
  accounts as accountsTable,
  bankAccounts,
  bankTransactions,
  classificationRules,
  journalLines,
  ruleSuggestions,
  type ClassificationRule,
} from "../db/schema";
import { classifyTransaction, ClassifyError } from "./classify";
import { PostingError } from "../ledger/posting";

export type RunRulesResult = {
  proposed: number;
  autoPosted: number;
  autoFailed: Array<{ txnId: bigint; ruleId: number; reason: string }>;
};

function ruleMatches(
  rule: ClassificationRule,
  txn: { bankAccountId: number; amount: bigint; descriptionNorm: string },
): boolean {
  if (rule.bankAccountId !== null && rule.bankAccountId !== txn.bankAccountId) return false;
  if (rule.amountMin !== null && txn.amount < rule.amountMin) return false;
  if (rule.amountMax !== null && txn.amount > rule.amountMax) return false;
  try {
    return new RegExp(rule.descriptionRegex, "i").test(txn.descriptionNorm);
  } catch {
    return false;
  }
}

/** Run active rules over unreviewed transactions. */
export async function runRules(db: Dbx): Promise<RunRulesResult> {
  const rules = (
    await db.select().from(classificationRules).where(eq(classificationRules.active, true))
  ).sort((a, b) => a.priority - b.priority || a.id - b.id);
  const unreviewed = await db
    .select()
    .from(bankTransactions)
    .where(eq(bankTransactions.status, "unreviewed"));
  const accountCodeById = new Map(
    (await db.select({ id: accountsTable.id, code: accountsTable.code }).from(accountsTable)).map(
      (r) => [r.id, r.code],
    ),
  );
  const result: RunRulesResult = { proposed: 0, autoPosted: 0, autoFailed: [] };
  for (const txn of unreviewed) {
    const rule = rules.find((r) => ruleMatches(r, txn));
    if (!rule) continue;
    const targetCode = accountCodeById.get(rule.targetAccountId);
    if (targetCode === undefined) continue;
    const decision = {
      targetAccountCode: targetCode,
      memo: rule.memoTemplate ?? undefined,
      investeeId: rule.investeeId ?? undefined,
      ownerPaymentTag: rule.ownerPaymentTag ?? undefined,
      ruleId: rule.id,
      auto: true,
    };
    if (rule.autoPost) {
      try {
        await classifyTransaction(db, txn.id, decision);
        result.autoPosted++;
        continue;
      } catch (err) {
        if (err instanceof ClassifyError || err instanceof PostingError) {
          result.autoFailed.push({ txnId: txn.id, ruleId: rule.id, reason: err.message });
          // fall through: leave it proposed for the owner with the rule attached
        } else {
          throw err;
        }
      }
    }
    await db
      .update(bankTransactions)
      .set({
        status: "proposed",
        matchedRuleId: rule.id,
        proposal: {
          targetAccountId: rule.targetAccountId,
          memo: rule.memoTemplate ?? "",
          investeeId: rule.investeeId ?? undefined,
          ownerPaymentTag: rule.ownerPaymentTag ?? undefined,
          ruleId: rule.id,
        },
      })
      .where(eq(bankTransactions.id, txn.id));
    result.proposed++;
  }
  return result;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * §4.2: after the owner classifies two similar transactions by hand,
 * suggest a rule. "Similar" = same account, same normalized description,
 * same target account. Never suggests over an existing rule or suggestion.
 */
export async function generateRuleSuggestions(db: Dbx): Promise<number> {
  const manual = await db
    .select({
      txnId: bankTransactions.id,
      bankAccountId: bankTransactions.bankAccountId,
      descriptionNorm: bankTransactions.descriptionNorm,
      amount: bankTransactions.amount,
      journalEntryId: bankTransactions.journalEntryId,
      ownerPaymentTag: bankTransactions.ownerPaymentTag,
    })
    .from(bankTransactions)
    .where(
      and(eq(bankTransactions.status, "posted"), isNull(bankTransactions.matchedRuleId)),
    );
  if (manual.length === 0) return 0;
  const cashIds = new Set(
    (await db.select({ id: bankAccounts.ledgerAccountId }).from(bankAccounts)).map((r) => r.id),
  );
  const rules = await db.select().from(classificationRules);
  const groups = new Map<
    string,
    {
      bankAccountId: number;
      descriptionNorm: string;
      targetAccountId: number;
      ownerPaymentTag: "payroll_net_pay" | "distribution" | "reimbursement" | null;
      txnIds: bigint[];
      amounts: bigint[];
    }
  >();
  for (const txn of manual) {
    if (txn.journalEntryId === null) continue;
    const lines = await db
      .select({ accountId: journalLines.accountId })
      .from(journalLines)
      .where(eq(journalLines.entryId, txn.journalEntryId));
    const target = lines.find((l) => !cashIds.has(l.accountId));
    if (!target) continue;
    const key = `${txn.bankAccountId}|${txn.descriptionNorm}|${target.accountId}`;
    const g = groups.get(key) ?? {
      bankAccountId: txn.bankAccountId,
      descriptionNorm: txn.descriptionNorm,
      targetAccountId: target.accountId,
      ownerPaymentTag: txn.ownerPaymentTag,
      txnIds: [],
      amounts: [],
    };
    g.txnIds.push(txn.txnId);
    g.amounts.push(txn.amount);
    groups.set(key, g);
  }
  let created = 0;
  for (const g of groups.values()) {
    if (g.txnIds.length < 2) continue;
    const alreadyRuled = rules.some((r) =>
      ruleMatches(r, {
        bankAccountId: g.bankAccountId,
        amount: g.amounts[0]!,
        descriptionNorm: g.descriptionNorm,
      }),
    );
    if (alreadyRuled) continue;
    const lo = g.amounts.reduce((a, b) => (b < a ? b : a));
    const hi = g.amounts.reduce((a, b) => (b > a ? b : a));
    const pad = (x: bigint) => (x < 0n ? -x : x) / 5n; // ±20% band
    const inserted = await db
      .insert(ruleSuggestions)
      .values({
        bankAccountId: g.bankAccountId,
        descriptionRegex: `^${escapeRegExp(g.descriptionNorm)}$`,
        amountMin: lo - pad(lo),
        amountMax: hi + pad(hi),
        targetAccountId: g.targetAccountId,
        ownerPaymentTag: g.ownerPaymentTag,
        sampleTxnIds: g.txnIds,
      })
      .onConflictDoNothing()
      .returning({ id: ruleSuggestions.id });
    created += inserted.length;
  }
  return created;
}

/** Owner accepts a suggestion → it becomes a rule (auto_post only if the owner says so). */
export async function acceptSuggestion(
  db: Dbx,
  suggestionId: number,
  opts: { name?: string; autoPost?: boolean } = {},
): Promise<{ ruleId: number }> {
  return await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(ruleSuggestions)
      .where(eq(ruleSuggestions.id, suggestionId))
      .for("update");
    const s = rows[0];
    if (!s || s.status !== "pending") {
      throw new Error(`suggestion ${suggestionId} not found or not pending`);
    }
    const [rule] = await tx
      .insert(classificationRules)
      .values({
        name: opts.name ?? `Suggested: ${s.descriptionRegex.slice(1, 40)}`,
        descriptionRegex: s.descriptionRegex,
        amountMin: s.amountMin,
        amountMax: s.amountMax,
        bankAccountId: s.bankAccountId,
        targetAccountId: s.targetAccountId,
        ownerPaymentTag: s.ownerPaymentTag,
        autoPost: opts.autoPost ?? false,
      })
      .returning({ id: classificationRules.id });
    await tx
      .update(ruleSuggestions)
      .set({ status: "accepted" })
      .where(eq(ruleSuggestions.id, suggestionId));
    return { ruleId: rule!.id };
  });
}

export async function dismissSuggestion(db: Dbx, suggestionId: number): Promise<void> {
  await db
    .update(ruleSuggestions)
    .set({ status: "dismissed" })
    .where(and(eq(ruleSuggestions.id, suggestionId), eq(ruleSuggestions.status, "pending")));
}
