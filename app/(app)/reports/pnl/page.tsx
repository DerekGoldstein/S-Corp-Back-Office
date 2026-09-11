import { getDb } from "../../../../src/db/client";
import { profitAndLoss } from "../../../../src/ledger/reports";
import { money, spStr, todayISO, type Sp } from "../../../../src/ui/fmt";

export const dynamic = "force-dynamic";

export default async function PnlPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const year = todayISO().slice(0, 4);
  const from = spStr(sp, "from", `${year}-01-01`);
  const to = spStr(sp, "to", todayISO());
  const pnl = await profitAndLoss(getDb(), from, to);
  return (
    <>
      <h1>Profit &amp; loss</h1>
      <div className="panel">
        <form className="inline" method="get">
          <label className="field">
            from
            <input type="date" name="from" defaultValue={from} />
          </label>
          <label className="field">
            to
            <input type="date" name="to" defaultValue={to} />
          </label>
          <button className="secondary" type="submit">
            Run
          </button>
        </form>
      </div>
      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={2}>
              <strong>Revenue</strong>
            </td>
          </tr>
          {pnl.revenue.map((r) => (
            <tr key={r.code}>
              <td>
                {r.code} {r.name}
              </td>
              <td className="num">{money(r.amount)}</td>
            </tr>
          ))}
          <tr>
            <td>Total revenue</td>
            <td className="num">{money(pnl.totalRevenue)}</td>
          </tr>
          <tr>
            <td colSpan={2}>
              <strong>Expenses</strong>
            </td>
          </tr>
          {pnl.expenses.map((r) => (
            <tr key={r.code}>
              <td>
                {r.code} {r.name}
              </td>
              <td className="num">{money(r.amount)}</td>
            </tr>
          ))}
          <tr>
            <td>Total expenses</td>
            <td className="num">{money(pnl.totalExpenses)}</td>
          </tr>
          <tr className="total">
            <td>Net income</td>
            <td className="num">{money(pnl.netIncome)}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
