import type { ThinkingStrategy, PRDContext } from "@prd-gen/core";
import type { EvidenceRepository, StrategyExecution } from "@prd-gen/core";
import type { StrategyAssignment } from "./selector.js";

/**
 * Effectiveness tracker -- records execution results to EvidenceRepository.
 * Ported from StrategyEffectivenessTracker.swift.
 *
 * Closes the feedback loop: selector reads historical adjustments that this
 * tracker writes, enabling the system to learn from real execution data.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface ExecutionResult {
  readonly strategy: ThinkingStrategy;
  readonly assignment: StrategyAssignment;
  readonly actualConfidenceGain: number;
  readonly wasCompliant: boolean;
  readonly retryCount: number;
  readonly prdContext: PRDContext;
  readonly sessionId?: string;
}

export interface EffectivenessReport {
  readonly totalMeasurements: number;
  readonly averageConfidenceGain: number;
  readonly overallComplianceRate: number;
  readonly underperformingStrategies: ThinkingStrategy[];
  readonly overperformingStrategies: ThinkingStrategy[];
}

// ── Tracker ─────────────────────────────────────────────────────────────────

export class EffectivenessTracker {
  constructor(private readonly repository: EvidenceRepository) {}

  recordExecution(result: ExecutionResult): void {
    const execution: StrategyExecution = {
      strategy: result.strategy,
      claimCharacteristics: [...result.assignment.claimAnalysis.characteristics],
      complexityTier: result.assignment.claimAnalysis.complexityTier,
      expectedImprovement: result.assignment.expectedImprovement,
      actualConfidenceGain: result.actualConfidenceGain,
      wasCompliant: result.wasCompliant,
      retryCount: result.retryCount,
      prdContext: result.prdContext,
    };

    this.repository.recordStrategyExecution(execution, result.sessionId);
  }

  generateReport(minExecutions: number = 5): EffectivenessReport {
    const summaries = this.repository.getStrategyPerformance(minExecutions);

    const totalMeasurements = summaries.reduce((s, r) => s + r.executionCount, 0);
    const averageConfidenceGain =
      totalMeasurements === 0
        ? 0
        : summaries.reduce((s, r) => s + r.avgActualGain * r.executionCount, 0) /
          totalMeasurements;
    const overallComplianceRate =
      totalMeasurements === 0
        ? 0
        : summaries.reduce((s, r) => s + r.complianceRate * r.executionCount, 0) /
          totalMeasurements;

    // Underperforming: actual < expected by more than 20% of expected
    const underperforming = summaries
      .filter((s) => s.performanceDelta < -0.2 * Math.abs(s.avgExpectedImprovement))
      .map((s) => s.strategy);

    // Overperforming: actual > expected by more than 20% of expected
    const overperforming = summaries
      .filter((s) => s.performanceDelta > 0.2 * Math.abs(s.avgExpectedImprovement))
      .map((s) => s.strategy);

    return {
      totalMeasurements,
      averageConfidenceGain,
      overallComplianceRate,
      underperformingStrategies: underperforming,
      overperformingStrategies: overperforming,
    };
  }
}
