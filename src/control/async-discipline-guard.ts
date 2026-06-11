/**
 * FR-K01/K02/K03: Main Session Async Discipline Guard
 *
 * Pure evaluator + audit event helpers. FR-K02 uses Ark embedding cosine
 * similarity for one-call exemption intent judgement. FR-K03 keeps degraded
 * state as an in-memory timestamp with a recovery window.
 */

import { createHash } from 'node:crypto';
import { matchSemanticVector, SEMANTIC_VECTOR_MODEL, type SemanticVectorMatch } from '../shared/semantic-vector-classifier.js';

export const ASYNC_DISCIPLINE_RULE = 'async-discipline';
export const ASYNC_DISCIPLINE_BLOCK_RULE_ID = 'dispatch.process.async_discipline_blocked';
export const ASYNC_DISCIPLINE_EXEMPT_RULE_ID = 'dispatch.process.async_discipline_exempted';
export const ASYNC_DISCIPLINE_ALLOW_RULE_ID = 'dispatch.process.async_discipline_allowed';
export const ASYNC_DISCIPLINE_BYPASS_DISABLED_RULE_ID = 'dispatch.process.async_discipline_bypass_disabled';
export const ASYNC_DISCIPLINE_BYPASS_DEGRADED_RULE_ID = 'dispatch.process.async_discipline_bypass_degraded';
export const ASYNC_DISCIPLINE_RECOVERY_ATTEMPT_RULE_ID = 'dispatch.process.async_discipline_recovery_attempt';
export const VECTOR_INTENT_DOMAIN = 'async-exemption-intent';

export interface VectorJudgementConfig {
  enabled?: boolean;
  timeoutMs?: number;
}

export interface NormalizedVectorJudgementConfig {
  enabled: boolean;
  timeoutMs: number;
}

export interface AsyncDisciplineGuardConfig {
  enabled?: boolean;
  maxBlockingTimeoutMs?: number;
  blockingActions?: string[];
  vectorJudgement?: VectorJudgementConfig;
  degradedRecoveryWindowMs?: number;
  degradedRecoverIntervalMs?: number;
}

export interface NormalizedAsyncDisciplineGuardConfig {
  enabled: boolean;
  maxBlockingTimeoutMs: number;
  blockingActions: string[];
  vectorJudgement: NormalizedVectorJudgementConfig;
  degradedRecoveryWindowMs: number;
}

export const DEFAULT_ASYNC_DISCIPLINE_CONFIG: NormalizedAsyncDisciplineGuardConfig = {
  enabled: true,
  maxBlockingTimeoutMs: 5000,
  blockingActions: ['poll', 'wait', 'log', 'list'],
  vectorJudgement: {
    enabled: true,
    timeoutMs: 8000,
  },
  degradedRecoveryWindowMs: 300000,
};

export type VectorVerdict = 'allow' | 'deny' | 'unavailable' | 'disabled' | 'not_applicable';

export interface VectorIntentJudgementResult {
  vectorVerdict: VectorVerdict;
  vectorLatencyMs: number;
  vectorError: string | null;
  vectorModel: string | null;
  vectorScore: number | null;
  vectorConfidenceBand: SemanticVectorMatch['confidenceBand'] | null;
  matchedSampleId?: string | null;
}

export interface VectorIntentJudgementInput {
  recentUserMessage: string | null;
  timeoutMs: number;
}

export type JudgeVectorIntent = (input: VectorIntentJudgementInput) => Promise<SemanticVectorMatch<'allow' | 'deny'>>;

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
  judgeVectorIntent?: JudgeVectorIntent;
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
  vectorVerdict: VectorVerdict;
  vectorLatencyMs: number;
  vectorError: string | null;
  vectorModel: string | null;
  vectorScore: number | null;
  vectorConfidenceBand: SemanticVectorMatch['confidenceBand'] | null;
  auditEvent: AsyncDisciplineAuditEvent;
  recoveryAuditEvent?: AsyncDisciplineAuditEvent;
  degradedAt: number | null;
}

export interface AsyncDisciplineAuditEvent {
  ts: string;
  timestamp: string;
  eventType: 'dispatch.process.async_discipline';
  rule: typeof ASYNC_DISCIPLINE_RULE;
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
  vectorVerdict: VectorVerdict;
  vectorLatencyMs: number;
  vectorError: string | null;
  vectorModel: string | null;
  vectorScore: number | null;
  vectorConfidenceBand: SemanticVectorMatch['confidenceBand'] | null;
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
  const rawVector = config.vectorJudgement && typeof config.vectorJudgement === 'object' ? config.vectorJudgement : {};
  const timeoutMs = Number(rawVector.timeoutMs ?? DEFAULT_ASYNC_DISCIPLINE_CONFIG.vectorJudgement.timeoutMs);

  return {
    enabled: config.enabled ?? DEFAULT_ASYNC_DISCIPLINE_CONFIG.enabled,
    maxBlockingTimeoutMs: Number.isFinite(maxBlockingTimeoutMs) && maxBlockingTimeoutMs > 0
      ? maxBlockingTimeoutMs
      : DEFAULT_ASYNC_DISCIPLINE_CONFIG.maxBlockingTimeoutMs,
    blockingActions: sanitizeStringArray(config.blockingActions, DEFAULT_ASYNC_DISCIPLINE_CONFIG.blockingActions),
    vectorJudgement: {
      enabled: rawVector.enabled ?? DEFAULT_ASYNC_DISCIPLINE_CONFIG.vectorJudgement.enabled,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : DEFAULT_ASYNC_DISCIPLINE_CONFIG.vectorJudgement.timeoutMs,
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
      vector: notApplicableVector(),
      degradedAt: state?.degradedAt ?? null,
    });
  }

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
          vector: notApplicableVector(),
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
        vector: notApplicableVector(),
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
      vector: notApplicableVector(),
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
    return buildDecision({ decision: 'allow', ruleId: ASYNC_DISCIPLINE_ALLOW_RULE_ID, reason: 'Non-main session; async discipline guard does not apply.', block: false, context, cfg, now, action, timeoutMs, exemptKeyword: null, recentUserMessageHash, vector: notApplicableVector(), degradedAt: context.state?.degradedAt ?? null });
  }

  if (String(context.toolName || '') !== 'process') {
    return buildDecision({ decision: 'allow', ruleId: ASYNC_DISCIPLINE_ALLOW_RULE_ID, reason: 'Tool is not process; async discipline guard does not apply.', block: false, context, cfg, now, action, timeoutMs, exemptKeyword: null, recentUserMessageHash, vector: notApplicableVector(), degradedAt: context.state?.degradedAt ?? null });
  }

  if (!cfg.blockingActions.map(a => a.toLowerCase()).includes(action.toLowerCase())) {
    return buildDecision({ decision: 'allow', ruleId: ASYNC_DISCIPLINE_ALLOW_RULE_ID, reason: `process(action=${action || 'unknown'}) is not configured as blocking.`, block: false, context, cfg, now, action, timeoutMs, exemptKeyword: null, recentUserMessageHash, vector: notApplicableVector(), degradedAt: context.state?.degradedAt ?? null });
  }

  if (timeoutMs < cfg.maxBlockingTimeoutMs) {
    return buildDecision({ decision: 'allow', ruleId: ASYNC_DISCIPLINE_ALLOW_RULE_ID, reason: `process timeout ${timeoutMs}ms is below async discipline threshold ${cfg.maxBlockingTimeoutMs}ms.`, block: false, context, cfg, now, action, timeoutMs, exemptKeyword: null, recentUserMessageHash, vector: notApplicableVector(), degradedAt: context.state?.degradedAt ?? null });
  }

  const vector = await judgeVectorExemption(context, cfg);
  if (vector.vectorVerdict === 'deny') {
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
      vector,
      degradedAt: context.state?.degradedAt ?? null,
    });
  }

  return buildDecision({
    decision: 'exempt',
    ruleId: ASYNC_DISCIPLINE_EXEMPT_RULE_ID,
    reason: vectorAllowReason(vector.vectorVerdict),
    block: false,
    context,
    cfg,
    now,
    action,
    timeoutMs,
    exemptKeyword: null,
    recentUserMessageHash,
    vector,
    degradedAt: context.state?.degradedAt ?? null,
  });
}

export async function judgeVectorExemption(
  context: AsyncDisciplineContext,
  cfg: NormalizedAsyncDisciplineGuardConfig,
): Promise<VectorIntentJudgementResult> {
  if (cfg.vectorJudgement.enabled === false) {
    return { vectorVerdict: 'disabled', vectorLatencyMs: 0, vectorError: null, vectorModel: null, vectorScore: null, vectorConfidenceBand: null };
  }

  const started = Date.now();
  try {
    const recentUserMessage = context.recentUserMessage ?? null;
    const match = context.judgeVectorIntent
      ? await context.judgeVectorIntent({ recentUserMessage, timeoutMs: cfg.vectorJudgement.timeoutMs })
      : await matchSemanticVector<'allow' | 'deny'>({
        text: recentUserMessage ?? '',
        domain: VECTOR_INTENT_DOMAIN,
        timeoutMs: cfg.vectorJudgement.timeoutMs,
      });

    return {
      vectorVerdict: match.ok && match.label === 'deny' ? 'deny' : match.ok && match.label === 'allow' ? 'allow' : 'unavailable',
      vectorLatencyMs: Math.max(0, Date.now() - started),
      vectorError: match.ok ? null : truncate(match.reason ?? 'embedding match unavailable', 256),
      vectorModel: match.model ?? SEMANTIC_VECTOR_MODEL,
      vectorScore: Number.isFinite(match.score) && match.score >= 0 ? match.score : null,
      vectorConfidenceBand: match.confidenceBand ?? null,
      matchedSampleId: match.matchedSampleId,
    };
  } catch (error) {
    return {
      vectorVerdict: 'unavailable',
      vectorLatencyMs: Math.max(0, Date.now() - started),
      vectorError: truncate(error instanceof Error ? error.message : String(error), 256),
      vectorModel: SEMANTIC_VECTOR_MODEL,
      vectorScore: null,
      vectorConfidenceBand: null,
    };
  }
}

function vectorAllowReason(verdict: VectorVerdict): string {
  if (verdict === 'allow') return 'User exemption intent matched by embedding cosine similarity.';
  if (verdict === 'disabled') return 'Embedding classifier disabled by configuration; allowing tool call without LLM fallback.';
  return 'Embedding classifier unavailable; allowing tool call without LLM fallback.';
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
  vector: VectorIntentJudgementResult;
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
    vectorVerdict: input.vector.vectorVerdict,
    vectorLatencyMs: input.vector.vectorLatencyMs,
    vectorError: input.vector.vectorError,
    vectorModel: input.vector.vectorModel,
    vectorScore: input.vector.vectorScore,
    vectorConfidenceBand: input.vector.vectorConfidenceBand,
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
  vector: VectorIntentJudgementResult;
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
    vectorVerdict: input.vector.vectorVerdict,
    vectorLatencyMs: input.vector.vectorLatencyMs,
    vectorError: input.vector.vectorError,
    vectorModel: input.vector.vectorModel,
    vectorScore: input.vector.vectorScore,
    vectorConfidenceBand: input.vector.vectorConfidenceBand,
    matchedSampleId: input.vector.matchedSampleId ?? null,
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
    vectorVerdict: input.vector.vectorVerdict,
    vectorLatencyMs: input.vector.vectorLatencyMs,
    vectorError: input.vector.vectorError,
    vectorModel: input.vector.vectorModel,
    vectorScore: input.vector.vectorScore,
    vectorConfidenceBand: input.vector.vectorConfidenceBand,
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
    '豁免方式: 用户在最近一条 IM 消息中明确表达让主会话本回合亲自执行这件事的意图，由向量匹配判定。',
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

function notApplicableVector(): VectorIntentJudgementResult {
  return {
    vectorVerdict: 'not_applicable',
    vectorLatencyMs: 0,
    vectorError: null,
    vectorModel: null,
    vectorScore: null,
    vectorConfidenceBand: null,
  };
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
