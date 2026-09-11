import { desc } from "drizzle-orm";
import { getDb } from "../../../src/db/client";
import { compMethodologies, corporateRecords } from "../../../src/db/schema";
import {
  generatePreYearConsent,
  generateRecord,
  renderAccountablePlanPolicy,
  standingDocumentGaps,
} from "../../../src/records/templates";
import { storeDocument, linkDocument } from "../../../src/vault/store";
import { runAction, fd, fdRequired } from "../../../src/ui/action";
import { Banner } from "../../../src/ui/banner";
import { currentYear, todayISO, type Sp } from "../../../src/ui/fmt";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

async function generatePolicyAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/records", async () => {
    const html = renderAccountablePlanPolicy({
      entityName: fdRequired(formData, "entityName"),
      memberName: fdRequired(formData, "memberName"),
      adoptedOn: fdRequired(formData, "adoptedOn"),
      effectiveFrom: fdRequired(formData, "effectiveFrom"),
      substantiationWindowDays: Number(fd(formData, "substantiation") || "60"),
      reimbursementWindowDays: Number(fd(formData, "excessReturn") || "120"),
      categories: fdRequired(formData, "categories")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    });
    const r = await generateRecord(getDb(), {
      kind: "accountable_plan_policy",
      taxYear: Number(fdRequired(formData, "effectiveFrom").slice(0, 4)),
      title: `Accountable plan policy (effective ${fdRequired(formData, "effectiveFrom")})`,
      html,
      data: Object.fromEntries(formData.entries()) as Record<string, unknown>,
    });
    return `policy generated as document #${r.documentId} (${r.mime}) — print, sign, and upload the signed copy`;
  });
}

async function generateConsentAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/records", async () => {
    const r = await generatePreYearConsent(getDb(), {
      entityName: fdRequired(formData, "entityName"),
      memberName: fdRequired(formData, "memberName"),
      consentYear: Number(fdRequired(formData, "consentYear")),
      signedOn: fdRequired(formData, "signedOn"),
      methodologyId: Number(fdRequired(formData, "methodologyId")),
      deferral401kElection: fdRequired(formData, "deferral"),
      accountablePlanAdoptedOn: fdRequired(formData, "planAdoptedOn"),
      deMinimisElection: formData.get("deMinimis") === "on",
      ptetNote: fd(formData, "ptetNote") || undefined,
    });
    return `pre-year consent generated as document #${r.documentId} — sign before January 1`;
  });
}

async function uploadStandingAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/records", async () => {
    const db = getDb();
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("choose the document file");
    const standingKind = fdRequired(formData, "standingKind");
    const { document } = await storeDocument(db, {
      filename: file.name,
      mime: file.type || "application/octet-stream",
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    const [record] = await db
      .insert(corporateRecords)
      .values({
        kind: "standing",
        standingKind,
        title: fd(formData, "title") || file.name,
        documentId: document.id,
        status: "signed",
        signedOn: todayISO(),
      })
      .returning({ id: corporateRecords.id });
    await linkDocument(db, document.id, "corporate_record", record!.id);
    return `standing document filed (${standingKind})`;
  });
}

async function markSignedAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/records", async () => {
    const db = getDb();
    const id = Number(fdRequired(formData, "id"));
    const file = formData.get("file");
    let note = "";
    if (file instanceof File && file.size > 0) {
      const { document } = await storeDocument(db, {
        filename: file.name,
        mime: file.type || "application/pdf",
        bytes: Buffer.from(await file.arrayBuffer()),
      });
      await linkDocument(db, document.id, "corporate_record", id);
      note = ` (signed copy vaulted as document #${document.id})`;
    }
    await db
      .update(corporateRecords)
      .set({ status: "signed", signedOn: fdRequired(formData, "signedOn") })
      .where(eq(corporateRecords.id, id));
    return `record marked signed${note}`;
  });
}

export default async function RecordsPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const db = getDb();
  const gaps = await standingDocumentGaps(db);
  const records = await db
    .select()
    .from(corporateRecords)
    .orderBy(desc(corporateRecords.id))
    .limit(30);
  const methodologies = await db.select().from(compMethodologies);
  const year = currentYear();

  return (
    <>
      <h1>Corporate records (§4.9)</h1>
      <Banner sp={sp} />

      <h2>Records</h2>
      <table>
        <thead>
          <tr>
            <th>Kind</th>
            <th>Title</th>
            <th>Year</th>
            <th>Status</th>
            <th>Document</th>
            <th>Mark signed</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.id}>
              <td className="small">{r.kind === "standing" ? `standing: ${r.standingKind}` : r.kind}</td>
              <td>{r.title}</td>
              <td>{r.taxYear ?? ""}</td>
              <td>
                <span className={"badge " + (r.status === "signed" ? "completed" : "unreviewed")}>
                  {r.status}
                  {r.signedOn !== null ? ` ${r.signedOn}` : ""}
                </span>
              </td>
              <td>
                {r.documentId !== null && (
                  <a href={`/documents/${r.documentId}`}>download #{r.documentId.toString()}</a>
                )}
              </td>
              <td>
                {r.status !== "signed" && (
                  <form className="inline" action={markSignedAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="date" name="signedOn" defaultValue={todayISO()} required />
                    <input type="file" name="file" title="signed copy (optional)" />
                    <button className="secondary" type="submit">
                      Signed
                    </button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Standing documents{gaps.length > 0 ? ` — ${gaps.length} missing` : " — complete ✓"}</h2>
      <div className="panel">
        <form className="inline" action={uploadStandingAction}>
          <label className="field">
            kind
            <select name="standingKind" required>
              {gaps.map((g) => (
                <option key={g.standingKind} value={g.standingKind}>
                  {g.label}
                </option>
              ))}
              <option value="other">other</option>
            </select>
          </label>
          <label className="field">
            title
            <input name="title" size={26} />
          </label>
          <label className="field">
            file
            <input type="file" name="file" required />
          </label>
          <button type="submit">File standing document</button>
        </form>
      </div>

      <h2>Generate: accountable-plan policy</h2>
      <div className="panel">
        <form className="inline" action={generatePolicyAction}>
          <label className="field">
            entity name
            <input name="entityName" required size={22} />
          </label>
          <label className="field">
            member name
            <input name="memberName" required size={18} />
          </label>
          <label className="field">
            adopted on
            <input type="date" name="adoptedOn" defaultValue={todayISO()} required />
          </label>
          <label className="field">
            effective from
            <input type="date" name="effectiveFrom" defaultValue={`${year + 1}-01-01`} required />
          </label>
          <label className="field">
            substantiation days
            <input name="substantiation" size={4} defaultValue="60" />
          </label>
          <label className="field">
            excess-return days
            <input name="excessReturn" size={4} defaultValue="120" />
          </label>
          <label className="field">
            categories (comma-sep)
            <input
              name="categories"
              size={45}
              defaultValue="home office, phone, internet, supplies, health insurance premiums"
            />
          </label>
          <button type="submit">Generate policy</button>
        </form>
      </div>

      <h2>Generate: pre-year consent</h2>
      <div className="panel">
        {methodologies.length === 0 ? (
          <p className="muted">
            Create the comp methodology under <a href="/time">Time &amp; comp</a> first — the
            consent adopts it by version.
          </p>
        ) : (
          <form className="inline" action={generateConsentAction}>
            <label className="field">
              entity name
              <input name="entityName" required size={22} />
            </label>
            <label className="field">
              member name
              <input name="memberName" required size={18} />
            </label>
            <label className="field">
              consent year
              <input name="consentYear" size={5} defaultValue={String(year + 1)} />
            </label>
            <label className="field">
              signed on
              <input type="date" name="signedOn" defaultValue={todayISO()} required />
            </label>
            <label className="field">
              methodology
              <select name="methodologyId">
                {methodologies.map((m) => (
                  <option key={m.id} value={m.id}>
                    v{m.version} {m.frozen ? "(frozen)" : "(draft!)"}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              401(k) deferral election
              <input
                name="deferral"
                size={34}
                defaultValue="the annual employee elective deferral limit"
              />
            </label>
            <label className="field">
              plan adopted on
              <input type="date" name="planAdoptedOn" required />
            </label>
            <label className="field">
              <span>
                <input type="checkbox" name="deMinimis" defaultChecked /> de minimis election
              </span>
            </label>
            <label className="field">
              PTET note (optional)
              <input name="ptetNote" size={30} />
            </label>
            <button type="submit">Generate consent</button>
          </form>
        )}
      </div>
    </>
  );
}
