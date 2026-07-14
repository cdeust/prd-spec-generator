/**
 * Shared parser for Cortex `recall` tool_result payloads.
 *
 * Extracted so both the per-section recall (section-generation.ts) and the
 * run-level global recall (input-analysis.ts, Phase 1a) apply the IDENTICAL
 * truncation/selection rule to a Cortex `recall` response. Before this
 * extraction only one call site existed; the global-recall call site
 * (Phase 1a) introduced the second, and duplicating the parsing logic would
 * let the two summaries silently drift in shape (e.g. one truncating at a
 * different length than the other) — the same payload should always
 * summarize the same way regardless of which handler asked for it.
 *
 * source: provisional heuristic, unchanged from the pre-extraction values in
 * section-generation.ts:
 *  - RECALL_MAX_RESULTS_INCLUDED = 8 mirrors the request-side max_results.
 *  - RECALL_RESULT_TRUNCATE_CHARS = 800 caps each excerpt to ~200 tokens.
 * Cross-audit code-reviewer M8 (Phase 3+4, 2026-04).
 */
const RECALL_MAX_RESULTS_INCLUDED = 8;
const RECALL_RESULT_TRUNCATE_CHARS = 800;
const RECALL_TRUNCATION_MARKER = "...";

/**
 * precondition:  `data` is the `tool_result.data` payload of a Cortex
 *                `recall` call (or undefined/malformed, tolerated).
 * postcondition: returns the joined, truncated recall content, or "" when
 *                `data` carries no usable `results[].content` entries —
 *                the caller treats "" as "recall returned nothing" (the
 *                Curie A4 silent-suppression signal).
 */
export function summarizeCortexRecall(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) return "";
  return (results as Array<{ content?: string }>)
    .slice(0, RECALL_MAX_RESULTS_INCLUDED)
    .map((r) => r.content)
    .filter((c): c is string => typeof c === "string" && c.length > 0)
    .map((c) =>
      c.length > RECALL_RESULT_TRUNCATE_CHARS
        ? c.slice(0, RECALL_RESULT_TRUNCATE_CHARS) + RECALL_TRUNCATION_MARKER
        : c,
    )
    .join("\n---\n");
}
