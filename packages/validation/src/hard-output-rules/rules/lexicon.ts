/**
 * Shared bilingual (EN/FR) concept lexicon for hard-output-rule keyword and
 * opt-out detection — barrel module.
 *
 * Precondition: none — this module has no runtime dependencies beyond the
 * standard library; every export is a pure function of its arguments.
 * Postcondition: every concept ID resolves to a non-empty EN entry (FR may
 * be empty only for concepts that are language-neutral, e.g. code-syntax
 * tokens); `phrases`/`matchCount`/`matchesAny`/`hasExplicitOptOut` never
 * mutate `LEXICON`.
 *
 * Why this module exists (single source of truth, not per-rule copy-paste):
 * every hard-output rule that scans PRD prose for a concept ("this spec
 * addresses encryption", "this spec opts out of rate limiting") used to
 * carry its own English keyword array. A French PRD section describing the
 * exact same concept in French shared no substring with those arrays, so
 * the rule fired a false violation. Fixing this per-rule (as commit
 * f346204 started doing for 5 of ~20 affected rules) reproduces the same
 * bug for every rule family not yet patched, and leaves two live
 * mechanisms (bilingual vs. English-only) in the same codebase. This
 * module is the fix at the mechanism level: every rule that needs to
 * recognize a concept in prose imports the concept's ID from here and
 * calls `phrases`, `matchCount`, `matchesAny`, or `hasExplicitOptOut`.
 * Adding a third language later means adding one field per concept across
 * the lexicon-*.ts partials below — zero rule files change.
 *
 * The concept groups themselves live in lexicon-shared.ts,
 * lexicon-security.ts, lexicon-data-protection.ts, lexicon-observability.ts,
 * lexicon-resilience.ts, and lexicon-quality.ts (split to stay under the
 * 500-line file limit, coding-standards.md §4.1) and are merged here into
 * one `LEXICON` map so every rule file keeps importing from "./lexicon.js"
 * unchanged.
 *
 * source: bug found 2026-07-15, e2e run run_mrlqa0aj_u2rh15 (see commit
 * f346204 for the first 5 rules patched under time pressure during that
 * incident). This module unifies those 5 with every other keyword-list
 * rule in security-rules.ts, data-protection-rules.ts,
 * observability-rules.ts, resilience-rules.ts, and senior-quality-rules.ts
 * that shared the same English-only defect.
 */

import type { LexiconConcept } from "./lexicon-types.js";
import { SHARED_LEXICON } from "./lexicon-shared.js";
import { SECURITY_LEXICON } from "./lexicon-security.js";
import { DATA_PROTECTION_LEXICON } from "./lexicon-data-protection.js";
import { OBSERVABILITY_LEXICON } from "./lexicon-observability.js";
import { RESILIENCE_LEXICON } from "./lexicon-resilience.js";
import { QUALITY_LEXICON } from "./lexicon-quality.js";

export type { LexiconConcept } from "./lexicon-types.js";

/**
 * All concept groups, keyed by a stable concept ID. Every phrase is
 * lowercase (matching is always done against lowercased content).
 */
export const LEXICON = {
  ...SHARED_LEXICON,
  ...SECURITY_LEXICON,
  ...DATA_PROTECTION_LEXICON,
  ...OBSERVABILITY_LEXICON,
  ...RESILIENCE_LEXICON,
  ...QUALITY_LEXICON,
} as const satisfies Record<string, LexiconConcept>;

/** Every valid concept ID in {@link LEXICON}. */
export type ConceptId = keyof typeof LEXICON;

/**
 * Flatten one or more concepts into a single lowercase phrase list
 * (EN + FR, in declaration order, duplicates preserved).
 *
 * Precondition: every id is a key of LEXICON (enforced by the ConceptId
 * type at compile time).
 * Postcondition: result.length === sum of en.length + fr.length across
 * the given concepts; every phrase in result is lowercase.
 */
export function phrases(...ids: ConceptId[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const concept = LEXICON[id];
    out.push(...concept.en, ...concept.fr);
  }
  return out;
}

/**
 * Count how many distinct phrases across the given concepts appear in
 * content (case-insensitive substring match). Mirrors the pre-existing
 * per-rule `signals.filter((s) => lowered.includes(s)).length` idiom, so
 * callers can drop this in as a threshold check without changing
 * threshold values.
 */
export function matchCount(content: string, ids: ConceptId[]): number {
  const lowered = content.toLowerCase();
  return phrases(...ids).filter((p) => lowered.includes(p)).length;
}

/** True if content contains at least one phrase from the given concepts. */
export function matchesAny(content: string, ids: ConceptId[]): boolean {
  const lowered = content.toLowerCase();
  return phrases(...ids).some((p) => lowered.includes(p));
}

/** Window (characters) searched around a topic mention for an opt-out marker. */
const OPT_OUT_WINDOW = 240;

/**
 * Detect explicit "N/A" / "by construction" opt-outs for a rule's topic.
 *
 * Some hard-output rules (auth, rate-limiting, secure-communication, GDPR
 * consent, distributed tracing, sensitive-data-protection, structured-error-
 * handling, transaction boundaries, etc.) are service-shaped and don't apply
 * to many feature subtypes — local CLIs, libraries, batch jobs, read-only
 * validators. Rather than forcing every spec to invent ceremonial language,
 * this helper recognizes when the spec acknowledges the topic and explicitly
 * opts out with a justification.
 *
 * Precondition: topicIds is non-empty for a meaningful check (empty always
 * returns false — no topic mention can be matched).
 * Postcondition: returns true iff content mentions at least one phrase from
 * the union of `topicIds`' concepts AND, within ±OPT_OUT_WINDOW characters
 * of that mention, at least one `optOut` marker phrase appears (either
 * language, independent of the mention's language).
 *
 * source: bug found 2026-04-26 during the wiki-grooming PRD run on the
 * Cortex repo (see git history for the original English-only version in
 * hard-output-rules/helpers.ts). Extended bilingual 2026-07-15 (e2e run
 * run_mrlqa0aj_u2rh15) and centralized into this lexicon module so a third
 * language is a one-file change instead of an N-file one.
 */
export function hasExplicitOptOut(
  content: string,
  topicIds: ConceptId[],
): boolean {
  if (topicIds.length === 0) return false;
  const lowered = content.toLowerCase();
  const topicPhrases = phrases(...topicIds);
  const optOutPhrases = phrases("optOut");
  for (const topic of topicPhrases) {
    let idx = lowered.indexOf(topic);
    while (idx !== -1) {
      const start = Math.max(0, idx - OPT_OUT_WINDOW);
      const end = Math.min(lowered.length, idx + topic.length + OPT_OUT_WINDOW);
      const window = lowered.substring(start, end);
      for (const marker of optOutPhrases) {
        if (window.includes(marker)) return true;
      }
      idx = lowered.indexOf(topic, idx + topic.length);
    }
  }
  return false;
}
