/**
 * Tests for P1-1: CLI task/pool/rule/init commands
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../src/cli/cli.js';

const TEST_DIR = '/tmp/aco-cli-p1-test';

function captureOutput() {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  console.error = (...args: unknown[]) => errors.push(args.join(' '));
  return {
    logs,
    errors,
    restore: () => { console.log = origLog; console.error = origErr; },
  };
}

describe('CLI P1 Commands', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    await mkdir(join(TEST_DIR, '.aco'), { recursive: true });
    process.env.ACO_DATA_DIR = join(TEST_DIR, '.aco');
    process.env.ACO_BOARD_PATH = join(TEST_DIR, '.aco', 'board.json');
  });

  afterEach(async () => {
    delete process.env.ACO_DATA_DIR;
    delete process.env.ACO_BOARD_PATH;
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe('aco task', () => {
    it('shows help', async () => {
      const out = captureOutput();
      const code = await main(['task', '--help']);
      out.restore();
      expect(code).toBe(0);
      expect(out.logs.join('\n')).toContain('aco task');
    });

    it('lists tasks from board.json', async () => {
      const tasks = [
        { taskId: 'task-1', label: 'test-task', status: 'running', agentId: 'cc', priority: 50, timeoutSeconds: 600, createdAt: Date.now(), updatedAt: Date.now(), retryCount: 0, maxRetries: 3 },
      ];
      await writeFile(join(TEST_DIR, '.aco', 'board.json'), JSON.stringify(tasks));

      const out = captureOutput();
      const code = await main(['task', 'list']);
      out.restore();
      expect(code).toBe(0);
      expect(out.logs.join('\n')).toContain('task-1');
    });

    it('filters tasks by status', async () => {
      const tasks = [
        { taskId: 'task-1', label: 'running-task', status: 'running', agentId: 'cc', priority: 50, timeoutSeconds: 600, createdAt: Date.now(), updatedAt: Date.now(), retryCount: 0, maxRetries: 3 },
        { taskId: 'task-2', label: 'failed-task', status: 'failed', agentId: 'cc', priority: 50, timeoutSeconds: 600, createdAt: Date.now(), updatedAt: Date.now(), retryCount: 0, maxRetries: 3 },
      ];
      await writeFile(join(TEST_DIR, '.aco', 'board.json'), JSON.stringify(tasks));

      const out = captureOutput();
      const code = await main(['task', 'list', '--status', 'failed']);
      out.restore();
      expect(code).toBe(0);
      expect(out.logs.join('\n')).toContain('task-2');
      expect(out.logs.join('\n')).not.toContain('task-1');
    });

    it('cancels a task', async () => {
      const tasks = [
        { taskId: 'task-1', label: 'test', status: 'running', agentId: 'cc', priority: 50, timeoutSeconds: 600, createdAt: Date.now(), updatedAt: Date.now(), retryCount: 0, maxRetries: 3 },
      ];
      await writeFile(join(TEST_DIR, '.aco', 'board.json'), JSON.stringify(tasks));

      const out = captureOutput();
      const code = await main(['task', 'cancel', 'task-1']);
      out.restore();
      expect(code).toBe(0);
      expect(out.logs.join('\n')).toContain('cancelled');
    });

    it('rejects cancel on terminal task', async () => {
      const tasks = [
        { taskId: 'task-1', label: 'test', status: 'succeeded', agentId: 'cc', priority: 50, timeoutSeconds: 600, createdAt: Date.now(), updatedAt: Date.now(), retryCount: 0, maxRetries: 3 },
      ];
      await writeFile(join(TEST_DIR, '.aco', 'board.json'), JSON.stringify(tasks));

      const out = captureOutput();
      const code = await main(['task', 'cancel', 'task-1']);
      out.restore();
      expect(code).toBe(1);
      expect(out.errors.join('\n')).toContain('TASK_TERMINAL');
    });

    it('retries a failed task', async () => {
      const tasks = [
        { taskId: 'task-1', label: 'test', status: 'failed', agentId: 'cc', priority: 50, timeoutSeconds: 600, createdAt: Date.now(), updatedAt: Date.now(), retryCount: 0, maxRetries: 3 },
      ];
      await writeFile(join(TEST_DIR, '.aco', 'board.json'), JSON.stringify(tasks));

      const out = captureOutput();
      const code = await main(['task', 'retry', 'task-1']);
      out.restore();
      expect(code).toBe(0);
      expect(out.logs.join('\n')).toContain('retry');
    });

    it('outputs JSON with --json', async () => {
      const tasks = [
        { taskId: 'task-1', label: 'test', status: 'running', agentId: 'cc', priority: 50, timeoutSeconds: 600, createdAt: Date.now(), updatedAt: Date.now(), retryCount: 0, maxRetries: 3 },
      ];
      await writeFile(join(TEST_DIR, '.aco', 'board.json'), JSON.stringify(tasks));

      const out = captureOutput();
      const code = await main(['task', 'list', '--json']);
      out.restore();
      expect(code).toBe(0);
      const parsed = JSON.parse(out.logs.join('\n'));
      expect(parsed).toHaveLength(1);
      expect(parsed[0].taskId).toBe('task-1');
    });
  });

  describe('aco pool', () => {
    it('shows help', async () => {
      const out = captureOutput();
      const code = await main(['pool', '--help']);
      out.restore();
      expect(code).toBe(0);
      expect(out.logs.join('\n')).toContain('aco pool');
    });

    it('adds an agent to pool', async () => {
      const out = captureOutput();
      const code = await main(['pool', 'add', 'dev-01', '--tier', 'T2', '--role', 'coder']);
      out.restore();
      expect(code).toBe(0);
      expect(out.logs.join('\n')).toContain('dev-01');
      expect(out.logs.join('\n')).toContain('registered');
    });

    it('rejects duplicate agent', async () => {
      await main(['pool', 'add', 'dev-01', '--tier', 'T2', '--role', 'coder']);
      const out = captureOutput();
      const code = await main(['pool', 'add', 'dev-01', '--tier', 'T2', '--role', 'coder']);
      out.restore();
      expect(code).toBe(1);
      expect(out.errors.join('\n')).toContain('POOL_DUPLICATE');
    });

    it('removes an agent', async () => {
      await main(['pool', 'add', 'dev-01', '--tier', 'T2', '--role', 'coder']);
      const out = captureOutput();
      const code = await main(['pool', 'remove', 'dev-01']);
      out.restore();
      expect(code).toBe(0);
      expect(out.logs.join('\n')).toContain('removed');
    });

    it('shows pool status', async () => {
      await main(['pool', 'add', 'dev-01', '--tier', 'T2', '--role', 'coder']);
      const out = captureOutput();
      const code = await main(['pool', 'status']);
      out.restore();
      expect(code).toBe(0);
      expect(out.logs.join('\n')).toContain('dev-01');
    });

    it('validates tier input', async () => {
      const out = captureOutput();
      const code = await main(['pool', 'add', 'dev-01', '--tier', 'X9']);
      out.restore();
      expect(code).toBe(1);
      expect(out.errors.join('\n')).toContain('POOL_INVALID_TIER');
    });
  });

  describe('aco rule', () => {
    it('shows help', async () => {
      const out = captureOutput();
      const code = await main(['rule', '--help']);
      out.restore();
      expect(code).toBe(0);
      expect(out.logs.join('\n')).toContain('aco rule');
    });

    it('adds a rule', async () => {
      const out = captureOutput();
      const code = await main(['rule', 'add', '--action', 'block', '--task-type', 'audit', '--desc', 'test rule']);
      out.restore();
      expect(code).toBe(0);
      expect(out.logs.join('\n')).toContain('Rule created');
    });

    it('lists rules', async () => {
      await main(['rule', 'add', '--action', 'block', '--task-type', 'audit', '--desc', 'test rule']);
      const out = captureOutput();
      const code = await main(['rule', 'list']);
      out.restore();
      expect(code).toBe(0);
      expect(out.logs.join('\n')).toContain('block');
    });

    it('enables/disables rules', async () => {
      // Add a rule first
      const addOut = captureOutput();
      await main(['rule', 'add', '--action', 'block', '--task-type', 'audit', '--desc', 'test']);
      addOut.restore();

      // Get rule ID from list
      const listOut = captureOutput();
      await main(['rule', 'list', '--json']);
      listOut.restore();
      const rules = JSON.parse(listOut.logs.join('\n'));
      const ruleId = rules[0].ruleId;

      // Disable
      const disOut = captureOutput();
      const code = await main(['rule', 'disable', ruleId]);
      disOut.restore();
      expect(code).toBe(0);
      expect(disOut.logs.join('\n')).toContain('disabled');

      // Enable
      const enOut = captureOutput();
      const code2 = await main(['rule', 'enable', ruleId]);
      enOut.restore();
      expect(code2).toBe(0);
      expect(enOut.logs.join('\n')).toContain('enabled');
    });

    it('rejects invalid action', async () => {
      const out = captureOutput();
      const code = await main(['rule', 'add', '--action', 'invalid']);
      out.restore();
      expect(code).toBe(1);
      expect(out.errors.join('\n')).toContain('RULE_INVALID_ACTION');
    });
  });

  describe('aco init', () => {
    it('shows help', async () => {
      const out = captureOutput();
      const code = await main(['init', '--help']);
      out.restore();
      expect(code).toBe(0);
      expect(out.logs.join('\n')).toContain('aco init');
    });
  });
});
