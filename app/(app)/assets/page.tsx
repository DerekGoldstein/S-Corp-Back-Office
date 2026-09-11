import { getDb } from "../../../src/db/client";
import {
  accumulatedByAsset,
  addAsset,
  listAssets,
  postAnnualDepreciation,
  recordDisposal,
} from "../../../src/assets/register";
import type { MacrsMethod } from "../../../src/assets/macrs";
import { buildF4562 } from "../../../src/workpapers/f4562";
import { storeDocument } from "../../../src/vault/store";
import { parseDollars } from "../../../src/lib/cents";
import { runAction, fd, fdRequired } from "../../../src/ui/action";
import { Banner } from "../../../src/ui/banner";
import { money, todayISO, currentYear, type Sp } from "../../../src/ui/fmt";

export const dynamic = "force-dynamic";

async function addAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/assets", async () => {
    const db = getDb();
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      throw new Error("attach the purchase invoice (guardrail 6)");
    }
    const { document } = await storeDocument(db, {
      filename: file.name,
      mime: file.type || "application/pdf",
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    const id = await addAsset(db, {
      description: fdRequired(formData, "description"),
      placedInService: fdRequired(formData, "placedInService"),
      cost: parseDollars(fdRequired(formData, "cost")),
      businessUsePct: fd(formData, "businessUsePct") || "100%",
      method: fdRequired(formData, "method") as MacrsMethod,
      recoveryYears: Number(fdRequired(formData, "recoveryYears")),
      section179: parseDollars(fd(formData, "section179") || "0"),
      takeBonus: fd(formData, "takeBonus") === "on",
      documentId: document.id,
      note: fd(formData, "note") || undefined,
    });
    return `asset #${id} added — depreciation posts with the annual run`;
  });
}

async function postYearAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/assets", async () => {
    const year = Number(fdRequired(formData, "taxYear"));
    const { entryId, total, assets } = await postAnnualDepreciation(getDb(), year);
    return `posted ${year} depreciation ${money(total)} across ${assets} asset(s) as entry #${entryId} (Dr 5050 / Cr 1610)`;
  });
}

async function build4562Action(formData: FormData): Promise<void> {
  "use server";
  await runAction("/assets", async () => {
    const year = Number(fdRequired(formData, "taxYear"));
    const wp = await buildF4562(getDb(), year);
    const red = wp.tieOuts.filter((x) => !x.pass).length;
    return `4562 workpaper saved for ${year}: line 22 ${wp.line22_total}, ${wp.tieOuts.length - red}/${wp.tieOuts.length} tie-outs green`;
  });
}

async function disposeAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/assets", async () => {
    await recordDisposal(getDb(), BigInt(fdRequired(formData, "id")), fdRequired(formData, "disposedOn"));
    return "disposal recorded — depreciation stops; book the disposal entry manually with the CPA (§1245 recapture)";
  });
}

export default async function AssetsPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const db = getDb();
  const assets = await listAssets(db);
  const accum = await accumulatedByAsset(db);

  return (
    <>
      <h1>Fixed assets &amp; depreciation</h1>
      <Banner sp={sp} />
      <p className="muted small">
        S-corp-era assets only (placed in service ≥ 2027) — older assets enter via manual opening
        balances with the CPA&apos;s schedule. MACRS is computed, never table-transcribed; §179 and
        bonus limits come from the verified per-year <code>depreciation</code> table. Annual run
        posts one Dr 5050 / Cr 1610 entry.
      </p>

      <h2>Register</h2>
      <table>
        <thead>
          <tr>
            <th>Id</th>
            <th>Description</th>
            <th>In service</th>
            <th className="num">Cost</th>
            <th>Method</th>
            <th>Conv.</th>
            <th className="num">§179</th>
            <th className="num">Bonus</th>
            <th className="num">Accum. dep.</th>
            <th>Invoice</th>
            <th>Dispose</th>
          </tr>
        </thead>
        <tbody>
          {assets.map((a) => (
            <tr key={a.id.toString()}>
              <td className="mono">#{a.id.toString()}</td>
              <td>
                {a.description}
                {a.disposedOn && <span className="badge unreviewed"> disposed {a.disposedOn}</span>}
              </td>
              <td>{a.placedInService}</td>
              <td className="num">{money(a.cost)}</td>
              <td>
                {a.method} / {a.recoveryYears}yr / {a.businessUsePct}
              </td>
              <td>{a.convention ?? "—"}</td>
              <td className="num">{money(a.section179)}</td>
              <td className="num">{a.takeBonus ? money(a.bonusApplied) : "—"}</td>
              <td className="num">{money(accum.get(a.id.toString()) ?? 0n)}</td>
              <td>
                <a href={`/documents/${a.documentId}`}>doc</a>
              </td>
              <td>
                {!a.disposedOn && (
                  <form className="inline" action={disposeAction}>
                    <input type="hidden" name="id" value={a.id.toString()} />
                    <input type="date" name="disposedOn" defaultValue={todayISO()} required />
                    <button className="secondary" type="submit">
                      Record
                    </button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="panel">
        <form className="inline" action={postYearAction}>
          <label className="field">
            tax year
            <input name="taxYear" size={5} defaultValue={currentYear()} />
          </label>
          <button type="submit">Post annual depreciation</button>
        </form>
        <form className="inline" action={build4562Action}>
          <label className="field">
            tax year
            <input name="taxYear" size={5} defaultValue={currentYear()} />
          </label>
          <button className="secondary" type="submit">
            Build 4562 workpaper
          </button>
        </form>
      </div>

      <h2>Add asset</h2>
      <div className="panel">
        <form className="inline" action={addAction}>
          <label className="field">
            description
            <input name="description" size={24} required />
          </label>
          <label className="field">
            placed in service
            <input type="date" name="placedInService" required />
          </label>
          <label className="field">
            cost $
            <input name="cost" size={10} required />
          </label>
          <label className="field">
            business use
            <input name="businessUsePct" size={6} defaultValue="100%" />
          </label>
          <label className="field">
            method
            <select name="method">
              <option value="macrs_200db">MACRS 200% DB</option>
              <option value="macrs_150db">MACRS 150% DB</option>
              <option value="sl">Straight line</option>
            </select>
          </label>
          <label className="field">
            recovery
            <select name="recoveryYears">
              {[3, 5, 7, 10, 15, 20].map((y) => (
                <option key={y} value={y}>
                  {y}-year
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            §179 $
            <input name="section179" size={9} defaultValue="0" />
          </label>
          <label className="field">
            bonus
            <input type="checkbox" name="takeBonus" />
          </label>
          <label className="field">
            invoice (required)
            <input type="file" name="file" required />
          </label>
          <label className="field">
            note
            <input name="note" size={16} />
          </label>
          <button type="submit">Add</button>
        </form>
        <p className="muted small">
          Elections (§179/bonus) require more-than-50% business use and a verified{" "}
          <code>depreciation</code> table for the year; posting refuses over-limit elections.
          Listed property and real property are out of scope by design.
        </p>
      </div>
    </>
  );
}
