# ACO 架构质量评审报告

OpenClaw（pm-02 子Agent）| 2026-05-06

---

## 评审结论：PASS_WITH_NOTES

ACO 架构文档整体质量高，7 个评审维度中 5 个完全通过，2 个有轻微建议。无 P0 阻断项，可进入编码阶段。

---

## 逐维度评审

### 1. FR 覆盖（31 FR → 架构组件）✅ PASS

架构文档附录提供了完整的 FR 到架构组件追溯矩阵，31 个 FR 全部有对应的架构组件承接：

- 域 A（任务生命周期）：A01-A04 → task-board.ts + scheduler.ts + health-monitor.ts
- 域 B（派发治理）：B01-B05 → rule-engine.ts + rules/builtin/* + rules/loader.ts
- 域 C（资源池）：C01-C04 → agent-slot.ts + tier-router.ts + health-monitor.ts
- 域 D（自动推进）：D01-D04 → completion-chain.ts + scheduler.ts
- 域 E（可观测性）：E01-E04 → task-board.ts + audit-event.ts + adapter.notify() + cli/*
- 域 F（健康恢复）：F01-F04 → health-monitor.ts + AuditLogger.rotate()
- 域 G（配置与渐进式披露）：G01-G03 → scheduler.detectLevel() + adapters/adapter.ts + aco.config.schema.json
- 域 Z（包分发）：Z01-Z04 → package.json + cli/init.ts + cli/demo.ts + plugin/gateway-plugin.ts

无遗漏。每个 FR 的 AC 都能在对应组件的接口定义或运行时流程中找到实现路径。

### 2. NFR 满足 ✅ PASS

6 条 NFR 均有架构层面的保障措施：

| NFR | 架构保障 |
|-----|----------|
| NFR-01 性能 | 事件驱动架构消除轮询开销（ADR-001）；规则引擎首个 block 短路返回；LLM 调用异步不阻塞热路径（ADR-003）；JSON 内存缓存读、原子写仅在变更时触发（ADR-002）；归档机制保持活跃数据集 <100 任务 |
| NFR-02 可靠性 | tmp+rename 原子写入；append-only 审计日志；单规则异常不级联；5s 兜底定时器防事件丢失；内存断路器防 OOM |
| NFR-03 可维护性 | 严格分层依赖（models→rules→adapters→core→cli/plugin）；禁止循环依赖；每个域独立可测试；JSON Schema 配置校验 |
| NFR-04 安全性 | prompt 截断 200 字符；TaskBoard 文件权限 600；敏感字段不写审计日志；输入校验拒绝畸形请求 |
| NFR-05 可移植性 | 无 OS 特定 API；纯 JS/TS 依赖无 native binding；Adapter 接口解耦宿主 |
| NFR-06 分层约束 | Section 2.3 明确映射三层到目录结构，依赖规则强制内层不依赖外层 |

质量属性场景（Section 7）为每条 NFR 提供了具体的刺激-响应-度量三元组，可直接转化为验收测试。

### 3. 边界清晰 ✅ PASS

架构 Section 1.2-1.3 用表格明确定义了四组交互边界：

- **ACO ↔ SEVO**：SEVO 决定"做什么"（阶段推进），ACO 决定"谁做、怎么派"。SEVO 创建任务请求 → ACO 入队执行 → ACO completion 通知 SEVO。职责不重叠。
- **ACO ↔ KIVO**：单向消费关系。ACO 可消费 KIVO 输出的 Agent 能力画像作为路由参考，ACO 不写入 KIVO。
- **ACO ↔ AEO**：ACO 产出运行数据（审计日志、TaskBoard），AEO 消费数据产出洞察，洞察可反馈为 ACO 配置变更。
- **ACO ↔ 宿主**：ACO 定义调度语义，宿主提供执行能力。Adapter 接口（5 个方法）是唯一耦合点。

系统上下文图清晰展示了 ACO 在整体架构中的位置。Adapter 接口设计干净，5 个方法覆盖完整调度生命周期（dispatch/query/cancel/notify/discover）。

### 4. 分层一致 ✅ PASS

三层架构贯穿整个文档：

- **npm 包层**：`src/core/` + `src/models/` + `src/rules/` + `src/cli/` — 通用调度逻辑，所有用户共享
- **宿主适配层**：`src/adapters/` + `src/plugin/` — 每个宿主一套实现，OpenClaw Adapter 内置为默认
- **本地定制层**：`aco.config.json` — 每个部署实例独立配置

依赖规则严格执行分层：
- models 无外部依赖（纯数据）
- rules 依赖 models（不依赖 core）
- adapters 依赖 models（定义 IO 边界）
- core 依赖 models + adapters(接口) + rules
- cli/plugin 依赖 core（最外层）

Section 6.5 的"三问"决策框架为后续开发中的归属判断提供了清晰标准。部署视图（Section 5）分别展示了 Gateway 插件模式和独立运行模式，两种模式都遵循三层架构。

### 5. ADR 合理 ⚠️ PASS_WITH_NOTES

4 个 ADR 质量高，每个都有 Context/Decision/Rationale/Consequences 结构：

- **ADR-001 (Event-Driven)**：对比轮询 vs 事件驱动，选择事件驱动 + 5s 兜底。论证充分（延迟、效率、宿主适配、可靠性）。
- **ADR-002 (JSON File vs SQLite)**：选择 JSON 文件。论证合理（规模适配、零依赖、可调试、原子写入、迁移成本）。明确了重新评估条件。
- **ADR-003 (Rule Engine vs LLM)**：选择规则引擎为主 + LLM 可选增强。边界表清晰，约束明确（LLM 不在热路径上）。
- **ADR-004 (Migration Strategy)**：三阶段渐进迁移，每阶段可独立回滚。功能映射表完整。

**建议补充的 ADR（P1）**：

- **并发事件处理模型**：架构展示了多个事件入口（onTaskEnqueued、onCompletionEvent、onAgentFreed、onHealthAlert），但未说明在 Node.js 单线程环境中如何保证事件处理的串行化。如果两个 completion event 几乎同时到达，`scheduleNext()` 是否需要互斥锁？TaskBoard 的状态流转是否需要乐观锁？建议补充一个 ADR 明确并发控制策略（如：事件队列串行处理 / 微任务级别天然串行 / 显式 mutex）。

### 6. 迁移可行 ✅ PASS

Section 5.5 + ADR-004 提供了完整的迁移方案：

**三阶段设计合理**：
- Phase 1（Shadow）：零风险验证。ACO 并行运行但不执行，对比决策一致性。随时可停。
- Phase 2（Partial）：逐步接管。ACO 接管 TaskBoard 和规则引擎，现有插件降级为 thin wrapper。可回滚到 Phase 1。
- Phase 3（Full）：完全替代。移除现有插件。代码保留可回滚。

**功能映射完整**：
- dispatch-guard 的 AGENT_TIER → tier-router.ts
- dispatch-guard 的 ROLE_TASK_MAP → role-match.ts
- dispatch-guard 的 MAX_CONCURRENT_ACP → concurrency-limit.ts
- run-watchdog 的 STALE_MS/IDLE_ALERT_MS → health-monitor.ts
- local-subagent-board.js → task-board.ts

**兼容性保证**：
- TaskBoard JSON 格式向后兼容
- 审计日志格式只增不删
- CLI 命令不与现有脚本冲突

迁移路径可执行，风险可控。

### 7. 渐进式披露（L0-L3）✅ PASS

Section 4.5 明确定义了四个层级的运行时行为：

| 层级 | 触发条件 | 行为 |
|------|----------|------|
| L0（零配置） | 单 Agent，无 aco.config.json | 基础调度：超时保护 + 失败通知 + TaskBoard 记录。规则引擎只跑内置规则，推进链禁用 |
| L1（基础治理） | 2-5 Agent，默认配置 | 完整规则引擎 + 角色匹配 + 梯队路由 |
| L2（完整治理） | 5+ Agent，自定义配置 | 所有功能启用，含自定义规则和推进链 |
| L3（平台集成） | 自定义 Adapter | 多宿主环境，完整 API |

`detectLevel()` 在 Scheduler 中根据环境自动判定层级，用户无需手动配置。这与 spec FR-G01 的要求完全对应。单 Agent 用户获得基础保护（L0），多 Agent 用户获得完整治理（L1-L2），平台集成方获得最大灵活性（L3）。

---

## 问题清单

### P1（编码前建议修复）

| # | 维度 | 问题 | 建议 |
|---|------|------|------|
| 1 | ADR | 缺少并发事件处理模型的 ADR | 补充 ADR-005，明确多个事件入口的串行化策略。Node.js 单线程 + async/await 天然串行微任务，但 `scheduleNext()` 内部有 await（adapter.dispatch），期间新事件可能触发重入。需要明确是否用事件队列或 mutex 防止重入。 |
| 2 | 组件接口 | LLM 分类器在 RuleEngine 接口中的注入点不明确 | ADR-003 决定了 LLM 作为可选增强，但 RuleEngine 的 TypeScript 接口中没有展示 LLM classifier 的注入方式。建议在 RuleEngine constructor 中增加 `classifier?: TaskClassifier` 可选参数，并在 DispatchContext 中增加 `taskTypeHint?: string` 字段承载缓存的分类结果。 |
| 3 | 组件接口 | 通知批量/静默模式缺少承载组件 | FR-E03 AC4 要求通知频率可配置（实时/批量/静默），但 Adapter 接口只有单条 `notify(event)` 方法。批量聚合逻辑应由 ACO 核心层的 NotificationManager 承担（在 Adapter 之上），而非下推到每个 Adapter 实现。建议在 core/ 中增加 notification-manager.ts。 |
| 4 | 一致性 | Node.js 版本要求不一致 | NFR-05 写"Node.js 18+"，质量属性 Section 7.6 写"Node.js 22+"。建议统一为 18+（更宽泛的兼容性）或 22+（如果使用了 22 特性），并在 package.json engines 字段中锁定。 |

### P2（编码过程中逐步完善）

| # | 维度 | 问题 | 建议 |
|---|------|------|------|
| 5 | 扩展性 | 规则热重载机制未展示 | 质量属性 7.3 声称"Hot-reload without restart"，但 RuleEngine 接口只有 `loadCustomRules(configPath)` 没有 watch 机制。编码时需要在 Scheduler 或 RuleEngine 中加入 config file watcher，检测 aco.config.json 变更后重新加载规则。 |
| 6 | 边界 | 内置推进链与 SEVO 的覆盖关系未在架构中体现 | Spec review 已指出 FR-D01 内置链与 SEVO 流水线有语义重叠。架构中 CompletionChainEngine 应有一个"SEVO 接管时禁用内置链"的机制（如检测 SEVO 插件是否活跃）。编码时在 chain 匹配逻辑中加入 `sevoActive` 条件判断即可。 |
| 7 | 配置 | aco.config.schema.json 的运行时校验入口不明确 | Schema 文件在包根目录，但哪个组件在什么时机执行校验（启动时？CLI doctor？配置变更时？）未明确。建议在 cli/init.ts 和 Scheduler.start() 中都执行 schema 校验。 |
| 8 | 可观测性 | FR-D02 评审产出解析逻辑的归属不明确 | "自动解析 P0/P1 问题"需要理解评审报告格式。这个解析逻辑是 CompletionChain 的 condition 函数？还是独立的 parser 模块？建议在 core/ 中增加 review-parser.ts，被 completion-chain.ts 调用。 |

---

## 总结

ACO 架构文档结构完整、设计决策有据、分层清晰、迁移路径可执行。4 个 P1 建议均为接口细化和一致性修正，不涉及架构重构，预计 1-2 小时可完成补充。4 个 P2 问题可在编码过程中自然解决。

架构质量足以支撑进入编码阶段。
