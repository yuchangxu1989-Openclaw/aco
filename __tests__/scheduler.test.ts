/**
 * Scheduler 集成测试
 * 验证 TaskQueue + ResourcePool + RuleEngine 协同工作
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Scheduler } from '../src/scheduler.js';
import type { HostAdapter, HostEvent } from '../src/types/index.js';

const mockAdapter: HostAdapter = {
  async spawnTask() { return 'session-1'; },
  async killTask() {},
  async steerTask() {},
  async getTaskStatus() { return { status: 'running', outputTokens: 5000 }; },
  async getAgentStatus() { return { active: true }; },
  subscribeEvents() {},
};

describe('Scheduler', () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    scheduler = new Scheduler({ defaultTimeout: 600, minTimeout: 300 });
    scheduler.setHostAdapter(mockAdapter);
    scheduler.setLLMProvider({
      async classify(prompt, categories) {
        if (prompt.includes('audit')) return 'audit';
        return 'code';
      },
    });

    // 注册 Agent 池
    scheduler.resourcePool.register({
      agentId: 'cc',
      tier: 'T1',
      runtimeType: 'subagent',
      roles: ['coder'],
      maxConcurrency: 2,
    });
    scheduler.resourcePool.register({
      agentId: 'dev-01',
      tier: 'T3',
      runtimeType: 'subagent',
      roles: ['coder'],
    });
    scheduler.resourcePool.register({
      agentId: 'audit-01',
      tier: 'T2',
      runtimeType: 'subagent',
      roles: ['auditor'],
    });
  });

  it('创建任务后自动调度到可用 Agent', async () => {
    const task = await scheduler.createTask({
      label: 'implement-feature',
      prompt: 'Implement the login feature',
      targetTier: 'T3',
    });

    // 等待异步调度
    await new Promise(r => setTimeout(r, 50));

    const updated = scheduler.taskQueue.get(task.taskId);
    expect(updated?.status).toBe('running');
    expect(updated?.agentId).toBe('dev-01');
  });

  it('任务完成后释放 Agent 资源', async () => {
    const task = await scheduler.createTask({
      label: 'test',
      prompt: 'code something',
      targetTier: 'T3',
    });

    await new Promise(r => setTimeout(r, 50));

    await scheduler.handleTaskComplete(task.taskId, true, 5000);

    const slot = scheduler.resourcePool.get('dev-01');
    expect(slot?.activeTasks).toBe(0);
    expect(slot?.status).toBe('idle');
    expect(slot?.totalCompleted).toBe(1);
  });

  it('实质成功校验失败时标记为 failed', async () => {
    const task = await scheduler.createTask({
      label: 'test',
      prompt: 'code something',
      targetTier: 'T3',
    });

    await new Promise(r => setTimeout(r, 50));

    // output_tokens 低于阈值
    await scheduler.handleTaskComplete(task.taskId, true, 100);

    const updated = scheduler.taskQueue.get(task.taskId);
    expect(updated?.status).toBe('retrying');
    expect(updated?.failureReason).toBe('substantive_failure');
  });

  it('失败后自动梯队升级重试', async () => {
    const task = await scheduler.createTask({
      label: 'test',
      prompt: 'code something',
      targetTier: 'T4',
    });

    // 手动推进状态（因为 T4 没有注册 Agent，会回退到 queued）
    // 注册一个 T4 Agent
    scheduler.resourcePool.register({
      agentId: 'dev-04',
      tier: 'T4',
      runtimeType: 'subagent',
      roles: ['coder'],
    });

    await scheduler.tryDispatch();
    await new Promise(r => setTimeout(r, 50));

    // 模拟失败
    await scheduler.handleTaskComplete(task.taskId, false);

    const updated = scheduler.taskQueue.get(task.taskId);
    expect(updated?.targetTier).toBe('T3');
    expect(updated?.status).toBe('retrying');
  });

  it('取消任务释放 Agent', async () => {
    const task = await scheduler.createTask({
      label: 'test',
      prompt: 'code something',
      targetTier: 'T3',
    });

    await new Promise(r => setTimeout(r, 50));
    expect(scheduler.taskQueue.get(task.taskId)?.status).toBe('running');

    scheduler.cancelTask(task.taskId);

    const updated = scheduler.taskQueue.get(task.taskId);
    expect(updated?.status).toBe('cancelled');

    const slot = scheduler.resourcePool.get('dev-01');
    expect(slot?.activeTasks).toBe(0);
  });

  it('熔断后不再派发到该 Agent', async () => {
    // 让 dev-01 连续失败 3 次
    for (let i = 0; i < 3; i++) {
      const task = await scheduler.createTask({
        label: `fail-${i}`,
        prompt: 'code something',
        targetTier: 'T3',
      });
      await new Promise(r => setTimeout(r, 50));
      await scheduler.handleTaskComplete(task.taskId, false, 5000);
    }

    const slot = scheduler.resourcePool.get('dev-01');
    expect(slot?.status).toBe('offline');

    // 新任务不会派到 dev-01
    const newTask = await scheduler.createTask({
      label: 'after-break',
      prompt: 'code something',
      targetTier: 'T3',
    });
    await new Promise(r => setTimeout(r, 50));

    const updated = scheduler.taskQueue.get(newTask.taskId);
    // 应该升级到 T2 或 T1
    if (updated?.status === 'running') {
      expect(updated.agentId).not.toBe('dev-01');
    }
  });
});
