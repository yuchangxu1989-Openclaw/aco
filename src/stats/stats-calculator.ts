/**
 * StatsCalculator - 资源利用率统计
 * FR-E03: 资源利用率统计
 */

import type { AuditQuery } from '../audit-query/index.js';
import type { AuditEntry } from '../audit-logger/index.js';

export interface StatsCalculatorConfig {
  knownAgents: string[];
}

export interface AgentStats {
  agentId: string;
  completedCount: number;
  failedCount: number;
  totalTasks: number;
  avgDurationMs: number;
  failureRate: number;
  busyRate: number;
  tierUpgradeCount: number;
}

export interface PeriodStats {
  period: string;
  totalTasks: number;
  succeededTasks: number;
  failedTasks: number;
  retriedTasks: number;
  avgDurationMs: number;
  overallUtilization: number;
  agents: AgentStats[];
}

type Period = '1h' | '24h' | '7d';

const PERIOD_MS: Record<Period, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

export class StatsCalculator {
  private auditQuery: AuditQuery;
  private knownAgents: string[];

  constructor(auditQuery: AuditQuery, config: StatsCalculatorConfig) {
    this.auditQuery = auditQuery;
    this.knownAgents = [...config.knownAgents];
  }

  updateKnownAgents(agents: string[]): void {
    this.knownAgents = [...agents];
  }

  async calculate(period: Period): Promise<PeriodStats> {
    const periodMs = PERIOD_MS[period];
    const entries = await this.auditQuery.queryPeriod(periodMs);

    // Categorize entries
    const dispatched = entries.filter(e => e.eventType === 'task.dispatched');
    const completed = entries.filter(e => e.eventType === 'task.completed');
    const failed = entries.filter(e => e.eventType === 'task.failed');
    const retried = entries.filter(e => e.eventType === 'task.retry');

    const totalTasks = completed.length + failed.length;
    const succeededTasks = completed.length;
    const failedTasks = failed.length;
    const retriedTasks = retried.length;

    // Calculate average duration across all tasks with duration info
    const allWithDuration = [...completed, ...failed].filter(
      e => e.details?.durationMs !== undefined
    );
    const avgDurationMs = allWithDuration.length > 0
      ? allWithDuration.reduce((sum, e) => sum + (e.details!.durationMs as number), 0) / allWithDuration.length
      : 0;

    // Per-agent stats
    const discoveredAgents = new Set<string>();
    for (const e of entries) {
      if (e.agentId) discoveredAgents.add(e.agentId);
    }

    const allAgents = new Set([...this.knownAgents, ...discoveredAgents]);
    const agents: AgentStats[] = [];

    for (const agentId of allAgents) {
      const agentCompleted = completed.filter(e => e.agentId === agentId);
      const agentFailed = failed.filter(e => e.agentId === agentId);
      const agentRetried = retried.filter(e => e.agentId === agentId);
      const agentDispatched = dispatched.filter(e => e.agentId === agentId);
      const agentTotal = agentCompleted.length + agentFailed.length;

      const agentWithDuration = [...agentCompleted, ...agentFailed].filter(
        e => e.details?.durationMs !== undefined
      );
      const agentAvgDuration = agentWithDuration.length > 0
        ? agentWithDuration.reduce((sum, e) => sum + (e.details!.durationMs as number), 0) / agentWithDuration.length
        : 0;

      // Busy rate = total busy time / period
      const totalBusyMs = agentWithDuration.reduce(
        (sum, e) => sum + (e.details!.durationMs as number), 0
      );
      const busyRate = periodMs > 0 ? totalBusyMs / periodMs : 0;

      agents.push({
        agentId,
        completedCount: agentCompleted.length,
        failedCount: agentFailed.length,
        totalTasks: agentTotal,
        avgDurationMs: agentAvgDuration,
        failureRate: agentTotal > 0 ? agentFailed.length / agentTotal : 0,
        busyRate: Math.min(1, busyRate),
        tierUpgradeCount: agentRetried.length,
      });
    }

    // Overall utilization = sum of all busy time / (period * agent count)
    const totalBusyMs = allWithDuration.reduce(
      (sum, e) => sum + (e.details!.durationMs as number), 0
    );
    const overallUtilization = allAgents.size > 0 && periodMs > 0
      ? Math.min(1, totalBusyMs / (periodMs * allAgents.size))
      : 0;

    return {
      period,
      totalTasks,
      succeededTasks,
      failedTasks,
      retriedTasks,
      avgDurationMs,
      overallUtilization,
      agents,
    };
  }
}
