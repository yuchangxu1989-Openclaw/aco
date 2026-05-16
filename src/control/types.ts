/**
 * ACO Control Domain Types — FR-C01 ~ FR-C08
 * 核心调度铁律的类型定义
 */

import type { AgentSlot, Task, Tier, RoleTag } from '../types/index.js';

// --- FR-C01: 开发审计分离 ---

export interface DevAuditSeparationConfig {
  /** 审计 Agent 池（默认 ['audit-01', 'audit-02']） */
  auditPool: string[];
  /** 开发角色标签（这些角色的 agent 禁止自审） */
  devRoles: RoleTag[];
  /** 审计角色标签 */
  auditRoles: RoleTag[];
  /** 是否启用（默认 true） */
  enabled: boolean;
}

export interface DevAuditResult {
  /** 是否应派审计任务 */
  shouldAudit: boolean;
  /** 推荐的审计 agentId */
  recommendedAuditor?: string;
  /** 拦截原因（若开发 agent 试图自审） */
  blockReason?: string;
  /** 生成的审计任务 prompt */
  auditPrompt?: string;
  /** 跳过审计的原因（如非代码类任务） */
  skipReason?: string;
  /** 降级警告原因（如单 Agent 模式自审不可避免） */
  warnReason?: string;
}

// --- FR-C02: 失败即时重派 ---

export interface FailureRedispatchConfig {
  /** 实质失败 token 阈值（默认 3000） */
  substantiveTokenThreshold: number;
  /** 最大重试次数（默认 3） */
  maxRetries: number;
  /** 同梯队失败几次后升级（默认 1） */
  tierUpgradeThreshold: number;
  /** 是否追加失败上下文到重派 prompt（默认 true） */
  appendFailureContext: boolean;
  /** 是否启用（默认 true） */
  enabled: boolean;
}

export interface TaskResult {
  /** 任务输出 token 数 */
  outputTokens: number;
  /** 任务写入的文件列表 */
  outputFiles: string[];
  /** 失败原因（若有） */
  failureReason?: string;
  /** 原始 prompt */
  originalPrompt: string;
  /** 任务执行时长（ms） */
  duration?: number;
}

export interface RedispatchDecision {
  /** 是否应重派 */
  shouldRedispatch: boolean;
  /** 重派策略 */
  strategy?: 'tier_upgrade' | 'prompt_optimize' | 'task_split';
  /** 优化后的 prompt */
  optimizedPrompt?: string;
  /** 目标梯队 */
  targetTier?: Tier;
  /** 推荐的 agentId */
  recommendedAgent?: string;
  /** 拒绝重派的原因 */
  exhaustedReason?: string;
}

// --- FR-C03: 超时熔断与 Stale 治理 ---

export interface CircuitBreakerConfig {
  /** 连续失败触发熔断的阈值（默认 3） */
  failureThreshold: number;
  /** 熔断冷却时间（ms，默认 300000 = 5 分钟） */
  cooldownMs: number;
  /** stale 判定倍数（超过 timeout * staleFactor 视为 stale，默认 1.5） */
  staleFactor: number;
  /** stale 扫描间隔（ms，默认 30000 = 30 秒） */
  scanIntervalMs: number;
  /** stall_warning 后等待响应时间（ms，默认 60000） */
  stallGracePeriodMs: number;
  /** 是否启用（默认 true） */
  enabled: boolean;
}

export interface AgentCircuitState {
  agentId: string;
  state: 'closed' | 'open' | 'half-open';
  consecutiveFailures: number;
  lastFailureAt?: number;
  openedAt?: number;
  /** 冷却结束时间 */
  recoveryAt?: number;
}

export interface StaleTaskInfo {
  taskId: string;
  agentId?: string;
  runningDuration: number;
  timeoutSeconds: number;
  staleFactor: number;
  /** 是否已发送 stall_warning */
  stallWarned: boolean;
  stallWarnedAt?: number;
}

// --- FR-C04: 主会话空闲保护 ---

export interface MainSessionGuardConfig {
  /** 耗时命令黑名单模式 */
  commandBlacklist: string[];
  /** 耗时阈值（秒，超过此值的命令应委派，默认 30） */
  durationThreshold: number;
  /** 是否启用（默认 true） */
  enabled: boolean;
}

export interface DelegationSuggestion {
  /** 是否应委派给子任务 */
  shouldDelegate: boolean;
  /** 拦截原因 */
  reason?: string;
  /** 匹配到的黑名单模式 */
  matchedPattern?: string;
  /** 建议的任务 prompt（从原命令转化） */
  suggestedPrompt?: string;
  /** 建议的超时时间 */
  suggestedTimeout?: number;
}

// --- FR-C05: File Isolation ---

export interface FileIsolationConfig {
  /** 排除隔离的文件模式（glob 或精确匹配） */
  exclude: string[];
  /** 是否启用自动隔离 */
  enabled: boolean;
}

export interface IsolatedTaskConfig {
  /** 原始任务 prompt */
  prompt: string;
  /** 注入隔离约束后的 prompt */
  isolatedPrompt: string;
  /** 产出文件路径列表 */
  outputFiles?: string[];
  /** 隔离后的产出文件路径列表 */
  isolatedOutputFiles?: string[];
}

export interface FileConflict {
  /** 冲突的文件路径 */
  filePath: string;
  /** 涉及冲突的 agent ID 列表 */
  agentIds: string[];
  /** 冲突严重程度 */
  severity: 'warning' | 'error';
}

// --- FR-C06: Auto Init ---

export interface PluginInfo {
  name: string;
  installed: boolean;
  version?: string;
}

export interface InitEnvironment {
  openclawVersion?: string;
  installedPlugins: string[];
  agentCount: number;
  runtimeType: string;
}

export interface InitResult {
  /** 已激活的能力列表 */
  activated: string[];
  /** 已跳过的（已存在的）能力列表 */
  skipped: string[];
  /** 安装失败的插件 */
  failed: string[];
  /** 是否全部成功 */
  success: boolean;
  /** 摘要信息 */
  summary: string;
  /** health check 警告（插件安装后加载验证失败） */
  healthWarnings?: string[];
}

export interface OpenClawConfig {
  plugins?: Array<{ name: string; enabled?: boolean; [key: string]: unknown }>;
  agents?: { list?: Array<{ id: string; [key: string]: unknown }> };
  [key: string]: unknown;
}

// --- FR-C07: Rule Engine ---

export type ControlRuleType =
  | 'dev-audit-separation'
  | 'failure-retry'
  | 'timeout-circuit-break'
  | 'main-session-guard'
  | 'file-isolation'
  | 'tier-routing'
  | 'custom';

export type ControlRuleAction = 'block' | 'retry' | 'escalate' | 'warn' | 'allow' | 'delegate';

export interface ControlRuleContext {
  task?: Task;
  agent?: AgentSlot;
  sourceAgentId?: string;
  sessionType?: 'main' | 'subagent' | 'acp';
  operationType?: string;
  parallelTasks?: Task[];
  failureCount?: number;
  elapsedMs?: number;
  [key: string]: unknown;
}

export interface ControlRuleResult {
  action: ControlRuleAction;
  reason: string;
  ruleId: string;
  metadata?: Record<string, unknown>;
}

export interface ControlRule {
  /** 唯一标识 */
  ruleId: string;
  /** 规则类型 */
  type: ControlRuleType;
  /** 优先级（数字越大越优先） */
  priority: number;
  /** 规则描述 */
  description: string;
  /** 是否启用 */
  enabled: boolean;
  /** 评估函数：返回 null 表示不匹配 */
  evaluate(context: ControlRuleContext): ControlRuleResult | null;
}

export interface RuleEngineConfig {
  /** 内置规则是否启用 */
  builtinRulesEnabled: boolean;
  /** 审计日志路径 */
  auditLogPath?: string;
  /** 规则配置文件路径（用于 fs watch 热加载） */
  rulesConfigPath?: string;
}

export interface RuleExecutionRecord {
  ruleId: string;
  timestamp: number;
  context: Partial<ControlRuleContext>;
  result: ControlRuleResult;
}

// --- FR-C08: Tier Manager ---

export interface TierAssignment {
  agentId: string;
  tier: Tier;
  source: 'auto' | 'manual' | 'performance';
  assignedAt: number;
}

export interface AgentPerformance {
  agentId: string;
  totalTasks: number;
  successCount: number;
  failureCount: number;
  averageDurationMs: number;
  successRate: number;
  lastUpdated: number;
}

export interface TierManagerConfig {
  /** 自动调整所需的最小任务完成数 */
  minTasksForAutoAdjust: number;
  /** 成功率低于此值降级 */
  demoteThreshold: number;
  /** 成功率高于此值升级 */
  promoteThreshold: number;
  /** 默认梯队分配策略 */
  defaultStrategy: 'model-based' | 'round-robin' | 'manual';
}

export interface TierDistribution {
  tier: Tier;
  agents: Array<{
    agentId: string;
    performance: AgentPerformance;
    source: TierAssignment['source'];
  }>;
}

/** Model capability hints for auto-tier assignment */
export interface ModelTierMapping {
  /** Model name patterns → tier */
  patterns: Array<{ pattern: RegExp; tier: Tier }>;
}

export const DEFAULT_MODEL_TIER_MAPPING: ModelTierMapping = {
  patterns: [
    { pattern: /opus|o1|gpt-?4o/i, tier: 'T1' },
    { pattern: /sonnet|gpt-?4/i, tier: 'T2' },
    { pattern: /haiku|gpt-?3\.5|mini/i, tier: 'T3' },
    { pattern: /nano|flash|lite/i, tier: 'T4' },
  ],
};

export const DEFAULT_TIER_MANAGER_CONFIG: TierManagerConfig = {
  minTasksForAutoAdjust: 10,
  demoteThreshold: 0.5,
  promoteThreshold: 0.9,
  defaultStrategy: 'model-based',
};

export const DEFAULT_FILE_ISOLATION_CONFIG: FileIsolationConfig = {
  exclude: ['package.json', 'tsconfig.json', 'README.md', '.gitignore'],
  enabled: true,
};

export const DEFAULT_RULE_ENGINE_CONFIG: RuleEngineConfig = {
  builtinRulesEnabled: true,
};

/** Required plugins for ACO core functionality */
export const REQUIRED_PLUGINS = [
  'run-watchdog',
  'dispatch-guard',
] as const;

/** Capabilities that ACO activates on init */
export const CORE_CAPABILITIES = [
  '超时保护',
  '失败重派',
  '审计分离',
  '并行文件隔离',
  '梯队管理',
  '主会话空闲保护',
] as const;
