/**
 * Pipeline-tool registration — orchestrator + verification.
 *
 * Adds the new MCP tools that drive the full PRD workflow:
 *
 *   start_pipeline_v2     — initialize a pipeline run, return first NextAction
 *   submit_action_result  — feed an ActionResult to the reducer, return next action
 *   get_pipeline_state_v2 — read current state by run_id
 *   plan_section_verification    — emit JudgeRequest[] for a section
 *   plan_document_verification   — emit JudgeRequest[] across all sections
 *   conclude_verification        — aggregate JudgeVerdict[] → VerificationReport
 *
 * The host (Claude Code) drives the loop: call start, execute the action,
 * call submit_action_result with the result, repeat until `done`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type LicenseTier } from "@prd-gen/core";
export declare function registerPipelineTools(server: McpServer, resolveLicenseTier: () => LicenseTier): void;
//# sourceMappingURL=pipeline-tools.d.ts.map