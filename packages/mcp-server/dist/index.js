#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PRD_CONTEXT_CONFIGS, CAPABILITIES, STRATEGY_TIERS, SectionTypeSchema, } from "@prd-gen/core";
import { tryCreateEvidenceRepository } from "@prd-gen/core";
import { validateSection, validateDocument } from "@prd-gen/validation";
import { registerBudgetTools } from "./budget-tools.js";
import { registerPipelineTools } from "./pipeline-tools.js";
/**
 * PRD Generator MCP Server — native TypeScript.
 *
 * 17 tools: 5 diagnostics + 2 validation + 2 evidence + 8 pipeline/verification/budget.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
// ─── Config Loading ──────────────────────────────────────────────────────────
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? join(__dirname, "..", "..", "..");
function loadSkillConfig() {
    const configPaths = [
        process.env.PRD_GEN_SKILL_CONFIG,
        join(PLUGIN_ROOT, "skill-config.json"),
        join(PLUGIN_ROOT, "packages", "skill", "skill-config.json"),
    ].filter(Boolean);
    for (const p of configPaths) {
        if (existsSync(p)) {
            return JSON.parse(readFileSync(p, "utf-8"));
        }
    }
    return { version: "2.0.0", status: "config_not_found" };
}
function loadSkillMd() {
    const skillPaths = [
        join(PLUGIN_ROOT, "skills", "prd-spec-generator", "SKILL.md"),
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
// Lazy-init evidence repository (only when better-sqlite3 is available).
// `tryCreateEvidenceRepository` returns null if the native module is
// missing — replaces the previous `await import + unknown cast` pattern
// (cross-audit code-reviewer M7, Phase 3+4, 2026-04).
let _evidenceRepo = undefined;
function getEvidenceRepo() {
    if (_evidenceRepo === undefined) {
        _evidenceRepo = tryCreateEvidenceRepository();
    }
    return _evidenceRepo;
}
// ─── Tool 1: get_config ──────────────────────────────────────────────────────
server.tool("get_config", "Get the full skill configuration", {}, async () => {
    const config = loadSkillConfig();
    return {
        content: [{ type: "text", text: JSON.stringify(config, null, 2) }],
    };
});
// ─── Tool 2: read_skill_config ───────────────────────────────────────────────
server.tool("read_skill_config", "Read the SKILL.md content that drives PRD generation", {}, async () => {
    const skillMd = loadSkillMd();
    return {
        content: [{ type: "text", text: skillMd }],
    };
});
// ─── Tool 3: check_health ────────────────────────────────────────────────────
server.tool("check_health", "Check system health — verify all components are accessible", {}, async () => {
    const configAvailable = loadSkillConfig().version !== undefined;
    const skillAvailable = loadSkillMd() !== "SKILL.md not found";
    let dbHealthy = false;
    try {
        const repo = getEvidenceRepo();
        if (repo) {
            repo.getQualityHistory(1);
            dbHealthy = true;
        }
    }
    catch {
        dbHealthy = false;
    }
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({
                    status: "ok",
                    configAvailable,
                    skillAvailable,
                    evidenceDbHealthy: dbHealthy,
                    timestamp: new Date().toISOString(),
                }, null, 2),
            },
        ],
    };
});
// ─── Tool 4: get_prd_context_info ────────────────────────────────────────────
server.tool("get_prd_context_info", "Get configuration for a specific PRD context type", {
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
}, async ({ context }) => {
    const config = PRD_CONTEXT_CONFIGS[context];
    return {
        content: [{ type: "text", text: JSON.stringify(config, null, 2) }],
    };
});
// ─── Tool 5: list_available_strategies ───────────────────────────────────────
server.tool("list_available_strategies", "List thinking strategies available to the pipeline.", {}, async () => {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({
                    strategies: CAPABILITIES.allowedStrategies,
                    tiers: STRATEGY_TIERS,
                }, null, 2),
            },
        ],
    };
});
// ─── Tool 6: validate_prd_section ────────────────────────────────────────────
server.tool("validate_prd_section", "Run deterministic Hard Output Rules validation on a single PRD section. Returns violations found — zero LLM calls, pure regex/parsing.", {
    content: z.string().describe("The markdown content of the PRD section"),
    section_type: SectionTypeSchema.describe("The type of PRD section being validated"),
}, async ({ content, section_type }) => {
    // section_type is already validated by SectionTypeSchema at the MCP
    // boundary above. No cast required (cross-audit code-reviewer H5,
    // Phase 3+4, 2026-04).
    const report = validateSection(content, section_type);
    return {
        content: [
            { type: "text", text: JSON.stringify(report, null, 2) },
        ],
    };
});
// ─── Tool 7: validate_prd_document ───────────────────────────────────────────
server.tool("validate_prd_document", "Run full document validation including cross-section checks (SP arithmetic, AC numbering, FR-AC coverage, test traceability). Returns comprehensive validation report.", {
    sections: z
        .array(z.object({
        // Validate at MCP boundary so the cast at the call site is
        // unnecessary. Pre-fix: `z.string()` + `s.type as SectionType`.
        // Cross-audit code-reviewer H5 (Phase 3+4, 2026-04).
        type: SectionTypeSchema.describe("Section type"),
        content: z.string().describe("Section content"),
    }))
        .describe("Array of PRD sections to validate"),
}, async ({ sections }) => {
    const report = validateDocument(sections);
    return {
        content: [
            { type: "text", text: JSON.stringify(report, null, 2) },
        ],
    };
});
// ─── Tool 8: get_quality_history ─────────────────────────────────────────────
server.tool("get_quality_history", "Get historical PRD quality scores from the evidence repository", {
    limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(20)
        .describe("Maximum number of records to return"),
}, async ({ limit }) => {
    const repo = getEvidenceRepo();
    if (!repo) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        error: "Evidence repository unavailable (better-sqlite3 not loaded)",
                    }),
                },
            ],
            isError: true,
        };
    }
    const history = repo.getQualityHistory(limit);
    return {
        content: [
            { type: "text", text: JSON.stringify(history, null, 2) },
        ],
    };
});
// ─── Tool 9: get_strategy_effectiveness ──────────────────────────────────────
server.tool("get_strategy_effectiveness", "Get strategy performance data — actual vs expected improvement, compliance rate", {
    min_executions: z
        .number()
        .int()
        .min(1)
        .default(5)
        .describe("Minimum executions required to include a strategy"),
}, async ({ min_executions }) => {
    const repo = getEvidenceRepo();
    if (!repo) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        error: "Evidence repository unavailable (better-sqlite3 not loaded)",
                    }),
                },
            ],
            isError: true,
        };
    }
    const performance = repo.getStrategyPerformance(min_executions);
    const adjustments = repo.getHistoricalAdjustments(min_executions);
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({
                    performance,
                    adjustments: Object.fromEntries(adjustments),
                }, null, 2),
            },
        ],
    };
});
// ─── Budget + feedback tools (extracted to budget-tools.ts) ──────────────────
registerBudgetTools(server);
// Legacy tools (initialize_pipeline / update_pipeline_state) were removed
// in v3.0.0. The pipeline tools (start_pipeline / submit_action_result /
// get_pipeline_state, registered below via registerPipelineTools) are the
// canonical surface.
// ─── Pipeline / verification tools (orchestration + verification) ────────────
registerPipelineTools(server);
// ─── Start Server ────────────────────────────────────────────────────────────
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((error) => {
    console.error("MCP server failed to start:", error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map