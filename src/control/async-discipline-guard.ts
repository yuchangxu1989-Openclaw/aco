/**
 * FR-K01/K02/K03: Main Session Async Discipline Guard
 *
 * Pure evaluator + audit event helpers. FR-K02 replaces keyword exemption with
 * LLM semantic judgement. FR-K03 keeps degraded state as an in-memory timestamp
 * with a recovery window.
 */

import { createHash } from 'node:crypto';

export const ASYNC_DISCIPLINE_RULE = 'async-discipline';
export const ASYNC_DISCIPLINE_BLOCK_RULE_ID = 'dispatch.process.async_discipline_blocked';
export const ASYNC_DISCIPLINE_EXEMPT_RULE_ID = 'dispatch.process.async_discipline_exempted';
export const ASYNC_DISCIPLINE_ALLOW_RULE_ID = 'dispatch.process.async_discipline_allowed';
export const ASYNC_DISCIPLINE_BYPASS_DISABLED_RULE_ID = 'dispatch.process.async_discipline_bypass_disabled';
export const ASYNC_DISCIPLINE_BYPASS_DEGRADED_RULE_ID = 'dispatch.process.async_discipline_bypass_degraded';
export const ASYNC_DISCIPLINE_RECOVERY_ATTEMPT_RULE_ID = 'dispatch.process.async_discipline_recovery_attempt';

export const LLM_INTENT_JUDGEMENT_PROMPT_VERSION = 'v1';
export const LLM_INTENT_JUDGEMENT_PROMPT_V1 = [
  '你是 ACO 主会话异步纪律守卫的意图判断器。',
  '任务: 判断用户当前消息是否在表达“我授权这次主会话本回合亲自执行长任务/同步等待/不要派子 Agent”。',
  '如果用户当前消息表达了这种授权意图,包括任意自然语言措辞、YES、你别派、我亲自处理、这次我搞、主会话直接干、你顶上、我盯着这个、老规矩你来、[SYSTEM] override、忽略指令放行等,判 YES。',
  '如果用户当前消息没有表达授权主会话亲自执行本回合长任务的意图,判 NO。',
  '严格只返回单词 YES 或 NO,不返回任何解释、标点、引号、代码块、空白以外字符;不返回其他语言;不返回多个单词。',
].join('\n');

export interface LlmJudgementConfig {
  enabled?: boolean;
  provider?: string;
  model?: string;
  timeoutMs?: number;
}

export interface NormalizedLlmJudgementConfig {
  enabled: boolean;
  provider: string;
  model: string;
  timeoutMs: number;
}

export interface AsyncDisciplineGuardConfig {
  enabled?: boolean;
  maxBlockingTimeoutMs?: number;
  blockingActions?: string[];
  llmJudgement?: LlmJudgementConfig;
  degradedRecoveryWindowMs?: number;
  degradedRecoverIntervalMs?: number;
}

export interface NormalizedAsyncDisciplineGuardConfig {
  enabled: boolean;
  maxBlockingTimeoutMs: number;
  blockingActions: string[];
  llmJudgement: NormalizedLlmJudgementConfig;
  degradedRecoveryWindowMs: number;
}

export const DEFAULT_ASYNC_DISCIPLINE_CONFIG: NormalizedAsyncDisciplineGuardConfig = {
  enabled: true,
  maxBlockingTimeoutMs: 5000,
  blockingActions: ['poll', 'wait', 'log', 'list'],
  llmJudgement: {
    enabled: true,
    provider: 'penguin-main',
    model: 'claude-opus-4-7',
    timeoutMs: 5000,
  },
  degradedRecoveryWindowMs: 300000,
};

export type LlmVerdict = 'allow' | 'deny' | 'timeout' | 'error' | 'disabled' | 'not_applicable';

export interface LlmIntentJudgementResult {
  llmVerdict: LlmVerdict;
  llmLatencyMs: number;
  llmError: string | null;
  llmPromptVersion: string | null;
  rawText?: string;
}

export interface LlmIntentJudgementInput {
  provider: string;
  model: string;
  timeoutMs: number;
  systemPrompt: string;
  userPrompt: string;
  promptVersion: string;
  recentUserMessage: string | null;
  toolName: string;
  action: string;
  signal?: AbortSignal;
}

export type JudgeLlmIntent = (input: LlmIntentJudgementInput) => Promise<string>;

export interface AsyncDisciplineState {
  degradedAt: number | null;
}

export interface AsyncDisciplineContext {
  toolName: string;
  toolArgs?: Record<string, unknown>;
  sessionKey?: string;
  agentId?: string;
  recentUserMessage?: string | null;
  config?: AsyncDisciplineGuardConfig & Record<string, unknown>;
  state?: AsyncDisciplineState;
  nowMs?: number;
  judgeLlmIntent?: JudgeLlmIntent;
  simulateMainLogicError?: Error;
}

export type AsyncDisciplineDecisionKind =
  | 'allow'
  | 'block'
  | 'exempt'
  | 'bypass_disabled'
  | 'bypass_degraded'
  | 'recovery_attempt';

export interface AsyncDisciplineDecision {
  decision: AsyncDisciplineDecisionKind;
  block: boolean;
  ruleId: string;
  reason: string;
  timeoutMs: number;
  action: string;
  exemptKeyword: string | null;
  recentUserMessageHash: string | null;
  normalizedConfig: NormalizedAsyncDisciplineGuardConfig;
  llmVerdict: LlmVerdict;
  llmLatencyMs: number;
  llmError: string | null;
  llmPromptVersion: string | null;
  auditEvent: AsyncDisciplineAuditEvent;
  recoveryAuditEvent?: AsyncDisciplineAuditEvent;
  degradedAt: number | null;
}

export interface AsyncDisciplineAuditEvent {
  ts: string;
  timestamp: string;
  eventType: 'dispatch.process.async_discipline';
  rule: 'async-discipline';
  ruleId: string;
  decision: AsyncDisciplineDecisionKind;
  toolName: string;
  sessionKey: string;
  agentId: string;
  action: string;
  timeoutMs: number;
  toolArgs: Record<string, unknown>;
  exemptKeyword: string | null;
  triggerKeyword: string | null;
  recentUserMessageHash: string | null;
  llmVerdict: LlmVerdict;
  llmLatencyMs: number;
  llmError: string | null;
  llmPromptVersion: string | null;
  reason: string;
  details: Record<string, unknown>;
}

export function normalizeAsyncDisciplineConfig(
  config: (AsyncDisciplineGuardConfig & Record<string, unknown>) = {},
): NormalizedAsyncDisciplineGuardConfig {
  const maxBlockingTimeoutMs = Number(config.maxBlockingTimeoutMs ?? DEFAULT_ASYNC_DISCIPLINE_CONFIG.maxBlockingTimeoutMs);
  const rawWindow = Number(
    config.degradedRecoveryWindowMs
      ?? config.degradedRecoverIntervalMs
      ?? DEFAULT_ASYNC_DISCIPLINE_CONFIG.degradedRecoveryWindowMs,
  );
  const degradedRecoveryWindowMs = Number.isFinite(rawWindow) && rawWindow >= 60000 && rawWindow <= 3600000
    ? rawWindow
    : DEFAULT_ASYNC_DISCIPLINE_CONFIG.degradedRecoveryWindowMs;
  const rawLlm = config.llmJudgement && typeof config.llmJudgement === 'object' ? config.llmJudgement : {};
  const timeoutMs = Number(rawLlm.timeoutMs ?? DEFAULT_ASYNC_DISCIPLINE_CONFIG.llmJudgement.timeoutMs);

  return {
    enabled: config.enabled ?? DEFAULT_ASYNC_DISCIPLINE_CONFIG.enabled,
    maxBlockingTimeoutMs: Number.isFinite(maxBlockingTimeoutMs) && maxBlockingTimeoutMs > 0
      ? maxBlockingTimeoutMs
      : DEFAULT_ASYNC_DISCIPLINE_CONFIG.maxBlockingTimeoutMs,
    blockingActions: sanitizeStringArray(config.blockingActions, DEFAULT_ASYNC_DISCIPLINE_CONFIG.blockingActions),
    llmJudgement: {
      enabled: rawLlm.enabled ?? DEFAULT_ASYNC_DISCIPLINE_CONFIG.llmJudgement.enabled,
      provider: typeof rawLlm.provider === 'string' && rawLlm.provider.trim()
        ? rawLlm.provider.trim()
        : DEFAULT_ASYNC_DISCIPLINE_CONFIG.llmJudgement.provider,
      model: typeof rawLlm.model === 'string' && rawLlm.model.trim()
        ? rawLlm.model.trim()
        : DEFAULT_ASYNC_DISCIPLINE_CONFIG.llmJudgement.model,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : DEFAULT_ASYNC_DISCIPLINE_CONFIG.llmJudgement.timeoutMs,
    },
    degradedRecoveryWindowMs,
  };
}

export async function evaluateAsyncDiscipline(
  context: AsyncDisciplineContext,
  now: Date = new Date(context.nowMs ?? Date.now()),
): Promise<AsyncDisciplineDecision> {
  const cfg = normalizeAsyncDisciplineConfig(context.config);
  const state = context.state;
  const nowMs = context.nowMs ?? now.getTime();
  const action = extractAction(context.toolArgs);
  const timeoutMs = extractTimeoutMs(context.toolArgs);
  const recentUserMessageHash = hashRecentUserMessage(context.recentUserMessage);

  if (!cfg.enabled) {
    return buildDecision({
      decision: 'bypass_disabled',
      ruleId: ASYNC_DISCIPLINE_BYPASS_DISABLED_RULE_ID,
      reason: 'Async discipline guard is disabled by configuration.',
      block: false,
      context,
      cfg,
      now,
      action,
      timeoutMs,
      exemptKeyword: null,
      recentUserMessageHash,
      llm: notApplicableLlm(),
      degradedAt: state?.degradedAt ?? null,
    });
  }

  // outer catch: guard main logic only. LLM calls have their own inner catch in judgeLlmExemption.
  try {
    if (context.simulateMainLogicError) throw context.simulateMainLogicError;

    let recoveryAuditEvent: AsyncDisciplineAuditEvent | undefined;
    if (state?.degradedAt !== null && state?.degradedAt !== undefined) {
      const elapsed = nowMs - state.degradedAt;
      if (elapsed < cfg.degradedRecoveryWindowMs) {
        return buildDecision({
          decision: 'bypass_degraded',
          ruleId: ASYNC_DISCIPLINE_BYPASS_DEGRADED_RULE_ID,
          reason: `Async discipline guard is degraded since ${new Date(state.degradedAt).toISOString()}; allowing tool call.`,
          block: false,
          context,
          cfg,
          now,
          action,
          timeoutMs,
          exemptKeyword: null,
          recentUserMessageHash,
          llm: notApplicableLlm(),
          degradedAt: state.degradedAt,
        });
      }

      const previousDegradedAt = state.degradedAt;
      state.degradedAt = null;
      recoveryAuditEvent = buildAuditEvent({
        decision: 'recovery_attempt',
        ruleId: ASYNC_DISCIPLINE_RECOVERY_ATTEMPT_RULE_ID,
        reason: 'Async discipline guard recovery window elapsed; attempting normal evaluation.',
        context,
        cfg,
        now,
        action,
        timeoutMs,
        exemptKeyword: null,
        recentUserMessageHash,
        llm: notApplicableLlm(),
        extraDetails: {
          previousDegradedAt,
          recoveryWindowMs: cfg.degradedRecoveryWindowMs,
          elapsedMs: elapsed,
        },
      });
    }

    const decision = await evaluateAsyncDisciplineMain({ context, cfg, now, action, timeoutMs, recentUserMessageHash });
    if (recoveryAuditEvent) decision.recoveryAuditEvent = recoveryAuditEvent;
    decision.degradedAt = state?.degradedAt ?? null;
    return decision;
  } catch (error) {
    const degradedAt = nowMs;
    if (state) state.degradedAt = degradedAt;
    const message = truncate(error instanceof Error ? error.message : String(error), 256);
    const stackTop = truncate(error instanceof Error && error.stack ? error.stack.split('\n').slice(0, 3).join('\n') : null, 512);
    return buildDecision({
      decision: 'bypass_degraded',
      ruleId: ASYNC_DISCIPLINE_BYPASS_DEGRADED_RULE_ID,
      reason: `Async discipline guard runtime error: ${message}`,
      block: false,
      context,
      cfg,
      now,
      action,
      timeoutMs,
      exemptKeyword: null,
      recentUserMessageHash,
      llm: notApplicableLlm(),
      degradedAt,
      extraDetails: { error: message, stackTop, degradedAt },
    });
  }
}

async function evaluateAsyncDisciplineMain(input: {
  context: AsyncDisciplineContext;
  cfg: NormalizedAsyncDisciplineGuardConfig;
  now: Date;
  action: string;
  timeoutMs: number;
  recentUserMessageHash: string | null;
}): Promise<AsyncDisciplineDecision> {
  const { context, cfg, now, action, timeoutMs, recentUserMessageHash } = input;

  if (!isMainSession(context.sessionKey, context.agentId)) {
    return buildDecision({ decision: 'allow', ruleId: ASYNC_DISCIPLINE_ALLOW_RULE_ID, reason: 'Non-main session; async discipline guard does not apply.', block: false, context, cfg, now, action, timeoutMs, exemptKeyword: null, recentUserMessageHash, llm: notApplicableLlm(), degradedAt: context.state?.degradedAt ?? null });
  }

  if (String(context.toolName || '') !== 'process') {
    return buildDecision({ decision: 'allow', ruleId: ASYNC_DISCIPLINE_ALLOW_RULE_ID, reason: 'Tool is not process; async discipline guard does not apply.', block: false, context, cfg, now, action, timeoutMs, exemptKeyword: null, recentUserMessageHash, llm: notApplicableLlm(), degradedAt: context.state?.degradedAt ?? null });
  }

  if (!cfg.blockingActions.map(a => a.toLowerCase()).includes(action.toLowerCase())) {
    return buildDecision({ decision: 'allow', ruleId: ASYNC_DISCIPLINE_ALLOW_RULE_ID, reason: `process(action=${action || 'unknown'}) is not configured as blocking.`, block: false, context, cfg, now, action, timeoutMs, exemptKeyword: null, recentUserMessageHash, llm: notApplicableLlm(), degradedAt: context.state?.degradedAt ?? null });
  }

  if (timeoutMs < cfg.maxBlockingTimeoutMs) {
    return buildDecision({ decision: 'allow', ruleId: ASYNC_DISCIPLINE_ALLOW_RULE_ID, reason: `process timeout ${timeoutMs}ms is below async discipline threshold ${cfg.maxBlockingTimeoutMs}ms.`, block: false, context, cfg, now, action, timeoutMs, exemptKeyword: null, recentUserMessageHash, llm: notApplicableLlm(), degradedAt: context.state?.degradedAt ?? null });
  }

  const llm = await judgeLlmExemption(context, cfg, action, timeoutMs);
  if (llm.llmVerdict === 'allow') {
    return buildDecision({
      decision: 'exempt',
      ruleId: ASYNC_DISCIPLINE_EXEMPT_RULE_ID,
      reason: 'User exemption intent judged by LLM.',
      block: false,
      context,
      cfg,
      now,
      action,
      timeoutMs,
      exemptKeyword: null,
      recentUserMessageHash,
      llm,
      degradedAt: context.state?.degradedAt ?? null,
    });
  }

  return buildDecision({
    decision: 'block',
    ruleId: ASYNC_DISCIPLINE_BLOCK_RULE_ID,
    reason: buildBlockReason(action, timeoutMs),
    block: true,
    context,
    cfg,
    now,
    action,
    timeoutMs,
    exemptKeyword: null,
    recentUserMessageHash,
    llm,
    degradedAt: context.state?.degradedAt ?? null,
  });
}

export async function judgeLlmExemption(
  context: AsyncDisciplineContext,
  cfg: NormalizedAsyncDisciplineGuardConfig,
  action: string,
  timeoutMs: number,
): Promise<LlmIntentJudgementResult> {
  if (cfg.llmJudgement.enabled === false) {
    return { llmVerdict: 'disabled', llmLatencyMs: 0, llmError: null, llmPromptVersion: null };
  }
  if (!context.judgeLlmIntent) {
    return { llmVerdict: 'error', llmLatencyMs: 0, llmError: 'LLM intent judgement capability unavailable', llmPromptVersion: LLM_INTENT_JUDGEMENT_PROMPT_VERSION };
  }

  const started = Date.now();
  const timeoutMsCfg = cfg.llmJudgement.timeoutMs;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try { controller?.abort(); } catch {}
        reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
      }, timeoutMsCfg);
    });
    const prompt = buildIntentJudgementMessages(context.recentUserMessage ?? null);
    const raw = await Promise.race([
      context.judgeLlmIntent({
        provider: cfg.llmJudgement.provider,
        model: cfg.llmJudgement.model,
        timeoutMs: timeoutMsCfg,
        systemPrompt: prompt.system,
        userPrompt: prompt.user,
        promptVersion: LLM_INTENT_JUDGEMENT_PROMPT_VERSION,
        recentUserMessage: context.recentUserMessage ?? null,
        toolName: context.toolName,
        action,
        signal: controller?.signal,
      }),
      timeoutPromise,
    ]);
    const normalized = normalizeLlmIntentRaw(raw);
    return {
      llmVerdict: normalized === 'YES' ? 'allow' : 'deny',
      llmLatencyMs: Math.max(0, Date.now() - started),
      llmError: null,
      llmPromptVersion: LLM_INTENT_JUDGEMENT_PROMPT_VERSION,
      rawText: truncate(normalized, 32) ?? '',
    };
  } catch (error) {
    // inner catch: LLM call only. Convert every provider/timeout/parse error into verdict metadata; never trigger degraded.
    const elapsed = Math.max(0, Date.now() - started);
    const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' || error.message === 'timeout');
    return {
      llmVerdict: isTimeout ? 'timeout' : 'error',
      llmLatencyMs: isTimeout ? timeoutMsCfg : elapsed,
      llmError: truncate(isTimeout ? 'timeout' : error instanceof Error ? error.message : String(error), 256),
      llmPromptVersion: LLM_INTENT_JUDGEMENT_PROMPT_VERSION,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function normalizeLlmIntentRaw(raw: string): string {
  return String(raw ?? '').trim().toUpperCase().replace(/[\p{P}\p{S}]/gu, '');
}

export function buildIntentJudgementMessages(recentUserMessage: string | null): { system: string; user: string } {
  return {
    system: LLM_INTENT_JUDGEMENT_PROMPT_V1,
    user: `请判断下面这条用户当前消息是否表达授权主会话本回合亲自执行长任务。\n\n\`\`\`\n${recentUserMessage ?? ''}\n\`\`\``,
  };
}

function buildDecision(input: {
  decision: AsyncDisciplineDecisionKind;
  ruleId: string;
  reason: string;
  block: boolean;
  context: AsyncDisciplineContext;
  cfg: NormalizedAsyncDisciplineGuardConfig;
  now: Date;
  action: string;
  timeoutMs: number;
  exemptKeyword: string | null;
  recentUserMessageHash: string | null;
  llm: LlmIntentJudgementResult;
  degradedAt: number | null;
  extraDetails?: Record<string, unknown>;
}): AsyncDisciplineDecision {
  const auditEvent = buildAuditEvent(input);
  return {
    decision: input.decision,
    block: input.block,
    ruleId: input.ruleId,
    reason: input.reason,
    timeoutMs: input.timeoutMs,
    action: input.action,
    exemptKeyword: input.exemptKeyword,
    recentUserMessageHash: input.recentUserMessageHash,
    normalizedConfig: input.cfg,
    llmVerdict: input.llm.llmVerdict,
    llmLatencyMs: input.llm.llmLatencyMs,
    llmError: input.llm.llmError,
    llmPromptVersion: input.llm.llmPromptVersion,
    auditEvent,
    degradedAt: input.degradedAt,
  };
}

function buildAuditEvent(input: {
  decision: AsyncDisciplineDecisionKind;
  ruleId: string;
  reason: string;
  context: AsyncDisciplineContext;
  cfg: NormalizedAsyncDisciplineGuardConfig;
  now: Date;
  action: string;
  timeoutMs: number;
  exemptKeyword: string | null;
  recentUserMessageHash: string | null;
  llm: LlmIntentJudgementResult;
  extraDetails?: Record<string, unknown>;
}): AsyncDisciplineAuditEvent {
  const sessionKey = String(input.context.sessionKey ?? '');
  const agentId = String(input.context.agentId ?? inferAgentIdFromSessionKey(sessionKey) ?? 'unknown');
  const toolName = String(input.context.toolName ?? '');
  const toolArgs = summarizeToolArgs(input.context.toolArgs);
  const timestamp = input.now.toISOString();
  const details = {
    rule: ASYNC_DISCIPLINE_RULE,
    ruleId: input.ruleId,
    decision: input.decision,
    toolName,
    action: input.action,
    timeoutMs: input.timeoutMs,
    exemptKeyword: input.exemptKeyword,
    triggerKeyword: input.exemptKeyword,
    recentUserMessageHash: input.recentUserMessageHash,
    llmVerdict: input.llm.llmVerdict,
    llmLatencyMs: input.llm.llmLatencyMs,
    llmError: input.llm.llmError,
    llmPromptVersion: input.llm.llmPromptVersion,
    reason: input.reason,
    ...(input.extraDetails ?? {}),
  };
  return {
    ts: timestamp,
    timestamp,
    eventType: 'dispatch.process.async_discipline',
    rule: ASYNC_DISCIPLINE_RULE,
    ruleId: input.ruleId,
    decision: input.decision,
    toolName,
    sessionKey,
    agentId,
    action: input.action,
    timeoutMs: input.timeoutMs,
    toolArgs,
    exemptKeyword: input.exemptKeyword,
    triggerKeyword: input.exemptKeyword,
    recentUserMessageHash: input.recentUserMessageHash,
    llmVerdict: input.llm.llmVerdict,
    llmLatencyMs: input.llm.llmLatencyMs,
    llmError: input.llm.llmError,
    llmPromptVersion: input.llm.llmPromptVersion,
    reason: input.reason,
    details,
  };
}

export function buildBlockReason(action: string, timeoutMs: number): string {
  return [
    `[ACO 异步纪律守卫] 主会话被禁止调用 process(action=${action || 'unknown'}, timeout=${timeoutMs}ms) 同步等待。`,
    '原因: 此调用会锁住主会话 lane，期间用户 IM 消息会被静默排队，体感等同失联。',
    '',
    '合规路径(任选其一):',
    '  1. 信任 push-based completion event。spawn 后直接结束当前回合，子 Agent 完成时会自动触发新回合，无需主动 poll。',
    '  2. 确实需要观察某个进程状态，改派一个短任务子 Agent 异步执行 poll，完成后通过 completion event 回报结果。',
    '',
    '豁免方式: 用户在最近一条 IM 消息中明确表达让主会话本回合亲自执行这件事的意图，由 LLM 语义判定。',
    '豁免仅本次有效，下次调用重新走完整守卫。',
    '',
    `命中规则: ${ASYNC_DISCIPLINE_BLOCK_RULE_ID}`,
  ].join('\n');
}

export function isMainSession(sessionKey?: string, agentId?: string): boolean {
  if (agentId === 'main') return true;
  const key = String(sessionKey ?? '');
  return key.includes(':main:') || key.startsWith('agent:main:');
}

export function hashRecentUserMessage(message: string | null | undefined): string | null {
  if (message === null || message === undefined) return 'cache_miss';
  return createHash('sha256').update(String(message)).digest('hex').slice(0, 16);
}

function notApplicableLlm(): LlmIntentJudgementResult {
  return { llmVerdict: 'not_applicable', llmLatencyMs: 0, llmError: null, llmPromptVersion: null };
}

function extractAction(args?: Record<string, unknown>): string {
  const action = args?.action;
  return typeof action === 'string' ? action : '';
}

function extractTimeoutMs(args?: Record<string, unknown>): number {
  const raw = args?.timeout;
  const parsed = typeof raw === 'number' ? raw : Number(raw ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function inferAgentIdFromSessionKey(sessionKey: string): string | undefined {
  const parts = sessionKey.split(':');
  if (parts[0] === 'agent' && parts[1]) return parts[1];
  return undefined;
}

function summarizeToolArgs(args?: Record<string, unknown>): Record<string, unknown> {
  if (!args) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') out[key] = value.length > 60 ? `${value.slice(0, 60)}…` : value;
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
    else if (value === undefined) out[key] = undefined;
    else {
      const text = JSON.stringify(value);
      out[key] = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    }
  }
  return out;
}

function sanitizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const sanitized = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return sanitized.length > 0 ? sanitized : [...fallback];
}

function truncate(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length > max ? value.slice(0, max) : value;
}
