/**
 * BiasDetector — FR-B06: 无偏见调度
 *
 * AC1: 调度决策合法输入仅限：任务类型匹配、Agent 可用性、角色适配度
 * AC2: 同 Tier 同 Role 多 Agent 可用时，使用确定性公平算法
 * AC3: 连续 N 次派同一 Agent 且同 Tier 有其他空闲 Agent → bias-alert + 强制轮转
 * AC4: 代码级规则执行（L2 层）
 * AC5: bias-alert 写入 Audit Event
 */

import { v4 as uuid } from 'uuid';
import { EventBus } from '../event/event-bus.js';
import type {
  AgentSlot,
  AuditEvent,
  BiasAlertEvent,
  BiasDetectorConfig,
  SelectionStrategy,
} from '../types/index.js';
import { DEFAULT_BIAS_CONFIG } from '../types/index.js';

export class BiasDetector {
  private config: BiasDetectorConfig;
  private dispatchHistory: string[] = [];
  private roundRobinIndex = 0;

  constructor(
    private eventBus: EventBus,
    config?: Partial<BiasDetectorConfig>,
  ) {
    this.config = { ...DEFAULT_BIAS_CONFIG, ...config };
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(config: Partial<BiasDetectorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): BiasDetectorConfig {
    return { ...this.config };
  }

  /**
   * FR-B06 AC2: Select agent from candidates using fair algorithm.
   * FR-B06 AC3: Check for bias and force rotation if needed.
   *
   * Returns the selected agent, or undefined if candidates is empty.
   */
  selectFair(candidates: AgentSlot[]): AgentSlot | undefined {
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) {
      this.recordDispatch(candidates[0].agentId);
      return candidates[0];
    }

    // FR-B06 AC3: Check if we need to force rotation
    const forcedRotation = this.checkBiasAndRotate(candidates);
    if (forcedRotation) {
      this.recordDispatch(forcedRotation.agentId);
      return forcedRotation;
    }

    // FR-B06 AC2: Apply fair selection strategy
    const selected = this.applyStrategy(candidates);
    this.recordDispatch(selected.agentId);
    return selected;
  }

  /**
   * Record a dispatch event (called externally when dispatch happens outside selectFair)
   */
  recordDispatch(agentId: string): void {
    this.dispatchHistory.push(agentId);
    // Keep history bounded
    if (this.dispatchHistory.length > 1000) {
      this.dispatchHistory = this.dispatchHistory.slice(-500);
    }
  }

  /**
   * Get the current consecutive count for the most recently dispatched agent
   */
  getConsecutiveCount(agentId: string): number {
    let count = 0;
    for (let i = this.dispatchHistory.length - 1; i >= 0; i--) {
      if (this.dispatchHistory[i] === agentId) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  /**
   * Get dispatch history (for testing/debugging)
   */
  getHistory(): string[] {
    return [...this.dispatchHistory];
  }

  /**
   * Reset state (for testing)
   */
  reset(): void {
    this.dispatchHistory = [];
    this.roundRobinIndex = 0;
  }

  /**
   * FR-B06 AC3: Check for consecutive bias pattern.
   * If bias detected, emit alert and return a rotated candidate.
   */
  private checkBiasAndRotate(candidates: AgentSlot[]): AgentSlot | undefined {
    if (this.dispatchHistory.length < this.config.consecutiveThreshold) {
      return undefined;
    }

    // Check if last N dispatches went to the same agent
    const lastN = this.dispatchHistory.slice(-this.config.consecutiveThreshold);
    const allSame = lastN.every(id => id === lastN[0]);
    if (!allSame) return undefined;

    const biasedAgentId = lastN[0];

    // Check if there are other idle candidates in the same tier
    const biasedAgent = candidates.find(a => a.agentId === biasedAgentId);
    if (!biasedAgent) return undefined;

    const otherCandidates = candidates.filter(
      a => a.agentId !== biasedAgentId && a.status === 'idle',
    );

    if (otherCandidates.length === 0) {
      // No other idle agents — bias is justified, no alert
      return undefined;
    }

    // FR-B06 AC5: Emit bias-alert event
    const alertEvent: BiasAlertEvent = {
      biasedAgentId,
      consecutiveCount: this.config.consecutiveThreshold,
      sameTierIdleAgents: otherCandidates.map(a => a.agentId),
      timestamp: Date.now(),
    };

    this.emitAudit('bias_alert', {
      biasedAgentId: alertEvent.biasedAgentId,
      consecutiveCount: alertEvent.consecutiveCount,
      sameTierIdleAgents: alertEvent.sameTierIdleAgents,
    });

    this.eventBus.emit('dispatch:bias_alert', alertEvent).catch(() => {});

    // Force rotation: pick from other candidates using the fair strategy
    return this.applyStrategy(otherCandidates);
  }

  /**
   * FR-B06 AC2: Apply deterministic fair selection strategy
   */
  private applyStrategy(candidates: AgentSlot[]): AgentSlot {
    switch (this.config.selectionStrategy) {
      case 'round-robin':
        return this.roundRobin(candidates);
      case 'random':
        return this.randomSelect(candidates);
      case 'least-active':
      default:
        return this.leastActive(candidates);
    }
  }

  /**
   * Least-active-first: pick the agent with fewest active tasks.
   * Ties broken by total completed (fewer = less used overall).
   */
  private leastActive(candidates: AgentSlot[]): AgentSlot {
    const sorted = [...candidates].sort((a, b) => {
      if (a.activeTasks !== b.activeTasks) return a.activeTasks - b.activeTasks;
      // Secondary: fewer total completed means less historically used
      return a.totalCompleted - b.totalCompleted;
    });
    return sorted[0];
  }

  /**
   * Round-robin: cycle through candidates in order
   */
  private roundRobin(candidates: AgentSlot[]): AgentSlot {
    // Sort candidates by agentId for deterministic ordering
    const sorted = [...candidates].sort((a, b) => a.agentId.localeCompare(b.agentId));
    const idx = this.roundRobinIndex % sorted.length;
    this.roundRobinIndex++;
    return sorted[idx];
  }

  /**
   * Random selection (uniform)
   */
  private randomSelect(candidates: AgentSlot[]): AgentSlot {
    const idx = Math.floor(Math.random() * candidates.length);
    return candidates[idx];
  }

  private emitAudit(type: AuditEvent['type'], details: Record<string, unknown>): void {
    const event: AuditEvent = {
      eventId: uuid(),
      type,
      timestamp: Date.now(),
      details,
    };
    this.eventBus.emit('audit', event).catch(() => {});
  }
}
