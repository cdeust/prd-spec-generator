/**
 * Per-pipeline-op handlers for `evaluateAlgorithmicRule`.
 *
 * Each handler mutates the shared `vars` record in place; `flag_if` is the
 * only op that can short-circuit the pipeline by returning an AuditFinding.
 *
 * source: cross-audit code-reviewer Blocking-#1 + #4 (Phase 3+4 follow-up,
 * 2026-04). Pre-fix the dispatch + ops + condition evaluator + template
 * interpolator all lived in engine.ts, which exceeded §4.1 (510 → 560 lines)
 * and §4.2 (evaluateAlgorithmicRule was 91 lines). Splitting along the
 * "rule-level orchestration vs per-op execution" boundary keeps both
 * concerns under their respective caps.
 */

import type { AuditRule, AuditFinding, SectionInput } from "./types.js";
import { combineSections, hasMatch, testRegex, makeFinding } from "./helpers.js";

export function opCrossSectionPresence(
  op: AuditRule["pipeline"][number],
  sections: readonly SectionInput[],
  vars: Record<string, unknown>,
): void {
  const sourceSections = (op.source_sections as string[]) ?? [];
  const targetSections = (op.target_sections as string[]) ?? [];
  const sourceContent = combineSections(sections, sourceSections);
  const targetContent = combineSections(sections, targetSections);
  vars["source_found"] = testRegex(op.source_pattern as string, sourceContent).length;
  vars["target_found"] = testRegex(op.target_pattern as string, targetContent).length;
}

export function opExtract(
  op: AuditRule["pipeline"][number],
  rule: AuditRule,
  sections: readonly SectionInput[],
  vars: Record<string, unknown>,
): void {
  const content = combineSections(sections, rule.sections);
  const matches = testRegex(op.pattern as string, content);
  const name = (op.into ?? op.store_as) as string;
  vars[name] = matches.map((m) => m[0]);
}

export function opExtractTable(
  op: AuditRule["pipeline"][number],
  rule: AuditRule,
  sections: readonly SectionInput[],
  vars: Record<string, unknown>,
): void {
  const content = combineSections(sections, rule.sections);
  const name = (op.into ?? op.store_as) as string;
  if (hasMatch(op.header_pattern as string, content)) {
    vars[name] = content.split("\n").filter((l) => l.includes("|"));
  } else {
    vars[name] = [];
  }
}

export function opCount(
  op: AuditRule["pipeline"][number],
  vars: Record<string, unknown>,
): void {
  const source = (op.from ?? op.source) as string;
  const storeName = (op.into ?? op.store_as) as string;
  const arr = vars[source];
  const count = Array.isArray(arr) ? arr.length : 0;
  vars[storeName] = count;
  vars["total"] = count;
}

export function opSimilarity(
  op: AuditRule["pipeline"][number],
  vars: Record<string, unknown>,
): void {
  const arr = vars[(op.from ?? op.source) as string];
  if (!Array.isArray(arr) || arr.length < 2) {
    vars["similar_count"] = 0;
    return;
  }
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
}

export function opRatio(
  op: AuditRule["pipeline"][number],
  vars: Record<string, unknown>,
): void {
  const arr = vars[op.numerator_from as string];
  if (!Array.isArray(arr)) return;
  const match = (op.numerator_match as string).toUpperCase();
  const total = arr.length;
  const hits = arr.filter((v) => String(v).toUpperCase().includes(match)).length;
  vars["pass_rate"] = total > 0 ? hits / total : 0;
  vars["total"] = total;
}

export function opFlagIf(
  op: AuditRule["pipeline"][number],
  rule: AuditRule,
  vars: Record<string, unknown>,
): AuditFinding | null {
  const condition = op.condition as string;
  if (!evaluateCondition(condition, vars)) return null;
  const template = (op.finding as string) ?? rule.description;
  const message = interpolateVars(template, vars);
  return makeFinding(rule, 1, message);
}

// ─── Condition + template helpers ────────────────────────────────────────────

export function evaluateCondition(
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

export function interpolateVars(
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
