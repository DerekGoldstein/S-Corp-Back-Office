/**
 * HTML → PDF via headless Chromium (pre-installed in the CCR container at
 * /opt/pw-browsers/chromium; configurable via CHROMIUM_PATH). No PDF
 * library dependency. When no Chromium is available the caller stores the
 * HTML itself — the content, not the container, is the record.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function chromiumPath(): string | null {
  const candidates = [
    process.env.CHROMIUM_PATH,
    "/opt/pw-browsers/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const c of candidates) {
    if (c !== undefined && c !== "" && existsSync(c)) return c;
  }
  return null;
}

export type RenderedRecord = { bytes: Buffer; mime: "application/pdf" | "text/html" };

/** Render HTML to PDF when Chromium is available; otherwise pass the HTML through. */
export function htmlToPdf(html: string): RenderedRecord {
  const chromium = chromiumPath();
  if (chromium === null) {
    return { bytes: Buffer.from(html, "utf8"), mime: "text/html" };
  }
  const dir = mkdtempSync(join(tmpdir(), "record-pdf-"));
  try {
    const htmlPath = join(dir, "record.html");
    const pdfPath = join(dir, "record.pdf");
    writeFileSync(htmlPath, html);
    execFileSync(
      chromium,
      [
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--no-pdf-header-footer",
        `--print-to-pdf=${pdfPath}`,
        `file://${htmlPath}`,
      ],
      { stdio: "pipe", timeout: 30_000 },
    );
    return { bytes: readFileSync(pdfPath), mime: "application/pdf" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
