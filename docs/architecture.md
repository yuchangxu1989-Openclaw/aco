# ACO 技术架构文档（arc42）

OpenClaw（sa-01 子Agent）| 2026-05-05

---

## 目录

1. 系统上下文
2. 容器视图
3. 组件视图
4. 运行时视图
5. 部署视图
6. 技术决策记录（ADR）
7. 质量属性场景
8. 附录：FR 到架构组件的追溯矩阵

---

## 1. 系统上下文

### 1.1 系统边界

ACO（Agent Controlled Orchestration）是一个独立的 npm 包，运行在宿主环境中，负责多 Agent 协作场景下的调度治理。ACO 不管理 Agent 生命周期，不编排研发流程，不管理知识，不做效果分析——它只管"谁做什么、什么时候做、失败了怎么办"。

### 1.2 外部系统交互

```
┌─────────────────────────────────────────────────────────────────┐
│                        宿主环境（如 OpenClaw Gateway）              │
│                                                                 │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐  │
│  │  SEVO    │    │  KIVO    │    │   AEO    │    │  用户/CLI │  │
│  │(流程编排) │    │(知识管理) │    │(效果监测) │    │          │  │
│  └────┬─────┘    └────┬─────┘    └────┬─────┘    └────┬─────┘  │
│       │               │               │               │         │
│       ▼               ▼               ▼               ▼         │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    ACO 调度中枢                           │    │
│  │  (TaskBoard + RuleEngine + Scheduler + CompletionChain)  │    │
│  └────────────────────────────┬────────────────────────────┘    │
│                               │                                  │
│                               ▼                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              Adapter 接口（宿主适配层）                     │    │
│  └────┬──────────┬──────────┬──────────┬───────────────────┘    │
│       │          │          │          │                         │
│       ▼          ▼          ▼          ▼                         │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                   │
│  │Agent T1│ │Agent T2│ │Agent T3│ │Agent T4│                   │
│  │(cc/fc) │ │(codex) │ │(hermes)│ │(dev-0x)│                   │
│  └────────┘ └────────┘ └────────┘ └────────┘                   │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 交互边界定义

**ACO ↔ SEVO（流程编排器）**

| 维度 | SEVO 负责 | ACO 负责 |
|------|-----------|----------|
| 决策层 | 决定"做什么"（阶段推进、门禁评估） | 决定"谁做、怎么派" |
| 触发关系 | SEVO 创建任务请求 → ACO 入队执行 | ACO completion → 通知 SEVO 阶段完成 |
| 数据流 | SEVO 提供 task spec（agentRole, prompt, timeout） | ACO 返回执行结果（status, output, duration） |

**ACO ↔ KIVO（知识管理）**

| 维度 | KIVO 负责 | ACO 负责 |
|------|-----------|----------|
| 知识域 | 知识提取、索引、检索 | 运行时调度 |
| 消费关系 | KIVO 可提供规则知识（如"某 Agent 擅长什么"） | ACO 消费规则配置做路由决策 |
| 数据流 | KIVO 输出 Agent 能力画像 → ACO 规则引擎参考 | 单向消费，ACO 不写入 KIVO |

**ACO ↔ AEO（效果监测）**

| 维度 | AEO 负责 | ACO 负责 |
|------|-----------|----------|
| 分析域 | ROI 分析、效率优化建议 | 产出运行数据 |
| 数据流 | AEO 消费 ACO 审计日志和 TaskBoard 数据 | ACO 暴露数据接口供 AEO 读取 |
| 反馈环 | AEO 优化建议 → ACO 规则调整 | ACO 接受配置变更 |

**ACO ↔ 宿主环境**

| 维度 | 宿主负责 | ACO 负责 |
|------|----------|----------|
| 执行 | Agent 运行、工具接入、沙箱 | 调度语义（规则、路由、推进） |
| 接口 | 提供 Adapter 实现（spawn/query/cancel/notify） | 定义 Adapter 接口规范 |
| 事件 | 推送 completion event | 消费 event 驱动调度循环 |


---

## 2. 容器视图

### 2.1 npm 包内部模块划分

ACO npm 包（`aco-orchestrator`）按职责域划分为以下模块：

```
aco-orchestrator/
├── src/
│   ├── core/                  # 核心调度引擎（通用，不绑定宿主）
│   │   ├── scheduler.ts       # 调度主循环 + 事件分发
│   │   ├── task-board.ts      # TaskBoard 持久化 + 查询
│   │   ├── rule-engine.ts     # 准入校验规则引擎
│   │   ├── completion-chain.ts # 自动推进链引擎
│   │   ├── tier-router.ts     # 梯队路由 + 负载均衡
│   │   └── health-monitor.ts  # 健康监测 + 熔断
│   │
│   ├── models/                # 领域模型（纯数据结构 + 状态机）
│   │   ├── task.ts            # Task 实体 + 状态流转
│   │   ├── agent-slot.ts      # AgentSlot 实体
│   │   ├── dispatch-rule.ts   # DispatchRule 定义
│   │   ├── completion-chain.ts # Chain 定义
│   │   ├── audit-event.ts     # AuditEvent 结构
│   │   └── types.ts           # 共享类型定义
│   │
│   ├── adapters/              # 宿主适配层接口 + 内置实现
│   │   ├── adapter.ts         # Adapter 接口定义（抽象）
│   │   ├── openclaw.ts        # OpenClaw Adapter（内置默认）
│   │   └── mock.ts            # Mock Adapter（测试 + demo）
│   │
│   ├── rules/                 # 内置规则集
│   │   ├── builtin/           # 内置规则实现
│   │   │   ├── agent-exists.ts
│   │   │   ├── timeout-minimum.ts
│   │   │   ├── prompt-non-empty.ts
│   │   │   ├── no-main-dispatch.ts
│   │   │   ├── role-match.ts
│   │   │   ├── separation-of-duty.ts
│   │   │   └── concurrency-limit.ts
│   │   └── loader.ts          # 规则加载器（内置 + 用户自定义）
│   │
│   ├── cli/                   # CLI 命令集
│   │   ├── index.ts           # CLI 入口
│   │   ├── init.ts            # aco init
│   │   ├── demo.ts            # aco demo
│   │   ├── status.ts          # aco status
│   │   ├── pool.ts            # aco pool
│   │   ├── audit.ts           # aco audit
│   │   ├── rule.ts            # aco rule list/add/remove
│   │   └── doctor.ts          # aco doctor
│   │
│   ├── plugin/                # 宿主插件入口
│   │   └── gateway-plugin.ts  # OpenClaw Gateway Plugin 封装
│   │
│   └── index.ts               # 库 API 导出
│
├── bin/
│   └── aco.ts                 # CLI 可执行入口
│
├── aco.config.schema.json     # 配置 JSON Schema
└── package.json
```

### 2.2 模块职责与依赖关系

```
                    ┌─────────────┐
                    │   cli/      │  用户交互层
                    │   plugin/   │  宿主集成层
                    └──────┬──────┘
                           │ 调用
                           ▼
              ┌────────────────────────┐
              │       core/            │  核心引擎层
              │  scheduler             │
              │  rule-engine           │
              │  completion-chain      │
              │  tier-router           │
              │  health-monitor        │
              │  task-board            │
              └──────┬─────────────────┘
                     │ 依赖
          ┌──────────┼──────────┐
          ▼          ▼          ▼
   ┌──────────┐ ┌────────┐ ┌────────┐
   │ models/  │ │adapters/│ │ rules/ │
   │(纯数据)  │ │(IO抽象) │ │(规则集)│
   └──────────┘ └────────┘ └────────┘
```

依赖规则：
- `models/` 无外部依赖，纯数据结构和类型定义
- `rules/` 依赖 `models/`，不依赖 `core/`
- `adapters/` 依赖 `models/`，定义 IO 边界
- `core/` 依赖 `models/`、`adapters/`（接口）、`rules/`
- `cli/` 和 `plugin/` 依赖 `core/`，是最外层
- 禁止循环依赖，禁止内层依赖外层

### 2.3 三层架构映射（NFR-06）

| 架构层 | 对应目录 | 职责 | 可替换性 |
|--------|----------|------|----------|
| npm 包层（通用产品） | `src/core/` + `src/models/` + `src/rules/` + `src/cli/` | 规则引擎、调度器、TaskBoard、CompletionChain、CLI | 所有用户共享，版本升级统一 |
| 宿主适配层 | `src/adapters/` + `src/plugin/` | Adapter 实现、Gateway Plugin 封装 | 每个宿主环境一套实现 |
| 本地定制层 | `aco.config.json`（用户项目中） | 自定义规则、推进链、梯队配置 | 每个部署实例独立配置 |


---

## 3. 组件视图

### 3.1 core/scheduler.ts — 调度主循环

```typescript
interface SchedulerConfig {
  pollIntervalMs?: number;       // 事件循环兜底间隔（默认 5000ms，仅防漏）
  maxConcurrentDispatches: number; // 最大并发派发数
}

class Scheduler {
  constructor(
    taskBoard: TaskBoard,
    ruleEngine: RuleEngine,
    tierRouter: TierRouter,
    completionChain: CompletionChainEngine,
    healthMonitor: HealthMonitor,
    adapter: Adapter,
    config: SchedulerConfig
  );

  // 事件入口（外部调用触发调度循环）
  onTaskEnqueued(task: Task): void;
  onAgentFreed(agentId: string): void;
  onCompletionEvent(event: CompletionEvent): void;
  onHealthAlert(alert: HealthAlert): void;

  // 调度主循环（内部）
  private scheduleNext(): Promise<void>;
  private dispatchTask(task: Task, targetAgent: AgentSlot): Promise<DispatchResult>;

  // 生命周期
  start(): void;
  stop(): void;
}
```

核心职责：
- 接收外部事件（入队、Agent 空闲、completion、健康告警）触发调度
- 协调 RuleEngine、TierRouter、Adapter 完成派发
- 管理调度循环的启停和异常恢复

### 3.2 core/task-board.ts — 任务看板

```typescript
interface TaskBoardConfig {
  filePath: string;              // 持久化文件路径
  archiveAfterMs: number;        // 完成任务归档时间（默认 24h）
  maxTasks: number;              // 最大任务数（含历史）
}

class TaskBoard {
  constructor(config: TaskBoardConfig);

  // CRUD
  enqueue(request: TaskCreateRequest): Task;
  update(taskId: string, patch: Partial<Task>): Task;
  get(taskId: string): Task | null;

  // 查询
  queryByStatus(status: TaskStatus): Task[];
  queryByAgent(agentId: string): Task[];
  queryByTimeRange(from: Date, to: Date): Task[];
  getQueuedByPriority(): Task[];  // 按优先级+FIFO排序

  // 状态流转（带校验）
  transition(taskId: string, to: TaskStatus, context?: object): Task;

  // 持久化（原子写入：tmp + rename）
  private persist(): void;
  private load(): void;

  // 归档
  archiveExpired(): void;

  // 统计
  summary(): BoardSummary;
}
```

核心职责：
- Task 的创建、状态流转、查询、持久化
- 原子写入保证断电不丢数据
- 过期任务自动归档

### 3.3 core/rule-engine.ts — 准入校验规则引擎

```typescript
type RuleDecision = 'allow' | 'block' | 'warn';

interface Rule {
  id: string;
  priority: number;              // 数字越小优先级越高
  match(context: DispatchContext): boolean;
  evaluate(context: DispatchContext): RuleResult;
}

interface RuleResult {
  ruleId: string;
  decision: RuleDecision;
  reason: string;
}

interface DispatchContext {
  task: Task;
  targetAgent: AgentSlot;
  agentPool: AgentSlot[];
  config: AcoConfig;
}

class RuleEngine {
  constructor(rules: Rule[], auditLogger: AuditLogger);

  // 执行规则链
  evaluate(context: DispatchContext): EvaluationResult;

  // 规则管理
  addRule(rule: Rule): void;
  removeRule(ruleId: string): void;
  listRules(): Rule[];

  // 加载
  loadBuiltinRules(): void;
  loadCustomRules(configPath: string): void;
}

interface EvaluationResult {
  finalDecision: RuleDecision;
  ruleResults: RuleResult[];     // 所有规则的执行结果
  blockedBy?: string;            // 阻断规则 ID（如有）
  durationMs: number;            // 执行耗时
}
```

核心职责：
- 按优先级顺序执行规则链
- 首个 block 命中即短路返回
- 每条规则结果写入审计日志
- 执行耗时 < 100ms（NFR-01）

### 3.4 core/completion-chain.ts — 自动推进链引擎

```typescript
interface ChainDefinition {
  id: string;
  trigger: {
    taskType?: string;
    status: TaskStatus;
    agentRole?: string;
    condition?: (task: Task) => boolean;  // 可选条件函数
  };
  action: {
    taskType: string;
    agentRole: string;
    promptTemplate: string;      // 支持变量插值：{{prevOutput}}, {{prevTaskId}}
    timeout?: number;
  };
}

class CompletionChainEngine {
  constructor(chains: ChainDefinition[], auditLogger: AuditLogger);

  // 触发检查
  onTaskCompleted(task: Task): ChainAction[];

  // 链管理
  addChain(chain: ChainDefinition): void;
  removeChain(chainId: string): void;
  listChains(): ChainDefinition[];

  // 内置链
  loadBuiltinChains(): void;
  loadCustomChains(configPath: string): void;
}

interface ChainAction {
  chainId: string;
  generatedTask: TaskCreateRequest;  // 生成的下一个任务
}
```

核心职责：
- 任务完成时匹配推进链定义
- 从模板生成下一个任务的 prompt
- 支持条件分支（有 UI → 视觉验证，纯 CLI → 跳过）
- 内置默认链 + 用户自定义链

### 3.5 core/tier-router.ts — 梯队路由

```typescript
interface TierRouterConfig {
  strategy: 'cost-first' | 'capability-first';  // 默认 cost-first
  tiers: TierDefinition[];
}

interface TierDefinition {
  level: number;                 // T1=1, T2=2, T3=3, T4=4
  agents: string[];              // 该梯队的 agentId 列表
}

class TierRouter {
  constructor(config: TierRouterConfig, agentPool: AgentPool);

  // 路由决策
  selectAgent(task: Task, excludeAgents?: string[]): AgentSlot | null;

  // 升级梯队
  escalate(task: Task, failedAgent: string): AgentSlot | null;

  // 负载均衡（同梯队内）
  private balanceWithinTier(tier: number, excludeAgents: string[]): AgentSlot | null;
}
```

核心职责：
- 默认从最低满足梯队开始（成本优先）
- 失败后自动升级到更高梯队
- 同梯队内按负载均衡选择
- 专职 Agent 不参与梯队路由

### 3.6 core/health-monitor.ts — 健康监测

```typescript
interface HealthMonitorConfig {
  checkIntervalMs: number;       // 检测频率（默认 60000ms）
  idleAlertMs: number;           // idle 告警阈值（默认 300000ms）
  memoryThresholdMb: number;     // 内存断路器阈值（默认 500MB）
  memoryCheckIntervalMs: number; // 内存检测频率（默认 30000ms）
}

class HealthMonitor {
  constructor(config: HealthMonitorConfig, adapter: Adapter, auditLogger: AuditLogger);

  // 启停
  start(): void;
  stop(): void;

  // 事件
  onTaskStarted(task: Task): void;
  onTaskActivity(taskId: string): void;  // Agent 有活动信号

  // 断路器
  isCircuitOpen(): boolean;      // 内存断路器是否触发
  getCircuitState(): CircuitState;

  // 内部
  private checkRunningTasks(): void;
  private checkMemory(): void;
}

type CircuitState = 'closed' | 'open' | 'half-open';
```

核心职责：
- 定期检测 running 任务的活动信号
- idle 超时 → stale 告警 → 熔断
- 内存断路器：低内存时暂停派发
- 不干扰 Agent 执行

### 3.7 adapters/adapter.ts — 宿主适配接口

```typescript
interface Adapter {
  // 派发任务到 Agent
  dispatch(task: Task, agent: AgentSlot): Promise<DispatchResult>;

  // 查询 Agent 状态
  queryAgentStatus(agentId: string): Promise<AgentStatus>;

  // 取消任务
  cancelTask(taskId: string, agentId: string): Promise<void>;

  // 发送通知
  notify(event: NotificationEvent): Promise<void>;

  // 发现 Agent 列表
  discoverAgents(): Promise<AgentSlot[]>;
}

interface DispatchResult {
  success: boolean;
  sessionKey?: string;           // 宿主分配的会话标识
  error?: string;
}

interface AgentStatus {
  agentId: string;
  state: 'idle' | 'busy' | 'stale' | 'offline';
  currentTaskId?: string;
  lastActivityAt?: Date;
}
```

核心职责：
- 定义 ACO 与宿主环境的通信契约
- 5 个方法覆盖完整的调度生命周期
- OpenClaw Adapter 内置为默认实现
- Mock Adapter 用于测试和 demo

### 3.8 models/audit-event.ts — 审计日志

```typescript
interface AuditEvent {
  timestamp: string;             // ISO 8601
  type: AuditEventType;
  taskId?: string;
  agentId?: string;
  ruleId?: string;
  decision?: RuleDecision;
  reason?: string;
  source: string;                // 产生事件的模块
  context?: Record<string, unknown>;  // 附加上下文（prompt 截断到 200 字符）
}

type AuditEventType =
  | 'task_enqueued'
  | 'task_dispatched'
  | 'task_completed'
  | 'task_failed'
  | 'task_retrying'
  | 'task_cancelled'
  | 'task_stale'
  | 'rule_evaluated'
  | 'chain_triggered'
  | 'circuit_opened'
  | 'circuit_closed'
  | 'agent_escalated'
  | 'recovery_started';

class AuditLogger {
  constructor(config: { filePath: string; maxFileSizeMb: number });

  log(event: AuditEvent): void;
  query(filter: AuditFilter): AuditEvent[];
  rotate(): void;                // 按天轮转
}
```


---

## 4. 运行时视图

### 4.1 调度主循环

ACO 的核心运行时是事件驱动的，不是定时轮询。调度循环由以下事件触发：

```
事件源                          触发动作
─────────────────────────────────────────────────────
TaskEnqueued(task)          →  scheduleNext()
CompletionEvent(result)     →  updateBoard() → triggerChain() → scheduleNext()
AgentFreed(agentId)         →  scheduleNext()
HealthAlert(stale/oom)      →  handleAlert() → maybeScheduleNext()
TimerTick(5s fallback)      →  reconcile() → scheduleNext()  [仅防漏]
```

调度主循环伪代码：

```typescript
async function scheduleNext(): Promise<void> {
  if (healthMonitor.isCircuitOpen()) return;  // 内存断路器触发，暂停

  const queued = taskBoard.getQueuedByPriority();
  if (queued.length === 0) return;

  for (const task of queued) {
    const agent = tierRouter.selectAgent(task);
    if (!agent) continue;  // 无空闲 Agent，跳过

    const context: DispatchContext = { task, targetAgent: agent, agentPool, config };
    const evaluation = ruleEngine.evaluate(context);

    if (evaluation.finalDecision === 'block') {
      auditLogger.log({ type: 'rule_evaluated', taskId: task.id, decision: 'block', ... });
      // 根据阻断原因决定：回队等待 or 标记失败
      continue;
    }

    if (evaluation.finalDecision === 'warn') {
      auditLogger.log({ type: 'rule_evaluated', taskId: task.id, decision: 'warn', ... });
      // 记录警告但继续派发
    }

    taskBoard.transition(task.id, 'dispatching');
    const result = await adapter.dispatch(task, agent);

    if (result.success) {
      taskBoard.transition(task.id, 'running', { sessionKey: result.sessionKey });
      healthMonitor.onTaskStarted(task);
    } else {
      taskBoard.transition(task.id, 'failed', { error: result.error });
    }
  }
}
```

### 4.2 任务生命周期状态机

```
                    ┌─────────────────────────────────────────┐
                    │                                         │
                    ▼                                         │
┌─────────┐    ┌──────────┐    ┌─────────┐    ┌───────────┐ │
│ queued  │───▶│dispatching│───▶│ running │───▶│ succeeded │ │
└─────────┘    └──────────┘    └─────────┘    └───────────┘ │
     ▲              │               │                        │
     │              │               │          ┌──────────┐  │
     │              ▼               ├─────────▶│  failed  │  │
     │         (校验不通过           │          └────┬─────┘  │
     │          回队等待)            │               │        │
     │              │               │               ▼        │
     └──────────────┘               │          ┌──────────┐  │
     │                              │          │ retrying │──┘
     │                              ▼          └──────────┘
     │                         ┌─────────┐
     │                         │  stale  │──────▶ failed
     │                         └─────────┘
     │
     │         ┌───────────┐
     └─────────│ cancelled │  (任何状态均可取消)
               └───────────┘
```

状态流转规则：
- `queued → dispatching`：调度器取出任务开始校验
- `dispatching → running`：规则校验通过，Adapter 派发成功
- `dispatching → queued`：目标 Agent 忙或校验暂时不通过，回队重试
- `running → succeeded`：Agent 完成且产出有效（output_tokens > 3000 或有文件产出）
- `running → failed`：Agent 报告失败或超时
- `running → stale`：超过 idle 阈值无活动信号
- `failed → retrying`：重试次数未耗尽，自动重派
- `retrying → running`：重派成功
- `retrying → failed`：重试次数耗尽或最高梯队也失败
- `stale → failed`：宽限期后确认卡死
- `any → cancelled`：用户或系统主动取消

### 4.3 Completion Chain 执行流程

```
completion event 到达
        │
        ▼
┌─────────────────────┐
│ 更新 TaskBoard 状态  │
│ (succeeded/failed)  │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐     匹配失败
│ 匹配 Chain 定义     │────────────────▶ 结束（无后续）
│ (taskType + status) │
└────────┬────────────┘
         │ 匹配成功
         ▼
┌─────────────────────┐
│ 评估条件分支         │
│ (有UI? 纯CLI?)      │
└────────┬────────────┘
         │ 条件满足
         ▼
┌─────────────────────┐
│ 从模板生成新任务     │
│ 注入上一任务产出     │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ 新任务入队 TaskBoard │
│ 触发 scheduleNext() │
└─────────────────────┘
```

内置默认推进链：

| 触发条件 | 生成任务 | 条件 |
|----------|----------|------|
| 开发任务 succeeded | 代码审计 | 无 |
| 审计 succeeded + 通过 | smoke test | 无 |
| smoke test succeeded | 视觉验证 | task 有 UI 产出 |
| 评审 succeeded + 有 P0/P1 | 修复任务 | 自动解析问题列表 |
| 修复 succeeded | 复验（原评审 Agent） | 最多 3 轮 |

### 4.4 失败恢复流程

```
任务 failed
     │
     ▼
┌──────────────────┐
│ 检查重试次数     │──── 已耗尽 ──▶ 标记最终失败 → 通知用户
│ (默认上限 2 次)  │
└────────┬─────────┘
         │ 未耗尽
         ▼
┌──────────────────┐
│ 分析失败原因     │
│ (超时/错误/产出) │
└────────┬─────────┘
         │
         ├── 超时 ──▶ 升级梯队（更强模型）
         ├── 产出不足 ──▶ 优化 prompt + 升级梯队
         └── 执行错误 ──▶ 换 Agent（同梯队不同实例）或升级
                │
                ▼
┌──────────────────┐
│ 同梯队已失败?    │──── 是 ──▶ 升级到更高梯队
└────────┬─────────┘
         │ 否（首次该梯队）
         ▼
┌──────────────────┐
│ 选择同梯队其他   │
│ Agent 重派       │
└────────┬─────────┘
         │
         ▼
  任务状态 → retrying → running
```

### 4.5 渐进式披露运行时行为（L0-L3）

ACO 根据环境复杂度自动调整运行时行为：

| 层级 | 触发条件 | 运行时行为 |
|------|----------|------------|
| L0（零配置） | 单 Agent，无 aco.config.json | 基础调度：超时保护 + 失败通知 + TaskBoard 记录。规则引擎只跑内置规则，推进链禁用。 |
| L1（基础治理） | 2-5 Agent，默认配置 | 完整规则引擎 + 角色匹配 + 梯队路由。推进链启用内置默认链。 |
| L2（完整治理） | 5+ Agent，自定义规则 | 全部功能启用。自定义规则 + 自定义推进链 + 并发控制 + 内存断路器。 |
| L3（集成模式） | 有 SEVO/AEO 集成 | ACO 作为 SEVO 的执行引擎，接受 SEVO 的任务编排指令。AEO 消费 ACO 数据。 |

层级自动检测逻辑：
```typescript
function detectLevel(config: AcoConfig, agentPool: AgentSlot[]): Level {
  if (agentPool.length <= 1 && !config.customRules?.length) return 'L0';
  if (agentPool.length <= 5 && !config.customRules?.length) return 'L1';
  if (!config.integrations?.sevo && !config.integrations?.aeo) return 'L2';
  return 'L3';
}
```


---

## 5. 部署视图

### 5.1 npm 包分发结构

```
aco-orchestrator (npm package)
├── dist/                      # 编译产物（ESM）
│   ├── core/
│   ├── models/
│   ├── adapters/
│   ├── rules/
│   ├── cli/
│   ├── plugin/
│   └── index.js
├── bin/
│   └── aco                    # CLI 入口（#!/usr/bin/env node）
├── aco.config.schema.json     # 配置 JSON Schema
├── package.json
└── README.md
```

package.json 关键字段：
```json
{
  "name": "aco-orchestrator",
  "type": "module",
  "exports": {
    ".": "./dist/index.js",
    "./plugin": "./dist/plugin/gateway-plugin.js",
    "./adapter": "./dist/adapters/adapter.js"
  },
  "bin": {
    "aco": "./bin/aco"
  },
  "engines": {
    "node": ">=22.0.0"
  }
}
```

### 5.2 宿主集成部署（OpenClaw 环境）

```
/root/.openclaw/
├── openclaw.json              # Gateway 配置（注册 ACO 插件）
├── extensions/
│   └── aco-gateway-bridge/    # 宿主适配层 wrapper
│       ├── index.js           # Gateway Plugin 入口（import aco-orchestrator/plugin）
│       └── package.json
├── workspace/
│   ├── aco.config.json        # 本地定制层配置
│   └── logs/
│       ├── aco-task-board.json    # TaskBoard 持久化
│       ├── aco-audit.jsonl        # 审计日志
│       └── aco-audit-archive/     # 历史审计归档
└── node_modules/
    └── aco-orchestrator/      # npm 包安装位置
```

openclaw.json 插件注册：
```json
{
  "plugins": {
    "entries": {
      "aco-gateway-bridge": {
        "enabled": true,
        "source": "extensions/aco-gateway-bridge/index.js"
      }
    }
  }
}
```

### 5.3 宿主适配层 wrapper（aco-gateway-bridge）

```javascript
// extensions/aco-gateway-bridge/index.js
import { createScheduler, OpenClawAdapter } from 'aco-orchestrator';
import { loadConfig } from 'aco-orchestrator/plugin';

export default function register(api) {
  const config = loadConfig('/root/.openclaw/workspace/aco.config.json');
  const adapter = new OpenClawAdapter(api);
  const scheduler = createScheduler({ config, adapter });

  // 拦截 sessions_spawn 调用，注入治理逻辑
  api.hook('tool-call', async (event) => {
    if (event.toolName === 'sessions_spawn') {
      return scheduler.interceptDispatch(event);
    }
  });

  // 监听 completion event，驱动调度循环
  api.hook('session-complete', async (event) => {
    scheduler.onCompletionEvent(event);
  });

  // 注入调度规则摘要到 system prompt（L6 层冗余）
  api.hook('prompt-inject', async (event) => {
    if (event.agentId === 'main') {
      return { append: scheduler.getRuleSummary() };
    }
  });

  scheduler.start();
  api.logger.info('[aco] scheduler started');
}
```

### 5.4 独立运行部署（非 OpenClaw 环境）

```
my-project/
├── aco.config.json            # 配置文件
├── node_modules/
│   └── aco-orchestrator/
└── scripts/
    └── run-aco.ts             # 自定义启动脚本
```

独立运行时，用户需要：
1. 实现自定义 Adapter（对接自有 Agent 执行环境）
2. 通过库 API 创建 Scheduler 实例
3. 手动调用事件入口（onTaskEnqueued、onCompletionEvent）

```typescript
import { createScheduler, TaskBoard, RuleEngine } from 'aco-orchestrator';
import { MyCustomAdapter } from './my-adapter.js';

const adapter = new MyCustomAdapter();
const scheduler = createScheduler({
  config: './aco.config.json',
  adapter,
});

// 手动驱动
scheduler.onTaskEnqueued({ agentId: 'worker-1', prompt: '...', timeoutSeconds: 600 });
```

### 5.5 迁移路径（现有实现 → ACO）

```
Phase 1: 并行运行
─────────────────────────────────────────────────
现有插件（dispatch-guard + run-watchdog）继续运行
ACO 以 shadow mode 运行：接收相同事件，记录决策，但不实际执行
对比 ACO 决策与现有插件决策，验证一致性

Phase 2: 逐步接管
─────────────────────────────────────────────────
ACO 接管 TaskBoard 管理（替代 local-subagent-board.js）
ACO 接管规则引擎（替代 dispatch-guard 的规则逻辑）
run-watchdog 的健康监测逻辑迁入 ACO HealthMonitor
现有插件降级为 thin wrapper，转发事件给 ACO

Phase 3: 完全替代
─────────────────────────────────────────────────
移除 dispatch-guard 插件，ACO gateway-bridge 完全接管
移除 run-watchdog 插件，ACO HealthMonitor 完全接管
移除 local-subagent-board.js，ACO TaskBoard 完全接管
AGENTS.md 中的调度铁律由 ACO 规则引擎代码化执行
```

迁移兼容性保证：
- Phase 1-2 期间，现有 TaskBoard JSON 格式保持兼容
- ACO TaskBoard 可读取现有 `subagent-task-board.json` 格式并自动迁移
- 审计日志格式向后兼容（新增字段，不删除旧字段）
- CLI 命令不与现有 `node local-subagent-board.js` 冲突



---

## 6. 技术决策记录（ADR）

### ADR-001: Event-Driven

**Status**: Decided

**Context**:
ACO needs to advance tasks promptly after completion. Two approaches:
- A: Poll TaskBoard on timer
- B: Event-driven via completion events

**Decision**: Event-driven (B) with 5s fallback timer for reconciliation.

**Rationale**:
1. Latency: Polling interval sets worst-case delay. To meet NFR-01 (< 5s), polling must be < 5s which wastes CPU. Events give near-zero latency.
2. Efficiency: Polling reads files even when idle. Events have zero idle cost.
3. Host fit: OpenClaw Gateway provides session-complete hook natively.
4. Reliability: Pure events may miss. 5s fallback reconcile catches gaps idempotently.

**Consequences**:
- Adapter must support event push (completion)
- Hosts without events need polling-to-event conversion in Adapter layer
- Reconcile logic must be idempotent

---

### ADR-002: TaskBoard JSON File vs SQLite

**Status**: Decided

**Context**:
TaskBoard needs persistent storage. Options: JSON file (current approach) or SQLite.

**Decision**: JSON file.

**Rationale**:
1. Scale fit: Max 20 agents, 50+ tasks. JSON handles this easily, read/write < 50ms (NFR-01).
2. Zero deps: No native bindings needed. Clean npm install experience.
3. Debuggability: Plain text, editable with any editor. No DB tools needed for troubleshooting.
4. Atomic writes: tmp + rename is POSIX-atomic. No data loss on crash (NFR-02).
5. Migration cost: Existing subagent-task-board.json is already JSON. Zero conversion needed.

**Tradeoffs**:
- No complex queries. ACO queries are simple (by status/agent/time), in-memory filter suffices.
- Concurrent writes need mutex. Single-instance deployment (spec constraint) means in-process lock is enough.
- Performance degrades with growth. Archive mechanism (24h expiry) keeps active data small.

**Re-evaluate when**:
- Agent count exceeds 50
- Complex aggregate queries needed (e.g. 7-day average duration per agent)
- Multi-process concurrent access required

---

### ADR-003: Rule Engine vs LLM Semantic Judgment Boundary

**Status**: Decided

**Context**:
ACO governance needs to understand task content for decisions (task type inference, role matching). Options:
- A: Pure rule engine (pattern matching)
- B: Pure LLM semantic judgment
- C: Rule engine primary, LLM as optional enhancement

**Decision**: Option C. Rule engine handles deterministic logic; LLM handles semantic understanding.

**Boundary**:

| Scenario | Handler | Why |
|----------|---------|-----|
| agentId existence check | Rule engine | Deterministic config lookup |
| timeout minimum threshold | Rule engine | Numeric comparison |
| Role-task match (manually tagged) | Rule engine | User specified taskType |
| Role-task match (no tag, needs inference) | LLM | Requires prompt semantic understanding |
| Separation of duty (dev cannot self-audit) | Rule engine | Check parentTaskId agentId |
| Concurrency control | Rule engine | Counting logic |
| Failure reason analysis (retry strategy) | LLM | Requires understanding error semantics |
| Chain condition (has UI output?) | LLM | Requires understanding task output |

**Constraints**:
- Rule engine path must be < 100ms (NFR-01). LLM calls are NOT on this path.
- LLM calls are async pre/post-processing, never blocking the dispatch loop.
- LLM unavailable: degrade to rule engine (skip semantic rules), function degrades but does not break.
- Keyword matching is forbidden for understanding tasks (spec hard constraint). Must use LLM or degrade to not-judging.

**Implementation**:
- LLM classifier injected as optional dependency into RuleEngine
- Results cached (same prompt not re-called within 5 minutes)
- Unavailable LLM returns unknown; rules skip semantic checks (degrade to warn, not block)

---

### ADR-004: Migration Strategy from dispatch-guard / run-watchdog

**Status**: Decided

**Context**:
Two existing plugins handle partial orchestration duties:
- agent-dispatch-guard: admission rules, role matching, concurrency control, audit logging
- run-watchdog: task monitoring, stale detection, TaskBoard management, completion handling

ACO replaces both, but cannot do so in one step (too risky).

**Decision**: Three-phase gradual migration, each phase independently rollbackable.

**Phases**:

| Phase | Timeline | Action | Rollback |
|-------|----------|--------|----------|
| Phase 1: Shadow | Week 1-2 | ACO runs in parallel, records decisions but does not execute. Compare decision consistency. | Stop ACO, zero impact |
| Phase 2: Partial | Week 3-4 | ACO takes over TaskBoard + rule engine. Existing plugins degrade to event forwarding. | Restore plugin config, ACO back to shadow |
| Phase 3: Full | Week 5+ | Remove existing plugins, ACO fully takes over. | Re-enable plugins (code preserved, not deleted) |

**Function Mapping**:

| Existing | ACO Module | Migration |
|----------|-----------|-----------|
| dispatch-guard: AGENT_TIER | core/tier-router.ts | Config migrates to aco.config.json |
| dispatch-guard: ROLE_TASK_MAP | rules/builtin/role-match.ts | Rules codified |
| dispatch-guard: MAX_CONCURRENT_ACP | rules/builtin/concurrency-limit.ts | Rules codified |
| dispatch-guard: audit log | core/audit-logger.ts | Format compatible, path configurable |
| run-watchdog: STALE_MS | core/health-monitor.ts | Config migration |
| run-watchdog: IDLE_ALERT_MS | core/health-monitor.ts | Config migration |
| run-watchdog: upsertBoardTask | core/task-board.ts | Interface compatible |
| run-watchdog: memoryBreaker | core/health-monitor.ts | Logic migration |
| run-watchdog: maybeRecover | core/health-monitor.ts | Logic migration |
| local-subagent-board.js: send-snapshot | adapter: notify() | Adapter implementation |

**Data Migration**:
- ACO startup detects existing old-format task board JSON
- Auto-reads and converts to ACO TaskBoard format
- Preserves old file as .bak backup, does not delete
- Audit logs keep JSONL format, add fields but never remove existing ones

---

## 7. 质量属性场景

### 7.1 Performance

| Scenario | Stimulus | Response | Measure |
|----------|----------|----------|---------|
| Dispatch latency | Completion event arrives | Next task dispatched | < 5 seconds (NFR-01) |
| Rule evaluation | Task enters dispatching state | All rules evaluated | < 100ms total (NFR-01) |
| TaskBoard I/O | Read or write operation | Operation completes | < 50ms (NFR-01) |
| Scale | 50+ tasks in board | All operations normal | No degradation |
| Chain trigger | Task completes with matching chain | New task generated and queued | < 1 second |

**Design decisions supporting performance**:
- Event-driven architecture eliminates polling overhead (ADR-001)
- JSON file with in-memory cache for reads, atomic write only on mutations (ADR-002)
- Rule engine short-circuits on first block (no unnecessary evaluation)
- LLM calls are async, never on the critical dispatch path (ADR-003)
- Archive mechanism keeps active dataset small (< 100 tasks in memory)

### 7.2 Reliability

| Scenario | Stimulus | Response | Measure |
|----------|----------|----------|---------|
| Crash recovery | Gateway restarts unexpectedly | ACO recovers state from persisted TaskBoard | Zero task loss, orphan tasks detected within 10s |
| Atomic persistence | Process killed during write | TaskBoard file remains consistent | tmp+rename guarantees atomicity |
| Rule failure | Single rule throws exception | Other rules continue, failed rule logged | Fault isolation, no cascade |
| Adapter timeout | Host dispatch call hangs | Task marked failed after timeout | Configurable timeout per dispatch |
| Event loss | Completion event missed | 5s reconcile timer detects inconsistency | Self-healing within 10s |
| Memory pressure | System memory < 500MB | Circuit breaker pauses new dispatches | Running tasks unaffected, auto-resume on recovery |

**Design decisions supporting reliability**:
- Persistent-first: TaskBoard and audit log survive process restarts (NFR-02)
- Append-only audit log: no data overwrite risk
- Graceful degradation: any single component failure does not crash the scheduler
- Circuit breaker pattern for memory protection (FR-F02)
- Reconcile timer as safety net for event-driven architecture (ADR-001)

### 7.3 Extensibility

| Scenario | Stimulus | Response | Measure |
|----------|----------|----------|---------|
| Custom rules | User adds rule to aco.config.json | Rule loaded and active on next cycle | Hot-reload without restart |
| Custom chains | User defines new completion chain | Chain active for matching tasks | No code changes needed |
| New host | Developer implements custom Adapter | ACO works on new platform | 5 methods to implement |
| New notification channel | Developer adds channel to Adapter | Notifications flow to new channel | Single method implementation |
| Tier reconfiguration | User changes agent tiers | Router uses new tiers immediately | Config change, no code change |

**Design decisions supporting extensibility**:
- Adapter pattern decouples ACO from any specific host (NFR-06)
- Three-layer architecture: npm package / host adapter / local customization
- Rule engine supports dynamic rule loading from config
- Completion chains are declarative (config, not code)
- All extension points use dependency injection (no hardcoded implementations)

### 7.4 Observability

| Scenario | Stimulus | Response | Measure |
|----------|----------|----------|---------|
| Dispatch audit | Any dispatch decision made | Full context logged to JSONL | Every decision traceable |
| Task history | User runs aco status | Current board summary displayed | Real-time accuracy |
| Agent health | User runs aco pool | All agent states visible | Includes failure rates, current tasks |
| Notification | Task fails or goes stale | User notified via configured channel | < 30s notification latency |
| Log rotation | Audit log exceeds 50MB | Auto-rotated to date-stamped archive | No manual intervention |

### 7.5 Security

| Scenario | Stimulus | Response | Measure |
|----------|----------|----------|---------|
| Prompt leakage | Audit log written | Only first 200 chars of prompt recorded | NFR-04 compliance |
| File permissions | TaskBoard file created | Permission set to 600 (owner only) | NFR-04 compliance |
| Sensitive config | API keys in host config | Never written to audit log | Key patterns redacted |
| Input validation | Malformed task request | Rejected with clear error | No crash, no partial state |

### 7.6 Portability

| Scenario | Stimulus | Response | Measure |
|----------|----------|----------|---------|
| OS compatibility | Run on Linux or macOS | All features work | No OS-specific APIs used |
| Node.js version | Run on Node.js 22+ | All features work | ESM, no version-specific APIs |
| Host independence | Run without OpenClaw | Core features work via CLI | Only Adapter-dependent features degrade |
| Zero external deps | npm install | No native compilation needed | Pure JS/TS dependencies only |

---

## 附录：FR 到架构组件的追溯矩阵

| FR | Architecture Component | Notes |
|----|----------------------|-------|
| A01 (Task Create) | core/task-board.ts: enqueue() | Validation + ID generation |
| A02 (Task Dispatch) | core/scheduler.ts: scheduleNext() | Coordinates rule-engine + adapter |
| A03 (Task Complete) | core/scheduler.ts: onCompletionEvent() | Updates board + triggers chain |
| A04 (Timeout/Cancel) | core/health-monitor.ts + adapter.cancelTask() | Stale detection + forced termination |
| B01 (Rule Engine) | core/rule-engine.ts | Priority-ordered rule chain |
| B02 (Role Match) | rules/builtin/role-match.ts | With optional LLM classifier |
| B03 (Separation of Duty) | rules/builtin/separation-of-duty.ts | parentTaskId check |
| B04 (Concurrency) | rules/builtin/concurrency-limit.ts | Per-type and global limits |
| B05 (Custom Rules) | rules/loader.ts | Config-driven rule loading |
| C01 (Agent Pool) | models/agent-slot.ts + adapter.discoverAgents() | Pool state management |
| C02 (Tier Routing) | core/tier-router.ts | Cost-first with escalation |
| C03 (Failure Escalation) | core/tier-router.ts: escalate() | Auto-upgrade tier on failure |
| C04 (Health Check) | core/health-monitor.ts | Periodic activity signal check |
| D01 (Chain Definition) | core/completion-chain.ts | Declarative chain config |
| D02 (Review-Fix Loop) | core/completion-chain.ts | Built-in chain with P0/P1 parsing |
| D03 (Instant Advance) | core/scheduler.ts: onCompletionEvent() | Immediate next-task dispatch |
| D04 (Failure Retry) | core/scheduler.ts + tier-router.ts | Auto-escalate and retry |
| E01 (TaskBoard View) | core/task-board.ts + cli/status.ts | Persistent board + CLI query |
| E02 (Audit Log) | models/audit-event.ts + AuditLogger | JSONL append-only |
| E03 (Notifications) | adapter.notify() | Channel-agnostic via Adapter |
| E04 (Pool Dashboard) | cli/pool.ts + adapter.queryAgentStatus() | Real-time agent states |
| F01 (Stale Detection) | core/health-monitor.ts | idle threshold + circuit breaker |
| F02 (Memory Breaker) | core/health-monitor.ts | Pause dispatch on low memory |
| F03 (Auto Recovery) | core/scheduler.ts: start() | Orphan task detection on startup |
| F04 (Log Rotation) | AuditLogger.rotate() | Daily rotation, 50MB cap |
| G01 (Progressive Disclosure) | detectLevel() in scheduler | L0-L3 auto-detection |
| G02 (Adapter Interface) | adapters/adapter.ts | 5-method contract |
| G03 (Config Schema) | aco.config.schema.json | JSON Schema validation |
| Z01 (npm Package) | package.json + dist/ | ESM, bin, exports |
| Z02 (Init) | cli/init.ts | Environment detection + config generation |
| Z03 (Demo) | cli/demo.ts | Mock adapter demo flow |
| Z04 (Plugin Mode) | plugin/gateway-plugin.ts | Hook-based integration |
