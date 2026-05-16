/**
 * FR-C01：开发审计分离
 * 检测开发任务完成 → 自动派审计任务
 * 禁止开发 agent 自审（agentId 校验）
 * 审计池可配置
 */

import type { Task, AgentSlot } from '../types/index.js';
import type { DevAuditSeparationConfig, DevAuditResult } from './types.js';

const DEFAULT_CONFIG: DevAuditSeparationConfig = {
  auditPool: ['audit-01', 'audit-02'],
  devRoles: ['coder', 'architect'],
  auditRoles: ['auditor'],
  enabled: true,
};

/** Task types that trigger audit after completion */
const CODE_TASK_TYPES: string[] = ['code', 'implement', 'fix', 'refactor'];

/**
 * 检测开发任务完成后是否应派审计，并选择合适的审计 Agent。
 * 核心约束：开发 Agent 禁止自审。
 */
export function enforceDevAuditSeparation(
  task: Task,
  config: Partial<DevAuditSeparationConfig> = {},
  availableAgents?: AgentSlot[],
): DevAuditResult {
  const cfg: DevAuditSeparationConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return { shouldAudit: false };
  }

  // 只有成功完成的任务才触发审计
  if (task.status !== 'succeeded') {
    return { shouldAudit: false };
  }

  // AC1: 仅代码类任务触发审计推荐
  const taskType = task.metadata?.taskType as string | undefined;
  if (taskType && !CODE_TASK_TYPES.includes(taskType)) {
    return { shouldAudit: false, skipReason: 'non-code task' };
  }

  // 检查任务是否由开发角色执行（通过 metadata 或 agentId 判断）
  const executorAgentId = task.agentId;
  if (!executorAgentId) {
    return { shouldAudit: false };
  }

  // 如果任务本身就是审计任务，不再触发二次审计
  if (isAuditTask(task)) {
    return { shouldAudit: false };
  }

  // AC6: 单 Agent 降级 — 只有一个 agent 且与执行者相同时，warn 而非 block
  if (availableAgents && availableAgents.length === 1 && availableAgents[0].agentId === executorAgentId) {
    return {
      shouldAudit: true,
      recommendedAuditor: executorAgentId,
      auditPrompt: generateAuditPrompt(task),
      warnReason: 'single agent mode, self-audit unavoidable',
    };
  }

  // 选择审计 Agent：从审计池中选择，排除执行者
  const auditor = selectAuditor(executorAgentId, cfg, availableAgents);

  if (!auditor) {
    return {
      shouldAudit: true,
      blockReason: 'No available auditor in pool (all busy or executor is the only option)',
    };
  }

  return {
    shouldAudit: true,
    recommendedAuditor: auditor,
    auditPrompt: generateAuditPrompt(task),
  };
}

/**
 * 校验某个 agentId 是否允许执行审计任务。
 * 核心规则：开发 Agent 不能审计自己开发的任务。
 */
export function validateAuditAssignment(
  taskExecutorAgentId: string,
  proposedAuditorAgentId: string,
  config: Partial<DevAuditSeparationConfig> = {},
): { allowed: boolean; reason?: string } {
  const cfg: DevAuditSeparationConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return { allowed: true };
  }

  // 核心铁律：开发者不能自审
  if (taskExecutorAgentId === proposedAuditorAgentId) {
    return {
      allowed: false,
      reason: `Agent "${proposedAuditorAgentId}" cannot audit its own work (dev-audit separation violation)`,
    };
  }

  return { allowed: true };
}

/**
 * 判断任务是否为审计类任务（通过 label 或 metadata）
 */
function isAuditTask(task: Task): boolean {
  const label = task.label.toLowerCase();
  if (label.includes('audit') || label.includes('review') || label.includes('质量审计')) {
    return true;
  }
  if (task.metadata?.taskType === 'audit') {
    return true;
  }
  return false;
}

/**
 * 从审计池中选择可用的审计 Agent，排除任务执行者。
 * AC2: 优先选择具有 auditor 角色的 agent。
 */
function selectAuditor(
  executorAgentId: string,
  config: DevAuditSeparationConfig,
  availableAgents?: AgentSlot[],
): string | undefined {
  if (availableAgents && availableAgents.length > 0) {
    // AC2: 优先选择有 auditor 角色的 agent（不限于 auditPool 配置）
    const auditorRoleCandidates = availableAgents
      .filter(a => a.agentId !== executorAgentId)
      .filter(a => a.roles?.includes('auditor'))
      .filter(a => a.status === 'idle' || (a.status === 'busy' && a.activeTasks < a.maxConcurrency))
      .sort((a, b) => a.activeTasks - b.activeTasks);

    if (auditorRoleCandidates.length > 0) {
      return auditorRoleCandidates[0].agentId;
    }

    // Fallback: 从配置的 auditPool 中选择
    const poolCandidates = availableAgents
      .filter(a => config.auditPool.includes(a.agentId))
      .filter(a => a.agentId !== executorAgentId)
      .filter(a => a.status === 'idle' || (a.status === 'busy' && a.activeTasks < a.maxConcurrency))
      .sort((a, b) => a.activeTasks - b.activeTasks);

    if (poolCandidates.length > 0) {
      return poolCandidates[0].agentId;
    }
  }

  // 无状态信息时，从审计池中选择第一个非执行者
  const fallback = config.auditPool.find((id: string) => id !== executorAgentId);
  return fallback;
}

/**
 * 生成审计任务的 prompt
 */
function generateAuditPrompt(task: Task): string {
  const files = task.outputFiles?.length
    ? `\n产出文件：${task.outputFiles.join(', ')}`
    : '';

  return [
    `代码质量审计任务`,
    ``,
    `审计目标：${task.label}`,
    `原始任务 prompt：${task.prompt}`,
    files,
    ``,
    `审计要求：`,
    `1. 检查代码实现是否完整覆盖任务要求`,
    `2. 检查代码质量（类型安全、错误处理、边界条件）`,
    `3. 检查是否有安全隐患`,
    `4. 输出审计报告（通过/不通过 + 具体问题列表）`,
  ].join('\n');
}
