/**
 * aco failures — 失败根因追踪查询
 * FR-B07 AC5: CLI 查询入口，支持按 agentId / taskType / failureMode / 时间范围过滤
 */

import { hasFlag, getFlagValue, parseArgs } from '../parse-args.js';
import { getDataDir, formatTable, formatDuration, formatPercent } from './shared.js';
import { EventBus } from '../../event/event-bus.js';
import { FailureTracker } from '../../stats/failure-tracker.js';
import { FailureAggregator } from '../../stats/failure-aggregator.js';
import type { FailureMode } from '../../types/index.js';
import { join } from 'node:path';

const HELP = `
aco failures — 失败根因追踪查询

Usage:
  aco failures                      显示失败概览
  aco failures list                 列出失败记录
  aco failures heatmap              显示失败率热力图
  aco failures report <agentId>     生成 Agent 失败分析报告

Options:
  --help                  显示帮助
  --json                  JSON 格式输出
  --agent <agentId>       按 Agent 过滤
  --type <taskType>       按任务类型过滤
  --mode <failureMode>    按失败模式过滤（zero-output/timeout/error-output/no-file-written/crash）
  --since <duration>      时间范围起点（如 1h, 24h, 7d）
  --limit <n>             限制输出条数（默认 20）

Examples:
  aco failures
  aco failures list --agent cc --since 24h
  aco failures heatmap --json
  aco failures report cc
  aco failures list --mode timeout --type code
`.trim();

const VALID_MODES: FailureMode[] = ['zero-output', 'timeout', 'error-output', 'no-file-written', 'crash'];

export async function failuresCommand(args: string[]): Promise<number> {
  if (hasFlag(args, 'help')) {
    console.log(HELP);
    return 0;
  }

  // Parse args properly: separate positional args from flag values
  const parsed = parseArgs(args);
  const subcommand = parsed.command; // First positional arg is the subcommand

  const jsonOutput = hasFlag(args, 'json');
  const agentFilter = getFlagValue(args, 'agent');
  const typeFilter = getFlagValue(args, 'type');
  const modeFilter = getFlagValue(args, 'mode') as FailureMode | undefined;
  const sinceStr = getFlagValue(args, 'since');
  const limitStr = getFlagValue(args, 'limit');
  const limit = limitStr ? parseInt(limitStr, 10) : 20;

  // Validate failure mode filter
  if (modeFilter && !VALID_MODES.includes(modeFilter)) {
    console.error(`Error [FAILURES_INVALID_MODE]: Invalid failure mode '${modeFilter}'.`);
    console.error(`Valid modes: ${VALID_MODES.join(', ')}`);
    return 1;
  }

  // Parse since duration
  let since: number | undefined;
  if (sinceStr) {
    since = Date.now() - parseDuration(sinceStr);
  }

  // Initialize tracker and load data
  const dataDir = getDataDir();
  const eventBus = new EventBus();
  const tracker = new FailureTracker(eventBus, {
    dataFilePath: join(dataDir, 'failures.jsonl'),
  });
  await tracker.loadFromFile();

  const records = tracker.getRecords({
    agentId: agentFilter,
    taskType: typeFilter,
    failureMode: modeFilter,
    since,
  });

  switch (subcommand) {
    case 'list':
      return showList(records, limit, jsonOutput);
    case 'heatmap':
      return showHeatmap(records, jsonOutput);
    case 'report':
      return showReport(args, tracker, jsonOutput);
    default:
      return showOverview(records, jsonOutput);
  }
}

function showOverview(
  records: Array<{
    failureId: string;
    agentId: string;
    taskId: string;
    taskType: string;
    failureMode: FailureMode;
    faultType?: string;
    timestamp: number;
  }>,
  json: boolean,
): number {
  const aggregator = new FailureAggregator();
  const summary = aggregator.getSummary(records as any);

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  console.log('Failure Tracking Overview');
  console.log('─'.repeat(50));
  console.log(`  Total failures:      ${summary.totalFailures}`);
  console.log(`  Unique agents:       ${summary.uniqueAgents}`);
  console.log(`  Unique task types:   ${summary.uniqueTaskTypes}`);

  if (summary.topFailingAgents.length > 0) {
    console.log('\nTop failing agents:');
    const headers = ['Agent', 'Failures'];
    const rows = summary.topFailingAgents.map(a => [a.agentId, String(a.count)]);
    console.log(formatTable(headers, rows));
  }

  if (summary.topFailingTaskTypes.length > 0) {
    console.log('\nTop failing task types:');
    const headers = ['Task Type', 'Failures'];
    const rows = summary.topFailingTaskTypes.map(t => [t.taskType, String(t.count)]);
    console.log(formatTable(headers, rows));
  }

  if (records.length === 0) {
    console.log('\nNo failure records found.');
  }

  return 0;
}

function showList(
  records: Array<{
    failureId: string;
    agentId: string;
    taskId: string;
    taskType: string;
    failureMode: FailureMode;
    promptSummary: string;
    durationMs: number;
    outputTokens: number;
    faultType?: string;
    repairSuggestions: string[];
    timestamp: number;
  }>,
  limit: number,
  json: boolean,
): number {
  const limited = records.slice(-limit).reverse();

  if (json) {
    console.log(JSON.stringify(limited, null, 2));
    return 0;
  }

  if (limited.length === 0) {
    console.log('No failure records match the filter.');
    return 0;
  }

  console.log(`Failure Records (showing ${limited.length} of ${records.length}):`);
  console.log('─'.repeat(80));

  const headers = ['Time', 'Agent', 'Type', 'Mode', 'Fault', 'Duration', 'Tokens'];
  const rows = limited.map(r => [
    new Date(r.timestamp).toISOString().slice(5, 16).replace('T', ' '),
    r.agentId,
    r.taskType,
    r.failureMode,
    r.faultType ?? '?',
    formatDuration(r.durationMs),
    String(r.outputTokens),
  ]);

  console.log(formatTable(headers, rows));
  return 0;
}

function showHeatmap(
  records: Array<{
    agentId: string;
    taskType: string;
    failureMode: FailureMode;
    timestamp: number;
  }>,
  json: boolean,
): number {
  const aggregator = new FailureAggregator();
  const heatmap = aggregator.generateHeatmap(records as any);

  if (json) {
    console.log(JSON.stringify(heatmap, null, 2));
    return 0;
  }

  if (heatmap.length === 0) {
    console.log('No data for heatmap.');
    return 0;
  }

  console.log('Failure Rate Heatmap (Agent × Task Type):');
  console.log('─'.repeat(70));

  const headers = ['Agent', 'Task Type', 'Failure Rate', 'Attempts', 'Dominant Mode'];
  const rows = heatmap.map(cell => [
    cell.agentId,
    cell.taskType,
    formatPercent(cell.failureRate),
    String(cell.totalAttempts),
    cell.dominantFailureMode ?? '-',
  ]);

  console.log(formatTable(headers, rows));
  return 0;
}

function showReport(args: string[], tracker: FailureTracker, json: boolean): number {
  // Find agentId after 'report' subcommand
  const reportIdx = args.indexOf('report');
  const agentId = reportIdx >= 0 ? args[reportIdx + 1] : undefined;

  if (!agentId || agentId.startsWith('--')) {
    console.error('Error [FAILURES_NO_AGENT]: Please specify an agentId for the report.');
    console.error('Usage: aco failures report <agentId>');
    return 1;
  }

  const report = tracker.generateCircuitBreakReport(agentId);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  console.log(`Failure Analysis Report: ${agentId}`);
  console.log('─'.repeat(50));

  if (report.recentFailures.length === 0) {
    console.log('  No failure records for this agent.');
    return 0;
  }

  console.log(`  Recent failures:         ${report.recentFailures.length}`);
  console.log(`  Dominant failure mode:    ${report.dominantFailureMode ?? 'N/A'}`);
  console.log(`  Dominant fault type:      ${report.dominantFaultType ?? 'N/A'}`);
  console.log(`  Suggested recovery:       ${report.suggestedRecovery.join(', ') || 'N/A'}`);

  console.log('\nRecent failure timeline:');
  const headers = ['Time', 'Task Type', 'Mode', 'Fault', 'Duration'];
  const rows = report.recentFailures.slice(-5).map(r => [
    new Date(r.timestamp).toISOString().slice(5, 16).replace('T', ' '),
    r.taskType,
    r.failureMode,
    r.faultType ?? '?',
    formatDuration(r.durationMs),
  ]);
  console.log(formatTable(headers, rows));

  return 0;
}

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
