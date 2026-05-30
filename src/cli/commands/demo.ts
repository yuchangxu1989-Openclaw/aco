/**
 * demo 命令 — 演示 ACO 完整调度生命周期
 * FR-K12: Demo 命令开箱即用
 *
 * 6 阶段演示流程：
 * 1. pool init — 注册 Agent 资源池
 * 2. task submit — 提交任务
 * 3. rule block — 规则拦截
 * 4. dispatch — 智能派发
 * 5. failure+retry — 失败重派
 * 6. completion stats — 完成统计
 *
 * 零副作用：不写文件、不读真实配置、不修改系统状态
 * 不依赖外部 LLM/网络/文件系统
 */

import { DemoAdapter } from '../../demo/demo-adapter.js';
import { DEFAULT_DEMO_SCENARIO } from '../../demo/demo-scenarios.js';
import { DemoRenderer } from '../../demo/demo-renderer.js';
import type { DemoTask } from '../../demo/demo-scenarios.js';

const SUBSTANTIVE_TOKEN_THRESHOLD = 3000;

/** 模拟短延迟，增加演示真实感 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function demoCommand(argv: string[]): Promise<number> {
  const verbose = argv.includes('--verbose');
  const noColor = argv.includes('--no-color');

  if (argv.includes('--help')) {
    console.log(`aco demo — 演示 ACO 完整调度生命周期

Usage: aco demo [options]

Options:
  --verbose    显示详细调度决策日志
  --no-color   禁用颜色输出

演示 6 个阶段：资源池初始化 → 任务提交 → 规则拦截 → 智能派发 → 失败重派 → 完成统计
不依赖外部 LLM provider 或在线服务，零副作用。`);
    return 0;
  }

  const scenario = DEFAULT_DEMO_SCENARIO;
  const renderer = new DemoRenderer({ verbose, noColor });
  const adapter = new DemoAdapter();
  const startTime = Date.now();

  // 跟踪派发状态
  const dispatched = new Map<string, { agentId: string; startTime: number }>();
  const taskDurations = new Map<string, number>();
  let totalRetries = 0;

  renderer.header();

  // ═══════════════════════════════════════════
  // Phase 1: 初始化资源池
  // ═══════════════════════════════════════════
  renderer.phase(1, '初始化资源池');
  for (const agent of scenario.agents) {
    renderer.agentRegistered(agent);
    await delay(80);
  }
  console.log('');

  // ═══════════════════════════════════════════
  // Phase 2: 提交任务
  // ═══════════════════════════════════════════
  renderer.phase(2, '提交任务');
  for (const task of scenario.tasks) {
    renderer.taskSubmitted(task);
    // 预设失败行为
    if (task.willFail) {
      adapter.presetBehavior(task.taskId, {
        willFail: true,
        outputTokens: task.failTokens ?? 500,
        durationMs: 200,
      });
    } else {
      adapter.presetBehavior(task.taskId, {
        willFail: false,
        outputTokens: 8000,
        durationMs: 150,
      });
    }
    await delay(60);
  }
  console.log('');

  // ═══════════════════════════════════════════
  // Phase 3: 规则拦截演示
  // ═══════════════════════════════════════════
  renderer.phase(3, '规则拦截演示');
  renderer.verboseLog(`已加载 ${scenario.rules.length} 条规则`);
  for (const blocked of scenario.blockedTasks) {
    // 模拟规则匹配：检查 label 是否匹配 pattern
    const matchedRule = scenario.rules.find(r => {
      const pattern = r.pattern.replace('*', '');
      return blocked.label.startsWith(pattern);
    });
    if (matchedRule) {
      renderer.verboseLog(`规则 [${matchedRule.id}] 匹配: pattern="${matchedRule.pattern}" vs label="${blocked.label}"`);
    }
    renderer.taskBlocked(blocked);
    await delay(100);
  }
  console.log('');

  // ═══════════════════════════════════════════
  // Phase 4: 智能派发
  // ═══════════════════════════════════════════
  renderer.phase(4, '智能派发');

  // 模拟角色匹配派发
  const agentBusy = new Set<string>();
  for (const task of scenario.tasks) {
    const matchedAgent = scenario.agents.find(
      a => a.roles.includes(task.expectedRole) && !agentBusy.has(a.agentId),
    );

    if (matchedAgent) {
      agentBusy.add(matchedAgent.agentId);
      dispatched.set(task.taskId, { agentId: matchedAgent.agentId, startTime: Date.now() });
      renderer.taskDispatched(task.taskId, matchedAgent.agentId, `角色匹配: ${task.expectedRole}`);
      renderer.verboseLog(`selectCandidate: tier=${matchedAgent.tier}, role=${task.expectedRole}, activeTasks=0/1`);
    } else {
      renderer.taskQueued(task.taskId, '无空闲匹配 Agent，等待释放后派发');
      renderer.verboseLog(`所有 ${task.expectedRole} Agent 已满载`);
    }
    await delay(80);
  }
  console.log('');

  // ═══════════════════════════════════════════
  // Phase 5: 失败重派演示
  // ═══════════════════════════════════════════
  renderer.phase(5, '失败重派演示');

  const failedTask = scenario.tasks.find(t => t.willFail);
  if (failedTask) {
    // 模拟执行失败
    const result = await adapter.executeTask(failedTask.taskId);
    renderer.taskFailed(failedTask, result.outputTokens, SUBSTANTIVE_TOKEN_THRESHOLD);
    await delay(150);

    // 重派
    totalRetries++;
    const dispatchInfo = dispatched.get(failedTask.taskId);
    const retryAgent = dispatchInfo?.agentId ?? scenario.agents[0].agentId;
    renderer.taskRetried(failedTask, retryAgent, 1);
    renderer.verboseLog(`failureReason=substantive_failure, strategy=same_agent_retry`);
    await delay(100);

    // 模拟重试成功
    adapter.presetBehavior(failedTask.taskId, { willFail: false, outputTokens: 8500 });
    const retryResult = await adapter.executeTask(failedTask.taskId);
    renderer.taskRetrySuccess(failedTask, retryResult.outputTokens);
    taskDurations.set(failedTask.taskId, Date.now() - (dispatchInfo?.startTime ?? startTime));
  }
  console.log('');

  // ═══════════════════════════════════════════
  // Phase 6: 完成与统计
  // ═══════════════════════════════════════════
  renderer.phase(6, '完成与统计');

  // 模拟其他任务完成
  for (const task of scenario.tasks) {
    if (task.taskId === failedTask?.taskId) continue;
    await adapter.executeTask(task.taskId);
    const dispatchInfo = dispatched.get(task.taskId);
    const duration = Date.now() - (dispatchInfo?.startTime ?? startTime);
    taskDurations.set(task.taskId, duration);
  }

  // 输出每个任务的完成状态
  for (const task of scenario.tasks) {
    const duration = taskDurations.get(task.taskId) ?? 500;
    const retries = task.willFail ? 1 : 0;
    renderer.taskCompleted(task.taskId, duration, retries);
    await delay(60);
  }

  const totalMs = Date.now() - startTime;
  renderer.summary(scenario, { totalMs, retries: totalRetries });
  renderer.footer(totalMs);

  return 0;
}
