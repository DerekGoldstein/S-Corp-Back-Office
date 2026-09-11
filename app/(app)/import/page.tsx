import { desc } from "drizzle-orm";
import { getDb } from "../../../src/db/client";
import { bankAccounts, importBatches } from "../../../src/db/schema";
import { importCsvFile, importOfxFile } from "../../../src/bank/import";
import { runAction, fdRequired } from "../../../src/ui/action";
import { Banner } from "../../../src/ui/banner";
import type { Sp } from "../../../src/ui/fmt";

export const dynamic = "force-dynamic";

async function importAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/import", async () => {
    const db = getDb();
    const bankAccountId = Number(fdRequired(formData, "bankAccountId"));
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("choose a file to import");
    const bytes = Buffer.from(await file.arrayBuffer());
    const text = bytes.toString("utf8", 0, 400).toUpperCase();
    const isOfx =
      file.name.toLowerCase().endsWith(".ofx") ||
      file.name.toLowerCase().endsWith(".qfx") ||
      text.includes("OFXHEADER") ||
      text.includes("<OFX>");
    const summary = isOfx
      ? await importOfxFile(db, bankAccountId, bytes, file.name)
      : await importCsvFile(db, bankAccountId, bytes, file.name);
    const w = summary.warnings.length > 0 ? `; ${summary.warnings.length} warning(s)` : "";
    return `${summary.newCount} new, ${summary.duplicateCount} duplicate(s) skipped${w} — review them in the queue`;
  });
}

export default async function ImportPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const db = getDb();
  const banks = await db.select().from(bankAccounts);
  const batches = await db
    .select()
    .from(importBatches)
    .orderBy(desc(importBatches.id))
    .limit(15);
  const bankName = new Map(banks.map((b) => [b.id, b.name]));

  return (
    <>
      <h1>Import bank activity</h1>
      <Banner sp={sp} />
      {banks.length === 0 ? (
        <p>
          No bank accounts yet — create one under <a href="/settings">Settings</a> first (with a
          CSV profile, or use OFX/QFX which needs none).
        </p>
      ) : (
        <div className="panel">
          <form className="inline" action={importAction}>
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
              CSV / OFX / QFX file
              <input type="file" name="file" accept=".csv,.ofx,.qfx,text/csv" required />
            </label>
            <button type="submit">Import</button>
          </form>
          <p className="muted small">
            Re-importing an overlapping export is safe: duplicates are skipped by hash. The file
            itself is vaulted and linked for statement→posting lineage.
          </p>
        </div>
      )}
      <h2>Recent imports</h2>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Account</th>
            <th>File</th>
            <th className="num">Rows</th>
            <th className="num">New</th>
            <th className="num">Dupes</th>
            <th className="num">Warnings</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id.toString()}>
              <td className="mono small">{b.importedAt.toISOString().slice(0, 16).replace("T", " ")}</td>
              <td>{bankName.get(b.bankAccountId)}</td>
              <td className="mono small">{b.filename}</td>
              <td className="num">{b.rowCount}</td>
              <td className="num">{b.newCount}</td>
              <td className="num">{b.duplicateCount}</td>
              <td className="num">{b.warningCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
