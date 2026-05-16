/**
 * aco audit — 决策溯源查询
 * FR-Z02 AC1: audit 子命令
 */

import { hasFlag, getFlagValue } from '../parse-args.js';
import { createAuditQuery, formatTable, formatDuration } from './shared.js';

const HELP = `
aco audit — 决策溯源查询

Usage:
  aco audit <taskId>            查询指定任务的完整决策链
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

Examples:
  aco audit task-abc123
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
  const agentId = getFlagValue(args, 'agent');
  const eventType = getFlagValue(args, 'type');
  const sinceStr = getFlagValue(args, 'since');
  const limitStr = getFlagValue(args, 'limit');
  const limit = limitStr ? parseInt(limitStr, 10) : 50;

  // First positional arg is taskId
  const taskId = args.find(a => !a.startsWith('--'));

  const auditQuery = createAuditQuery();

  const since = sinceStr ? Date.now() - parseDuration(sinceStr) : undefined;

  const entries = await auditQuery.query({
    taskId,
    agentId,
    eventType,
    since,
  });

  const limited = entries.slice(-limit);

  if (jsonOutput) {
    console.log(JSON.stringify(limited, null, 2));
    return 0;
  }

  if (limited.length === 0) {
    if (taskId) {
      console.log(`No audit entries found for task '${taskId}'.`);
    } else {
      console.log('No audit entries found matching the filter.');
    }
    console.log('Hint: Audit log path: .aco/audit.jsonl');
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
