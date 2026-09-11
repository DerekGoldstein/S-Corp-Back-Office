import { NextResponse } from "next/server";
import { getDb } from "../../../../src/db/client";
import { readDocument } from "../../../../src/vault/store";

/** Auth-guarded (middleware) download of a vault document, hash-verified. */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  try {
    const { document, bytes } = await readDocument(getDb(), BigInt(id));
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": document.mime,
        "content-disposition": `inline; filename="${document.filename.replaceAll('"', "")}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "not found", { status: 404 });
  }
}
