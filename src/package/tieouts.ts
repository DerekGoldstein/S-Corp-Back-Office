/**
 * §4.11: the CPA reviews, never reconciles. Every tie-out below runs the
 * check itself and reports green/red with the numbers; the package cannot be
 * "final" with a red row, and "final with open items" requires an owner note
 * on every red row (guardrail 8).
 */
import { and, eq } from "drizzle-orm";
import { sql as dsql } from "drizzle-orm";
import type { Dbx } from "../db/client";
import {
  auditLog,
  bankAccounts,
  basisRollforwards,
  compComputations,
  compMethodologies,
  documents,
  investees as investeesTable,
  k1s,
  payrollDeposits,
  payrollRuns,
  periods,
  reviewPackages,
} from "../db/schema";
import { formatCents } from "../lib/cents";
import { isReconciledThrough } from "../bank/reconcile";
import { box19Reconciliation } from "../k1/k1";
import { buildF1120s } from "../workpapers/f1120s";
import { buildF4562 } from "../workpapers/f4562";
import { storeDocument, linkDocument } from "../vault/store";

export class PackageError extends Error {}

export type TieOut = {
  key: string;
  name: string;
  pass: boolean;
  detail: string;
  ownerNote?: string;
};

async function centsQuery(db: Dbx, query: ReturnType<typeof dsql>): Promise<bigint> {
  const r = await db.execute<{ v: bigint | null }>(query);
  return r.rows[0]?.v ?? 0n;
}

export async function runTieOuts(db: Dbx, taxYear: number): Promise<TieOut[]> {
  const out: TieOut[] = [];
  const add = (key: string, name: string, pass: boolean, detail: string) =>
    out.push({ key, name, pass, detail });

  // 1. cash reconciled through December for every active bank account
  const banks = await db.select().from(bankAccounts).where(eq(bankAccounts.active, true));
  if (banks.length === 0) {
    add("cash_reconciled", "Ledger cash = statements through 12/31", true, "no bank accounts connected");
  } else {
    const bad: string[] = [];
    for (const b of banks) {
      if (!(await isReconciledThrough(db, b.id, taxYear, 12))) bad.push(b.name);
    }
    add(
      "cash_reconciled",
      "Ledger cash = statements through 12/31",
      bad.length === 0,
      bad.length === 0 ? `${banks.length} account(s) reconciled` : `not reconciled: ${bad.join(", ")}`,
    );
  }

  // 2. officer comp vs payroll runs (5000+5030 = Σ gross+health; FICA wages = Σ gross)
  const runs = await db
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.taxYear, taxYear), eq(payrollRuns.status, "posted")));
  const ledger5000 = await centsQuery(
    db,
    dsql`SELECT (COALESCE(sum(l.debit),0)-COALESCE(sum(l.credit),0))::bigint AS v
         FROM journal_lines l JOIN accounts a ON a.id=l.account_id
         JOIN journal_entries e ON e.id=l.entry_id
         WHERE a.code IN ('5000','5030')
           AND e.entry_date BETWEEN ${`${taxYear}-01-01`} AND ${`${taxYear}-12-31`}`,
  );
  if (runs.length === 0) {
    add(
      "officer_comp_w2",
      "Officer comp (5000+5030) = payroll register",
      ledger5000 === 0n,
      ledger5000 === 0n ? "no payroll this year" : `ledger ${formatCents(ledger5000)} with NO posted run`,
    );
  } else {
    const registerTotal = runs.reduce((a, r) => a + r.grossWages + r.healthPremium, 0n);
    add(
      "officer_comp_w2",
      "Officer comp (5000+5030) = payroll register (gross + 2% health)",
      ledger5000 === registerTotal,
      `ledger ${formatCents(ledger5000)} vs runs ${formatCents(registerTotal)}`,
    );
  }

  // 3. payroll liabilities zero or covered by scheduled deposits
  const liabilities = await db.execute<{ code: string; balance: bigint }>(dsql`
    SELECT a.code, (COALESCE(sum(l.credit),0)-COALESCE(sum(l.debit),0))::bigint AS balance
    FROM journal_lines l JOIN accounts a ON a.id=l.account_id
    WHERE a.code IN ('2100','2110','2120','2130','2140','2150','2160','2170','2180')
    GROUP BY a.code HAVING COALESCE(sum(l.credit),0)-COALESCE(sum(l.debit),0) <> 0
  `);
  const scheduled = await db
    .select()
    .from(payrollDeposits)
    .where(eq(payrollDeposits.status, "scheduled"));
  const coveredCodes = new Set(scheduled.flatMap((d) => d.liabilityAccounts));
  const uncovered = liabilities.rows.filter((l) => !coveredCodes.has(l.code));
  add(
    "payroll_liabilities",
    "Payroll liabilities zero after deposits, or covered by a scheduled deposit",
    uncovered.length === 0,
    uncovered.length === 0
      ? "all clear or scheduled"
      : uncovered.map((l) => `${l.code}: ${formatCents(l.balance)}`).join(", "),
  );

  // 4/5. every partnership investee has a POSTED K-1 with its PDF, a basis row,
  //      and a reconciled box 19 (or the difference is an open item)
  const invs = await db
    .select()
    .from(investeesTable)
    .where(eq(investeesTable.entityType, "partnership"));
  for (const inv of invs) {
    const [k1] = await db
      .select()
      .from(k1s)
      .where(and(eq(k1s.investeeId, inv.id), eq(k1s.taxYear, taxYear)));
    if (!k1 || k1.status !== "posted") {
      add(
        `k1_${inv.id}`,
        `K-1 for ${inv.name} ${taxYear} confirmed and posted with source PDF`,
        false,
        k1 ? `status is ${k1.status}` : "no K-1 uploaded (placeholder flagged)",
      );
      continue;
    }
    const [doc] = await db.select().from(documents).where(eq(documents.id, k1.documentId));
    const [basis] = await db
      .select()
      .from(basisRollforwards)
      .where(and(eq(basisRollforwards.investeeId, inv.id), eq(basisRollforwards.taxYear, taxYear)));
    add(
      `k1_${inv.id}`,
      `K-1 for ${inv.name} ${taxYear} confirmed and posted with source PDF + basis roll`,
      doc !== undefined && basis !== undefined,
      `pdf ${doc ? "✓" : "missing"}, basis roll ${basis ? "✓ ending " + formatCents(basis.endingBasis) : "missing"}`,
    );
    const b19 = await box19Reconciliation(db, k1.id);
    add(
      `box19_${inv.id}`,
      `${inv.name}: K-1 box 19 = classified wires`,
      !b19.explanationNeeded,
      `K-1 ${formatCents(b19.k1Distributions)} vs wires ${formatCents(b19.bankClassifiedWires)} (diff ${formatCents(b19.difference)})`,
    );
  }

  // 6. 1120-S internal tie-outs (M-1 loop, Schedule L, M-2 vs ledger)
  const wp = await buildF1120s(db, taxYear);
  for (const t of wp.tieOuts) {
    add(`f1120s_${t.name.slice(0, 24).replaceAll(/\W+/g, "_")}`, t.name, t.pass, t.detail);
  }

  // 7. distributions on K.16d = owner-tagged bank distributions (when banked)
  const dist3200 = await centsQuery(
    db,
    dsql`SELECT (COALESCE(sum(l.debit),0)-COALESCE(sum(l.credit),0))::bigint AS v
         FROM journal_lines l JOIN accounts a ON a.id=l.account_id
         JOIN journal_entries e ON e.id=l.entry_id
         WHERE a.code='3200' AND e.source_module <> 'close'
           AND e.entry_date BETWEEN ${`${taxYear}-01-01`} AND ${`${taxYear}-12-31`}`,
  );
  const distTagged = await centsQuery(
    db,
    dsql`SELECT COALESCE(sum(-t.amount),0)::bigint AS v
         FROM bank_transactions t
         WHERE t.owner_payment_tag='distribution' AND t.status='posted'
           AND t.txn_date BETWEEN ${`${taxYear}-01-01`} AND ${`${taxYear}-12-31`}`,
  );
  add(
    "distributions_3200",
    "3200 distributions = owner-tagged bank payments",
    banks.length === 0 ? true : dist3200 === distTagged,
    `3200 ${formatCents(dist3200)} vs tagged ${formatCents(distTagged)}` +
      (banks.length === 0 ? " (no bank feed: manual entries accepted)" : ""),
  );

  // 8. accountable plan: 2190 zero or covered by approved-not-yet-paid submissions
  const bal2190 = await centsQuery(
    db,
    dsql`SELECT (COALESCE(sum(l.credit),0)-COALESCE(sum(l.debit),0))::bigint AS v
         FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE a.code='2190'`,
  );
  const approvedUnpaid = await centsQuery(
    db,
    dsql`SELECT COALESCE(sum(amount),0)::bigint AS v FROM reimbursement_submissions
         WHERE status IN ('approved','posted') AND tax_year = ${taxYear}`,
  );
  add(
    "reimbursements",
    "Accountable-plan payable (2190) covered by approved documented submissions",
    bal2190 <= approvedUnpaid || bal2190 === 0n,
    `2190 ${formatCents(bal2190)} vs approved unpaid ${formatCents(approvedUnpaid)}`,
  );

  // 9. reasonable-comp evidence: frozen methodology + computation for the year
  const methodologies = await db.select().from(compMethodologies).where(eq(compMethodologies.frozen, true));
  const comps = await db
    .select()
    .from(compComputations)
    .where(eq(compComputations.taxYear, taxYear));
  add(
    "comp_evidence",
    "Reasonable-comp methodology frozen + computation on file",
    runs.length === 0 || (methodologies.length > 0 && comps.length > 0),
    `${methodologies.length} frozen methodology(ies), ${comps.length} computation(s)` +
      (runs.length === 0 ? " (no payroll yet)" : ""),
  );

  // 10. fixed assets: 4562 ties to the ledger; a 1600 balance with an empty
  //     register means a purchase was classified but never registered
  const assetCount = await db.execute<{ n: number }>(
    dsql`SELECT count(*)::int AS n FROM fixed_assets`,
  );
  if ((assetCount.rows[0]?.n ?? 0) > 0) {
    const f4562 = await buildF4562(db, taxYear);
    for (const t of f4562.tieOuts) {
      add(`f4562_${t.name.slice(0, 24).replaceAll(/\W+/g, "_")}`, t.name, t.pass, t.detail);
    }
  } else {
    const bal1600 = await centsQuery(
      db,
      dsql`SELECT (COALESCE(sum(l.debit),0)-COALESCE(sum(l.credit),0))::bigint AS v
           FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE a.code='1600'`,
    );
    add(
      "fixed_assets_registered",
      "Fixed assets (1600) all have register rows",
      bal1600 === 0n,
      bal1600 === 0n
        ? "no fixed assets"
        : `1600 carries ${formatCents(bal1600)} with an EMPTY register — add the asset(s) so depreciation runs`,
    );
  }

  // 11. all twelve periods locked
  const locked = await db
    .select()
    .from(periods)
    .where(and(eq(periods.taxYear, taxYear), eq(periods.locked, true)));
  add(
    "periods_locked",
    "All twelve periods locked",
    locked.length === 12,
    `${locked.length}/12 locked`,
  );

  return out;
}

function renderCoverMemo(taxYear: number, tieOuts: TieOut[], version: number): string {
  const red = tieOuts.filter((t) => !t.pass);
  const lines = [
    `# CPA review package — tax year ${taxYear} (v${version})`,
    "",
    `Every tie-out below was RUN by the system, not asserted. ${tieOuts.length - red.length}/${tieOuts.length} green.`,
    red.length > 0 ? `\n## OPEN ITEMS — start here (${red.length})\n` : "\n## All tie-outs green\n",
  ];
  for (const t of red) {
    lines.push(`- **${t.name}** — ${t.detail}${t.ownerNote ? `\n  - owner note: ${t.ownerNote}` : ""}`);
  }
  lines.push("", "## Tie-out results", "", "| ✓ | Tie-out | Detail |", "|---|---|---|");
  for (const t of tieOuts) {
    lines.push(`| ${t.pass ? "🟢" : "🔴"} | ${t.name} | ${t.detail} |`);
  }
  lines.push(
    "",
    "_Workpapers, reconciliations, K-1 extractions with source PDFs, basis schedules, consents,_",
    "_and the compliance calendar with completion evidence accompany this memo in the vault._",
  );
  return lines.join("\n");
}

export type BuildPackageResult = {
  packageId: number;
  version: number;
  tieOuts: TieOut[];
  redCount: number;
  coverDocumentId: bigint;
};

export async function buildReviewPackage(
  db: Dbx,
  taxYear: number,
  ownerNotes: Record<string, string> = {},
): Promise<BuildPackageResult> {
  const tieOuts = (await runTieOuts(db, taxYear)).map((t) => ({
    ...t,
    ownerNote: ownerNotes[t.key],
  }));
  return await db.transaction(async (tx) => {
    const prior = await tx
      .select({ version: reviewPackages.version })
      .from(reviewPackages)
      .where(eq(reviewPackages.taxYear, taxYear));
    const version = prior.reduce((a, r) => Math.max(a, r.version), 0) + 1;
    const memo = renderCoverMemo(taxYear, tieOuts, version);
    const { document } = await storeDocument(tx, {
      filename: `cpa-package-${taxYear}-v${version}-cover.md`,
      mime: "text/markdown",
      bytes: Buffer.from(memo, "utf8"),
      source: "generated",
      year: taxYear,
    });
    const [row] = await tx
      .insert(reviewPackages)
      .values({
        taxYear,
        version,
        tieOuts: tieOuts as unknown as Record<string, unknown>[],
        openItems: tieOuts.filter((t) => !t.pass) as unknown as Record<string, unknown>[],
        coverDocumentId: document.id,
      })
      .returning({ id: reviewPackages.id });
    await linkDocument(tx, document.id, "review_package", row!.id);
    await tx.insert(auditLog).values({
      actor: "owner",
      action: "build_review_package",
      objectType: "review_package",
      objectId: String(row!.id),
      detail: { taxYear, version, red: tieOuts.filter((t) => !t.pass).length },
    });
    return {
      packageId: row!.id,
      version,
      tieOuts,
      redCount: tieOuts.filter((t) => !t.pass).length,
      coverDocumentId: document.id,
    };
  });
}

/** Guardrail 8: 'final' needs zero red; 'final_with_open_items' needs a note on every red. */
export async function finalizePackage(
  db: Dbx,
  packageId: number,
  status: "final" | "final_with_open_items",
): Promise<void> {
  const [pkg] = await db.select().from(reviewPackages).where(eq(reviewPackages.id, packageId));
  if (!pkg) throw new PackageError(`package ${packageId} not found`);
  if (pkg.status !== "draft") throw new PackageError(`package ${packageId} is already ${pkg.status}`);
  const tieOuts = pkg.tieOuts as unknown as TieOut[];
  const red = tieOuts.filter((t) => !t.pass);
  if (status === "final" && red.length > 0) {
    throw new PackageError(
      `cannot mark final with ${red.length} red tie-out(s) (guardrail 8): ` +
        red.map((t) => t.name).join("; "),
    );
  }
  if (status === "final_with_open_items") {
    const unnoted = red.filter((t) => !t.ownerNote || t.ownerNote.trim() === "");
    if (unnoted.length > 0) {
      throw new PackageError(
        `every red item needs an owner note (guardrail 8); missing: ` +
          unnoted.map((t) => t.name).join("; "),
      );
    }
    if (red.length === 0) throw new PackageError("no open items — mark it 'final' instead");
  }
  await db.update(reviewPackages).set({ status }).where(eq(reviewPackages.id, packageId));
  await db.insert(auditLog).values({
    actor: "owner",
    action: "finalize_review_package",
    objectType: "review_package",
    objectId: String(packageId),
    detail: { status },
  });
}

/** CPA feedback attaches without reopening the version. */
export async function recordCpaSignoff(db: Dbx, packageId: number, comments: string): Promise<void> {
  await db
    .update(reviewPackages)
    .set({ cpaComments: comments, signedOffAt: new Date() })
    .where(eq(reviewPackages.id, packageId));
}
