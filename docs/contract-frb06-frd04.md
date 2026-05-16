# ACO 架构契约：FR-B06 动态角色发现 + FR-D04 链路可视化

OpenClaw（sa-01 子Agent）| 2026-05-16

---

## 1. FR-B06: 动态角色发现 (Dynamic Role Discovery)

### 1.1 职责

从宿主配置动态读取 Agent 列表和角色映射，构建运行时角色路由表，禁止硬编码 Agent ID。支持渐进式降级和配置热更新。

### 1.2 模块位置

```
src/dispatch/role-discovery.ts    # 核心模块
```

### 1.3 核心数据结构

```typescript
/** 角色 → Agent 列表映射 */
export type RoleAgentsMap = Map<RoleTag, string[]>;

/** 任务类型 → 允许角色映射 */
export type RoleTaskMap = Map<TaskType, RoleTag[]>;

/** 角色发现的运行模式 */
export type RoleEnforcementMode = 'skip' | 'warn' | 'enforce';

/** 角色发现配置 */
export interface RoleDiscoveryConfig {
  /** 默认任务类型到角色的映射（当宿主配置未提供时使用） */
  defaultTaskRoleMapping: Record<string, string[]>;
  /** 配置刷新间隔（ms），0 表示仅依赖 watcher 事件 */
  refreshIntervalMs: number;
}

/** 角色发现结果 */
export interface RoleDiscoveryResult {
  roleAgents: RoleAgentsMap;
  roleTaskMap: RoleTaskMap;
  mode: RoleEnforcementMode;
  agentCount: number;
  rolesFound: string[];
  timestamp: number;
}
```

### 1.4 类设计

```typescript
export class RoleDiscovery {
  constructor(
    private eventBus: EventBus,
    private adapter: HostAdapter,
    config?: Partial<RoleDiscoveryConfig>,
  );

  /**
   * AC1+AC2: 从宿主配置动态构建角色映射
   * 调用 adapter.discoverAgents() 获取 Agent 列表
   * 根据每个 Agent 的 roles 字段构建 ROLE_AGENTS
   * 根据内置 + 配置的任务类型定义构建 ROLE_TASK_MAP
   */
  async discover(): Promise<RoleDiscoveryResult>;

  /**
   * AC3: 判断当前运行模式
   * - 0-1 个 Agent → 'skip'（单 Agent 模式，跳过角色匹配）
   * - 多 Agent 但无任何 role 声明 → 'warn'（记录日志但不拦截）
   * - 有 role 声明 → 'enforce'（拦截角色不匹配的派发）
   */
  getEnforcementMode(): RoleEnforcementMode;

  /**
   * AC4: 获取 Agent 的梯队信息
   * 优先使用配置中显式声明的 tier
   * 无显式声明时根据 runtime.type 推断：
   *   acp → T1-T3（根据 model 进一步细分）
   *   subagent → T4
   */
  getAgentTier(agentId: string): Tier | undefined;

  /**
   * AC5: 配置变更时刷新
   * 监听宿主 config watcher 事件或 ACO 自身的 FR-H02 热加载
   * 刷新后发出 'role_discovery_refreshed' 审计事件
   */
  async refresh(): Promise<RoleDiscoveryResult>;

  /**
   * AC6: 获取当前映射（用于启动日志输出）
   */
  getSnapshot(): RoleDiscoveryResult;

  /**
   * 校验派发请求的角色匹配
   * 返回 { allowed, reason }
   */
  checkRoleMatch(
    taskType: string,
    targetAgentId: string,
  ): { allowed: boolean; reason: string };
}
```

### 1.5 与现有模块的集成

```
┌──────────────────┐     discover()      ┌──────────────────┐
│  OpenClawAdapter │ ◄────────────────── │  RoleDiscovery   │
│  .discoverAgents │                     │                  │
└──────────────────┘                     └────────┬─────────┘
                                                  │
                                    checkRoleMatch()
                                                  │
                                                  ▼
                                         ┌────────────────┐
                                         │  RuleEngine    │
                                         │  (dispatch/)   │
                                         └────────────────┘
```

- **RuleEngine** 在评估派发规则时调用 `RoleDiscovery.checkRoleMatch()`
- **Scheduler/Plugin** 启动时调用 `RoleDiscovery.discover()` 并输出日志（AC6）
- **ConfigManager** 配置变更事件触发 `RoleDiscovery.refresh()`（AC5）

### 1.6 渐进式降级逻辑（AC3）

```
agents.length == 0 or 1  →  mode = 'skip'
                             所有任务直接放行，不做角色校验

agents.length > 1 &&
  agents.every(a => !a.roles || a.roles.length === 0)
                         →  mode = 'warn'
                             角色不匹配时记录 warn 日志 + audit event
                             但不拦截派发

agents.some(a => a.roles && a.roles.length > 0)
                         →  mode = 'enforce'
                             角色不匹配时拦截派发，返回 { allowed: false }
```

### 1.7 默认任务类型→角色映射

```typescript
const DEFAULT_TASK_ROLE_MAPPING: Record<string, string[]> = {
  coding:       ['coder'],
  refactoring:  ['coder'],
  testing:      ['coder'],
  bugfix:       ['coder'],
  architecture: ['architect'],
  design:       ['architect'],
  review:       ['auditor'],
  audit:        ['auditor'],
  security:     ['auditor'],
  requirements: ['pm'],
  spec:         ['pm'],
  planning:     ['pm'],
  ux_review:    ['ux'],
  visual:       ['ux'],
  research:     ['researcher'],
  analysis:     ['researcher'],
};
```

用户可通过 `aco.config.json` 的 `dispatch.roleTaskMapping` 字段覆盖或扩展。

### 1.8 AC 覆盖验证点

| AC | 验证方式 |
|----|----------|
| AC1 | 单测：传入含 role 字段的 DiscoveredAgent[]，验证 RoleAgentsMap 正确构建 |
| AC2 | 单测：验证 ROLE_AGENTS 和 ROLE_TASK_MAP 不含硬编码 Agent ID |
| AC3 | 单测：分别传入 0/1 Agent、多 Agent 无 role、多 Agent 有 role，验证 mode 判定 |
| AC4 | 单测：验证显式 tier 优先于推断；验证 acp→T1-T3、subagent→T4 推断逻辑 |
| AC5 | 集成测：模拟 config change 事件，验证 refresh() 被调用且映射更新 |
| AC6 | 单测：验证 discover() 后 getSnapshot() 返回完整映射；集成测验证启动日志输出 |

---

## 2. FR-D04: 链路可视化

### 2.1 职责

展示 Completion Chain 的执行路径和当前进度。提供 CLI 命令查看运行中和历史 chain 执行的节点状态。

### 2.2 模块位置

```
src/chain/chain-visualizer.ts         # 可视化渲染逻辑
src/cli/commands/chain.ts             # CLI 命令扩展（新增 status 子命令）
```

### 2.3 核心数据结构

```typescript
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
  status: ChainNodeStatus;  // 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
  agentId?: string;
  durationMs?: number;
  outputSummary?: string;
  failureReason?: string;
}

/** 输出格式 */
export type ChainOutputFormat = 'tree' | 'json';
```

### 2.4 类设计

```typescript
export class ChainVisualizer {
  constructor(private executor: ChainExecutor);

  /**
   * AC1+AC2: 获取指定 chain 执行的完整视图
   * 包含每个节点的状态、执行时间、agentId、产出摘要
   */
  getExecutionView(executionId: string): ChainExecutionView | undefined;

  /**
   * AC3: 获取历史执行记录列表
   * 支持按状态筛选
   */
  listExecutions(filter?: {
    status?: ChainExecution['status'];
    limit?: number;
  }): ChainExecutionView[];

  /**
   * AC4: 渲染为 tree 格式（终端友好）
   *
   * 输出示例：
   * Chain: dev-audit-fix (exec-abc123) [succeeded]
   * Duration: 8m 32s | Parent: task-xyz
   * ├── ✓ code-review (audit-01) 2m 15s
   * │   └─ "发现 3 个 P1 问题"
   * ├── ✓ fix-issues (cc) 4m 48s
   * │   └─ "修复 3 个 P1 问题，改动 5 文件"
   * ├── ✓ re-verify (audit-01) 1m 29s
   * │   └─ "全部通过"
   * └── ○ notify (skipped)
   *     └─ condition not met
   */
  renderTree(view: ChainExecutionView): string;

  /**
   * AC4: 渲染为 JSON 格式（程序消费）
   */
  renderJson(view: ChainExecutionView): string;
}
```

### 2.5 CLI 命令扩展

在现有 `src/cli/commands/chain.ts` 中新增 `status` 子命令：

```
aco chain status <executionId>    查看链路执行状态
aco chain status --active         查看所有运行中的链路
aco chain status --history        查看历史执行记录

Options:
  --json          JSON 格式输出（默认 tree）
  --limit <n>     历史记录数量限制（默认 10）
```

### 2.6 与现有模块的集成

```
┌──────────────────┐                    ┌──────────────────┐
│  CLI chain cmd   │ ──── renders ────► │ ChainVisualizer  │
│  (status subcmd) │                    │                  │
└──────────────────┘                    └────────┬─────────┘
                                                 │
                                        reads execution state
                                                 │
                                                 ▼
                                        ┌────────────────┐
                                        │ ChainExecutor  │
                                        │ (已有，域 D)    │
                                        └────────────────┘
```

- **ChainVisualizer** 从 `ChainExecutor` 读取执行状态（通过 `getExecution()` 和 `listExecutions()`）
- **ChainExecutor** 需要暴露两个新方法：
  - `getExecution(executionId: string): ChainExecution | undefined`
  - `listExecutions(): ChainExecution[]`
  - 这两个方法已有内部数据（`this.executions` Map），只需公开访问器

### 2.7 持久化考虑

当前 `ChainExecutor` 的 `executions` Map 是内存态。为支持 AC3（查看历史已完成的 chain 执行记录），需要：

1. **方案 A（推荐）**：ChainExecutor 完成/失败时将执行记录写入审计日志（已有 audit event 机制），ChainVisualizer 从审计日志中恢复历史记录
2. **方案 B**：ChainExecutor 维护一个持久化的执行历史文件（`data/chain-history.jsonl`）

推荐方案 A，复用已有审计基础设施，不引入新的持久化路径。

### 2.8 Tree 渲染规则

| 节点状态 | 图标 | 颜色（终端） |
|----------|------|-------------|
| succeeded | ✓ | green |
| running | ◉ | cyan |
| pending | ○ | dim |
| failed | ✗ | red |
| skipped | ○ | yellow |

Duration 格式：`< 1s` → `<1s`；`1-60s` → `Xs`；`1-60m` → `Xm Ys`；`> 1h` → `Xh Ym`

### 2.9 AC 覆盖验证点

| AC | 验证方式 |
|----|----------|
| AC1 | 单测：创建 ChainExecution，调用 getExecutionView()，验证每个节点状态正确 |
| AC2 | 单测：验证 ChainNodeView 包含 durationMs、agentId、outputSummary |
| AC3 | 集成测：执行多个 chain，验证 listExecutions() 返回历史记录 |
| AC4 | 单测：验证 renderTree() 输出格式正确；验证 renderJson() 输出合法 JSON |

---

## 3. 追溯矩阵更新

现有架构文档的追溯矩阵需要更新以下条目：

| FR | Architecture Component | Notes |
|----|----------------------|-------|
| B06 (Dynamic Role Discovery) | src/dispatch/role-discovery.ts | 动态构建 ROLE_AGENTS + ROLE_TASK_MAP，渐进式降级 |
| D04 (Chain Visualization) | src/chain/chain-visualizer.ts + src/cli/commands/chain.ts (status) | CLI 链路状态展示，tree/JSON 格式 |

---

## 4. 实现约束

1. **禁止硬编码 Agent ID**：role-discovery 的所有映射必须从 adapter.discoverAgents() 动态获取
2. **单 Agent 透明退化**：单 Agent 环境下 role-discovery 返回 mode='skip'，不影响正常派发
3. **无新依赖**：两个模块均使用项目已有依赖（uuid、EventBus），不引入新 npm 包
4. **向后兼容**：ChainExecutor 新增的公开方法不改变现有接口签名
5. **测试覆盖**：每个 AC 至少一个单测用例

---

## 5. 实现顺序建议

1. FR-B06 先行（dispatch/role-discovery.ts + 单测）
2. FR-D04 跟进（chain/chain-visualizer.ts + CLI status 子命令 + 单测）
3. 集成验证：启动 ACO，验证角色发现日志输出 + chain status 命令可用
