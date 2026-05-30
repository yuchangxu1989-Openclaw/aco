/**
 * Tests for P1-2: ChainExecutor runtime class
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ChainExecutor } from '../src/chain/chain-executor.js';
import { EventBus } from '../src/event/event-bus.js';
import type { CompletionChainDef, Task } from '../src/types/index.js';
import type { TaskOutput } from '../src/chain/chain-executor.js';

function createMockTask(overrides?: Partial<Task>): Task {
  return {
    taskId: 'parent-task-1',
    label: 'parent task',
    prompt: 'do something',
    agentId: 'cc',
    timeoutSeconds: 600,
    priority: 50,
    status: 'succeeded',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    retryCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

describe('ChainExecutor', () => {
  let eventBus: EventBus;
  let executor: ChainExecutor;

  beforeEach(() => {
    eventBus = new EventBus();
    executor = new ChainExecutor(eventBus);
  });

  describe('FR-D01: 链式触发', () => {
    it('starts a chain execution from onSuccess branch', () => {
      const chainDef: CompletionChainDef = {
        onSuccess: [
          { label: 'audit', promptTemplate: 'Audit the code' },
          { label: 'deploy', promptTemplate: 'Deploy to prod' },
        ],
      };

      const execution = executor.start(chainDef, createMockTask(), { summary: 'done' });
      expect(execution).toBeDefined();
      expect(execution!.status).toBe('running');
      expect(execution!.nodes).toHaveLength(2);
      expect(execution!.nodes[0].status).toBe('pending');
    });

    it('returns undefined for empty chain', () => {
      const chainDef: CompletionChainDef = { onSuccess: [] };
      const execution = executor.start(chainDef, createMockTask(), {});
      expect(execution).toBeUndefined();
    });

    it('AC2: resolves template variables in prompt', () => {
      const chainDef: CompletionChainDef = {
        onSuccess: [
          { label: 'audit', promptTemplate: 'Review output: {{parent.summary}}, files: {{parent.files}}' },
        ],
      };

      const output: TaskOutput = { summary: 'all tests pass', files: ['src/a.ts', 'src/b.ts'] };
      const execution = executor.start(chainDef, createMockTask(), output);
      const request = executor.getNextTaskRequest(execution!.executionId);

      expect(request).not.toBeNull();
      expect(request!.prompt).toContain('all tests pass');
      expect(request!.prompt).toContain('src/a.ts, src/b.ts');
    });

    it('AC3: inherits parent priority', () => {
      const chainDef: CompletionChainDef = {
        onSuccess: [
          { label: 'audit', promptTemplate: 'audit', priority: 80 },
        ],
      };

      const execution = executor.start(chainDef, createMockTask({ priority: 70 }), {});
      const request = executor.getNextTaskRequest(execution!.executionId);
      expect(request!.priority).toBe(80); // chain config overrides
    });

    it('advances through steps sequentially', () => {
      const chainDef: CompletionChainDef = {
        onSuccess: [
          { label: 'step1', promptTemplate: 'do step 1' },
          { label: 'step2', promptTemplate: 'do step 2' },
        ],
      };

      const execution = executor.start(chainDef, createMockTask(), {});
      const req1 = executor.getNextTaskRequest(execution!.executionId);
      expect(req1!.label).toBe('step1');

      // Complete step 1
      const result1 = executor.reportStepCompleted(execution!.executionId, req1!.nodeId, true, { summary: 'ok' });
      expect(result1.next).toBe('advance');

      // Get step 2
      const req2 = executor.getNextTaskRequest(execution!.executionId);
      expect(req2!.label).toBe('step2');

      // Complete step 2
      const result2 = executor.reportStepCompleted(execution!.executionId, req2!.nodeId, true, { summary: 'done' });
      expect(result2.next).toBe('done');

      // Chain is complete
      const status = executor.getStatus(execution!.executionId);
      expect(status!.status).toBe('succeeded');
    });

    it('AC5: supports loop chain on negative conclusion', () => {
      const chainDef: CompletionChainDef = {
        onSuccess: [
          { label: 'audit', promptTemplate: 'audit code', maxLoopCount: 3 },
        ],
      };

      const execution = executor.start(chainDef, createMockTask(), {});
      const req1 = executor.getNextTaskRequest(execution!.executionId);

      // Report negative conclusion
      const result = executor.reportStepCompleted(execution!.executionId, req1!.nodeId, true, {
        summary: 'failed audit',
        data: { conclusion: 'negative' },
      });
      expect(result.next).toBe('loop');

      // Node should be reset to pending
      const status = executor.getStatus(execution!.executionId);
      expect(status!.nodes[0].loopCount).toBe(1);
    });
  });

  describe('FR-D02: 条件触发', () => {
    it('AC1: evaluates condition and proceeds when met', () => {
      const chainDef: CompletionChainDef = {
        onSuccess: [
          {
            label: 'deploy',
            promptTemplate: 'deploy',
            condition: { field: 'testsPassed', operator: '==', value: true },
          },
        ],
      };

      const output: TaskOutput = { data: { testsPassed: true } };
      const execution = executor.start(chainDef, createMockTask(), output);
      const req = executor.getNextTaskRequest(execution!.executionId);
      expect(req).not.toBeNull();
      expect(req!.label).toBe('deploy');
    });

    it('AC3: skips step when condition not met', () => {
      const chainDef: CompletionChainDef = {
        onSuccess: [
          {
            label: 'deploy',
            promptTemplate: 'deploy',
            condition: { field: 'testsPassed', operator: '==', value: true },
          },
        ],
      };

      const output: TaskOutput = { data: { testsPassed: false } };
      const execution = executor.start(chainDef, createMockTask(), output);
      const req = executor.getNextTaskRequest(execution!.executionId);
      // Should be null since the only step was skipped
      expect(req).toBeNull();
      expect(execution!.nodes[0].status).toBe('skipped');
    });

    it('supports comparison operators', () => {
      const output: TaskOutput = { data: { score: 85 } };

      expect(executor.evaluateCondition({ field: 'score', operator: '>', value: 80 }, output)).toBe(true);
      expect(executor.evaluateCondition({ field: 'score', operator: '<', value: 80 }, output)).toBe(false);
      expect(executor.evaluateCondition({ field: 'score', operator: '>=', value: 85 }, output)).toBe(true);
      expect(executor.evaluateCondition({ field: 'score', operator: '!=', value: 90 }, output)).toBe(true);
    });

    it('supports nested field access', () => {
      const output: TaskOutput = { data: { result: { passed: true } } };
      // Note: evaluateCondition uses dot notation for nested access
      expect(executor.evaluateCondition({ field: 'result.passed', operator: '==', value: true }, output)).toBe(true);
    });
  });

  describe('FR-D03: 失败分支', () => {
    it('AC1: triggers onFailure branch on task failure', () => {
      const chainDef: CompletionChainDef = {
        onSuccess: [
          { label: 'deploy', promptTemplate: 'deploy' },
        ],
        onFailure: [
          { label: 'notify', promptTemplate: 'notify team of failure' },
        ],
      };

      const execution = executor.start(chainDef, createMockTask(), {});
      const req = executor.getNextTaskRequest(execution!.executionId);

      // Report failure
      const result = executor.reportStepCompleted(execution!.executionId, req!.nodeId, false, {
        data: { reason: 'timeout' },
      });
      expect(result.next).toBe('failure_branch');
    });

    it('AC4: marks execution as failed when no onFailure branch', () => {
      const chainDef: CompletionChainDef = {
        onSuccess: [
          { label: 'deploy', promptTemplate: 'deploy' },
        ],
      };

      const execution = executor.start(chainDef, createMockTask(), {});
      const req = executor.getNextTaskRequest(execution!.executionId);

      const result = executor.reportStepCompleted(execution!.executionId, req!.nodeId, false, {});
      expect(result.next).toBe('done');
      expect(executor.getStatus(execution!.executionId)!.status).toBe('failed');
    });
  });

  describe('FR-D04: 链路可视化', () => {
    it('AC1: getStatus shows node statuses', () => {
      const chainDef: CompletionChainDef = {
        onSuccess: [
          { label: 'step1', promptTemplate: 'do 1' },
          { label: 'step2', promptTemplate: 'do 2' },
        ],
      };

      const execution = executor.start(chainDef, createMockTask(), {});
      const status = executor.getStatus(execution!.executionId);

      expect(status!.nodes[0].label).toBe('step1');
      expect(status!.nodes[0].status).toBe('pending');
      expect(status!.nodes[1].label).toBe('step2');
      expect(status!.nodes[1].status).toBe('pending');
    });

    it('AC3: getCompletedExecutions returns finished chains', () => {
      const chainDef: CompletionChainDef = {
        onSuccess: [{ label: 'step1', promptTemplate: 'do 1' }],
      };

      const execution = executor.start(chainDef, createMockTask(), {});
      const req = executor.getNextTaskRequest(execution!.executionId);
      executor.reportStepCompleted(execution!.executionId, req!.nodeId, true, {});
      // Trigger done
      executor.getNextTaskRequest(execution!.executionId);

      const completed = executor.getCompletedExecutions();
      expect(completed).toHaveLength(1);
      expect(completed[0].status).toBe('succeeded');
    });
  });

  describe('Pause/Resume', () => {
    it('pauses and resumes execution', () => {
      const chainDef: CompletionChainDef = {
        onSuccess: [
          { label: 'step1', promptTemplate: 'do 1' },
          { label: 'step2', promptTemplate: 'do 2' },
        ],
      };

      const execution = executor.start(chainDef, createMockTask(), {});

      // Pause
      const paused = executor.pause(execution!.executionId);
      expect(paused).toBe(true);
      expect(executor.getStatus(execution!.executionId)!.status).toBe('paused');

      // Can't get next task while paused
      const req = executor.getNextTaskRequest(execution!.executionId);
      expect(req).toBeNull();

      // Resume
      const resumed = executor.resume(execution!.executionId);
      expect(resumed).toBe(true);
      expect(executor.getStatus(execution!.executionId)!.status).toBe('running');

      // Now can get next task
      const req2 = executor.getNextTaskRequest(execution!.executionId);
      expect(req2).not.toBeNull();
    });
  });
});
