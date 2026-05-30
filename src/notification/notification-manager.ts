/**
 * NotificationManager - 域 F：通知与 IM 推送
 * FR-F01: 通知渠道注册
 * FR-F02: 事件订阅过滤
 * FR-F03: 通知内容模板
 * FR-F04: 通知送达确认
 */

import { EventBus } from '../event/event-bus.js';
import type { NotificationChannelType, Task } from '../types/index.js';

// --- Types ---

export interface ChannelConfig {
  /** Channel unique ID */
  channelId: string;
  /** Channel type */
  type: NotificationChannelType;
  /** Type-specific configuration (url, token, chatId, etc.) */
  config: Record<string, unknown>;
  /** Whether this channel is active */
  enabled: boolean;
  /** Channel health status */
  status: 'active' | 'degraded' | 'disabled';
  /** Consecutive delivery failures */
  consecutiveFailures: number;
  /** Total messages sent */
  totalSent: number;
  /** Total delivery failures */
  totalFailed: number;
}

export type NotificationEventType =
  | 'task_succeeded'
  | 'task_failed'
  | 'task_timeout'
  | 'circuit_break'
  | 'chain_completed'
  | 'task_completed';

export type NotificationTaskSource = 'subagent' | 'acp' | 'system' | 'main';

export interface SubscriptionFilter {
  /** Event types to subscribe to */
  eventTypes?: NotificationEventType[];
  /** Minimum priority threshold */
  minPriority?: number;
  /** Only events from these agents */
  agentIds?: string[];
  /** Exclude task labels by prefix or regular expression */
  excludeLabels?: string[];
  /** Only events from these task sources */
  taskSources?: NotificationTaskSource[];
}

export interface DeliveryRecord {
  recordId: string;
  channelId: string;
  eventType: NotificationEventType;
  status: 'sent' | 'delivered' | 'failed';
  attempts: number;
  lastAttemptAt: number;
  error?: string;
  taskId?: string;
}

export interface NotificationTemplate {
  name: string;
  template: string; // Handlebars-style template
}

export interface NotificationPayload {
  eventType: NotificationEventType;
  taskId: string;
  label: string;
  agentId?: string;
  source?: NotificationTaskSource;
  fromStatus?: string;
  toStatus?: string;
  durationMs?: number;
  failureReason?: string;
  outputSummary?: string;
  outputFiles?: string[];
  suggestion?: string;
}

export interface CompletionEventPayload {
  type?: 'session:complete' | 'run:completed' | 'subagent_ended';
  sessionId?: string;
  runId?: string;
  childSessionKey?: string;
  targetSessionKey?: string;
  targetKind?: string;
  agentId?: string;
  label?: string;
  status?: string;
  outcome?: string;
  success?: boolean;
  startedAt?: number | string;
  createdAt?: number | string;
  endedAt?: number | string;
  completedAt?: number | string;
  durationMs?: number;
  data?: Record<string, unknown>;
}

/** Transport interface for channel-specific delivery */
export interface ChannelTransport {
  send(channel: ChannelConfig, message: string): Promise<void>;
  testConnection(channel: ChannelConfig): Promise<boolean>;
}

// --- Configuration ---

export interface NotificationManagerConfig {
  /** Max retry attempts for failed deliveries (FR-F04 AC2) */
  maxRetries: number;
  /** Base delay for exponential backoff in ms */
  retryBaseDelayMs: number;
  /** Consecutive failures before marking channel as degraded (FR-F04 AC3) */
  degradedThreshold: number;
  /** Single delivery attempt timeout in ms (FR-F05 AC7) */
  sendTimeoutMs: number;
  /** Default subscription filter */
  defaultFilter: SubscriptionFilter;
}

export const DEFAULT_NOTIFICATION_CONFIG: NotificationManagerConfig = {
  maxRetries: 3,
  retryBaseDelayMs: 1000,
  degradedThreshold: 5,
  sendTimeoutMs: 10000,
  defaultFilter: {
    eventTypes: ['task_failed', 'circuit_break', 'task_completed'],
    excludeLabels: ['healthcheck', 'heartbeat'],
    taskSources: ['subagent', 'acp'],
  },
};

// --- Default Templates (FR-F03 AC4) ---

const DEFAULT_TEMPLATES: Record<NotificationEventType, string> = {
  task_succeeded: '✅ Task {{label}} ({{taskId}}) succeeded\nAgent: {{agentId}}\nDuration: {{durationFormatted}}\n{{#if outputSummary}}Output: {{outputSummary}}{{/if}}',
  task_failed: '❌ Task {{label}} ({{taskId}}) failed\nAgent: {{agentId}}\nReason: {{failureReason}}\n{{#if suggestion}}Next: {{suggestion}}{{/if}}',
  task_timeout: '⏰ Task {{label}} ({{taskId}}) timed out\nAgent: {{agentId}}\nDuration: {{durationFormatted}}',
  circuit_break: '🔴 Circuit break triggered for agent {{agentId}}\nConsecutive failures exceeded threshold',
  chain_completed: '🔗 Chain completed: {{label}}\nFinal task: {{taskId}}\nStatus: {{toStatus}}',
  task_completed: '{{completionIcon}} [{{agentId}}] {{label}} | {{durationFormatted}}{{failureSuffix}}',
};

// --- FR-F05 AC8: Known host event names ---

/**
 * Valid event names that the host environment declares.
 * Event listeners must reference one of these names.
 */
export const KNOWN_HOST_EVENTS = [
  'session:complete',
  'session:timeout',
  'run:completed',
  'subagent_ended',
  'subagent_spawned',
  'task:state_change',
  'agent:circuit_break',
  'notification:channel_degraded',
  'notification:warn',
  'message:received',
] as const;

export type KnownHostEvent = typeof KNOWN_HOST_EVENTS[number];

export interface EventListenerStatus {
  eventName: string;
  active: boolean;
  registeredAt: number;
  error?: string;
}

/**
 * FR-F05 AC8: Validate that an event name is in the host's declared event list.
 * Returns null if valid, or an error message with available events if invalid.
 */
export function validateEventName(eventName: string): { valid: boolean; error?: string } {
  if ((KNOWN_HOST_EVENTS as readonly string[]).includes(eventName)) {
    return { valid: true };
  }
  return {
    valid: false,
    error: `Invalid event name "${eventName}". Available events: ${KNOWN_HOST_EVENTS.join(', ')}`,
  };
}

// --- NotificationManager ---

export class NotificationManager {
  private channels = new Map<string, ChannelConfig>();
  private filter: SubscriptionFilter;
  private config: NotificationManagerConfig;
  private deliveryRecords: DeliveryRecord[] = [];
  private templates: Record<string, string>;
  private transports = new Map<NotificationChannelType, ChannelTransport>();
  private eventBus: EventBus;
  private completionStarts = new Map<string, number>();
  private eventListeners: EventListenerStatus[] = [];

  constructor(eventBus: EventBus, config?: Partial<NotificationManagerConfig>) {
    this.eventBus = eventBus;
    this.config = { ...DEFAULT_NOTIFICATION_CONFIG, ...config };
    this.filter = { ...this.config.defaultFilter };
    this.templates = { ...DEFAULT_TEMPLATES };

    // Listen to task state changes
    this.registerEventListener('task:state_change', (payload: unknown) => {
      this.handleTaskStateChange(payload as {
        taskId: string;
        from: string;
        to: string;
        task: Task;
      });
    });

    // Listen to circuit break events
    this.registerEventListener('agent:circuit_break', (payload: unknown) => {
      const { agentId } = payload as { agentId: string };
      this.notify({
        eventType: 'circuit_break',
        taskId: '',
        label: '',
        agentId,
      }).catch(() => {});
    });

    // Listen to task completion events from host/plugin runtime (FR-F05)
    this.registerEventListener('subagent_spawned', (payload: unknown) => {
      this.trackCompletionStart(payload as CompletionEventPayload);
    });
    for (const eventName of ['session:complete', 'run:completed', 'subagent_ended'] as const) {
      this.registerEventListener(eventName, (payload: unknown) => {
        this.handleCompletionEvent(eventName, payload as CompletionEventPayload);
      });
    }
  }

  // --- FR-F01: Channel Registration ---

  /**
   * FR-F01 AC2: Register a notification channel
   */
  registerChannel(
    type: NotificationChannelType,
    config: Record<string, unknown>,
    channelId?: string,
  ): ChannelConfig {
    const id = channelId ?? `${type}-${Date.now()}`;
    const channel: ChannelConfig = {
      channelId: id,
      type,
      config,
      enabled: true,
      status: 'active',
      consecutiveFailures: 0,
      totalSent: 0,
      totalFailed: 0,
    };
    this.channels.set(id, channel);
    return channel;
  }

  /**
   * FR-F01 AC3: Test channel connectivity
   */
  async testChannel(channelId: string): Promise<{ success: boolean; error?: string }> {
    const channel = this.channels.get(channelId);
    if (!channel) return { success: false, error: 'Channel not found' };

    const transport = this.transports.get(channel.type);
    if (!transport) return { success: false, error: `No transport registered for type: ${channel.type}` };

    try {
      const ok = await transport.testConnection(channel);
      return { success: ok };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Remove a channel
   */
  removeChannel(channelId: string): boolean {
    return this.channels.delete(channelId);
  }

  /**
   * Get all registered channels
   */
  getChannels(): ChannelConfig[] {
    return Array.from(this.channels.values());
  }

  /**
   * Get a specific channel
   */
  getChannel(channelId: string): ChannelConfig | undefined {
    return this.channels.get(channelId);
  }

  // --- FR-F02: Event Subscription & Filtering ---

  /**
   * FR-F02 AC1-AC4: Set subscription filter
   */
  setFilter(filter: SubscriptionFilter): void {
    if (!filter.eventTypes && !filter.minPriority && !filter.agentIds && !filter.excludeLabels && !filter.taskSources) {
      this.filter = {};
      return;
    }
    this.filter = { ...this.filter, ...filter };
  }

  /**
   * Get current filter
   */
  getFilter(): SubscriptionFilter {
    return { ...this.filter };
  }

  /**
   * Check if an event passes the subscription filter
   */
  private passesFilter(payload: NotificationPayload, task?: Task): boolean {
    // FR-F02 AC1: Event type filter
    if (this.filter.eventTypes && this.filter.eventTypes.length > 0) {
      if (!this.filter.eventTypes.includes(payload.eventType)) return false;
    }

    // FR-F02 AC2: Priority filter
    if (this.filter.minPriority !== undefined && task) {
      if (task.priority < this.filter.minPriority) return false;
    }

    // FR-F02 AC3: Agent filter
    if (this.filter.agentIds && this.filter.agentIds.length > 0) {
      if (payload.agentId && !this.filter.agentIds.includes(payload.agentId)) return false;
    }

    // FR-F02 AC5: Label exclusion by prefix or RegExp string
    if (this.isExcludedLabel(payload.label, this.filter.excludeLabels)) return false;

    // FR-F02 AC6: Task source filter
    if (this.filter.taskSources && this.filter.taskSources.length > 0) {
      const source = payload.source ?? this.inferSource(payload, task);
      if (!this.filter.taskSources.includes(source)) return false;
    }

    return true;
  }

  private isExcludedLabel(label: string | undefined, patterns: string[] | undefined): boolean {
    const text = String(label ?? '').trim();
    if (!text || !patterns || patterns.length === 0) return false;

    return patterns.some(pattern => {
      if (!pattern) return false;
      if (text.startsWith(pattern)) return true;
      try {
        return new RegExp(pattern).test(text);
      } catch {
        return false;
      }
    });
  }

  private inferSource(payload: NotificationPayload, task?: Task): NotificationTaskSource {
    const raw = task?.metadata?.source ?? task?.metadata?.runtimeType ?? payload.source;
    if (raw === 'subagent' || raw === 'acp' || raw === 'system' || raw === 'main') return raw;
    return 'subagent';
  }

  // --- FR-F03: Message Templates ---

  /**
   * FR-F03 AC4: Set custom template
   */
  setTemplate(eventType: NotificationEventType, template: string): void {
    this.templates[eventType] = template;
  }

  /**
   * Get template for event type
   */
  getTemplate(eventType: NotificationEventType): string {
    return this.templates[eventType] ?? DEFAULT_TEMPLATES[eventType];
  }

  /**
   * FR-F03 AC1-AC3: Format notification message
   */
  formatMessage(payload: NotificationPayload): string {
    const template = this.templates[payload.eventType] ?? '{{eventType}}: {{label}} ({{taskId}})';
    return this.renderTemplate(template, payload as unknown as Record<string, unknown>);
  }

  private renderTemplate(template: string, data: Record<string, unknown>): string {
    // Simple Handlebars-like rendering
    let result = template;

    // Handle {{#if field}}...{{/if}} blocks
    result = result.replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, field, content) => {
      return data[field] ? content : '';
    });

    // Handle {{field}} substitutions
    result = result.replace(/\{\{(\w+)\}\}/g, (_, field) => {
      if (field === 'durationFormatted') {
        const ms = data['durationMs'] as number | undefined;
        if (ms === undefined) return 'N/A';
        if (data['eventType'] === 'task_completed') {
          const sec = Math.max(0, Math.round(ms / 1000));
          if (sec < 60) return `${sec}s`;
          return `${Math.floor(sec / 60)}m ${sec % 60}s`;
        }
        return ms >= 60000 ? `${(ms / 60000).toFixed(1)}min` : `${(ms / 1000).toFixed(1)}s`;
      }
      if (field === 'completionIcon') {
        return data['toStatus'] === 'failed' ? '❌' : '✅';
      }
      if (field === 'failureSuffix') {
        return data['toStatus'] === 'failed' ? '（失败）' : '';
      }
      const val = data[field];
      return val !== undefined && val !== null ? String(val) : '';
    });

    return result.trim();
  }

  // --- FR-F04: Delivery & Retry ---

  /**
   * Register a transport for a channel type
   */
  registerTransport(type: NotificationChannelType, transport: ChannelTransport): void {
    this.transports.set(type, transport);
  }

  /**
   * FR-F04 AC1-AC3: Send notification to all enabled channels
   */
  async notify(payload: NotificationPayload, task?: Task): Promise<DeliveryRecord[]> {
    if (!this.passesFilter(payload, task)) return [];

    const message = this.formatMessage(payload);
    const records: DeliveryRecord[] = [];

    // FR-F01 AC4: Push to all enabled channels in parallel
    const enabledChannels = Array.from(this.channels.values()).filter(
      ch => ch.enabled && ch.status !== 'disabled'
    );

    await Promise.all(
      enabledChannels.map(async (channel) => {
        const record = await this.deliverToChannel(channel, message, payload);
        records.push(record);
      })
    );

    return records;
  }

  private async deliverToChannel(
    channel: ChannelConfig,
    message: string,
    payload: NotificationPayload,
  ): Promise<DeliveryRecord> {
    const record: DeliveryRecord = {
      recordId: `${channel.channelId}-${Date.now()}`,
      channelId: channel.channelId,
      eventType: payload.eventType,
      status: 'sent',
      attempts: 0,
      lastAttemptAt: Date.now(),
      taskId: payload.taskId || undefined,
    };

    const transport = this.transports.get(channel.type);
    if (!transport) {
      record.status = 'failed';
      record.error = `No transport for type: ${channel.type}`;
      this.recordDelivery(record, channel);
      return record;
    }

    // FR-F04 AC2: Retry with exponential backoff
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      record.attempts = attempt + 1;
      record.lastAttemptAt = Date.now();

      try {
        await this.withTimeout(
          transport.send(channel, message),
          this.config.sendTimeoutMs,
          `Notification delivery timed out after ${this.config.sendTimeoutMs}ms`,
        );
        record.status = 'delivered';
        channel.totalSent++;
        channel.consecutiveFailures = 0;
        if (channel.status === 'degraded') {
          channel.status = 'active';
        }
        break;
      } catch (err) {
        record.error = (err as Error).message;
        if (attempt < this.config.maxRetries) {
          // Exponential backoff
          const delay = this.config.retryBaseDelayMs * Math.pow(2, attempt);
          await this.sleep(delay);
        } else {
          record.status = 'failed';
          channel.totalFailed++;
          channel.consecutiveFailures++;

          // FR-F04 AC3: Mark as degraded if threshold exceeded
          if (channel.consecutiveFailures >= this.config.degradedThreshold) {
            channel.status = 'degraded';
            this.eventBus.emit('notification:channel_degraded', {
              channelId: channel.channelId,
              consecutiveFailures: channel.consecutiveFailures,
            }).catch(() => {});
          }
        }
      }
    }

    this.recordDelivery(record, channel);
    return record;
  }

  private recordDelivery(record: DeliveryRecord, _channel: ChannelConfig): void {
    this.deliveryRecords.push(record);
    // Keep only last 1000 records
    if (this.deliveryRecords.length > 1000) {
      this.deliveryRecords = this.deliveryRecords.slice(-500);
    }
  }

  /**
   * FR-F05: Listen to host task completion events and send fire-and-forget completion notifications.
   */
  private handleCompletionEvent(eventName: 'session:complete' | 'run:completed' | 'subagent_ended', event: CompletionEventPayload): void {
    const payload = this.normalizeCompletionEvent(eventName, event);
    this.notify(payload)
      .then((records) => {
        if (records.some(record => record.status === 'failed')) {
          this.eventBus.emit('notification:warn', {
            reason: 'completion_notification_failed',
            taskId: payload.taskId,
          }).catch(() => {});
        }
      })
      .catch((err) => {
        // FR-F05 AC2: notification failure must not block completion flow.
        this.eventBus.emit('notification:warn', {
          reason: 'completion_notification_failed',
          error: (err as Error).message,
          taskId: payload.taskId,
        }).catch(() => {});
      });
  }

  private trackCompletionStart(event: CompletionEventPayload): void {
    const key = this.completionKey(event);
    if (!key) return;
    this.completionStarts.set(key, this.parseTime(event.startedAt ?? event.createdAt) ?? Date.now());
  }

  private normalizeCompletionEvent(
    eventName: 'session:complete' | 'run:completed' | 'subagent_ended',
    event: CompletionEventPayload,
  ): NotificationPayload {
    const data = event.data ?? {};
    const sessionKey = event.targetSessionKey ?? event.childSessionKey ?? event.sessionId ?? String(data.childSessionKey ?? data.sessionId ?? '');
    const taskId = event.runId ?? event.sessionId ?? sessionKey ?? `completion-${Date.now()}`;
    const agentId = event.agentId
      ?? (typeof data.agentId === 'string' ? data.agentId : undefined)
      ?? this.agentIdFromSessionKey(sessionKey)
      ?? 'unknown';
    const label = event.label
      ?? (typeof data.label === 'string' ? data.label : undefined)
      ?? 'subagent-task';
    const status = this.normalizeCompletionStatus(event, data);
    const ended = this.parseTime(event.endedAt ?? event.completedAt)
      ?? this.parseTime(data.endedAt as number | string | undefined)
      ?? Date.now();
    const started = this.parseTime(event.startedAt ?? event.createdAt)
      ?? this.parseTime(data.startedAt as number | string | undefined)
      ?? this.completionStarts.get(this.completionKey(event))
      ?? ended;
    const durationMs = typeof event.durationMs === 'number'
      ? event.durationMs
      : typeof data.durationMs === 'number'
        ? data.durationMs
        : Math.max(0, ended - started);

    return {
      eventType: 'task_completed',
      taskId,
      label,
      agentId,
      source: this.normalizeSource(eventName, event, data, sessionKey),
      toStatus: status,
      durationMs,
      failureReason: status === 'failed' ? String(data.error ?? data.reason ?? event.outcome ?? '') : undefined,
    };
  }

  private normalizeCompletionStatus(event: CompletionEventPayload, data: Record<string, unknown>): 'succeeded' | 'failed' {
    if (event.success === true || data.success === true) return 'succeeded';
    if (event.success === false || data.success === false) return 'failed';

    const raw = String(event.status ?? data.status ?? event.outcome ?? data.outcome ?? '').toLowerCase();
    if (raw === 'ok' || raw === 'success' || raw === 'succeeded' || raw === 'completed') return 'succeeded';
    if (raw === 'failed' || raw === 'error' || raw === 'timeout' || raw === 'cancelled') return 'failed';
    return 'succeeded';
  }

  private normalizeSource(
    eventName: 'session:complete' | 'run:completed' | 'subagent_ended',
    event: CompletionEventPayload,
    data: Record<string, unknown>,
    sessionKey: string,
  ): NotificationTaskSource {
    const raw = event.targetKind ?? data.source ?? data.kind ?? data.runtimeType;
    if (raw === 'subagent' || raw === 'acp' || raw === 'system' || raw === 'main') return raw;
    if (String(sessionKey).includes(':acp:')) return 'acp';
    if (String(sessionKey).includes(':main:')) return 'main';
    if (eventName === 'session:complete' && String(sessionKey).includes(':system:')) return 'system';
    return 'subagent';
  }

  private completionKey(event: CompletionEventPayload): string {
    return event.targetSessionKey ?? event.childSessionKey ?? event.sessionId ?? event.runId ?? '';
  }

  private agentIdFromSessionKey(sessionKey: string): string | undefined {
    const parts = String(sessionKey).split(':');
    return parts.length >= 2 && parts[1] ? parts[1] : undefined;
  }

  private parseTime(value: number | string | undefined): number | undefined {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // --- FR-F04 AC4: Status & Delivery History ---

  /**
   * Get delivery records for a channel
   */
  getDeliveryRecords(channelId?: string): DeliveryRecord[] {
    if (!channelId) return [...this.deliveryRecords];
    return this.deliveryRecords.filter(r => r.channelId === channelId);
  }

  /**
   * Get channel delivery stats
   */
  getChannelStats(channelId: string): {
    deliveryRate: number;
    recentFailures: DeliveryRecord[];
  } | undefined {
    const channel = this.channels.get(channelId);
    if (!channel) return undefined;

    const total = channel.totalSent + channel.totalFailed;
    const deliveryRate = total > 0 ? channel.totalSent / total : 1;
    const recentFailures = this.deliveryRecords
      .filter(r => r.channelId === channelId && r.status === 'failed')
      .slice(-10);

    return { deliveryRate, recentFailures };
  }

  // --- FR-F05 AC8/AC9: Event Listener Registration & Status ---

  /**
   * FR-F05 AC8: Register an event listener with validation.
   * Validates event name against known host events before registering.
   * Throws if event name is invalid.
   */
  registerEventListener(eventName: string, handler: (payload: unknown) => void): void {
    const validation = validateEventName(eventName);
    if (!validation.valid) {
      const status: EventListenerStatus = {
        eventName,
        active: false,
        registeredAt: Date.now(),
        error: validation.error,
      };
      this.eventListeners.push(status);
      throw new Error(validation.error);
    }

    this.eventBus.on(eventName, handler);
    this.eventListeners.push({
      eventName,
      active: true,
      registeredAt: Date.now(),
    });
  }

  /**
   * FR-F05 AC9: Get the status of all registered event listeners.
   */
  getEventListenerStatus(): EventListenerStatus[] {
    return [...this.eventListeners];
  }

  /**
   * FR-F04 AC5: Test all registered channels and return per-channel results.
   */
  async testAllChannels(): Promise<Array<{ channelId: string; type: NotificationChannelType; success: boolean; error?: string }>> {
    const results: Array<{ channelId: string; type: NotificationChannelType; success: boolean; error?: string }> = [];
    const allChannels = Array.from(this.channels.values());
    for (const channel of allChannels) {
      if (!channel.enabled) {
        results.push({ channelId: channel.channelId, type: channel.type, success: false, error: 'Channel disabled' });
        continue;
      }
      const testResult = await this.testChannel(channel.channelId);
      results.push({
        channelId: channel.channelId,
        type: channel.type,
        success: testResult.success,
        error: testResult.error,
      });
    }
    return results;
  }

  // --- Internal Event Handling ---

  private handleTaskStateChange(payload: {
    taskId: string;
    from: string;
    to: string;
    task: Task;
  }): void {
    const { taskId, from, to, task } = payload;

    let eventType: NotificationEventType | undefined;
    let suggestion: string | undefined;

    if (to === 'succeeded') {
      eventType = 'task_succeeded';
    } else if (to === 'failed') {
      eventType = 'task_failed';
      if (task.failureReason === 'timeout') {
        eventType = 'task_timeout';
      }
      if (task.retryCount < task.maxRetries) {
        suggestion = '已自动升级梯队重试';
      }
    }

    if (!eventType) return;

    const notifPayload: NotificationPayload = {
      eventType,
      taskId,
      label: task.label,
      agentId: task.agentId,
      source: this.inferSource({
        eventType,
        taskId,
        label: task.label,
        agentId: task.agentId,
      }, task),
      fromStatus: from,
      toStatus: to,
      durationMs: task.completedAt && task.createdAt
        ? task.completedAt - task.createdAt
        : undefined,
      failureReason: task.failureReason,
      outputSummary: task.outputSummary?.slice(0, 200),
      outputFiles: task.outputFiles,
      suggestion,
    };

    this.notify(notifPayload, task).catch(() => {});
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
