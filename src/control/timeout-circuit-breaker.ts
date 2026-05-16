/**
 * FR-C03：超时熔断与 Stale 治理
 * 超时 kill + 自动重派
 * stale running 扫描（超过 timeout * staleFactor 视为 stale）
 * Agent 熔断：连续失败 N 次 → circuit-open → 冷却后恢复
 */

import type { Task } from '../types/index.js';
import type { EventBus } from '../event/event-bus.js';
import type { CircuitBreakerConfig, AgentCircuitState, StaleTaskInfo } from './types.js';

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  cooldownMs: 300_000, // 5 分钟
  staleFactor: 1.5,
  scanIntervalMs: 30_000, // 30 秒
  stallGracePeriodMs: 60_000, // 60 秒
  enabled: true,
};

/**
 * 超时熔断器 — 管理 Agent 健康状态和 stale 任务治理
 */
export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private agentStates = new Map<string, AgentCircuitState>();
  private stallWarnings = new Map<string, number>(); // taskId → warning timestamp
  private scanTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private eventBus: EventBus,
    config: Partial<CircuitBreakerConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 启动 stale 扫描定时器
   */
  start(getRunningTasks: () => Task[]): void {
    if (!this.config.enabled) return;
    if (this.scanTimer) return;

    this.scanTimer = setInterval(() => {
      this.scanStaleTasks(getRunningTasks());
    }, this.config.scanIntervalMs);
  }

  /**
   * 停止扫描
   */
  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  /**
   * 记录 Agent 任务失败，检查是否触发熔断
   */
  recordFailure(agentId: string): AgentCircuitState {
    const state = this.getOrCreateState(agentId);
    state.consecutiveFailures++;
    state.lastFailureAt = Date.now();

    if (state.consecutiveFailures >= this.config.failureThreshold && state.state === 'closed') {
      state.state = 'open';
      state.openedAt = Date.now();
      state.recoveryAt = Date.now() + this.config.cooldownMs;

      this.eventBus.emit('agent:circuit_break', {
        agentId,
        consecutiveFailures: state.consecutiveFailures,
        recoveryAt: state.recoveryAt,
      }).catch(() => {});

      // 安排冷却后自动恢复
      setTimeout(() => this.attemptRecovery(agentId), this.config.cooldownMs);
    }

    return { ...state };
  }

  /**
   * 记录 Agent 任务成功，重置连续失败计数
   */
  recordSuccess(agentId: string): AgentCircuitState {
    const state = this.getOrCreateState(agentId);
    state.consecutiveFailures = 0;

    // half-open 状态下成功 → 恢复为 closed
    if (state.state === 'half-open') {
      state.state = 'closed';
      state.openedAt = undefined;
      state.recoveryAt = undefined;

      this.eventBus.emit('agent:recovered', { agentId }).catch(() => {});
    }

    return { ...state };
  }

  /**
   * 检查 Agent 是否可用（非熔断状态）
   */
  isAvailable(agentId: string): boolean {
    const state = this.agentStates.get(agentId);
    if (!state) return true;
    return state.state !== 'open';
  }

  /**
   * 获取 Agent 熔断状态
   */
  getState(agentId: string): AgentCircuitState | undefined {
    const state = this.agentStates.get(agentId);
    return state ? { ...state } : undefined;
  }

  /**
   * 获取所有 Agent 的熔断状态
   */
  getAllStates(): AgentCircuitState[] {
    return Array.from(this.agentStates.values()).map(s => ({ ...s }));
  }

  /**
   * 检测任务是否超时，返回应 kill 的任务列表
   */
  detectTimeouts(runningTasks: Task[]): Task[] {
    if (!this.config.enabled) return [];

    const now = Date.now();
    return runningTasks.filter(task => {
      if (task.status !== 'running') return false;
      const elapsed = now - task.updatedAt;
      const timeoutMs = task.timeoutSeconds * 1000;
      return elapsed > timeoutMs;
    });
  }

  /**
   * 扫描 stale 任务（超过 timeout * staleFactor 仍在运行）
   */
  scanStaleTasks(runningTasks: Task[]): StaleTaskInfo[] {
    if (!this.config.enabled) return [];

    const now = Date.now();
    const staleInfos: StaleTaskInfo[] = [];

    for (const task of runningTasks) {
      if (task.status !== 'running') continue;

      const elapsed = now - task.updatedAt;
      const staleThreshold = task.timeoutSeconds * 1000 * this.config.staleFactor;

      if (elapsed <= staleThreshold) continue;

      const stallWarned = this.stallWarnings.has(task.taskId);
      const stallWarnedAt = this.stallWarnings.get(task.taskId);

      const info: StaleTaskInfo = {
        taskId: task.taskId,
        agentId: task.agentId,
        runningDuration: elapsed,
        timeoutSeconds: task.timeoutSeconds,
        staleFactor: this.config.staleFactor,
        stallWarned,
        stallWarnedAt,
      };

      staleInfos.push(info);

      if (!stallWarned) {
        // 首次发现 stale → 发送 stall_warning
        this.stallWarnings.set(task.taskId, now);
        this.eventBus.emit('task:stall_warning', {
          taskId: task.taskId,
          agentId: task.agentId,
          elapsed,
          threshold: staleThreshold,
        }).catch(() => {});
      } else if (stallWarnedAt && (now - stallWarnedAt) > this.config.stallGracePeriodMs) {
        // stall_warning 后超过宽限期仍无响应 → 应 kill
        this.eventBus.emit('task:stale_kill', {
          taskId: task.taskId,
          agentId: task.agentId,
          elapsed,
          gracePeriodExceeded: true,
        }).catch(() => {});
      }
    }

    return staleInfos;
  }

  /**
   * 清除任务的 stall warning 记录（任务完成后调用）
   */
  clearStallWarning(taskId: string): void {
    this.stallWarnings.delete(taskId);
  }

  /**
   * 手动重置 Agent 熔断状态
   */
  reset(agentId: string): void {
    this.agentStates.delete(agentId);
  }

  /**
   * 尝试恢复熔断的 Agent（冷却期结束后）
   */
  private attemptRecovery(agentId: string): void {
    const state = this.agentStates.get(agentId);
    if (!state || state.state !== 'open') return;

    // 转为 half-open，允许探测性派发
    state.state = 'half-open';
    this.eventBus.emit('agent:half_open', { agentId }).catch(() => {});
  }

  private getOrCreateState(agentId: string): AgentCircuitState {
    let state = this.agentStates.get(agentId);
    if (!state) {
      state = {
        agentId,
        state: 'closed',
        consecutiveFailures: 0,
      };
      this.agentStates.set(agentId, state);
    }
    return state;
  }
}
