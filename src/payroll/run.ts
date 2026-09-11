/**
 * Persisted pay run (§4.4): verified tables → pure engine → payroll_runs row
 * with the full trace and table versions → the §4.1 journal entry → the
 * deposit schedule. The run refuses to exist unless every table cleared the
 * owner-verification gate.
 */
import { eq } from "drizzle-orm";
import type { Dbx } from "../db/client";
import { auditLog, payrollDeposits, payrollRuns } from "../db/schema";
import { postEntry, postReversal, type DraftLine } from "../ledger/posting";
import { getVerifiedTable } from "../tax/tables";
import {
  computeDepositSchedule,
  computePayroll,
  type DepositRulesTable,
  type PayrollInput,
  type PayrollResult,
  type PayrollTables,
} from "./engine";
import type { Cents } from "../lib/cents";

export class PayrollRunError extends Error {}

const TABLE_KINDS = [
  "fica",
  "pub15t",
  "nys50t_nys",
  "nys50t_nyc",
  "futa",
  "ny_sui",
  "limits_401k",
  "deposit_rules",
  "holidays",
] as const;

export type RunPayrollArgs = {
  input: PayrollInput;
  grossSource: string; // 'comp_computation:<id>' or 'override: <logged reason>'
  priorYearNyWithholding: Cents;
};

export type RunPayrollSummary = {
  runId: bigint;
  entryId: bigint;
  result: PayrollResult;
  deposits: Array<{ authority: string; amount: Cents; dueDate: string }>;
};

export async function runPayroll(db: Dbx, args: RunPayrollArgs): Promise<RunPayrollSummary> {
  const { input } = args;
  if (!args.grossSource.startsWith("comp_computation:") && !args.grossSource.startsWith("override:")) {
    throw new PayrollRunError(
      "gross_source must be 'comp_computation:<id>' (§4.3 default) or 'override: <reason>' (logged)",
    );
  }
  // the §4.4 gate: every table verified, versions recorded for reproducibility
  const tableVersionIds: Record<string, number> = {};
  const payloads: Record<string, unknown> = {};
  for (const kind of TABLE_KINDS) {
    const { id, payload } = await getVerifiedTable(db, input.taxYear, kind);
    tableVersionIds[kind] = id;
    payloads[kind] = payload;
  }
  const tables = payloads as unknown as PayrollTables;
  const depositRules = payloads["deposit_rules"] as DepositRulesTable;
  const holidays = new Set((payloads["holidays"] as { dates: string[] }).dates);

  const result = computePayroll(input, tables);
  const deposits = computeDepositSchedule(result, {
    payDate: input.payDate,
    rules: depositRules,
    holidays,
    priorYearNyWithholding: args.priorYearNyWithholding,
  });

  return await db.transaction(async (tx) => {
    const [run] = await tx
      .insert(payrollRuns)
      .values({
        taxYear: input.taxYear,
        payDate: input.payDate,
        status: "draft", // → posted once the entry links (all inside this tx)
        grossWages: input.grossWages,
        grossSource: args.grossSource,
        healthPremium: input.healthPremium2pct,
        fitWages: result.wageBases.fit,
        nysWages: result.wageBases.nys,
        nycWages: result.wageBases.nyc,
        ficaWages: result.wageBases.fica,
        futaWages: result.wageBases.futa,
        suiWages: result.wageBases.sui,
        eeDeferral401k: result.employee.deferral401k,
        eeSocialSecurity: result.employee.socialSecurity,
        eeMedicare: result.employee.medicare,
        eeAddlMedicare: result.employee.additionalMedicare,
        fitWithheld: result.employee.fitWithheld,
        nysWithheld: result.employee.nysWithheld,
        nycWithheld: result.employee.nycWithheld,
        erSocialSecurity: result.employer.socialSecurity,
        erMedicare: result.employer.medicare,
        erFuta: result.employer.futa,
        erSui: result.employer.sui,
        er401k: result.employer.contribution401k,
        netPay: result.netPay,
        tableVersionIds,
        trace: result.trace,
        warnings: result.warnings.length > 0 ? result.warnings : null,
      })
      .returning({ id: payrollRuns.id });
    const runId = run!.id;

    // §4.1 posting template (docs/proposal/01 §7). Health premium is NOT
    // re-expensed here — 5030 was debited when paid (guardrail 7).
    const e = result.employee;
    const er = result.employer;
    const dim = { payrollRunId: runId, taxYear: input.taxYear };
    const lines: DraftLine[] = [
      { accountCode: "5000", debit: input.grossWages, ...dim, memo: "officer gross wages" },
      {
        accountCode: "5010",
        debit: er.socialSecurity + er.medicare + er.futa + er.sui,
        ...dim,
        memo: "employer payroll taxes",
      },
      { accountCode: "5020", debit: er.contribution401k, ...dim, memo: "employer 401(k)" },
      { accountCode: "2100", credit: e.fitWithheld, ...dim },
      { accountCode: "2110", credit: e.socialSecurity + er.socialSecurity, ...dim },
      {
        accountCode: "2120",
        credit: e.medicare + e.additionalMedicare + er.medicare,
        ...dim,
      },
      { accountCode: "2130", credit: e.nysWithheld, ...dim },
      { accountCode: "2140", credit: e.nycWithheld, ...dim },
      { accountCode: "2150", credit: er.futa, ...dim },
      { accountCode: "2160", credit: er.sui, ...dim },
      { accountCode: "2170", credit: e.deferral401k, ...dim },
      { accountCode: "2180", credit: er.contribution401k, ...dim },
      { accountCode: "1000", credit: result.netPay, ...dim, memo: "net pay" },
    ];
    const nonZeroLines = lines.filter((l) => (l.debit ?? 0n) > 0n || (l.credit ?? 0n) > 0n);

    const { entryId } = await postEntry(tx, {
      entryDate: input.payDate,
      memo: `payroll run ${input.payDate} (${args.grossSource})`,
      sourceModule: "payroll",
      sourceId: runId,
      lines: nonZeroLines,
    });
    await tx
      .update(payrollRuns)
      .set({ status: "posted", journalEntryId: entryId })
      .where(eq(payrollRuns.id, runId));

    for (const d of deposits) {
      await tx.insert(payrollDeposits).values({
        payrollRunId: runId,
        authority: d.authority,
        amount: d.amount,
        dueDate: d.dueDate,
        rule: d.rule,
        liabilityAccounts: d.liabilityAccounts,
      });
    }
    await tx.insert(auditLog).values({
      actor: "owner",
      action: "run_payroll",
      objectType: "payroll_run",
      objectId: runId.toString(),
      detail: {
        payDate: input.payDate,
        gross: input.grossWages.toString(),
        net: result.netPay.toString(),
        entryId: entryId.toString(),
        tableVersionIds,
        warnings: result.warnings,
      },
    });
    return {
      runId,
      entryId,
      result,
      deposits: deposits.map((d) => ({
        authority: d.authority,
        amount: d.amount,
        dueDate: d.dueDate,
      })),
    };
  });
}

/** Corrections: reverse the run's entry, mark it reversed, drop open deposits. */
export async function reversePayrollRun(db: Dbx, runId: bigint, reason: string): Promise<void> {
  if (reason.trim() === "") throw new PayrollRunError("a reversal reason is required");
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, runId)).for("update");
    if (!run) throw new PayrollRunError(`payroll run ${runId} not found`);
    if (run.status !== "posted") throw new PayrollRunError(`run ${runId} is ${run.status}`);
    await postReversal(tx, run.journalEntryId!, run.payDate, `reverse payroll run: ${reason}`);
    await tx
      .update(payrollRuns)
      .set({ status: "reversed" }) // the entry link stays: it is the history
      .where(eq(payrollRuns.id, runId));
    await tx.delete(payrollDeposits).where(eq(payrollDeposits.payrollRunId, runId));
    await tx.insert(auditLog).values({
      actor: "owner",
      action: "reverse_payroll_run",
      objectType: "payroll_run",
      objectId: runId.toString(),
      detail: { reason },
    });
  });
}
