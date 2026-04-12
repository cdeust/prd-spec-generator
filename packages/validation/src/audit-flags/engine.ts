import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import type { SectionType } from "@prd-gen/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditRuleFamily {
  readonly code: string;
  readonly name: string;
  readonly display_name: string;
  readonly description: string;
  readonly primary_persona: string;
}

interface DetectPattern {
  readonly pattern: string;
  readonly description: string;
}

interface SuppressPattern {
  readonly pattern: string;
  readonly scope: string;
  readonly description: string;
}

interface PipelineOp {
  readonly op: string;
  readonly [key: string]: unknown;
}

export interface AuditRule {
  readonly id: string;
  readonly family: AuditRuleFamily;
  readonly name: string;
  readonly display_name: string;
  readonly description: string;
  readonly type: "pattern" | "algorithmic";
  readonly mode?: "presence" | "absence" | "cross_section_presence";
  readonly severity?: string;
  readonly sections: readonly string[];
  readonly detect: readonly DetectPattern[];
  readonly suppress: readonly SuppressPattern[];
  readonly pipeline: readonly PipelineOp[];
  readonly claim_count: string;
  readonly suggested_action: string;
}

export interface AuditFinding {
  readonly ruleId: string;
  readonly familyCode: string;
  readonly familyName: string;
  readonly ruleName: string;
  readonly message: string;
  readonly suggestedAction: string;
  readonly severity: string;
  readonly matchCount: number;
}

export interface AuditFlagReport {
  readonly findings: readonly AuditFinding[];
  readonly totalFlags: number;
  readonly familySummary: Record<string, number>;
}

// ---------------------------------------------------------------------------
// YAML loading
// ---------------------------------------------------------------------------

function loadRulesFromDir(rulesDir: string): readonly AuditRule[] {
  const rules: AuditRule[] = [];

  let files: string[];
  try {
    files = readdirSync(rulesDir).filter((f) => f.endsWith(".yaml"));
  } catch {
    return rules;
  }

  for (const file of files) {
    try {
      const raw = readFileSync(join(rulesDir, file), "utf-8");
      const doc = yaml.load(raw) as {
        family?: AuditRuleFamily;
        rules?: Array<Record<string, unknown>>;
      };
      if (!doc?.family || !doc?.rules) continue;

      for (const r of doc.rules) {
        rules.push({
          id: `${doc.family.code}-${String(r.id).padStart(3, "0")}`,
          family: doc.family,
          name: String(r.name ?? ""),
          display_name: String(r.display_name ?? ""),
          description: String(r.description ?? ""),
          type: (r.type as "pattern" | "algorithmic") ?? "pattern",
          mode: r.mode as "presence" | "absence" | "cross_section_presence" | undefined,
          severity: r.severity as string | undefined,
          sections: (r.sections as string[]) ?? [],
          detect: (r.detect as DetectPattern[]) ?? [],
          suppress: (r.suppress as SuppressPattern[]) ?? [],
          pipeline: (r.pipeline as PipelineOp[]) ?? [],
          claim_count: String(r.claim_count ?? "detect_matches"),
          suggested_action: String(r.suggested_action ?? ""),
        });
      }
    } catch {
      // Skip malformed YAML files
    }
  }

  return rules;
}

// ---------------------------------------------------------------------------
// Pattern helpers
// ---------------------------------------------------------------------------

function testRegex(pattern: string, text: string): RegExpMatchArray[] {
  try {
    const re = new RegExp(pattern, "gm");
    return [...text.matchAll(re)];
  } catch {
    return [];
  }
}

function hasMatch(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, "gm").test(text);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Suppress scope evaluation
// ---------------------------------------------------------------------------

function getLineIndex(text: string, charIndex: number): number {
  let line = 0;
  for (let i = 0; i < charIndex && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

function getRowAtIndex(lines: readonly string[], lineIdx: number): string {
  return lines[lineIdx] ?? "";
}

function getNearbyLines(
  lines: readonly string[],
  lineIdx: number,
  radius: number,
): string {
  const start = Math.max(0, lineIdx - radius);
  const end = Math.min(lines.length, lineIdx + radius + 1);
  return lines.slice(start, end).join("\n");
}

function isSuppressedAtMatch(
  suppressors: readonly SuppressPattern[],
  sectionContent: string,
  matchIndex: number,
  allContent: string,
): boolean {
  if (suppressors.length === 0) return false;

  const lines = sectionContent.split("\n");
  const lineIdx = getLineIndex(sectionContent, matchIndex);

  for (const sup of suppressors) {
    let searchText: string;

    if (sup.scope === "same_row") {
      searchText = getRowAtIndex(lines, lineIdx);
    } else if (sup.scope === "same_section") {
      searchText = sectionContent;
    } else if (sup.scope === "any_section") {
      searchText = allContent;
    } else if (sup.scope.startsWith("nearby_lines_")) {
      const radius = parseInt(sup.scope.slice("nearby_lines_".length), 10);
      searchText = getNearbyLines(lines, lineIdx, radius);
    } else {
      searchText = sectionContent;
    }

    if (hasMatch(sup.pattern, searchText)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Section helpers
// ---------------------------------------------------------------------------

interface SectionInput {
  readonly type: SectionType;
  readonly content: string;
}

function sectionMatchesRule(
  sectionType: SectionType,
  ruleSections: readonly string[],
): boolean {
  return ruleSections.length === 0 || ruleSections.includes(sectionType);
}

function combineSections(
  sections: readonly SectionInput[],
  filter: readonly string[],
): string {
  return sections
    .filter((s) => filter.length === 0 || filter.includes(s.type))
    .map((s) => s.content)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Pattern rule evaluation
// ---------------------------------------------------------------------------

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

  return makeFinding(rule, totalMatches,
    `${rule.description} (${totalMatches} occurrence${totalMatches > 1 ? "s" : ""})`);
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

// ---------------------------------------------------------------------------
// Algorithmic (pipeline) rule evaluation
// ---------------------------------------------------------------------------

function evaluateAlgorithmicRule(
  rule: AuditRule,
  sections: readonly SectionInput[],
): AuditFinding | null {
  const vars: Record<string, unknown> = {};

  for (const op of rule.pipeline) {
    switch (op.op) {
      case "cross_section_presence": {
        const sourceSections = (op.source_sections as string[]) ?? [];
        const targetSections = (op.target_sections as string[]) ?? [];
        const sourceContent = combineSections(sections, sourceSections);
        const targetContent = combineSections(sections, targetSections);
        vars["source_found"] = testRegex(op.source_pattern as string, sourceContent).length;
        vars["target_found"] = testRegex(op.target_pattern as string, targetContent).length;
        break;
      }

      case "extract": {
        const content = combineSections(sections, rule.sections);
        const matches = testRegex(op.pattern as string, content);
        const name = (op.into ?? op.store_as) as string;
        vars[name] = matches.map((m) => m[0]);
        break;
      }

      case "extract_table": {
        const content = combineSections(sections, rule.sections);
        const name = (op.into ?? op.store_as) as string;
        if (hasMatch(op.header_pattern as string, content)) {
          vars[name] = content.split("\n").filter((l) => l.includes("|"));
        } else {
          vars[name] = [];
        }
        break;
      }

      case "count": {
        const source = (op.from ?? op.source) as string;
        const storeName = (op.into ?? op.store_as) as string;
        const arr = vars[source];
        const count = Array.isArray(arr) ? arr.length : 0;
        vars[storeName] = count;
        vars["total"] = count;
        break;
      }

      case "similarity": {
        const arr = vars[(op.from ?? op.source) as string];
        if (Array.isArray(arr) && arr.length >= 2) {
          const threshold = (op.threshold as number) ?? 0.8;
          let count = 0;
          for (let i = 0; i < arr.length; i++) {
            for (let j = i + 1; j < arr.length; j++) {
              if (jaccardSimilarity(String(arr[i]), String(arr[j])) >= threshold) {
                count++;
              }
            }
          }
          vars["similar_count"] = count;
        } else {
          vars["similar_count"] = 0;
        }
        break;
      }

      case "ratio": {
        const arr = vars[op.numerator_from as string];
        if (Array.isArray(arr)) {
          const match = (op.numerator_match as string).toUpperCase();
          const total = arr.length;
          const hits = arr.filter((v) => String(v).toUpperCase().includes(match)).length;
          vars["pass_rate"] = total > 0 ? hits / total : 0;
          vars["total"] = total;
        }
        break;
      }

      case "flag_if": {
        const condition = op.condition as string;
        if (evaluateCondition(condition, vars)) {
          const template = (op.finding as string) ?? rule.description;
          const message = interpolateVars(template, vars);
          return makeFinding(rule, 1, message);
        }
        break;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Condition evaluator
// ---------------------------------------------------------------------------

function evaluateCondition(
  condition: string,
  vars: Record<string, unknown>,
): boolean {
  return condition
    .split(/\s+AND\s+/i)
    .every((part) => evaluateComparison(part.trim(), vars));
}

function evaluateComparison(
  expr: string,
  vars: Record<string, unknown>,
): boolean {
  const ops = [">=", "<=", "!=", ">", "<", "=="] as const;
  for (const op of ops) {
    const idx = expr.indexOf(op);
    if (idx === -1) continue;

    const left = resolveNum(expr.slice(0, idx).trim(), vars);
    const right = resolveNum(expr.slice(idx + op.length).trim(), vars);

    switch (op) {
      case ">=": return left >= right;
      case "<=": return left <= right;
      case "!=": return left !== right;
      case ">":  return left > right;
      case "<":  return left < right;
      case "==": return left === right;
    }
  }
  return false;
}

function resolveNum(token: string, vars: Record<string, unknown>): number {
  const n = Number(token);
  if (!Number.isNaN(n)) return n;
  const v = vars[token];
  return typeof v === "number" ? v : 0;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function interpolateVars(
  template: string,
  vars: Record<string, unknown>,
): string {
  return template.replace(/\{(\w+)(?::([^}]+))?\}/g, (_m, name: string) => {
    const val = vars[name];
    if (val === undefined) return `{${name}}`;
    if (typeof val === "number") return String(Math.round(val * 100) / 100);
    return String(val);
  });
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function makeFinding(
  rule: AuditRule,
  matchCount: number,
  message: string,
): AuditFinding {
  return {
    ruleId: rule.id,
    familyCode: rule.family.code,
    familyName: rule.family.display_name,
    ruleName: rule.display_name,
    message,
    suggestedAction: rule.suggested_action,
    severity: rule.severity ?? "warning",
    matchCount,
  };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

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
