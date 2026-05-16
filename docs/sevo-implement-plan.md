# ACO SEVO 实现计划

OpenClaw（pm-01 子Agent）| 2026-05-07

---

## 阶段判定：进入 Implement 阶段（续建模式）

ACO 项目当前状态并非"尚未开始实现"，而是已完成主体实现并通过 P0/P1 代码审计。正确的判定是：**以续建模式进入 Implement 阶段，聚焦于关闭剩余 FR 覆盖缺口**。

### 当前实现状态

| 指标 | 数值 |
|------|------|
| 源文件 | 54 个 TypeScript 文件 |
| 测试 | 277 passing / 10 failing |
| 编译 | tsc 零错误 |
| 审计 | P0 + P1 全量复验通过 |
| 模块覆盖 | 10/10 核心模块已实现 |

### Spec 门禁评估

| 门禁项 | 状态 | 说明 |
|--------|------|------|
| FR 完整性 | ✅ | 8 域 + Z 域，~30 个 FR，171 条 AC |
| AC 可验证性 | ✅ | 每条 AC 有明确的验证条件 |
| 概念架构 | ✅ | 部署形态、核心组件、数据流转、持久化策略均已定义 |
| 模块边界 | ✅ | ACO vs SEVO/KIVO/AEO/宿主环境边界清晰 |
| NFR | ✅ | 性能、可靠性、安全性、兼容性、可观测性均有量化指标 |
| 约束与假设 | ✅ | 明确列出 |

结论：Spec 质量满足 Implement 门禁要求。

---

## 差距分析

基于 spec 全部 FR 逐条对照当前代码，识别出以下未实现或部分实现的功能：

### 已完整实现的域

| 域 | FR 覆盖 | 说明 |
|----|----------|------|
| A：任务生命周期 | FR-A01~A05 全覆盖 | TaskBoard + Scheduler + 状态机 |
| B：派发治理 | FR-B01~B05 全覆盖 | RuleEngine + 6 条内置规则 + 熔断 |
| C：资源池管理 | FR-C01~C04 全覆盖 | ResourcePool + TierRouter |
| D：自动推进链 | FR-D01~D04 全覆盖 | CompletionChain + 条件/循环/可视化 |
| G：健康与恢复 | FR-G01~G04 全覆盖 | HealthMonitor + StallDetector |

### 存在缺口的域

| 域 | 缺口 | 严重度 |
|----|------|--------|
| E：可观测性 | FR-E01（审计日志）已实现；FR-E02（看板 watch 模式）、FR-E03（资源利用率统计）、FR-E04（决策溯源）CLI 层面未完整暴露 | P1 |
| F：通知与 IM 推送 | FR-F01~F04 全部未实现（无 notification 模块） | P0 |
| H：配置与渐进式披露 | FR-H01（零配置启动）CLI 层有基础实现；FR-H02（热加载）、FR-H03（校验提示）、FR-H04（渐进式启用）未实现 | P1 |
| Z：包分发 | FR-Z01（init）已实现；FR-Z02（CLI 完整子命令）部分缺失；FR-Z03（库 API）已实现；FR-Z04（Adapter）已实现；FR-Z05（版本升级）未实现 | P1 |

### 其他缺口

| 问题 | 严重度 | 说明 |
|------|--------|------|
| 10 个 stall-detector 测试失败 | P1 | 测试用例使用 timeout < 600s，与 TaskBoard 校验冲突 |
| CLI 缺少 chain/audit/notify/stats/health/config 子命令 | P1 | spec FR-Z02 要求完整 CLI |
| 无 README 快速上手指引 | P2 | 开箱即用门禁要求 |

---

## 分批实现计划

### 依赖关系图

```
Wave 1（基础设施修复）
  └── 修复 10 个失败测试
  └── 补齐 types/notification.ts

Wave 2（P0 缺口：通知系统）← 最高优先级
  └── FR-F01：通知渠道注册
  └── FR-F02：事件订阅过滤
  └── FR-F03：通知内容模板
  └── FR-F04：通知送达确认
  └── 依赖：Wave 1 的类型定义

Wave 3（P1 缺口：配置管理）
  └── FR-H02：配置热加载
  └── FR-H03：配置校验与提示
  └── FR-H04：渐进式功能启用
  └── 无强依赖，可与 Wave 2 并行

Wave 4（P1 缺口：可观测性完善 + CLI 补齐）
  └── FR-E02：看板 watch 模式
  └── FR-E03：资源利用率统计
  └── FR-E04：决策溯源
  └── FR-Z02：补齐 CLI 子命令（chain/audit/notify/stats/health/config）
  └── 依赖：Wave 2（notify CLI 需要通知模块）、Wave 3（config CLI 需要配置模块）

Wave 5（收尾：版本升级 + 文档 + 开箱体验）
  └── FR-Z05：版本与升级（数据迁移）
  └── README 快速上手
  └── npx aco init 端到端验证
  └── 依赖：Wave 1~4 全部完成
```

---

### Wave 1：基础设施修复（预估 1 个任务，600s）

**目标**：修复 10 个失败测试，确保 CI 全绿。

| 任务 | 内容 | Agent 建议 |
|------|------|------------|
| W1-1 | 修复 stall-detector 测试：将测试中 timeout 值改为 >= 600s，或在测试中 mock TaskBoard 绕过校验 | 编码 Agent（T2+） |

**验收标准**：`npm test` 全部通过（287/287）。

---

### Wave 2：通知系统（预估 2-3 个任务，1200s/任务）

**目标**：实现 Domain F 全部 4 个 FR。

| 任务 | FR | 内容 | Agent 建议 |
|------|-----|------|------------|
| W2-1 | FR-F01 + FR-F02 | 实现 NotificationManager：渠道注册（飞书/Telegram/Discord/Slack/Webhook）、事件订阅过滤、本地队列缓冲 | 编码 Agent（T1） |
| W2-2 | FR-F03 + FR-F04 | 实现通知模板（Handlebars）、送达确认与重试、与 Scheduler 事件总线对接 | 编码 Agent（T1） |

**验收标准**：
- 通知模块有独立测试覆盖
- `aco notify add --type webhook --config '{"url":"..."}'` 能注册渠道
- 任务状态变更自动触发通知推送
- 送达失败自动重试（最多 3 次）

---

### Wave 3：配置管理（预估 1-2 个任务，1200s/任务）

**目标**：实现 Domain H 的 FR-H02~H04。

| 任务 | FR | 内容 | Agent 建议 |
|------|-----|------|------------|
| W3-1 | FR-H02 + FR-H03 | 实现 ConfigManager：fs.watch 热加载、JSON Schema 校验、错误提示与修复建议 | 编码 Agent（T2） |
| W3-2 | FR-H04 | 实现渐进式功能启用：L0~L4 分层、`aco feature enable` 命令、功能开关 | 编码 Agent（T2） |

**验收标准**：
- 修改配置文件后无需重启即生效
- `aco config validate` 输出明确的错误信息和修复建议
- `aco feature enable notification` 生成通知配置模板

---

### Wave 4：可观测性 + CLI 补齐（预估 2 个任务，1200s/任务）

**目标**：补齐 Domain E 的 CLI 暴露和 FR-Z02 的完整子命令。

| 任务 | FR | 内容 | Agent 建议 |
|------|-----|------|------------|
| W4-1 | FR-E02~E04 | 实现 `aco board --watch`、`aco stats --period 24h`、`aco task history <taskId>` | 编码 Agent（T2） |
| W4-2 | FR-Z02 | 补齐 CLI 子命令：chain status、audit query、notify add/list、health、config validate/reload | 编码 Agent（T2） |

**验收标准**：
- `aco --help` 展示所有 spec 定义的子命令
- `aco board --watch` 每 5 秒刷新
- `aco stats --period 24h` 输出利用率统计
- 所有子命令支持 `--json` 输出

---

### Wave 5：收尾与开箱体验（预估 2 个任务，1200s/任务）

**目标**：版本升级机制 + 文档 + 端到端验证。

| 任务 | FR | 内容 | Agent 建议 |
|------|-----|------|------------|
| W5-1 | FR-Z05 | 实现版本升级：数据格式迁移、自动备份、回滚机制 | 编码 Agent（T2） |
| W5-2 | 开箱体验 | README 快速上手、`npx aco init` 端到端测试、陌生人走查准备 | 编码 Agent（T2） |

**验收标准**：
- `npm update` 后自动迁移数据
- README 30 秒快速体验路径可走通
- `npx aco init && aco task create --label test --prompt "hello" --timeout 600` 完整流程跑通

---

## 并行策略

- Wave 1 必须先完成（全绿基线）
- Wave 2 和 Wave 3 可并行（无依赖）
- Wave 4 依赖 Wave 2 + Wave 3（CLI 需要底层模块）
- Wave 5 依赖 Wave 1~4

最优路径：
```
时间线 →
Agent A: [Wave 1] → [Wave 2-1] → [Wave 2-2] → [Wave 4-1]
Agent B:           → [Wave 3-1] → [Wave 3-2] → [Wave 4-2] → [Wave 5-1]
Agent C:                                                    → [Wave 5-2]
```

预估总工时：双 Agent 并行约 4-5 轮调度（每轮 20min），总计 ~2 小时完成全部缺口。

---

## 完成后的 SEVO 流程

1. 全部 Wave 完成 → 自动触发代码审计（audit-01）
2. 审计通过 → smoke test（编码 Agent）
3. smoke test 通过 → 陌生人走查（ux-01）
4. 走查通过 → npm publish
5. publish 后 → 终局差距扫描
6. 差距为零 → 闭环
