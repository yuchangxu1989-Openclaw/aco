/**
 * FR-B01 测试：角色-任务匹配校验
 * FR-B02 测试：自审禁止
 * FR-B04 测试：规则热更新
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RuleEngine } from '../src/dispatch/rule-engine.js';
import { EventBus } from '../src/event/event-bus.js';
import type { AgentSlot, DispatchRule, LLMProvider, Task } from '../src/types/index.js';

function makeTask(overrides?: Partial<Task>): Task {
  return {
    taskId: 'task-1',
    label: 'test-task',
    prompt: 'Write unit tests',
    timeoutSeconds: 600,
    priority: 50,
    status: 'dispatching',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    retryCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function makeAgent(overrides?: Partial<AgentSlot>): AgentSlot {
  return {
    agentId: 'dev-01',
    tier: 'T3',
    runtimeType: 'subagent',
    status: 'idle',
    roles: ['coder'],
    maxConcurrency: 1,
    activeTasks: 0,
    totalCompleted: 0,
    totalFailed: 0,
    consecutiveFailures: 0,
    ...overrides,
  };
}

const mockLLM: LLMProvider = {
  async classify(prompt: string, categories: string[]): Promise<string> {
    if (prompt.toLowerCase().includes('audit')) return 'audit';
    if (prompt.toLowerCase().includes('code') || prompt.toLowerCase().includes('implement')) return 'code';
    if (prompt.toLowerCase().includes('spec')) return 'spec';
    return categories[0];
  },
};

describe('RuleEngine', () => {
  let engine: RuleEngine;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    engine = new RuleEngine(eventBus);
    engine.setLLMProvider(mockLLM);
  });

  describe('FR-B01: 角色-任务匹配校验', () => {
    it('AC1/AC2: 角色不匹配时阻断', async () => {
      const rule: DispatchRule = {
        ruleId: 'audit-role-check',
        priority: 100,
        condition: { taskType: 'audit', roleRequired: 'auditor' },
        action: 'block',
        description: 'Audit tasks require auditor role',
      };
      engine.addRule(rule);

      const task = makeTask({ prompt: 'Audit the code' });
      const agent = makeAgent({ roles: ['coder'] });

      const decision = await engine.evaluate(task, agent, { declaredTaskType: 'audit' });
      expect(decision.allowed).toBe(false);
      expect(decision.action).toBe('block');
    });

    it('AC3: warn 动作放行但记录', async () => {
      const rule: DispatchRule = {
        ruleId: 'warn-rule',
        priority: 100,
        condition: { taskType: 'code', roleRequired: 'architect' },
        action: 'warn',
        description: 'Code tasks prefer coder role',
      };
      engine.addRule(rule);

      const task = makeTask({ prompt: 'Implement feature' });
      const agent = makeAgent({ roles: ['coder'] });

      const decision = await engine.evaluate(task, agent, { declaredTaskType: 'code' });
      // roleRequired is architect but agent is coder, rule doesn't match
      expect(decision.allowed).toBe(true);
    });

    it('AC4: 无匹配规则时默认放行（open 策略）', async () => {
      engine.setDefaultPolicy('open');
      const task = makeTask();
      const agent = makeAgent();

      const decision = await engine.evaluate(task, agent);
      expect(decision.allowed).toBe(true);
    });

    it('AC4: 无匹配规则时默认阻断（closed 策略）', async () => {
      engine.setDefaultPolicy('closed');
      const task = makeTask();
      const agent = makeAgent();

      const decision = await engine.evaluate(task, agent);
      expect(decision.allowed).toBe(false);
    });

    it('AC5/AC6: LLM 语义分类', async () => {
      const result = await engine.classifyTask(makeTask({ prompt: 'Audit the implementation' }));
      expect(result.taskType).toBe('audit');
      expect(result.source).toBe('llm');
    });

    it('AC6: 声明式标注优先于 LLM', async () => {
      const result = await engine.classifyTask(
        makeTask({ prompt: 'Audit the code' }),
        'code', // 声明为 code
      );
      expect(result.taskType).toBe('code');
      expect(result.source).toBe('declared');
    });

    it('AC7: data-ops 跳过角色校验', async () => {
      const rule: DispatchRule = {
        ruleId: 'strict-role',
        priority: 100,
        condition: { roleRequired: 'auditor' },
        action: 'block',
      };
      engine.addRule(rule);

      const task = makeTask();
      const agent = makeAgent({ roles: ['coder'] });

      const decision = await engine.evaluate(task, agent, { declaredTaskType: 'data-ops' });
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toContain('data-ops');
    });
  });

  describe('FR-B02: 自审禁止', () => {
    it('AC1/AC2: 同一 Agent 不能审计自己的产出', async () => {
      const task = makeTask({ prompt: 'Audit the code changes' });
      const agent = makeAgent({ agentId: 'cc' });

      const decision = await engine.evaluate(task, agent, {
        parentAgentId: 'cc',
        declaredTaskType: 'audit',
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('Self-audit');
    });

    it('AC4: 不同 Agent 可以审计', async () => {
      const task = makeTask({ prompt: 'Audit the code changes' });
      const agent = makeAgent({ agentId: 'audit-01', roles: ['auditor'] });

      const decision = await engine.evaluate(task, agent, {
        parentAgentId: 'cc',
        declaredTaskType: 'audit',
      });
      expect(decision.allowed).toBe(true);
    });
  });

  describe('FR-B04: 规则热更新', () => {
    it('AC1: 添加规则立即生效', async () => {
      const task = makeTask({ prompt: 'Do something dangerous' });
      const agent = makeAgent();

      // 无规则时放行
      let decision = await engine.evaluate(task, agent);
      expect(decision.allowed).toBe(true);

      // 添加阻断规则
      engine.addRule({
        ruleId: 'block-dangerous',
        priority: 100,
        condition: { promptPattern: 'dangerous' },
        action: 'block',
      });

      decision = await engine.evaluate(task, agent);
      expect(decision.allowed).toBe(false);
    });

    it('AC1: 移除规则', () => {
      engine.addRule({
        ruleId: 'test-rule',
        priority: 50,
        condition: {},
        action: 'block',
      });
      expect(engine.getRules()).toHaveLength(1);

      engine.removeRule('test-rule');
      expect(engine.getRules()).toHaveLength(0);
    });

    it('AC3: 批量加载规则', () => {
      engine.loadRules([
        { ruleId: 'r1', priority: 10, condition: {}, action: 'allow' },
        { ruleId: 'r2', priority: 20, condition: {}, action: 'block' },
      ]);
      const rules = engine.getRules();
      expect(rules).toHaveLength(2);
      // 按优先级降序
      expect(rules[0].ruleId).toBe('r2');
    });

    it('AC4: 规则冲突按优先级排序', async () => {
      engine.addRule({
        ruleId: 'low-priority-allow',
        priority: 10,
        condition: { promptPattern: 'test' },
        action: 'allow',
      });
      engine.addRule({
        ruleId: 'high-priority-block',
        priority: 100,
        condition: { promptPattern: 'test' },
        action: 'block',
      });

      const task = makeTask({ prompt: 'test something' });
      const agent = makeAgent();

      const decision = await engine.evaluate(task, agent);
      expect(decision.allowed).toBe(false);
      expect(decision.matchedRuleId).toBe('high-priority-block');
    });
  });
});
