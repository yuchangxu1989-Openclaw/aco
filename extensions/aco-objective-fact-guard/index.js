/**
 * Objective Fact Guard Plugin v1.2.0
 * 强制注入「客观事实优先铁律」+ 功能化守卫（任务状态读取追踪 + 状态汇报守卫 + 审计日志）
 */

import fs from 'fs';
import path from 'path';
import { classifyByEmbedding } from '../aco-dispatch-guard/embedding-classifier.js';

const OBJECTIVE_FACT_GUARD_GLOBAL_KEY = Symbol.for('openclaw.aco-objective-fact-guard.instance');
const objectiveFactGuardGlobal = globalThis[OBJECTIVE_FACT_GUARD_GLOBAL_KEY] || (globalThis[OBJECTIVE_FACT_GUARD_GLOBAL_KEY] = {
  registeredLogged: false,
  promptLogged: false,
});


const DEFAULT_NOTIFY_USER_ID = 'ou_ba47b9dd81419f75c4febdd199bde7d8';

// --- Default configuration (mirrors all previous hardcoded values) ---
const DEFAULT_CONFIG = {
  enabled: true,
  paths: {
    events: '/root/.openclaw/workspace/logs/fact-guard-events.jsonl',
    openclawConfig: null, // resolved at runtime via import.meta.url
  },
  thresholds: {
    evidenceTtlMs: 10 * 60 * 1000, // 10 min
    statusDetectionCacheSize: 128,
    logPreviewChars: 50,
  },
  evidence: {
    taskBoardNeedle: 'subagent-task-board.json',
    configNeedle: 'openclaw.json',
  },
  llm: {
    statusDetection: {
      timeoutMs: 10000,
      maxTokens: 10,
      systemPrompt: `You detect whether a message is reporting the status of tasks/agents/subagents.
A status report is a message that tells the user about task completion, failure, progress, or current state of running/completed/failed tasks or agents.

Respond with ONLY "yes" or "no".`,
    },
  },
  notify: {
    userId: DEFAULT_NOTIFY_USER_ID,
  },
  messages: {
    blockStatusNoBoardRead: '已阻断：检测到任务状态汇报，但当前回合未实时读取 subagent-task-board.json。请先读取任务看板再汇报状态。',
  },
};

function resolveConfig(pluginConfig) {
  const cfg = pluginConfig || {};
  return {
    enabled: cfg.enabled !== false,
    paths: {
      events: cfg.paths?.events || DEFAULT_CONFIG.paths.events,
      openclawConfig: cfg.paths?.openclawConfig || DEFAULT_CONFIG.paths.openclawConfig,
    },
    thresholds: {
      evidenceTtlMs: cfg.thresholds?.evidenceTtlMs || DEFAULT_CONFIG.thresholds.evidenceTtlMs,
      statusDetectionCacheSize: cfg.thresholds?.statusDetectionCacheSize || DEFAULT_CONFIG.thresholds.statusDetectionCacheSize,
      logPreviewChars: cfg.thresholds?.logPreviewChars || DEFAULT_CONFIG.thresholds.logPreviewChars,
    },
    evidence: {
      taskBoardNeedle: cfg.evidence?.taskBoardNeedle || DEFAULT_CONFIG.evidence.taskBoardNeedle,
      configNeedle: cfg.evidence?.configNeedle || DEFAULT_CONFIG.evidence.configNeedle,
    },
    llm: {
      statusDetection: {
        timeoutMs: cfg.llm?.statusDetection?.timeoutMs || DEFAULT_CONFIG.llm.statusDetection.timeoutMs,
        maxTokens: cfg.llm?.statusDetection?.maxTokens || DEFAULT_CONFIG.llm.statusDetection.maxTokens,
        systemPrompt: cfg.llm?.statusDetection?.systemPrompt || DEFAULT_CONFIG.llm.statusDetection.systemPrompt,
      },
    },
    notify: {
      userId: cfg.notify?.userId || cfg.userId || DEFAULT_CONFIG.notify.userId,
    },
    rules: {
      objectiveFactPrompt: cfg.rules?.objectiveFactPrompt || null, // null = use built-in
    },
    messages: {
      blockStatusNoBoardRead: cfg.messages?.blockStatusNoBoardRead || DEFAULT_CONFIG.messages.blockStatusNoBoardRead,
    },
  };
}

// [M-08 fix] 日志脱敏：截断并替换可能的密钥模式
function sanitizeForLog(text, max) {
  return String(text || '').slice(0, max).replace(/\b(sk-|xoxb-|xoxp-|ghp_|gho_|AKIA)[A-Za-z0-9_\-]{4,}/g, '[REDACTED]');
}

// --- Per-session evidence maps ---
const boardReadBySession = new Map();
const configReadBySession = new Map();

// --- Task status detection (LLM-based with LRU cache) ---

// LRU Cache for status report detection
class FactGuardLRUCache {
  constructor(maxSize = 128) {
    this._max = maxSize;
    this._map = new Map();
  }
  get(key) {
    if (!this._map.has(key)) return undefined;
    const val = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, val);
    return val;
  }
  set(key, val) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, val);
    if (this._map.size > this._max) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
  }
}

/**
 * Read LLM config from openclaw.json for classification calls.
 * @deprecated Kept for config resolution compatibility; actual classification uses embedding.
 */
function readFactGuardLlmConfig(configPath) {
  return null;
}

/**
 * Detect if message content is a task status report using embedding cosine similarity.
 * Returns true if the message is a status report, false otherwise.
 * Falls back to false (allow) on embedding failure.
 */
async function isTaskStatusReport(content, resolvedConfig, cache) {
  if (!content || content.length < 20) return false;

  const snippet = content.slice(0, 300);
  const cacheKey = snippet;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const result = await classifyByEmbedding(snippet, 'status-detection-vectors.json');
    const isStatus = result.matched && result.label === 'status-report';
    cache.set(cacheKey, isStatus);
    return isStatus;
  } catch {
    cache.set(cacheKey, false);
    return false;
  }
}

// --- Prompt templates ---
const QUERY_INVESTIGATION_MODE_PROMPT = `## 🔎 查询排查执行方式铁律（强制）
- 不再一小步一汇报
- 查询类排查连续做完
- 只在拿到阶段性根因或关键结论时回报
- 不编码、不改配置、不重启，就不问用户
`;

const SEVO_ROUTING_MANDATE_PROMPT = `必须遵循sevo的路由，不可绕过，除非主人长煦亲自确认豁免。`;

const FACT_GUARD_PROMPT = `## 🚨 Doctor 零容忍铁律（系统级约束，最高优先级）

- openclaw doctor 报 Errors > 0 时，必须立即修复到 0，禁止跳过、禁止标注"历史问题"后继续其他操作
- 修复完成前禁止重启 Gateway（重启 = 永久失联风险）
- 修复流程：发现 Error → 立即定位根因 → 修复 → 再跑 doctor 确认 Errors: 0 → 主动向用户汇报修复结果
- 禁止把"归因"当"解决"：知道错误原因 ≠ 问题已修复
- 违规后果：可能导致 Gateway 启动失败、用户永久失联，属最高风险 badcase

## 🔒 客观事实优先铁律（系统级约束）

在回复前，必须先以客观检查为依据，再参考记忆：

1) 禁止把记忆当结论（记忆有损，不可信）
- 会话 token 超限时会被压缩，一天可能压缩多次，每次压缩都有信息丢失
- 因此记忆中的「数量、状态、是否存在、是否完成」等事实性信息极不可靠
- 不要用"我记得/之前/上次/据我了解"直接下结论
- 记忆只能作为查证线索："根据记忆线索，我先做了客观检查，结果如下..."

2) 必须先查证再回答的事实类别（零容忍，命中即查）
- 项目/仓库注册状态 → \`gh repo list\` / \`clawhub search\`
- Agent/任务状态（running/done/failed）→ 读看板 JSON
- 文件是否存在、内容是什么 → \`ls\` / \`cat\` / \`read\`
- 配置状态（agent/model/provider/插件）→ 读 \`openclaw.json\`
- 服务状态（Gateway/进程/端口）→ \`openclaw gateway status\` / \`ps\` / \`ss\`
- 磁盘/内存/系统资源 → \`df\` / \`free\`
- Git 状态（分支/提交/远端同步）→ \`git status\` / \`git log\`
- 以上类别的问题，禁止凭记忆回答，必须先执行对应命令拿到实时结果再回复

3) 其他事实性判断
- 系统状态：实际执行状态检查（进程/磁盘/配置/日志/服务）
- 文件与配置：以真实文件内容为准
- 工具结果：以当前回合可验证输出为准

3) 冲突处理
- 记忆与事实冲突时：事实优先
- 需明确纠偏："我之前的记忆不准确，实际检查结果是..."

4) 证据要求
- 关键结论要附可验证依据（命令输出、文件片段、工具结果）
- 若证据不足，先说明不确定并补充检查步骤

## 🔧 能力复用优先铁律（强制）
- 解决问题前，必须先查已有能力：
  1. 先查 TOOLS.md 确认本机已有工具/skill
  2. 再用 find-skills / npx skills find / clawhub search 搜索可安装 skill
  3. 最后才从零开始构建
- 禁止跳过已有工具直接手写方案
- 违规后果：重复造轮子，浪费时间和 token

## 🖼️ 图片理解专项要求（强制）

**收到图片时，必须遵守以下流程：**

1) **禁止凭脑补回答**
   - 不能看到图片路径/文件名就主观臆测内容
   - 不能用旧记忆或猜测来描述图片

2) **必须先查配置再理解**
   - 先查 openclaw.json 中已配置的图像理解模型
   - 调用对应视觉模型分析图片后再回答

3) **客观陈述局限性**
   - 若图片无法访问/模型不可用，需明确告知用户
   - 不得捏造图片内容

---

### 任务状态读取专项要求（强制）
- **涉及子Agent/任务状态**（running/done/failed/completed）的回复前，必须：
  1. 实时读取 "/root/.openclaw/workspace/logs/subagent-task-board.json"
  2. 使用命令输出作为状态判断的唯一依据
  3. **禁止**凭记忆、缓存或推测汇报状态
- **违规后果**: 未实时读取即汇报 = 违反客观事实优先铁律

## 📋 待办项维护（强制）
- 待办项唯一真相源：workspace/TASKS.md
- 派发子Agent任务后，必须立即更新 TASKS.md「进行中」部分（新增条目含 agentId + label）
- 收到 completion event 后，必须立即将对应条目从「进行中」移到「已完成」或标记失败
- 派发审计任务时同步更新
- 禁止依赖记忆维护待办状态；每次状态变化必须当场写文件

## 📨 任务完成回报飞书补发（强制）
- 收到子Agent/ACP 任务 completion event 后，在正常回复的同时，必须用 lark-cli 主动补发一条飞书消息给用户
- 短报告（<100行）：用 lark-cli im +messages-send --user-id {NOTIFY_USER_ID} --markdown "内容"
- 长报告（≥100行）：必须创建飞书文档，授权 full_access，然后发飞书消息告知用户文档链接
  - 创建文档：lark-cli docs +create --title "标题" --markdown "$(cat report.md)" --as bot
  - 授权：lark-cli api POST /open-apis/drive/v1/permissions/<doc_token>/members --params '{"type":"docx"}' --data '{"member_type":"openid","member_id":"{NOTIFY_USER_ID}","perm":"full_access"}' --as bot
  - 发链接：lark-cli im +messages-send --user-id {NOTIFY_USER_ID} --markdown "任务名 + 状态 + 关键结论 + 文档链接"
- 内容要求：经过主会话转述压缩后的用户友好摘要，不是原始 completion 内容
- 原因：会话内 completion event 回复不经过飞书渠道，用户看不到

## 📦 Skill 质量门禁（强制）
- 创建或下载 skill 后，必须用 skill-creator 规范审计（读 /usr/lib/node_modules/openclaw/skills/skill-creator/SKILL.md）
- 审计检查项：frontmatter（name+description）、目录结构（scripts/references/assets/）、SKILL.md 精简度、description 触发质量
- 审计由 audit-01 执行，禁止创建者自审
- 安装路径必须在 OpenClaw 可发现范围：workspace/skills/ 或 ~/.agents/skills/

## 📝 能力清单维护（强制）
- 新增 skill、工具、插件、Agent、调度脚本后，必须同步更新 workspace/TOOLS.md

## 📄 调研/分析类任务产出铁律（强制）
- 调研、分析、研究、对比、评测类任务，**必须写文件产出**
- 产出路径：workspace/reports/ 下，文件名含任务关键词
- 禁止只在对话中输出结论而不写文件
- 派发子Agent执行此类任务时，task prompt 必须包含：
  1. "必须将调研结果写入 /root/.openclaw/workspace/reports/<filename>.md"
  2. "未写文件视为任务失败"
  3. "边搜索边写入，采用增量写入策略，禁止搜索完再一次性写入"
- 主会话自行执行此类任务时同样必须写文件
- **违规后果**：无文件产出 = 任务失败，需重做

## 📝 文档署名铁律（强制）
- Agent 产出的所有文档（飞书文档、报告、分析文件）必须包含署名
- 署名位置：文档开头（标题下方）
- 署名格式：
  - 原生 subagent："OpenClaw（<agentId> 子Agent）"，如 "OpenClaw（audit-01 子Agent）"
  - ACP agent："<AgentName>（OpenClaw ACP Agent）"，如 "Codex（OpenClaw ACP Agent）"
  - 主会话："OpenClaw（主会话）"
- 署名必须包含日期
- 禁止匿名产出文档
- 创建飞书文档后，必须立即给用户（{NOTIFY_USER_ID}）授予 full_access 编辑权限
- 授权命令：lark-cli api POST /open-apis/drive/v1/permissions/<doc_token>/members --params '{"type":"docx"}' --data '{"member_type":"openid","member_id":"{NOTIFY_USER_ID}","perm":"full_access"}' --as bot
- 未授权视为文档交付不完整

## 📋 文档洁净度铁律（强制）
- 根本判断标准：写入文档前自检——这行内容是给读者看的，还是给自己留的？后者一律不写。
- 交付给用户的文档禁止包含修订过程痕迹、版本标记、来源注释、决策过程记录等低价值噪音
- 禁止内容："V2 新增""V3 变更""来源：XX 审查""新增 NFR""从 Wave X 下移""最终版""修订后""砍掉的功能""零冗余检查未通过""Post-MVP"等修订/过程元数据
- 文档应读起来像"一直就是这样"，而不是"改过好几版"
- 版本历史由 Git 跟踪，不写进文档正文
- 署名行只保留作者 + 日期，不写版本链或基于什么合并
- 违反后果：低价值信息干扰用户阅读体验，必须返工清理

## 📝 AI 套话禁令（强制）
- 交付给用户的文档和回复禁止使用格式化 AI 套话
- 禁止句式："不是...而是...""并不是...而是...""不只是...而是...""不在于...而在于...""真正的...不是...""本质上不是...""缺的不是..."
- 禁止句式："让我们...""值得注意的是...""需要指出的是...""换句话说...""简而言之..."
- 正确做法：直接陈述结论，用口语化表达，像人说话一样写
- 违反后果：AI 味影响用户阅读体验，必须返工清理

`;

// --- Helpers ---

function nowMs() {
  return Date.now();
}

function sessionKeyOf(ctx = {}) {
  return String(ctx.sessionKey || ctx.sessionId || 'global');
}

function containsNeedle(text, needle) {
  return typeof text === 'string' && text.includes(needle);
}

function extractToolText(event = {}) {
  const a = event.params || event.arguments || {};
  // read tool: path field
  if (typeof a.path === 'string') return a.path;
  // exec tool: command field
  if (typeof a.command === 'string') return a.command;
  // fallback
  try { return JSON.stringify(a); } catch { return ''; }
}

function isReadLikeTool(toolName = '') {
  const t = String(toolName).toLowerCase();
  return t === 'read' || t === 'readfile' || t === 'readcode' || t === 'read_file';
}

function isExecLikeTool(toolName = '') {
  const t = String(toolName).toLowerCase();
  return t.includes('exec') || t.includes('shell') || t.includes('terminal') || t === 'bash';
}

// --- Audit logging ---

function createAuditAppender(api, eventsPath) {
  return (entry) => {
    try {
      fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
      const rec = {
        timestamp: new Date().toISOString(),
        pluginId: 'aco-objective-fact-guard',
        ...entry,
      };
      fs.appendFileSync(eventsPath, `${JSON.stringify(rec)}\n`);
    } catch (e) {
      api.logger.warn(`[aco-objective-fact-guard] failed to write audit: ${e.message}`);
    }
  };
}

// --- Plugin ---

const objectiveFactGuardPlugin = {
  id: 'aco-objective-fact-guard',
  name: '客观事实守卫',
  description: '强制注入客观事实优先约束，降低记忆误导，功能化守卫任务状态汇报',
  version: '1.2.0',

  register(api) {
    const rawConfig = api.pluginConfig?.['aco-objective-fact-guard'] || {};
    const config = resolveConfig(rawConfig);

    if (!config.enabled) {
      api.logger?.info?.('[aco-objective-fact-guard] plugin disabled via config');
      return;
    }

    const EVIDENCE_TTL_MS = config.thresholds.evidenceTtlMs;
    const TASK_BOARD_NEEDLE = config.evidence.taskBoardNeedle;
    const OPENCLAW_CONFIG_NEEDLE = config.evidence.configNeedle;
    const EVENTS_PATH = process.env.FACT_GUARD_EVENTS_PATH || config.paths.events;
    const LOG_PREVIEW_CHARS = config.thresholds.logPreviewChars;

    const _statusDetectionCache = new FactGuardLRUCache(config.thresholds.statusDetectionCacheSize);
    const appendAuditEvent = createAuditAppender(api, EVENTS_PATH);

    // Determine the prompt to inject
    const notificationFactGuardPrompt = FACT_GUARD_PROMPT.replaceAll('{NOTIFY_USER_ID}', config.notify.userId);
    const baseFactGuardPrompt = config.rules.objectiveFactPrompt || `${QUERY_INVESTIGATION_MODE_PROMPT}\n\n${notificationFactGuardPrompt}`;
    const factGuardPrompt = `${SEVO_ROUTING_MANDATE_PROMPT}\n\n${baseFactGuardPrompt}`;

    function markBoardRead(ctx) {
      boardReadBySession.set(sessionKeyOf(ctx), nowMs());
    }

    function hasBoardRead(ctx) {
      const t = boardReadBySession.get(sessionKeyOf(ctx));
      return typeof t === 'number' && (nowMs() - t) <= EVIDENCE_TTL_MS;
    }

    function markConfigRead(ctx) {
      configReadBySession.set(sessionKeyOf(ctx), nowMs());
    }

    // 1) before_prompt_build — 提示注入（保留原有能力）
    api.on(
      'before_prompt_build',
      (event, _ctx) => {
        void event;
        if (!objectiveFactGuardGlobal.promptLogged) {
          api.logger.info('[aco-objective-fact-guard] injecting objective-fact rule via before_prompt_build');
          objectiveFactGuardGlobal.promptLogged = true;
        }
        return {
          prependContext: factGuardPrompt,
        };
      },
      { priority: 1000 },
    );

    // 2) before_tool_call — 任务状态读取追踪
    api.on(
      'before_tool_call',
      (event, ctx) => {
        const toolName = String(event?.toolName || ctx?.toolName || '');
        const toolText = extractToolText(event);
        const sk = sessionKeyOf(ctx);

        const isBoard = containsNeedle(toolText, TASK_BOARD_NEEDLE);
        const isConfig = containsNeedle(toolText, OPENCLAW_CONFIG_NEEDLE);

        if (!isBoard && !isConfig) return null;

        if (isReadLikeTool(toolName) || isExecLikeTool(toolName)) {
          if (isBoard) {
            markBoardRead(ctx);
            appendAuditEvent({
              decision: 'observe',
              ruleId: 'fact.board_read.detected',
              reason: `session ${sk} read task board via ${toolName}`,
              toolName,
              details: { sessionKey: sk },
            });
          }
          if (isConfig) {
            markConfigRead(ctx);
            appendAuditEvent({
              decision: 'observe',
              ruleId: 'fact.config_read.detected',
              reason: `session ${sk} read openclaw.json via ${toolName}`,
              toolName,
              details: { sessionKey: sk },
            });
          }
        }

        return null; // never block reads, only track
      },
      { priority: 950 },
    );

    // 3) message_sending — 状态汇报守卫
    api.on(
      'message_sending',
      async (event, ctx) => {
        const content = String(event.content || '');

        // LLM-based detection with LRU cache
        const isStatus = await isTaskStatusReport(content, config, _statusDetectionCache);
        if (!isStatus) {
          return null;
        }

        if (hasBoardRead(ctx)) {
          appendAuditEvent({
            decision: 'allow',
            ruleId: 'fact.status_report.board_verified',
            reason: 'status report allowed — board was read this turn',
            details: { sessionKey: sessionKeyOf(ctx) },
          });
          return null;
        }

        // Block: status report without board read
        const sk = sessionKeyOf(ctx);
        appendAuditEvent({
          decision: 'block',
          ruleId: 'fact.status_report.no_board_read',
          reason: `blocked status report from session ${sk} — task board not read in current turn`,
          details: { sessionKey: sk, contentSnippet: sanitizeForLog(content, LOG_PREVIEW_CHARS) },
        });

        return {
          cancel: true,
          content: config.messages.blockStatusNoBoardRead,
        };
      },
      { priority: 1050 },
    );

    if (!objectiveFactGuardGlobal.registeredLogged) {
      api.logger.info('aco-objective-fact-guard: plugin registered (v1.2.0 — functional hooks enabled)');
      objectiveFactGuardGlobal.registeredLogged = true;
    }
  },
};

export default objectiveFactGuardPlugin;
