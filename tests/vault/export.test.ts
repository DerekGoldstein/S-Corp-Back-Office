/**
 * The CPA hand-off zip: store-mode writer round-trips with CRC checks, and
 * the year archive contains the manifest, the LATEST workpaper versions,
 * and exactly the documents that belong to the year (tagged or linked to an
 * in-year journal entry) — bytes integrity-checked out of the vault.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildZip, readZip } from "../../src/lib/zip";
import { exportYearArchive } from "../../src/vault/export";
import { saveWorkpaper } from "../../src/workpapers/f1120s";
import { storeDocument, linkDocument } from "../../src/vault/store";
import { postEntry } from "../../src/ledger/posting";
import { makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;

beforeAll(async () => {
  process.env.VAULT_DIR = mkdtempSync(join(tmpdir(), "vault-"));
  t = await makeTestDb();
});

afterAll(async () => {
  await t.drop();
});

describe("zip writer", () => {
  it("round-trips entries byte-for-byte with valid CRCs", () => {
    const entries = [
      { path: "manifest.json", bytes: Buffer.from('{"ok":true}') },
      { path: "documents/1-receipt.pdf", bytes: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]) },
      { path: "workpapers/f1120s-v1.json", bytes: Buffer.from("{}") },
    ];
    const zip = buildZip(entries);
    // EOCD signature present at the end
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(3); // total entries
    const back = readZip(zip);
    expect([...back.keys()]).toEqual(entries.map((e) => e.path));
    for (const e of entries) expect(back.get(e.path)!.equals(e.bytes)).toBe(true);
  });

  it("refuses unsafe paths", () => {
    expect(() => buildZip([{ path: "../escape", bytes: Buffer.alloc(1) }])).toThrow(/unsafe/);
    expect(() => buildZip([{ path: "/abs", bytes: Buffer.alloc(1) }])).toThrow(/unsafe/);
  });
});

describe("exportYearArchive", () => {
  it("collects latest workpapers + year documents, skips other years", async () => {
    // two versions of a workpaper — only v2 must ship
    await saveWorkpaper(t.db, "f1120s", 2027, { draft: 1 }, [{ name: "x", pass: true, detail: "" }]);
    await saveWorkpaper(t.db, "f1120s", 2027, { draft: 2 }, [{ name: "x", pass: true, detail: "" }]);
    await saveWorkpaper(t.db, "941", 2027, { q: 4 }, null, 4);
    // a year-tagged document
    const tagged = await storeDocument(t.db, {
      filename: "board consent.pdf",
      mime: "application/pdf",
      bytes: Buffer.from("consent bytes"),
      year: 2027,
    });
    // a document linked to an in-year entry (no year tag)
    const linked = await storeDocument(t.db, {
      filename: "wire-receipt.pdf",
      mime: "application/pdf",
      bytes: Buffer.from("wire receipt bytes"),
    });
    const { entryId } = await postEntry(t.db, {
      entryDate: "2027-06-15",
      memo: "consulting revenue",
      sourceModule: "manual",
      lines: [
        { accountCode: "1000", debit: 100_000n },
        { accountCode: "4000", credit: 100_000n },
      ],
    });
    await linkDocument(t.db, linked.document.id, "journal_entry", entryId);
    // noise: a 2028 document must NOT appear
    await storeDocument(t.db, {
      filename: "next-year.pdf",
      mime: "application/pdf",
      bytes: Buffer.from("2028 bytes"),
      year: 2028,
    });

    const { zip, manifest, filename } = await exportYearArchive(t.db, 2027);
    expect(filename).toBe("cpa-export-2027.zip");
    const files = readZip(zip);
    expect(files.has("manifest.json")).toBe(true);
    expect(files.has("workpapers/f1120s-v2.json")).toBe(true);
    expect(files.has("workpapers/f1120s-v1.json")).toBe(false);
    expect(files.has("workpapers/941-q4-v1.json")).toBe(true);
    const docPaths = [...files.keys()].filter((p) => p.startsWith("documents/"));
    expect(docPaths).toHaveLength(2);
    expect(docPaths.join(",")).toContain("board_consent.pdf");
    expect(docPaths.join(",")).toContain("wire-receipt.pdf");
    expect(docPaths.join(",")).not.toContain("next-year");
    expect(files.get(`documents/${linked.document.id}-wire-receipt.pdf`)!.toString()).toBe(
      "wire receipt bytes",
    );
    expect(manifest.workpapers).toHaveLength(2);
    expect(manifest.documents).toHaveLength(2);
    const parsed = JSON.parse(files.get("manifest.json")!.toString());
    expect(parsed.taxYear).toBe(2027);
  });
});
