import { parseCsv } from "../lib/csv";
import { parseDollars } from "../lib/cents";
import type { CsvImportProfile } from "../db/schema";
import type { ParsedTxn } from "./normalize";

export class CsvImportError extends Error {}

export type CsvParseResult = { txns: ParsedTxn[]; warnings: string[] };

/** Parse a bank CSV export using the account's stored import profile. */
export function parseBankCsv(text: string, profile: CsvImportProfile): CsvParseResult {
  const rows = parseCsv(text, profile.delimiter ?? ",");
  const skip = profile.skipRows ?? 0;
  const headerRow = rows[skip];
  if (!headerRow) throw new CsvImportError("no header row found (check skipRows)");
  const headers = headerRow.map((h) => h.trim().toLowerCase());
  const col = (name: string): number => {
    const i = headers.indexOf(name.trim().toLowerCase());
    if (i === -1) {
      throw new CsvImportError(
        `column ${JSON.stringify(name)} not found; headers are: ${headers.join(", ")}`,
      );
    }
    return i;
  };
  const dateIdx = col(profile.dateColumn);
  const descIdxs = profile.descriptionColumns.map(col);
  const amountIdx = profile.amountColumn !== undefined ? col(profile.amountColumn) : undefined;
  const debitIdx = profile.debitColumn !== undefined ? col(profile.debitColumn) : undefined;
  const creditIdx = profile.creditColumn !== undefined ? col(profile.creditColumn) : undefined;
  if (amountIdx === undefined && debitIdx === undefined && creditIdx === undefined) {
    throw new CsvImportError("profile needs amountColumn or debitColumn/creditColumn");
  }

  const txns: ParsedTxn[] = [];
  const warnings: string[] = [];
  for (let r = skip + 1; r < rows.length; r++) {
    const cells = rows[r]!;
    if (cells.every((c) => c.trim() === "")) continue;
    const line = r + 1;
    try {
      const date = parseDateCell(cells[dateIdx] ?? "", profile.dateFormat);
      let amount: bigint;
      if (amountIdx !== undefined) {
        const rawAmount = (cells[amountIdx] ?? "").trim();
        if (rawAmount === "") {
          warnings.push(`line ${line}: empty amount, skipped`);
          continue;
        }
        amount = parseDollars(rawAmount);
        if (profile.negateAmount) amount = -amount;
      } else {
        const debitRaw = debitIdx !== undefined ? (cells[debitIdx] ?? "").trim() : "";
        const creditRaw = creditIdx !== undefined ? (cells[creditIdx] ?? "").trim() : "";
        if (debitRaw !== "" && creditRaw !== "") {
          throw new CsvImportError("both debit and credit populated");
        }
        if (debitRaw === "" && creditRaw === "") {
          warnings.push(`line ${line}: no amount, skipped`);
          continue;
        }
        amount = debitRaw !== "" ? -abs(parseDollars(debitRaw)) : abs(parseDollars(creditRaw));
      }
      const descriptionRaw = descIdxs
        .map((i) => (cells[i] ?? "").trim())
        .filter((s) => s !== "")
        .join(" ");
      if (descriptionRaw === "") {
        warnings.push(`line ${line}: empty description, skipped`);
        continue;
      }
      txns.push({ date, amount, descriptionRaw });
    } catch (err) {
      warnings.push(`line ${line}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { txns, warnings };
}

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

export function parseDateCell(cell: string, format: "MDY" | "DMY" | "YMD"): string {
  const s = cell.trim();
  const parts = s.split(/[/\-.]/).map((p) => p.trim());
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new CsvImportError(`unparseable date ${JSON.stringify(cell)}`);
  }
  let y: number, m: number, d: number;
  const [a, b, c] = parts.map(Number) as [number, number, number];
  if (format === "YMD") [y, m, d] = [a, b, c];
  else if (format === "MDY") [m, d, y] = [a, b, c];
  else [d, m, y] = [a, b, c];
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) {
    throw new CsvImportError(`implausible date ${JSON.stringify(cell)}`);
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
