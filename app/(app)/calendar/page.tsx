import { getDb } from "../../../src/db/client";
import {
  completeCalendarItem,
  generateCalendar,
  listCalendar,
  loadCalendarRules,
} from "../../../src/calendar/calendar";
import { storeDocument, linkDocument } from "../../../src/vault/store";
import { runAction, fd, fdRequired } from "../../../src/ui/action";
import { Banner } from "../../../src/ui/banner";
import { currentYear, spStr, todayISO, type Sp } from "../../../src/ui/fmt";

export const dynamic = "force-dynamic";

async function generateAction(formData: FormData): Promise<void> {
  "use server";
  const year = fdRequired(formData, "year");
  await runAction(`/calendar?year=${year}`, async () => {
    const db = getDb();
    await loadCalendarRules(db);
    const r = await generateCalendar(db, Number(year));
    return `generated ${r.created} item(s), ${r.na} n/a (conditions unset), ${r.skipped} already existed`;
  });
}

async function completeAction(formData: FormData): Promise<void> {
  "use server";
  const year = fd(formData, "year") || String(currentYear());
  await runAction(`/calendar?year=${year}`, async () => {
    const db = getDb();
    let documentId: bigint | undefined;
    const file = formData.get("file");
    if (file instanceof File && file.size > 0) {
      const { document } = await storeDocument(db, {
        filename: file.name,
        mime: file.type || "application/pdf",
        bytes: Buffer.from(await file.arrayBuffer()),
      });
      documentId = document.id;
    }
    const itemId = BigInt(fdRequired(formData, "itemId"));
    await completeCalendarItem(db, itemId, {
      documentId,
      note: fd(formData, "note") || undefined,
    });
    if (documentId !== undefined) await linkDocument(db, documentId, "calendar_item", itemId);
    return "item completed" + (documentId !== undefined ? " with the filing confirmation vaulted" : "");
  });
}

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const year = Number(spStr(sp, "year", String(currentYear())));
  const db = getDb();
  const items = await listCalendar(db, year);
  const today = todayISO();

  return (
    <>
      <h1>Compliance calendar (§5) — {year}</h1>
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
        <form className="inline" action={generateAction}>
          <input type="hidden" name="year" value={year} />
          <button type="submit">Generate {year} items</button>
          <span className="muted small">
            requires the {year} holidays table loaded and verified (Settings → tax tables live in
            data files; guardrail 1)
          </span>
        </form>
      </div>
      <table>
        <thead>
          <tr>
            <th>Due</th>
            <th>Item</th>
            <th>Channel</th>
            <th>Amount source</th>
            <th>Status</th>
            <th>Complete</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr
              key={i.id.toString()}
              style={i.status === "upcoming" && i.dueDate < today ? { background: "#fbeaea" } : undefined}
            >
              <td className="mono small">{i.dueDate}</td>
              <td className="small">
                {i.label}
                {i.note !== null && <div className="muted">{i.note}</div>}
              </td>
              <td className="small">{i.channel}</td>
              <td className="small muted">{i.amountSource}</td>
              <td>
                <span className={"badge " + (i.status === "done" ? "completed" : i.status === "na" ? "" : i.dueDate < today ? "flagged" : "unreviewed")}>
                  {i.status === "upcoming" && i.dueDate < today ? "OVERDUE" : i.status}
                </span>
                {i.documentId !== null && (
                  <>
                    {" "}
                    <a className="small" href={`/documents/${i.documentId}`}>
                      confirmation
                    </a>
                  </>
                )}
              </td>
              <td>
                {i.status === "upcoming" && (
                  <form className="inline" action={completeAction}>
                    <input type="hidden" name="itemId" value={i.id.toString()} />
                    <input type="hidden" name="year" value={year} />
                    <input type="file" name="file" title="filing confirmation" />
                    <input name="note" size={12} placeholder="note" />
                    <button className="secondary" type="submit">
                      Done
                    </button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Items generate from data/calendar/rules.json — never hardcoded dates. Due dates roll past
        weekends and the year's verified holiday table. Event-driven items (EFTPS after the
        December run, NYS-1, new-hire report) attach when the pay run posts.
      </p>
    </>
  );
}
