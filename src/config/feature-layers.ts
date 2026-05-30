/**
 * 功能分层定义 — 域 H：渐进式功能启用
 * FR-H04: 渐进式功能启用
 *
 * AC1: 功能分层 L0→L1→L2→L3→L4
 * AC2: 每层功能独立启用，不依赖更高层
 * AC3: CLI 命令 `aco feature enable <feature>` 启用特定功能并生成对应配置模板
 * AC4: `aco status` 展示当前已启用的功能层级
 */

import type { FeatureFlag, AcoFileConfig } from './config-schema.js';

/**
 * 功能层级定义
 */
export interface FeatureLayer {
  level: number;
  flag: FeatureFlag;
  name: string;
  description: string;
  configTemplate: Partial<AcoFileConfig>;
}

/**
 * FR-H04 AC1: 功能分层
 * L0（基础调度）→ L1（治理规则）→ L2（推进链）→ L3（通知）→ L4（统计分析）
 */
export const FEATURE_LAYERS: FeatureLayer[] = [
  {
    level: 0,
    flag: 'scheduling',
    name: 'Basic Scheduling',
    description: 'Task creation, dispatch, timeout protection, board view',
    configTemplate: {
      scheduling: {
        defaultTimeout: 600,
        minTimeout: 300,
        defaultPriority: 50,
        substantiveTokenThreshold: 3000,
      },
    },
  },
  {
    level: 1,
    flag: 'governance',
    name: 'Dispatch Governance',
    description: 'Role-task matching, self-audit prevention, concurrency control, circuit breaking',
    configTemplate: {
      governance: {
        defaultPolicy: 'open',
        circuitBreakThreshold: 3,
        circuitBreakDuration: 300000,
        maxGlobalAcpConcurrency: 8,
        rules: [],
      },
    },
  },
  {
    level: 2,
    flag: 'chains',
    name: 'Completion Chains',
    description: 'Declarative post-completion task triggering with conditions and loops',
    configTemplate: {
      chains: [],
    },
  },
  {
    level: 3,
    flag: 'notification',
    name: 'Notification & IM Push',
    description: 'Multi-channel notifications (Feishu, Telegram, Discord, Slack, Webhook)',
    configTemplate: {
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
    },
  },
  {
    level: 4,
    flag: 'stats',
    name: 'Statistics & Analysis',
    description: 'Resource utilization stats, decision tracing, historical analysis',
    configTemplate: {},
  },
];

/**
 * 获取功能层级信息
 */
export function getFeatureLayer(flag: FeatureFlag): FeatureLayer | undefined {
  return FEATURE_LAYERS.find(l => l.flag === flag);
}

/**
 * 获取功能层级号
 */
export function getFeatureLevel(flag: FeatureFlag): number {
  const layer = getFeatureLayer(flag);
  return layer?.level ?? -1;
}

/**
 * FR-H04 AC2: 检查功能是否已启用（每层独立，不依赖更高层）
 */
export function isFeatureEnabled(enabledFeatures: FeatureFlag[], flag: FeatureFlag): boolean {
  return enabledFeatures.includes(flag);
}

/**
 * FR-H04 AC3: 启用功能并返回需要合并的配置模板
 */
export function enableFeature(
  currentEnabled: FeatureFlag[],
  flag: FeatureFlag,
): { enabled: FeatureFlag[]; template: Partial<AcoFileConfig> } {
  const layer = getFeatureLayer(flag);
  if (!layer) {
    throw new Error(`Unknown feature: "${flag}". Valid features: ${FEATURE_LAYERS.map(l => l.flag).join(', ')}`);
  }

  if (currentEnabled.includes(flag)) {
    return { enabled: currentEnabled, template: {} };
  }

  const enabled = [...currentEnabled, flag];
  return { enabled, template: layer.configTemplate };
}

/**
 * 禁用功能
 */
export function disableFeature(
  currentEnabled: FeatureFlag[],
  flag: FeatureFlag,
): FeatureFlag[] {
  return currentEnabled.filter(f => f !== flag);
}

/**
 * FR-H04 AC4: 获取当前功能状态摘要
 */
export function getFeatureStatus(enabledFeatures: FeatureFlag[]): Array<{
  level: number;
  flag: FeatureFlag;
  name: string;
  enabled: boolean;
  description: string;
}> {
  return FEATURE_LAYERS.map(layer => ({
    level: layer.level,
    flag: layer.flag,
    name: layer.name,
    enabled: enabledFeatures.includes(layer.flag),
    description: layer.description,
  }));
}

/**
 * FR-H01 AC4: 单 Agent 环境下治理规则自动降级为 warn 模式
 */
export function shouldDowngradeGovernance(agentCount: number): boolean {
  return agentCount <= 1;
}
