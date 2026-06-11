/**
 * Tests for Async Discipline Guard Plugin Generator — FR-K01/K02/K03
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

  it('registers before_prompt_build and async before_tool_call hooks', () => {
    expect(output).toContain("api.on('before_prompt_build'");
    expect(output).toContain("api.on('before_tool_call'");
    expect(output).toContain('async function(event, context)');
    expect(output).toContain('await evaluateAsyncDiscipline(event, context, cfg)');
    expect(output).toContain('recentUserMessageCache');
    expect(output).toContain("msg.role !== 'user'");
  });

  it('blocks only process calls with configured blocking actions and threshold', () => {
    expect(output).toContain("toolName !== 'process'");
    expect(output).toContain('blockingActions');
    expect(output).toContain('timeoutMs < cfg.maxBlockingTimeoutMs');
    expect(output).toContain('isMainSession(sessionKey, agentId)');
    expect(output).toContain('block: true');
    expect(output).toContain('blockReason');
  });

  it('uses Ark vector judgement and removes keyword and LLM exemption paths', () => {
    expect(output).toContain('vectorIntentJudgement');
    expect(output).toContain('VECTOR_DB');
    expect(output).toContain('doubao-embedding-vision-251215');
    expect(output).toContain('/embeddings/multimodal');
    expect(output).toContain('cfg.vectorJudgement');
    expect(output).not.toContain('llmIntentJudgement');
    expect(output).not.toContain('chat.complete');
    expect(output).not.toContain('/chat/completions');
    expect(output).not.toContain('findExemptKeyword');
    expect(output).not.toContain('userExemptKeywords');
    expect(output).not.toContain('exemptedSessions');
  });

  it('writes async discipline audit schema with vector fields', () => {
    expect(output).toContain('dispatch-guard-events.jsonl');
    expect(output).toContain("rule: 'async-discipline'");
    expect(output).toContain("eventType: 'dispatch.process.async_discipline'");
    expect(output).toContain('exemptKeyword');
    expect(output).toContain('triggerKeyword');
    expect(output).toContain('recentUserMessageHash');
    expect(output).toContain('vectorVerdict');
    expect(output).toContain('vectorLatencyMs');
    expect(output).toContain('vectorModel');
  });

  it('supports disabled, degraded, recovery, and vector-unavailable allow decisions', () => {
    expect(output).toContain('bypass_disabled');
    expect(output).toContain('bypass_degraded');
    expect(output).toContain('recovery_attempt');
    expect(output).toContain('let degradedAt = null');
    expect(output).toContain("vectorVerdict !== 'deny'");
    expect(output).toContain('without LLM fallback');
    expect(output).not.toContain('degraded = true');
  });

  it('does not reference run-watchdog state or completion queues', () => {
    expect(output).not.toContain('run-watchdog-state');
    expect(output).not.toContain('queueAutoAdvanceNotice');
    expect(output).not.toContain('consumeAutoAdvanceNotice');
  });

  it('keeps DEFAULT_CONFIG complete when caller passes explicit undefined fields', () => {
    const cases = [
      generateAsyncDisciplineGuardPlugin(),
      generateAsyncDisciplineGuardPlugin({ enabled: undefined }),
      generateAsyncDisciplineGuardPlugin({
        enabled: undefined,
        maxBlockingTimeoutMs: undefined,
        blockingActions: undefined,
        vectorJudgement: { enabled: undefined, timeoutMs: undefined },
        degradedRecoveryWindowMs: undefined,
      }),
    ];

    for (const generated of cases) {
      expect(generated).toContain('"enabled": true');
      expect(generated).toContain('"maxBlockingTimeoutMs": 5000');
      expect(generated).toContain('"blockingActions"');
      expect(generated).toContain('"degradedRecoveryWindowMs": 300000');
      expect(generated).toContain('"vectorJudgement"');
      expect(generated).toContain('"timeoutMs": 8000');
      expect(generated).not.toContain('"llmJudgement"');
    }
  });

  it('keeps DEFAULT_CONFIG complete when caller passes partial config', () => {
    const generated = generateAsyncDisciplineGuardPlugin({
      enabled: false,
      blockingActions: ['poll'],
      vectorJudgement: { timeoutMs: 2500 },
    });

    expect(generated).toContain('"enabled": false');
    expect(generated).toContain('"maxBlockingTimeoutMs": 5000');
    expect(generated).toContain('"blockingActions"');
    expect(generated).toContain('"poll"');
    expect(generated).toContain('"degradedRecoveryWindowMs": 300000');
    expect(generated).toContain('"vectorJudgement"');
    expect(generated).toContain('"timeoutMs": 2500');
  });

  it('respects custom options', () => {
    const custom = generateAsyncDisciplineGuardPlugin({
      maxBlockingTimeoutMs: 9000,
      blockingActions: ['poll'],
      vectorJudgement: { timeoutMs: 3000 },
      auditLogPath: '/tmp/dispatch-guard-events.jsonl',
      pluginName: 'custom-async-guard',
    });

    expect(custom).toContain('9000');
    expect(custom).toContain('"timeoutMs": 3000');
    expect(custom).toContain('/tmp/dispatch-guard-events.jsonl');
    expect(custom).toContain('custom-async-guard');
  });
});

describe('async discipline generator registry', () => {
  it('registers async-discipline-guard-plugin for aco init', () => {
    expect(getGenerators().map(g => g.name)).toContain('async-discipline-guard-plugin');
    const item = listGenerators().find(g => g.name === 'async-discipline-guard-plugin');
    expect(item).toBeDefined();
    expect(item?.description).toContain('async discipline');
  });

  it('accepts volcengine-ark api key in OpenClaw config during init generation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aco-async-guard-'));
    try {
      const openclawConfigPath = join(dir, 'openclaw.json');
      await writeFile(openclawConfigPath, JSON.stringify({
        models: {
          providers: {
            'volcengine-ark': {
              apiKey: 'test-key',
              baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
            },
          },
        },
      }));

      const generator = getGenerators().find(g => g.name === 'async-discipline-guard-plugin');
      await generator?.generate({
        openclawHome: dir,
        rulesPath: join(dir, 'extensions', 'aco-rules', 'rules.json'),
        dataDir: join(dir, 'aco-data'),
        openclawConfigPath,
      }, {}, true);

      const plugin = await readFile(join(dir, 'extensions', 'aco-async-discipline-guard', 'index.js'), 'utf-8');
      expect(plugin).toContain('aco-async-discipline-guard');
      expect(plugin).toContain('/embeddings/multimodal');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
