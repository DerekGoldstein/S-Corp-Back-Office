import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyPassword } from "../../src/lib/auth";
import { createSessionToken, SESSION_COOKIE } from "../../src/lib/session";
import { loadEnv } from "../../src/lib/env";
import { Banner } from "../../src/ui/banner";
import type { Sp } from "../../src/ui/fmt";

async function login(formData: FormData): Promise<void> {
  "use server";
  loadEnv();
  const password = formData.get("password");
  // Indexed access on purpose: the bundler inlines dotted `process.env.X`
  // reads into the build, which would freeze the hash at build time and make
  // password changes silently ineffective until the next rebuild.
  const hash = process.env["OWNER_PASSWORD_HASH"];
  const secret = process.env["SESSION_SECRET"];
  if (!hash || !secret) {
    redirect("/login?setup=1");
  }
  if (typeof password !== "string" || !verifyPassword(password, hash)) {
    redirect(`/login?err=${encodeURIComponent("wrong password")}`);
  }
  const token = await createSessionToken(secret);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env["APP_SECURE_COOKIES"] === "1",
    maxAge: 7 * 24 * 3600,
  });
  redirect("/");
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const needsSetup = sp.setup === "1";
  return (
    <div className="login-wrap">
      <div className="login-box panel">
        <h1>S-Corp Back Office</h1>
        <Banner sp={sp} />
        {needsSetup ? (
          <div className="banner err">
            Not configured yet. Copy <span className="mono">.env.example</span> to{" "}
            <span className="mono">.env</span>, set <span className="mono">SESSION_SECRET</span>{" "}
            (<span className="mono">openssl rand -base64 32</span>) and run{" "}
            <span className="mono">npm run set-password</span>, then restart.
          </div>
        ) : (
          <form action={login}>
            <label className="field">
              password
              <input type="password" name="password" autoFocus required />
            </label>
            <p>
              <button type="submit">Sign in</button>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
