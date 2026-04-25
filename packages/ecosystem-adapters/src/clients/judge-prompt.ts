/**
 * Re-export shim for backward compatibility.
 *
 * `buildJudgePrompt` moved to `@prd-gen/verification` (Phase 3+4 cross-audit
 * closure, code-reviewer H1). Use-case logic for judge orchestration now
 * lives in the verification package; the infrastructure layer no longer
 * owns it.
 *
 * source: cross-audit code-reviewer H1 (Phase 3+4, 2026-04).
 */

export { buildJudgePrompt, type BuiltJudgePrompt } from "@prd-gen/verification";
