/**
 * Set/replace OWNER_PASSWORD_HASH in .env (creating .env from scratch if
 * needed) and generate SESSION_SECRET / APP_ENCRYPTION_KEY when absent.
 * Usage: npm run set-password -- 'your long password'
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { hashPassword } from "../src/lib/auth";

const password = process.argv[2];
if (!password) {
  console.error("usage: npm run set-password -- 'your long password'");
  process.exit(1);
}

const hash = hashPassword(password);
const envPath = resolve(process.cwd(), ".env");
let lines: string[] = existsSync(envPath)
  ? readFileSync(envPath, "utf8").split("\n")
  : [];

function upsert(key: string, value: string, onlyIfMissing = false): void {
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) {
    if (!onlyIfMissing) lines[idx] = `${key}=${value}`;
  } else {
    lines.push(`${key}=${value}`);
  }
}

// Single-quoted so dotenv-style loaders never variable-expand the values
// (base64 can contain '+'/'='; the hash format avoids '$' for the same reason).
upsert("OWNER_PASSWORD_HASH", `'${hash}'`);
upsert("SESSION_SECRET", `'${randomBytes(32).toString("base64")}'`, true);
upsert("APP_ENCRYPTION_KEY", `'${randomBytes(32).toString("base64")}'`, true);
lines = lines.filter((l, i) => !(l === "" && i === lines.length - 1));
writeFileSync(envPath, lines.join("\n") + "\n", { mode: 0o600 });
console.log("password hash written to .env (SESSION_SECRET / APP_ENCRYPTION_KEY ensured)");
