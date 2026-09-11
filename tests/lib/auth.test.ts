/**
 * Regression coverage for the login-freeze bug: @next/env variable-expands
 * `$N` sequences in .env values, so a `$`-separated scrypt hash loaded
 * through it was silently mangled and every login failed after a password
 * change. The format is now colon-separated (nothing for dotenv-expand to
 * eat) and legacy `$` hashes still verify.
 */
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/lib/auth";

describe("password hashing", () => {
  it("round-trips and rejects wrong passwords", () => {
    const h = hashPassword("a perfectly long password");
    expect(verifyPassword("a perfectly long password", h)).toBe(true);
    expect(verifyPassword("a perfectly long passwore", h)).toBe(false);
    expect(verifyPassword("", h)).toBe(false);
  });

  it("emits no dotenv-expandable characters (the login-freeze regression)", () => {
    const h = hashPassword("a perfectly long password");
    expect(h.startsWith("scrypt:")).toBe(true);
    expect(h).not.toContain("$");
    // what @next/env's expansion would do to a $-separated value: nothing here
    expect(h.replaceAll(/\$[0-9]+/g, "")).toBe(h);
  });

  it("still verifies a legacy $-separated hash", () => {
    const legacy = hashPassword("a perfectly long password").replaceAll(":", "$");
    expect(verifyPassword("a perfectly long password", legacy)).toBe(true);
    expect(verifyPassword("something else entirely", legacy)).toBe(false);
  });

  it("rejects malformed stored values instead of throwing", () => {
    expect(verifyPassword("whatever pw", "scrypt6384==mangled")).toBe(false);
    expect(verifyPassword("whatever pw", "")).toBe(false);
    expect(verifyPassword("whatever pw", "scrypt:1:2:3:notenough")).toBe(false);
  });

  it("refuses short passwords at hash time", () => {
    expect(() => hashPassword("short")).toThrow(/at least 10/);
  });
});
