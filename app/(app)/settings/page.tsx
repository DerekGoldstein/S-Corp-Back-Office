import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../src/db/client";
import {
  accounts as accountsTable,
  appConfig,
  bankAccounts,
  investees as investeesTable,
  periods,
  type CsvImportProfile,
} from "../../../src/db/schema";
import { createInvestee } from "../../../src/ledger/investees";
import { lockPeriod, unlockPeriod } from "../../../src/ledger/periods";
import { isReconciledThrough } from "../../../src/bank/reconcile";
import { runAction, fd, fdRequired } from "../../../src/ui/action";
import { Banner } from "../../../src/ui/banner";
import { currentYear, spStr, type Sp } from "../../../src/ui/fmt";

export const dynamic = "force-dynamic";

async function createBankAccountAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/settings", async () => {
    const db = getDb();
    const code = fdRequired(formData, "ledgerCode");
    const [ledger] = await db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.code, code));
    if (!ledger) throw new Error(`unknown ledger account ${code}`);
    if (ledger.type !== "asset") throw new Error(`${code} is not an asset account`);
    const profileRaw = fd(formData, "profile");
    let profile: CsvImportProfile | null = null;
    if (profileRaw !== "") {
      profile = JSON.parse(profileRaw) as CsvImportProfile;
      if (!profile.dateColumn || !profile.descriptionColumns) {
        throw new Error("profile needs at least dateColumn, dateFormat, descriptionColumns");
      }
    }
    await db.insert(bankAccounts).values({
      name: fdRequired(formData, "name"),
      ledgerAccountId: ledger.id,
      institution: fd(formData, "institution") || null,
      mask: fd(formData, "mask") || null,
      importProfile: profile,
    });
    return "bank account created";
  });
}

async function createInvesteeAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/settings", async () => {
    const entityType = fdRequired(formData, "entityType");
    const r = await createInvestee(getDb(), {
      name: fdRequired(formData, "name"),
      ein: fd(formData, "ein") || undefined,
      entityType: entityType as "partnership" | "c_corporation" | "s_corporation",
      ownershipPct: fdRequired(formData, "ownershipPct"),
      acquiredOn: fdRequired(formData, "acquiredOn"),
      counterpartyRegex: fd(formData, "counterpartyRegex") || undefined,
    });
    return `investee created with investment account ${r.accountCode}`;
  });
}

async function setConfigAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/settings", async () => {
    const db = getDb();
    const key = fdRequired(formData, "key");
    const value = fdRequired(formData, "value");
    if (key === "owner_payee_regex") new RegExp(value, "i"); // validate
    await db
      .insert(appConfig)
      .values({ key, value })
      .onConflictDoUpdate({ target: appConfig.key, set: { value, updatedAt: new Date() } });
    return `config ${key} saved`;
  });
}

async function lockAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/settings", async () => {
    const db = getDb();
    const year = Number(fdRequired(formData, "year"));
    const month = Number(fdRequired(formData, "month"));
    const banks = await db.select().from(bankAccounts);
    for (const b of banks) {
      if (!(await isReconciledThrough(db, b.id, year, month))) {
        throw new Error(
          `${b.name} is not reconciled through ${year}-${String(month).padStart(2, "0")} — complete the reconciliation first`,
        );
      }
    }
    await lockPeriod(db, year, month);
    return `period ${year}-${String(month).padStart(2, "0")} locked`;
  });
}

async function unlockAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/settings", async () => {
    await unlockPeriod(
      getDb(),
      Number(fdRequired(formData, "year")),
      Number(fdRequired(formData, "month")),
      fdRequired(formData, "reason"),
    );
    return "period unlocked (audited)";
  });
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const db = getDb();
  const banks = await db.select().from(bankAccounts);
  const accountName = new Map(
    (await db.select().from(accountsTable)).map((a) => [a.id, `${a.code} ${a.name}`]),
  );
  const invs = await db.select().from(investeesTable);
  const config = await db.select().from(appConfig).orderBy(asc(appConfig.key));
  const year = Number(spStr(sp, "year", String(currentYear())));
  const periodRows = await db
    .select()
    .from(periods)
    .where(eq(periods.taxYear, year));
  const lockedByMonth = new Map(periodRows.map((p) => [p.month, p.locked]));

  return (
    <>
      <h1>Settings</h1>
      <Banner sp={sp} />

      <h2>Bank accounts</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Ledger account</th>
            <th>Institution</th>
            <th>CSV profile</th>
          </tr>
        </thead>
        <tbody>
          {banks.map((b) => (
            <tr key={b.id}>
              <td>{b.name}</td>
              <td>{accountName.get(b.ledgerAccountId)}</td>
              <td>{b.institution}</td>
              <td className="mono small">
                {b.importProfile !== null ? JSON.stringify(b.importProfile) : "— (OFX only)"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="panel">
        <form className="inline" action={createBankAccountAction}>
          <label className="field">
            name
            <input name="name" required size={18} />
          </label>
          <label className="field">
            ledger account code
            <input name="ledgerCode" required size={6} defaultValue="1000" />
          </label>
          <label className="field">
            institution
            <input name="institution" size={12} />
          </label>
          <label className="field">
            mask
            <input name="mask" size={6} />
          </label>
          <label className="field" style={{ minWidth: "26rem" }}>
            CSV profile JSON (leave empty for OFX-only)
            <textarea
              name="profile"
              rows={3}
              placeholder='{"dateColumn":"Posting Date","dateFormat":"MDY","descriptionColumns":["Description"],"amountColumn":"Amount"}'
            />
          </label>
          <button type="submit">Add bank account</button>
        </form>
      </div>

      <h2>Investees</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th className="num">Ownership %</th>
            <th>Acquired</th>
            <th>Wire match regex</th>
          </tr>
        </thead>
        <tbody>
          {invs.map((i) => (
            <tr key={i.id}>
              <td>{i.name}</td>
              <td>{i.entityType}</td>
              <td className="num">{i.ownershipPct}</td>
              <td className="mono small">{i.acquiredOn}</td>
              <td className="mono small">{i.counterpartyRegex}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="panel">
        <form className="inline" action={createInvesteeAction}>
          <label className="field">
            name
            <input name="name" required size={18} />
          </label>
          <label className="field">
            EIN
            <input name="ein" size={11} />
          </label>
          <label className="field">
            entity type
            <select name="entityType">
              <option value="partnership">partnership / LLC (1065)</option>
              <option value="c_corporation">C corporation</option>
              <option value="s_corporation">S corporation (will be refused)</option>
            </select>
          </label>
          <label className="field">
            ownership %
            <input name="ownershipPct" size={7} required />
          </label>
          <label className="field">
            acquired
            <input type="date" name="acquiredOn" required />
          </label>
          <label className="field">
            wire counterparty regex
            <input name="counterpartyRegex" size={18} placeholder="FACTORING LLC" />
          </label>
          <button type="submit">Add investee</button>
        </form>
        <p className="muted small">
          Creates the per-investee 15xx investment account automatically. Incoming wires matching
          the regex are forced to that account — never revenue (§4.2).
        </p>
      </div>

      <h2>Configuration</h2>
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {config.map((c) => (
            <tr key={c.key}>
              <td className="mono">{c.key}</td>
              <td className="mono small">{c.encrypted ? "•••••" : c.value}</td>
              <td className="mono small">{c.updatedAt.toISOString().slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="panel">
        <form className="inline" action={setConfigAction}>
          <label className="field">
            key
            <input name="key" required size={22} defaultValue="owner_payee_regex" />
          </label>
          <label className="field">
            value
            <input name="value" required size={30} placeholder="DEREK|GOLDSTEIN|TO OWNER" />
          </label>
          <button type="submit">Save</button>
        </form>
        <p className="muted small">
          <span className="mono">owner_payee_regex</span> marks imported transactions as owner
          payments, which then refuse to post untagged (§4.2). Answers from NYS DOL/WCB (SUI
          treatment of 2% health premiums, DBL/PFL/WC applicability) also live here when confirmed.
        </p>
      </div>

      <h2>Period locks — {year}</h2>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Month</th>
              <th>Status</th>
              <th>Lock / unlock</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <tr key={m}>
                <td className="mono">
                  {year}-{String(m).padStart(2, "0")}
                </td>
                <td>
                  {lockedByMonth.get(m) === true ? (
                    <span className="badge completed">locked</span>
                  ) : (
                    <span className="badge open">open</span>
                  )}
                </td>
                <td>
                  {lockedByMonth.get(m) === true ? (
                    <form className="inline" action={unlockAction}>
                      <input type="hidden" name="year" value={year} />
                      <input type="hidden" name="month" value={m} />
                      <input name="reason" size={24} placeholder="reason (audited)" required />
                      <button className="danger" type="submit">
                        Unlock
                      </button>
                    </form>
                  ) : (
                    <form className="inline" action={lockAction}>
                      <input type="hidden" name="year" value={year} />
                      <input type="hidden" name="month" value={m} />
                      <button className="secondary" type="submit">
                        Lock
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          Locking requires every bank account reconciled through the month; the database then
          rejects any entry dated inside it.
        </p>
      </div>
    </>
  );
}
