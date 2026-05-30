# ACO P0 修复复验报告
OpenClaw（audit-02 子Agent）| 2026-05-06

## 复验结论
FAIL

4 个 P0 代码修复点都已落地，相关新增测试也已补上。
当前不能给 PASS，原因只有一个：按本次任务约束我只做了读代码和写报告，仓库里也没有现成的测试执行结果文件，因此我只能客观确认“测试数量已达到 194、P0 对应测试存在”，不能客观确认“194 个测试已全绿”。

## P0-1 复验
状态：已修复
证据：
- `src/scheduler/scheduler.ts:375-379` 的 `scheduleNext()` 已同时查询 `queued` 和 `retrying`：`this.taskBoard.query({ status: ['queued', 'retrying'] })`。
- `src/scheduler/scheduler.ts:439-467` 已补上 `retrying` 任务重新派发分支，`retrying` 任务会再次走 Adapter 派发，而不是卡死在重试状态。
- `src/p0-fixes.test.ts:64-202` 新增 P0-1 测试组，覆盖：失败后重派、梯队升级、最大重试次数、`task.retry` 事件、health alert 后重派链路。

## P0-2 复验
状态：已修复
证据：
- `src/scheduler/scheduler.ts:210-231` 在 completion 入口增加“成功但疑似空转”的二次判定，先算 `effectiveStatus`，再写入 TaskBoard。
- `src/scheduler/scheduler.ts:598-611` 新增 `detectSubstantiveFailure()`：`outputTokens < minOutputTokens` 且 `filesWritten === 0` 时判定为实质失败；未提供 token 信息时保持向后兼容。
- `src/scheduler/scheduler.ts:229-231` 对这种伪成功补写 `failureReason`，不再把空转结果当成功吞掉。
- `aco.config.schema.json:192-206` 已加入 `substantiveFailure` 配置结构。
- `src/p0-fixes.test.ts:204-386` 新增 P0-2 测试组，覆盖低 token 无文件、阈值以上、有文件输出、无 token 信息、自定义阈值等场景。

## P0-3 复验
状态：已修复
证据：
- `src/adapters/openclaw/openclaw-adapter.ts:23-41` 新增 `GatewayBridge` 接口，明确 `spawn / kill / notify / queryAgent` 边界。
- `src/adapters/openclaw/openclaw-adapter.ts:157-179` Adapter 已持有并暴露 bridge，支持 `setBridge()` / `getBridge()`。
- `src/adapters/openclaw/openclaw-adapter.ts:186-224` `dispatch()` 不再是 stub，真实通过 `bridge.spawn()` 派发，并维护 `taskId -> sessionId` 映射。
- `src/adapters/openclaw/openclaw-adapter.ts:270-338` 已补 `findTaskBySession()` 和 `convertGatewayEvent()`，完成 Gateway completion 事件回流所需桥接。
- `src/plugin/plugin.ts:76-109` Plugin 已实现 `createGatewayBridge(context)`，把 `context.spawn / kill / notify` 真正接到 ACO。
- `src/plugin/plugin.ts:118-150` `activate()` 已实例化 `OpenClawAdapter + createACO(...)`，不是空壳插件。
- `src/plugin/plugin.ts:154-268` 已注册 `task:created / task:completed / agent:idle / before_prompt_build` 四类 hook，并把完成事件通过 `adapter.findTaskBySession()` 回写 ACO。
- `src/p0-fixes.test.ts:387-574` 新增 P0-3 测试组，覆盖 bridge 缺失失败、bridge.spawn 派发、bridge.kill 取消、`setBridge/getBridge`、session 映射、plugin activate 和 prompt 注入。

## P0-4 复验
状态：已修复
证据：
- `src/cli/cli.ts:41` 初始化模板已引用 `$schema: './aco.config.schema.json'`。
- `src/cli/cli.ts:69-109` CLI 主路由已支持：`pool`、`rule list`、`task list`、`task cancel`。
- `src/cli/cli.ts:292-341` 已实现 `cmdPool()`。
- `src/cli/cli.ts:345-386` 已实现 `cmdRuleList()`。
- `src/cli/cli.ts:391-424` 已实现 `cmdTaskList()`。
- `src/cli/cli.ts:429-458` 已实现 `cmdTaskCancel()`。
- `src/cli/cli.ts:472-486` `--help` 已列出新增命令。
- `aco.config.schema.json` 文件存在；`package.json:18-21` 也已把该 schema 纳入 npm 包 `files`。
- `src/p0-fixes.test.ts:575-705` 新增 P0-4 测试组，覆盖 `pool / rule list / task list / task cancel / help / schema`。

## 测试检查
- 静态统计结果：`src/` 下 `it(` / `test(` 总数为 **194**，达到“≥194”要求。
- 新增测试文件存在：`src/p0-fixes.test.ts`，且其中明确分成 P0-1 / P0-2 / P0-3 / P0-4 四组。
- 额外 CLI 测试文件存在：`src/cli/cli.test.ts`。
- 但仓库内**没有可供只读核验的测试执行结果文件**；我也按任务要求没有运行测试，因此“全绿”这一项目前无法客观确认。

## 残留问题（如有）
- 当前唯一残留点不是代码修复缺口，而是证据缺口：缺少现成的测试运行产物，导致在“只读代码 + 不执行测试”的约束下，无法完成“全绿”确认。
- 如果要把结论升为 PASS，需要补一条客观证据：执行一次测试并保存结果，或提供 CI/本地测试报告文件供复核。
