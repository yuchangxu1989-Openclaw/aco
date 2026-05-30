/**
 * 任务队列 — 域 A：任务生命周期管理
 * FR-A01: 任务创建与入队
 * FR-A02: 任务状态流转
 * FR-A03: 超时保护
 * FR-A04: 实质成功校验
 * FR-A05: 任务取消
 */

import { v4 as uuid } from 'uuid';
import { EventBus } from '../event/event-bus.js';
import type {
  AcoConfig,
  AuditEvent,
  CreateTaskInput,
  Task,
  TaskStatus,
} from '../types/index.js';
import { DEFAULT_CONFIG } from '../types/index.js';

/** 合法状态转换表 */
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued: ['dispatching', 'cancelled'],
  dispatching: ['running', 'queued', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: ['retrying', 'cancelled'],
  retrying: ['dispatching', 'failed', 'cancelled'],
  cancelled: [],
};

const TERMINAL_STATES: TaskStatus[] = ['succeeded', 'cancelled'];

export class TaskQueue {
  private tasks = new Map<string, Task>();
  private config: AcoConfig;

  constructor(
    private eventBus: EventBus,
    config?: Partial<AcoConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * FR-A01 AC1/AC2: 创建任务并入队
   */
  create(input: CreateTaskInput): Task {
    const timeout = input.timeoutSeconds ?? this.config.defaultTimeout;

    // FR-A03 AC5: 超时下限校验
    if (timeout < this.config.minTimeout) {
      throw new Error(
        `Timeout ${timeout}s is below minimum ${this.config.minTimeout}s`
      );
    }

    const task: Task = {
      taskId: uuid(),
      label: input.label,
      prompt: input.prompt,
      agentId: input.agentId,
      timeoutSeconds: timeout,
      priority: input.priority ?? this.config.defaultPriority,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      retryCount: 0,
      maxRetries: input.maxRetries ?? 3,
      targetTier: input.targetTier,
      outputFiles: input.outputFiles,
      chainId: input.chain?.chainId,
      metadata: input.metadata,
    };

    this.tasks.set(task.taskId, task);
    this.emitAudit('task_created', task.taskId, {
      label: task.label,
      priority: task.priority,
      timeout: task.timeoutSeconds,
    });

    // FR-A01 AC2: 触发队列消费事件
    this.eventBus.emit('queue:task_added', { taskId: task.taskId }).catch(() => {});

    return task;
  }

  /**
   * FR-A02 AC1/AC2/AC3: 状态流转
   */
  transition(taskId: string, newStatus: TaskStatus, reason?: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // FR-A02 AC3: 终态不可逆
    if (TERMINAL_STATES.includes(task.status)) {
      throw new Error(
        `Cannot transition task ${taskId} from terminal state '${task.status}'`
      );
    }

    // FR-A02 AC2: 非法转换拒绝
    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `Invalid transition: ${task.status} -> ${newStatus} for task ${taskId}`
      );
    }

    const prevStatus = task.status;
    task.status = newStatus;
    task.updatedAt = Date.now();

    if (reason) {
      task.failureReason = reason;
    }

    if (TERMINAL_STATES.includes(newStatus)) {
      task.completedAt = Date.now();
    }

    if (newStatus === 'retrying') {
      task.retryCount++;
    }

    // FR-A02 AC1: 状态变更审计
    this.emitAudit('task_state_change', taskId, {
      from: prevStatus,
      to: newStatus,
      reason,
    });

    // FR-A02 AC4: 触发通知事件
    this.eventBus.emit('task:state_change', {
      taskId,
      from: prevStatus,
      to: newStatus,
      task,
    }).catch(() => {});

    return task;
  }

  /**
   * FR-A04 AC1/AC2/AC3: 实质成功校验
   */
  validateSubstantiveSuccess(taskId: string, outputTokens?: number, filesExist?: boolean): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    // AC1: token 阈值检查
    if (outputTokens !== undefined && outputTokens < this.config.substantiveTokenThreshold) {
      return false;
    }

    // AC2: 文件存在性检查
    if (task.outputFiles && task.outputFiles.length > 0 && filesExist === false) {
      return false;
    }

    return true;
  }

  /**
   * FR-A05 AC1: 取消任务
   */
  cancel(taskId: string): Task {
    return this.transition(taskId, 'cancelled', 'user_cancelled');
  }

  /**
   * FR-A05 AC3: 批量取消
   */
  cancelByFilter(filter: { labelPattern?: string; agentId?: string }): Task[] {
    const cancelled: Task[] = [];
    for (const task of this.tasks.values()) {
      if (TERMINAL_STATES.includes(task.status)) continue;

      let match = false;
      if (filter.labelPattern && task.label.includes(filter.labelPattern)) match = true;
      if (filter.agentId && task.agentId === filter.agentId) match = true;

      if (match) {
        this.transition(task.taskId, 'cancelled', 'batch_cancelled');
        cancelled.push(task);
      }
    }
    return cancelled;
  }

  /**
   * 获取队列中待调度的任务（queued + retrying）
   * 按 priority 降序 + 入队时间升序
   */
  getPendingTasks(): Task[] {
    return Array.from(this.tasks.values())
      .filter(t => t.status === 'queued' || t.status === 'retrying')
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.createdAt - b.createdAt;
      });
  }

  /**
   * 获取运行中的任务
   */
  getRunningTasks(): Task[] {
    return Array.from(this.tasks.values()).filter(t => t.status === 'running');
  }

  /**
   * 获取单个任务
   */
  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * 获取所有任务
   */
  getAll(): Task[] {
    return Array.from(this.tasks.values());
  }

  /**
   * 获取非终态任务
   */
  getActive(): Task[] {
    return Array.from(this.tasks.values()).filter(t => !TERMINAL_STATES.includes(t.status));
  }

  private emitAudit(type: AuditEvent['type'], taskId: string, details: Record<string, unknown>): void {
    const event: AuditEvent = {
      eventId: uuid(),
      type,
      timestamp: Date.now(),
      taskId,
      details,
    };
    this.eventBus.emit('audit', event).catch(() => {});
  }
}
