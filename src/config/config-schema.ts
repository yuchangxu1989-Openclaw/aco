/**
 * 配置 Schema 定义 — 域 H：配置与渐进式披露
 * FR-H03: 配置校验与提示
 */

/**
 * 完整 ACO 配置文件结构（aco.config.json / aco.config.yaml）
 */
export interface AcoFileConfig {
  /** 基础调度配置 */
  scheduling?: {
    defaultTimeout?: number;
    minTimeout?: number;
    defaultPriority?: number;
    substantiveTokenThreshold?: number;
  };

  /** 治理规则配置 */
  governance?: {
    defaultPolicy?: 'open' | 'closed';
    circuitBreakThreshold?: number;
    circuitBreakDuration?: number;
    maxGlobalAcpConcurrency?: number;
    rules?: RuleFileEntry[];
  };

  /** 资源池配置 */
  pool?: {
    agents?: AgentFileEntry[];
  };

  /** 推进链配置 */
  chains?: ChainFileEntry[];

  /** 通知配置 */
  notification?: {
    channels?: NotificationChannelFileEntry[];
    subscriptions?: SubscriptionFileEntry[];
  };

  /** 功能开关 */
  features?: {
    enabled?: FeatureFlag[];
  };

  /** 数据目录 */
  dataDir?: string;

  /** 闭环保障配置 (FR-F06) */
  closureGuard?: {
    /** 全局开关，默认 true (AC8) */
    enabled?: boolean;
    /** 闭环超时秒数，默认 120 (AC1) */
    timeoutSeconds?: number;
    /** 排除的 label 模式列表（前缀或 /regex/）(AC5) */
    excludeLabels?: string[];
  };

  /** 宿主适配器 */
  adapter?: {
    type?: string;
    config?: Record<string, unknown>;
  };
}

export interface RuleFileEntry {
  ruleId?: string;
  priority?: number;
  condition?: {
    taskType?: string | string[];
    agentId?: string | string[];
    promptPattern?: string;
    roleRequired?: string | string[];
  };
  action?: 'allow' | 'block' | 'warn' | 'route';
  routeTarget?: string;
  description?: string;
}

export interface AgentFileEntry {
  agentId?: string;
  tier?: string;
  runtimeType?: string;
  roles?: string[];
  maxConcurrency?: number;
}

export interface ChainFileEntry {
  chainId?: string;
  trigger?: string;
  steps?: Array<{
    label?: string;
    promptTemplate?: string;
    agentId?: string;
    targetTier?: string;
    timeoutSeconds?: number;
  }>;
}

export interface NotificationChannelFileEntry {
  channelId?: string;
  type?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export interface SubscriptionFileEntry {
  events?: string[];
  channelId?: string;
  excludeLabels?: string[];
  taskSources?: Array<'subagent' | 'acp' | 'system' | 'main'>;
}

export type FeatureFlag =
  | 'scheduling'
  | 'governance'
  | 'chains'
  | 'notification'
  | 'stats';

/**
 * 校验错误
 */
export interface ConfigValidationError {
  path: string;
  message: string;
  expected?: string;
  actual?: string;
  suggestion?: string;
  severity: 'error' | 'warning';
}

/**
 * 字段 Schema 定义（用于校验）
 */
interface FieldSchema {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  min?: number;
  max?: number;
  enum?: unknown[];
  items?: FieldSchema;
  properties?: Record<string, FieldSchema>;
  description?: string;
}

const VALID_TIERS = ['T1', 'T2', 'T3', 'T4'];
const VALID_RUNTIME_TYPES = ['subagent', 'acp'];
const VALID_RULE_ACTIONS = ['allow', 'block', 'warn', 'route'];
const VALID_POLICIES = ['open', 'closed'];
const VALID_CHANNEL_TYPES = ['feishu', 'telegram', 'discord', 'slack', 'webhook'];
const VALID_FEATURES: FeatureFlag[] = ['scheduling', 'governance', 'chains', 'notification', 'stats'];

/**
 * 校验配置文件，返回所有错误和警告
 * FR-H03 AC1/AC2/AC3
 */
export function validateConfig(
  config: unknown,
  knownAgentIds?: string[],
): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  if (config === null || config === undefined || typeof config !== 'object') {
    errors.push({
      path: '/',
      message: 'Config must be a non-null object',
      expected: 'object',
      actual: String(typeof config),
      severity: 'error',
    });
    return errors;
  }

  const cfg = config as Record<string, unknown>;

  // Validate scheduling section
  if (cfg.scheduling !== undefined) {
    if (typeof cfg.scheduling !== 'object' || cfg.scheduling === null) {
      errors.push({
        path: 'scheduling',
        message: 'scheduling must be an object',
        expected: 'object',
        actual: String(typeof cfg.scheduling),
        severity: 'error',
      });
    } else {
      const sched = cfg.scheduling as Record<string, unknown>;
      validateNumber(errors, sched, 'scheduling.defaultTimeout', 1);
      validateNumber(errors, sched, 'scheduling.minTimeout', 1);
      validateNumber(errors, sched, 'scheduling.defaultPriority', 0, 100);
      validateNumber(errors, sched, 'scheduling.substantiveTokenThreshold', 0);

      // Cross-field validation
      if (
        typeof sched.minTimeout === 'number' &&
        typeof sched.defaultTimeout === 'number' &&
        sched.defaultTimeout < sched.minTimeout
      ) {
        errors.push({
          path: 'scheduling.defaultTimeout',
          message: 'defaultTimeout must be >= minTimeout',
          expected: `>= ${sched.minTimeout}`,
          actual: String(sched.defaultTimeout),
          suggestion: `Set scheduling.defaultTimeout to at least ${sched.minTimeout}`,
          severity: 'error',
        });
      }
    }
  }

  // Validate governance section
  if (cfg.governance !== undefined) {
    if (typeof cfg.governance !== 'object' || cfg.governance === null) {
      errors.push({
        path: 'governance',
        message: 'governance must be an object',
        expected: 'object',
        actual: String(typeof cfg.governance),
        severity: 'error',
      });
    } else {
      const gov = cfg.governance as Record<string, unknown>;
      validateEnum(errors, gov, 'governance.defaultPolicy', 'defaultPolicy', VALID_POLICIES);
      validateNumber(errors, gov, 'governance.circuitBreakThreshold', 1);
      validateNumber(errors, gov, 'governance.circuitBreakDuration', 1000);
      validateNumber(errors, gov, 'governance.maxGlobalAcpConcurrency', 1);

      if (Array.isArray(gov.rules)) {
        (gov.rules as unknown[]).forEach((rule, i) => {
          validateRule(errors, rule, `governance.rules[${i}]`);
        });
      }
    }
  }

  // Validate pool section
  if (cfg.pool !== undefined) {
    if (typeof cfg.pool !== 'object' || cfg.pool === null) {
      errors.push({
        path: 'pool',
        message: 'pool must be an object',
        expected: 'object',
        actual: String(typeof cfg.pool),
        severity: 'error',
      });
    } else {
      const pool = cfg.pool as Record<string, unknown>;
      if (Array.isArray(pool.agents)) {
        (pool.agents as unknown[]).forEach((agent, i) => {
          validateAgent(errors, agent, `pool.agents[${i}]`, knownAgentIds);
        });
      }
    }
  }

  // Validate chains section
  if (cfg.chains !== undefined) {
    if (!Array.isArray(cfg.chains)) {
      errors.push({
        path: 'chains',
        message: 'chains must be an array',
        expected: 'array',
        actual: String(typeof cfg.chains),
        severity: 'error',
      });
    }
  }

  // Validate notification section
  if (cfg.notification !== undefined) {
    if (typeof cfg.notification !== 'object' || cfg.notification === null) {
      errors.push({
        path: 'notification',
        message: 'notification must be an object',
        expected: 'object',
        actual: String(typeof cfg.notification),
        severity: 'error',
      });
    } else {
      const notif = cfg.notification as Record<string, unknown>;
      if (Array.isArray(notif.channels)) {
        (notif.channels as unknown[]).forEach((ch, i) => {
          validateNotificationChannel(errors, ch, `notification.channels[${i}]`);
        });
      }
      if (notif.subscriptions !== undefined) {
        if (!Array.isArray(notif.subscriptions)) {
          errors.push({
            path: 'notification.subscriptions',
            message: 'notification.subscriptions must be an array',
            expected: 'array',
            actual: String(typeof notif.subscriptions),
            severity: 'error',
          });
        } else {
          (notif.subscriptions as unknown[]).forEach((sub, i) => {
            validateNotificationSubscription(errors, sub, `notification.subscriptions[${i}]`);
          });
        }
      }
    }
  }

  // Validate features section
  if (cfg.features !== undefined) {
    if (typeof cfg.features !== 'object' || cfg.features === null) {
      errors.push({
        path: 'features',
        message: 'features must be an object',
        expected: 'object',
        actual: String(typeof cfg.features),
        severity: 'error',
      });
    } else {
      const feat = cfg.features as Record<string, unknown>;
      if (feat.enabled !== undefined) {
        if (!Array.isArray(feat.enabled)) {
          errors.push({
            path: 'features.enabled',
            message: 'features.enabled must be an array',
            expected: 'array',
            actual: String(typeof feat.enabled),
            severity: 'error',
          });
        } else {
          (feat.enabled as unknown[]).forEach((f, i) => {
            if (typeof f !== 'string' || !VALID_FEATURES.includes(f as FeatureFlag)) {
              errors.push({
                path: `features.enabled[${i}]`,
                message: `Invalid feature flag: "${f}"`,
                expected: `one of: ${VALID_FEATURES.join(', ')}`,
                actual: String(f),
                suggestion: `Valid features: ${VALID_FEATURES.join(', ')}`,
                severity: 'error',
              });
            }
          });
        }
      }
    }
  }

  // Validate dataDir
  if (cfg.dataDir !== undefined && typeof cfg.dataDir !== 'string') {
    errors.push({
      path: 'dataDir',
      message: 'dataDir must be a string',
      expected: 'string',
      actual: String(typeof cfg.dataDir),
      severity: 'error',
    });
  }

  return errors;
}

function validateNumber(
  errors: ConfigValidationError[],
  obj: Record<string, unknown>,
  fullPath: string,
  min?: number,
  max?: number,
): void {
  const key = fullPath.split('.').pop()!;
  const val = obj[key];
  if (val === undefined) return;

  if (typeof val !== 'number' || isNaN(val)) {
    errors.push({
      path: fullPath,
      message: `${fullPath} must be a number`,
      expected: 'number',
      actual: String(typeof val),
      severity: 'error',
    });
    return;
  }

  if (min !== undefined && val < min) {
    errors.push({
      path: fullPath,
      message: `${fullPath} must be >= ${min}`,
      expected: `>= ${min}`,
      actual: String(val),
      suggestion: `Set ${fullPath} to at least ${min}`,
      severity: 'error',
    });
  }

  if (max !== undefined && val > max) {
    errors.push({
      path: fullPath,
      message: `${fullPath} must be <= ${max}`,
      expected: `<= ${max}`,
      actual: String(val),
      suggestion: `Set ${fullPath} to at most ${max}`,
      severity: 'error',
    });
  }
}

function validateEnum(
  errors: ConfigValidationError[],
  obj: Record<string, unknown>,
  fullPath: string,
  key: string,
  validValues: string[],
): void {
  const val = obj[key];
  if (val === undefined) return;

  if (typeof val !== 'string' || !validValues.includes(val)) {
    errors.push({
      path: fullPath,
      message: `${fullPath} must be one of: ${validValues.join(', ')}`,
      expected: validValues.join(' | '),
      actual: String(val),
      suggestion: `Valid values: ${validValues.join(', ')}`,
      severity: 'error',
    });
  }
}

function validateRule(errors: ConfigValidationError[], rule: unknown, path: string): void {
  if (typeof rule !== 'object' || rule === null) {
    errors.push({ path, message: 'Rule must be an object', severity: 'error' });
    return;
  }
  const r = rule as Record<string, unknown>;

  if (r.action !== undefined) {
    if (typeof r.action !== 'string' || !VALID_RULE_ACTIONS.includes(r.action)) {
      errors.push({
        path: `${path}.action`,
        message: `Invalid rule action: "${r.action}"`,
        expected: VALID_RULE_ACTIONS.join(' | '),
        actual: String(r.action),
        suggestion: `Valid actions: ${VALID_RULE_ACTIONS.join(', ')}`,
        severity: 'error',
      });
    }
  }

  if (r.priority !== undefined && (typeof r.priority !== 'number' || r.priority < 0)) {
    errors.push({
      path: `${path}.priority`,
      message: 'Rule priority must be a non-negative number',
      expected: '>= 0',
      actual: String(r.priority),
      severity: 'error',
    });
  }
}

function validateAgent(
  errors: ConfigValidationError[],
  agent: unknown,
  path: string,
  knownAgentIds?: string[],
): void {
  if (typeof agent !== 'object' || agent === null) {
    errors.push({ path, message: 'Agent entry must be an object', severity: 'error' });
    return;
  }
  const a = agent as Record<string, unknown>;

  if (!a.agentId || typeof a.agentId !== 'string') {
    errors.push({
      path: `${path}.agentId`,
      message: 'agentId is required and must be a string',
      expected: 'string',
      actual: String(a.agentId),
      severity: 'error',
    });
  } else if (knownAgentIds && !knownAgentIds.includes(a.agentId)) {
    errors.push({
      path: `${path}.agentId`,
      message: `Agent "${a.agentId}" not found in host environment`,
      expected: `one of: ${knownAgentIds.join(', ')}`,
      actual: a.agentId,
      suggestion: `Run "aco pool sync" to discover available agents, or check the agentId spelling`,
      severity: 'warning',
    });
  }

  if (a.tier !== undefined) {
    if (typeof a.tier !== 'string' || !VALID_TIERS.includes(a.tier)) {
      errors.push({
        path: `${path}.tier`,
        message: `Invalid tier: "${a.tier}"`,
        expected: VALID_TIERS.join(' | '),
        actual: String(a.tier),
        suggestion: `Valid tiers: ${VALID_TIERS.join(', ')}`,
        severity: 'error',
      });
    }
  }

  if (a.runtimeType !== undefined) {
    if (typeof a.runtimeType !== 'string' || !VALID_RUNTIME_TYPES.includes(a.runtimeType)) {
      errors.push({
        path: `${path}.runtimeType`,
        message: `Invalid runtimeType: "${a.runtimeType}"`,
        expected: VALID_RUNTIME_TYPES.join(' | '),
        actual: String(a.runtimeType),
        suggestion: `Valid types: ${VALID_RUNTIME_TYPES.join(', ')}`,
        severity: 'error',
      });
    }
  }

  if (a.maxConcurrency !== undefined) {
    if (typeof a.maxConcurrency !== 'number' || a.maxConcurrency < 1) {
      errors.push({
        path: `${path}.maxConcurrency`,
        message: 'maxConcurrency must be >= 1',
        expected: '>= 1',
        actual: String(a.maxConcurrency),
        severity: 'error',
      });
    }
  }
}

function validateNotificationChannel(
  errors: ConfigValidationError[],
  channel: unknown,
  path: string,
): void {
  if (typeof channel !== 'object' || channel === null) {
    errors.push({ path, message: 'Notification channel must be an object', severity: 'error' });
    return;
  }
  const ch = channel as Record<string, unknown>;

  if (!ch.type || typeof ch.type !== 'string') {
    errors.push({
      path: `${path}.type`,
      message: 'Channel type is required',
      expected: VALID_CHANNEL_TYPES.join(' | '),
      actual: String(ch.type),
      severity: 'error',
    });
  } else if (!VALID_CHANNEL_TYPES.includes(ch.type)) {
    errors.push({
      path: `${path}.type`,
      message: `Invalid channel type: "${ch.type}"`,
      expected: VALID_CHANNEL_TYPES.join(' | '),
      actual: ch.type,
      suggestion: `Valid types: ${VALID_CHANNEL_TYPES.join(', ')}`,
      severity: 'error',
    });
  }
}

function validateNotificationSubscription(
  errors: ConfigValidationError[],
  subscription: unknown,
  path: string,
): void {
  if (typeof subscription !== 'object' || subscription === null) {
    errors.push({ path, message: 'Notification subscription must be an object', severity: 'error' });
    return;
  }
  const sub = subscription as Record<string, unknown>;

  if (sub.excludeLabels !== undefined && !Array.isArray(sub.excludeLabels)) {
    errors.push({
      path: `${path}.excludeLabels`,
      message: 'excludeLabels must be an array',
      expected: 'array',
      actual: String(typeof sub.excludeLabels),
      severity: 'error',
    });
  }

  if (sub.taskSources !== undefined) {
    const validSources = ['subagent', 'acp', 'system', 'main'];
    if (!Array.isArray(sub.taskSources)) {
      errors.push({
        path: `${path}.taskSources`,
        message: 'taskSources must be an array',
        expected: 'array',
        actual: String(typeof sub.taskSources),
        severity: 'error',
      });
    } else {
      (sub.taskSources as unknown[]).forEach((source, i) => {
        if (typeof source !== 'string' || !validSources.includes(source)) {
          errors.push({
            path: `${path}.taskSources[${i}]`,
            message: `Invalid task source: "${source}"`,
            expected: validSources.join(' | '),
            actual: String(source),
            suggestion: `Valid sources: ${validSources.join(', ')}`,
            severity: 'error',
          });
        }
      });
    }
  }
}

/**
 * 生成最小配置（FR-H01 AC1/AC3）
 * 包含注释说明每个字段的用途和可选值
 */
export function generateMinimalConfig(): string {
  return JSON.stringify(
    {
      scheduling: {
        defaultTimeout: 600,
        minTimeout: 300,
        defaultPriority: 50,
        substantiveTokenThreshold: 3000,
      },
      governance: {
        defaultPolicy: 'open',
        circuitBreakThreshold: 3,
        circuitBreakDuration: 300000,
        maxGlobalAcpConcurrency: 8,
      },
      pool: {
        agents: [],
      },
      features: {
        enabled: ['scheduling', 'notification'],
      },
      notification: {
        channels: [],
        subscriptions: [
          {
            events: ['task_failed', 'circuit_break', 'task_completed'],
            excludeLabels: ['healthcheck', 'heartbeat'],
            taskSources: ['subagent', 'acp'],
          },
        ],
      },
      closureGuard: {
        enabled: true,
        timeoutSeconds: 120,
        excludeLabels: ['healthcheck', 'heartbeat'],
      },
      dataDir: '.aco',
    },
    null,
    2,
  );
}

/**
 * 生成带注释的配置模板（用于 aco init 输出）
 * FR-H01 AC3: 包含注释说明每个字段的用途和可选值
 */
export function generateAnnotatedConfig(): string {
  const lines = [
    '{',
    '  // === 基础调度配置 ===',
    '  "scheduling": {',
    '    // 默认超时时间（秒），任务未指定 timeout 时使用此值',
    '    "defaultTimeout": 600,',
    '    // 超时下限（秒），低于此值的任务创建会被拒绝',
    '    "minTimeout": 300,',
    '    // 默认优先级（0-100），数值越大优先级越高',
    '    "defaultPriority": 50,',
    '    // 实质成功校验的 token 阈值，低于此值视为空跑',
    '    "substantiveTokenThreshold": 3000',
    '  },',
    '',
    '  // === 治理规则配置 ===',
    '  "governance": {',
    '    // 默认策略：open（无规则时放行）或 closed（无规则时阻断）',
    '    "defaultPolicy": "open",',
    '    // 连续失败多少次触发熔断',
    '    "circuitBreakThreshold": 3,',
    '    // 熔断持续时间（毫秒）',
    '    "circuitBreakDuration": 300000,',
    '    // ACP 类型 Agent 全局最大并发数',
    '    "maxGlobalAcpConcurrency": 8',
    '  },',
    '',
    '  // === 资源池配置 ===',
    '  "pool": {',
    '    // Agent 列表，aco init 会自动从宿主环境发现并填充',
    '    // tier: T1(最强) | T2 | T3 | T4(最弱)',
    '    // runtimeType: subagent | acp',
    '    // roles: coder | auditor | architect | pm | ux | 自定义',
    '    "agents": []',
    '  },',
    '',
    '  // === 功能开关 ===',
    '  "features": {',
    '    // 已启用的功能层：scheduling | governance | chains | notification | stats',
    '    // L0=scheduling, L1=governance, L2=chains, L3=notification, L4=stats',
    '    "enabled": ["scheduling", "notification"]',
    '  },',
    '',
    '  // === 通知配置 ===',
    '  "notification": {',
    '    // aco init 后默认启用任务完成即时通知；添加渠道后无需额外订阅配置',
    '    "channels": [],',
    '    "subscriptions": [',
    '      {',
    '        "events": ["task_failed", "circuit_break", "task_completed"],',
    '        "excludeLabels": ["healthcheck", "heartbeat"],',
    '        "taskSources": ["subagent", "acp"]',
    '      }',
    '    ]',
    '  },',
    '',
    '  // === 闭环保障配置 (FR-F06) ===',
    '  "closureGuard": {',
    '    // 全局开关，设为 false 关闭闭环保障',
    '    "enabled": true,',
    '    // 闭环超时时间（秒），主会话必须在此时间内发送总结',
    '    "timeoutSeconds": 120,',
    '    // 排除的任务 label 模式（前缀匹配或 /regex/ 正则）',
    '    "excludeLabels": ["healthcheck", "heartbeat"]',
    '  },',
    '',
    '  // 数据存储目录（相对于项目根目录）',
    '  "dataDir": ".aco"',
    '}',
  ];
  return lines.join('\n');
}
