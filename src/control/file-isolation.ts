/**
 * FR-C05: 并行文件隔离
 * 多 Agent 并行写同一项目时，自动在文件名中注入 agentId 标识，防止互相覆盖。
 *
 * AC1: 检测到同一项目目录下有 2+ 个 Agent 同时 running 时，自动激活文件隔离模式
 * AC2: 隔离模式下，派发任务时自动向 prompt 注入文件命名约束
 * AC3: 隔离规则可配置排除模式
 * AC4: 并行任务全部完成后自动解除
 * AC5: 冲突检测：若两个 running 任务的产出文件路径相同，触发告警
 */

import { basename, dirname, extname, join } from 'node:path';
import type { Task } from '../types/index.js';
import type {
  FileConflict,
  FileIsolationConfig,
  IsolatedTaskConfig,
} from './types.js';
import { DEFAULT_FILE_ISOLATION_CONFIG } from './types.js';

/**
 * 向任务配置注入文件隔离约束
 * AC2: 在 prompt 中追加文件命名约束
 * AC3: 排除模式中的文件不受隔离影响
 */
export function injectFileIsolation(
  taskConfig: { prompt: string; outputFiles?: string[] },
  agentId: string,
  config: FileIsolationConfig = DEFAULT_FILE_ISOLATION_CONFIG,
): IsolatedTaskConfig {
  if (!config.enabled) {
    return {
      prompt: taskConfig.prompt,
      isolatedPrompt: taskConfig.prompt,
      outputFiles: taskConfig.outputFiles,
      isolatedOutputFiles: taskConfig.outputFiles,
    };
  }

  // Inject naming constraint into prompt
  const constraint = buildIsolationConstraint(agentId, config.exclude);
  const isolatedPrompt = `${taskConfig.prompt}\n\n${constraint}`;

  // Transform output file paths
  const isolatedOutputFiles = taskConfig.outputFiles?.map(filePath => {
    if (isExcluded(filePath, config.exclude)) {
      return filePath;
    }
    return injectAgentIdToPath(filePath, agentId);
  });

  return {
    prompt: taskConfig.prompt,
    isolatedPrompt,
    outputFiles: taskConfig.outputFiles,
    isolatedOutputFiles,
  };
}

/**
 * 检测多个并行任务之间的文件冲突
 * AC5: 若两个 running 任务的产出文件路径相同，触发告警
 */
export function detectFileConflict(
  tasks: Array<Pick<Task, 'taskId' | 'agentId' | 'outputFiles' | 'status'>>,
  config: FileIsolationConfig = DEFAULT_FILE_ISOLATION_CONFIG,
): FileConflict[] {
  // Only consider running tasks
  const runningTasks = tasks.filter(t => t.status === 'running');
  if (runningTasks.length < 2) return [];

  // Build a map of file path → agent IDs
  const fileToAgents = new Map<string, string[]>();

  for (const task of runningTasks) {
    if (!task.outputFiles || !task.agentId) continue;
    for (const filePath of task.outputFiles) {
      // Skip excluded files from conflict detection
      if (isExcluded(filePath, config.exclude)) continue;

      const normalized = normalizePath(filePath);
      const agents = fileToAgents.get(normalized) ?? [];
      if (!agents.includes(task.agentId)) {
        agents.push(task.agentId);
      }
      fileToAgents.set(normalized, agents);
    }
  }

  // Find conflicts (same file, multiple agents)
  const conflicts: FileConflict[] = [];
  for (const [filePath, agentIds] of fileToAgents) {
    if (agentIds.length > 1) {
      conflicts.push({
        filePath,
        agentIds,
        severity: 'warning',
      });
    }
  }

  return conflicts;
}

/**
 * 判断当前是否需要激活文件隔离模式
 * AC1: 同一项目目录下有 2+ 个 Agent 同时 running
 */
export function shouldActivateIsolation(
  tasks: Array<Pick<Task, 'status' | 'agentId'>>,
): boolean {
  const runningAgents = new Set<string>();
  for (const task of tasks) {
    if (task.status === 'running' && task.agentId) {
      runningAgents.add(task.agentId);
    }
  }
  return runningAgents.size >= 2;
}

/**
 * 判断并行任务是否全部完成（用于解除隔离模式）
 * AC4: 并行任务全部完成后自动解除
 */
export function shouldDeactivateIsolation(
  tasks: Array<Pick<Task, 'status'>>,
): boolean {
  return tasks.every(
    t => t.status === 'succeeded' || t.status === 'failed' || t.status === 'cancelled',
  );
}

// --- Internal helpers ---

function buildIsolationConstraint(agentId: string, exclude: string[]): string {
  const excludeList = exclude.length > 0
    ? `（以下文件除外，不需要加后缀：${exclude.join(', ')}）`
    : '';
  return `[文件隔离约束] 产出文件名必须包含 \`${agentId}\` 标识。格式：\`<name>-${agentId}.<ext>\`${excludeList}`;
}

function injectAgentIdToPath(filePath: string, agentId: string): string {
  const dir = dirname(filePath);
  const ext = extname(filePath);
  const base = basename(filePath, ext);

  // Don't double-inject if already contains agentId
  if (base.includes(agentId)) {
    return filePath;
  }

  const newName = `${base}-${agentId}${ext}`;
  return dir === '.' ? newName : join(dir, newName);
}

function isExcluded(filePath: string, excludePatterns: string[]): boolean {
  const fileName = basename(filePath);
  return excludePatterns.some(pattern => {
    // Simple glob: *.ext
    if (pattern.startsWith('*')) {
      return fileName.endsWith(pattern.slice(1));
    }
    // Exact match on filename
    return fileName === pattern || filePath === pattern;
  });
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+/g, '/');
}
