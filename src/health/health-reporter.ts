/**
 * HealthReporter — 域 G：系统级健康报告
 * FR-G04: 全局健康仪表盘
 */

import { ResourcePool } from '../pool/resource-pool.js';
import { TaskQueue } from '../task/task-queue.js';
import { HealthMonitor } from './health-monitor.js';
import { RecoveryManager } from './recovery-manager.js';
import type { AgentSlot } from '../types/index.js';

// --- Types ---

export type SystemHealthLevel = 'healthy' | 'degraded' | 'critical';

export interface AgentHealthInfo {
  agentId: string;
  status: string;
  tier: string;
  lastHeartbeatAt: number | null;
  missedHeartbeats: number;
  totalCompleted: number;
  totalFailed: number;
  consecutiveFailures: number;
  isRecovering: boolean;
  healthScore: number;
}

export interface SystemHealthReport {
  /** FR-G04 AC2: Overall system health level */
  level: SystemHealthLevel;
  /** FR-G04 AC1: Active (idle/busy) agent count */
  activeAgents: number;
  /** FR-G04 AC1: Stale agent count */
  staleAgents: number;
  /** FR-G04 AC1: Offline/circuit-broken agent count */
  offlineAgents: number;
  /** Total registered agents */
  totalAgents: number;
  /** FR-G04 AC1: Queue depth */
  queueDepth: number;
  /** FR-G04 AC1: Average wait time (ms) for queued tasks */
  avgWaitTimeMs: number;
  /** Per-agent health details */
  agents: AgentHealthInfo[];
  /** System health score (0-100) */
  healthScore: number;
  /** Timestamp of report generation */
  generatedAt: number;
}

// --- HealthReporter ---

export class HealthReporter {
  constructor(
    private resourcePool: ResourcePool,
    private taskQueue: TaskQueue,
    private healthMonitor: HealthMonitor,
    private recoveryManager: RecoveryManager,
  ) {}

  /**
   * FR-G04 AC1/AC2/AC4: Generate full system health report
   */
  generateReport(): SystemHealthReport {
    const allAgents = this.resourcePool.getAll();
    const now = Date.now();

    // Categorize agents
    const activeAgents = allAgents.filter(a => a.status === 'idle' || a.status === 'busy');
    const staleAgents = allAgents.filter(a => a.status === 'stale');
    const offlineAgents = allAgents.filter(a => a.status === 'offline');

    // Queue metrics
    const queuedTasks = this.taskQueue.getAll().filter(t => t.status === 'queued');
    const queueDepth = queuedTasks.length;
    const avgWaitTimeMs = this.calculateAvgWaitTime(queuedTasks, now);

    // Per-agent health info
    const agentInfos = allAgents.map(a => this.buildAgentHealthInfo(a));

    // FR-G04 AC2: Determine system health level
    const level = this.determineHealthLevel(allAgents, activeAgents.length, offlineAgents.length);

    // Calculate overall health score
    const healthScore = this.calculateSystemHealthScore(agentInfos, queueDepth);

    return {
      level,
      activeAgents: activeAgents.length,
      staleAgents: staleAgents.length,
      offlineAgents: offlineAgents.length,
      totalAgents: allAgents.length,
      queueDepth,
      avgWaitTimeMs,
      agents: agentInfos,
      healthScore,
      generatedAt: now,
    };
  }

  /**
   * FR-G04 AC4: Export report as JSON (for external monitoring)
   */
  toJSON(): string {
    return JSON.stringify(this.generateReport(), null, 2);
  }

  // --- Private ---

  private buildAgentHealthInfo(agent: AgentSlot): AgentHealthInfo {
    const heartbeat = this.healthMonitor.getHeartbeatState(agent.agentId);
    const isRecovering = this.recoveryManager.isRecovering(agent.agentId);

    const healthScore = this.calculateAgentHealthScore(agent, heartbeat?.missedCount ?? 0);

    return {
      agentId: agent.agentId,
      status: agent.status,
      tier: agent.tier,
      lastHeartbeatAt: heartbeat?.lastResponseAt ?? null,
      missedHeartbeats: heartbeat?.missedCount ?? 0,
      totalCompleted: agent.totalCompleted,
      totalFailed: agent.totalFailed,
      consecutiveFailures: agent.consecutiveFailures,
      isRecovering,
      healthScore,
    };
  }

  /**
   * FR-G04 AC2: Three-level health determination
   */
  private determineHealthLevel(
    allAgents: AgentSlot[],
    activeCount: number,
    offlineCount: number,
  ): SystemHealthLevel {
    if (allAgents.length === 0) return 'critical';
    if (activeCount === 0) return 'critical'; // No available agents
    if (offlineCount > 0 || activeCount < allAgents.length) return 'degraded';
    return 'healthy';
  }

  /**
   * Calculate per-agent health score (0-100)
   */
  private calculateAgentHealthScore(agent: AgentSlot, missedHeartbeats: number): number {
    let score = 100;

    // Status penalty
    if (agent.status === 'offline') score -= 100;
    else if (agent.status === 'stale') score -= 60;

    // Missed heartbeats penalty (up to -30)
    score -= Math.min(missedHeartbeats * 10, 30);

    // Consecutive failures penalty (up to -30)
    score -= Math.min(agent.consecutiveFailures * 10, 30);

    // Success rate factor
    const total = agent.totalCompleted + agent.totalFailed;
    if (total > 0) {
      const failRate = agent.totalFailed / total;
      score -= Math.round(failRate * 20);
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Calculate system-wide health score (0-100)
   */
  private calculateSystemHealthScore(agents: AgentHealthInfo[], queueDepth: number): number {
    if (agents.length === 0) return 0;

    // Average of agent scores
    const avgAgentScore = agents.reduce((sum, a) => sum + a.healthScore, 0) / agents.length;

    // Queue pressure penalty (high queue = degraded)
    const queuePenalty = Math.min(queueDepth * 2, 20);

    return Math.max(0, Math.min(100, Math.round(avgAgentScore - queuePenalty)));
  }

  private calculateAvgWaitTime(queuedTasks: { createdAt: number }[], now: number): number {
    if (queuedTasks.length === 0) return 0;
    const totalWait = queuedTasks.reduce((sum, t) => sum + (now - t.createdAt), 0);
    return Math.round(totalWait / queuedTasks.length);
  }
}
