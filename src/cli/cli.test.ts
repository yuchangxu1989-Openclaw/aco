import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { main } from './cli.js';
import { AuditLogger } from '../audit-logger/audit-logger.js';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const testDir = '/tmp/aco-cli-test-' + Date.now();
const boardPath = resolve(testDir, 'board.json');

describe('CLI', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let originalCwd: string;

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    await mkdir(resolve(testDir, '.aco'), { recursive: true });
    // Clean audit file to ensure test isolation
    await writeFile(resolve(testDir, '.aco/audit.jsonl'), '');
    process.env.ACO_BOARD_PATH = boardPath;
    process.env.ACO_DATA_DIR = resolve(testDir, '.aco');

    originalCwd = process.cwd();
    process.chdir(testDir);

    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    delete process.env.ACO_BOARD_PATH;
    delete process.env.ACO_DATA_DIR;
    process.chdir(originalCwd);
    try { await unlink(boardPath); } catch { /* ignore */ }
    try { await unlink(resolve(testDir, '.aco/audit.jsonl')); } catch { /* ignore */ }
  });

  describe('aco board (FR-E02)', () => {
    it('should show active tasks in table format (FR-E02 AC1)', async () => {
      const tasks = [
        {
          taskId: 'task-001',
          label: 'build-feature',
          status: 'running',
          agentId: 'hermes',
          priority: 80,
          timeoutSeconds: 1200,
          createdAt: Date.now() - 60000,
          updatedAt: Date.now() - 60000,
          retryCount: 0,
          maxRetries: 3,
        },
        {
          taskId: 'task-002',
          label: 'audit-code',
          status: 'queued',
          agentId: 'audit-01',
          priority: 60,
          timeoutSeconds: 600,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          retryCount: 0,
          maxRetries: 3,
        },
      ];
      await writeFile(boardPath, JSON.stringify(tasks));

      const code = await main(['board']);
      expect(code).toBe(0);
      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('task-001');
      expect(output).toContain('build-feature');
      expect(output).toContain('hermes');
    });

    it('should filter by status (FR-E02 AC2)', async () => {
      const tasks = [
        { taskId: 'task-run-1', label: 'running-task', status: 'running', agentId: 'hermes', priority: 50, createdAt: Date.now(), updatedAt: Date.now(), retryCount: 0, maxRetries: 3, timeoutSeconds: 600 },
        { taskId: 'task-queue-1', label: 'queued-task', status: 'queued', agentId: 'dev-01', priority: 50, createdAt: Date.now(), updatedAt: Date.now(), retryCount: 0, maxRetries: 3, timeoutSeconds: 600 },
      ];
      await writeFile(boardPath, JSON.stringify(tasks));

      const code = await main(['board', '--status', 'running']);
      expect(code).toBe(0);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('task-run-1');
      expect(output).not.toContain('task-queue-1');
    });

    it('should filter by agent (FR-E02 AC2)', async () => {
      const tasks = [
        { taskId: 'task-hermes', label: 'task-a', status: 'running', agentId: 'hermes', priority: 50, createdAt: Date.now(), updatedAt: Date.now(), retryCount: 0, maxRetries: 3, timeoutSeconds: 600 },
        { taskId: 'task-dev01', label: 'task-b', status: 'running', agentId: 'dev-01', priority: 50, createdAt: Date.now(), updatedAt: Date.now(), retryCount: 0, maxRetries: 3, timeoutSeconds: 600 },
      ];
      await writeFile(boardPath, JSON.stringify(tasks));

      const code = await main(['board', '--agent', 'hermes']);
      expect(code).toBe(0);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('task-hermes');
      expect(output).not.toContain('task-dev01');
    });

    it('should output JSON format (FR-E02 AC4)', async () => {
      const tasks = [
        { taskId: 'task-json-1', label: 'json-task', status: 'running', agentId: 'hermes', priority: 50, createdAt: Date.now(), updatedAt: Date.now(), retryCount: 0, maxRetries: 3, timeoutSeconds: 600 },
      ];
      await writeFile(boardPath, JSON.stringify(tasks));

      const code = await main(['board', '--json']);
      expect(code).toBe(0);
      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed[0].taskId).toBe('task-json-1');
      expect(parsed[0].status).toBe('running');
    });

    it('should handle empty board (FR-E02 AC3)', async () => {
      await writeFile(boardPath, JSON.stringify([]));

      const code = await main(['board']);
      expect(code).toBe(0);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('No active tasks');
    });

    it('should handle missing board file', async () => {
      const code = await main(['board']);
      expect(code).toBe(0);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('No active tasks');
    });
  });

  describe('aco stats (FR-E03)', () => {
    it('should show stats for default 24h period (FR-E03 AC2)', async () => {
      const auditPath = resolve(testDir, '.aco/audit.jsonl');
      const logger = new AuditLogger({ filePath: auditPath });
      logger.logDispatch('task-1', 'hermes', { tier: 'T1' });
      logger.logComplete('task-1', 'hermes', { durationMs: 120000 });
      logger.logDispatch('task-2', 'dev-01', { tier: 'T4' });
      logger.logFail('task-2', 'dev-01', { durationMs: 600000, reason: 'timeout' });
      await logger.flush();

      const code = await main(['stats']);
      expect(code).toBe(0);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('Resource Utilization');
      expect(output).toContain('24h');
    });

    it('should accept --period flag (FR-E03 AC2)', async () => {
      const auditPath = resolve(testDir, '.aco/audit.jsonl');
      const logger = new AuditLogger({ filePath: auditPath });
      logger.logDispatch('task-1', 'hermes');
      logger.logComplete('task-1', 'hermes', { durationMs: 5000 });
      await logger.flush();

      const code = await main(['stats', '--period', '1h']);
      expect(code).toBe(0);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('1h');
    });

    it('should reject invalid period', async () => {
      const code = await main(['stats', '--period', '2h']);
      expect(code).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid period'));
    });

    it('should output JSON format (FR-E03 AC4)', async () => {
      const auditPath = resolve(testDir, '.aco/audit.jsonl');
      const logger = new AuditLogger({ filePath: auditPath });
      logger.logDispatch('task-1', 'hermes');
      logger.logComplete('task-1', 'hermes', { durationMs: 5000 });
      await logger.flush();

      const code = await main(['stats', '--json']);
      expect(code).toBe(0);
      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.period).toBe('24h');
      expect(parsed).toHaveProperty('totalTasks');
      expect(parsed).toHaveProperty('agents');
    });

    it('should show per-agent stats (FR-E03 AC1)', async () => {
      const auditPath = resolve(testDir, '.aco/audit.jsonl');
      const logger = new AuditLogger({ filePath: auditPath });
      logger.logDispatch('task-1', 'hermes');
      logger.logComplete('task-1', 'hermes', { durationMs: 5000 });
      await logger.flush();

      const code = await main(['stats', 'agents', '--json']);
      expect(code).toBe(0);
      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed).toBeInstanceOf(Array);
      const agent = parsed.find((a: any) => a.agentId === 'hermes');
      expect(agent).toBeDefined();
      expect(agent.busyRate).toBeGreaterThanOrEqual(0);
      expect(agent.completedCount).toBe(1);
    });

    it('should handle empty audit log (FR-E03 AC4)', async () => {
      const code = await main(['stats']);
      expect(code).toBe(0);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('No agent activity');
    });
  });

  describe('aco audit (FR-E04)', () => {
    it('should show task decision trace (FR-E04 AC1)', async () => {
      const auditPath = resolve(testDir, '.aco/audit.jsonl');
      const logger = new AuditLogger({ filePath: auditPath });
      logger.log({
        timestamp: new Date().toISOString(),
        eventType: 'task.dispatched',
        taskId: 'task-trace-1',
        agentId: 'hermes',
        details: { tier: 'T1' },
      });
      logger.log({
        timestamp: new Date(Date.now() + 60000).toISOString(),
        eventType: 'task.completed',
        taskId: 'task-trace-1',
        agentId: 'hermes',
        details: { durationMs: 60000 },
      });
      await logger.flush();

      const code = await main(['audit', 'task-trace-1']);
      expect(code).toBe(0);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('Decision trace for task: task-trace-1');
      expect(output).toContain('task.dispatched');
      expect(output).toContain('task.completed');
    });

    it('should output JSON with retry attempts (FR-E04 AC3/AC4)', async () => {
      const auditPath = resolve(testDir, '.aco/audit.jsonl');
      const logger = new AuditLogger({ filePath: auditPath });
      logger.log({
        timestamp: new Date().toISOString(),
        eventType: 'task.dispatched',
        taskId: 'task-retry-1',
        agentId: 'dev-01',
        details: { tier: 'T4' },
      });
      logger.log({
        timestamp: new Date(Date.now() + 60000).toISOString(),
        eventType: 'task.failed',
        taskId: 'task-retry-1',
        agentId: 'dev-01',
        details: { durationMs: 60000, reason: 'timeout' },
      });
      logger.log({
        timestamp: new Date(Date.now() + 60001).toISOString(),
        eventType: 'task.retry',
        taskId: 'task-retry-1',
        agentId: 'dev-01',
        details: { tier: 'T3', reason: 'tier_upgrade' },
      });
      logger.log({
        timestamp: new Date(Date.now() + 120000).toISOString(),
        eventType: 'task.completed',
        taskId: 'task-retry-1',
        agentId: 'hermes',
        details: { durationMs: 59999 },
      });
      await logger.flush();

      const code = await main(['audit', 'task-retry-1', '--json']);
      expect(code).toBe(0);
      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.taskId).toBe('task-retry-1');
      expect(parsed.entries).toHaveLength(4);
      expect(parsed.retryAttempts).toHaveLength(1);
      expect(parsed.retryAttempts[0].attemptNumber).toBe(1);
      expect(parsed.retryAttempts[0].tier).toBe('T3');
      expect(parsed.retryAttempts[0].failureReason).toBe('tier_upgrade');
      expect(parsed.totalDurationMs).toBeGreaterThan(0);
    });

    it('should show retry attempts in table format (FR-E04 AC3)', async () => {
      const auditPath = resolve(testDir, '.aco/audit.jsonl');
      const logger = new AuditLogger({ filePath: auditPath });
      logger.log({
        timestamp: new Date().toISOString(),
        eventType: 'task.dispatched',
        taskId: 'task-retry-2',
        agentId: 'dev-01',
      });
      logger.log({
        timestamp: new Date(Date.now() + 1000).toISOString(),
        eventType: 'task.retry',
        taskId: 'task-retry-2',
        agentId: 'dev-01',
        details: { tier: 'T3', reason: 'tier_upgrade' },
      });
      await logger.flush();

      const code = await main(['audit', 'task-retry-2']);
      expect(code).toBe(0);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('Retry Attempts:');
      expect(output).toContain('#1');
      expect(output).toContain('tier=T3');
    });

    it('should filter by agent (FR-E04 AC2)', async () => {
      const auditPath = resolve(testDir, '.aco/audit.jsonl');
      const logger = new AuditLogger({ filePath: auditPath });
      logger.log({
        timestamp: new Date().toISOString(),
        eventType: 'task.dispatched',
        taskId: 'task-a1',
        agentId: 'hermes',
      });
      logger.log({
        timestamp: new Date().toISOString(),
        eventType: 'task.dispatched',
        taskId: 'task-b1',
        agentId: 'dev-01',
      });
      await logger.flush();

      const code = await main(['audit', '--agent', 'hermes', '--json']);
      expect(code).toBe(0);
      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed).toBeInstanceOf(Array);
      expect(parsed.length).toBe(1);
      expect(parsed[0].agentId).toBe('hermes');
    });

    it('should handle no entries found', async () => {
      const code = await main(['audit', 'nonexistent-task']);
      expect(code).toBe(0);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('No audit entries');
    });
  });

  describe('help and routing', () => {
    it('should show help with --help flag', async () => {
      const code = await main(['--help']);
      expect(code).toBe(0);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('ACO');
      expect(output).toContain('board');
      expect(output).toContain('stats');
      expect(output).toContain('audit');
    });

    it('should show help with no args', async () => {
      const code = await main([]);
      expect(code).toBe(0);
    });

    it('should show version', async () => {
      const code = await main(['--version']);
      expect(code).toBe(0);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toMatch(/\d+\.\d+\.\d+/);
    });

    it('should error on unknown command', async () => {
      const code = await main(['unknown']);
      expect(code).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown command'));
    });
  });
});
