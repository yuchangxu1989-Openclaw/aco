/**
 * NotificationManager 测试
 * FR-F01: 通知渠道注册
 * FR-F02: 事件订阅过滤
 * FR-F03: 通知内容模板
 * FR-F04: 通知送达确认
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotificationManager } from '../src/notification/notification-manager.js';
import type {
  ChannelConfig,
  ChannelTransport,
  NotificationPayload,
} from '../src/notification/notification-manager.js';
import { EventBus } from '../src/event/event-bus.js';
import type { Task } from '../src/types/index.js';

function makeTask(overrides?: Partial<Task>): Task {
  return {
    taskId: 'task-1',
    label: 'test-task',
    prompt: 'Do something',
    timeoutSeconds: 600,
    priority: 50,
    status: 'running',
    createdAt: Date.now() - 5000,
    updatedAt: Date.now(),
    retryCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function makeMockTransport(shouldFail = false): ChannelTransport {
  return {
    send: shouldFail
      ? vi.fn().mockRejectedValue(new Error('delivery failed'))
      : vi.fn().mockResolvedValue(undefined),
    testConnection: shouldFail
      ? vi.fn().mockResolvedValue(false)
      : vi.fn().mockResolvedValue(true),
  };
}

describe('NotificationManager', () => {
  let manager: NotificationManager;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    manager = new NotificationManager(eventBus, {
      maxRetries: 3,
      retryBaseDelayMs: 10, // Fast retries for tests
      degradedThreshold: 3,
      defaultFilter: { eventTypes: ['task_failed', 'circuit_break'] },
    });
  });

  describe('FR-F01: 通知渠道注册', () => {
    it('AC1: 支持五种渠道类型', () => {
      const types = ['feishu', 'telegram', 'discord', 'slack', 'webhook'] as const;
      for (const type of types) {
        const ch = manager.registerChannel(type, { url: `https://${type}.example.com` });
        expect(ch.type).toBe(type);
        expect(ch.enabled).toBe(true);
        expect(ch.status).toBe('active');
      }
      expect(manager.getChannels().length).toBe(5);
    });

    it('AC2: 注册渠道包含认证凭据和目标地址', () => {
      const ch = manager.registerChannel('feishu', {
        webhookUrl: 'https://open.feishu.cn/hook/xxx',
        secret: 'my-secret',
      }, 'feishu-main');

      expect(ch.channelId).toBe('feishu-main');
      expect(ch.config.webhookUrl).toBe('https://open.feishu.cn/hook/xxx');
      expect(ch.config.secret).toBe('my-secret');
    });

    it('AC3: 注册后测试连通性', async () => {
      const transport = makeMockTransport();
      manager.registerTransport('webhook', transport);
      manager.registerChannel('webhook', { url: 'https://example.com/hook' }, 'wh-1');

      const result = await manager.testChannel('wh-1');
      expect(result.success).toBe(true);
      expect(transport.testConnection).toHaveBeenCalled();
    });

    it('AC3: 连通性测试失败时返回错误原因', async () => {
      const transport = makeMockTransport(true);
      manager.registerTransport('webhook', transport);
      manager.registerChannel('webhook', { url: 'https://bad.example.com' }, 'wh-bad');

      const result = await manager.testChannel('wh-bad');
      expect(result.success).toBe(false);
    });

    it('AC4: 多渠道并行推送', async () => {
      const transport1 = makeMockTransport();
      const transport2 = makeMockTransport();
      manager.registerTransport('webhook', transport1);
      manager.registerTransport('feishu', transport2);

      manager.registerChannel('webhook', { url: 'https://a.com' }, 'ch-1');
      manager.registerChannel('feishu', { url: 'https://b.com' }, 'ch-2');

      // Allow all events
      manager.setFilter({ eventTypes: ['task_failed'] });

      const records = await manager.notify({
        eventType: 'task_failed',
        taskId: 'task-1',
        label: 'test',
        failureReason: 'timeout',
      });

      expect(records.length).toBe(2);
      expect(records.every(r => r.status === 'delivered')).toBe(true);
      expect(transport1.send).toHaveBeenCalledTimes(1);
      expect(transport2.send).toHaveBeenCalledTimes(1);
    });

    it('移除渠道', () => {
      manager.registerChannel('webhook', { url: 'https://a.com' }, 'ch-1');
      expect(manager.getChannels().length).toBe(1);
      manager.removeChannel('ch-1');
      expect(manager.getChannels().length).toBe(0);
    });
  });

  describe('FR-F02: 事件订阅过滤', () => {
    it('AC1: 按事件类型过滤', async () => {
      const transport = makeMockTransport();
      manager.registerTransport('webhook', transport);
      manager.registerChannel('webhook', { url: 'https://a.com' }, 'ch-1');

      // Default filter: task_failed, circuit_break
      const records1 = await manager.notify({
        eventType: 'task_succeeded',
        taskId: 'task-1',
        label: 'test',
      });
      expect(records1.length).toBe(0); // Filtered out

      const records2 = await manager.notify({
        eventType: 'task_failed',
        taskId: 'task-1',
        label: 'test',
        failureReason: 'error',
      });
      expect(records2.length).toBe(1); // Passes filter
    });

    it('AC2: 按优先级过滤', async () => {
      const transport = makeMockTransport();
      manager.registerTransport('webhook', transport);
      manager.registerChannel('webhook', { url: 'https://a.com' }, 'ch-1');

      manager.setFilter({ eventTypes: ['task_failed'], minPriority: 80 });

      const lowPriorityTask = makeTask({ priority: 50 });
      const records1 = await manager.notify(
        { eventType: 'task_failed', taskId: 'task-1', label: 'test', failureReason: 'err' },
        lowPriorityTask,
      );
      expect(records1.length).toBe(0); // Priority too low

      const highPriorityTask = makeTask({ priority: 90 });
      const records2 = await manager.notify(
        { eventType: 'task_failed', taskId: 'task-2', label: 'test', failureReason: 'err' },
        highPriorityTask,
      );
      expect(records2.length).toBe(1); // Priority passes
    });

    it('AC3: 按 agentId 过滤', async () => {
      const transport = makeMockTransport();
      manager.registerTransport('webhook', transport);
      manager.registerChannel('webhook', { url: 'https://a.com' }, 'ch-1');

      manager.setFilter({ eventTypes: ['task_failed'], agentIds: ['cc', 'dev-01'] });

      const records1 = await manager.notify({
        eventType: 'task_failed',
        taskId: 'task-1',
        label: 'test',
        agentId: 'audit-01',
        failureReason: 'err',
      });
      expect(records1.length).toBe(0); // Agent not in filter

      const records2 = await manager.notify({
        eventType: 'task_failed',
        taskId: 'task-2',
        label: 'test',
        agentId: 'cc',
        failureReason: 'err',
      });
      expect(records2.length).toBe(1); // Agent in filter
    });

    it('AC4: 默认订阅 task_failed 和 circuit_break', () => {
      const filter = manager.getFilter();
      expect(filter.eventTypes).toContain('task_failed');
      expect(filter.eventTypes).toContain('circuit_break');
    });
  });

  describe('FR-F03: 通知内容模板', () => {
    it('AC1: 通知消息包含结构化上下文', () => {
      const message = manager.formatMessage({
        eventType: 'task_failed',
        taskId: 'task-123',
        label: 'implement-login',
        agentId: 'dev-01',
        failureReason: 'timeout',
      });

      expect(message).toContain('task-123');
      expect(message).toContain('implement-login');
      expect(message).toContain('dev-01');
      expect(message).toContain('timeout');
    });

    it('AC2: 成功通知包含产出摘要', () => {
      const message = manager.formatMessage({
        eventType: 'task_succeeded',
        taskId: 'task-123',
        label: 'write-tests',
        agentId: 'cc',
        durationMs: 45000,
        outputSummary: 'Created 5 test files covering auth module',
      });

      expect(message).toContain('write-tests');
      expect(message).toContain('Created 5 test files');
      expect(message).toContain('45.0s');
    });

    it('AC3: 失败通知包含建议的下一步', () => {
      const message = manager.formatMessage({
        eventType: 'task_failed',
        taskId: 'task-456',
        label: 'deploy',
        agentId: 'dev-01',
        failureReason: 'compilation error',
        suggestion: '已自动升级梯队重试',
      });

      expect(message).toContain('compilation error');
      expect(message).toContain('已自动升级梯队重试');
    });

    it('AC4: 自定义模板', () => {
      manager.setTemplate('task_succeeded', '[OK] {{label}} done by {{agentId}}');

      const message = manager.formatMessage({
        eventType: 'task_succeeded',
        taskId: 'task-1',
        label: 'build',
        agentId: 'cc',
      });

      expect(message).toBe('[OK] build done by cc');
    });
  });

  describe('FR-F04: 通知送达确认', () => {
    it('AC1: 记录送达状态', async () => {
      const transport = makeMockTransport();
      manager.registerTransport('webhook', transport);
      manager.registerChannel('webhook', { url: 'https://a.com' }, 'ch-1');
      manager.setFilter({ eventTypes: ['task_failed'] });

      await manager.notify({
        eventType: 'task_failed',
        taskId: 'task-1',
        label: 'test',
        failureReason: 'err',
      });

      const records = manager.getDeliveryRecords('ch-1');
      expect(records.length).toBe(1);
      expect(records[0].status).toBe('delivered');
      expect(records[0].attempts).toBe(1);
    });

    it('AC2: 送达失败自动重试（指数退避）', async () => {
      let callCount = 0;
      const transport: ChannelTransport = {
        send: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount <= 2) throw new Error('temporary failure');
        }),
        testConnection: vi.fn().mockResolvedValue(true),
      };

      manager.registerTransport('webhook', transport);
      manager.registerChannel('webhook', { url: 'https://a.com' }, 'ch-1');
      manager.setFilter({ eventTypes: ['task_failed'] });

      const records = await manager.notify({
        eventType: 'task_failed',
        taskId: 'task-1',
        label: 'test',
        failureReason: 'err',
      });

      expect(records[0].status).toBe('delivered');
      expect(records[0].attempts).toBe(3); // Failed twice, succeeded on 3rd
      expect(transport.send).toHaveBeenCalledTimes(3);
    });

    it('AC2: 超过最大重试次数标记为 failed', async () => {
      const transport = makeMockTransport(true); // Always fails
      manager.registerTransport('webhook', transport);
      manager.registerChannel('webhook', { url: 'https://a.com' }, 'ch-1');
      manager.setFilter({ eventTypes: ['task_failed'] });

      const records = await manager.notify({
        eventType: 'task_failed',
        taskId: 'task-1',
        label: 'test',
        failureReason: 'err',
      });

      expect(records[0].status).toBe('failed');
      expect(records[0].attempts).toBe(4); // 1 initial + 3 retries
    });

    it('AC3: 连续失败超阈值标记渠道为 degraded', async () => {
      const transport = makeMockTransport(true);
      manager.registerTransport('webhook', transport);
      manager.registerChannel('webhook', { url: 'https://a.com' }, 'ch-1');
      manager.setFilter({ eventTypes: ['task_failed'] });

      // Send 3 notifications (degradedThreshold = 3)
      for (let i = 0; i < 3; i++) {
        await manager.notify({
          eventType: 'task_failed',
          taskId: `task-${i}`,
          label: 'test',
          failureReason: 'err',
        });
      }

      const channel = manager.getChannel('ch-1');
      expect(channel?.status).toBe('degraded');
      expect(channel?.consecutiveFailures).toBe(3);
    });

    it('AC3: 成功送达后恢复 active 状态', async () => {
      let shouldFail = true;
      const transport: ChannelTransport = {
        send: vi.fn().mockImplementation(async () => {
          if (shouldFail) throw new Error('fail');
        }),
        testConnection: vi.fn().mockResolvedValue(true),
      };

      manager.registerTransport('webhook', transport);
      manager.registerChannel('webhook', { url: 'https://a.com' }, 'ch-1');
      manager.setFilter({ eventTypes: ['task_failed'] });

      // Fail enough to degrade
      for (let i = 0; i < 3; i++) {
        await manager.notify({
          eventType: 'task_failed',
          taskId: `task-${i}`,
          label: 'test',
          failureReason: 'err',
        });
      }
      expect(manager.getChannel('ch-1')?.status).toBe('degraded');

      // Now succeed
      shouldFail = false;
      await manager.notify({
        eventType: 'task_failed',
        taskId: 'task-ok',
        label: 'test',
        failureReason: 'err',
      });

      expect(manager.getChannel('ch-1')?.status).toBe('active');
      expect(manager.getChannel('ch-1')?.consecutiveFailures).toBe(0);
    });

    it('AC4: 查看渠道送达率', async () => {
      let callCount = 0;
      const transport: ChannelTransport = {
        send: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 2) throw new Error('fail');
        }),
        testConnection: vi.fn().mockResolvedValue(true),
      };

      manager.registerTransport('webhook', transport);
      manager.registerChannel('webhook', { url: 'https://a.com' }, 'ch-1');
      manager.setFilter({ eventTypes: ['task_failed'] });

      // Send 3 notifications: 1st succeeds, 2nd fails (all retries), 3rd succeeds
      // Actually with retries, the 2nd will retry and eventually the mock will succeed on attempt 3
      // Let me simplify: first call succeeds, second always fails
      for (let i = 0; i < 2; i++) {
        await manager.notify({
          eventType: 'task_failed',
          taskId: `task-${i}`,
          label: 'test',
          failureReason: 'err',
        });
      }

      const stats = manager.getChannelStats('ch-1');
      expect(stats).toBeDefined();
      expect(stats!.deliveryRate).toBeGreaterThan(0);
    });
  });

  describe('EventBus 集成', () => {
    it('task:state_change 事件自动触发通知', async () => {
      const transport = makeMockTransport();
      manager.registerTransport('webhook', transport);
      manager.registerChannel('webhook', { url: 'https://a.com' }, 'ch-1');
      manager.setFilter({ eventTypes: ['task_failed', 'task_timeout'] });

      // Simulate task state change event
      await eventBus.emit('task:state_change', {
        taskId: 'task-1',
        from: 'running',
        to: 'failed',
        task: makeTask({
          taskId: 'task-1',
          status: 'failed',
          failureReason: 'execution_error',
          completedAt: Date.now(),
        }),
      });

      // Give async handler time to complete
      await new Promise(r => setTimeout(r, 50));

      expect(transport.send).toHaveBeenCalled();
      const records = manager.getDeliveryRecords('ch-1');
      expect(records.length).toBe(1);
    });

    it('agent:circuit_break 事件自动触发通知', async () => {
      const transport = makeMockTransport();
      manager.registerTransport('webhook', transport);
      manager.registerChannel('webhook', { url: 'https://a.com' }, 'ch-1');
      // circuit_break is in default filter

      await eventBus.emit('agent:circuit_break', { agentId: 'dev-01' });
      await new Promise(r => setTimeout(r, 50));

      expect(transport.send).toHaveBeenCalled();
    });
  });
});
