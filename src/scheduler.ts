/**
 * 调度器 — 核心编排组件
 * 连接 TaskQueue + ResourcePool + RuleEngine，实现事件驱动调度
 */

import { EventBus } from './event/event-bus.js';
import { TaskQueue } from './task/task-queue.js';
import { ResourcePool } from './pool/resource-pool.js';
import { RuleEngine } from './dispatch/rule-engine.js';
import type {
  AcoConfig,
  CreateTaskInput,
  HostAdapter,
  LLMProvider,
  Task,
  Tier,
} from './types/index.js';
import { DEFAULT_CONFIG } from './types/index.js';

export class Scheduler {
  readonly eventBus: EventBus;
  readonly taskQueue: TaskQueue;
  readonly resourcePool: ResourcePool;
  readonly ruleEngine: RuleEngine;
  private config: AcoConfig;
  private hostAdapter?: HostAdapter;

  constructor(config?: Partial<AcoConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventBus = new EventBus();
    this.taskQueue = new TaskQueue(this.eventBus, this.config);
    this.resourcePool = new ResourcePool(this.eventBus);
    this.ruleEngine = new RuleEngine(this.eventBus);

    this.ruleEngine.setDefaultPolicy(this.config.defaultPolicy);

    // 监听队列事件，触发调度
    this.eventBus.on('queue:task_added', () => this.tryDispatch());
    this.eventBus.on('agent:recovered', () => this.tryDispatch());
  }

  setHostAdapter(adapter: HostAdapter): void {
    this.hostAdapter = adapter;
  }

  setLLMProvider(provider: LLMProvider): void {
    this.ruleEngine.setLLMProvider(provider);
  }

  /**
   * 创建任务并触发调度
   */
  async createTask(input: CreateTaskInput): Promise<Task> {
    return this.taskQueue.create(input);
  }

  /**
   * 核心调度循环：取待调度任务 → 规则校验 → 选 Agent → 派发
   */
  async tryDispatch(): Promise<void> {
    const pending = this.taskQueue.getPendingTasks();
    if (pending.length === 0) return;

    for (const task of pending) {
      const dispatched = await this.dispatchOne(task);
      if (!dispatched) break; // 无可用资源，停止
    }
  }

  private async dispatchOne(task: Task): Promise<boolean> {
    // 状态转为 dispatching
    try {
      this.taskQueue.transition(task.taskId, 'dispatching');
    } catch {
      return false;
    }

    // 选择候选 Agent
    let candidate = task.agentId
      ? this.resourcePool.get(task.agentId)
      : undefined;

    // If the pinned agent is offline or at capacity, fall back to selectCandidate
    if (candidate && (candidate.status === 'offline' || candidate.activeTasks >= candidate.maxConcurrency)) {
      candidate = undefined;
    }

    if (!candidate) {
      candidate = this.resourcePool.selectCandidate({
        tier: task.targetTier,
        maxGlobalAcpConcurrency: this.config.maxGlobalAcpConcurrency,
      });
    }

    if (!candidate || candidate.status === 'offline') {
      // 无可用 Agent，回退到 queued
      this.taskQueue.transition(task.taskId, 'queued', 'no_available_agent');
      return false;
    }

    // 规则引擎校验
    const decision = await this.ruleEngine.evaluate(task, candidate, {
      parentAgentId: task.metadata?.parentAgentId as string | undefined,
      declaredTaskType: task.metadata?.taskType as string | undefined,
    });

    if (!decision.allowed) {
      // 被规则阻断，回退到 queued
      this.taskQueue.transition(task.taskId, 'queued', decision.reason);
      return true; // 继续尝试下一个任务
    }

    // 派发
    task.agentId = candidate.agentId;
    this.resourcePool.markBusy(candidate.agentId);
    this.taskQueue.transition(task.taskId, 'running');

    // 通过 HostAdapter 实际执行
    if (this.hostAdapter) {
      try {
        await this.hostAdapter.spawnTask(candidate.agentId, task.prompt, {
          timeoutSeconds: task.timeoutSeconds,
          label: task.label,
        });
      } catch (err) {
        // 派发失败
        this.resourcePool.markTaskCompleted(candidate.agentId, false);
        this.taskQueue.transition(task.taskId, 'failed', `spawn_error: ${(err as Error).message}`);
        return true;
      }
    }

    this.eventBus.emit('dispatch:completed', {
      taskId: task.taskId,
      agentId: candidate.agentId,
      tier: candidate.tier,
    }).catch(() => {});

    return true;
  }

  /**
   * 处理任务完成事件
   */
  async handleTaskComplete(
    taskId: string,
    success: boolean,
    outputTokens?: number,
    filesExist?: boolean,
  ): Promise<void> {
    const task = this.taskQueue.get(taskId);
    if (!task || task.status !== 'running') return;

    if (success) {
      // FR-A04: 实质成功校验
      const substantive = this.taskQueue.validateSubstantiveSuccess(taskId, outputTokens, filesExist);
      if (!substantive) {
        success = false;
        task.failureReason = 'substantive_failure';
      }
    }

    if (success) {
      this.taskQueue.transition(taskId, 'succeeded');
      if (task.agentId) {
        this.resourcePool.markTaskCompleted(task.agentId, true);
      }
    } else {
      this.taskQueue.transition(taskId, 'failed', task.failureReason ?? 'execution_failed');
      if (task.agentId) {
        this.resourcePool.markTaskCompleted(task.agentId, false);

        // FR-B05: 熔断检测
        if (this.resourcePool.checkCircuitBreak(task.agentId, this.config.circuitBreakThreshold)) {
          this.resourcePool.triggerCircuitBreak(task.agentId);
        }
      }

      // FR-C03: 失败梯队升级
      await this.handleFailureRetry(task);
    }

    // 触发队列消费（可能有等待的任务）— 异步触发避免阻塞当前流程
    setTimeout(() => { this.tryDispatch(); }, 0);
  }

  /**
   * FR-C03: 失败后梯队升级重试
   */
  private async handleFailureRetry(task: Task): Promise<void> {
    if (task.retryCount >= task.maxRetries) return;

    const currentTier = task.targetTier ?? 'T4';
    const upgradedTier = this.resourcePool.getUpgradedTier(currentTier);

    if (!upgradedTier) return; // 已在最高梯队

    task.targetTier = upgradedTier;
    // Clear agentId so the retrying task gets routed to the new tier
    task.agentId = undefined;
    this.taskQueue.transition(task.taskId, 'retrying');

    this.eventBus.emit('audit', {
      eventId: '',
      type: 'tier_upgrade' as const,
      timestamp: Date.now(),
      taskId: task.taskId,
      details: { from: currentTier, to: upgradedTier, retryCount: task.retryCount },
    }).catch(() => {});
  }

  /**
   * FR-A03: 处理超时
   */
  async handleTimeout(taskId: string): Promise<void> {
    const task = this.taskQueue.get(taskId);
    if (!task || task.status !== 'running') return;

    await this.handleTaskComplete(taskId, false);
    task.failureReason = 'timeout';
  }

  /**
   * FR-A05: 取消任务
   */
  cancelTask(taskId: string): Task {
    const task = this.taskQueue.cancel(taskId);
    if (task.agentId) {
      this.resourcePool.markTaskCompleted(task.agentId, false);
      if (this.hostAdapter) {
        // best-effort kill
        this.hostAdapter.killTask(taskId).catch(() => {});
      }
    }
    return task;
  }
}
