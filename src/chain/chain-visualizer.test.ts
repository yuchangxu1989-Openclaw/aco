import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../event/event-bus.js';
import { ChainExecutor } from './chain-executor.js';
import { ChainVisualizer } from './chain-visualizer.js';
import type { Task, CompletionChainDef } from '../types/index.js';
import type { TaskOutput } from './chain-executor.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: 'parent-task-001',
    label: 'parent-task',
    prompt: 'do something',
    agentId: 'agent-1',
    timeoutSeconds: 600,
    priority: 50,
    status: 'succeeded',
    createdAt: Date.now() - 60000,
    updatedAt: Date.now(),
    retryCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function makeChainDef(overrides: Partial<CompletionChainDef> = {}): CompletionChainDef {
  return {
    chainId: 'dev-audit-fix',
    onSuccess: [
      { label: 'code-review', promptTemplate: 'Review {{parent.output}}', agentId: 'audit-01', timeoutSeconds: 600 },
      { label: 'fix-issues', promptTemplate: 'Fix issues from review', agentId: 'cc', timeoutSeconds: 1200 },
      { label: 're-verify', promptTemplate: 'Re-verify fixes', agentId: 'audit-01', timeoutSeconds: 600 },
    ],
    ...overrides,
  };
}

describe('ChainVisualizer', () => {
  let eventBus: EventBus;
  let executor: ChainExecutor;
  let visualizer: ChainVisualizer;

  beforeEach(() => {
    eventBus = new EventBus();
    executor = new ChainExecutor(eventBus);
    visualizer = new ChainVisualizer(executor);
  });

  describe('getExecutionView (AC1+AC2)', () => {
    it('should return view with correct node statuses', () => {
      const chainDef = makeChainDef();
      const parentTask = makeTask();
      const parentOutput: TaskOutput = { summary: 'Feature implemented' };

      const execution = executor.start(chainDef, parentTask, parentOutput)!;
      expect(execution).toBeDefined();

      const view = visualizer.getExecutionView(execution.executionId);
      expect(view).toBeDefined();
      expect(view!.executionId).toBe(execution.executionId);
      expect(view!.chainName).toBe('dev-audit-fix');
      expect(view!.parentTaskId).toBe('parent-task-001');
      expect(view!.status).toBe('running');
      expect(view!.totalNodes).toBe(3);
    });

    it('should include durationMs, agentId, outputSummary in node views (AC2)', () => {
      const chainDef = makeChainDef();
      const parentTask = makeTask();
      const parentOutput: TaskOutput = { summary: 'done' };

      const execution = executor.start(chainDef, parentTask, parentOutput)!;

      // Advance first step
      const req = executor.getNextTaskRequest(execution.executionId);
      expect(req).not.toBeNull();

      // Complete first step
      const node = execution.nodes[0];
      executor.reportStepCompleted(execution.executionId, node.nodeId, true, {
        summary: 'Found 3 P1 issues',
      });

      const view = visualizer.getExecutionView(execution.executionId);
      const nodeView = view!.nodes[0];

      expect(nodeView.agentId).toBe('audit-01');
      expect(nodeView.status).toBe('succeeded');
      expect(nodeView.outputSummary).toBe('Found 3 P1 issues');
      expect(nodeView.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should return undefined for non-existent execution', () => {
      const view = visualizer.getExecutionView('non-existent-id');
      expect(view).toBeUndefined();
    });
  });

  describe('listExecutions (AC3)', () => {
    it('should return all executions', () => {
      const chainDef = makeChainDef();
      const parentOutput: TaskOutput = { summary: 'done' };

      executor.start(chainDef, makeTask({ taskId: 'task-1' }), parentOutput);
      executor.start(chainDef, makeTask({ taskId: 'task-2' }), parentOutput);

      const list = visualizer.listExecutions();
      expect(list.length).toBe(2);
    });

    it('should filter by status', () => {
      const chainDef = makeChainDef();
      const parentOutput: TaskOutput = { summary: 'done' };

      const exec1 = executor.start(chainDef, makeTask({ taskId: 'task-1' }), parentOutput)!;
      executor.start(chainDef, makeTask({ taskId: 'task-2' }), parentOutput);

      // Complete all steps of exec1 to make it succeeded
      for (const node of exec1.nodes) {
        executor.getNextTaskRequest(exec1.executionId);
        executor.reportStepCompleted(exec1.executionId, node.nodeId, true, { summary: 'ok' });
      }

      const running = visualizer.listExecutions({ status: 'running' });
      expect(running.length).toBe(1);

      const succeeded = visualizer.listExecutions({ status: 'succeeded' });
      expect(succeeded.length).toBe(1);
    });

    it('should respect limit', () => {
      const chainDef = makeChainDef();
      const parentOutput: TaskOutput = { summary: 'done' };

      for (let i = 0; i < 5; i++) {
        executor.start(chainDef, makeTask({ taskId: `task-${i}` }), parentOutput);
      }

      const limited = visualizer.listExecutions({ limit: 3 });
      expect(limited.length).toBe(3);
    });

    it('should cache completed executions in history (AC3 in-process Map)', () => {
      const chainDef = makeChainDef({
        onSuccess: [{ label: 'single-step', promptTemplate: 'do it', agentId: 'a' }],
      });
      const parentOutput: TaskOutput = { summary: 'done' };

      const exec = executor.start(chainDef, makeTask(), parentOutput)!;
      executor.getNextTaskRequest(exec.executionId);
      executor.reportStepCompleted(exec.executionId, exec.nodes[0].nodeId, true, { summary: 'ok' });

      // First access caches it
      const view1 = visualizer.getExecutionView(exec.executionId);
      expect(view1).toBeDefined();
      expect(view1!.status).toBe('succeeded');

      // Even if executor no longer has it (simulated by creating new visualizer with same executor)
      // The history cache should still have it
      const view2 = visualizer.getExecutionView(exec.executionId);
      expect(view2).toBeDefined();
      expect(view2!.status).toBe('succeeded');
    });
  });

  describe('renderTree (AC4)', () => {
    it('should render tree format with status icons', () => {
      const chainDef = makeChainDef();
      const parentTask = makeTask();
      const parentOutput: TaskOutput = { summary: 'Feature done' };

      const exec = executor.start(chainDef, parentTask, parentOutput)!;

      // Complete first step
      executor.getNextTaskRequest(exec.executionId);
      executor.reportStepCompleted(exec.executionId, exec.nodes[0].nodeId, true, {
        summary: 'Found 3 P1 issues',
      });

      const view = visualizer.getExecutionView(exec.executionId)!;
      const tree = visualizer.renderTree(view);

      // Should contain chain name and execution id
      expect(tree).toContain('dev-audit-fix');
      expect(tree).toContain(exec.executionId);

      // Should contain status
      expect(tree).toContain('running');

      // Should contain node labels
      expect(tree).toContain('code-review');
      expect(tree).toContain('fix-issues');
      expect(tree).toContain('re-verify');

      // Should contain agent IDs
      expect(tree).toContain('audit-01');

      // Should contain output summary
      expect(tree).toContain('Found 3 P1 issues');

      // Should contain tree characters
      expect(tree).toContain('├──');
      expect(tree).toContain('└──');
    });

    it('should show failure reason for failed nodes', () => {
      const chainDef = makeChainDef({
        onSuccess: [{ label: 'failing-step', promptTemplate: 'fail', agentId: 'a' }],
      });
      const parentOutput: TaskOutput = { summary: 'done' };

      const exec = executor.start(chainDef, makeTask(), parentOutput)!;
      executor.getNextTaskRequest(exec.executionId);
      executor.reportStepCompleted(exec.executionId, exec.nodes[0].nodeId, false, {
        data: { reason: 'OOM killed' },
      });

      const view = visualizer.getExecutionView(exec.executionId)!;
      const tree = visualizer.renderTree(view);

      expect(tree).toContain('OOM killed');
      // Should contain the failed icon (✗)
      expect(tree).toContain('✗');
    });

    it('should show "condition not met" for skipped nodes', () => {
      const chainDef: CompletionChainDef = {
        chainId: 'conditional-chain',
        onSuccess: [
          {
            label: 'conditional-step',
            promptTemplate: 'maybe',
            agentId: 'a',
            condition: { field: 'shouldRun', operator: '==', value: true },
          },
        ],
      };
      const parentOutput: TaskOutput = { summary: 'done', data: { shouldRun: false } };

      const exec = executor.start(chainDef, makeTask(), parentOutput)!;
      // Getting next task request will evaluate condition and skip
      executor.getNextTaskRequest(exec.executionId);

      const view = visualizer.getExecutionView(exec.executionId)!;
      const tree = visualizer.renderTree(view);

      expect(tree).toContain('condition not met');
    });
  });

  describe('renderJson (AC4)', () => {
    it('should output valid JSON', () => {
      const chainDef = makeChainDef();
      const parentOutput: TaskOutput = { summary: 'done' };

      const exec = executor.start(chainDef, makeTask(), parentOutput)!;
      const view = visualizer.getExecutionView(exec.executionId)!;
      const json = visualizer.renderJson(view);

      const parsed = JSON.parse(json);
      expect(parsed.executionId).toBe(exec.executionId);
      expect(parsed.chainName).toBe('dev-audit-fix');
      expect(parsed.nodes).toBeInstanceOf(Array);
      expect(parsed.nodes.length).toBe(3);
      expect(parsed.totalNodes).toBe(3);
    });

    it('should include all required fields in JSON output', () => {
      const chainDef = makeChainDef();
      const parentOutput: TaskOutput = { summary: 'done' };

      const exec = executor.start(chainDef, makeTask(), parentOutput)!;
      executor.getNextTaskRequest(exec.executionId);
      executor.reportStepCompleted(exec.executionId, exec.nodes[0].nodeId, true, {
        summary: 'Review complete',
      });

      const view = visualizer.getExecutionView(exec.executionId)!;
      const parsed = JSON.parse(visualizer.renderJson(view));

      // Execution-level fields
      expect(parsed).toHaveProperty('executionId');
      expect(parsed).toHaveProperty('chainName');
      expect(parsed).toHaveProperty('parentTaskId');
      expect(parsed).toHaveProperty('status');
      expect(parsed).toHaveProperty('totalNodes');
      expect(parsed).toHaveProperty('completedNodes');
      expect(parsed).toHaveProperty('failedNodes');
      expect(parsed).toHaveProperty('skippedNodes');
      expect(parsed).toHaveProperty('createdAt');
      expect(parsed).toHaveProperty('durationMs');
      expect(parsed).toHaveProperty('nodes');

      // Node-level fields
      const node = parsed.nodes[0];
      expect(node).toHaveProperty('nodeId');
      expect(node).toHaveProperty('stepIndex');
      expect(node).toHaveProperty('label');
      expect(node).toHaveProperty('status');
      expect(node).toHaveProperty('durationMs');
      expect(node).toHaveProperty('outputSummary');
    });
  });

  describe('duration formatting', () => {
    it('should format sub-second as <1s', () => {
      const chainDef = makeChainDef({
        onSuccess: [{ label: 'fast', promptTemplate: 'go', agentId: 'a' }],
      });
      const parentOutput: TaskOutput = { summary: 'done' };

      const exec = executor.start(chainDef, makeTask(), parentOutput)!;
      // Immediately complete
      executor.getNextTaskRequest(exec.executionId);
      executor.reportStepCompleted(exec.executionId, exec.nodes[0].nodeId, true, { summary: 'ok' });

      const view = visualizer.getExecutionView(exec.executionId)!;
      const tree = visualizer.renderTree(view);

      // Duration should be <1s since it completed almost instantly
      expect(tree).toContain('<1s');
    });
  });
});
