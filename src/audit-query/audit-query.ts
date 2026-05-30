/**
 * AuditQuery - 审计日志查询
 * FR-E01/E04: 审计日志查询与决策溯源
 */

import { readFile } from 'node:fs/promises';
import type { AuditEntry } from '../audit-logger/audit-logger.js';

export interface AuditQueryConfig {
  filePath: string;
  retentionDays: number;
}

export interface QueryFilter {
  eventType?: string | string[];
  agentId?: string;
  taskId?: string;
  since?: number; // timestamp ms
  until?: number; // timestamp ms
}

export class AuditQuery {
  private readonly config: AuditQueryConfig;

  constructor(config: AuditQueryConfig) {
    this.config = config;
  }

  /**
   * Query audit entries matching the filter
   */
  async query(filter?: QueryFilter): Promise<AuditEntry[]> {
    let content: string;
    try {
      content = await readFile(this.config.filePath, 'utf-8');
    } catch {
      return [];
    }

    const lines = content.trim().split('\n').filter(Boolean);
    let entries: AuditEntry[] = lines.map(line => {
      try {
        return JSON.parse(line) as AuditEntry;
      } catch {
        return null;
      }
    }).filter((e): e is AuditEntry => e !== null);

    // Apply retention
    const retentionCutoff = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
    entries = entries.filter(e => new Date(e.timestamp).getTime() >= retentionCutoff);

    if (!filter) return entries;

    if (filter.eventType) {
      const types = Array.isArray(filter.eventType) ? filter.eventType : [filter.eventType];
      entries = entries.filter(e => types.includes(e.eventType));
    }

    if (filter.agentId) {
      entries = entries.filter(e => e.agentId === filter.agentId);
    }

    if (filter.taskId) {
      entries = entries.filter(e => e.taskId === filter.taskId);
    }

    if (filter.since) {
      entries = entries.filter(e => new Date(e.timestamp).getTime() >= filter.since!);
    }

    if (filter.until) {
      entries = entries.filter(e => new Date(e.timestamp).getTime() <= filter.until!);
    }

    return entries;
  }

  /**
   * Get entries for a specific period
   */
  async queryPeriod(periodMs: number): Promise<AuditEntry[]> {
    const since = Date.now() - periodMs;
    return this.query({ since });
  }

  getFilePath(): string {
    return this.config.filePath;
  }
}
