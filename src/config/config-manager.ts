/**
 * 配置管理器 — 域 H：配置与渐进式披露
 * FR-H01: 零配置启动
 * FR-H02: 配置热加载
 * FR-H03: 配置校验与提示
 * FR-H04: 渐进式功能启用
 */

import { EventBus } from '../event/event-bus.js';
import { parse as parseYaml } from 'yaml';
import type { AcoConfig, AuditEvent } from '../types/index.js';
import { DEFAULT_CONFIG } from '../types/index.js';
import type { AcoFileConfig, ConfigValidationError, FeatureFlag } from './config-schema.js';
import { validateConfig, generateMinimalConfig } from './config-schema.js';
import {
  FEATURE_LAYERS,
  enableFeature,
  disableFeature,
  getFeatureStatus,
  isFeatureEnabled,
  shouldDowngradeGovernance,
} from './feature-layers.js';
import { v4 as uuid } from 'uuid';

export interface ConfigManagerOptions {
  /** 配置文件路径 */
  configPath?: string;
  /** 是否启用 fs.watch 热加载 */
  watchEnabled?: boolean;
  /** 已知的 agentId 列表（用于校验引用） */
  knownAgentIds?: string[];
}

export interface ConfigChangeEvent {
  timestamp: number;
  changedFields: string[];
  oldValues: Record<string, unknown>;
  newValues: Record<string, unknown>;
}

/**
 * 文件系统抽象接口（便于测试和跨平台）
 */
export interface FileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  watch(path: string, callback: () => void): { close(): void };
}

/**
 * 配置管理器
 * 负责配置的加载、校验、热加载和渐进式功能管理
 */
export class ConfigManager {
  private fileConfig: AcoFileConfig = {};
  private resolvedConfig: AcoConfig;
  private eventBus: EventBus;
  private fs?: FileSystem;
  private configPath?: string;
  private watcher?: { close(): void };
  private watchEnabled: boolean;
  private knownAgentIds: string[];
  private lastLoadedContent: string = '';

  constructor(eventBus: EventBus, options?: ConfigManagerOptions) {
    this.eventBus = eventBus;
    this.resolvedConfig = { ...DEFAULT_CONFIG };
    this.configPath = options?.configPath;
    this.watchEnabled = options?.watchEnabled ?? false;
    this.knownAgentIds = options?.knownAgentIds ?? [];
  }

  /**
   * 设置文件系统实现（依赖注入，便于测试）
   */
  setFileSystem(fs: FileSystem): void {
    this.fs = fs;
  }

  /**
   * FR-H01 AC1: 初始化配置
   * 无配置文件时以合理默认值启动
   */
  async initialize(): Promise<{ created: boolean; errors: ConfigValidationError[] }> {
    if (!this.fs || !this.configPath) {
      // 无文件系统或路径，使用默认配置
      this.fileConfig = {};
      this.resolvedConfig = { ...DEFAULT_CONFIG };
      return { created: false, errors: [] };
    }

    const exists = await this.fs.exists(this.configPath);

    if (!exists) {
      // FR-H01 AC1: 生成最小配置
      const content = generateMinimalConfig();
      await this.fs.writeFile(this.configPath, content);
      this.lastLoadedContent = content;
      this.fileConfig = JSON.parse(content) as AcoFileConfig;
      this.resolvedConfig = this.resolveConfig(this.fileConfig);
      this.startWatching();
      return { created: true, errors: [] };
    }

    // 加载已有配置
    const result = await this.loadFromFile();
    this.startWatching();
    return { created: false, errors: result.errors };
  }

  /**
   * FR-H02 AC1: 从文件加载配置
   * FR-H02 AC2: 加载前执行 schema 校验，失败时拒绝加载
   */
  async loadFromFile(): Promise<{ success: boolean; errors: ConfigValidationError[] }> {
    if (!this.fs || !this.configPath) {
      return { success: false, errors: [{ path: '/', message: 'No file system or config path configured', severity: 'error' }] };
    }

    let content: string;
    try {
      content = await this.fs.readFile(this.configPath);
    } catch (err) {
      return {
        success: false,
        errors: [{
          path: '/',
          message: `Failed to read config file: ${(err as Error).message}`,
          severity: 'error',
        }],
      };
    }

    // 内容未变化，跳过
    if (content === this.lastLoadedContent) {
      return { success: true, errors: [] };
    }

    let parsed: unknown;
    try {
      // FR-H03 AC4: 支持 JSON 和 YAML 两种格式
      if (this.configPath && (this.configPath.endsWith('.yaml') || this.configPath.endsWith('.yml'))) {
        parsed = parseYaml(content);
      } else {
        parsed = JSON.parse(content);
      }
    } catch (err) {
      return {
        success: false,
        errors: [{
          path: '/',
          message: `Invalid config format: ${(err as Error).message}`,
          suggestion: 'Check for syntax errors in your configuration file',
          severity: 'error',
        }],
      };
    }

    // FR-H03 AC1: 校验
    const errors = validateConfig(parsed, this.knownAgentIds);
    const hasErrors = errors.some(e => e.severity === 'error');

    if (hasErrors) {
      // FR-H02 AC2: 校验失败，拒绝加载，保持旧配置
      return { success: false, errors };
    }

    // 校验通过，应用新配置
    const oldConfig = { ...this.fileConfig };
    this.fileConfig = parsed as AcoFileConfig;
    this.lastLoadedContent = content;

    const newResolved = this.resolveConfig(this.fileConfig);
    const changes = this.detectChanges(this.resolvedConfig, newResolved);
    this.resolvedConfig = newResolved;

    // FR-H02 AC3: 配置变更写入 Audit Event
    if (changes.changedFields.length > 0) {
      this.emitConfigChanged(changes);
    }

    return { success: true, errors };
  }

  /**
   * FR-H02 AC4: 手动触发重新加载
   */
  async reload(): Promise<{ success: boolean; errors: ConfigValidationError[] }> {
    // 强制重新读取（清除缓存）
    this.lastLoadedContent = '';
    return this.loadFromFile();
  }

  /**
   * FR-H03 AC1: 校验当前配置
   */
  validate(): ConfigValidationError[] {
    return validateConfig(this.fileConfig, this.knownAgentIds);
  }

  /**
   * FR-H03 AC1: 校验任意配置对象
   */
  validateExternal(config: unknown, knownAgentIds?: string[]): ConfigValidationError[] {
    return validateConfig(config, knownAgentIds ?? this.knownAgentIds);
  }

  /**
   * FR-H04 AC3: 启用功能
   */
  enableFeature(flag: FeatureFlag): { enabled: FeatureFlag[]; template: Partial<AcoFileConfig> } {
    const currentEnabled = this.fileConfig.features?.enabled ?? ['scheduling'];
    const result = enableFeature(currentEnabled, flag);

    // 更新内存中的配置
    if (!this.fileConfig.features) {
      this.fileConfig.features = {};
    }
    this.fileConfig.features.enabled = result.enabled;

    // 合并模板到配置
    this.mergeTemplate(result.template);

    // 重新解析
    this.resolvedConfig = this.resolveConfig(this.fileConfig);

    return result;
  }

  /**
   * 禁用功能
   */
  disableFeature(flag: FeatureFlag): FeatureFlag[] {
    const currentEnabled = this.fileConfig.features?.enabled ?? ['scheduling'];
    const result = disableFeature(currentEnabled, flag);

    if (!this.fileConfig.features) {
      this.fileConfig.features = {};
    }
    this.fileConfig.features.enabled = result;
    this.resolvedConfig = this.resolveConfig(this.fileConfig);

    return result;
  }

  /**
   * FR-H04 AC2: 检查功能是否启用
   */
  isFeatureEnabled(flag: FeatureFlag): boolean {
    const enabled = this.fileConfig.features?.enabled ?? ['scheduling'];
    return isFeatureEnabled(enabled, flag);
  }

  /**
   * FR-H04 AC4: 获取功能状态
   */
  getFeatureStatus(): Array<{
    level: number;
    flag: FeatureFlag;
    name: string;
    enabled: boolean;
    description: string;
  }> {
    const enabled = this.fileConfig.features?.enabled ?? ['scheduling'];
    return getFeatureStatus(enabled);
  }

  /**
   * FR-H01 AC4: 单 Agent 环境下治理规则降级
   */
  shouldDowngradeGovernance(): boolean {
    const agentCount = this.fileConfig.pool?.agents?.length ?? 0;
    return shouldDowngradeGovernance(agentCount);
  }

  /**
   * 获取解析后的运行时配置
   */
  getConfig(): AcoConfig {
    return { ...this.resolvedConfig };
  }

  /**
   * 获取文件配置（原始）
   */
  getFileConfig(): AcoFileConfig {
    return { ...this.fileConfig };
  }

  /**
   * 获取配置文件内容（用于持久化）
   */
  getConfigContent(): string {
    return JSON.stringify(this.fileConfig, null, 2);
  }

  /**
   * 更新已知 Agent 列表（用于校验）
   */
  setKnownAgentIds(ids: string[]): void {
    this.knownAgentIds = ids;
  }

  /**
   * 停止文件监听
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }

  /**
   * 销毁
   */
  destroy(): void {
    this.stopWatching();
  }

  // --- Private ---

  /**
   * FR-H02 AC1: 启动文件监听
   */
  private startWatching(): void {
    if (!this.watchEnabled || !this.fs || !this.configPath) return;
    if (this.watcher) return;

    this.watcher = this.fs.watch(this.configPath, () => {
      // 异步重新加载
      this.loadFromFile().catch(() => {});
    });
  }

  /**
   * 将文件配置解析为运行时 AcoConfig
   */
  private resolveConfig(fileConfig: AcoFileConfig): AcoConfig {
    return {
      defaultTimeout: fileConfig.scheduling?.defaultTimeout ?? DEFAULT_CONFIG.defaultTimeout,
      minTimeout: fileConfig.scheduling?.minTimeout ?? DEFAULT_CONFIG.minTimeout,
      defaultPriority: fileConfig.scheduling?.defaultPriority ?? DEFAULT_CONFIG.defaultPriority,
      substantiveTokenThreshold:
        fileConfig.scheduling?.substantiveTokenThreshold ?? DEFAULT_CONFIG.substantiveTokenThreshold,
      circuitBreakThreshold:
        fileConfig.governance?.circuitBreakThreshold ?? DEFAULT_CONFIG.circuitBreakThreshold,
      circuitBreakDuration:
        fileConfig.governance?.circuitBreakDuration ?? DEFAULT_CONFIG.circuitBreakDuration,
      maxGlobalAcpConcurrency:
        fileConfig.governance?.maxGlobalAcpConcurrency ?? DEFAULT_CONFIG.maxGlobalAcpConcurrency,
      defaultPolicy: fileConfig.governance?.defaultPolicy ?? DEFAULT_CONFIG.defaultPolicy,
      dataDir: fileConfig.dataDir ?? DEFAULT_CONFIG.dataDir,
    };
  }

  /**
   * 检测配置变更
   */
  private detectChanges(
    oldConfig: AcoConfig,
    newConfig: AcoConfig,
  ): ConfigChangeEvent {
    const changedFields: string[] = [];
    const oldValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};

    for (const key of Object.keys(newConfig) as Array<keyof AcoConfig>) {
      if (oldConfig[key] !== newConfig[key]) {
        changedFields.push(key);
        oldValues[key] = oldConfig[key];
        newValues[key] = newConfig[key];
      }
    }

    return {
      timestamp: Date.now(),
      changedFields,
      oldValues,
      newValues,
    };
  }

  /**
   * 合并功能模板到当前配置
   */
  private mergeTemplate(template: Partial<AcoFileConfig>): void {
    if (template.scheduling && !this.fileConfig.scheduling) {
      this.fileConfig.scheduling = template.scheduling;
    }
    if (template.governance && !this.fileConfig.governance) {
      this.fileConfig.governance = template.governance;
    }
    if (template.chains && !this.fileConfig.chains) {
      this.fileConfig.chains = template.chains;
    }
    if (template.notification && !this.fileConfig.notification) {
      this.fileConfig.notification = template.notification;
    }
  }

  /**
   * FR-H02 AC3: 发射配置变更审计事件
   */
  private emitConfigChanged(changes: ConfigChangeEvent): void {
    const event: AuditEvent = {
      eventId: uuid(),
      type: 'config_changed',
      timestamp: changes.timestamp,
      details: {
        changedFields: changes.changedFields,
        oldValues: changes.oldValues,
        newValues: changes.newValues,
      },
    };
    this.eventBus.emit('audit', event).catch(() => {});
    this.eventBus.emit('config:changed', changes).catch(() => {});
  }
}
