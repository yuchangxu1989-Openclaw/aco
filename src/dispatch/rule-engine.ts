/**
 * 规则引擎 — 域 B：派发治理
 * FR-B01: 角色-任务匹配校验
 * FR-B02: 自审禁止
 * FR-B03: 并发控制（在 ResourcePool.selectCandidate 中实现）
 * FR-B04: 规则热更新
 * FR-B05: 熔断机制（在 ResourcePool 中实现）
 */

import { v4 as uuid } from 'uuid';
import { EventBus } from '../event/event-bus.js';
import type {
  AgentSlot,
  AuditEvent,
  DispatchRule,
  LLMProvider,
  RoleTag,
  RuleAction,
  Task,
} from '../types/index.js';

export interface DispatchDecision {
  allowed: boolean;
  action: RuleAction;
  matchedRuleId?: string;
  reason: string;
}

export interface ClassifyResult {
  taskType: string;
  source: 'declared' | 'llm' | 'fallback';
}

export class RuleEngine {
  private rules: DispatchRule[] = [];
  private defaultPolicy: 'open' | 'closed' = 'open';
  private llmProvider?: LLMProvider;

  constructor(private eventBus: EventBus) {}

  setLLMProvider(provider: LLMProvider): void {
    this.llmProvider = provider;
  }

  setDefaultPolicy(policy: 'open' | 'closed'): void {
    this.defaultPolicy = policy;
  }

  /**
   * FR-B04 AC1: 添加规则（立即生效）
   */
  addRule(rule: DispatchRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
    this.emitAudit('config_changed', { action: 'rule_added', ruleId: rule.ruleId });
  }

  /**
   * FR-B04 AC1: 移除规则
   */
  removeRule(ruleId: string): boolean {
    const idx = this.rules.findIndex(r => r.ruleId === ruleId);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    this.emitAudit('config_changed', { action: 'rule_removed', ruleId });
    return true;
  }

  /**
   * FR-B04 AC3: 批量加载规则
   */
  loadRules(rules: DispatchRule[]): void {
    this.rules = [...rules].sort((a, b) => b.priority - a.priority);
  }

  getRules(): DispatchRule[] {
    return [...this.rules];
  }

  /**
   * FR-B01 AC5/AC6: 任务类型分类
   * 优先级：声明式标注 > LLM 语义分类 > 默认 fallback
   */
  async classifyTask(task: Task, declaredType?: string): Promise<ClassifyResult> {
    // 声明式标注
    if (declaredType) {
      return { taskType: declaredType, source: 'declared' };
    }

    // LLM 语义分类
    if (this.llmProvider) {
      const categories = ['spec', 'code', 'audit', 'ux', 'readme', 'data-ops', 'research', 'architecture'];
      const result = await this.llmProvider.classify(task.prompt, categories);
      return { taskType: result, source: 'llm' };
    }

    // Fallback
    return { taskType: 'unknown', source: 'fallback' };
  }

  /**
   * FR-B01/B02: 评估派发决策
   */
  async evaluate(
    task: Task,
    targetAgent: AgentSlot,
    context?: { parentAgentId?: string; declaredTaskType?: string },
  ): Promise<DispatchDecision> {
    // FR-B02 AC1/AC2: 自审禁止
    if (context?.parentAgentId && context.parentAgentId === targetAgent.agentId) {
      const taskType = await this.classifyTask(task, context.declaredTaskType);
      if (taskType.taskType === 'audit') {
        this.emitAudit('rule_blocked', {
          taskId: task.taskId,
          agentId: targetAgent.agentId,
          reason: 'self_audit_prohibited',
        });
        return {
          allowed: false,
          action: 'block',
          reason: 'Self-audit prohibited: producer and auditor are the same agent',
        };
      }
    }

    // FR-B01 AC5/AC6: 任务类型分类
    const classification = await this.classifyTask(task, context?.declaredTaskType);

    // FR-B01 AC7: data-ops 跳过角色校验
    if (classification.taskType === 'data-ops') {
      return { allowed: true, action: 'allow', reason: 'data-ops: role check skipped' };
    }

    // 逐条匹配规则（按优先级降序）
    for (const rule of this.rules) {
      const matched = this.matchRule(rule, task, targetAgent, classification.taskType);
      if (!matched) continue;

      this.emitAudit('rule_matched', {
        taskId: task.taskId,
        agentId: targetAgent.agentId,
        ruleId: rule.ruleId,
        action: rule.action,
      });

      if (rule.action === 'block') {
        this.emitAudit('rule_blocked', {
          taskId: task.taskId,
          agentId: targetAgent.agentId,
          ruleId: rule.ruleId,
        });
        return {
          allowed: false,
          action: 'block',
          matchedRuleId: rule.ruleId,
          reason: rule.description ?? `Blocked by rule ${rule.ruleId}`,
        };
      }

      if (rule.action === 'warn') {
        return {
          allowed: true,
          action: 'warn',
          matchedRuleId: rule.ruleId,
          reason: rule.description ?? `Warning from rule ${rule.ruleId}`,
        };
      }

      if (rule.action === 'allow') {
        return {
          allowed: true,
          action: 'allow',
          matchedRuleId: rule.ruleId,
          reason: rule.description ?? `Allowed by rule ${rule.ruleId}`,
        };
      }
    }

    // FR-B01 AC4: 无匹配规则时按默认策略
    if (this.defaultPolicy === 'closed') {
      return {
        allowed: false,
        action: 'block',
        reason: 'No matching rule and default policy is closed',
      };
    }

    return { allowed: true, action: 'allow', reason: 'No matching rule, default open policy' };
  }

  private matchRule(
    rule: DispatchRule,
    task: Task,
    agent: AgentSlot,
    taskType: string,
  ): boolean {
    const cond = rule.condition;

    if (cond.taskType) {
      const types = Array.isArray(cond.taskType) ? cond.taskType : [cond.taskType];
      if (!types.includes(taskType)) return false;
    }

    if (cond.agentId) {
      const ids = Array.isArray(cond.agentId) ? cond.agentId : [cond.agentId];
      if (!ids.includes(agent.agentId)) return false;
    }

    if (cond.promptPattern) {
      const regex = new RegExp(cond.promptPattern, 'i');
      if (!regex.test(task.prompt)) return false;
    }

    if (cond.roleRequired) {
      const required = Array.isArray(cond.roleRequired) ? cond.roleRequired : [cond.roleRequired];
      const hasRole = required.some((r: RoleTag) => agent.roles.includes(r));
      // If agent has the required role, this blocking rule doesn't apply
      if (hasRole) return false;
    }

    if (cond.custom) {
      if (!cond.custom(task, agent)) return false;
    }

    return true;
  }

  private emitAudit(type: AuditEvent['type'], details: Record<string, unknown>): void {
    const event: AuditEvent = {
      eventId: uuid(),
      type,
      timestamp: Date.now(),
      taskId: details.taskId as string | undefined,
      agentId: details.agentId as string | undefined,
      details,
    };
    this.eventBus.emit('audit', event).catch(() => {});
  }
}
