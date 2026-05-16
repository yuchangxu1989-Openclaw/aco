/**
 * Tests for OpenClawAdapter — FR-Z04 AC2
 * Mock HTTP calls to verify adapter behavior
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenClawAdapter } from './openclaw-adapter.js';
import type { OpenClawAdapterConfig } from './openclaw-adapter.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockResponse(status: number, body: unknown): Response {
  return {
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe('OpenClawAdapter', () => {
  let adapter: OpenClawAdapter;
  const config: OpenClawAdapterConfig = {
    gatewayUrl: 'http://localhost:4141',
    authToken: 'test-token',
    openclawConfigPath: '/tmp/test-openclaw.json',
    pollIntervalMs: 60000, // Long interval to prevent auto-polling in tests
  };

  beforeEach(() => {
    mockFetch.mockReset();
    adapter = new OpenClawAdapter(config);
  });

  afterEach(() => {
    adapter.dispose();
  });

  describe('spawnTask', () => {
    it('should POST to Gateway spawn endpoint and return sessionId', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(200, { sessionId: 'sess-abc123' }),
      );

      const sessionId = await adapter.spawnTask('hermes', 'Write tests', {
        timeoutSeconds: 600,
        label: 'test-task',
      });

      expect(sessionId).toBe('sess-abc123');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:4141/api/v1/sessions/spawn');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Authorization']).toBe('Bearer test-token');

      const body = JSON.parse(opts.body);
      expect(body.agentId).toBe('hermes');
      expect(body.message).toBe('Write tests');
      expect(body.timeoutSeconds).toBe(600);
      expect(body.label).toBe('test-task');
    });

    it('should throw on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(500, { error: 'Internal server error' }),
      );

      await expect(adapter.spawnTask('hermes', 'test')).rejects.toThrow(
        /Gateway spawn failed \(HTTP 500\)/,
      );
    });

    it('should throw if response missing sessionId', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(200, { status: 'ok' }),
      );

      await expect(adapter.spawnTask('hermes', 'test')).rejects.toThrow(
        /missing sessionId/,
      );
    });

    it('should accept alternative sessionId field names', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(200, { id: 'sess-alt' }),
      );

      const sessionId = await adapter.spawnTask('cc', 'test');
      expect(sessionId).toBe('sess-alt');
    });
  });

  describe('killTask', () => {
    it('should POST to kill endpoint', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(200, { ok: true }));

      await adapter.killTask('sess-abc123');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:4141/api/v1/sessions/sess-abc123/kill');
      expect(opts.method).toBe('POST');
    });

    it('should not throw on 404 (session already gone)', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(404, { error: 'not found' }));

      await expect(adapter.killTask('sess-gone')).resolves.toBeUndefined();
    });

    it('should throw on other errors', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(500, { error: 'fail' }));

      await expect(adapter.killTask('sess-x')).rejects.toThrow(/Gateway kill failed/);
    });
  });

  describe('steerTask', () => {
    it('should POST message to steer endpoint', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(200, { ok: true }));

      await adapter.steerTask('sess-abc', 'Please also add error handling');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:4141/api/v1/sessions/sess-abc/steer');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body);
      expect(body.message).toBe('Please also add error handling');
    });

    it('should throw on error', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(400, { error: 'bad request' }));

      await expect(adapter.steerTask('sess-x', 'msg')).rejects.toThrow(/Gateway steer failed/);
    });
  });

  describe('getTaskStatus', () => {
    it('should GET session status', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(200, { status: 'running', outputTokens: 1500 }),
      );

      const result = await adapter.getTaskStatus('sess-abc');
      expect(result.status).toBe('running');
      expect(result.outputTokens).toBe(1500);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:4141/api/v1/sessions/sess-abc');
    });

    it('should return not_found for 404', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(404, {}));

      const result = await adapter.getTaskStatus('sess-gone');
      expect(result.status).toBe('not_found');
    });
  });

  describe('getAgentStatus', () => {
    it('should GET agent status', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(200, { active: true }),
      );

      const result = await adapter.getAgentStatus('hermes');
      expect(result.active).toBe(true);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:4141/api/v1/agents/hermes/status');
    });

    it('should return inactive for 404', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(404, {}));

      const result = await adapter.getAgentStatus('unknown-agent');
      expect(result.active).toBe(false);
    });
  });

  describe('getSessionState', () => {
    it('should GET session state', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(200, {
          active: true,
          files: ['src/main.ts', 'src/test.ts'],
          lastActivity: 1700000000000,
        }),
      );

      const result = await adapter.getSessionState('sess-abc');
      expect(result.sessionId).toBe('sess-abc');
      expect(result.active).toBe(true);
      expect(result.files).toEqual(['src/main.ts', 'src/test.ts']);
      expect(result.lastActivity).toBe(1700000000000);
    });

    it('should return inactive for 404', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(404, {}));

      const result = await adapter.getSessionState('sess-gone');
      expect(result.sessionId).toBe('sess-gone');
      expect(result.active).toBe(false);
    });
  });

  describe('discoverAgents', () => {
    it('should read agents from openclaw.json', async () => {
      const { readFile } = await import('node:fs/promises');
      const { vi: viModule } = await import('vitest');

      // We need to test with a real file, so let's write a temp one
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');

      const testConfig = {
        agents: {
          list: [
            { id: 'hermes', model: 'claude-opus-4' },
            { id: 'cc', model: 'claude-sonnet-4' },
            { id: 'audit-01', model: 'claude-opus-4' },
          ],
        },
      };

      await mkdir(dirname(config.openclawConfigPath!), { recursive: true });
      await writeFile(config.openclawConfigPath!, JSON.stringify(testConfig));

      const agents = await adapter.discoverAgents();
      expect(agents).toHaveLength(3);
      expect(agents[0]).toEqual({ agentId: 'hermes', model: 'claude-opus-4', roles: undefined });
      expect(agents[1]).toEqual({ agentId: 'cc', model: 'claude-sonnet-4', roles: undefined });
      expect(agents[2]).toEqual({ agentId: 'audit-01', model: 'claude-opus-4', roles: undefined });
    });

    it('should return empty array if config not found', async () => {
      const adapterNoConfig = new OpenClawAdapter({
        ...config,
        openclawConfigPath: '/tmp/nonexistent-openclaw.json',
      });

      const agents = await adapterNoConfig.discoverAgents();
      expect(agents).toEqual([]);
      adapterNoConfig.dispose();
    });
  });

  describe('subscribeEvents', () => {
    it('should register event handler', () => {
      const handler = vi.fn();
      adapter.subscribeEvents(handler);

      // Handler registered, no immediate call
      expect(handler).not.toHaveBeenCalled();
    });

    it('should emit completion events when polling detects state change', async () => {
      const handler = vi.fn();

      // First spawn a task to track it
      mockFetch.mockResolvedValueOnce(
        mockResponse(200, { sessionId: 'sess-poll-test' }),
      );
      await adapter.spawnTask('hermes', 'test');

      adapter.subscribeEvents(handler);

      // Simulate polling: session completed
      mockFetch.mockResolvedValueOnce(
        mockResponse(200, { status: 'succeeded', outputTokens: 5000 }),
      );

      // Manually trigger poll (private method, access via any)
      await (adapter as unknown as { pollSessions: () => Promise<void> }).pollSessions();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        type: 'session:complete',
        sessionId: 'sess-poll-test',
        data: { status: 'succeeded', outputTokens: 5000 },
      });
    });

    it('should emit timeout events for failed sessions', async () => {
      const handler = vi.fn();

      mockFetch.mockResolvedValueOnce(
        mockResponse(200, { sessionId: 'sess-fail' }),
      );
      await adapter.spawnTask('cc', 'test');

      adapter.subscribeEvents(handler);

      mockFetch.mockResolvedValueOnce(
        mockResponse(200, { status: 'failed', outputTokens: 100 }),
      );

      await (adapter as unknown as { pollSessions: () => Promise<void> }).pollSessions();

      expect(handler).toHaveBeenCalledWith({
        type: 'session:timeout',
        sessionId: 'sess-fail',
        data: { status: 'failed', outputTokens: 100 },
      });
    });
  });

  describe('dispose', () => {
    it('should clean up resources', () => {
      const handler = vi.fn();
      adapter.subscribeEvents(handler);
      adapter.dispose();

      // After dispose, no more polling should happen
      expect(() => adapter.dispose()).not.toThrow();
    });
  });

  describe('configuration', () => {
    it('should use environment variables when no config provided', () => {
      const originalUrl = process.env.OPENCLAW_GATEWAY_URL;
      const originalToken = process.env.OPENCLAW_AUTH_TOKEN;

      process.env.OPENCLAW_GATEWAY_URL = 'http://custom:9999';
      process.env.OPENCLAW_AUTH_TOKEN = 'env-token';

      const envAdapter = new OpenClawAdapter();

      // Verify by making a request
      mockFetch.mockResolvedValueOnce(mockResponse(200, { sessionId: 'x' }));
      envAdapter.spawnTask('test', 'msg').then(() => {
        const [url, opts] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
        expect(url).toContain('http://custom:9999');
        expect(opts.headers['Authorization']).toBe('Bearer env-token');
      });

      envAdapter.dispose();

      // Restore
      if (originalUrl) process.env.OPENCLAW_GATEWAY_URL = originalUrl;
      else delete process.env.OPENCLAW_GATEWAY_URL;
      if (originalToken) process.env.OPENCLAW_AUTH_TOKEN = originalToken;
      else delete process.env.OPENCLAW_AUTH_TOKEN;
    });

    it('should use default gateway URL when nothing configured', () => {
      const originalUrl = process.env.OPENCLAW_GATEWAY_URL;
      delete process.env.OPENCLAW_GATEWAY_URL;

      const defaultAdapter = new OpenClawAdapter({ openclawConfigPath: '/tmp/none.json' });

      mockFetch.mockResolvedValueOnce(mockResponse(200, { sessionId: 'y' }));
      defaultAdapter.spawnTask('test', 'msg').then(() => {
        const [url] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
        expect(url).toContain('http://localhost:4141');
      });

      defaultAdapter.dispose();

      if (originalUrl) process.env.OPENCLAW_GATEWAY_URL = originalUrl;
    });
  });

  describe('URL encoding', () => {
    it('should encode special characters in session IDs', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(200, { status: 'running' }));

      await adapter.getTaskStatus('agent:main:feishu:direct:ou_123');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(
        'http://localhost:4141/api/v1/sessions/agent%3Amain%3Afeishu%3Adirect%3Aou_123',
      );
    });
  });
});
