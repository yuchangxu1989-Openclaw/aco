/**
 * ACO — Agent Controlled Orchestration
 * 面向多 Agent 协作场景的可控调度中枢
 */

export { Scheduler } from './scheduler.js';
export { TaskQueue } from './task/task-queue.js';
export { ResourcePool } from './pool/resource-pool.js';
export { RuleEngine } from './dispatch/rule-engine.js';
export { RoleDiscovery } from './dispatch/role-discovery.js';
export { EventBus } from './event/event-bus.js';
export { ConfigManager } from './config/config-manager.js';
export { NotificationManager, DEFAULT_NOTIFICATION_CONFIG } from './notification/index.js';
export {
  WebhookTransport,
  FeishuTransport,
  TelegramTransport,
  DiscordTransport,
  SlackTransport,
  getBuiltinTransports,
} from './notification/index.js';
export { AuditLogger } from './audit-logger/index.js';
export { AuditQuery } from './audit-query/index.js';
export { TaskHistory } from './audit-query/index.js';
export { StatsCalculator } from './stats/stats-calculator.js';
export { BoardRenderer } from './board/index.js';
export { ChainExecutor } from './chain/index.js';
export { ChainVisualizer } from './chain/index.js';
export { HealthMonitor, RecoveryManager, HealthReporter, DEFAULT_HEALTH_MONITOR_CONFIG, DEFAULT_RECOVERY_CONFIG } from './health/index.js';
export { OpenClawAdapter } from './adapter/index.js';
export { MigrationManager } from './migration/index.js';

export type {
  Task,
  TaskStatus,
  CreateTaskInput,
  AgentSlot,
  AgentStatus,
  RegisterAgentInput,
  Tier,
  RoleTag,
  RuntimeType,
  DispatchRule,
  RuleAction,
  RuleCondition,
  CompletionChainDef,
  ChainStep,
  ChainCondition,
  AuditEvent,
  AuditEventType,
  NotificationChannel,
  NotificationChannelType,
  LLMProvider,
  HostAdapter,
  SpawnOptions,
  HostEvent,
  SessionState,
  DiscoveredAgent,
  AcoConfig,
} from './types/index.js';

export { DEFAULT_CONFIG } from './types/index.js';

export {
  validateConfig,
  generateMinimalConfig,
  generateAnnotatedConfig,
} from './config/config-schema.js';

export type {
  AcoFileConfig,
  ConfigValidationError,
  FeatureFlag,
} from './config/config-schema.js';

export type {
  ConfigManagerOptions,
  ConfigChangeEvent,
  FileSystem,
} from './config/config-manager.js';

export {
  FEATURE_LAYERS,
  getFeatureLayer,
  getFeatureLevel,
  isFeatureEnabled,
  enableFeature,
  disableFeature,
  getFeatureStatus,
  shouldDowngradeGovernance,
} from './config/feature-layers.js';

export type { FeatureLayer } from './config/feature-layers.js';

export type {
  ChannelConfig,
  ChannelTransport,
  DeliveryRecord,
  NotificationEventType,
  NotificationManagerConfig,
  NotificationPayload,
  SubscriptionFilter,
  NotificationTaskSource,
  CompletionEventPayload,
  NotificationTemplate,
} from './notification/index.js';

export type { AuditEntry, AuditLoggerConfig } from './audit-logger/index.js';
export type { AuditQueryConfig, QueryFilter } from './audit-query/index.js';
export type { TaskHistoryEntry, TaskHistoryResult, RetryAttempt } from './audit-query/index.js';
export type { StatsCalculatorConfig, PeriodStats, AgentStats } from './stats/stats-calculator.js';
export type { BoardFilter, BoardOptions, BoardOutputFormat, BoardRow } from './board/index.js';
export type {
  ChainExecution,
  ChainExecutorConfig,
  ChainNode,
  ChainNodeStatus,
  ChainTaskRequest,
  TaskOutput,
} from './chain/index.js';

export type {
  ChainExecutionView,
  ChainNodeView,
  ChainOutputFormat,
} from './chain/index.js';

export type {
  HealthMonitorConfig,
  RecoveryManagerConfig,
  RecoveryAttempt,
  RecoveryPhase,
  SystemHealthReport,
  AgentHealthInfo,
  SystemHealthLevel,
} from './health/index.js';

export type {
  RoleAgentsMap,
  RoleTaskMap,
  RoleEnforcementMode,
  RoleDiscoveryConfig,
  RoleDiscoveryResult,
} from './dispatch/index.js';

export type { OpenClawAdapterConfig } from './adapter/index.js';

export type {
  MigrationStep,
  MigrationRecord,
  MigrationState,
  MigrationFileSystem,
  MigrationManagerConfig,
} from './migration/index.js';
