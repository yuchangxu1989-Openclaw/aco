/**
 * FR-C07: 调度规则引擎
 * 内置核心调度规则的执行引擎，支持用户自定义规则，规则变更实时生效。
 *
 * AC1: 内置 FR-C01 至 FR-C05 的规则定义
 * AC2: 用户可添加自定义规则
 * AC3: 规则变更实时生效（热加载）
 * AC4: 规则执行按优先级排序
 * AC5: 规则冲突时按优先级降序执行第一条匹配规则
 * AC6: 每条规则的执行结果写入 Audit Event
 * AC7: CLI 命令展示所有规则状态
 */

import { EventBus } from '../event/event-bus.js';
import type {
  ControlRule,
  ControlRuleContext,
  ControlRuleResult,
  RuleEngineConfig,
  RuleExecutionRecord,
} from './types.js';
import { DEFAULT_RULE_ENGINE_CONFIG } from './types.js';

/**
 * Rule interface for external consumers
 */
export type { ControlRule as Rule };

/**
 * 核心调度规则引擎
 * 管理内置规则 + 用户自定义规则，按优先级评估，审计追踪每次触发
 */
export class ControlRuleEngine {
  private rules: ControlRule[] = [];
  private executionLog: RuleExecutionRecord[] = [];
  private readonly config: RuleEngineConfig;
  private hitCounts = new Map<string, number>();

  constructor(
    private eventBus: EventBus,
    config?: Partial<RuleEngineConfig>,
  ) {
    this.config = { ...DEFAULT_RULE_ENGINE_CONFIG, ...config };
    if (this.config.builtinRulesEnabled) {
      this.loadBuiltinRules();
    }
  }

  /**
   * AC2: 添加自定义规则（立即生效）
   */
  addRule(rule: ControlRule): void {
    // Remove existing rule with same ID (update semantics)
    this.rules = this.rules.filter(r => r.ruleId !== rule.ruleId);
    this.rules.push(rule);
    this.sortRules();
    this.emitAudit('config_changed', { action: 'rule_added', ruleId: rule.ruleId });
  }

  /**
   * AC2: 移除规则
   */
  removeRule(ruleId: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter(r => r.ruleId !== ruleId);
    if (this.rules.length < before) {
      this.emitAudit('config_changed', { action: 'rule_removed', ruleId });
      return true;
    }
    return false;
  }

  /**
   * AC3: 批量加载规则（热加载场景）
   * 替换所有非内置规则，保留内置规则
   */
  loadCustomRules(rules: ControlRule[]): void {
    const builtins = this.rules.filter(r => isBuiltinRule(r.ruleId));
    this.rules = [...builtins, ...rules];
    this.sortRules();
    this.emitAudit('config_changed', { action: 'rules_reloaded', count: rules.length });
  }

  /**
   * AC4/AC5: 评估上下文，返回第一条匹配规则的结果
   * 按优先级降序逐条评估，返回第一个非 null 结果
   */
  evaluate(context: ControlRuleContext): ControlRuleResult | null {
    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      const result = rule.evaluate(context);
      if (result !== null) {
        // AC6: 记录执行结果
        this.recordExecution(rule, context, result);
        return result;
      }
    }
    return null;
  }

  /**
   * 评估所有匹配的规则（不短路），返回所有匹配结果
   * 用于审计和调试场景
   */
  evaluateAll(context: ControlRuleContext): ControlRuleResult[] {
    const results: ControlRuleResult[] = [];
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const result = rule.evaluate(context);
      if (result !== null) {
        this.recordExecution(rule, context, result);
        results.push(result);
      }
    }
    return results;
  }

  /**
   * AC7: 获取所有规则及其状态
   */
  listRules(): Array<{
    ruleId: string;
    type: string;
    priority: number;
    enabled: boolean;
    description: string;
    hitCount: number;
  }> {
    return this.rules.map(r => ({
      ruleId: r.ruleId,
      type: r.type,
      priority: r.priority,
      enabled: r.enabled,
      description: r.description,
      hitCount: this.hitCounts.get(r.ruleId) ?? 0,
    }));
  }

  /**
   * 启用/禁用规则
   */
  setRuleEnabled(ruleId: string, enabled: boolean): boolean {
    const rule = this.rules.find(r => r.ruleId === ruleId);
    if (!rule) return false;
    rule.enabled = enabled;
    this.emitAudit('config_changed', { action: enabled ? 'rule_enabled' : 'rule_disabled', ruleId });
    return true;
  }

  /**
   * 获取执行日志（最近 N 条）
   */
  getExecutionLog(limit = 100): RuleExecutionRecord[] {
    return this.executionLog.slice(-limit);
  }

  /**
   * 清空执行日志
   */
  clearExecutionLog(): void {
    this.executionLog = [];
  }

  /**
   * 获取规则数量
   */
  getRuleCount(): { total: number; builtin: number; custom: number; enabled: number } {
    const builtin = this.rules.filter(r => isBuiltinRule(r.ruleId)).length;
    const custom = this.rules.length - builtin;
    const enabled = this.rules.filter(r => r.enabled).length;
    return { total: this.rules.length, builtin, custom, enabled };
  }

  // --- Internal ---

  private loadBuiltinRules(): void {
    const builtins = createBuiltinRules();
    this.rules.push(...builtins);
    this.sortRules();
  }

  private sortRules(): void {
    // AC4: 按优先级降序排序
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  private recordExecution(
    rule: ControlRule,
    context: ControlRuleContext,
    result: ControlRuleResult,
  ): void {
    // Update hit count
    this.hitCounts.set(rule.ruleId, (this.hitCounts.get(rule.ruleId) ?? 0) + 1);

    // AC6: Write to execution log
    const record: RuleExecutionRecord = {
      ruleId: rule.ruleId,
      timestamp: Date.now(),
      context: {
        task: context.task ? { taskId: context.task.taskId, label: context.task.label } as any : undefined,
        agent: context.agent ? { agentId: context.agent.agentId } as any : undefined,
        sessionType: context.sessionType,
        operationType: context.operationType,
      },
      result,
    };
    this.executionLog.push(record);

    // Keep log bounded
    if (this.executionLog.length > 10000) {
      this.executionLog = this.executionLog.slice(-5000);
    }

    // Emit audit event
    this.emitAudit('rule_matched', {
      ruleId: rule.ruleId,
      action: result.action,
      reason: result.reason,
      taskId: context.task?.taskId,
      agentId: context.agent?.agentId,
    });
  }

  private emitAudit(type: string, details: Record<string, unknown>): void {
    this.eventBus.emit('audit', {
      eventId: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      timestamp: Date.now(),
      details,
    }).catch(() => {});
  }
}

// --- Built-in Rules (FR-C01 to FR-C05 encoded as rules) ---

function isBuiltinRule(ruleId: string): boolean {
  return ruleId.startsWith('builtin:');
}

function createBuiltinRules(): ControlRule[] {
  return [
    // FR-C01: 开发审计分离
    {
      ruleId: 'builtin:dev-audit-separation',
      type: 'dev-audit-separation',
      priority: 100,
      description: '开发 Agent 不能审计自己的产出',
      enabled: true,
      evaluate(ctx: ControlRuleContext): ControlRuleResult | null {
        if (!ctx.task || !ctx.agent || !ctx.sourceAgentId) return null;
        // Check if this is an audit task being assigned to the same agent that produced the work.
        // Uses structured SEVO label protocol (sevo:<project>:<stage>:<type>) or operationType field.
        const label = ctx.task.label ?? '';
        const opType = ctx.operationType ?? '';
        const labelParts = label.split(':');
        // SEVO structured label: sevo:<project>:audit:<detail> or sevo:<project>:review:<detail>
        const isAuditByLabel = labelParts.length >= 3 &&
          labelParts[0] === 'sevo' &&
          (labelParts[2] === 'audit' || labelParts[2] === 'review');
        // operationType is a structured field set by the dispatcher, not free text
        const isAuditByOpType = opType === 'audit' || opType === 'review';
        const isAuditTask = isAuditByLabel || isAuditByOpType;
        if (isAuditTask && ctx.sourceAgentId === ctx.agent.agentId) {
          return {
            action: 'block',
            reason: '开发审计分离：禁止开发者自审',
            ruleId: 'builtin:dev-audit-separation',
          };
        }
        return null;
      },
    },

    // FR-C02: 失败即时重派
    {
      ruleId: 'builtin:failure-retry',
      type: 'failure-retry',
      priority: 90,
      description: '任务失败后自动重派，禁止原样重派',
      enabled: true,
      evaluate(ctx: ControlRuleContext): ControlRuleResult | null {
        if (!ctx.task) return null;
        if (ctx.task.status !== 'failed') return null;
        if ((ctx.failureCount ?? 0) >= (ctx.task.maxRetries ?? 3)) {
          return {
            action: 'escalate',
            reason: '重试次数已耗尽，升级梯队或标记 failed-exhausted',
            ruleId: 'builtin:failure-retry',
            metadata: { exhausted: true },
          };
        }
        return {
          action: 'retry',
          reason: '任务失败，触发重派（需优化 prompt 或拆分）',
          ruleId: 'builtin:failure-retry',
          metadata: { retryCount: (ctx.failureCount ?? 0) + 1 },
        };
      },
    },

    // FR-C03: 超时熔断
    {
      ruleId: 'builtin:timeout-circuit-break',
      type: 'timeout-circuit-break',
      priority: 95,
      description: '任务超时自动 kill 并重派，频繁失败的 Agent 熔断',
      enabled: true,
      evaluate(ctx: ControlRuleContext): ControlRuleResult | null {
        if (!ctx.task || !ctx.elapsedMs) return null;
        const timeout = ctx.task.timeoutSeconds * 1000;
        if (ctx.elapsedMs > timeout) {
          return {
            action: 'retry',
            reason: `任务超时（${Math.round(ctx.elapsedMs / 1000)}s > ${ctx.task.timeoutSeconds}s），触发 kill + 重派`,
            ruleId: 'builtin:timeout-circuit-break',
            metadata: { timeout: true, elapsedMs: ctx.elapsedMs },
          };
        }
        return null;
      },
    },

    // FR-C04: 主会话空闲保护
    {
      ruleId: 'builtin:main-session-guard',
      type: 'main-session-guard',
      priority: 85,
      description: '主会话检测到耗时操作时自动拦截并委派',
      enabled: true,
      evaluate(ctx: ControlRuleContext): ControlRuleResult | null {
        if (ctx.sessionType !== 'main') return null;
        // Detect long-running operation patterns
        const longRunningPatterns = [
          /npm\s+(run\s+)?build/i,
          /npx\s+(next|tsc|webpack)/i,
          /npm\s+(install|ci)/i,
          /apt\s+install/i,
          /pip\s+install/i,
        ];
        const op = ctx.operationType ?? '';
        const isLongRunning = longRunningPatterns.some(p => p.test(op));
        if (isLongRunning) {
          return {
            action: 'delegate',
            reason: '主会话空闲保护：耗时操作应委派给子 Agent',
            ruleId: 'builtin:main-session-guard',
            metadata: { operation: op },
          };
        }
        return null;
      },
    },

    // FR-C05: 并行文件隔离（规则层面的检测触发）
    {
      ruleId: 'builtin:file-isolation',
      type: 'file-isolation',
      priority: 80,
      description: '多 Agent 并行时自动激活文件隔离',
      enabled: true,
      evaluate(ctx: ControlRuleContext): ControlRuleResult | null {
        if (!ctx.parallelTasks) return null;
        const runningAgents = new Set(
          ctx.parallelTasks
            .filter(t => t.status === 'running' && t.agentId)
            .map(t => t.agentId),
        );
        if (runningAgents.size >= 2) {
          return {
            action: 'warn',
            reason: `并行文件隔离已激活：${runningAgents.size} 个 Agent 同时运行`,
            ruleId: 'builtin:file-isolation',
            metadata: { activeAgents: Array.from(runningAgents) },
          };
        }
        return null;
      },
    },
  ];
}
