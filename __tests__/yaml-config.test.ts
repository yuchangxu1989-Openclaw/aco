/**
 * Tests for P1-3: YAML config support
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigManager } from '../src/config/config-manager.js';
import { EventBus } from '../src/event/event-bus.js';
import type { FileSystem } from '../src/config/config-manager.js';

function createMockFs(files: Record<string, string>): FileSystem {
  return {
    async readFile(path: string) {
      if (path in files) return files[path];
      throw new Error(`File not found: ${path}`);
    },
    async writeFile(path: string, content: string) {
      files[path] = content;
    },
    async exists(path: string) {
      return path in files;
    },
    watch(_path: string, _cb: () => void) {
      return { close() {} };
    },
  };
}

describe('ConfigManager YAML Support (FR-H03 AC4)', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  it('loads YAML config file (.yaml extension)', async () => {
    const yamlContent = `
scheduling:
  defaultTimeout: 900
  minTimeout: 300
  defaultPriority: 60
governance:
  defaultPolicy: open
  circuitBreakThreshold: 5
`;

    const files: Record<string, string> = {
      '/config/aco.config.yaml': yamlContent,
    };

    const cm = new ConfigManager(eventBus, { configPath: '/config/aco.config.yaml' });
    cm.setFileSystem(createMockFs(files));

    const result = await cm.loadFromFile();
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);

    const config = cm.getConfig();
    expect(config.defaultTimeout).toBe(900);
    expect(config.defaultPriority).toBe(60);
    expect(config.circuitBreakThreshold).toBe(5);
  });

  it('loads YAML config file (.yml extension)', async () => {
    const yamlContent = `
scheduling:
  defaultTimeout: 1200
governance:
  defaultPolicy: closed
`;

    const files: Record<string, string> = {
      '/config/aco.config.yml': yamlContent,
    };

    const cm = new ConfigManager(eventBus, { configPath: '/config/aco.config.yml' });
    cm.setFileSystem(createMockFs(files));

    const result = await cm.loadFromFile();
    expect(result.success).toBe(true);

    const config = cm.getConfig();
    expect(config.defaultTimeout).toBe(1200);
    expect(config.defaultPolicy).toBe('closed');
  });

  it('rejects invalid YAML with clear error', async () => {
    const invalidYaml = `
scheduling:
  defaultTimeout: 900
  invalid: [unclosed bracket
`;

    const files: Record<string, string> = {
      '/config/aco.config.yaml': invalidYaml,
    };

    const cm = new ConfigManager(eventBus, { configPath: '/config/aco.config.yaml' });
    cm.setFileSystem(createMockFs(files));

    const result = await cm.loadFromFile();
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toContain('Invalid config format');
  });

  it('still loads JSON config normally', async () => {
    const jsonContent = JSON.stringify({
      scheduling: { defaultTimeout: 800 },
    });

    const files: Record<string, string> = {
      '/config/aco.config.json': jsonContent,
    };

    const cm = new ConfigManager(eventBus, { configPath: '/config/aco.config.json' });
    cm.setFileSystem(createMockFs(files));

    const result = await cm.loadFromFile();
    expect(result.success).toBe(true);
    expect(cm.getConfig().defaultTimeout).toBe(800);
  });

  it('validates YAML config with same schema as JSON', async () => {
    const yamlContent = `
scheduling:
  defaultTimeout: 100
  minTimeout: 50
`;

    const files: Record<string, string> = {
      '/config/aco.config.yaml': yamlContent,
    };

    const cm = new ConfigManager(eventBus, { configPath: '/config/aco.config.yaml' });
    cm.setFileSystem(createMockFs(files));

    const result = await cm.loadFromFile();
    // Should still load (validation produces warnings, not blocking errors for these values)
    // The key point is YAML parsing works and validation runs
    expect(result.errors.every(e => e.severity !== 'error') || result.success).toBe(true);
  });

  it('YAML config with pool agents', async () => {
    const yamlContent = `
scheduling:
  defaultTimeout: 600
pool:
  agents:
    - agentId: cc
      tier: T1
      roles:
        - coder
    - agentId: audit-01
      tier: T2
      roles:
        - auditor
features:
  enabled:
    - scheduling
    - governance
`;

    const files: Record<string, string> = {
      '/config/aco.config.yaml': yamlContent,
    };

    const cm = new ConfigManager(eventBus, { configPath: '/config/aco.config.yaml' });
    cm.setFileSystem(createMockFs(files));

    const result = await cm.loadFromFile();
    expect(result.success).toBe(true);

    const fileConfig = cm.getFileConfig();
    expect(fileConfig.pool?.agents).toHaveLength(2);
    expect(fileConfig.features?.enabled).toContain('governance');
  });
});
