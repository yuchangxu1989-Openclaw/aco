/**
 * Tests for ClosureGuard - FR-F06: 任务闭环保障
 * Covers AC1-AC12
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClosureGuard, DEFAULT_CLOSURE_GUARD_CONFIG } from './closure-guard.js';
import type { ClosureGuardConfig, TaskCompletionEvent, PromptBuildContext } from './closure-guard.js';
import { EventBus } from '../event/event-bus.js';
import { AuditLogger } from '../audit-logger/index.js';
import type { HostAdapter, OutboundMessage } from '../types/index.js';

// --- Test Helpers ---

function createTestDeps(configOverrides?: Partial<ClosureGuardConfig>) {
  const eventBus = new EventBus();
  const auditLogger = new AuditLogger({ filePath: '/tmp/test-closure-audit.jsonl', enabled: false });
  const logSpy = vi.spyOn(auditLogger, 'log');

  const outboundHandlers: Array<(msg: OutboundMessage) => void> = [];
  const hostAdapter: HostAdapter = {
    spawnTask: vi.fn().mockResolvedValue('session-1'),
    killTask: vi.fn().mockResolvedValue(undefined),
    steerTask: vi.fn().mockResolvedValue(undefined),
    getTaskStatus: vi.fn().mockResolvedValue({ status: 'running' }),
    getAgentStatus: vi.fn().mockResolvedValue({ active: true }),
    getSessionState: vi.fn().mockResolvedValue({ sessionId: 's1', active: true }),
    subscribeEvents: vi.fn(),
    detectOutboundMessage: (handler) => {
      outboundHandlers.push(handler);
      return () => {
        const idx = outboundHandlers.indexOf(handler);
        if (idx >= 0) outboundHandlers.splice(idx, 1);
      };
    },
  };

  const config: Partial<ClosureGuardConfig> = {
    timeoutSeconds: 2, // Short timeout for tests
    ...configOverrides,
  };

  const guard = new ClosureGuard(eventBus, auditLogger, config, hostAdapter);

  return {
    eventBus,
    auditLogger,
    logSpy,
    hostAdapter,
    outboundHandlers,
    guard,
    simulateOutbound: (msg: OutboundMessage) => {
      for (const h of outboundHandlers) h(msg);
    },
  };
}

function createCompletionEvent(overrides?: Partial<TaskCompletionEvent>): TaskCompletionEvent {
  return {
    taskId: 'task-001',
    label: 'test-task',
    agentId: 'dev-01',
    status: 'succeeded',
    durationMs: 30000,
    ...overrides,
  };
}

function mainSessionContext(overrides?: Partial<PromptBuildContext>): PromptBuildContext {
  return {
    sessionKey: 'agent:main:feishu:direct:ou_test123',
    agentId: 'main',
    ...overrides,
  };
}

// --- Tests ---

describe('ClosureGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('AC1: Completion triggers closure timer', () => {
    it('should start timer on succeeded task completion', async () => {
      const { eventBus, guard } = createTestDeps();
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent());

      expect(guard.getPendingCount()).toBe(1);
      guard.stop();
    });

    it('should start timer on failed task completion', async () => {
      const { eventBus, guard } = createTestDeps();
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent({ status: 'failed' }));

      expect(guard.getPendingCount()).toBe(1);
      guard.stop();
    });

    it('should use configured timeoutSeconds', async () => {
      const { eventBus, guard, logSpy } = createTestDeps({ timeoutSeconds: 5 });
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent());

      // Not expired at 4s
      vi.advanceTimersByTime(4000);
      expect(guard.getPendingCount()).toBe(1);

      // Expired at 5s
      vi.advanceTimersByTime(1000);
      expect(guard.getPendingCount()).toBe(0);

      // Should have logged closure_missed
      const missedLog = logSpy.mock.calls.find(
        (c) => c[0].eventType === 'closure_missed',
      );
      expect(missedLog).toBeDefined();
      expect(missedLog![0].details!.timeoutSeconds).toBe(5);

      guard.stop();
    });
  });

  describe('AC2: Outbound message detection closes pending', () => {
    it('should detect closure when message contains taskId', async () => {
      const { eventBus, guard, simulateOutbound, logSpy } = createTestDeps();
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent({ taskId: 'task-xyz' }));
      expect(guard.getPendingCount()).toBe(1);

      // Simulate outbound message mentioning taskId
      simulateOutbound({
        content: 'Task task-xyz completed successfully. Here is the summary of what was done in this task.',
        sessionKey: 'agent:main:feishu:direct:ou_test',
        timestamp: Date.now(),
      });

      expect(guard.getPendingCount()).toBe(0);

      const detectedLog = logSpy.mock.calls.find(
        (c) => c[0].eventType === 'closure_detected',
      );
      expect(detectedLog).toBeDefined();
      expect(detectedLog![0].taskId).toBe('task-xyz');

      guard.stop();
    });

    it('should detect closure when message contains label', async () => {
      const { eventBus, guard, simulateOutbound } = createTestDeps();
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent({ label: 'build-feature-x' }));

      simulateOutbound({
        content: 'The build-feature-x task is done. Everything looks good and tests pass correctly.',
        sessionKey: 'agent:main:feishu:direct:ou_test',
        timestamp: Date.now(),
      });

      expect(guard.getPendingCount()).toBe(0);
      guard.stop();
    });

    it('should ignore short messages (<=50 chars)', async () => {
      const { eventBus, guard, simulateOutbound } = createTestDeps();
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent({ taskId: 'task-xyz' }));

      simulateOutbound({
        content: 'task-xyz ok',
        sessionKey: 'agent:main:feishu:direct:ou_test',
        timestamp: Date.now(),
      });

      // Still pending because message too short
      expect(guard.getPendingCount()).toBe(1);
      guard.stop();
    });
  });

  describe('AC3: Timeout records audit event, no user notification', () => {
    it('should log closure_missed on timeout', async () => {
      const { eventBus, guard, logSpy } = createTestDeps({ timeoutSeconds: 1 });
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent());

      vi.advanceTimersByTime(1000);

      expect(guard.getPendingCount()).toBe(0);

      const missedLog = logSpy.mock.calls.find(
        (c) => c[0].eventType === 'closure_missed',
      );
      expect(missedLog).toBeDefined();
      expect(missedLog![0].taskId).toBe('task-001');
      expect(missedLog![0].agentId).toBe('dev-01');
      expect(missedLog![0].details!.reason).toContain('did not send summary');

      guard.stop();
    });
  });

  describe('AC4 & AC11: Prompt injection', () => {
    it('should inject reminder for un-reminded pending closures', async () => {
      const { eventBus, guard } = createTestDeps();
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent({
        label: 'my-dev-task',
        agentId: 'cc',
      }));

      const result = guard.buildPromptInjection(mainSessionContext());

      expect(result).not.toBeNull();
      expect(result!.prependContext).toContain('my-dev-task');
      expect(result!.prependContext).toContain('agent=cc');
      expect(result!.prependContext).toContain('lark-cli');
      expect(result!.prependContext).toContain('不可忽略');

      guard.stop();
    });

    it('should only inject once per completion (reminded flag)', async () => {
      const { eventBus, guard } = createTestDeps();
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent());

      // First call: should inject
      const first = guard.buildPromptInjection(mainSessionContext());
      expect(first).not.toBeNull();

      // Second call: should return null (already reminded)
      const second = guard.buildPromptInjection(mainSessionContext());
      expect(second).toBeNull();

      guard.stop();
    });

    it('should include taskId in reminder (AC11)', async () => {
      const { eventBus, guard } = createTestDeps();
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent({ taskId: 'task-abc-123' }));

      const result = guard.buildPromptInjection(mainSessionContext());
      expect(result!.prependContext).toContain('task-abc-123');

      guard.stop();
    });
  });

  describe('AC5: excludeLabels', () => {
    it('should skip tasks with excluded label prefix', async () => {
      const { eventBus, guard } = createTestDeps({
        excludeLabels: ['healthcheck', 'heartbeat'],
      });
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent({ label: 'healthcheck-ping' }));

      expect(guard.getPendingCount()).toBe(0);
      guard.stop();
    });

    it('should skip tasks matching regex pattern', async () => {
      const { eventBus, guard } = createTestDeps({
        excludeLabels: ['/^internal-.*/'],
      });
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent({ label: 'internal-cleanup' }));

      expect(guard.getPendingCount()).toBe(0);
      guard.stop();
    });

    it('should not skip non-matching labels', async () => {
      const { eventBus, guard } = createTestDeps({
        excludeLabels: ['healthcheck'],
      });
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent({ label: 'build-feature' }));

      expect(guard.getPendingCount()).toBe(1);
      guard.stop();
    });
  });

  describe('AC7: Audit event details', () => {
    it('should include all required fields in closure_missed', async () => {
      const { eventBus, guard, logSpy } = createTestDeps({ timeoutSeconds: 1 });
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent({
        taskId: 'task-audit-test',
        label: 'audit-label',
        agentId: 'sa-01',
      }));

      vi.advanceTimersByTime(1000);

      const missedLog = logSpy.mock.calls.find(
        (c) => c[0].eventType === 'closure_missed',
      );
      expect(missedLog).toBeDefined();
      const entry = missedLog![0];
      expect(entry.taskId).toBe('task-audit-test');
      expect(entry.agentId).toBe('sa-01');
      expect(entry.details!.label).toBe('audit-label');
      expect(entry.details!.waitDurationMs).toBeGreaterThanOrEqual(1000);
      expect(entry.details!.timeoutSeconds).toBe(1);
      expect(entry.details!.reason).toBeDefined();

      guard.stop();
    });
  });

  describe('AC8: Global enabled toggle', () => {
    it('should not start timers when disabled', async () => {
      const { eventBus, guard } = createTestDeps({ enabled: false });
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent());

      expect(guard.getPendingCount()).toBe(0);
      guard.stop();
    });

    it('should not inject when disabled', async () => {
      const { eventBus, guard } = createTestDeps({ enabled: false });
      guard.start();

      const result = guard.buildPromptInjection(mainSessionContext());
      expect(result).toBeNull();

      guard.stop();
    });

    it('should support runtime toggle via updateConfig', async () => {
      const { eventBus, guard } = createTestDeps({ enabled: true });
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent());
      expect(guard.getPendingCount()).toBe(1);

      guard.updateConfig({ enabled: false });
      // Disabling clears pending
      expect(guard.getPendingCount()).toBe(0);

      guard.stop();
    });
  });

  describe('AC9: HostAdapter.detectOutboundMessage', () => {
    it('should subscribe to outbound messages via HostAdapter', () => {
      const { guard, outboundHandlers } = createTestDeps();
      guard.start();

      expect(outboundHandlers.length).toBe(1);
      guard.stop();
    });

    it('should unsubscribe on stop', () => {
      const { guard, outboundHandlers } = createTestDeps();
      guard.start();
      expect(outboundHandlers.length).toBe(1);

      guard.stop();
      expect(outboundHandlers.length).toBe(0);
    });

    it('should work without HostAdapter (manual notifyOutboundMessage)', async () => {
      const eventBus = new EventBus();
      const auditLogger = new AuditLogger({ filePath: '/tmp/test.jsonl', enabled: false });
      const guard = new ClosureGuard(eventBus, auditLogger, { timeoutSeconds: 5 });
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent({ taskId: 'task-manual' }));
      expect(guard.getPendingCount()).toBe(1);

      // Manually notify
      guard.notifyOutboundMessage({
        content: 'Here is the summary for task-manual. Everything completed successfully and the output is ready.',
        sessionKey: 'agent:main:feishu:direct:ou_test',
        timestamp: Date.now(),
      });

      expect(guard.getPendingCount()).toBe(0);
      guard.stop();
    });
  });

  describe('AC10: Default config values', () => {
    it('should have correct defaults', () => {
      expect(DEFAULT_CLOSURE_GUARD_CONFIG.enabled).toBe(true);
      expect(DEFAULT_CLOSURE_GUARD_CONFIG.timeoutSeconds).toBe(120);
      expect(DEFAULT_CLOSURE_GUARD_CONFIG.excludeLabels).toEqual(['healthcheck', 'heartbeat']);
    });
  });

  describe('AC12: Only inject into main session', () => {
    it('should not inject into subagent sessions', async () => {
      const { eventBus, guard } = createTestDeps();
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent());

      const result = guard.buildPromptInjection({
        sessionKey: 'agent:dev-01:subagent:abc123',
        agentId: 'dev-01',
      });

      expect(result).toBeNull();
      guard.stop();
    });

    it('should not inject into non-user-channel sessions', async () => {
      const { eventBus, guard } = createTestDeps();
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent());

      const result = guard.buildPromptInjection({
        sessionKey: 'agent:main:internal:system',
        agentId: 'main',
      });

      expect(result).toBeNull();
      guard.stop();
    });

    it('should inject into main session with telegram channel', async () => {
      const { eventBus, guard } = createTestDeps();
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent());

      const result = guard.buildPromptInjection({
        sessionKey: 'agent:main:telegram:chat:12345',
        agentId: 'main',
      });

      expect(result).not.toBeNull();
      guard.stop();
    });

    it('should inject when agentId is empty (treated as main)', async () => {
      const { eventBus, guard } = createTestDeps();
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent());

      const result = guard.buildPromptInjection({
        sessionKey: 'agent:main:feishu:direct:ou_test',
        agentId: '',
      });

      expect(result).not.toBeNull();
      guard.stop();
    });
  });

  describe('Multiple completions', () => {
    it('should track multiple pending closures independently', async () => {
      const { eventBus, guard } = createTestDeps({ timeoutSeconds: 5 });
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent({ taskId: 'task-1', label: 'first' }));
      await eventBus.emit('task:completed', createCompletionEvent({ taskId: 'task-2', label: 'second' }));

      expect(guard.getPendingCount()).toBe(2);

      // Close one via outbound message
      guard.notifyOutboundMessage({
        content: 'The first task is done. Here is a detailed summary of what happened during the execution.',
        sessionKey: 'agent:main:feishu:direct:ou_test',
        timestamp: Date.now(),
      });

      expect(guard.getPendingCount()).toBe(1);

      // Timeout the other
      vi.advanceTimersByTime(5000);
      expect(guard.getPendingCount()).toBe(0);

      guard.stop();
    });

    it('should include all un-reminded in single injection', async () => {
      const { eventBus, guard } = createTestDeps();
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent({ taskId: 'task-a', label: 'alpha' }));
      await eventBus.emit('task:completed', createCompletionEvent({ taskId: 'task-b', label: 'beta' }));

      const result = guard.buildPromptInjection(mainSessionContext());

      expect(result).not.toBeNull();
      expect(result!.prependContext).toContain('alpha');
      expect(result!.prependContext).toContain('beta');

      guard.stop();
    });
  });

  describe('Lifecycle', () => {
    it('should clear all timers on stop', async () => {
      const { eventBus, guard, logSpy } = createTestDeps({ timeoutSeconds: 10 });
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent());
      await eventBus.emit('task:completed', createCompletionEvent({ taskId: 'task-2' }));

      expect(guard.getPendingCount()).toBe(2);

      guard.stop();
      expect(guard.getPendingCount()).toBe(0);

      // Advance time - no closure_missed should fire
      vi.advanceTimersByTime(15000);
      const missedLogs = logSpy.mock.calls.filter(
        (c) => c[0].eventType === 'closure_missed',
      );
      expect(missedLogs.length).toBe(0);
    });

    it('should not process events after stop', async () => {
      const { eventBus, guard } = createTestDeps();
      guard.start();
      guard.stop();

      await eventBus.emit('task:completed', createCompletionEvent());
      // Event handler was unsubscribed, so nothing should be pending
      // (EventBus still has the handler reference until GC, but guard checks enabled)
      expect(guard.getPendingCount()).toBe(0);
    });
  });

  describe('reminder_injected audit event', () => {
    it('should log reminder_injected when injection happens', async () => {
      const { eventBus, guard, logSpy } = createTestDeps();
      guard.start();

      await eventBus.emit('task:completed', createCompletionEvent({ taskId: 'task-rem' }));
      guard.buildPromptInjection(mainSessionContext());

      const reminderLog = logSpy.mock.calls.find(
        (c) => c[0].eventType === 'reminder_injected',
      );
      expect(reminderLog).toBeDefined();
      expect(reminderLog![0].details!.taskIds).toContain('task-rem');

      guard.stop();
    });
  });
});
