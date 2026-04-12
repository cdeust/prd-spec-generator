import { z } from "zod";
import { PRDContextSchema } from "./prd-context.js";
import { SectionTypeSchema } from "./section-type.js";
import { LicenseTierSchema } from "./license-tier.js";
import { ClarificationAnswerSchema } from "./clarification.js";

export const PRDSectionSchema = z.object({
  type: SectionTypeSchema,
  title: z.string(),
  content: z.string(),
  order: z.number().int().min(0),
  metadata: z.object({
    generatedAt: z.string().datetime(),
    wordCount: z.number().int().min(0),
    strategy: z.string().optional(),
    validationStatus: z.enum(["pending", "passed", "failed"]),
    violationCount: z.number().int().min(0).default(0),
  }),
});

export type PRDSection = z.infer<typeof PRDSectionSchema>;

export const PRDDocumentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  context: PRDContextSchema,
  licenseTier: LicenseTierSchema,
  sections: z.array(PRDSectionSchema),
  clarificationAnswers: z.array(ClarificationAnswerSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PRDDocument = z.infer<typeof PRDDocumentSchema>;
