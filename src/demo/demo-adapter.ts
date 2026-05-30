/**
 * DemoAdapter — 内存 mock HostAdapter，不依赖真实 spawn/LLM
 * FR-K12: Demo 命令开箱即用
 */

export interface DemoTaskBehavior {
  taskId: string;
  willFail: boolean;
  outputTokens: number;
  durationMs: number;
  retryCount: number;
}

export class DemoAdapter {
  private behaviors = new Map<string, DemoTaskBehavior>();
  private sessionCounter = 0;

  /**
   * 预设任务行为（模拟成功/失败）
   */
  presetBehavior(taskId: string, behavior: Partial<DemoTaskBehavior>): void {
    const existing = this.behaviors.get(taskId);
    this.behaviors.set(taskId, {
      taskId,
      willFail: behavior.willFail ?? existing?.willFail ?? false,
      outputTokens: behavior.outputTokens ?? existing?.outputTokens ?? 8000,
      durationMs: behavior.durationMs ?? existing?.durationMs ?? 500,
      retryCount: existing?.retryCount ?? 0,
    });
  }

  /**
   * 模拟 spawn — 返回 session key
   */
  async spawnTask(_agentId: string, _prompt: string): Promise<string> {
    return `demo-session-${++this.sessionCounter}`;
  }

  /**
   * 模拟 kill — no-op
   */
  async killTask(_sessionId: string): Promise<void> {}

  /**
   * 模拟执行并返回结果
   */
  async executeTask(taskId: string): Promise<{ success: boolean; outputTokens: number }> {
    const behavior = this.behaviors.get(taskId);
    if (!behavior) {
      return { success: true, outputTokens: 8000 };
    }

    // 模拟延迟
    await this.sleep(behavior.durationMs);

    if (behavior.willFail && behavior.retryCount === 0) {
      behavior.retryCount++;
      return { success: false, outputTokens: behavior.outputTokens };
    }

    return { success: true, outputTokens: behavior.outputTokens > 3000 ? behavior.outputTokens : 8500 };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
