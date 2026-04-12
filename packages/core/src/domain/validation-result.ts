import { z } from "zod";
import { HardOutputRuleSchema } from "./hard-output-rule.js";
import { SectionTypeSchema } from "./section-type.js";

export const HardOutputRuleViolationSchema = z.object({
  rule: HardOutputRuleSchema,
  sectionType: SectionTypeSchema.nullable(),
  message: z.string(),
  offendingContent: z.string().nullable(),
  location: z.string().nullable(),
  isCritical: z.boolean(),
  scorePenalty: z.number().min(0).max(1),
});

export type HardOutputRuleViolation = z.infer<typeof HardOutputRuleViolationSchema>;

export const ValidationReportSchema = z.object({
  violations: z.array(HardOutputRuleViolationSchema),
  rulesChecked: z.array(HardOutputRuleSchema),
  rulesPassed: z.array(HardOutputRuleSchema),
  sectionType: SectionTypeSchema.nullable(),
  hasCriticalViolations: z.boolean(),
  totalScore: z.number().min(0).max(1),
  checkedAt: z.string().datetime(),
});

export type ValidationReport = z.infer<typeof ValidationReportSchema>;

export const CrossRefValidationResultSchema = z.object({
  danglingReferences: z.array(z.object({
    id: z.string(),
    referencedIn: z.string(),
    type: z.string(),
  })),
  orphanNodes: z.array(z.object({
    id: z.string(),
    type: z.string(),
    reason: z.string(),
  })),
  cycles: z.array(z.array(z.string())),
  numberingGaps: z.array(z.object({
    prefix: z.string(),
    expected: z.number(),
    actual: z.number(),
  })),
  duplicateIds: z.array(z.string()),
  isValid: z.boolean(),
});

export type CrossRefValidationResult = z.infer<typeof CrossRefValidationResultSchema>;
