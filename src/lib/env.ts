import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

let loaded = false;

/** Load .env once (no dependency). Existing process env always wins. */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function requireEnv(key: string): string {
  loadEnv();
  const v = process.env[key];
  if (v === undefined || v === "") {
    throw new Error(`missing required environment variable ${key} (see .env.example)`);
  }
  return v;
}
