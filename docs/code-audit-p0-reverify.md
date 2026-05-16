# ACO P0 修复复验审计报告

OpenClaw（audit-01 子Agent）｜2026-05-06

## 最终判定：PASS

4 个 P0 问题全部确认修复，修复质量扎实，不是占位或表面修补。

验证结果：
- `npm test`：9 个测试文件，199 个测试通过（含 29 个 P0 专项测试）
- `npm run build`：零错误通过
- `aco.config.schema.json`：存在且已纳入 package.json files 字段

---

## P0 复验详情

### P0-1：失败重派链 — ✅ 已修复

**修复内容：**
- `scheduler.ts` 的 `scheduleNext()` 现在查询 `['queued', 'retrying']` 两种状态的任务
- `tryDispatch()` 对 `retrying` 状态有专门处理路径：直接 `retrying → running`，调用 adapter.dispatch
- `handleFailure()` 在失败后将任务转为 `retrying`，同时通过 TierRouter 升级梯队、更新 excludeAgents

**验证逻辑完整性：**
- 失败 → `handleFailure` 设置 `retrying` + 升级梯队 → `scheduleNext` 查到 retrying 任务 → `tryDispatch` 重新派发 → running
- maxRetries=2 的上限检查存在，超限后不再重试
- 升级时排除已失败的 agent（excludeAgents 累加）

**测试覆盖：**
- `should re-dispatch retrying tasks via scheduleNext`
- `should escalate tier on retry`
- `should not retry beyond max retries`
- `should emit task.retry event during retry`
- `should handle failure after health alert`

### P0-2：假成功判定 — ✅ 已修复

**修复内容：**
- `onCompletionEvent()` 在 status='succeeded' 时调用 `detectSubstantiveFailure(output)`
- 判定为实质失败时，effectiveStatus 改为 'failed'，failureReason 记录具体数值
- `detectSubstantiveFailure()` 逻辑：outputTokens < minOutputTokens(默认 3000）且 filesWritten === 0 → 实质失败
- 边界处理正确：无 output 或未提供 outputTokens 时不做判定（向后兼容）

**验证逻辑完整性：**
- 低 token + 无文件 → 判定失败 → 触发 handleFailure（重试/升级）
- 高 token → 正常成功 → 触发推进链
- 有文件产出 → 即使 token 低也算成功
- 配置可调（substantiveFailure.minOutputTokens / requireFileOutput）

**测试覆盖：**
- `should detect substantive failure (low tokens, no files)`
- `should not flag as failure when tokens are above threshold`
- `should not flag as failure when files are written`
- `should not flag when output info is missing`
- `should trigger retry after substantive failure detection`

### P0-3：OpenClaw Adapter/Plugin 完整实现 — ✅ 已修复

**修复内容：**

Adapter 层：
- 引入 `GatewayBridge` 接口（spawn/kill/notify），通过依赖注入隔离 Gateway API
- `dispatch()` 调用 `this.bridge.spawn()`，传递 timeoutSeconds/label/metadata（含 acoTaskId）
- `cancelTask()` 通过 taskSessionMap 找到 sessionId，调用 `this.bridge.kill()`
- `notify()` 调用 `this.bridge.notify()`
- 维护 taskId → sessionId 映射，支持可靠的任务取消
- `discoverAgents()` 从 openclaw.json 读取 agent 列表，推断 role/tier

Plugin 层：
- `activate()` 创建 GatewayBridge（桥接 PluginContext.spawn/kill/notify）
- 实例化完整 ACO（Scheduler + TaskBoard + RuleEngine + CompletionChain + HealthMonitor）
- 注册 4 个 hooks：
  - `task:created`：构建 CreateTaskRequest，入队到 ACO Scheduler
  - `task:completed`：桥接 completion 事件到 scheduler.onCompletionEvent，含 outputTokens/filesWritten
  - `agent:idle`：桥接到 scheduler.onAgentFreed
  - `before_prompt_build`：注入 ACO 调度上下文（池状态、忙碌 agent 列表）
- 返回 `AcoPluginInstance`（deactivate/getStatus/triggerSchedule/getACO）

**验证逻辑完整性：**
- Gateway 事件 → Plugin hooks → ACO Scheduler → 调度决策 → Adapter.dispatch → GatewayBridge.spawn → Gateway API
- 这条链路完整闭合，不再是占位实现

**测试覆盖：**
- `OpenClaw Adapter should dispatch via bridge`
- `OpenClaw Adapter should handle bridge unavailable`
- `OpenClaw Adapter should discover agents from config`
- `Plugin should activate and register hooks`
- `Plugin should bridge task:completed to scheduler`
- `Plugin should deactivate cleanly`

### P0-4：CLI 补齐 `aco run` 命令 — ✅ 已修复

**修复内容：**
- 新增命令：`run`、`pool`、`rule list`、`task list`、`task cancel`
- `aco run <prompt>` 从配置读取 agent 池，通过 TierRouter 选择 agent，创建任务并持久化到 task board
- `aco pool` 显示 agent 池状态
- `aco rule list` 显示当前规则
- `aco task list` 显示所有任务详情
- `aco task cancel <id>` 取消指定任务（检查状态是否可取消）
- `aco --help` 列出所有命令
- `aco.config.schema.json` 存在，package.json files 字段包含它

**验证逻辑完整性：**
- `aco run` 完整路径：读配置 → 发现 agents → TierRouter 选择 → 创建任务 → 写入 task board → 输出确认
- help 文本覆盖所有命令
- schema 文件是合法 JSON Schema（draft-07），定义了 level/agents/rules/substantiveFailure 等字段

**测试覆盖：**
- `aco run should create task and persist to board`
- `aco help should list all commands`
- `aco.config.schema.json should exist and be valid JSON`
- `aco pool should display agent pool`
- `aco rule list should display rules`
- `aco task list should display tasks`
- `aco task cancel should cancel a running task`

---

## P1 问题当前状态

| 编号 | 问题 | 状态 | 说明 |
|------|------|------|------|
| P1-1 | 健康监控未接线 | 部分修复 | HealthMonitor 已接入 ACO 主类（register/recordHeartbeat/recordSuccess/recordFailure/onAgentIsolated/onAgentRecovered/filterHealthyAgents）。但 heartbeat timeout 检测结果仍未桥接到 scheduler.onHealthAlert()，即超时检测到了但不会自动标记任务为 stale |
| P1-2 | TaskBoard 安全与归档 | 部分修复 | archive() 方法已实现（过滤终态任务）。文件权限 0o600 仍未设置 |
| P1-3 | 审计日志与通知 | 未修复 | 无 JSONL 持久化审计日志，无 `aco audit` 命令 |
| P1-4 | TierRouter 缺失特性 | 未检查 | 非本次复验范围 |
| P1-5 | RuleEngine 缺失特性 | 未修复 | 无规则热加载，无 `aco rule reload` |
| P1-6 | 保护机制 | 未检查 | 非本次复验范围 |

---

## 附注

- 包名仍为 `@self-evolving-harness/aco`（原审计提到规格写 `aco-orchestrator`），这是命名决策而非代码缺陷
- 测试从 166 个增长到 199 个（+33），新增测试专门覆盖 P0 修复场景
- 代码质量保持一致：TypeScript 严格模式，无 any/ts-ignore 逃逸
