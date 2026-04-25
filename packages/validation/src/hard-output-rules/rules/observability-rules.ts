import type { HardOutputRuleViolation, SectionType } from "@prd-gen/core";
import {
  findAbsenceViolation,
  hasExplicitOptOut,
  makeViolation,
} from "./helpers.js";

// Rule 59: Structured Logging
export function checkStructuredLogging(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const lowered = content.toLowerCase();

  const formatSignals = [
    "structured log",
    "json log",
    "log format",
    "log schema",
    "log standard",
    "log framework",
  ];

  const levelSignals = [
    "log level",
    "debug",
    "info",
    "warn",
    "error",
    "trace",
    "fatal",
    "severity",
    "verbosity",
  ];

  const hasFormat = formatSignals.some((s) => lowered.includes(s));
  const hasLevels =
    levelSignals.filter((s) => lowered.includes(s)).length >= 2;

  if (!hasFormat && !hasLevels) {
    return [
      makeViolation(
        "structured_logging",
        sectionType,
        "Technical spec must define structured logging — specify log format (JSON/structured), log levels (DEBUG/INFO/WARN/ERROR), and what to log at each level.",
      ),
    ];
  }

  return [];
}

// Rule 60: Distributed Tracing
export function checkDistributedTracing(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (
    hasExplicitOptOut(content, [
      "distributed tracing",
      "tracing",
      "correlation id",
      "single-process",
      "single process",
      "cross-service",
      "second hop",
    ])
  ) {
    return [];
  }
  return findAbsenceViolation(
    content,
    [
      "correlation id",
      "trace id",
      "request id",
      "distributed trac",
      "opentelemetry",
      "jaeger",
      "zipkin",
      "trace context",
      "span",
      "trace propagat",
      "x-request-id",
      "x-correlation-id",
      "end-to-end trac",
      "cross-service trac",
    ],
    1,
    "distributed_tracing",
    sectionType,
    "Technical spec should specify distributed tracing — correlation IDs for cross-service request tracking, trace context propagation, and observability integration.",
  );
}

// Rule 61: No PII in Observability
export function checkNoPIIInObservability(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (
    hasExplicitOptOut(content, [
      "pii",
      "observability",
      "personal data",
      "logs",
      "metrics",
      "traces",
      "dashboards",
    ])
  ) {
    return [];
  }
  const lowered = content.toLowerCase();

  const piiProtectionSignals = [
    "no pii in log",
    "no pii in metric",
    "no pii in trace",
    "mask sensitive",
    "redact",
    "scrub",
    "sanitize log",
    "filter pii",
    "exclude sensitive",
    "log safe",
    "safe to log",
    "no personal data in",
  ];

  const hasProtection = piiProtectionSignals.some((s) => lowered.includes(s));

  const hasBroader =
    (lowered.includes("pii") ||
      lowered.includes("sensitive") ||
      lowered.includes("personal data")) &&
    (lowered.includes("log") ||
      lowered.includes("metric") ||
      lowered.includes("trace") ||
      lowered.includes("monitor")) &&
    (lowered.includes("never") ||
      lowered.includes("must not") ||
      lowered.includes("exclude") ||
      lowered.includes("prevent") ||
      lowered.includes("mask") ||
      lowered.includes("redact"));

  if (!hasProtection && !hasBroader) {
    return [
      makeViolation(
        "no_pii_in_observability",
        sectionType,
        "Technical spec must ensure no PII in observability — logs, metrics, traces, and dashboards must not contain sensitive personal data. Specify masking/redaction strategy.",
      ),
    ];
  }

  return [];
}

// Rule 62: Alerting Thresholds
export function checkAlertingThresholds(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return findAbsenceViolation(
    content,
    [
      "alert",
      "alerting",
      "threshold",
      "alarm",
      "escalat",
      "on-call",
      "pagerduty",
      "opsgenie",
      "notification",
      "sla breach",
      "slo",
      "warning threshold",
      "critical threshold",
      "runbook",
      "incident response",
    ],
    2,
    "alerting_thresholds",
    sectionType,
    "Technical spec should define alerting thresholds — specify what triggers alerts, severity levels, escalation paths, and on-call routing.",
  );
}
