import type { HardOutputRuleViolation, SectionType } from "@prd-gen/core";
import { findAbsenceViolation } from "./helpers.js";

// Rule 44: Concurrency Safety
export function checkConcurrencySafety(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return findAbsenceViolation(
    content,
    [
      "thread safe",
      "thread-safe",
      "concurren",
      "race condition",
      "mutex",
      "semaphore",
      "lock",
      "synchronized",
      "atomic",
      "volatile",
      "actor",
      "serial queue",
      "dispatch queue",
      "async/await",
      "coroutine",
      "channel",
      "deadlock",
      "livelock",
      "starvation",
      "shared state",
      "mutable state",
      "concurrent access",
    ],
    2,
    "concurrency_safety",
    sectionType,
    "Technical spec must address concurrency safety — specify how shared mutable state is protected, thread safety guarantees, race condition prevention, and deadlock avoidance strategies.",
  );
}

// Rule 45: Immutability by Default
export function checkImmutabilityByDefault(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return findAbsenceViolation(
    content,
    [
      "immutable",
      "immutability",
      "value type",
      "value object",
      "val ",
      "let ",
      "const ",
      "readonly",
      "read-only",
      "frozen",
      "unmodifiable",
      "persistent data structure",
      "copy-on-write",
      "defensive copy",
      "final field",
    ],
    1,
    "immutability_by_default",
    sectionType,
    "Technical spec should prefer immutable data structures — use value types, const/let/val by default, and justify any mutable state explicitly.",
  );
}

// Rule 46: Atomic Operations
export function checkAtomicOperations(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return findAbsenceViolation(
    content,
    [
      "atomic",
      "atomicity",
      "compare-and-swap",
      "cas ",
      "transaction isolation",
      "serializable",
      "read committed",
      "repeatable read",
      "snapshot isolation",
      "optimistic concurrency",
      "version check",
      "etag",
      "if-match",
      "conditional update",
    ],
    1,
    "atomic_operations",
    sectionType,
    "Technical spec must specify atomicity for multi-step state changes — define transaction isolation levels, optimistic concurrency control, and atomic operation boundaries.",
  );
}
