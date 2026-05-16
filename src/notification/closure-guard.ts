/**
 * ClosureGuard - FR-F06: 任务闭环保障
 *
 * 子 Agent 任务完成后，通过 before_prompt_build hook 注入提醒到主会话上下文，
 * 逼主会话向用户发送人话总结。若主会话在规定时间内完成发送则记录闭环成功，
 * 否则记录审计事件（closure_missed），不发送任何用户可见通知。
 */

import { EventBus } from '../event/event-bus.js';
import { AuditLogger } from '../audit-logger/index.js';
import type { HostAdapter, OutboundMessage } from '../types/index.js';

// --- Configuration (AC1, AC5, AC8, AC10) ---

export interface ClosureGuardConfig {
  /** Global toggle. Default true (AC8) */
  enabled: boolean;
  /** Closure timeout in seconds. Default 120 (AC1) */
  timeoutSeconds: number;
  /** Label patterns to exclude (prefix or /regex/) (AC5) */
  excludeLabels: string[];
}

export const DEFAULT_CLOSURE_GUARD_CONFIG: ClosureGuardConfig = {
  enabled: true,
  timeoutSeconds: 120,
  excludeLabels: ['healthcheck', 'heartbeat'],
};

// --- Pending Closure Entry ---

export interface PendingClosure {
  closureId: string;
  taskId: string;
  label: string;
  agentId: string;
  durationMs: number;
  status: 'succeeded' | 'failed';
  completedAt: number;
  timer: ReturnType<typeof setTimeout>;
  reminded: boolean;
}

// --- Completion Event (input from EventBus) ---

export interface TaskCompletionEvent {
  taskId: string;
  label: string;
  agentId: string;
  status: 'succeeded' | 'failed';
  durationMs?: number;
  failureReason?: string;
}

// --- Prompt Injection Context ---

export interface PromptBuildContext {
  sessionKey: string;
  agentId: string;
}

export interface PromptInjectionResult {
  prependContext: string;
}

// --- ClosureGuard Class ---

export class ClosureGuard {
  private config: ClosureGuardConfig;
  private eventBus: EventBus;
  private auditLogger: AuditLogger;
  private hostAdapter?: HostAdapter;
  private pendingClosures = new Map<string, PendingClosure>();
  private unsubscribeOutbound?: () => void;
  private unsubscribeCompletion?: () => void;
  private closureIdCounter = 0;

  constructor(
    eventBus: EventBus,
    auditLogger: AuditLogger,
    config?: Partial<ClosureGuardConfig>,
    hostAdapter?: HostAdapter,
  ) {
    this.eventBus = eventBus;
    this.auditLogger = auditLogger;
    this.config = { ...DEFAULT_CLOSURE_GUARD_CONFIG, ...config };
    this.hostAdapter = hostAdapter;
  }

  // --- Lifecycle ---

  /**
   * Start listening for completion events and outbound messages.
   * AC6: Runs independently in event loop, not tied to main session context.
   */
  start(): void {
    if (!this.config.enabled) return;

    // Subscribe to task completion events
    this.unsubscribeCompletion = this.eventBus.on<TaskCompletionEvent>(
      'task:completed',
      (event) => this.handleCompletion(event),
    );

    // AC9: Subscribe to outbound messages via HostAdapter
    if (this.hostAdapter?.detectOutboundMessage) {
      this.unsubscribeOutbound = this.hostAdapter.detectOutboundMessage(
        (message) => this.handleOutboundMessage(message),
      );
    }
  }

  /**
   * Stop all timers and unsubscribe from events.
   */
  stop(): void {
    // Clear all pending timers
    for (const [, entry] of this.pendingClosures) {
      clearTimeout(entry.timer);
    }
    this.pendingClosures.clear();

    // Unsubscribe
    this.unsubscribeCompletion?.();
    this.unsubscribeOutbound?.();
    this.unsubscribeCompletion = undefined;
    this.unsubscribeOutbound = undefined;
  }

  /**
   * Check if the guard is currently active.
   */
  isActive(): boolean {
    return this.config.enabled;
  }

  /**
   * Get current config (read-only).
   */
  getConfig(): Readonly<ClosureGuardConfig> {
    return this.config;
  }

  /**
   * Update config at runtime (e.g., from hot-reload).
   */
  updateConfig(newConfig: Partial<ClosureGuardConfig>): void {
    const wasEnabled = this.config.enabled;
    this.config = { ...this.config, ...newConfig };

    if (wasEnabled && !this.config.enabled) {
      this.stop();
    } else if (!wasEnabled && this.config.enabled) {
      this.start();
    }
  }

  /**
   * Get count of pending closures (for observability).
   */
  getPendingCount(): number {
    return this.pendingClosures.size;
  }

  /**
   * Get all pending closure IDs (for testing/observability).
   */
  getPendingClosureIds(): string[] {
    return Array.from(this.pendingClosures.keys());
  }

  // --- AC4, AC11, AC12: Prompt Injection ---

  /**
   * Called by the before_prompt_build hook.
   * Returns injection text if there are un-reminded pending closures for the main session.
   *
   * AC4: Injects reminder into main session context.
   * AC11: Includes task name, agentId, duration, lark-cli format. Only once per completion.
   * AC12: Only for main session (agent=main) user channel sessions.
   */
  buildPromptInjection(context: PromptBuildContext): PromptInjectionResult | null {
    if (!this.config.enabled) return null;

    // AC12: Only inject into main session
    if (!this.isMainSession(context)) return null;

    // Collect un-reminded pending closures
    const toRemind: PendingClosure[] = [];
    for (const [, entry] of this.pendingClosures) {
      if (!entry.reminded) {
        toRemind.push(entry);
      }
    }

    if (toRemind.length === 0) return null;

    // Build reminder text (AC11)
    const lines: string[] = [
      '',
      '## ⚠️ [ACO Closure Guard] 任务完成总结提醒（不可忽略）',
      '',
      '以下任务已完成，你**必须**用 `lark-cli im +messages-send --user-id <userId> --markdown "..."` 给用户发一条人话总结。不发 = 违规。',
      '',
    ];

    for (const entry of toRemind) {
      const icon = entry.status === 'succeeded' ? '✅' : '❌';
      const duration = this.formatDuration(entry.durationMs);
      lines.push(
        `- ${icon} **${entry.label || '(无label)'}** | agent=${entry.agentId} | 耗时=${duration} | taskId=${entry.taskId}`,
      );
    }

    lines.push('');
    lines.push('要求：总结用人话，包含结论+关键产出+状态。禁止技术标签。发完飞书后继续正常处理。');
    lines.push('');

    // AC11: Mark as reminded (only once per completion)
    for (const entry of toRemind) {
      entry.reminded = true;
    }

    // Log reminder injection audit event
    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      eventType: 'reminder_injected',
      details: {
        sessionKey: context.sessionKey,
        completionCount: toRemind.length,
        closureIds: toRemind.map((e) => e.closureId),
        taskIds: toRemind.map((e) => e.taskId),
      },
    });

    return { prependContext: lines.join('\n') };
  }

  // --- Internal: Completion Handling ---

  /**
   * AC1: Task completion triggers closure timer.
   * AC5: Excluded labels skip timer.
   */
  private handleCompletion(event: TaskCompletionEvent): void {
    if (!this.config.enabled) return;

    // AC5: Check excludeLabels
    if (this.shouldExclude(event.label)) return;

    // Only track succeeded or failed (AC1)
    if (event.status !== 'succeeded' && event.status !== 'failed') return;

    const closureId = this.generateClosureId(event.agentId);
    const timeoutMs = this.config.timeoutSeconds * 1000;

    // AC1: Start closure timer
    const timer = setTimeout(() => {
      this.handleClosureTimeout(closureId);
    }, timeoutMs);

    // Prevent timer from keeping the process alive
    if (timer.unref) timer.unref();

    const entry: PendingClosure = {
      closureId,
      taskId: event.taskId,
      label: event.label,
      agentId: event.agentId,
      durationMs: event.durationMs ?? 0,
      status: event.status,
      completedAt: Date.now(),
      timer,
      reminded: false,
    };

    this.pendingClosures.set(closureId, entry);
  }

  // --- Internal: Outbound Message Detection ---

  /**
   * AC2: Monitor outbound messages for taskId or label mentions.
   * AC9: Uses HostAdapter.detectOutboundMessage interface.
   */
  private handleOutboundMessage(message: OutboundMessage): void {
    if (this.pendingClosures.size === 0) return;

    const content = message.content;
    // Must be a substantive message (> 50 chars)
    if (content.length <= 50) return;

    // Check each pending closure for taskId or label match (AC2)
    for (const [closureId, entry] of this.pendingClosures) {
      if (entry.completedAt > message.timestamp) continue;

      const matches =
        content.includes(entry.taskId) || content.includes(entry.label);

      if (matches) {
        this.markClosureDetected(closureId, message);
      }
    }
  }

  /**
   * Manually notify the guard that an outbound message was sent.
   * Useful when HostAdapter.detectOutboundMessage is not available
   * and the host environment calls this directly.
   */
  notifyOutboundMessage(message: OutboundMessage): void {
    this.handleOutboundMessage(message);
  }

  // --- Internal: Timeout Handling ---

  /**
   * AC3, AC7: Timer expired without closure detection.
   * Record audit event (closure_missed), no user notification.
   */
  private handleClosureTimeout(closureId: string): void {
    const entry = this.pendingClosures.get(closureId);
    if (!entry) return;

    // AC3, AC7: Record audit event
    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      eventType: 'closure_missed',
      taskId: entry.taskId,
      agentId: entry.agentId,
      details: {
        closureId,
        label: entry.label,
        waitDurationMs: Date.now() - entry.completedAt,
        timeoutSeconds: this.config.timeoutSeconds,
        reason: 'main session did not send summary within timeout',
        reminded: entry.reminded,
      },
    });

    this.pendingClosures.delete(closureId);
  }

  // --- Internal: Closure Success ---

  /**
   * AC2: Closure detected - main session sent a message mentioning the task.
   */
  private markClosureDetected(closureId: string, message: OutboundMessage): void {
    const entry = this.pendingClosures.get(closureId);
    if (!entry) return;

    // Cancel timer
    clearTimeout(entry.timer);

    // Log success audit event
    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      eventType: 'closure_detected',
      taskId: entry.taskId,
      agentId: entry.agentId,
      details: {
        closureId,
        label: entry.label,
        latencyMs: Date.now() - entry.completedAt,
        closedBySessionKey: message.sessionKey,
      },
    });

    this.pendingClosures.delete(closureId);
  }

  // --- Helpers ---

  /**
   * AC5: Check if a label matches any exclude pattern.
   */
  private shouldExclude(label: string): boolean {
    if (!label) return false;
    return this.config.excludeLabels.some((pattern) => {
      if (pattern.startsWith('/') && pattern.endsWith('/')) {
        try {
          return new RegExp(pattern.slice(1, -1)).test(label);
        } catch {
          return false;
        }
      }
      return label.startsWith(pattern);
    });
  }

  /**
   * AC12: Determine if context is the main session user channel.
   */
  private isMainSession(context: PromptBuildContext): boolean {
    const agentId = context.agentId?.trim();
    const isMain = !agentId || agentId === 'main';
    // Also check session key contains user channel indicator
    const isUserChannel =
      context.sessionKey.includes('feishu') ||
      context.sessionKey.includes('telegram') ||
      context.sessionKey.includes('discord') ||
      context.sessionKey.includes('slack');
    return isMain && isUserChannel;
  }

  private generateClosureId(agentId: string): string {
    this.closureIdCounter++;
    return `${agentId}:${Date.now()}:${this.closureIdCounter}`;
  }

  private formatDuration(ms: number): string {
    if (!ms || ms <= 0) return '?';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const remainSec = sec % 60;
    if (remainSec === 0) return `${min}min`;
    return `${min}m${remainSec}s`;
  }
}
