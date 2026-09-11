import { asc, desc } from "drizzle-orm";
import { getDb } from "../../../src/db/client";
import { accountablePlans, reimbursementSubmissions } from "../../../src/db/schema";
import {
  approveSubmission,
  computeHomeOffice,
  createSubmission,
  type ReimbursementCategory,
} from "../../../src/plan/reimbursements";
import { storeDocument } from "../../../src/vault/store";
import { parseDollars } from "../../../src/lib/cents";
import { runAction, fd, fdRequired } from "../../../src/ui/action";
import { Banner } from "../../../src/ui/banner";
import { money, todayISO, type Sp } from "../../../src/ui/fmt";

export const dynamic = "force-dynamic";

async function submitAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/reimbursements", async () => {
    const db = getDb();
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      throw new Error("attach the receipt/computation document (guardrail 6)");
    }
    const { document } = await storeDocument(db, {
      filename: file.name,
      mime: file.type || "application/pdf",
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    const category = fdRequired(formData, "category") as ReimbursementCategory;
    let amount = 0n;
    let computation: Record<string, unknown> | undefined;
    if (category === "home_office") {
      const ho = computeHomeOffice({
        totalSquareFeet: Number(fdRequired(formData, "totalSqft")),
        businessSquareFeet: Number(fdRequired(formData, "businessSqft")),
        annualRent: parseDollars(fd(formData, "rent") || "0"),
        annualUtilities: parseDollars(fd(formData, "utilities") || "0"),
        annualInsurance: parseDollars(fd(formData, "insurance") || "0"),
      });
      amount = ho.amount;
      computation = ho.breakdown;
    } else {
      amount = parseDollars(fdRequired(formData, "amount"));
    }
    const id = await createSubmission(db, {
      planId: Number(fdRequired(formData, "planId")),
      taxYear: Number(fdRequired(formData, "taxYear")),
      category,
      amount,
      computation,
      documentId: document.id,
    });
    return `submission #${id} created for ${money(amount)} — approve to post`;
  });
}

async function approveAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/reimbursements", async () => {
    const { entryId } = await approveSubmission(
      getDb(),
      BigInt(fdRequired(formData, "id")),
      fdRequired(formData, "approvedOn"),
    );
    return `approved and posted as entry #${entryId} (Dr expense / Cr 2190); pay it with the December batch and tag the bank payment 'reimbursement'`;
  });
}

export default async function ReimbursementsPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const db = getDb();
  const plans = await db.select().from(accountablePlans).orderBy(desc(accountablePlans.id));
  const subs = await db
    .select()
    .from(reimbursementSubmissions)
    .orderBy(asc(reimbursementSubmissions.id));
  const activePlan = plans.find((p) => p.active);

  return (
    <>
      <h1>Accountable-plan reimbursements (§4.8)</h1>
      <Banner sp={sp} />
      {!activePlan ? (
        <p>
          No accountable plan on file — generate the policy under{" "}
          <a href="/records">Corporate records</a>, sign it, then record it here (the plan row is
          created when the policy is generated... create one in Settings if needed).
        </p>
      ) : (
        <div className="panel">
          <strong>Plan in force:</strong> adopted {activePlan.adoptedOn}, substantiation window{" "}
          {activePlan.substantiationWindowDays} days, categories:{" "}
          {activePlan.categories.join(", ")}
        </div>
      )}

      <h2>Submissions</h2>
      <table>
        <thead>
          <tr>
            <th>Id</th>
            <th>Year</th>
            <th>Category</th>
            <th className="num">Amount</th>
            <th>Status</th>
            <th>Document</th>
            <th>Approve</th>
          </tr>
        </thead>
        <tbody>
          {subs.map((s) => (
            <tr key={s.id.toString()}>
              <td className="mono">#{s.id.toString()}</td>
              <td>{s.taxYear}</td>
              <td>{s.category}</td>
              <td className="num">{money(s.amount)}</td>
              <td>
                <span
                  className={
                    "badge " + (s.status === "paid" ? "completed" : s.status === "posted" ? "proposed" : "unreviewed")
                  }
                >
                  {s.status}
                </span>
              </td>
              <td>
                <a href={`/documents/${s.documentId}`}>doc</a>
              </td>
              <td>
                {s.status === "submitted" && (
                  <form className="inline" action={approveAction}>
                    <input type="hidden" name="id" value={s.id.toString()} />
                    <input type="date" name="approvedOn" defaultValue={todayISO()} required />
                    <button className="secondary" type="submit">
                      Approve &amp; post
                    </button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {activePlan && (
        <>
          <h2>New submission</h2>
          <div className="panel">
            <form className="inline" action={submitAction}>
              <input type="hidden" name="planId" value={activePlan.id} />
              <label className="field">
                tax year
                <input name="taxYear" size={5} defaultValue={todayISO().slice(0, 4)} />
              </label>
              <label className="field">
                category
                <select name="category">
                  {activePlan.categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                amount $ (non-home-office)
                <input name="amount" size={10} />
              </label>
              <label className="field">
                document (required)
                <input type="file" name="file" required />
              </label>
              <button type="submit">Submit</button>
              <div className="muted small" style={{ width: "100%" }}>
                Home-office fields (used when category is home_office; amount computed):
              </div>
              <label className="field">
                total sq ft
                <input name="totalSqft" size={6} />
              </label>
              <label className="field">
                business sq ft
                <input name="businessSqft" size={6} />
              </label>
              <label className="field">
                annual rent $
                <input name="rent" size={10} />
              </label>
              <label className="field">
                annual utilities $
                <input name="utilities" size={8} />
              </label>
              <label className="field">
                annual insurance $
                <input name="insurance" size={8} />
              </label>
            </form>
            <p className="muted small">
              Health-insurance submissions post to 5030 (expensed exactly once, W-2 Box 1/14
              handling in payroll — guardrail 7). Everything else posts to its 504x account.
              Default cadence: one annual batch paid with the December payroll (§4.8).
            </p>
          </div>
        </>
      )}
    </>
  );
}
