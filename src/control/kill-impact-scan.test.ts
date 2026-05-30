/**
 * Tests for FR-K04 kill impact scan.
 */

import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildKillImpactDisabledReport,
  buildKillImpactFailedReport,
  classifyKillImpactRisk,
  DEFAULT_KILL_IMPACT_SCAN_CONFIG,
  normalizeKillImpactScanConfig,
  persistKillImpactReport,
  recommendedActionForRisk,
  scanKillImpactAfterKill,
  takeKillImpactSnapshot,
  validateKillImpactScanConfig,
} from './kill-impact-scan.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('kill impact scan (FR-K04)', () => {
  let dir: string;
  let logs: string;
  let boardPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aco-kill-impact-'));
    logs = join(dir, 'logs');
    boardPath = join(logs, 'subagent-task-board.json');
    mkdirSync(logs, { recursive: true });
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'product-requirements.md'), 'base\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'init']);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('snapshots git status with sha256 hash and scans affected files after kill (AC1/AC3/AC7)', () => {
    const startedAt = Date.now() - 1000;
    writeFileSync(boardPath, JSON.stringify({ tasks: [{ sessionKey: 'sess-1', taskId: 'task-1', label: 'spec write', status: 'running', startedAt, updatedAt: startedAt + 10 }] }));
    writeFileSync(join(dir, 'docs', 'product-requirements.md'), 'changed\n');

    const snapshot = takeKillImpactSnapshot('sess-1', { repoRoot: dir, boardPath, outputDir: logs });
    expect(snapshot.files[0].hash).toMatch(/^[a-f0-9]{32}$/);

    const report = scanKillImpactAfterKill('sess-1', snapshot, { repoRoot: dir, boardPath, outputDir: logs }, Date.now());
    expect(report.affectedFiles).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'docs/product-requirements.md', status: 'modified' })]));
    expect(report.riskLevel).toBe('high');
    expect(report.recommendedAction).toBe('consider_stash_first');

    persistKillImpactReport(report, { repoRoot: dir, boardPath, outputDir: logs });
    const line = readFileSync(join(logs, 'aco-kill-impact.jsonl'), 'utf-8').trim();
    expect(JSON.parse(line).sessionKey).toBe('sess-1');
  });

  it('detects reverted files using snapshot mtime and size (AC3)', () => {
    const startedAt = Date.now() - 1000;
    writeFileSync(boardPath, JSON.stringify({ tasks: [{ sessionKey: 'sess-1', label: 'spec write', status: 'running', startedAt, updatedAt: startedAt + 10 }] }));
    writeFileSync(join(dir, 'docs', 'product-requirements.md'), 'changed\n');
    const snapshot = takeKillImpactSnapshot('sess-1', { repoRoot: dir, boardPath, outputDir: logs });
    const originalMtime = snapshot.files[0].mtime;
    const originalSize = snapshot.files[0].sizeBytes;
    git(dir, ['checkout', 'HEAD', '--', 'docs/product-requirements.md']);

    const report = scanKillImpactAfterKill('sess-1', snapshot, { repoRoot: dir, boardPath, outputDir: logs }, Date.now());
    expect(report.affectedFiles[0]).toEqual(expect.objectContaining({
      path: 'docs/product-requirements.md',
      status: 'reverted',
      mtime: originalMtime,
      sizeBytes: originalSize,
    }));
  });

  it('detects deleted tracked files and surfaces them in affectedFiles', () => {
    const startedAt = Date.now() - 1000;
    writeFileSync(boardPath, JSON.stringify({ tasks: [{ sessionKey: 'sess-1', taskId: 'task-1', label: 'delete docs', status: 'running', startedAt, updatedAt: startedAt + 10 }] }));
    writeFileSync(join(dir, 'docs', 'delete-me.md'), 'delete me\n');
    git(dir, ['add', 'docs/delete-me.md']);
    git(dir, ['commit', '-m', 'add delete target']);
    unlinkSync(join(dir, 'docs', 'delete-me.md'));

    const snapshot = takeKillImpactSnapshot('sess-1', { repoRoot: dir, boardPath, outputDir: logs }, startedAt + 20);
    const report = scanKillImpactAfterKill('sess-1', snapshot, { repoRoot: dir, boardPath, outputDir: logs }, Date.now());

    expect(report.affectedFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'docs/delete-me.md', status: 'deleted' }),
    ]));
    expect(report.riskLevel).toBe('high');
    expect(report.recommendedAction).toBe('consider_stash_first');
  });

  it('detects nested deleted tracked files without mtime filtering', () => {
    const startedAt = Date.now() + 60_000;
    mkdirSync(join(dir, 'docs', 'nested'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'nested', 'delete-me.md'), 'delete me\n');
    git(dir, ['add', 'docs/nested/delete-me.md']);
    git(dir, ['commit', '-m', 'add nested delete target']);
    writeFileSync(boardPath, JSON.stringify({ tasks: [{ sessionKey: 'sess-1', taskId: 'task-1', label: 'delete nested docs', status: 'running', startedAt, updatedAt: startedAt }] }));
    unlinkSync(join(dir, 'docs', 'nested', 'delete-me.md'));

    const snapshot = takeKillImpactSnapshot('sess-1', { repoRoot: dir, boardPath, outputDir: logs }, startedAt + 10);
    const report = scanKillImpactAfterKill('sess-1', snapshot, { repoRoot: dir, boardPath, outputDir: logs }, startedAt + 20);

    expect(report.affectedFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'docs/nested/delete-me.md', status: 'deleted' }),
    ]));
    expect(report.riskLevel).toBe('high');
  });

  it('collects affected board entries without writtenBy dependency (AC4)', () => {
    const startedAt = Date.now() - 1000;
    const killAt = startedAt + 500;
    writeFileSync(boardPath, JSON.stringify({ tasks: [
      { sessionKey: 'sess-1', taskId: 'task-1', label: 'target', status: 'killed', startedAt, updatedAt: startedAt + 100 },
      { sessionKey: 'other', taskId: 'task-2', label: 'other', status: 'running', startedAt, updatedAt: startedAt + 100 },
    ] }));
    const snapshot = takeKillImpactSnapshot('sess-1', { repoRoot: dir, boardPath, outputDir: logs }, startedAt + 10);
    const report = scanKillImpactAfterKill('sess-1', snapshot, { repoRoot: dir, boardPath, outputDir: logs }, killAt);
    expect(report.affectedBoardEntries).toEqual([expect.objectContaining({ taskId: 'task-1', label: 'target', status: 'killed' })]);
  });

  it('classifies riskLevel with six deterministic MECE rules (AC5)', () => {
    const cfg = DEFAULT_KILL_IMPACT_SCAN_CONFIG;
    expect(classifyKillImpactRisk([], [], cfg)).toBe('low');
    expect(classifyKillImpactRisk([], [{ taskId: 't', label: 'l', status: 'done', lastWriteAt: 1 }], cfg)).toBe('low');
    expect(classifyKillImpactRisk([{ path: 'docs/product-requirements.md' }], [], cfg)).toBe('high');
    expect(classifyKillImpactRisk([{ path: 'reports/a.md' }, { path: 'logs/a.log' }], [], cfg)).toBe('medium');
    expect(classifyKillImpactRisk([{ path: 'scripts/a.sh' }], [], cfg)).toBe('medium');
    expect(classifyKillImpactRisk([{ path: 'reports/a.md' }, { path: 'Makefile' }], [], cfg)).toBe('medium');
    expect(classifyKillImpactRisk([{ path: 'reports/a.md' }, { path: 'src/index.ts' }], [], cfg)).toBe('high');
  });

  it('maps recommendedAction strictly from riskLevel (AC6)', () => {
    expect(recommendedActionForRisk('low')).toBe('safe_to_proceed');
    expect(recommendedActionForRisk('medium')).toBe('review_diff');
    expect(recommendedActionForRisk('high')).toBe('consider_stash_first');
  });

  it('filters files older than task.startedAt (AC11 l)', () => {
    writeFileSync(join(dir, 'old.txt'), 'old');
    const startedAt = Date.now() + 60_000;
    writeFileSync(boardPath, JSON.stringify({ tasks: [{ sessionKey: 'sess-1', label: 'future', status: 'running', startedAt, updatedAt: startedAt }] }));
    const snapshot = takeKillImpactSnapshot('sess-1', { repoRoot: dir, boardPath, outputDir: logs });
    const report = scanKillImpactAfterKill('sess-1', snapshot, { repoRoot: dir, boardPath, outputDir: logs }, startedAt + 1000);
    expect(report.affectedFiles).toEqual([]);
    expect(report.riskLevel).toBe('low');
  });

  it('uses disabled and failed reports for runtime degradation (AC8/AC9)', () => {
    expect(buildKillImpactDisabledReport('sess-1', 123)).toEqual({ sessionKey: 'sess-1', killAt: 123, scanDisabled: true });
    const failed = buildKillImpactFailedReport('sess-1', new Error('x'.repeat(300)), 456);
    expect(failed.scanFailed).toBe(true);
    expect(failed.errorMessage.length).toBe(256);
  });

  it('normalizes invalid runtime config to safe defaults', () => {
    const cfg = normalizeKillImpactScanConfig({ maxFileScan: -1, highRiskPathPrefixes: ['docs/'] });
    expect(cfg.maxFileScan).toBe(DEFAULT_KILL_IMPACT_SCAN_CONFIG.maxFileScan);
    expect(cfg.highRiskPathPrefixes).toEqual(['docs/']);
  });

  it('validates seven illegal config classes for startup schema (AC9)', () => {
    expect(validateKillImpactScanConfig({ enabled: 'yes' })).toContain('killImpactScan.enabled must be a boolean');
    expect(validateKillImpactScanConfig({ outputDir: '' })).toContain('killImpactScan.outputDir must be a non-empty string');
    expect(validateKillImpactScanConfig({ outputDir: join(dir, 'missing') })).toContain('killImpactScan.outputDir must be an existing directory');
    expect(validateKillImpactScanConfig({ repoRoot: '' })).toContain('killImpactScan.repoRoot must be a non-empty string');
    expect(validateKillImpactScanConfig({ repoRoot: join(dir, 'missing') })).toContain('killImpactScan.repoRoot must be an existing directory');
    expect(validateKillImpactScanConfig({ boardPath: '' })).toContain('killImpactScan.boardPath must be a non-empty string');
    expect(validateKillImpactScanConfig({ highRiskPathPrefixes: ['docs/', ''] })).toContain('killImpactScan.highRiskPathPrefixes must be an array of non-empty strings');
    expect(validateKillImpactScanConfig({ mediumRiskPathPrefixes: 'logs/' })).toContain('killImpactScan.mediumRiskPathPrefixes must be an array of non-empty strings');
    expect(validateKillImpactScanConfig({ maxFileScan: 0 })).toContain('killImpactScan.maxFileScan must be a positive integer');
    expect(validateKillImpactScanConfig({ maxBoardScanBytes: 1.5 })).toContain('killImpactScan.maxBoardScanBytes must be a positive integer');
  });

  it('returns normal report when board file is missing (AC11 f)', () => {
    rmSync(boardPath, { force: true });
    writeFileSync(join(dir, 'reports.md'), 'x');
    const snapshot = takeKillImpactSnapshot('sess-unknown', { repoRoot: dir, boardPath, outputDir: logs });
    const report = scanKillImpactAfterKill('sess-unknown', snapshot, { repoRoot: dir, boardPath, outputDir: logs });
    expect(report.affectedBoardEntries).toEqual([]);
    expect('scanFailed' in report).toBe(false);
  });

  it('writes aco-kill-impact.jsonl under outputDir', () => {
    const report = buildKillImpactDisabledReport('sess-1');
    persistKillImpactReport(report, { repoRoot: dir, boardPath, outputDir: logs });
    expect(existsSync(join(logs, 'aco-kill-impact.jsonl'))).toBe(true);
  });
});
