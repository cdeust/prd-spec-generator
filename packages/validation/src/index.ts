// Validation engine — 64 HOR rules + audit flags + cross-ref graph

export { validateSection, validateDocument } from "./hard-output-rules/index.js";
export { validateCrossReferences } from "./cross-ref-validator.js";
export {
  AuditFlagEngine,
  type AuditFinding,
  type AuditFlagReport,
  type AuditRule,
  type AuditRuleFamily,
} from "./audit-flags/index.js";
