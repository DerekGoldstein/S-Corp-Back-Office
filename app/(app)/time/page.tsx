import { asc, desc, eq } from "drizzle-orm";
import { getDb } from "../../../src/db/client";
import {
  compComputations,
  compMethodologies,
  rateSources,
  taskTypes,
} from "../../../src/db/schema";
import {
  computeCompensation,
  createMethodology,
  ensureDefaultTaskTypes,
  freezeMethodology,
  renderCompMemoPack,
} from "../../../src/time/comp";
import { addRateSource, addTimeEntry, listTimeEntries } from "../../../src/time/timelog";
import { storeDocument, linkDocument } from "../../../src/vault/store";
import { parseDollars, formatCents } from "../../../src/lib/cents";
import { runAction, fd, fdRequired } from "../../../src/ui/action";
import { Banner } from "../../../src/ui/banner";
import { currentYear, money, spStr, todayISO, type Sp } from "../../../src/ui/fmt";

export const dynamic = "force-dynamic";

async function addEntryAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/time", async () => {
    await addTimeEntry(getDb(), {
      entryDate: fdRequired(formData, "date"),
      hours: fdRequired(formData, "hours"),
      taskTypeName: fdRequired(formData, "taskType"),
      client: fd(formData, "client") || undefined,
      note: fd(formData, "note") || undefined,
    });
    return "time entry added";
  });
}

async function addRateAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/time", async () => {
    const kind = fdRequired(formData, "sourceKind");
    await addRateSource(getDb(), {
      taskTypeName: fdRequired(formData, "taskType"),
      hourlyRate: parseDollars(fdRequired(formData, "rate")),
      sourceKind: kind === "job_posting" || kind === "survey" ? kind : "other",
      citation: fdRequired(formData, "citation"),
      conversionNote: fd(formData, "conversion") || undefined,
      capturedOn: todayISO(),
    });
    return "rate source added";
  });
}

async function createMethodologyAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/time", async () => {
    const agg = fdRequired(formData, "aggregation");
    const m = await createMethodology(getDb(), {
      version: Number(fdRequired(formData, "version")),
      description: fdRequired(formData, "description"),
      parameters: {
        rateAggregation: agg === "mean" || agg === "min" ? agg : "median",
      },
    });
    return `methodology v${m.version} created — freeze it before 1/1 of the comp year`;
  });
}

async function freezeAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/time", async () => {
    await freezeMethodology(getDb(), Number(fdRequired(formData, "id")));
    return "methodology frozen — it is now immutable";
  });
}

async function computeAction(formData: FormData): Promise<void> {
  "use server";
  await runAction("/time", async () => {
    const db = getDb();
    const r = await computeCompensation(db, {
      taxYear: Number(fdRequired(formData, "taxYear")),
      methodologyId: Number(fdRequired(formData, "methodologyId")),
    });
    const md = await renderCompMemoPack(db, r.computationId);
    const { document } = await storeDocument(db, {
      filename: `comp-memo-pack-${r.taxYear}-c${r.computationId}.md`,
      mime: "text/markdown",
      bytes: Buffer.from(md, "utf8"),
      source: "generated",
      year: r.taxYear,
    });
    await linkDocument(db, document.id, "comp_computation", r.computationId);
    const warn = r.warnings.length > 0 ? ` — WARNING: ${r.warnings[0]}` : "";
    return `computed $${formatCents(r.total)} for ${r.taxYear} (memo pack vaulted as document #${document.id})${warn}`;
  });
}

async function seedTaskTypesAction(): Promise<void> {
  "use server";
  await runAction("/time", async () => {
    await ensureDefaultTaskTypes(getDb());
    return "default task types ensured";
  });
}

export default async function TimePage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const year = Number(spStr(sp, "year", String(currentYear())));
  const db = getDb();
  const types = await db.select().from(taskTypes).orderBy(asc(taskTypes.name));
  const entries = await listTimeEntries(db, year);
  const rates = await db.select().from(rateSources).orderBy(asc(rateSources.taskTypeId));
  const typeName = new Map(types.map((t) => [t.id, t.name]));
  const methodologies = await db
    .select()
    .from(compMethodologies)
    .orderBy(asc(compMethodologies.version));
  const computations = await db
    .select()
    .from(compComputations)
    .orderBy(desc(compComputations.id))
    .limit(5);
  const totalHours = entries.reduce((a, e) => a + Number(e.hours), 0);

  return (
    <>
      <h1>Time log &amp; reasonable compensation</h1>
      <Banner sp={sp} />
      {types.length === 0 && (
        <form action={seedTaskTypesAction}>
          <button type="submit">Seed default task types (§4.3)</button>
        </form>
      )}
      <div className="panel">
        <form className="inline" action={addEntryAction}>
          <label className="field">
            date
            <input type="date" name="date" defaultValue={todayISO()} required />
          </label>
          <label className="field">
            hours
            <input name="hours" size={5} placeholder="2.50" required />
          </label>
          <label className="field">
            task type
            <select name="taskType" required>
              {types.map((t) => (
                <option key={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            client/investee
            <input name="client" size={14} />
          </label>
          <label className="field">
            note
            <input name="note" size={20} />
          </label>
          <button type="submit">Log time</button>
        </form>
      </div>

      <h2>
        {year} entries — {totalHours.toFixed(2)} hours
      </h2>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Task type</th>
            <th className="num">Hours</th>
            <th>Client</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id.toString()}>
              <td className="mono small">{e.entryDate}</td>
              <td>{e.taskType}</td>
              <td className="num">{e.hours}</td>
              <td className="small">{e.client}</td>
              <td className="small muted">{e.note}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Market rate sources</h2>
      <table>
        <thead>
          <tr>
            <th>Task type</th>
            <th className="num">Rate/hr</th>
            <th>Kind</th>
            <th>Citation</th>
            <th>Captured</th>
          </tr>
        </thead>
        <tbody>
          {rates.map((r) => (
            <tr key={r.id}>
              <td>{typeName.get(r.taskTypeId)}</td>
              <td className="num">{money(r.hourlyRate)}</td>
              <td className="small">{r.sourceKind}</td>
              <td className="small">{r.citation}</td>
              <td className="mono small">{r.capturedOn}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="panel">
        <form className="inline" action={addRateAction}>
          <label className="field">
            task type
            <select name="taskType" required>
              {types.map((t) => (
                <option key={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            rate $/hr
            <input name="rate" size={8} required />
          </label>
          <label className="field">
            kind
            <select name="sourceKind">
              <option value="job_posting">job posting</option>
              <option value="survey">survey</option>
              <option value="other">other</option>
            </select>
          </label>
          <label className="field">
            citation (URL / description)
            <input name="citation" size={30} required />
          </label>
          <label className="field">
            salary conversion note
            <input name="conversion" size={16} placeholder="salary / 2080" />
          </label>
          <button type="submit">Add rate source</button>
        </form>
      </div>

      <h2>Methodology &amp; computation</h2>
      <table>
        <thead>
          <tr>
            <th>Version</th>
            <th>Description</th>
            <th>Aggregation</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {methodologies.map((m) => (
            <tr key={m.id}>
              <td>v{m.version}</td>
              <td className="small">{m.description}</td>
              <td>{m.parameters.rateAggregation}</td>
              <td>
                {m.frozen ? (
                  <span className="badge completed">
                    frozen {m.frozenAt?.toISOString().slice(0, 10)}
                  </span>
                ) : (
                  <span className="badge unreviewed">draft</span>
                )}
              </td>
              <td>
                {!m.frozen && (
                  <form action={freezeAction}>
                    <input type="hidden" name="id" value={m.id} />
                    <button type="submit">Freeze</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="panel">
        <form className="inline" action={createMethodologyAction}>
          <label className="field">
            version
            <input name="version" size={3} defaultValue={String(methodologies.length + 1)} />
          </label>
          <label className="field">
            description
            <input name="description" size={40} required />
          </label>
          <label className="field">
            rate aggregation
            <select name="aggregation">
              <option value="median">median</option>
              <option value="mean">mean</option>
              <option value="min">min (most conservative)</option>
            </select>
          </label>
          <button type="submit">Create methodology</button>
        </form>
        <form className="inline" action={computeAction} style={{ marginTop: ".6rem" }}>
          <label className="field">
            tax year
            <input name="taxYear" size={5} defaultValue={String(year)} />
          </label>
          <label className="field">
            methodology
            <select name="methodologyId" required>
              {methodologies.map((m) => (
                <option key={m.id} value={m.id}>
                  v{m.version} {m.frozen ? "(frozen)" : "(draft)"}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Compute compensation</button>
        </form>
      </div>

      {computations.length > 0 && (
        <>
          <h2>Recent computations</h2>
          <table>
            <thead>
              <tr>
                <th>Id</th>
                <th>Year</th>
                <th className="num">Total</th>
                <th>Computed</th>
              </tr>
            </thead>
            <tbody>
              {computations.map((c) => (
                <tr key={c.id.toString()}>
                  <td className="mono">#{c.id.toString()}</td>
                  <td>{c.taxYear}</td>
                  <td className="num">{money(c.total)}</td>
                  <td className="mono small">{c.computedAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
