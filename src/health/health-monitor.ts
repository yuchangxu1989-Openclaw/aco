/**
 * HealthMonitor — 域 G：Agent 健康探测 + 任务停滞检测
 * FR-G01: 心跳检测（主动探测 Agent 存活性）
 * FR-G02: 卡死检测（识别长时间无产出的任务）
 */

import { EventBus } from '../event/event-bus.js';
import { ResourcePool } from '../pool/resource-pool.js';
import { TaskQueue } from '../task/task-queue.js';
import type { AgentSlot, HostAdapter, Task } from '../types/index.js';

// --- Configuration ---

export interface HealthMonitorConfig {
  /** FR-G01 AC4: 心跳探测间隔（ms），默认 30s */
  heartbeatIntervalMs: number;
  /** FR-G01 AC2: 连续无响应次数阈值，默认 3 */
  missedHeartbeatsThreshold: number;
  /** FR-G02 AC1: stall 预警倍数（timeout * factor），默认 0.8 */
  stallWarningFactor: number;
  /** FR-G02 AC3: steer 后等待响应时间（ms），默认 60s */
  stallResponseTimeoutMs: number;
  /** 按 Tier 覆盖心跳间隔 */
  tierIntervals?: Partial<Record<string, number>>;
  /** FR-G02 AC4: 免检任务类型（天然长时间无中间输出） */
  stallExemptTaskTypes?: string[];
}

export const DEFAULT_HEALTH_MONITOR_CONFIG: HealthMonitorConfig = {
  heartbeatIntervalMs: 30_000,
  missedHeartbeatsThreshold: 3,
  stallWarningFactor: 0.8,
  stallResponseTimeoutMs: 60_000,
  tierIntervals: {},
  stallExemptTaskTypes: [],
};

// --- Internal State ---

interface AgentHeartbeatState {
  agentId: string;
  lastResponseAt: number;
  missedCount: number;
  probing: boolean;
}

interface TaskStallState {
  taskId: string;
  warningEmittedAt?: number;
  steerSentAt?: number;
  resolved: boolean;
}

// --- HealthMonitor ---

export class HealthMonitor {
  private config: HealthMonitorConfig;
  private heartbeatStates = new Map<string, AgentHeartbeatState>();
  private stallStates = new Map<string, TaskStallState>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private hostAdapter?: HostAdapter;

  constructor(
    private eventBus: EventBus,
    private resourcePool: ResourcePool,
    private taskQueue: TaskQueue,
    config?: Partial<HealthMonitorConfig>,
  ) {
    this.config = { ...DEFAULT_HEALTH_MONITOR_CONFIG, ...config };
    this.setupEventListeners();
  }

  setHostAdapter(adapter: HostAdapter): void {
    this.hostAdapter = adapter;
  }

  // --- Lifecycle ---

  start(): void {
    if (this.running) return;
    this.running = true;

    // Initialize heartbeat state for all registered agents
    for (const agent of this.resourcePool.getAll()) {
      this.initHeartbeatState(agent);
    }

    // FR-G01 AC1: Start heartbeat timer
    this.heartbeatTimer = setInterval(
      () => this.runHeartbeatCycle(),
      this.config.heartbeatIntervalMs,
    );

    // FR-G02: Start stall detection timer (check every 10s)
    this.stallTimer = setInterval(
      () => this.runStallDetection(),
      10_000,
    );
  }

  stop(): void {
    this.running = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  // --- FR-G01: Heartbeat Detection ---

  /**
   * FR-G01 AC1: Run one heartbeat cycle — probe all busy agents
   */
  async runHeartbeatCycle(): Promise<void> {
    const agents = this.resourcePool.getAll().filter(
      a => a.status === 'busy' || a.status === 'idle',
    );

    for (const agent of agents) {
      await this.probeAgent(agent);
    }
  }

  /**
   * Probe a single agent for responsiveness
   */
  private async probeAgent(agent: AgentSlot): Promise<void> {
    const state = this.getOrCreateHeartbeatState(agent);
    if (state.probing) return; // Already probing, skip

    state.probing = true;

    try {
      if (this.hostAdapter) {
        const status = await this.hostAdapter.getAgentStatus(agent.agentId);
        if (status.active) {
          this.recordHeartbeatSuccess(agent.agentId);
        } else {
          this.recordHeartbeatMiss(agent.agentId);
        }
      } else {
        // No host adapter — use lastActiveAt as proxy
        const now = Date.now();
        const interval = this.getIntervalForAgent(agent);
        const threshold = interval * this.config.missedHeartbeatsThreshold;

        if (agent.lastActiveAt && (now - agent.lastActiveAt) > threshold) {
          this.recordHeartbeatMiss(agent.agentId);
        } else {
          this.recordHeartbeatSuccess(agent.agentId);
        }
      }
    } catch {
      this.recordHeartbeatMiss(agent.agentId);
    } finally {
      state.probing = false;
    }
  }

  /**
   * Record a successful heartbeat response
   */
  recordHeartbeatSuccess(agentId: string): void {
    const state = this.heartbeatStates.get(agentId);
    if (!state) return;

    const wasMissing = state.missedCount > 0;
    state.lastResponseAt = Date.now();
    state.missedCount = 0;

    if (wasMissing) {
      this.eventBus.emit('health:heartbeat_restored', { agentId }).catch(() => {});
    }
  }

  /**
   * FR-G01 AC2: Record a missed heartbeat
   */
  private recordHeartbeatMiss(agentId: string): void {
    const state = this.heartbeatStates.get(agentId);
    if (!state) return;

    state.missedCount++;

    this.eventBus.emit('health:heartbeat_missed', {
      agentId,
      missedCount: state.missedCount,
      threshold: this.config.missedHeartbeatsThreshold,
    }).catch(() => {});

    // FR-G01 AC2: Threshold reached → mark stale
    if (state.missedCount >= this.config.missedHeartbeatsThreshold) {
      this.markAgentUnhealthy(agentId);
    }
  }

  /**
   * FR-G01 AC2/AC3: Mark agent as stale, fail its running tasks
   */
  private markAgentUnhealthy(agentId: string): void {
    const agent = this.resourcePool.get(agentId);
    if (!agent || agent.status === 'stale' || agent.status === 'offline') return;

    // FR-G01 AC2: Transition to stale
    this.resourcePool.setStatus(agentId, 'stale');

    // FR-G01 AC3: Emit health state change event
    this.eventBus.emit('health:agent_unhealthy', {
      agentId,
      previousStatus: agent.status,
      reason: 'heartbeat_timeout',
      missedCount: this.heartbeatStates.get(agentId)?.missedCount ?? 0,
    }).catch(() => {});

    // FR-G01 AC3: Fail running tasks on this agent
    const runningTasks = this.taskQueue.getAll().filter(
      t => t.agentId === agentId && t.status === 'running',
    );
    for (const task of runningTasks) {
      this.eventBus.emit('health:task_failed_unhealthy_agent', {
        taskId: task.taskId,
        agentId,
        reason: 'agent_unresponsive',
      }).catch(() => {});
    }
  }

  // --- FR-G02: Stall Detection ---

  /**
   * FR-G02 AC1-AC3: Check all running tasks for stall conditions
   */
  runStallDetection(): void {
    const runningTasks = this.taskQueue.getAll().filter(t => t.status === 'running');
    const now = Date.now();

    for (const task of runningTasks) {
      // FR-G02 AC4: Skip exempt task types
      const taskType = task.metadata?.taskType as string | undefined;
      if (taskType && this.config.stallExemptTaskTypes?.includes(taskType)) {
        continue;
      }

      const elapsed = now - task.updatedAt;
      const timeoutMs = task.timeoutSeconds * 1000;
      const warningThreshold = timeoutMs * this.config.stallWarningFactor;

      const stallState = this.getOrCreateStallState(task.taskId);
      if (stallState.resolved) continue;

      // FR-G02 AC1: Stall warning
      if (elapsed >= warningThreshold && !stallState.warningEmittedAt) {
        stallState.warningEmittedAt = now;

        this.eventBus.emit('health:stall_warning', {
          taskId: task.taskId,
          agentId: task.agentId,
          elapsedMs: elapsed,
          timeoutMs,
          warningFactor: this.config.stallWarningFactor,
        }).catch(() => {});

        // FR-G02 AC2: Send steer message
        if (this.hostAdapter && task.agentId) {
          this.hostAdapter.steerTask(task.taskId, '请报告当前进度').catch(() => {});
          stallState.steerSentAt = now;
        }
      }

      // FR-G02 AC3: Steer timeout → mark stalled
      if (
        stallState.steerSentAt &&
        !stallState.resolved &&
        (now - stallState.steerSentAt) >= this.config.stallResponseTimeoutMs
      ) {
        stallState.resolved = true;

        this.eventBus.emit('health:task_stalled', {
          taskId: task.taskId,
          agentId: task.agentId,
          elapsedMs: elapsed,
          timeoutMs,
        }).catch(() => {});
      }
    }
  }

  /**
   * Mark a stall as resolved (e.g., agent responded after steer)
   */
  resolveStall(taskId: string): void {
    const state = this.stallStates.get(taskId);
    if (state) {
      state.resolved = true;
    }
  }

  // --- Query Methods ---

  getHeartbeatState(agentId: string): AgentHeartbeatState | undefined {
    return this.heartbeatStates.get(agentId);
  }

  getAllHeartbeatStates(): AgentHeartbeatState[] {
    return Array.from(this.heartbeatStates.values());
  }

  getStallState(taskId: string): TaskStallState | undefined {
    return this.stallStates.get(taskId);
  }

  // --- Private Helpers ---

  private setupEventListeners(): void {
    // When a new agent is registered, init its heartbeat state
    this.eventBus.on('audit', (event: unknown) => {
      const e = event as { type: string; details?: Record<string, unknown> };
      if (e.type === 'agent_registered' && e.details?.agentId) {
        const agent = this.resourcePool.get(e.details.agentId as string);
        if (agent) this.initHeartbeatState(agent);
      }
    });

    // When message:received, update heartbeat
    this.eventBus.on('message:received', (payload: unknown) => {
      const p = payload as { agentId?: string };
      if (p.agentId) {
        this.recordHeartbeatSuccess(p.agentId);
      }
    });

    // When task completes, clean up stall state
    this.eventBus.on('task:state_change', (payload: unknown) => {
      const p = payload as { taskId: string; to: string };
      if (p.to === 'succeeded' || p.to === 'failed' || p.to === 'cancelled') {
        this.stallStates.delete(p.taskId);
      }
    });
  }

  private initHeartbeatState(agent: AgentSlot): void {
    if (!this.heartbeatStates.has(agent.agentId)) {
      this.heartbeatStates.set(agent.agentId, {
        agentId: agent.agentId,
        lastResponseAt: agent.lastActiveAt ?? Date.now(),
        missedCount: 0,
        probing: false,
      });
    }
  }

  private getOrCreateHeartbeatState(agent: AgentSlot): AgentHeartbeatState {
    let state = this.heartbeatStates.get(agent.agentId);
    if (!state) {
      state = {
        agentId: agent.agentId,
        lastResponseAt: agent.lastActiveAt ?? Date.now(),
        missedCount: 0,
        probing: false,
      };
      this.heartbeatStates.set(agent.agentId, state);
    }
    return state;
  }

  private getOrCreateStallState(taskId: string): TaskStallState {
    let state = this.stallStates.get(taskId);
    if (!state) {
      state = { taskId, resolved: false };
      this.stallStates.set(taskId, state);
    }
    return state;
  }

  private getIntervalForAgent(agent: AgentSlot): number {
    const tierInterval = this.config.tierIntervals?.[agent.tier];
    return tierInterval ?? this.config.heartbeatIntervalMs;
  }
}
