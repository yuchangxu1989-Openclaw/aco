/**
 * Tests for config schema additions.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig } from './config-schema.js';

describe('validateConfig killImpactScan (FR-K04 AC9)', () => {
  it('accepts a valid killImpactScan config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aco-config-'));
    try {
      expect(validateConfig({ killImpactScan: { outputDir: dir, repoRoot: dir, boardPath: '/tmp/board.json', highRiskPathPrefixes: ['src/'], mediumRiskPathPrefixes: ['logs/'], maxFileScan: 1, maxBoardScanBytes: 1 } })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects seven illegal value classes', () => {
    const missing = join(tmpdir(), 'aco-missing-dir-for-test');
    expect(validateConfig({ killImpactScan: { enabled: 'true' } }).map(e => e.path)).toContain('killImpactScan.enabled');
    expect(validateConfig({ killImpactScan: { outputDir: '' } }).map(e => e.path)).toContain('killImpactScan.outputDir');
    expect(validateConfig({ killImpactScan: { outputDir: missing } }).map(e => e.path)).toContain('killImpactScan.outputDir');
    expect(validateConfig({ killImpactScan: { repoRoot: '' } }).map(e => e.path)).toContain('killImpactScan.repoRoot');
    expect(validateConfig({ killImpactScan: { repoRoot: missing } }).map(e => e.path)).toContain('killImpactScan.repoRoot');
    expect(validateConfig({ killImpactScan: { boardPath: '' } }).map(e => e.path)).toContain('killImpactScan.boardPath');
    expect(validateConfig({ killImpactScan: { highRiskPathPrefixes: ['docs/', ''] } }).map(e => e.path)).toContain('killImpactScan.highRiskPathPrefixes');
    expect(validateConfig({ killImpactScan: { mediumRiskPathPrefixes: 'logs/' } }).map(e => e.path)).toContain('killImpactScan.mediumRiskPathPrefixes');
    expect(validateConfig({ killImpactScan: { maxFileScan: 0 } }).map(e => e.path)).toContain('killImpactScan.maxFileScan');
    expect(validateConfig({ killImpactScan: { maxBoardScanBytes: Number.NaN } }).map(e => e.path)).toContain('killImpactScan.maxBoardScanBytes');
  });
});
