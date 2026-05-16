/**
 * aco init — 项目初始化
 * FR-Z01: 一键初始化
 * FR-Z02 AC1: init 子命令
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, resolve, dirname, extname } from 'node:path';
import { homedir } from 'node:os';
import { hasFlag } from '../parse-args.js';
import { createEventBus, createNotificationManager, loadFileConfig, fileExists as sharedFileExists } from './shared.js';
import type { AcoFileConfig, NotificationChannelFileEntry } from '../../config/config-schema.js';
import { runAllGenerators, listGenerators } from '../../generators/index.js';

const HELP = `
aco init — 初始化 ACO L2 调度规则

Usage:
  aco init [options]

Options:
  --help          显示帮助
  --list          列出所有已注册的 generator
  --dry-run       只输出将要生成的配置，不写入文件
  --force         覆盖已有规则配置文件

Description:
  自动检测 OpenClaw 环境并生成 ~/.openclaw/extensions/aco-rules/rules.json。
  - 只读取 openclaw.json，不修改宿主配置
  - 检测已有插件并协调冲突
  - 生成 8 条开箱即用 L2 调度治理规则
  - 重复执行默认不覆盖已有规则（使用 --force 覆盖）

Examples:
  aco init
  aco init --dry-run
  aco init --force
`.trim();

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface HostAgent {
  id: string;
  model?: string;
  runtimeType: 'acp' | 'subagent' | 'unknown';
  roles: string[];
  tier?: string | number;
}

interface DetectedPlugin {
  id: string;
  enabled: boolean;
  config?: unknown;
}

interface DetectedEnvironment {
  type: 'openclaw' | 'standalone';
  openclawConfigPath?: string;
  openclawHome: string;
  rulesPath: string;
  dataDir: string;
  agents: HostAgent[];
  plugins: DetectedPlugin[];
  pluginIds: Set<string>;
  agentCount: number;
  agentsWithRoles: number;
  dispatchGuardMaxAcp: number;
  legacyTaskBoardPath?: string;
  legacyAuditSources: string[];
}

interface AcoRule {
  id: string;
  name: string;
  mode: 'enforce' | 'warn' | 'delegate';
  config: Record<string, unknown>;
  conflicts: Array<{
    plugin: string;
    strategy: 'delegate' | 'inherit' | 'bridge' | 'aggregate' | 'exclude' | 'compatible';
    note: string;
  }>;
}

interface RulesFile {
  version: 1;
  generatedAt: string;
  source: 'aco init';
  host: {
    type: DetectedEnvironment['type'];
    openclawConfigPath?: string;
    openclawHome: string;
  };
  environment: {
    agentCount: number;
    agentsWithRoles: number;
    detectedPlugins: string[];
  };
  rules: AcoRule[];
}

function getOpenclawHome(configPath?: string): string {
  if (configPath) return dirname(configPath);
  return join(homedir(), '.openclaw');
}

function normalizePluginId(id: string): string {
  if (id === 'dispatch-guard') return 'agent-dispatch-guard';
  return id;
}

function collectPlugins(config: Record<string, unknown>): DetectedPlugin[] {
  const plugins: DetectedPlugin[] = [];
  const seen = new Set<string>();
  const add = (id: string, enabled = true, pluginConfig?: unknown) => {
    const normalized = normalizePluginId(id);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    plugins.push({ id: normalized, enabled, config: pluginConfig });
  };

  const pluginsRoot = config.plugins as Record<string, unknown> | undefined;
  const entries = pluginsRoot?.entries as Record<string, unknown> | undefined;
  if (entries && typeof entries === 'object') {
    for (const [id, value] of Object.entries(entries)) {
      const entry = value as Record<string, unknown> | undefined;
      const enabled = entry?.enabled !== false;
      add(id, enabled, entry?.config);
    }
  }

  const allow = pluginsRoot?.allow;
  if (Array.isArray(allow)) {
    for (const id of allow) {
      if (typeof id === 'string') add(id, true);
    }
  }

  const load = pluginsRoot?.load as Record<string, unknown> | undefined;
  const paths = load?.paths;
  if (Array.isArray(paths)) {
    for (const p of paths) {
      if (typeof p !== 'string') continue;
      add(p.split('/').filter(Boolean).pop() ?? p, true);
    }
  }

  return plugins;
}

function inferRoles(agent: Record<string, unknown>): string[] {
  const rawRoles = agent.roles ?? agent.role;
  if (Array.isArray(rawRoles)) return rawRoles.filter((r): r is string => typeof r === 'string');
  if (typeof rawRoles === 'string') return [rawRoles];

  const id = String(agent.id ?? '');
  const runtimeType = inferRuntimeType(agent);
  if (id.includes('audit')) return ['audit'];
  if (id.includes('pm')) return ['product'];
  if (id.includes('sa')) return ['architecture'];
  if (id.includes('ux')) return ['ux'];
  if (runtimeType === 'acp' || id.includes('dev') || id.includes('code') || id === 'cc') return ['coding'];
  return [];
}

function inferTier(agent: Record<string, unknown>): string | number | undefined {
  if (typeof agent.tier === 'string' || typeof agent.tier === 'number') return agent.tier;
  const id = String(agent.id ?? '');
  if (id === 'cc' || id === 'free-code') return 1;
  if (id === 'opencode' || id === 'codex') return 2;
  if (id === 'hermes') return 3;
  if (id.startsWith('dev-')) return 4;
  return undefined;
}

function inferRuntimeType(agent: Record<string, unknown>): HostAgent['runtimeType'] {
  const runtime = agent.runtime as Record<string, unknown> | undefined;
  if (runtime?.type === 'acp') return 'acp';
  if (agent.agentDir || agent.workspace) return 'subagent';
  return 'unknown';
}

function extractAgents(config: Record<string, unknown>): HostAgent[] {
  const agentsRoot = config.agents as Record<string, unknown> | undefined;
  const list = agentsRoot?.list;
  if (!Array.isArray(list)) return [];

  return list
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && typeof item.id === 'string')
    .map(agent => ({
      id: agent.id as string,
      model: typeof agent.model === 'string' ? agent.model : undefined,
      runtimeType: inferRuntimeType(agent),
      roles: inferRoles(agent),
      tier: inferTier(agent),
    }));
}

function readDispatchGuardMaxAcp(): number {
  const raw = process.env.DISPATCH_GUARD_MAX_ACP;
  const parsed = Number(raw ?? 8);
  if (!Number.isFinite(parsed)) return 8;
  return Math.max(1, Math.min(10, parsed));
}

async function detectEnvironment(): Promise<DetectedEnvironment> {
  const candidates = [
    join(process.cwd(), 'openclaw.json'),
    join(homedir(), '.openclaw', 'openclaw.json'),
    ...(process.env.ACO_DISABLE_ROOT_CONFIG === '1' ? [] : ['/root/.openclaw/openclaw.json']),
  ];

  for (const p of candidates) {
    if (!(await fileExists(p))) continue;
    try {
      const content = await readFile(p, 'utf-8');
      const config = JSON.parse(content) as Record<string, unknown>;
      const agents = extractAgents(config);
      const plugins = collectPlugins(config).filter(p => p.enabled);
      const pluginIds = new Set(plugins.map(p => p.id));
      const openclawHome = getOpenclawHome(p);
      const logsDir = join(openclawHome, 'workspace', 'logs');
      const legacyAuditSources = [
        join(logsDir, 'dispatch-guard-events.jsonl'),
        join(logsDir, 'run-watchdog-events.jsonl'),
      ];

      return {
        type: 'openclaw',
        openclawConfigPath: p,
        openclawHome,
        rulesPath: join(openclawHome, 'extensions', 'aco-rules', 'rules.json'),
        dataDir: join(openclawHome, 'aco-data'),
        agents,
        plugins,
        pluginIds,
        agentCount: agents.length,
        agentsWithRoles: agents.filter(a => a.roles.length > 0).length,
        dispatchGuardMaxAcp: readDispatchGuardMaxAcp(),
        legacyTaskBoardPath: join(logsDir, 'subagent-task-board.json'),
        legacyAuditSources,
      };
    } catch {
      // Continue with next candidate.
    }
  }

  const openclawHome = join(homedir(), '.openclaw');
  return {
    type: 'standalone',
    openclawHome,
    rulesPath: join(openclawHome, 'extensions', 'aco-rules', 'rules.json'),
    dataDir: join(openclawHome, 'aco-data'),
    agents: [],
    plugins: [],
    pluginIds: new Set(),
    agentCount: 0,
    agentsWithRoles: 0,
    dispatchGuardMaxAcp: readDispatchGuardMaxAcp(),
    legacyAuditSources: [],
  };
}

function conflict(
  plugin: string,
  strategy: AcoRule['conflicts'][number]['strategy'],
  note: string,
): AcoRule['conflicts'][number] {
  return { plugin, strategy, note };
}

function generateRules(env: DetectedEnvironment): AcoRule[] {
  const hasRunWatchdog = env.pluginIds.has('run-watchdog');
  const hasDispatchGuard = env.pluginIds.has('agent-dispatch-guard');
  const hasSevoPipeline = env.pluginIds.has('sevo-pipeline');

  const timeoutMode: AcoRule['mode'] = hasRunWatchdog ? 'delegate' : 'enforce';
  const sevoExcludePatterns = hasSevoPipeline ? ['sevo:*'] : [];

  return [
    {
      id: 'timeout-protection',
      name: '超时保护',
      mode: timeoutMode,
      config: {
        defaultTimeoutSeconds: 1200,
        minimumTimeoutSeconds: 300,
        timeoutProvider: hasRunWatchdog ? 'run-watchdog' : 'aco',
        auditOnlyWhenDelegated: true,
      },
      conflicts: hasRunWatchdog
        ? [conflict('run-watchdog', 'delegate', 'run-watchdog 已存在，ACO 只记录审计，不重复执行超时处置')]
        : [],
    },
    {
      id: 'substantive-success-validation',
      name: '实质成功校验',
      mode: 'enforce',
      config: {
        minimumOutputTokens: 3000,
        requireArtifactForLongTasks: true,
        treatLowOutputAsFailure: true,
      },
      conflicts: [],
    },
    {
      id: 'concurrency-limit',
      name: '并发控制',
      mode: 'enforce',
      config: {
        perAgentMaxConcurrency: 1,
        acpGlobalMax: hasDispatchGuard ? env.dispatchGuardMaxAcp : 8,
        source: hasDispatchGuard ? 'agent-dispatch-guard' : 'aco-default',
      },
      conflicts: hasDispatchGuard
        ? [conflict('agent-dispatch-guard', 'inherit', '继承 dispatch-guard 的 ACP 全局并发上限')]
        : [],
    },
    {
      id: 'main-session-idle',
      name: '主会话空闲保护',
      mode: 'warn',
      config: {
        longRunningExecThresholdSeconds: 30,
        warnOnly: true,
      },
      conflicts: hasDispatchGuard
        ? [conflict('agent-dispatch-guard', 'compatible', 'dispatch-guard 负责 prompt 约束，ACO 补充运行时告警')]
        : [],
    },
    {
      id: 'circuit-breaker',
      name: '熔断机制',
      mode: 'enforce',
      config: {
        consecutiveFailureThreshold: 3,
        cooldownSeconds: 300,
        scope: 'agent',
      },
      conflicts: [],
    },
    {
      id: 'task-board',
      name: '任务看板',
      mode: 'enforce',
      config: {
        storage: 'sqlite',
        sqlitePath: join(env.dataDir, 'aco.sqlite'),
        walMode: true,
        legacyJsonBridge: hasRunWatchdog,
        legacyJsonPath: hasRunWatchdog ? env.legacyTaskBoardPath : undefined,
      },
      conflicts: hasRunWatchdog
        ? [conflict('run-watchdog', 'bridge', '检测到 run-watchdog 看板，启用 JSON 桥接，迁移期双写')]
        : [],
    },
    {
      id: 'audit-trail',
      name: '调度审计',
      mode: 'enforce',
      config: {
        auditPath: join(env.dataDir, 'audit', 'aco-audit.jsonl'),
        retentionDays: 30,
        legacySources: env.legacyAuditSources,
      },
      conflicts: [
        ...(hasDispatchGuard ? [conflict('agent-dispatch-guard', 'aggregate', '保留 dispatch-guard 审计日志读取兼容')] : []),
        ...(hasRunWatchdog ? [conflict('run-watchdog', 'aggregate', '保留 run-watchdog 审计日志读取兼容')] : []),
      ],
    },
    {
      id: 'failure-retry-escalation',
      name: '失败重试升级',
      mode: 'warn',
      config: {
        maxAttempts: 3,
        sameTierRetryLimit: 1,
        requireChangedPlanAfterFailure: true,
        excludeLabelPatterns: sevoExcludePatterns,
        tierSource: hasDispatchGuard ? 'agent-dispatch-guard' : 'aco-inference',
      },
      conflicts: [
        ...(hasDispatchGuard ? [conflict('agent-dispatch-guard', 'inherit', '读取 dispatch-guard 梯队定义作为升级输入')] : []),
        ...(hasSevoPipeline ? [conflict('sevo-pipeline', 'exclude', '排除 sevo:* 任务，不覆盖 SEVO 阶段重试逻辑')] : []),
      ],
    },
  ];
}

function generateRulesFile(env: DetectedEnvironment): RulesFile {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'aco init',
    host: {
      type: env.type,
      openclawConfigPath: env.openclawConfigPath,
      openclawHome: env.openclawHome,
    },
    environment: {
      agentCount: env.agentCount,
      agentsWithRoles: env.agentsWithRoles,
      detectedPlugins: [...env.pluginIds].sort(),
    },
    rules: generateRules(env),
  };
}

async function writeJsonIfNeeded(path: string, data: unknown, force: boolean, label: string): Promise<'written' | 'skipped'> {
  if ((await fileExists(path)) && !force) {
    console.log(`  - ${label} already exists: ${path}`);
    console.log('    Skipped. Use --force to overwrite.');
    return 'skipped';
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  console.log(`  ✓ ${label} written: ${path}`);
  return 'written';
}

async function ensureDataDirs(env: DetectedEnvironment, dryRun: boolean): Promise<void> {
  const dirs = [env.dataDir, join(env.dataDir, 'audit'), join(env.dataDir, 'snapshots')];
  if (dryRun) return;
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}

function printReport(env: DetectedEnvironment, rulesFile: RulesFile, dryRun: boolean, writeStatus?: string): void {
  const plugins = rulesFile.environment.detectedPlugins;

  console.log('ACO Init — L2 rule bootstrap');
  console.log('');
  console.log(`Environment: ${env.type}`);
  if (env.openclawConfigPath) console.log(`OpenClaw config: ${env.openclawConfigPath}`);
  console.log(`Agents discovered: ${env.agentCount} (${env.agentsWithRoles} with role hints)`);
  console.log(`Detected plugins: ${plugins.length > 0 ? plugins.join(', ') : 'none'}`);
  console.log(`Rules path: ${env.rulesPath}`);
  console.log('');

  if (dryRun) {
    console.log('Dry run: no files were written. The generated rules.json would be:');
    console.log(JSON.stringify(rulesFile, null, 2));
    return;
  }

  console.log('Activated rules:');
  for (const rule of rulesFile.rules) {
    const conflictText = rule.conflicts.length > 0
      ? ` — ${rule.conflicts.map(c => `${c.plugin}:${c.strategy}`).join(', ')}`
      : '';
    console.log(`  - ${rule.id}: ${rule.mode}${conflictText}`);
  }

  console.log('');
  if (writeStatus === 'skipped') {
    console.log('Existing rules kept unchanged. Re-run with --force to regenerate from the current host config.');
  } else {
    console.log(`Data directories ready: ${env.dataDir}`);
  }
  console.log('Next: add the aco-rules extension to your host only after reviewing this file. aco init did not modify openclaw.json.');
}



async function loadAcoConfig(): Promise<AcoFileConfig | null> {
  const candidates = [
    resolve(process.cwd(), 'aco.config.json'),
    resolve(process.cwd(), 'aco.config.yaml'),
    resolve(process.cwd(), 'aco.config.yml'),
  ];

  for (const p of candidates) {
    if (!(await fileExists(p))) continue;
    try {
      const content = await readFile(p, 'utf-8');
      const ext = extname(p);
      if (ext === '.yaml' || ext === '.yml') {
        const { parse } = await import('yaml');
        return parse(content) as AcoFileConfig;
      }
      return JSON.parse(content) as AcoFileConfig;
    } catch {
      return null;
    }
  }
  return null;
}

export async function initCommand(args: string[]): Promise<number> {
  if (hasFlag(args, 'help')) {
    console.log(HELP);
    return 0;
  }

  // FR-J01 AC4: --list shows all registered generators
  if (hasFlag(args, 'list')) {
    const generators = listGenerators();
    console.log('Registered generators:\n');
    for (const g of generators) {
      console.log(`  [${g.priority}] ${g.name} — ${g.description}`);
    }
    return 0;
  }

  const force = hasFlag(args, 'force');
  const dryRun = hasFlag(args, 'dry-run');
  const env = await detectEnvironment();
  const rulesFile = generateRulesFile(env);

  if (dryRun) {
    printReport(env, rulesFile, true);
    return 0;
  }

  await ensureDataDirs(env, dryRun);
  const writeStatus = await writeJsonIfNeeded(env.rulesPath, rulesFile, force, 'Rules config');

  // FR-J01: Run all registered generators (declarative plugin registration)
  const acoConfig = await loadAcoConfig();
  await runAllGenerators(env, acoConfig, force);

  printReport(env, rulesFile, false, writeStatus);

  // FR-F01 AC5/AC6: Auto-detect host IM channels and register
  const registeredChannels = await detectAndRegisterHostChannels(env);

  // FR-F04 AC6: Auto-run notify test after channel registration
  if (registeredChannels.length > 0) {
    await runAutoNotifyTest(registeredChannels);
  }

  return 0;
}

// --- FR-F01 AC5: Detect host IM channels ---

interface DetectedIMChannel {
  channelId: string;
  type: string;
  config: Record<string, unknown>;
}

/**
 * FR-F01 AC5: Detect IM channels already configured in the host environment.
 * Looks for feishu/lark-cli config, telegram bot tokens, discord webhooks, etc.
 * FR-F01 AC6: If no channels found, output hint without blocking.
 */
async function detectAndRegisterHostChannels(env: DetectedEnvironment): Promise<DetectedIMChannel[]> {
  const detected: DetectedIMChannel[] = [];

  // 1. Check openclaw.json for notification/IM config
  if (env.openclawConfigPath) {
    try {
      const content = await readFile(env.openclawConfigPath, 'utf-8');
      const config = JSON.parse(content) as Record<string, unknown>;

      // Check for lark/feishu configuration
      const larkConfig = extractLarkConfig(config);
      if (larkConfig) {
        detected.push(larkConfig);
      }

      // Check for telegram bot config
      const telegramConfig = extractTelegramConfig(config);
      if (telegramConfig) {
        detected.push(telegramConfig);
      }

      // Check for discord webhook config
      const discordConfig = extractDiscordConfig(config);
      if (discordConfig) {
        detected.push(discordConfig);
      }

      // Check for slack webhook config
      const slackConfig = extractSlackConfig(config);
      if (slackConfig) {
        detected.push(slackConfig);
      }
    } catch {
      // Config read failure is non-blocking
    }
  }

  // 2. Check environment variables for common IM tokens
  if (!detected.some(d => d.type === 'feishu')) {
    const feishuWebhook = process.env.FEISHU_WEBHOOK_URL ?? process.env.LARK_WEBHOOK_URL;
    if (feishuWebhook) {
      detected.push({
        channelId: 'feishu-env',
        type: 'feishu',
        config: { url: feishuWebhook },
      });
    }
  }

  if (!detected.some(d => d.type === 'telegram')) {
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.TELEGRAM_CHAT_ID;
    if (telegramToken && telegramChatId) {
      detected.push({
        channelId: 'telegram-env',
        type: 'telegram',
        config: { token: telegramToken, chatId: telegramChatId },
      });
    }
  }

  if (!detected.some(d => d.type === 'discord')) {
    const discordWebhook = process.env.DISCORD_WEBHOOK_URL;
    if (discordWebhook) {
      detected.push({
        channelId: 'discord-env',
        type: 'discord',
        config: { url: discordWebhook },
      });
    }
  }

  if (!detected.some(d => d.type === 'slack')) {
    const slackWebhook = process.env.SLACK_WEBHOOK_URL;
    if (slackWebhook) {
      detected.push({
        channelId: 'slack-env',
        type: 'slack',
        config: { url: slackWebhook },
      });
    }
  }

  // 3. Check for lark-cli availability (common in OpenClaw setups)
  if (!detected.some(d => d.type === 'feishu')) {
    const larkCliAvailable = await checkCommandExists('lark-cli');
    if (larkCliAvailable) {
      detected.push({
        channelId: 'feishu-lark-cli',
        type: 'feishu',
        config: { transport: 'lark-cli' },
      });
    }
  }

  // FR-F01 AC6: No channels detected — output hint, don't block
  if (detected.length === 0) {
    console.log('');
    console.log('ℹ No IM notification channels detected in host environment.');
    console.log('  To enable notifications, register a channel:');
    console.log('    aco notify add --type feishu --url <webhook-url> --name my-feishu');
    console.log('    aco notify add --type webhook --url <url> --name my-hook');
    console.log('  Or set environment variables: FEISHU_WEBHOOK_URL, DISCORD_WEBHOOK_URL, SLACK_WEBHOOK_URL');
    return [];
  }

  // Write detected channels to aco config
  await persistDetectedChannels(detected);

  console.log('');
  console.log(`✓ Auto-detected ${detected.length} notification channel(s) from host environment:`);
  for (const ch of detected) {
    console.log(`  - ${ch.channelId} (${ch.type})`);
  }

  return detected;
}

function extractLarkConfig(config: Record<string, unknown>): DetectedIMChannel | null {
  // Look for lark/feishu webhook in various config locations
  const im = config.im as Record<string, unknown> | undefined;
  const lark = im?.lark ?? im?.feishu ?? config.lark ?? config.feishu;
  if (lark && typeof lark === 'object') {
    const larkObj = lark as Record<string, unknown>;
    const webhookUrl = larkObj.webhookUrl ?? larkObj.webhook_url ?? larkObj.url;
    if (typeof webhookUrl === 'string') {
      return {
        channelId: 'feishu-host',
        type: 'feishu',
        config: { url: webhookUrl },
      };
    }
    // lark-cli based config
    const userId = larkObj.userId ?? larkObj.user_id;
    if (userId) {
      return {
        channelId: 'feishu-host',
        type: 'feishu',
        config: { transport: 'lark-cli', userId },
      };
    }
  }
  return null;
}

function extractTelegramConfig(config: Record<string, unknown>): DetectedIMChannel | null {
  const im = config.im as Record<string, unknown> | undefined;
  const telegram = im?.telegram ?? config.telegram;
  if (telegram && typeof telegram === 'object') {
    const tg = telegram as Record<string, unknown>;
    const token = tg.botToken ?? tg.bot_token ?? tg.token;
    const chatId = tg.chatId ?? tg.chat_id;
    if (typeof token === 'string' && chatId) {
      return {
        channelId: 'telegram-host',
        type: 'telegram',
        config: { token, chatId: String(chatId) },
      };
    }
  }
  return null;
}

function extractDiscordConfig(config: Record<string, unknown>): DetectedIMChannel | null {
  const im = config.im as Record<string, unknown> | undefined;
  const discord = im?.discord ?? config.discord;
  if (discord && typeof discord === 'object') {
    const dc = discord as Record<string, unknown>;
    const webhookUrl = dc.webhookUrl ?? dc.webhook_url ?? dc.url;
    if (typeof webhookUrl === 'string') {
      return {
        channelId: 'discord-host',
        type: 'discord',
        config: { url: webhookUrl },
      };
    }
  }
  return null;
}

function extractSlackConfig(config: Record<string, unknown>): DetectedIMChannel | null {
  const im = config.im as Record<string, unknown> | undefined;
  const slack = im?.slack ?? config.slack;
  if (slack && typeof slack === 'object') {
    const sl = slack as Record<string, unknown>;
    const webhookUrl = sl.webhookUrl ?? sl.webhook_url ?? sl.url;
    if (typeof webhookUrl === 'string') {
      return {
        channelId: 'slack-host',
        type: 'slack',
        config: { url: webhookUrl },
      };
    }
  }
  return null;
}

async function checkCommandExists(cmd: string): Promise<boolean> {
  try {
    const { execSync } = await import('node:child_process');
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function persistDetectedChannels(channels: DetectedIMChannel[]): Promise<void> {
  // Load existing ACO config
  const candidates = [
    resolve(process.cwd(), 'aco.config.json'),
    resolve(process.cwd(), 'aco.config.yaml'),
    resolve(process.cwd(), 'aco.config.yml'),
  ];

  let configPath = candidates[0];
  let config: AcoFileConfig = {};

  for (const p of candidates) {
    if (await fileExists(p)) {
      configPath = p;
      try {
        const content = await readFile(p, 'utf-8');
        const ext = extname(p);
        if (ext === '.yaml' || ext === '.yml') {
          const { parse } = await import('yaml');
          config = parse(content) as AcoFileConfig;
        } else {
          config = JSON.parse(content) as AcoFileConfig;
        }
      } catch {
        config = {};
      }
      break;
    }
  }

  if (!config.notification) {
    config.notification = {};
  }
  if (!config.notification.channels) {
    config.notification.channels = [];
  }

  // Add only channels not already registered
  for (const ch of channels) {
    const exists = config.notification.channels.some(
      existing => (existing.channelId ?? existing.type) === ch.channelId
    );
    if (!exists) {
      config.notification.channels.push({
        channelId: ch.channelId,
        type: ch.type,
        config: ch.config,
        enabled: true,
      });
    }
  }

  // Write config
  const ext = extname(configPath);
  if (ext === '.yaml' || ext === '.yml') {
    const { stringify } = await import('yaml');
    await writeFile(configPath, stringify(config), 'utf-8');
  } else {
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  }
}

// --- FR-F04 AC6: Auto notify test after init ---

/**
 * FR-F04 AC6: After channel registration, automatically run a connectivity test.
 * Failures output diagnostic info but do not block init.
 */
async function runAutoNotifyTest(channels: DetectedIMChannel[]): Promise<void> {
  console.log('');
  console.log('Running notification connectivity test...');

  const eventBus = createEventBus();
  const manager = createNotificationManager(eventBus);

  for (const ch of channels) {
    manager.registerChannel(ch.type as any, ch.config, ch.channelId);
  }

  const results = await manager.testAllChannels();
  let allPassed = true;

  for (const r of results) {
    if (r.success) {
      console.log(`  ✓ ${r.channelId} (${r.type}): reachable`);
    } else {
      console.log(`  ✗ ${r.channelId} (${r.type}): ${r.error ?? 'unreachable'}`);
      allPassed = false;
    }
  }

  if (allPassed) {
    console.log('✓ All notification channels verified.');
  } else {
    console.log('');
    console.log('⚠ Some channels failed connectivity test. Notifications may not work until resolved.');
    console.log('  Run "aco notify status" for details, or "aco notify test" to retry.');
  }
}
