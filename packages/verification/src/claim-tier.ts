/**
 * Claim verification tiering — classifies each extracted Claim as
 * "mechanical" (its verification method is a deterministic, tool-executable
 * check: grep/diff/time/kcov/count/exact-string comparison) or "subjective"
 * (requires semantic/design judgment a rule cannot perform).
 *
 * Mechanical claims get NO judge panel — self-check.ts emits a deterministic
 * rule-tier verdict directly (mechanical-verdict.ts) instead of spending a
 * judge invocation on a claim a script could answer. This is the primary
 * invocation-count reduction of the verification-tiering feature: judging
 * is read-and-compare work for subjective claims, and PURE EXECUTION for
 * mechanical ones — spawning an LLM judge for the latter wastes the
 * invocation and adds nothing a deterministic check doesn't already give.
 *
 * Classification is CONSERVATIVE by construction: a claim only becomes
 * "mechanical" when (a) its claim_type is one of the types where an atomic,
 * single-fact deterministic check is plausible, AND (b) its own text PLUS
 * evidence together name an explicit deterministic verification method
 * (grep, diff, time, kcov, wc -l, exit-code, absence-of-pattern, checksum,
 * or a named gate). Absent either condition, the claim stays "subjective" —
 * when unsure, judge it. "architecture" and "fr_traceability" claims are
 * ALWAYS subjective regardless of text content: an architecture claim
 * ("ports and adapters") and a requirement's design intent ("replace X with
 * Y") both require judging WHETHER an implementation satisfies an intent,
 * not just whether a literal pattern is present in the diff — a mechanical
 * check can confirm the pattern is present/absent but cannot confirm intent
 * satisfaction, so routing them to the mechanical tier would silently
 * downgrade a judgment call to a rubber stamp.
 *
 * `evidence` is included uniformly for every mechanical-eligible claim type
 * (no more per-type carve-out — see git history for the retired
 * EVIDENCE_INCLUDED_CLAIM_TYPES workaround). That carve-out existed solely
 * because claim-extractor.ts's `snippet()` used a fixed-size line window
 * that ignored claim boundaries: two AC/NFR bullets separated by a single
 * blank line could leak an ADJACENT claim's wording into THIS claim's
 * evidence (calibrated failure case: AC-009's evidence used to contain
 * AC-010's "...n'est présente..." marker text, which would have
 * false-positived AC-009 to "mechanical"). `snippet()` now bounds every
 * evidence window at the neighboring claim's own start line (and at
 * markdown headings) — see claim-extractor.ts's `snippet` doc comment and
 * its regression test — so a claim's `evidence` can no longer contain
 * another claim's text, and the workaround's premise no longer holds.
 *
 * Calibrated against the 29 real claims of e2e run run_mrlqa0aj_u2rh15
 * (16 acceptance criteria + 12 functional requirements + 1 architecture
 * claim — session-optimizer/prd-output/run_mrlq/01-prd.md, "## Acceptance
 * Criteria" / "## Requirements" / "### Architecture (ports/adapters)"
 * sections). AC-010 through AC-016 name an explicit inspection method
 * ("quand on grep...", "quand on diffe...", "exécution `time` moyennée",
 * "aucune occurrence n'est trouvée", "passe la gate G6") and classify
 * mechanical; AC-001 through AC-009 assert a specific rendered outcome
 * ("la couleur retournée est HEAT_1", "rendu segmenté multi-couleurs")
 * without naming a verification method, and classify subjective — including
 * AC-008, the claim the multi-judge panel actually caught a FAIL on
 * (mendeleev, confidence 0.60, ID-collision + rendering-model contradiction)
 * in that run; a purely mechanical check would have missed it entirely,
 * which is the concrete argument for keeping semantic ACs off the
 * mechanical tier. FR-001 through FR-012 are design-intent statements with
 * no named verification method and classify subjective per the
 * fr_traceability blanket rule above.
 *
 * source: design-phases-3-5.md "Verification tiering & monoculture limits";
 * arXiv:2602.11865 (DeepMind, "Cognitive Monoculture" threat class).
 */

import type { Claim } from "@prd-gen/core";

export type ClaimTier = "mechanical" | "subjective";

/**
 * Claim types where an atomic, single-fact deterministic check is
 * plausible. This is a NECESSARY, not sufficient, condition — see module
 * doc. "architecture" and "fr_traceability" are deliberately excluded.
 */
const MECHANICAL_ELIGIBLE_CLAIM_TYPES: ReadonlySet<Claim["claim_type"]> = new Set([
  "acceptance_criteria_completeness",
  "test_coverage",
  "data_model",
  "story_point_arithmetic",
  "performance",
]);

/**
 * Explicit deterministic-verification-method markers. Matched against
 * `claim.text + " " + claim.evidence` (case-insensitive). Each marker names
 * a literal tool, command, or absence-of-pattern assertion a script can
 * execute without semantic judgment — see module doc for the AC-010..016
 * derivation this was calibrated against.
 */
const MECHANICAL_METHOD_MARKERS: readonly RegExp[] = [
  /\bgrep\b/i,
  /\bdiff\w*\b/i, // diff, diffe, diffé, diffing
  /\bkcov\b/i,
  /\bwc -l\b/i,
  /\btime\b/i, // `time <cmd>` / "exécution `time` moyennée"
  /\bexit code\b/i,
  /\bcode de sortie\b/i,
  /\bsans erreur\b/i, // deterministic exit-status check
  /\bgate\s+g\d/i, // named pass/fail gate, e.g. "gate G6"
  /\bn['’]est\s+(?:pas\s+)?(?:présente?|trouvée?)\b/i, // absence-of-pattern
  /\baucune occurrence\b/i,
  /\bcheck ?sum\b|\bsha256\b/i,
];

/**
 * precondition:  none — `claim` is any extracted Claim.
 * postcondition: pure function; returns "mechanical" only when claim_type is
 *                eligible AND the claim's own text/evidence names an
 *                explicit deterministic verification method; "subjective"
 *                otherwise (the conservative default).
 */
export function classifyClaimTier(claim: Claim): ClaimTier {
  if (!MECHANICAL_ELIGIBLE_CLAIM_TYPES.has(claim.claim_type)) {
    return "subjective";
  }
  const haystack = `${claim.text} ${claim.evidence}`;
  return MECHANICAL_METHOD_MARKERS.some((re) => re.test(haystack))
    ? "mechanical"
    : "subjective";
}
