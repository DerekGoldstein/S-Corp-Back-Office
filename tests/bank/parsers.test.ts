import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../../src/lib/csv";
import { parseBankCsv, parseDateCell } from "../../src/bank/import-csv";
import { parseOfx } from "../../src/bank/import-ofx";
import { computeImportHashes, normalizeDescription } from "../../src/bank/normalize";
import type { CsvImportProfile } from "../../src/db/schema";

const fixture = (name: string) =>
  readFileSync(resolve(process.cwd(), "tests/fixtures", name), "utf8");

const chaseProfile: CsvImportProfile = {
  dateColumn: "Posting Date",
  dateFormat: "MDY",
  descriptionColumns: ["Description"],
  amountColumn: "Amount",
};

describe("csv primitives", () => {
  it("handles quotes, embedded commas/newlines, escaped quotes, CRLF", () => {
    const rows = parseCsv('a,"b,c","d""e","f\ng"\r\nh,,i,');
    expect(rows).toEqual([
      ["a", "b,c", 'd"e', "f\ng"],
      ["h", "", "i", ""],
    ]);
  });
  it("parses dates in all three orders with 2-digit years", () => {
    expect(parseDateCell("10/05/2026", "MDY")).toBe("2026-10-05");
    expect(parseDateCell("05-10-26", "DMY")).toBe("2026-10-05");
    expect(parseDateCell("2026.10.05", "YMD")).toBe("2026-10-05");
    expect(() => parseDateCell("13/45/2026", "MDY")).toThrow();
  });
});

describe("bank csv", () => {
  it("parses the Chase-style fixture with signed amounts", () => {
    const { txns, warnings } = parseBankCsv(fixture("chase.csv"), chaseProfile);
    expect(warnings).toEqual([]);
    expect(txns).toHaveLength(4);
    expect(txns[0]).toMatchObject({ date: "2026-10-05", amount: 500000n });
    expect(txns[1]).toMatchObject({ amount: -4900n, descriptionRaw: "ACME SOFTWARE, INC" });
  });

  it("supports split debit/credit columns with unsigned cells", () => {
    const text = "Date,Payee,Debit,Credit\n2026-10-05,CLIENT,,5000.00\n2026-10-07,ACME,49.00,\n";
    const { txns } = parseBankCsv(text, {
      dateColumn: "Date",
      dateFormat: "YMD",
      descriptionColumns: ["Payee"],
      debitColumn: "Debit",
      creditColumn: "Credit",
    });
    expect(txns.map((t) => t.amount)).toEqual([500000n, -4900n]);
  });

  it("collects warnings per bad line instead of failing the file", () => {
    const text = "Date,Payee,Amount\nnot-a-date,X,5.00\n2026-10-07,ACME,49.00\n";
    const { txns, warnings } = parseBankCsv(text, {
      dateColumn: "Date",
      dateFormat: "YMD",
      descriptionColumns: ["Payee"],
      amountColumn: "Amount",
    });
    expect(txns).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/line 2/);
  });
});

describe("ofx", () => {
  it("parses OFX 1.x SGML with FITIDs, memos, entities, tz-suffixed dates", () => {
    const { txns, warnings } = parseOfx(fixture("sample.ofx"));
    expect(warnings).toEqual([]);
    expect(txns).toHaveLength(3);
    expect(txns[0]).toMatchObject({ date: "2026-10-05", amount: 500000n, fitid: "FIT-001" });
    expect(txns[1]!.descriptionRaw).toBe("ACME SOFTWARE INC SUBSCRIPTION");
    expect(txns[2]!.descriptionRaw).toBe("DOORDASH LUNCH & MEETING");
  });

  it("parses OFX 2.x XML too", () => {
    const xml = `<?xml version="1.0"?><OFX><STMTRS><CURDEF>USD</CURDEF><BANKTRANLIST>
      <STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261101</DTPOSTED><TRNAMT>-12.34</TRNAMT><FITID>X1</FITID><NAME>COFFEE</NAME></STMTTRN>
      </BANKTRANLIST></STMTRS></OFX>`;
    const { txns } = parseOfx(xml);
    expect(txns).toEqual([
      { date: "2026-11-01", amount: -1234n, descriptionRaw: "COFFEE", fitid: "X1" },
    ]);
  });

  it("refuses non-USD files and non-OFX content", () => {
    expect(() => parseOfx("<OFX><CURDEF>EUR</CURDEF></OFX>")).toThrow(/unsupported currency/);
    expect(() => parseOfx("hello world")).toThrow(/no <STMTTRN>/);
  });
});

describe("hashing", () => {
  it("normalization v1 uppercases and collapses whitespace", () => {
    expect(normalizeDescription("  Acme   Software\tInc ")).toBe("ACME SOFTWARE INC");
  });

  it("identical same-day rows get distinct occurrence hashes, stable across re-parse", () => {
    const { txns } = parseBankCsv(fixture("chase.csv"), chaseProfile);
    const h1 = computeImportHashes(1, txns);
    expect(new Set(h1).size).toBe(4); // the two identical DoorDash rows differ
    const h2 = computeImportHashes(1, parseBankCsv(fixture("chase.csv"), chaseProfile).txns);
    expect(h2).toEqual(h1); // re-import is a perfect no-op
    expect(computeImportHashes(2, txns)).not.toEqual(h1); // account-scoped
  });

  it("OFX rows hash by FITID", () => {
    const a = computeImportHashes(1, [
      { date: "2026-10-05", amount: 1n, descriptionRaw: "X", fitid: "F1" },
    ]);
    const b = computeImportHashes(1, [
      { date: "2026-10-06", amount: 2n, descriptionRaw: "Y", fitid: "F1" },
    ]);
    expect(a).toEqual(b); // same FITID = same transaction, whatever the bank re-labels it
  });
});
