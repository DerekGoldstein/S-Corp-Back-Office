import { parseDollars } from "../lib/cents";
import type { ParsedTxn } from "./normalize";

export class OfxImportError extends Error {}

export type OfxParseResult = { txns: ParsedTxn[]; warnings: string[] };

/**
 * Tolerant OFX/QFX parser covering both flavors in the wild:
 *  - OFX 1.x: SGML with a colon-separated header block (OFXHEADER:100 …)
 *  - OFX 2.x: XML with an <?xml…?> prolog
 * We only need the bank statement transaction list: every <STMTTRN> block's
 * TRNTYPE/DTPOSTED/TRNAMT/FITID/NAME/MEMO. Values run to the next tag; SGML
 * close tags are optional and simply ignored.
 */
export function parseOfx(text: string): OfxParseResult {
  const warnings: string[] = [];
  const curdef = tagValue(text, "CURDEF");
  if (curdef !== undefined && curdef.toUpperCase() !== "USD") {
    throw new OfxImportError(`unsupported currency ${curdef} (single-currency app)`);
  }
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  if (blocks.length === 0) {
    throw new OfxImportError("no <STMTTRN> transactions found — is this an OFX/QFX export?");
  }
  const txns: ParsedTxn[] = [];
  for (const [i, blockRaw] of blocks.entries()) {
    const block = blockRaw.split(/<\/STMTTRN>/i)[0]!;
    const n = i + 1;
    try {
      const dt = tagValue(block, "DTPOSTED");
      const amt = tagValue(block, "TRNAMT");
      const fitid = tagValue(block, "FITID");
      const name = tagValue(block, "NAME");
      const memo = tagValue(block, "MEMO");
      if (dt === undefined || amt === undefined) {
        warnings.push(`transaction ${n}: missing DTPOSTED or TRNAMT, skipped`);
        continue;
      }
      const m = /^(\d{4})(\d{2})(\d{2})/.exec(dt);
      if (!m) {
        warnings.push(`transaction ${n}: unparseable DTPOSTED ${dt}, skipped`);
        continue;
      }
      const date = `${m[1]}-${m[2]}-${m[3]}`;
      const amount = parseDollars(amt);
      const descriptionRaw = [name, memo].filter((s): s is string => !!s && s !== "").join(" ");
      if (descriptionRaw === "") {
        warnings.push(`transaction ${n}: no NAME/MEMO, using TRNTYPE`);
      }
      txns.push({
        date,
        amount,
        descriptionRaw: descriptionRaw || (tagValue(block, "TRNTYPE") ?? "UNKNOWN"),
        fitid,
      });
    } catch (err) {
      warnings.push(`transaction ${n}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { txns, warnings };
}

/** First <TAG>value in the text; value ends at the next '<' or newline. */
function tagValue(text: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i");
  const m = re.exec(text);
  const v = m?.[1]?.trim();
  return v === undefined || v === "" ? undefined : decodeEntities(v);
}

function decodeEntities(s: string): string {
  return s
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}
