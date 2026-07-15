/**
 * Opt-out coverage introspection.
 *
 * f346204 found checkCryptographicStandards was the only security rule with
 * NO opt-out escape at all — a local script with zero encryption surface
 * could never satisfy it, no matter how it justified the non-applicability.
 * This test generalizes that audit: it introspects every exported `check*`
 * rule function in the five "service/context-shaped" rule files
 * (security-rules.ts, data-protection-rules.ts, observability-rules.ts,
 * resilience-rules.ts, senior-quality-rules.ts) and asserts each one either
 * (a) calls `hasExplicitOptOut(` — the rule admits a justified N/A, or
 * (b) is explicitly declared exempt below, with a one-line reason.
 *
 * Precondition: the imported modules export only `check*` functions plus
 * (in senior-quality-rules.ts) helpers re-exported from ./helpers.js — the
 * `name.startsWith("check")` filter excludes anything else.
 * Postcondition: a rule function added to one of these five files in the
 * future is either given an opt-out escape or added to OPT_OUT_EXEMPT with
 * a reviewable reason; the test fails loudly otherwise instead of silently
 * reproducing the f346204 defect class.
 *
 * This is a static-source introspection (Function.prototype.toString()),
 * not a behavioral one — it directly catches "the call is missing
 * entirely", which is the exact failure mode found in commit f346204. The
 * *behavior* of each opt-out (does it actually suppress the violation when
 * a French/English marker is present) is separately pinned per-rule in
 * bilingual-lexicon.test.ts and validation.test.ts.
 *
 * Note: under vitest's SSR module transform, `fn.toString()` renders
 * imported call sites as `(0,__vite_ssr_import_N__.hasExplicitOptOut)(...)`
 * rather than a bare `hasExplicitOptOut(`, so the match is on the
 * `.hasExplicitOptOut)(` suffix (the property-access + call, independent of
 * the generated import alias) instead of the literal source spelling.
 */

import { describe, expect, it } from "vitest";
import * as securityRules from "../hard-output-rules/rules/security-rules.js";
import * as dataProtectionRules from "../hard-output-rules/rules/data-protection-rules.js";
import * as observabilityRules from "../hard-output-rules/rules/observability-rules.js";
import * as resilienceRules from "../hard-output-rules/rules/resilience-rules.js";
import * as seniorQualityRules from "../hard-output-rules/rules/senior-quality-rules.js";

/**
 * Rules whose category does NOT admit a legitimate "N/A": universal
 * code-hygiene or pattern-detection concerns that apply to every codebase
 * regardless of whether the feature has a network/service/API surface.
 * "N/A — by construction" would never be a truthful justification for
 * skipping these, so they are exempt from the opt-out requirement.
 */
const OPT_OUT_EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    "checkNoHardcodedSecrets",
    "pattern-detection only (fires on evidence found in code examples); there is no 'absence' state to opt out of",
  ],
  [
    "checkNoMagicNumbers",
    "universal code hygiene — every codebase with code examples can have magic numbers",
  ],
  [
    "checkDefensiveCoding",
    "universal code hygiene — every function has preconditions/inputs to guard",
  ],
  [
    "checkMethodSizeLimits",
    "structural measurement of code-block line counts, not a concept-absence check",
  ],
  [
    "checkConsistentNaming",
    "universal code hygiene — every codebase has identifiers to name",
  ],
]);

const RULE_MODULES: ReadonlyArray<{
  readonly name: string;
  readonly mod: Record<string, unknown>;
}> = [
  { name: "security-rules", mod: securityRules },
  { name: "data-protection-rules", mod: dataProtectionRules },
  { name: "observability-rules", mod: observabilityRules },
  { name: "resilience-rules", mod: resilienceRules },
  { name: "senior-quality-rules", mod: seniorQualityRules },
];

describe("opt-out coverage — every applicable rule calls hasExplicitOptOut", () => {
  for (const { name: moduleName, mod } of RULE_MODULES) {
    for (const [exportName, fn] of Object.entries(mod)) {
      if (typeof fn !== "function") continue;
      if (!exportName.startsWith("check")) continue;

      if (OPT_OUT_EXEMPT.has(exportName)) {
        it(`${moduleName}.${exportName} is declared exempt: ${OPT_OUT_EXEMPT.get(exportName)}`, () => {
          expect(OPT_OUT_EXEMPT.has(exportName)).toBe(true);
        });
        continue;
      }

      it(`${moduleName}.${exportName} calls hasExplicitOptOut`, () => {
        const source = fn.toString();
        // Matches both the plain-source form (`hasExplicitOptOut(`) and
        // vitest's SSR-transformed form
        // (`(0,__vite_ssr_import_N__.hasExplicitOptOut)(`).
        const callsHasExplicitOptOut =
          source.includes("hasExplicitOptOut(") ||
          /\bhasExplicitOptOut\)\(/.test(source);
        expect(callsHasExplicitOptOut).toBe(true);
      });
    }
  }

  it("every exported check* function was accounted for (no silently-skipped module)", () => {
    let total = 0;
    for (const { mod } of RULE_MODULES) {
      total += Object.keys(mod).filter(
        (n) => n.startsWith("check") && typeof mod[n] === "function",
      ).length;
    }
    // 8 security + 6 data-protection + 4 observability + 5 resilience
    // + 6 senior-quality = 29 exported check* functions across the five
    // audited files as of this change.
    expect(total).toBe(29);
  });
});
