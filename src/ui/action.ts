import { redirect } from "next/navigation";

/**
 * Server-action wrapper: run `fn`, then redirect back to `path` with
 * ?ok=<message> or ?err=<message>. Keeps every mutation's outcome visible
 * without client JS. `fn` must not itself redirect.
 */
export async function runAction(path: string, fn: () => Promise<string>): Promise<never> {
  let ok: string | undefined;
  let err: string | undefined;
  try {
    ok = await fn();
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  if (err !== undefined) {
    redirect(`${path}?err=${encodeURIComponent(err.slice(0, 500))}`);
  }
  redirect(`${path}?ok=${encodeURIComponent((ok ?? "done").slice(0, 300))}`);
}

export function fd(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export function fdRequired(formData: FormData, key: string): string {
  const v = fd(formData, key);
  if (v === "") throw new Error(`${key} is required`);
  return v;
}
