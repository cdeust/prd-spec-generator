#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRD_CONTEXT_CONFIGS,
  TIER_CAPABILITIES,
  STRATEGY_TIERS,
  type LicenseTier,
  type PRDContext,
  type SectionType,
} from "@prd-gen/core";

// EvidenceRepository is optional — requires better-sqlite3 native module
let EvidenceRepository: (new (dbPath?: string) => any) | null = null;
try {
  const mod = await import("@prd-gen/core");
  EvidenceRepository = mod.EvidenceRepository;
} catch {
  // better-sqlite3 not available — run without persistence
}

import { validateSection, validateDocument } from "@prd-gen/validation";
import {
  calculateContextBudget,
  SECTION_RECALL_TEMPLATES,
} from "./context-budget.js";
import { mapFailuresToRetrievals } from "./failure-mapper.js";
import {
  initializePipeline,
  getPipelineState,
  updatePipelineState,
  updateSectionStatus,
  addPipelineError,
  getPipelineStateSummary,
} from "./pipeline-state.js";

/**
 * PRD Generator MCP Server — native TypeScript.
 * Eliminates the Node.js↔Swift cross-language boundary.
 *
 * 11 tools: 7 existing (ported from index.js) + 4 new validation tools.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── License Resolution ──────────────────────────────────────────────────────

function resolveLicenseTier(): LicenseTier {
  const homedir = process.env.HOME ?? process.env.USERPROFILE ?? "";

  // Check for license file
  const licensePath = join(homedir, ".aiprd", "license.json");
  if (existsSync(licensePath)) {
    try {
      const data = JSON.parse(readFileSync(licensePath, "utf-8"));
      if (data.tier === "licensed" || data.tier === "trial") {
        return data.tier;
      }
    } catch {
      // Fall through to free
    }
  }

  // Check for trial file
  const trialPath = join(homedir, ".aiprd", "trial.json");
  if (existsSync(trialPath)) {
    try {
      const data = JSON.parse(readFileSync(trialPath, "utf-8"));
      const expiresAt = new Date(data.expiresAt);
      if (expiresAt > new Date()) {
        return "trial";
      }
    } catch {
      // Fall through to free
    }
  }

  return "free";
}

// ─── Config Loading ──────────────────────────────────────────────────────────

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? join(__dirname, "..", "..", "..");

function loadSkillConfig(): Record<string, unknown> {
  const configPaths = [
    process.env.PRD_GEN_SKILL_CONFIG,
    join(PLUGIN_ROOT, "skill-config.json"),
    join(PLUGIN_ROOT, "packages", "skill", "skill-config.json"),
  ].filter(Boolean) as string[];

  for (const p of configPaths) {
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf-8"));
    }
  }

  return { version: "2.0.0", status: "config_not_found" };
}

function loadSkillMd(): string {
  const skillPaths = [
    join(PLUGIN_ROOT, "skills", "ai-prd-generator", "SKILL.md"),
    join(PLUGIN_ROOT, "packages", "skill", "SKILL.md"),
  ];

  for (const p of skillPaths) {
    if (existsSync(p)) {
      return readFileSync(p, "utf-8");
    }
  }

  return "SKILL.md not found";
}

// ─── Server Setup ────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "prd-gen",
  version: "0.1.0",
});

// Lazy-init evidence repository (only when better-sqlite3 is available)
let _evidenceRepo: any = null;
function getEvidenceRepo(): any | null {
  if (!EvidenceRepository) return null;
  if (!_evidenceRepo) {
    try {
      _evidenceRepo = new EvidenceRepository();
    } catch {
      return null;
    }
  }
  return _evidenceRepo;
}

// ─── Tool 1: validate_license ────────────────────────────────────────────────

server.tool(
  "validate_license",
  "Resolve the current license tier (free/trial/licensed)",
  {},
  async () => {
    const tier = resolveLicenseTier();
    const capabilities = TIER_CAPABILITIES[tier];
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ tier, capabilities }, null, 2),
        },
      ],
    };
  },
);

// ─── Tool 2: get_license_features ────────────────────────────────────────────

server.tool(
  "get_license_features",
  "Get feature capabilities for the current license tier",
  {},
  async () => {
    const tier = resolveLicenseTier();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(TIER_CAPABILITIES[tier], null, 2),
        },
      ],
    };
  },
);

// ─── Tool 3: get_config ──────────────────────────────────────────────────────

server.tool(
  "get_config",
  "Get the full skill configuration",
  {},
  async () => {
    const config = loadSkillConfig();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(config, null, 2) }],
    };
  },
);

// ─── Tool 4: read_skill_config ───────────────────────────────────────────────

server.tool(
  "read_skill_config",
  "Read the SKILL.md content that drives PRD generation",
  {},
  async () => {
    const skillMd = loadSkillMd();
    return {
      content: [{ type: "text" as const, text: skillMd }],
    };
  },
);

// ─── Tool 5: check_health ────────────────────────────────────────────────────

server.tool(
  "check_health",
  "Check system health — verify all components are accessible",
  {},
  async () => {
    const tier = resolveLicenseTier();
    const configAvailable = loadSkillConfig().version !== undefined;
    const skillAvailable = loadSkillMd() !== "SKILL.md not found";

    let dbHealthy = false;
    try {
      const repo = getEvidenceRepo();
      if (repo) {
        repo.getQualityHistory(1);
        dbHealthy = true;
      }
    } catch {
      dbHealthy = false;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: "ok",
              licenseTier: tier,
              configAvailable,
              skillAvailable,
              evidenceDbHealthy: dbHealthy,
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── Tool 6: get_prd_context_info ────────────────────────────────────────────

server.tool(
  "get_prd_context_info",
  "Get configuration for a specific PRD context type",
  {
    context: z
      .enum([
        "proposal",
        "feature",
        "bug",
        "incident",
        "poc",
        "mvp",
        "release",
        "cicd",
      ])
      .describe("The PRD context type"),
  },
  async ({ context }) => {
    const config = PRD_CONTEXT_CONFIGS[context as PRDContext];
    return {
      content: [{ type: "text" as const, text: JSON.stringify(config, null, 2) }],
    };
  },
);

// ─── Tool 7: list_available_strategies ───────────────────────────────────────

server.tool(
  "list_available_strategies",
  "List thinking strategies available for the current license tier",
  {},
  async () => {
    const tier = resolveLicenseTier();
    const capabilities = TIER_CAPABILITIES[tier];
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              tier,
              strategies: capabilities.allowedStrategies,
              tiers: STRATEGY_TIERS,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── Tool 8: validate_prd_section (NEW) ──────────────────────────────────────

server.tool(
  "validate_prd_section",
  "Run deterministic Hard Output Rules validation on a single PRD section. Returns violations found — zero LLM calls, pure regex/parsing.",
  {
    content: z.string().describe("The markdown content of the PRD section"),
    section_type: z
      .enum([
        "overview", "goals", "requirements", "user_stories",
        "technical_specification", "acceptance_criteria", "data_model",
        "api_specification", "security_considerations",
        "performance_requirements", "testing", "deployment",
        "risks", "timeline", "source_code", "test_code",
      ])
      .describe("The type of PRD section being validated"),
  },
  async ({ content, section_type }) => {
    const report = validateSection(content, section_type as SectionType);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(report, null, 2) },
      ],
    };
  },
);

// ─── Tool 9: validate_prd_document (NEW) ─────────────────────────────────────

server.tool(
  "validate_prd_document",
  "Run full document validation including cross-section checks (SP arithmetic, AC numbering, FR-AC coverage, test traceability). Returns comprehensive validation report.",
  {
    sections: z
      .array(
        z.object({
          type: z.string().describe("Section type"),
          content: z.string().describe("Section content"),
        }),
      )
      .describe("Array of PRD sections to validate"),
  },
  async ({ sections }) => {
    const typedSections = sections.map((s) => ({
      type: s.type as SectionType,
      content: s.content,
    }));
    const report = validateDocument(typedSections);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(report, null, 2) },
      ],
    };
  },
);

// ─── Tool 10: get_quality_history (NEW) ──────────────────────────────────────

server.tool(
  "get_quality_history",
  "Get historical PRD quality scores from the evidence repository",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(20)
      .describe("Maximum number of records to return"),
  },
  async ({ limit }) => {
    const repo = getEvidenceRepo();
    const history = repo.getQualityHistory(limit);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(history, null, 2) },
      ],
    };
  },
);

// ─── Tool 11: get_strategy_effectiveness (NEW) ───────────────────────────────

server.tool(
  "get_strategy_effectiveness",
  "Get strategy performance data — actual vs expected improvement, compliance rate",
  {
    min_executions: z
      .number()
      .int()
      .min(1)
      .default(5)
      .describe("Minimum executions required to include a strategy"),
  },
  async ({ min_executions }) => {
    const repo = getEvidenceRepo();
    const performance = repo.getStrategyPerformance(min_executions);
    const adjustments = repo.getHistoricalAdjustments(min_executions);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              performance,
              adjustments: Object.fromEntries(adjustments),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── Tool 12: coordinate_context_budget (NEW — Beer's S2) ────────────────────

server.tool(
  "coordinate_context_budget",
  "Calculate token budget allocation for PRD generation. Returns per-section retrieval limits for Cortex recall, generation budgets, and section-specific query templates. Call this BEFORE starting section generation.",
  {
    prd_context: z
      .enum(["proposal", "feature", "bug", "incident", "poc", "mvp", "release", "cicd"])
      .describe("The PRD context type"),
    completed_sections: z
      .array(z.string())
      .default([])
      .describe("Section types already generated"),
    context_window_size: z
      .number()
      .int()
      .default(200000)
      .describe("Total context window size in tokens"),
  },
  async ({ prd_context, completed_sections, context_window_size }) => {
    const budget = calculateContextBudget(
      prd_context as PRDContext,
      completed_sections,
      context_window_size,
    );
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { budget, recallTemplates: SECTION_RECALL_TEMPLATES },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── Tool 13: map_failure_to_retrieval (NEW — Feedback Loop) ─────────────────

server.tool(
  "map_failure_to_retrieval",
  "When validate_prd_section returns violations, call this to get corrective Cortex recall queries. Closes the validation→retrieval feedback loop so retries use better context.",
  {
    violations: z
      .array(
        z.object({
          rule: z.string(),
          message: z.string(),
          isCritical: z.boolean(),
          scorePenalty: z.number(),
          sectionType: z.string().nullable(),
          offendingContent: z.string().nullable(),
          location: z.string().nullable(),
        }),
      )
      .describe("Violations from validate_prd_section"),
  },
  async ({ violations }) => {
    const result = mapFailuresToRetrievals(violations as any);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  },
);

// ─── Tool 14: initialize_pipeline (NEW — Pipeline State) ─────────────────────

server.tool(
  "initialize_pipeline",
  "Start a new PRD generation pipeline. Creates a tracked run with unique ID. Call at the beginning of /generate-prd.",
  {
    feature_description: z.string().describe("What the PRD is about"),
    codebase_path: z
      .string()
      .optional()
      .describe("Path to the codebase being analyzed"),
  },
  async ({ feature_description, codebase_path }) => {
    const tier = resolveLicenseTier();
    const state = initializePipeline(tier, feature_description, codebase_path);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(state, null, 2) },
      ],
    };
  },
);

// ─── Tool 15: get_pipeline_state (NEW — Pipeline State) ──────────────────────

server.tool(
  "get_pipeline_state",
  "Get current pipeline state — which step, which sections done, errors, budget consumed. Use the summary format to save context tokens.",
  {
    format: z
      .enum(["full", "summary"])
      .default("summary")
      .describe("'summary' for compact view, 'full' for complete state"),
  },
  async ({ format }) => {
    if (format === "summary") {
      const summary = getPipelineStateSummary();
      return {
        content: [
          {
            type: "text" as const,
            text: summary ?? "No active pipeline. Call initialize_pipeline first.",
          },
        ],
      };
    }
    const state = getPipelineState();
    return {
      content: [
        {
          type: "text" as const,
          text: state
            ? JSON.stringify(state, null, 2)
            : "No active pipeline. Call initialize_pipeline first.",
        },
      ],
    };
  },
);

// ─── Tool 16: update_pipeline_state (NEW — Pipeline State) ───────────────────

server.tool(
  "update_pipeline_state",
  "Update pipeline progress — advance step, mark sections, record errors. Call after each pipeline action.",
  {
    current_step: z
      .enum([
        "license_gate", "context_detection", "input_analysis",
        "feasibility_gate", "clarification", "section_generation",
        "jira_generation", "file_export", "self_check", "complete",
      ])
      .optional()
      .describe("Advance to this pipeline step"),
    prd_context: z
      .enum(["proposal", "feature", "bug", "incident", "poc", "mvp", "release", "cicd"])
      .optional()
      .describe("Set the detected PRD context"),
    codebase_indexed: z
      .boolean()
      .optional()
      .describe("Mark codebase as indexed in Cortex"),
    section_type: z.string().optional().describe("Section to update"),
    section_status: z
      .enum(["pending", "generating", "validating", "passed", "failed", "retrying"])
      .optional()
      .describe("New status for the section"),
    violation_count: z.number().optional().describe("Number of violations found"),
    error: z.string().optional().describe("Record an error"),
  },
  async (params) => {
    if (params.error) {
      addPipelineError(params.error);
    }

    if (params.section_type && params.section_status) {
      updateSectionStatus(
        params.section_type as SectionType,
        params.section_status,
        params.violation_count,
      );
    }

    const updates: Record<string, unknown> = {};
    if (params.current_step) updates.currentStep = params.current_step;
    if (params.prd_context) updates.prdContext = params.prd_context;
    if (params.codebase_indexed !== undefined) updates.codebaseIndexed = params.codebase_indexed;

    if (Object.keys(updates).length > 0) {
      updatePipelineState(updates as any);
    }

    const summary = getPipelineStateSummary();
    return {
      content: [
        { type: "text" as const, text: summary ?? "No active pipeline." },
      ],
    };
  },
);

// ─── Start Server ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("MCP server failed to start:", error);
  process.exit(1);
});
