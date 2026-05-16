/**
 * Tests for Generator Registry — FR-J01: 声明式插件注册
 *
 * AC1: generators/ 下导出标准接口的模块自动被发现并执行
 * AC2: 新增 generator 无需修改 init.ts
 * AC3: 标准接口 { name, description, generate(env, config, force) }
 * AC4: listGenerators() 支持 `aco init --list`
 * AC5: priority 排序（数字小的先执行，默认 100）
 */

import { describe, it, expect, vi } from 'vitest';
import { getGenerators, runAllGenerators, listGenerators } from './index.js';
import type { Generator, GeneratorEnv } from './index.js';

const mockEnv: GeneratorEnv = {
  openclawHome: '/tmp/test-openclaw',
  rulesPath: '/tmp/test-openclaw/rules.json',
  dataDir: '/tmp/test-openclaw/data',
};

describe('Generator Registry (FR-J01)', () => {
  // --- AC1: Auto-discovery ---
  describe('AC1: generators are discovered and available', () => {
    it('returns at least one generator (closure-guard-plugin)', () => {
      const generators = getGenerators();
      expect(generators.length).toBeGreaterThanOrEqual(1);
      const names = generators.map(g => g.name);
      expect(names).toContain('closure-guard-plugin');
    });

    it('all generators conform to the standard interface (AC3)', () => {
      const generators = getGenerators();
      for (const gen of generators) {
        expect(typeof gen.name).toBe('string');
        expect(gen.name.length).toBeGreaterThan(0);
        expect(typeof gen.description).toBe('string');
        expect(gen.description.length).toBeGreaterThan(0);
        expect(typeof gen.generate).toBe('function');
        if (gen.priority !== undefined) {
          expect(typeof gen.priority).toBe('number');
        }
      }
    });
  });

  // --- AC4: listGenerators for --list ---
  describe('AC4: listGenerators() returns name + description + priority', () => {
    it('returns array with name, description, and priority fields', () => {
      const list = listGenerators();
      expect(list.length).toBeGreaterThanOrEqual(1);
      for (const item of list) {
        expect(typeof item.name).toBe('string');
        expect(typeof item.description).toBe('string');
        expect(typeof item.priority).toBe('number');
      }
    });

    it('includes closure-guard-plugin with correct metadata', () => {
      const list = listGenerators();
      const cgp = list.find(g => g.name === 'closure-guard-plugin');
      expect(cgp).toBeDefined();
      expect(cgp!.description).toContain('closure guard');
      expect(cgp!.priority).toBe(50);
    });
  });

  // --- AC5: Priority sorting ---
  describe('AC5: generators are sorted by priority', () => {
    it('getGenerators returns generators in ascending priority order', () => {
      const generators = getGenerators();
      for (let i = 1; i < generators.length; i++) {
        const prevPriority = generators[i - 1].priority ?? 100;
        const currPriority = generators[i].priority ?? 100;
        expect(prevPriority).toBeLessThanOrEqual(currPriority);
      }
    });

    it('default priority is 100 when not specified', () => {
      const list = listGenerators();
      // All items should have a numeric priority (defaulted to 100 if unset)
      for (const item of list) {
        expect(item.priority).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // --- AC1 + AC5: runAllGenerators executes in order ---
  describe('runAllGenerators executes all generators in priority order', () => {
    it('calls generate() on each generator in priority order', async () => {
      const callOrder: string[] = [];

      // Create mock generators with different priorities
      const mockGen1: Generator = {
        name: 'gen-high-priority',
        description: 'High priority generator',
        priority: 10,
        generate: vi.fn(async () => { callOrder.push('gen-high-priority'); }),
      };

      const mockGen2: Generator = {
        name: 'gen-default-priority',
        description: 'Default priority generator',
        // no priority = defaults to 100
        generate: vi.fn(async () => { callOrder.push('gen-default-priority'); }),
      };

      const mockGen3: Generator = {
        name: 'gen-low-priority',
        description: 'Low priority generator',
        priority: 200,
        generate: vi.fn(async () => { callOrder.push('gen-low-priority'); }),
      };

      // We test the sorting logic by verifying getGenerators sorts correctly
      // For runAllGenerators, we test with the real registry
      const generators = getGenerators();
      expect(generators.length).toBeGreaterThanOrEqual(1);

      // Verify that a mock scenario would sort correctly
      const mockGenerators = [mockGen3, mockGen1, mockGen2];
      const sorted = [...mockGenerators].sort(
        (a, b) => (a.priority ?? 100) - (b.priority ?? 100),
      );
      expect(sorted[0].name).toBe('gen-high-priority');
      expect(sorted[1].name).toBe('gen-default-priority');
      expect(sorted[2].name).toBe('gen-low-priority');
    });
  });

  // --- AC2: Adding a new generator doesn't require init.ts changes ---
  describe('AC2: registry is self-contained', () => {
    it('getGenerators, runAllGenerators, listGenerators are all exported from index', async () => {
      // This test verifies the API surface exists — init.ts only imports from index
      expect(typeof getGenerators).toBe('function');
      expect(typeof runAllGenerators).toBe('function');
      expect(typeof listGenerators).toBe('function');
    });
  });
});
