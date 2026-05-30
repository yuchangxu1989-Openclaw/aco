# ACO 代码审计报告

OpenClaw（audit-02 子Agent）｜2026-05-06

## 总体评价：FAIL

代码基础质量不错：TypeScript 严格模式开启，源码里没有发现 `any`/`@ts-ignore` 逃逸，`npm test` 166 项全绿，`npm run build` 通过，TaskBoard 和 Scheduler 的串行化思路也成立。

当前版本还不能判定为“规格已完整落地”。我确认了几个会直接影响产品行为的缺口：失败重派链跑不通、成功完成没有做实质成功判定、OpenClaw 插件/Adapter 还是占位实现、CLI/分发面严重缺项。这些问题已经超过“优化建议”的级别。

审计时复验结果：
- `npm test`：8 个测试文件，166 个测试通过
- `npm run build`：通过
- `npm pack --dry-run`：成功，但包内容暴露出分发面缺口（见 P1-2）

---

## P0 问题（必须修复）

### P0-1：失败升级/重派链实际走不起来

证据：
- `src/scheduler/scheduler.ts:352` 只查询 `queued` 任务进入调度循环。
- `src/scheduler/scheduler.ts:484-508` 失败后把任务状态改成 `retrying`，并注释写着“通过 scheduleNext 自动处理”。
- `src/types/task.ts:64-72` 允许 `failed -> retrying -> running`，说明设计上确实希望 `retrying` 能重新派发。

结果：
- 失败后的任务会停在 `retrying`，不会再被 `scheduleNext()` 选中。
- FR-C03、FR-D04 的核心承诺没有成立。
- 测试只断言状态可能是 `failed` 或 `retrying`（`src/scheduler/scheduler.test.ts:456-474`），没有验证 retrying 之后真的重新跑起来，所以这个缺口被测试漏掉了。

影响：
- 自动升级梯队、即时重派、失败恢复这三条主链路在运行时会卡死。

### P0-2：完成事件没有做“实质成功”判定，假成功会直接触发推进链

证据：
- `src/scheduler/scheduler.ts:196-239` 收到 completion 后，直接把传入的 `status` 写进 TaskBoard。
- 同一段代码只把 `outputTokens` 挂到事件里，没有做阈值校验，也没有检查文件产出。
- `status === 'succeeded'` 时会立刻触发 `triggerChain(task)`。
- 规格 FR-A03 明确要求：`output_tokens < 3000` 且未写文件，要判定为实质失败。

结果：
- 低质量空产出、短回复、假完成都会被标成 `succeeded`。
- 审计链、smoke test 链、视觉验证链会在错误前提上继续推进。

影响：
- 这会直接污染 TaskBoard 状态，放大误报，破坏自动推进可靠性。

### P0-3：OpenClaw 宿主集成还没落地，插件和 Adapter 目前是占位实现

证据：
- `src/adapters/openclaw/openclaw-adapter.ts:124-138` 的 `dispatch()` 没有调用 `sessions_spawn` / Gateway API，只是返回一个伪造的 `sessionKey`。
- `src/adapters/openclaw/openclaw-adapter.ts:162-173` 的 `cancelTask()`、`notify()` 是 no-op。
- `src/adapters/openclaw/openclaw-adapter.ts:188-219` Gateway completion 事件没有把 `taskId` 建回来，只有 `agentId` 和 status，无法可靠映射任务。
- `src/plugin/plugin.ts:82-177` 插件只注册事件并打印日志，没有实例化 ACO，也没有调用 Scheduler、TaskBoard、RuleEngine、CompletionChain。
- `src/plugin/plugin.ts:107-114` prompt 注入只塞了一句固定字符串。
- `src/plugin/plugin.ts:156-176` 对 `task:created` / `task:completed` / `agent:idle` 的处理只有日志，没有调度动作。

结果：
- FR-G02、FR-Z04 的宿主插件模式没有真正可用。
- 当前代码能“模拟 ACO”，还不能“接管 OpenClaw 调度”。

影响：
- 这是产品主价值链。宿主接不起来，npm 包的核心卖点就没落地。

### P0-4：CLI 与分发面离规格差距过大，当前包不满足宣称的产品入口

证据：
- `src/cli/cli.ts:71-84` 只支持 `init / demo / status / dispatch`。
- `src/cli/cli.ts:270-280` help 里也只有这 4 个命令。
- 规格 FR-Z01 要求：`pool / audit / rule list/add/remove/reload / task list/cancel / doctor`。
- `package.json:2` 当前包名是 `@self-evolving-harness/aco`，规格写的是 `aco-orchestrator`。
- `src/cli/cli.ts:30-36` 默认配置引用 `./aco.config.schema.json`。
- `package.json:20-23` 也声明要把 `aco.config.schema.json` 打进包。
- 实际仓库里这个文件不存在；`npm pack --dry-run` 输出里也没有它。

结果：
- CLI 入口不完整。
- 初始化出来的配置自带一个失效的 `$schema` 路径。
- 包名、命令面、schema 交付面都和规格不一致。

影响：
- 这会直接影响陌生用户的首次使用路径，FR-Z01 / Z02 / Z03 无法算通过。

---

## P1 问题（建议修复）

### P1-1：健康监控模块有能力，主运行时没有接上线

证据：
- `src/health-monitor/health-monitor.ts` 具备 heartbeat 检测、隔离恢复、资源告警能力。
- `src/aco.ts:89-117` 启动时只做了 `onAgentIsolated` / `onAgentRecovered` 两个池状态回调。
- 代码里没有把 `checkHeartbeats()` 的 stale/timeout 结果桥接到 `scheduler.onHealthAlert()`。
- 代码里也没有设置 `setProbeCallback()`、`setResourceMonitor()`。
- `rg` 结果表明 `scheduler.onHealthAlert()` 只在测试里显式调用，没有生产接线。

影响：
- FR-C04、FR-F01、FR-F02、FR-F04 目前更多停留在库能力层，没有形成完整闭环。

### P1-2：TaskBoard 安全与归档策略没有达到规格要求

证据：
- `src/task-board/task-board.ts:299-308` 原子写做了，但没有设置文件权限 600。
- 规格 NFR-04 明确要求 Task Board 文件权限 owner 读写。
- `src/task-board/task-board.ts:84` 有 `archiveThreshold` 配置。
- 整个类里没有自动归档逻辑，也没有“保留 24 小时后归档到历史文件”的实现。

影响：
- FR-E01 AC6、NFR-04 没有落地完。

### P1-3：审计日志与通知通道还没接起来

证据：
- 代码里没有独立的 audit logger 模块，也没有 JSONL 落盘实现。
- `src/scheduler/scheduler.ts` 会 emit 事件，但没有持久化这些事件。
- CLI 没有 `aco audit`。
- Adapter 的 `notify()` 是 no-op。

影响：
- FR-E02 基本缺失。
- FR-E03 只有接口，没有端到端行为。

### P1-4：规则引擎只实现了部分内置规则，且默认工厂未装配任何内置规则

证据：
- `src/rule-engine/rule-engine.ts` 只实现了 `RoleMatchRule / ConcurrencyLimitRule / TimeoutDefaultRule / SeparationOfDutyRule`。
- 规格 FR-B01 AC2 要求的 `agent-exists / prompt-non-empty / no-main-dispatch` 没有实现。
- `src/aco.ts:209-213` `createACO()` 创建 `RuleEngine` 后，只在 `options.rules` 存在时 addRules；默认没有加载任何内置规则。

影响：
- 默认实例下，规则治理能力比规格和 README 宣传都弱。

### P1-5：Adapter / Plugin 缺少专门测试，关键宿主缺口没有被测试网住

证据：
- 当前测试文件只有 8 个：TaskBoard / CLI / ACO / HealthMonitor / RuleEngine / CompletionChain / TierRouter / Scheduler。
- 没有 `openclaw-adapter.test.ts`。
- 没有 `plugin.test.ts`。

影响：
- 166 测试全绿能证明核心库单元质量，证明不了宿主集成可用性。

### P1-6：部分规格细节只做了简化版

例子：
- `src/completion-chain/completion-chain.ts:259-317` 内置链存在，但 FR-D02 要求的 P0/P1 解析、复验循环、最多 3 轮闭环都没做实。
- `src/rule-engine/rule-engine.ts:309-340` 职责分离规则依赖 `metadata.parentAgentId`，没有按规格去查 TaskBoard 历史。
- `src/adapters/openclaw/openclaw-adapter.ts:275-280` 读取配置失败直接降级为空 Agent 列表，缺少显式错误暴露与重试策略。

---

## P2 问题（可选优化）

### P2-1：Node 版本口径不一致

证据：
- `package.json:6-8` 要求 Node `>=22.0.0`
- 规格 NFR-05 写的是 Node.js 18+

### P2-2：规格文档里的 FR 数量和任务描述不一致

我复核 `docs/product-requirements.md`，当前实际是 32 个 FR 编号：
- A01-A04
- B01-B05
- C01-C04
- D01-D04
- E01-E04
- F01-F04
- G01-G03
- Z01-Z04

本次任务描述写的是 31 个 FR。这个是文档/任务口径问题，代码不受影响，但建议统一。

---

## 类型安全、接口一致性、错误处理、并发安全、测试覆盖结论

### 类型安全

通过。
- `tsconfig.json` 开启 strict。
- 源码未发现 `any`、`@ts-ignore` 逃逸。
- 只看到一处保守的 `eslint-disable-next-line`，位置在 `TimeoutDefaultRule` 的保留参数上，风险可接受。

### 接口一致性

大体通过，有局部落空。
- 核心模块导入导出关系清楚，`src/index.ts` 汇总完整。
- `Adapter`、`Rule`、`CompletionChain`、`TaskBoard`、`HealthMonitor` 的边界都清晰。
- 真正的问题在“接口定义有了，宿主实现没接满”。

### 错误处理

中等。
- TaskBoard 的错误类型、状态机校验、原子写都做了。
- Scheduler 事件队列里对单次 handler 异常做了隔离。
- 宿主集成侧的错误处理偏弱，很多地方直接 no-op 或静默降级。

### 并发安全

核心思路正确。
- TaskBoard 用 Promise 链串行化写入。
- Scheduler 用事件队列串行化入口。

我确认的主要问题不在竞态，而在状态机断链：`retrying` 没有重新进入调度源集合。

### 测试覆盖

基础覆盖扎实，集成覆盖不够。
- 166 个测试对核心类覆盖度不错。
- Plugin/Adapter 没有专门测试。
- 失败重派只测到“进入 retrying”，没测到“retrying 再次派发成功”。
- 实质失败判定没有测试，因为实现本身就没有。

### 安全

部分通过。
- 没看到明显路径拼接注入风险。
- 配置读取是本地 JSON 读取，行为简单。
- TaskBoard 文件权限 600 未落实。
- 审计日志敏感信息脱敏要求目前也没有实现，因为审计日志模块本身还没落地。

---

## FR 覆盖矩阵

我按当前 `product-requirements.md` 实际的 32 个 FR 做核对。

### 域 A：任务生命周期

- FR-A01：**部分覆盖**
  - 已有：必填字段校验、timeout 下限、唯一 taskId、Task Board 写入、可选字段支持。
  - 缺口：没有校验 `agentId` 是否真的存在于宿主 Agent 列表。

- FR-A02：**部分覆盖**
  - 已有：优先级 + FIFO、Adapter 抽象、成功进 running、失败进 failed。
  - 缺口：规则阻断后的回队/失败策略不完整；busy 等待主要依赖 Agent 选择，没有单独审计记录。

- FR-A03：**部分覆盖**
  - 已有：completion 更新状态、写入摘要、触发推进链、记录时长事件。
  - 缺口：没有实质成功判定；会把假成功推进下去。

- FR-A04：**部分覆盖**
  - 已有：`onHealthAlert()` 可把 running 任务转 stale/failed。
  - 缺口：没有 CLI/API 取消入口；没有真正通过 Adapter 终止运行任务；超时监控没有接线上。

### 域 B：派发治理

- FR-B01：**部分覆盖**
  - 已有：优先级执行、首个 block 短路、自定义规则接口、warn 支持。
  - 缺口：缺少 `agent-exists`、`prompt-non-empty`、`no-main-dispatch`；没有审计事件持久化。

- FR-B02：**部分覆盖**
  - 已有：`requiredRole` 匹配规则、别名映射、可插入 LLM 分类器接口。
  - 缺口：没有 prompt 自动分类落地；没有单 Agent 降级为 warn 的行为。

- FR-B03：**部分覆盖**
  - 已有：职责分离规则存在。
  - 缺口：规则依赖 metadata，没按规格查询 TaskBoard 历史；没有单 Agent 降级逻辑。

- FR-B04：**部分覆盖**
  - 已有：全局并发、按 runtime type 并发、单 Agent busy 约束。
  - 缺口：`aco status` 没有展示并发数/上限；配置热生效没有完整实现。

- FR-B05：**缺失**
  - 没有主会话硬阻断规则，也没有耗时命令黑名单治理。

### 域 C：资源池管理

- FR-C01：**部分覆盖**
  - 已有：从 `openclaw.json` 发现 Agent、推断 role/tier/runtime。
  - 缺口：没有配置变更 watcher；没有 `aco pool` 资源池视图。

- FR-C02：**部分覆盖**
  - 已有：成本优先、默认梯队、LRU 选择、失败后可升级。
  - 缺口：路由审计日志没落盘。

- FR-C03：**部分覆盖**
  - 已有：升级决策接口、排除失败 Agent、最大重试上限。
  - 缺口：`retrying` 不会再被调度；没有 prompt 优化；没有最终失败通知闭环。

- FR-C04：**部分覆盖**
  - 已有：HealthMonitor 库能力齐。
  - 缺口：对 running 任务的活跃信号监测没有接线；ACP 进程存活检查未实现。

### 域 D：自动推进链

- FR-D01：**部分覆盖**
  - 已有：声明式链、内置链、模板变量、跳过条件。
  - 缺口：链执行审计日志未落盘。

- FR-D02：**部分覆盖**
  - 已有：有一个简化版 `review -> fix` 内置链。
  - 缺口：没有解析 P0/P1 列表、没有复验循环、没有最多 3 轮闭环。

- FR-D03：**部分覆盖**
  - 已有：completion 到达后立即进入串行事件队列，并继续调度。
  - 缺口：没有显式的“扫描其他已完成任务未处理项”逻辑，也没有 5 秒 SLA 保障代码。

- FR-D04：**部分覆盖**
  - 已有：失败后会立即进入 `handleFailure()`。
  - 缺口：重派链断在 `retrying`；没有失败原因分析与策略分流。

### 域 E：可观测性

- FR-E01：**部分覆盖**
  - 已有：JSON 持久化、状态/Agent/label/parent/priority 查询。
  - 缺口：没有时间范围筛选；没有 24 小时归档历史；`aco status` 也没输出“最近完成/最近失败”。

- FR-E02：**缺失**
  - 没有 JSONL 审计日志、没有轮转、没有 `aco audit`。

- FR-E03：**部分覆盖**
  - 已有：NotificationManager 抽象、Adapter.notify 接口、批量/静默概念。
  - 缺口：运行时没有真正发送通知，也没有飞书/终端的端到端接线。

- FR-E04：**缺失**
  - 没有 `aco pool`，也没有 JSON 输出。

### 域 F：健康与恢复

- FR-F01：**部分覆盖**
  - 已有：heartbeat 检测、隔离、告警能力。
  - 缺口：stale 任务自动进入 Scheduler 失败处理流程没有真正接线；熔断释放 Slot 依赖外部调用。

- FR-F02：**部分覆盖**
  - 已有：资源阈值检测能力。
  - 缺口：没有断路器状态，没有“暂停新任务派发/恢复派发”的调度层动作。

- FR-F03：**部分覆盖**
  - 已有：启动时会 `taskBoard.load()`，queued 任务随后能继续进入调度。
  - 缺口：没有 orphan running 识别、没有恢复审计日志、没有“10 秒内恢复完成”的宿主集成保证。

- FR-F04：**部分覆盖**
  - 已有：CPU 阈值检测能力。
  - 缺口：没有 ACP-only 限流、没有 `aco status` 暴露保护状态。

### 域 G：配置与渐进式披露

- FR-G01：**部分覆盖**
  - 已有：L0 默认配置模板、可注入更高层配置。
  - 缺口：没有 level 自动判定逻辑；单 Agent 降级治理没有完整体现。

- FR-G02：**部分覆盖**
  - 已有：Adapter interface、OpenClawAdapter 类型定义。
  - 缺口：OpenClawAdapter 的 dispatch/cancel/notify 关键方法没落地；宿主自动检测没有实现。

- FR-G03：**缺失**
  - 没有规则热加载；CLI 也没有 `aco rule reload`。

### 域 Z：包分发与开箱体验

- FR-Z01：**缺失**
  - CLI 命令集不完整；包名与规格不一致；schema 文件未交付；plugin 分发面也不完整。

- FR-Z02：**部分覆盖**
  - 已有：`aco init` 创建配置并给出下一步提示。
  - 缺口：没有宿主环境检测、自动注册插件、角色分配表、单 Agent 降级、`aco doctor`。

- FR-Z03：**部分覆盖**
  - 已有：`aco demo`。
  - 缺口：没有 `--dry-run` 分支、没有失败修复指引闭环、没有真实首任务调度路径。

- FR-Z04：**缺失**
  - 插件没有拦截 `sessions_spawn/subagents`，没有在 tool-call 阶段做准入校验，也没有和核心库形成共享闭环。

---

## 最终结论

当前版本有“库雏形可用、产品闭环未完成”的特征。

如果目标是“代码质量基础是否健康”，答案是健康：类型纪律好，核心模块结构清楚，测试习惯也到位。

如果目标是“ACO 已按规格完成并可作为 OpenClaw 宿主调度中枢发布”，答案是否定的。P0 问题修完前，不建议把这个版本标成完成态。

我建议下一步按这个顺序修：
1. 先修 `retrying` 重派断链。
2. 补上 completion 的实质成功判定。
3. 把 OpenClaw Adapter 和 Plugin 真正接到 Gateway 调度链上。
4. 补齐 CLI/doctor/pool/audit/rule/task 命令与 schema 分发。
5. 最后补宿主集成测试，把这几个主链路锁住。
