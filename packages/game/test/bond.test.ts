import { describe, expect, it } from "vitest";
import { BOND_CAP, bondBonus } from "../src/stats.ts";

describe("bond", () => {
  it("grows 2% per battle and stops at the cap", () => {
    expect(bondBonus(0)).toBe(0);
    expect(bondBonus(5)).toBeCloseTo(0.1);
    expect(bondBonus(9)).toBeCloseTo(BOND_CAP);
    expect(bondBonus(40)).toBe(BOND_CAP);
  });
});
