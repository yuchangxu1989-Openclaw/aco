/**
 * ChainExecutor — 域 D：自动推进链运行时引擎
 * FR-D01: 链式触发
 * FR-D02: 条件触发
 * FR-D03: 失败分支
 * FR-D04: 链路可视化
 */

import { v4 as uuid } from 'uuid';
import { EventBus } from '../event/event-bus.js';
import type {
  AuditEvent,
  ChainCondition,
  ChainStep,
  CompletionChainDef,
  Task,
  Tier,
} from '../types/index.js';

// --- Chain Execution Types ---

export type ChainNodeStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface ChainNode {
  nodeId: string;
  stepIndex: number;
  label: string;
  status: ChainNodeStatus;
  agentId?: string;
  taskId?: string;
  startedAt?: number;
  completedAt?: number;
  outputSummary?: string;
  failureReason?: string;
  loopCount: number;
}

export interface ChainExecution {
  executionId: string;
  chainDef: CompletionChainDef;
  parentTaskId: string;
  parentOutput?: TaskOutput;
  status: 'running' | 'paused' | 'succeeded' | 'failed';
  nodes: ChainNode[];
  currentNodeIndex: number;
  createdAt: number;
  completedAt?: number;
}

export interface TaskOutput {
  summary?: string;
  files?: string[];
  tokens?: number;
  data?: Record<string, unknown>;
}

export interface ChainTaskRequest {
  label: string;
  prompt: string;
  agentId?: string;
  targetTier?: Tier;
  timeoutSeconds?: number;
  priority?: number;
  chainExecutionId: string;
  nodeId: string;
}

export interface ChainExecutorConfig {
  defaultMaxLoopCount: number;
  defaultTimeout: number;
  defaultPriority: number;
}

const DEFAULT_CHAIN_CONFIG: ChainExecutorConfig = {
  defaultMaxLoopCount: 3,
  defaultTimeout: 600,
  defaultPriority: 50,
};

/**
 * ChainExecutor: 按链定义顺序执行任务，处理步骤间依赖
 * 支持链的启动、暂停、恢复
 * 步骤失败时的重试/跳过策略
 */
export class ChainExecutor {
  private executions = new Map<string, ChainExecution>();
  private config: ChainExecutorConfig;

  constructor(
    private eventBus: EventBus,
    config?: Partial<ChainExecutorConfig>,
  ) {
    this.config = { ...DEFAULT_CHAIN_CONFIG, ...config };
  }

  /**
   * FR-D01 AC1/AC4: 启动链式执行
   * 父任务完成后调用，创建执行实例并触发第一个步骤
   */
  start(
    chainDef: CompletionChainDef,
    parentTask: Task,
    parentOutput: TaskOutput,
    branch: 'onSuccess' | 'onFailure' = 'onSuccess',
  ): ChainExecution | undefined {
    const steps = branch === 'onSuccess' ? chainDef.onSuccess : chainDef.onFailure;
    if (!steps || steps.length === 0) return undefined;

    const executionId = uuid();
    const nodes: ChainNode[] = steps.map((step, i) => ({
      nodeId: uuid(),
      stepIndex: i,
      label: step.label,
      status: 'pending' as ChainNodeStatus,
      loopCount: 0,
    }));

    const execution: ChainExecution = {
      executionId,
      chainDef,
      parentTaskId: parentTask.taskId,
      parentOutput,
      status: 'running',
      nodes,
      currentNodeIndex: 0,
      createdAt: Date.now(),
    };

    this.executions.set(executionId, execution);

    this.emitAudit('chain_triggered', {
      executionId,
      parentTaskId: parentTask.taskId,
      branch,
      totalSteps: steps.length,
    });

    return execution;
  }

  /**
   * 获取当前步骤需要创建的任务请求
   * FR-D01 AC2: prompt 可引用父任务产出
   * FR-D02 AC1-AC4: 条件评估
   */
  getNextTaskRequest(executionId: string): ChainTaskRequest | null {
    const execution = this.executions.get(executionId);
    if (!execution || execution.status !== 'running') return null;

    const idx = execution.currentNodeIndex;
    if (idx >= execution.nodes.length) {
      // All steps done
      execution.status = 'succeeded';
      execution.completedAt = Date.now();
      return null;
    }

    const steps = execution.chainDef.onSuccess ?? execution.chainDef.onFailure ?? [];
    const step = steps[idx];
    const node = execution.nodes[idx];

    if (!step) return null;

    // FR-D02: 条件评估
    if (step.condition) {
      const conditionMet = this.evaluateCondition(step.condition, execution.parentOutput);
      if (!conditionMet) {
        // FR-D02 AC3: 条件不满足，跳过
        node.status = 'skipped';
        node.completedAt = Date.now();
        this.emitAudit('chain_triggered', {
          executionId,
          nodeId: node.nodeId,
          action: 'skipped',
          reason: 'condition_not_met',
        });
        execution.currentNodeIndex++;
        return this.getNextTaskRequest(executionId);
      }
    }

    // FR-D01 AC2: 模板变量替换
    const prompt = this.resolveTemplate(step.promptTemplate, execution.parentOutput);

    node.status = 'running';
    node.startedAt = Date.now();

    return {
      label: step.label,
      prompt,
      agentId: step.agentId,
      targetTier: step.targetTier as Tier | undefined,
      timeoutSeconds: step.timeoutSeconds ?? this.config.defaultTimeout,
      priority: step.priority ?? this.config.defaultPriority,
      chainExecutionId: executionId,
      nodeId: node.nodeId,
    };
  }

  /**
   * 报告步骤完成
   * FR-D01 AC5: 支持条件循环链
   */
  reportStepCompleted(
    executionId: string,
    nodeId: string,
    success: boolean,
    output?: TaskOutput,
  ): { next: 'advance' | 'loop' | 'failure_branch' | 'done' } {
    const execution = this.executions.get(executionId);
    if (!execution) return { next: 'done' };

    const node = execution.nodes.find(n => n.nodeId === nodeId);
    if (!node) return { next: 'done' };

    const steps = execution.chainDef.onSuccess ?? execution.chainDef.onFailure ?? [];
    const step = steps[node.stepIndex];

    if (success) {
      node.status = 'succeeded';
      node.completedAt = Date.now();
      node.outputSummary = output?.summary;

      // FR-D01 AC5: 循环链检测 — 产出结论为负面时循环
      if (step?.maxLoopCount && output?.data?.conclusion === 'negative') {
        node.loopCount++;
        if (node.loopCount < (step.maxLoopCount ?? this.config.defaultMaxLoopCount)) {
          // Reset node for loop
          node.status = 'pending';
          node.startedAt = undefined;
          node.completedAt = undefined;
          // Update parent output for next iteration
          execution.parentOutput = output;
          return { next: 'loop' };
        }
      }

      // Advance to next step
      execution.currentNodeIndex++;
      // Update parent output for next step
      if (output) execution.parentOutput = output;

      if (execution.currentNodeIndex >= execution.nodes.length) {
        execution.status = 'succeeded';
        execution.completedAt = Date.now();
        return { next: 'done' };
      }

      return { next: 'advance' };
    } else {
      // Task execution failed
      node.status = 'failed';
      node.completedAt = Date.now();
      node.failureReason = output?.data?.reason as string | undefined;

      // FR-D03 AC4: 检查是否有 onFailure 分支
      if (execution.chainDef.onFailure && execution.chainDef.onFailure.length > 0) {
        return { next: 'failure_branch' };
      }

      // No failure branch — mark execution as failed
      execution.status = 'failed';
      execution.completedAt = Date.now();
      return { next: 'done' };
    }
  }

  /**
   * 暂停链执行
   */
  pause(executionId: string): boolean {
    const execution = this.executions.get(executionId);
    if (!execution || execution.status !== 'running') return false;
    execution.status = 'paused';
    return true;
  }

  /**
   * 恢复链执行
   */
  resume(executionId: string): boolean {
    const execution = this.executions.get(executionId);
    if (!execution || execution.status !== 'paused') return false;
    execution.status = 'running';
    return true;
  }

  /**
   * FR-D04 AC1/AC2: 获取链路状态
   */
  getStatus(executionId: string): ChainExecution | undefined {
    return this.executions.get(executionId);
  }

  /**
   * 获取所有执行实例
   */
  getAllExecutions(): ChainExecution[] {
    return Array.from(this.executions.values());
  }

  /**
   * FR-D04 AC3: 获取历史已完成的执行记录
   */
  getCompletedExecutions(): ChainExecution[] {
    return Array.from(this.executions.values()).filter(
      e => e.status === 'succeeded' || e.status === 'failed',
    );
  }

  /**
   * FR-D02 AC1-AC3: 条件评估
   * 支持基础比较和逻辑组合
   */
  evaluateCondition(condition: ChainCondition, output?: TaskOutput): boolean {
    if (!output?.data) return false;

    const fieldValue = this.getNestedValue(output.data, condition.field);

    // Handle logical operators
    if (condition.logic === 'NOT') {
      return !this.compareValues(fieldValue, condition.operator, condition.value);
    }

    if (condition.children && condition.children.length > 0) {
      if (condition.logic === 'OR') {
        return condition.children.some(c => this.evaluateCondition(c, output));
      }
      // Default AND
      return condition.children.every(c => this.evaluateCondition(c, output));
    }

    return this.compareValues(fieldValue, condition.operator, condition.value);
  }

  /**
   * FR-D01 AC2: 模板变量替换
   * 支持 {{parent.output}}, {{parent.files}}, {{parent.summary}}
   */
  private resolveTemplate(template: string, parentOutput?: TaskOutput): string {
    if (!parentOutput) return template;

    return template
      .replace(/\{\{parent\.output\}\}/g, parentOutput.summary ?? '')
      .replace(/\{\{parent\.summary\}\}/g, parentOutput.summary ?? '')
      .replace(/\{\{parent\.files\}\}/g, (parentOutput.files ?? []).join(', '))
      .replace(/\{\{parent\.tokens\}\}/g, String(parentOutput.tokens ?? 0))
      .replace(/\{\{parent\.data\.(\w+)\}\}/g, (_match, key) => {
        return String(parentOutput.data?.[key] ?? '');
      });
  }

  private compareValues(
    actual: unknown,
    operator: ChainCondition['operator'],
    expected: string | number | boolean,
  ): boolean {
    switch (operator) {
      case '==': return actual == expected;
      case '!=': return actual != expected;
      case '>': return Number(actual) > Number(expected);
      case '<': return Number(actual) < Number(expected);
      case '>=': return Number(actual) >= Number(expected);
      case '<=': return Number(actual) <= Number(expected);
      default: return false;
    }
  }

  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  private emitAudit(type: AuditEvent['type'], details: Record<string, unknown>): void {
    const event: AuditEvent = {
      eventId: uuid(),
      type,
      timestamp: Date.now(),
      details,
    };
    this.eventBus.emit('audit', event).catch(() => {});
  }
}
