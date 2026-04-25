/**
 * Audit flag types — extracted from engine.ts to keep the per-op module
 * importing from a small types file rather than the full engine.
 *
 * source: cross-audit code-reviewer Blocking-#1 (Phase 3+4 follow-up, 2026-04).
 */

import type { SectionType } from "@prd-gen/core";

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

export interface SectionInput {
  readonly type: SectionType;
  readonly content: string;
}
