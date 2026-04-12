import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import type { ThinkingStrategy, PRDContext, HardOutputRule } from "../index.js";

// Dynamic import — better-sqlite3 is optional (native module, may not be available)
let Database: any = null;
try {
  Database = (await import("better-sqlite3")).default;
} catch {
  // better-sqlite3 not installed — EvidenceRepository will throw on construction
}

/**
 * SQLite evidence repository — FIXES the no-op InMemoryVerificationEvidenceRepository.
 *
 * This is the single most important infrastructure change (Deming audit root cause).
 * It activates: adaptive thresholds, effectiveness tracking, quality trends,
 * and refinement learning — all of which exist in the Swift code but are starved of data.
 *
 * Location: ~/.prd-gen/evidence.db
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StrategyExecution {
  readonly strategy: ThinkingStrategy;
  readonly claimCharacteristics: readonly string[];
  readonly complexityTier: string;
  readonly expectedImprovement: number;
  readonly actualConfidenceGain: number;
  readonly wasCompliant: boolean;
  readonly retryCount: number;
  readonly prdContext: PRDContext;
}

export interface PRDQualityScore {
  readonly prdId: string;
  readonly prdContext: PRDContext;
  readonly rulesChecked: number;
  readonly rulesPassed: number;
  readonly criticalViolations: number;
  readonly totalScore: number;
  readonly auditFlagsRaised: number;
}

export interface AdaptiveThreshold {
  readonly metricName: string;
  readonly currentValue: number;
  readonly sampleCount: number;
  readonly lastUpdated: string;
}

export interface StrategyPerformanceSummary {
  readonly strategy: ThinkingStrategy;
  readonly executionCount: number;
  readonly avgExpectedImprovement: number;
  readonly avgActualGain: number;
  readonly performanceDelta: number; // actual - expected (negative = underperforming)
  readonly complianceRate: number;
}

// ─── Repository ──────────────────────────────────────────────────────────────

export class EvidenceRepository {
  private db: any;

  constructor(dbPath?: string) {
    if (!Database) {
      throw new Error("better-sqlite3 not available — install it with: pnpm add better-sqlite3");
    }
    const resolvedPath = dbPath ?? this.defaultDbPath();
    const dir = resolvedPath.substring(0, resolvedPath.lastIndexOf("/"));
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private defaultDbPath(): string {
    return join(homedir(), ".prd-gen", "evidence.db");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS strategy_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL DEFAULT '',
        strategy TEXT NOT NULL,
        claim_characteristics TEXT NOT NULL,
        complexity_tier TEXT NOT NULL,
        expected_improvement REAL NOT NULL,
        actual_confidence_gain REAL NOT NULL,
        was_compliant INTEGER NOT NULL DEFAULT 1,
        retry_count INTEGER NOT NULL DEFAULT 0,
        prd_context TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS prd_quality_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prd_id TEXT NOT NULL,
        prd_context TEXT NOT NULL,
        rules_checked INTEGER NOT NULL,
        rules_passed INTEGER NOT NULL,
        critical_violations INTEGER NOT NULL,
        total_score REAL NOT NULL,
        audit_flags_raised INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS adaptive_thresholds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_name TEXT NOT NULL UNIQUE,
        current_value REAL NOT NULL,
        sample_count INTEGER NOT NULL DEFAULT 0,
        last_updated TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_strategy_executions_strategy
        ON strategy_executions(strategy);
      CREATE INDEX IF NOT EXISTS idx_strategy_executions_context
        ON strategy_executions(prd_context);
      CREATE INDEX IF NOT EXISTS idx_prd_quality_scores_context
        ON prd_quality_scores(prd_context);
      CREATE INDEX IF NOT EXISTS idx_prd_quality_scores_prd_id
        ON prd_quality_scores(prd_id);
    `);
  }

  // ─── Strategy Executions ─────────────────────────────────────────────────

  recordStrategyExecution(execution: StrategyExecution, sessionId?: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO strategy_executions
        (session_id, strategy, claim_characteristics, complexity_tier,
         expected_improvement, actual_confidence_gain, was_compliant,
         retry_count, prd_context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      sessionId ?? "",
      execution.strategy,
      JSON.stringify(execution.claimCharacteristics),
      execution.complexityTier,
      execution.expectedImprovement,
      execution.actualConfidenceGain,
      execution.wasCompliant ? 1 : 0,
      execution.retryCount,
      execution.prdContext,
    );
  }

  /**
   * Get performance summary per strategy — used to close the feedback loop.
   * Returns historical adjustment factor for the selector.
   */
  getStrategyPerformance(
    minExecutions: number = 10,
  ): StrategyPerformanceSummary[] {
    const rows = this.db
      .prepare(
        `
      SELECT
        strategy,
        COUNT(*) as execution_count,
        AVG(expected_improvement) as avg_expected,
        AVG(actual_confidence_gain) as avg_actual,
        AVG(CAST(was_compliant AS REAL)) as compliance_rate
      FROM strategy_executions
      GROUP BY strategy
      HAVING COUNT(*) >= ?
      ORDER BY COUNT(*) DESC
    `,
      )
      .all(minExecutions) as Array<{
      strategy: string;
      execution_count: number;
      avg_expected: number;
      avg_actual: number;
      compliance_rate: number;
    }>;

    return rows.map((row) => ({
      strategy: row.strategy as ThinkingStrategy,
      executionCount: row.execution_count,
      avgExpectedImprovement: row.avg_expected,
      avgActualGain: row.avg_actual,
      performanceDelta: row.avg_actual - row.avg_expected,
      complianceRate: row.compliance_rate,
    }));
  }

  /**
   * Compute historical adjustments for strategy selection.
   * Bounded [-0.3, +0.3] — prevents runaway feedback.
   */
  getHistoricalAdjustments(
    minExecutions: number = 10,
  ): Map<ThinkingStrategy, number> {
    const summaries = this.getStrategyPerformance(minExecutions);
    const adjustments = new Map<ThinkingStrategy, number>();

    for (const summary of summaries) {
      if (summary.avgExpectedImprovement === 0) continue;
      const rawAdjustment =
        summary.performanceDelta / summary.avgExpectedImprovement;
      const clamped = Math.max(-0.3, Math.min(0.3, rawAdjustment));
      adjustments.set(summary.strategy, clamped);
    }

    return adjustments;
  }

  // ─── PRD Quality Scores ──────────────────────────────────────────────────

  recordQualityScore(score: PRDQualityScore): void {
    const stmt = this.db.prepare(`
      INSERT INTO prd_quality_scores
        (prd_id, prd_context, rules_checked, rules_passed,
         critical_violations, total_score, audit_flags_raised)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      score.prdId,
      score.prdContext,
      score.rulesChecked,
      score.rulesPassed,
      score.criticalViolations,
      score.totalScore,
      score.auditFlagsRaised,
    );
  }

  getQualityHistory(limit: number = 50): PRDQualityScore[] {
    const rows = this.db
      .prepare(
        `
      SELECT prd_id, prd_context, rules_checked, rules_passed,
             critical_violations, total_score, audit_flags_raised
      FROM prd_quality_scores
      ORDER BY created_at DESC
      LIMIT ?
    `,
      )
      .all(limit) as Array<{
      prd_id: string;
      prd_context: string;
      rules_checked: number;
      rules_passed: number;
      critical_violations: number;
      total_score: number;
      audit_flags_raised: number;
    }>;

    return rows.map((row) => ({
      prdId: row.prd_id,
      prdContext: row.prd_context as PRDContext,
      rulesChecked: row.rules_checked,
      rulesPassed: row.rules_passed,
      criticalViolations: row.critical_violations,
      totalScore: row.total_score,
      auditFlagsRaised: row.audit_flags_raised,
    }));
  }

  // ─── Adaptive Thresholds ─────────────────────────────────────────────────

  getThreshold(metricName: string): AdaptiveThreshold | undefined {
    const row = this.db
      .prepare(
        `SELECT metric_name, current_value, sample_count, last_updated
       FROM adaptive_thresholds WHERE metric_name = ?`,
      )
      .get(metricName) as
      | {
          metric_name: string;
          current_value: number;
          sample_count: number;
          last_updated: string;
        }
      | undefined;

    if (!row) return undefined;
    return {
      metricName: row.metric_name,
      currentValue: row.current_value,
      sampleCount: row.sample_count,
      lastUpdated: row.last_updated,
    };
  }

  /**
   * Recalculate adaptive thresholds from historical quality data.
   * Uses percentiles: p25 = fail, p50 = needs-improvement, p75 = good.
   * Only updates if sufficient data exists (minSamples).
   */
  recalculateThresholds(minSamples: number = 20): void {
    const scores = this.db
      .prepare(
        `SELECT total_score FROM prd_quality_scores ORDER BY total_score ASC`,
      )
      .all() as Array<{ total_score: number }>;

    if (scores.length < minSamples) return;

    const values = scores.map((s) => s.total_score);
    const p25 = values[Math.floor(values.length * 0.25)];
    const p50 = values[Math.floor(values.length * 0.5)];
    const p75 = values[Math.floor(values.length * 0.75)];

    const upsert = this.db.prepare(`
      INSERT INTO adaptive_thresholds (metric_name, current_value, sample_count, last_updated)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(metric_name) DO UPDATE SET
        current_value = excluded.current_value,
        sample_count = excluded.sample_count,
        last_updated = datetime('now')
    `);

    const updateAll = this.db.transaction(() => {
      upsert.run("quality_fail_threshold", p25, values.length);
      upsert.run("quality_improvement_threshold", p50, values.length);
      upsert.run("quality_good_threshold", p75, values.length);
    });
    updateAll();
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
