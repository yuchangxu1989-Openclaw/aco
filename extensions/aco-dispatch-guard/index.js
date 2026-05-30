/**
 * Agent Dispatch Guard Plugin
 * 强制注入Agent调度规范，并提供功能化MVP（准入/治理/审计）
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// ── SEVO Pipeline Integration (async init with fallback) ──
let _sevoStageChain = null;
const _sevoInitPromise = (async () => {
  try {
    const sevoTaskMapper = await import('../sevo-pipeline/task-mapper.js');
    _sevoStageChain = sevoTaskMapper.STAGE_FALLBACK_CHAIN;
  } catch {
    // SEVO pipeline plugin not available — fallback to hardcoded ROLE_TASK_MAP
  }
})();

const DISPATCH_GUARD_GLOBAL_KEY = Symbol.for('openclaw.aco-dispatch-guard.instance');
const dispatchGuardGlobal = globalThis[DISPATCH_GUARD_GLOBAL_KEY] || (globalThis[DISPATCH_GUARD_GLOBAL_KEY] = {
  registeredLogged: false,
  promptLogged: false,
  configWatcherStarted: false,
});


const resolveOpenclawHome = () => process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
const OPENCLAW_HOME = resolveOpenclawHome();
const OPENCLAW_CONFIG = path.join(OPENCLAW_HOME, 'openclaw.json');
const DEFAULT_EVENTS_PATH = path.join(OPENCLAW_HOME, 'workspace', 'logs', 'dispatch-guard-events.jsonl');
const TASK_BOARD_PATH = path.join(OPENCLAW_HOME, 'workspace', 'logs', 'subagent-task-board.json');
// [M-10 fix] MAX_CONCURRENT_ACP 边界校验：1-10
// 2026-05-05: ACP 进程各自仅占 4-5% CPU + 150-300MB RAM，5路并行完全安全
// 之前限制为4是因为误将 PM2 next start 的 CPU 占用归因于 ACP
const MAX_CONCURRENT_ACP = Math.max(1, Math.min(10, Number(process.env.DISPATCH_GUARD_MAX_ACP || 8)));

const AGENT_TIER_FALLBACK = [
  { id: 'cc', runtime: 'acp', tier: 1 },
  { id: 'free-code', runtime: 'acp', tier: 1 },
  { id: 'opencode', runtime: 'acp', tier: 2 },
  { id: 'codex', runtime: 'acp', tier: 2 },
  { id: 'hermes', runtime: 'acp', tier: 3 },
  { id: 'dev-01', runtime: 'subagent', tier: 4 },
  { id: 'dev-02', runtime: 'subagent', tier: 4 },
  { id: 'sa-01', runtime: 'subagent', tier: 'arch' },
  { id: 'pm-01', runtime: 'subagent', tier: 'pm' },
];

const DISPATCH_GUARD_PROMPT = `## 🎯 Agent调度铁律（系统级强制约束）

### 0. 看板自查铁律（强制，最高优先级）
**每个回合开头，只要本回合可能涉及任务状态判断（用户问进度 / 你准备说"还在跑"或"已完成" / 你准备 spawn 新任务前判断 agent 是否空闲），必须先用 jq 实读 \`${TASK_BOARD_PATH}\`，再回复。**

**禁止**：
- 依赖 completion event push 作为唯一信息源（Gateway restart / drain timeout / announce retry 耗尽都会让 push 丢失）
- 用记忆里的 sessionKey 状态当结论（会话压缩、Gateway 重启、看板异步更新都会让记忆和事实脱节）
- 没查看板就说"应该还在跑"或"应该已完成"

**正确做法**：
\`jq -r '.tasks[] | select(.status=="running") | "\\(.agentId) \\(.title) startedAt=\\(.startedAt)"' ${TASK_BOARD_PATH}\`

**违反后果**：用户告诉你状态变化而你没察觉 = P0 badcase。

### 1. 任务时长标准（强制）
派子Agent前，必须按任务类型设定timeoutSeconds：

| 任务类型 | 标准时长 | 说明 |
|----------|----------|------|
| **简单查询/代码审查** | 600s (10min) | 单个问题、读文件、轻量分析 |
| **中等开发任务** | 1200s (20min) | 功能实现、bug修复、重构 |
| **深度调研报告** | 1800s (30min) | 行业分析、案例研究、方法论 |
| **架构设计** | 3600s (60min) | 复杂系统设计、大规模重构 |

**禁止**：随意缩短时长（如设300s调研任务）

### 2. 禁止Poll（强制）
- sessions_spawn后**禁止**轮询/睡眠等待
- 子Agent通过completion event自动汇报结果
- 采用push-based而非polling
- 主Agent保持通信通道畅通

### 3. Agent选择验证（强制）
派生子Agent前，**必须**先查证：
1. 检查 \`openclaw.json\` 中的agents配置
2. **确认agentId存在且配置正确**
3. **禁止依赖fallback机制**
4. **不得使用不存在的agentId**（如coder、reviewer、analyst、scout等）

**Agent配置唯一真相源：${OPENCLAW_CONFIG}（强制）**
- \`agents/\` 目录下的物理文件夹可能残留已删除的Agent
- **唯一可信来源是 \`${OPENCLAW_CONFIG}\` 中的 \`agents.list\`**
- 派生子Agent前，**必须以 ${OPENCLAW_CONFIG} 配置为准**，不得仅依赖文件夹存在性
- 当文件系统与 ${OPENCLAW_CONFIG} 冲突时，以 ${OPENCLAW_CONFIG} 为准
- **当前可用Agent必须实时读取 \`${OPENCLAW_CONFIG}\`，禁止硬编码历史列表**

**模型配置唯一真相源：${OPENCLAW_CONFIG}（强制）**
- 模型/provider 选择的唯一可信来源是 \`${OPENCLAW_CONFIG}\` 中的 \`models.providers\`
- 选模型前必须校验 \`providerId/modelId\` 在 \`models.providers\` 中存在
- 当运行时枚举、缓存、历史会话与 ${OPENCLAW_CONFIG} 冲突时，以 ${OPENCLAW_CONFIG} 为准
- 禁止基于“历史可用性印象”假定能力（如 xhigh）；必须以当前 provider/model 实测能力为准

### 4. MECE拆分原则（强制）
复杂任务、处理数据量过大的任务，必须：
1. 按MECE原则拆解为子任务
2. 评估单个子任务是否超过单Agent产能
3. 批量spawn(≥2个)后立即输出队列状态汇报
4. 禁止等用户催促才汇报

### 5. 禁止行为
- ❌ "先解释再派发" → 要dispatch FIRST
- ❌ "等第一波完成再派第二波" → 要全部enqueue
- ❌ "手动跟踪任务状态" → 看板自动跟踪
- ❌ 使用不存在/未验证的agentId

### 6. 开发→审计顺序约束（强制）
- **开发任务完成后**，必须创建对应的**质量审计任务**
- 审计任务默认由 audit-01 执行
- 若 audit-01 不可用，可降级到其他非开发 Agent（如 codex）
- 不允许开发 Agent 自审
- 审计触发时机：收到开发任务的completion event后自动派发
- 禁止在开发任务完成前提前派发审计任务

**执行链条**：
开发任务执行 → completion event → 自动派发审计任务 → 审计通过 → 任务闭环

### 7. 主会话保持空闲铁律（强制）
- 主会话（main）只做：接收消息、判断意图、派发任务、秒级回复
- 预计超过 30 秒的工作必须派给子 Agent 或 ACP
- 禁止主会话亲自执行耗时操作（调研、开发、长文生成、批量检查等）
- 原因：Gateway 已知缺陷——主会话处理消息期间，用户新消息会被静默丢弃（dispatch replies=0, queuedFinal=false）
- 主会话可做的事：读文件确认内容、秒级判断后派发、短回复、更新文档
- 主会话不可做的事：web_search 多轮调研、逐文件审查、长篇报告撰写、代码开发

违反以上 = Badcase，需记录并修正。

### 8. SEVO 流水线（强制）
SEVO 触发由 sevo-pipeline 插件自动判定和路由，主会话不做独立判断。任务走流水线时按提示执行 \`sevo:create <project-slug>\`。

### 9. 失败即时重派（强制）
- 收到失败/不完整 completion 时，若资源池有空闲 agent，立即优化任务描述/粒度后重派
- 不等同批其他任务回收，资源最大化利用
- 同梯队失败 1 次后禁止原样重派，必须拆分或升级梯队
- 实质失败判定：completion 到达后，若 output_tokens 极低（如 <3k）且未写入任何文件，视为实质失败，即使 status=succeeded

### 10. 运行中任务补充（强制）
- 对已派发的进行中任务有新信息/约束补充时，**默认走 kill + 重派**，不要 steer。
  1. **steer 是高风险动作**：subagents(action=steer) 内部是 mode=restart，会把目标任务从 0 重新拉起读 prompt，进度全丢；连续多次 steer = 任务永远从 0 开始，必然失败。
  2. **steer 仅限以下场景**：(a) 任务刚 spawn 60 秒内，模型还在读取 prompt 阶段；(b) 单次单条小约束补充，且发出后立即查 subagent-task-board.json 确认目标 sessionKey 仍 running。
  3. **超过 60 秒 / 第二次以上的约束补充 / 多条收敛合并**：必须 kill 旧任务（subagents action=kill）→ 把所有约束合并成一份完整 prompt → 重新 sessions_spawn。
  4. **每次 steer / kill+重派后必须立即读看板**：确认目标任务真实状态；不读看板就再发约束 = 可能在向已死任务重复发指令。
- 禁止等任务自然完成后再返工，浪费资源和时间

### 11. 长文档分段式写作（强制）
- 适用范围：预估产出 >300 行或 >15KB 的文档任务（spec、arc42、设计文档、深度报告）
- **首次派发即分段**：不等失败才拆，预估超阈值时直接按分段策略派发
- 第一段：输出目录 + 前半章节，确认文件写入成功
- 第二段：续写剩余章节（task prompt 引用第一段产出路径，要求 append/edit 而非覆盖）
- 多 Agent 交叉写作：A 写前半，B 写后半，最后由架构方合并
- 失败后禁止原样重派，必须拆段或升级

### 主会话耗时命令禁令（强制）
- 主会话（main）禁止通过 exec 工具执行以下类型的命令：
  - 构建命令：npm run build、npx next build、npx tsc、npx webpack、NODE_OPTIONS=*build*
  - 安装命令：npm install、npm ci、pip install、apt install
  - 清理+重建：rm -rf .next、rm -rf node_modules、rm -rf dist
  - 服务启停：npx next start、nohup、pkill、kill、systemctl restart
  - 长时间运行：任何预估超过 30 秒的 exec 命令
- 检测到以上命令时，必须改为派子 Agent 执行
- 主会话只允许执行秒级完成的命令：cat、head、tail、ls、grep、wc、curl（单次快速请求）、sqlite3（单条查询）
- 违反后果：主会话阻塞期间用户消息被静默丢弃（Gateway 已知缺陷）
`;

// ── Role-Task Matching Rules ──────────────────────────────────────────

// Fallback agent lists per role. Runtime normally builds this from openclaw.json agents.list[].role.
const ROLE_AGENTS_FALLBACK = {
  pm: ['pm-01', 'pm-02'],
  research: ['re'],
  architecture: ['sa-01', 'sa-02'],
  coding: ['cc', 'free-code', 'opencode', 'codex', 'hermes', 'dev-01', 'dev-02'],
  review: ['audit-01', 'audit-02'],
  ux: ['ux-01'],
};

const VALID_ROLES = new Set(['coding', 'pm', 'architecture', 'review', 'ux', 'research']);

// Role → task types. Keep this in sync with the classifier prompt.
const ROLE_TASK_TYPES = {
  pm: ['spec', 'readme'],
  research: ['research'],
  architecture: ['ac'],
  coding: ['code'],
  review: ['audit'],
  ux: ['ux'],
};

// SEVO stage → dispatch-guard task type (only stages with a direct task-type equivalent)
const STAGE_TO_DISPATCH_TYPE = {
  'spec': 'spec',
  'contract': 'ac',
  'implement': 'code',
  'review': 'audit',
  'ux-acceptance': 'ux',
};

/**
 * Build ROLE_TASK_MAP from SEVO STAGE_FALLBACK_CHAIN.
 * Inverts the chain (stage→roles) into (role→taskTypes), then into (taskType→agents).
 * Falls back to hardcoded map if SEVO data is unavailable.
 */
function buildRoleMapFromSevo(stageChain, roleAgents = ROLE_AGENTS_FALLBACK) {
  if (!stageChain) return null;

  // Step 1: Invert chain → role → Set<stage>
  const roleToStages = {};
  for (const [stage, roles] of Object.entries(stageChain)) {
    for (const role of roles) {
      if (role === 'general') continue;
      if (!roleToStages[role]) roleToStages[role] = new Set();
      roleToStages[role].add(stage);
    }
  }

  // Step 2: role → taskTypes (via stage→taskType mapping)
  const roleToTaskTypes = {};
  for (const [role, stages] of Object.entries(roleToStages)) {
    const types = new Set();
    for (const stage of stages) {
      const t = STAGE_TO_DISPATCH_TYPE[stage];
      if (t) types.add(t);
    }
    if (types.size > 0) roleToTaskTypes[role] = [...types];
  }

  // Extra: pm also handles readme (not a SEVO stage but a dispatch-guard task type)
  if (roleToTaskTypes.pm) {
    if (!roleToTaskTypes.pm.includes('readme')) roleToTaskTypes.pm.push('readme');
  } else {
    roleToTaskTypes.pm = ['readme'];
  }

  // Step 3: Invert to taskType → agents
  const taskMap = {};
  for (const [role, taskTypes] of Object.entries(roleToTaskTypes)) {
    const agents = roleAgents[role] || [];
    for (const taskType of taskTypes) {
      if (!taskMap[taskType]) taskMap[taskType] = [];
      taskMap[taskType].push(...agents);
    }
  }

  return taskMap;
}

function buildRoleTaskMapFromRoleAgents(roleAgents) {
  const taskMap = {};
  const allAgents = new Set();

  for (const [role, agents] of Object.entries(roleAgents || {})) {
    if (!Array.isArray(agents) || agents.length === 0) continue;
    agents.forEach((id) => allAgents.add(id));
    const taskTypes = ROLE_TASK_TYPES[role] || [];
    for (const taskType of taskTypes) {
      if (!taskMap[taskType]) taskMap[taskType] = [];
      taskMap[taskType].push(...agents);
    }
  }

  // data-ops is intentionally broad: any declared role may perform data inspection/cleanup.
  if (allAgents.size > 0) taskMap['data-ops'] = [...allAgents];

  return taskMap;
}

function filterTaskMapToAgents(taskMap, agentIds) {
  const ids = new Set(agentIds || []);
  if (ids.size === 0) return taskMap;
  const filtered = {};
  for (const [taskType, agents] of Object.entries(taskMap || {})) {
    filtered[taskType] = (agents || []).filter((id) => ids.has(id));
  }
  return filtered;
}

// Hardcoded fallback (used when openclaw.json is unreadable)
const ROLE_TASK_MAP_FALLBACK = {
  spec: ['pm-01', 'pm-02', 'sa-01', 'sa-02'],
  ac: ['sa-01', 'sa-02'],
  code: ['cc', 'free-code', 'opencode', 'codex', 'hermes', 'dev-01', 'dev-02', 'sa-01', 'sa-02', 're'],
  'data-ops': ['cc', 'free-code', 'opencode', 'codex', 'hermes', 'dev-01', 'dev-02', 'sa-01', 'sa-02', 'audit-01', 'audit-02', 'pm-01', 'pm-02', 'ux-01', 're'],
  audit: ['audit-01', 'audit-02', 'sa-01', 'sa-02', 'pm-01', 'pm-02'],
  ux: ['ux-01'],
  readme: ['pm-01', 'pm-02', 'sa-01', 'sa-02'],
  research: ['re'],
};

let _roleRegistryCache = null;
let _roleTaskMapCache = null;
let _agentTierCache = null;

function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase();
  return VALID_ROLES.has(value) ? value : null;
}

function runtimeTypeOf(agent) {
  if (typeof agent?.runtime === 'string') return agent.runtime;
  if (agent?.runtime && typeof agent.runtime.type === 'string') return agent.runtime.type;
  return 'subagent';
}

function inferAcpTier(agent) {
  const explicit = agent?.tier ?? agent?.runtime?.tier;
  if (explicit !== undefined && explicit !== null && explicit !== '') return explicit;

  const model = String(agent?.model || '').toLowerCase();
  if (/haiku|mini|flash|lite|small|low/.test(model)) return 3;
  if (/opus|gpt-5\.5|gpt-5|o3|o4|xhigh|high|thinking/.test(model)) return 1;
  return 2;
}

function buildAgentTierFromConfigAgents(agents) {
  return (agents || [])
    .filter((agent) => agent && agent.id)
    .map((agent) => {
      const runtime = runtimeTypeOf(agent);
      const tier = runtime === 'acp' ? inferAcpTier(agent) : (agent.tier || 4);
      return { id: agent.id, runtime, tier };
    });
}

function loadRoleRegistry() {
  if (_roleRegistryCache) return _roleRegistryCache;

  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG, 'utf8');
    const cfg = JSON.parse(raw || '{}');
    const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list.filter((a) => a && a.id) : [];
    const agentIds = agents.map((a) => a.id);
    const roleAgents = {};
    const roleByAgent = {};
    const invalidRoles = [];

    for (const agent of agents) {
      if (!Object.prototype.hasOwnProperty.call(agent, 'role')) continue;
      const role = normalizeRole(agent.role);
      if (!role) {
        if (agent.role !== undefined && agent.role !== null && String(agent.role).trim() !== '') {
          invalidRoles.push({ id: agent.id, role: agent.role });
        }
        continue;
      }
      if (!roleAgents[role]) roleAgents[role] = [];
      roleAgents[role].push(agent.id);
      roleByAgent[agent.id] = role;
    }

    const hasAnyRole = Object.keys(roleAgents).length > 0;
    const singleMainOnly = agents.length === 1 && agents[0]?.id === 'main';
    const mode = hasAnyRole ? 'enforce' : (singleMainOnly ? 'open' : 'warn');
    const dynamicTaskMap = hasAnyRole
      ? buildRoleTaskMapFromRoleAgents(roleAgents)
      : (singleMainOnly ? {} : filterTaskMapToAgents(ROLE_TASK_MAP_FALLBACK, agentIds));

    _roleRegistryCache = {
      mode,
      source: hasAnyRole ? 'openclaw.json:agents.list.role' : 'openclaw.json:agents.list.no_role',
      roleAgents,
      roleByAgent,
      roleTaskMap: dynamicTaskMap,
      agentTier: buildAgentTierFromConfigAgents(agents),
      agentCount: agents.length,
      invalidRoles,
      configReadOk: true,
    };
    return _roleRegistryCache;
  } catch (e) {
    _roleRegistryCache = {
      mode: 'fallback-enforce',
      source: 'fallback:openclaw_config_unreadable',
      roleAgents: ROLE_AGENTS_FALLBACK,
      roleByAgent: Object.fromEntries(
        Object.entries(ROLE_AGENTS_FALLBACK).flatMap(([role, ids]) => ids.map((id) => [id, role]))
      ),
      roleTaskMap: buildRoleMapFromSevo(_sevoStageChain, ROLE_AGENTS_FALLBACK) || ROLE_TASK_MAP_FALLBACK,
      agentTier: AGENT_TIER_FALLBACK,
      agentCount: 0,
      invalidRoles: [],
      configReadOk: false,
      error: String(e?.message || e),
    };
    return _roleRegistryCache;
  }
}

function getRoleTaskMap() {
  if (!_roleTaskMapCache) {
    _roleTaskMapCache = loadRoleRegistry().roleTaskMap;
  }
  return _roleTaskMapCache;
}

function getAgentTier() {
  if (!_agentTierCache) {
    _agentTierCache = loadRoleRegistry().agentTier;
  }
  return _agentTierCache;
}

function clearDispatchGuardCaches() {
  _roleRegistryCache = null;
  _roleTaskMapCache = null;
  _agentTierCache = null;
  if (_taskTypeCache && typeof _taskTypeCache.clear === 'function') _taskTypeCache.clear();
}

// Re-resolve after async init completes
_sevoInitPromise.then(() => { clearDispatchGuardCaches(); });

const DEFAULT_TASK_TYPE_CACHE_TTL_MS = 5 * 60 * 1000;

function resolveTaskTypeCacheTtlMs() {
  const raw = Number(process.env.DISPATCH_GUARD_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TASK_TYPE_CACHE_TTL_MS;
}

// ── LRU Cache for LLM task-type classification ──
class LRUCache {
  constructor(maxSize = 100, ttlMs = DEFAULT_TASK_TYPE_CACHE_TTL_MS) {
    this._max = maxSize;
    this._ttlMs = ttlMs;
    this._map = new Map();
  }
  get(key) {
    if (!this._map.has(key)) return undefined;
    const entry = this._map.get(key);
    const ttlMs = resolveTaskTypeCacheTtlMs();
    if (ttlMs > 0 && Date.now() - entry.timestamp > ttlMs) {
      this._map.delete(key);
      return undefined;
    }
    // Move to end (most recently used)
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }
  set(key, val) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, { value: val, timestamp: Date.now() });
    // Evict oldest if over capacity
    if (this._map.size > this._max) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
  }
  clear() {
    this._map.clear();
  }
}

const _taskTypeCache = new LRUCache(100, resolveTaskTypeCacheTtlMs());

// SEVO stage → task type mapping (deterministic, no LLM needed)
const SEVO_STAGE_TYPE_MAP = {
  'spec': 'spec',
  'spec-review-gate': 'spec',
  'contract': 'ac',
  'contract-review-gate': 'ac',
  'plan': 'ac',
  // 'implement' intentionally omitted: falls through to LLM classifier
  // because implement tasks can be 'code' OR 'data-ops' depending on content
  'review': 'audit',
  'smoke-test': 'audit',
  'regression': 'audit',
  'ux-acceptance': 'audit',
  'pm-commercial-review': 'audit',
  'deploy': 'code',
  'verify': 'code',
  'post-release-validation': 'code',
};

/**
 * Resolve LLM provider config from openclaw.json for lightweight classification calls.
 * Returns { baseUrl, apiKey, model } or null if unavailable.
 */
function resolveLlmConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));
    const providers = cfg.models?.providers || {};
    const defaultModelStr = cfg.agents?.defaults?.model?.primary || ''; // e.g. "penguin-main/claude-opus-4-6-thinking"
    const [defaultProviderId, defaultModelId] = defaultModelStr.includes('/')
      ? defaultModelStr.split('/', 2)
      : [null, null];

    // Try default provider first
    if (defaultProviderId && providers[defaultProviderId]?.apiKey) {
      const p = providers[defaultProviderId];
      // Prefer a non-thinking model for classification (faster, cheaper)
      const models = Array.isArray(p.models) ? p.models : [];
      const nonThinking = models.find((m) => !m.reasoning && m.id);
      const modelId = nonThinking?.id || defaultModelId || models[0]?.id;
      if (modelId) return { baseUrl: p.baseUrl, apiKey: p.apiKey, model: modelId };
    }

    // Fallback: first provider with apiKey and at least one model
    for (const [, p] of Object.entries(providers)) {
      if (!p.apiKey || !p.baseUrl) continue;
      const models = Array.isArray(p.models) ? p.models : [];
      const nonThinking = models.find((m) => !m.reasoning && m.id);
      const modelId = nonThinking?.id || models[0]?.id;
      if (modelId) return { baseUrl: p.baseUrl, apiKey: p.apiKey, model: modelId };
    }
  } catch { /* config unreadable */ }
  return null;
}

/**
 * Build the chat completions endpoint URL from a provider baseUrl.
 */
function buildChatEndpoint(baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

const TASK_TYPE_DESCRIPTION_FALLBACK = {
  spec: '撰写需求规格书、写 spec、写产品需求文档、定义 FR/AC（即使内容中提到 AC，只要任务目标是"写文档"就是 spec）',
  ac: '架构分析、架构设计、技术方案、设计评审、重构方案、技术选型、系统分析、出方案、架构评审、实现架构契约（架构师做的所有工作都是 ac）',
  code: '通用编码、功能开发、bug 修复、重构、按 AC 写代码实现功能',
  audit: '代码审计、质量审查、安全审计',
  ux: 'UX 评审、浏览器走查、视觉验证',
  readme: '写 README、写文档',
  'data-ops': '数据库操作、数据清理、批量更新、知识库治理、sqlite操作、数据评测、数据核查、数据加工等数据运维任务（任何角色都可以执行）',
  research: '调研、分析、资料搜集、竞品分析、行业报告撰写',
};

const DEFAULT_TASK_TYPES = Object.keys(TASK_TYPE_DESCRIPTION_FALLBACK);

function normalizeTaskType(type) {
  return String(type || '').trim().toLowerCase().replace(/data[_]?ops/, 'data-ops');
}

function getClassifierTaskTypes(roleTaskMap = getRoleTaskMap()) {
  const types = Object.keys(roleTaskMap || {})
    .map(normalizeTaskType)
    .filter(Boolean);
  return types.length > 0 ? [...new Set(types)] : DEFAULT_TASK_TYPES;
}

function describeTaskType(taskType) {
  const normalized = normalizeTaskType(taskType);
  return TASK_TYPE_DESCRIPTION_FALLBACK[normalized]
    || `当前 ROLE_TASK_MAP 中定义的 ${normalized} 类型任务，请根据 label/prompt 语义判断是否属于该类型`;
}

function buildClassifierSystemPrompt(roleTaskMap = getRoleTaskMap()) {
  const taskTypes = getClassifierTaskTypes(roleTaskMap);
  const typeList = taskTypes.join(' / ');
  const rules = taskTypes
    .map((taskType) => `- ${taskType} = ${describeTaskType(taskType)}`)
    .join('\n');

  return `你是任务分类器。根据任务 label 和 prompt 前 500 字，判断任务类型。只输出一个词：${typeList}

分类规则：
${rules}

关键区分："写一份包含 AC 的 spec" = spec，"出架构方案/技术分析/设计评审" = ac，"按方案写代码实现" = code`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractTaskTypeFromClassifierResult(content, taskTypes) {
  const text = String(content || '').trim().toLowerCase();
  for (const taskType of taskTypes) {
    const normalized = normalizeTaskType(taskType);
    const variants = normalized === 'data-ops'
      ? ['data-ops', 'data_ops', 'dataops']
      : [normalized];
    for (const variant of variants) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}_-])${escapeRegExp(variant)}([^\\p{L}\\p{N}_-]|$)`, 'iu');
      if (re.test(text)) return normalized;
    }
  }
  return null;
}

/**
 * Detect task type from agent id + label + prompt text.
 * - Audit agents: deterministic audit classification (prevents audit prompts with build/typecheck commands being misclassified as code).
 * - SEVO labels: deterministic stage parsing (no LLM).
 * - Non-SEVO: LLM semantic classification with LRU cache.
 * - Fallback to warn mode on LLM timeout/failure.
 */
async function detectTaskType(label, prompt, agentId = '') {
  // 0. Audit agents always run audit tasks. Do this before any prompt/label
  // content checks so audit prompts containing build/typecheck commands are not
  // misclassified as code validation tasks.
  if (typeof agentId === 'string' && /^audit-/.test(agentId)) {
    return { type: 'audit', source: 'agent-id', classifierFailed: false, promptSummary: '' };
  }

  // 1a. SEVO create labels: sevo:create <project> → always spec
  if (label && /^sevo:create\b/i.test(label)) {
    return { type: 'spec', source: 'sevo-create-label', classifierFailed: false, promptSummary: '' };
  }

  // 1b. SEVO pipeline labels: sevo:<id>:<stage>:<attempt>
  if (label) {
    const sevoMatch = label.match(/^sevo:[^:]+:([^:]+):/i);
    if (sevoMatch) {
      const stage = sevoMatch[1].toLowerCase();
      const mapped = SEVO_STAGE_TYPE_MAP[stage];
      if (mapped) return { type: mapped, source: 'sevo-stage-label', classifierFailed: false, promptSummary: '' };
      // Stages not in the map (e.g. 'implement') fall through to LLM classifier
      // to determine actual task type (code vs data-ops etc.)
    }
  }

  // 1c. SEVO backdoor blocker: labels starting with sevo_ or sevo- that are NOT
  // proper SEVO pipeline labels are attempts to bypass SEVO flow. Block them.
  // Proper SEVO labels: sevo:create, sevo:<id>:<stage>:<attempt>
  if (label && /^sevo[_-]/i.test(label)) {
    return { type: '__sevo_bypass_attempt__', source: 'sevo-bypass-label', classifierFailed: false, promptSummary: '' };
  }

  // 2. Non-SEVO: LLM classification with cache
  const cacheKey = `${label || ''}|||${(prompt || '').slice(0, 500)}`;
  const cached = _taskTypeCache.get(cacheKey);
  if (cached) return cached;

  const llmCfg = resolveLlmConfig();
  if (!llmCfg) return { type: 'code', source: 'llm', classifierFailed: true, failureReason: 'llm_config_unavailable', promptSummary: (prompt || '').slice(0, 120) };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const endpoint = buildChatEndpoint(llmCfg.baseUrl);
    const promptSnippet = (prompt || '').slice(0, 500);
    const promptSummary = promptSnippet;
    const roleTaskMap = getRoleTaskMap();
    const classifierTaskTypes = getClassifierTaskTypes(roleTaskMap);
    const classifierSystemPrompt = buildClassifierSystemPrompt(roleTaskMap);

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmCfg.apiKey}`,
      },
      body: JSON.stringify({
        model: llmCfg.model,
        max_tokens: 16,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: classifierSystemPrompt,
          },
          {
            role: 'user',
            content: `label: ${label || '(none)'}\nprompt: ${promptSnippet || '(none)'}`,
          },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) return { type: 'code', source: 'llm', classifierFailed: true, failureReason: `llm_http_${resp.status}`, promptSummary };

    const data = await resp.json();
    const content = (data.choices?.[0]?.message?.content || '').trim().toLowerCase();
    const matched = extractTaskTypeFromClassifierResult(content, classifierTaskTypes);
    if (!matched) {
      return { type: 'code', source: 'llm', classifierFailed: true, failureReason: 'llm_unparseable_result', rawResult: content.slice(0, 120), promptSummary };
    }
    const result = {
      type: matched,
      source: 'llm',
      classifierFailed: false,
      confidence: null,
      rawResult: content.slice(0, 120),
      promptSummary,
    };

    _taskTypeCache.set(cacheKey, result);
    return result;
  } catch (e) {
    // fallback: network timeout or any other error
    return { type: 'code', source: 'llm', classifierFailed: true, failureReason: String(e?.name || e?.message || e), promptSummary: (prompt || '').slice(0, 500) };
  }
}

/**
 * Describe the expected role for a task type (for warning messages).
 */
function describeAgentRole(agentId) {
  const registry = loadRoleRegistry();
  if (registry.roleByAgent?.[agentId]) return registry.roleByAgent[agentId];
  for (const [role, agents] of Object.entries(registry.roleAgents || {})) {
    if ((agents || []).includes(agentId)) return role;
  }
  return 'unknown';
}

const README_QUALITY_RULES = `
## README 营销质量铁律（当任务涉及 README 时强制注入）

### 必须包含的结构
1. **Tagline**：一句话说清产品是什么、解决什么问题（≤20字）
2. **痛点共鸣**：目标用户遇到的具体痛苦（2-3句）
3. **核心优势**：为什么用这个而不是别的（3个bullet max）
4. **30秒快速体验**：从零到第一个成功结果的最短路径
5. **使用场景**：2-3个具体场景，让用户对号入座
6. **详细文档链接**：深入内容不堆在 README 里

### 禁止的写法
- ❌ 技术定义开头（"本项目是一个基于 XX 的 YY 框架"）
- ❌ Spec 术语泄露（FR-xxx、AC-xxx、NFR、SEVO、arc42）
- ❌ 版本号/日期占位（"v0.1.0-alpha"、"2024-xx-xx"）
- ❌ 内部架构暴露（模块名、内部 API、实现细节）
- ❌ 空洞承诺（"即将支持"、"计划中"）
- ❌ 工程文档风格（changelog、贡献指南放 README 正文）

### 验收标准
- 陌生人看前 20 行能回答："干嘛的？为什么我要用？"
- README 内容必须与 spec 对齐但不暴露 spec 术语
- 所有代码示例必须可直接复制运行
`;

function inferRuleId(errorMessage = '') {
  if (/missing agentId/.test(errorMessage)) return 'dispatch.agent.required';
  if (/agentId .* not in openclaw\.json/.test(errorMessage)) return 'dispatch.agent.not_in_config';
  if (/agentId main is forbidden/.test(errorMessage)) return 'dispatch.agent.main_forbidden';
  if (/prompt is required/.test(errorMessage)) return 'dispatch.prompt.required';
  if (/timeoutSec/.test(errorMessage)) return 'dispatch.timeout.below_minimum';
  return 'dispatch.unknown';
}

function extractEnqueuePayload(command = '') {
  const m = String(command).match(/enqueue\s+'([\s\S]+)'\s*$/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

const agentDispatchGuardPlugin = {
  id: 'aco-dispatch-guard',
  name: 'Agent调度守卫',
  version: '1.1.0',

  register(api) {
    const ENABLE_FUNCTIONAL = String(process.env.DISPATCH_GUARD_FUNCTIONAL_ENABLED || '1') !== '0';
    const EVENTS_PATH = process.env.DISPATCH_GUARD_EVENTS_PATH || DEFAULT_EVENTS_PATH;

    const readOpenclawConfig = () => {
      const raw = fs.readFileSync(OPENCLAW_CONFIG, 'utf8');
      return JSON.parse(raw || '{}');
    };

    const agentSetFromConfig = () => {
      const cfg = readOpenclawConfig();
      const ids = (cfg.agents?.list || []).map((x) => x?.id).filter(Boolean);
      return new Set(ids);
    };

    const appendAuditEvent = (entry) => {
      try {
        fs.mkdirSync(path.dirname(EVENTS_PATH), { recursive: true });
        const rec = {
          timestamp: new Date().toISOString(),
          pluginId: 'aco-dispatch-guard',
          ...entry,
        };
        fs.appendFileSync(EVENTS_PATH, `${JSON.stringify(rec)}\n`);
      } catch (e) {
        api.logger.warn(`[aco-dispatch-guard] failed to write audit: ${e.message}`);
      }
    };

    const readBusyAgentIds = () => {
      try {
        const raw = fs.readFileSync(TASK_BOARD_PATH, 'utf8');
        const board = JSON.parse(raw || '{}');
        const tasks = Array.isArray(board.tasks) ? board.tasks : [];
        return new Set(
          tasks
            .filter((t) => t && t.status === 'running' && t.agentId)
            .map((t) => t.agentId)
        );
      } catch {
        return new Set();
      }
    };

    const countRunningAcpTasks = () => {
      try {
        const raw = fs.readFileSync(TASK_BOARD_PATH, 'utf8');
        const board = JSON.parse(raw || '{}');
        const tasks = Array.isArray(board.tasks) ? board.tasks : [];
        const acpAgentIds = new Set(getAgentTier().filter((a) => a.runtime === 'acp').map((a) => a.id));
        return tasks.filter(
          (t) => t && t.status === 'running' && acpAgentIds.has(t.agentId)
        ).length;
      } catch {
        return 0;
      }
    };

    /**
     * Detect stale completions: done tasks within 15 minutes that have no follow-up audit.
     * Returns array of { agentId, label } for unprocessed tasks, or empty array.
     */
    const detectStaleCompletions = () => {
      try {
        const raw = fs.readFileSync(TASK_BOARD_PATH, 'utf8');
        if (!raw || !raw.trim()) return [];
        const board = JSON.parse(raw);
        const tasks = Array.isArray(board.tasks) ? board.tasks : [];
        if (tasks.length === 0) return [];

        const now = Date.now();
        const FIFTEEN_MIN = 15 * 60 * 1000;

        // Find done tasks completed within last 15 minutes
        const recentDone = tasks.filter((t) => {
          if (!t || t.status !== 'done') return false;
          if (!t.completedAt) return false;
          const completedTime = new Date(t.completedAt).getTime();
          if (isNaN(completedTime)) return false;
          return (now - completedTime) <= FIFTEEN_MIN;
        });

        if (recentDone.length === 0) return [];

        // For each recent done task, check if it's "processed"
        const unprocessed = recentDone.filter((doneTask) => {
          const label = String(doneTask.label || '').toLowerCase();

          // Audit tasks don't need follow-up audit
          if (label.includes('audit')) return false;

          // Check if there's a follow-up audit task for this done task
          const labelKeywords = label.split(/[\s\-_:]+/).filter((w) => w.length > 2);
          const hasFollowUp = tasks.some((t) => {
            if (!t || t === doneTask) return false;
            const tLabel = String(t.label || '').toLowerCase();
            if (!tLabel.includes('audit')) return false;
            // Check if the audit task label contains at least one keyword from the original
            return labelKeywords.some((kw) => tLabel.includes(kw));
          });

          return !hasFollowUp;
        });

        return unprocessed.map((t) => ({
          agentId: t.agentId || 'unknown',
          label: t.label || '(no label)',
        }));
      } catch {
        // File doesn't exist, parse error, etc. — silently return empty
        return [];
      }
    };

    const autoAssignAgent = () => {
      const configAgents = agentSetFromConfig();
      const busyIds = readBusyAgentIds();
      // Filter AGENT_TIER to only agents present in openclaw.json, exclude main and audit-01
      const candidates = getAgentTier().filter(
        (a) => configAgents.has(a.id) && a.id !== 'main' && a.id !== 'audit-01'
      );
      // Try to find first idle agent by tier order
      const idle = candidates.find((a) => !busyIds.has(a.id));
      if (idle) {
        return { id: idle.id, runtime: idle.runtime, allBusy: false };
      }
      // All busy — fallback to first candidate
      if (candidates.length > 0) {
        return { id: candidates[0].id, runtime: candidates[0].runtime, allBusy: true };
      }
      return null;
    };

    const appendRoleRegistryEvent = (reason) => {
      const registry = loadRoleRegistry();
      appendAuditEvent({
        decision: registry.mode === 'enforce' || registry.mode === 'fallback-enforce' ? 'observe' : 'warn',
        ruleId: 'dispatch.role_registry.loaded',
        reason,
        mode: registry.mode,
        source: registry.source,
        agentCount: registry.agentCount,
        roleAgents: registry.roleAgents,
        roleTaskMap: registry.roleTaskMap,
        agentTier: registry.agentTier,
        invalidRoles: registry.invalidRoles,
        configReadOk: registry.configReadOk,
        error: registry.error || null,
      });
    };

    const startConfigWatcher = () => {
      if (dispatchGuardGlobal.configWatcherStarted) return;
      dispatchGuardGlobal.configWatcherStarted = true;
      try {
        fs.watch(OPENCLAW_CONFIG, { persistent: false }, () => {
          clearDispatchGuardCaches();
          appendRoleRegistryEvent('openclaw.json changed, role registry cache cleared and rebuilt');
        });
      } catch (e) {
        appendAuditEvent({
          decision: 'warn',
          ruleId: 'dispatch.role_registry.watch_failed',
          reason: `failed to watch openclaw.json: ${e.message}`,
        });
      }
    };

    const validateDispatchPayload = (payload = {}) => {
      const agentId = String(payload.agentId || '').trim();
      const prompt = String(payload.prompt || '').trim();
      const timeoutSec = Number(payload.timeoutSec || 0);

      if (!agentId) throw new Error('enqueue payload missing agentId');
      if (agentId === 'main') throw new Error('agentId main is forbidden for dispatch');

      const agents = agentSetFromConfig();
      if (!agents.has(agentId)) {
        throw new Error(`agentId ${agentId} not in openclaw.json agents.list`);
      }

      if (!prompt) throw new Error('enqueue payload prompt is required');
      if (!Number.isFinite(timeoutSec) || timeoutSec < 600) {
        throw new Error(`timeoutSec ${timeoutSec} below minimum 600`);
      }

      return { ok: true, agentId, timeoutSec };
    };

    appendRoleRegistryEvent('startup role registry built');
    startConfigWatcher();

    // Prompt guard (existing behavior)
    api.on(
      'before_prompt_build',
      () => {
        if (!dispatchGuardGlobal.promptLogged) {
          api.logger.info('[aco-dispatch-guard] injecting dispatch rules via before_prompt_build');
          dispatchGuardGlobal.promptLogged = true;
        }
        return { prependContext: DISPATCH_GUARD_PROMPT };
      },
      { priority: 900 }
    );

    // Functional MVP: only guard local-subagent-board enqueue command path.
    // NOTE(冲突整合): local-subagent-board 仍是执行器，guard 仅做准入校验与审计。
    // NOTE(冲突整合): guard 不执行重试、不发送通知，避免与执行器形成双重重试/双重通知。
    if (ENABLE_FUNCTIONAL) {
      api.on(
        'before_tool_call',
        async (event, hookCtx) => {
          const toolName = String(event?.toolName || hookCtx?.toolName || '');
          const args = event?.params || {};

          if (toolName === 'sessions_spawn') {
            let runtime = String(args.runtime || 'subagent');
            const streamTo = args.streamTo;
            let agentId = typeof args.agentId === 'string' ? args.agentId : null;
            const modelOverride = typeof args.model === 'string' ? args.model : null;
            appendAuditEvent({
              decision: 'observe',
              ruleId: 'dispatch.sessions_spawn.before_tool_call_seen',
              reason: 'sessions_spawn seen by before_tool_call',
              toolName,
              runtime,
              streamTo: streamTo === undefined ? null : streamTo,
              model: modelOverride,
              agentId,
              sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
            });
            let nextParams = null;

            // Auto-assign agent when agentId is empty or "main"
            if (!agentId || agentId === 'main') {
              let assigned = null;
              try { assigned = autoAssignAgent(); } catch { /* config unreadable, skip auto-assign */ }
              if (assigned) {
                const ruleId = assigned.allBusy
                  ? 'dispatch.sessions_spawn.auto_assign_all_busy'
                  : 'dispatch.sessions_spawn.auto_assign_agent';
                appendAuditEvent({
                  decision: 'rewrite',
                  ruleId,
                  reason: assigned.allBusy
                    ? `all agents busy, fallback assign agentId=${assigned.id} runtime=${assigned.runtime}`
                    : `auto assign idle agentId=${assigned.id} runtime=${assigned.runtime}`,
                  toolName,
                  originalAgentId: agentId,
                  assignedAgentId: assigned.id,
                  assignedRuntime: assigned.runtime,
                  allBusy: assigned.allBusy,
                  sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
                });
                agentId = assigned.id;
                runtime = assigned.runtime;
                nextParams = { ...(nextParams || args), agentId: assigned.id, runtime: assigned.runtime };
              }
            }
            // ACP concurrency limiter: block if too many ACP tasks running (OOM prevention)
            if (runtime === 'acp') {
              const runningAcp = countRunningAcpTasks();
              if (runningAcp >= MAX_CONCURRENT_ACP) {
                const reason = `ACP concurrency limit reached: ${runningAcp}/${MAX_CONCURRENT_ACP} running. Wait for a running ACP task to finish, then retry.`;
                appendAuditEvent({
                  decision: 'block',
                  ruleId: 'dispatch.sessions_spawn.acp_concurrency_limit',
                  reason,
                  toolName,
                  runtime,
                  agentId,
                  runningAcp,
                  maxAcp: MAX_CONCURRENT_ACP,
                  sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
                });
                return { block: true, blockReason: reason };
              }
            }

            // L2: 同一 agentId 并发守卫
            if (agentId && agentId !== 'main') {
              try {
                const boardRaw = fs.readFileSync(TASK_BOARD_PATH, 'utf8');
                const board = JSON.parse(boardRaw);
                const tasks = Array.isArray(board.tasks) ? board.tasks : Array.isArray(board) ? board : [];
                const isRunning = tasks.some(t => t && t.status === 'running' && t.agentId === agentId);
                if (isRunning) {
                  const reason = `已阻断：${agentId} 当前有 running 任务，同一 agent 不允许并发。等待完成或 kill 后重试。`;
                  appendAuditEvent({ decision: 'block', ruleId: 'dispatch.sessions_spawn.same_agent_concurrent', reason, toolName, agentId });
                  return { block: true, blockReason: reason };
                }
              } catch { /* board unreadable, skip check */ }
            }

            if (runtime !== 'acp' && streamTo === 'parent') {
              appendAuditEvent({
                decision: 'rewrite',
                ruleId: 'dispatch.sessions_spawn.strip_invalid_streamTo_runtime',
                reason: `strip invalid streamTo=parent for runtime=${runtime}`,
                toolName,
                runtime,
                model: modelOverride,
                agentId,
                sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
              });
              nextParams = { ...(nextParams || args), streamTo: undefined };
            }

            if (runtime === 'subagent' && agentId && agentId !== 'main' && modelOverride) {
              const cfg = readOpenclawConfig();
              const targetAgent = (cfg.agents?.list || []).find((item) => item?.id === agentId) || null;
              const targetModel = typeof targetAgent?.model === 'string' ? targetAgent.model : null;
              const defaultModelPrimary = typeof cfg.agents?.defaults?.model?.primary === 'string' ? cfg.agents.defaults.model.primary : null;
              const globalAliases = cfg.agents?.defaults?.models || {};
              const defaultAlias = typeof globalAliases?.[defaultModelPrimary || '']?.alias === 'string' ? globalAliases[defaultModelPrimary].alias : null;
              const targetAlias = typeof globalAliases?.[targetModel || '']?.alias === 'string' ? globalAliases[targetModel].alias : null;
              const modelOverrideMatchesTarget = Boolean(
                modelOverride && (
                  modelOverride === targetModel ||
                  modelOverride === targetAlias
                )
              );
              const shouldStripModelOverride = Boolean(
                targetModel && !modelOverrideMatchesTarget
              );
              if (shouldStripModelOverride) {
                appendAuditEvent({
                  decision: 'rewrite',
                  ruleId: 'dispatch.sessions_spawn.strip_model_override_for_configured_subagent',
                  reason: `strip model=${modelOverride} so subagent ${agentId} keeps configured model ${targetModel}`,
                  toolName,
                  runtime,
                  model: modelOverride,
                  targetModel,
                  targetAlias,
                  defaultModelPrimary,
                  defaultAlias,
                  agentId,
                  sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
                });
                nextParams = { ...(nextParams || args), model: undefined };
              }
            }

            // ── Role-Task matching check ──
            const taskLabel = typeof args.label === 'string' ? args.label : '';
            const taskPrompt = typeof args.prompt === 'string' ? args.prompt : '';
            const classification = await detectTaskType(taskLabel, taskPrompt, agentId);
            const detectedType = classification.type;
            const roleRegistry = loadRoleRegistry();

            appendAuditEvent({
              decision: classification.classifierFailed ? 'warn' : 'observe',
              ruleId: classification.classifierFailed ? 'dispatch.task_classifier.fallback_warn' : 'dispatch.task_classifier.result',
              reason: classification.classifierFailed
                ? `task classifier failed (${classification.failureReason || 'unknown'}), dispatch will warn instead of hard-blocking`
                : `task classified as ${detectedType}`,
              toolName,
              agentId,
              taskType: detectedType,
              classifierSource: classification.source,
              classifierFailed: Boolean(classification.classifierFailed),
              failureReason: classification.failureReason || null,
              confidence: classification.confidence ?? null,
              rawResult: classification.rawResult || null,
              promptSummary: classification.promptSummary || taskPrompt.slice(0, 120) || null,
              roleMatchMode: roleRegistry.mode,
              roleTaskRule: getRoleTaskMap()[detectedType] || [],
              label: taskLabel || null,
              sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
            });

            // ── SEVO bypass attempt blocker (L2 hard enforcement) ──
            if (detectedType === '__sevo_bypass_attempt__') {
              const bypassViolation = {
                decision: 'block',
                ruleId: 'dispatch.sevo_bypass_blocked',
                reason: `Label "${taskLabel}" uses sevo_/sevo- prefix to bypass SEVO pipeline. All dev tasks MUST go through sevo:create.`,
                toolName,
                agentId,
                taskType: 'sevo_bypass',
                label: taskLabel,
                sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
              };
              appendAuditEvent(bypassViolation);
              return { block: true, blockReason: `❌ SEVO 后门已封死：label "${taskLabel}" 试图绕过 SEVO 流水线。主 Agent 无权跳过 SEVO 流程！正确做法：用 sevo:create <project> 触发流水线，由 SEVO 自动判定入口阶段并派发对应角色的 agent。` };
            }
            const allowedAgents = getRoleTaskMap()[detectedType] || [];
            const roleMatched = roleRegistry.mode === 'open' || allowedAgents.length === 0 || allowedAgents.includes(agentId);
            const hardEnforceRoleMatch = (roleRegistry.mode === 'enforce' || roleRegistry.mode === 'fallback-enforce') && !classification.classifierFailed;

            if (!roleMatched) {
              const agentRole = describeAgentRole(agentId);
              const violation = {
                decision: hardEnforceRoleMatch ? 'block' : 'warn',
                ruleId: 'dispatch.role_task.mismatch',
                reason: `agentId=${agentId} (role: ${agentRole}) assigned ${detectedType} task, expected one of [${allowedAgents.join(', ')}]`,
                toolName,
                agentId,
                taskType: detectedType,
                expectedRoles: allowedAgents,
                violation: true,
                label: taskLabel || null,
                roleMatchMode: roleRegistry.mode,
                classifierFailed: Boolean(classification.classifierFailed),
                sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
              };
              appendAuditEvent(violation);

              if (hardEnforceRoleMatch) {
                const blockMsg = `❌ 角色不匹配已阻断：${agentId}（${agentRole}）不应执行 ${detectedType} 类型任务。请改用：[${allowedAgents.join(', ')}]。❗主 Agent 无权绕过 SEVO 流水线，必须用 sevo:create <project> 触发正确流程。`;
                return { block: true, blockReason: blockMsg };
              }

              const currentPrompt = (nextParams || args).prompt || taskPrompt;
              const warningMsg = roleRegistry.mode === 'open'
                ? 'single-agent mode: role matching skipped'
                : `role mismatch in ${roleRegistry.mode} mode; dispatch allowed with warning`;
              nextParams = { ...(nextParams || args), prompt: `${currentPrompt}\n\n⚠️ [dispatch-guard] ${warningMsg}` };
            } else {
              appendAuditEvent({
                decision: 'observe',
                ruleId: 'dispatch.role_task.match',
                reason: roleRegistry.mode === 'open' ? 'single-agent mode skips role matching' : `agentId=${agentId} matches ${detectedType} task`,
                toolName,
                agentId,
                taskType: detectedType,
                label: taskLabel || null,
                roleMatchMode: roleRegistry.mode,
                classifierFailed: Boolean(classification.classifierFailed),
                sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
              });
            }

            // ── Bulk data operation detection (L2 enforcement) ──
            if (detectedType === 'data-ops') {
              const bulkCheckPrompt = (nextParams || args).prompt || taskPrompt;
              // Skip if already split (contains OFFSET/batch/批次)
              const alreadySplit = /\b(OFFSET|batch)\b/i.test(bulkCheckPrompt) || /批次/.test(bulkCheckPrompt);

              if (!alreadySplit) {
                let estimatedCount = null;
                let triggerReason = null;

                // Check LIMIT > 250
                const limitMatch = bulkCheckPrompt.match(/LIMIT\s+(\d+)/i);
                if (limitMatch && parseInt(limitMatch[1], 10) > 250) {
                  estimatedCount = parseInt(limitMatch[1], 10);
                  triggerReason = `LIMIT ${estimatedCount}`;
                }

                // Check N条 > 250
                if (!estimatedCount) {
                  const countMatch = bulkCheckPrompt.match(/(\d+)\s*条/);
                  if (countMatch && parseInt(countMatch[1], 10) > 250) {
                    estimatedCount = parseInt(countMatch[1], 10);
                    triggerReason = `${estimatedCount}条`;
                  }
                }

                // Check bulk keywords (no numeric LIMIT constraint)
                if (!estimatedCount) {
                  const bulkKeywords = /全部条目|所有条目|all entries|全量|批量/;
                  if (bulkKeywords.test(bulkCheckPrompt)) {
                    estimatedCount = 1000; // default estimate when no number available
                    triggerReason = 'bulk keyword detected';
                  }
                }

                if (estimatedCount) {
                  const suggestedBatches = Math.ceil(estimatedCount / 250);
                  const warningMsg = `检测到大批量数据操作(估计 ${estimatedCount} 条)，建议拆分为 ${suggestedBatches} 个子任务并行处理`;

                  appendAuditEvent({
                    decision: 'warn',
                    ruleId: 'dispatch.data_ops.bulk_detected',
                    reason: warningMsg,
                    toolName,
                    agentId,
                    taskType: detectedType,
                    estimatedCount,
                    triggerReason,
                    suggestedBatches,
                    sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
                  });

                  // Inject warning into prompt (soft warn, not block)
                  const currentPrompt = (nextParams || args).prompt || taskPrompt;
                  nextParams = { ...(nextParams || args), prompt: currentPrompt + `\n\n⚠️ [dispatch-guard] ${warningMsg}` };
                }
              }
            }

            // README quality rules injection: when task prompt mentions README
            if (/readme/i.test(taskPrompt)) {
              appendAuditEvent({
                decision: 'rewrite',
                ruleId: 'dispatch.sessions_spawn.readme_quality_rules_injected',
                reason: 'task prompt contains README keyword, injecting quality rules',
                toolName,
                agentId,
                sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
              });
              nextParams = { ...(nextParams || args), prompt: taskPrompt + '\n' + README_QUALITY_RULES };
            }

            // ── Stale completion detection (warn, not block) ──
            const staleCompletions = detectStaleCompletions();
            if (staleCompletions.length > 0) {
              const staleList = staleCompletions.map((s) => `${s.agentId}: ${s.label}`).join(', ');
              const staleWarning = `\n\n⚠️ [dispatch-guard] 发现 ${staleCompletions.length} 个已完成但未处理的任务：[${staleList}]。建议先处理已完成任务再派新任务。`;
              appendAuditEvent({
                decision: 'warn',
                ruleId: 'dispatch.stale_completion_detected',
                reason: `${staleCompletions.length} stale completion(s) found`,
                type: 'stale_completion_detected',
                toolName,
                agentId,
                staleCompletions,
                sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
              });
              // Inject warning into prompt without blocking
              const currentPrompt = (nextParams || args).prompt || taskPrompt;
              nextParams = { ...(nextParams || args), prompt: currentPrompt + staleWarning };
            }

            if (nextParams) {
              appendAuditEvent({
                decision: 'observe',
                ruleId: 'dispatch.sessions_spawn.after_rewrite',
                reason: 'sessions_spawn params rewritten',
                toolName,
                runtime,
                streamTo: Object.prototype.hasOwnProperty.call(nextParams, 'streamTo') ? nextParams.streamTo : null,
                model: Object.prototype.hasOwnProperty.call(nextParams, 'model') ? nextParams.model : null,
                agentId: typeof nextParams.agentId === 'string' ? nextParams.agentId : null,
                sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
              });
              return { params: nextParams };
            }
            return null;
          }

          // ── L2: 主会话耗时命令守卫 ──
          if (toolName === 'exec') {
            const sessionKey = typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : '';
            const isMain = sessionKey.includes(':main:') || sessionKey === 'main' || (!sessionKey);
            if (isMain) {
              const cmd = String(args.command || '');
              const BLOCKED_PATTERNS = [
                /\bnpm\s+run\s+build\b/i,
                /\bnpx\s+(next|tsc|webpack)\s+(build|start)\b/i,
                /\bNODE_OPTIONS.*build\b/i,
                /\bnpm\s+(install|ci)\b/i,
                /\bpip\s+install\b/i,
                /\bapt(-get)?\s+install\b/i,
                /\brm\s+-rf\s+(\.next|node_modules|dist)\b/,
                /\bnohup\s+/,
                /\bpkill\s+/,
                /\bsystemctl\s+(restart|start|stop)\b/,
              ];
              const SAFE_PREFIXES = /^\s*(cat|head|tail|ls|grep|wc|echo|pwd|date|whoami|id|stat|file|git\s+(status|log|diff|branch))\b/;
              if (!SAFE_PREFIXES.test(cmd)) {
                for (const pat of BLOCKED_PATTERNS) {
                  if (pat.test(cmd)) {
                    const reason = pat.source.includes('systemctl')
                      ? `已阻断：主会话禁止执行 systemctl 命令。Gateway 重启需确认看板空闲 + doctor Errors: 0；其他服务启停请派子 Agent 执行。`
                      : `已阻断：主会话禁止执行耗时命令（${pat.source}）。请派子 Agent 执行。`;
                    appendAuditEvent({ decision: 'block', ruleId: 'dispatch.exec.main_session_blocked', reason, toolName, command: cmd.slice(0, 120) });
                    return { block: true, blockReason: reason };
                  }
                }
              }
            }
          }

          // ── L2: 主会话禁止 edit/write 代码文件 ──
          if ((toolName === 'edit' || toolName === 'write') && !toolName.startsWith('sessions')) {
            const sessionKey = typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : '';
            const isMain = sessionKey.includes(':main:') || sessionKey === 'main' || (!sessionKey);
            if (isMain) {
              const filePath = String(args.path || '');
              const CODE_EXTS = /\.(js|ts|mjs|jsx|tsx|py|sh)$/i;
              const CODE_DIRS = /(^|[\/])(extensions|projects|hooks|scripts)[\/]/;
              if (CODE_EXTS.test(filePath) && CODE_DIRS.test(filePath)) {
                const reason = '[ACO Dispatch Guard] 主会话禁止直接编辑代码文件。请 spawn 编码 Agent 执行代码变更。';
                appendAuditEvent({ decision: 'block', ruleId: 'dispatch.edit_write.main_session_code_blocked', reason, toolName, filePath: filePath.slice(0, 200) });
                return { block: true, blockReason: reason };
              }
            }
          }

          if (toolName !== 'exec') return null;

          const cmd = String(args.command || '');
          if (!cmd.includes('local-subagent-board.js') || !cmd.includes(' enqueue ')) {
            return null;
          }

          const payload = extractEnqueuePayload(cmd);
          if (!payload) {
            const reason = 'dispatch-guard: cannot parse enqueue payload JSON from command';
            appendAuditEvent({
              decision: 'block',
              ruleId: 'dispatch.enqueue.payload_unparseable',
              reason,
              toolName,
            });
            return { block: true, blockReason: reason };
          }

          try {
            const v = validateDispatchPayload(payload);
            appendAuditEvent({
              decision: 'allow',
              ruleId: 'dispatch.enqueue.valid',
              reason: 'payload validated',
              agentId: v.agentId,
              timeoutSec: v.timeoutSec,
              toolName,
            });
            return null;
          } catch (e) {
            const reason = String(e?.message || e);
            appendAuditEvent({
              decision: 'block',
              ruleId: inferRuleId(reason),
              reason,
              toolName,
            });
            return {
              block: true,
              blockReason: `dispatch-guard blocked enqueue: ${reason}`,
            };
          }
        },
        { priority: 910 }
      );
    }

    if (!dispatchGuardGlobal.registeredLogged) {
      api.logger.info('aco-dispatch-guard: plugin registered');
      dispatchGuardGlobal.registeredLogged = true;
    }
  },
};

export default agentDispatchGuardPlugin;

// ─── L2: 信息密度原则（主会话回复简洁性门禁）───────────────────────────
// 原则：回复的每一句话必须对用户当前决策有用。
// 排查过程、中间步骤、工具输出是内部上下文，不是用户需要的信息。
// 触发：主会话 + 飞书 direct chat + 回复超过阈值
const REPLY_DENSITY_MAX_CHARS = 500;
const REPLY_DENSITY_NOTICE = `[信息密度警告] 你的回复超过 ${REPLY_DENSITY_MAX_CHARS} 字。检查：
- 是否包含用户没问的排查过程？删掉。
- 是否重复已知信息？删掉。
- 是否列举用户没要求的选项？删掉。
- 结论能否用一两句话说清？压缩。
原则：用户问事实→给结论；要行动→做完告知结果；问方案→方案+关键取舍(≤3点)。`;

// Register via before_prompt_build: inject density reminder into main session context
// (before_agent_reply is the closest hook but doesn't allow blocking;
//  instead we inject the principle as a persistent system reminder)
if (typeof plugin !== 'undefined' && plugin.hook) {
  plugin.hook('before_prompt_build', async ({ session, messages }) => {
    try {
      const isMain = session?.agentId === 'main' || !session?.agentId;
      if (!isMain) return;
      const channel = session?.channel || session?.meta?.channel;
      const isDirect = channel?.type === 'direct' || channel?.chatType === 'direct';
      if (!isDirect) return;
      // Inject density principle as system context
      return {
        inject: REPLY_DENSITY_NOTICE
      };
    } catch (e) { /* non-critical */ }
  });
}
