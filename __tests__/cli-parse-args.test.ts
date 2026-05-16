/**
 * CLI 子命令测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseArgs, hasFlag, getFlagValue } from '../src/cli/parse-args.js';

describe('parseArgs', () => {
  it('parses command and positional args', () => {
    const result = parseArgs(['chain', 'list']);
    expect(result.command).toBe('chain');
    expect(result.args).toEqual(['list']);
  });

  it('parses flags with values', () => {
    const result = parseArgs(['stats', '--period', '7d', '--json']);
    expect(result.command).toBe('stats');
    expect(result.flags.period).toBe('7d');
    expect(result.flags.json).toBe(true);
  });

  it('returns undefined command for empty argv', () => {
    const result = parseArgs([]);
    expect(result.command).toBeUndefined();
    expect(result.args).toEqual([]);
  });
});

describe('hasFlag', () => {
  it('detects flag presence', () => {
    expect(hasFlag(['--json', '--help'], 'json')).toBe(true);
    expect(hasFlag(['--json'], 'help')).toBe(false);
  });
});

describe('getFlagValue', () => {
  it('gets flag value', () => {
    expect(getFlagValue(['--period', '7d', '--json'], 'period')).toBe('7d');
  });

  it('returns undefined for missing flag', () => {
    expect(getFlagValue(['--json'], 'period')).toBeUndefined();
  });

  it('returns undefined when next arg is a flag', () => {
    expect(getFlagValue(['--period', '--json'], 'period')).toBeUndefined();
  });
});
