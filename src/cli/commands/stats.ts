/**
 * aco stats — 资源利用率统计
 * FR-Z02 AC1: stats 子命令
 */

import { hasFlag, getFlagValue } from '../parse-args.js';
import { createAuditQuery, createStatsCalculator, loadFileConfig, formatTable, formatDuration, formatPercent } from './shared.js';

const HELP = `
aco stats — 资源利用率统计

Usage:
  aco stats                     显示 24h 统计概览
  aco stats --period <period>   指定统计周期（1h/24h/7d）
  aco stats agents              按 Agent 维度展示

Options:
  --help              显示帮助
  --json              JSON 格式输出
  --period <period>   统计周期：1h, 24h, 7d（默认 24h）

Examples:
  aco stats
  aco stats --period 7d
  aco stats agents --period 1h --json
`.trim();

type Period = '1h' | '24h' | '7d';

export async function statsCommand(args: string[]): Promise<number> {
  if (hasFlag(args, 'help')) {
    console.log(HELP);
    return 0;
  }

  const jsonOutput = hasFlag(args, 'json');
  const periodStr = (getFlagValue(args, 'period') ?? '24h') as Period;
  const subcommand = args.find(a => !a.startsWith('--'));

  if (!['1h', '24h', '7d'].includes(periodStr)) {
    console.error(`Error [STATS_INVALID_PERIOD]: Invalid period '${periodStr}'.`);
    console.error('Suggestion: Use 1h, 24h, or 7d.');
    return 1;
  }

  const fileConfig = await loadFileConfig();
  const knownAgents = (fileConfig.pool?.agents ?? []).map(a => a.agentId).filter((id): id is string => !!id);
  const auditQuery = createAuditQuery();
  const calculator = createStatsCalculator(auditQuery, knownAgents);

  const stats = await calculator.calculate(periodStr);

  if (subcommand === 'agents') {
    return showAgentStats(stats.agents, jsonOutput);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(stats, null, 2));
    return 0;
  }

  console.log(`Resource Utilization — Period: ${stats.period}`);
  console.log('─'.repeat(50));
  console.log(`  Total tasks:       ${stats.totalTasks}`);
  console.log(`  Succeeded:         ${stats.succeededTasks}`);
  console.log(`  Failed:            ${stats.failedTasks}`);
  console.log(`  Retried:           ${stats.retriedTasks}`);
  console.log(`  Avg duration:      ${formatDuration(stats.avgDurationMs)}`);
  console.log(`  Utilization:       ${formatPercent(stats.overallUtilization)}`);
  console.log(`  Active agents:     ${stats.agents.length}`);

  if (stats.agents.length > 0) {
    console.log('\nTop agents by task count:');
    const sorted = [...stats.agents].sort((a, b) => b.totalTasks - a.totalTasks).slice(0, 5);
    const headers = ['Agent', 'Tasks', 'Failed', 'Avg Duration', 'Busy Rate'];
    const rows = sorted.map(a => [
      a.agentId,
      String(a.totalTasks),
      String(a.failedCount),
      formatDuration(a.avgDurationMs),
      formatPercent(a.busyRate),
    ]);
    console.log(formatTable(headers, rows));
  }

  return 0;
}

function showAgentStats(agents: Array<{
  agentId: string;
  completedCount: number;
  failedCount: number;
  totalTasks: number;
  avgDurationMs: number;
  failureRate: number;
  busyRate: number;
  tierUpgradeCount: number;
}>, json: boolean): number {
  if (json) {
    console.log(JSON.stringify(agents, null, 2));
    return 0;
  }

  if (agents.length === 0) {
    console.log('No agent activity in this period.');
    return 0;
  }

  const headers = ['Agent', 'Completed', 'Failed', 'Failure Rate', 'Avg Duration', 'Busy Rate', 'Tier Upgrades'];
  const rows = agents.map(a => [
    a.agentId,
    String(a.completedCount),
    String(a.failedCount),
    formatPercent(a.failureRate),
    formatDuration(a.avgDurationMs),
    formatPercent(a.busyRate),
    String(a.tierUpgradeCount),
  ]);
  console.log(formatTable(headers, rows));
  return 0;
}
