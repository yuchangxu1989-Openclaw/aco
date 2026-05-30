/**
 * aco audit — 决策溯源查询
 * FR-Z02 AC1: audit 子命令
 */

import { hasFlag, getFlagValue } from '../parse-args.js';
import { join } from 'node:path';
import { readKillImpactReports, type KillImpactReport, type KillImpactScanResult } from '../../control/kill-impact-scan.js';
import { createAuditQuery, formatTable, formatDuration } from './shared.js';
import { detectEnvironment } from './init.js';

const HELP = `
aco audit — 决策溯源查询

Usage:
  aco audit <taskId>            查询指定任务的完整决策链
  aco audit kill-impact         查询 kill 后置影响扫描报告
  aco audit --agent <agentId>   查询指定 Agent 的审计记录
  aco audit --type <eventType>  按事件类型过滤
  aco audit --since <duration>  时间范围过滤（如 1h, 24h, 7d）

Options:
  --help            显示帮助
  --json            JSON 格式输出
  --agent <id>      按 Agent 过滤
  --type <type>     按事件类型过滤（task.dispatched, task.completed, task.failed 等）
  --since <dur>     时间范围（1h/24h/7d）
  --limit <n>       最多显示条数（默认 50）
  --last <n>        kill-impact 最近 N 条（默认 20）
  --risk <level>    kill-impact 按 low/medium/high 过滤
  --session <key>   kill-impact 按 sessionKey 过滤
  --verbose         kill-impact 展开完整文件与看板列表

Examples:
  aco audit task-abc123
  aco audit async-discipline --since 24h
  aco audit kill-impact --last 20 --risk high --verbose
  aco audit --agent cc --since 24h
  aco audit --type task.failed --limit 10
`.trim();

function parseDuration(dur: string): number {
  const match = dur.match(/^(\d+)(h|d|m)$/);
  if (!match) return 24 * 60 * 60 * 1000; // default 24h
  const [, num, unit] = match;
  const n = parseInt(num, 10);
  switch (unit) {
    case 'h': return n * 60 * 60 * 1000;
    case 'd': return n * 24 * 60 * 60 * 1000;
    case 'm': return n * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}

export async function auditCommand(args: string[]): Promise<number> {
  if (hasFlag(args, 'help')) {
    console.log(HELP);
    return 0;
  }

  const jsonOutput = hasFlag(args, 'json');
  const taskId = args.find(a => !a.startsWith('--'));
  if (taskId === 'kill-impact') {
    return await auditKillImpactCommand(args.filter(arg => arg !== 'kill-impact'), jsonOutput);
  }

  const agentId = getFlagValue(args, 'agent');
  const eventType = getFlagValue(args, 'type');
  const sinceStr = getFlagValue(args, 'since');
  const limitStr = getFlagValue(args, 'limit');
  const limit = limitStr ? parseInt(limitStr, 10) : 50;

  // First positional arg is taskId

  const since = sinceStr ? Date.now() - parseDuration(sinceStr) : undefined;
  const asyncDisciplineMode = taskId === 'async-discipline';
  const asyncDisciplineAuditPath = asyncDisciplineMode ? await getAsyncDisciplineAuditPath() : undefined;
  const auditQuery = createAuditQuery(asyncDisciplineAuditPath);

  const entries = await auditQuery.query({
    taskId: asyncDisciplineMode ? undefined : taskId,
    agentId,
    eventType: asyncDisciplineMode ? 'dispatch.process.async_discipline' : eventType,
    since,
  });

  const limited = entries.slice(-limit);

  if (jsonOutput) {
    if (asyncDisciplineMode) {
      console.log(JSON.stringify({
        summary: summarizeAsyncDiscipline(limited),
        entries: limited,
      }, null, 2));
      return 0;
    }
    console.log(JSON.stringify(limited, null, 2));
    return 0;
  }

  if (limited.length === 0) {
    if (asyncDisciplineMode) {
      console.log('No async discipline audit entries found matching the filter.');
    } else if (taskId) {
      console.log(`No audit entries found for task '${taskId}'.`);
    } else {
      console.log('No audit entries found matching the filter.');
    }
    console.log(asyncDisciplineMode
      ? `Hint: Audit log path: ${auditQuery.getFilePath()}`
      : 'Hint: Audit log path: .aco/audit.jsonl');
    return 0;
  }

  if (asyncDisciplineMode) {
    const summary = summarizeAsyncDiscipline(limited);
    console.log(`Async discipline audit — ${limited.length} entries`);
    console.log(`block=${summary.block} allow=${summary.allow} exempt=${summary.exempt} bypass_disabled=${summary.bypass_disabled} bypass_degraded=${summary.bypass_degraded} recovery_attempt=${summary.recovery_attempt}`);
    console.log(`llmVerdict allow=${summary.llmVerdict_allow} deny=${summary.llmVerdict_deny} timeout=${summary.llmVerdict_timeout} error=${summary.llmVerdict_error} disabled=${summary.llmVerdict_disabled} not_applicable=${summary.llmVerdict_not_applicable}`);
    console.log('─'.repeat(80));
    const headers = ['Time', 'Decision', 'LLM', 'Action', 'Timeout', 'Agent', 'Reason'];
    const rows = limited.map(e => {
      const details = e.details ?? {};
      return [
        e.timestamp.slice(11, 19),
        String(details.decision ?? '-'),
        String(details.llmVerdict ?? '-'),
        String(details.action ?? '-'),
        String(details.timeoutMs ?? '-'),
        e.agentId ?? '-',
        String(details.reason ?? '').slice(0, 48),
      ];
    });
    console.log(formatTable(headers, rows));
    return 0;
  }

  if (taskId) {
    console.log(`Decision trace for task: ${taskId}`);
    console.log('─'.repeat(60));
  }

  const headers = ['Time', 'Event', 'Agent', 'Details'];
  const rows = limited.map(e => [
    e.timestamp.slice(11, 19),
    e.eventType,
    e.agentId ?? '-',
    e.details ? summarizeDetails(e.details) : '-',
  ]);

  console.log(formatTable(headers, rows));
  console.log(`\nShowing ${limited.length} of ${entries.length} entries.`);
  return 0;
}

function summarizeDetails(details: Record<string, unknown>): string {
  const parts: string[] = [];
  if (details.durationMs) parts.push(formatDuration(details.durationMs as number));
  if (details.reason) parts.push(String(details.reason));
  if (details.tier) parts.push(`tier:${details.tier}`);
  if (details.ruleId) parts.push(`rule:${details.ruleId}`);
  if (parts.length === 0) {
    const keys = Object.keys(details).slice(0, 2);
    return keys.map(k => `${k}:${String(details[k]).slice(0, 20)}`).join(' ');
  }
  return parts.join(' | ');
}

function summarizeAsyncDiscipline(entries: Array<{ details?: Record<string, unknown> }>): Record<string, number> {
  const summary: Record<string, number> = {
    block: 0,
    allow: 0,
    exempt: 0,
    bypass_disabled: 0,
    bypass_degraded: 0,
    recovery_attempt: 0,
    llmVerdict_allow: 0,
    llmVerdict_deny: 0,
    llmVerdict_timeout: 0,
    llmVerdict_error: 0,
    llmVerdict_disabled: 0,
    llmVerdict_not_applicable: 0,
  };
  for (const entry of entries) {
    const decision = String(entry.details?.decision ?? 'allow');
    summary[decision] = (summary[decision] ?? 0) + 1;
    const llmVerdict = String(entry.details?.llmVerdict ?? 'not_applicable');
    summary[`llmVerdict_${llmVerdict}`] = (summary[`llmVerdict_${llmVerdict}`] ?? 0) + 1;
  }
  return summary;
}

async function auditKillImpactCommand(args: string[], jsonOutput: boolean): Promise<number> {
  const last = parsePositiveInt(getFlagValue(args, 'last')) ?? 20;
  const risk = getFlagValue(args, 'risk');
  const session = getFlagValue(args, 'session');
  const verbose = hasFlag(args, 'verbose');
  const logPath = join((await detectEnvironment()).openclawHome, 'workspace', 'logs', 'aco-kill-impact.jsonl');
  let records: KillImpactScanResult[] = [];
  try {
    records = readKillImpactReports(logPath);
  } catch (error) {
    console.error(`Failed to read kill impact records: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const filtered = records
    .filter(record => !risk || ('riskLevel' in record && record.riskLevel === risk))
    .filter(record => !session || record.sessionKey === session)
    .slice(-last)
    .reverse();

  if (jsonOutput) {
    console.log(JSON.stringify(filtered, null, 2));
    return 0;
  }
  if (filtered.length === 0) {
    console.log('no kill impact records yet');
    return 0;
  }
  const rows = filtered.map(record => {
    const full = record as Partial<KillImpactReport> & KillImpactScanResult;
    return [
      new Date(record.killAt).toISOString(),
      record.sessionKey,
      full.taskLabel ?? '-',
      full.riskLevel ?? ('scanFailed' in record ? 'failed' : 'disabled'),
      full.recommendedAction ?? '-',
      String(full.affectedFiles?.length ?? 0),
      String(full.affectedBoardEntries?.length ?? 0),
    ];
  });
  console.log(formatTable(['timestamp', 'sessionKey', 'taskLabel', 'riskLevel', 'recommendedAction', 'files', 'board'], rows));
  if (verbose) {
    for (const record of filtered) {
      console.log('─'.repeat(80));
      console.log(JSON.stringify(record, null, 2));
    }
  }
  return 0;
}

function parsePositiveInt(raw?: string): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function getAsyncDisciplineAuditPath(): Promise<string> {
  if (process.env.ACO_ASYNC_DISCIPLINE_AUDIT_PATH) return process.env.ACO_ASYNC_DISCIPLINE_AUDIT_PATH;
  const env = await detectEnvironment();
  return join(env.openclawHome, 'workspace', 'logs', 'dispatch-guard-events.jsonl');
}
