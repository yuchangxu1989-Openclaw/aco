/**
 * ChainVisualizer — FR-D04: 链路可视化
 *
 * AC1: CLI 命令展示链路中每个节点的状态
 * AC2: 输出包含每个节点的执行时间、agentId、产出摘要
 * AC3: 支持查看历史已完成的 chain 执行记录
 * AC4: 输出格式支持 tree（终端友好）和 JSON（程序消费）
 */

import type { ChainExecution, ChainNode, ChainNodeStatus } from './chain-executor.js';
import { ChainExecutor } from './chain-executor.js';

// --- Types ---

/** 链路执行摘要（用于 CLI 展示） */
export interface ChainExecutionView {
  executionId: string;
  chainName: string;
  parentTaskId: string;
  status: 'running' | 'paused' | 'succeeded' | 'failed';
  totalNodes: number;
  completedNodes: number;
  failedNodes: number;
  skippedNodes: number;
  createdAt: number;
  completedAt?: number;
  durationMs: number;
  nodes: ChainNodeView[];
}

/** 单个节点的展示视图 */
export interface ChainNodeView {
  nodeId: string;
  stepIndex: number;
  label: string;
  status: ChainNodeStatus;
  agentId?: string;
  durationMs?: number;
  outputSummary?: string;
  failureReason?: string;
}

/** 输出格式 */
export type ChainOutputFormat = 'tree' | 'json';

// --- ANSI Colors ---

const COLORS = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
} as const;

/** 节点状态图标和颜色 */
const STATUS_DISPLAY: Record<ChainNodeStatus, { icon: string; color: string }> = {
  succeeded: { icon: '✓', color: COLORS.green },
  running: { icon: '◉', color: COLORS.cyan },
  pending: { icon: '○', color: COLORS.dim },
  failed: { icon: '✗', color: COLORS.red },
  skipped: { icon: '○', color: COLORS.yellow },
};

// --- Class ---

export class ChainVisualizer {
  /** FR-D04 AC3: in-process history cache */
  private historyCache = new Map<string, ChainExecutionView>();

  constructor(private executor: ChainExecutor) {}

  /**
   * AC1+AC2: 获取指定 chain 执行的完整视图
   * 包含每个节点的状态、执行时间、agentId、产出摘要
   */
  getExecutionView(executionId: string): ChainExecutionView | undefined {
    const execution = this.executor.getStatus(executionId);
    if (!execution) {
      // 尝试从历史缓存获取
      return this.historyCache.get(executionId);
    }

    const view = this.buildView(execution);

    // 如果执行已完成，缓存到历史
    if (execution.status === 'succeeded' || execution.status === 'failed') {
      this.historyCache.set(executionId, view);
    }

    return view;
  }

  /**
   * AC3: 获取历史执行记录列表
   * 支持按状态筛选
   */
  listExecutions(filter?: {
    status?: ChainExecution['status'];
    limit?: number;
  }): ChainExecutionView[] {
    // 从 executor 获取所有执行
    const allExecutions = this.executor.getAllExecutions();

    // 同步到历史缓存
    for (const exec of allExecutions) {
      if (exec.status === 'succeeded' || exec.status === 'failed') {
        if (!this.historyCache.has(exec.executionId)) {
          this.historyCache.set(exec.executionId, this.buildView(exec));
        }
      }
    }

    // 合并活跃执行和历史缓存
    const viewMap = new Map<string, ChainExecutionView>();

    // 历史缓存
    for (const [id, view] of this.historyCache) {
      viewMap.set(id, view);
    }

    // 活跃执行（覆盖缓存中的旧状态）
    for (const exec of allExecutions) {
      viewMap.set(exec.executionId, this.buildView(exec));
    }

    let views = Array.from(viewMap.values());

    // 按状态筛选
    if (filter?.status) {
      views = views.filter(v => v.status === filter.status);
    }

    // 按创建时间降序排列
    views.sort((a, b) => b.createdAt - a.createdAt);

    // 限制数量
    if (filter?.limit && filter.limit > 0) {
      views = views.slice(0, filter.limit);
    }

    return views;
  }

  /**
   * AC4: 渲染为 tree 格式（终端友好）
   */
  renderTree(view: ChainExecutionView): string {
    const lines: string[] = [];

    // Header
    const statusColor = this.getStatusColor(view.status);
    lines.push(
      `${COLORS.bold}Chain: ${view.chainName} (${view.executionId})${COLORS.reset} [${statusColor}${view.status}${COLORS.reset}]`,
    );
    lines.push(
      `Duration: ${this.formatDuration(view.durationMs)} | Parent: ${view.parentTaskId}`,
    );

    // Nodes
    const lastIdx = view.nodes.length - 1;
    for (let i = 0; i < view.nodes.length; i++) {
      const node = view.nodes[i];
      const isLast = i === lastIdx;
      const prefix = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';

      const display = STATUS_DISPLAY[node.status];
      const icon = `${display.color}${display.icon}${COLORS.reset}`;
      const agentStr = node.agentId ? ` (${node.agentId})` : '';
      const durationStr = node.durationMs != null ? ` ${this.formatDuration(node.durationMs)}` : '';

      lines.push(`${prefix}${icon} ${node.label}${agentStr}${durationStr}`);

      // Output summary or failure reason
      if (node.outputSummary) {
        lines.push(`${childPrefix}└─ "${node.outputSummary}"`);
      } else if (node.failureReason) {
        lines.push(`${childPrefix}└─ ${COLORS.red}${node.failureReason}${COLORS.reset}`);
      } else if (node.status === 'skipped') {
        lines.push(`${childPrefix}└─ ${COLORS.dim}condition not met${COLORS.reset}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * AC4: 渲染为 JSON 格式（程序消费）
   */
  renderJson(view: ChainExecutionView): string {
    return JSON.stringify(view, null, 2);
  }

  // --- Private methods ---

  private buildView(execution: ChainExecution): ChainExecutionView {
    const now = Date.now();
    const steps = execution.chainDef.onSuccess ?? execution.chainDef.onFailure ?? [];

    const nodes: ChainNodeView[] = execution.nodes.map((node, idx) => ({
      nodeId: node.nodeId,
      stepIndex: node.stepIndex,
      label: node.label,
      status: node.status,
      agentId: node.agentId ?? steps[idx]?.agentId,
      durationMs: this.computeNodeDuration(node, now),
      outputSummary: node.outputSummary,
      failureReason: node.failureReason,
    }));

    const completedNodes = nodes.filter(n => n.status === 'succeeded').length;
    const failedNodes = nodes.filter(n => n.status === 'failed').length;
    const skippedNodes = nodes.filter(n => n.status === 'skipped').length;

    const durationMs = execution.completedAt
      ? execution.completedAt - execution.createdAt
      : now - execution.createdAt;

    // Derive chain name from the first step label or chainDef.chainId
    const chainName = execution.chainDef.chainId
      ?? execution.nodes[0]?.label
      ?? 'unnamed-chain';

    return {
      executionId: execution.executionId,
      chainName,
      parentTaskId: execution.parentTaskId,
      status: execution.status,
      totalNodes: nodes.length,
      completedNodes,
      failedNodes,
      skippedNodes,
      createdAt: execution.createdAt,
      completedAt: execution.completedAt,
      durationMs,
      nodes,
    };
  }

  private computeNodeDuration(node: ChainNode, now: number): number | undefined {
    if (!node.startedAt) return undefined;
    const end = node.completedAt ?? now;
    return end - node.startedAt;
  }

  private getStatusColor(status: string): string {
    switch (status) {
      case 'succeeded': return COLORS.green;
      case 'failed': return COLORS.red;
      case 'running': return COLORS.cyan;
      case 'paused': return COLORS.yellow;
      default: return COLORS.dim;
    }
  }

  /**
   * Duration 格式化
   * < 1s → "<1s"；1-60s → "Xs"；1-60m → "Xm Ys"；> 1h → "Xh Ym"
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) return '<1s';
    const totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) {
      return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const remainMinutes = minutes % 60;
    return remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`;
  }
}
