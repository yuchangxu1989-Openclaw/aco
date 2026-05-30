/**
 * Tests for Async Discipline Guard Plugin Generator — FR-K01/K02/K03
 */

import { describe, expect, it } from 'vitest';
import { generateAsyncDisciplineGuardPlugin } from './async-discipline-guard-plugin.js';
import { getGenerators, listGenerators } from './index.js';

describe('generateAsyncDisciplineGuardPlugin', () => {
  const output = generateAsyncDisciplineGuardPlugin();

  it('generates Gateway-loadable ESM plugin structure', () => {
    expect(output).toContain('export default {');
    expect(output).toContain('register(api)');
    expect(output).toContain('aco-async-discipline-guard');
  });

  it('registers before_prompt_build and async before_tool_call hooks (FR-K01 AC1/AC4 + FR-K02 AC14)', () => {
    expect(output).toContain("api.on('before_prompt_build'");
    expect(output).toContain("api.on('before_tool_call'");
    expect(output).toContain('async function(event, context)');
    expect(output).toContain('await evaluateAsyncDiscipline(event, context, cfg)');
    expect(output).toContain('recentUserMessageCache');
    expect(output).toContain("msg.role !== 'user'");
  });

  it('blocks only process calls with configured blocking actions and threshold (FR-K01 AC1/AC2/AC7/AC10)', () => {
    expect(output).toContain("toolName !== 'process'");
    expect(output).toContain('blockingActions');
    expect(output).toContain('timeoutMs < cfg.maxBlockingTimeoutMs');
    expect(output).toContain('isMainSession(sessionKey, agentId)');
    expect(output).toContain('block: true');
    expect(output).toContain('blockReason');
  });

  it('uses LLM judgement and removes keyword exemption path (FR-K02 AC1/AC6/P1)', () => {
    expect(output).toContain('llmIntentJudgement');
    expect(output).toContain('LLM_INTENT_JUDGEMENT_PROMPT_V1');
    expect(output).toContain('asyncDisciplineGuard.llmJudgement');
    expect(output).not.toContain('findExemptKeyword');
    expect(output).not.toContain('userExemptKeywords');
    expect(output).not.toContain('exemptedSessions');
  });

  it('writes async discipline audit schema with LLM fields (FR-K02 AC7/AC10)', () => {
    expect(output).toContain('dispatch-guard-events.jsonl');
    expect(output).toContain("rule: 'async-discipline'");
    expect(output).toContain("eventType: 'dispatch.process.async_discipline'");
    expect(output).toContain('exemptKeyword');
    expect(output).toContain('triggerKeyword');
    expect(output).toContain('recentUserMessageHash');
    expect(output).toContain('llmVerdict');
    expect(output).toContain('llmLatencyMs');
    expect(output).toContain('llmPromptVersion');
  });

  it('supports disabled, degraded, and recovery decisions with degradedAt timestamp (FR-K03)', () => {
    expect(output).toContain('bypass_disabled');
    expect(output).toContain('bypass_degraded');
    expect(output).toContain('recovery_attempt');
    expect(output).toContain('let degradedAt = null');
    expect(output).not.toContain('degraded = true');
  });

  it('does not reference run-watchdog state or completion queues (FR-K01 AC9)', () => {
    expect(output).not.toContain('run-watchdog-state');
    expect(output).not.toContain('queueAutoAdvanceNotice');
    expect(output).not.toContain('consumeAutoAdvanceNotice');
  });

  it('keeps DEFAULT_CONFIG complete when caller passes explicit undefined fields (P1 regression)', () => {
    const cases = [
      generateAsyncDisciplineGuardPlugin(),
      generateAsyncDisciplineGuardPlugin({ enabled: undefined }),
      generateAsyncDisciplineGuardPlugin({
        enabled: undefined,
        maxBlockingTimeoutMs: undefined,
        blockingActions: undefined,
        llmJudgement: { enabled: undefined, provider: undefined, model: undefined, timeoutMs: undefined },
        degradedRecoveryWindowMs: undefined,
      }),
    ];

    for (const generated of cases) {
      expect(generated).toContain('"enabled": true');
      expect(generated).toContain('"maxBlockingTimeoutMs": 5000');
      expect(generated).toContain('"blockingActions"');
      expect(generated).toContain('"degradedRecoveryWindowMs": 300000');
      expect(generated).toContain('"llmJudgement"');
      expect(generated).toContain('"provider": "penguin-main"');
      expect(generated).toContain('"model": "claude-opus-4-7"');
    }
  });

  it('keeps DEFAULT_CONFIG complete when caller passes partial config (P1 regression)', () => {
    const generated = generateAsyncDisciplineGuardPlugin({
      enabled: false,
      blockingActions: ['poll'],
      llmJudgement: { timeoutMs: 2500 },
    });

    expect(generated).toContain('"enabled": false');
    expect(generated).toContain('"maxBlockingTimeoutMs": 5000');
    expect(generated).toContain('"blockingActions"');
    expect(generated).toContain('"poll"');
    expect(generated).toContain('"degradedRecoveryWindowMs": 300000');
    expect(generated).toContain('"llmJudgement"');
    expect(generated).toContain('"enabled": true');
    expect(generated).toContain('"provider": "penguin-main"');
    expect(generated).toContain('"model": "claude-opus-4-7"');
    expect(generated).toContain('"timeoutMs": 2500');
  });

  it('respects custom options', () => {
    const custom = generateAsyncDisciplineGuardPlugin({
      maxBlockingTimeoutMs: 9000,
      blockingActions: ['poll'],
      llmJudgement: { provider: 'penguin-main', model: 'claude-opus-4-7', timeoutMs: 3000 },
      auditLogPath: '/tmp/dispatch-guard-events.jsonl',
      pluginName: 'custom-async-guard',
    });

    expect(custom).toContain('9000');
    expect(custom).toContain('claude-opus-4-7');
    expect(custom).toContain('/tmp/dispatch-guard-events.jsonl');
    expect(custom).toContain('custom-async-guard');
  });
});

describe('async discipline generator registry', () => {
  it('registers async-discipline-guard-plugin for aco init (FR-K01 AC11)', () => {
    expect(getGenerators().map(g => g.name)).toContain('async-discipline-guard-plugin');
    const item = listGenerators().find(g => g.name === 'async-discipline-guard-plugin');
    expect(item).toBeDefined();
    expect(item?.description).toContain('async discipline');
  });
});
