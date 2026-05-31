# ACO — Agent Runtime Governance

> 多 Agent 运行时治理。管的是执行起来之后的事：谁在跑、卡没卡死、失败了该怎么补。

[![npm version](https://img.shields.io/npm/v/%40self-evolving-harness%2Faco.svg)](https://www.npmjs.com/package/@self-evolving-harness/aco)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](./package.json)

多 Agent 一跑起来就容易乱。任务卡死没人管，输出空壳却报成功，同一个失败反复重试，几个 Agent 抢同一个文件，主会话被一条耗时命令占住动不了。这些都是执行层的问题，prompt 里写再多规矩也兜不住。

ACO 把这层接管过来。它在 OpenClaw Gateway 之上加一道运行时治理面：派活之前先判断给谁，跑的过程盯着别卡死，失败之后告诉你下一步该怎么走。

最值得说的一点：失败发生后，ACO 帮你判断该换人、拆任务、补上下文，还是升级执行层级，而不是把同样的活原样再扔一遍。

## Quick Start

### 1. 安装

```bash
npm install -g @self-evolving-harness/aco
```

### 2. 初始化规则

```bash
aco init
```

这一步会探测你的 OpenClaw 环境，在 `~/.openclaw/extensions/aco-rules/rules.json` 生成初始规则集。

### 3. 跑一遍本地演示

```bash
aco demo
```

`aco demo` 不依赖任何 provider，把完整生命周期打印出来：Agent 注册、任务提交、规则拦截、派发、重试、完成总结。失败重派那一段也在里面，可以直接看到一次失败之后 ACO 怎么决策。

## 三个最值得放大的机制

官网过去把 ACO 讲成"调度器"，源码里真正有含量的是下面三个。每个都能在仓库里找到对应实现。

### Failure Attribution — 失败归因

失败之后，最难的不是重试，是判断这次失败到底怪谁。Agent 能力不够，还是任务本身没说清、太大、缺依赖？

`FailureTracker`（`src/stats/failure-tracker.ts`）做的就是这件事。每次失败记一条结构化记录：哪个 Agent、什么任务类型、什么失败模式（zero-output / timeout / error-output / no-file-written / crash）、跑了多久、产出多少 token。然后做 agent-fault 和 task-fault 的二分判定：

- 零输出、崩溃 → 大概率 agent-fault
- 长 prompt 还超时 → 任务太复杂，task-fault
- 短时间内没写文件 → Agent 没认真干，agent-fault
- 同类任务换别的 Agent 也失败 → 怪任务不怪人，task-fault

判完之后给修复建议：agent-fault 给 `switch-agent`、`upgrade-tier`；task-fault 给 `split-task`、`add-context`。同一个 Agent 反复失败时，`generateCircuitBreakReport()` 还能把近期记录聚合成一份根因报告，交给熔断机制联动处理。

### Kill Impact Scan — 可审计的 kill

杀掉一个卡死的会话很简单，难的是杀完之后不知道它在工作区里留下了什么。改了一半的文件、写了一半的任务板，都可能是隐患。

`kill-impact-scan.ts`（`src/control/kill-impact-scan.ts`）把 kill 做成可审计的动作：kill 之前对脏工作区文件做快照，kill 之后再扫一遍，比对出这个会话碰过哪些文件、改了任务板哪些条目，然后定风险等级（low / medium / high）并给出建议动作（safe_to_proceed / review_diff / consider_stash_first）。全程不跑 LLM、不回滚、不 stash，只做确定性的快照比对和风险报告。

命令行直接可用：

```bash
aco audit kill-impact
```

### Rule-based Dispatch — 规则化派发

多 Agent 并行最常见的翻车是互相覆盖、抢任务、乱改文件。靠每个 Agent 自觉记规矩是兜不住的。

ACO 用 `rule-engine.ts`（`src/control/rule-engine.ts`）把经验变成可执行的治理策略：按优先级跑规则，命中即短路，每次执行都留执行日志和审计事件。派活的时候按任务类型、角色匹配度、梯队、超时纪律、当前负载来决定给谁，coding 的活走 coding 通道，审计独立出去，避免一个忙 Agent 悄悄变成全局瓶颈。

## 失败重派：不原样重试

`failure-redispatch.ts`（`src/control/failure-redispatch.ts`）落的是一条铁律：每次重派至少要做到三件事之一——升级梯队、优化 prompt、拆分任务。原样把失败的活再扔回去这种事不允许发生。

判定逻辑很直接。output token 低于阈值（默认 3000）且没写任何文件，算实质失败，任务可能太复杂，建议拆分。同梯队连续失败到了阈值，往上升一级（T4 → T3 → T2 → T1）。选重派目标时优先排除上次失败的那个 Agent。已经在最高梯队还失败，就转去优化 prompt 或拆任务，重试次数耗尽（默认 3 次）就停下来给出耗尽原因，不无限重试。

## 接管 OpenClaw Gateway

ACO 不自己造执行引擎，它把 OpenClaw Gateway 的会话能力接管成可治理的运行时。`openclaw-adapter.ts`（`src/adapter/openclaw-adapter.ts`）对接 Gateway 的 sessions API：

- `spawnTask` → `POST /api/v1/sessions/spawn`：派发新任务
- `killTask` → `POST /api/v1/sessions/{id}/kill`：kill 时自动触发 kill impact scan，返回影响报告
- `steerTask` → `POST /api/v1/sessions/{id}/steer`：给运行中的会话发指令
- `getStatus` / `getState` → 查会话状态和快照

这一层把 OpenClaw 从"能起会话"升级成"会话可派、可杀、可观测、可审计"。

## Live Task Board in Your IM

任务板不会被关在一个你得记得打开的 dashboard 后面。ACO 的 watchdog 插件在任务状态变化时，把实时看板卡片直接推到你的 IM，运行全貌主动找上你。

![Task board card pushed to Feishu](docs/assets/feishu-task-board-card.jpg)

上面这张卡片是真实的多 Agent 工作现场：7 个 Agent 并行、186 个任务完成，当前在跑的、刚结束的任务和当天统计都在上面。每次状态变化都直接推到聊天里，不用轮询、不用刷新、不用切上下文。

零配置。watchdog 从运行时状态里自动发现你的 IM 身份，不用配 open_id，不用注册 webhook，不用额外步骤。装上 ACO、跑你的 Agent，看板就开始推送。

## 核心概念

### 插件系统

ACO 用运行时插件做 L2 确定性守卫。与其指望每个 Agent 记住每条规矩，ACO 在控制面拦截执行，插件包括 dispatch guard、objective-fact guard、output humanizer guard、notify guard、doctor guard。

### 梯队管理

`tier-manager.ts` 按模型能力把 Agent 分到 T1–T4（opus/o1 → T1，sonnet → T2，haiku/mini → T3，nano/flash → T4），也支持按历史成功率自动升降级：跑够最小任务数后，成功率高的升、低的降。

### 任务板

ACO 把任务状态存在一个看板里，它是 queued / running / failed / cancelled / succeeded 的运行时真相源，支撑 `aco task`、`aco board` 这些命令的可见性和恢复能力。

### Watchdog

silent failure 在 ACO 里被当成产品 bug。watchdog 路径检测 stale 任务、僵尸会话、超时漂移、孤儿资源，把问题暴露出来、清理状态、把通道腾给下一个任务。

## Example

从 `examples/hello-plugin/` 里的最小插件开始。

它挂在 `before_prompt_build` 事件上，能作为真实 ACO 插件加载，给你一个端到端的小例子，照着抄就能写自己的守卫。

```bash
node -e "import('./examples/hello-plugin/index.js').then(m => console.log('OK:', m.default.id))"
```

预期输出：

```text
OK: aco-hello-plugin
```

安装和接线细节看 `examples/hello-plugin/README.md`。

## 什么时候用 ACO

| 适合用 ACO | 不适合 |
| --- | --- |
| 你要在多 Agent 运行时行为外面套一层确定性控制 | 你只想要一个单 prompt 跑批，不需要路由和恢复 |
| 你要任务状态、重试、watchdog 行为保持可见 | 你想要开箱即用的托管 SaaS 控制面 |
| 你需要扛得住长上下文的插件级守卫 | 你想让 Agent 纯靠 prompt 自觉治理 |
| 你在乎运行闭环和失败可恢复，不只是生成文本 | 你不需要审计、任务板、超时纪律 |

## CLI

- `aco init` 为你的环境生成初始规则集
- `aco demo` 跑一遍不依赖 provider 的确定性演示
- `aco dispatch` 把活派给发现的或指定的 Agent
- `aco task` 查看、重试、取消、追踪任务状态
- `aco board` 看实时任务板
- `aco audit kill-impact` 查 kill 影响扫描报告
- `aco health` 检查配置、数据路径、审计可用性和 Agent 健康摘要

## 成熟度

这是一个 early-stage 开源项目。运行时治理的抽象已经成型，状态机、规则引擎、失败归因、kill 扫描这些骨架都在仓库里跑得起来（本地 vitest 479/479 通过）。还缺的是大规模运行数据、控制台、权限、多租户、可观测性仪表盘这些平台级能力。技术含量是实打实的，平台化还在路上。

## Docs

- 产品需求：`docs/product-requirements.md`
- 架构：`docs/architecture.md`
- 示例插件：`examples/hello-plugin/README.md`

## License

MIT。见 `LICENSE`。
