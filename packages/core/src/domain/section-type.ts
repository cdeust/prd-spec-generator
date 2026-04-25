import { z } from "zod";

/**
 * PRD section types — ported from SectionType.swift.
 * rawValue uses snake_case for serialization compatibility.
 *
 * `jira_tickets` is a synthetic section produced by jira-generation; it is
 * not subject to the standard hard-output rules and is written to its own
 * file by file-export.
 */
export const SectionTypeSchema = z.enum([
  "overview",
  "goals",
  "requirements",
  "user_stories",
  "technical_specification",
  "acceptance_criteria",
  "data_model",
  "api_specification",
  "security_considerations",
  "performance_requirements",
  "testing",
  "deployment",
  "risks",
  "timeline",
  "source_code",
  "test_code",
  "jira_tickets",
]);

export type SectionType = z.infer<typeof SectionTypeSchema>;

export const SECTION_DISPLAY_NAMES: Record<SectionType, string> = {
  overview: "Overview",
  goals: "Goals & Objectives",
  requirements: "Requirements",
  user_stories: "User Stories",
  technical_specification: "Technical Specification",
  acceptance_criteria: "Acceptance Criteria",
  data_model: "Data Model",
  api_specification: "API Specification",
  security_considerations: "Security Considerations",
  performance_requirements: "Performance Requirements",
  testing: "Testing Strategy",
  deployment: "Deployment Plan",
  risks: "Risks & Mitigation",
  timeline: "Timeline & Milestones",
  source_code: "Source Code",
  test_code: "Test Code",
  jira_tickets: "JIRA Tickets",
};

export const SECTION_ORDER: Record<SectionType, number> = {
  overview: 0,
  goals: 1,
  requirements: 2,
  user_stories: 3,
  technical_specification: 4,
  acceptance_criteria: 5,
  data_model: 6,
  api_specification: 7,
  security_considerations: 8,
  performance_requirements: 9,
  testing: 10,
  deployment: 11,
  risks: 12,
  timeline: 13,
  source_code: 14,
  test_code: 15,
  jira_tickets: 16,
};
