/**
 * aco config — 配置管理
 * FR-Z02 AC1: config 子命令
 */

import { readFile, writeFile } from 'node:fs/promises';
import { hasFlag, getFlagValue } from '../parse-args.js';
import { getConfigPath, fileExists, loadFileConfig, createEventBus, createConfigManager } from './shared.js';
import { validateConfig, generateMinimalConfig, generateAnnotatedConfig } from '../../config/config-schema.js';

const HELP = `
aco config — 配置管理

Usage:
  aco config show               显示当前配置
  aco config validate           校验配置文件
  aco config generate           生成带注释的配置模板
  aco config generate --minimal 生成最小配置
  aco config features           查看功能层级状态

Options:
  --help        显示帮助
  --json        JSON 格式输出
  --minimal     生成最小配置（仅必填项）
  --output <p>  输出路径（generate 时使用）

Examples:
  aco config show
  aco config validate
  aco config generate --output aco.config.json
  aco config features
`.trim();

export async function configCommand(args: string[]): Promise<number> {
  if (hasFlag(args, 'help') || args.length === 0) {
    console.log(HELP);
    return 0;
  }

  const subcommand = args[0];
  const jsonOutput = hasFlag(args, 'json');

  switch (subcommand) {
    case 'show':
      return await showConfig(jsonOutput);
    case 'validate':
      return await validateConfigFile(jsonOutput);
    case 'generate':
      return await generateConfig(args);
    case 'features':
      return await showFeatures(jsonOutput);
    default:
      console.error(`Error [CONFIG_UNKNOWN_CMD]: Unknown subcommand '${subcommand}'`);
      console.error(`Suggestion: Run 'aco config --help' for usage.`);
      return 1;
  }
}

async function showConfig(json: boolean): Promise<number> {
  const configPath = getConfigPath();

  if (!(await fileExists(configPath))) {
    console.log('No configuration file found.');
    console.log(`Expected at: ${configPath}`);
    console.log('Run "aco config generate" to create one.');
    return 0;
  }

  const config = await loadFileConfig();

  if (json) {
    console.log(JSON.stringify(config, null, 2));
    return 0;
  }

  console.log(`Configuration: ${configPath}`);
  console.log('─'.repeat(50));

  // Scheduling
  if (config.scheduling) {
    console.log('\n[Scheduling]');
    if (config.scheduling.defaultTimeout) console.log(`  Default timeout: ${config.scheduling.defaultTimeout}s`);
    if (config.scheduling.defaultPriority) console.log(`  Default priority: ${config.scheduling.defaultPriority}`);
  }

  // Governance
  if (config.governance) {
    console.log('\n[Governance]');
    if (config.governance.defaultPolicy) console.log(`  Default policy: ${config.governance.defaultPolicy}`);
    if (config.governance.circuitBreakThreshold) console.log(`  Circuit break threshold: ${config.governance.circuitBreakThreshold}`);
    if (config.governance.maxGlobalAcpConcurrency) console.log(`  Max ACP concurrency: ${config.governance.maxGlobalAcpConcurrency}`);
  }

  // Pool
  if (config.pool?.agents) {
    console.log(`\n[Agent Pool] (${config.pool.agents.length} agents)`);
    for (const agent of config.pool.agents.slice(0, 10)) {
      console.log(`  ${agent.agentId} — ${agent.tier} ${agent.runtimeType} [${agent.roles?.join(', ') ?? ''}]`);
    }
    if (config.pool.agents.length > 10) {
      console.log(`  ... and ${config.pool.agents.length - 10} more`);
    }
  }

  // Features
  if (config.features?.enabled) {
    console.log(`\n[Features] ${config.features.enabled.join(', ')}`);
  }

  // Notification
  if (config.notification?.channels) {
    console.log(`\n[Notification] ${config.notification.channels.length} channel(s)`);
  }

  return 0;
}

async function validateConfigFile(json: boolean): Promise<number> {
  const configPath = getConfigPath();

  if (!(await fileExists(configPath))) {
    const msg = 'No configuration file to validate.';
    if (json) {
      console.log(JSON.stringify({ valid: true, message: msg, errors: [] }));
    } else {
      console.log(msg);
      console.log('Using default configuration (always valid).');
    }
    return 0;
  }

  let content: string;
  try {
    content = await readFile(configPath, 'utf-8');
  } catch (err) {
    const msg = `Cannot read config: ${(err as Error).message}`;
    if (json) {
      console.log(JSON.stringify({ valid: false, errors: [{ path: '/', message: msg, severity: 'error' }] }));
    } else {
      console.error(`✗ ${msg}`);
    }
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    const msg = `Invalid JSON: ${(err as Error).message}`;
    if (json) {
      console.log(JSON.stringify({ valid: false, errors: [{ path: '/', message: msg, severity: 'error' }] }));
    } else {
      console.error(`✗ ${msg}`);
      console.error('Suggestion: Check for trailing commas or missing quotes.');
    }
    return 1;
  }

  const errors = validateConfig(parsed);
  const hasErrors = errors.some(e => e.severity === 'error');
  const hasWarnings = errors.some(e => e.severity === 'warning');

  if (json) {
    console.log(JSON.stringify({ valid: !hasErrors, errors }));
    return hasErrors ? 1 : 0;
  }

  if (errors.length === 0) {
    console.log('✓ Configuration is valid.');
    return 0;
  }

  for (const err of errors) {
    const icon = err.severity === 'error' ? '✗' : '⚠';
    console.log(`  ${icon} [${err.path}] ${err.message}`);
    if (err.suggestion) console.log(`    → ${err.suggestion}`);
  }

  if (hasErrors) {
    console.log(`\n✗ Validation failed with ${errors.filter(e => e.severity === 'error').length} error(s).`);
  } else {
    console.log(`\n⚠ Valid with ${errors.length} warning(s).`);
  }

  return hasErrors ? 1 : 0;
}

async function generateConfig(args: string[]): Promise<number> {
  const minimal = hasFlag(args, 'minimal');
  const outputPath = getFlagValue(args, 'output');

  const content = minimal ? generateMinimalConfig() : generateAnnotatedConfig();

  if (outputPath) {
    if (await fileExists(outputPath)) {
      console.error(`Error [CONFIG_EXISTS]: File '${outputPath}' already exists.`);
      console.error('Suggestion: Remove it first or choose a different path.');
      return 1;
    }
    await writeFile(outputPath, content, 'utf-8');
    console.log(`✓ Configuration template written to: ${outputPath}`);
  } else {
    console.log(content);
  }

  return 0;
}

async function showFeatures(json: boolean): Promise<number> {
  const eventBus = createEventBus();
  const manager = createConfigManager(eventBus);
  await manager.initialize();

  const features = manager.getFeatureStatus();

  if (json) {
    console.log(JSON.stringify(features, null, 2));
    return 0;
  }

  console.log('Feature Layers (渐进式功能启用)');
  console.log('─'.repeat(50));

  for (const f of features) {
    const icon = f.enabled ? '●' : '○';
    console.log(`  L${f.level} ${icon} ${f.flag.padEnd(16)} ${f.name}`);
    console.log(`     ${f.description}`);
  }

  console.log('\n● = enabled, ○ = disabled');
  console.log('Enable with: aco config enable-feature <flag>');
  return 0;
}
