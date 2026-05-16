/**
 * AuditLogger - 审计日志 JSONL 落盘
 * FR-E01: 调度审计日志
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AuditEntry {
  timestamp: string;
  eventType: string;
  taskId?: string;
  agentId?: string;
  details?: Record<string, unknown>;
}

export interface AuditLoggerConfig {
  filePath: string;
  enabled?: boolean;
}

export class AuditLogger {
  private readonly config: Required<AuditLoggerConfig>;
  private writeQueue = Promise.resolve();
  private initialized = false;

  constructor(config: AuditLoggerConfig) {
    this.config = {
      filePath: config.filePath,
      enabled: config.enabled ?? true,
    };
  }

  log(entry: AuditEntry): void {
    if (!this.config.enabled) return;
    this.writeQueue = this.writeQueue.then(async () => {
      await this.ensureDir();
      const line = JSON.stringify(entry) + '\n';
      await appendFile(this.config.filePath, line, 'utf-8');
    }).catch(() => {});
  }

  logDispatch(taskId: string, agentId: string, details?: Record<string, unknown>): void {
    this.log({
      timestamp: new Date().toISOString(),
      eventType: 'task.dispatched',
      taskId,
      agentId,
      details,
    });
  }

  logComplete(taskId: string, agentId: string, details?: Record<string, unknown>): void {
    this.log({
      timestamp: new Date().toISOString(),
      eventType: 'task.completed',
      taskId,
      agentId,
      details,
    });
  }

  logFail(taskId: string, agentId: string, details?: Record<string, unknown>): void {
    this.log({
      timestamp: new Date().toISOString(),
      eventType: 'task.failed',
      taskId,
      agentId,
      details,
    });
  }

  logRetry(taskId: string, agentId: string, details?: Record<string, unknown>): void {
    this.log({
      timestamp: new Date().toISOString(),
      eventType: 'task.retry',
      taskId,
      agentId,
      details,
    });
  }

  logHealthAlert(agentId: string, alertType: string, details?: Record<string, unknown>): void {
    this.log({
      timestamp: new Date().toISOString(),
      eventType: 'health.alert',
      agentId,
      details: { alertType, ...details },
    });
  }

  logNotification(eventType: string, details?: Record<string, unknown>): void {
    this.log({
      timestamp: new Date().toISOString(),
      eventType: `notification.${eventType}`,
      details,
    });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  getFilePath(): string {
    return this.config.filePath;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  private async ensureDir(): Promise<void> {
    if (this.initialized) return;
    const dir = dirname(this.config.filePath);
    await mkdir(dir, { recursive: true });
    this.initialized = true;
  }
}
