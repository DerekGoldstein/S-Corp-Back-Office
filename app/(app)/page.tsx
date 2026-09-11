import { sql as dsql } from "drizzle-orm";
import { getDb } from "../../src/db/client";
import { standingDocumentGaps } from "../../src/records/templates";
import { Banner } from "../../src/ui/banner";
import { money, todayISO, type Sp } from "../../src/ui/fmt";

export const dynamic = "force-dynamic";

export default async function Dashboard({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const db = getDb();
  const cash = await db.execute<{
    name: string;
    code: string;
    balance: bigint | null;
  }>(dsql`
    SELECT ba.name, a.code,
           (SELECT COALESCE(sum(l.debit) - sum(l.credit), 0)::bigint
            FROM journal_lines l WHERE l.account_id = a.id) AS balance
    FROM bank_accounts ba JOIN accounts a ON a.id = ba.ledger_account_id
    WHERE ba.active ORDER BY a.code
  `);
  const statuses = await db.execute<{ status: string; n: number }>(dsql`
    SELECT status::text AS status, count(*)::int AS n
    FROM bank_transactions GROUP BY status
  `);
  const byStatus = new Map(statuses.rows.map((r) => [r.status, r.n]));
  const recent = await db.execute<{
    at: string; // raw execute bypasses drizzle's mappers: timestamptz arrives as text
    actor: string;
    action: string;
    object_type: string;
    object_id: string;
  }>(dsql`
    SELECT at::text AS at, actor, action, object_type, object_id
    FROM audit_log ORDER BY id DESC LIMIT 12
  `);
  const gaps = await standingDocumentGaps(db);
  const openRecs = await db.execute<{ n: number }>(
    dsql`SELECT count(*)::int AS n FROM reconciliations WHERE status = 'open'`,
  );

  return (
    <>
      <h1>Dashboard</h1>
      <Banner sp={sp} />
      <div className="grid">
        {cash.rows.map((r) => (
          <div className="stat" key={r.code}>
            <div className="v">{money(r.balance ?? 0n)}</div>
            <div className="k">
              {r.name} ({r.code}) ledger balance
            </div>
          </div>
        ))}
        <div className="stat">
          <div className="v">
            {(byStatus.get("unreviewed") ?? 0) + (byStatus.get("proposed") ?? 0)}
          </div>
          <div className="k">
            transactions to review ({byStatus.get("proposed") ?? 0} proposed) →{" "}
            <a href="/queue">queue</a>
          </div>
        </div>
        <div className="stat">
          <div className="v">{byStatus.get("flagged") ?? 0}</div>
          <div className="k">flagged personal (fix at the bank)</div>
        </div>
        <div className="stat">
          <div className="v">{openRecs.rows[0]?.n ?? 0}</div>
          <div className="k">
            open reconciliations → <a href="/reconcile">reconcile</a>
          </div>
        </div>
      </div>

      {gaps.length > 0 && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Standing documents missing (§4.9)</h2>
          <ul>
            {gaps.map((g) => (
              <li key={g.standingKind}>
                {g.label} — upload it under <a href="/records">Corporate records</a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <h2>Recent activity (audit log)</h2>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Object</th>
          </tr>
        </thead>
        <tbody>
          {recent.rows.map((r, i) => (
            <tr key={i}>
              <td className="mono small">{r.at.slice(0, 19)}</td>
              <td>{r.actor}</td>
              <td>{r.action}</td>
              <td className="mono small">
                {r.object_type} #{r.object_id}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">As of {todayISO()}. Every number is a live ledger query.</p>
    </>
  );
}
