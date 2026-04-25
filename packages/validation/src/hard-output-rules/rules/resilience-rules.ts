import type { HardOutputRuleViolation, SectionType } from "@prd-gen/core";
import {
  findAbsenceViolation,
  hasExplicitOptOut,
  makeViolation,
} from "./helpers.js";

// Rule 39: Structured Error Handling
export function checkStructuredErrorHandling(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (
    hasExplicitOptOut(content, [
      "error",
      "exception",
      "error handling",
      "error propagation",
      "swallowed exception",
    ])
  ) {
    return [];
  }
  const lowered = content.toLowerCase();

  const domainErrorSignals = [
    "domain error",
    "error type",
    "error enum",
    "error class",
    "custom exception",
    "business exception",
    "typed error",
    "error hierarchy",
    "error code",
    "error catalog",
  ];

  const propagationSignals = [
    "error propagation",
    "error boundary",
    "error handling strategy",
    "catch and rethrow",
    "error translation",
    "error mapping",
    "exception filter",
    "global error handler",
    "error middleware",
    "no swallow",
    "never swallow",
    "always propagate",
  ];

  const hasDomainErrors = domainErrorSignals.some((s) => lowered.includes(s));
  const hasPropagation = propagationSignals.some((s) => lowered.includes(s));

  if (!hasDomainErrors && !hasPropagation) {
    return [
      makeViolation(
        "structured_error_handling",
        sectionType,
        "Technical spec must define structured error handling — domain-specific error types, no swallowed exceptions, no generic catch-all, and explicit error propagation strategy.",
      ),
    ];
  }

  return [];
}

// Rule 40: Resilience Patterns
export function checkResiliencePatterns(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (
    hasExplicitOptOut(content, [
      "resilience",
      "circuit breaker",
      "retry",
      "external dependency",
      "remote call",
      "transient",
    ])
  ) {
    return [];
  }
  return findAbsenceViolation(
    content,
    [
      "circuit breaker",
      "retry",
      "exponential backoff",
      "timeout",
      "bulkhead",
      "rate limit",
      "failure isolation",
      "fault tolerance",
      "resilience",
      "health check",
      "dead letter",
      "fallback",
      "backpressure",
      "load shedding",
    ],
    2,
    "resilience_patterns",
    sectionType,
    "Technical spec must specify resilience patterns — circuit breaker for external dependencies, retry with exponential backoff, and timeout on every external call.",
  );
}

// Rule 41: Graceful Degradation
export function checkGracefulDegradation(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (
    hasExplicitOptOut(content, [
      "graceful degradation",
      "degradation",
      "fallback",
      "dependency failure",
      "cascading failure",
    ])
  ) {
    return [];
  }
  return findAbsenceViolation(
    content,
    [
      "graceful degradation",
      "degrade gracefully",
      "fallback",
      "fail gracefully",
      "partial failure",
      "degraded mode",
      "offline mode",
      "cache fallback",
      "default response",
      "service unavailable",
      "cascading failure",
      "blast radius",
    ],
    1,
    "graceful_degradation",
    sectionType,
    "Technical spec must define graceful degradation — specify fallback behavior when dependencies fail, prevent cascading failures, and define degraded operation modes.",
  );
}

// Rule 42: Transaction Boundaries
export function checkTransactionBoundaries(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (
    hasExplicitOptOut(content, [
      "transaction",
      "rollback",
      "atomic",
      "multi-step",
      "read-only",
      "no writes",
      "database",
    ])
  ) {
    return [];
  }
  return findAbsenceViolation(
    content,
    [
      "transaction",
      "transactional",
      "atomicity",
      "atomic operation",
      "isolation level",
      "rollback",
      "commit",
      "saga",
      "compensating transaction",
      "eventual consistency",
      "two-phase commit",
      "optimistic lock",
      "pessimistic lock",
      "idempoten",
      "exactly-once",
      "at-least-once",
    ],
    2,
    "transaction_boundaries",
    sectionType,
    "Technical spec must define transaction boundaries — specify transaction scope, isolation level, rollback strategy, and idempotency for multi-step operations.",
  );
}

// Rule 43: Consistent Error Format
export function checkConsistentErrorFormat(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (
    hasExplicitOptOut(content, [
      "error format",
      "error response",
      "error envelope",
      "error code",
      "error catalog",
    ])
  ) {
    return [];
  }
  return findAbsenceViolation(
    content,
    [
      "error format",
      "error response format",
      "error schema",
      "error contract",
      "rfc 7807",
      "problem detail",
      "error code",
      "error_code",
      "error response structure",
      "standardized error",
      "consistent error",
      "error envelope",
      "error body",
      "machine-readable error",
    ],
    1,
    "consistent_error_format",
    sectionType,
    'Technical spec must define a consistent error response format — standardized structure with error codes, human-readable messages, and machine-readable details (e.g., RFC 7807).',
  );
}
