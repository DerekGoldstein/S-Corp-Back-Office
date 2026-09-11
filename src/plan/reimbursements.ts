/**
 * Accountable-plan reimbursements (§4.8): submission (document required) →
 * approval, which POSTS Dr 504x-by-category (health premiums → 5030, so
 * they're expensed exactly once — guardrail 7) / Cr 2190 → the bank payment
 * to the owner, tagged `reimbursement`, clears 2190 (§4.2 guard) and marks
 * submissions paid oldest-first. No reimbursement posts without an approved
 * submission and an attached document (guardrail 6).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Dbx } from "../db/client";
import {
  accountablePlans,
  auditLog,
  reimbursementSubmissions,
} from "../db/schema";
import type { Cents } from "../lib/cents";
import { applyRate } from "../payroll/engine";
import { formatCents } from "../lib/cents";
import { postEntry } from "../ledger/posting";

export class ReimbursementError extends Error {}

export type ReimbursementCategory =
  | "home_office"
  | "phone"
  | "internet"
  | "supplies"
  | "health_insurance"
  | "other";

const CATEGORY_ACCOUNT: Record<ReimbursementCategory, string> = {
  home_office: "5041",
  phone: "5042",
  internet: "5043",
  supplies: "5044",
  other: "5044",
  health_insurance: "5030", // guardrail 7: the ONE place premiums are expensed
};

export type HomeOfficeInputs = {
  totalSquareFeet: number;
  businessSquareFeet: number;
  annualRent: Cents;
  annualUtilities: Cents;
  annualInsurance: Cents;
};

/** Square-footage method, exact cents (half-up at the final multiplication). */
export function computeHomeOffice(i: HomeOfficeInputs): {
  businessUsePct: string;
  amount: Cents;
  breakdown: Record<string, string>;
} {
  if (i.businessSquareFeet <= 0 || i.totalSquareFeet <= 0 || i.businessSquareFeet > i.totalSquareFeet) {
    throw new ReimbursementError("business square footage must be positive and within the total");
  }
  const eligible = i.annualRent + i.annualUtilities + i.annualInsurance;
  const amount = (eligible * BigInt(i.businessSquareFeet) + BigInt(i.totalSquareFeet) / 2n) / BigInt(i.totalSquareFeet);
  const pct = ((i.businessSquareFeet / i.totalSquareFeet) * 100).toFixed(2);
  return {
    businessUsePct: `${pct}%`,
    amount,
    breakdown: {
      method: "square footage",
      eligibleCosts: formatCents(eligible),
      businessUse: `${i.businessSquareFeet}/${i.totalSquareFeet} sq ft (${pct}%)`,
      amount: formatCents(amount),
    },
  };
}

/** Business-use percentage of a mixed-use bill (phone/internet). */
export function computeBusinessUse(annualCost: Cents, pct: string): Cents {
  return applyRate(annualCost, pct);
}

export async function createSubmission(
  db: Dbx,
  input: {
    planId: number;
    taxYear: number;
    category: ReimbursementCategory;
    amount: Cents;
    computation?: Record<string, unknown>;
    documentId: bigint; // guardrail 6: no submission without its document
  },
): Promise<bigint> {
  const [plan] = await db
    .select()
    .from(accountablePlans)
    .where(eq(accountablePlans.id, input.planId));
  if (!plan || !plan.active) throw new ReimbursementError(`no active plan ${input.planId}`);
  if (!plan.categories.includes(input.category)) {
    throw new ReimbursementError(
      `the accountable plan does not cover '${input.category}' — its categories are ${plan.categories.join(", ")}`,
    );
  }
  if (input.amount <= 0n) throw new ReimbursementError("amount must be positive");
  const [row] = await db
    .insert(reimbursementSubmissions)
    .values({
      planId: input.planId,
      taxYear: input.taxYear,
      category: input.category,
      amount: input.amount,
      computation: input.computation ?? null,
      documentId: input.documentId,
      submittedOn: new Date().toISOString().slice(0, 10),
      status: "submitted",
    })
    .returning({ id: reimbursementSubmissions.id });
  return row!.id;
}

/** Approval posts immediately (§4.8: approved submissions post to 504x/2190). */
export async function approveSubmission(
  db: Dbx,
  submissionId: bigint,
  approvedOn: string,
): Promise<{ entryId: bigint }> {
  return await db.transaction(async (tx) => {
    const [s] = await tx
      .select()
      .from(reimbursementSubmissions)
      .where(eq(reimbursementSubmissions.id, submissionId))
      .for("update");
    if (!s) throw new ReimbursementError(`submission ${submissionId} not found`);
    if (s.status !== "submitted") {
      throw new ReimbursementError(`submission ${submissionId} is ${s.status}`);
    }
    const account = CATEGORY_ACCOUNT[s.category as ReimbursementCategory];
    const { entryId } = await postEntry(tx, {
      entryDate: approvedOn,
      memo: `accountable-plan reimbursement approved: ${s.category} (submission ${s.id})`,
      sourceModule: "reimbursement",
      sourceId: s.id,
      documentIds: [s.documentId],
      lines: [
        { accountCode: account, debit: s.amount, taxYear: s.taxYear },
        { accountCode: "2190", credit: s.amount, taxYear: s.taxYear },
      ],
    });
    await tx
      .update(reimbursementSubmissions)
      .set({ status: "posted", approvedOn, journalEntryId: entryId })
      .where(eq(reimbursementSubmissions.id, submissionId));
    await tx.insert(auditLog).values({
      actor: "owner",
      action: "approve_reimbursement",
      objectType: "reimbursement_submission",
      objectId: submissionId.toString(),
      detail: {
        category: s.category,
        amount: s.amount.toString(),
        account,
        entryId: entryId.toString(),
      },
    });
    return { entryId };
  });
}

/**
 * Called by bank classification when a `reimbursement`-tagged payment posts:
 * marks posted submissions paid, oldest first, up to the payment amount.
 */
export async function markSubmissionsPaid(
  db: Dbx,
  bankTransactionId: bigint,
  paymentAmount: Cents,
): Promise<number> {
  const open = await db
    .select()
    .from(reimbursementSubmissions)
    .where(inArray(reimbursementSubmissions.status, ["posted"]))
    .orderBy(asc(reimbursementSubmissions.id));
  let remaining = paymentAmount;
  let marked = 0;
  for (const s of open) {
    if (remaining < s.amount) break; // partial coverage leaves it posted
    await db
      .update(reimbursementSubmissions)
      .set({ status: "paid", paidBankTransactionId: bankTransactionId })
      .where(and(eq(reimbursementSubmissions.id, s.id), eq(reimbursementSubmissions.status, "posted")));
    remaining -= s.amount;
    marked++;
  }
  return marked;
}
