import { NextResponse } from "next/server";
import { getDb } from "../../../../src/db/client";
import { exportYearArchive } from "../../../../src/vault/export";

export const dynamic = "force-dynamic";

/** Auth-guarded (middleware) CPA hand-off zip: workpapers + year documents. */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ year: string }> },
): Promise<NextResponse> {
  const { year } = await ctx.params;
  const taxYear = Number(year);
  if (!Number.isInteger(taxYear) || taxYear < 2027 || taxYear > 2100) {
    return new NextResponse("bad year", { status: 400 });
  }
  try {
    const { zip, filename } = await exportYearArchive(getDb(), taxYear);
    return new NextResponse(new Uint8Array(zip), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "export failed", { status: 500 });
  }
}
