/**
 * Agent Dispatch Guard Plugin
 * 强制注入Agent调度规范，并提供功能化MVP（准入/治理/审计）
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { createRequire } from 'module';
import { classifyByEmbedding, readEmbeddingConfig } from './embedding-classifier.js';

const require = createRequire(import.meta.url);
const {
  ROLE_AGENT_FALLBACK,
  ROLE_TASK_TYPES,
  TASK_TYPE_EXPECTED_ROLE,
  CODING_TIER_BY_AGENT_ID,
  DEFAULT_AGENT_TIER_FALLBACK,
  HEALTH_SCAN_T1_AGENT_IDS,
  ROLE_TASK_MAP_FALLBACK,
  cloneRoleAgents,
  cloneAgentTierFallback,
  normalizeRole,
  inferRoleByAgentId,
  inferTierByAgentId,
  buildRoleTaskMapFromRoleAgents,
  getValidRoles,
} = require('./routing-registry.cjs');

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
const WORKSPACE_ROOT = path.join(OPENCLAW_HOME, 'workspace');
const OPENCLAW_CONFIG = path.join(OPENCLAW_HOME, 'openclaw.json');
const DEFAULT_EVENTS_PATH = path.join(OPENCLAW_HOME, 'workspace', 'logs', 'dispatch-guard-events.jsonl');
const TASK_BOARD_PATH = path.join(OPENCLAW_HOME, 'workspace', 'logs', 'subagent-task-board.json');
const TASKS_MD_PATH = path.join(OPENCLAW_HOME, 'workspace', 'TASKS.md');
const README_AUTODISPATCH_STATE_PATH = path.join(OPENCLAW_HOME, 'workspace', 'state', 'aco-dispatch-guard', 'readme-autodispatch.json');
const README_AUTODISPATCH_WINDOW_MS = 10 * 60 * 1000;

const ACO_EXTENSION_PATH_RE = /(?:^|[\s`'"(])(?:\.?\/?[^\s`'"()]*?)?extensions\/aco-[^\s`'"()]+/i;
const ACO_PROJECT_PATH_RE = /(?:^|[\s`'"(])(?:\.?\/?[^\s`'"()]*?)?projects\/aco(?:[\/\s`'"()]|$)/i;
const ACO_BACKWARD_COMPATIBILITY_APPENDIX = '\n\n【向后兼容铁律】不传 config 时，插件行为必须与改动前完全一致。DEFAULT_CONFIG 必须等于当前硬编码值。改完后 node --check 验证。\nWhy：不传 config 的旧行为是现有用户和流水线依赖的隐性契约，改坏会让所有未升级配置的旧任务和默认运行态静默回归。';
const ACO_AUDIT_TEST_GATE_APPENDIX = '\n\n【测试门禁】审计前先执行 cd /root/.openclaw/workspace/projects/aco && npm test，不全绿=不通过。\nWhy：审计只读代码会把表面正确当成通过；只有跑测试才能证明运行态没坏，漏跑等于把未验证的改动放进流水线。';
const AUDIT_GENERALIZATION_CHECK_APPENDIX = '\n\n【通用化检查】审计时必须 grep 硬编码路径（/root/、绝对路径），检查关键参数是否可配置，检查是否有宿主绑定无隔离层。硬编码路径=P1阻断。\nWhy：ACO 是可复用产品，宿主硬编码在本机看不出问题，发布到陌生环境就会暴露为开箱即失败。';
const ACO_PUBLISH_STRANGER_GATE_APPENDIX = '\n\n【发布门禁】发布前执行 bash scripts/npm-stranger-verify.sh 验证干净环境可安装可运行。\nWhy：本机的全局依赖和缓存会掩盖安装失败；不模拟干净环境，问题会留给第一个陌生用户在安装时撞上。';
const ALWAYS_ON_OPS_NOTICE = '\n\n## ⏰ 24小时无休（L2 强制）\n- 系统 24 小时运行，早晚无差别，没有"收工"概念。\n- 禁止以时间为由推迟任务、建议用户休息、或主动提议"先这样"。\n- 有待办就继续推进，无待办就待命。时间不是决策变量。\nWhy：这是持续运行的自动化协作环境，把时间当成决策变量会造成待办堆积、闭环中断；用户期待的是任务随到随推，而非按人类作息节奏停顿。';

// ── SEVO Pipeline Discipline Fallback (Plan C: injection ownership) ──────────
//
// SEVO 插件是流水线纪律的唯一权威来源（FR-14a）。正常路径下 SEVO 在同一轮
// prompt 构建中先注入完整纪律并写入 marker；ACO 检测到 marker 时只追加一句
// fallback 提醒，不重复完整纪律文本。
//
// 仅当 SEVO 缺失/降级/本轮未注入 marker 时，ACO 才注入完整纪律作为兜底，避免
// 研发任务在 SEVO 不可用时完全失去 Spec-First 和审计闭环引导。
const SEVO_DISCIPLINE_MARKER = '[SEVO_CONTEXT_V1]';
const SEVO_PROMPT_INJECTION_STATE_KEY = Symbol.for('openclaw.sevo.promptInjectionState');

// 一句话 fallback：marker 存在时追加，语义为「研发类变更交由 SEVO 流水线引导」。
const SEVO_FALLBACK_LINE = '\n\nℹ️ SEVO fallback：研发类变更请遵循 SEVO 流水线引导。\nWhy：完整流水线纪律由 SEVO 插件注入，这一句兜底确保 SEVO 本轮提示在场时主会话仍能确认研发动作应进入流水线，而不是当普通裸任务处理。';

// 完整纪律兜底：仅当 SEVO marker 未确认（缺失/降级）时注入，覆盖 Spec-First、
// sevo: 入口、开发→审计→复验闭环、引导式握手四类规则，确保 SEVO 不可用时主会话
// 仍能看到完整研发纪律。文案用引导/准入校验/路由/握手表述。
const SEVO_DISCIPLINE_FULL_FALLBACK = [
  '',
  '',
  '## ℹ️ SEVO 流水线纪律提醒（ACO 兜底）',
  '目标：让一切研发活动进入可追溯、可审计、可复验的流水线。',
  '做什么：派发前先确认 spec FR/AC 覆盖；需要研发推进时使用 sevo:create / sevo:implement / sevo:fix / sevo:from；开发完成后进入独立审计并处理修复→复验闭环；接受 SEVO 的引导式路由握手。',
  'Why：SEVO 插件本轮未确认注入流水线纪律，这段兜底确保研发任务不会失去 Spec-First 和审计闭环引导而回到不可追溯的口头约束。',
  '',
  '- Spec-First',
  '  目标：每个代码/配置变更都能追溯到 spec 里的 FR/AC。',
  '  做什么：派发前先评估该任务是否需要同步修改 spec；新功能/新模块/逻辑变更若 spec 无对应 FR，先补 spec 再开发；纯 bug 修复（不改变功能边界）可直接修复。',
  '  Why：spec 是功能的唯一定义源，没有 spec 覆盖的代码无法追溯、无法审计、无法向用户证明边界。',
  '- SEVO 入口',
  '  目标：研发文件变更统一从流水线入口进入状态机。',
  '  做什么：会改受管项目代码/spec/配置/文档时，task prompt 用 sevo:create / sevo:implement / sevo:fix / sevo:from 前缀触发；纯查询/纯审计读报告不需要前缀。',
  '  Why：从入口进入流水线，才能让阶段门禁、角色路由和审计闭环自动接管，产出可纳入验收。',
  '- 开发→审计→复验',
  '  目标：开发产出经过独立审计并形成修复→复验闭环。',
  '  做什么：开发完成后由非开发 Agent 独立审计；审计发现的问题进入修复阶段，修复后由原审计复验，直到通过。',
  '  Why：开发自审存在认知盲区，独立审计提供第二视角；审计是流水线质量门禁的核心，缺它会让表面成功的产出直接当成完成。',
  '- 引导式握手',
  '  目标：主 Agent 与 SEVO 的引导保持一致，按流水线推进。',
  '  做什么：接受 SEVO 的路由提示，沿流水线阶段推进；不通过改 label、换措辞或拆分任务脱离流水线引导。',
  '  Why：引导式握手让插件稳定作为引导层生效，保证研发质量与端到端自动化效率，也避免两套定义分叉。',
].join('\n');

/**
 * 检测 SEVO 是否在本轮 prompt 构建中已注入流水线纪律 marker。
 * 只看同一 promptBuildId（ctx.runId）对应的共享状态，不依赖时间窗（架构硬约束）。
 * 共享状态不可用时，回退扫描已拼接 prompt 文本中的 marker。
 *
 * @returns {{ found: boolean, source: 'shared_state'|'prompt_text'|'missing' }}
 */
function detectSevoInjection({ promptBuildId, promptText } = {}) {
  try {
    const state = globalThis[SEVO_PROMPT_INJECTION_STATE_KEY];
    if (state && promptBuildId && state.promptBuilds instanceof Map) {
      const entry = state.promptBuilds.get(String(promptBuildId));
      if (entry && entry.marker === SEVO_DISCIPLINE_MARKER && !entry.degraded) {
        return { found: true, source: 'shared_state' };
      }
    }
  } catch { /* fail-open: detection error falls through to prompt-text scan */ }

  if (typeof promptText === 'string' && promptText.includes(SEVO_DISCIPLINE_MARKER)) {
    return { found: true, source: 'prompt_text' };
  }

  return { found: false, source: 'missing' };
}

function semanticYesFromRaw(rawResult = '' ) {
  let normalized = String(rawResult || '' ).trim().toLowerCase();
  // Strip thinking model output
  normalized = normalized.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '' ).trim();
  normalized = normalized.replace(/<thinking>[\s\S]*/gi, '' ).trim();
  if (/^yes\b/.test(normalized)) return true;
  if (/^no\b/.test(normalized)) return false;
  if (/\byes\b/.test(normalized)) return true;
  if (/\bno\b/.test(normalized)) return false;
  return null;
}

// Advisory gate semantic checks (publish/readme/health-scan/bulk/exemption) run on
// the dispatch path and must never stall spawning. They use a short timeout and
// fail open (matched=false). The spec-first checks keep the longer default ceiling.
const SEMANTIC_GATE_TIMEOUT_MS = 8000;

/**
 * Reusable semantic check via embedding cosine similarity.
 * Replaces the former LLM yes/no classification. Failures return matched=false
 * with a reason so callers can fail open.
 *
 * @param {object} opts
 * @param {string} opts.text - Text to classify
 * @param {string} opts.vectorDb - Vector DB filename (in sevo/data/)
 * @param {string} opts.positiveLabel - Label that means "yes/matched"
 * @param {number} [opts.maxChars=2000] - Max chars to use from text
 */
async function askSemanticYesNo({ text, vectorDb, positiveLabel, maxChars = 2000 }) {
  const snippet = String(text || '').slice(0, maxChars);
  if (!snippet.trim()) return { matched: false, reason: 'empty_text' };

  try {
    const result = await classifyByEmbedding(snippet, vectorDb);
    if (!result.matched) return { matched: false, reason: 'embedding_no_match', score: result.score };
    const matched = result.label === positiveLabel;
    return { matched, reason: matched ? 'embedding_yes' : 'embedding_no', rawResult: result.label, score: result.score };
  } catch (e) {
    return { matched: false, reason: String(e?.message || e || 'embedding_error') };
  }
}

// sevo: 前缀是流水线入口命令（sevo:create/implement/fix/from），
// 表示任务已在 SEVO 流水线内，不需要再次路由或做 spec-first 拦截。
// 这不是"豁免流水线"——它们本身就是在走流水线。
// 豁免条件（AC-35.8）只有两种：无限循环、用户明确授权，不在此处理。
function isAlreadyInPipeline(label = '') {
  const normalized = String(label || '').trim().toLowerCase();
  return normalized.startsWith('sevo:');
}

// 显式结构化豁免标记：用户在 prompt 中放入 [用户授权豁免] 标记是确定性结构信号，
// 直接命中即放行，不需要 LLM。
const USER_EXEMPTION_MARKER_RE = /【用户授权豁免】/;

function hasUserExemptionMarker(text = '') {
  return USER_EXEMPTION_MARKER_RE.test(String(text || ''));
}

// 自然语言豁免意图判定走 LLM 语义分类。判断"用户是否授权豁免某操作"属于语义理解，
// 必须由 LLM 完成；用 /用户原话.*豁免/、/exempt.*user/ 之类正则会把任意提到"豁免"
// 的文本误判为授权。失败时 fail-open=false（不豁免），让任务继续走正常准入校验。
// Why: 用户是最终决策者，当用户明确授权豁免时 guard 应尊重；但"是否授权"是语义问题，
// 关键词匹配既会漏判改写措辞，也会把讨论豁免的文本误当成授权，必须交给 LLM。
async function hasUserExemption(text = '') {
  const s = String(text || '');
  if (hasUserExemptionMarker(s)) return true;
  const semantic = await askSemanticYesNo({
    text: s,
    vectorDb: 'semantic-gate-vectors.json',
    positiveLabel: 'has-mutation',
    maxChars: 2000,
  });
  return semantic.matched === true;
}

// FR-K33：只读调研产出准入边界。
// 区分「调研报告产出（写入 reports/）」与「项目文件变更」：写入路径仅涉及 reports/
// 且 LLM 未判定会修改项目产物时，视为只读调研产出，不触发 spec-first 准入要求。
// Why：调研报告是事实沉淀和决策输入，不是产品实现本身。把 workspace/reports/ 写入误判为
// 项目文件变更，会让纯调研任务被错误送入研发流水线，造成排查变慢、角色路由混乱和无意义的 spec 补写。
const REPORT_PATH_RE = /(?:\/root\/\.openclaw\/workspace\/)?reports\/[A-Za-z0-9._\-\/]+/gi;
// 项目变更候选路径：projects/<name>/src|docs/、extensions/、配置文件、测试文件、发布产物。
const PROJECT_MUTATION_PATH_RE = /(?:\/root\/\.openclaw\/workspace\/)?(?:projects\/[A-Za-z0-9._-]+\/(?:src|docs)\/[A-Za-z0-9._\-\/]+|extensions\/[A-Za-z0-9._-]+\/[A-Za-z0-9._\-\/]+|[A-Za-z0-9._\-\/]*__tests__\/[A-Za-z0-9._\-\/]+|[A-Za-z0-9._\-\/]+\.(?:test|spec|config|conf)\.[A-Za-z0-9]+|openclaw\.json)/gi;

const RESEARCH_OUTPUT_TASK_TYPES = new Set(['research', 'audit', 'analysis']);
const SEMANTIC_SPEC_REQUIRED_TASK_TYPES = new Set(['spec', 'code', 'audit', 'ux', 'readme']);

function cleanPathToken(token) {
  return String(token || '').replace(/[.,;:!?，。；：！？)）]+$/g, '');
}

function uniquePathMatches(re, text) {
  re.lastIndex = 0;
  const paths = [];
  let match;
  while ((match = re.exec(String(text || ''))) !== null) {
    const token = cleanPathToken(match[0]);
    if (token) paths.push(token);
    if (match.index === re.lastIndex) re.lastIndex++;
  }
  return [...new Set(paths)];
}

async function hasSemanticProjectMutation(text = '') {
  return askSemanticYesNo({
    text,
    vectorDb: 'semantic-gate-vectors.json',
    positiveLabel: 'has-mutation',
    maxChars: 2000,
  });
}

// 返回 { researchOutputOnly, reportPaths[], projectMutations[], semanticReason }。
// LLM 不可用时按安全路径：只要出现项目变更候选路径，就不按只读调研放行。
async function analyzeResearchOutput(prompt = '', classification = {}) {
  const text = String(prompt || '');
  const reportPaths = uniquePathMatches(REPORT_PATH_RE, text);
  const projectMutationCandidates = uniquePathMatches(PROJECT_MUTATION_PATH_RE, text);
  const semanticMutation = await hasSemanticProjectMutation(text);
  const classifierFailed = semanticMutation.reason && semanticMutation.reason !== 'llm_no' && semanticMutation.reason !== 'llm_yes';
  const hasProjectMutation = classifierFailed
    ? projectMutationCandidates.length > 0
    : semanticMutation.matched;
  const projectMutations = hasProjectMutation ? projectMutationCandidates : [];
  const semanticTaskType = normalizeTaskType(classification.type);
  const isResearchLike = RESEARCH_OUTPUT_TASK_TYPES.has(semanticTaskType);
  const researchOutputOnly = isResearchLike && reportPaths.length > 0 && projectMutations.length === 0;
  return {
    researchOutputOnly,
    reportPaths,
    projectMutations,
    semanticReason: semanticMutation.reason || null,
  };
}

function resolveReferencedSpecPaths(text = '') {
  const refs = new Set();
  const raw = String(text || '');
  const re = /(?:^|[\s`'"(])((?:\/[^\s`'")]+|[A-Za-z0-9_.@~+:-][^\s`'")]*)(?:\.md|\/docs\/[^\s`'")]*))/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const token = cleanPathToken(m[1]);
    if (token) refs.add(token);
  }
  return [...refs];
}

function buildSpecPathCandidates(ref) {
  const clean = String(ref || '').trim();
  if (!clean) return [];

  const workspaceRelative = clean.replace(/^\/root\/\.openclaw\/workspace\/?/, '');
  const candidates = [];
  if (path.isAbsolute(clean)) {
    candidates.push(clean);
    if (workspaceRelative !== clean && workspaceRelative) {
      candidates.push(path.join(WORKSPACE_ROOT, workspaceRelative));
    }
  } else {
    candidates.push(path.join(WORKSPACE_ROOT, clean));
    if (!clean.startsWith('projects/')) {
      candidates.push(path.join(WORKSPACE_ROOT, 'projects', clean));
    }
    candidates.push(path.join(process.cwd(), clean));
  }
  return [...new Set(candidates)];
}

function checkSpecPath(ref) {
  const candidates = buildSpecPathCandidates(ref);
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) {
        return { ref, specPath: candidate, pathCheckResult: 'not_file', failReason: 'spec path points to a directory or non-file' };
      }
      fs.accessSync(candidate, fs.constants.R_OK);
      return { ref, specPath: candidate, pathCheckResult: 'exists_readable', failReason: null };
    } catch (e) {
      if (e?.code === 'EACCES') {
        return { ref, specPath: candidate, pathCheckResult: 'not_readable', failReason: 'spec path is not readable' };
      }
    }
  }
  return { ref, specPath: ref || null, pathCheckResult: 'missing', failReason: 'spec path does not exist' };
}

function getBestSpecPathCheck(text = '') {
  const refs = resolveReferencedSpecPaths(text);
  const checks = refs.map(checkSpecPath);
  return checks.find((check) => check.pathCheckResult === 'exists_readable')
    || checks[0]
    || { ref: null, specPath: null, pathCheckResult: 'missing', failReason: 'no spec path found' };
}

async function hasSemanticSpecReference(text = '') {
  return askSemanticYesNo({
    text,
    vectorDb: 'semantic-gate-vectors.json',
    positiveLabel: 'has-mutation',
    maxChars: 2000,
  });
}

function hasAcoExtensionPathReference(text = '') {
  return ACO_EXTENSION_PATH_RE.test(String(text || ''));
}

function shouldInjectAcoBackwardCompatibilityRule(label = '', prompt = '') {
  const normalizedLabel = String(label || '').trim().toLowerCase();
  return hasAcoExtensionPathReference(prompt)
    && (normalizedLabel.includes('sevo:implement') || normalizedLabel.includes('sevo:fix'));
}

function shouldInjectAcoAuditTestGate(label = '', prompt = '') {
  const normalizedLabel = String(label || '').trim().toLowerCase();
  const rawPrompt = String(prompt || '');
  return normalizedLabel.includes('audit-')
    && (ACO_PROJECT_PATH_RE.test(rawPrompt) || hasAcoExtensionPathReference(rawPrompt));
}

function shouldInjectAuditGeneralizationCheck(label = '') {
  const normalizedLabel = String(label || '').trim().toLowerCase();
  return normalizedLabel.includes('audit-');
}

// 「是否发布/release 任务」是语义判断，走 LLM。/publish|release/ 关键词会漏判
// 「上线」「打包对外」等换词，也会误判只是提到这些词的非发布任务。
// 失败 fail-open=false（不注入门禁），保持注入的保守性。
async function shouldInjectAcoPublishStrangerGate(prompt = '') {
  const semantic = await askSemanticYesNo({
    text: String(prompt || ''),
    vectorDb: 'semantic-gate-vectors.json',
    positiveLabel: 'has-mutation',
    maxChars: 2000,
  });
  return semantic.matched === true;
}

function loadReadmeAutodispatchState() {
  try {
    return JSON.parse(fs.readFileSync(README_AUTODISPATCH_STATE_PATH, 'utf8') || '{}');
  } catch {
    return { dispatched: {} };
  }
}

function saveReadmeAutodispatchState(state) {
  fs.mkdirSync(path.dirname(README_AUTODISPATCH_STATE_PATH), { recursive: true });
  fs.writeFileSync(README_AUTODISPATCH_STATE_PATH, JSON.stringify(state, null, 2));
}

async function isUserVisibleFeatureChange(text = '', appendAuditEvent = null, context = {}) {
  const raw = String(text || '');
  const semanticCheck = await askSemanticYesNo({
    text: raw,
    vectorDb: 'semantic-gate-vectors.json',
    positiveLabel: 'user-visible-feature',
    maxChars: 2000,
  });

  if (typeof appendAuditEvent === 'function') {
    appendAuditEvent({
      decision: semanticCheck.matched ? 'allow' : 'observe',
      ruleId: 'dispatch.semantic_user_visible_change',
      eventType: 'dispatch.semantic_user_visible_change',
      reason: semanticCheck.matched
        ? 'LLM classified the task as a user-visible feature change'
        : `LLM did not classify the task as user-visible; fail-open/no autodispatch on LLM failure (${semanticCheck.reason || 'unknown'})`,
      semanticMatched: Boolean(semanticCheck.matched),
      semanticCheckReason: semanticCheck.reason || null,
      semanticResult: semanticCheck.rawResult || null,
      ...context,
    });
  }

  return semanticCheck.matched;
}

async function isAuditPassedCompletion(event = {}, appendAuditEvent = null, context = {}) {
  const label = String(event.label || event.title || '').toLowerCase();
  const outcome = String(event.outcome || event.status || '').toLowerCase();
  const ok = event.success === true || outcome === 'ok' || outcome === 'completed' || outcome === 'succeeded' || outcome === 'success';
  const resultText = String(event.result || event.resultText || event.frozenResultText || event.output || '');
  const textForPassCheck = `${label}
${resultText}
${outcome}`;
  const isAudit = label.startsWith('audit-');
  if (!ok || !isAudit) return false;

  const semanticCheck = await askSemanticYesNo({
    text: textForPassCheck,
    vectorDb: 'semantic-gate-vectors.json',
    positiveLabel: 'audit-passed',
    maxChars: 2000,
  });

  if (typeof appendAuditEvent === 'function') {
    appendAuditEvent({
      decision: semanticCheck.matched ? 'allow' : 'observe',
      ruleId: 'dispatch.semantic_audit_passed',
      eventType: 'dispatch.semantic_audit_passed',
      reason: semanticCheck.matched
        ? 'LLM classified the audit completion as passed'
        : `LLM did not classify the audit completion as passed; fail-open/no README autodispatch on LLM failure (${semanticCheck.reason || 'unknown'})`,
      label: label || null,
      outcome: outcome || null,
      semanticMatched: Boolean(semanticCheck.matched),
      semanticCheckReason: semanticCheck.reason || null,
      semanticResult: semanticCheck.rawResult || null,
      ...context,
    });
  }

  return semanticCheck.matched;
}

function resolveReadmeUpdateAgent() {
  const registry = loadRoleRegistry();
  const pmAgents = registry.roleAgents?.pm || ROLE_AGENTS_FALLBACK.pm || [];
  const busyIds = (() => {
    try {
      const board = JSON.parse(fs.readFileSync(TASK_BOARD_PATH, 'utf8') || '{}');
      const tasks = Array.isArray(board.tasks) ? board.tasks : [];
      return new Set(tasks.filter((t) => t && t.status === 'running' && t.agentId).map((t) => t.agentId));
    } catch {
      return new Set();
    }
  })();
  const available = pmAgents.find((id) => !busyIds.has(id)) || pmAgents[0];
  return available || null;
}

function enqueueReadmeUpdateTask(payload, onDone) {
  const script = path.join(WORKSPACE_ROOT, 'scripts', 'local-subagent-board.js');
  execFile('node', [script, 'enqueue', JSON.stringify(payload)], { timeout: 30000 }, onDone);
}

// [M-10 fix] MAX_CONCURRENT_ACP 边界校验：1-10
// 2026-05-05: ACP 进程各自仅占 4-5% CPU + 150-300MB RAM，5路并行完全安全
// 之前限制为4是因为误将 PM2 next start 的 CPU 占用归因于 ACP
const MAX_CONCURRENT_ACP = Math.max(1, Math.min(10, Number(process.env.DISPATCH_GUARD_MAX_ACP || 8)));

const AGENT_TIER_FALLBACK = cloneAgentTierFallback();

const MAX_PARALLEL_DISPATCH_NOTICE = '【最大化并行调度】每次有新待办或 agent 释放时，立即全量扫描：待办列表 × 空闲 agent × 文件冲突域，不冲突的全部同时派出。禁止串行等待。\nWhy：空闲 agent 就是被浪费的产能；串行等待会让推进变成挤牙膏式，已发现的问题停留在口头待办里迟迟不落地，用户感知为系统停滞。';

const TASK_PROMPT_QUALITY_SELF_CHECK = `## \u{1f4cb} 派发任务 Prompt 质量铁律（每次 spawn 前过一遍）

### 核心原则：给目标、给方法、给验证标准，不给具体执行路径（2026-06-03 用户纠偏，永久生效）
- 任务有复杂度时，prompt 应写「做什么 + 方法论 + 验收标准 + 硬约束」
- 方法论是原则性流程指引，例如「先查 spec 是否需要调整再做设计」「先定位真实运行态再列修复项」
- 具体执行路径是子 Agent 的决策空间，主会话不要越界指定函数、行号或逐步操作序列
- 越具体的执行路径 = 越大的误导风险（尤其当路径本身可能是错的时候）
- 强模型有能力自主设计最优方案，主会话的价值在于精确定义目标、方法边界和验证标准
- 允许写「可能的方向（仅供参考）」但必须标注是参考不是指令

### 必须包含
- 目标：一句话说清做完后世界有什么不同
- 方法论：原则性流程指引，说明应遵循的判断顺序或工作方法
- 验收标准：怎么判定做完了（可验证的检查项）
- 硬约束：不能碰什么、stdout 重定向、不改 openclaw.json 等
- AC 编号和摘要（如果有 spec 覆盖）

**为什么**：缺目标/方法/验收/硬约束，子 Agent 只能自行猜测意图，产出无法对照验收，主会话事后才发现跑偏又得重派。

### 允许包含（但标注为参考）
- 已知的架构事实（如「函数在 line 1476」）— 省去子 Agent 定位时间
- 可能的方向 — 标注「仅供参考，你可以选完全不同的方案」

**为什么**：背景事实能减少子 Agent 的定位成本，但必须明确标注为参考——否则未验证的「事实」会变成误导性指令，把子 Agent 带向错误方向。

### 禁止包含
- 具体执行路径：指定用哪个函数、改哪一行、按什么步骤序列操作
- 具体的代码写法（「用 sed 替换第 X 行为 Y」）
- 假设未验证的架构结论（主会话的理解可能是错的，会误导子 Agent）

### 运维类硬约束（仍需包含）
- stdout 重定向（构建/测试命令必须 > /tmp/xxx.txt 2>&1）
- 禁止关键词匹配冒充语义、禁止硬编码学科名到用户可见位置
- 调研类必须写 reports/，编码类指明改哪些文件
- 涉及错误修复时：要求子 Agent 第一步自己跑诊断命令确认实际错误列表

**为什么**：stdout 不重定向会让构建/测试输出污染 announce、阻塞主会话；构建测试隔离和先跑诊断，是为了拿到可复现的验证证据而非凭印象判断成败。`;

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

**为什么**：completion event 是 push 机制，Gateway 重启、drain 超时、announce 重试耗尽都会让 push 静默丢失；会话压缩又会让记忆里的状态与事实脱节。看板 JSON 是磁盘上的持久真相源，只有实读它才能拿到不受这两类丢失影响的状态。凭记忆或 push 回复进度，本质是拿不可靠的信息源冒充事实，必然出现「用户已知道变化、你还在说旧状态」的失联感。

### 1. 任务时长标准（强制）
派子Agent前，必须按任务类型设定timeoutSeconds：

| 任务类型 | 标准时长 | 说明 |
|----------|----------|------|
| **简单查询** | 600s (10min) | 单个问题、读文件、轻量分析 |
| **中等开发/调研** | 3600s (60min) | 功能实现、bug修复、中型重构、中型代码审计、行业分析、案例研究、方法体系沉淀 |
| **重型系统开发** | 7200s (120min) | 复杂系统设计、大规模重构、深度代码审计 |

**禁止**：随意缩短时长（如设300s调研任务）
**默认档位**：拿不准时选 3600s，涉及 >3000 行文件或跨模块重构时选 7200s

**为什么**：timeout 设太短，子 Agent 还在正常工作就被强制中断，产出半成品甚至空文件，主会话误判为失败而重派，白白浪费一轮资源和时间；设太长则占着 agent 槽位不释放，阻塞同梯队其他任务排队。按任务类型给足时长，是让 Agent 有完整产能窗口、又不过度占用资源的平衡点。

### 1.1 cc effort 动态映射（强制）
派 cc（Claude Code）任务时，必须通过环境变量 CLAUDE_EFFORT 设置思考深度：

| 任务类型 | effort | 说明 |
|----------|--------|------|
| 简单查询/文件操作 | low | 快速完成，省 token |
| 中等开发/调研 | high | 默认值，平衡质量与速度 |
| 重型系统开发 | max | 最大思考预算 |

不传 CLAUDE_EFFORT 时默认 high。

**为什么**：不同复杂度的任务需要不同的思考预算。简单任务给 max 是在浪费 token 和时间，复杂系统任务给 low 则思考不足、产出潦草；按任务类型映射 effort，才能让每个任务拿到匹配的推理深度。

### 2. 禁止Poll（强制）
- sessions_spawn后**禁止**轮询/睡眠等待
- 子Agent通过completion event自动汇报结果
- 采用push-based而非polling
- 主Agent保持通信通道畅通

**为什么**：主会话 poll/sleep 等待期间会锁住自己的处理 lane，此时用户发来的新消息会被 Gateway 静默丢弃（已知缺陷），体感等同失联；而 completion 本就是 push 机制，轮询不会更快拿到结果，只会平白让主会话失去响应能力。

### 3. Agent选择验证（强制）
派生子Agent前，**必须**先查证：
1. 检查 \`openclaw.json\` 中的agents配置
2. **确认agentId存在且配置正确**
3. **确认目标 agent 的 runtime 类型并选择正确 spawn 方式**：读取 \`${OPENCLAW_CONFIG}\` 的 \`agents.list\`，定位目标 agent；若该 agent 配置存在 \`runtime.acp\` 字段，则它是 ACP agent，spawn payload 必须显式使用 \`runtime:"acp"\`；若不存在 \`runtime.acp\` 字段，则它是原生 subagent，spawn payload 必须走原生 subagent 方式，**不得**携带 \`runtime\` 参数
4. **禁止依赖fallback机制**
5. **不得使用不存在的agentId**（如coder、reviewer、analyst、scout等）

**Agent配置唯一真相源：${OPENCLAW_CONFIG}（强制）**
- \`agents/\` 目录下的物理文件夹可能残留已删除的Agent
- **唯一可信来源是 \`${OPENCLAW_CONFIG}\` 中的 \`agents.list\`**
- 派生子Agent前，**必须以 ${OPENCLAW_CONFIG} 配置为准**，不得仅依赖文件夹存在性
- 当文件系统与 ${OPENCLAW_CONFIG} 冲突时，以 ${OPENCLAW_CONFIG} 为准
- **当前可用Agent必须实时读取 \`${OPENCLAW_CONFIG}\`，禁止硬编码历史列表**
- **runtime 类型不得按 agentId 前缀、角色、目录是否存在或历史印象推断；只看 \`agents.list[].runtime.acp\` 是否存在**

**模型配置唯一真相源：${OPENCLAW_CONFIG}（强制）**
- 模型/provider 选择的唯一可信来源是 \`${OPENCLAW_CONFIG}\` 中的 \`models.providers\`
- 选模型前必须校验 \`providerId/modelId\` 在 \`models.providers\` 中存在
- 当运行时枚举、缓存、历史会话与 ${OPENCLAW_CONFIG} 冲突时，以 ${OPENCLAW_CONFIG} 为准
- 禁止基于“历史可用性印象”假定能力（如 xhigh）；必须以当前 provider/model 实测能力为准

**为什么**：agents/ 目录会残留已删除 Agent 的物理文件夹，会话记忆又会因压缩丢失 agent 池的真实变更，凭这两者派发会指向不存在的 agentId 导致 spawn 失败或静默落到 fallback；只有 openclaw.json 是配置的唯一权威来源，实读它才能保证派的 agent/model 真的存在且能力匹配。runtime 也必须同源校验：ACP agent 和原生 subagent 的 spawn payload 不兼容，把原生 subagent 误带 \`runtime:"acp"\` 会走错 ACP 通道，把 ACP agent 按原生方式派发会绕过其 acpx 后端与命令配置；每轮 spawn 前检查 \`runtime.acp\`，才能把目标 agent 送进正确运行时。


### 4. MECE拆分原则（强制）
复杂任务、处理数据量过大的任务，必须：
1. 按MECE原则拆解为子任务
2. 评估单个子任务是否超过单Agent产能
3. 批量spawn(≥2个)后立即输出队列状态汇报
4. 禁止等用户催促才汇报

**为什么**：超出单 Agent 产能的任务（数据量过大、跨多模块）塞给一个 Agent，会因 context 超限或时间不够而产出截断、遗漏；MECE 拆分让每个子任务落在单 Agent 可完成的范围内，且子任务之间不重叠不遗漏，合并后才能保证覆盖完整。批量 spawn 后立即汇报队列状态，是因为用户看不到内部调度，不汇报就等于任务进了黑盒。

### 5. 禁止行为
- ❌ "先解释再派发" → 要dispatch FIRST
- ❌ "等第一波完成再派第二波" → 要全部enqueue
- ❌ "手动跟踪任务状态" → 看板自动跟踪
- ❌ 使用不存在/未验证的agentId

**为什么**：先解释再派发会拖慢吞吐；分波等待让空闲 agent 干等、资源闲置；手动跟踪状态会与看板这个真相源脱节，导致状态判断不可追踪；用未验证的 agentId 会 spawn 失败或静默落到 fallback 误派。这些行为合起来会把调度变成黑盒。

### 6. 主会话保持空闲铁律（强制）
- 主会话（main）只做：接收消息、判断意图、派发任务、秒级回复
- 预计超过 30 秒的工作必须派给子 Agent 或 ACP
- 禁止主会话亲自执行耗时操作（调研、开发、长文生成、批量检查等）
- 主会话可做的事：读文件确认内容、秒级判断后派发、短回复、更新文档
- 主会话不可做的事：web_search 多轮调研、逐文件审查、长篇报告撰写、代码开发

违反以上 = Badcase，需记录并修正。

**为什么**：Gateway 已知缺陷——主会话处理消息期间被耗时操作占住 lane 时，用户新发来的消息会被静默丢弃（dispatch replies=0, queuedFinal=false），体感等同失联。主会话保持空闲、把耗时工作派出去，才是保护用户通信通道不丢消息的唯一办法。

### 7. 失败即时重派（强制）
- 收到失败/不完整 completion 时，若资源池有空闲 agent，立即优化任务描述/粒度后重派
- 不等同批其他任务回收，资源最大化利用
- 同梯队失败 1 次后禁止原样重派，必须拆分或升级梯队
- 实质失败判定：completion 到达后，若 output_tokens 极低（如 <3k）且未写入任何文件，视为实质失败，即使 status=succeeded

**为什么**：失败任务原样重派大概率再次以同样原因失败，是在浪费资源；拆分或升级梯队才是堵根因。等同批其他任务回收再处理失败任务，会让空闲 agent 干等，资源利用率下降。status=succeeded 但零产出的情况存在，是因为模型可能「认为自己完成了」但实际没落盘，只看状态字段会把空任务误判为成功，必须用产出（token + 文件）做实质判定。

### 8. 运行中任务补充（强制）
- 对已派发的进行中任务有新信息/约束补充时，**默认走 kill + 重派**，不要 steer。
  1. **steer 是高风险动作**：subagents(action=steer) 内部是 mode=restart，会把目标任务从 0 重新拉起读 prompt，进度全丢；连续多次 steer = 任务永远从 0 开始，必然失败。
  2. **steer 仅限以下场景**：(a) 任务刚 spawn 60 秒内，模型还在读取 prompt 阶段；(b) 单次单条小约束补充，且发出后立即查 subagent-task-board.json 确认目标 sessionKey 仍 running。
  3. **超过 60 秒 / 第二次以上的约束补充 / 多条收敛合并**：必须 kill 旧任务（subagents action=kill）→ 把所有约束合并成一份完整 prompt → 重新 sessions_spawn。
  4. **每次 steer / kill+重派后必须立即读看板**：确认目标任务真实状态；不读看板就再发约束 = 可能在向已死任务重复发指令。
- 禁止等任务自然完成后再返工，浪费资源和时间

**为什么**：steer 底层是 mode=restart，会把任务从 0 重新拉起读 prompt、进度全丢，连续 steer 等于让任务永远从头开始、必然失败；这正是默认走 kill+重派而非 steer 的根因。等任务自然跑完再返工，则是明知方向错了还让它把错的做完，浪费整轮产能。

### 9. 长文档分段式写作（强制）
- 适用范围：预估产出 >300 行或 >15KB 的文档任务（spec、arc42、设计文档、深度报告）
- **首次派发即分段**：不等失败才拆，预估超阈值时直接按分段策略派发
- 第一段：输出目录 + 前半章节，确认文件写入成功
- 第二段：续写剩余章节（task prompt 引用第一段产出路径，要求 append/edit 而非覆盖）
- 多 Agent 交叉写作：A 写前半，B 写后半，最后由架构方合并
- 失败后禁止原样重派，必须拆段或升级

**为什么**：超长文档一次性生成会撞到模型单次输出上限，产出被截断或后半敷衍；首次就分段，是因为「等失败再拆」会先浪费一整轮，且失败现场往往已写了半个文件，续写容易覆盖或重复。分段 + append/edit 让每段都落在可完整输出的范围内，多段拼接才能保证长文档既完整又质量均匀。

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

**为什么**：构建/安装/服务启停这类耗时命令会占住 main lane，导致主会话阻塞、用户消息静默丢失；而且它们的产出本就需要独立验证和审计（是否真的构建成功、服务是否真的起来），由子 Agent 在隔离环境里执行才能给出可复现的证据。
`;

// ── Role-Task Matching Rules ──────────────────────────────────────────

// Fallback agent lists per role. Runtime normally builds this from openclaw.json agents.list[].role.
const ROLE_AGENTS_FALLBACK = cloneRoleAgents();

const VALID_ROLES = getValidRoles();

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

function filterTaskMapToAgents(taskMap, agentIds) {
  const ids = new Set(agentIds || []);
  if (ids.size === 0) return taskMap;
  const filtered = {};
  for (const [taskType, agents] of Object.entries(taskMap || {})) {
    filtered[taskType] = (agents || []).filter((id) => ids.has(id));
  }
  return filtered;
}


let _roleRegistryCache = null;
let _roleTaskMapCache = null;
let _agentTierCache = null;

const HEALTH_SCAN_T1_FALLBACK_AGENT_IDS = [...HEALTH_SCAN_T1_AGENT_IDS];
const HEALTH_SCAN_T1_BLOCK_REASON = '健康扫描任务必须由 T1 编码 Agent（cc > codex > omp）执行';

// 「是否健康扫描任务」是语义判断，不能用 /健康扫描|health-scan/ 关键词匹配
// （会漏判换措辞的扫描请求，也会误判只是提到这些词的审计/文档任务）。走 LLM 语义分类。
// 失败时 fail-open=false（不强制 T1），避免分类器抖动把普通任务误路由。
async function isHealthScanTask(label = '', prompt = '') {
  const semantic = await askSemanticYesNo({
    text: `label: ${String(label || '(none)')}\nprompt: ${String(prompt || '(none)')}`,
    vectorDb: 'task-type-vectors.json',
    positiveLabel: 'audit',
    maxChars: 2000,
  });
  return semantic.matched === true;
}

function shouldEnforceHealthScanT1(classification) {
  // Only enforce when the task classifier positively identified a coding/development task.
  // If classification fell back (LLM timeout/error/unavailable), prefer false negatives over
  // false positives so audit/spec/doc tasks mentioning health scans are not blocked.
  return Boolean(classification)
    && classification.classifierFailed !== true
    && classification.type === 'code';
}

function getHealthScanT1AgentIds() {
  const registry = loadRoleRegistry();
  const knownAgentIds = new Set((registry.agentTier || []).map((agent) => String(agent.id || '').trim()).filter(Boolean));
  const dynamicT1 = (registry.agentTier || [])
    .filter((agent) => agent && agent.role === 'coding' && String(agent.tier || '').toUpperCase() === 'T1')
    .map((agent) => String(agent.id || '').trim())
    .filter(Boolean);
  const fallbackExisting = HEALTH_SCAN_T1_FALLBACK_AGENT_IDS.filter((id) => knownAgentIds.size === 0 || knownAgentIds.has(id));
  return [...new Set([...dynamicT1, ...fallbackExisting])];
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
  if (/haiku|mini|flash|lite|small|low/.test(model)) return 'T3';
  if (/opus|gpt-5\.5|gpt-5|o3|o4|xhigh|high|thinking/.test(model)) return 'T1';
  return 'T2';
}

function buildAgentTierFromConfigAgents(agents) {
  const tierRank = { T1: 1, T2: 2, T3: 3, audit: 4, arch: 5, pm: 6, ux: 7, research: 8, unknown: 9 };
  return (agents || [])
    .filter((agent) => agent && agent.id)
    .map((agent) => {
      const runtime = runtimeTypeOf(agent);
      const inferredRole = inferRoleByAgentId(agent.id);
      const role = normalizeRole(agent.role) || inferredRole || 'unknown';
      const explicitCodingTier = inferTierByAgentId(String(agent.id || '').trim());
      const tier = explicitCodingTier || (runtime === 'acp' ? inferAcpTier(agent) : (agent.tier || role || 'T3'));
      return { id: agent.id, runtime, role, tier };
    })
    .sort((a, b) => {
      const tierDiff = (tierRank[a.tier] || 99) - (tierRank[b.tier] || 99);
      return tierDiff !== 0 ? tierDiff : String(a.id).localeCompare(String(b.id));
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
      roleAgents: cloneRoleAgents(ROLE_AGENTS_FALLBACK),
      roleByAgent: Object.fromEntries(
        Object.entries(ROLE_AGENTS_FALLBACK).flatMap(([role, ids]) => ids.map((id) => [id, role]))
      ),
      roleTaskMap: buildRoleMapFromSevo(_sevoStageChain, ROLE_AGENTS_FALLBACK) || buildRoleTaskMapFromRoleAgents(ROLE_AGENTS_FALLBACK),
      agentTier: cloneAgentTierFallback(),
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

function getAgentsByRole(role) {
  const registry = loadRoleRegistry();
  const fromRoleAgents = registry.roleAgents?.[role];
  if (Array.isArray(fromRoleAgents) && fromRoleAgents.length > 0) return fromRoleAgents;
  return getAgentTier().filter((agent) => agent.role === role).map((agent) => agent.id);
}

function isUserExplicitAgentSelection(agentId, label = '', prompt = '') {
  if (!agentId) return false;
  const escaped = String(agentId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idRe = new RegExp(`(?:agentId|agent|子Agent|指定|派给|用|使用|label)\\s*[:=：]?\\s*[\\"'“”]?${escaped}[\\"'“”]?|\\b${escaped}\\b`, 'i');
  return idRe.test(String(label || '')) || idRe.test(String(prompt || ''));
}

function buildRoleMismatchWarning({ taskType, agentId, agentRole, expectedRole, suggestedAgents }) {
  const suggestions = suggestedAgents.length > 0 ? suggestedAgents.join(', ') : '当前配置中没有该角色可用 agent，请检查 openclaw.json agents.list';
  return `角色匹配提示：检测到 ${taskType} 类型任务派给 ${agentId}（当前角色：${agentRole || 'unknown'}），建议角色：${expectedRole}，建议改派：[${suggestions}]。本次不阻断 spawn；如确需跨角色，请在 label 或 task prompt 明确指定 agentId。`;
}

function buildRoleMismatchBlockReason({ taskType, agentId, agentRole, expectedRole, suggestedAgents }) {
  const suggestions = suggestedAgents.length > 0 ? suggestedAgents.join(', ') : '当前配置中没有该角色可用 agent，请检查 openclaw.json agents.list';
  return `角色不匹配：检测到任务类型=${taskType}；目标 agent=${agentId}（角色=${agentRole || 'unknown'}）；期望角色=${expectedRole || 'unknown'}；建议改派=[${suggestions}]；如需跨角色派发，请在 label 或 task prompt 中加入 [role-override]。Why：错角色执行会让阶段职责混乱，spec/架构/代码/审计的闭环断裂，产出难以纳入流水线验收。`;
}

function hasRoleOverrideMarker(label = '', prompt = '') {
  return /\[role-override\]/i.test(String(label || '')) || /\[role-override\]/i.test(String(prompt || ''));
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
 * Resolve a usable { baseUrl, apiKey, model } from a single provider entry.
 * Returns null when the provider lacks any required field.
 */
function resolveProviderConfig(provider) {
  if (!provider?.apiKey || !provider?.baseUrl) return null;
  const models = Array.isArray(provider.models) ? provider.models : [];
  const modelId = models[0]?.id;
  if (!modelId) return null;
  return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: modelId };
}

/**
 * Resolve LLM provider config from openclaw.json for lightweight classification calls.
 *
 * Only the dedicated "penguin-classifier" provider is used. The classifier is a
 * routing aid; when it is unavailable we return null so callers degrade to their
 * existing keyword/regex fallback instead of borrowing the main agent's channel.
 * Deliberately does NOT fall back to "penguin-main": penguin-classifier and
 * penguin-main share the same upstream (penguinsaichat), so they tend to fail
 * together, and routing a non-critical classifier request through the main
 * communication key would spread a non-critical failure into the core path.
 *
 * Returns { baseUrl, apiKey, model } or null.
 */
function resolveLlmConfig() {
  const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));
  const providers = cfg.models?.providers || {};

  // Dedicated lightweight classifier provider only; no main-provider fallback.
  const classifier = resolveProviderConfig(providers['penguin-classifier']);
  if (classifier) return classifier;

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
const SPEC_FIRST_GUARD_TASK_TYPES = new Set(['spec', 'code', 'audit', 'ux', 'readme']);

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

function extractTaskTypeFromClassifierResult(content, taskTypes) {
  // Classifier is instructed to output exactly one task-type word. Accept only a
  // strict, exact match against the registered task-type list. Reject any dirty,
  // multi-token, or ambiguous output instead of guessing from substring containment.
  const cleaned = String(content || '')
    .trim()
    .toLowerCase()
    // strip surrounding quotes / punctuation / whitespace the model may add
    .replace(/^[\s"'`.,:;()\[\]]+/, '')
    .replace(/[\s"'`.,:;()\[\]]+$/, '');
  if (!cleaned) return null;

  const normalizedResult = normalizeTaskType(cleaned);
  const registered = new Set(taskTypes.map(normalizeTaskType).filter(Boolean));
  return registered.has(normalizedResult) ? normalizedResult : null;
}

/**
 * PRIMARY classifier: Embedding cosine similarity for task type.
 * Uses pre-computed vectors from task-type-vectors.json.
 * Returns classifierFailed=true (with type=null) on embedding unavailable
 * so the caller can fail open. Never throws.
 */
async function classifyTaskTypeLLM(classifierLabel, prompt) {
  const promptSummary = (prompt || '').slice(0, 120);
  const text = `label: ${classifierLabel || '(none)'}\nprompt: ${(prompt || '').slice(0, 500)}`;

  try {
    const result = await classifyByEmbedding(text, 'task-type-vectors.json');
    if (!result.matched) {
      return { type: null, source: 'embedding', classifierFailed: true, failureReason: 'embedding_no_match', score: result.score, promptSummary };
    }
    return { type: result.label, source: 'embedding', classifierFailed: false, confidence: result.confidence, score: result.score, rawResult: result.label, promptSummary };
  } catch (e) {
    return { type: null, source: 'embedding', classifierFailed: true, failureReason: String(e?.message || e || 'embedding_error'), promptSummary };
  }
}

/**
 * Detect task type from agent id + label + prompt text.
 *
 * Priority order:
 *   0. Audit agents          -> identity-based, deterministic (audit by definition).
 *   1. SEVO structured labels -> deterministic parsing of the label *format*
 *      (sevo:create / sevo:<id>:<stage>:<attempt> / sevo_-bypass). These encode
 *      the stage explicitly; they are not semantic keyword guessing.
 *   2. LLM semantic classification (PRIMARY judge of free-text task content).
 *   3. Fail-open as unknown when LLM is unavailable. Free-text keyword fallback
 *      must not classify task role/domain.
 */
async function detectTaskType(label, prompt, agentId = '') {
  // 0. Audit agents always run audit tasks. Identity-based and deterministic, so
  // this stays ahead of the LLM (an audit-01 dispatch is an audit task by definition,
  // even when the prompt contains build/typecheck commands).
  if (typeof agentId === 'string' && /^audit-/.test(agentId)) {
    return { type: 'audit', source: 'agent-id', classifierFailed: false, promptSummary: '' };
  }

  // 1. SEVO structured-label parsing. These rules read the explicit label format,
  // not the free-text prompt, so they are deterministic structural parsing (not
  // semantic keyword guessing) and legitimately precede the LLM.
  // 1a. sevo:create <project> -> always spec
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
      // Stages not in the map (e.g. 'implement') fall through to the LLM classifier
      // to determine actual task type (code vs data-ops etc.)
    }
  }
  // 1c. SEVO backdoor blocker: labels starting with sevo_ or sevo- that are NOT
  // proper SEVO pipeline labels are attempts to bypass SEVO flow. Block them.
  if (label && /^sevo[_-]/i.test(label)) {
    return { type: '__sevo_bypass_attempt__', source: 'sevo-bypass-label', classifierFailed: false, promptSummary: '' };
  }

  const classifierLabel = String(label || '').replace(/^sevo:(?:fix|implement)\b[:\s-]*/i, '').trim();
  const cacheKey = `${classifierLabel}|||${(prompt || '').slice(0, 500)}`;
  const cached = _taskTypeCache.get(cacheKey);
  if (cached) return cached;

  // 2. PRIMARY: LLM semantic classification.
  const llmResult = await classifyTaskTypeLLM(classifierLabel, prompt);
  if (!llmResult.classifierFailed && llmResult.type) {
    _taskTypeCache.set(cacheKey, llmResult);
    return llmResult;
  }

  const fallbackReason = llmResult.failureReason || 'llm_failed';
  return {
    type: 'unknown',
    source: 'llm-fail-open',
    classifierFailed: true,
    failureReason: fallbackReason,
    promptSummary: (prompt || '').slice(0, 120),
  };
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

**为什么**：README 是陌生用户的第一入口。缺 tagline/痛点/快速体验，用户根本不知道产品是干嘛的、为什么要用、怎么开始，第一眼就会流失。

### 禁止的写法
- ❌ 技术定义开头（"本项目是一个基于 XX 的 YY 框架"）
- ❌ Spec 术语泄露（FR-xxx、AC-xxx、NFR、SEVO、arc42）
- ❌ 版本号/日期占位（"v0.1.0-alpha"、"2024-xx-xx"）
- ❌ 内部架构暴露（模块名、内部 API、实现细节）
- ❌ 空洞承诺（"即将支持"、"计划中"）
- ❌ 工程文档风格（changelog、贡献指南放 README 正文）

**为什么**：内部术语、空洞承诺和工程细节会劝退外部用户，还会暴露未交付的内容，让产品看起来不可信、没做完。

### 验收标准
- 陌生人看前 20 行能回答："干嘛的？为什么我要用？"
- README 内容必须与 spec 对齐但不暴露 spec 术语
- 所有代码示例必须可直接复制运行

**为什么**：前 20 行必须让陌生人形成行动意愿，否则 README 没完成它最核心的获客和上手职责，再多内容都白搭。
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

    const countConfiguredAcpAgents = () => {
      try {
        const cfg = readOpenclawConfig();
        const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
        const count = agents.filter((agent) => runtimeTypeOf(agent) === 'acp').length;
        return count > 0 ? count : 8;
      } catch {
        return 8;
      }
    };

    const countRunningTasks = () => {
      try {
        const raw = fs.readFileSync(TASK_BOARD_PATH, 'utf8');
        const board = JSON.parse(raw || '{}');
        const tasks = Array.isArray(board.tasks) ? board.tasks : Array.isArray(board) ? board : [];
        return tasks.filter((task) => task && task.status === 'running').length;
      } catch {
        return 0;
      }
    };

    const hasUndispatchedTodoTasks = () => {
      try {
        const raw = fs.readFileSync(TASKS_MD_PATH, 'utf8');
        if (!raw || !raw.trim()) return false;

        const lines = raw.split('\n');
        const todoStartIndex = lines.findIndex((line) => /^##\s*待做\s*$/.test(line));
        if (todoStartIndex < 0) return false;

        const todoLines = [];
        for (let i = todoStartIndex + 1; i < lines.length; i += 1) {
          if (/^##\s+/.test(lines[i])) break;
          todoLines.push(lines[i]);
        }

        return todoLines.some((line) => /^\s*[-*]\s+\[\s\]\s+/.test(line));
      } catch {
        return false;
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
      // Filter to configured coding agents, excluding main and all non-coding roles.
      const candidates = getAgentTier().filter(
        (a) => configAgents.has(a.id) && a.id !== 'main' && (a.role || describeAgentRole(a.id) || inferRoleByAgentId(a.id)) === 'coding'
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
      (event, ctx) => {
        if (!dispatchGuardGlobal.promptLogged) {
          api.logger.info('[aco-dispatch-guard] injecting dispatch rules via before_prompt_build');
          dispatchGuardGlobal.promptLogged = true;
        }

        // ── SEVO marker detection (Plan C: injection ownership) ──
        // SEVO owns full pipeline discipline (Spec-First, sevo: entry, dev→audit
        // closure, handshake) and injects a marker at priority 950 (before this
        // hook at 900). Detect the marker for THIS prompt build via shared state;
        // when found, inject only a one-line fallback. When missing/degraded,
        // inject the full discipline as fallback so research tasks never lose
        // Spec-First and audit-loop guidance.
        let sevoFallback = '';
        try {
          const session = event?.session || {};
          const ctxSessionKey = String(ctx?.sessionKey || '');
          const sessionKeyFromSession = String(session.sessionKey || '');
          const sessionKey = ctxSessionKey || sessionKeyFromSession;
          const sessionAgentId = String(session.agentId || session.agent || '').trim().toLowerCase();
          const isMainSession = sessionAgentId === 'main' || sessionKey.startsWith('agent:main:');
          const promptBuildId = String(ctx?.runId || (sessionKey ? `${sessionKey}` : ''));

          if (isMainSession) {
            const promptText = typeof event?.prompt === 'string' ? event.prompt : '';
            const sevoInjection = detectSevoInjection({ promptBuildId, promptText });
            sevoFallback = sevoInjection.found ? SEVO_FALLBACK_LINE : SEVO_DISCIPLINE_FULL_FALLBACK;
            try {
              appendAuditEvent({
                decision: 'observe',
                ruleId: 'dispatch.sevo_fallback_decision',
                reason: sevoInjection.found
                  ? 'SEVO discipline marker detected; ACO injects one-line fallback only'
                  : 'SEVO discipline marker missing; ACO injects full discipline fallback',
                sessionKey: sessionKey || null,
                promptBuildId: promptBuildId || null,
                sevoMarkerFound: sevoInjection.found,
                detectionSource: sevoInjection.source,
                fallbackInjected: !sevoInjection.found,
                marker: SEVO_DISCIPLINE_MARKER,
              });
            } catch { /* audit event best-effort */ }
          }
        } catch { /* non-critical: SEVO detection failure falls open to no fallback */ }

        let concurrencyEfficiencyExtra = '';
        let maxParallelDispatchExtra = '';
        try {
          const session = event?.session || {};
          const sessionAgentId = String(session.agentId || session.agent || '').trim().toLowerCase();
          const isMainSession = sessionAgentId === 'main';

          if (isMainSession) {
            maxParallelDispatchExtra = `\n\n${MAX_PARALLEL_DISPATCH_NOTICE}`;
            const totalAcpAgents = countConfiguredAcpAgents();
            const runningTasks = countRunningTasks();
            const idleAcpAgents = Math.max(0, totalAcpAgents - runningTasks);
            if (idleAcpAgents >= 1) {
              concurrencyEfficiencyExtra = `\n\n⚠️ 并发效率最大化：当前有 ${idleAcpAgents} 个 agent 空闲。如果上下文中有明确的待做任务且与运行中任务不冲突，必须立即派发，不允许资源闲置。\nWhy：存在明确待做任务而 agent 空闲却不派发，等于让产能白白闲置、系统吞吐下降，用户感知为停滞。`;
            }
          }
        } catch { /* best effort only */ }


        const gitPushFullRule = `\n\n## 📦 GitHub 推送语义规则（L2 强制）\n用户说「推 GitHub」「推下」「push」= 主仓库 git push + 所有独立仓库同步。不追问「要推独立仓库吗」，直接执行 \`bash scripts/sync-independent-repos.sh\`。\nWhy：用户说 push 的真实意图是「所有对外代码状态一致」；只推主仓库会让独立仓库和发布源漂移，外部看到的代码与主仓库不同步。`;
        return { prependContext: DISPATCH_GUARD_PROMPT + ALWAYS_ON_OPS_NOTICE + sevoFallback + maxParallelDispatchExtra + concurrencyEfficiencyExtra + gitPushFullRule + `\n\n${TASK_PROMPT_QUALITY_SELF_CHECK}` };
      },
      { priority: 900 }
    );

    // FR-K10: README eval V2 — audit-pass completion event drives PM README update dispatch.
    api.on('subagent_ended', async (event, ctx) => {
      try {
        const auditSessionKey = event.childSessionKey || event.targetSessionKey || ctx?.childSessionKey || null;
        if (!await isAuditPassedCompletion(event, appendAuditEvent, { auditSessionKey })) return null;
        const label = String(event.label || event.title || '');
        const result = String(event.result || event.resultText || event.frozenResultText || event.output || '');

        // FR-K10 AC3: Extract sourceSessionKey from audit result — trace to the source dev task,
        // not the audit task itself. Audit tasks typically reference the source in their result/prompt.
        const sourceSessionKeyMatch = result.match(/(?:源\s*sessionKey|源开发任务|sourceSessionKey|source[\s_-]?session[\s_-]?key)[\s：:]+([a-zA-Z0-9:._-]+)/i)
          || result.match(/(?:被审计任务|audited[\s_-]?task|dev[\s_-]?task)[\s：:]+([a-zA-Z0-9:._-]+)/i);
        // Also try to extract from the audit label: "audit-<source-label>" pattern
        const auditLabelSourceMatch = label.match(/^audit-(.+)$/i);
        const sourceSessionKey = (sourceSessionKeyMatch && sourceSessionKeyMatch[1])
          || (event.sourceSessionKey)
          || (ctx?.sourceSessionKey)
          || null;

        // Extract source dev task label from audit label or result
        const sourceDevLabel = (auditLabelSourceMatch && auditLabelSourceMatch[1])
          || (result.match(/(?:源任务|source[\s_-]?label|dev[\s_-]?label|开发任务)[\s：:]+([^\n]{3,80})/i) || [])[1]
          || null;

        const textForVisibility = `${label}\n${result}`;
        if (!await isUserVisibleFeatureChange(textForVisibility, appendAuditEvent, {
          label: label || null,
          sourceSessionKey,
          sourceDevLabel: sourceDevLabel || null,
          auditSessionKey,
        })) {
          appendAuditEvent({
            decision: 'observe',
            ruleId: 'dispatch.readme_eval_v2.not_user_visible',
            reason: 'audit passed but no user-visible feature keyword found (or negative keywords matched)',
            label: label || null,
            sourceSessionKey,
            sourceDevLabel: sourceDevLabel || null,
            auditSessionKey,
          });
          return null;
        }

        // FR-K10 AC4: Dedup by source dev task label/title (not audit session key)
        // This ensures the same source development task doesn't trigger multiple README updates
        const dedupeKey = sourceSessionKey
          || sourceDevLabel
          || `${label}:${new Date(event.endedAt || Date.now()).toISOString().slice(0, 16)}`;
        const state = loadReadmeAutodispatchState();
        const dispatched = state.dispatched || {};
        const previous = dispatched[dedupeKey];
        if (previous && Date.now() - new Date(previous.dispatchedAt || 0).getTime() < README_AUTODISPATCH_WINDOW_MS) {
          appendAuditEvent({
            decision: 'observe',
            ruleId: 'dispatch.readme_eval_v2.dedupe_skip',
            reason: 'README update dispatch already created for this source task within 10 minutes',
            label: label || null,
            sourceSessionKey,
            sourceDevLabel: sourceDevLabel || null,
            dedupeKey,
          });
          return null;
        }

        const agentId = resolveReadmeUpdateAgent();
        if (!agentId) {
          appendAuditEvent({
            decision: 'warn',
            ruleId: 'dispatch.readme_eval_v2.no_pm_agent',
            reason: 'No PM agent available for README update dispatch',
            label: label || null,
            sourceSessionKey,
            sourceDevLabel: sourceDevLabel || null,
            dedupeKey,
          });
          return null;
        }

        const prompt = `更新对应项目的 README.md。\n\n触发源开发任务：${sourceDevLabel || label || '(no label)'}\n源 sessionKey：${sourceSessionKey || '(unknown)'}\n审计任务 sessionKey：${auditSessionKey || '(unknown)'}\n\n审计通过结果摘要：\n${result.slice(0, 4000)}\n\n要求：只把用户可见的新功能/新命令/新配置/新行为整合进 README；纯内部实现细节不要写；保持 README 面向外部用户可读。\nWhy：审计通过后的用户可见变化必须回写 README，否则产品实际能力和外部文档不同步，用户看到的说明落后于真实功能。`;
        const payload = {
          agentId,
          label: `doc-update-readme-${Date.now()}`,
          title: `doc-update-readme from ${sourceDevLabel || label || sourceSessionKey || 'audit-pass'}`,
          prompt,
          timeoutSec: 1200,
          priority: 50,
        };

        // Only write dispatched state and audit event AFTER successful enqueue (not before)
        // to avoid false-positive audit records and occupying dedup window on enqueue failure
        enqueueReadmeUpdateTask(payload, (error, stdout, stderr) => {
          if (error) {
            appendAuditEvent({
              decision: 'warn',
              ruleId: 'dispatch.readme_eval_v2.enqueue_failed',
              reason: error.message,
              sourceSessionKey,
              sourceDevLabel: sourceDevLabel || null,
              dedupeKey,
              agentId,
              stdout: String(stdout || '').slice(0, 500),
              stderr: String(stderr || '').slice(0, 500),
            });
          } else {
            appendAuditEvent({
              decision: 'dispatch',
              ruleId: 'dispatch.readme_eval_v2.pm_update_enqueued',
              reason: 'audit passed for user-visible feature change; PM README update enqueue succeeded',
              label: label || null,
              sourceSessionKey,
              sourceDevLabel: sourceDevLabel || null,
              auditSessionKey,
              dedupeKey,
              agentId,
              payloadLabel: payload.label,
              stdout: String(stdout || '').slice(0, 500),
            });
            // Write dispatched state only on success
            dispatched[dedupeKey] = {
              dispatchedAt: new Date().toISOString(),
              sourceSessionKey,
              sourceDevLabel: sourceDevLabel || null,
              auditSessionKey,
              sourceLabel: label || null,
              agentId,
              payloadLabel: payload.label,
            };
            state.dispatched = dispatched;
            saveReadmeAutodispatchState(state);
          }
        });
        return null;
      } catch (e) {
        appendAuditEvent({
          decision: 'warn',
          ruleId: 'dispatch.readme_eval_v2.error',
          reason: String(e?.message || e),
        });
        return null;
      }
    }, { priority: 100 });

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
                  const reason = `暂不派发：${agentId} 当前有 running 任务，同一 agent 不允许并发。请等待完成或结束该任务后重试。`;
                  appendAuditEvent({ decision: 'block', ruleId: 'dispatch.sessions_spawn.same_agent_concurrent', reason, toolName, agentId });
                  return { block: true, blockReason: reason };
                }
              } catch { /* board unreadable, skip check */ }
            }

            // NOTE: keyword-only pre-LLM role matching removed. Role matching is now
            // performed once, downstream, by the LLM-primary classifier (detectTaskType)
            // via the dispatch.role_task.mismatch rule. That single path uses LLM
            // semantic judgement as PRIMARY (keyword as fallback), blocks on mismatch,
            // and honors [role-override]. Keeping a separate keyword-only block here
            // would short-circuit the LLM and ignore [role-override], which is exactly
            // the bug being fixed.

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
            const roleOverride = hasRoleOverrideMarker(taskLabel, taskPrompt);
            const classification = await detectTaskType(taskLabel, taskPrompt, agentId);
            const detectedType = classification.type;
            const roleRegistry = loadRoleRegistry();

            // ── FR-K22: health/code-health scans require T1 coding agents ──
            // Deep health scans need stronger reasoning capacity; [role-override] remains the
            // explicit escape hatch for exceptional routing decisions.
            // Only enforce after a positive coding/development classification. If the classifier
            // fell back (LLM timeout/error/unavailable), prefer allowing the task rather than
            // falsely blocking audit/spec/doc work that merely mentions health scans.
            if (!roleOverride && shouldEnforceHealthScanT1(classification) && await isHealthScanTask(taskLabel, taskPrompt)) {
              const healthScanT1AgentIds = getHealthScanT1AgentIds();
              if (!healthScanT1AgentIds.includes(agentId)) {
                appendAuditEvent({
                  decision: 'route',
                  ruleId: 'dispatch.sessions_spawn.health_scan_t1_required',
                  reason: `${HEALTH_SCAN_T1_BLOCK_REASON}；actual=${agentId}; allowed=[${healthScanT1AgentIds.join(', ')}]`,
                  toolName,
                  agentId,
                  taskType: detectedType,
                  label: taskLabel || null,
                  expectedAgents: healthScanT1AgentIds,
                  sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
                });
                const healthScanRouteHint = `${HEALTH_SCAN_T1_BLOCK_REASON}；建议改用 T1 编码 agent（allowed=[${healthScanT1AgentIds.join(', ')}]）或在 prompt 中加 [role-override]。Why：健康扫描跨模块、误判成本高，弱模型容易漏掉系统性问题，必须用更强推理能力的 T1 编码 agent。`;
                nextParams = { ...(nextParams || args), prompt: ((nextParams || args).prompt || taskPrompt) + `\n\n⚠️ [dispatch-guard route] ${healthScanRouteHint}` };
              }
            }

            // ── FR-K09: spec-first guard（真实 spec 路径准入） ──
            // 研发活动由 LLM 分类结果驱动；准入只检查 prompt 是否给出真实可读的 spec 文档路径，
            // 并明确要求子 Agent 先读该文档。不再用 FR/AC 编号或关键词正则替代 spec 文档路径。
            const promptForSpecCheck = (nextParams || args).prompt || taskPrompt;
            const pipelineDelegated = isAlreadyInPipeline(taskLabel);
            const hasExemption = await hasUserExemption(promptForSpecCheck);
            const semanticTaskType = detectedType;
            const classifierProvider = classification.source || 'unknown';
            const semanticReason = classification.classifierFailed
              ? (classification.failureReason || 'llm_classifier_failed_safe_path')
              : (classification.rawResult || `classified_as_${detectedType}`);
            const requiresSpec = SEMANTIC_SPEC_REQUIRED_TASK_TYPES.has(detectedType) || classification.classifierFailed;

            if (pipelineDelegated) {
              appendAuditEvent({
                decision: 'allow',
                ruleId: 'dispatch.sessions_spawn.spec_first_pipeline_delegated',
                reason: 'FR-K09: sevo: pipeline entry delegates spec quality to SEVO specify/spec-review stages',
                toolName,
                agentId,
                taskType: detectedType,
                semanticTaskType,
                semanticReason,
                classifierProvider,
                requiresSpec: false,
                pipelineDelegated: true,
                pipelineLabel: taskLabel || null,
                researchOutputOnly: false,
                finalDecision: 'pipeline_entry_delegated',
                label: taskLabel || null,
                sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
              });
            } else if (requiresSpec && !hasExemption) {
              const researchAnalysis = await analyzeResearchOutput(promptForSpecCheck, classification);
              if (researchAnalysis.researchOutputOnly) {
                appendAuditEvent({
                  decision: 'allow',
                  ruleId: 'dispatch.sessions_spawn.research_output_only_allow',
                  reason: 'FR-K33: LLM 判定为调研/审计类任务，写入路径仅涉及 reports/ 且无项目产物变更，不触发 spec 文档准入',
                  toolName,
                  agentId,
                  taskType: detectedType,
                  semanticTaskType,
                  semanticReason: researchAnalysis.semanticReason || semanticReason,
                  classifierProvider,
                  requiresSpec: false,
                  pipelineDelegated: false,
                  label: taskLabel || null,
                  researchOutputOnly: true,
                  reportPaths: researchAnalysis.reportPaths,
                  projectMutations: researchAnalysis.projectMutations,
                  finalDecision: 'allow',
                  sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
                });
              } else {
                const specPathCheck = getBestSpecPathCheck(promptForSpecCheck);
                const semanticSpecReadCheck = specPathCheck.pathCheckResult === 'exists_readable'
                  ? await hasSemanticSpecReference(promptForSpecCheck)
                  : { matched: false, reason: 'spec_path_not_readable', rawResult: null };
                const hasReadableSpecPath = specPathCheck.pathCheckResult === 'exists_readable';
                const hasRequiredReadInstruction = semanticSpecReadCheck.matched === true;

                if (hasReadableSpecPath && hasRequiredReadInstruction) {
                  appendAuditEvent({
                    decision: 'allow',
                    ruleId: 'dispatch.sessions_spawn.spec_first_path_allow',
                    reason: 'FR-K09: prompt includes a real readable spec path and semantically requires reading it before work',
                    toolName,
                    agentId,
                    taskType: detectedType,
                    semanticTaskType,
                    semanticReason,
                    classifierProvider,
                    requiresSpec: true,
                    specPath: specPathCheck.specPath,
                    pathCheckResult: specPathCheck.pathCheckResult,
                    pipelineDelegated: false,
                    researchOutputOnly: false,
                    finalDecision: 'allow',
                    userFacingHint: null,
                    label: taskLabel || null,
                    sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
                  });
                } else {
                  const needsPath = !hasReadableSpecPath;
                  const finalDecision = needsPath ? 'spec_path_missing_blocked' : 'spec_read_instruction_missing_blocked';
                  const userFacingHint = needsPath
                    ? '请在 prompt 中写明真实 spec 文档路径，并要求子 Agent 先读该文档。'
                    : '请在 prompt 中明确要求子 Agent 动手前先读取该 spec 文档。';
                  const reason = needsPath
                    ? '研发活动缺少真实可读取的 spec 文档路径。请在 task prompt 中写明真实 spec 文档路径，并要求子 Agent 先读该文档。'
                    : '研发活动已提供真实 spec 文档路径，但未明确要求子 Agent 动手前先读该文档。';
                  appendAuditEvent({
                    decision: 'route',
                    ruleId: 'dispatch.sessions_spawn.spec_first_path_block',
                    reason,
                    toolName,
                    agentId,
                    taskType: detectedType,
                    semanticTaskType,
                    semanticReason,
                    classifierProvider,
                    requiresSpec: true,
                    specPath: specPathCheck.specPath,
                    pathCheckResult: specPathCheck.pathCheckResult,
                    failReason: specPathCheck.failReason,
                    pipelineDelegated: false,
                    researchOutputOnly: false,
                    reportPaths: researchAnalysis.reportPaths,
                    projectMutations: researchAnalysis.projectMutations,
                    finalDecision,
                    userFacingHint,
                    semanticCheckReason: semanticSpecReadCheck.reason || null,
                    semanticResult: semanticSpecReadCheck.rawResult || null,
                    label: taskLabel || null,
                    sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
                  });
                  nextParams = { ...(nextParams || args), prompt: ((nextParams || args).prompt || taskPrompt) + `\n\n⚠️ [dispatch-guard route] ${reason} ${userFacingHint}` };
                }
              }
            }

            appendAuditEvent({
              decision: 'observe',
              ruleId: classification.classifierFailed ? 'dispatch.task_classifier.fallback_result' : 'dispatch.task_classifier.result',
              reason: classification.classifierFailed
                ? `task classifier failed (${classification.failureReason || 'unknown'}); safe path as ${detectedType}`
                : `task classified as ${detectedType}`,
              toolName,
              agentId,
              taskType: detectedType,
              semanticTaskType,
              semanticReason,
              classifierProvider,
              requiresSpec,
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
                decision: 'route',
                ruleId: 'dispatch.sevo_bypass_blocked',
                reason: `Label "${taskLabel}" uses sevo_/sevo- prefix. Development tasks should enter the SEVO pipeline through sevo:create.`,
                toolName,
                agentId,
                taskType: 'sevo_bypass',
                label: taskLabel,
                sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
              };
              appendAuditEvent(bypassViolation);
              const sevoRouteHint = `此任务属于研发活动，建议通过 SEVO 流水线推进以确保质量与可追溯性：使用 sevo:create <project> 触发流水线，由 SEVO 自动判定入口阶段并派发对应角色的 agent。当前 label "${taskLabel}" 使用了 sevo_/sevo- 前缀，建议改为标准 SEVO 入口。`;
              nextParams = { ...(nextParams || args), prompt: ((nextParams || args).prompt || taskPrompt) + `\n\n⚠️ [dispatch-guard route] ${sevoRouteHint}` };
            }
            const allowedAgents = getRoleTaskMap()[detectedType] || [];
            const roleMatched = roleRegistry.mode === 'open' || allowedAgents.length === 0 || allowedAgents.includes(agentId);
            const expectedRole = TASK_TYPE_EXPECTED_ROLE[detectedType] || null;

            if (roleOverride) {
              appendAuditEvent({
                decision: 'allow',
                ruleId: 'dispatch.role_task.override',
                reason: `role-task check skipped by [role-override]: agentId=${agentId}, taskType=${detectedType}`,
                toolName,
                agentId,
                taskType: detectedType,
                label: taskLabel || null,
                roleMatchMode: 'override',
                classifierSource: classification.source,
                classifierFailed: Boolean(classification.classifierFailed),
                sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
              });
            } else if (!roleMatched) {
              const agentRole = describeAgentRole(agentId);
              const suggestedAgents = expectedRole ? getAgentsByRole(expectedRole) : allowedAgents;
              const explicitAgentSelection = isUserExplicitAgentSelection(agentId, taskLabel, taskPrompt);
              const blockReason = buildRoleMismatchBlockReason({ taskType: detectedType, agentId, agentRole, expectedRole: expectedRole || 'unknown', suggestedAgents });
              const violation = {
                decision: 'route',
                ruleId: 'dispatch.role_task.mismatch',
                reason: `agentId=${agentId} (role: ${agentRole}) assigned ${detectedType} task, expectedRole=${expectedRole || 'unknown'}, suggestedAgents=[${suggestedAgents.join(', ')}]`,
                toolName,
                agentId,
                taskType: detectedType,
                agentRole,
                expectedRole,
                suggestedAgents,
                expectedAgents: allowedAgents,
                explicitAgentSelection,
                violation: true,
                label: taskLabel || null,
                roleMatchMode: 'block',
                classifierSource: classification.source,
                classifierFailed: Boolean(classification.classifierFailed),
                sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
              };
              appendAuditEvent(violation);
              nextParams = { ...(nextParams || args), prompt: ((nextParams || args).prompt || taskPrompt) + `\n\n⚠️ [dispatch-guard route] ${blockReason}` };
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
                classifierSource: classification.source,
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

                // No explicit numeric count: judge bulk intent semantically (LLM),
                // not by /全部条目|全量|批量/ keyword matching. Only runs for data-ops
                // tasks lacking a numeric count, so the call surface is narrow.
                // Fail-open=false (no warning) on classifier failure.
                if (!estimatedCount) {
                  const bulkIntent = await askSemanticYesNo({
                    text: String(bulkCheckPrompt || ''),
                    vectorDb: 'semantic-gate-vectors.json',
                    positiveLabel: 'has-mutation',
                    maxChars: 2000,
                  });
                  if (bulkIntent.matched === true) {
                    estimatedCount = 1000; // default estimate when no number available
                    triggerReason = 'bulk intent (LLM)';
                  }
                }

                if (estimatedCount) {
                  const suggestedBatches = Math.ceil(estimatedCount / 250);
                  const warningMsg = `检测到大批量数据操作(估计 ${estimatedCount} 条)，建议拆分为 ${suggestedBatches} 个子任务并行处理。Why：单任务处理超过 250 条容易漏项或被截断，分片才能保证覆盖完整、且各片可独立验证后合并。`;

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

            // ── ACO backward-compatibility rule injection for development tasks ──
            const currentPromptBeforeAcoRule = (nextParams || args).prompt || taskPrompt;
            if (shouldInjectAcoBackwardCompatibilityRule(taskLabel, currentPromptBeforeAcoRule)
              && !currentPromptBeforeAcoRule.includes(ACO_BACKWARD_COMPATIBILITY_APPENDIX.trim())) {
              appendAuditEvent({
                decision: 'rewrite',
                ruleId: 'dispatch.sessions_spawn.aco_backward_compatibility_rule_injected',
                reason: 'development task references extensions/aco-* path, injecting backward-compatibility rule',
                toolName,
                agentId,
                taskType: detectedType,
                label: taskLabel || null,
                sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
              });
              nextParams = {
                ...(nextParams || args),
                prompt: currentPromptBeforeAcoRule + ACO_BACKWARD_COMPATIBILITY_APPENDIX,
              };
            }

            // ── ACO audit/release gate injection ──
            const currentPromptBeforeAcoAuditGate = (nextParams || args).prompt || taskPrompt;
            if (shouldInjectAcoAuditTestGate(taskLabel, currentPromptBeforeAcoAuditGate)
              && !currentPromptBeforeAcoAuditGate.includes(ACO_AUDIT_TEST_GATE_APPENDIX.trim())) {
              appendAuditEvent({
                decision: 'rewrite',
                ruleId: 'dispatch.sessions_spawn.aco_audit_test_gate_injected',
                reason: 'audit task references projects/aco or extensions/aco-*, injecting npm test gate',
                toolName,
                agentId,
                taskType: detectedType,
                label: taskLabel || null,
                sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
              });
              nextParams = {
                ...(nextParams || args),
                prompt: currentPromptBeforeAcoAuditGate + ACO_AUDIT_TEST_GATE_APPENDIX,
              };
            }

            const currentPromptBeforeAuditGeneralizationGate = (nextParams || args).prompt || taskPrompt;
            if (shouldInjectAuditGeneralizationCheck(taskLabel)
              && !currentPromptBeforeAuditGeneralizationGate.includes(AUDIT_GENERALIZATION_CHECK_APPENDIX.trim())) {
              appendAuditEvent({
                decision: 'rewrite',
                ruleId: 'dispatch.sessions_spawn.audit_generalization_check_injected',
                reason: 'audit task detected, injecting generalization hardcode/config/host-binding check',
                toolName,
                agentId,
                taskType: detectedType,
                label: taskLabel || null,
                sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
              });
              nextParams = {
                ...(nextParams || args),
                prompt: currentPromptBeforeAuditGeneralizationGate + AUDIT_GENERALIZATION_CHECK_APPENDIX,
              };
            }

            const currentPromptBeforeAcoPublishGate = (nextParams || args).prompt || taskPrompt;
            if (await shouldInjectAcoPublishStrangerGate(currentPromptBeforeAcoPublishGate)
              && !currentPromptBeforeAcoPublishGate.includes(ACO_PUBLISH_STRANGER_GATE_APPENDIX.trim())) {
              appendAuditEvent({
                decision: 'rewrite',
                ruleId: 'dispatch.sessions_spawn.aco_publish_stranger_gate_injected',
                reason: 'task prompt contains publish/release keyword, injecting stranger verification gate',
                toolName,
                agentId,
                taskType: detectedType,
                label: taskLabel || null,
                sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
              });
              nextParams = {
                ...(nextParams || args),
                prompt: currentPromptBeforeAcoPublishGate + ACO_PUBLISH_STRANGER_GATE_APPENDIX,
              };
            }

            // README quality rules injection: when the task is about writing/updating
            // user-facing README docs. 「是否在写 README」是语义判断，走 LLM；
            // /readme/i 会把只是顺带提到 readme 的任务误判，也漏判换措辞的文档任务。
            // 失败 fail-open=false（不注入规则），保持注入保守。
            const readmeIntent = await askSemanticYesNo({
              text: String(taskPrompt || ''),
              vectorDb: 'task-type-vectors.json',
              positiveLabel: 'readme',
              maxChars: 2000,
            });
            if (readmeIntent.matched === true) {
              appendAuditEvent({
                decision: 'rewrite',
                ruleId: 'dispatch.sessions_spawn.readme_quality_rules_injected',
                reason: 'LLM classified the task as README authoring; injecting quality rules',
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
              const staleWarning = `\n\n⚠️ [dispatch-guard] 发现 ${staleCompletions.length} 个已完成但未处理的任务：[${staleList}]。建议先处理已完成任务再派新任务。Why：完成事件不处理会让审计/通知/下一步断链，继续派新任务只会扩大遗漏、让闭环越欠越多。`;
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
          const CODE_EXTS = /\.(js|ts|mjs|jsx|tsx|py|sh)$/i;
          const CODE_DIRS = /(^|[\\/])(extensions|projects|hooks|scripts)[\\/]/;
          const MAIN_SESSION_CODE_EDIT_REASON = '[ACO Dispatch Guard] 代码变更请通过编码 Agent 执行，主会话负责派发与推进。';
          if (toolName === 'exec') {
            const sessionKey = typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : '';
            const isMain = sessionKey.includes(':main:') || sessionKey === 'main' || (!sessionKey);
            if (isMain) {
              const cmd = String(args.command || '');
              const stripShellQuotes = (value) => String(value || '').replace(/^['"]|['"]$/g, '');
              const shellTokens = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
              const isCodeFilePath = (value) => {
                const normalized = stripShellQuotes(value);
                return CODE_EXTS.test(normalized) && CODE_DIRS.test(normalized);
              };
              const hasExecCodeWrite = (() => {
                if (/\bsed\s+-i(?:\S*)?\b/i.test(cmd) && shellTokens.some(isCodeFilePath)) return true;
                if (/\btee\b/i.test(cmd) && shellTokens.some(isCodeFilePath)) return true;
                if (/\bawk\s+-i\s+inplace\b/i.test(cmd) && shellTokens.some(isCodeFilePath)) return true;
                if ([...cmd.matchAll(/(?:^|[^\d>])>>?\s*([^\s;&|]+)/g)].some((match) => isCodeFilePath(match[1]))) return true;
                if (/\b(cp|mv)\b/i.test(cmd) && shellTokens.length >= 2 && isCodeFilePath(shellTokens[shellTokens.length - 1])) return true;
                return false;
              })();
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
              if (hasExecCodeWrite) {
                appendAuditEvent({ decision: 'block', ruleId: 'dispatch.exec.main_session_code_write_blocked', reason: MAIN_SESSION_CODE_EDIT_REASON, toolName, command: cmd.slice(0, 120) });
                return { block: true, blockReason: MAIN_SESSION_CODE_EDIT_REASON };
              }
              if (!SAFE_PREFIXES.test(cmd)) {
                for (const pat of BLOCKED_PATTERNS) {
                  if (pat.test(cmd)) {
                    const reason = pat.source.includes('systemctl')
                      ? `暂不执行：Gateway 重启需确认看板空闲 + doctor Errors: 0；其他服务启停请派子 Agent 执行。`
                      : `暂不执行：耗时命令（${pat.source}）请派子 Agent 执行。`;
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
              if (CODE_EXTS.test(filePath) && CODE_DIRS.test(filePath)) {
                appendAuditEvent({ decision: 'block', ruleId: 'dispatch.edit_write.main_session_code_blocked', reason: MAIN_SESSION_CODE_EDIT_REASON, toolName, filePath: filePath.slice(0, 200) });
                return { block: true, blockReason: MAIN_SESSION_CODE_EDIT_REASON };
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
原则：用户问事实→给结论；要行动→做完告知结果；问方案→方案+关键取舍(≤3点)。
Why：飞书 direct chat 里用户需要的是结论和决策信息；排查过程、中间步骤这类过程噪音会掩盖关键状态，增加用户的误解和焦虑。`;

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
