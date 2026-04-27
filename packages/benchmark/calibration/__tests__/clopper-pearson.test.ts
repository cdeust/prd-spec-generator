import { describe, it, expect } from "vitest";
import { clopperPearson } from "../clopper-pearson.js";

describe("clopperPearson", () => {
  // source: tabulated values, e.g. R's binom.test(0, 200), Hahn & Meeker
  // (1991), table A.2. 0/200 → upper bound ≈ 0.0183 (95%).
  it("0 fires in K=200 → upper ≈ 0.0183", () => {
    const ci = clopperPearson(0, 200);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBeGreaterThan(0.017);
    expect(ci.upper).toBeLessThan(0.020);
  });

  // source: 0/460 → upper ≈ 0.0080 per Phase 4.3 sample-size pre-reg.
  it("0 fires in K=460 → upper < 0.01 (Phase 4.3 H0 ceiling)", () => {
    const ci = clopperPearson(0, 460);
    expect(ci.upper).toBeLessThan(0.01);
    expect(ci.upper).toBeGreaterThan(0.005);
  });

  // source: x=n boundary returns upper=1 by convention (Clopper & Pearson 1934).
  it("x=n returns upper=1", () => {
    const ci = clopperPearson(50, 50);
    expect(ci.upper).toBe(1);
  });

  // source: x=0 boundary returns lower=0 by convention.
  it("x=0 returns lower=0", () => {
    const ci = clopperPearson(0, 100);
    expect(ci.lower).toBe(0);
  });

  it("rejects invalid input", () => {
    expect(() => clopperPearson(0, 0)).toThrow();
    expect(() => clopperPearson(-1, 10)).toThrow();
    expect(() => clopperPearson(11, 10)).toThrow();
  });
});
