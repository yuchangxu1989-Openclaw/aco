/**
 * TaskHistory - 决策溯源
 * FR-E04: 对任意任务，可追溯其完整调度历史
 */

import type { AuditEntry } from '../audit-logger/audit-logger.js';
import type { AuditQuery } from './audit-query.js';

export interface TaskHistoryEntry {
  timestamp: string;
  eventType: string;
  stateChange?: { from?: string; to?: string };
  triggerReason?: string;
  auditEventId?: string;
  agentId?: string;
  tier?: string;
  durationMs?: number;
  failureReason?: string;
  details?: Record<string, unknown>;
}

export interface TaskHistoryResult {
  taskId: string;
  entries: TaskHistoryEntry[];
  retryAttempts: RetryAttempt[];
  totalDurationMs?: number;
}

export interface RetryAttempt {
  attemptNumber: number;
  agentId?: string;
  tier?: string;
  durationMs?: number;
  failureReason?: string;
  timestamp: string;
}

export class TaskHistory {
  private auditQuery: AuditQuery;

  constructor(auditQuery: AuditQuery) {
    this.auditQuery = auditQuery;
  }

  /**
   * FR-E04 AC1: 展示该任务从创建到终态的所有状态变更和调度决策
   * FR-E04 AC2: 每条记录包含时间戳、状态变更、触发原因、关联的 Audit Event ID
   * FR-E04 AC3: 若任务经历过重试，展示每次尝试的 agentId、Tier、耗时、失败原因
   */
  async getHistory(taskId: string): Promise<TaskHistoryResult> {
    const entries = await this.auditQuery.query({ taskId });

    // Sort by timestamp ascending
    entries.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const historyEntries: TaskHistoryEntry[] = entries.map(e => this.toHistoryEntry(e));
    const retryAttempts = this.extractRetryAttempts(entries);

    // Calculate total duration from first to last event
    let totalDurationMs: number | undefined;
    if (entries.length >= 2) {
      const first = new Date(entries[0].timestamp).getTime();
      const last = new Date(entries[entries.length - 1].timestamp).getTime();
      totalDurationMs = last - first;
    }

    return {
      taskId,
      entries: historyEntries,
      retryAttempts,
      totalDurationMs,
    };
  }

  /**
   * FR-E04 AC4: 输出支持 JSON 格式
   */
  formatJson(result: TaskHistoryResult): string {
    return JSON.stringify(result, null, 2);
  }

  /**
   * Format as human-readable table
   */
  formatTable(result: TaskHistoryResult): string {
    if (result.entries.length === 0) {
      return `No history found for task ${result.taskId}`;
    }

    const lines: string[] = [];
    lines.push(`Task History: ${result.taskId}`);
    lines.push('═'.repeat(60));
    lines.push('');

    for (const entry of result.entries) {
      const time = entry.timestamp.replace('T', ' ').replace(/\.\d+Z$/, '');
      let line = `[${time}] ${entry.eventType}`;

      if (entry.stateChange) {
        line += ` (${entry.stateChange.from ?? '?'} → ${entry.stateChange.to ?? '?'})`;
      }

      if (entry.agentId) {
        line += ` agent=${entry.agentId}`;
      }

      if (entry.tier) {
        line += ` tier=${entry.tier}`;
      }

      if (entry.triggerReason) {
        line += ` reason="${entry.triggerReason}"`;
      }

      if (entry.durationMs !== undefined) {
        line += ` duration=${entry.durationMs}ms`;
      }

      if (entry.failureReason) {
        line += ` failure="${entry.failureReason}"`;
      }

      lines.push(line);
    }

    if (result.retryAttempts.length > 0) {
      lines.push('');
      lines.push('Retry Attempts:');
      lines.push('─'.repeat(40));
      for (const attempt of result.retryAttempts) {
        let line = `  #${attempt.attemptNumber}`;
        if (attempt.agentId) line += ` agent=${attempt.agentId}`;
        if (attempt.tier) line += ` tier=${attempt.tier}`;
        if (attempt.durationMs !== undefined) line += ` duration=${attempt.durationMs}ms`;
        if (attempt.failureReason) line += ` failure="${attempt.failureReason}"`;
        lines.push(line);
      }
    }

    if (result.totalDurationMs !== undefined) {
      lines.push('');
      lines.push(`Total duration: ${result.totalDurationMs}ms`);
    }

    return lines.join('\n');
  }

  private toHistoryEntry(entry: AuditEntry): TaskHistoryEntry {
    const result: TaskHistoryEntry = {
      timestamp: entry.timestamp,
      eventType: entry.eventType,
      agentId: entry.agentId,
    };

    if (entry.details) {
      // State change info
      if (entry.details.from || entry.details.to) {
        result.stateChange = {
          from: entry.details.from as string | undefined,
          to: entry.details.to as string | undefined,
        };
      }

      // Trigger reason
      if (entry.details.reason) {
        result.triggerReason = entry.details.reason as string;
      }

      // Audit event ID
      if (entry.details.eventId) {
        result.auditEventId = entry.details.eventId as string;
      }

      // Tier info
      if (entry.details.tier) {
        result.tier = String(entry.details.tier);
      }

      // Duration
      if (entry.details.durationMs !== undefined) {
        result.durationMs = entry.details.durationMs as number;
      }

      // Failure reason
      if (entry.details.failureReason) {
        result.failureReason = entry.details.failureReason as string;
      }

      // Keep full details for JSON output
      result.details = entry.details;
    }

    return result;
  }

  /**
   * FR-E04 AC3: 提取重试尝试信息
   */
  private extractRetryAttempts(entries: AuditEntry[]): RetryAttempt[] {
    const attempts: RetryAttempt[] = [];
    let attemptNumber = 0;

    for (const entry of entries) {
      if (entry.eventType === 'task.retry' || entry.eventType === 'task.failed') {
        if (entry.eventType === 'task.failed' && attemptNumber === 0 && !entries.some(e => e.eventType === 'task.retry')) {
          // Single failure without retry, skip
          continue;
        }

        if (entry.eventType === 'task.retry') {
          attemptNumber++;
          attempts.push({
            attemptNumber,
            agentId: entry.agentId,
            tier: entry.details?.tier as string | undefined,
            durationMs: entry.details?.durationMs as number | undefined,
            failureReason: entry.details?.reason as string | undefined,
            timestamp: entry.timestamp,
          });
        }
      }
    }

    return attempts;
  }
}
