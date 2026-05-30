/**
 * 资源池管理 — 域 C：Agent 注册、状态追踪、梯队路由
 * FR-C01: Agent 注册与发现
 * FR-C02: 梯队路由
 * FR-C03: 失败梯队升级
 * FR-C04: 资源池状态视图
 */

import { v4 as uuid } from 'uuid';
import { EventBus } from '../event/event-bus.js';
import type {
  AgentSlot,
  AgentStatus,
  AuditEvent,
  RegisterAgentInput,
  RoleTag,
  Tier,
} from '../types/index.js';

const TIER_ORDER: Tier[] = ['T4', 'T3', 'T2', 'T1'];

export class ResourcePool {
  private agents = new Map<string, AgentSlot>();

  constructor(private eventBus: EventBus) {}

  /**
   * FR-C01 AC2/AC3: 注册 Agent 到资源池
   */
  register(input: RegisterAgentInput): AgentSlot {
    const slot: AgentSlot = {
      agentId: input.agentId,
      tier: input.tier,
      runtimeType: input.runtimeType,
      status: 'idle',
      roles: input.roles,
      maxConcurrency: input.maxConcurrency ?? 1,
      activeTasks: 0,
      totalCompleted: 0,
      totalFailed: 0,
      consecutiveFailures: 0,
    };
    this.agents.set(input.agentId, slot);

    this.emitAudit('agent_registered', { agentId: input.agentId, tier: input.tier, roles: input.roles });
    return slot;
  }

  /**
   * FR-C01 AC4: 移除 Agent
   */
  unregister(agentId: string): boolean {
    return this.agents.delete(agentId);
  }

  /**
   * 获取单个 Agent Slot
   */
  get(agentId: string): AgentSlot | undefined {
    return this.agents.get(agentId);
  }

  /**
   * FR-C04 AC1: 获取所有 Agent 状态
   */
  getAll(): AgentSlot[] {
    return Array.from(this.agents.values());
  }

  /**
   * FR-C04 AC2: 按条件筛选
   */
  filter(opts?: { tier?: Tier; role?: RoleTag; status?: AgentStatus }): AgentSlot[] {
    let result = this.getAll();
    if (opts?.tier) result = result.filter(a => a.tier === opts.tier);
    if (opts?.role) result = result.filter(a => a.roles.includes(opts.role!));
    if (opts?.status) result = result.filter(a => a.status === opts.status);
    return result;
  }

  /**
   * FR-C02 AC2: 选择可用 Agent（负载均衡：最少活跃任务优先）
   * FR-B03 AC1/AC2: 跳过已达并发上限的 Agent
   */
  selectCandidate(opts: {
    tier?: Tier;
    role?: RoleTag;
    excludeAgentId?: string;
    runtimeType?: 'subagent' | 'acp';
    maxGlobalAcpConcurrency?: number;
  }): AgentSlot | undefined {
    const tier = opts.tier;
    const tiersToTry = tier
      ? TIER_ORDER.slice(TIER_ORDER.indexOf(tier))
      : TIER_ORDER;

    // FR-B03 AC5: ACP 全局并发检查
    if (opts.maxGlobalAcpConcurrency !== undefined) {
      const totalAcpActive = this.getAll()
        .filter(a => a.runtimeType === 'acp')
        .reduce((sum, a) => sum + a.activeTasks, 0);
      if (totalAcpActive >= opts.maxGlobalAcpConcurrency && opts.runtimeType === 'acp') {
        return undefined;
      }
    }

    for (const t of tiersToTry) {
      const candidates = this.getAll()
        .filter(a => a.tier === t)
        .filter(a => a.status === 'idle' || a.status === 'busy')
        .filter(a => a.activeTasks < a.maxConcurrency)
        .filter(a => !opts.excludeAgentId || a.agentId !== opts.excludeAgentId)
        .filter(a => !opts.role || a.roles.includes(opts.role))
        .filter(a => !opts.runtimeType || a.runtimeType === opts.runtimeType);

      if (candidates.length === 0) continue;

      // 最少活跃任务优先
      candidates.sort((a, b) => a.activeTasks - b.activeTasks);
      return candidates[0];
    }

    return undefined;
  }

  /**
   * FR-C03 AC1: 获取升级后的 Tier
   */
  getUpgradedTier(currentTier: Tier): Tier | undefined {
    const idx = TIER_ORDER.indexOf(currentTier);
    if (idx >= TIER_ORDER.length - 1) return undefined; // 已在 T1
    return TIER_ORDER[idx + 1];
  }

  /**
   * 标记 Agent 开始执行任务
   */
  markBusy(agentId: string): void {
    const slot = this.agents.get(agentId);
    if (!slot) return;
    slot.activeTasks++;
    slot.status = 'busy';
    slot.lastActiveAt = Date.now();
  }

  /**
   * 标记 Agent 完成任务
   */
  markTaskCompleted(agentId: string, success: boolean): void {
    const slot = this.agents.get(agentId);
    if (!slot) return;
    slot.activeTasks = Math.max(0, slot.activeTasks - 1);
    if (success) {
      slot.totalCompleted++;
      slot.consecutiveFailures = 0;
    } else {
      slot.totalFailed++;
      slot.consecutiveFailures++;
    }
    if (slot.activeTasks === 0) {
      slot.status = 'idle';
    }
    slot.lastActiveAt = Date.now();
  }

  /**
   * FR-B05 AC1: 熔断检测
   */
  checkCircuitBreak(agentId: string, threshold: number): boolean {
    const slot = this.agents.get(agentId);
    if (!slot) return false;
    return slot.consecutiveFailures >= threshold;
  }

  /**
   * FR-B05 AC1: 触发熔断
   */
  triggerCircuitBreak(agentId: string): void {
    const slot = this.agents.get(agentId);
    if (!slot) return;
    slot.status = 'offline';
    this.emitAudit('circuit_break', { agentId });
    this.eventBus.emit('agent:circuit_break', { agentId });
  }

  /**
   * FR-B05 AC3: 恢复 Agent
   */
  recover(agentId: string): void {
    const slot = this.agents.get(agentId);
    if (!slot) return;
    slot.status = 'idle';
    slot.consecutiveFailures = 0;
    this.emitAudit('agent_status_change', { agentId, from: 'offline', to: 'idle' });
    this.eventBus.emit('agent:recovered', { agentId });
  }

  /**
   * 更新 Agent 状态
   */
  setStatus(agentId: string, status: AgentStatus): void {
    const slot = this.agents.get(agentId);
    if (!slot) return;
    const prev = slot.status;
    slot.status = status;
    this.emitAudit('agent_status_change', { agentId, from: prev, to: status });
  }

  private emitAudit(type: AuditEvent['type'], details: Record<string, unknown>): void {
    const event: AuditEvent = {
      eventId: uuid(),
      type,
      timestamp: Date.now(),
      agentId: details.agentId as string | undefined,
      details,
    };
    this.eventBus.emit('audit', event).catch(() => {});
  }
}
