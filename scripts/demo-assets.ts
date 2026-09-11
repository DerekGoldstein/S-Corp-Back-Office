/** Dev-only: seed two no-election assets and post 2027 depreciation. */
import { getDb } from "../src/db/client";
import { addAsset, postAnnualDepreciation, listAssets } from "../src/assets/register";
import { storeDocument } from "../src/vault/store";

async function main() {
  const db = getDb();
  if ((await listAssets(db)).length > 0) {
    console.log("assets already present; skipping");
    process.exit(0);
  }
  const inv1 = await storeDocument(db, {
    filename: "macbook-invoice.pdf",
    mime: "application/pdf",
    bytes: Buffer.from("demo invoice: MacBook Pro $3,499.00"),
    year: 2027,
  });
  const inv2 = await storeDocument(db, {
    filename: "desk-chair-invoice.pdf",
    mime: "application/pdf",
    bytes: Buffer.from("demo invoice: sit-stand desk + chair $1,850.00"),
    year: 2027,
  });
  await addAsset(db, {
    description: "MacBook Pro 16 (demo)",
    placedInService: "2027-02-12",
    cost: 349_900n,
    method: "macrs_200db",
    recoveryYears: 5,
    documentId: inv1.document.id,
  });
  await addAsset(db, {
    description: "Sit-stand desk + chair (demo)",
    placedInService: "2027-10-03",
    cost: 185_000n,
    method: "macrs_200db",
    recoveryYears: 7,
    documentId: inv2.document.id,
  });
  const r = await postAnnualDepreciation(db, 2027);
  console.log("posted", r.total.toString(), "entry", r.entryId.toString());
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
