/**
 * FailureTracker — FR-B07: 失败根因追踪
 *
 * AC1: 结构化失败记录
 * AC2: agent-fault vs task-fault 二分判定
 * AC3: 自动生成修复建议
 * AC6: 与熔断机制联动
 */

import { v4 as uuid } from 'uuid';
import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EventBus } from '../event/event-bus.js';
import type {
  AuditEvent,
  FailureMode,
  FailureRecord,
  FailureTrackerConfig,
  FaultType,
  RepairAction,
  Task,
} from '../types/index.js';
import { DEFAULT_FAILURE_TRACKER_CONFIG } from '../types/index.js';

export interface RecordFailureInput {
  task: Task;
  agentId: string;
  taskType: string;
  failureMode: FailureMode;
  durationMs: number;
  outputTokens: number;
}

export class FailureTracker {
  private config: FailureTrackerConfig;
  private records: FailureRecord[] = [];
  private initialized = false;

  constructor(
    private eventBus: EventBus,
    config?: Partial<FailureTrackerConfig>,
  ) {
    this.config = { ...DEFAULT_FAILURE_TRACKER_CONFIG, ...config };
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(config: Partial<FailureTrackerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): FailureTrackerConfig {
    return { ...this.config };
  }

  /**
   * FR-B07 AC1: Record a structured failure event
   */
  async recordFailure(input: RecordFailureInput): Promise<FailureRecord> {
    const { task, agentId, taskType, failureMode, durationMs, outputTokens } = input;

    // FR-B07 AC1: Structured failure fields
    const record: FailureRecord = {
      failureId: uuid(),
      agentId,
      taskId: task.taskId,
      taskType,
      failureMode,
      promptSummary: task.prompt.slice(0, 200),
      durationMs,
      outputTokens,
      faultType: undefined,
      repairSuggestions: [],
      timestamp: Date.now(),
    };

    // FR-B07 AC2: Root cause classification
    record.faultType = await this.classifyFault(record);

    // FR-B07 AC3: Generate repair suggestions
    record.repairSuggestions = this.generateRepairSuggestions(record);

    // Store in memory
    this.records.push(record);
    if (this.records.length > 10000) {
      this.records = this.records.slice(-5000);
    }

    // Persist to file
    await this.persistRecord(record);

    // Emit audit event
    this.emitAudit('failure_tracked', {
      failureId: record.failureId,
      agentId: record.agentId,
      taskId: record.taskId,
      taskType: record.taskType,
      failureMode: record.failureMode,
      faultType: record.faultType,
      repairSuggestions: record.repairSuggestions,
    });

    // FR-B07 AC6: Emit event for circuit breaker integration
    this.eventBus.emit('failure:recorded', record).catch(() => {});

    return record;
  }

  /**
   * FR-B07 AC2: Classify fault type
   *
   * agent-fault: Agent capability issue or state anomaly
   * task-fault: Task description unclear, too large, or missing dependencies
   *
   * Heuristic classification based on failure patterns:
   * - Same task succeeded with different agent → agent-fault
   * - Same agent fails on this task type but succeeds on others → task-fault
   * - Zero output / crash → likely agent-fault
   * - Timeout with large prompt → likely task-fault (too complex)
   * - No file written with short duration → likely agent-fault
   */
  private async classifyFault(record: FailureRecord): Promise<FaultType> {
    const agentRecords = this.records.filter(r => r.agentId === record.agentId);
    const taskTypeRecords = this.records.filter(r => r.taskType === record.taskType);

    // Check if same task type fails with other agents too
    const otherAgentFailures = taskTypeRecords.filter(
      r => r.agentId !== record.agentId,
    );
    const taskTypeFailsWithOthers = otherAgentFailures.length > 0;

    // Heuristic rules
    switch (record.failureMode) {
      case 'zero-output':
      case 'crash':
        // Zero output or crash is typically agent-fault
        return 'agent-fault';

      case 'timeout':
        // Timeout with long prompt suggests task is too complex
        if (record.promptSummary.length >= 180) return 'task-fault';
        // Timeout with short prompt suggests agent issue
        return taskTypeFailsWithOthers ? 'task-fault' : 'agent-fault';

      case 'no-file-written':
        // Short duration + no file = agent didn't try
        if (record.durationMs < 30_000) return 'agent-fault';
        // Long duration + no file = task might be unclear
        return 'task-fault';

      case 'error-output':
        // If other agents also fail on this type, it's task-fault
        if (taskTypeFailsWithOthers) return 'task-fault';
        return 'agent-fault';

      default:
        return 'agent-fault';
    }
  }

  /**
   * FR-B07 AC3: Generate repair suggestions based on fault classification
   */
  private generateRepairSuggestions(record: FailureRecord): RepairAction[] {
    const suggestions: RepairAction[] = [];

    if (record.faultType === 'agent-fault') {
      // Agent issue: try different agent or upgrade tier
      suggestions.push('switch-agent');
      suggestions.push('upgrade-tier');
    } else {
      // Task issue: split or add context
      suggestions.push('split-task');
      suggestions.push('add-context');
    }

    // Additional heuristics
    if (record.failureMode === 'timeout' && record.faultType === 'task-fault') {
      // Timeout + task-fault: definitely split
      if (!suggestions.includes('split-task')) {
        suggestions.unshift('split-task');
      }
    }

    if (record.failureMode === 'zero-output') {
      // Zero output: agent is broken, switch first
      if (!suggestions.includes('switch-agent')) {
        suggestions.unshift('switch-agent');
      }
    }

    return suggestions;
  }

  /**
   * Get all failure records (optionally filtered)
   */
  getRecords(filter?: {
    agentId?: string;
    taskType?: string;
    failureMode?: FailureMode;
    since?: number;
    until?: number;
  }): FailureRecord[] {
    let results = [...this.records];

    if (filter?.agentId) {
      results = results.filter(r => r.agentId === filter.agentId);
    }
    if (filter?.taskType) {
      results = results.filter(r => r.taskType === filter.taskType);
    }
    if (filter?.failureMode) {
      results = results.filter(r => r.failureMode === filter.failureMode);
    }
    if (filter?.since) {
      results = results.filter(r => r.timestamp >= filter.since!);
    }
    if (filter?.until) {
      results = results.filter(r => r.timestamp <= filter.until!);
    }

    return results;
  }

  /**
   * FR-B07 AC4: Check if an agent's failure rate for a task type exceeds threshold
   *
   * Rate-based: failureCount / totalAttempts >= failureRateThreshold
   * Requires totalAttempts from external source (e.g. audit query) since
   * the tracker only stores failure records.
   */
  isRoutingDegraded(agentId: string, taskType: string, totalAttempts: number): boolean {
    const relevant = this.records.filter(
      r => r.agentId === agentId && r.taskType === taskType,
    );
    // Need minimum sample size to avoid false positives on small samples
    if (totalAttempts < 3) return false;
    const failureRate = relevant.length / totalAttempts;
    return failureRate >= this.config.failureRateThreshold;
  }

  /**
   * FR-B07 AC6: Generate root cause analysis report for circuit breaker
   */
  generateCircuitBreakReport(agentId: string): {
    agentId: string;
    recentFailures: FailureRecord[];
    dominantFailureMode: FailureMode | null;
    dominantFaultType: FaultType | null;
    suggestedRecovery: RepairAction[];
  } {
    const recentFailures = this.records
      .filter(r => r.agentId === agentId)
      .slice(-10);

    if (recentFailures.length === 0) {
      return {
        agentId,
        recentFailures: [],
        dominantFailureMode: null,
        dominantFaultType: null,
        suggestedRecovery: [],
      };
    }

    // Find dominant failure mode
    const modeCounts = new Map<FailureMode, number>();
    const faultCounts = new Map<FaultType, number>();

    for (const r of recentFailures) {
      modeCounts.set(r.failureMode, (modeCounts.get(r.failureMode) ?? 0) + 1);
      if (r.faultType) {
        faultCounts.set(r.faultType, (faultCounts.get(r.faultType) ?? 0) + 1);
      }
    }

    let dominantFailureMode: FailureMode | null = null;
    let maxModeCount = 0;
    for (const [mode, count] of modeCounts) {
      if (count > maxModeCount) {
        maxModeCount = count;
        dominantFailureMode = mode;
      }
    }

    let dominantFaultType: FaultType | null = null;
    let maxFaultCount = 0;
    for (const [fault, count] of faultCounts) {
      if (count > maxFaultCount) {
        maxFaultCount = count;
        dominantFaultType = fault;
      }
    }

    // Aggregate suggestions
    const suggestionSet = new Set<RepairAction>();
    for (const r of recentFailures) {
      for (const s of r.repairSuggestions) {
        suggestionSet.add(s);
      }
    }

    return {
      agentId,
      recentFailures,
      dominantFailureMode,
      dominantFaultType,
      suggestedRecovery: Array.from(suggestionSet),
    };
  }

  /**
   * Load persisted records from file
   */
  async loadFromFile(): Promise<void> {
    try {
      const content = await readFile(this.config.dataFilePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      this.records = lines.map(line => {
        try {
          return JSON.parse(line) as FailureRecord;
        } catch {
          return null;
        }
      }).filter((r): r is FailureRecord => r !== null);
    } catch {
      // File doesn't exist yet, start fresh
      this.records = [];
    }
  }

  /**
   * Persist a single record to file (append)
   */
  private async persistRecord(record: FailureRecord): Promise<void> {
    try {
      if (!this.initialized) {
        await mkdir(dirname(this.config.dataFilePath), { recursive: true });
        this.initialized = true;
      }
      const line = JSON.stringify(record) + '\n';
      await appendFile(this.config.dataFilePath, line, 'utf-8');
    } catch {
      // Silently fail on persistence errors — in-memory records still available
    }
  }

  private emitAudit(type: AuditEvent['type'], details: Record<string, unknown>): void {
    const event: AuditEvent = {
      eventId: uuid(),
      type,
      timestamp: Date.now(),
      taskId: details.taskId as string | undefined,
      agentId: details.agentId as string | undefined,
      details,
    };
    this.eventBus.emit('audit', event).catch(() => {});
  }
}
