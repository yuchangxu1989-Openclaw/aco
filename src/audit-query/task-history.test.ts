import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskHistory } from './task-history.js';
import { AuditQuery } from './audit-query.js';
import { AuditLogger } from '../audit-logger/audit-logger.js';
import { unlink } from 'node:fs/promises';

const testFilePath = '/tmp/aco-test-history-' + Date.now() + '.jsonl';

describe('TaskHistory (FR-E04)', () => {
  let auditQuery: AuditQuery;
  let logger: AuditLogger;
  let taskHistory: TaskHistory;

  beforeEach(async () => {
    logger = new AuditLogger({ filePath: testFilePath });
    auditQuery = new AuditQuery({ filePath: testFilePath, retentionDays: 30 });
    taskHistory = new TaskHistory(auditQuery);
  });

  afterEach(async () => {
    try {
      await unlink(testFilePath);
    } catch { /* ignore */ }
  });

  describe('getHistory (FR-E04 AC1)', () => {
    it('should return all state changes for a task from creation to completion', async () => {
      // Simulate task lifecycle
      logger.log({
        timestamp: new Date('2026-05-06T10:00:00Z').toISOString(),
        eventType: 'task.dispatched',
        taskId: 'task-abc',
        agentId: 'cc',
        details: { tier: 'T1' },
      });
      logger.log({
        timestamp: new Date('2026-05-06T10:05:00Z').toISOString(),
        eventType: 'task.completed',
        taskId: 'task-abc',
        agentId: 'cc',
        details: { durationMs: 300000 },
      });
      await logger.flush();

      const result = await taskHistory.getHistory('task-abc');

      expect(result.taskId).toBe('task-abc');
      expect(result.entries.length).toBe(2);
      expect(result.entries[0].eventType).toBe('task.dispatched');
      expect(result.entries[0].agentId).toBe('cc');
      expect(result.entries[1].eventType).toBe('task.completed');
      expect(result.entries[1].durationMs).toBe(300000);
    });

    it('should return entries sorted by timestamp ascending', async () => {
      // Write out of order
      logger.log({
        timestamp: new Date('2026-05-06T10:05:00Z').toISOString(),
        eventType: 'task.completed',
        taskId: 'task-sort',
        agentId: 'cc',
      });
      logger.log({
        timestamp: new Date('2026-05-06T10:00:00Z').toISOString(),
        eventType: 'task.dispatched',
        taskId: 'task-sort',
        agentId: 'cc',
      });
      await logger.flush();

      const result = await taskHistory.getHistory('task-sort');
      expect(result.entries[0].eventType).toBe('task.dispatched');
      expect(result.entries[1].eventType).toBe('task.completed');
    });

    it('should return empty entries for unknown task', async () => {
      const result = await taskHistory.getHistory('nonexistent');
      expect(result.entries).toHaveLength(0);
      expect(result.retryAttempts).toHaveLength(0);
    });
  });

  describe('state change details (FR-E04 AC2)', () => {
    it('should include timestamp, state change, trigger reason, and audit event ID', async () => {
      logger.log({
        timestamp: new Date('2026-05-06T10:00:00Z').toISOString(),
        eventType: 'task.state_change',
        taskId: 'task-detail',
        agentId: 'cc',
        details: {
          from: 'queued',
          to: 'running',
          reason: 'dispatched_to_cc',
          eventId: 'evt-123',
        },
      });
      await logger.flush();

      const result = await taskHistory.getHistory('task-detail');
      const entry = result.entries[0];

      expect(entry.timestamp).toBe('2026-05-06T10:00:00.000Z');
      expect(entry.stateChange).toEqual({ from: 'queued', to: 'running' });
      expect(entry.triggerReason).toBe('dispatched_to_cc');
      expect(entry.auditEventId).toBe('evt-123');
    });
  });

  describe('retry attempts (FR-E04 AC3)', () => {
    it('should extract retry attempts with agentId, tier, duration, failure reason', async () => {
      // First attempt - dispatched and failed
      logger.log({
        timestamp: new Date('2026-05-06T10:00:00Z').toISOString(),
        eventType: 'task.dispatched',
        taskId: 'task-retry',
        agentId: 'dev-01',
        details: { tier: 'T4' },
      });
      logger.log({
        timestamp: new Date('2026-05-06T10:10:00Z').toISOString(),
        eventType: 'task.failed',
        taskId: 'task-retry',
        agentId: 'dev-01',
        details: { durationMs: 600000, reason: 'timeout' },
      });
      // Retry
      logger.log({
        timestamp: new Date('2026-05-06T10:10:01Z').toISOString(),
        eventType: 'task.retry',
        taskId: 'task-retry',
        agentId: 'dev-01',
        details: { tier: 'T3', retryCount: 1, reason: 'tier_upgrade' },
      });
      // Second attempt - dispatched and succeeded
      logger.log({
        timestamp: new Date('2026-05-06T10:10:02Z').toISOString(),
        eventType: 'task.dispatched',
        taskId: 'task-retry',
        agentId: 'hermes',
        details: { tier: 'T3' },
      });
      logger.log({
        timestamp: new Date('2026-05-06T10:15:00Z').toISOString(),
        eventType: 'task.completed',
        taskId: 'task-retry',
        agentId: 'hermes',
        details: { durationMs: 298000 },
      });
      await logger.flush();

      const result = await taskHistory.getHistory('task-retry');

      expect(result.entries.length).toBe(5);
      expect(result.retryAttempts.length).toBe(1);

      const attempt = result.retryAttempts[0];
      expect(attempt.attemptNumber).toBe(1);
      expect(attempt.agentId).toBe('dev-01');
      expect(attempt.tier).toBe('T3');
      expect(attempt.failureReason).toBe('tier_upgrade');
    });

    it('should handle multiple retries', async () => {
      logger.log({
        timestamp: new Date('2026-05-06T10:00:00Z').toISOString(),
        eventType: 'task.dispatched',
        taskId: 'task-multi',
        agentId: 'dev-01',
      });
      logger.log({
        timestamp: new Date('2026-05-06T10:05:00Z').toISOString(),
        eventType: 'task.failed',
        taskId: 'task-multi',
        agentId: 'dev-01',
        details: { reason: 'timeout' },
      });
      logger.log({
        timestamp: new Date('2026-05-06T10:05:01Z').toISOString(),
        eventType: 'task.retry',
        taskId: 'task-multi',
        agentId: 'dev-01',
        details: { tier: 'T3', reason: 'tier_upgrade' },
      });
      logger.log({
        timestamp: new Date('2026-05-06T10:10:00Z').toISOString(),
        eventType: 'task.failed',
        taskId: 'task-multi',
        agentId: 'hermes',
        details: { reason: 'substantive_failure' },
      });
      logger.log({
        timestamp: new Date('2026-05-06T10:10:01Z').toISOString(),
        eventType: 'task.retry',
        taskId: 'task-multi',
        agentId: 'hermes',
        details: { tier: 'T2', reason: 'tier_upgrade' },
      });
      await logger.flush();

      const result = await taskHistory.getHistory('task-multi');
      expect(result.retryAttempts.length).toBe(2);
      expect(result.retryAttempts[0].attemptNumber).toBe(1);
      expect(result.retryAttempts[1].attemptNumber).toBe(2);
    });
  });

  describe('output formats (FR-E04 AC4)', () => {
    it('should format as JSON', async () => {
      logger.log({
        timestamp: new Date('2026-05-06T10:00:00Z').toISOString(),
        eventType: 'task.dispatched',
        taskId: 'task-json',
        agentId: 'cc',
        details: { tier: 'T1' },
      });
      await logger.flush();

      const result = await taskHistory.getHistory('task-json');
      const json = taskHistory.formatJson(result);
      const parsed = JSON.parse(json);

      expect(parsed.taskId).toBe('task-json');
      expect(parsed.entries).toBeInstanceOf(Array);
      expect(parsed.entries[0].eventType).toBe('task.dispatched');
    });

    it('should format as human-readable table', async () => {
      logger.log({
        timestamp: new Date('2026-05-06T10:00:00Z').toISOString(),
        eventType: 'task.dispatched',
        taskId: 'task-table',
        agentId: 'cc',
        details: { tier: 'T1' },
      });
      logger.log({
        timestamp: new Date('2026-05-06T10:05:00Z').toISOString(),
        eventType: 'task.completed',
        taskId: 'task-table',
        agentId: 'cc',
        details: { durationMs: 300000 },
      });
      await logger.flush();

      const result = await taskHistory.getHistory('task-table');
      const table = taskHistory.formatTable(result);

      expect(table).toContain('Task History: task-table');
      expect(table).toContain('task.dispatched');
      expect(table).toContain('task.completed');
      expect(table).toContain('agent=cc');
      expect(table).toContain('duration=300000ms');
    });

    it('should show "No history found" for empty result', async () => {
      const result = await taskHistory.getHistory('nonexistent');
      const table = taskHistory.formatTable(result);
      expect(table).toContain('No history found');
    });
  });

  describe('total duration', () => {
    it('should calculate total duration from first to last event', async () => {
      logger.log({
        timestamp: new Date('2026-05-06T10:00:00Z').toISOString(),
        eventType: 'task.dispatched',
        taskId: 'task-dur',
        agentId: 'cc',
      });
      logger.log({
        timestamp: new Date('2026-05-06T10:05:00Z').toISOString(),
        eventType: 'task.completed',
        taskId: 'task-dur',
        agentId: 'cc',
      });
      await logger.flush();

      const result = await taskHistory.getHistory('task-dur');
      expect(result.totalDurationMs).toBe(300000); // 5 minutes
    });
  });
});
