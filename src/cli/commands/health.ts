/**
 * aco health — 健康检查 + Agent 健康仪表盘
 * FR-Z02 AC1: health 子命令
 * FR-G04: 全局健康仪表盘
 */

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { hasFlag } from '../parse-args.js';
import { getDataDir, getConfigPath, fileExists, loadFileConfig } from './shared.js';

const HELP = `
aco health — 健康检查与 Agent 健康仪表盘

Usage:
  aco health              执行完整健康检查
  aco health --quick      仅检查核心组件
  aco health --agents     显示 Agent 健康状态（FR-G04）

Options:
  --help    显示帮助
  --json    JSON 格式输出
  --quick   快速检查模式
  --agents  显示 Agent 级健康详情

Checks:
  - 配置文件存在性与合法性
  - 数据目录可写性
  - 审计日志可访问性
  - Agent 池配置完整性
  - 通知通道配置
  - Agent 健康状态（--agents）

Examples:
  aco health
  aco health --json
  aco health --agents
`.trim();

interface HealthCheck {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
}

/** FR-G04 AC1: Agent health info for CLI display */
interface AgentHealthDisplay {
  agentId: string;
  status: string;
  tier: string;
  lastHeartbeat: string;
  failureCount: number;
  healthScore: number;
}

export async function healthCommand(args: string[]): Promise<number> {
  if (hasFlag(args, 'help')) {
    console.log(HELP);
    return 0;
  }

  const jsonOutput = hasFlag(args, 'json');
  const quick = hasFlag(args, 'quick');
  const showAgents = hasFlag(args, 'agents');

  const checks: HealthCheck[] = [];

  // Check 1: Config file
  const configPath = getConfigPath();
  if (await fileExists(configPath)) {
    try {
      const config = await loadFileConfig();
      checks.push({ name: 'Config file', status: 'ok', message: `Found at ${configPath}` });
    } catch (err) {
      checks.push({ name: 'Config file', status: 'error', message: `Invalid JSON: ${(err as Error).message}` });
    }
  } else {
    checks.push({ name: 'Config file', status: 'warn', message: 'No config file (using defaults)' });
  }

  // Check 2: Data directory
  const dataDir = getDataDir();
  try {
    await access(dataDir);
    checks.push({ name: 'Data directory', status: 'ok', message: dataDir });
  } catch {
    checks.push({ name: 'Data directory', status: 'warn', message: `Not found: ${dataDir} (will be created on first use)` });
  }

  // Check 3: Audit log
  const auditPath = join(dataDir, 'audit.jsonl');
  if (await fileExists(auditPath)) {
    checks.push({ name: 'Audit log', status: 'ok', message: auditPath });
  } else {
    checks.push({ name: 'Audit log', status: 'warn', message: 'No audit log yet (created on first event)' });
  }

  let agentHealthData: AgentHealthDisplay[] = [];

  if (!quick) {
    // Check 4: Agent pool config
    try {
      const config = await loadFileConfig();
      const agents = config.pool?.agents ?? [];
      if (agents.length > 0) {
        checks.push({ name: 'Agent pool', status: 'ok', message: `${agents.length} agent(s) configured` });

        // FR-G04 AC1: Build agent health display data
        if (showAgents) {
          agentHealthData = agents.map((a) => ({
            agentId: a.agentId ?? 'unknown',
            status: 'configured',
            tier: a.tier ?? 'T4',
            lastHeartbeat: 'N/A (static config)',
            failureCount: 0,
            healthScore: 100,
          }));
        }
      } else {
        checks.push({ name: 'Agent pool', status: 'warn', message: 'No agents configured in pool' });
      }

      // Check 5: Notification channels
      const channels = config.notification?.channels ?? [];
      if (channels.length > 0) {
        checks.push({ name: 'Notification', status: 'ok', message: `${channels.length} channel(s) configured` });
      } else {
        checks.push({ name: 'Notification', status: 'warn', message: 'No notification channels configured' });
      }

      // Check 6: Dispatch rules
      const rules = config.governance?.rules ?? [];
      if (rules.length > 0) {
        checks.push({ name: 'Dispatch rules', status: 'ok', message: `${rules.length} rule(s) defined` });
      } else {
        checks.push({ name: 'Dispatch rules', status: 'warn', message: 'No dispatch rules (using default policy)' });
      }
    } catch {
      // Config already reported as error above
    }
  }

  // Output
  if (jsonOutput) {
    const output: Record<string, unknown> = {
      checks,
      overall: getOverall(checks),
    };
    if (showAgents && agentHealthData.length > 0) {
      output.agents = agentHealthData;
    }
    console.log(JSON.stringify(output, null, 2));
    return checks.some(c => c.status === 'error') ? 1 : 0;
  }

  const statusIcon = { ok: '✓', warn: '⚠', error: '✗' };
  console.log('ACO Health Check');
  console.log('─'.repeat(50));

  for (const check of checks) {
    console.log(`  ${statusIcon[check.status]} ${check.name}: ${check.message}`);
  }

  // FR-G04 AC1: Display agent health table
  if (showAgents && agentHealthData.length > 0) {
    console.log('');
    console.log('Agent Health Status');
    console.log('─'.repeat(50));
    console.log(
      '  ' +
      'Agent'.padEnd(16) +
      'Tier'.padEnd(6) +
      'Status'.padEnd(14) +
      'Score'.padEnd(8) +
      'Failures'
    );
    console.log('  ' + '─'.repeat(48));
    for (const agent of agentHealthData) {
      const scoreStr = `${agent.healthScore}/100`;
      console.log(
        '  ' +
        agent.agentId.padEnd(16) +
        agent.tier.padEnd(6) +
        agent.status.padEnd(14) +
        scoreStr.padEnd(8) +
        String(agent.failureCount)
      );
    }
  }

  const overall = getOverall(checks);
  console.log('─'.repeat(50));
  console.log(`Overall: ${overall.toUpperCase()}`);

  if (overall === 'error') {
    console.log('\nSuggestion: Fix errors above, then run "aco health" again.');
  }

  return overall === 'error' ? 1 : 0;
}

function getOverall(checks: HealthCheck[]): 'ok' | 'warn' | 'error' {
  if (checks.some(c => c.status === 'error')) return 'error';
  if (checks.some(c => c.status === 'warn')) return 'warn';
  return 'ok';
}
