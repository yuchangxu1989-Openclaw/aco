/**
 * Tests for notification CLI commands and WebhookTransport
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WebhookTransport } from '../notification/transports/webhook-transport.js';
import { getBuiltinTransports } from '../notification/transports/index.js';
import { NotificationManager } from '../notification/notification-manager.js';
import { EventBus } from '../event/event-bus.js';
import type { ChannelConfig } from '../notification/notification-manager.js';

// --- WebhookTransport Tests ---

describe('WebhookTransport', () => {
  let transport: WebhookTransport;

  beforeEach(() => {
    transport = new WebhookTransport();
  });

  it('should throw if channel has no url', async () => {
    const channel: ChannelConfig = {
      channelId: 'test-hook',
      type: 'webhook',
      config: {},
      enabled: true,
      status: 'active',
      consecutiveFailures: 0,
      totalSent: 0,
      totalFailed: 0,
    };

    await expect(transport.send(channel, 'hello')).rejects.toThrow('missing "url"');
  });

  it('should send POST request to configured url', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    });
    vi.stubGlobal('fetch', mockFetch);

    const channel: ChannelConfig = {
      channelId: 'test-hook',
      type: 'webhook',
      config: { url: 'https://example.com/hook' },
      enabled: true,
      status: 'active',
      consecutiveFailures: 0,
      totalSent: 0,
      totalFailed: 0,
    };

    await transport.send(channel, 'test message');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body);
    expect(body.channelId).toBe('test-hook');
    expect(body.message).toBe('test message');
    expect(body.timestamp).toBeDefined();

    vi.unstubAllGlobals();
  });

  it('should include Authorization header when secret is set', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const channel: ChannelConfig = {
      channelId: 'secure-hook',
      type: 'webhook',
      config: { url: 'https://example.com/hook', secret: 'my-secret' },
      enabled: true,
      status: 'active',
      consecutiveFailures: 0,
      totalSent: 0,
      totalFailed: 0,
    };

    await transport.send(channel, 'secure msg');

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers['Authorization']).toBe('Bearer my-secret');

    vi.unstubAllGlobals();
  });

  it('should throw on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });
    vi.stubGlobal('fetch', mockFetch);

    const channel: ChannelConfig = {
      channelId: 'fail-hook',
      type: 'webhook',
      config: { url: 'https://example.com/hook' },
      enabled: true,
      status: 'active',
      consecutiveFailures: 0,
      totalSent: 0,
      totalFailed: 0,
    };

    await expect(transport.send(channel, 'msg')).rejects.toThrow('HTTP 500');

    vi.unstubAllGlobals();
  });

  it('testConnection should return true on ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const channel: ChannelConfig = {
      channelId: 'test-hook',
      type: 'webhook',
      config: { url: 'https://example.com/hook' },
      enabled: true,
      status: 'active',
      consecutiveFailures: 0,
      totalSent: 0,
      totalFailed: 0,
    };

    const result = await transport.testConnection(channel);
    expect(result).toBe(true);

    vi.unstubAllGlobals();
  });

  it('testConnection should return false on error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network error'));
    vi.stubGlobal('fetch', mockFetch);

    const channel: ChannelConfig = {
      channelId: 'test-hook',
      type: 'webhook',
      config: { url: 'https://example.com/hook' },
      enabled: true,
      status: 'active',
      consecutiveFailures: 0,
      totalSent: 0,
      totalFailed: 0,
    };

    const result = await transport.testConnection(channel);
    expect(result).toBe(false);

    vi.unstubAllGlobals();
  });

  it('testConnection should return false if no url', async () => {
    const channel: ChannelConfig = {
      channelId: 'no-url',
      type: 'webhook',
      config: {},
      enabled: true,
      status: 'active',
      consecutiveFailures: 0,
      totalSent: 0,
      totalFailed: 0,
    };

    const result = await transport.testConnection(channel);
    expect(result).toBe(false);
  });

  it('should include custom headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const channel: ChannelConfig = {
      channelId: 'custom-headers',
      type: 'webhook',
      config: {
        url: 'https://example.com/hook',
        headers: { 'X-Custom': 'value' },
      },
      enabled: true,
      status: 'active',
      consecutiveFailures: 0,
      totalSent: 0,
      totalFailed: 0,
    };

    await transport.send(channel, 'msg');

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers['X-Custom']).toBe('value');

    vi.unstubAllGlobals();
  });
});

// --- getBuiltinTransports Tests ---

describe('getBuiltinTransports', () => {
  it('should include webhook transport', () => {
    const transports = getBuiltinTransports();
    expect(transports.has('webhook')).toBe(true);
    expect(transports.get('webhook')).toBeInstanceOf(WebhookTransport);
  });
});

// --- NotificationManager with WebhookTransport integration ---

describe('NotificationManager + WebhookTransport', () => {
  let eventBus: EventBus;
  let manager: NotificationManager;

  beforeEach(() => {
    eventBus = new EventBus();
    manager = new NotificationManager(eventBus);
    // Register built-in transports
    for (const [type, transport] of getBuiltinTransports()) {
      manager.registerTransport(type, transport);
    }
  });

  it('should deliver via webhook transport', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    manager.registerChannel('webhook', { url: 'https://example.com/hook' }, 'my-hook');
    manager.setFilter({});

    const records = await manager.notify({
      eventType: 'task_succeeded',
      taskId: 'task-1',
      label: 'Test task',
      agentId: 'test-agent',
    });

    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('delivered');
    expect(records[0].channelId).toBe('my-hook');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('should mark delivery as failed on transport error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });
    vi.stubGlobal('fetch', mockFetch);

    // Use a manager with zero retry delay to avoid timeout
    const fastManager = new NotificationManager(eventBus, {
      maxRetries: 1,
      retryBaseDelayMs: 0,
      degradedThreshold: 5,
      sendTimeoutMs: 10000,
      defaultFilter: {},
    });
    for (const [type, transport] of getBuiltinTransports()) {
      fastManager.registerTransport(type, transport);
    }

    fastManager.registerChannel('webhook', { url: 'https://example.com/hook' }, 'fail-hook');
    fastManager.setFilter({});

    const records = await fastManager.notify({
      eventType: 'task_failed',
      taskId: 'task-2',
      label: 'Failing task',
      agentId: 'test-agent',
    });

    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('failed');
    expect(records[0].error).toContain('503');

    vi.unstubAllGlobals();
  });

  it('testChannel should work with webhook transport', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    manager.registerChannel('webhook', { url: 'https://example.com/hook' }, 'test-ch');

    const result = await manager.testChannel('test-ch');
    expect(result.success).toBe(true);

    vi.unstubAllGlobals();
  });
});

// --- notify add CLI (config file writing) ---

describe('notify add - config writing', () => {
  const testDir = resolve('/tmp/aco-notify-test-' + process.pid);
  const configPath = resolve(testDir, 'aco.config.json');
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    await mkdir(testDir, { recursive: true });
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(testDir, { recursive: true, force: true });
  });

  it('should create config and add channel when no config exists', async () => {
    // Import dynamically to pick up cwd change
    const { notifyCommand } = await import('../cli/commands/notify.js');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));

    const code = await notifyCommand(['add', '--type', 'webhook', '--url', 'https://example.com/hook', '--name', 'my-hook']);

    console.log = origLog;

    expect(code).toBe(0);
    expect(logs.some(l => l.includes("'my-hook' added"))).toBe(true);

    // Verify config file was written
    const { readFile } = await import('node:fs/promises');
    const content = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(content.notification.channels).toHaveLength(1);
    expect(content.notification.channels[0].channelId).toBe('my-hook');
    expect(content.notification.channels[0].type).toBe('webhook');
    expect(content.notification.channels[0].config.url).toBe('https://example.com/hook');
  });

  it('should reject duplicate channel names', async () => {
    await writeFile(configPath, JSON.stringify({
      notification: {
        channels: [{ channelId: 'existing', type: 'webhook', config: { url: 'http://x' }, enabled: true }],
      },
    }));

    const { notifyCommand } = await import('../cli/commands/notify.js');

    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(' '));

    const code = await notifyCommand(['add', '--type', 'webhook', '--url', 'http://y', '--name', 'existing']);

    console.error = origErr;

    expect(code).toBe(1);
    expect(errors.some(e => e.includes('NOTIFY_DUPLICATE'))).toBe(true);
  });

  it('should reject missing --type', async () => {
    const { notifyCommand } = await import('../cli/commands/notify.js');

    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(' '));

    const code = await notifyCommand(['add', '--url', 'http://x', '--name', 'test']);

    console.error = origErr;

    expect(code).toBe(1);
    expect(errors.some(e => e.includes('NOTIFY_MISSING_TYPE'))).toBe(true);
  });

  it('should reject invalid --type', async () => {
    const { notifyCommand } = await import('../cli/commands/notify.js');

    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(' '));

    const code = await notifyCommand(['add', '--type', 'invalid', '--url', 'http://x', '--name', 'test']);

    console.error = origErr;

    expect(code).toBe(1);
    expect(errors.some(e => e.includes('NOTIFY_INVALID_TYPE'))).toBe(true);
  });

  it('should reject missing --url', async () => {
    const { notifyCommand } = await import('../cli/commands/notify.js');

    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(' '));

    const code = await notifyCommand(['add', '--type', 'webhook', '--name', 'test']);

    console.error = origErr;

    expect(code).toBe(1);
    expect(errors.some(e => e.includes('NOTIFY_MISSING_URL'))).toBe(true);
  });

  it('should reject missing --name', async () => {
    const { notifyCommand } = await import('../cli/commands/notify.js');

    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(' '));

    const code = await notifyCommand(['add', '--type', 'webhook', '--url', 'http://x']);

    console.error = origErr;

    expect(code).toBe(1);
    expect(errors.some(e => e.includes('NOTIFY_MISSING_NAME'))).toBe(true);
  });

  it('should include secret in config when provided', async () => {
    const { notifyCommand } = await import('../cli/commands/notify.js');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));

    const code = await notifyCommand(['add', '--type', 'webhook', '--url', 'http://x', '--name', 'secure', '--secret', 'abc123']);

    console.log = origLog;

    expect(code).toBe(0);

    const { readFile } = await import('node:fs/promises');
    const content = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(content.notification.channels[0].config.secret).toBe('abc123');
  });
});

// --- FR-F05 completion notifications + FR-F02 AC5/AC6 filters ---

describe('NotificationManager completion notifications', () => {
  let eventBus: EventBus;
  let manager: NotificationManager;
  let messages: string[];

  beforeEach(() => {
    eventBus = new EventBus();
    manager = new NotificationManager(eventBus, {
      maxRetries: 0,
      retryBaseDelayMs: 0,
      degradedThreshold: 5,
      sendTimeoutMs: 10000,
      defaultFilter: {
        eventTypes: ['task_completed'],
        excludeLabels: ['healthcheck', 'heartbeat'],
        taskSources: ['subagent', 'acp'],
      },
    });
    messages = [];
    manager.registerTransport('webhook', {
      send: async (_channel, message) => {
        messages.push(message);
      },
      testConnection: async () => true,
    });
    manager.registerChannel('webhook', { url: 'memory://test' }, 'memory');
  });

  it('should send default completion message for subagent_ended events', async () => {
    await eventBus.emit('subagent_spawned', {
      childSessionKey: 'agent:codex:subagent:abc',
      startedAt: 1_000,
    });

    await eventBus.emit('subagent_ended', {
      childSessionKey: 'agent:codex:subagent:abc',
      label: 'sevo:aco:implement',
      status: 'succeeded',
      endedAt: 66_000,
    });

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(messages).toEqual(['✅ [codex] sevo:aco:implement | 1m 5s']);
  });

  it('should mark failed completion messages', async () => {
    await eventBus.emit('run:completed', {
      runId: 'run-1',
      targetSessionKey: 'agent:audit-01:subagent:def',
      label: 'audit task',
      outcome: 'failed',
      startedAt: 0,
      endedAt: 5_000,
    });

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(messages).toEqual(['❌ [audit-01] audit task | 5s（失败）']);
  });

  it('should exclude labels by prefix and regex', async () => {
    await eventBus.emit('subagent_ended', {
      childSessionKey: 'agent:codex:subagent:abc',
      label: 'healthcheck daily',
      status: 'succeeded',
      durationMs: 1_000,
    });

    manager.setFilter({ excludeLabels: ['^skip:.*'] });
    await eventBus.emit('subagent_ended', {
      childSessionKey: 'agent:codex:subagent:abc',
      label: 'skip:maintenance',
      status: 'succeeded',
      durationMs: 1_000,
    });

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(messages).toHaveLength(0);
  });

  it('should filter completion notifications by task source', async () => {
    await eventBus.emit('session:complete', {
      sessionId: 'main-session',
      agentId: 'main',
      label: 'main reply',
      status: 'succeeded',
      data: { source: 'main' },
      durationMs: 1_000,
    });

    await eventBus.emit('session:complete', {
      sessionId: 'acp-session',
      agentId: 'codex',
      label: 'acp task',
      status: 'completed',
      data: { source: 'acp' },
      durationMs: 2_000,
    });

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(messages).toEqual(['✅ [codex] acp task | 2s']);
  });

  it('should timeout a single delivery attempt after configured limit without throwing from event emit', async () => {
    const warnEvents: unknown[] = [];
    const slowManager = new NotificationManager(eventBus, {
      maxRetries: 0,
      retryBaseDelayMs: 0,
      degradedThreshold: 5,
      sendTimeoutMs: 1,
      defaultFilter: { eventTypes: ['task_completed'], taskSources: ['subagent'] },
    });
    slowManager.registerTransport('webhook', {
      send: () => new Promise<void>(resolve => setTimeout(resolve, 50)),
      testConnection: async () => true,
    });
    slowManager.registerChannel('webhook', { url: 'memory://slow' }, 'slow');
    eventBus.on('notification:warn', event => {
      warnEvents.push(event);
    });

    await expect(eventBus.emit('subagent_ended', {
      childSessionKey: 'agent:codex:subagent:abc',
      label: 'slow notify',
      status: 'succeeded',
      durationMs: 1_000,
    })).resolves.toBeUndefined();

    await new Promise(resolve => setTimeout(resolve, 30));

    expect(slowManager.getDeliveryRecords('slow')[0].status).toBe('failed');
    expect(warnEvents).toHaveLength(1);
  });
});
