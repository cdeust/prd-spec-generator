import { z } from "zod";

export const PipelineStepSchema = z.enum([
  "banner",
  "preflight",
  "context_detection",
  "input_analysis",
  "feasibility_gate",
  "clarification",
  "budget",
  "section_generation",
  "jira_generation",
  "file_export",
  "self_check",
  "complete",
]);
export type PipelineStep = z.infer<typeof PipelineStepSchema>;
