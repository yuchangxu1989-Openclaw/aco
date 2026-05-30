/**
 * Tests for Closure Guard Plugin Generator — FR-F06 AC13-AC15
 */

import { describe, it, expect } from 'vitest';
import { generateClosureGuardPlugin } from './closure-guard-plugin.js';
import type { ClosureGuardPluginOptions } from './closure-guard-plugin.js';

describe('generateClosureGuardPlugin', () => {
  const defaultOutput = generateClosureGuardPlugin();

  // --- AC13: ESM export default with three hooks ---

  describe('AC13: ESM export default with three hooks', () => {
    it('generates valid ESM export default structure', () => {
      expect(defaultOutput).toContain('export default {');
      expect(defaultOutput).toContain('name:');
      expect(defaultOutput).toContain('version:');
      expect(defaultOutput).toContain('register(api)');
    });

    it('registers subagent_ended hook', () => {
      expect(defaultOutput).toContain("api.on('subagent_ended'");
    });

    it('registers before_prompt_build hook', () => {
      expect(defaultOutput).toContain("api.on(\n      'before_prompt_build'");
    });

    it('registers message_sending hook', () => {
      expect(defaultOutput).toContain("api.on(\n      'message_sending'");
    });

    it('also registers subagent_spawned for correlation', () => {
      expect(defaultOutput).toContain("api.on('subagent_spawned'");
    });
  });

  // --- AC14: Post-reminder auto-close (15s default) ---

  describe('AC14: post-reminder auto-close', () => {
    it('includes post_reminder_auto_close logic', () => {
      expect(defaultOutput).toContain('post_reminder_auto_close');
    });

    it('uses 15s (15000ms) as default auto-close delay', () => {
      expect(defaultOutput).toContain('autoCloseDelayMs');
      expect(defaultOutput).toContain('15000');
    });

    it('sets auto-close timer after marking as reminded', () => {
      // The logic: entry.reminded = true → clearTimeout → setTimeout(autoCloseDelayMs)
      expect(defaultOutput).toContain('entry.reminded = true');
      expect(defaultOutput).toContain('const autoCloseTimer = setTimeout');
    });

    it('respects custom autoCloseDelayMs option', () => {
      const custom = generateClosureGuardPlugin({ autoCloseDelayMs: 30000 });
      expect(custom).toContain('30000');
    });
  });

  // --- AC15: before_prompt_build clears already-reminded pending closures ---

  describe('AC15: before_prompt_build clears reminded closures', () => {
    it('clears reminded closures at the start of before_prompt_build', () => {
      // The Phase 1 comment and logic should appear before Phase 2
      const phase1Idx = defaultOutput.indexOf('Phase 1');
      const phase2Idx = defaultOutput.indexOf('Phase 2');
      expect(phase1Idx).toBeGreaterThan(-1);
      expect(phase2Idx).toBeGreaterThan(-1);
      expect(phase1Idx).toBeLessThan(phase2Idx);
    });

    it('uses next_turn_detection method for cleared closures', () => {
      expect(defaultOutput).toContain('next_turn_detection');
    });

    it('deletes reminded closures from pendingClosures map', () => {
      // Check the pattern: if (data.reminded) { ... pendingClosures.delete(closureId) }
      const remindedBlock = defaultOutput.indexOf('if (data.reminded)');
      expect(remindedBlock).toBeGreaterThan(-1);
      const deleteAfterReminded = defaultOutput.indexOf('pendingClosures.delete(closureId)', remindedBlock);
      expect(deleteAfterReminded).toBeGreaterThan(-1);
    });
  });

  // --- Audit logging ---

  describe('audit logging', () => {
    it('includes appendAuditLog function', () => {
      expect(defaultOutput).toContain('function appendAuditLog');
    });

    it('logs completion_registered events', () => {
      expect(defaultOutput).toContain("event: 'completion_registered'");
    });

    it('logs closure_detected events', () => {
      expect(defaultOutput).toContain("event: 'closure_detected'");
    });

    it('logs closure_missed events', () => {
      expect(defaultOutput).toContain("event: 'closure_missed'");
    });

    it('logs reminder_injected events', () => {
      expect(defaultOutput).toContain("event: 'reminder_injected'");
    });
  });

  // --- Configuration options ---

  describe('configuration options', () => {
    it('uses default plugin name aco-closure-guard', () => {
      expect(defaultOutput).toContain('"aco-closure-guard"');
    });

    it('uses default closure timeout of 120000ms', () => {
      expect(defaultOutput).toContain('120000');
    });

    it('respects custom pluginName', () => {
      const custom = generateClosureGuardPlugin({ pluginName: 'my-guard' });
      expect(custom).toContain('"my-guard"');
    });

    it('respects custom closureTimeoutMs', () => {
      const custom = generateClosureGuardPlugin({ closureTimeoutMs: 60000 });
      expect(custom).toContain('60000');
    });

    it('respects custom excludeLabels', () => {
      const custom = generateClosureGuardPlugin({ excludeLabels: ['test-', '/^ci-/'] });
      expect(custom).toContain('"test-"');
      expect(custom).toContain('"/^ci-/"');
    });

    it('respects custom auditLogPath', () => {
      const custom = generateClosureGuardPlugin({ auditLogPath: '/tmp/my-audit.jsonl' });
      expect(custom).toContain('/tmp/my-audit.jsonl');
    });

    it('respects custom pluginVersion', () => {
      const custom = generateClosureGuardPlugin({ pluginVersion: '2.0.0' });
      expect(custom).toContain('"2.0.0"');
    });
  });

  // --- Structural correctness ---

  describe('structural correctness', () => {
    it('imports fs and path', () => {
      expect(defaultOutput).toContain("import fs from 'node:fs'");
      expect(defaultOutput).toContain("import path from 'node:path'");
    });

    it('includes shouldExclude helper with regex support', () => {
      expect(defaultOutput).toContain('function shouldExclude');
      expect(defaultOutput).toContain('new RegExp');
    });

    it('includes formatDuration helper', () => {
      expect(defaultOutput).toContain('function formatDuration');
    });

    it('includes extractAgentId helper', () => {
      expect(defaultOutput).toContain('function extractAgentId');
    });

    it('sets priority 980 for before_prompt_build', () => {
      expect(defaultOutput).toContain('{ priority: 980 }');
    });

    it('sets priority 900 for message_sending', () => {
      expect(defaultOutput).toContain('{ priority: 900 }');
    });

    it('prevents timer from keeping process alive with unref', () => {
      expect(defaultOutput).toContain('timer.unref');
    });

    it('prunes spawned sessions to prevent unbounded growth', () => {
      expect(defaultOutput).toContain('spawnedSessions.size > 200');
    });
  });
});
