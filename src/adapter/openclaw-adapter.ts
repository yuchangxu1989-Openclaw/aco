/**
 * OpenClaw Host Adapter — FR-Z04 AC2
 * 对接 OpenClaw Gateway 的 sessions/subagents API
 *
 * 支持：
 * - 任务派发（sessions_spawn）
 * - 状态查询（subagents list）
 * - 任务取消（subagents kill）
 * - 任务转向（subagents steer）
 * - Agent 池发现（从 openclaw.json 读取 agents.list）
 * - 事件订阅（轮询 + 事件推送）
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  HostAdapter,
  HostEvent,
  SpawnOptions,
  SessionState,
  DiscoveredAgent,
} from '../types/index.js';

// --- Configuration ---

export interface OpenClawAdapterConfig {
  /** Gateway base URL (default: http://localhost:4141) */
  gatewayUrl?: string;
  /** Authentication token for Gateway API */
  authToken?: string;
  /** Path to openclaw.json for agent discovery */
  openclawConfigPath?: string;
  /** Polling interval for event subscription (ms, default: 5000) */
  pollIntervalMs?: number;
  /** Request timeout (ms, default: 30000) */
  requestTimeoutMs?: number;
}

const DEFAULT_GATEWAY_URL = 'http://localhost:4141';
const DEFAULT_POLL_INTERVAL = 5000;
const DEFAULT_REQUEST_TIMEOUT = 30000;

// --- HTTP helpers ---

interface HttpResponse {
  status: number;
  body: unknown;
}

async function httpRequest(
  url: string,
  method: string,
  body?: unknown,
  headers?: Record<string, string>,
  timeoutMs?: number,
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_REQUEST_TIMEOUT);

  try {
    const opts: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      signal: controller.signal,
    };

    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url, opts);
    let responseBody: unknown;
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      responseBody = await res.json();
    } else {
      responseBody = await res.text();
    }

    return { status: res.status, body: responseBody };
  } finally {
    clearTimeout(timeout);
  }
}

// --- OpenClaw Adapter ---

export class OpenClawAdapter implements HostAdapter {
  private readonly gatewayUrl: string;
  private readonly authToken?: string;
  private readonly openclawConfigPath: string;
  private readonly pollIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private eventHandlers: Array<(event: HostEvent) => void> = [];
  private pollTimer?: ReturnType<typeof setInterval>;
  private knownSessions: Map<string, string> = new Map(); // sessionId -> last known status

  constructor(config?: OpenClawAdapterConfig) {
    this.gatewayUrl = config?.gatewayUrl
      ?? process.env.OPENCLAW_GATEWAY_URL
      ?? DEFAULT_GATEWAY_URL;
    this.authToken = config?.authToken
      ?? process.env.OPENCLAW_AUTH_TOKEN;
    this.openclawConfigPath = config?.openclawConfigPath
      ?? this.resolveOpenclawConfigPath();
    this.pollIntervalMs = config?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL;
    this.requestTimeoutMs = config?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT;
  }

  private resolveOpenclawConfigPath(): string {
    // Try standard locations
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    return process.env.OPENCLAW_CONFIG_PATH
      ?? join(home, '.openclaw', 'openclaw.json');
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }
    return headers;
  }

  /**
   * Spawn a task on the specified agent via Gateway sessions API
   * Returns the session ID of the spawned task
   */
  async spawnTask(agentId: string, prompt: string, options?: SpawnOptions): Promise<string> {
    const payload = {
      agentId,
      message: prompt,
      label: options?.label,
      timeoutSeconds: options?.timeoutSeconds,
    };

    const res = await httpRequest(
      `${this.gatewayUrl}/api/v1/sessions/spawn`,
      'POST',
      payload,
      this.getHeaders(),
      this.requestTimeoutMs,
    );

    if (res.status >= 400) {
      const errMsg = typeof res.body === 'object' && res.body !== null
        ? (res.body as Record<string, unknown>).error ?? (res.body as Record<string, unknown>).message ?? JSON.stringify(res.body)
        : String(res.body);
      throw new Error(`Gateway spawn failed (HTTP ${res.status}): ${errMsg}`);
    }

    const data = res.body as Record<string, unknown>;
    const sessionId = data.sessionId ?? data.id ?? data.session_id;
    if (typeof sessionId !== 'string') {
      throw new Error(`Gateway spawn response missing sessionId: ${JSON.stringify(data)}`);
    }

    // Track the session for event polling
    this.knownSessions.set(sessionId, 'running');

    return sessionId;
  }

  /**
   * Kill a running task session
   */
  async killTask(sessionId: string): Promise<void> {
    const res = await httpRequest(
      `${this.gatewayUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/kill`,
      'POST',
      undefined,
      this.getHeaders(),
      this.requestTimeoutMs,
    );

    if (res.status >= 400 && res.status !== 404) {
      throw new Error(`Gateway kill failed (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
    }

    this.knownSessions.delete(sessionId);
  }

  /**
   * Steer a running task by injecting a message
   */
  async steerTask(sessionId: string, message: string): Promise<void> {
    const res = await httpRequest(
      `${this.gatewayUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/steer`,
      'POST',
      { message },
      this.getHeaders(),
      this.requestTimeoutMs,
    );

    if (res.status >= 400) {
      throw new Error(`Gateway steer failed (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
    }
  }

  /**
   * Get the status of a task session
   */
  async getTaskStatus(sessionId: string): Promise<{ status: string; outputTokens?: number }> {
    const res = await httpRequest(
      `${this.gatewayUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      'GET',
      undefined,
      this.getHeaders(),
      this.requestTimeoutMs,
    );

    if (res.status === 404) {
      return { status: 'not_found' };
    }

    if (res.status >= 400) {
      throw new Error(`Gateway status query failed (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
    }

    const data = res.body as Record<string, unknown>;
    return {
      status: String(data.status ?? 'unknown'),
      outputTokens: typeof data.outputTokens === 'number' ? data.outputTokens : undefined,
    };
  }

  /**
   * Check if an agent is currently active (has running sessions)
   */
  async getAgentStatus(agentId: string): Promise<{ active: boolean }> {
    const res = await httpRequest(
      `${this.gatewayUrl}/api/v1/agents/${encodeURIComponent(agentId)}/status`,
      'GET',
      undefined,
      this.getHeaders(),
      this.requestTimeoutMs,
    );

    if (res.status === 404) {
      return { active: false };
    }

    if (res.status >= 400) {
      throw new Error(`Gateway agent status failed (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
    }

    const data = res.body as Record<string, unknown>;
    return { active: Boolean(data.active ?? data.busy ?? false) };
  }

  /**
   * Get session filesystem state (FR-Z04 AC1: getSessionState)
   * Used to determine if an ACP session is truly active
   */
  async getSessionState(sessionId: string): Promise<SessionState> {
    const res = await httpRequest(
      `${this.gatewayUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/state`,
      'GET',
      undefined,
      this.getHeaders(),
      this.requestTimeoutMs,
    );

    if (res.status === 404) {
      return { sessionId, active: false };
    }

    if (res.status >= 400) {
      throw new Error(`Gateway session state failed (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
    }

    const data = res.body as Record<string, unknown>;
    return {
      sessionId,
      active: Boolean(data.active ?? true),
      files: Array.isArray(data.files) ? data.files as string[] : undefined,
      lastActivity: typeof data.lastActivity === 'number' ? data.lastActivity : undefined,
    };
  }

  /**
   * Subscribe to host events (completion, timeout, etc.)
   * Uses polling to detect state changes in tracked sessions
   */
  subscribeEvents(handler: (event: HostEvent) => void): void {
    this.eventHandlers.push(handler);

    // Start polling if not already running
    if (!this.pollTimer && this.eventHandlers.length === 1) {
      this.startPolling();
    }
  }

  /**
   * Discover agents from openclaw.json (FR-Z04 AC2)
   * Reads agents.list from the OpenClaw configuration file
   */
  async discoverAgents(): Promise<DiscoveredAgent[]> {
    try {
      const content = await readFile(this.openclawConfigPath, 'utf-8');
      const config = JSON.parse(content) as Record<string, unknown>;
      const agents = config.agents as Record<string, unknown> | undefined;

      if (!agents || !Array.isArray(agents.list)) {
        return [];
      }

      return (agents.list as Array<Record<string, unknown>>).map(agent => ({
        agentId: String(agent.id ?? agent.agentId ?? ''),
        model: agent.model ? String(agent.model) : undefined,
        roles: Array.isArray(agent.roles) ? agent.roles as string[] : undefined,
      })).filter(a => a.agentId !== '');
    } catch {
      // Config file not found or invalid — not an error, just no agents discovered
      return [];
    }
  }

  /**
   * Stop the event polling loop and clean up resources
   */
  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.eventHandlers = [];
    this.knownSessions.clear();
  }

  // --- Private methods ---

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      this.pollSessions().catch(() => {
        // Polling errors are non-fatal; will retry next interval
      });
    }, this.pollIntervalMs);
  }

  private async pollSessions(): Promise<void> {
    if (this.knownSessions.size === 0) return;

    for (const [sessionId, lastStatus] of this.knownSessions.entries()) {
      try {
        const current = await this.getTaskStatus(sessionId);

        if (current.status !== lastStatus) {
          this.knownSessions.set(sessionId, current.status);

          // Emit events for state transitions
          if (current.status === 'succeeded' || current.status === 'completed') {
            this.emitEvent({
              type: 'session:complete',
              sessionId,
              data: { status: current.status, outputTokens: current.outputTokens },
            });
            this.knownSessions.delete(sessionId);
          } else if (current.status === 'failed' || current.status === 'timeout') {
            this.emitEvent({
              type: 'session:timeout',
              sessionId,
              data: { status: current.status, outputTokens: current.outputTokens },
            });
            this.knownSessions.delete(sessionId);
          } else if (current.status === 'not_found') {
            this.knownSessions.delete(sessionId);
          }
        }
      } catch {
        // Individual session poll failure is non-fatal
      }
    }
  }

  private emitEvent(event: HostEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Handler errors should not break the polling loop
      }
    }
  }
}
