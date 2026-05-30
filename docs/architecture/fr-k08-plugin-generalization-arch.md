# ACO FR-K08 插件通用化与开源准备架构方案
Feynman（OpenClaw ACP Agent）2026-05-29

## 目标

FR-K08 的目标是让 ACO 插件能离开当前机器独立使用，同时不破坏本机现有行为。当前 12 个 ACO L2 插件位于 `/root/.openclaw/extensions/`，另有 `kivo-intent-injection` 以 hook 形式存在于 workspace。它们共同问题是：插件代码把本机路径、用户身份、Agent 池、任务标签、规则文本、阈值和命令名写死在实现里。

通用化原则只有一条：无 config 时，默认值必须等于当前硬编码值，行为完全一致。任何插件改造都先加配置解析与默认值，不先改业务逻辑。

## 总体架构

插件拆成三层：

1. 插件核心层：只保留通用事件监听、命令拦截、任务状态判断、文本检测、通知发送编排等逻辑。
2. Profile 层：保存 OpenClaw 本机定制规则，例如默认 workspace、用户 openid、13 个插件规则、默认 Agent 池、中文提示文案。
3. Adapter 层：对接宿主能力，例如文件系统、Lark、模型调用、任务看板、Gateway 事件、浏览器 lease 状态。

配置合并顺序：

`内置默认值（当前硬编码值） → profile 默认值 → openclaw.json 插件 config → 环境变量覆盖`

所有路径支持 `{home}`、`{workspace}`、`{date}`、`{pluginId}` 占位符。默认 `{home}` 为当前 `os.homedir()`，默认 `{workspace}` 为 `{home}/.openclaw/workspace`。

## 统一 config 字段规范

每个插件都应支持以下基础字段：

- `enabled`: 是否启用。默认保持当前行为。
- `workspaceDir`: workspace 根目录。默认 `/root/.openclaw/workspace` 的语义等价值 `{home}/.openclaw/workspace`。
- `openclawDir`: OpenClaw 根目录。默认 `{home}/.openclaw`。
- `paths`: 插件用到的文件路径集合。
- `agents`: Agent 池、排除列表、路由优先级。
- `rules`: 规则 ID、关键词、阻断模式、注入文案。
- `thresholds`: 超时、重试、长度、窗口、并发等阈值。
- `channels`: 生效渠道，如 `feishu`、`cli`、`api`。
- `notify`: 用户、渠道、模板、去重窗口。
- `llm`: 模型判断或改写配置，包含 provider、model、timeoutMs、maxTokens。
- `compatMode`: 兼容模式。默认 `openclaw-local`，表示完全沿用当前硬编码默认。

## 兼容策略

1. 每个插件新增 `DEFAULT_CONFIG`，值逐项复制当前硬编码值。
2. 初始化时调用 `resolveConfig(pluginConfig, env, context)`，深合并默认值。
3. openclaw.plugin.json 的 `additionalProperties` 从禁止改为允许，或补齐所有 configSchema 字段，避免新增字段被宿主拒绝。
4. 任何 config 缺失都回退到 `DEFAULT_CONFIG`。
5. 任何路径缺失都用当前路径逻辑生成。
6. 每个插件加一组快照测试：空 config 输入时，关键输出与改造前一致。



## 逐插件硬编码分析与配置方案

### 1. aco-async-discipline-guard

职责：阻止主会话用 `process` 长时间同步等待，必要时用 LLM 判断是否属于真实豁免意图。

| 当前硬编码项 | 建议 config key | 默认值 |
|---|---|---|
| 审计日志 `/root/.openclaw/workspace/logs/dispatch-guard-events.jsonl`，实际代码用 `process.env.HOME || /root` 拼接 | `paths.auditLog` | `{home}/.openclaw/workspace/logs/dispatch-guard-events.jsonl` |
| 只作用于 `main` / `agent:main:` 会话 | `scope.mainAgentIds`、`scope.mainSessionPatterns` | `['main']`、`[':main:', 'agent:main:']` |
| 阻断阈值 `maxBlockingTimeoutMs = 5000` | `thresholds.maxBlockingTimeoutMs` | `5000` |
| 降级恢复窗口 `degradedRecoveryWindowMs = 300000` | `thresholds.degradedRecoveryWindowMs` | `300000` |
| LLM provider `penguin-main` | `llmJudgement.provider` | `penguin-main` |
| LLM model `claude-opus-4-7` | `llmJudgement.model` | `claude-opus-4-7` |
| LLM 超时 `5000` | `llmJudgement.timeoutMs` | `5000` |
| OpenAI 兼容调用参数 `temperature:0,max_tokens:4` | `llmJudgement.request.temperature`、`llmJudgement.request.maxTokens` | `0`、`4` |
| 阻断提示文案 `[ACO 异步纪律守卫]...` | `messages.blockReasonTemplate` | 当前中文文案 |
| 规则 ID `dispatch.process.async_discipline_*` | `rules.ids.*` | 当前规则 ID |

分离边界：`process` 调用解析、超时判断、LLM YES/NO 判定是通用核心；中文阻断文案、main 会话识别、规则 ID、日志路径是 profile。

改造建议：现有 `DEFAULT_CONFIG` 已包含一部分字段，补齐 `paths`、`scope`、`rules`、`messages`，并把 `AUDIT_LOG_PATH` 改成注册时从 config 解析。空 config 时仍写入当前日志文件，仍只拦截 main，仍按 5 秒阈值拦截。

### 2. aco-browser-session-lease

职责：为浏览器工位提供独占租约、续期、释放、过期回收。

| 当前硬编码项 | 建议 config key | 默认值 |
|---|---|---|
| 租约状态 `/root/.openclaw/workspace/state/browser/lease.json` | `paths.leaseState` | `{workspace}/state/browser/lease.json` |
| 事件日志 `/root/.openclaw/workspace/logs/browser-workbench-events.jsonl` | `paths.events` | `{workspace}/logs/browser-workbench-events.jsonl` |
| 默认租约 TTL `300000` | `thresholds.defaultLeaseTtlMs` | `300000` |
| 自动回收检查间隔，代码中定时器实际按固定间隔运行 | `thresholds.reclaimIntervalMs` | 当前 setInterval 间隔值 |
| 拒绝原因中文 `浏览器工位被...持有` | `messages.leaseHeldTemplate` | 当前中文文案 |
| 非持有者续期/释放中文原因 | `messages.notHolderRenew`、`messages.notHolderRelease` | 当前中文文案 |
| 事件类型 `lease_acquired`、`lease_renewed` 等 | `events.types.*` | 当前事件名 |

分离边界：租约状态机是通用核心；“浏览器工位”命名、中文原因、文件落点是 profile。

改造建议：导出的 `acquire/renew/release/status` 当前在模块顶层直接使用常量。应引入 `createLeaseManager(config)`，默认导出仍用 `DEFAULT_CONFIG` 创建单例，保证旧调用不变。插件 register 时再用宿主 config 覆盖单例路径。

### 3. aco-closure-guard

职责：子任务结束后，要求主会话给用户做闭环总结；未总结则注入提醒并自动清理。

| 当前硬编码项 | 建议 config key | 默认值 |
|---|---|---|
| 审计日志 `/root/.openclaw/workspace/logs/aco-closure-guard-events.jsonl` | `paths.auditLog` | `{workspace}/logs/aco-closure-guard-events.jsonl` |
| `autoCloseDelayMs = 15000` | `thresholds.autoCloseDelayMs` | `15000` |
| `closureTimeoutMs` 默认未设置，依赖 config；无 config 时不启用超时定时 | `thresholds.closureTimeoutMs` | `undefined` |
| 只在 `sessionKey.includes('feishu')` 注入/清理 | `channels` 或 `scope.sessionChannelIncludes` | `['feishu']` |
| main 识别：空 agentId 或 main 视为 main | `scope.mainAgentIds` | `['main', '']` |
| 子任务识别：`sessionKey.includes(':subagent:')` | `scope.subagentSessionIncludes` | `[':subagent:']` |
| 提醒文案要求 `lark-cli im +messages-send --user-id <userId>` | `notify.commandTemplate`、`messages.reminderTemplate` | 当前 lark-cli 文案 |
| 文案中的 `<userId>` 占位符未从 config.userId 实际替换 | `notify.userId` | `'<userId>'` |
| excludeLabels 前缀/正则匹配逻辑 | `excludeLabels`、`excludeMode` | 当前 config 值，默认 `[]` |
| closureId 生成 `agentId:Date.now():random` | `ids.closureIdStrategy` | `legacy` |

分离边界：完成事件登记、下一轮检测、超时清理是通用核心；飞书渠道、lark-cli 命令、中文闭环话术、用户 ID 是 profile。

改造建议：保留现有 `excludeLabels`、`closureTimeoutMs`、`autoCloseDelayMs`。新增 `notify.enabled`、`notify.commandTemplate`、`notify.userId`、`channels`。默认仍只对飞书会话注入，仍要求 lark-cli。

### 4. aco-dispatch-guard

职责：调度门禁，强制任务看板自查、Agent 配置校验、timeout 下限、MECE 拆分、开发后审计、禁止轮询等。

| 当前硬编码项 | 建议 config key | 默认值 |
|---|---|---|
| OpenClaw home `process.env.OPENCLAW_HOME || ~/.openclaw` | `openclawDir` | `{home}/.openclaw` |
| 配置文件 `{openclawDir}/openclaw.json` | `paths.openclawConfig` | `{openclawDir}/openclaw.json` |
| 事件日志 `{openclawDir}/workspace/logs/dispatch-guard-events.jsonl` | `paths.events` | `{workspace}/logs/dispatch-guard-events.jsonl` |
| 看板 `{openclawDir}/workspace/logs/subagent-task-board.json` | `paths.taskBoard` | `{workspace}/logs/subagent-task-board.json` |
| TASKS `{openclawDir}/workspace/TASKS.md` | `paths.tasksMd` | `{workspace}/TASKS.md` |
| sevo mapper `../sevo-pipeline/task-mapper.js` | `integrations.sevo.taskMapperPath` | `../sevo-pipeline/task-mapper.js` |
| ACP 并发 `DISPATCH_GUARD_MAX_ACP` 默认 8，范围 1-10 | `thresholds.maxConcurrentAcp` | `8`，环境变量覆盖保留 |
| Agent registry fallback：cc/codex/hermes/free-code/opencode/dev-01/dev-02/feynman/sa/pm/audit/ux | `agents.registryFallback` | 当前数组 |
| role fallback：pm/research/architecture/coding/review/ux | `agents.roleFallback` | 当前对象 |
| task map fallback：spec/ac/code/data-ops/audit/ux/readme/research | `routing.taskMapFallback` | 当前对象 |
| agent tier fallback：cc/codex/omp T1，hermes/free-code/opencode T2 | `agents.tierFallback` | 当前对象 |
| timeout 标准：600/1200/1800/3600 | `thresholds.timeoutByTaskType` | 当前四档 |
| timeout 下限 600 | `thresholds.minTimeoutSec` | `600` |
| steer 补充窗口 60 秒 | `thresholds.steerWindowSec` | `60` |
| 实质失败 token 阈值 `<3k` | `thresholds.lowOutputTokens` | `3000` |
| LLM 分类 cache size 100 | `thresholds.taskTypeCacheSize` | `100` |
| LLM 分类 timeout 10000 | `llm.taskClassifier.timeoutMs` | `10000` |
| LLM 分类 `max_tokens:16` | `llm.taskClassifier.maxTokens` | `16` |
| prompt 截断前 500 字 | `thresholds.promptSnippetChars` | `500` |
| stale completion 窗口 15 分钟 | `thresholds.staleCompletionWindowMs` | `900000` |
| audit 默认 `audit-01`，降级 `codex` | `agents.defaultAuditAgent`、`agents.auditFallback` | `audit-01`、`codex` |
| 禁止 agentId `main` | `agents.forbiddenIds` | `['main']` |
| sevo label 正则 `sevo:create`、`sevo:<id>:<stage>:<attempt>`、`sevo[_-]` | `integrations.sevo.labelPatterns` | 当前正则 |
| README 质量规则中文大段文案 | `rules.readmeQualityPrompt` | 当前文案 |
| 调度铁律注入中文大段文案 | `rules.dispatchPrompt` | 当前文案 |
| 错误到 ruleId 映射 `dispatch.agent.required` 等 | `rules.errorRuleIds` | 当前映射 |

分离边界：从 openclaw.json 读取 agents、从看板判断 running、校验 timeout、拦截非法 spawn 是通用核心；角色名、Agent 池、SEVO 标签、中文铁律文案、审计偏好是 profile。

改造建议：这是最需要分层的插件。先抽 `policy/default-openclaw-profile.js` 保存当前 Agent 池、timeout 表和中文 prompt；核心文件只接收 `policy`。`openclaw.plugin.json` 当前 `additionalProperties:false` 且 properties 为空，必须改成允许配置或补全 schema，否则无法通用化。空 config 时 fallback 与当前完全一致。

### 5. aco-doctor-guard

职责：阻断 `doctor --fix`、openclaw.json 未确认写入、危险 Gateway/systemd 操作；Gateway 重启前校验 doctor evidence、看板 idle、ACP command 可用。

| 当前硬编码项 | 建议 config key | 默认值 |
|---|---|---|
| 事件日志 `/root/.openclaw/workspace/logs/doctor-guard-events.jsonl` | `paths.events` | `{workspace}/logs/doctor-guard-events.jsonl` |
| OpenClaw home `OPENCLAW_HOME || ~/.openclaw` | `openclawDir` | `{home}/.openclaw` |
| openclaw.json `{openclawDir}/openclaw.json` | `paths.openclawConfig` | `{openclawDir}/openclaw.json` |
| 看板 `{openclawDir}/workspace/logs/subagent-task-board.json` | `paths.taskBoard` | `{workspace}/logs/subagent-task-board.json` |
| 危险 doctor 正则 `openclaw doctor --fix|doctor --fix|doctor -f` | `rules.dangerousDoctorPatterns` | 当前正则 |
| 安全 doctor 正则 `openclaw doctor|doctor` | `rules.safeDoctorPatterns` | 当前正则 |
| openclaw.json 绝对路径写保护 `/root/.openclaw/openclaw.json` | `rules.protectedConfigPaths` | `['/root/.openclaw/openclaw.json']` |
| shell 写操作正则 `sed -i|cat >|tee|>>|cp|mv` | `rules.shellWritePatterns` | 当前正则 |
| Gateway restart/reload/stop 正则 | `rules.gatewayCommandPatterns` | 当前正则 |
| systemd L0 保护正则 | `rules.l0SystemdPatterns` | 当前正则 |
| doctor evidence TTL，代码中 `DOCTOR_EVIDENCE_TTL_MS` | `thresholds.doctorEvidenceTtlMs` | 当前常量值 |
| ACP command 探测 `timeout 5 <command> --help || timeout 5 <command>` | `acp.probeCommandTemplate` | 当前模板 |
| ACP 探测 exec timeout 12000 | `acp.probeTimeoutMs` | `12000` |
| ACP 失败正则 `command not found|ENOVERSIONS|No such file` | `acp.failurePatterns` | 当前正则 |
| restart 推荐命令 `openclaw gateway restart` | `commands.gatewayRestart` | `openclaw gateway restart` |
| 阻断中文文案 | `messages.*` | 当前中文文案 |
| ruleId `doctor.fix.forbidden`、`gateway.restart.*` 等 | `rules.ids.*` | 当前 ruleId |

分离边界：命令风险分类、证据 TTL、三重门禁是通用核心；OpenClaw doctor 命令、Gateway/systemd 规则、openclaw.json 路径、中文文案是 OpenClaw profile。

改造建议：`additionalProperties:false` 且空 schema 必须修正。`OPENCLAW_JSON_WRITE_RE` 不能只匹配 `/root`，应由 `rules.protectedConfigPaths` 生成，同时默认值保留 `/root/.openclaw/openclaw.json`。

### 6. aco-notify

职责：子任务完成后强制主会话通过飞书补发用户可见通知，没发送就阻断主会话回复。

| 当前硬编码项 | 建议 config key | 默认值 |
|---|---|---|
| 审计日志 `/root/.openclaw/workspace/logs/aco-notify-closure-events.jsonl` | `paths.auditLog` | `{workspace}/logs/aco-notify-closure-events.jsonl` |
| `closureTimeoutMs = 120000` | `thresholds.closureTimeoutMs` | `120000` |
| 未发送提示 `⚠️ 你有未发送的飞书通知...` | `messages.unsentNotice` | 当前中文文案 |
| 只对 main 生效 | `scope.mainAgentIds` | `['main', '']` |
| 飞书渠道判断 `channel === 'feishu' || sessionKey.includes('feishu')` | `channels`、`scope.channelSessionIncludes` | `['feishu']`、`['feishu']` |
| 子任务识别 `sessionKey.includes(':subagent:')` | `scope.subagentSessionIncludes` | `[':subagent:']` |
| lark-cli 发送检测：命令包含 `lark-cli` 且包含 `im` | `notify.sendDetection` | `{ commandIncludes:['lark-cli','im'] }` |
| 注入文案要求先调用 lark-cli | `messages.promptReminderTemplate` | 当前中文文案 |
| 永久提醒 `Persistent reminder` 文案 | `messages.persistentReminderTemplate` | 当前文案 |
| completion label 拼接 `label || agentId` | `format.pendingLabelStrategy` | `labelOrAgentId` |

分离边界：完成事件登记、检测是否已发通知、阻断主会话回复是通用核心；飞书/lark-cli、中文文案、用户通知方式是 profile。

改造建议：已有 schema 暴露 `userId`、`excludeLabels`、`taskSources`，但代码未充分使用 `userId` 构造命令。补齐 `notify.commandTemplate = 'lark-cli im +messages-send --user-id {userId} --markdown {markdown}'`。默认仍通过命令内容包含 lark-cli/im 来确认发送。


### 7. aco-objective-fact-guard

职责：强制事实类回复先做客观检查，尤其是任务状态回复必须当回合读取看板。

| 当前硬编码项 | 建议 config key | 默认值 |
|---|---|---|
| Evidence TTL `10 * 60 * 1000` | `thresholds.evidenceTtlMs` | `600000` |
| task board 文件名 needle `subagent-task-board.json` | `evidence.taskBoardNeedle` | `subagent-task-board.json` |
| config 文件名 needle `openclaw.json` | `evidence.configNeedle` | `openclaw.json` |
| 事件日志 `/root/.openclaw/workspace/logs/fact-guard-events.jsonl` | `paths.events` | `{workspace}/logs/fact-guard-events.jsonl` |
| LRU cache size 128 | `thresholds.statusDetectionCacheSize` | `128` |
| 日志脱敏最大 50 字 | `thresholds.logPreviewChars` | `50` |
| LLM 配置路径 `../../openclaw.json` | `paths.openclawConfig` | `{openclawDir}/openclaw.json`，兼容默认仍解析相对路径 |
| LLM status detection timeout `10000` | `llm.statusDetection.timeoutMs` | `10000` |
| LLM `max_tokens:10` | `llm.statusDetection.maxTokens` | `10` |
| 状态检测英文 system prompt | `llm.statusDetection.systemPrompt` | 当前英文 prompt |
| 必查事实类别大段中文规则 | `rules.objectiveFactPrompt` | 当前中文规则 |
| 飞书授权用户 `ou_ba47b9dd81419f75c4febdd199bde7d8` | `notify.defaultUserId` | 当前 openid |
| lark-cli 文档/消息命令模板 | `notify.larkCliTemplates.*` | 当前命令文案 |
| skill 审计路径 `/usr/lib/node_modules/openclaw/skills/skill-creator/SKILL.md` | `paths.skillCreatorSkill` | 当前路径 |
| 报告产出路径 `/root/.openclaw/workspace/reports/<filename>.md` | `paths.reportsDir` | `{workspace}/reports` |
| 文档署名格式 | `messages.signatureTemplates` | 当前三类署名格式 |
| 阻断提示 `已阻断：检测到任务状态汇报...` | `messages.blockStatusNoBoardRead` | 当前中文文案 |
| ruleId `fact.status_report.*` | `rules.ids.*` | 当前 ruleId |

分离边界：证据记录、状态汇报识别、按 evidence 放行/阻断是通用核心；事实类别清单、飞书 openid、lark-cli 命令、中文铁律文案是 profile。

改造建议：将长 prompt 拆到 `profiles/openclaw/objective-fact-rules.md` 或 JS 字符串模块，核心只注入 `rules.objectiveFactPrompt`。LLM 模型选择当前从 openclaw.json 任意找非 thinking/image 模型，可保留为默认 resolver，但允许 `llm.statusDetection.model` 指定。

### 8. aco-output-humanizer-guard

职责：守卫主会话出站消息，检测技术标签并提醒或改写成人话。

| 当前硬编码项 | 建议 config key | 默认值 |
|---|---|---|
| 审计日志 `/root/.openclaw/workspace/logs/output-humanizer-guard-events.jsonl` | `paths.auditLog` | `{workspace}/logs/output-humanizer-guard-events.jsonl` |
| 内置技术标签模式：agent id、路径、FR/AC、camelCase、snake_case、命令行、代码片段 | `patterns.builtIn` | 当前数组 |
| Agent ID 正则 `sa|pm|audit|dev|ux|cc|re)-\d{2}` | `patterns.agentId` | 当前正则 |
| 路径正则包含 `/root/`、`~/.openclaw/`、`workspace/`、`projects/`、`/usr/lib/`、`/tmp/`、`/etc/` | `patterns.filePath` | 当前正则 |
| 命令行正则包含 git/npm/npx/openclaw/docker/curl/systemctl/sevo | `patterns.commandLine` | 当前正则 |
| camel/snake minLength 6 | `thresholds.identifierMinLength` | `6` |
| 英文白名单 `CAMEL_CASE_WHITELIST` | `patterns.camelCaseWhitelist` | 当前 Set |
| 默认策略 `remind` | `strategy` | `remind` |
| 默认渠道 `['feishu']` | `channels` | `['feishu']` |
| 默认 strictness `strict` | `strictness` | `strict` |
| rewrite timeout `30000` | `thresholds.rewriteTimeoutMs` / `rewriteTimeout` | `30000` |
| remind max retries `3` | `thresholds.remindMaxRetries` / `remindMaxRetries` | `3` |
| semantic LLM timeout 常量 `LLM_SEMANTIC_TIMEOUT_MS` | `thresholds.llmSemanticTimeoutMs` | 当前常量值 |
| rewrite `max_tokens:4096` | `llm.rewrite.maxTokens` | `4096` |
| semantic check `max_tokens:200` | `llm.semantic.maxTokens` | `200` |
| LLM 配置路径 `../../openclaw.json` | `paths.openclawConfig` | `{openclawDir}/openclaw.json`，兼容默认仍解析相对路径 |
| 重写 prompt 中文规则 | `messages.rewriteSystemPrompt` | 当前中文 prompt |
| remind prompt 中文规则 | `messages.remindPromptTemplate` | 当前中文 prompt |
| 语义 remind prompt | `messages.semanticRemindPromptTemplate` | 当前 prompt |

分离边界：正则检测、白名单、重试计数、rewrite/remind 策略是通用核心；哪些词算“技术标签”、中文改写要求、默认飞书渠道是 profile。

改造建议：该插件 schema 已较完整，但缺 `paths.auditLog`、`llmSemanticTimeout`、内置 patterns 覆盖策略。新增 `patternsMode: append|replace`，默认 `append`，保证现有内置规则不丢。

### 9. aco-research-anti-crawl-guard

职责：识别调研/抓取任务，自动注入反爬处理要求。

| 当前硬编码项 | 建议 config key | 默认值 |
|---|---|---|
| 审计日志 `/root/.openclaw/workspace/logs/aco-anti-crawl-guard-events.jsonl` | `paths.auditLog` | `{workspace}/logs/aco-anti-crawl-guard-events.jsonl` |
| 研究关键词数组：research、调研、crawl、scrape、抓取、数据采集等 | `rules.researchKeywords` | 当前数组 |
| 额外关键词追加逻辑 | `rules.extraKeywords` 或现有 `extraKeywords` | `[]` |
| 排除 label 默认 `['healthcheck','heartbeat']` | `excludeLabels` | `['healthcheck','heartbeat']` |
| 只拦截工具 `sessions_spawn` | `scope.toolNames` | `['sessions_spawn']` |
| 反爬注入中文文案 | `messages.antiCrawlInjection` | 当前文案 |
| 浏览器兜底脚本 `/root/.openclaw/workspace/scripts/fetch-with-browser.sh` | `paths.browserFetchScript` | `{workspace}/scripts/fetch-with-browser.sh` |
| 公开 API 优先例子 `Indiegogo API` | `messages.publicApiExamples` | `['Indiegogo API']` |
| 第三方服务例子 `Apify` | `messages.thirdPartyServices` | `['Apify']` |
| 失败判定文案 `标记"被反爬"然后跳过 = 任务失败` | `messages.failureRule` | 当前中文文案 |

分离边界：任务意图匹配和 prompt 注入是通用核心；反爬 SOP、浏览器脚本路径、平台例子是 profile。

改造建议：当前计算了 `allKeywords` 但 `hasResearchIntent(prompt,label)` 使用全局 `RESEARCH_KEYWORDS`，`extraKeywords` 没真正生效。通用化时先改成 `hasResearchIntent(prompt,label,allKeywords)`，空 config 默认仍只用当前关键词。

### 10. aco-run-watchdog

职责：维护任务看板、同步 ACP ledger、回收 stale 任务、提示主会话推进、记录 tool trace、memory_search 熔断建议。

| 当前硬编码项 | 建议 config key | 默认值 |
|---|---|---|
| OpenClaw dist `/usr/lib/node_modules/openclaw/dist` | `paths.openclawDistDir` | `/usr/lib/node_modules/openclaw/dist` |
| task-registry 模块模式 `task-registry-*.js` | `paths.taskRegistryPattern` | `task-registry-*.js` |
| ACP session state `/root/.openclaw/workspace/state/sessions` | `paths.acpSessionStateDir` | `{workspace}/state/sessions` |
| state `/root/.openclaw/workspace/logs/run-watchdog-state.json` | `paths.state` | `{workspace}/logs/run-watchdog-state.json` |
| events `/root/.openclaw/workspace/logs/run-watchdog-events.jsonl` | `paths.events` | `{workspace}/logs/run-watchdog-events.jsonl` |
| board `/root/.openclaw/workspace/logs/subagent-task-board.json` | `paths.taskBoard` | `{workspace}/logs/subagent-task-board.json` |
| subagent index `/root/.openclaw/workspace/logs/subagent-task-index.json` | `paths.subagentIndex` | `{workspace}/logs/subagent-task-index.json` |
| recovery `/root/.openclaw/workspace/logs/run-watchdog-recovery.json` | `paths.recovery` | `{workspace}/logs/run-watchdog-recovery.json` |
| recovery lock `/root/.openclaw/workspace/logs/run-watchdog-recovery.lock` | `paths.recoveryLock` | `{workspace}/logs/run-watchdog-recovery.lock` |
| board bridge `/root/.openclaw/workspace/scripts/local-subagent-board.js` | `paths.boardBridgeScript` | `{workspace}/scripts/local-subagent-board.js` |
| board notify events `/root/.openclaw/workspace/logs/subagent-notify-events.jsonl` | `paths.boardNotifyEvents` | `{workspace}/logs/subagent-notify-events.jsonl` |
| tool traces dir `/root/.openclaw/workspace/logs/tool-traces` | `paths.toolTracesDir` | `{workspace}/logs/tool-traces` |
| runs state `/root/.openclaw/subagents/runs.json` | `paths.subagentRunsState` | `{openclawDir}/subagents/runs.json` |
| agents sessions dir `/root/.openclaw/agents/{agentId}/sessions` | `paths.agentSessionsPattern` | `{openclawDir}/agents/{agentId}/sessions` |
| stale ms env `RUN_WATCHDOG_STALE_MS` 默认 1800000，夹在 300000-7200000 | `thresholds.staleMs`、`thresholds.staleMsMin`、`thresholds.staleMsMax` | `1800000`、`300000`、`7200000` |
| idle alert env 默认 300000，夹在 180000-1800000 | `thresholds.idleAlertMs`、`thresholds.idleAlertMinMs`、`thresholds.idleAlertMaxMs` | `300000`、`180000`、`1800000` |
| ACP stale 默认 1800000，夹在 300000-7200000 | `thresholds.acpStaleMs`、`thresholds.acpStaleMinMs`、`thresholds.acpStaleMaxMs` | `1800000`、`300000`、`7200000` |
| interval `5000` | `thresholds.intervalMs` | `5000` |
| auto recover env `RUN_WATCHDOG_AUTO_RECOVER === '1'` | `recovery.autoRecover` | `false`，环境变量覆盖保留 |
| gateway restart `openclaw gateway restart` timeout 120000 | `commands.gatewayRestart`、`thresholds.gatewayRestartTimeoutMs` | `openclaw gateway restart`、`120000` |
| board snapshot 命令 `node local-subagent-board.js send-snapshot` timeout 30000 | `commands.boardSnapshot`、`thresholds.boardSnapshotTimeoutMs` | 当前命令、`30000` |
| stale trace cleanup 30 分钟 | `thresholds.toolTraceStaleMs` | `1800000` |
| memory breaker threshold 3 | `memoryBreaker.threshold` | `3` |
| memory breaker timeout 30000 | `memoryBreaker.timeoutMs` | `30000` |
| memory breaker events `/root/.openclaw/workspace/logs/memory-breaker-events.jsonl` | `memoryBreaker.eventsPath` | `{workspace}/logs/memory-breaker-events.jsonl` |
| memory breaker 飞书用户 `ou_ba47...` | `notify.userId` | `ou_ba47b9dd81419f75c4febdd199bde7d8` |
| notify command `lark-cli im +messages-send` timeout 15000 | `notify.command`、`notify.timeoutMs` | `lark-cli im +messages-send`、`15000` |
| task title fallback `subagent-task`、`acp-task`、`${agentId}-task-${ts}` | `format.titleFallbacks` | 当前值 |
| output tail max 1200 | `thresholds.tailMaxChars` | `1200` |
| param summary 截断 path 200、command 100、query 100、url 200、prompt 100 等 | `thresholds.toolTraceParamPreview` | 当前各字段长度 |
| build 字符串 `2026-04-10-recovery-probe-1` | `diagnostics.build` | 当前值 |

分离边界：事件到看板 upsert、ACP stale 判断、tool trace、锁与原子写是通用核心；OpenClaw dist 路径、本机 board bridge、Gateway restart、飞书通知、memory-core 文案是 profile。

改造建议：路径常量过多，先集中到 `resolveWatchdogConfig()`，不要一次重构状态机。第一阶段只替换常量来源；第二阶段再拆 `board-store`、`acp-ledger-sync`、`stale-reaper`、`notifier`。

### 11. aco-session-context-recovery

职责：会话压缩/重置后，从 reset 备份、memory、extractions 找回上下文并注入。

| 当前硬编码项 | 建议 config key | 默认值 |
|---|---|---|
| agents 根目录 `/root/.openclaw/agents` | `paths.agentsRoot` | `{openclawDir}/agents` |
| memory 目录 `/root/.openclaw/workspace/memory` | `paths.memoryDir` | `{workspace}/memory` |
| extractions 目录 `/root/.openclaw/workspace/memory/extractions` | `paths.extractionsDir` | `{workspace}/memory/extractions` |
| tmp 目录 `/root/.openclaw/extensions/aco-session-context-recovery/tmp` | `paths.tmpDir` | `{openclawDir}/extensions/aco-session-context-recovery/tmp` |
| reset 文件尾部读取 2MB | `thresholds.resetTailBytes` | `2097152` |
| reset 注入窗口 `RESET_WINDOW_MS` | `thresholds.resetWindowMs` | 当前常量值 |
| 只在 `sessionKey.includes('feishu')` 注入 | `channels` / `scope.sessionIncludes` | `['feishu']` |
| main fallback：空 agentId 或 main | `scope.mainAgentIds` | `['main', '']` |
| reset 文件名解析规则 | `rules.resetFilenamePattern` | 当前解析逻辑 |
| memory 文件日期格式 `YYYY-MM-DD.md` | `rules.memoryDailyFilePattern` | `{yyyy}-{mm}-{dd}.md` |
| 注入 marker `Symbol.for('openclaw.aco-session-context-recovery.injected')` | `runtime.markerKey` | 当前 symbol |
| summary tmp 文件名 `recovery-${Date.now()}.md` | `format.tmpSummaryFileName` | `recovery-{timestamp}.md` |

分离边界：读取 JSONL reset、提取最近消息、组合恢复摘要是通用核心；OpenClaw agents/memory 目录、飞书渠道限制、中文摘要模板是 profile。

改造建议：把 `AGENTS_ROOT/MEMORY_DIR/EXTRACTIONS_DIR/TMP_DIR` 改为注册时 config 解析。保留当前只对飞书会话注入，避免本机行为扩大。

### 12. aco-spec-challenge-guard

职责：每次 prompt 构建前注入批判性思维、第一性原理、意图澄清和收敛沉淀规则。

| 当前硬编码项 | 建议 config key | 默认值 |
|---|---|---|
| 注入 prompt `SPEC_CHALLENGE_PROMPT` 大段中文 | `rules.prompt` | 当前完整中文 prompt |
| before_prompt_build priority `900` | `hooks.beforePromptBuildPriority` | `900` |
| 作用范围所有 agent | `scope.agentIds`、`scope.excludeAgentIds` | `['*']`、`[]` |
| 只记录一次 promptLogged/registeredLogged | `diagnostics.logOnce` | `true` |
| 插件版本代码 `2.0.0`，plugin json `1.0.0` 不一致 | `metadata.version` | 代码与 manifest 统一为当前实际版本 |
| 方法论关键词：spec、product-requirements.md、Phase 1/2 | `rules.terms` | 当前 prompt 内词汇 |

分离边界：before_prompt_build 注入机制是通用核心；注入的具体方法论文案是 profile。

改造建议：这是最容易通用化的插件。新增 `enabled`、`prompt`、`priority`、`scope`。空 config 注入完全相同的 `SPEC_CHALLENGE_PROMPT`。

### 13. kivo-intent-injection

职责：在消息到达和 bootstrap 时，从 KIVO DB 检索知识、意图和图谱邻居，注入到上下文；同时做实时知识提取。该能力目前不在 `/root/.openclaw/extensions/kivo-intent-injection`，实际文件位于 `/root/.openclaw/workspace/projects/kivo/hooks/kivo-intent-injection/handler.js`，workspace 下另有动态上下文文件。

| 当前硬编码项 | 建议 config key | 默认值 |
|---|---|---|
| home fallback `/root` | `homeDir` | `{home}`，当前 root 环境等价 `/root` |
| workspace 候选 `OPENCLAW_WORKSPACE/projects/kivo`、`~/.openclaw/workspace/projects/kivo`、相对 projects/kivo | `paths.kivoProjectCandidates` | 当前候选顺序 |
| KIVO DB 候选 `{workspace}/projects/kivo/kivo.db`、`{workspace}/kivo.db` | `paths.dbCandidates` | 当前顺序 |
| 日志 `{workspace}/logs/kivo-intent-injection.log` | `paths.log` | `{workspace}/logs/kivo-intent-injection.log` |
| 动态上下文 `{workspace}/hooks/kivo-intent-injection/KIVO_CONTEXT.md` | `paths.dynamicContext` | 当前路径 |
| openclaw config `~/.openclaw/openclaw.json` | `paths.openclawConfig` | `{openclawDir}/openclaw.json` |
| 默认 provider 偏好 `penguin-main` | `llm.realtime.preferredProvider` | `penguin-main` |
| penguin baseUrl 过滤：包含 `api.penguinsaichat` 且不含 `api2.penguinsaichat` | `llm.realtime.providerBaseUrlIncludes`、`providerBaseUrlExcludes` | 当前规则 |
| 默认 realtime LLM model `DEFAULT_REALTIME_LLM_MODEL` | `llm.realtime.model` | 当前常量/环境变量默认 |
| realtime max_tokens 1200 | `llm.realtime.maxTokens` | `1200` |
| realtime capture timeout `REALTIME_CAPTURE_TIMEOUT_MS` | `thresholds.realtimeCaptureTimeoutMs` | 当前常量 |
| realtime min confidence 0.7 | `thresholds.realtimeMinConfidence` | `0.7` |
| 短消息跳过阈值 | `thresholds.realtimeMinChars` | 当前代码阈值 |
| 去重表名 `realtime_processed_messages` | `storage.realtimeDedupTable` | `realtime_processed_messages` |
| dedup source `kivo-intent-injection` | `storage.realtimeSource` | `kivo-intent-injection` |
| 图谱边表 `graph_edges`，weight threshold 常量 | `graph.edgeTable`、`graph.minWeight` | 当前值 |
| 图谱扩展安全 cap | `graph.maxEntries` | 当前值 |
| intents 表名 `intents`，状态 `active` | `intents.table`、`intents.activeStatus` | `intents`、`active` |
| bootstrap limit `KIVO_BOOTSTRAP_MAX` | `thresholds.bootstrapMax` | 当前常量 |
| bootstrap max chars `MAX_CHARS_BOOTSTRAP` | `thresholds.bootstrapMaxChars` | 当前常量 |
| subject min score env `KIVO_SUBJECT_MIN_SCORE || 0.2` | `thresholds.subjectMinScore` | `0.2`，环境变量覆盖保留 |
| KIVO package imports `@self-evolving-harness/kivo/...` | `integrations.kivoPackage` | 当前包名 |
| worker 默认 base/model/provider 偏好 penguin-main/openai fallback | `worker.llm.*` | 当前逻辑 |
| worker LLM timeout `90_000`、max_tokens 4000 | `worker.thresholds.llmTimeoutMs`、`worker.llm.maxTokens` | `90000`、`4000` |
| worker embedding `OLLAMA_URL = http://localhost:11434/api/embeddings` | `worker.embedding.url` | `http://localhost:11434/api/embeddings` |
| worker embedding text 截断 2000 | `worker.embedding.maxInputChars` | `2000` |
| better-sqlite3 fallback path `/root/.openclaw/workspace/projects/kivo/node_modules/better-sqlite3/lib/index.js` | `worker.paths.betterSqliteFallback` | `{workspace}/projects/kivo/node_modules/better-sqlite3/lib/index.js` |
| dictionary domain `system-dictionary` | `worker.dictionary.domain` | `system-dictionary` |
| queue chunk size 10 messages | `worker.thresholds.chunkSize` | `10` |
| source JSON `{type:'hook-extraction', id:'kivo-intent-hook'}` | `worker.storage.source` | 当前对象 |

分离边界：事件触发、DB 检索、向量/图谱召回、上下文格式化是通用核心；KIVO 包路径、DB schema、方舟/企鹅模型偏好、OpenClaw workspace 候选、system-dictionary 领域是 KIVO profile。

改造建议：先补一个 `openclaw.plugin.json` 或 hook manifest，让该 hook 也按插件配置加载。将 `resolveWorkspace/resolveKivoDbPath/resolveLogPath/resolveDynamicContextPath` 改为 config 驱动。worker 当前仍使用 Ollama embedding，与本机 TOOLS.md 记录的方舟 embedding 冲突；通用化时将 embedding provider 配置化，默认保持当前 worker 逻辑，OpenClaw profile 可覆盖为本机兼容层。


## 通用实现方案

### 配置解析模块

新增共享模块 `shared/config.js`，每个插件都调用同一套解析方法：

```js
export function resolvePluginConfig({ pluginId, defaults, api, env = process.env }) {
  const raw = api?.pluginConfig?.[pluginId] || {};
  const base = expandPlaceholders(defaults, {
    home: env.HOME || '/root',
    openclawDir: env.OPENCLAW_HOME || `${env.HOME || '/root'}/.openclaw`,
    workspace: env.OPENCLAW_WORKSPACE || `${env.OPENCLAW_HOME || `${env.HOME || '/root'}/.openclaw`}/workspace`,
  });
  return deepMerge(base, raw);
}
```

要求：

- `DEFAULT_CONFIG` 必须放在插件内，值与当前硬编码一致。
- 只允许在 register 阶段解析一次配置；需要热更新的插件显式监听 config 变化。
- 所有路径通过 `resolvePathTemplate` 生成，不在业务函数中拼 `/root`。
- schema 与默认值同步维护。schema 不完整时，先 `additionalProperties:true`，避免宿主拒绝新增配置。

### Profile 分层

新增 profile 概念：

- `profiles/openclaw-local.js`：当前机器行为，包含中文铁律、飞书 openid、默认 Agent 池、OpenClaw 路径、SEVO 标签规则。
- `profiles/generic.js`：开源默认行为，只提供通用安全规则，不含用户 openid、本机路径、不含 13 个 Agent 名称。
- 插件默认 `compatMode = 'openclaw-local'`，这样本机不传 config 完全不变。
- 开源包文档推荐 `compatMode = 'generic'`，用户按需配置路径、通知渠道和 Agent 角色。

### Adapter 分层

通用插件不直接依赖具体 CLI 或服务：

- `FileStoreAdapter`：读写 JSON/JSONL、原子写、锁。
- `TaskBoardAdapter`：看板读取、upsert、snapshot。
- `NotifierAdapter`：lark-cli、console、webhook 三种实现。
- `ModelAdapter`：从宿主 `api.openclaw.chat.complete` 或 OpenAI compatible endpoint 调用。
- `CommandGuardAdapter`：命令解析与风险匹配。

默认 adapter 仍使用当前本机实现。开源用户可替换为 webhook、Slack、纯日志。

### openclaw.plugin.json 规范

每个插件 manifest 至少包含：

```json
{
  "configSchema": {
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "enabled": { "type": "boolean", "default": true },
      "compatMode": { "type": "string", "default": "openclaw-local" },
      "openclawDir": { "type": "string" },
      "workspaceDir": { "type": "string" },
      "paths": { "type": "object", "additionalProperties": true },
      "thresholds": { "type": "object", "additionalProperties": true },
      "rules": { "type": "object", "additionalProperties": true },
      "messages": { "type": "object", "additionalProperties": true }
    }
  }
}
```

特定插件可继续声明更细字段。`additionalProperties:false` 只适合 schema 完全覆盖后再启用；FR-K08 第一阶段不要使用。

## 迁移计划

### Wave 1：只加配置，不改行为

范围：所有插件新增 `DEFAULT_CONFIG` 和 `resolvePluginConfig`。把路径、阈值、provider/model、用户 openid、Agent 池搬进默认配置。业务逻辑不重构。

验收：

- 13 个插件空 config 启动不报错。
- 空 config 下关键日志路径与当前一致。
- 空 config 下阻断/注入文案与当前一致。
- 空 config 下 timeout、Agent 池、规则 ID 与当前一致。

### Wave 2：抽 profile 与 adapter

范围：优先处理硬编码最多的 `aco-dispatch-guard`、`aco-run-watchdog`、`aco-doctor-guard`、`kivo-intent-injection`。

验收：

- `compatMode=openclaw-local` 与 Wave 1 行为一致。
- `compatMode=generic` 不包含 `/root`、`ou_ba47...`、固定 Agent 池。
- 通知 adapter 可切换成 console，不依赖 lark-cli。

### Wave 3：开源包装

范围：README、配置样例、最小运行模式、测试快照。

验收：

- 新机器只配置 workspaceDir 即可跑 `browser-session-lease`、`spec-challenge-guard`、`research-anti-crawl-guard`。
- 不配置飞书时，notify 类插件降级为 console/webhook，不阻断用户不可完成的动作。
- 不配置 Agent 池时，dispatch guard 从宿主 agents.list 读取，读不到才用 generic 空策略或明确 fail-open。

## 测试方案

1. 快照测试：每个插件空 config 解析出的关键字段等于当前硬编码值。
2. 路径测试：`HOME=/tmp/user OPENCLAW_HOME=/tmp/oc OPENCLAW_WORKSPACE=/tmp/ws` 时，路径按模板展开。
3. 行为测试：对每个 guard 构造典型事件，确认阻断/放行结果与当前一致。
4. Schema 测试：manifest schema 能接受新增 `paths`、`thresholds`、`rules`、`messages`。
5. 本机 smoke：不改 openclaw.json，加载改造后插件，跑只读 doctor，确认无 Errors，再观察日志写入位置。

## 风险与控制

- 最大风险是路径默认值改变导致本机看板、日志、通知失效。控制方式：默认值必须用当前绝对路径快照测试兜住。
- 第二风险是 schema 仍 `additionalProperties:false`，配置写了但宿主拒绝。控制方式：第一阶段统一改为 `additionalProperties:true`。
- 第三风险是通知插件通用化后仍要求 lark-cli，开源用户无法完成。控制方式：notify adapter 默认按 profile 选择，generic 下不硬阻断不可用通知命令。
- 第四风险是 dispatch guard 的 Agent fallback 与宿主 agents.list 冲突。控制方式：宿主配置优先，fallback 仅在配置不可读时使用，且 fallback 来源写入审计日志。

## 插件优先级

先改易验证且影响面小的插件：

1. `aco-spec-challenge-guard`
2. `aco-research-anti-crawl-guard`
3. `aco-browser-session-lease`
4. `aco-closure-guard` / `aco-notify`
5. `aco-async-discipline-guard`
6. `aco-output-humanizer-guard`
7. `aco-objective-fact-guard`
8. `aco-doctor-guard`
9. `aco-run-watchdog`
10. `aco-dispatch-guard`
11. `kivo-intent-injection`

原因：先拿 prompt 注入和路径类插件验证配置框架，再处理调度、看板、doctor、KIVO 这类高风险插件。

## 最小默认配置样例

```json
{
  "compatMode": "openclaw-local",
  "workspaceDir": "{home}/.openclaw/workspace",
  "openclawDir": "{home}/.openclaw"
}
```

开源 generic 样例：

```json
{
  "compatMode": "generic",
  "workspaceDir": "/data/openclaw-workspace",
  "notify": {
    "adapter": "console"
  },
  "agents": {
    "roleFallback": {
      "coding": ["coder"],
      "review": ["reviewer"]
    }
  }
}
```

## 结论

FR-K08 不应直接“删硬编码”，而是先把硬编码提升为默认配置。这样本机空 config 行为保持不变，开源用户再通过 profile 和 adapter 替换路径、通知、Agent 池和规则文案。13 个插件里，`aco-dispatch-guard`、`aco-run-watchdog`、`aco-doctor-guard`、`kivo-intent-injection` 是高风险核心；其余插件适合先做配置化样板。
