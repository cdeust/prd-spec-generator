import type { HardOutputRuleViolation, SectionType } from "@prd-gen/core";
import {
  findAbsenceViolation,
  hasExplicitOptOut,
  makeViolation,
} from "./helpers.js";

// Rule 33: Data Classification Required
export function checkDataClassificationRequired(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (
    hasExplicitOptOut(content, [
      "data classification",
      "sensitivity",
      "pii",
      "personal data",
      "sensitive data",
    ])
  ) {
    return [];
  }
  return findAbsenceViolation(
    content,
    [
      "data classification",
      "classify",
      "classification level",
      "public data",
      "internal data",
      "confidential",
      "restricted",
      "sensitivity level",
      "sensitivity class",
      "data tier",
      "data category",
      "personal data",
      "non-personal",
      "pii",
      "phi",
      "pci",
      "sensitive data",
    ],
    2,
    "data_classification_required",
    sectionType,
    "Technical spec must classify all data entities — define sensitivity levels (public/internal/confidential/restricted) with handling rules per classification.",
  );
}

// Rule 34: Sensitive Data Protection
export function checkSensitiveDataProtection(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (
    hasExplicitOptOut(content, [
      "sensitive data",
      "sensitive data protection",
      "pii",
      "personal data",
      "credentials",
      "secrets",
    ])
  ) {
    return [];
  }
  const lowered = content.toLowerCase();

  const encryptionSignals = [
    "encrypt at rest",
    "encryption at rest",
    "field-level encryption",
    "column encryption",
    "database encryption",
    "aes",
  ];

  const maskingSignals = [
    "mask",
    "anonymiz",
    "pseudonymiz",
    "redact",
    "obfuscat",
    "tokeniz",
    "de-identif",
    "data scrub",
  ];

  const accessSignals = [
    "row-level security",
    "rls",
    "column-level",
    "field-level access",
    "data access control",
    "need-to-know",
    "least privilege",
  ];

  let categoriesMet = 0;
  if (encryptionSignals.some((s) => lowered.includes(s))) categoriesMet++;
  if (maskingSignals.some((s) => lowered.includes(s))) categoriesMet++;
  if (accessSignals.some((s) => lowered.includes(s))) categoriesMet++;

  if (categoriesMet < 2) {
    return [
      makeViolation(
        "sensitive_data_protection",
        sectionType,
        "Technical spec must specify sensitive data protection strategy — address at least 2 of: encryption at rest, masking/anonymization, and access restrictions for PII and sensitive fields.",
      ),
    ];
  }

  return [];
}

// Rule 35: No Sensitive Data in Logs
export function checkNoSensitiveDataInLogs(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (
    hasExplicitOptOut(content, [
      "sensitive data",
      "pii",
      "personal data",
      "log",
      "credentials",
      "tokens",
    ])
  ) {
    return [];
  }
  const lowered = content.toLowerCase();

  const noLogPIISignals = [
    "no pii in log",
    "mask in log",
    "redact in log",
    "filter sensitive",
    "log sanitiz",
    "scrub log",
    "no sensitive data in log",
    "log masking",
    "exclude pii",
    "strip pii",
    "no personal data in log",
    "structured log",
    "safe logging",
  ];

  const hasLogProtection = noLogPIISignals.some((s) => lowered.includes(s));

  const broaderSignals =
    lowered.includes("sensitive") &&
    lowered.includes("log") &&
    (lowered.includes("never") ||
      lowered.includes("must not") ||
      lowered.includes("exclude") ||
      lowered.includes("prevent"));

  if (!hasLogProtection && !broaderSignals) {
    return [
      makeViolation(
        "no_sensitive_data_in_logs",
        sectionType,
        "Technical spec must explicitly prevent sensitive data (PII, credentials, tokens) from appearing in logs, error messages, URLs, or query parameters.",
      ),
    ];
  }

  return [];
}

// Rule 36: Data Minimization
export function checkDataMinimization(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (
    hasExplicitOptOut(content, [
      "data minimization",
      "personal data",
      "pii",
      "user data",
      "data collected",
    ])
  ) {
    return [];
  }
  return findAbsenceViolation(
    content,
    [
      "data minimization",
      "minimal data",
      "minimise",
      "collect only",
      "store only",
      "need-to-know",
      "purpose limitation",
      "data purpose",
      "justified",
      "necessary data",
      "required fields only",
      "no unnecessary",
      "reduce data footprint",
    ],
    1,
    "data_minimization",
    sectionType,
    "Technical spec must address data minimization — collect and store only what's necessary, justify every sensitive field, define purpose limitation.",
  );
}

// Rule 37: Audit Trail Required
export function checkAuditTrailRequired(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (
    hasExplicitOptOut(content, [
      "audit",
      "audit trail",
      "compliance",
      "authentication events",
      "data access",
    ])
  ) {
    return [];
  }
  return findAbsenceViolation(
    content,
    [
      "audit trail",
      "audit log",
      "audit event",
      "who did what",
      "who/what/when",
      "accountability",
      "compliance log",
      "activity log",
      "change log",
      "access log",
      "security log",
      "event sourcing",
      "tamper-proof log",
      "immutable log",
    ],
    1,
    "audit_trail_required",
    sectionType,
    "Technical spec must require audit trails for sensitive operations — log who/what/when for authentication events, data access, configuration changes, and admin actions.",
  );
}

// Rule 38: Consent & Erasure Support
export function checkConsentAndErasureSupport(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (
    hasExplicitOptOut(content, [
      "consent",
      "erasure",
      "personal data",
      "gdpr",
      "privacy compliance",
      "user data",
    ])
  ) {
    return [];
  }
  const lowered = content.toLowerCase();

  const consentSignals = [
    "consent",
    "opt-in",
    "opt-out",
    "user agreement",
    "privacy preference",
    "data subject",
    "lawful basis",
  ];

  const erasureSignals = [
    "right to erasure",
    "right to deletion",
    "right to be forgotten",
    "gdpr erasure",
    "data deletion",
    "cascade delete",
    "soft delete",
    "hard delete",
    "purge",
    "anonymize on delete",
    "account deletion",
    "data removal",
  ];

  const hasConsent = consentSignals.some((s) => lowered.includes(s));
  const hasErasure = erasureSignals.some((s) => lowered.includes(s));

  if (!hasConsent && !hasErasure) {
    return [
      makeViolation(
        "consent_and_erasure_support",
        sectionType,
        "Technical spec must support consent management and data erasure — specify how user consent is tracked, how deletion cascades through the data model, and GDPR/privacy compliance.",
      ),
    ];
  }

  return [];
}
