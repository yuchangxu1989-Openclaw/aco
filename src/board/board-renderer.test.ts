import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BoardRenderer } from './board-renderer.js';
import type { Task, TaskStatus } from '../types/index.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: 'task-001',
    label: 'test-task',
    prompt: 'do something',
    agentId: 'agent-1',
    timeoutSeconds: 600,
    priority: 50,
    status: 'running',
    createdAt: Date.now() - 30000,
    updatedAt: Date.now() - 30000,
    retryCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

describe('BoardRenderer', () => {
  let renderer: BoardRenderer;

  beforeEach(() => {
    renderer = new BoardRenderer();
  });

  afterEach(() => {
    renderer.stopWatch();
  });

  describe('render (FR-E02 AC1)', () => {
    it('should render active tasks with status, agentId, running time, priority', () => {
      const tasks = [
        makeTask({ taskId: 'aaa-111', label: 'build-feature', agentId: 'hermes', status: 'running', priority: 80 }),
        makeTask({ taskId: 'bbb-222', label: 'audit-code', agentId: 'audit-01', status: 'queued', priority: 60 }),
      ];

      const output = renderer.render(tasks);
      expect(output).toContain('aaa-111');
      expect(output).toContain('build-feature');
      expect(output).toContain('hermes');
      expect(output).toContain('running');
      expect(output).toContain('80');
      expect(output).toContain('bbb-222');
      expect(output).toContain('audit-code');
      expect(output).toContain('queued');
    });

    it('should exclude terminal state tasks by default', () => {
      const tasks = [
        makeTask({ taskId: 'task-running', status: 'running' }),
        makeTask({ taskId: 'task-succeeded', status: 'succeeded' }),
        makeTask({ taskId: 'task-cancelled', status: 'cancelled' }),
        makeTask({ taskId: 'task-failed', status: 'failed' }),
      ];

      const output = renderer.render(tasks);
      expect(output).toContain('task-running');
      expect(output).not.toContain('task-succeeded');
      expect(output).not.toContain('task-cancelled');
      expect(output).toContain('task-failed');
    });

    it('should show "No active tasks." when empty', () => {
      const output = renderer.render([]);
      expect(output).toBe('No active tasks.');
    });

    it('should show "-" for agentId when not assigned', () => {
      const tasks = [makeTask({ agentId: undefined, status: 'queued' })];
      const output = renderer.render(tasks, { format: 'json' });
      const parsed = JSON.parse(output);
      expect(parsed[0].agentId).toBe('-');
    });
  });

  describe('filter (FR-E02 AC2)', () => {
    const tasks = [
      makeTask({ taskId: 'task-alpha', status: 'running', agentId: 'hermes', priority: 80 }),
      makeTask({ taskId: 'task-beta', status: 'queued', agentId: 'audit-01', priority: 60 }),
      makeTask({ taskId: 'task-gamma', status: 'failed', agentId: 'hermes', priority: 40 }),
      makeTask({ taskId: 'task-delta', status: 'running', agentId: 'dev-01', priority: 50 }),
    ];

    it('should filter by single status', () => {
      const output = renderer.render(tasks, { filter: { status: 'running' } });
      expect(output).toContain('task-alpha');
      expect(output).toContain('task-delta');
      expect(output).not.toContain('task-beta');
      expect(output).not.toContain('task-gamma');
    });

    it('should filter by multiple statuses', () => {
      const output = renderer.render(tasks, { filter: { status: ['running', 'failed'] } });
      expect(output).toContain('task-alpha');
      expect(output).toContain('task-gamma');
      expect(output).toContain('task-delta');
      expect(output).not.toContain('task-beta');
    });

    it('should filter by agentId', () => {
      const output = renderer.render(tasks, { filter: { agentId: 'hermes' } });
      expect(output).toContain('task-alpha');
      expect(output).toContain('task-gamma');
      expect(output).not.toContain('task-beta');
      expect(output).not.toContain('task-delta');
    });

    it('should filter by minimum priority', () => {
      const output = renderer.render(tasks, { filter: { priority: 60 } });
      expect(output).toContain('task-alpha');
      expect(output).toContain('task-beta');
      expect(output).not.toContain('task-gamma');
      expect(output).not.toContain('task-delta');
    });
  });

  describe('output format (FR-E02 AC4)', () => {
    it('should render table format by default', () => {
      const tasks = [makeTask()];
      const output = renderer.render(tasks, { format: 'table' });
      expect(output).toContain('TASK ID');
      expect(output).toContain('LABEL');
      expect(output).toContain('STATUS');
      expect(output).toContain('AGENT');
      expect(output).toContain('RUNNING');
      expect(output).toContain('PRI');
    });

    it('should render JSON format', () => {
      const tasks = [makeTask({ taskId: 'json-test', label: 'my-task', agentId: 'hermes' })];
      const output = renderer.render(tasks, { format: 'json' });
      const parsed = JSON.parse(output);
      expect(parsed).toBeInstanceOf(Array);
      expect(parsed[0].taskId).toBe('json-test');
      expect(parsed[0].label).toBe('my-task');
      expect(parsed[0].agentId).toBe('hermes');
      expect(parsed[0].status).toBe('running');
      expect(parsed[0].priority).toBe(50);
    });
  });

  describe('watch mode (FR-E02 AC5)', () => {
    it('should start and stop watch mode', () => {
      vi.useFakeTimers();
      const outputs: string[] = [];

      renderer.startWatch(
        () => [makeTask()],
        {},
        (content) => outputs.push(content),
      );

      expect(renderer.isWatching()).toBe(true);
      expect(outputs.length).toBe(1); // Initial render

      vi.advanceTimersByTime(5000);
      expect(outputs.length).toBe(2); // After 5s

      vi.advanceTimersByTime(5000);
      expect(outputs.length).toBe(3); // After 10s

      renderer.stopWatch();
      expect(renderer.isWatching()).toBe(false);

      vi.advanceTimersByTime(5000);
      expect(outputs.length).toBe(3); // No more after stop

      vi.useRealTimers();
    });

    it('should use custom interval', () => {
      vi.useFakeTimers();
      const outputs: string[] = [];

      renderer.startWatch(
        () => [makeTask()],
        { intervalMs: 2000 },
        (content) => outputs.push(content),
      );

      vi.advanceTimersByTime(2000);
      expect(outputs.length).toBe(2); // Initial + 1 refresh

      vi.advanceTimersByTime(2000);
      expect(outputs.length).toBe(3);

      renderer.stopWatch();
      vi.useRealTimers();
    });

    it('should reflect task changes in watch mode', () => {
      vi.useFakeTimers();
      const outputs: string[] = [];
      let taskList = [makeTask({ taskId: 'watch-task-1', status: 'running' })];

      renderer.startWatch(
        () => taskList,
        {},
        (content) => outputs.push(content),
      );

      expect(outputs[0]).toContain('watch-task-1');

      // Simulate task completion (removed from active)
      taskList = [makeTask({ taskId: 'watch-task-2', status: 'queued' })];
      vi.advanceTimersByTime(5000);

      expect(outputs[1]).toContain('watch-task-2');
      expect(outputs[1]).not.toContain('watch-task-1');

      renderer.stopWatch();
      vi.useRealTimers();
    });
  });

  describe('duration formatting', () => {
    it('should show seconds for short durations', () => {
      const tasks = [makeTask({ status: 'running', updatedAt: Date.now() - 45000 })];
      const output = renderer.render(tasks);
      expect(output).toMatch(/45s/);
    });

    it('should show minutes for medium durations', () => {
      const tasks = [makeTask({ status: 'running', updatedAt: Date.now() - 125000 })];
      const output = renderer.render(tasks);
      expect(output).toMatch(/2m5s/);
    });

    it('should show hours for long durations', () => {
      const tasks = [makeTask({ status: 'running', updatedAt: Date.now() - 3700000 })];
      const output = renderer.render(tasks);
      expect(output).toMatch(/1h1m/);
    });

    it('should show "-" for non-running tasks', () => {
      const tasks = [makeTask({ status: 'queued' })];
      const json = renderer.render(tasks, { format: 'json' });
      const parsed = JSON.parse(json);
      expect(parsed[0].runningTime).toBe('-');
    });
  });
});
