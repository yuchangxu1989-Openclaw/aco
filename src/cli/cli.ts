/**
 * ACO CLI — 统一命令行入口
 * FR-Z02: CLI 入口
 *
 * 子命令：board, stats, audit, chain, notify, health, config
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AuditQuery } from '../audit-query/audit-query.js';
import { StatsCalculator } from '../stats/stats-calculator.js';
import { chainCommand } from './commands/chain.js';
import { notifyCommand } from './commands/notify.js';
import { healthCommand } from './commands/health.js';
import { configCommand } from './commands/config.js';
import { taskCommand } from './commands/task.js';
import { poolCommand } from './commands/pool.js';
import { ruleCommand } from './commands/rule.js';
import { initCommand } from './commands/init.js';
import { dispatchCommand } from './commands/dispatch.js';

// --- Arg parsing helpers ---

function getFlag(argv: string[], flag: string): boolean {
  return argv.includes(`--${flag}`);
}

function getFlagVal(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(`--${flag}`);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  const val = argv[idx + 1];
  if (val.startsWith('--')) return undefined;
  return val;
}

function getPositionals(argv: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      // skip flag value if present
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) i++;
      continue;
    }
    result.push(argv[i]);
  }
  return result;
}

// --- Paths ---

function getDataDir(): string {
  return process.env.ACO_DATA_DIR ?? join(process.cwd(), '.aco');
}

function getBoardPath(): string {
  return process.env.ACO_BOARD_PATH ?? join(getDataDir(), 'board.json');
}

function getAuditPath(): string {
  return join(getDataDir(), 'audit.jsonl');
}

// --- Formatting ---

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

// --- Help ---

const HELP = `ACO — Agent Controlled Orchestration v0.2.0

Usage: aco <command> [options]

Commands:
  init        初始化项目（生成配置文件 + 数据目录）
  dispatch    派发任务到 Agent（通过宿主适配器）
  task        任务管理（查看/取消/重试）
  board       任务看板（实时状态聚合视图）
  pool        Agent 池管理（查看/同步状态）
  rule        调度规则管理（查看/启用/禁用）
  chain       任务链管理
  stats       资源利用率统计
  audit       决策溯源查询
  config      配置管理
  notify      通知管理
  health      健康检查

Global Options:
  --help      显示帮助
  --version   显示版本号

Run 'aco <command> --help' for command-specific help.`;

// --- Main ---

export async function main(argv: string[]): Promise<number> {
  if (getFlag(argv, 'version')) {
    console.log('0.2.0');
    return 0;
  }

  const positionals = getPositionals(argv);
  const command = positionals[0];

  if (!command || command === 'help') {
    console.log(HELP);
    return 0;
  }

  switch (command) {
    case 'board':
      if (getFlag(argv, 'help')) { console.log(HELP); return 0; }
      return await cmdBoard(argv);
    case 'stats':
      if (getFlag(argv, 'help')) { console.log(HELP); return 0; }
      return await cmdStats(argv);
    case 'audit':
      if (getFlag(argv, 'help')) { console.log(HELP); return 0; }
      return await cmdAudit(argv);
    case 'chain':
      return await chainCommand(argv.slice(argv.indexOf('chain') + 1));
    case 'notify':
      return await notifyCommand(argv.slice(argv.indexOf('notify') + 1));
    case 'health':
      return await healthCommand(argv.slice(argv.indexOf('health') + 1));
    case 'config':
      return await configCommand(argv.slice(argv.indexOf('config') + 1));
    case 'init':
      return await initCommand(argv.slice(argv.indexOf('init') + 1));
    case 'dispatch':
      return await dispatchCommand(argv.slice(argv.indexOf('dispatch') + 1));
    case 'task':
      return await taskCommand(argv.slice(argv.indexOf('task') + 1));
    case 'pool':
      return await poolCommand(argv.slice(argv.indexOf('pool') + 1));
    case 'rule':
      return await ruleCommand(argv.slice(argv.indexOf('rule') + 1));
    default:
      console.error(`Error [ACO_UNKNOWN_CMD]: Unknown command '${command}'`);
      console.error(`Run 'aco --help' for available commands.`);
      return 1;
  }
}

// --- Board Command (FR-E02) ---

interface BoardTask {
  taskId: string;
  label: string;
  status: string;
  agentId: string;
  priority: number;
  timeoutSeconds: number;
  createdAt: number;
  updatedAt: number;
  retryCount: number;
  maxRetries: number;
}

async function loadBoardTasks(): Promise<BoardTask[]> {
  try {
    const raw = await readFile(getBoardPath(), 'utf-8');
    return JSON.parse(raw) as BoardTask[];
  } catch {
    return [];
  }
}

function renderBoard(tasks: BoardTask[], jsonOutput: boolean): string {
  if (tasks.length === 0) {
    return 'No active tasks.';
  }

  if (jsonOutput) {
    return JSON.stringify(tasks, null, 2);
  }

  // Table format
  const now = Date.now();
  const lines: string[] = [];
  lines.push(`Task Board (${tasks.length} tasks)`);
  lines.push('─'.repeat(80));
  lines.push(
    padR('Task ID', 20) + padR('Label', 20) + padR('Agent', 12) +
    padR('Status', 10) + padR('Priority', 8) + 'Elapsed'
  );
  lines.push('─'.repeat(80));

  for (const t of tasks) {
    const elapsed = formatDuration(now - t.createdAt);
    lines.push(
      padR(t.taskId, 20) + padR(t.label, 20) + padR(t.agentId ?? '-', 12) +
      padR(t.status, 10) + padR(String(t.priority), 8) + elapsed
    );
  }

  return lines.join('\n');
}

async function cmdBoard(argv: string[]): Promise<number> {
  const jsonOutput = getFlag(argv, 'json');
  const statusFilter = getFlagVal(argv, 'status');
  const agentFilter = getFlagVal(argv, 'agent');
  const watch = getFlag(argv, 'watch');

  const applyFilters = (tasks: BoardTask[]): BoardTask[] => {
    let filtered = tasks;
    if (statusFilter) {
      filtered = filtered.filter(t => t.status === statusFilter);
    }
    if (agentFilter) {
      filtered = filtered.filter(t => t.agentId === agentFilter);
    }
    return filtered;
  };

  if (watch) {
    // FR-E02 AC5: watch 模式，每 5 秒刷新
    const render = async () => {
      process.stdout.write('\x1B[2J\x1B[H');
      const tasks = applyFilters(await loadBoardTasks());
      console.log(renderBoard(tasks, jsonOutput));
      console.log('\n[Watch mode — refreshing every 5s. Press Ctrl+C to exit]');
    };

    await render();
    const timer = setInterval(render, 5000);

    process.on('SIGINT', () => {
      clearInterval(timer);
      process.exit(0);
    });

    // Keep process alive
    await new Promise(() => {});
    return 0;
  }

  const tasks = applyFilters(await loadBoardTasks());
  console.log(renderBoard(tasks, jsonOutput));
  return 0;
}

// --- Stats Command (FR-E03) ---

type Period = '1h' | '24h' | '7d';

async function cmdStats(argv: string[]): Promise<number> {
  const jsonOutput = getFlag(argv, 'json');
  const periodStr = getFlagVal(argv, 'period') ?? '24h';
  const positionals = getPositionals(argv);
  const subcommand = positionals[1]; // e.g. 'agents'

  if (!['1h', '24h', '7d'].includes(periodStr)) {
    console.error(`Error [STATS_INVALID_PERIOD]: Invalid period '${periodStr}'. Use 1h, 24h, or 7d.`);
    return 1;
  }

  const auditQuery = new AuditQuery({
    filePath: getAuditPath(),
    retentionDays: 30,
  });

  const calculator = new StatsCalculator(auditQuery, { knownAgents: [] });
  const stats = await calculator.calculate(periodStr as Period);

  if (subcommand === 'agents') {
    if (jsonOutput) {
      console.log(JSON.stringify(stats.agents, null, 2));
      return 0;
    }
    if (stats.agents.length === 0) {
      console.log('No agent activity in this period.');
      return 0;
    }
    const lines: string[] = [];
    lines.push(`Agent Stats — ${stats.period}`);
    lines.push('─'.repeat(70));
    for (const a of stats.agents) {
      lines.push(`  ${a.agentId}: ${a.completedCount} completed, ${a.failedCount} failed, busy ${formatPercent(a.busyRate)}`);
    }
    console.log(lines.join('\n'));
    return 0;
  }

  if (jsonOutput) {
    console.log(JSON.stringify(stats, null, 2));
    return 0;
  }

  if (stats.totalTasks === 0 && stats.agents.length === 0) {
    console.log('No agent activity in this period.');
    return 0;
  }

  const lines: string[] = [];
  lines.push(`Resource Utilization — ${stats.period}`);
  lines.push('─'.repeat(50));
  lines.push(`  Total tasks:    ${stats.totalTasks}`);
  lines.push(`  Succeeded:      ${stats.succeededTasks}`);
  lines.push(`  Failed:         ${stats.failedTasks}`);
  lines.push(`  Retried:        ${stats.retriedTasks}`);
  lines.push(`  Avg duration:   ${formatDuration(stats.avgDurationMs)}`);
  lines.push(`  Utilization:    ${formatPercent(stats.overallUtilization)}`);
  if (stats.agents.length > 0) {
    lines.push('');
    lines.push('  Agents:');
    for (const a of stats.agents) {
      lines.push(`    ${a.agentId}: ${a.completedCount}✓ ${a.failedCount}✗ busy:${formatPercent(a.busyRate)}`);
    }
  }
  console.log(lines.join('\n'));
  return 0;
}

// --- Audit Command (FR-E04) ---

async function cmdAudit(argv: string[]): Promise<number> {
  const jsonOutput = getFlag(argv, 'json');
  const agentFilter = getFlagVal(argv, 'agent');
  const sinceStr = getFlagVal(argv, 'since');
  const limitStr = getFlagVal(argv, 'limit');
  const limit = limitStr ? parseInt(limitStr, 10) : 50;

  const positionals = getPositionals(argv);
  // positionals[0] = 'audit', positionals[1] = taskId (if any)
  const taskId = positionals[1];

  const auditQuery = new AuditQuery({
    filePath: getAuditPath(),
    retentionDays: 30,
  });

  const since = sinceStr ? Date.now() - parseDuration(sinceStr) : undefined;

  let entries = await auditQuery.query({
    taskId,
    agentId: agentFilter,
    since,
  });

  entries = entries.slice(-limit);

  if (jsonOutput) {
    // FR-E04 AC4: JSON output with full details
    if (taskId) {
      // Include retry attempt summary for task-specific queries
      const retryAttempts = extractRetryAttempts(entries);
      const totalDurationMs = entries.length >= 2
        ? new Date(entries[entries.length - 1].timestamp).getTime() - new Date(entries[0].timestamp).getTime()
        : undefined;
      console.log(JSON.stringify({ taskId, entries, retryAttempts, totalDurationMs }, null, 2));
    } else {
      console.log(JSON.stringify(entries, null, 2));
    }
    return 0;
  }

  if (entries.length === 0) {
    console.log(taskId
      ? `No audit entries found for task '${taskId}'.`
      : 'No audit entries found matching the filter.');
    return 0;
  }

  const lines: string[] = [];
  if (taskId) {
    lines.push(`Decision trace for task: ${taskId}`);
    lines.push('─'.repeat(60));
  }

  for (const e of entries) {
    const time = e.timestamp.includes('T') ? e.timestamp.slice(11, 19) : e.timestamp;
    const agent = e.agentId ?? '-';
    const detail = e.details ? summarizeDetails(e.details) : '';
    lines.push(`  ${time}  ${padR(e.eventType, 20)} ${padR(agent, 10)} ${detail}`);
  }

  // FR-E04 AC3: Show retry attempts if task had retries
  if (taskId) {
    const retryAttempts = extractRetryAttempts(entries);
    if (retryAttempts.length > 0) {
      lines.push('');
      lines.push('Retry Attempts:');
      lines.push('─'.repeat(40));
      for (const attempt of retryAttempts) {
        let line = `  #${attempt.attemptNumber}`;
        if (attempt.agentId) line += ` agent=${attempt.agentId}`;
        if (attempt.tier) line += ` tier=${attempt.tier}`;
        if (attempt.durationMs !== undefined) line += ` duration=${formatDuration(attempt.durationMs)}`;
        if (attempt.failureReason) line += ` reason="${attempt.failureReason}"`;
        lines.push(line);
      }
    }
  }

  lines.push(`\n${entries.length} entries.`);
  console.log(lines.join('\n'));
  return 0;
}

// --- FR-E04 AC3: Retry attempt extraction ---

interface RetryAttempt {
  attemptNumber: number;
  agentId?: string;
  tier?: string;
  durationMs?: number;
  failureReason?: string;
  timestamp: string;
}

function extractRetryAttempts(entries: Array<{ eventType: string; agentId?: string; timestamp: string; details?: Record<string, unknown> }>): RetryAttempt[] {
  const attempts: RetryAttempt[] = [];
  let attemptNumber = 0;

  for (const entry of entries) {
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

  return attempts;
}

// --- Helpers ---

function padR(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

function parseDuration(dur: string): number {
  const match = dur.match(/^(\d+)(h|d|m)$/);
  if (!match) return 24 * 60 * 60 * 1000;
  const [, num, unit] = match;
  const n = parseInt(num, 10);
  switch (unit) {
    case 'h': return n * 60 * 60 * 1000;
    case 'd': return n * 24 * 60 * 60 * 1000;
    case 'm': return n * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}

function summarizeDetails(details: Record<string, unknown>): string {
  const parts: string[] = [];
  if (details.durationMs) parts.push(formatDuration(details.durationMs as number));
  if (details.reason) parts.push(String(details.reason));
  if (details.tier) parts.push(`tier:${details.tier}`);
  if (parts.length === 0) {
    const keys = Object.keys(details).slice(0, 2);
    return keys.map(k => `${k}:${String(details[k]).slice(0, 15)}`).join(' ');
  }
  return parts.join(' | ');
}
