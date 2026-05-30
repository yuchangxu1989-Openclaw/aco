/**
 * BoardRenderer - 任务看板渲染
 * FR-E02: 任务看板
 */

import type { Task, TaskStatus } from '../types/index.js';

export interface BoardFilter {
  status?: TaskStatus | TaskStatus[];
  agentId?: string;
  priority?: number;
}

export type BoardOutputFormat = 'table' | 'json';

export interface BoardOptions {
  filter?: BoardFilter;
  format?: BoardOutputFormat;
  watch?: boolean;
  intervalMs?: number;
}

export interface BoardRow {
  taskId: string;
  label: string;
  status: TaskStatus;
  agentId: string;
  runningTime: string;
  priority: number;
}

/**
 * FR-E02 AC3: 看板数据基于内存状态实时生成
 */
export class BoardRenderer {
  private watchTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * FR-E02 AC1: 展示当前所有非终态任务的状态、agentId、已运行时长、优先级
   * FR-E02 AC2: 支持按状态、agentId、priority 筛选
   */
  render(tasks: Task[], options: BoardOptions = {}): string {
    const filtered = this.applyFilter(tasks, options.filter);
    const format = options.format ?? 'table';

    if (format === 'json') {
      return this.renderJson(filtered);
    }
    return this.renderTable(filtered);
  }

  /**
   * FR-E02 AC2: 筛选逻辑
   */
  applyFilter(tasks: Task[], filter?: BoardFilter): Task[] {
    // FR-E02 AC1: 默认只展示非终态任务
    let result = tasks.filter(t => !['succeeded', 'cancelled'].includes(t.status));

    if (!filter) return result;

    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      result = result.filter(t => statuses.includes(t.status));
    }

    if (filter.agentId) {
      result = result.filter(t => t.agentId === filter.agentId);
    }

    if (filter.priority !== undefined) {
      result = result.filter(t => t.priority >= filter.priority!);
    }

    return result;
  }

  /**
   * FR-E02 AC4: table 格式输出
   */
  renderTable(tasks: Task[]): string {
    if (tasks.length === 0) {
      return 'No active tasks.';
    }

    const rows = tasks.map(t => this.toRow(t));

    // Column widths
    const headers = ['TASK ID', 'LABEL', 'STATUS', 'AGENT', 'RUNNING', 'PRI'];
    const colWidths = [
      Math.max(headers[0].length, ...rows.map(r => r.taskId.length)),
      Math.max(headers[1].length, ...rows.map(r => r.label.length)),
      Math.max(headers[2].length, ...rows.map(r => r.status.length)),
      Math.max(headers[3].length, ...rows.map(r => r.agentId.length)),
      Math.max(headers[4].length, ...rows.map(r => r.runningTime.length)),
      Math.max(headers[5].length, ...rows.map(r => String(r.priority).length)),
    ];

    const pad = (s: string, w: number) => s.padEnd(w);
    const sep = colWidths.map(w => '─'.repeat(w)).join('──');

    const lines: string[] = [];
    lines.push(
      headers.map((h, i) => pad(h, colWidths[i])).join('  ')
    );
    lines.push(sep);

    for (const row of rows) {
      lines.push([
        pad(row.taskId, colWidths[0]),
        pad(row.label, colWidths[1]),
        pad(row.status, colWidths[2]),
        pad(row.agentId, colWidths[3]),
        pad(row.runningTime, colWidths[4]),
        pad(String(row.priority), colWidths[5]),
      ].join('  '));
    }

    lines.push('');
    lines.push(`Total: ${tasks.length} active task(s)`);

    return lines.join('\n');
  }

  /**
   * FR-E02 AC4: JSON 格式输出
   */
  renderJson(tasks: Task[]): string {
    const rows = tasks.map(t => this.toRow(t));
    return JSON.stringify(rows, null, 2);
  }

  /**
   * FR-E02 AC5: watch 模式，每 intervalMs 刷新一次
   */
  startWatch(
    getActiveTasks: () => Task[],
    options: BoardOptions,
    output: (content: string) => void,
  ): void {
    const intervalMs = options.intervalMs ?? 5000;

    // Initial render
    const render = () => {
      const tasks = getActiveTasks();
      const content = this.render(tasks, options);
      output(content);
    };

    render();
    this.watchTimer = setInterval(render, intervalMs);
  }

  stopWatch(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  isWatching(): boolean {
    return this.watchTimer !== null;
  }

  private toRow(task: Task): BoardRow {
    return {
      taskId: task.taskId,
      label: task.label,
      status: task.status,
      agentId: task.agentId ?? '-',
      runningTime: this.formatDuration(task),
      priority: task.priority,
    };
  }

  private formatDuration(task: Task): string {
    if (task.status !== 'running') return '-';
    const elapsed = Date.now() - task.updatedAt;
    return this.msToHuman(elapsed);
  }

  private msToHuman(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainSec = seconds % 60;
    if (minutes < 60) return `${minutes}m${remainSec}s`;
    const hours = Math.floor(minutes / 60);
    const remainMin = minutes % 60;
    return `${hours}h${remainMin}m`;
  }
}
