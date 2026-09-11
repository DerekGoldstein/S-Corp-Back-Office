/**
 * MACRS as arithmetic. Golden values are HAND-DERIVED from the
 * declining-balance-with-SL-switch definition (worked in the comments);
 * on round bases they coincide with the familiar Pub 946 table
 * percentages, which is the point — the tables are this arithmetic.
 */
import { describe, expect, it } from "vitest";
import {
  MacrsError,
  firstYearEighths,
  macrsSchedule,
  midQuarterTest,
  quarterOf,
} from "../../src/assets/macrs";

describe("macrsSchedule", () => {
  it("5-year 200DB half-year on $10,000 reproduces the canonical 20/32/19.2/11.52/11.52/5.76", () => {
    const s = macrsSchedule({
      basis: 1_000_000n,
      method: "macrs_200db",
      recoveryYears: 5,
      convention: "half_year",
    });
    expect(s).toEqual([200_000n, 320_000n, 192_000n, 115_200n, 115_200n, 57_600n]);
    expect(s.reduce((a, b) => a + b, 0n)).toBe(1_000_000n);
  });

  it("7-year 200DB half-year on $10,000: exact formula cents, switch to SL in year 6, sums to basis", () => {
    // y1 10000*2/7*1/2 = 1428.57; y2 8571.43*2/7 = 2448.98; y3 1749.27;
    // y4 1249.48; y5 DB=SL 892.49; y6 SL 892.48; y7 SL 892.49; y8 tail 446.24
    const s = macrsSchedule({
      basis: 1_000_000n,
      method: "macrs_200db",
      recoveryYears: 7,
      convention: "half_year",
    });
    expect(s).toEqual([
      142_857n, 244_898n, 174_927n, 124_948n, 89_249n, 89_248n, 89_249n, 44_624n,
    ]);
    expect(s.reduce((a, b) => a + b, 0n)).toBe(1_000_000n);
  });

  it("mid-quarter Q4 5-year 200DB on $10,000 reproduces the canonical 5/38/22.8/13.68/10.94/9.58", () => {
    const s = macrsSchedule({
      basis: 1_000_000n,
      method: "macrs_200db",
      recoveryYears: 5,
      convention: "mid_quarter",
      quarter: 4,
    });
    expect(s).toEqual([50_000n, 380_000n, 228_000n, 136_800n, 109_440n, 95_760n]);
  });

  it("straight line 5-year half-year on $10,000: 10/20/20/20/20/10", () => {
    const s = macrsSchedule({
      basis: 1_000_000n,
      method: "sl",
      recoveryYears: 5,
      convention: "half_year",
    });
    expect(s).toEqual([100_000n, 200_000n, 200_000n, 200_000n, 200_000n, 100_000n]);
  });

  it("an odd basis still sums exactly to the basis (final-year remainder)", () => {
    const basis = 1_000_137n;
    const s = macrsSchedule({
      basis,
      method: "macrs_200db",
      recoveryYears: 7,
      convention: "half_year",
    });
    expect(s).toHaveLength(8);
    expect(s.every((x) => x >= 0n)).toBe(true);
    expect(s.reduce((a, b) => a + b, 0n)).toBe(basis);
  });

  it("zero basis (fully expensed via 179/bonus) yields an empty schedule", () => {
    expect(
      macrsSchedule({ basis: 0n, method: "macrs_200db", recoveryYears: 5, convention: "half_year" }),
    ).toEqual([]);
  });
});

describe("conventions", () => {
  it("mid-quarter fractions are (9-2q)/8 and require the quarter", () => {
    expect(firstYearEighths("half_year")).toBe(4n);
    expect(firstYearEighths("mid_quarter", 1)).toBe(7n);
    expect(firstYearEighths("mid_quarter", 4)).toBe(1n);
    expect(() => firstYearEighths("mid_quarter")).toThrow(MacrsError);
    expect(quarterOf("2027-11-15")).toBe(4);
    expect(quarterOf("2027-03-31")).toBe(1);
  });

  it("mid-quarter test is strict: exactly 40% in Q4 stays half-year", () => {
    expect(
      midQuarterTest([
        { basisAfter179: 60_000n, quarter: 1 },
        { basisAfter179: 40_000n, quarter: 4 },
      ]),
    ).toBe("half_year");
    expect(
      midQuarterTest([
        { basisAfter179: 59_000n, quarter: 2 },
        { basisAfter179: 41_000n, quarter: 4 },
      ]),
    ).toBe("mid_quarter");
    expect(midQuarterTest([])).toBe("half_year");
  });
});
