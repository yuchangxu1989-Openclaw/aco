/**
 * FailureAggregator — FR-B07 AC4: 累计数据聚合
 *
 * 按 agentId × taskType 维度聚合失败数据，生成失败率热力图。
 * 当某 Agent 在特定 taskType 上的失败率超过阈值时，自动降低路由权重。
 */

import type {
  FailureAggregateEntry,
  FailureHeatmapCell,
  FailureMode,
  FailureRecord,
} from '../types/index.js';

export interface AggregatorConfig {
  /** Failure rate threshold to flag degraded routing (default: 0.3 = 30%) */
  failureRateThreshold: number;
}

const DEFAULT_AGGREGATOR_CONFIG: AggregatorConfig = {
  failureRateThreshold: 0.3,
};

export class FailureAggregator {
  private config: AggregatorConfig;
  /** Track total dispatch attempts per agentId × taskType */
  private dispatchCounts = new Map<string, number>();

  constructor(config?: Partial<AggregatorConfig>) {
    this.config = { ...DEFAULT_AGGREGATOR_CONFIG, ...config };
  }

  updateConfig(config: Partial<AggregatorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): AggregatorConfig {
    return { ...this.config };
  }

  /**
   * Record a dispatch attempt (success or failure) for rate calculation
   */
  recordDispatchAttempt(agentId: string, taskType: string): void {
    const key = this.makeKey(agentId, taskType);
    this.dispatchCounts.set(key, (this.dispatchCounts.get(key) ?? 0) + 1);
  }

  /**
   * Bulk load dispatch counts (for initialization from audit log)
   */
  loadDispatchCounts(counts: Map<string, number>): void {
    this.dispatchCounts = new Map(counts);
  }

  /**
   * FR-B07 AC4: Aggregate failure records by agentId × taskType
   */
  aggregate(records: FailureRecord[]): FailureAggregateEntry[] {
    const groups = new Map<string, FailureRecord[]>();

    for (const record of records) {
      const key = this.makeKey(record.agentId, record.taskType);
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(record);
    }

    const entries: FailureAggregateEntry[] = [];

    for (const [key, groupRecords] of groups) {
      const [agentId, taskType] = this.parseKey(key);
      const totalAttempts = this.dispatchCounts.get(key) ?? groupRecords.length;
      const failureCount = groupRecords.length;

      // Count failure modes
      const failureModes: Record<FailureMode, number> = {
        'zero-output': 0,
        'timeout': 0,
        'error-output': 0,
        'no-file-written': 0,
        'crash': 0,
      };
      for (const r of groupRecords) {
        failureModes[r.failureMode]++;
      }

      const lastFailureAt = Math.max(...groupRecords.map(r => r.timestamp));

      entries.push({
        agentId,
        taskType,
        totalAttempts,
        failureCount,
        failureRate: totalAttempts > 0 ? failureCount / totalAttempts : 0,
        failureModes,
        lastFailureAt,
      });
    }

    // Sort by failure rate descending
    entries.sort((a, b) => b.failureRate - a.failureRate);
    return entries;
  }

  /**
   * FR-B07 AC4: Generate failure rate heatmap data
   */
  generateHeatmap(records: FailureRecord[]): FailureHeatmapCell[] {
    const aggregated = this.aggregate(records);

    return aggregated.map(entry => {
      // Find dominant failure mode
      let dominantMode: FailureMode | null = null;
      let maxCount = 0;
      for (const [mode, count] of Object.entries(entry.failureModes)) {
        if (count > maxCount) {
          maxCount = count;
          dominantMode = mode as FailureMode;
        }
      }

      return {
        agentId: entry.agentId,
        taskType: entry.taskType,
        failureRate: entry.failureRate,
        totalAttempts: entry.totalAttempts,
        dominantFailureMode: dominantMode,
      };
    });
  }

  /**
   * FR-B07 AC4: Check if routing weight should be reduced for an agent × taskType pair
   */
  shouldReduceWeight(agentId: string, taskType: string, records: FailureRecord[]): boolean {
    const key = this.makeKey(agentId, taskType);
    const relevant = records.filter(
      r => r.agentId === agentId && r.taskType === taskType,
    );

    if (relevant.length < 3) return false; // Need minimum sample

    const totalAttempts = this.dispatchCounts.get(key) ?? relevant.length;
    const failureRate = relevant.length / totalAttempts;

    return failureRate >= this.config.failureRateThreshold;
  }

  /**
   * Get agents with degraded routing for a specific task type
   */
  getDegradedAgents(taskType: string, records: FailureRecord[]): string[] {
    const agentIds = new Set(
      records.filter(r => r.taskType === taskType).map(r => r.agentId),
    );

    const degraded: string[] = [];
    for (const agentId of agentIds) {
      if (this.shouldReduceWeight(agentId, taskType, records)) {
        degraded.push(agentId);
      }
    }
    return degraded;
  }

  /**
   * Get summary statistics
   */
  getSummary(records: FailureRecord[]): {
    totalFailures: number;
    uniqueAgents: number;
    uniqueTaskTypes: number;
    topFailingAgents: Array<{ agentId: string; count: number }>;
    topFailingTaskTypes: Array<{ taskType: string; count: number }>;
  } {
    const agentCounts = new Map<string, number>();
    const taskTypeCounts = new Map<string, number>();

    for (const r of records) {
      agentCounts.set(r.agentId, (agentCounts.get(r.agentId) ?? 0) + 1);
      taskTypeCounts.set(r.taskType, (taskTypeCounts.get(r.taskType) ?? 0) + 1);
    }

    const topFailingAgents = Array.from(agentCounts.entries())
      .map(([agentId, count]) => ({ agentId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const topFailingTaskTypes = Array.from(taskTypeCounts.entries())
      .map(([taskType, count]) => ({ taskType, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      totalFailures: records.length,
      uniqueAgents: agentCounts.size,
      uniqueTaskTypes: taskTypeCounts.size,
      topFailingAgents,
      topFailingTaskTypes,
    };
  }

  private makeKey(agentId: string, taskType: string): string {
    return `${agentId}::${taskType}`;
  }

  private parseKey(key: string): [string, string] {
    const idx = key.indexOf('::');
    return [key.slice(0, idx), key.slice(idx + 2)];
  }
}
