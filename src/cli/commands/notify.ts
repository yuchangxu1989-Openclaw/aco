/**
 * aco notify — 通知管理
 * FR-Z02 AC1: notify 子命令
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { hasFlag, getFlagValue } from '../parse-args.js';
import { createEventBus, createNotificationManager, loadFileConfig, fileExists, formatTable } from './shared.js';
import type { NotificationTaskSource, EventListenerStatus } from '../../notification/notification-manager.js';
import type { AcoFileConfig, NotificationChannelFileEntry } from '../../config/config-schema.js';

const HELP = `
aco notify — 通知管理

Usage:
  aco notify channels           列出已注册的通知通道
  aco notify add                添加通知通道
  aco notify status             显示所有通道状态
  aco notify test <channelId>   测试通道连通性
  aco notify send <channelId>   发送测试消息
  aco notify filter             查看当前订阅过滤器
  aco notify history            查看最近投递记录

Options:
  --help              显示帮助
  --json              JSON 格式输出
  --message <msg>     自定义测试消息内容
  --limit <n>         历史记录条数（默认 20）

Add Options:
  --type <type>       通道类型 (webhook | feishu | slack | telegram | discord)
  --url <url>         通道 URL (webhook endpoint)
  --name <name>       通道名称 (用作 channelId)
  --secret <secret>   可选：认证密钥

Examples:
  aco notify channels
  aco notify add --type webhook --url https://example.com/hook --name my-hook
  aco notify status
  aco notify test my-hook
  aco notify send my-hook --message "Hello from ACO"
  aco notify history --limit 10
`.trim();

export async function notifyCommand(args: string[]): Promise<number> {
  if (hasFlag(args, 'help') || args.length === 0) {
    console.log(HELP);
    return 0;
  }

  const subcommand = args[0];
  const jsonOutput = hasFlag(args, 'json');

  switch (subcommand) {
    case 'channels':
      return await listChannels(jsonOutput);
    case 'add':
      return await addChannel(args);
    case 'status':
      return await showStatus(jsonOutput);
    case 'test':
      return await testChannel(args[1], jsonOutput);
    case 'send':
      return await sendTest(args[1], args);
    case 'filter':
      return await showFilter(jsonOutput);
    case 'history':
      return await showHistory(args, jsonOutput);
    default:
      console.error(`Error [NOTIFY_UNKNOWN_CMD]: Unknown subcommand '${subcommand}'`);
      console.error(`Suggestion: Run 'aco notify --help' for usage.`);
      return 1;
  }
}

// --- aco notify add ---

async function addChannel(args: string[]): Promise<number> {
  const type = getFlagValue(args, 'type');
  const url = getFlagValue(args, 'url');
  const name = getFlagValue(args, 'name');
  const secret = getFlagValue(args, 'secret');

  if (!type) {
    console.error('Error [NOTIFY_MISSING_TYPE]: --type is required.');
    console.error('Supported types: webhook, feishu, slack, telegram, discord');
    return 1;
  }

  const validTypes = ['webhook', 'feishu', 'slack', 'telegram', 'discord'];
  if (!validTypes.includes(type)) {
    console.error(`Error [NOTIFY_INVALID_TYPE]: '${type}' is not a valid channel type.`);
    console.error(`Supported types: ${validTypes.join(', ')}`);
    return 1;
  }

  if (!url) {
    console.error('Error [NOTIFY_MISSING_URL]: --url is required.');
    console.error('Example: --url https://example.com/webhook');
    return 1;
  }

  if (!name) {
    console.error('Error [NOTIFY_MISSING_NAME]: --name is required.');
    console.error('Example: --name my-webhook');
    return 1;
  }

  // Load existing config
  const { config, configPath } = await loadConfigWithPath();

  // Ensure notification.channels array exists
  if (!config.notification) {
    config.notification = {};
  }
  if (!config.notification.channels) {
    config.notification.channels = [];
  }

  // Check for duplicate
  const existing = config.notification.channels.find(
    ch => (ch.channelId ?? ch.type) === name
  );
  if (existing) {
    console.error(`Error [NOTIFY_DUPLICATE]: Channel '${name}' already exists.`);
    console.error('Suggestion: Use a different --name or remove the existing channel first.');
    return 1;
  }

  // Build channel entry
  const channelEntry: NotificationChannelFileEntry = {
    channelId: name,
    type,
    config: { url },
    enabled: true,
  };

  if (secret) {
    channelEntry.config!.secret = secret;
  }

  config.notification.channels.push(channelEntry);

  // Write back
  await writeConfigFile(configPath, config);

  console.log(`✓ Channel '${name}' added (type: ${type}).`);
  console.log(`  URL: ${url}`);
  if (secret) console.log(`  Secret: ****`);
  console.log(`\nTest it: aco notify test ${name}`);
  return 0;
}

// --- aco notify status ---

async function showStatus(json: boolean): Promise<number> {
  const fileConfig = await loadFileConfig();
  const channels = fileConfig.notification?.channels ?? [];

  if (channels.length === 0) {
    if (json) {
      console.log(JSON.stringify([]));
    } else {
      console.log('No notification channels configured.');
      console.log('Hint: Run "aco notify add --type webhook --url <url> --name <name>" to add one.');
    }
    return 0;
  }

  // Test each channel's connectivity
  const eventBus = createEventBus();
  const manager = createNotificationManager(eventBus);

  const results: Array<{
    channelId: string;
    type: string;
    enabled: boolean;
    reachable: boolean | null;
    error?: string;
  }> = [];

  for (const ch of channels) {
    const channelId = ch.channelId ?? ch.type ?? 'unknown';
    const enabled = ch.enabled ?? true;

    if (!enabled) {
      results.push({ channelId, type: ch.type ?? '-', enabled, reachable: null });
      continue;
    }

    manager.registerChannel(ch.type as any, ch.config ?? {}, channelId);
    const testResult = await manager.testChannel(channelId);
    results.push({
      channelId,
      type: ch.type ?? '-',
      enabled,
      reachable: testResult.success,
      error: testResult.error,
    });
  }

  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return 0;
  }

  const headers = ['Channel ID', 'Type', 'Enabled', 'Reachable'];
  const rows = results.map(r => [
    r.channelId,
    r.type,
    r.enabled ? 'yes' : 'no',
    r.reachable === null ? 'skipped' : r.reachable ? '✓ yes' : `✗ no${r.error ? ` (${r.error})` : ''}`,
  ]);
  console.log(formatTable(headers, rows));

  // FR-F05 AC9: Show event listener status
  const listeners = manager.getEventListenerStatus();
  if (listeners.length > 0) {
    console.log('');
    console.log('Event listeners:');
    const listenerHeaders = ['Event Name', 'Status', 'Error'];
    const listenerRows = listeners.map((l: EventListenerStatus) => [
      l.eventName,
      l.active ? '✓ active' : '✗ inactive',
      l.error ?? '-',
    ]);
    console.log(formatTable(listenerHeaders, listenerRows));
  }

  return 0;
}

// --- aco notify channels ---

async function listChannels(json: boolean): Promise<number> {
  const fileConfig = await loadFileConfig();
  const channels = fileConfig.notification?.channels ?? [];

  if (json) {
    console.log(JSON.stringify(channels, null, 2));
    return 0;
  }

  if (channels.length === 0) {
    console.log('No notification channels configured.');
    console.log('Hint: Run "aco notify add --type webhook --url <url> --name <name>" to add one.');
    return 0;
  }

  const headers = ['Channel ID', 'Type', 'Enabled'];
  const rows = channels.map(ch => [
    ch.channelId ?? ch.type ?? '-',
    ch.type ?? '-',
    String(ch.enabled ?? true),
  ]);
  console.log(formatTable(headers, rows));
  return 0;
}

// --- aco notify test ---

async function testChannel(channelId: string | undefined, json: boolean): Promise<number> {
  const eventBus = createEventBus();
  const manager = createNotificationManager(eventBus);

  // Load channels from config
  const fileConfig = await loadFileConfig();
  const channels = fileConfig.notification?.channels ?? [];

  if (channels.length === 0) {
    console.error('Error [NOTIFY_NO_CHANNELS]: No notification channels configured.');
    console.error('Suggestion: Run "aco notify add --type webhook --url <url> --name <name>" to add one.');
    return 1;
  }

  // FR-F04 AC5: If no channelId specified, test ALL registered channels
  if (!channelId) {
    for (const ch of channels) {
      const id = ch.channelId ?? ch.type ?? 'unknown';
      if (ch.enabled !== false) {
        manager.registerChannel(ch.type as any, ch.config ?? {}, id);
      }
    }

    const results = await manager.testAllChannels();

    if (json) {
      console.log(JSON.stringify(results, null, 2));
      return results.every(r => r.success) ? 0 : 1;
    }

    console.log('Notification channel test results:');
    console.log('');
    let allPassed = true;
    for (const r of results) {
      if (r.success) {
        console.log(`  ✓ ${r.channelId} (${r.type}): passed`);
      } else {
        console.log(`  ✗ ${r.channelId} (${r.type}): failed — ${r.error ?? 'unknown error'}`);
        allPassed = false;
      }
    }
    console.log('');
    if (allPassed) {
      console.log(`All ${results.length} channel(s) passed connectivity test.`);
    } else {
      const failCount = results.filter(r => !r.success).length;
      console.log(`${failCount}/${results.length} channel(s) failed. Check channel configuration.`);
    }
    return allPassed ? 0 : 1;
  }

  // Test a specific channel
  const channelDef = channels.find(ch => (ch.channelId ?? ch.type) === channelId);

  if (!channelDef) {
    console.error(`Error [NOTIFY_CHANNEL_NOT_FOUND]: Channel '${channelId}' not found in config.`);
    return 1;
  }

  manager.registerChannel(channelDef.type as any, channelDef.config ?? {}, channelId);
  const result = await manager.testChannel(channelId);

  if (json) {
    console.log(JSON.stringify({ channelId, success: result.success, error: result.error }));
    return result.success ? 0 : 1;
  }

  if (result.success) {
    console.log(`✓ Channel '${channelId}' connectivity test passed.`);
  } else {
    console.log(`✗ Channel '${channelId}' test failed: ${result.error}`);
  }
  return result.success ? 0 : 1;
}

// --- aco notify send ---

async function sendTest(channelId: string | undefined, args: string[]): Promise<number> {
  if (!channelId) {
    console.error('Error [NOTIFY_MISSING_ID]: Please specify a channel ID.');
    return 1;
  }

  const message = getFlagValue(args, 'message') ?? 'ACO test notification';
  const eventBus = createEventBus();
  const manager = createNotificationManager(eventBus);

  const fileConfig = await loadFileConfig();
  const channels = fileConfig.notification?.channels ?? [];
  const channelDef = channels.find(ch => (ch.channelId ?? ch.type) === channelId);

  if (!channelDef) {
    console.error(`Error [NOTIFY_CHANNEL_NOT_FOUND]: Channel '${channelId}' not found.`);
    return 1;
  }

  manager.registerChannel(channelDef.type as any, channelDef.config ?? {}, channelId);

  // Set filter to allow all for test
  manager.setFilter({});

  const records = await manager.notify({
    eventType: 'task_succeeded',
    taskId: 'test-' + Date.now(),
    label: message,
    agentId: 'cli',
  });

  if (records.length === 0) {
    console.log('No delivery attempted (channel may be disabled or filtered).');
    return 1;
  }

  const delivered = records.filter(r => r.status === 'delivered');
  const failed = records.filter(r => r.status === 'failed');

  if (delivered.length > 0) {
    console.log(`✓ Message sent to ${delivered.length} channel(s).`);
  }
  if (failed.length > 0) {
    console.log(`✗ Failed to deliver to ${failed.length} channel(s).`);
    failed.forEach(r => console.log(`  ${r.channelId}: ${r.error}`));
  }
  return failed.length > 0 ? 1 : 0;
}

// --- aco notify filter ---

async function showFilter(json: boolean): Promise<number> {
  const fileConfig = await loadFileConfig();
  const subscriptions = fileConfig.notification?.subscriptions;
  const subscription = subscriptions?.[0];
  const filter: Record<string, unknown> = subscription
    ? {
        eventTypes: subscription.events,
        excludeLabels: subscription.excludeLabels,
        taskSources: subscription.taskSources,
      }
    : {
        eventTypes: ['task_failed', 'circuit_break', 'task_completed'],
        excludeLabels: ['healthcheck', 'heartbeat'],
        taskSources: ['subagent', 'acp'] satisfies NotificationTaskSource[],
      };

  if (json) {
    console.log(JSON.stringify(filter, null, 2));
    return 0;
  }

  console.log('Current notification filter:');
  if (filter.eventTypes) console.log(`  Event types: ${(filter.eventTypes as string[]).join(', ')}`);
  if (filter.excludeLabels) console.log(`  Exclude labels: ${(filter.excludeLabels as string[]).join(', ')}`);
  if (filter.taskSources) console.log(`  Task sources: ${(filter.taskSources as string[]).join(', ')}`);
  if (filter.minPriority) console.log(`  Min priority: ${filter.minPriority}`);
  if (filter.agentIds) console.log(`  Agent IDs: ${(filter.agentIds as string[]).join(', ')}`);
  return 0;
}

// --- aco notify history ---

async function showHistory(_args: string[], _json: boolean): Promise<number> {
  console.log('Delivery history is available at runtime via the library API.');
  console.log('For persistent history, check the audit log:');
  console.log('  aco audit --type notification.sent');
  return 0;
}

// --- Config file helpers ---

async function loadConfigWithPath(): Promise<{ config: AcoFileConfig; configPath: string }> {
  const candidates = [
    resolve(process.cwd(), 'aco.config.json'),
    resolve(process.cwd(), 'aco.config.yaml'),
    resolve(process.cwd(), 'aco.config.yml'),
  ];

  for (const configPath of candidates) {
    if (!(await fileExists(configPath))) continue;
    const content = await readFile(configPath, 'utf-8');
    const ext = extname(configPath);
    if (ext === '.yaml' || ext === '.yml') {
      // For YAML, we import dynamically to avoid issues
      const { parse } = await import('yaml');
      return { config: parse(content) as AcoFileConfig, configPath };
    }
    return { config: JSON.parse(content) as AcoFileConfig, configPath };
  }

  // No config file exists; default to JSON
  const defaultPath = resolve(process.cwd(), 'aco.config.json');
  return { config: {}, configPath: defaultPath };
}

async function writeConfigFile(configPath: string, config: AcoFileConfig): Promise<void> {
  const ext = extname(configPath);
  if (ext === '.yaml' || ext === '.yml') {
    const { stringify } = await import('yaml');
    await writeFile(configPath, stringify(config), 'utf-8');
  } else {
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  }
}
