/**
 * aco pool — Agent 池管理
 * FR-Z02 AC1: pool 子命令
 * FR-C01: Agent 注册与发现
 * FR-C04: 资源池状态视图
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hasFlag, getFlagValue } from '../parse-args.js';
import { getDataDir, fileExists, formatTable, formatPercent } from './shared.js';

interface PoolAgent {
  agentId: string;
  tier: string;
  runtimeType: string;
  roles: string[];
  maxConcurrency: number;
  status: string;
  activeTasks: number;
  totalCompleted: number;
  totalFailed: number;
}

const HELP = `
aco pool — Agent 池管理

Usage:
  aco pool status               查看资源池状态（FR-C04）
  aco pool add <agentId>        注册 Agent（FR-C01 AC2）
  aco pool remove <agentId>     移除 Agent
  aco pool sync                 从宿主环境同步 Agent 配置（FR-C01 AC4）

Options:
  --help              显示帮助
  --json              JSON 格式输出
  --tier <T1-T4>      Agent 梯队
  --role <role>       角色标签（coder/auditor/architect/pm/ux）
  --runtime <type>    运行时类型（subagent/acp）
  --concurrency <n>   最大并发数
  --status <s>        按状态筛选（idle/busy/stale/offline）

Examples:
  aco pool status
  aco pool status --tier T2
  aco pool add dev-01 --tier T2 --role coder --runtime subagent
  aco pool sync
`.trim();

function getPoolPath(): string {
  return join(getDataDir(), 'pool.json');
}

async function loadPool(): Promise<PoolAgent[]> {
  const path = getPoolPath();
  if (!(await fileExists(path))) return [];
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as PoolAgent[];
}

async function savePool(pool: PoolAgent[]): Promise<void> {
  const dir = getDataDir();
  await mkdir(dir, { recursive: true });
  const path = getPoolPath();
  await writeFile(path, JSON.stringify(pool, null, 2), 'utf-8');
}

export async function poolCommand(args: string[]): Promise<number> {
  if (hasFlag(args, 'help') || args.length === 0) {
    console.log(HELP);
    return 0;
  }

  const subcommand = args[0];
  const jsonOutput = hasFlag(args, 'json');

  switch (subcommand) {
    case 'status':
      return await poolStatus(args.slice(1), jsonOutput);
    case 'add':
      return await poolAdd(args.slice(1));
    case 'remove':
      return await poolRemove(args[1]);
    case 'sync':
      return await poolSync(jsonOutput);
    default:
      console.error(`Error [POOL_UNKNOWN_CMD]: Unknown subcommand '${subcommand}'`);
      console.error(`Suggestion: Run 'aco pool --help' for usage.`);
      return 1;
  }
}

async function poolStatus(args: string[], json: boolean): Promise<number> {
  let pool = await loadPool();

  const tierFilter = getFlagValue(args, 'tier');
  const roleFilter = getFlagValue(args, 'role');
  const statusFilter = getFlagValue(args, 'status');

  if (tierFilter) pool = pool.filter(a => a.tier === tierFilter);
  if (roleFilter) pool = pool.filter(a => a.roles.includes(roleFilter));
  if (statusFilter) pool = pool.filter(a => a.status === statusFilter);

  if (json) {
    console.log(JSON.stringify(pool, null, 2));
    return 0;
  }

  if (pool.length === 0) {
    console.log('No agents in pool. Use "aco pool add" or "aco pool sync" to register agents.');
    return 0;
  }

  const headers = ['Agent ID', 'Tier', 'Role(s)', 'Status', 'Active', 'Done', 'Failed', 'Rate'];
  const rows = pool.map(a => {
    const total = a.totalCompleted + a.totalFailed;
    const failRate = total > 0 ? formatPercent(a.totalFailed / total) : '-';
    return [
      a.agentId,
      a.tier,
      a.roles.join(','),
      a.status,
      String(a.activeTasks) + '/' + String(a.maxConcurrency),
      String(a.totalCompleted),
      String(a.totalFailed),
      failRate,
    ];
  });
  console.log(formatTable(headers, rows));
  return 0;
}

async function poolAdd(args: string[]): Promise<number> {
  const agentId = args.find(a => !a.startsWith('--'));
  if (!agentId) {
    console.error('Error [POOL_MISSING_ID]: Please specify an agent ID.');
    console.error('Suggestion: aco pool add dev-01 --tier T2 --role coder');
    return 1;
  }

  const tier = getFlagValue(args, 'tier') ?? 'T3';
  const role = getFlagValue(args, 'role') ?? 'coder';
  const runtime = getFlagValue(args, 'runtime') ?? 'subagent';
  const concurrency = parseInt(getFlagValue(args, 'concurrency') ?? '1', 10);

  const validTiers = ['T1', 'T2', 'T3', 'T4'];
  if (!validTiers.includes(tier)) {
    console.error(`Error [POOL_INVALID_TIER]: Invalid tier '${tier}'. Use T1, T2, T3, or T4.`);
    return 1;
  }

  const pool = await loadPool();
  if (pool.find(a => a.agentId === agentId)) {
    console.error(`Error [POOL_DUPLICATE]: Agent '${agentId}' already registered.`);
    console.error('Suggestion: Use "aco pool remove" first, then re-add.');
    return 1;
  }

  const newAgent: PoolAgent = {
    agentId,
    tier,
    runtimeType: runtime,
    roles: role.split(','),
    maxConcurrency: concurrency,
    status: 'idle',
    activeTasks: 0,
    totalCompleted: 0,
    totalFailed: 0,
  };

  pool.push(newAgent);
  await savePool(pool);
  console.log(`✓ Agent '${agentId}' registered (tier=${tier}, role=${role}, runtime=${runtime}).`);
  return 0;
}

async function poolRemove(agentId: string | undefined): Promise<number> {
  if (!agentId) {
    console.error('Error [POOL_MISSING_ID]: Please specify an agent ID to remove.');
    return 1;
  }

  const pool = await loadPool();
  const idx = pool.findIndex(a => a.agentId === agentId);

  if (idx === -1) {
    console.error(`Error [POOL_NOT_FOUND]: Agent '${agentId}' not found in pool.`);
    console.error('Suggestion: Run "aco pool status" to see registered agents.');
    return 1;
  }

  pool.splice(idx, 1);
  await savePool(pool);
  console.log(`✓ Agent '${agentId}' removed from pool.`);
  return 0;
}

async function poolSync(json: boolean): Promise<number> {
  // Try to read openclaw.json for agent discovery (FR-C01 AC1/AC4)
  const openclawPaths = [
    join(process.cwd(), 'openclaw.json'),
    join(process.env.HOME ?? '', '.openclaw', 'openclaw.json'),
    '/root/.openclaw/openclaw.json',
  ];

  let agentsList: Array<{ id: string; model?: string }> = [];
  let foundPath = '';

  for (const p of openclawPaths) {
    if (await fileExists(p)) {
      try {
        const content = await readFile(p, 'utf-8');
        const config = JSON.parse(content);
        if (config.agents?.list) {
          agentsList = config.agents.list.map((a: { id: string; model?: string }) => ({
            id: a.id,
            model: a.model,
          }));
          foundPath = p;
          break;
        }
      } catch { /* skip */ }
    }
  }

  if (agentsList.length === 0) {
    console.log('No host environment agents found. Register manually with "aco pool add".');
    return 0;
  }

  const pool = await loadPool();
  let added = 0;

  for (const agent of agentsList) {
    if (pool.find(a => a.agentId === agent.id)) continue;

    pool.push({
      agentId: agent.id,
      tier: 'T3',
      runtimeType: 'subagent',
      roles: ['coder'],
      maxConcurrency: 1,
      status: 'idle',
      activeTasks: 0,
      totalCompleted: 0,
      totalFailed: 0,
    });
    added++;
  }

  await savePool(pool);

  if (json) {
    console.log(JSON.stringify({ source: foundPath, total: agentsList.length, added }, null, 2));
    return 0;
  }

  console.log(`✓ Synced from ${foundPath}`);
  console.log(`  Total agents discovered: ${agentsList.length}`);
  console.log(`  Newly added: ${added}`);
  console.log(`  Already registered: ${agentsList.length - added}`);
  return 0;
}
