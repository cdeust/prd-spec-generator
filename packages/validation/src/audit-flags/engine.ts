/**
 * Audit-flag engine — loads YAML rules + evaluates them against PRD sections.
 *
 * Decomposed into:
 *   - types.ts        — AuditRule / AuditFinding / SectionInput shapes
 *   - helpers.ts      — pattern + section + suppress + makeFinding helpers
 *   - pipeline-ops.ts — per-op handlers for algorithmic rules + condition
 *                       evaluator + template interpolator
 *   - engine.ts       — YAML loading + rule dispatch (this file)
 *
 * source: cross-audit code-reviewer Blocking-#1+#4 (Phase 3+4 follow-up,
 * 2026-04). Pre-fix this file was 510+ lines with a 91-line algorithmic
 * dispatch function. The decomposition keeps each module under §4.1 and
 * §4.2 caps without changing observable behaviour.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import type { SectionType } from "@prd-gen/core";

import type {
  AuditRule,
  AuditFinding,
  AuditFlagReport,
  SectionInput,
} from "./types.js";
import {
  testRegex,
  hasMatch,
  sectionMatchesRule,
  combineSections,
  isSuppressedAtMatch,
  makeFinding,
} from "./helpers.js";
import {
  opCrossSectionPresence,
  opExtract,
  opExtractTable,
  opCount,
  opSimilarity,
  opRatio,
  opFlagIf,
} from "./pipeline-ops.js";

export type {
  AuditRuleFamily,
  AuditRule,
  AuditFinding,
  AuditFlagReport,
} from "./types.js";

// ─── YAML loading ────────────────────────────────────────────────────────────

function loadRulesFromDir(rulesDir: string): readonly AuditRule[] {
  const rules: AuditRule[] = [];

  let entries: string[];
  try {
    entries = readdirSync(rulesDir);
  } catch {
    return rules;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    const path = join(rulesDir, entry);

    try {
      const text = readFileSync(path, "utf-8");
      const doc = yaml.load(text) as {
        family?: { code?: string; name?: string; display_name?: string; description?: string; primary_persona?: string };
        rules?: Array<Record<string, unknown>>;
      };
      if (!doc?.family || !doc.rules) continue;

      const family = {
        code: String(doc.family.code ?? ""),
        name: String(doc.family.name ?? ""),
        display_name: String(doc.family.display_name ?? ""),
        description: String(doc.family.description ?? ""),
        primary_persona: String(doc.family.primary_persona ?? ""),
      };

      for (const r of doc.rules) {
        rules.push({
          id: String(r.id ?? ""),
          family,
          name: String(r.name ?? ""),
          display_name: String(r.display_name ?? ""),
          description: String(r.description ?? ""),
          type: ((r.type as string) ?? "pattern") as "pattern" | "algorithmic",
          mode: r.mode as AuditRule["mode"],
          severity: r.severity as string | undefined,
          sections: ((r.sections as readonly string[]) ?? []),
          detect: ((r.detect as readonly AuditRule["detect"][number][]) ?? []),
          suppress: ((r.suppress as readonly AuditRule["suppress"][number][]) ?? []),
          pipeline: ((r.pipeline as readonly AuditRule["pipeline"][number][]) ?? []),
          claim_count: String(r.claim_count ?? ""),
          suggested_action: String(r.suggested_action ?? ""),
        });
      }
    } catch {
      // Skip malformed YAML files; surface via log if telemetry is added later.
      continue;
    }
  }

  return rules;
}

// ─── Pattern rule evaluation ─────────────────────────────────────────────────

function evaluatePresenceRule(
  rule: AuditRule,
  sections: readonly SectionInput[],
  allContent: string,
): AuditFinding | null {
  let totalMatches = 0;

  for (const section of sections) {
    if (!sectionMatchesRule(section.type, rule.sections)) continue;

    for (const det of rule.detect) {
      const matches = testRegex(det.pattern, section.content);
      for (const m of matches) {
        const idx = m.index ?? 0;
        if (!isSuppressedAtMatch(rule.suppress, section.content, idx, allContent)) {
          totalMatches++;
        }
      }
    }
  }

  if (totalMatches === 0) return null;

  return makeFinding(
    rule,
    totalMatches,
    `${rule.description} (${totalMatches} occurrence${totalMatches > 1 ? "s" : ""})`,
  );
}

function evaluateAbsenceRule(
  rule: AuditRule,
  sections: readonly SectionInput[],
  allContent: string,
): AuditFinding | null {
  const searchText = rule.sections.length === 0
    ? allContent
    : combineSections(sections, rule.sections);

  for (const det of rule.detect) {
    if (hasMatch(det.pattern, searchText)) return null;
  }

  return makeFinding(rule, 1, rule.description);
}

// ─── Algorithmic (pipeline) rule evaluation ──────────────────────────────────

function evaluateAlgorithmicRule(
  rule: AuditRule,
  sections: readonly SectionInput[],
): AuditFinding | null {
  const vars: Record<string, unknown> = {};
  for (const op of rule.pipeline) {
    switch (op.op) {
      case "cross_section_presence":
        opCrossSectionPresence(op, sections, vars);
        break;
      case "extract":
        opExtract(op, rule, sections, vars);
        break;
      case "extract_table":
        opExtractTable(op, rule, sections, vars);
        break;
      case "count":
        opCount(op, vars);
        break;
      case "similarity":
        opSimilarity(op, vars);
        break;
      case "ratio":
        opRatio(op, vars);
        break;
      case "flag_if": {
        const finding = opFlagIf(op, rule, vars);
        if (finding) return finding;
        break;
      }
    }
  }
  return null;
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export class AuditFlagEngine {
  private readonly rules: readonly AuditRule[];

  constructor(rulesDir?: string) {
    const defaultDir = join(dirname(fileURLToPath(import.meta.url)), "rules");
    this.rules = loadRulesFromDir(rulesDir ?? defaultDir);
  }

  get ruleCount(): number {
    return this.rules.length;
  }

  get familyCodes(): readonly string[] {
    return [...new Set(this.rules.map((r) => r.family.code))];
  }

  evaluate(
    sections: ReadonlyArray<{ readonly type: SectionType; readonly content: string }>,
  ): AuditFlagReport {
    const allContent = sections.map((s) => s.content).join("\n\n");
    const findings: AuditFinding[] = [];

    for (const rule of this.rules) {
      let finding: AuditFinding | null = null;

      if (rule.type === "pattern") {
        if (rule.mode === "presence") {
          finding = evaluatePresenceRule(rule, sections, allContent);
        } else if (rule.mode === "absence") {
          finding = evaluateAbsenceRule(rule, sections, allContent);
        }
      } else if (rule.type === "algorithmic") {
        finding = evaluateAlgorithmicRule(rule, sections);
      }

      if (finding !== null) {
        findings.push(finding);
      }
    }

    const familySummary: Record<string, number> = {};
    for (const f of findings) {
      familySummary[f.familyCode] = (familySummary[f.familyCode] ?? 0) + 1;
    }

    return {
      findings,
      totalFlags: findings.length,
      familySummary,
    };
  }
}
