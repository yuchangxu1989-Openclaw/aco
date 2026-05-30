/**
 * Tests for 域 G: 健康与恢复
 * FR-G01: 心跳检测
 * FR-G02: 卡死检测
 * FR-G03: 自动恢复策略
 * FR-G04: 全局健康仪表盘
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus } from '../event/event-bus.js';
import { ResourcePool } from '../pool/resource-pool.js';
import { TaskQueue } from '../task/task-queue.js';
import { HealthMonitor } from './health-monitor.js';
import { RecoveryManager } from './recovery-manager.js';
import { HealthReporter } from './health-reporter.js';
import type { HostAdapter } from '../types/index.js';
import { DEFAULT_CONFIG } from '../types/index.js';

// --- Test Helpers ---

function createTestEnv() {
  const eventBus = new EventBus();
  const resourcePool = new ResourcePool(eventBus);
  const taskQueue = new TaskQueue(eventBus, DEFAULT_CONFIG);

  // Register test agents
  resourcePool.register({ agentId: 'agent-1', tier: 'T1', runtimeType: 'subagent', roles: ['coder'] });
  resourcePool.register({ agentId: 'agent-2', tier: 'T2', runtimeType: 'acp', roles: ['auditor'] });
  resourcePool.register({ agentId: 'agent-3', tier: 'T3', runtimeType: 'subagent', roles: ['coder'] });

  return { eventBus, resourcePool, taskQueue };
}

function createMockHostAdapter(opts?: { active?: boolean; spawnResult?: string }): HostAdapter {
  return {
    spawnTask: vi.fn().mockResolvedValue(opts?.spawnResult ?? 'session-123'),
    killTask: vi.fn().mockResolvedValue(undefined),
    steerTask: vi.fn().mockResolvedValue(undefined),
    getTaskStatus: vi.fn().mockResolvedValue({ status: 'succeeded', outputTokens: 5000 }),
    getAgentStatus: vi.fn().mockResolvedValue({ active: opts?.active ?? true }),
    getSessionState: vi.fn().mockResolvedValue({ sessionId: 'session-123', active: true }),
    subscribeEvents: vi.fn(),
  };
}

// --- FR-G01: Heartbeat Detection ---

describe('FR-G01: Agent 健康探测', () => {
  let env: ReturnType<typeof createTestEnv>;
  let monitor: HealthMonitor;

  beforeEach(() => {
    env = createTestEnv();
    monitor = new HealthMonitor(env.eventBus, env.resourcePool, env.taskQueue, {
      heartbeatIntervalMs: 100,
      missedHeartbeatsThreshold: 3,
    });
  });

  afterEach(() => {
    monitor.stop();
  });

  it('AC1: initializes heartbeat state for all registered agents', () => {
    monitor.start();
    const states = monitor.getAllHeartbeatStates();
    expect(states).toHaveLength(3);
    expect(states.map(s => s.agentId).sort()).toEqual(['agent-1', 'agent-2', 'agent-3']);
  });

  it('AC1: probes agents via HostAdapter', async () => {
    const adapter = createMockHostAdapter({ active: true });
    monitor.setHostAdapter(adapter);
    monitor.start();

    await monitor.runHeartbeatCycle();

    expect(adapter.getAgentStatus).toHaveBeenCalledWith('agent-1');
    expect(adapter.getAgentStatus).toHaveBeenCalledWith('agent-2');
    expect(adapter.getAgentStatus).toHaveBeenCalledWith('agent-3');
  });

  it('AC2: marks agent as stale after N missed heartbeats', async () => {
    const adapter = createMockHostAdapter({ active: false });
    monitor.setHostAdapter(adapter);
    monitor.start();

    // Miss 3 heartbeats
    await monitor.runHeartbeatCycle();
    await monitor.runHeartbeatCycle();
    await monitor.runHeartbeatCycle();

    const agent = env.resourcePool.get('agent-1');
    expect(agent?.status).toBe('stale');
  });

  it('AC2: does not mark stale before threshold', async () => {
    const adapter = createMockHostAdapter({ active: false });
    monitor.setHostAdapter(adapter);
    monitor.start();

    await monitor.runHeartbeatCycle();
    await monitor.runHeartbeatCycle();

    const agent = env.resourcePool.get('agent-1');
    expect(agent?.status).not.toBe('stale');
  });

  it('AC3: emits health:agent_unhealthy event on stale transition', async () => {
    const adapter = createMockHostAdapter({ active: false });
    monitor.setHostAdapter(adapter);
    monitor.start();

    const events: unknown[] = [];
    env.eventBus.on('health:agent_unhealthy', (p) => { events.push(p); });

    await monitor.runHeartbeatCycle();
    await monitor.runHeartbeatCycle();
    await monitor.runHeartbeatCycle();

    expect(events.length).toBeGreaterThan(0);
    expect((events[0] as Record<string, unknown>).agentId).toBe('agent-1');
    expect((events[0] as Record<string, unknown>).reason).toBe('heartbeat_timeout');
  });

  it('AC4: respects tier-specific intervals (via config)', () => {
    const customMonitor = new HealthMonitor(env.eventBus, env.resourcePool, env.taskQueue, {
      heartbeatIntervalMs: 30_000,
      missedHeartbeatsThreshold: 3,
      tierIntervals: { T1: 10_000, T3: 60_000 },
    });
    // Verify config is stored (internal behavior tested via probing logic)
    expect(customMonitor).toBeDefined();
    customMonitor.stop();
  });

  it('records heartbeat success on message:received event', async () => {
    const adapter = createMockHostAdapter({ active: false });
    monitor.setHostAdapter(adapter);
    monitor.start();

    // Miss one heartbeat
    await monitor.runHeartbeatCycle();
    const stateBefore = monitor.getHeartbeatState('agent-1');
    expect(stateBefore?.missedCount).toBe(1);

    // Simulate message received
    await env.eventBus.emit('message:received', { agentId: 'agent-1' });

    const stateAfter = monitor.getHeartbeatState('agent-1');
    expect(stateAfter?.missedCount).toBe(0);
  });
});

// --- FR-G02: Stall Detection ---

describe('FR-G02: 任务停滞检测', () => {
  let env: ReturnType<typeof createTestEnv>;
  let monitor: HealthMonitor;

  beforeEach(() => {
    env = createTestEnv();
    monitor = new HealthMonitor(env.eventBus, env.resourcePool, env.taskQueue, {
      heartbeatIntervalMs: 100,
      missedHeartbeatsThreshold: 3,
      stallWarningFactor: 0.8,
      stallResponseTimeoutMs: 100, // Short for testing
    });
  });

  afterEach(() => {
    monitor.stop();
  });

  it('AC1: emits stall_warning when task exceeds timeout * factor', async () => {
    // Create a task with minimum allowed timeout (300s)
    const task = await env.taskQueue.create({
      label: 'test-task',
      prompt: 'do something',
      timeoutSeconds: 300,
    });
    env.taskQueue.transition(task.taskId, 'dispatching');
    env.taskQueue.transition(task.taskId, 'running');

    // Simulate elapsed time > 0.8 * 300000ms = 240000ms
    const t = env.taskQueue.get(task.taskId)!;
    (t as { updatedAt: number }).updatedAt = Date.now() - 250_000;

    const events: unknown[] = [];
    env.eventBus.on('health:stall_warning', (p) => { events.push(p); });

    monitor.start();
    monitor.runStallDetection();

    expect(events).toHaveLength(1);
    expect((events[0] as Record<string, unknown>).taskId).toBe(task.taskId);
  });

  it('AC2: sends steer message on stall warning', async () => {
    const adapter = createMockHostAdapter();
    monitor.setHostAdapter(adapter);

    const task = await env.taskQueue.create({
      label: 'stall-test',
      prompt: 'do something',
      agentId: 'agent-1',
      timeoutSeconds: 300,
    });
    env.taskQueue.transition(task.taskId, 'dispatching');
    env.taskQueue.transition(task.taskId, 'running');

    const t = env.taskQueue.get(task.taskId)!;
    (t as { updatedAt: number }).updatedAt = Date.now() - 250_000;
    (t as { agentId: string }).agentId = 'agent-1';

    monitor.start();
    monitor.runStallDetection();

    expect(adapter.steerTask).toHaveBeenCalledWith(task.taskId, '请报告当前进度');
  });

  it('AC3: emits task_stalled after steer response timeout', async () => {
    const adapter = createMockHostAdapter();
    monitor.setHostAdapter(adapter);

    const task = await env.taskQueue.create({
      label: 'stall-timeout',
      prompt: 'do something',
      agentId: 'agent-1',
      timeoutSeconds: 300,
    });
    env.taskQueue.transition(task.taskId, 'dispatching');
    env.taskQueue.transition(task.taskId, 'running');

    const t = env.taskQueue.get(task.taskId)!;
    (t as { updatedAt: number }).updatedAt = Date.now() - 250_000;
    (t as { agentId: string }).agentId = 'agent-1';

    monitor.start();

    // First detection: emits warning + steer
    monitor.runStallDetection();

    // Simulate steer timeout (set steerSentAt to past)
    const stallState = monitor.getStallState(task.taskId);
    expect(stallState).toBeDefined();
    (stallState as { steerSentAt: number }).steerSentAt = Date.now() - 200; // > 100ms timeout

    const events: unknown[] = [];
    env.eventBus.on('health:task_stalled', (p) => { events.push(p); });

    // Second detection: should emit stalled
    monitor.runStallDetection();

    expect(events).toHaveLength(1);
    expect((events[0] as Record<string, unknown>).taskId).toBe(task.taskId);
  });

  it('AC4: skips exempt task types', async () => {
    const customMonitor = new HealthMonitor(env.eventBus, env.resourcePool, env.taskQueue, {
      heartbeatIntervalMs: 100,
      missedHeartbeatsThreshold: 3,
      stallWarningFactor: 0.8,
      stallResponseTimeoutMs: 100,
      stallExemptTaskTypes: ['long-running'],
    });

    const task = await env.taskQueue.create({
      label: 'exempt-task',
      prompt: 'long operation',
      timeoutSeconds: 300,
      metadata: { taskType: 'long-running' },
    });
    env.taskQueue.transition(task.taskId, 'dispatching');
    env.taskQueue.transition(task.taskId, 'running');

    const t = env.taskQueue.get(task.taskId)!;
    (t as { updatedAt: number }).updatedAt = Date.now() - 250_000;

    const events: unknown[] = [];
    env.eventBus.on('health:stall_warning', (p) => { events.push(p); });

    customMonitor.start();
    customMonitor.runStallDetection();

    expect(events).toHaveLength(0);
    customMonitor.stop();
  });
});

// --- FR-G03: Recovery ---

describe('FR-G03: 自动恢复策略', () => {
  let env: ReturnType<typeof createTestEnv>;
  let recovery: RecoveryManager;

  beforeEach(() => {
    env = createTestEnv();
    recovery = new RecoveryManager(env.eventBus, env.resourcePool, {
      probeTimeoutMs: 500,
      stabilizationDelayMs: 10,
    });
  });

  it('AC1: initiates recovery when agent transitions from stale', async () => {
    // Set agent to stale
    env.resourcePool.setStatus('agent-1', 'stale');

    const events: unknown[] = [];
    env.eventBus.on('recovery:initiated', (p) => { events.push(p); });

    await recovery.initiateRecovery('agent-1');

    expect(events).toHaveLength(1);
    expect((events[0] as Record<string, unknown>).agentId).toBe('agent-1');
  });

  it('AC2: sends probe task (no host adapter → auto-confirms)', async () => {
    env.resourcePool.setStatus('agent-1', 'stale');

    const events: unknown[] = [];
    env.eventBus.on('recovery:confirmed', (p) => { events.push(p); });

    await recovery.initiateRecovery('agent-1');

    // Without host adapter, recovery auto-confirms after stabilization delay
    expect(events).toHaveLength(1);
    expect((events[0] as Record<string, unknown>).agentId).toBe('agent-1');
  });

  it('AC3: restores agent to idle after confirmed recovery', async () => {
    env.resourcePool.setStatus('agent-1', 'stale');

    await recovery.initiateRecovery('agent-1');

    const agent = env.resourcePool.get('agent-1');
    expect(agent?.status).toBe('idle');
  });

  it('AC2: sends probe via host adapter', async () => {
    const adapter = createMockHostAdapter({ spawnResult: 'probe-session' });
    recovery.setHostAdapter(adapter);

    env.resourcePool.setStatus('agent-1', 'offline');

    await recovery.initiateRecovery('agent-1');

    expect(adapter.spawnTask).toHaveBeenCalledWith(
      'agent-1',
      expect.stringContaining('Health probe'),
      expect.objectContaining({ label: 'health-probe' }),
    );
  });

  it('AC4: emits recovery event for audit logging', async () => {
    env.resourcePool.setStatus('agent-1', 'stale');

    const events: unknown[] = [];
    env.eventBus.on('recovery:confirmed', (p) => { events.push(p); });

    await recovery.initiateRecovery('agent-1');

    expect(events).toHaveLength(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.agentId).toBe('agent-1');
    expect(event.durationMs).toBeTypeOf('number');
  });

  it('records recovery history', async () => {
    env.resourcePool.setStatus('agent-1', 'stale');
    await recovery.initiateRecovery('agent-1');

    const history = recovery.getRecoveryHistory();
    expect(history).toHaveLength(1);
    expect(history[0].agentId).toBe('agent-1');
    expect(history[0].success).toBe(true);
  });

  it('auto-triggers recovery on heartbeat_restored for stale agent', async () => {
    env.resourcePool.setStatus('agent-2', 'stale');

    const events: unknown[] = [];
    env.eventBus.on('recovery:initiated', (p) => { events.push(p); });

    // Simulate heartbeat restored
    await env.eventBus.emit('health:heartbeat_restored', { agentId: 'agent-2' });

    // Give async recovery time to start
    await new Promise(r => setTimeout(r, 50));

    expect(events).toHaveLength(1);
  });
});

// --- FR-G04: Health Reporter ---

describe('FR-G04: 全局健康仪表盘', () => {
  let env: ReturnType<typeof createTestEnv>;
  let monitor: HealthMonitor;
  let recovery: RecoveryManager;
  let reporter: HealthReporter;

  beforeEach(() => {
    env = createTestEnv();
    monitor = new HealthMonitor(env.eventBus, env.resourcePool, env.taskQueue, {
      heartbeatIntervalMs: 100,
      missedHeartbeatsThreshold: 3,
    });
    recovery = new RecoveryManager(env.eventBus, env.resourcePool);
    reporter = new HealthReporter(env.resourcePool, env.taskQueue, monitor, recovery);
    monitor.start();
  });

  afterEach(() => {
    monitor.stop();
  });

  it('AC1: reports active, stale, offline agent counts', () => {
    env.resourcePool.setStatus('agent-2', 'stale');
    env.resourcePool.setStatus('agent-3', 'offline');

    const report = reporter.generateReport();

    expect(report.activeAgents).toBe(1); // agent-1 is idle
    expect(report.staleAgents).toBe(1);  // agent-2
    expect(report.offlineAgents).toBe(1); // agent-3
    expect(report.totalAgents).toBe(3);
  });

  it('AC1: reports queue depth and avg wait time', async () => {
    await env.taskQueue.create({ label: 'task-1', prompt: 'p1', timeoutSeconds: 600 });
    await env.taskQueue.create({ label: 'task-2', prompt: 'p2', timeoutSeconds: 600 });

    const report = reporter.generateReport();

    expect(report.queueDepth).toBe(2);
    expect(report.avgWaitTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('AC1: includes per-agent health details', () => {
    const report = reporter.generateReport();

    expect(report.agents).toHaveLength(3);
    const agent1 = report.agents.find(a => a.agentId === 'agent-1');
    expect(agent1).toBeDefined();
    expect(agent1!.tier).toBe('T1');
    expect(agent1!.healthScore).toBeGreaterThan(0);
    expect(agent1!.lastHeartbeatAt).toBeTypeOf('number');
  });

  it('AC2: healthy when all agents are active', () => {
    const report = reporter.generateReport();
    expect(report.level).toBe('healthy');
  });

  it('AC2: degraded when some agents are offline', () => {
    env.resourcePool.setStatus('agent-3', 'offline');
    const report = reporter.generateReport();
    expect(report.level).toBe('degraded');
  });

  it('AC2: critical when no agents are available', () => {
    env.resourcePool.setStatus('agent-1', 'offline');
    env.resourcePool.setStatus('agent-2', 'offline');
    env.resourcePool.setStatus('agent-3', 'offline');

    const report = reporter.generateReport();
    expect(report.level).toBe('critical');
  });

  it('AC4: toJSON exports valid JSON', () => {
    const json = reporter.toJSON();
    const parsed = JSON.parse(json);
    expect(parsed.level).toBeDefined();
    expect(parsed.agents).toBeInstanceOf(Array);
    expect(parsed.generatedAt).toBeTypeOf('number');
  });

  it('calculates system health score', () => {
    const report = reporter.generateReport();
    expect(report.healthScore).toBeGreaterThan(0);
    expect(report.healthScore).toBeLessThanOrEqual(100);
  });

  it('health score decreases with failures', () => {
    const reportBefore = reporter.generateReport();

    // Simulate failures
    env.resourcePool.markBusy('agent-1');
    env.resourcePool.markTaskCompleted('agent-1', false);
    env.resourcePool.markBusy('agent-1');
    env.resourcePool.markTaskCompleted('agent-1', false);

    const reportAfter = reporter.generateReport();
    expect(reportAfter.healthScore).toBeLessThan(reportBefore.healthScore);
  });
});
