/**
 * CLI 共享工具：配置加载、格式化输出
 */

import { readFile, access } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { EventBus } from '../../event/event-bus.js';
import { ConfigManager } from '../../config/config-manager.js';
import { AuditQuery } from '../../audit-query/audit-query.js';
import { StatsCalculator } from '../../stats/stats-calculator.js';
import { NotificationManager } from '../../notification/notification-manager.js';
import { getBuiltinTransports } from '../../notification/transports/index.js';
import type { AcoFileConfig } from '../../config/config-schema.js';

export function getDataDir(): string {
  return process.env.ACO_DATA_DIR ?? resolve(process.cwd(), '.aco');
}

export function getConfigPath(): string {
  // Support both JSON and YAML config files
  const jsonPath = resolve(process.cwd(), 'aco.config.json');
  const yamlPath = resolve(process.cwd(), 'aco.config.yaml');
  const ymlPath = resolve(process.cwd(), 'aco.config.yml');
  // Default to JSON; actual resolution happens in loadFileConfig
  return process.env.ACO_CONFIG_PATH ?? jsonPath;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadFileConfig(): Promise<AcoFileConfig> {
  // Try JSON, YAML, YML in order
  const candidates = [
    resolve(process.cwd(), 'aco.config.json'),
    resolve(process.cwd(), 'aco.config.yaml'),
    resolve(process.cwd(), 'aco.config.yml'),
  ];

  for (const configPath of candidates) {
    if (!(await fileExists(configPath))) continue;
    const content = await readFile(configPath, 'utf-8');
    const ext = extname(configPath);
    if (ext === '.yaml' || ext === '.yml') {
      return parseYaml(content) as AcoFileConfig;
    }
    return JSON.parse(content) as AcoFileConfig;
  }

  return {};
}

export function createEventBus(): EventBus {
  return new EventBus();
}

export function createConfigManager(eventBus: EventBus): ConfigManager {
  return new ConfigManager(eventBus, { configPath: getConfigPath() });
}

export function createAuditQuery(): AuditQuery {
  const dataDir = getDataDir();
  return new AuditQuery({
    filePath: join(dataDir, 'audit.jsonl'),
    retentionDays: 30,
  });
}

export function createStatsCalculator(auditQuery: AuditQuery, knownAgents: string[]): StatsCalculator {
  return new StatsCalculator(auditQuery, { knownAgents });
}

export function createNotificationManager(eventBus: EventBus): NotificationManager {
  const manager = new NotificationManager(eventBus);
  // Register built-in transports
  for (const [type, transport] of getBuiltinTransports()) {
    manager.registerTransport(type, transport);
  }
  return manager;
}

/** 格式化表格输出 */
export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => {
    const colValues = [h, ...rows.map(r => r[i] ?? '')];
    return Math.max(...colValues.map(v => v.length));
  });

  const sep = widths.map(w => '─'.repeat(w + 2)).join('┼');
  const headerLine = headers.map((h, i) => ` ${h.padEnd(widths[i])} `).join('│');
  const dataLines = rows.map(row =>
    row.map((cell, i) => ` ${(cell ?? '').padEnd(widths[i])} `).join('│')
  );

  return [headerLine, sep, ...dataLines].join('\n');
}

/** 格式化持续时间 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

/** 格式化百分比 */
export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}
