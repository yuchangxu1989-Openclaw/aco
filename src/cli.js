#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { inferRoleByAgentId, inferTierByAgentId } = require('../../../extensions/aco-dispatch-guard/routing-registry.cjs');

const HELP = `ACO — Agent Controlled Orchestration

Usage: aco <command> [options]

Commands:
  init        Initialize ACO L2 rules
  demo        演示完整调度生命周期（零依赖）

Run 'aco <command> --help' for command-specific help.

Note: For the full CLI (dispatch, task, pool, rule, etc.), use the compiled
entry point: node dist/esm/cli/index.js <command>`;

const INIT_HELP = `aco init — 初始化 ACO L2 调度规则

Usage:
  aco init [options]

Options:
  --help          显示帮助
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
  aco init --force`;

const hasFlag = (argv, flag) => argv.includes(`--${flag}`);

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function normalizePluginId(id) {
  const aliases = { 'dispatch-guard': 'aco-dispatch-guard', 'agent-dispatch-guard': 'aco-dispatch-guard', 'run-watchdog': 'aco-run-watchdog', 'doctor-guard': 'aco-doctor-guard', 'objective-fact-guard': 'aco-objective-fact-guard', 'output-humanizer-guard': 'aco-output-humanizer-guard', 'session-context-recovery': 'aco-session-context-recovery', 'browser-session-lease': 'aco-browser-session-lease', 'spec-challenge-guard': 'aco-spec-challenge-guard' };
  return aliases[id] || id;
}

function collectPlugins(config) {
  const out = [];
  const seen = new Set();
  const add = (id, enabled = true, pluginConfig = undefined) => {
    const normalized = normalizePluginId(id);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push({ id: normalized, enabled, config: pluginConfig });
  };

  const root = config.plugins || {};
  if (root.entries && typeof root.entries === 'object') {
    for (const [id, entry] of Object.entries(root.entries)) {
      add(id, entry?.enabled !== false, entry?.config);
    }
  }
  if (Array.isArray(root.allow)) {
    for (const id of root.allow) if (typeof id === 'string') add(id, true);
  }
  if (Array.isArray(root.load?.paths)) {
    for (const p of root.load.paths) if (typeof p === 'string') add(p.split('/').filter(Boolean).pop() || p, true);
  }
  return out;
}

function inferRuntimeType(agent) {
  if (agent.runtime?.type === 'acp') return 'acp';
  if (agent.agentDir || agent.workspace) return 'subagent';
  return 'unknown';
}

function inferRoles(agent) {
  const raw = agent.roles ?? agent.role;
  if (Array.isArray(raw)) return raw.filter(r => typeof r === 'string');
  if (typeof raw === 'string') return [raw];
  const inferredRole = inferRoleByAgentId(String(agent.id || ''));
  return inferredRole ? [inferredRole] : [];
}

function inferTier(agent) {
  if (typeof agent.tier === 'string' || typeof agent.tier === 'number') return agent.tier;
  const inferredTier = inferTierByAgentId(String(agent.id || ''));
  if (!inferredTier) return undefined;
  const numericTier = Number.parseInt(String(inferredTier).replace(/^T/i, ''), 10);
  return Number.isFinite(numericTier) ? numericTier : inferredTier;
}

function extractAgents(config) {
  const list = config.agents?.list;
  if (!Array.isArray(list)) return [];
  return list
    .filter(a => a && typeof a === 'object' && typeof a.id === 'string')
    .map(a => ({
      id: a.id,
      model: typeof a.model === 'string' ? a.model : undefined,
      runtimeType: inferRuntimeType(a),
      roles: inferRoles(a),
      tier: inferTier(a),
    }));
}

function readDispatchGuardMaxAcp() {
  const parsed = Number(process.env.DISPATCH_GUARD_MAX_ACP || 8);
  if (!Number.isFinite(parsed)) return 8;
  return Math.max(1, Math.min(10, parsed));
}

async function detectEnvironment() {
  const candidates = [
    join(process.cwd(), 'openclaw.json'),
    join(homedir(), '.openclaw', 'openclaw.json'),
  ];

  for (const p of candidates) {
    if (!(await exists(p))) continue;
    try {
      const config = JSON.parse(await readFile(p, 'utf-8'));
      const agents = extractAgents(config);
      const plugins = collectPlugins(config).filter(p => p.enabled);
      const pluginIds = new Set(plugins.map(p => p.id));
      const openclawHome = dirname(p);
      const logsDir = join(openclawHome, 'workspace', 'logs');
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
        legacyAuditSources: [
          join(logsDir, 'dispatch-guard-events.jsonl'),
          join(logsDir, 'run-watchdog-events.jsonl'),
        ],
      };
    } catch {
      // try next candidate
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

const conflict = (plugin, strategy, note) => ({ plugin, strategy, note });

function generateRules(env) {
  const hasRunWatchdog = env.pluginIds.has('aco-run-watchdog');
  const hasDispatchGuard = env.pluginIds.has('aco-dispatch-guard');
  const hasSevoPipeline = env.pluginIds.has('sevo-pipeline');
  return [
    {
      id: 'timeout-protection',
      name: '超时保护',
      mode: hasRunWatchdog ? 'delegate' : 'enforce',
      config: { defaultTimeoutSeconds: 1200, minimumTimeoutSeconds: 300, timeoutProvider: hasRunWatchdog ? 'aco-run-watchdog' : 'aco', auditOnlyWhenDelegated: true },
      conflicts: hasRunWatchdog ? [conflict('aco-run-watchdog', 'delegate', 'aco-run-watchdog 已存在，ACO 只记录审计，不重复执行超时处置')] : [],
    },
    {
      id: 'substantive-success-validation',
      name: '实质成功校验',
      mode: 'enforce',
      config: { minimumOutputTokens: 3000, requireArtifactForLongTasks: true, treatLowOutputAsFailure: true },
      conflicts: [],
    },
    {
      id: 'concurrency-limit',
      name: '并发控制',
      mode: 'enforce',
      config: { perAgentMaxConcurrency: 1, acpGlobalMax: hasDispatchGuard ? env.dispatchGuardMaxAcp : 8, source: hasDispatchGuard ? 'aco-dispatch-guard' : 'aco-default' },
      conflicts: hasDispatchGuard ? [conflict('aco-dispatch-guard', 'inherit', '继承 aco-dispatch-guard 的 ACP 全局并发上限')] : [],
    },
    {
      id: 'main-session-idle',
      name: '主会话空闲保护',
      mode: 'warn',
      config: { longRunningExecThresholdSeconds: 30, warnOnly: true },
      conflicts: hasDispatchGuard ? [conflict('aco-dispatch-guard', 'compatible', 'aco-dispatch-guard 负责 prompt 约束，ACO 补充运行时告警')] : [],
    },
    {
      id: 'circuit-breaker',
      name: '熔断机制',
      mode: 'enforce',
      config: { consecutiveFailureThreshold: 3, cooldownSeconds: 300, scope: 'agent' },
      conflicts: [],
    },
    {
      id: 'task-board',
      name: '任务看板',
      mode: 'enforce',
      config: { storage: 'sqlite', sqlitePath: join(env.dataDir, 'aco.sqlite'), walMode: true, legacyJsonBridge: hasRunWatchdog, legacyJsonPath: hasRunWatchdog ? env.legacyTaskBoardPath : undefined },
      conflicts: hasRunWatchdog ? [conflict('aco-run-watchdog', 'bridge', '检测到 aco-run-watchdog 看板，启用 JSON 桥接，迁移期双写')] : [],
    },
    {
      id: 'audit-trail',
      name: '调度审计',
      mode: 'enforce',
      config: { auditPath: join(env.dataDir, 'audit', 'aco-audit.jsonl'), retentionDays: 30, legacySources: env.legacyAuditSources },
      conflicts: [
        ...(hasDispatchGuard ? [conflict('aco-dispatch-guard', 'aggregate', '保留 aco-dispatch-guard 审计日志读取兼容')] : []),
        ...(hasRunWatchdog ? [conflict('aco-run-watchdog', 'aggregate', '保留 aco-run-watchdog 审计日志读取兼容')] : []),
      ],
    },
    {
      id: 'failure-retry-escalation',
      name: '失败重试升级',
      mode: 'warn',
      config: { maxAttempts: 3, sameTierRetryLimit: 1, requireChangedPlanAfterFailure: true, excludeLabelPatterns: hasSevoPipeline ? ['sevo:*'] : [], tierSource: hasDispatchGuard ? 'aco-dispatch-guard' : 'aco-inference' },
      conflicts: [
        ...(hasDispatchGuard ? [conflict('aco-dispatch-guard', 'inherit', '读取 aco-dispatch-guard 梯队定义作为升级输入')] : []),
        ...(hasSevoPipeline ? [conflict('sevo-pipeline', 'exclude', '排除 sevo:* 任务，不覆盖 SEVO 阶段重试逻辑')] : []),
      ],
    },
  ];
}

function generateRulesFile(env) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'aco init',
    host: { type: env.type, openclawConfigPath: env.openclawConfigPath, openclawHome: env.openclawHome },
    environment: { agentCount: env.agentCount, agentsWithRoles: env.agentsWithRoles, detectedPlugins: [...env.pluginIds].sort() },
    rules: generateRules(env),
  };
}

async function initCommand(args) {
  if (hasFlag(args, 'help')) {
    console.log(INIT_HELP);
    return 0;
  }

  const force = hasFlag(args, 'force');
  const dryRun = hasFlag(args, 'dry-run');
  const env = await detectEnvironment();
  const rulesFile = generateRulesFile(env);
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
    return 0;
  }

  let skipped = false;
  if ((await exists(env.rulesPath)) && !force) {
    skipped = true;
    console.log(`  - Rules config already exists: ${env.rulesPath}`);
    console.log('    Skipped. Use --force to overwrite.');
  } else {
    await mkdir(dirname(env.rulesPath), { recursive: true });
    await writeFile(env.rulesPath, `${JSON.stringify(rulesFile, null, 2)}\n`, 'utf-8');
    await mkdir(join(env.dataDir, 'audit'), { recursive: true });
    await mkdir(join(env.dataDir, 'snapshots'), { recursive: true });
    console.log(`  ✓ Rules config written: ${env.rulesPath}`);
  }

  console.log('');
  console.log('Activated rules:');
  for (const rule of rulesFile.rules) {
    const suffix = rule.conflicts.length ? ` — ${rule.conflicts.map(c => `${c.plugin}:${c.strategy}`).join(', ')}` : '';
    console.log(`  - ${rule.id}: ${rule.mode}${suffix}`);
  }
  console.log('');
  console.log(skipped ? 'Existing rules kept unchanged. Re-run with --force to regenerate from the current host config.' : `Data directories ready: ${env.dataDir}`);
  console.log('Next: add the aco-rules extension to your host only after reviewing this file. aco init did not modify openclaw.json.');
  return 0;
}

async function main(argv) {
  const command = argv.find(arg => !arg.startsWith('--'));
  if (!command || command === 'help') {
    console.log(HELP);
    return 0;
  }
  if (command === 'init') return initCommand(argv.slice(argv.indexOf('init') + 1));
  if (command === 'demo') {
    // Delegate to compiled TypeScript CLI
    const { demoCommand } = await import('../dist/esm/cli/commands/demo.js');
    return await demoCommand(argv.slice(argv.indexOf('demo') + 1));
  }
  if (hasFlag(argv, 'help')) {
    console.log(HELP);
    return 0;
  }
  console.error(`Error [ACO_UNKNOWN_CMD]: Unknown command '${command}'`);
  console.error(`Run 'aco --help' for available commands.`);
  return 1;
}

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
