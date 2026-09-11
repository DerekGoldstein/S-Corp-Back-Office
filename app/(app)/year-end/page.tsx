import { desc } from "drizzle-orm";
import { getDb } from "../../../src/db/client";
import { reviewPackages, workpapers } from "../../../src/db/schema";
import { closePreconditions, closeYear, reopenYear } from "../../../src/ledger/close";
import { buildF1120s, finalizeWorkpaper, saveWorkpaper } from "../../../src/workpapers/f1120s";
import { buildReviewPackage, finalizePackage } from "../../../src/package/tieouts";
import { runAction, fd, fdRequired } from "../../../src/ui/action";
import { Banner } from "../../../src/ui/banner";
import { currentYear, money, spStr, type Sp } from "../../../src/ui/fmt";

export const dynamic = "force-dynamic";

async function closeAction(formData: FormData): Promise<void> {
  "use server";
  const year = fdRequired(formData, "year");
  await runAction(`/year-end?year=${year}`, async () => {
    const s = await closeYear(getDb(), Number(year));
    return (
      `closed ${year}: meals reclass ${money(s.mealsReclassed)}, net income ${money(s.netIncome)}, ` +
      `AAA ${money(s.aaaPortion)}, OAA ${money(s.oaaPortion)}, distributions ${money(s.distributionsClosed)} — periods locked`
    );
  });
}

async function reopenAction(formData: FormData): Promise<void> {
  "use server";
  const year = fdRequired(formData, "year");
  await runAction(`/year-end?year=${year}`, async () => {
    await reopenYear(getDb(), Number(year), fdRequired(formData, "reason"));
    return `${year} reopened (close entries reversed, periods unlocked, audited)`;
  });
}

async function buildWorkpaperAction(formData: FormData): Promise<void> {
  "use server";
  const year = fdRequired(formData, "year");
  await runAction(`/year-end?year=${year}`, async () => {
    const db = getDb();
    const wp = await buildF1120s(db, Number(year));
    const saved = await saveWorkpaper(db, "f1120s", Number(year), wp, wp.tieOuts);
    const red = wp.tieOuts.filter((t) => !t.pass).length;
    return `1120-S workpaper v${saved.version} saved — ${wp.tieOuts.length - red}/${wp.tieOuts.length} tie-outs green`;
  });
}

async function finalizeWorkpaperAction(formData: FormData): Promise<void> {
  "use server";
  const year = fd(formData, "year") || String(currentYear());
  await runAction(`/year-end?year=${year}`, async () => {
    await finalizeWorkpaper(
      getDb(),
      BigInt(fdRequired(formData, "id")),
      fdRequired(formData, "reviewedBy"),
    );
    return "workpaper finalized (immutable) with the reviewer sign-off";
  });
}

async function buildPackageAction(formData: FormData): Promise<void> {
  "use server";
  const year = fdRequired(formData, "year");
  await runAction(`/year-end?year=${year}`, async () => {
    const notesRaw = fd(formData, "ownerNotes");
    const notes: Record<string, string> = {};
    for (const line of notesRaw.split("\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) notes[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    const pkg = await buildReviewPackage(getDb(), Number(year), notes);
    return `package v${pkg.version} built — ${pkg.redCount} open item(s); cover memo is document #${pkg.coverDocumentId}`;
  });
}

async function finalizePackageAction(formData: FormData): Promise<void> {
  "use server";
  const year = fd(formData, "year") || String(currentYear());
  await runAction(`/year-end?year=${year}`, async () => {
    const status = fdRequired(formData, "status");
    await finalizePackage(
      getDb(),
      Number(fdRequired(formData, "id")),
      status === "final" ? "final" : "final_with_open_items",
    );
    return `package marked ${status}`;
  });
}

export default async function YearEndPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const year = Number(spStr(sp, "year", String(currentYear())));
  const db = getDb();
  const preconditions = await closePreconditions(db, year);
  const wps = await db.select().from(workpapers).orderBy(desc(workpapers.id)).limit(10);
  const pkgs = await db.select().from(reviewPackages).orderBy(desc(reviewPackages.id)).limit(10);
  const closed = preconditions.some((p) => p.issue.includes("already has close entries"));

  return (
    <>
      <h1>Year-end — {year}</h1>
      <Banner sp={sp} />
      <div className="panel">
        <form className="inline" method="get">
          <label className="field">
            year
            <input name="year" size={6} defaultValue={String(year)} />
          </label>
          <button className="secondary" type="submit">
            Show
          </button>
        </form>
      </div>

      <h2>Close (§4.1/§6)</h2>
      <div className="panel">
        {preconditions.length === 0 ? (
          <p>
            <span className="badge completed">ready</span> queue empty, flags resolved,
            reconciliations complete.
          </p>
        ) : (
          <ul>
            {preconditions.map((p, i) => (
              <li key={i}>{p.issue}</li>
            ))}
          </ul>
        )}
        {!closed && (
          <form className="inline" action={closeAction}>
            <input type="hidden" name="year" value={year} />
            <button type="submit" disabled={preconditions.length > 0}>
              Close {year}
            </button>
            <span className="muted small">
              meals 50% reclass → close to 3900 → AAA/OAA split → distributions → lock periods
            </span>
          </form>
        )}
        {closed && (
          <form className="inline" action={reopenAction}>
            <input type="hidden" name="year" value={year} />
            <input name="reason" size={30} placeholder="reason (audited)" required />
            <button className="danger" type="submit">
              Reopen {year}
            </button>
          </form>
        )}
      </div>

      <h2>1120-S workpaper (§4.6)</h2>
      <div className="panel">
        <form className="inline" action={buildWorkpaperAction}>
          <input type="hidden" name="year" value={year} />
          <button type="submit">Build 1120-S workpaper for {year}</button>
        </form>
      </div>
      {wps.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Kind</th>
              <th>Year</th>
              <th>v</th>
              <th>Status</th>
              <th>Tie-outs</th>
              <th>Finalize (needs sign-off)</th>
            </tr>
          </thead>
          <tbody>
            {wps.map((w) => {
              const ties = (w.tieOuts ?? []) as Array<{ pass: boolean }>;
              const red = ties.filter((t) => !t.pass).length;
              return (
                <tr key={w.id.toString()}>
                  <td className="mono">{w.kind}</td>
                  <td>{w.taxYear}</td>
                  <td>v{w.version}</td>
                  <td>
                    <span className={"badge " + (w.status === "final" ? "completed" : "unreviewed")}>
                      {w.status}
                      {w.reviewedBy !== null ? ` — ${w.reviewedBy}` : ""}
                    </span>
                  </td>
                  <td>{ties.length - red}/{ties.length} green</td>
                  <td>
                    {w.status === "draft" && (
                      <form className="inline" action={finalizeWorkpaperAction}>
                        <input type="hidden" name="id" value={w.id.toString()} />
                        <input type="hidden" name="year" value={year} />
                        <input name="reviewedBy" size={16} placeholder="reviewed by" required />
                        <button className="secondary" type="submit">
                          Finalize
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h2>CPA review package (§4.11)</h2>
      <div className="panel">
        <form action={buildPackageAction}>
          <input type="hidden" name="year" value={year} />
          <label className="field">
            owner notes for red items (one per line: <span className="mono">tieout_key: note</span>)
            <textarea name="ownerNotes" rows={3} cols={70} />
          </label>
          <p>
            <button type="submit">Run all tie-outs &amp; build package</button>
          </p>
        </form>
      </div>
      {pkgs.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Year</th>
              <th>v</th>
              <th>Status</th>
              <th>Open items</th>
              <th>Cover memo</th>
              <th>Finalize</th>
            </tr>
          </thead>
          <tbody>
            {pkgs.map((p) => {
              const open = (p.openItems ?? []) as unknown[];
              return (
                <tr key={p.id}>
                  <td>{p.taxYear}</td>
                  <td>v{p.version}</td>
                  <td>
                    <span className={"badge " + (p.status === "draft" ? "unreviewed" : "completed")}>
                      {p.status}
                    </span>
                    {p.signedOffAt !== null && <span className="small muted"> · CPA signed</span>}
                  </td>
                  <td>{open.length}</td>
                  <td>
                    {p.coverDocumentId !== null && (
                      <a href={`/documents/${p.coverDocumentId}`}>memo</a>
                    )}
                  </td>
                  <td>
                    {p.status === "draft" && (
                      <form className="inline" action={finalizePackageAction}>
                        <input type="hidden" name="id" value={p.id} />
                        <input type="hidden" name="year" value={year} />
                        <select name="status">
                          <option value="final">final (needs all green)</option>
                          <option value="final_with_open_items">final with open items (noted)</option>
                        </select>
                        <button className="secondary" type="submit">
                          Finalize
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
