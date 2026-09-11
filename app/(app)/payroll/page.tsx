import { asc, desc } from "drizzle-orm";
import { getDb } from "../../../src/db/client";
import { payrollDeposits, payrollRuns, taxTableVersions } from "../../../src/db/schema";
import { loadTaxTables, verifyTaxTable } from "../../../src/tax/tables";
import { reversePayrollRun } from "../../../src/payroll/run";
import { runAction, fdRequired } from "../../../src/ui/action";
import { Banner } from "../../../src/ui/banner";
import { currentYear, money, spStr, type Sp } from "../../../src/ui/fmt";

export const dynamic = "force-dynamic";

async function loadTablesAction(formData: FormData): Promise<void> {
  "use server";
  const year = fdRequired(formData, "year");
  await runAction(`/payroll?year=${year}`, async () => {
    const report = await loadTaxTables(getDb(), Number(year));
    const fresh = report.filter((r) => r.action !== "unchanged");
    return (
      `loaded ${report.length} table file(s): ${fresh.length} new version(s) awaiting verification` +
      (fresh.some((f) => f.action === "superseded_verified")
        ? " — a VERIFIED table changed; nothing computes until you re-verify it"
        : "")
    );
  });
}

async function verifyAction(formData: FormData): Promise<void> {
  "use server";
  const year = fdRequired(formData, "year");
  await runAction(`/payroll?year=${year}`, async () => {
    await verifyTaxTable(getDb(), Number(fdRequired(formData, "id")));
    return "table verified against its official source (one-way; the row is now immutable)";
  });
}

async function payStubAction(formData: FormData): Promise<void> {
  "use server";
  const year = fdRequired(formData, "year");
  await runAction(`/payroll?year=${year}`, async () => {
    const { generatePayStub } = await import("../../../src/payroll/paystub");
    const { documentId, mime } = await generatePayStub(getDb(), BigInt(fdRequired(formData, "runId")));
    return `pay stub vaulted as document #${documentId} (${mime}) — open it under /documents/${documentId}`;
  });
}

async function reverseRunAction(formData: FormData): Promise<void> {
  "use server";
  const year = fdRequired(formData, "year");
  await runAction(`/payroll?year=${year}`, async () => {
    await reversePayrollRun(getDb(), BigInt(fdRequired(formData, "runId")), fdRequired(formData, "reason"));
    return "run reversed (entry mirrored, scheduled deposits dropped)";
  });
}

export default async function PayrollPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const year = Number(spStr(sp, "year", String(currentYear())));
  const db = getDb();
  const tables = await db
    .select()
    .from(taxTableVersions)
    .orderBy(asc(taxTableVersions.kind), asc(taxTableVersions.id));
  const yearTables = tables.filter((t) => t.taxYear === year);
  const latestByKind = new Map<string, (typeof yearTables)[number]>();
  for (const t of yearTables) latestByKind.set(t.kind, t);
  const runs = await db.select().from(payrollRuns).orderBy(desc(payrollRuns.id)).limit(10);
  const deposits = await db.select().from(payrollDeposits).orderBy(asc(payrollDeposits.dueDate));

  return (
    <>
      <h1>Payroll (§4.4) — {year}</h1>
      <Banner sp={sp} />
      <div className="panel">
        <form className="inline" method="get">
          <label className="field">
            year
            <input name="year" size={6} defaultValue={String(year)} />
          </label>
          <button className="secondary" type="submit">
            Show
          </button>
        </form>
        <form className="inline" action={loadTablesAction}>
          <input type="hidden" name="year" value={year} />
          <button type="submit">Load {year} table files</button>
          <span className="muted small">
            from <span className="mono">data/tax-tables/{year}/</span> — fill nulls from the
            official sources first; verification refuses placeholders
          </span>
        </form>
      </div>

      <h2>Tax tables (guardrail 1 — payroll refuses to run on anything unverified)</h2>
      <table>
        <thead>
          <tr>
            <th>Kind</th>
            <th>Source</th>
            <th>Loaded</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {[...latestByKind.values()].map((t) => (
            <tr key={t.id}>
              <td className="mono">{t.kind}</td>
              <td className="small">{t.sourceUrl}</td>
              <td className="mono small">{t.loadedAt.toISOString().slice(0, 10)}</td>
              <td>
                {t.verifiedByOwner ? (
                  <span className="badge completed">
                    verified {t.verifiedAt?.toISOString().slice(0, 10)}
                  </span>
                ) : (
                  <span className="badge flagged">NOT verified — blocks payroll</span>
                )}
              </td>
              <td>
                {!t.verifiedByOwner && (
                  <form action={verifyAction}>
                    <input type="hidden" name="id" value={t.id} />
                    <input type="hidden" name="year" value={year} />
                    <button className="secondary" type="submit">
                      I verified this against the source
                    </button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Pay runs</h2>
      {runs.length === 0 ? (
        <p className="muted">
          No runs yet. The December run takes its gross from the frozen comp computation
          (Time &amp; comp) and its withholding override from the projection — the run itself is
          executed from the December-payroll checklist once 2027 tables are verified.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Id</th>
              <th>Pay date</th>
              <th className="num">Gross</th>
              <th className="num">FIT</th>
              <th className="num">NYS+NYC</th>
              <th className="num">Net</th>
              <th>Status</th>
              <th>Entry</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id.toString()}>
                <td className="mono">#{r.id.toString()}</td>
                <td className="mono small">{r.payDate}</td>
                <td className="num">{money(r.grossWages)}</td>
                <td className="num">{money(r.fitWithheld)}</td>
                <td className="num">{money(r.nysWithheld + r.nycWithheld)}</td>
                <td className="num">{money(r.netPay)}</td>
                <td>
                  <span className={"badge " + (r.status === "posted" ? "completed" : "flagged")}>
                    {r.status}
                  </span>
                </td>
                <td className="mono small">
                  {r.journalEntryId !== null ? `#${r.journalEntryId}` : ""}
                </td>
                <td>
                  {r.status === "posted" && (
                    <>
                      <form className="inline" action={payStubAction}>
                        <input type="hidden" name="runId" value={r.id.toString()} />
                        <input type="hidden" name="year" value={year} />
                        <button className="secondary" type="submit">
                          Pay stub
                        </button>
                      </form>{" "}
                      <form className="inline" action={reverseRunAction}>
                        <input type="hidden" name="runId" value={r.id.toString()} />
                        <input type="hidden" name="year" value={year} />
                        <input name="reason" size={14} placeholder="reason" required />
                        <button className="danger" type="submit">
                          Reverse
                        </button>
                      </form>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {deposits.length > 0 && (
        <>
          <h2>Deposit schedule</h2>
          <table>
            <thead>
              <tr>
                <th>Authority</th>
                <th className="num">Amount</th>
                <th>Due</th>
                <th>Rule</th>
                <th>Clears</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {deposits.map((d) => (
                <tr key={d.id.toString()}>
                  <td>{d.authority}</td>
                  <td className="num">{money(d.amount)}</td>
                  <td className="mono small">{d.dueDate}</td>
                  <td className="small">{d.rule}</td>
                  <td className="mono small">{d.liabilityAccounts.join(", ")}</td>
                  <td>
                    <span className={"badge " + (d.status === "cleared" ? "completed" : "unreviewed")}>
                      {d.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            When the matching EFTPS/NYS debit arrives in the bank feed, classification clears the
            liability (§4.2) and marks the deposit cleared.
          </p>
        </>
      )}
    </>
  );
}
