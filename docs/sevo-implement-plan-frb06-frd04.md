# ACO SEVO 实现计划：FR-B06 + FR-D04

OpenClaw（sa-01 子Agent）| 2026-05-16

---

## Pipeline 信息

- Pipeline ID: 75c55919-fbd4-4fab-ad64-84a8f705c307
- 项目: ACO (Agent Controlled Orchestration)
- 目标 FR: FR-B06 动态角色发现, FR-D04 链路可视化
- Spec: `docs/product-requirements.md` (L252-L275, L349-L358)
- 架构契约: `docs/contract-frb06-frd04.md`
- 当前阶段: contract-review-gate → implement

---

## 实现任务拆分

### Task 1: FR-B06 动态角色发现

**文件**: `src/dispatch/role-discovery.ts`

**待实现 AC**:
- AC1: 支持宿主配置中的可选 `role` 字段，合法值为 `"coding" | "pm" | "architecture" | "review" | "ux" | "research"`
- AC2: 启动时从宿主配置动态构建 ROLE_AGENTS 和 ROLE_TASK_MAP，禁止硬编码 Agent ID
- AC3: 渐进式降级——单 Agent→skip；多 Agent 无 role→warn；有 role→enforce
- AC4: AGENT_TIER 支持从配置显式声明或根据 runtime.type 自动推断
- AC5: 配置变更后自动刷新角色映射和梯队信息
- AC6: 动态构建的映射关系写入启动日志

**依赖**:
- `src/adapter/openclaw-adapter.ts` 的 `discoverAgents()` 方法（已实现）
- `src/event/event-bus.ts`（已实现）
- `src/types/index.ts` 中的 `DiscoveredAgent`, `RoleTag`, `Tier` 类型（已定义）

**集成点**:
- `src/dispatch/rule-engine.ts` 需要在规则评估时调用 `RoleDiscovery.checkRoleMatch()`
- `src/dispatch/index.ts` 需要导出 RoleDiscovery

**测试文件**: `src/dispatch/__tests__/role-discovery.test.ts`

---

### Task 2: FR-D04 链路可视化

**文件**:
- `src/chain/chain-visualizer.ts`（新建）
- `src/cli/commands/chain.ts`（扩展，新增 status 子命令）

**待实现 AC**:
- AC1: CLI 命令 `aco chain status <executionId>` 展示链路中每个节点的状态
- AC2: 输出包含每个节点的执行时间、agentId、产出摘要
- AC3: 支持查看历史已完成的 chain 执行记录
- AC4: 输出格式支持 tree（终端友好）和 JSON（程序消费）

**依赖**:
- `src/chain/chain-executor.ts`（已实现，需暴露 `getExecution()` 和 `listExecutions()` 访问器）

**对 chain-executor.ts 的改动**:
- 新增公开方法 `getExecution(executionId: string): ChainExecution | undefined`
- 新增公开方法 `listExecutions(): ChainExecution[]`
- 新增 `chain_completed` 审计事件（用于历史记录持久化）

**测试文件**: `src/chain/__tests__/chain-visualizer.test.ts`

---

## 实现顺序

1. **Task 1 先行**：role-discovery.ts + 单测 + dispatch/index.ts 导出
2. **Task 2 跟进**：chain-executor.ts 新增访问器 → chain-visualizer.ts + CLI status 子命令 + 单测
3. **集成验证**：`npm run build` 通过 + `npm test` 全部通过

---

## 编码约束

1. 匹配项目现有风格：ESM、vitest、类+依赖注入、EventBus 审计
2. 禁止硬编码 Agent ID（FR-B06 核心约束）
3. 禁止引入新 npm 依赖
4. 每个 AC 至少一个单测覆盖
5. 所有新增公开 API 必须在 `src/dispatch/index.ts` 或 `src/chain/index.ts` 中导出
6. 代码注释标注对应 FR/AC 编号
