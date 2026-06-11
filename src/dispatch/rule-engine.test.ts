import { describe, expect, it } from 'vitest';
import { EventBus } from '../event/event-bus.js';
import type { AgentSlot, Task } from '../types/index.js';
import { RuleEngine } from './rule-engine.js';

function makeTask(prompt: string): Task {
  return {
    taskId: 'task-1',
    label: 'test',
    prompt,
    timeoutSeconds: 600,
    priority: 1,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    retryCount: 0,
    maxRetries: 0,
  };
}

function makeAgent(roles: string[] = ['coder']): AgentSlot {
  return {
    agentId: 'agent-1',
    tier: 'T1',
    runtimeType: 'subagent',
    status: 'idle',
    roles,
    maxConcurrency: 1,
    activeTasks: 0,
    totalCompleted: 0,
    totalFailed: 0,
    consecutiveFailures: 0,
  };
}

describe('RuleEngine embedding classification', () => {
  it('classifies task type from embedding cosine match', async () => {
    const engine = new RuleEngine(new EventBus());
    engine.setVectorClassifier(async () => ({
      ok: true,
      label: 'audit',
      score: 0.74,
      confidenceBand: 'direct',
      matchedSampleId: 'dispatch-task-type:audit:1',
      matchedSampleText: '独立审计实现结果',
      providerId: 'volcengine-ark',
      model: 'doubao-embedding-vision-251215',
    }));

    const result = await engine.classifyTask(makeTask('请独立审计这次实现'));

    expect(result).toEqual({
      taskType: 'audit',
      source: 'embedding',
      score: 0.74,
      confidenceBand: 'direct',
    });
  });

  it('falls back to unknown when embedding is unavailable', async () => {
    const engine = new RuleEngine(new EventBus());
    engine.setVectorClassifier(async () => ({
      ok: false,
      label: null,
      score: -1,
      confidenceBand: 'none',
      matchedSampleId: null,
      matchedSampleText: null,
      providerId: 'volcengine-ark',
      model: 'doubao-embedding-vision-251215',
      reason: 'query embedding unavailable',
    }));

    const result = await engine.classifyTask(makeTask('看一下这个任务'));

    expect(result).toEqual({ taskType: 'unknown', source: 'fallback' });
  });

  it('uses declared task type before embedding classification', async () => {
    const engine = new RuleEngine(new EventBus());
    engine.setVectorClassifier(async () => {
      throw new Error('embedding classifier should not run for declared task type');
    });

    const result = await engine.classifyTask(makeTask('任意任务'), 'code');

    expect(result).toEqual({ taskType: 'code', source: 'declared' });
  });

  it('uses embedding classification when enforcing self-audit prohibition', async () => {
    const engine = new RuleEngine(new EventBus());
    engine.setVectorClassifier(async () => ({
      ok: true,
      label: 'audit',
      score: 0.8,
      confidenceBand: 'direct',
      matchedSampleId: 'dispatch-task-type:audit:1',
      matchedSampleText: '独立审计实现结果',
      providerId: 'volcengine-ark',
      model: 'doubao-embedding-vision-251215',
    }));

    const decision = await engine.evaluate(
      makeTask('请审核你刚才写的代码'),
      makeAgent(['auditor']),
      { parentAgentId: 'agent-1' },
    );

    expect(decision.allowed).toBe(false);
    expect(decision.action).toBe('block');
    expect(decision.reason).toContain('Self-audit prohibited');
  });
});
