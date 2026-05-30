/**
 * FR-C08: 梯队管理
 * 自动发现可用 Agent 池并分梯队，任务分配时按梯队优先级选择，支持基于历史表现自动调整。
 *
 * AC1: init 时自动扫描宿主环境的 Agent 列表，根据 model provider 和历史表现分配梯队
 * AC2: 默认策略按 model 能力分级
 * AC3: 有历史数据后（>= 10 次）根据成功率、平均耗时自动调整
 * AC4: 手动覆盖优先级高于自动调整
 * AC5: 任务派发时按梯队优先级选择 Agent
 * AC6: CLI 展示梯队分布
 * AC7: 单 Agent 环境下透明退化
 */

import { EventBus } from '../event/event-bus.js';
import type { DiscoveredAgent, Tier } from '../types/index.js';
import type {
  AgentPerformance,
  ModelTierMapping,
  TierAssignment,
  TierDistribution,
  TierManagerConfig,
} from './types.js';
import {
  DEFAULT_MODEL_TIER_MAPPING,
  DEFAULT_TIER_MANAGER_CONFIG,
} from './types.js';

const TIER_ORDER: Tier[] = ['T4', 'T3', 'T2', 'T1'];

/**
 * 梯队管理器
 * 管理 Agent 的梯队分配、历史表现追踪、自动调整
 */
export class TierManager {
  private assignments = new Map<string, TierAssignment>();
  private performance = new Map<string, AgentPerformance>();
  private manualOverrides = new Set<string>();
  private readonly config: TierManagerConfig;
  private readonly modelMapping: ModelTierMapping;

  constructor(
    private eventBus: EventBus,
    config?: Partial<TierManagerConfig>,
    modelMapping?: ModelTierMapping,
  ) {
    this.config = { ...DEFAULT_TIER_MANAGER_CONFIG, ...config };
    this.modelMapping = modelMapping ?? DEFAULT_MODEL_TIER_MAPPING;
  }

  /**
   * AC1: 自动发现并分配梯队
   * 扫描 Agent 列表，根据 model 信息自动分配初始梯队
   */
  discoverAndAssign(agents: DiscoveredAgent[]): TierAssignment[] {
    const results: TierAssignment[] = [];

    for (const agent of agents) {
      // Skip if manually overridden
      if (this.manualOverrides.has(agent.agentId)) continue;

      // AC2: 按 model 能力分级
      const tier = this.inferTierFromModel(agent.model);
      const assignment: TierAssignment = {
        agentId: agent.agentId,
        tier,
        source: 'auto',
        assignedAt: Date.now(),
      };

      this.assignments.set(agent.agentId, assignment);
      results.push(assignment);

      // Initialize performance tracking
      if (!this.performance.has(agent.agentId)) {
        this.performance.set(agent.agentId, {
          agentId: agent.agentId,
          totalTasks: 0,
          successCount: 0,
          failureCount: 0,
          averageDurationMs: 0,
          successRate: 0,
          lastUpdated: Date.now(),
        });
      }
    }

    this.emitAudit('tier_assignment', {
      action: 'discover_and_assign',
      count: results.length,
      assignments: results.map(a => ({ agentId: a.agentId, tier: a.tier })),
    });

    return results;
  }

  /**
   * AC4: 手动设置 Agent 梯队（优先级高于自动调整）
   */
  setTier(agentId: string, tier: Tier): TierAssignment {
    const assignment: TierAssignment = {
      agentId,
      tier,
      source: 'manual',
      assignedAt: Date.now(),
    };
    this.assignments.set(agentId, assignment);
    this.manualOverrides.add(agentId);

    this.emitAudit('tier_assignment', {
      action: 'manual_set',
      agentId,
      tier,
    });

    return assignment;
  }

  /**
   * 获取 Agent 的当前梯队
   */
  getTier(agentId: string): Tier | undefined {
    return this.assignments.get(agentId)?.tier;
  }

  /**
   * 获取 Agent 的梯队分配信息
   */
  getAssignment(agentId: string): TierAssignment | undefined {
    return this.assignments.get(agentId);
  }

  /**
   * 记录任务完成，更新历史表现
   */
  recordTaskCompletion(
    agentId: string,
    success: boolean,
    durationMs: number,
  ): void {
    let perf = this.performance.get(agentId);
    if (!perf) {
      perf = {
        agentId,
        totalTasks: 0,
        successCount: 0,
        failureCount: 0,
        averageDurationMs: 0,
        successRate: 0,
        lastUpdated: Date.now(),
      };
      this.performance.set(agentId, perf);
    }

    perf.totalTasks++;
    if (success) {
      perf.successCount++;
    } else {
      perf.failureCount++;
    }

    // Rolling average duration
    perf.averageDurationMs =
      (perf.averageDurationMs * (perf.totalTasks - 1) + durationMs) / perf.totalTasks;
    perf.successRate = perf.successCount / perf.totalTasks;
    perf.lastUpdated = Date.now();

    // AC3: 自动调整梯队（仅非手动覆盖的 Agent）
    if (perf.totalTasks >= this.config.minTasksForAutoAdjust) {
      this.autoAdjustTier(agentId, perf);
    }
  }

  /**
   * AC5: 按梯队优先级选择 Agent
   * 返回指定梯队（或更高梯队）中可用的 Agent ID 列表，按表现排序
   * AC7: 单 Agent 环境下透明退化，直接返回唯一 agent 并标记为 T1
   */
  selectByTier(targetTier: Tier, excludeAgentId?: string): string[] {
    // AC7 / FR-C08: 单 Agent 强制 T1 — 直接返回唯一 agent
    if (this.isSingleAgentMode()) {
      const [onlyAgentId] = [...this.assignments.keys()];
      if (onlyAgentId && (!excludeAgentId || onlyAgentId !== excludeAgentId)) {
        // 强制标记为 T1
        const assignment = this.assignments.get(onlyAgentId);
        if (assignment && assignment.tier !== 'T1') {
          assignment.tier = 'T1';
          assignment.source = 'auto';
          assignment.assignedAt = Date.now();
        }
        return [onlyAgentId];
      }
      return [];
    }

    const tierIndex = TIER_ORDER.indexOf(targetTier);
    const candidates: Array<{ agentId: string; tier: Tier; score: number }> = [];

    for (const [agentId, assignment] of this.assignments) {
      if (excludeAgentId && agentId === excludeAgentId) continue;
      const assignmentTierIndex = TIER_ORDER.indexOf(assignment.tier);
      // Include same tier and higher tiers
      if (assignmentTierIndex >= tierIndex) {
        const perf = this.performance.get(agentId);
        const score = perf ? perf.successRate * 100 - (assignmentTierIndex - tierIndex) * 10 : 50;
        candidates.push({ agentId, tier: assignment.tier, score });
      }
    }

    // Sort: prefer same tier first, then by performance score
    candidates.sort((a, b) => {
      const aTierIdx = TIER_ORDER.indexOf(a.tier);
      const bTierIdx = TIER_ORDER.indexOf(b.tier);
      if (aTierIdx !== bTierIdx) return aTierIdx - bTierIdx;
      return b.score - a.score;
    });

    return candidates.map(c => c.agentId);
  }

  /**
   * 获取升级后的梯队
   */
  getUpgradedTier(currentTier: Tier): Tier | undefined {
    const idx = TIER_ORDER.indexOf(currentTier);
    if (idx >= TIER_ORDER.length - 1) return undefined; // Already at T1
    return TIER_ORDER[idx + 1];
  }

  /**
   * AC6: 获取梯队分布视图
   */
  getTierDistribution(): TierDistribution[] {
    const distribution: TierDistribution[] = TIER_ORDER.map(tier => ({
      tier,
      agents: [],
    }));

    for (const [agentId, assignment] of this.assignments) {
      const perf = this.performance.get(agentId) ?? {
        agentId,
        totalTasks: 0,
        successCount: 0,
        failureCount: 0,
        averageDurationMs: 0,
        successRate: 0,
        lastUpdated: 0,
      };
      const tierDist = distribution.find(d => d.tier === assignment.tier);
      tierDist?.agents.push({
        agentId,
        performance: perf,
        source: assignment.source,
      });
    }

    return distribution.filter(d => d.agents.length > 0);
  }

  /**
   * 获取 Agent 的历史表现数据
   */
  getPerformance(agentId: string): AgentPerformance | undefined {
    return this.performance.get(agentId);
  }

  /**
   * 获取所有 Agent 的表现数据
   */
  getAllPerformance(): AgentPerformance[] {
    return Array.from(this.performance.values());
  }

  /**
   * AC7: 检测是否为单 Agent 模式
   */
  isSingleAgentMode(): boolean {
    return this.assignments.size <= 1;
  }

  /**
   * 获取已注册的 Agent 数量
   */
  getAgentCount(): number {
    return this.assignments.size;
  }

  // --- Internal ---

  /**
   * AC2: 根据 model 名称推断梯队
   */
  private inferTierFromModel(model?: string): Tier {
    if (!model) return 'T3'; // Default to T3 when model unknown

    for (const { pattern, tier } of this.modelMapping.patterns) {
      if (pattern.test(model)) {
        return tier;
      }
    }

    return 'T3'; // Default fallback
  }

  /**
   * AC3: 基于历史表现自动调整梯队
   */
  private autoAdjustTier(agentId: string, perf: AgentPerformance): void {
    // Skip manually overridden agents
    if (this.manualOverrides.has(agentId)) return;

    const current = this.assignments.get(agentId);
    if (!current) return;

    const currentTierIdx = TIER_ORDER.indexOf(current.tier);
    let newTier: Tier | undefined;

    // Promote if success rate is high
    if (perf.successRate >= this.config.promoteThreshold && currentTierIdx < TIER_ORDER.length - 1) {
      newTier = TIER_ORDER[currentTierIdx + 1];
    }
    // Demote if success rate is low
    else if (perf.successRate <= this.config.demoteThreshold && currentTierIdx > 0) {
      newTier = TIER_ORDER[currentTierIdx - 1];
    }

    if (newTier && newTier !== current.tier) {
      const oldTier = current.tier;
      current.tier = newTier;
      current.source = 'performance';
      current.assignedAt = Date.now();

      this.emitAudit('tier_assignment', {
        action: 'auto_adjust',
        agentId,
        oldTier,
        newTier,
        successRate: perf.successRate,
        totalTasks: perf.totalTasks,
      });
    }
  }

  private emitAudit(type: string, details: Record<string, unknown>): void {
    this.eventBus.emit('audit', {
      eventId: `tier-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      timestamp: Date.now(),
      details,
    }).catch(() => {});
  }
}
