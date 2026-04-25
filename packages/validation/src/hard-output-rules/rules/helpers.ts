import type {
  HardOutputRule,
  HardOutputRuleViolation,
  SectionType,
} from "@prd-gen/core";
import { isCriticalRule, scorePenalty } from "@prd-gen/core";

/**
 * Find all matches of a pattern and return a violation for each.
 * Ported from HardOutputRulesValidator+Evaluation.swift findPatternViolations.
 */
export function findPatternViolations(
  pattern: RegExp,
  content: string,
  rule: HardOutputRule,
  sectionType: SectionType,
  message: string,
): HardOutputRuleViolation[] {
  const matches = content.match(pattern);
  if (!matches) return [];

  return matches.map((match) => ({
    rule,
    sectionType,
    message,
    offendingContent: match.length > 0 ? match.substring(0, 120) : null,
    location: null,
    isCritical: isCriticalRule(rule),
    scorePenalty: scorePenalty(rule),
  }));
}

/**
 * Check that content contains enough signals from a keyword list.
 * Returns a violation if the signal count is below the threshold.
 */
export function findAbsenceViolation(
  content: string,
  signals: readonly string[],
  threshold: number,
  rule: HardOutputRule,
  sectionType: SectionType,
  message: string,
): HardOutputRuleViolation[] {
  const lowered = content.toLowerCase();
  const signalCount = signals.filter((s) => lowered.includes(s)).length;

  if (signalCount < threshold) {
    return [
      {
        rule,
        sectionType,
        message,
        offendingContent: null,
        location: null,
        isCritical: isCriticalRule(rule),
        scorePenalty: scorePenalty(rule),
      },
    ];
  }

  return [];
}

/**
 * Create a single violation object.
 */
export function makeViolation(
  rule: HardOutputRule,
  sectionType: SectionType | null,
  message: string,
  offendingContent: string | null = null,
): HardOutputRuleViolation {
  return {
    rule,
    sectionType,
    message,
    offendingContent,
    location: null,
    isCritical: isCriticalRule(rule),
    scorePenalty: scorePenalty(rule),
  };
}

/**
 * Extract code blocks from markdown content.
 * Returns the inner content of each ```...``` block.
 */
export function extractCodeBlocks(content: string): string[] {
  const pattern = /```(?:\w+)?\s*\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

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
 * Returns true when the content mentions at least one `topicSignal` AND, in a
 * window of ±OPT_OUT_WINDOW characters around that mention, any opt-out
 * marker appears.
 *
 * source: bug found 2026-04-26 during the wiki-grooming PRD run on the
 * Cortex repo. The Technical Specification section for a local-CLI feature
 * was forced to fail rules that only apply to network services. Author kept
 * adding "N/A — local CLI, no network surface" prose, but the validator's
 * keyword check ignored those acknowledgements and demanded the prescribed
 * ceremonial keywords. This helper closes that gap.
 */
const OPT_OUT_WINDOW = 240;

const OPT_OUT_MARKERS: readonly string[] = [
  "n/a",
  "not applicable",
  "by construction",
  "no network",
  "no database",
  "no endpoint",
  "no public surface",
  "no public interface",
  "no http",
  "no rest",
  "no graphql",
  "no grpc",
  "no users",
  "no caller",
  "no remote",
  "no service",
  "no api",
  "absent surface",
  "no attack surface",
  "out of scope",
];

export function hasExplicitOptOut(
  content: string,
  topicSignals: readonly string[],
): boolean {
  if (topicSignals.length === 0) return false;
  const lowered = content.toLowerCase();
  for (const topic of topicSignals) {
    const t = topic.toLowerCase();
    let idx = lowered.indexOf(t);
    while (idx !== -1) {
      const start = Math.max(0, idx - OPT_OUT_WINDOW);
      const end = Math.min(lowered.length, idx + t.length + OPT_OUT_WINDOW);
      const window = lowered.substring(start, end);
      for (const marker of OPT_OUT_MARKERS) {
        if (window.includes(marker)) return true;
      }
      idx = lowered.indexOf(t, idx + t.length);
    }
  }
  return false;
}

/**
 * Extract a type name from a line containing a type declaration.
 * Ported from CodeQualityRules extractTypeName.
 */
export function extractTypeName(line: string): string {
  const typeKeywords = [
    "struct",
    "class",
    "enum",
    "interface",
    "object",
    "record",
  ];
  const words = line.split(/\s+/).filter((w) => w.length > 0);

  for (let i = 0; i < words.length; i++) {
    const clean = words[i].toLowerCase().replace(/[^\w]/g, "");
    if (typeKeywords.includes(clean) && i + 1 < words.length) {
      return words[i + 1].replace(/[^\w]/g, "");
    }
  }

  return "Unknown";
}
