# FR-K11 测试环境隔离 & FR-K12 Demo 命令开箱即用 · 架构设计

Claude Code（OpenClaw ACP Agent） · 2026-05-29

---

## 1. 现状分析

### 1.1 测试通过状态

当前 479/479 全绿（vitest run，3.48s）。此前报告的 `generateMinimalConfig` schema 漂移已修复。

### 1.2 路径依赖清单

通过 `grep -rn "/root/\|process.env.HOME\|homedir()" src/` 扫描，以下位置存在对宿主环境的硬编码或隐式依赖：

| 文件 | 行号 | 依赖类型 | 影响范围 |
|------|------|----------|----------|
| `src/config/config-schema.ts` | 857-859 | `DEFAULT_KILL_IMPACT_SCAN_CONFIG` 硬编码 `/root/.openclaw/workspace/...` | 默认值被 `generateMinimalConfig()` 引用 |
| `src/control/kill-impact-scan.ts` | 105-112 | 同上，`DEFAULT_KILL_IMPACT_SCAN_CONFIG` 常量 | 运行时 fallback |
| `src/cli/commands/init.ts` | 217 | `'/root/.openclaw/openclaw.json'` 作为 candidate（受 `ACO_DISABLE_ROOT_CONFIG` 控制） | `detectEnvironment()` |
| `src/cli/commands/pool.ts` | 203 | `'/root/.openclaw/openclaw.json'` 作为 fallback 路径 | `poolSync()` |
| `src/generators/async-discipline-guard-plugin.ts` | 66 | `process.env.HOME \|\| '/root'` 作为 fallback | 生成的插件代码 |
| `src/generators/closure-guard-plugin.ts` | 51 | 同上 | 生成的插件代码 |
| `src/cli.js` | 127 | 同 init.ts L217（编译产物） | 旧 JS 入口 |

### 1.3 测试隔离现状

测试已采用的隔离手段（做得好的部分）：

1. **cli.test.ts**：使用 `/tmp/aco-cli-test-*` 临时目录 + `ACO_BOARD_PATH` / `ACO_DATA_DIR` 环境变量覆盖
2. **config-manager.test.ts**：`createMockFs()` 内存文件系统 + `setFileSystem()` 注入
3. **kill-impact-scan.test.ts**：`mkdtempSync` 创建临时 git 仓库，所有路径参数显式传入
4. **scheduler.test.ts**：纯内存 mock adapter，零 I/O

**结论**：测试本身已经做到了良好隔离。路径硬编码存在于 **源码默认值** 中，不影响测试通过（测试通过显式参数覆盖默认值），但影响 `npm ci && npm test` 在干净环境的 **语义正确性**（默认值指向不存在的路径）。

---

## 2. FR-K11：测试环境隔离方案

### 2.1 设计目标

在任意干净 Node.js 环境（无 `/root/.openclaw/`）执行 `npm ci && npm test` 全绿，且默认配置值在语义上合理。

### 2.2 隔离策略

#### 策略 A：动态默认值（推荐）

将硬编码的 `/root/.openclaw/...` 替换为基于 `$HOME` 的动态计算：

```typescript
// src/control/kill-impact-scan.ts & src/config/config-schema.ts
import { homedir } from 'node:os';
import { join } from 'node:path';

function getDefaultOpenclawHome(): string {
  return process.env.OPENCLAW_HOME ?? join(homedir(), '.openclaw');
}

export const DEFAULT_KILL_IMPACT_SCAN_CONFIG: NormalizedKillImpactScanConfig = {
  enabled: true,
  get outputDir() { return join(getDefaultOpenclawHome(), 'workspace', 'logs'); },
  get repoRoot() { return join(getDefaultOpenclawHome(), 'workspace'); },
  get boardPath() { return join(getDefaultOpenclawHome(), 'workspace', 'logs', 'subagent-task-board.json'); },
  highRiskPathPrefixes: ['src/', 'docs/'],
  mediumRiskPathPrefixes: ['reports/', 'logs/'],
  maxFileScan: 1000,
  maxBoardScanBytes: 10 * 1024 * 1024,
  get auditLogPath() { return join(getDefaultOpenclawHome(), 'workspace', 'logs', 'dispatch-guard-events.jsonl'); },
};
```

**问题**：getter 在对象展开时丢失。改用工厂函数更安全：

```typescript
export function getDefaultKillImpactScanConfig(): NormalizedKillImpactScanConfig {
  const home = process.env.OPENCLAW_HOME ?? join(homedir(), '.openclaw');
  return {
    enabled: true,
    outputDir: join(home, 'workspace', 'logs'),
    repoRoot: join(home, 'workspace'),
    boardPath: join(home, 'workspace', 'logs', 'subagent-task-board.json'),
    highRiskPathPrefixes: ['src/', 'docs/'],
    mediumRiskPathPrefixes: ['reports/', 'logs/'],
    maxFileScan: 1000,
    maxBoardScanBytes: 10 * 1024 * 1024,
    auditLogPath: join(home, 'workspace', 'logs', 'dispatch-guard-events.jsonl'),
  };
}

// 保留常量导出以兼容现有引用
export const DEFAULT_KILL_IMPACT_SCAN_CONFIG = getDefaultKillImpactScanConfig();
```

#### 策略 B：消除 `/root/` 硬编码 fallback

| 位置 | 当前 | 改为 |
|------|------|------|
| `init.ts` L217 | `'/root/.openclaw/openclaw.json'` | 删除此 candidate（`ACO_DISABLE_ROOT_CONFIG` 已存在，直接默认不加） |
| `pool.ts` L203 | `'/root/.openclaw/openclaw.json'` | 删除，只保留 `$HOME/.openclaw/openclaw.json` |
| generators L66/L51 | `process.env.HOME \|\| '/root'` | `process.env.HOME \|\| os.homedir()` |

#### 策略 C：`generateMinimalConfig` 对齐

`generateMinimalConfig()` 生成的 JSON 字符串中 `killImpactScan` 的路径应使用占位符或动态值：

```typescript
export function generateMinimalConfig(): string {
  const home = process.env.OPENCLAW_HOME ?? join(homedir(), '.openclaw');
  return JSON.stringify({
    // ...其他字段不变...
    killImpactScan: {
      enabled: true,
      outputDir: join(home, 'workspace', 'logs'),
      repoRoot: join(home, 'workspace'),
      boardPath: join(home, 'workspace', 'logs', 'subagent-task-board.json'),
      // ...
    },
  }, null, 2);
}
```

同步修改 `generateAnnotatedConfig()` 中的注释模板。

### 2.3 环境变量契约

| 变量 | 用途 | 默认值 |
|------|------|--------|
| `OPENCLAW_HOME` | OpenClaw 根目录 | `~/.openclaw` |
| `ACO_DATA_DIR` | ACO 数据目录 | `$CWD/.aco` |
| `ACO_BOARD_PATH` | 看板路径 | `$ACO_DATA_DIR/board.json` |
| `ACO_CONFIG_PATH` | 配置文件路径 | `$CWD/aco.config.json` |
| `ACO_ASYNC_DISCIPLINE_AUDIT_PATH` | 审计日志路径 | `$OPENCLAW_HOME/workspace/logs/dispatch-guard-events.jsonl` |
| `ACO_DISABLE_ROOT_CONFIG` | 禁用 `/root/` fallback | `1`（CI 环境自动设置） |

### 2.4 CI 配置建议

```yaml
# .github/workflows/test.yml
env:
  ACO_DISABLE_ROOT_CONFIG: "1"
  OPENCLAW_HOME: /tmp/aco-test-home/.openclaw

steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with: { node-version: 22 }
  - run: npm ci
  - run: npm test
```

### 2.5 改动清单（按优先级）

| # | 文件 | 改动 | 风险 |
|---|------|------|------|
| 1 | `src/control/kill-impact-scan.ts` | `DEFAULT_KILL_IMPACT_SCAN_CONFIG` 改为工厂函数 | 低：所有调用方已显式传参 |
| 2 | `src/config/config-schema.ts` | `generateMinimalConfig()` 和 `generateAnnotatedConfig()` 使用动态 home | 低：测试已覆盖 |
| 3 | `src/cli/commands/init.ts` L217 | 删除 `/root/.openclaw/openclaw.json` candidate，改为仅 `homedir()` | 低：`OPENCLAW_HOME` 优先级更高 |
| 4 | `src/cli/commands/pool.ts` L203 | 删除 `/root/.openclaw/openclaw.json` fallback | 低 |
| 5 | `src/generators/*.ts` | `/root` fallback 改为 `os.homedir()` | 低：生成代码运行时才用 |
| 6 | `src/cli.js` | 同步 init.ts 改动（或删除此旧入口） | 低 |

### 2.6 测试补充

新增一个集成测试验证隔离：

```typescript
// src/config/config-isolation.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateMinimalConfig, validateConfig } from './config-schema.js';
import { getDefaultKillImpactScanConfig } from '../control/kill-impact-scan.js';
import { homedir } from 'node:os';

describe('config isolation (FR-K11)', () => {
  const originalHome = process.env.OPENCLAW_HOME;

  beforeEach(() => {
    process.env.OPENCLAW_HOME = '/tmp/fake-openclaw-home';
  });

  afterEach(() => {
    if (originalHome) process.env.OPENCLAW_HOME = originalHome;
    else delete process.env.OPENCLAW_HOME;
  });

  it('DEFAULT_KILL_IMPACT_SCAN_CONFIG respects OPENCLAW_HOME', () => {
    const cfg = getDefaultKillImpactScanConfig();
    expect(cfg.outputDir).toBe('/tmp/fake-openclaw-home/workspace/logs');
    expect(cfg.repoRoot).toBe('/tmp/fake-openclaw-home/workspace');
    expect(cfg.outputDir).not.toContain('/root/');
  });

  it('generateMinimalConfig does not contain /root/', () => {
    const content = generateMinimalConfig();
    expect(content).not.toContain('/root/');
  });

  it('no hardcoded /root/ in default config paths', () => {
    const cfg = getDefaultKillImpactScanConfig();
    const allPaths = [cfg.outputDir, cfg.repoRoot, cfg.boardPath, cfg.auditLogPath];
    for (const p of allPaths) {
      expect(p).not.toContain('/root/');
    }
  });
});
```

---

## 3. FR-K12：`aco demo` 命令设计

### 3.1 设计目标

一条命令演示 ACO 完整调度生命周期，不依赖外部 LLM provider，30 秒内跑完。

### 3.2 用户体验

```bash
$ aco demo

🎬 ACO Demo — 完整调度生命周期演示
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[1/6] 初始化资源池...
  ✓ 注册 agent: demo-coder (T1, coder)
  ✓ 注册 agent: demo-auditor (T2, auditor)
  ✓ 注册 agent: demo-researcher (T2, researcher)

[2/6] 提交任务...
  ✓ task-001: "实现用户登录功能" (priority=80, timeout=600s)
  ✓ task-002: "调研竞品方案" (priority=50, timeout=1200s)
  ✓ task-003: "代码审计" (priority=60, timeout=600s)

[3/6] 规则拦截演示...
  ✗ task-004: "部署到生产环境" → 被规则 [block-prod-deploy] 拦截
    原因: 匹配 label 模式 "deploy-prod*"

[4/6] 智能派发...
  ✓ task-001 → demo-coder (角色匹配: coder)
  ✓ task-002 → demo-researcher (角色匹配: researcher)
  ✓ task-003 排队等待 (demo-auditor 空闲后派发)

[5/6] 失败重派演示...
  ✗ task-001 执行失败 (模拟: output_tokens=500 < threshold=3000)
  ↻ task-001 重派 → demo-coder (retry #1, 降级超时 +50%)
  ✓ task-001 重试成功 (output_tokens=8500)

[6/6] 完成与统计...
  ✓ task-001: completed (耗时 2.1s, 重试 1 次)
  ✓ task-002: completed (耗时 1.5s)
  ✓ task-003: completed (耗时 0.8s)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 调度统计:
  总任务: 4 | 成功: 3 | 拦截: 1 | 重试: 1
  平均耗时: 1.5s | 资源利用率: 67%
  
✅ Demo 完成 (总耗时 4.2s)
```

### 3.3 架构设计

```
src/cli/commands/demo.ts          ← CLI 入口 + 编排逻辑
src/demo/                         ← demo 子模块
  ├── demo-adapter.ts             ← 模拟 HostAdapter（不做真实 spawn）
  ├── demo-scenarios.ts           ← 预定义场景数据
  └── demo-renderer.ts            ← 终端输出格式化
```

#### 3.3.1 DemoAdapter

```typescript
// src/demo/demo-adapter.ts
import type { HostAdapter, TaskStatus } from '../types/index.js';

interface DemoTaskState {
  taskId: string;
  willFail: boolean;
  outputTokens: number;
  durationMs: number;
  retryCount: number;
}

export class DemoAdapter implements HostAdapter {
  private tasks = new Map<string, DemoTaskState>();
  private sessionCounter = 0;

  /** 预设任务行为 */
  presetBehavior(taskId: string, behavior: Partial<DemoTaskState>): void {
    this.tasks.set(taskId, {
      taskId,
      willFail: behavior.willFail ?? false,
      outputTokens: behavior.outputTokens ?? 8000,
      durationMs: behavior.durationMs ?? 500,
      retryCount: 0,
    });
  }

  async spawnTask(): Promise<string> {
    return `demo-session-${++this.sessionCounter}`;
  }

  async killTask(): Promise<void> {}
  async steerTask(): Promise<void> {}

  async getTaskStatus(sessionKey: string): Promise<TaskStatus> {
    // 根据预设行为返回模拟状态
    const task = [...this.tasks.values()].find(t => t.retryCount === 0 && t.willFail);
    if (task) {
      task.retryCount++;
      return { status: 'failed', outputTokens: task.outputTokens };
    }
    return { status: 'completed', outputTokens: 8000 };
  }

  subscribeEvents(callback: (event: any) => void): void {
    // Demo 模式不需要事件订阅
  }
}
```

#### 3.3.2 场景数据

```typescript
// src/demo/demo-scenarios.ts
export interface DemoScenario {
  agents: Array<{
    agentId: string;
    tier: 'T1' | 'T2' | 'T3';
    roles: string[];
  }>;
  tasks: Array<{
    taskId: string;
    label: string;
    priority: number;
    timeout: number;
    expectedRole: string;
    willFail?: boolean;
    failTokens?: number;
  }>;
  blockedTasks: Array<{
    taskId: string;
    label: string;
    blockReason: string;
    ruleId: string;
  }>;
  rules: Array<{
    id: string;
    pattern: string;
    action: 'block';
    description: string;
  }>;
}

export const DEFAULT_DEMO_SCENARIO: DemoScenario = {
  agents: [
    { agentId: 'demo-coder', tier: 'T1', roles: ['coder'] },
    { agentId: 'demo-auditor', tier: 'T2', roles: ['auditor'] },
    { agentId: 'demo-researcher', tier: 'T2', roles: ['researcher'] },
  ],
  tasks: [
    { taskId: 'task-001', label: 'implement-login', priority: 80, timeout: 600, expectedRole: 'coder', willFail: true, failTokens: 500 },
    { taskId: 'task-002', label: 'research-competitors', priority: 50, timeout: 1200, expectedRole: 'researcher' },
    { taskId: 'task-003', label: 'code-audit-auth', priority: 60, timeout: 600, expectedRole: 'auditor' },
  ],
  blockedTasks: [
    { taskId: 'task-004', label: 'deploy-prod-v2', blockReason: '匹配 label 模式 "deploy-prod*"', ruleId: 'block-prod-deploy' },
  ],
  rules: [
    { id: 'block-prod-deploy', pattern: 'deploy-prod*', action: 'block', description: '禁止直接部署生产环境' },
  ],
};
```

#### 3.3.3 CLI 入口

```typescript
// src/cli/commands/demo.ts
import { Scheduler } from '../../scheduler.js';
import { DemoAdapter } from '../../demo/demo-adapter.js';
import { DEFAULT_DEMO_SCENARIO } from '../../demo/demo-scenarios.js';
import { DemoRenderer } from '../../demo/demo-renderer.js';

export async function demoCommand(argv: string[]): Promise<number> {
  const verbose = argv.includes('--verbose');
  const scenario = DEFAULT_DEMO_SCENARIO;
  const renderer = new DemoRenderer(verbose);
  const adapter = new DemoAdapter();
  const scheduler = new Scheduler({ defaultTimeout: 600, minTimeout: 300 });
  scheduler.setHostAdapter(adapter);

  renderer.header();

  // Phase 1: 注册资源池
  renderer.phase(1, '初始化资源池');
  for (const agent of scenario.agents) {
    scheduler.resourcePool.register({
      agentId: agent.agentId,
      tier: agent.tier,
      runtimeType: 'subagent',
      roles: agent.roles,
      maxConcurrency: 1,
    });
    renderer.agentRegistered(agent);
  }

  // Phase 2: 提交任务
  renderer.phase(2, '提交任务');
  for (const task of scenario.tasks) {
    scheduler.taskQueue.enqueue({
      taskId: task.taskId,
      label: task.label,
      priority: task.priority,
      timeoutSeconds: task.timeout,
    });
    renderer.taskSubmitted(task);
    if (task.willFail) {
      adapter.presetBehavior(task.taskId, {
        willFail: true,
        outputTokens: task.failTokens ?? 500,
      });
    }
  }

  // Phase 3: 规则拦截
  renderer.phase(3, '规则拦截演示');
  for (const rule of scenario.rules) {
    scheduler.ruleEngine.addRule({
      id: rule.id,
      pattern: rule.pattern,
      action: rule.action,
      priority: 100,
      description: rule.description,
    });
  }
  for (const blocked of scenario.blockedTasks) {
    const result = scheduler.ruleEngine.evaluate({ label: blocked.label });
    renderer.taskBlocked(blocked, result);
  }

  // Phase 4: 派发
  renderer.phase(4, '智能派发');
  const dispatched = await scheduler.dispatchPending();
  for (const d of dispatched) {
    renderer.taskDispatched(d);
  }

  // Phase 5: 失败重派
  renderer.phase(5, '失败重派演示');
  // 模拟 task-001 失败
  const failedTask = scenario.tasks.find(t => t.willFail);
  if (failedTask) {
    renderer.taskFailed(failedTask);
    // 重派
    adapter.presetBehavior(failedTask.taskId, { willFail: false, outputTokens: 8500 });
    renderer.taskRetried(failedTask);
    await scheduler.dispatchPending();
    renderer.taskRetrySuccess(failedTask);
  }

  // Phase 6: 完成统计
  renderer.phase(6, '完成与统计');
  renderer.summary(scenario);
  renderer.footer();

  return 0;
}
```

#### 3.3.4 注册到 CLI 主入口

```typescript
// src/cli/cli.ts — 在 main() 的 switch 中新增：
case 'demo':
  return demoCommand(rest);
```

### 3.4 设计约束

| 约束 | 实现方式 |
|------|----------|
| 不依赖外部 LLM | `DemoAdapter` 纯内存模拟，不调用任何 API |
| 30 秒内跑完 | 所有操作同步/微延迟（`setTimeout` 50-200ms 模拟真实感） |
| 零副作用 | 不写文件、不读真实配置、不修改系统状态 |
| 可扩展 | `DemoScenario` 接口支持自定义场景 `--scenario <path>` |

### 3.5 测试

```typescript
// src/cli/commands/demo.test.ts
import { describe, it, expect, vi } from 'vitest';
import { demoCommand } from './demo.js';

describe('aco demo (FR-K12)', () => {
  it('exits with code 0', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await demoCommand([]);
    expect(code).toBe(0);
    spy.mockRestore();
  });

  it('completes within 30 seconds', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const start = Date.now();
    await demoCommand([]);
    expect(Date.now() - start).toBeLessThan(30_000);
    spy.mockRestore();
  });

  it('shows all 6 phases', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    await demoCommand([]);
    const output = logs.join('\n');
    expect(output).toContain('[1/6]');
    expect(output).toContain('[6/6]');
    spy.mockRestore();
  });
});
```

---

## 4. 实现计划

### Phase 1：测试隔离（FR-K11）

| 步骤 | 工作量 | 说明 |
|------|--------|------|
| 1.1 | 30min | 将 `DEFAULT_KILL_IMPACT_SCAN_CONFIG` 改为工厂函数，消除 `/root/` 硬编码 |
| 1.2 | 15min | `generateMinimalConfig()` / `generateAnnotatedConfig()` 使用动态 home |
| 1.3 | 15min | 删除 `init.ts`、`pool.ts`、`cli.js` 中的 `/root/.openclaw/openclaw.json` fallback |
| 1.4 | 15min | generators 中 `/root` fallback 改为 `os.homedir()` |
| 1.5 | 15min | 新增 `config-isolation.test.ts` 验证隔离 |
| 1.6 | 10min | 全量 `npm test` 确认全绿 |

### Phase 2：Demo 命令（FR-K12）

| 步骤 | 工作量 | 说明 |
|------|--------|------|
| 2.1 | 30min | 创建 `src/demo/` 模块（adapter + scenarios + renderer） |
| 2.2 | 20min | 实现 `src/cli/commands/demo.ts` 编排逻辑 |
| 2.3 | 10min | 注册到 CLI 主入口 |
| 2.4 | 20min | 编写 demo 测试 |
| 2.5 | 10min | 全量测试确认 |

**总工作量**：约 3 小时

---

## 5. 风险与决策

| 决策 | 理由 |
|------|------|
| 工厂函数而非 getter | getter 在 `{ ...obj }` 展开时丢失，工厂函数更安全 |
| 保留 `DEFAULT_KILL_IMPACT_SCAN_CONFIG` 导出名 | 向后兼容，内部改为调用工厂函数 |
| Demo 不使用真实 Scheduler.dispatch() | 避免引入复杂的事件循环依赖，用编排脚本模拟流程更可控 |
| Demo 输出用 emoji + 颜色 | 30 秒演示需要视觉吸引力，但提供 `--no-color` 选项 |
| 不删除 `ACO_DISABLE_ROOT_CONFIG` 机制 | 向后兼容；CI 中设为 `1` 即可，本机开发保持现有行为 |

---

## 6. 验收标准

### FR-K11

- [ ] `grep -rn "/root/" src/` 返回 0 结果（或仅在注释/文档中）
- [ ] `OPENCLAW_HOME=/tmp/x npm test` 全绿
- [ ] `config-isolation.test.ts` 通过
- [ ] 现有 479 测试不回归

### FR-K12

- [ ] `aco demo` 退出码 0
- [ ] 总耗时 < 30s
- [ ] 输出包含 6 个阶段
- [ ] 演示了：注册 → 提交 → 拦截 → 派发 → 失败重派 → 完成统计
- [ ] 不依赖网络/LLM/文件系统
- [ ] `aco demo --verbose` 显示详细调度决策日志
