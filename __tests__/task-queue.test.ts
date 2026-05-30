/**
 * FR-A01 测试：任务创建与入队
 * FR-A02 测试：任务状态流转
 * FR-A03 测试：超时保护
 * FR-A04 测试：实质成功校验
 * FR-A05 测试：任务取消
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TaskQueue } from '../src/task/task-queue.js';
import { EventBus } from '../src/event/event-bus.js';

describe('TaskQueue', () => {
  let queue: TaskQueue;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    queue = new TaskQueue(eventBus);
  });

  describe('FR-A01: 任务创建与入队', () => {
    it('AC1: 创建任务需要 label、prompt、timeout', () => {
      const task = queue.create({
        label: 'test-task',
        prompt: 'Do something',
        timeoutSeconds: 600,
      });

      expect(task.taskId).toBeDefined();
      expect(task.label).toBe('test-task');
      expect(task.prompt).toBe('Do something');
      expect(task.timeoutSeconds).toBe(600);
    });

    it('AC1: agentId 和 priority 可选', () => {
      const task = queue.create({
        label: 'test',
        prompt: 'test',
      });
      expect(task.agentId).toBeUndefined();
      expect(task.priority).toBe(50); // 默认值
    });

    it('AC2: 创建后立即进入 queued 状态', () => {
      const task = queue.create({ label: 'test', prompt: 'test' });
      expect(task.status).toBe('queued');
    });

    it('AC2: 创建后触发队列消费事件', async () => {
      let triggered = false;
      eventBus.on('queue:task_added', () => { triggered = true; });
      queue.create({ label: 'test', prompt: 'test' });
      await new Promise(r => setTimeout(r, 10));
      expect(triggered).toBe(true);
    });

    it('FR-A03 AC5: 超时低于下限被拒绝', () => {
      expect(() => queue.create({
        label: 'test',
        prompt: 'test',
        timeoutSeconds: 100,
      })).toThrow(/below minimum/);
    });
  });

  describe('FR-A02: 任务状态流转', () => {
    it('AC1: 状态变更触发审计事件', async () => {
      const events: unknown[] = [];
      eventBus.on('audit', (e) => events.push(e));

      const task = queue.create({ label: 'test', prompt: 'test' });
      queue.transition(task.taskId, 'dispatching');

      await new Promise(r => setTimeout(r, 10));
      expect(events.length).toBeGreaterThan(0);
    });

    it('AC2: 非法状态转换被拒绝', () => {
      const task = queue.create({ label: 'test', prompt: 'test' });
      expect(() => queue.transition(task.taskId, 'succeeded')).toThrow(/Invalid transition/);
    });

    it('AC3: 终态不可逆', () => {
      const task = queue.create({ label: 'test', prompt: 'test' });
      queue.transition(task.taskId, 'dispatching');
      queue.transition(task.taskId, 'running');
      queue.transition(task.taskId, 'succeeded');

      expect(() => queue.transition(task.taskId, 'running')).toThrow(/terminal state/);
    });

    it('合法转换链: queued -> dispatching -> running -> succeeded', () => {
      const task = queue.create({ label: 'test', prompt: 'test' });
      queue.transition(task.taskId, 'dispatching');
      queue.transition(task.taskId, 'running');
      queue.transition(task.taskId, 'succeeded');
      expect(task.status).toBe('succeeded');
      expect(task.completedAt).toBeDefined();
    });

    it('合法转换链: queued -> dispatching -> running -> failed -> retrying', () => {
      const task = queue.create({ label: 'test', prompt: 'test' });
      queue.transition(task.taskId, 'dispatching');
      queue.transition(task.taskId, 'running');
      queue.transition(task.taskId, 'failed', 'timeout');
      queue.transition(task.taskId, 'retrying');
      expect(task.status).toBe('retrying');
      expect(task.retryCount).toBe(1);
    });
  });

  describe('FR-A04: 实质成功校验', () => {
    it('AC1: output_tokens 低于阈值返回 false', () => {
      const task = queue.create({ label: 'test', prompt: 'test' });
      expect(queue.validateSubstantiveSuccess(task.taskId, 100)).toBe(false);
    });

    it('AC1: output_tokens 高于阈值返回 true', () => {
      const task = queue.create({ label: 'test', prompt: 'test' });
      expect(queue.validateSubstantiveSuccess(task.taskId, 5000)).toBe(true);
    });

    it('AC2: 指定产出文件但文件不存在返回 false', () => {
      const task = queue.create({
        label: 'test',
        prompt: 'test',
        outputFiles: ['/tmp/output.md'],
      });
      expect(queue.validateSubstantiveSuccess(task.taskId, 5000, false)).toBe(false);
    });

    it('AC2: 指定产出文件且文件存在返回 true', () => {
      const task = queue.create({
        label: 'test',
        prompt: 'test',
        outputFiles: ['/tmp/output.md'],
      });
      expect(queue.validateSubstantiveSuccess(task.taskId, 5000, true)).toBe(true);
    });
  });

  describe('FR-A05: 任务取消', () => {
    it('AC1: 取消任务转为 cancelled', () => {
      const task = queue.create({ label: 'test', prompt: 'test' });
      const cancelled = queue.cancel(task.taskId);
      expect(cancelled.status).toBe('cancelled');
    });

    it('AC3: 批量取消按 label 筛选', () => {
      queue.create({ label: 'batch-a-1', prompt: 'test' });
      queue.create({ label: 'batch-a-2', prompt: 'test' });
      queue.create({ label: 'batch-b-1', prompt: 'test' });

      const cancelled = queue.cancelByFilter({ labelPattern: 'batch-a' });
      expect(cancelled).toHaveLength(2);
    });

    it('AC3: 批量取消按 agentId 筛选', () => {
      const t1 = queue.create({ label: 'test1', prompt: 'test', agentId: 'cc' });
      queue.create({ label: 'test2', prompt: 'test', agentId: 'dev-01' });

      queue.transition(t1.taskId, 'dispatching');
      queue.transition(t1.taskId, 'running');

      const cancelled = queue.cancelByFilter({ agentId: 'cc' });
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0].agentId).toBe('cc');
    });
  });

  describe('队列排序', () => {
    it('按 priority 降序 + 入队时间升序', () => {
      queue.create({ label: 'low', prompt: 'test', priority: 30 });
      queue.create({ label: 'high', prompt: 'test', priority: 80 });
      queue.create({ label: 'medium', prompt: 'test', priority: 50 });

      const pending = queue.getPendingTasks();
      expect(pending[0].label).toBe('high');
      expect(pending[1].label).toBe('medium');
      expect(pending[2].label).toBe('low');
    });

    it('同优先级按入队时间 FIFO', () => {
      queue.create({ label: 'first', prompt: 'test', priority: 50 });
      queue.create({ label: 'second', prompt: 'test', priority: 50 });

      const pending = queue.getPendingTasks();
      expect(pending[0].label).toBe('first');
      expect(pending[1].label).toBe('second');
    });
  });
});
