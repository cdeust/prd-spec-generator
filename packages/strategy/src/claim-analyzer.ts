/**
 * Claim characteristic analyzer -- ported from ClaimCharacteristicAnalyzer.swift.
 * Extracts claim characteristics via keyword pattern matching across 8 categories.
 * These characteristics drive research-evidence-based strategy selection.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface ClaimAnalysisResult {
  readonly claim: string;
  readonly characteristics: ReadonlySet<string>;
  readonly complexityScore: number;
  readonly complexityTier: "simple" | "moderate" | "complex";
  readonly analysisNotes: readonly string[];
}

// ── Pattern Detection ───────────────────────────────────────────────────────

interface DetectionResult {
  readonly characteristics: Set<string>;
  readonly notes: string[];
}

function containsAny(text: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => text.includes(p));
}

function detectReasoningComplexity(text: string): DetectionResult {
  const characteristics = new Set<string>();
  const notes: string[] = [];

  if (containsAny(text, ["calculate", "compute", "formula", "equation", "math"])) {
    characteristics.add("mathematical_reasoning");
    notes.push("Mathematical reasoning detected");
  }

  if (containsAny(text, ["step", "sequence", "then", "after", "before", "process"])) {
    characteristics.add("multi_step_logic");
    characteristics.add("sequential_planning");
  }

  if (containsAny(text, ["technical", "architecture", "system", "implementation", "api", "database"])) {
    characteristics.add("complex_technical");
    notes.push("Technical domain content");
  }

  if (containsAny(text, ["precise", "exact", "accurate", "critical", "must", "shall"])) {
    characteristics.add("high_precision");
    characteristics.add("accuracy_critical");
  }

  return { characteristics, notes };
}

function detectStructurePatterns(text: string): Set<string> {
  const characteristics = new Set<string>();

  if (containsAny(text, ["depend", "relationship", "connect", "link", "reference"])) {
    characteristics.add("dependency_analysis");
    characteristics.add("cross_reference");
  }

  if (containsAny(text, ["structure", "hierarchy", "organize", "component", "module"])) {
    characteristics.add("structural_reasoning");
  }

  return characteristics;
}

function detectExplorationPatterns(text: string): DetectionResult {
  const characteristics = new Set<string>();
  const notes: string[] = [];

  if (containsAny(text, ["explore", "alternative", "option", "approach", "possibility"])) {
    characteristics.add("exploratory_reasoning");
    characteristics.add("multiple_approaches");
    characteristics.add("branch_exploration");
  }

  if (containsAny(text, ["creative", "innovative", "novel", "design"])) {
    characteristics.add("creative_problems");
  }

  if (containsAny(text, ["uncertain", "unclear", "ambiguous", "complex", "difficult"])) {
    characteristics.add("uncertainty_handling");
    notes.push("High uncertainty detected");
  }

  return { characteristics, notes };
}

function detectVerificationNeeds(text: string): Set<string> {
  const characteristics = new Set<string>();

  if (containsAny(text, ["verify", "validate", "check", "ensure", "confirm"])) {
    characteristics.add("fact_verification");
    characteristics.add("consistency_check");
  }

  if (containsAny(text, ["risk", "threat", "vulnerability", "issue", "problem"])) {
    characteristics.add("risk_analysis");
  }

  return characteristics;
}

function detectDomainPatterns(text: string): DetectionResult {
  const characteristics = new Set<string>();
  const notes: string[] = [];

  if (containsAny(text, ["codebase", "repository", "existing code", "current system"])) {
    characteristics.add("codebase_integration");
    characteristics.add("tool_use");
    notes.push("Codebase integration required");
  }

  if (containsAny(text, ["example", "sample", "template", "pattern"])) {
    characteristics.add("pattern_matching");
    characteristics.add("example_based");
  }

  if (containsAny(text, ["code", "function", "class", "method", "implement"])) {
    characteristics.add("code_generation");
  }

  return { characteristics, notes };
}

function detectIterativePatterns(text: string): Set<string> {
  const characteristics = new Set<string>();

  if (containsAny(text, ["refine", "improve", "iterate", "enhance", "optimize"])) {
    characteristics.add("iterative_refinement");
    characteristics.add("quality_improvement");
  }

  if (containsAny(text, ["correct", "fix", "revise", "update"])) {
    characteristics.add("self_correction");
  }

  return characteristics;
}

function detectExternalDependencies(text: string): Set<string> {
  const characteristics = new Set<string>();

  if (containsAny(text, ["search", "find", "lookup", "retrieve", "fetch"])) {
    characteristics.add("external_knowledge");
    characteristics.add("tool_use");
  }

  return characteristics;
}

function detectSpecialModes(text: string): DetectionResult {
  const characteristics = new Set<string>();
  const notes: string[] = [];

  if (containsAny(text, ["image", "visual", "diagram", "mockup", "screenshot", "ui"])) {
    characteristics.add("visual_reasoning");
    characteristics.add("multimodal");
    characteristics.add("diagram_analysis");
    notes.push("Visual content processing needed");
  }

  if (containsAny(text, ["perspective", "role", "stakeholder", "expert"])) {
    characteristics.add("role_based_reasoning");
    characteristics.add("expert_orchestration");
  }

  return { characteristics, notes };
}

// ── Complexity Scoring ──────────────────────────────────────────────────────

const HIGH_COMPLEXITY_CHARS = new Set([
  "mathematical_reasoning", "complex_technical", "dependency_analysis",
  "multi_dimensional", "accuracy_critical", "risk_analysis",
  "codebase_integration", "iterative_refinement",
]);

const MEDIUM_COMPLEXITY_CHARS = new Set([
  "multi_step_logic", "cross_reference", "structural_reasoning",
  "exploratory_reasoning", "multiple_approaches", "uncertainty_handling",
  "fact_verification", "self_correction",
]);

function calculateComplexityScore(
  characteristics: ReadonlySet<string>,
  text: string,
): number {
  let score = characteristics.size * 0.05;

  for (const c of characteristics) {
    if (HIGH_COMPLEXITY_CHARS.has(c)) {
      score += 0.12;
    } else if (MEDIUM_COMPLEXITY_CHARS.has(c)) {
      score += 0.08;
    } else {
      score += 0.04;
    }
  }

  const wordCount = text.split(/\s+/).length;
  score += Math.min(0.15, wordCount / 500);

  return Math.min(1.0, score);
}

function complexityTierFromScore(score: number): "simple" | "moderate" | "complex" {
  if (score >= 0.6) return "complex";
  if (score >= 0.3) return "moderate";
  return "simple";
}

// ── Public API ──────────────────────────────────────────────────────────────

export function analyzeClaim(claim: string, context?: string): ClaimAnalysisResult {
  const text = (claim + " " + (context ?? "")).toLowerCase();

  const reasoning = detectReasoningComplexity(text);
  const structure = detectStructurePatterns(text);
  const exploration = detectExplorationPatterns(text);
  const verification = detectVerificationNeeds(text);
  const domain = detectDomainPatterns(text);
  const iterative = detectIterativePatterns(text);
  const external = detectExternalDependencies(text);
  const special = detectSpecialModes(text);

  const characteristics = new Set<string>();
  for (const set of [
    reasoning.characteristics, structure, exploration.characteristics,
    verification, domain.characteristics, iterative, external,
    special.characteristics,
  ]) {
    for (const c of set) characteristics.add(c);
  }

  if (characteristics.size === 0) {
    characteristics.add("basic_reasoning");
  }

  const notes = [
    ...reasoning.notes,
    ...exploration.notes,
    ...domain.notes,
    ...special.notes,
  ];

  const complexityScore = calculateComplexityScore(characteristics, text);

  return {
    claim,
    characteristics,
    complexityScore,
    complexityTier: complexityTierFromScore(complexityScore),
    analysisNotes: notes,
  };
}
