/**
 * CLI 命令集成测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { main } from '../src/cli/cli.js';

describe('CLI main', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('shows help with no args', async () => {
    const code = await main([]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ACO — Agent Controlled Orchestration'));
  });

  it('shows help with --help', async () => {
    const code = await main(['--help']);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Commands:'));
  });

  it('returns error for unknown command', async () => {
    const code = await main(['unknown']);
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown command'));
  });

  it('chain --help shows chain help', async () => {
    const code = await main(['chain', '--help']);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('任务链管理'));
  });

  it('audit --help shows audit help', async () => {
    const code = await main(['audit', '--help']);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('决策溯源查询'));
  });

  it('notify --help shows notify help', async () => {
    const code = await main(['notify', '--help']);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('通知管理'));
  });

  it('stats --help shows stats help', async () => {
    const code = await main(['stats', '--help']);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('资源利用率统计'));
  });

  it('health --help shows health help', async () => {
    const code = await main(['health', '--help']);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('健康检查'));
  });

  it('config --help shows config help', async () => {
    const code = await main(['config', '--help']);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('配置管理'));
  });
});

describe('CLI health command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('runs health check without error', async () => {
    const code = await main(['health']);
    // Should not crash; may return 0 (ok/warn) since no config file in test dir
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ACO Health Check'));
  });

  it('supports --json output', async () => {
    const code = await main(['health', '--json']);
    expect(code).toBe(0);
    const output = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('checks');
    expect(parsed).toHaveProperty('overall');
  });
});

describe('CLI stats command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('runs stats without error', async () => {
    const code = await main(['stats']);
    // Should not crash; may show "No agent activity" or "Resource Utilization" depending on data
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalled();
  });

  it('supports --json output', async () => {
    const code = await main(['stats', '--json']);
    expect(code).toBe(0);
    const output = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('period');
    expect(parsed).toHaveProperty('totalTasks');
  });

  it('rejects invalid period', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await main(['stats', '--period', 'invalid']);
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid period'));
    errorSpy.mockRestore();
  });
});

describe('CLI audit command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('shows no entries message for nonexistent task', async () => {
    const code = await main(['audit', 'nonexistent-task']);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No audit entries'));
  });
});

describe('CLI config command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('config show works without config file', async () => {
    const code = await main(['config', 'show']);
    expect(code).toBe(0);
  });

  it('config validate works without config file', async () => {
    const code = await main(['config', 'validate']);
    expect(code).toBe(0);
  });

  it('config generate outputs template', async () => {
    const code = await main(['config', 'generate']);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalled();
  });
});

describe('CLI chain command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('chain list works with no chains', async () => {
    const code = await main(['chain', 'list']);
    expect(code).toBe(0);
  });
});
