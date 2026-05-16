/**
 * Generator Registry — FR-J01: 声明式插件注册（init 自动发现）
 *
 * Static registry pattern: all generators are explicitly imported here.
 * New generators only need to be added to the `allGenerators` array.
 * This approach is reliable and compatible with npm package distribution.
 *
 * AC1: generators/ 下导出标准接口的模块自动被发现并执行
 * AC2: 新增 generator 只需放入 generators/ 并在此注册，无需修改 init.ts
 * AC3: 标准接口 { name, description, priority?, generate(env, config, force) }
 * AC4: listGenerators() 支持 `aco init --list`
 * AC5: priority 排序（数字小的先执行，默认 100）
 */

import type { AcoFileConfig } from '../config/config-schema.js';

/**
 * Minimal environment info passed to generators.
 * Compatible with DetectedEnvironment from init.ts.
 */
export interface GeneratorEnv {
  openclawHome: string;
  rulesPath: string;
  dataDir: string;
}

/**
 * Standard generator interface (AC3).
 */
export interface Generator {
  name: string;
  description: string;
  priority?: number;
  generate(env: GeneratorEnv, config: AcoFileConfig | null, force: boolean): Promise<void>;
}

// --- Static registry: import all generators here ---
import closureGuardGenerator from './closure-guard-plugin.js';

/**
 * All registered generators. To add a new generator:
 * 1. Create a file in src/generators/ exporting a default Generator object
 * 2. Import it above and add it to this array
 * No changes to init.ts required (AC2).
 */
const allGenerators: Generator[] = [
  closureGuardGenerator,
];

/**
 * Get all generators sorted by priority (AC5).
 * Lower priority number = executed first. Default priority is 100.
 */
export function getGenerators(): Generator[] {
  return [...allGenerators].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
}

/**
 * Run all registered generators in priority order (AC1, AC5).
 */
export async function runAllGenerators(
  env: GeneratorEnv,
  config: AcoFileConfig | null,
  force: boolean,
): Promise<void> {
  const generators = getGenerators();
  for (const gen of generators) {
    await gen.generate(env, config, force);
  }
}

/**
 * List all registered generators with name + description (AC4).
 * Used by `aco init --list`.
 */
export function listGenerators(): Array<{ name: string; description: string; priority: number }> {
  return getGenerators().map(g => ({
    name: g.name,
    description: g.description,
    priority: g.priority ?? 100,
  }));
}
