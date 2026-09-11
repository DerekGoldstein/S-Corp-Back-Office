import { getDb } from "../../../../src/db/client";
import { trialBalance } from "../../../../src/ledger/reports";
import { dcCell, spStr, todayISO, type Sp } from "../../../../src/ui/fmt";
import { formatCents } from "../../../../src/lib/cents";

export const dynamic = "force-dynamic";

export default async function TrialBalancePage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const asOf = spStr(sp, "asOf", todayISO());
  const tb = await trialBalance(getDb(), asOf);
  return (
    <>
      <h1>Trial balance</h1>
      <div className="panel">
        <form className="inline" method="get">
          <label className="field">
            as of
            <input type="date" name="asOf" defaultValue={asOf} />
          </label>
          <button className="secondary" type="submit">
            Run
          </button>
        </form>
      </div>
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Account</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
          </tr>
        </thead>
        <tbody>
          {tb.rows.map((r) => (
            <tr key={r.code}>
              <td className="mono">{r.code}</td>
              <td>{r.name}</td>
              <td className="num">{dcCell(r.debit)}</td>
              <td className="num">{dcCell(r.credit)}</td>
            </tr>
          ))}
          <tr className="total">
            <td />
            <td>Totals {tb.totalDebits === tb.totalCredits ? "✓" : "✗ UNBALANCED"}</td>
            <td className="num">{formatCents(tb.totalDebits)}</td>
            <td className="num">{formatCents(tb.totalCredits)}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
