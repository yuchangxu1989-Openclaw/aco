/**
 * 域 H 测试：配置与渐进式披露
 * FR-H01: 零配置启动
 * FR-H02: 配置热加载
 * FR-H03: 配置校验与提示
 * FR-H04: 渐进式功能启用
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConfigManager } from '../src/config/config-manager.js';
import type { FileSystem } from '../src/config/config-manager.js';
import { EventBus } from '../src/event/event-bus.js';
import {
  validateConfig,
  generateMinimalConfig,
  generateAnnotatedConfig,
} from '../src/config/config-schema.js';
import type { AcoFileConfig, FeatureFlag } from '../src/config/config-schema.js';
import {
  FEATURE_LAYERS,
  getFeatureLayer,
  getFeatureLevel,
  isFeatureEnabled,
  enableFeature,
  disableFeature,
  getFeatureStatus,
  shouldDowngradeGovernance,
} from '../src/config/feature-layers.js';

/**
 * Mock FileSystem for testing
 */
function createMockFs(files: Record<string, string> = {}): FileSystem {
  const store = new Map(Object.entries(files));
  const watchers: Array<{ path: string; callback: () => void }> = [];

  return {
    async readFile(path: string): Promise<string> {
      const content = store.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    async writeFile(path: string, content: string): Promise<void> {
      store.set(path, content);
    },
    async exists(path: string): Promise<boolean> {
      return store.has(path);
    },
    watch(path: string, callback: () => void) {
      watchers.push({ path, callback });
      return { close() {} };
    },
    // Test helpers
    _store: store,
    _watchers: watchers,
    _triggerWatch(path: string) {
      watchers.filter(w => w.path === path).forEach(w => w.callback());
    },
  } as FileSystem & {
    _store: Map<string, string>;
    _watchers: Array<{ path: string; callback: () => void }>;
    _triggerWatch: (path: string) => void;
  };
}

describe('ConfigManager', () => {
  let eventBus: EventBus;
  let configManager: ConfigManager;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  describe('FR-H01: 零配置启动', () => {
    it('AC1: 无配置文件时生成最小配置', async () => {
      const fs = createMockFs();
      configManager = new ConfigManager(eventBus, {
        configPath: '/tmp/aco.config.json',
        watchEnabled: false,
      });
      configManager.setFileSystem(fs);

      const result = await configManager.initialize();

      expect(result.created).toBe(true);
      expect(result.errors).toHaveLength(0);

      // 验证文件已创建
      const written = await fs.readFile('/tmp/aco.config.json');
      expect(written).toBeTruthy();
      const parsed = JSON.parse(written);
      expect(parsed.scheduling).toBeDefined();
      expect(parsed.scheduling.defaultTimeout).toBe(600);
    });

    it('AC2: 最小配置下所有核心功能可用', async () => {
      const fs = createMockFs();
      configManager = new ConfigManager(eventBus, {
        configPath: '/tmp/aco.config.json',
        watchEnabled: false,
      });
      configManager.setFileSystem(fs);

      await configManager.initialize();
      const config = configManager.getConfig();

      // 核心功能配置都有合理默认值
      expect(config.defaultTimeout).toBe(600);
      expect(config.minTimeout).toBe(300);
      expect(config.defaultPriority).toBe(50);
      expect(config.substantiveTokenThreshold).toBe(3000);
      expect(config.dataDir).toBe('.aco');
    });

    it('AC3: 生成的配置文件包含注释说明', () => {
      const annotated = generateAnnotatedConfig();
      expect(annotated).toContain('// 默认超时时间');
      expect(annotated).toContain('// 超时下限');
      expect(annotated).toContain('// 默认优先级');
      expect(annotated).toContain('// 默认策略');
      expect(annotated).toContain('// 已启用的功能层');
    });

    it('AC4: 单 Agent 环境下治理规则自动降级为 warn 模式', () => {
      // 0 agents
      expect(shouldDowngradeGovernance(0)).toBe(true);
      // 1 agent
      expect(shouldDowngradeGovernance(1)).toBe(true);
      // 2+ agents
      expect(shouldDowngradeGovernance(2)).toBe(false);
      expect(shouldDowngradeGovernance(5)).toBe(false);
    });

    it('AC4: ConfigManager 检测单 Agent 降级', async () => {
      const minConfig: AcoFileConfig = {
        scheduling: { defaultTimeout: 600 },
        pool: { agents: [{ agentId: 'solo', tier: 'T2', runtimeType: 'subagent', roles: ['coder'] }] },
      };
      const fs = createMockFs({
        '/tmp/aco.config.json': JSON.stringify(minConfig),
      });
      configManager = new ConfigManager(eventBus, {
        configPath: '/tmp/aco.config.json',
        watchEnabled: false,
      });
      configManager.setFileSystem(fs);

      await configManager.initialize();
      expect(configManager.shouldDowngradeGovernance()).toBe(true);
    });

    it('无文件系统时使用默认配置', async () => {
      configManager = new ConfigManager(eventBus);
      const result = await configManager.initialize();

      expect(result.created).toBe(false);
      expect(result.errors).toHaveLength(0);

      const config = configManager.getConfig();
      expect(config.defaultTimeout).toBe(600);
    });
  });

  describe('FR-H02: 配置热加载', () => {
    it('AC1: 检测到文件变更后自动重新加载', async () => {
      const initialConfig: AcoFileConfig = {
        scheduling: { defaultTimeout: 600 },
      };
      const mockFs = createMockFs({
        '/tmp/aco.config.json': JSON.stringify(initialConfig),
      }) as FileSystem & { _store: Map<string, string>; _triggerWatch: (path: string) => void };

      configManager = new ConfigManager(eventBus, {
        configPath: '/tmp/aco.config.json',
        watchEnabled: true,
      });
      configManager.setFileSystem(mockFs);
      await configManager.initialize();

      expect(configManager.getConfig().defaultTimeout).toBe(600);

      // 修改文件内容
      const newConfig: AcoFileConfig = {
        scheduling: { defaultTimeout: 1200 },
      };
      mockFs._store.set('/tmp/aco.config.json', JSON.stringify(newConfig));

      // 触发 watch 回调
      mockFs._triggerWatch('/tmp/aco.config.json');

      // 等待异步加载
      await new Promise(r => setTimeout(r, 50));

      expect(configManager.getConfig().defaultTimeout).toBe(1200);
    });

    it('AC2: 校验失败时拒绝加载并保持旧配置', async () => {
      const initialConfig: AcoFileConfig = {
        scheduling: { defaultTimeout: 600 },
      };
      const mockFs = createMockFs({
        '/tmp/aco.config.json': JSON.stringify(initialConfig),
      }) as FileSystem & { _store: Map<string, string>; _triggerWatch: (path: string) => void };

      configManager = new ConfigManager(eventBus, {
        configPath: '/tmp/aco.config.json',
        watchEnabled: true,
      });
      configManager.setFileSystem(mockFs);
      await configManager.initialize();

      // 写入无效配置
      const invalidConfig = { scheduling: { defaultTimeout: -1 } };
      mockFs._store.set('/tmp/aco.config.json', JSON.stringify(invalidConfig));
      mockFs._triggerWatch('/tmp/aco.config.json');

      await new Promise(r => setTimeout(r, 50));

      // 旧配置保持不变
      expect(configManager.getConfig().defaultTimeout).toBe(600);
    });

    it('AC2: 无效 JSON 时拒绝加载', async () => {
      const initialConfig: AcoFileConfig = {
        scheduling: { defaultTimeout: 600 },
      };
      const mockFs = createMockFs({
        '/tmp/aco.config.json': JSON.stringify(initialConfig),
      }) as FileSystem & { _store: Map<string, string> };

      configManager = new ConfigManager(eventBus, {
        configPath: '/tmp/aco.config.json',
        watchEnabled: false,
      });
      configManager.setFileSystem(mockFs);
      await configManager.initialize();

      // 写入无效 JSON
      mockFs._store.set('/tmp/aco.config.json', '{ invalid json }');
      const result = await configManager.reload();

      expect(result.success).toBe(false);
      expect(result.errors[0].message).toContain('Invalid config format');
      // 旧配置保持
      expect(configManager.getConfig().defaultTimeout).toBe(600);
    });

    it('AC3: 配置变更写入 Audit Event', async () => {
      const initialConfig: AcoFileConfig = {
        scheduling: { defaultTimeout: 600 },
      };
      const mockFs = createMockFs({
        '/tmp/aco.config.json': JSON.stringify(initialConfig),
      }) as FileSystem & { _store: Map<string, string> };

      const auditEvents: unknown[] = [];
      eventBus.on('audit', (event) => { auditEvents.push(event); });
      eventBus.on('config:changed', (event) => { auditEvents.push(event); });

      configManager = new ConfigManager(eventBus, {
        configPath: '/tmp/aco.config.json',
        watchEnabled: false,
      });
      configManager.setFileSystem(mockFs);
      await configManager.initialize();

      // 修改配置
      const newConfig: AcoFileConfig = {
        scheduling: { defaultTimeout: 1200 },
      };
      mockFs._store.set('/tmp/aco.config.json', JSON.stringify(newConfig));
      await configManager.reload();

      // 应该有审计事件
      expect(auditEvents.length).toBeGreaterThan(0);
    });

    it('AC4: CLI 命令 reload 手动触发重新加载', async () => {
      const initialConfig: AcoFileConfig = {
        scheduling: { defaultTimeout: 600 },
      };
      const mockFs = createMockFs({
        '/tmp/aco.config.json': JSON.stringify(initialConfig),
      }) as FileSystem & { _store: Map<string, string> };

      configManager = new ConfigManager(eventBus, {
        configPath: '/tmp/aco.config.json',
        watchEnabled: false,
      });
      configManager.setFileSystem(mockFs);
      await configManager.initialize();

      // 修改文件
      const newConfig: AcoFileConfig = {
        scheduling: { defaultTimeout: 900 },
      };
      mockFs._store.set('/tmp/aco.config.json', JSON.stringify(newConfig));

      // 手动 reload
      const result = await configManager.reload();
      expect(result.success).toBe(true);
      expect(configManager.getConfig().defaultTimeout).toBe(900);
    });

    it('内容未变化时跳过重新加载', async () => {
      const initialConfig: AcoFileConfig = {
        scheduling: { defaultTimeout: 600 },
      };
      const content = JSON.stringify(initialConfig);
      const mockFs = createMockFs({
        '/tmp/aco.config.json': content,
      });

      configManager = new ConfigManager(eventBus, {
        configPath: '/tmp/aco.config.json',
        watchEnabled: false,
      });
      configManager.setFileSystem(mockFs);
      await configManager.initialize();

      // loadFromFile 不会触发变更事件
      const auditEvents: unknown[] = [];
      eventBus.on('config:changed', (event) => { auditEvents.push(event); });

      const result = await configManager.loadFromFile();
      expect(result.success).toBe(true);
      expect(auditEvents).toHaveLength(0);
    });
  });

  describe('FR-H03: 配置校验与提示', () => {
    it('AC1: validate 输出所有错误和警告', () => {
      const config = {
        scheduling: {
          defaultTimeout: -1,
          minTimeout: 'abc',
          defaultPriority: 200,
        },
        governance: {
          defaultPolicy: 'invalid',
        },
      };

      const errors = validateConfig(config);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.path.includes('defaultTimeout'))).toBe(true);
      expect(errors.some(e => e.path.includes('minTimeout'))).toBe(true);
      expect(errors.some(e => e.path.includes('defaultPriority'))).toBe(true);
      expect(errors.some(e => e.path.includes('defaultPolicy'))).toBe(true);
    });

    it('AC2: 错误信息包含字段路径、期望类型/值、实际值、修复建议', () => {
      const config = {
        scheduling: {
          defaultTimeout: -1,
        },
      };

      const errors = validateConfig(config);
      const timeoutError = errors.find(e => e.path === 'scheduling.defaultTimeout');
      expect(timeoutError).toBeDefined();
      expect(timeoutError!.path).toBe('scheduling.defaultTimeout');
      expect(timeoutError!.expected).toBeDefined();
      expect(timeoutError!.actual).toBe('-1');
      expect(timeoutError!.suggestion).toBeDefined();
    });

    it('AC3: 引用不存在的 agentId 提供具体修复命令', () => {
      const config = {
        pool: {
          agents: [
            { agentId: 'ghost-agent', tier: 'T2', runtimeType: 'subagent', roles: ['coder'] },
          ],
        },
      };

      const errors = validateConfig(config, ['cc', 'audit-01']);
      const agentError = errors.find(e => e.path.includes('agentId') && e.severity === 'warning');
      expect(agentError).toBeDefined();
      expect(agentError!.message).toContain('ghost-agent');
      expect(agentError!.suggestion).toContain('aco pool sync');
    });

    it('AC4: 支持 JSON 格式校验（YAML 解析由调用方处理）', () => {
      // JSON 格式的配置可以直接校验
      const validConfig = {
        scheduling: { defaultTimeout: 600 },
        governance: { defaultPolicy: 'open' },
      };
      const errors = validateConfig(validConfig);
      expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
    });

    it('null 配置返回错误', () => {
      const errors = validateConfig(null);
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain('non-null object');
    });

    it('非对象配置返回错误', () => {
      const errors = validateConfig('string');
      expect(errors.length).toBe(1);
      expect(errors[0].severity).toBe('error');
    });

    it('校验 notification channels 类型', () => {
      const config = {
        notification: {
          channels: [
            { type: 'invalid-type' },
          ],
        },
      };
      const errors = validateConfig(config);
      expect(errors.some(e => e.path.includes('type') && e.message.includes('invalid-type'))).toBe(true);
    });

    it('校验 features.enabled 无效值', () => {
      const config = {
        features: {
          enabled: ['scheduling', 'invalid-feature'],
        },
      };
      const errors = validateConfig(config);
      expect(errors.some(e => e.message.includes('invalid-feature'))).toBe(true);
    });

    it('校验 pool.agents 无效 tier', () => {
      const config = {
        pool: {
          agents: [
            { agentId: 'test', tier: 'T99', runtimeType: 'subagent', roles: [] },
          ],
        },
      };
      const errors = validateConfig(config);
      expect(errors.some(e => e.path.includes('tier'))).toBe(true);
    });

    it('校验 pool.agents 无效 runtimeType', () => {
      const config = {
        pool: {
          agents: [
            { agentId: 'test', tier: 'T2', runtimeType: 'invalid', roles: [] },
          ],
        },
      };
      const errors = validateConfig(config);
      expect(errors.some(e => e.path.includes('runtimeType'))).toBe(true);
    });

    it('校验 governance.rules 无效 action', () => {
      const config = {
        governance: {
          rules: [
            { action: 'destroy', priority: 1 },
          ],
        },
      };
      const errors = validateConfig(config);
      expect(errors.some(e => e.path.includes('action'))).toBe(true);
    });

    it('校验 cross-field: defaultTimeout < minTimeout', () => {
      const config = {
        scheduling: {
          defaultTimeout: 100,
          minTimeout: 300,
        },
      };
      const errors = validateConfig(config);
      expect(errors.some(e => e.message.includes('defaultTimeout must be >= minTimeout'))).toBe(true);
    });

    it('ConfigManager.validate() 校验当前配置', async () => {
      const config: AcoFileConfig = {
        scheduling: { defaultTimeout: 600 },
      };
      const mockFs = createMockFs({
        '/tmp/aco.config.json': JSON.stringify(config),
      });

      configManager = new ConfigManager(eventBus, {
        configPath: '/tmp/aco.config.json',
        watchEnabled: false,
      });
      configManager.setFileSystem(mockFs);
      await configManager.initialize();

      const errors = configManager.validate();
      expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
    });

    it('ConfigManager.validateExternal() 校验外部配置', () => {
      configManager = new ConfigManager(eventBus);
      const errors = configManager.validateExternal({
        scheduling: { defaultTimeout: -5 },
      });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('FR-H04: 渐进式功能启用', () => {
    it('AC1: 功能分层 L0→L1→L2→L3→L4', () => {
      expect(FEATURE_LAYERS).toHaveLength(5);
      expect(FEATURE_LAYERS[0].level).toBe(0);
      expect(FEATURE_LAYERS[0].flag).toBe('scheduling');
      expect(FEATURE_LAYERS[1].level).toBe(1);
      expect(FEATURE_LAYERS[1].flag).toBe('governance');
      expect(FEATURE_LAYERS[2].level).toBe(2);
      expect(FEATURE_LAYERS[2].flag).toBe('chains');
      expect(FEATURE_LAYERS[3].level).toBe(3);
      expect(FEATURE_LAYERS[3].flag).toBe('notification');
      expect(FEATURE_LAYERS[4].level).toBe(4);
      expect(FEATURE_LAYERS[4].flag).toBe('stats');
    });

    it('AC2: 每层功能独立启用，不依赖更高层', () => {
      // 可以只启用 notification 而不启用 governance 或 chains
      expect(isFeatureEnabled(['scheduling', 'notification'], 'notification')).toBe(true);
      expect(isFeatureEnabled(['scheduling', 'notification'], 'governance')).toBe(false);
      expect(isFeatureEnabled(['scheduling', 'notification'], 'chains')).toBe(false);
    });

    it('AC3: enableFeature 启用功能并返回配置模板', () => {
      const result = enableFeature(['scheduling'], 'governance');
      expect(result.enabled).toContain('governance');
      expect(result.template.governance).toBeDefined();
      expect(result.template.governance!.defaultPolicy).toBe('open');
    });

    it('AC3: enableFeature 对已启用的功能返回空模板', () => {
      const result = enableFeature(['scheduling'], 'scheduling');
      expect(result.enabled).toEqual(['scheduling']);
      expect(result.template).toEqual({});
    });

    it('AC3: enableFeature 对未知功能抛出错误', () => {
      expect(() => enableFeature(['scheduling'], 'unknown' as FeatureFlag)).toThrow('Unknown feature');
    });

    it('AC3: ConfigManager.enableFeature 更新内部状态', async () => {
      const config: AcoFileConfig = {
        scheduling: { defaultTimeout: 600 },
        features: { enabled: ['scheduling'] },
      };
      const mockFs = createMockFs({
        '/tmp/aco.config.json': JSON.stringify(config),
      });

      configManager = new ConfigManager(eventBus, {
        configPath: '/tmp/aco.config.json',
        watchEnabled: false,
      });
      configManager.setFileSystem(mockFs);
      await configManager.initialize();

      expect(configManager.isFeatureEnabled('notification')).toBe(false);

      const result = configManager.enableFeature('notification');
      expect(result.enabled).toContain('notification');
      expect(configManager.isFeatureEnabled('notification')).toBe(true);

      // 模板已合并
      const fileConfig = configManager.getFileConfig();
      expect(fileConfig.notification).toBeDefined();
    });

    it('AC4: getFeatureStatus 展示当前已启用的功能层级', () => {
      const status = getFeatureStatus(['scheduling', 'governance']);
      expect(status).toHaveLength(5);

      const scheduling = status.find(s => s.flag === 'scheduling');
      expect(scheduling!.enabled).toBe(true);
      expect(scheduling!.level).toBe(0);

      const governance = status.find(s => s.flag === 'governance');
      expect(governance!.enabled).toBe(true);

      const chains = status.find(s => s.flag === 'chains');
      expect(chains!.enabled).toBe(false);

      const notification = status.find(s => s.flag === 'notification');
      expect(notification!.enabled).toBe(false);

      const stats = status.find(s => s.flag === 'stats');
      expect(stats!.enabled).toBe(false);
    });

    it('AC4: ConfigManager.getFeatureStatus 返回完整状态', async () => {
      const config: AcoFileConfig = {
        features: { enabled: ['scheduling', 'chains'] },
      };
      const mockFs = createMockFs({
        '/tmp/aco.config.json': JSON.stringify(config),
      });

      configManager = new ConfigManager(eventBus, {
        configPath: '/tmp/aco.config.json',
        watchEnabled: false,
      });
      configManager.setFileSystem(mockFs);
      await configManager.initialize();

      const status = configManager.getFeatureStatus();
      expect(status.find(s => s.flag === 'scheduling')!.enabled).toBe(true);
      expect(status.find(s => s.flag === 'chains')!.enabled).toBe(true);
      expect(status.find(s => s.flag === 'governance')!.enabled).toBe(false);
    });

    it('disableFeature 移除功能', () => {
      const result = disableFeature(['scheduling', 'governance', 'notification'], 'governance');
      expect(result).toEqual(['scheduling', 'notification']);
    });

    it('ConfigManager.disableFeature 更新状态', async () => {
      const config: AcoFileConfig = {
        features: { enabled: ['scheduling', 'governance'] },
      };
      const mockFs = createMockFs({
        '/tmp/aco.config.json': JSON.stringify(config),
      });

      configManager = new ConfigManager(eventBus, {
        configPath: '/tmp/aco.config.json',
        watchEnabled: false,
      });
      configManager.setFileSystem(mockFs);
      await configManager.initialize();

      configManager.disableFeature('governance');
      expect(configManager.isFeatureEnabled('governance')).toBe(false);
    });

    it('getFeatureLayer 返回层级信息', () => {
      const layer = getFeatureLayer('notification');
      expect(layer).toBeDefined();
      expect(layer!.level).toBe(3);
      expect(layer!.name).toBe('Notification & IM Push');
    });

    it('getFeatureLevel 返回层级号', () => {
      expect(getFeatureLevel('scheduling')).toBe(0);
      expect(getFeatureLevel('governance')).toBe(1);
      expect(getFeatureLevel('chains')).toBe(2);
      expect(getFeatureLevel('notification')).toBe(3);
      expect(getFeatureLevel('stats')).toBe(4);
      expect(getFeatureLevel('unknown' as FeatureFlag)).toBe(-1);
    });
  });

  describe('ConfigManager 集成', () => {
    it('destroy 停止文件监听', async () => {
      const mockFs = createMockFs({
        '/tmp/aco.config.json': generateMinimalConfig(),
      });

      configManager = new ConfigManager(eventBus, {
        configPath: '/tmp/aco.config.json',
        watchEnabled: true,
      });
      configManager.setFileSystem(mockFs);
      await configManager.initialize();

      // 不应抛出
      configManager.destroy();
    });

    it('setKnownAgentIds 更新校验用的 Agent 列表', async () => {
      const config: AcoFileConfig = {
        pool: {
          agents: [
            { agentId: 'cc', tier: 'T1', runtimeType: 'subagent', roles: ['coder'] },
          ],
        },
      };
      const mockFs = createMockFs({
        '/tmp/aco.config.json': JSON.stringify(config),
      });

      configManager = new ConfigManager(eventBus, {
        configPath: '/tmp/aco.config.json',
        watchEnabled: false,
      });
      configManager.setFileSystem(mockFs);
      await configManager.initialize();

      // 设置已知 agents
      configManager.setKnownAgentIds(['cc', 'audit-01']);
      const errors = configManager.validate();
      // cc 存在于已知列表中，不应有 warning
      expect(errors.filter(e => e.severity === 'warning')).toHaveLength(0);
    });

    it('getConfigContent 返回可持久化的 JSON', async () => {
      const config: AcoFileConfig = {
        scheduling: { defaultTimeout: 800 },
        features: { enabled: ['scheduling'] },
      };
      const mockFs = createMockFs({
        '/tmp/aco.config.json': JSON.stringify(config),
      });

      configManager = new ConfigManager(eventBus, {
        configPath: '/tmp/aco.config.json',
        watchEnabled: false,
      });
      configManager.setFileSystem(mockFs);
      await configManager.initialize();

      const content = configManager.getConfigContent();
      const parsed = JSON.parse(content);
      expect(parsed.scheduling.defaultTimeout).toBe(800);
    });

    it('loadFromFile 处理文件读取错误', async () => {
      const mockFs: FileSystem = {
        async readFile() { throw new Error('Permission denied'); },
        async writeFile() {},
        async exists() { return true; },
        watch() { return { close() {} }; },
      };

      configManager = new ConfigManager(eventBus, {
        configPath: '/tmp/aco.config.json',
        watchEnabled: false,
      });
      configManager.setFileSystem(mockFs);

      const result = await configManager.loadFromFile();
      expect(result.success).toBe(false);
      expect(result.errors[0].message).toContain('Permission denied');
    });

    it('无 configPath 时 loadFromFile 返回错误', async () => {
      configManager = new ConfigManager(eventBus);
      const result = await configManager.loadFromFile();
      expect(result.success).toBe(false);
    });
  });
});

describe('generateMinimalConfig', () => {
  it('生成有效的 JSON', () => {
    const content = generateMinimalConfig();
    const parsed = JSON.parse(content);
    expect(parsed).toBeDefined();
    expect(parsed.scheduling).toBeDefined();
    expect(parsed.features.enabled).toContain('scheduling');
    expect(parsed.features.enabled).toContain('notification');
    expect(parsed.notification.subscriptions[0].events).toContain('task_completed');
    expect(parsed.notification.subscriptions[0].excludeLabels).toEqual(['healthcheck', 'heartbeat']);
    expect(parsed.notification.subscriptions[0].taskSources).toEqual(['subagent', 'acp']);
  });

  it('生成的配置通过校验', () => {
    const content = generateMinimalConfig();
    const parsed = JSON.parse(content);
    const errors = validateConfig(parsed);
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });
});
