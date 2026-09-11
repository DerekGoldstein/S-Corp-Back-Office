/**
 * Session tokens: HMAC-SHA256 over an expiry payload, WebCrypto only — this
 * file must stay importable from the Edge middleware (no node: imports).
 */
const encoder = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export const SESSION_COOKIE = "scorp_session";
const SESSION_TTL_SECONDS = 7 * 24 * 3600;

export async function createSessionToken(secret: string, nowMs = Date.now()): Promise<string> {
  const payload = b64url(
    encoder.encode(
      JSON.stringify({ exp: Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS }),
    ),
  );
  const key = await hmacKey(secret);
  const sig = b64url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return `${payload}.${sig}`;
}

export async function verifySessionToken(
  secret: string,
  token: string | undefined,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const key = await hmacKey(secret);
  const expected = b64url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return false;
  try {
    // atob exists in both Node and the Edge runtime (Buffer does not)
    const decoded = JSON.parse(
      atob(payload.replaceAll("-", "+").replaceAll("_", "/")),
    ) as { exp: number };
    return decoded.exp * 1000 > nowMs;
  } catch {
    return false;
  }
}
