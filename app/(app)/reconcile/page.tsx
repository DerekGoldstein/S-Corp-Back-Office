import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../src/db/client";
import { bankAccounts, reconciliations } from "../../../src/db/schema";
import {
  completeReconciliation,
  computeReconciliation,
  createReconciliation,
} from "../../../src/bank/reconcile";
import { parseDollars } from "../../../src/lib/cents";
import { runAction, fdRequired } from "../../../src/ui/action";
import { Banner } from "../../../src/ui/banner";
import { money, type Sp } from "../../../src/ui/fmt";

export const dynamic = "force-dynamic";

async function createAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/reconcile", async () => {
    const id = await createReconciliation(
      getDb(),
      Number(fdRequired(formData, "bankAccountId")),
      fdRequired(formData, "statementDate"),
      parseDollars(fdRequired(formData, "statementBalance")),
    );
    return `reconciliation #${id} started`;
  });
}

async function completeAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/reconcile", async () => {
    await completeReconciliation(getDb(), Number(fdRequired(formData, "id")));
    return "reconciled to the cent ✓";
  });
}

export default async function ReconcilePage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const db = getDb();
  const banks = await db.select().from(bankAccounts);
  const bankName = new Map(banks.map((b) => [b.id, b.name]));
  const recs = await db
    .select()
    .from(reconciliations)
    .orderBy(desc(reconciliations.id))
    .limit(24);
  const openComputed = await Promise.all(
    recs.filter((r) => r.status === "open").map((r) => computeReconciliation(db, r.id)),
  );
  const computedById = new Map(openComputed.map((c) => [c.reconciliationId, c]));

  return (
    <>
      <h1>Reconciliation</h1>
      <Banner sp={sp} />
      <div className="panel">
        <form className="inline" action={createAction}>
          <label className="field">
            bank account
            <select name="bankAccountId" required>
              {banks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            statement date (month-end)
            <input type="date" name="statementDate" required />
          </label>
          <label className="field">
            statement closing balance $
            <input name="statementBalance" required size={12} />
          </label>
          <button type="submit">Start reconciliation</button>
        </form>
      </div>

      {recs.map((r) => {
        const c = computedById.get(r.id);
        return (
          <div className="panel" key={r.id}>
            <div>
              <span className={"badge " + r.status}>{r.status}</span>{" "}
              <strong>{bankName.get(r.bankAccountId)}</strong> — statement {r.statementDate},
              balance {money(r.statementBalance)}
            </div>
            {c !== undefined && (
              <>
                <p className="small">
                  ledger {money(c.ledgerBalance)} · difference{" "}
                  <strong>{money(c.difference)}</strong> · unexplained{" "}
                  <strong>{money(c.unexplained)}</strong>
                </p>
                {c.openItems.length > 0 && (
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Description</th>
                        <th>Status</th>
                        <th className="num">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.openItems.map((i) => (
                        <tr key={i.txnId.toString()}>
                          <td className="mono small">{i.txnDate}</td>
                          <td className="small">{i.description}</td>
                          <td>
                            <span className={"badge " + i.status}>{i.status}</span>
                          </td>
                          <td className="num">{money(i.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <form action={completeAction} style={{ marginTop: ".5rem" }}>
                  <input type="hidden" name="id" value={r.id} />
                  <button type="submit">Complete (requires zero difference)</button>
                </form>
              </>
            )}
            {r.status === "completed" && (
              <p className="small muted">
                completed {r.completedAt?.toISOString().slice(0, 10)} · ledger{" "}
                {r.ledgerBalance !== null ? money(r.ledgerBalance) : ""} · difference $0.00
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}
