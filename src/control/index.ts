/**
 * ACO Control Domain — 核心调度铁律
 * FR-C01: 开发审计分离
 * FR-C02: 失败即时重派
 * FR-C03: 超时熔断与 Stale 治理
 * FR-C04: 主会话空闲保护
 * FR-C05: 并行文件隔离
 * FR-C06: 无感初始化
 * FR-C07: 调度规则引擎
 * FR-C08: 梯队管理
 */

// FR-C01: Dev-Audit Separation
export {
  enforceDevAuditSeparation,
  validateAuditAssignment,
} from './dev-audit-separation.js';

// FR-C02: Failure Redispatch
export {
  handleFailure,
  isSubstantiveFailure,
} from './failure-redispatch.js';

// FR-C03: Timeout Circuit Breaker
export { CircuitBreaker } from './timeout-circuit-breaker.js';

// FR-C04: Main Session Guard
export {
  shouldDelegateToSubagent,
  checkCommands,
  extendBlacklist,
} from './main-session-guard.js';

// FR-C05: File Isolation
export {
  injectFileIsolation,
  detectFileConflict,
  shouldActivateIsolation,
  shouldDeactivateIsolation,
} from './file-isolation.js';

// FR-C06: Auto Init
export {
  autoInit,
  checkPlugins,
  detectEnvironment,
  getRequiredPlugins,
  getCoreCapabilities,
} from './auto-init.js';
export type { AutoInitOptions, PluginInstaller, EnvironmentDetector } from './auto-init.js';

// FR-C07: Rule Engine
export { ControlRuleEngine } from './rule-engine.js';
export type { Rule } from './rule-engine.js';

// FR-C08: Tier Manager
export { TierManager } from './tier-manager.js';

// Shared types
export type {
  // FR-C01
  DevAuditSeparationConfig,
  DevAuditResult,
  // FR-C02
  FailureRedispatchConfig,
  TaskResult,
  RedispatchDecision,
  // FR-C03
  CircuitBreakerConfig,
  AgentCircuitState,
  StaleTaskInfo,
  // FR-C04
  MainSessionGuardConfig,
  DelegationSuggestion,
  // FR-C05
  FileIsolationConfig,
  IsolatedTaskConfig,
  FileConflict,
  // FR-C06
  PluginInfo,
  InitEnvironment,
  InitResult,
  OpenClawConfig,
  // FR-C07
  ControlRuleType,
  ControlRuleAction,
  ControlRuleContext,
  ControlRuleResult,
  ControlRule,
  RuleEngineConfig,
  RuleExecutionRecord,
  // FR-C08
  TierAssignment,
  AgentPerformance,
  TierManagerConfig,
  TierDistribution,
  ModelTierMapping,
} from './types.js';

export {
  DEFAULT_FILE_ISOLATION_CONFIG,
  DEFAULT_RULE_ENGINE_CONFIG,
  DEFAULT_TIER_MANAGER_CONFIG,
  DEFAULT_MODEL_TIER_MAPPING,
  REQUIRED_PLUGINS,
  CORE_CAPABILITIES,
} from './types.js';
