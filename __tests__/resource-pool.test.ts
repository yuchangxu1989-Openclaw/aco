/**
 * FR-C01 测试：Agent 注册与发现
 * FR-C02 测试：梯队路由
 * FR-C03 测试：失败梯队升级
 * FR-C04 测试：资源池状态视图
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ResourcePool } from '../src/pool/resource-pool.js';
import { EventBus } from '../src/event/event-bus.js';

describe('ResourcePool', () => {
  let pool: ResourcePool;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    pool = new ResourcePool(eventBus);
  });

  describe('FR-C01: Agent 注册与发现', () => {
    it('AC2/AC3: 注册 Agent 到资源池', () => {
      const slot = pool.register({
        agentId: 'cc',
        tier: 'T1',
        runtimeType: 'subagent',
        roles: ['coder'],
        maxConcurrency: 2,
      });

      expect(slot.agentId).toBe('cc');
      expect(slot.tier).toBe('T1');
      expect(slot.runtimeType).toBe('subagent');
      expect(slot.roles).toEqual(['coder']);
      expect(slot.maxConcurrency).toBe(2);
      expect(slot.status).toBe('idle');
      expect(slot.activeTasks).toBe(0);
    });

    it('AC3: 默认 maxConcurrency 为 1', () => {
      const slot = pool.register({
        agentId: 'audit-01',
        tier: 'T2',
        runtimeType: 'subagent',
        roles: ['auditor'],
      });
      expect(slot.maxConcurrency).toBe(1);
    });

    it('AC4: 移除 Agent', () => {
      pool.register({ agentId: 'dev-01', tier: 'T3', runtimeType: 'subagent', roles: ['coder'] });
      expect(pool.unregister('dev-01')).toBe(true);
      expect(pool.get('dev-01')).toBeUndefined();
    });
  });

  describe('FR-C02: 梯队路由', () => {
    beforeEach(() => {
      pool.register({ agentId: 'cc', tier: 'T1', runtimeType: 'subagent', roles: ['coder'] });
      pool.register({ agentId: 'dev-01', tier: 'T3', runtimeType: 'subagent', roles: ['coder'] });
      pool.register({ agentId: 'dev-02', tier: 'T3', runtimeType: 'subagent', roles: ['coder'] });
      pool.register({ agentId: 'audit-01', tier: 'T2', runtimeType: 'subagent', roles: ['auditor'] });
    });

    it('AC2: 同 Tier 内按最少活跃任务优先', () => {
      pool.markBusy('dev-01');
      const candidate = pool.selectCandidate({ tier: 'T3' });
      expect(candidate?.agentId).toBe('dev-02');
    });

    it('AC3: 指定 Tier 无可用时自动升级', () => {
      pool.markBusy('dev-01');
      pool.markBusy('dev-02');
      const candidate = pool.selectCandidate({ tier: 'T3' });
      // T3 都满了，升级到 T2 (auditor) 或 T1
      expect(candidate).toBeDefined();
      expect(['T2', 'T1']).toContain(candidate?.tier);
    });

    it('按 role 筛选候选', () => {
      const candidate = pool.selectCandidate({ role: 'auditor' });
      expect(candidate?.agentId).toBe('audit-01');
    });

    it('排除指定 Agent', () => {
      const candidate = pool.selectCandidate({ tier: 'T1', excludeAgentId: 'cc' });
      // T1 只有 cc，排除后升级到 T2
      expect(candidate?.agentId).not.toBe('cc');
    });
  });

  describe('FR-C03: 失败梯队升级', () => {
    it('AC1: 获取升级后的 Tier', () => {
      expect(pool.getUpgradedTier('T4')).toBe('T3');
      expect(pool.getUpgradedTier('T3')).toBe('T2');
      expect(pool.getUpgradedTier('T2')).toBe('T1');
    });

    it('AC2: T1 无法再升级', () => {
      expect(pool.getUpgradedTier('T1')).toBeUndefined();
    });
  });

  describe('FR-C04: 资源池状态视图', () => {
    beforeEach(() => {
      pool.register({ agentId: 'cc', tier: 'T1', runtimeType: 'subagent', roles: ['coder'] });
      pool.register({ agentId: 'audit-01', tier: 'T2', runtimeType: 'subagent', roles: ['auditor'] });
    });

    it('AC1: 获取所有 Agent 状态', () => {
      const all = pool.getAll();
      expect(all).toHaveLength(2);
    });

    it('AC2: 按 Tier 筛选', () => {
      const t1 = pool.filter({ tier: 'T1' });
      expect(t1).toHaveLength(1);
      expect(t1[0].agentId).toBe('cc');
    });

    it('AC2: 按 Role 筛选', () => {
      const auditors = pool.filter({ role: 'auditor' });
      expect(auditors).toHaveLength(1);
      expect(auditors[0].agentId).toBe('audit-01');
    });

    it('AC2: 按 Status 筛选', () => {
      pool.markBusy('cc');
      const busy = pool.filter({ status: 'busy' });
      expect(busy).toHaveLength(1);
      expect(busy[0].agentId).toBe('cc');
    });
  });

  describe('FR-B05: 熔断机制', () => {
    it('AC1: 连续失败达阈值触发熔断', () => {
      pool.register({ agentId: 'dev-01', tier: 'T3', runtimeType: 'subagent', roles: ['coder'] });
      pool.markBusy('dev-01');
      pool.markTaskCompleted('dev-01', false);
      pool.markBusy('dev-01');
      pool.markTaskCompleted('dev-01', false);
      pool.markBusy('dev-01');
      pool.markTaskCompleted('dev-01', false);

      expect(pool.checkCircuitBreak('dev-01', 3)).toBe(true);
    });

    it('AC3: 恢复 Agent', () => {
      pool.register({ agentId: 'dev-01', tier: 'T3', runtimeType: 'subagent', roles: ['coder'] });
      pool.triggerCircuitBreak('dev-01');
      expect(pool.get('dev-01')?.status).toBe('offline');

      pool.recover('dev-01');
      expect(pool.get('dev-01')?.status).toBe('idle');
      expect(pool.get('dev-01')?.consecutiveFailures).toBe(0);
    });
  });

  describe('FR-B03: 并发控制', () => {
    it('AC1/AC2: 跳过已达并发上限的 Agent', () => {
      pool.register({ agentId: 'dev-01', tier: 'T3', runtimeType: 'subagent', roles: ['coder'], maxConcurrency: 1 });
      pool.register({ agentId: 'dev-02', tier: 'T3', runtimeType: 'subagent', roles: ['coder'], maxConcurrency: 1 });

      pool.markBusy('dev-01');
      const candidate = pool.selectCandidate({ tier: 'T3' });
      expect(candidate?.agentId).toBe('dev-02');
    });

    it('AC5: ACP 全局并发上限', () => {
      pool.register({ agentId: 'acp-01', tier: 'T2', runtimeType: 'acp', roles: ['coder'], maxConcurrency: 5 });
      pool.register({ agentId: 'acp-02', tier: 'T2', runtimeType: 'acp', roles: ['coder'], maxConcurrency: 5 });

      // 模拟 ACP 全局达到上限
      for (let i = 0; i < 4; i++) pool.markBusy('acp-01');
      for (let i = 0; i < 4; i++) pool.markBusy('acp-02');

      const candidate = pool.selectCandidate({
        tier: 'T2',
        runtimeType: 'acp',
        maxGlobalAcpConcurrency: 8,
      });
      expect(candidate).toBeUndefined();
    });
  });
});
