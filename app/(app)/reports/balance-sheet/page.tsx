import { getDb } from "../../../../src/db/client";
import { balanceSheet } from "../../../../src/ledger/reports";
import { money, spStr, todayISO, type Sp } from "../../../../src/ui/fmt";

export const dynamic = "force-dynamic";

export default async function BalanceSheetPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const asOf = spStr(sp, "asOf", todayISO());
  const bs = await balanceSheet(getDb(), asOf);
  const section = (title: string, rows: typeof bs.assets, total: bigint) => (
    <>
      <tr>
        <td colSpan={2}>
          <strong>{title}</strong>
        </td>
      </tr>
      {rows.map((r) => (
        <tr key={r.code}>
          <td>
            {r.code} {r.name}
          </td>
          <td className="num">{money(r.amount)}</td>
        </tr>
      ))}
      <tr>
        <td>Total {title.toLowerCase()}</td>
        <td className="num">{money(total)}</td>
      </tr>
    </>
  );
  return (
    <>
      <h1>Balance sheet</h1>
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
      {!bs.balanced && (
        <div className="banner err">Balance sheet does NOT balance — investigate immediately.</div>
      )}
      <table>
        <tbody>
          {section("Assets", bs.assets, bs.totalAssets)}
          {section("Liabilities", bs.liabilities, bs.totalLiabilities)}
          {section("Equity", bs.equity, bs.totalEquity - bs.unclosedNetIncome)}
          <tr>
            <td>Current-year net income (unclosed)</td>
            <td className="num">{money(bs.unclosedNetIncome)}</td>
          </tr>
          <tr className="total">
            <td>Liabilities + equity</td>
            <td className="num">{money(bs.totalLiabilities + bs.totalEquity)}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
