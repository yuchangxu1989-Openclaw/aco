/**
 * aco chain — 任务链管理
 * FR-Z02 AC1: chain 子命令
 * FR-D04: chain status 子命令（链路可视化）
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hasFlag, getFlagValue } from '../parse-args.js';
import { getDataDir, fileExists, formatTable, createEventBus } from './shared.js';
import { ChainExecutor } from '../../chain/chain-executor.js';
import { ChainVisualizer } from '../../chain/chain-visualizer.js';

interface ChainDef {
  chainId: string;
  name: string;
  description?: string;
  steps: ChainStepDef[];
  createdAt: string;
}

interface ChainStepDef {
  label: string;
  promptTemplate: string;
  agentId?: string;
  targetTier?: string;
  timeoutSeconds?: number;
  condition?: string;
}

const HELP = `
aco chain — 任务链管理

Usage:
  aco chain list                列出所有已定义的链
  aco chain show <chainId>      查看链详情
  aco chain create <name>       创建新链（交互式或从 JSON）
  aco chain delete <chainId>    删除链
  aco chain status <execId>     查看链路执行状态
  aco chain status --active     查看所有运行中的链路
  aco chain status --history    查看历史执行记录

Options:
  --help          显示帮助
  --json          JSON 格式输出
  --file <path>   从 JSON 文件导入链定义
  --name <name>   链名称
  --desc <desc>   链描述
  --limit <n>     历史记录数量限制（默认 10）

Examples:
  aco chain list
  aco chain create "dev-audit" --file chain-def.json
  aco chain show dev-audit-001
  aco chain status exec-abc123
  aco chain status --active --json
`.trim();

async function getChainsPath(): Promise<string> {
  const dir = getDataDir();
  await mkdir(dir, { recursive: true });
  return join(dir, 'chains.json');
}

async function loadChains(): Promise<ChainDef[]> {
  const path = await getChainsPath();
  if (!(await fileExists(path))) return [];
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as ChainDef[];
}

async function saveChains(chains: ChainDef[]): Promise<void> {
  const path = await getChainsPath();
  await writeFile(path, JSON.stringify(chains, null, 2), 'utf-8');
}

export async function chainCommand(args: string[]): Promise<number> {
  if (hasFlag(args, 'help') || args.length === 0) {
    console.log(HELP);
    return 0;
  }

  const subcommand = args[0];
  const jsonOutput = hasFlag(args, 'json');

  switch (subcommand) {
    case 'list':
      return await listChains(jsonOutput);
    case 'show':
      return await showChain(args[1], jsonOutput);
    case 'create':
      return await createChain(args.slice(1));
    case 'delete':
      return await deleteChain(args[1]);
    case 'status':
      return await chainStatus(args.slice(1), jsonOutput);
    default:
      console.error(`Error [CHAIN_UNKNOWN_CMD]: Unknown subcommand '${subcommand}'`);
      console.error(`Suggestion: Run 'aco chain --help' for usage.`);
      return 1;
  }
}

async function listChains(json: boolean): Promise<number> {
  const chains = await loadChains();

  if (json) {
    console.log(JSON.stringify(chains, null, 2));
    return 0;
  }

  if (chains.length === 0) {
    console.log('No chains defined. Use "aco chain create" to create one.');
    return 0;
  }

  const headers = ['Chain ID', 'Name', 'Steps', 'Created'];
  const rows = chains.map(c => [
    c.chainId,
    c.name,
    String(c.steps.length),
    c.createdAt.slice(0, 10),
  ]);
  console.log(formatTable(headers, rows));
  return 0;
}

async function showChain(chainId: string | undefined, json: boolean): Promise<number> {
  if (!chainId) {
    console.error('Error [CHAIN_MISSING_ID]: Please specify a chain ID.');
    console.error('Suggestion: Run "aco chain list" to see available chains.');
    return 1;
  }

  const chains = await loadChains();
  const chain = chains.find(c => c.chainId === chainId);

  if (!chain) {
    console.error(`Error [CHAIN_NOT_FOUND]: Chain '${chainId}' not found.`);
    console.error('Suggestion: Run "aco chain list" to see available chains.');
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(chain, null, 2));
    return 0;
  }

  console.log(`Chain: ${chain.name} (${chain.chainId})`);
  if (chain.description) console.log(`Description: ${chain.description}`);
  console.log(`Created: ${chain.createdAt}`);
  console.log(`Steps (${chain.steps.length}):`);
  chain.steps.forEach((step, i) => {
    console.log(`  ${i + 1}. ${step.label}`);
    if (step.agentId) console.log(`     Agent: ${step.agentId}`);
    if (step.targetTier) console.log(`     Tier: ${step.targetTier}`);
    if (step.timeoutSeconds) console.log(`     Timeout: ${step.timeoutSeconds}s`);
    if (step.condition) console.log(`     Condition: ${step.condition}`);
  });
  return 0;
}

async function createChain(args: string[]): Promise<number> {
  const filePath = getFlagValue(args, 'file');
  const name = getFlagValue(args, 'name') ?? args.find(a => !a.startsWith('--'));
  const desc = getFlagValue(args, 'desc');

  if (!name && !filePath) {
    console.error('Error [CHAIN_MISSING_NAME]: Please provide a chain name or --file.');
    console.error('Suggestion: aco chain create "my-chain" --file chain.json');
    return 1;
  }

  let steps: ChainStepDef[] = [];

  if (filePath) {
    if (!(await fileExists(filePath))) {
      console.error(`Error [CHAIN_FILE_NOT_FOUND]: File '${filePath}' not found.`);
      return 1;
    }
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      steps = parsed;
    } else if (parsed.steps) {
      steps = parsed.steps;
    }
  }

  const chains = await loadChains();
  const chainId = `${(name ?? 'chain').replace(/\s+/g, '-').toLowerCase()}-${Date.now().toString(36)}`;

  const newChain: ChainDef = {
    chainId,
    name: name ?? chainId,
    description: desc,
    steps,
    createdAt: new Date().toISOString(),
  };

  chains.push(newChain);
  await saveChains(chains);

  console.log(`✓ Chain created: ${chainId}`);
  console.log(`  Name: ${newChain.name}`);
  console.log(`  Steps: ${steps.length}`);
  return 0;
}

async function deleteChain(chainId: string | undefined): Promise<number> {
  if (!chainId) {
    console.error('Error [CHAIN_MISSING_ID]: Please specify a chain ID to delete.');
    return 1;
  }

  const chains = await loadChains();
  const idx = chains.findIndex(c => c.chainId === chainId);

  if (idx === -1) {
    console.error(`Error [CHAIN_NOT_FOUND]: Chain '${chainId}' not found.`);
    return 1;
  }

  chains.splice(idx, 1);
  await saveChains(chains);
  console.log(`✓ Chain '${chainId}' deleted.`);
  return 0;
}

/**
 * FR-D04: chain status 子命令
 * 展示链路执行状态（tree 或 JSON 格式）
 */
async function chainStatus(args: string[], jsonOutput: boolean): Promise<number> {
  const showActive = hasFlag(args, 'active');
  const showHistory = hasFlag(args, 'history');
  const limitStr = getFlagValue(args, 'limit');
  const limit = limitStr ? parseInt(limitStr, 10) : 10;

  // 获取 executionId（第一个非 flag 参数）
  const executionId = args.find(a => !a.startsWith('--'));

  // 创建 ChainExecutor 实例（从运行时状态读取）
  const eventBus = createEventBus();
  const executor = new ChainExecutor(eventBus);
  const visualizer = new ChainVisualizer(executor);

  // 查看特定执行
  if (executionId) {
    const view = visualizer.getExecutionView(executionId);
    if (!view) {
      console.error(`Error [CHAIN_EXEC_NOT_FOUND]: Execution '${executionId}' not found.`);
      console.error('Suggestion: Run "aco chain status --active" or "aco chain status --history" to see available executions.');
      return 1;
    }

    if (jsonOutput) {
      console.log(visualizer.renderJson(view));
    } else {
      console.log(visualizer.renderTree(view));
    }
    return 0;
  }

  // 列出执行记录
  let filter: { status?: 'running' | 'paused' | 'succeeded' | 'failed'; limit?: number } | undefined;

  if (showActive) {
    filter = { status: 'running', limit };
  } else if (showHistory) {
    filter = { limit };
  } else {
    // 默认显示所有
    filter = { limit };
  }

  const executions = visualizer.listExecutions(filter);

  if (executions.length === 0) {
    if (showActive) {
      console.log('No active chain executions.');
    } else {
      console.log('No chain executions found.');
    }
    return 0;
  }

  if (jsonOutput) {
    console.log(JSON.stringify(executions, null, 2));
    return 0;
  }

  // Table output for list view
  const headers = ['Execution ID', 'Chain', 'Status', 'Nodes', 'Duration', 'Parent Task'];
  const rows = executions.map(e => [
    e.executionId.slice(0, 12) + '...',
    e.chainName,
    e.status,
    `${e.completedNodes}/${e.totalNodes}`,
    formatChainDuration(e.durationMs),
    e.parentTaskId.slice(0, 12) + '...',
  ]);
  console.log(formatTable(headers, rows));
  return 0;
}

/** Duration 格式化 for chain status */
function formatChainDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`;
}
