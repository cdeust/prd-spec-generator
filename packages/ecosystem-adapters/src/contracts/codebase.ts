/**
 * Contracts for the automatised-pipeline MCP.
 * Stage assignments per /Users/cdeust/Developments/anthropic/ai-automatised-pipeline/NOTES.md.
 *
 * Tool names are canonical — defined in the pipeline's `src/tool_schemas.rs`.
 * We do not duplicate logic; we type the requests and parse the responses.
 */

import { z } from "zod";

// ─── Stage 3a: Index + query graph ──────────────────────────────────────────

/**
 * source: tool_schemas.rs index_codebase_schema (live binary at
 * /Users/cdeust/Developments/anthropic/ai-automatised-pipeline/src/tool_schemas.rs:214).
 * Required fields are `path` and `output_dir`; `language` is optional with
 * default "auto". `refresh` is NOT in the schema.
 */
export const IndexCodebaseRequestSchema = z.object({
  path: z.string().describe("Absolute path to the codebase root"),
  output_dir: z
    .string()
    .describe("Absolute directory where the graph will be stored"),
  language: z
    .enum(["rust", "swift", "typescript", "python", "auto"])
    .default("auto"),
});
export type IndexCodebaseRequest = z.infer<typeof IndexCodebaseRequestSchema>;

/**
 * source: live binary returns `graph_path` (not `graph_id`); see live-integration
 * test in packages/ecosystem-adapters/src/__tests__/automatised-pipeline.integration.test.ts.
 */
export const IndexCodebaseResponseSchema = z.object({
  graph_path: z.string(),
  symbols_indexed: z.number().int().nonnegative().optional(),
  files_parsed: z.number().int().nonnegative().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
});
export type IndexCodebaseResponse = z.infer<typeof IndexCodebaseResponseSchema>;

export const QueryGraphRequestSchema = z.object({
  graph_path: z
    .string()
    .describe("Absolute path to the graph (returned by index_codebase)"),
  query: z.string().describe("Cypher query against the graph"),
});
export type QueryGraphRequest = z.infer<typeof QueryGraphRequestSchema>;

// ─── Stage 3d: Hybrid search + context ──────────────────────────────────────

export const SearchCodebaseRequestSchema = z.object({
  graph_id: z.string(),
  query: z.string(),
  mode: z.enum(["bm25", "vector", "hybrid"]).default("hybrid"),
  limit: z.number().int().min(1).max(50).default(10),
});
export type SearchCodebaseRequest = z.infer<typeof SearchCodebaseRequestSchema>;

export const SearchCodebaseHitSchema = z.object({
  symbol: z.string(),
  file: z.string(),
  line: z.number().int(),
  score: z.number(),
  snippet: z.string(),
});
export type SearchCodebaseHit = z.infer<typeof SearchCodebaseHitSchema>;

export const GetContextRequestSchema = z.object({
  graph_id: z.string(),
  symbol_fqn: z.string(),
  hops: z.number().int().min(0).max(4).default(2),
});
export type GetContextRequest = z.infer<typeof GetContextRequestSchema>;

// ─── Stage 3c: Impact + clusters ────────────────────────────────────────────

export const GetImpactRequestSchema = z.object({
  graph_id: z.string(),
  changed_symbols: z.array(z.string()).min(1),
  depth: z.number().int().min(1).max(5).default(2),
});
export type GetImpactRequest = z.infer<typeof GetImpactRequestSchema>;

export const ImpactedSymbolSchema = z.object({
  fqn: z.string(),
  distance: z.number().int().nonnegative(),
  community: z.string().optional(),
});
export type ImpactedSymbol = z.infer<typeof ImpactedSymbolSchema>;

// ─── Stage 4: PRD input bundle ──────────────────────────────────────────────

export const PreparePrdInputRequestSchema = z.object({
  graph_id: z.string(),
  finding_id: z.string(),
  output_path: z.string().describe("Where to write stage-4.prd_input.json"),
});
export type PreparePrdInputRequest = z.infer<typeof PreparePrdInputRequestSchema>;

export const PrdInputBundleSchema = z.object({
  finding: z.unknown(),
  matched_symbols: z.array(z.unknown()),
  impacted_communities: z.array(z.unknown()),
  impacted_processes: z.array(z.unknown()),
  graph_stats: z.unknown(),
});
export type PrdInputBundle = z.infer<typeof PrdInputBundleSchema>;

// ─── Stage 6: PRD-vs-graph validation ───────────────────────────────────────

export const ValidatePrdAgainstGraphRequestSchema = z.object({
  graph_id: z.string(),
  prd_path: z.string(),
});
export type ValidatePrdAgainstGraphRequest = z.infer<
  typeof ValidatePrdAgainstGraphRequestSchema
>;

export const PrdGraphValidationReportSchema = z.object({
  hallucinated_symbols: z.array(z.string()),
  community_inconsistencies: z.array(z.string()),
  unverified_impact_claims: z.array(z.string()),
  verdict: z.enum(["pass", "warn", "fail"]),
});
export type PrdGraphValidationReport = z.infer<
  typeof PrdGraphValidationReportSchema
>;

// ─── Stage 9: Semantic diff verification ────────────────────────────────────

export const VerifySemanticDiffRequestSchema = z.object({
  pre_graph_id: z.string(),
  post_graph_id: z.string(),
});
export type VerifySemanticDiffRequest = z.infer<
  typeof VerifySemanticDiffRequestSchema
>;

export const SemanticDiffReportSchema = z.object({
  dangling_refs: z.array(z.string()),
  new_sccs: z.array(z.string()),
  unresolved_delta: z.number().int(),
  regression_score: z.number(),
  verdict: z.enum(["clean", "concerning", "regression"]),
});
export type SemanticDiffReport = z.infer<typeof SemanticDiffReportSchema>;
