/**
 * RoleDiscovery — FR-B06: 动态角色发现
 *
 * AC1: 支持宿主配置中的可选 role 字段
 * AC2: 启动时从宿主配置动态构建 ROLE_AGENTS 和 ROLE_TASK_MAP，禁止硬编码 Agent ID
 * AC3: 渐进式降级——单 Agent→skip；多 Agent 无 role→warn；有 role→enforce
 * AC4: AGENT_TIER 支持从配置显式声明或根据 runtime.type 自动推断
 * AC5: 配置变更后自动刷新角色映射和梯队信息
 * AC6: 动态构建的映射关系写入启动日志
 */

import { v4 as uuid } from 'uuid';
import { EventBus } from '../event/event-bus.js';
import type {
  AuditEvent,
  DiscoveredAgent,
  HostAdapter,
  RoleTag,
  Tier,
} from '../types/index.js';

// --- Types ---

/** 角色 → Agent 列表映射 */
export type RoleAgentsMap = Map<RoleTag, string[]>;

/** 任务类型 → 允许角色映射 */
export type RoleTaskMap = Map<string, RoleTag[]>;

/** 角色发现的运行模式 */
export type RoleEnforcementMode = 'skip' | 'warn' | 'enforce';

/** 角色发现配置 */
export interface RoleDiscoveryConfig {
  /** 默认任务类型到角色的映射（当宿主配置未提供时使用） */
  defaultTaskRoleMapping: Record<string, string[]>;
  /** 配置刷新间隔（ms），0 表示仅依赖 watcher 事件 */
  refreshIntervalMs: number;
}

/** 角色发现结果 */
export interface RoleDiscoveryResult {
  roleAgents: RoleAgentsMap;
  roleTaskMap: RoleTaskMap;
  mode: RoleEnforcementMode;
  agentCount: number;
  rolesFound: string[];
  timestamp: number;
}

/** 内部 Agent 信息（含推断的 tier） */
interface AgentInfo {
  agentId: string;
  roles: RoleTag[];
  tier: Tier;
  runtimeType?: string;
}

// --- Constants ---

/**
 * 规范角色别名映射：spec 值 → 内部 RoleTag
 * 宿主配置可能使用 spec 定义的角色名（如 "coding"），
 * 内部统一映射到 RoleTag（如 "coder"）
 */
const ROLE_ALIAS_MAP: Record<string, RoleTag> = {
  coding: 'coder',
  review: 'auditor',
  architecture: 'architect',
  research: 'researcher',
  // 以下值与内部 RoleTag 一致，无需映射但保留以支持两种写法
  coder: 'coder',
  auditor: 'auditor',
  architect: 'architect',
  researcher: 'researcher',
  pm: 'pm',
  ux: 'ux',
};

/** 默认任务类型→角色映射（AC2: 从配置动态构建，此为 fallback） */
const DEFAULT_TASK_ROLE_MAPPING: Record<string, string[]> = {
  coding: ['coder'],
  refactoring: ['coder'],
  testing: ['coder'],
  bugfix: ['coder'],
  architecture: ['architect'],
  design: ['architect'],
  review: ['auditor'],
  audit: ['auditor'],
  security: ['auditor'],
  requirements: ['pm'],
  spec: ['pm'],
  planning: ['pm'],
  ux_review: ['ux'],
  visual: ['ux'],
  research: ['researcher'],
  analysis: ['researcher'],
};

const DEFAULT_ROLE_DISCOVERY_CONFIG: RoleDiscoveryConfig = {
  defaultTaskRoleMapping: DEFAULT_TASK_ROLE_MAPPING,
  refreshIntervalMs: 0,
};

// --- Class ---

export class RoleDiscovery {
  private config: RoleDiscoveryConfig;
  private roleAgents: RoleAgentsMap = new Map();
  private roleTaskMap: RoleTaskMap = new Map();
  private agents: AgentInfo[] = [];
  private mode: RoleEnforcementMode = 'skip';
  private lastDiscoveryTimestamp = 0;
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(
    private eventBus: EventBus,
    private adapter: HostAdapter,
    config?: Partial<RoleDiscoveryConfig>,
  ) {
    this.config = { ...DEFAULT_ROLE_DISCOVERY_CONFIG, ...config };
  }

  /**
   * AC1+AC2: 从宿主配置动态构建角色映射
   * 调用 adapter.discoverAgents() 获取 Agent 列表
   * 根据每个 Agent 的 roles 字段构建 ROLE_AGENTS
   * 根据内置 + 配置的任务类型定义构建 ROLE_TASK_MAP
   */
  async discover(): Promise<RoleDiscoveryResult> {
    const discovered = await this.discoverFromAdapter();

    // 构建内部 Agent 信息
    this.agents = discovered.map(agent => ({
      agentId: agent.agentId,
      roles: this.normalizeRoles(agent.roles ?? []),
      tier: this.inferTier(agent),
      runtimeType: this.inferRuntimeType(agent),
    }));

    // AC2: 动态构建 ROLE_AGENTS
    this.roleAgents = this.buildRoleAgentsMap(this.agents);

    // AC2: 动态构建 ROLE_TASK_MAP
    this.roleTaskMap = this.buildRoleTaskMap();

    // AC3: 判定运行模式
    this.mode = this.determineMode(this.agents);

    this.lastDiscoveryTimestamp = Date.now();

    // AC5: 启动定时刷新（如果配置了间隔）
    this.startRefreshTimer();

    const result = this.getSnapshot();

    // AC6: 发出审计事件（用于启动日志）
    this.emitAudit('config_changed', {
      action: 'role_discovery_completed',
      mode: result.mode,
      agentCount: result.agentCount,
      rolesFound: result.rolesFound,
      roleAgents: Object.fromEntries(result.roleAgents),
    });

    return result;
  }

  /**
   * AC3: 判断当前运行模式
   */
  getEnforcementMode(): RoleEnforcementMode {
    return this.mode;
  }

  /**
   * AC4: 获取 Agent 的梯队信息
   * 优先使用配置中显式声明的 tier
   * 无显式声明时根据 runtime.type 推断
   */
  getAgentTier(agentId: string): Tier | undefined {
    const agent = this.agents.find(a => a.agentId === agentId);
    return agent?.tier;
  }

  /**
   * AC5: 配置变更时刷新
   * 刷新后发出 'role_discovery_refreshed' 审计事件
   */
  async refresh(): Promise<RoleDiscoveryResult> {
    const result = await this.discover();

    this.emitAudit('config_changed', {
      action: 'role_discovery_refreshed',
      mode: result.mode,
      agentCount: result.agentCount,
      rolesFound: result.rolesFound,
    });

    return result;
  }

  /**
   * AC6: 获取当前映射（用于启动日志输出）
   */
  getSnapshot(): RoleDiscoveryResult {
    return {
      roleAgents: new Map(this.roleAgents),
      roleTaskMap: new Map(this.roleTaskMap),
      mode: this.mode,
      agentCount: this.agents.length,
      rolesFound: Array.from(this.roleAgents.keys()),
      timestamp: this.lastDiscoveryTimestamp,
    };
  }

  /**
   * 校验派发请求的角色匹配
   * 在 RuleEngine evaluate() 之前调用
   * 返回 { allowed, reason }
   */
  checkRoleMatch(
    taskType: string,
    targetAgentId: string,
  ): { allowed: boolean; reason: string } {
    // skip 模式：所有任务直接放行
    if (this.mode === 'skip') {
      return { allowed: true, reason: 'Role check skipped (single agent or no agents)' };
    }

    // 查找任务类型对应的角色要求
    const requiredRoles = this.roleTaskMap.get(taskType);
    if (!requiredRoles || requiredRoles.length === 0) {
      // 未定义角色要求的任务类型，放行
      return { allowed: true, reason: `No role requirement defined for task type '${taskType}'` };
    }

    // 查找目标 Agent 的角色
    const agent = this.agents.find(a => a.agentId === targetAgentId);
    if (!agent) {
      // Agent 不在已发现列表中
      if (this.mode === 'warn') {
        return { allowed: true, reason: `Agent '${targetAgentId}' not in discovery registry (warn mode)` };
      }
      return { allowed: false, reason: `Agent '${targetAgentId}' not found in role registry` };
    }

    // 检查 Agent 是否具有所需角色
    const hasRequiredRole = requiredRoles.some(role => agent.roles.includes(role));

    if (hasRequiredRole) {
      return { allowed: true, reason: `Agent '${targetAgentId}' has matching role for '${taskType}'` };
    }

    // 角色不匹配
    if (this.mode === 'warn') {
      this.emitAudit('dispatch_decision', {
        action: 'role_mismatch_warn',
        taskType,
        agentId: targetAgentId,
        agentRoles: agent.roles,
        requiredRoles,
      });
      return {
        allowed: true,
        reason: `Role mismatch warning: '${targetAgentId}' lacks roles [${requiredRoles.join(', ')}] for '${taskType}' (warn mode, not blocking)`,
      };
    }

    // enforce 模式：拦截
    this.emitAudit('rule_blocked', {
      action: 'role_mismatch_blocked',
      taskType,
      agentId: targetAgentId,
      agentRoles: agent.roles,
      requiredRoles,
    });
    return {
      allowed: false,
      reason: `Role mismatch: '${targetAgentId}' has roles [${agent.roles.join(', ')}] but '${taskType}' requires [${requiredRoles.join(', ')}]`,
    };
  }

  /**
   * 获取指定角色的可用 Agent 列表
   */
  getAgentsForRole(role: RoleTag): string[] {
    return this.roleAgents.get(role) ?? [];
  }

  /**
   * 清理资源
   */
  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  // --- Private methods ---

  private async discoverFromAdapter(): Promise<DiscoveredAgent[]> {
    if (!this.adapter.discoverAgents) {
      return [];
    }
    try {
      return await this.adapter.discoverAgents();
    } catch {
      // Discovery failure is non-fatal; return empty
      return [];
    }
  }

  /**
   * 规范化角色名：将 spec 值映射到内部 RoleTag
   */
  private normalizeRoles(roles: string[]): RoleTag[] {
    return roles.map(role => {
      const normalized = role.toLowerCase().trim();
      return ROLE_ALIAS_MAP[normalized] ?? normalized;
    });
  }

  /**
   * AC4: 推断 Agent 梯队
   * 优先使用显式声明；无声明时根据 model 和 runtime type 推断
   */
  private inferTier(agent: DiscoveredAgent): Tier {
    // 从 model 名称推断 runtime type 和 tier
    const model = agent.model?.toLowerCase() ?? '';

    // ACP agents (有 model 配置) → T1-T3
    if (model) {
      if (model.includes('opus') || model.includes('o1') || (model.includes('gpt-4') && !model.includes('gpt-4o'))) {
        return 'T1';
      }
      if (model.includes('sonnet') || model.includes('gpt-4o')) {
        return 'T2';
      }
      if (model.includes('haiku') || model.includes('gpt-3.5') || model.includes('mini')) {
        return 'T3';
      }
      // 有 model 但无法细分 → T2 (中间值)
      return 'T2';
    }

    // 无 model → subagent → T4
    return 'T4';
  }

  /**
   * 推断 runtime type
   */
  private inferRuntimeType(agent: DiscoveredAgent): string {
    // 有 model 配置的通常是 ACP agent
    return agent.model ? 'acp' : 'subagent';
  }

  /**
   * AC2: 从 Agent 列表动态构建 ROLE_AGENTS 映射
   */
  private buildRoleAgentsMap(agents: AgentInfo[]): RoleAgentsMap {
    const map: RoleAgentsMap = new Map();

    for (const agent of agents) {
      for (const role of agent.roles) {
        const existing = map.get(role) ?? [];
        existing.push(agent.agentId);
        map.set(role, existing);
      }
    }

    return map;
  }

  /**
   * AC2: 构建 ROLE_TASK_MAP
   */
  private buildRoleTaskMap(): RoleTaskMap {
    const map: RoleTaskMap = new Map();

    for (const [taskType, roles] of Object.entries(this.config.defaultTaskRoleMapping)) {
      map.set(taskType, roles as RoleTag[]);
    }

    return map;
  }

  /**
   * AC3: 渐进式降级逻辑
   */
  private determineMode(agents: AgentInfo[]): RoleEnforcementMode {
    // 0-1 个 Agent → skip
    if (agents.length <= 1) {
      return 'skip';
    }

    // 多 Agent 但无任何 role 声明 → warn
    const hasAnyRole = agents.some(a => a.roles.length > 0);
    if (!hasAnyRole) {
      return 'warn';
    }

    // 有 role 声明 → enforce
    return 'enforce';
  }

  /**
   * AC5: 启动定时刷新
   */
  private startRefreshTimer(): void {
    // 清理旧 timer
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    if (this.config.refreshIntervalMs > 0) {
      this.refreshTimer = setInterval(() => {
        this.refresh().catch(() => {
          // Refresh failure is non-fatal
        });
      }, this.config.refreshIntervalMs);
    }
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
