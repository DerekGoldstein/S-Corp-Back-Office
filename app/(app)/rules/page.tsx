import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../src/db/client";
import {
  accounts as accountsTable,
  bankAccounts,
  classificationRules,
  ruleSuggestions,
} from "../../../src/db/schema";
import { acceptSuggestion, dismissSuggestion } from "../../../src/bank/rules";
import { parseDollars } from "../../../src/lib/cents";
import { runAction, fd, fdRequired } from "../../../src/ui/action";
import { Banner } from "../../../src/ui/banner";
import { money, type Sp } from "../../../src/ui/fmt";

export const dynamic = "force-dynamic";

async function createRuleAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/rules", async () => {
    const db = getDb();
    const code = fdRequired(formData, "target");
    const [target] = await db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.code, code));
    if (!target) throw new Error(`unknown account ${code}`);
    const regex = fdRequired(formData, "regex");
    new RegExp(regex, "i"); // validate
    const amountMin = fd(formData, "amountMin");
    const amountMax = fd(formData, "amountMax");
    const tag = fd(formData, "ownerPaymentTag");
    const bank = fd(formData, "bankAccountId");
    await db.insert(classificationRules).values({
      name: fdRequired(formData, "name"),
      descriptionRegex: regex,
      amountMin: amountMin !== "" ? parseDollars(amountMin) : null,
      amountMax: amountMax !== "" ? parseDollars(amountMax) : null,
      bankAccountId: bank !== "" ? Number(bank) : null,
      targetAccountId: target.id,
      memoTemplate: fd(formData, "memo") || null,
      ownerPaymentTag:
        tag === "payroll_net_pay" || tag === "distribution" || tag === "reimbursement"
          ? tag
          : null,
      autoPost: formData.get("autoPost") === "on",
      priority: Number(fd(formData, "priority") || "100"),
    });
    return "rule created";
  });
}

async function toggleRuleAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/rules", async () => {
    const db = getDb();
    const id = Number(fdRequired(formData, "id"));
    const [rule] = await db
      .select()
      .from(classificationRules)
      .where(eq(classificationRules.id, id));
    if (!rule) throw new Error("rule not found");
    await db
      .update(classificationRules)
      .set({ active: !rule.active })
      .where(eq(classificationRules.id, id));
    return rule.active ? "rule deactivated" : "rule activated";
  });
}

async function acceptSuggestionAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/rules", async () => {
    const { ruleId } = await acceptSuggestion(getDb(), Number(fdRequired(formData, "id")), {
      autoPost: formData.get("autoPost") === "on",
    });
    return `suggestion accepted as rule #${ruleId}`;
  });
}

async function dismissSuggestionAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/rules", async () => {
    await dismissSuggestion(getDb(), Number(fdRequired(formData, "id")));
    return "suggestion dismissed";
  });
}

export default async function RulesPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const db = getDb();
  const rules = await db
    .select()
    .from(classificationRules)
    .orderBy(asc(classificationRules.priority), asc(classificationRules.id));
  const suggestions = await db
    .select()
    .from(ruleSuggestions)
    .where(eq(ruleSuggestions.status, "pending"));
  const accounts = await db.select().from(accountsTable);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const banks = await db.select().from(bankAccounts);
  const bankName = new Map(banks.map((b) => [b.id, b.name]));

  return (
    <>
      <h1>Classification rules</h1>
      <Banner sp={sp} />
      {suggestions.length > 0 && (
        <>
          <h2>Suggestions (from your repeated manual classifications)</h2>
          {suggestions.map((s) => (
            <div className="panel" key={s.id}>
              <span className="mono">{s.descriptionRegex}</span> →{" "}
              {accountById.get(s.targetAccountId)?.code}{" "}
              {accountById.get(s.targetAccountId)?.name}
              <span className="muted small">
                {" "}
                ({s.sampleTxnIds.length} samples
                {s.amountMin !== null ? `, ${money(s.amountMin)}–${money(s.amountMax ?? 0n)}` : ""})
              </span>
              <form className="inline" action={acceptSuggestionAction} style={{ marginTop: ".4rem" }}>
                <input type="hidden" name="id" value={s.id} />
                <label className="field">
                  <span>
                    <input type="checkbox" name="autoPost" /> auto-post (owner flag, §8)
                  </span>
                </label>
                <button type="submit">Accept as rule</button>
              </form>
              <form className="inline" action={dismissSuggestionAction}>
                <input type="hidden" name="id" value={s.id} />
                <button className="secondary" type="submit">
                  Dismiss
                </button>
              </form>
            </div>
          ))}
        </>
      )}

      <h2>Rules</h2>
      <table>
        <thead>
          <tr>
            <th>Pri</th>
            <th>Name</th>
            <th>Match</th>
            <th>Target</th>
            <th>Tag</th>
            <th>Auto</th>
            <th className="num">Applied</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id} style={r.active ? undefined : { opacity: 0.5 }}>
              <td className="num">{r.priority}</td>
              <td>{r.name}</td>
              <td className="mono small">
                {r.descriptionRegex}
                {r.bankAccountId !== null ? ` @${bankName.get(r.bankAccountId)}` : ""}
                {r.amountMin !== null || r.amountMax !== null
                  ? ` [${r.amountMin !== null ? money(r.amountMin) : ""}..${r.amountMax !== null ? money(r.amountMax) : ""}]`
                  : ""}
              </td>
              <td>
                {accountById.get(r.targetAccountId)?.code}{" "}
                <span className="muted small">{accountById.get(r.targetAccountId)?.name}</span>
              </td>
              <td className="small">{r.ownerPaymentTag ?? ""}</td>
              <td>{r.autoPost ? "✓" : ""}</td>
              <td className="num">{r.timesApplied}</td>
              <td>
                <form action={toggleRuleAction}>
                  <input type="hidden" name="id" value={r.id} />
                  <button className="secondary" type="submit">
                    {r.active ? "Deactivate" : "Activate"}
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>New rule</h2>
      <div className="panel">
        <form className="inline" action={createRuleAction}>
          <label className="field">
            name
            <input name="name" required size={18} />
          </label>
          <label className="field">
            description regex
            <input name="regex" required size={24} className="mono" />
          </label>
          <label className="field">
            target account code
            <input name="target" required size={6} />
          </label>
          <label className="field">
            amount min $
            <input name="amountMin" size={8} placeholder="signed" />
          </label>
          <label className="field">
            amount max $
            <input name="amountMax" size={8} />
          </label>
          <label className="field">
            bank account
            <select name="bankAccountId">
              <option value="">any</option>
              {banks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            owner tag
            <select name="ownerPaymentTag">
              <option value="">none</option>
              <option value="distribution">distribution</option>
              <option value="reimbursement">reimbursement</option>
              <option value="payroll_net_pay">payroll net pay</option>
            </select>
          </label>
          <label className="field">
            memo template
            <input name="memo" size={18} />
          </label>
          <label className="field">
            priority
            <input name="priority" size={4} defaultValue="100" />
          </label>
          <label className="field">
            <span>
              <input type="checkbox" name="autoPost" /> auto-post
            </span>
          </label>
          <button type="submit">Create rule</button>
        </form>
      </div>
    </>
  );
}
