/**
 * Tolerant JSON-object extractor.
 *
 * Extract the first balanced JSON object from a text response. Tolerant to
 * markdown fences, prose preambles, and trailing commentary. Used wherever
 * we receive free-form agent output that should contain a structured object
 * (judge verdicts, clarification questions, etc.).
 *
 * Pure function — no I/O, no logging, no shared state. Throws on malformed
 * input rather than returning a fallback so callers must explicitly handle
 * the parse-failure case.
 *
 * Origin: previously lived in `@prd-gen/ecosystem-adapters/clients/subagent-client.ts`.
 * The Phase 3+4 cross-audit (code-reviewer H1) flagged orchestration handlers
 * importing this utility from the infrastructure layer as a §2.2 violation.
 * It belongs in core because it has no infrastructure dependency.
 *
 * source: cross-audit code-reviewer H1 (Phase 3+4, 2026-04).
 */

export function extractJsonObject(text: string): unknown {
  const stripped = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "");
  const start = stripped.indexOf("{");
  if (start === -1) throw new Error("no JSON object found in response");

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = stripped.slice(start, i + 1);
        return JSON.parse(candidate);
      }
    }
  }
  throw new Error("unbalanced JSON object in response");
}
