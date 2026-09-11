import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  documentsFor,
  linkDocument,
  readDocument,
  storeDocument,
  VaultError,
} from "../../src/vault/store";
import { expectDbReject, makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let vault: string;

beforeAll(async () => {
  vault = mkdtempSync(join(tmpdir(), "vault-"));
  process.env.VAULT_DIR = vault;
  t = await makeTestDb();
});

afterAll(async () => {
  await t.drop();
});

describe("vault store", () => {
  it("stores content-addressed, dedupes identical bytes, verifies on read", async () => {
    const bytes = Buffer.from("receipt: client lunch $101.00");
    const a = await storeDocument(t.db, { filename: "r1.txt", mime: "text/plain", bytes });
    expect(a.existed).toBe(false);
    const b = await storeDocument(t.db, { filename: "other-name.txt", mime: "text/plain", bytes });
    expect(b.existed).toBe(true);
    expect(b.document.id).toBe(a.document.id);
    const read = await readDocument(t.db, a.document.id);
    expect(read.bytes.equals(bytes)).toBe(true);
  });

  it("detects tampering via the stored hash", async () => {
    const bytes = Buffer.from("original statement bytes");
    const { document } = await storeDocument(t.db, {
      filename: "stmt.pdf",
      mime: "application/pdf",
      bytes,
    });
    const shard = join(vault, document.sha256.slice(0, 2), document.sha256);
    writeFileSync(shard, "TAMPERED");
    await expect(readDocument(t.db, document.id)).rejects.toThrow(VaultError);
    await expect(readDocument(t.db, document.id)).rejects.toThrow(/integrity/);
  });

  it("links documents to any record and lists them back", async () => {
    const { document } = await storeDocument(t.db, {
      filename: "k1-2026.pdf",
      mime: "application/pdf",
      bytes: Buffer.from("k-1 pdf bytes"),
    });
    await linkDocument(t.db, document.id, "k1", 42);
    await linkDocument(t.db, document.id, "k1", 42); // idempotent
    const docs = await documentsFor(t.db, "k1", 42);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.filename).toBe("k1-2026.pdf");
  });

  it("DB refuses identity edits and retention-window deletes", async () => {
    const { document } = await storeDocument(t.db, {
      filename: "consent.pdf",
      mime: "application/pdf",
      bytes: Buffer.from("signed consent"),
    });
    await expectDbReject(
      t.pool,
      `UPDATE documents SET sha256 = 'forged' WHERE id = ${document.id}`,
      /immutable/,
    );
    await expectDbReject(
      t.pool,
      `DELETE FROM documents WHERE id = ${document.id}`,
      /retention/,
    );
    // rejects empty files too
    await expect(
      storeDocument(t.db, { filename: "empty", mime: "text/plain", bytes: Buffer.alloc(0) }),
    ).rejects.toThrow(/empty/);
  });

  it("shards storage by hash prefix", () => {
    const entries = readdirSync(vault);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.length === 2)).toBe(true);
  });
});
