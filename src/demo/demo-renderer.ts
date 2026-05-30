/**
 * DemoRenderer — 终端格式化输出
 * FR-K12: Demo 命令开箱即用
 *
 * 使用 ANSI escape codes 实现颜色输出，不依赖外部库
 */

import type { DemoAgent, DemoBlockedTask, DemoScenario, DemoTask } from './demo-scenarios.js';

// ANSI color codes
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';

export class DemoRenderer {
  private verbose: boolean;
  private noColor: boolean;
  private startTime: number;

  constructor(options: { verbose?: boolean; noColor?: boolean } = {}) {
    this.verbose = options.verbose ?? false;
    this.noColor = options.noColor ?? !process.stdout.isTTY;
    this.startTime = Date.now();
  }

  private c(code: string, text: string): string {
    if (this.noColor) return text;
    return `${code}${text}${RESET}`;
  }

  header(): void {
    console.log('');
    console.log(this.c(BOLD, '🎬 ACO Demo — 完整调度生命周期演示'));
    console.log(this.c(DIM, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log('');
  }

  phase(num: number, title: string): void {
    console.log(this.c(BOLD + CYAN, `[${num}/6] ${title}...`));
  }

  agentRegistered(agent: DemoAgent): void {
    const tierColor = agent.tier === 'T1' ? GREEN : YELLOW;
    console.log(`  ${this.c(GREEN, '✓')} 注册 agent: ${this.c(BOLD, agent.agentId)} ${this.c(tierColor, `(${agent.tier}, ${agent.roles.join('/')})`)}`);
    if (this.verbose) {
      console.log(this.c(DIM, `    maxConcurrency=1, runtimeType=subagent`));
    }
  }

  taskSubmitted(task: DemoTask): void {
    console.log(`  ${this.c(GREEN, '✓')} ${task.taskId}: "${task.description}" ${this.c(DIM, `(priority=${task.priority}, timeout=${task.timeout}s)`)}`);
    if (this.verbose) {
      console.log(this.c(DIM, `    expectedRole=${task.expectedRole}, label=${task.label}`));
    }
  }

  taskBlocked(task: DemoBlockedTask): void {
    console.log(`  ${this.c(RED, '✗')} ${task.taskId}: "${task.description}" → ${this.c(RED, `被规则 [${task.ruleId}] 拦截`)}`);
    console.log(`    ${this.c(DIM, `原因: ${task.blockReason}`)}`);
    if (this.verbose) {
      console.log(this.c(DIM, `    action=block, pattern=${task.label}`));
    }
  }

  taskDispatched(taskId: string, agentId: string, reason: string): void {
    console.log(`  ${this.c(GREEN, '✓')} ${taskId} → ${this.c(BOLD, agentId)} ${this.c(DIM, `(${reason})`)}`);
  }

  taskQueued(taskId: string, reason: string): void {
    console.log(`  ${this.c(YELLOW, '◌')} ${taskId} ${this.c(DIM, `排队等待 (${reason})`)}`);
  }

  taskFailed(task: DemoTask, outputTokens: number, threshold: number): void {
    console.log(`  ${this.c(RED, '✗')} ${task.taskId} 执行失败 ${this.c(DIM, `(模拟: output_tokens=${outputTokens} < threshold=${threshold})`)}`);
    if (this.verbose) {
      console.log(this.c(DIM, `    failureReason=substantive_failure, willRetry=true`));
    }
  }

  taskRetried(task: DemoTask, agentId: string, retryNum: number): void {
    console.log(`  ${this.c(MAGENTA, '↻')} ${task.taskId} 重派 → ${this.c(BOLD, agentId)} ${this.c(DIM, `(retry #${retryNum}, 降级超时 +50%)`)}`);
    if (this.verbose) {
      console.log(this.c(DIM, `    newTimeout=${Math.round(task.timeout * 1.5)}s, tier=T1`));
    }
  }

  taskRetrySuccess(task: DemoTask, outputTokens: number): void {
    console.log(`  ${this.c(GREEN, '✓')} ${task.taskId} 重试成功 ${this.c(DIM, `(output_tokens=${outputTokens})`)}`);
  }

  taskCompleted(taskId: string, durationMs: number, retries: number): void {
    const retryInfo = retries > 0 ? `, 重试 ${retries} 次` : '';
    console.log(`  ${this.c(GREEN, '✓')} ${taskId}: completed ${this.c(DIM, `(耗时 ${(durationMs / 1000).toFixed(1)}s${retryInfo})`)}`);
  }

  summary(scenario: DemoScenario, stats: { totalMs: number; retries: number }): void {
    const total = scenario.tasks.length + scenario.blockedTasks.length;
    const succeeded = scenario.tasks.length;
    const blocked = scenario.blockedTasks.length;
    const avgMs = stats.totalMs / scenario.tasks.length;
    const utilization = Math.round((succeeded / (scenario.agents.length * 1)) * 100);

    console.log('');
    console.log(this.c(DIM, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(this.c(BOLD, '📊 调度统计:'));
    console.log(`  总任务: ${total} | 成功: ${succeeded} | 拦截: ${blocked} | 重试: ${stats.retries}`);
    console.log(`  平均耗时: ${(avgMs / 1000).toFixed(1)}s | 资源利用率: ${utilization}%`);
  }

  footer(totalMs: number): void {
    console.log('');
    console.log(this.c(GREEN + BOLD, `✅ Demo 完成`) + ` ${this.c(DIM, `(总耗时 ${(totalMs / 1000).toFixed(1)}s)`)}`);
    console.log('');
  }

  verboseLog(message: string): void {
    if (this.verbose) {
      console.log(this.c(DIM, `  [verbose] ${message}`));
    }
  }
}
