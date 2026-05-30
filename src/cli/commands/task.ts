/**
 * aco task — 任务管理
 * FR-Z02 AC1: task 子命令
 * FR-A05: 任务取消
 * FR-E04 AC1: 任务历史
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasFlag, getFlagValue } from '../parse-args.js';
import { getDataDir, fileExists, formatTable, formatDuration } from './shared.js';

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
  failureReason?: string;
  targetTier?: string;
}

const HELP = `
aco task — 任务管理

Usage:
  aco task list                 列出所有任务
  aco task show <taskId>        查看任务详情
  aco task cancel <taskId>      取消任务
  aco task retry <taskId>       重试失败的任务
  aco task history <taskId>     查看任务调度历史（FR-E04）

Options:
  --help          显示帮助
  --json          JSON 格式输出
  --status <s>    按状态筛选（queued/running/failed/succeeded/cancelled）
  --agent <id>    按 agentId 筛选
  --label <pat>   按 label 模式筛选

Examples:
  aco task list --status running
  aco task cancel task-abc123
  aco task retry task-abc123
  aco task history task-abc123
`.trim();

function getBoardPath(): string {
  return process.env.ACO_BOARD_PATH ?? join(getDataDir(), 'board.json');
}

async function loadTasks(): Promise<BoardTask[]> {
  const path = getBoardPath();
  if (!(await fileExists(path))) return [];
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as BoardTask[];
}

async function saveTasks(tasks: BoardTask[]): Promise<void> {
  const path = getBoardPath();
  await writeFile(path, JSON.stringify(tasks, null, 2), 'utf-8');
}

export async function taskCommand(args: string[]): Promise<number> {
  if (hasFlag(args, 'help') || args.length === 0) {
    console.log(HELP);
    return 0;
  }

  const subcommand = args[0];
  const jsonOutput = hasFlag(args, 'json');

  switch (subcommand) {
    case 'list':
      return await listTasks(args.slice(1), jsonOutput);
    case 'show':
      return await showTask(args[1], jsonOutput);
    case 'cancel':
      return await cancelTask(args[1]);
    case 'retry':
      return await retryTask(args[1]);
    case 'history':
      return await taskHistory(args[1], jsonOutput);
    default:
      console.error(`Error [TASK_UNKNOWN_CMD]: Unknown subcommand '${subcommand}'`);
      console.error(`Suggestion: Run 'aco task --help' for usage.`);
      return 1;
  }
}

async function listTasks(args: string[], json: boolean): Promise<number> {
  let tasks = await loadTasks();

  const statusFilter = getFlagValue(args, 'status');
  const agentFilter = getFlagValue(args, 'agent');
  const labelFilter = getFlagValue(args, 'label');

  if (statusFilter) tasks = tasks.filter(t => t.status === statusFilter);
  if (agentFilter) tasks = tasks.filter(t => t.agentId === agentFilter);
  if (labelFilter) tasks = tasks.filter(t => t.label.includes(labelFilter));

  if (json) {
    console.log(JSON.stringify(tasks, null, 2));
    return 0;
  }

  if (tasks.length === 0) {
    console.log('No tasks found.');
    return 0;
  }

  const headers = ['Task ID', 'Label', 'Status', 'Agent', 'Priority'];
  const rows = tasks.map(t => [
    t.taskId,
    t.label.slice(0, 25),
    t.status,
    t.agentId ?? '-',
    String(t.priority),
  ]);
  console.log(formatTable(headers, rows));
  return 0;
}

async function showTask(taskId: string | undefined, json: boolean): Promise<number> {
  if (!taskId) {
    console.error('Error [TASK_MISSING_ID]: Please specify a task ID.');
    console.error('Suggestion: Run "aco task list" to see available tasks.');
    return 1;
  }

  const tasks = await loadTasks();
  const task = tasks.find(t => t.taskId === taskId);

  if (!task) {
    console.error(`Error [TASK_NOT_FOUND]: Task '${taskId}' not found.`);
    console.error('Suggestion: Run "aco task list" to see available tasks.');
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(task, null, 2));
    return 0;
  }

  const now = Date.now();
  console.log(`Task: ${task.taskId}`);
  console.log(`  Label:     ${task.label}`);
  console.log(`  Status:    ${task.status}`);
  console.log(`  Agent:     ${task.agentId ?? '-'}`);
  console.log(`  Priority:  ${task.priority}`);
  console.log(`  Timeout:   ${task.timeoutSeconds}s`);
  console.log(`  Retries:   ${task.retryCount}/${task.maxRetries}`);
  console.log(`  Elapsed:   ${formatDuration(now - task.createdAt)}`);
  if (task.targetTier) console.log(`  Tier:      ${task.targetTier}`);
  if (task.failureReason) console.log(`  Failure:   ${task.failureReason}`);
  return 0;
}

async function cancelTask(taskId: string | undefined): Promise<number> {
  if (!taskId) {
    console.error('Error [TASK_MISSING_ID]: Please specify a task ID to cancel.');
    console.error('Suggestion: Run "aco task list --status running" to see active tasks.');
    return 1;
  }

  const tasks = await loadTasks();
  const task = tasks.find(t => t.taskId === taskId);

  if (!task) {
    console.error(`Error [TASK_NOT_FOUND]: Task '${taskId}' not found.`);
    return 1;
  }

  const terminalStates = ['succeeded', 'cancelled'];
  if (terminalStates.includes(task.status)) {
    console.error(`Error [TASK_TERMINAL]: Task '${taskId}' is already in terminal state '${task.status}'.`);
    console.error('Suggestion: Terminal tasks cannot be cancelled.');
    return 1;
  }

  task.status = 'cancelled';
  task.updatedAt = Date.now();
  await saveTasks(tasks);
  console.log(`✓ Task '${taskId}' cancelled.`);
  return 0;
}

async function retryTask(taskId: string | undefined): Promise<number> {
  if (!taskId) {
    console.error('Error [TASK_MISSING_ID]: Please specify a task ID to retry.');
    console.error('Suggestion: Run "aco task list --status failed" to see failed tasks.');
    return 1;
  }

  const tasks = await loadTasks();
  const task = tasks.find(t => t.taskId === taskId);

  if (!task) {
    console.error(`Error [TASK_NOT_FOUND]: Task '${taskId}' not found.`);
    return 1;
  }

  if (task.status !== 'failed') {
    console.error(`Error [TASK_NOT_FAILED]: Task '${taskId}' is in state '${task.status}', only failed tasks can be retried.`);
    return 1;
  }

  if (task.retryCount >= task.maxRetries) {
    console.error(`Error [TASK_MAX_RETRIES]: Task '${taskId}' has exhausted all retries (${task.maxRetries}).`);
    console.error('Suggestion: Increase maxRetries or create a new task.');
    return 1;
  }

  task.status = 'retrying';
  task.retryCount++;
  task.updatedAt = Date.now();
  await saveTasks(tasks);
  console.log(`✓ Task '${taskId}' queued for retry (attempt ${task.retryCount}/${task.maxRetries}).`);
  return 0;
}

async function taskHistory(taskId: string | undefined, json: boolean): Promise<number> {
  if (!taskId) {
    console.error('Error [TASK_MISSING_ID]: Please specify a task ID.');
    console.error('Suggestion: Run "aco task list" to see available tasks.');
    return 1;
  }

  // Read audit log for this task
  const auditPath = join(getDataDir(), 'audit.jsonl');
  if (!(await fileExists(auditPath))) {
    console.log(`No audit history found for task '${taskId}'.`);
    return 0;
  }

  const content = await readFile(auditPath, 'utf-8');
  const entries = content
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((e): e is Record<string, unknown> => e !== null && e.taskId === taskId);

  if (entries.length === 0) {
    console.log(`No audit history found for task '${taskId}'.`);
    return 0;
  }

  if (json) {
    console.log(JSON.stringify(entries, null, 2));
    return 0;
  }

  console.log(`History for task: ${taskId}`);
  console.log('─'.repeat(60));
  for (const e of entries) {
    const ts = typeof e.timestamp === 'number'
      ? new Date(e.timestamp).toISOString().slice(11, 19)
      : String(e.timestamp).slice(11, 19);
    const agent = e.agentId ?? '-';
    const type = String(e.type ?? e.eventType ?? '');
    const reason = (e.details as Record<string, unknown>)?.reason ?? '';
    console.log(`  ${ts}  ${type.padEnd(22)} agent=${agent}  ${reason}`);
  }
  console.log(`\n${entries.length} entries.`);
  return 0;
}
