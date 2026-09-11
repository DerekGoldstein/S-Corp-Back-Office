import { describe, expect, it } from "vitest";
import {
  allocate,
  asCents,
  formatAccounting,
  formatCents,
  parseDollars,
  roundToWholeDollars,
  splitHalf,
  sumCents,
} from "./cents";

describe("parseDollars", () => {
  it("parses plain, comma, sign, symbol, and paren forms", () => {
    expect(parseDollars("1,234.56")).toBe(123456n);
    expect(parseDollars("12")).toBe(1200n);
    expect(parseDollars("-45.6")).toBe(-4560n);
    expect(parseDollars("$3.07")).toBe(307n);
    expect(parseDollars("(12.00)")).toBe(-1200n);
    expect(parseDollars("+0.01")).toBe(1n);
    expect(parseDollars("0")).toBe(0n);
  });
  it("rejects garbage and 3+ decimals", () => {
    expect(() => parseDollars("")).toThrow();
    expect(() => parseDollars("1.234")).toThrow();
    expect(() => parseDollars("12,34.00")).toThrow();
    expect(() => parseDollars("abc")).toThrow();
    expect(() => parseDollars("1e5")).toThrow();
  });
});

describe("asCents", () => {
  it("accepts safe integers, integer strings, bigints", () => {
    expect(asCents(150)).toBe(150n);
    expect(asCents("-42")).toBe(-42n);
    expect(asCents(7n)).toBe(7n);
  });
  it("rejects floats and non-integer strings", () => {
    expect(() => asCents(1.5)).toThrow();
    expect(() => asCents("1.5")).toThrow();
    expect(() => asCents(Number.MAX_SAFE_INTEGER + 2)).toThrow();
  });
});

describe("format", () => {
  it("formats with grouping and fixed decimals", () => {
    expect(formatCents(123456n)).toBe("1,234.56");
    expect(formatCents(-7n)).toBe("-0.07");
    expect(formatCents(0n)).toBe("0.00");
    expect(formatCents(100000000n)).toBe("1,000,000.00");
  });
  it("accounting style wraps negatives in parens", () => {
    expect(formatAccounting(-123456n)).toBe("($1,234.56)");
    expect(formatAccounting(5n)).toBe("$0.05");
  });
});

describe("allocate", () => {
  it("preserves the total exactly (largest remainder)", () => {
    expect(allocate(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(sumCents(allocate(999n, [3n, 2n, 1n]))).toBe(999n);
    expect(allocate(-100n, [1n, 1n, 1n])).toEqual([-34n, -33n, -33n]);
  });
  it("rejects zero/negative weights", () => {
    expect(() => allocate(100n, [])).toThrow();
    expect(() => allocate(100n, [0n, 0n])).toThrow();
    expect(() => allocate(100n, [-1n, 2n])).toThrow();
  });
});

describe("splitHalf (meals 50% limitation)", () => {
  it("gives the odd cent to the disallowed half (conservative)", () => {
    expect(splitHalf(101n)).toEqual({ deductible: 50n, disallowed: 51n });
    expect(splitHalf(100n)).toEqual({ deductible: 50n, disallowed: 50n });
    expect(splitHalf(0n)).toEqual({ deductible: 0n, disallowed: 0n });
  });
  it("deductible + disallowed always reconstruct the total", () => {
    for (const total of [1n, 2n, 3n, 999n, 123457n]) {
      const { deductible, disallowed } = splitHalf(total);
      expect(deductible + disallowed).toBe(total);
      expect(disallowed - deductible <= 1n).toBe(true);
    }
  });
});

describe("roundToWholeDollars (IRS rounding, workpapers only)", () => {
  it("rounds half away from zero at the dollar level", () => {
    expect(roundToWholeDollars(149n)).toBe(100n);
    expect(roundToWholeDollars(150n)).toBe(200n);
    expect(roundToWholeDollars(-150n)).toBe(-200n);
    expect(roundToWholeDollars(-149n)).toBe(-100n);
    expect(roundToWholeDollars(0n)).toBe(0n);
  });
});
