import { getDb } from "../../../../src/db/client";
import { accountRegister } from "../../../../src/ledger/reports";
import { formatCents } from "../../../../src/lib/cents";
import { dcCell, spStr, todayISO, type Sp } from "../../../../src/ui/fmt";

export const dynamic = "force-dynamic";

export default async function RegisterPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const year = todayISO().slice(0, 4);
  const account = spStr(sp, "account", "1000");
  const from = spStr(sp, "from", `${year}-01-01`);
  const to = spStr(sp, "to", todayISO());
  const reg = await accountRegister(getDb(), account, from, to);
  return (
    <>
      <h1>Account register</h1>
      <div className="panel">
        <form className="inline" method="get">
          <label className="field">
            account code
            <input name="account" defaultValue={account} size={6} />
          </label>
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
            <th>Date</th>
            <th>Entry</th>
            <th>Memo</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
            <th className="num">Balance</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={5}>Opening balance</td>
            <td className="num">{formatCents(reg.openingBalance)}</td>
          </tr>
          {reg.lines.map((l) => (
            <tr key={`${l.entryId}-${l.lineNo}`}>
              <td className="mono small">{l.entryDate}</td>
              <td className="mono small">#{l.entryId.toString()}</td>
              <td className="small">{l.memo}</td>
              <td className="num">{dcCell(l.debit)}</td>
              <td className="num">{dcCell(l.credit)}</td>
              <td className="num">{formatCents(l.runningBalance)}</td>
            </tr>
          ))}
          <tr className="total">
            <td colSpan={5}>Closing balance</td>
            <td className="num">{formatCents(reg.closingBalance)}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
