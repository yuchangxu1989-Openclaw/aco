/**
 * FR-C02：失败即时重派
 * 实质失败检测 → 自动优化 prompt → 梯队升级 → 重派
 * 禁止原样重派
 */

import type { Task, AgentSlot, Tier } from '../types/index.js';
import type { FailureRedispatchConfig, TaskResult, RedispatchDecision } from './types.js';

const TIER_ORDER: Tier[] = ['T4', 'T3', 'T2', 'T1'];

const DEFAULT_CONFIG: FailureRedispatchConfig = {
  substantiveTokenThreshold: 3000,
  maxRetries: 3,
  tierUpgradeThreshold: 1,
  appendFailureContext: true,
  enabled: true,
};

/**
 * 判断任务结果是否为实质失败。
 * 实质失败 = output_tokens < 阈值 且 无文件写入
 */
export function isSubstantiveFailure(result: TaskResult, config: Partial<FailureRedispatchConfig> = {}): boolean {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const lowTokens = result.outputTokens < cfg.substantiveTokenThreshold;
  const noFiles = !result.outputFiles || result.outputFiles.length === 0;
  return lowTokens && noFiles;
}

/**
 * 处理任务失败，决定重派策略。
 * 核心约束：禁止原样重派，每次重派必须至少满足以下之一：升级梯队、优化 prompt、拆分任务。
 */
export function handleFailure(
  task: Task,
  result: TaskResult,
  agentPool: AgentSlot[],
  config: Partial<FailureRedispatchConfig> = {},
): RedispatchDecision {
  const cfg: FailureRedispatchConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return { shouldRedispatch: false, exhaustedReason: 'Failure redispatch disabled' };
  }

  // 检查是否已耗尽重试次数
  if (task.retryCount >= cfg.maxRetries) {
    return {
      shouldRedispatch: false,
      exhaustedReason: `Max retries exhausted (${task.retryCount}/${cfg.maxRetries})`,
    };
  }

  // 判断是否为实质失败
  const substantive = isSubstantiveFailure(result, cfg);

  // 确定当前梯队
  const currentTier = task.targetTier ?? inferTierFromAgent(task.agentId, agentPool) ?? 'T3';

  // 计算同梯队失败次数
  const sameTierFailures = countSameTierFailures(task, currentTier);

  // 决定重派策略
  const strategy = determineStrategy(substantive, sameTierFailures, currentTier, cfg);

  if (strategy === 'exhausted') {
    return {
      shouldRedispatch: false,
      exhaustedReason: 'No viable redispatch strategy (already at highest tier)',
    };
  }

  // 构建优化后的 prompt
  const optimizedPrompt = buildOptimizedPrompt(result, strategy, cfg);

  // 确定目标梯队
  const targetTier = strategy === 'tier_upgrade'
    ? getUpgradedTier(currentTier)
    : currentTier;

  // 选择推荐 Agent
  const recommendedAgent = selectRedispatchAgent(
    task.agentId,
    targetTier ?? currentTier,
    agentPool,
  );

  return {
    shouldRedispatch: true,
    strategy,
    optimizedPrompt,
    targetTier: targetTier ?? currentTier,
    recommendedAgent,
  };
}

/**
 * 确定重派策略
 */
function determineStrategy(
  isSubstantive: boolean,
  sameTierFailures: number,
  currentTier: Tier,
  config: FailureRedispatchConfig,
): 'tier_upgrade' | 'prompt_optimize' | 'task_split' | 'exhausted' {
  // 同梯队失败次数达到升级阈值 → 升级梯队
  if (sameTierFailures >= config.tierUpgradeThreshold) {
    const upgraded = getUpgradedTier(currentTier);
    if (!upgraded) {
      // 已在最高梯队，尝试 prompt 优化
      return isSubstantive ? 'task_split' : 'prompt_optimize';
    }
    return 'tier_upgrade';
  }

  // 实质失败（几乎无输出）→ 任务可能太复杂，建议拆分
  if (isSubstantive) {
    return 'task_split';
  }

  // 默认：优化 prompt
  return 'prompt_optimize';
}

/**
 * 构建优化后的 prompt（禁止原样重派）
 */
function buildOptimizedPrompt(
  result: TaskResult,
  strategy: 'tier_upgrade' | 'prompt_optimize' | 'task_split',
  config: FailureRedispatchConfig,
): string {
  const parts: string[] = [];

  // 追加失败上下文
  if (config.appendFailureContext && result.failureReason) {
    parts.push(`[上次失败原因] ${result.failureReason}`);
    parts.push('');
  }

  switch (strategy) {
    case 'task_split':
      parts.push('[任务拆分提示] 上次执行产出极少，任务可能过于复杂。请先完成最核心的部分，确保有实质产出。');
      parts.push('');
      parts.push(result.originalPrompt);
      break;

    case 'prompt_optimize':
      parts.push('[重试提示] 请仔细阅读任务要求，确保完整实现所有要点。上次执行未完全满足要求。');
      parts.push('');
      parts.push(result.originalPrompt);
      break;

    case 'tier_upgrade':
      parts.push('[梯队升级] 任务已升级到更高能力的 Agent 执行。');
      parts.push('');
      parts.push(result.originalPrompt);
      break;
  }

  return parts.join('\n');
}

/**
 * 获取升级后的梯队
 */
function getUpgradedTier(currentTier: Tier): Tier | undefined {
  const idx = TIER_ORDER.indexOf(currentTier);
  if (idx >= TIER_ORDER.length - 1) return undefined; // 已在 T1
  return TIER_ORDER[idx + 1];
}

/**
 * 从 Agent 池推断 Agent 所属梯队
 */
function inferTierFromAgent(agentId: string | undefined, pool: AgentSlot[]): Tier | undefined {
  if (!agentId) return undefined;
  const slot = pool.find(a => a.agentId === agentId);
  return slot?.tier;
}

/**
 * 计算同梯队连续失败次数（从 task metadata 中读取）
 */
function countSameTierFailures(task: Task, currentTier: Tier): number {
  const history = task.metadata?.tierFailures as Record<string, number> | undefined;
  if (!history) return task.retryCount > 0 ? 1 : 0;
  return history[currentTier] ?? 0;
}

/**
 * 选择重派目标 Agent（排除上次失败的 Agent）
 */
function selectRedispatchAgent(
  failedAgentId: string | undefined,
  targetTier: Tier,
  pool: AgentSlot[],
): string | undefined {
  const candidates = pool
    .filter(a => a.tier === targetTier)
    .filter(a => a.status === 'idle' || (a.status === 'busy' && a.activeTasks < a.maxConcurrency))
    .filter(a => a.agentId !== failedAgentId)
    .sort((a, b) => a.activeTasks - b.activeTasks);

  if (candidates.length > 0) {
    return candidates[0].agentId;
  }

  // 如果排除失败 Agent 后无候选，允许使用同 Agent（但 prompt 已优化，不算原样重派）
  const fallback = pool
    .filter(a => a.tier === targetTier)
    .filter(a => a.status !== 'offline')
    .sort((a, b) => a.activeTasks - b.activeTasks);

  return fallback[0]?.agentId;
}
