import { formatCents } from "../lib/cents";
import type { Cents } from "../lib/cents";

/** $1,234.56 / ($1,234.56) for tables. */
export function money(c: Cents): string {
  const s = `$${formatCents(c < 0n ? -c : c)}`;
  return c < 0n ? `(${s})` : s;
}

/** Plain 1,234.56 (blank when zero) for debit/credit columns. */
export function dcCell(c: Cents): string {
  return c === 0n ? "" : formatCents(c);
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function currentYear(): number {
  return new Date().getFullYear();
}

export type Sp = Record<string, string | string[] | undefined>;

export function spStr(sp: Sp, key: string, fallback = ""): string {
  const v = sp[key];
  return typeof v === "string" ? v : fallback;
}
