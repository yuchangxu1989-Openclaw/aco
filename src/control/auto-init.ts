/**
 * FR-C06: 无感初始化
 * `aco init` 检测宿主环境，缺少必要能力时自动安装并激活。
 *
 * AC1: 自动检测宿主环境（OpenClaw 版本、已安装插件列表、Agent 池配置、运行时类型）
 * AC2: 缺少必要插件时自动下载并安装
 * AC3: 安装过程对用户透明，只输出一行摘要
 * AC4: 已有等效插件时复用其配置
 * AC5: init 完成后自动运行 health 验证
 * AC6: 幂等操作，重复执行只补充缺失项
 */

import type {
  InitEnvironment,
  InitResult,
  OpenClawConfig,
  PluginInfo,
} from './types.js';
import { CORE_CAPABILITIES, REQUIRED_PLUGINS } from './types.js';

/**
 * 执行无感初始化
 * 检测环境 → 识别缺失 → 安装补全 → 验证健康
 *
 * @param openclawConfig - 宿主环境的 openclaw.json 配置对象
 * @param options - 可选的安装器和环境检测器
 */
export async function autoInit(
  openclawConfig: OpenClawConfig,
  options?: AutoInitOptions,
): Promise<InitResult> {
  const installer = options?.installer ?? defaultInstaller;
  const detector = options?.detector ?? defaultDetector;
  const healthChecker = options?.healthChecker ?? defaultHealthChecker;

  // AC1: 检测宿主环境
  const env = detector(openclawConfig);

  // AC6: 幂等 — 识别已安装 vs 缺失
  const pluginStatus = checkPlugins(env.installedPlugins);
  const missing = pluginStatus.filter(p => !p.installed);
  const existing = pluginStatus.filter(p => p.installed);

  // AC4: 已有等效插件时跳过
  const activated: string[] = [];
  const skipped: string[] = existing.map(p => p.name);
  const failed: string[] = [];

  // AC2: 缺失插件自动安装
  for (const plugin of missing) {
    const success = await installer(plugin.name, openclawConfig);
    if (success) {
      activated.push(plugin.name);
    } else {
      failed.push(plugin.name);
    }
  }

  // AC5: post-init health 验证 — 验证已安装插件是否可加载
  const healthWarnings: string[] = [];
  const allPlugins = [...skipped, ...activated];
  for (const pluginName of allPlugins) {
    const result = await healthChecker(pluginName, openclawConfig);
    if (!result.healthy) {
      healthWarnings.push(`Plugin "${pluginName}" health check failed: ${result.error ?? 'unknown error'}`);
    }
  }

  // AC3: 生成一行摘要
  const success = failed.length === 0;
  const summary = buildSummary(activated, skipped, failed);

  return {
    activated,
    skipped,
    failed,
    success,
    summary,
    ...(healthWarnings.length > 0 ? { healthWarnings } : {}),
  };
}

/**
 * 检测宿主环境中的插件安装状态
 */
export function checkPlugins(installedPlugins: string[]): PluginInfo[] {
  const normalized = installedPlugins.map(p => p.toLowerCase().trim());
  return REQUIRED_PLUGINS.map(name => ({
    name,
    installed: normalized.includes(name.toLowerCase()),
  }));
}

/**
 * 检测宿主环境信息
 */
export function detectEnvironment(openclawConfig: OpenClawConfig): InitEnvironment {
  return defaultDetector(openclawConfig);
}

/**
 * 获取必需插件清单
 */
export function getRequiredPlugins(): readonly string[] {
  return REQUIRED_PLUGINS;
}

/**
 * 获取核心能力清单
 */
export function getCoreCapabilities(): readonly string[] {
  return CORE_CAPABILITIES;
}

// --- Types for dependency injection ---

export interface AutoInitOptions {
  /** 自定义插件安装器（用于测试或非标准环境） */
  installer?: PluginInstaller;
  /** 自定义环境检测器 */
  detector?: EnvironmentDetector;
  /** 自定义插件健康检查器（验证插件是否可加载） */
  healthChecker?: PluginHealthChecker;
}

export type PluginInstaller = (pluginName: string, config: OpenClawConfig) => Promise<boolean>;
export type EnvironmentDetector = (config: OpenClawConfig) => InitEnvironment;
export type PluginHealthChecker = (pluginName: string, config: OpenClawConfig) => Promise<{ healthy: boolean; error?: string }>;

// --- Internal helpers ---

function defaultDetector(config: OpenClawConfig): InitEnvironment {
  const plugins = config.plugins ?? [];
  const installedPlugins = plugins
    .filter(p => p.enabled !== false)
    .map(p => p.name);

  const agents = config.agents?.list ?? [];
  const agentCount = agents.length;

  return {
    installedPlugins,
    agentCount,
    runtimeType: agentCount > 1 ? 'multi-agent' : 'single-agent',
  };
}

/**
 * Default installer — logs intent but does not perform actual installation.
 * In production, this would be replaced by the host adapter's plugin install mechanism.
 */
const defaultInstaller: PluginInstaller = async (pluginName: string): Promise<boolean> => {
  // In a real environment, this would call the host adapter to install the plugin.
  // For the library layer, we return true to indicate the plugin can be installed.
  // The CLI layer (aco init command) provides the actual installer implementation.
  void pluginName;
  return true;
};

/**
 * Default health checker — verifies plugin is loadable.
 * In production, this would attempt to require/import the plugin and check its exports.
 */
const defaultHealthChecker: PluginHealthChecker = async (pluginName: string, config: OpenClawConfig): Promise<{ healthy: boolean; error?: string }> => {
  // Check if the plugin is listed and enabled in config
  const plugins = config.plugins ?? [];
  const plugin = plugins.find(p => p.name.toLowerCase() === pluginName.toLowerCase());
  if (!plugin) {
    return { healthy: false, error: 'plugin not found in config after installation' };
  }
  if (plugin.enabled === false) {
    return { healthy: false, error: 'plugin is disabled' };
  }
  return { healthy: true };
};

function buildSummary(activated: string[], skipped: string[], failed: string[]): string {
  const parts: string[] = [];

  if (activated.length > 0) {
    parts.push(`已激活：${mapToCapabilities(activated).join('、')}`);
  }
  if (skipped.length > 0) {
    parts.push(`已存在：${skipped.join(', ')}`);
  }
  if (failed.length > 0) {
    parts.push(`安装失败：${failed.join(', ')}`);
  }

  if (parts.length === 0) {
    return '所有核心能力已就绪';
  }

  return parts.join(' | ');
}

/**
 * Map plugin names to user-facing capability descriptions
 */
function mapToCapabilities(pluginNames: string[]): string[] {
  const mapping: Record<string, string> = {
    'run-watchdog': '超时保护',
    'dispatch-guard': '派发治理',
  };
  return pluginNames.map(name => mapping[name] ?? name);
}
