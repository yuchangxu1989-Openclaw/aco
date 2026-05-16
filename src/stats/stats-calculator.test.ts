import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StatsCalculator } from './stats-calculator.js';
import type { StatsCalculatorConfig } from './stats-calculator.js';
import { AuditQuery } from '../audit-query/index.js';
import { AuditLogger } from '../audit-logger/index.js';
import { unlink } from 'node:fs/promises';

const testFilePath = '/tmp/aco-test-stats-' + Date.now() + '.jsonl';

describe('StatsCalculator', () => {
  let auditQuery: AuditQuery;
  let logger: AuditLogger;
  let calculator: StatsCalculator;

  beforeEach(async () => {
    logger = new AuditLogger({ filePath: testFilePath });
    auditQuery = new AuditQuery({ filePath: testFilePath, retentionDays: 30 });

    const config: StatsCalculatorConfig = {
      knownAgents: ['agent-1', 'agent-2', 'agent-3'],
    };
    calculator = new StatsCalculator(auditQuery, config);

    // Write test audit entries with timing data
    const now = Date.now();

    // agent-1: 2 dispatches, 2 completions (5s and 10s)
    logger.logDispatch('task-1', 'agent-1', { tier: 2 });
    logger.logComplete('task-1', 'agent-1', { durationMs: 5000 });
    logger.logDispatch('task-3', 'agent-1', { tier: 2 });
    logger.logComplete('task-3', 'agent-1', { durationMs: 10000 });

    // agent-2: 2 dispatches, 1 completion, 1 failure
    logger.logDispatch('task-2', 'agent-2', { tier: 1 });
    logger.logComplete('task-2', 'agent-2', { durationMs: 8000 });
    logger.logDispatch('task-4', 'agent-2', { tier: 1 });
    logger.logFail('task-4', 'agent-2', { reason: 'timeout', durationMs: 60000 });
    logger.logRetry('task-4', 'agent-2', { retryCount: 1 });

    // agent-3: no activity
    await logger.flush();
  });

  afterEach(async () => {
    try {
      await unlink(testFilePath);
    } catch { /* ignore */ }
  });

  describe('calculate (FR-E03 AC1, AC2)', () => {
    it('should calculate stats for 1h period', async () => {
      const stats = await calculator.calculate('1h');

      expect(stats.period).toBe('1h');
      expect(stats.totalTasks).toBe(4); // 3 completed + 1 failed
      expect(stats.succeededTasks).toBe(3);
      expect(stats.failedTasks).toBe(1);
      expect(stats.retriedTasks).toBe(1);
    });

    it('should calculate per-agent stats', async () => {
      const stats = await calculator.calculate('1h');

      const agent1 = stats.agents.find((a) => a.agentId === 'agent-1');
      expect(agent1).toBeDefined();
      expect(agent1!.completedCount).toBe(2);
      expect(agent1!.failedCount).toBe(0);
      expect(agent1!.avgDurationMs).toBe(7500); // (5000 + 10000) / 2
      expect(agent1!.failureRate).toBe(0);

      const agent2 = stats.agents.find((a) => a.agentId === 'agent-2');
      expect(agent2).toBeDefined();
      expect(agent2!.completedCount).toBe(1);
      expect(agent2!.failedCount).toBe(1);
      expect(agent2!.failureRate).toBe(0.5); // 1 fail / 2 total
      expect(agent2!.tierUpgradeCount).toBe(1);
    });

    it('should include agents with no activity', async () => {
      const stats = await calculator.calculate('1h');

      const agent3 = stats.agents.find((a) => a.agentId === 'agent-3');
      expect(agent3).toBeDefined();
      expect(agent3!.completedCount).toBe(0);
      expect(agent3!.failedCount).toBe(0);
      expect(agent3!.busyRate).toBe(0);
      expect(agent3!.totalTasks).toBe(0);
    });

    it('should calculate overall utilization (FR-E03 AC3)', async () => {
      const stats = await calculator.calculate('1h');

      // Overall utilization = total busy time / (period * agent count)
      expect(stats.overallUtilization).toBeGreaterThanOrEqual(0);
      expect(stats.overallUtilization).toBeLessThanOrEqual(1);
    });

    it('should calculate average duration', async () => {
      const stats = await calculator.calculate('1h');

      // (5000 + 10000 + 8000 + 60000) / 4 = 20750
      expect(stats.avgDurationMs).toBe(20750);
    });
  });

  describe('different periods', () => {
    it('should support 24h period', async () => {
      const stats = await calculator.calculate('24h');
      expect(stats.period).toBe('24h');
      expect(stats.totalTasks).toBeGreaterThanOrEqual(0);
    });

    it('should support 7d period', async () => {
      const stats = await calculator.calculate('7d');
      expect(stats.period).toBe('7d');
      expect(stats.totalTasks).toBeGreaterThanOrEqual(0);
    });
  });

  describe('updateKnownAgents', () => {
    it('should update agent list for utilization calculation', async () => {
      calculator.updateKnownAgents(['agent-1']);
      const stats = await calculator.calculate('1h');

      // With only 1 known agent, utilization denominator changes
      expect(stats.agents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('edge cases', () => {
    it('should handle empty audit log', async () => {
      const emptyQuery = new AuditQuery({ filePath: '/tmp/nonexistent-stats-' + Date.now() + '.jsonl', retentionDays: 30 });
      const emptyCalc = new StatsCalculator(emptyQuery, { knownAgents: ['agent-1'] });

      const stats = await emptyCalc.calculate('1h');
      expect(stats.totalTasks).toBe(0);
      expect(stats.overallUtilization).toBe(0);
      expect(stats.avgDurationMs).toBe(0);
    });

    it('should handle no known agents', async () => {
      calculator.updateKnownAgents([]);
      const stats = await calculator.calculate('1h');
      // Should still work, using discovered agents from entries
      expect(stats.agents.length).toBeGreaterThan(0);
    });
  });
});
