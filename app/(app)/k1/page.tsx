import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../src/db/client";
import {
  basisRollforwards,
  investees as investeesTable,
  k1Fields,
  k1s,
} from "../../../src/db/schema";
import {
  box19Reconciliation,
  confirmK1,
  createK1,
  postK1,
  rollForwardBasis,
  setK1Fields,
} from "../../../src/k1/k1";
import { extractK1 } from "../../../src/k1/extract";
import { storeDocument, linkDocument } from "../../../src/vault/store";
import { parseDollars } from "../../../src/lib/cents";
import { runAction, fd, fdRequired } from "../../../src/ui/action";
import { Banner } from "../../../src/ui/banner";
import { currentYear, money, spStr, type Sp } from "../../../src/ui/fmt";

export const dynamic = "force-dynamic";

async function createK1Action(formData: FormData): Promise<void> {
  "use server";
  await runAction("/k1", async () => {
    const db = getDb();
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("upload the K-1 PDF");
    const { document } = await storeDocument(db, {
      filename: file.name,
      mime: file.type || "application/pdf",
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    const id = await createK1(db, {
      investeeId: Number(fdRequired(formData, "investeeId")),
      taxYear: Number(fdRequired(formData, "taxYear")),
      documentId: document.id,
    });
    await linkDocument(db, document.id, "k1", id);
    return `K-1 #${id} created — extract or enter fields, then review every value against the PDF`;
  });
}

async function extractAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/k1", async () => {
    const s = await extractK1(getDb(), BigInt(fdRequired(formData, "k1Id")));
    return `extracted ${s.fieldCount} fields with ${s.model} (${s.lowConfidenceCount} low-confidence to review). Notes: ${s.notes}`;
  });
}

async function setFieldAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/k1", async () => {
    const cents = fd(formData, "valueDollars");
    const text = fd(formData, "valueText");
    await setK1Fields(
      getDb(),
      BigInt(fdRequired(formData, "k1Id")),
      [
        {
          boxCode: fdRequired(formData, "boxCode"),
          valueCents: cents !== "" ? parseDollars(cents) : undefined,
          valueText: text !== "" ? text : undefined,
        },
      ],
      "owner",
    );
    return `box ${fd(formData, "boxCode")} saved (owner-reviewed)`;
  });
}

async function confirmAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/k1", async () => {
    await confirmK1(getDb(), BigInt(fdRequired(formData, "k1Id")));
    return "K-1 confirmed — fields are frozen";
  });
}

async function postAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/k1", async () => {
    const { entryId } = await postK1(getDb(), BigInt(fdRequired(formData, "k1Id")));
    return `posted as journal entry #${entryId} (character preserved per box)`;
  });
}

async function basisAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/k1", async () => {
    const row = await rollForwardBasis(
      getDb(),
      Number(fdRequired(formData, "investeeId")),
      Number(fdRequired(formData, "taxYear")),
    );
    return `basis rolled: ending ${money(row.endingBasis)}, suspended losses ${money(row.suspendedLosses)}, excess distributions ${money(row.excessDistributions)}`;
  });
}

export default async function K1Page({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const db = getDb();
  const invs = await db
    .select()
    .from(investeesTable)
    .where(eq(investeesTable.entityType, "partnership"));
  const allK1s = await db.select().from(k1s).orderBy(asc(k1s.taxYear), asc(k1s.id));
  const invName = new Map(invs.map((i) => [i.id, i.name]));
  const openId = spStr(sp, "open");
  const open = allK1s.find((k) => k.id.toString() === openId) ?? allK1s[allK1s.length - 1];
  const fields = open
    ? await db.select().from(k1Fields).where(eq(k1Fields.k1Id, open.id)).orderBy(asc(k1Fields.boxCode))
    : [];
  const b19 = open && open.status !== "in_review" ? await box19Reconciliation(db, open.id) : null;
  const basis = open
    ? await db
        .select()
        .from(basisRollforwards)
        .where(eq(basisRollforwards.investeeId, open.investeeId))
    : [];

  return (
    <>
      <h1>K-1 ingestion (§4.5)</h1>
      <Banner sp={sp} />
      <div className="panel">
        <form className="inline" action={createK1Action}>
          <label className="field">
            investee (partnerships only)
            <select name="investeeId" required>
              {invs.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            tax year
            <input name="taxYear" size={6} defaultValue={String(currentYear() - 1)} required />
          </label>
          <label className="field">
            K-1 PDF
            <input type="file" name="file" accept="application/pdf" required />
          </label>
          <button type="submit">Upload K-1</button>
        </form>
      </div>

      <h2>K-1s</h2>
      <table>
        <thead>
          <tr>
            <th>Id</th>
            <th>Investee</th>
            <th>Year</th>
            <th>Status</th>
            <th>PDF</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {allK1s.map((k) => (
            <tr key={k.id.toString()}>
              <td className="mono">#{k.id.toString()}</td>
              <td>{invName.get(k.investeeId)}</td>
              <td>{k.taxYear}</td>
              <td>
                <span className={"badge " + (k.status === "posted" ? "completed" : k.status === "confirmed" ? "proposed" : "unreviewed")}>
                  {k.status}
                </span>
              </td>
              <td>
                <a href={`/documents/${k.documentId}`} target="_blank">
                  open PDF
                </a>
              </td>
              <td>
                <a href={`/k1?open=${k.id}`}>review</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {open && (
        <>
          <h2>
            Review #{open.id.toString()} — {invName.get(open.investeeId)} {open.taxYear}{" "}
            <a href={`/documents/${open.documentId}`} target="_blank" className="small">
              (open the PDF beside this screen)
            </a>
          </h2>
          {open.status === "in_review" && (
            <div className="panel">
              <form className="inline" action={extractAction}>
                <input type="hidden" name="k1Id" value={open.id.toString()} />
                <button type="submit">Extract with Claude</button>
                <span className="muted small">
                  model from config (<span className="mono">anthropic_model_id</span>); needs
                  ANTHROPIC_API_KEY. Every low-confidence value must be reviewed by you before
                  confirmation — nothing posts from extraction alone.
                </span>
              </form>
            </div>
          )}
          <table>
            <thead>
              <tr>
                <th>Box</th>
                <th>Label</th>
                <th className="num">Amount</th>
                <th>Text</th>
                <th>Confidence</th>
                <th>Reviewed</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr
                  key={f.boxCode}
                  style={
                    f.confidence === "low" && !f.ownerTouched
                      ? { background: "#fff6e5" }
                      : undefined
                  }
                >
                  <td className="mono">{f.boxCode}</td>
                  <td className="small">{f.label}</td>
                  <td className="num">{f.valueCents !== null ? money(f.valueCents) : ""}</td>
                  <td className="small">{f.valueText}</td>
                  <td>
                    <span className={"badge " + (f.confidence === "low" ? "flagged" : "completed")}>
                      {f.confidence}
                    </span>
                  </td>
                  <td>{f.ownerTouched ? "✓ owner" : f.confidence === "low" ? "required" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {open.status === "in_review" && (
            <div className="panel">
              <form className="inline" action={setFieldAction}>
                <input type="hidden" name="k1Id" value={open.id.toString()} />
                <label className="field">
                  box code
                  <input name="boxCode" size={8} required placeholder="1, 13J, L.ending" />
                </label>
                <label className="field">
                  amount $
                  <input name="valueDollars" size={12} />
                </label>
                <label className="field">
                  text value
                  <input name="valueText" size={10} />
                </label>
                <button type="submit">Save field (marks reviewed)</button>
              </form>
              <form className="inline" action={confirmAction} style={{ marginTop: ".5rem" }}>
                <input type="hidden" name="k1Id" value={open.id.toString()} />
                <button type="submit">Confirm K-1 (freezes fields)</button>
              </form>
            </div>
          )}
          {open.status === "confirmed" && (
            <form className="inline panel" action={postAction}>
              <input type="hidden" name="k1Id" value={open.id.toString()} />
              <button type="submit">Post to ledger (character preserved)</button>
            </form>
          )}
          {b19 && (
            <div className="panel">
              <strong>Box 19 vs classified wires:</strong> K-1 {money(b19.k1Distributions)} · wires{" "}
              {money(b19.bankClassifiedWires)} · difference{" "}
              <strong>{money(b19.difference)}</strong>{" "}
              {b19.explanationNeeded ? (
                <span className="badge flagged">explain in the CPA package</span>
              ) : (
                <span className="badge completed">reconciled</span>
              )}
            </div>
          )}
          <div className="panel">
            <form className="inline" action={basisAction}>
              <input type="hidden" name="investeeId" value={open.investeeId} />
              <input type="hidden" name="taxYear" value={open.taxYear} />
              <button className="secondary" type="submit">
                Roll outside basis for {open.taxYear}
              </button>
            </form>
            {basis.length > 0 && (
              <table style={{ marginTop: ".5rem" }}>
                <thead>
                  <tr>
                    <th>Year</th>
                    <th className="num">Beginning</th>
                    <th className="num">Income</th>
                    <th className="num">Distributions</th>
                    <th className="num">Losses allowed</th>
                    <th className="num">Suspended</th>
                    <th className="num">Ending</th>
                    <th className="num">Item L (reported)</th>
                  </tr>
                </thead>
                <tbody>
                  {basis
                    .sort((a, b) => a.taxYear - b.taxYear)
                    .map((b) => (
                      <tr key={b.taxYear}>
                        <td>{b.taxYear}</td>
                        <td className="num">{money(b.beginningBasis)}</td>
                        <td className="num">{money(b.incomeItems + b.taxExemptIncome)}</td>
                        <td className="num">{money(b.distributionsApplied + b.excessDistributions)}</td>
                        <td className="num">{money(b.lossDeductionItems)}</td>
                        <td className="num">{money(b.suspendedLosses)}</td>
                        <td className="num">{money(b.endingBasis)}</td>
                        <td className="num muted">
                          {b.reportedCapitalAccount !== null ? money(b.reportedCapitalAccount) : "—"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </>
  );
}
