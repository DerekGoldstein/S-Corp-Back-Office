import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "./src/lib/session";

export async function middleware(request: NextRequest) {
  const secret = process.env.SESSION_SECRET;
  if (secret === undefined || secret === "") {
    // Not configured yet: allow only the login page, which explains setup.
    if (request.nextUrl.pathname === "/login") return NextResponse.next();
    return NextResponse.redirect(new URL("/login?setup=1", request.url));
  }
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const ok = await verifySessionToken(secret, token);
  if (request.nextUrl.pathname === "/login") {
    return ok ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }
  if (!ok) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
