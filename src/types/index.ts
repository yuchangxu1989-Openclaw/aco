/**
 * ACO Core Types — 域 A/B/C/D/E/F/G 共享类型定义
 * 对应 spec §3 核心概念
 */

// --- Task (§3.1) ---

export type TaskStatus =
  | 'queued'
  | 'dispatching'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'retrying'
  | 'cancelled';

export interface Task {
  taskId: string;
  label: string;
  prompt: string;
  agentId?: string;
  timeoutSeconds: number;
  priority: number;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  outputSummary?: string;
  outputTokens?: number;
  outputFiles?: string[];
  retryCount: number;
  maxRetries: number;
  targetTier?: Tier;
  failureReason?: string;
  chainId?: string;
  parentTaskId?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateTaskInput {
  label: string;
  prompt: string;
  agentId?: string;
  timeoutSeconds?: number;
  priority?: number;
  targetTier?: Tier;
  maxRetries?: number;
  chain?: CompletionChainDef;
  outputFiles?: string[];
  metadata?: Record<string, unknown>;
}

// --- Agent Slot (§3.1) ---

export type AgentStatus = 'idle' | 'busy' | 'stale' | 'offline';
export type RuntimeType = 'subagent' | 'acp';
export type Tier = 'T1' | 'T2' | 'T3' | 'T4';
export type RoleTag = 'coder' | 'auditor' | 'architect' | 'pm' | 'ux' | string;

export interface AgentSlot {
  agentId: string;
  tier: Tier;
  runtimeType: RuntimeType;
  status: AgentStatus;
  roles: RoleTag[];
  maxConcurrency: number;
  activeTasks: number;
  totalCompleted: number;
  totalFailed: number;
  consecutiveFailures: number;
  lastActiveAt?: number;
}

export interface RegisterAgentInput {
  agentId: string;
  tier: Tier;
  runtimeType: RuntimeType;
  roles: RoleTag[];
  maxConcurrency?: number;
}

// --- Dispatch Rule (§3.1) ---

export type RuleAction = 'allow' | 'block' | 'warn' | 'route';

export interface DispatchRule {
  ruleId: string;
  priority: number;
  condition: RuleCondition;
  action: RuleAction;
  routeTarget?: string;
  description?: string;
}

export interface RuleCondition {
  taskType?: string | string[];
  agentId?: string | string[];
  promptPattern?: string;
  roleRequired?: RoleTag | RoleTag[];
  custom?: (task: Task, agent: AgentSlot) => boolean;
}

// --- Completion Chain (§3.1) ---

export interface CompletionChainDef {
  chainId?: string;
  onSuccess?: ChainStep[];
  onFailure?: ChainStep[];
}

export interface ChainStep {
  label: string;
  promptTemplate: string;
  agentId?: string;
  targetTier?: Tier;
  timeoutSeconds?: number;
  priority?: number;
  condition?: ChainCondition;
  maxLoopCount?: number;
}

export interface ChainCondition {
  field: string;
  operator: '==' | '!=' | '>' | '<' | '>=' | '<=';
  value: string | number | boolean;
  logic?: 'AND' | 'OR' | 'NOT';
  children?: ChainCondition[];
}

// --- Audit Event (§3.1) ---

export type AuditEventType =
  | 'task_created'
  | 'task_state_change'
  | 'dispatch_decision'
  | 'rule_matched'
  | 'rule_blocked'
  | 'circuit_break'
  | 'tier_upgrade'
  | 'chain_triggered'
  | 'notification_sent'
  | 'config_changed'
  | 'agent_registered'
  | 'agent_status_change'
  | 'bias_alert'
  | 'failure_tracked'
  | 'closure_missed'
  | 'closure_detected'
  | 'reminder_injected';

export interface AuditEvent {
  eventId: string;
  type: AuditEventType;
  timestamp: number;
  taskId?: string;
  agentId?: string;
  details: Record<string, unknown>;
}

// --- Dispatch Bias (FR-B06) ---

export type SelectionStrategy = 'least-active' | 'round-robin' | 'random';

export interface BiasDetectorConfig {
  consecutiveThreshold: number;
  selectionStrategy: SelectionStrategy;
}

export interface BiasAlertEvent {
  biasedAgentId: string;
  consecutiveCount: number;
  sameTierIdleAgents: string[];
  timestamp: number;
}

export const DEFAULT_BIAS_CONFIG: BiasDetectorConfig = {
  consecutiveThreshold: 3,
  selectionStrategy: 'least-active',
};

// --- Failure Tracking (FR-B07) ---

export type FailureMode = 'zero-output' | 'timeout' | 'error-output' | 'no-file-written' | 'crash';
export type FaultType = 'agent-fault' | 'task-fault';
export type RepairAction = 'switch-agent' | 'upgrade-tier' | 'split-task' | 'add-context';

export interface FailureRecord {
  failureId: string;
  agentId: string;
  taskId: string;
  taskType: string;
  failureMode: FailureMode;
  promptSummary: string;
  durationMs: number;
  outputTokens: number;
  faultType?: FaultType;
  repairSuggestions: RepairAction[];
  timestamp: number;
}

export interface FailureTrackerConfig {
  dataFilePath: string;
  failureRateThreshold: number;
}

export const DEFAULT_FAILURE_TRACKER_CONFIG: FailureTrackerConfig = {
  dataFilePath: '.aco/failures.jsonl',
  failureRateThreshold: 0.3,
};

export interface FailureAggregateEntry {
  agentId: string;
  taskType: string;
  totalAttempts: number;
  failureCount: number;
  failureRate: number;
  failureModes: Record<FailureMode, number>;
  lastFailureAt: number;
}

export interface FailureHeatmapCell {
  agentId: string;
  taskType: string;
  failureRate: number;
  totalAttempts: number;
  dominantFailureMode: FailureMode | null;
}

// --- Notification (§3.1) ---

export type NotificationChannelType = 'feishu' | 'telegram' | 'discord' | 'slack' | 'webhook';

export interface NotificationChannel {
  channelId: string;
  type: NotificationChannelType;
  config: Record<string, unknown>;
  enabled: boolean;
}

// --- LLM Interface ---

export interface LLMProvider {
  classify(prompt: string, categories: string[]): Promise<string>;
}

// --- Host Adapter (FR-Z04) ---

export interface OutboundMessage {
  content: string;
  sessionKey: string;
  timestamp: number;
  channelType?: string;
}

export interface HostAdapter {
  spawnTask(agentId: string, prompt: string, options?: SpawnOptions): Promise<string>;
  killTask(sessionId: string): Promise<void>;
  steerTask(sessionId: string, message: string): Promise<void>;
  getTaskStatus(sessionId: string): Promise<{ status: string; outputTokens?: number }>;
  getAgentStatus(agentId: string): Promise<{ active: boolean }>;
  getSessionState(sessionId: string): Promise<SessionState>;
  subscribeEvents(handler: (event: HostEvent) => void): void;
  discoverAgents?(): Promise<DiscoveredAgent[]>;
  /**
   * FR-F06 AC9: Detect outbound messages from main session.
   * Subscribe to outbound message events; callback fires when main session sends a message
   * to a user-visible channel. Implementation is host-specific.
   */
  detectOutboundMessage?(handler: (message: OutboundMessage) => void): () => void;
}

export interface SessionState {
  sessionId: string;
  active: boolean;
  files?: string[];
  lastActivity?: number;
}

export interface DiscoveredAgent {
  agentId: string;
  model?: string;
  roles?: string[];
}

export interface SpawnOptions {
  timeoutSeconds?: number;
  label?: string;
}

export interface HostEvent {
  type: 'session:complete' | 'session:timeout' | 'message:received' | 'run:completed' | 'subagent_ended';
  sessionId: string;
  runId?: string;
  childSessionKey?: string;
  targetSessionKey?: string;
  targetKind?: string;
  label?: string;
  status?: string;
  outcome?: string;
  success?: boolean;
  startedAt?: number | string;
  createdAt?: number | string;
  endedAt?: number | string;
  completedAt?: number | string;
  durationMs?: number;
  agentId?: string;
  data?: Record<string, unknown>;
}

// --- Config ---

export interface AcoConfig {
  defaultTimeout: number;
  minTimeout: number;
  defaultPriority: number;
  substantiveTokenThreshold: number;
  circuitBreakThreshold: number;
  circuitBreakDuration: number;
  maxGlobalAcpConcurrency: number;
  defaultPolicy: 'open' | 'closed';
  dataDir: string;
}

export const DEFAULT_CONFIG: AcoConfig = {
  defaultTimeout: 600,
  minTimeout: 300,
  defaultPriority: 50,
  substantiveTokenThreshold: 3000,
  circuitBreakThreshold: 3,
  circuitBreakDuration: 300_000,
  maxGlobalAcpConcurrency: 8,
  defaultPolicy: 'open',
  dataDir: '.aco',
};
