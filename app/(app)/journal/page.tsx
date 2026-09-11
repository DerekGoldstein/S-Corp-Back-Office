import { getDb } from "../../../src/db/client";
import { postEntry, postReversal, type DraftLine } from "../../../src/ledger/posting";
import { generalLedgerDetail } from "../../../src/ledger/reports";
import { parseDollars } from "../../../src/lib/cents";
import { runAction, fd, fdRequired } from "../../../src/ui/action";
import { Banner } from "../../../src/ui/banner";
import { dcCell, spStr, todayISO, type Sp } from "../../../src/ui/fmt";

export const dynamic = "force-dynamic";

const MAX_LINES = 6;

async function postManualAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/journal", async () => {
    const lines: DraftLine[] = [];
    for (let i = 1; i <= MAX_LINES; i++) {
      const account = fd(formData, `account${i}`);
      const debit = fd(formData, `debit${i}`);
      const credit = fd(formData, `credit${i}`);
      if (account === "" && debit === "" && credit === "") continue;
      if (account === "") throw new Error(`line ${i}: account code missing`);
      lines.push({
        accountCode: account,
        debit: debit !== "" ? parseDollars(debit) : undefined,
        credit: credit !== "" ? parseDollars(credit) : undefined,
      });
    }
    const { entryId } = await postEntry(getDb(), {
      entryDate: fdRequired(formData, "date"),
      memo: fdRequired(formData, "memo"),
      sourceModule: "manual",
      lines,
    });
    return `manual entry #${entryId} posted (manual entries are flagged in the audit log)`;
  });
}

async function reverseAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/journal", async () => {
    const { entryId } = await postReversal(
      getDb(),
      BigInt(fdRequired(formData, "entryId")),
      fdRequired(formData, "date"),
      fdRequired(formData, "memo"),
    );
    return `reversal posted as entry #${entryId}`;
  });
}

export default async function JournalPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const year = todayISO().slice(0, 4);
  const from = spStr(sp, "from", `${year}-01-01`);
  const to = spStr(sp, "to", todayISO());
  const account = spStr(sp, "account");
  const db = getDb();
  const detail = await generalLedgerDetail(db, {
    from,
    to,
    accountCode: account !== "" ? account : undefined,
  });

  return (
    <>
      <h1>Journal</h1>
      <Banner sp={sp} />
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
          <label className="field">
            account code
            <input name="account" defaultValue={account} size={6} placeholder="all" />
          </label>
          <button type="submit" className="secondary">
            Filter
          </button>
        </form>
      </div>

      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Entry</th>
            <th>Memo</th>
            <th>Source</th>
            <th>Account</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
          </tr>
        </thead>
        <tbody>
          {detail.map((l) => (
            <tr key={`${l.entryId}-${l.lineNo}`}>
              <td className="mono small">{l.lineNo === 1 ? l.entryDate : ""}</td>
              <td className="mono small">{l.lineNo === 1 ? `#${l.entryId}` : ""}</td>
              <td className="small">{l.lineNo === 1 ? l.memo : ""}</td>
              <td className="small muted">{l.lineNo === 1 ? l.sourceModule : ""}</td>
              <td>
                {l.accountCode} <span className="muted small">{l.accountName}</span>
              </td>
              <td className="num">{dcCell(l.debit)}</td>
              <td className="num">{dcCell(l.credit)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Manual journal entry</h2>
      <div className="panel">
        <form action={postManualAction}>
          <div className="inline">
            <label className="field">
              date
              <input type="date" name="date" defaultValue={todayISO()} required />
            </label>
            <label className="field">
              memo
              <input name="memo" size={40} required />
            </label>
          </div>
          {Array.from({ length: MAX_LINES }, (_, i) => i + 1).map((i) => (
            <div className="inline" key={i} style={{ marginTop: ".3rem" }}>
              <label className="field">
                account code
                <input name={`account${i}`} size={6} />
              </label>
              <label className="field">
                debit $
                <input name={`debit${i}`} size={10} />
              </label>
              <label className="field">
                credit $
                <input name={`credit${i}`} size={10} />
              </label>
            </div>
          ))}
          <p>
            <button type="submit">Post manual entry</button>{" "}
            <span className="muted small">
              Manual entries are audited; corrections to posted entries go through reversals.
            </span>
          </p>
        </form>
      </div>

      <h2>Reverse an entry</h2>
      <div className="panel">
        <form className="inline" action={reverseAction}>
          <label className="field">
            entry #
            <input name="entryId" size={8} required />
          </label>
          <label className="field">
            reversal date
            <input type="date" name="date" defaultValue={todayISO()} required />
          </label>
          <label className="field">
            memo
            <input name="memo" size={30} required placeholder="why" />
          </label>
          <button type="submit" className="danger">
            Post reversal
          </button>
        </form>
      </div>
    </>
  );
}
