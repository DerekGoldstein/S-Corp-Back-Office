import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../src/db/client";
import {
  accounts as accountsTable,
  bankAccounts,
  bankTransactions,
  classificationRules,
} from "../../../src/db/schema";
import { classifyTransaction, flagTransaction } from "../../../src/bank/classify";
import { generateRuleSuggestions, runRules } from "../../../src/bank/rules";
import { matchTransfers } from "../../../src/bank/transfers";
import { storeDocument, linkDocument } from "../../../src/vault/store";
import { runAction, fd, fdRequired } from "../../../src/ui/action";
import { Banner } from "../../../src/ui/banner";
import { formatCents } from "../../../src/lib/cents";
import type { Sp } from "../../../src/ui/fmt";

export const dynamic = "force-dynamic";

async function classifyAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/queue", async () => {
    const db = getDb();
    const txnId = BigInt(fdRequired(formData, "txnId"));
    const documentIds: bigint[] = [];
    const receipt = formData.get("receipt");
    if (receipt instanceof File && receipt.size > 0) {
      const { document } = await storeDocument(db, {
        filename: receipt.name,
        mime: receipt.type || "application/octet-stream",
        bytes: Buffer.from(await receipt.arrayBuffer()),
      });
      await linkDocument(db, document.id, "bank_transaction", txnId);
      documentIds.push(document.id);
    }
    const tag = fd(formData, "ownerPaymentTag");
    const matchEntry = fd(formData, "matchEntryId");
    const { entryId } = await classifyTransaction(db, txnId, {
      targetAccountCode: fd(formData, "target") || undefined,
      memo: fd(formData, "memo") || undefined,
      ownerPaymentTag:
        tag === "payroll_net_pay" || tag === "distribution" || tag === "reimbursement"
          ? tag
          : undefined,
      matchEntryId: matchEntry !== "" ? BigInt(matchEntry) : undefined,
      documentIds,
    });
    return `posted as journal entry #${entryId}`;
  });
}

async function flagAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/queue", async () => {
    await flagTransaction(getDb(), BigInt(fdRequired(formData, "txnId")), fdRequired(formData, "note"));
    return "flagged as personal — fix at the bank (§8 zero commingling)";
  });
}

async function runRulesAction(): Promise<void> {
  "use server";
  await runAction("/queue", async () => {
    const r = await runRules(getDb());
    return `rules: ${r.autoPosted} auto-posted, ${r.proposed} proposed` +
      (r.autoFailed.length > 0 ? `, ${r.autoFailed.length} auto-post blocked by guards` : "");
  });
}

async function matchTransfersAction(): Promise<void> {
  "use server";
  await runAction("/queue", async () => {
    const m = await matchTransfers(getDb());
    return `matched ${m.length} transfer pair(s)`;
  });
}

async function suggestAction(): Promise<void> {
  "use server";
  await runAction("/queue", async () => {
    const n = await generateRuleSuggestions(getDb());
    return n > 0 ? `${n} new rule suggestion(s) — see Rules` : "no new suggestions yet";
  });
}

export default async function QueuePage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const db = getDb();
  const txns = await db
    .select()
    .from(bankTransactions)
    .where(inArray(bankTransactions.status, ["unreviewed", "proposed"]))
    .orderBy(asc(bankTransactions.txnDate), asc(bankTransactions.id));
  const accounts = (
    await db.select().from(accountsTable).where(eq(accountsTable.active, true))
  ).sort((a, b) => a.code.localeCompare(b.code));
  const banks = new Map(
    (await db.select().from(bankAccounts)).map((b) => [b.id, b.name]),
  );
  const rules = new Map(
    (await db.select().from(classificationRules)).map((r) => [r.id, r.name]),
  );
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  return (
    <>
      <h1>Classification queue</h1>
      <Banner sp={sp} />
      <div className="panel">
        <form className="inline" action={runRulesAction}>
          <button type="submit">Run rules</button>
        </form>{" "}
        <form className="inline" action={matchTransfersAction}>
          <button className="secondary" type="submit">
            Match transfers
          </button>
        </form>{" "}
        <form className="inline" action={suggestAction}>
          <button className="secondary" type="submit">
            Suggest rules
          </button>
        </form>
        <p className="muted small">
          Nothing posts without your confirmation, except rules you have explicitly flagged
          auto-post — and those run the exact same guards.
        </p>
      </div>
      {txns.length === 0 && <p>Queue is empty — import a statement or relax.</p>}
      {txns.map((t) => {
        const proposedAccount =
          t.proposal !== null ? accountById.get(t.proposal.targetAccountId) : undefined;
        return (
          <div className="panel" key={t.id.toString()}>
            <div>
              <span className={"badge " + t.status}>{t.status}</span>{" "}
              <strong className="mono">{t.txnDate}</strong>{" "}
              <span className="mono">{t.amount < 0n ? "−" : "+"}${formatCents(t.amount < 0n ? -t.amount : t.amount)}</span>{" "}
              — {t.descriptionRaw}{" "}
              <span className="muted small">({banks.get(t.bankAccountId)})</span>
              {t.isOwnerPayee && t.amount < 0n && (
                <span className="badge flagged"> owner payment — tag required</span>
              )}
              {t.status === "proposed" && proposedAccount !== undefined && (
                <div className="small muted">
                  proposed: {proposedAccount.code} {proposedAccount.name}
                  {t.matchedRuleId !== null ? ` (rule: ${rules.get(t.matchedRuleId)})` : ""}
                </div>
              )}
            </div>
            <form className="inline" action={classifyAction} style={{ marginTop: ".5rem" }}>
              <input type="hidden" name="txnId" value={t.id.toString()} />
              <label className="field">
                account
                <select name="target" defaultValue={proposedAccount?.code ?? ""}>
                  <option value="">— choose —</option>
                  {accounts.map((a) => (
                    <option key={a.code} value={a.code}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                memo
                <input name="memo" defaultValue={t.proposal?.memo ?? ""} size={28} />
              </label>
              {t.isOwnerPayee && t.amount < 0n && (
                <label className="field">
                  owner tag
                  <select name="ownerPaymentTag" defaultValue={t.proposal?.ownerPaymentTag ?? ""}>
                    <option value="">— required —</option>
                    <option value="distribution">distribution (3200)</option>
                    <option value="reimbursement">reimbursement (2190)</option>
                    <option value="payroll_net_pay">payroll net pay (match entry)</option>
                  </select>
                </label>
              )}
              {t.isOwnerPayee && t.amount < 0n && (
                <label className="field">
                  payroll entry #
                  <input name="matchEntryId" size={6} />
                </label>
              )}
              <label className="field">
                receipt (if required)
                <input type="file" name="receipt" />
              </label>
              <button type="submit">Post</button>
            </form>
            <form className="inline" action={flagAction} style={{ marginTop: ".4rem" }}>
              <input type="hidden" name="txnId" value={t.id.toString()} />
              <label className="field">
                personal? note
                <input name="note" size={30} placeholder="why this is personal" />
              </label>
              <button className="danger" type="submit">
                Flag personal
              </button>
            </form>
          </div>
        );
      })}
    </>
  );
}
