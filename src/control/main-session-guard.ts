/**
 * FR-C04：主会话空闲保护
 * 检测耗时操作意图 → 拦截并建议转子任务
 * 基于命令模式匹配，不依赖 LLM 推断
 */

import type { MainSessionGuardConfig, DelegationSuggestion } from './types.js';

const DEFAULT_CONFIG: MainSessionGuardConfig = {
  commandBlacklist: [
    // 构建命令
    'npm run build',
    'npx next build',
    'npx tsc',
    'npx webpack',
    'npx vite build',
    'npx rollup',
    'npx esbuild',
    'npx turbo',
    'make build',
    'cargo build',
    'go build',
    // 安装命令
    'npm install',
    'npm ci',
    'yarn install',
    'pnpm install',
    'pip install',
    'apt install',
    'apt-get install',
    'brew install',
    // 测试命令（可能耗时）
    'npm test',
    'npm run test',
    'npx vitest',
    'npx jest',
    'pytest',
    // 清理+重建
    'rm -rf node_modules',
    'rm -rf .next',
    'rm -rf dist',
    // 服务启停
    'npx next start',
    'npm start',
    'npm run dev',
    'nohup',
    'docker build',
    'docker compose up',
    // 长时间运行
    'npx next dev',
    'npx webpack serve',
  ],
  durationThreshold: 30,
  enabled: true,
};

/**
 * 判断命令是否应委派给子任务执行。
 * 基于命令模式匹配（规则引擎），不依赖 LLM。
 */
export function shouldDelegateToSubagent(
  command: string,
  config: Partial<MainSessionGuardConfig> = {},
): DelegationSuggestion {
  const cfg: MainSessionGuardConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return { shouldDelegate: false };
  }

  const normalizedCommand = command.trim().toLowerCase();

  // 检查命令黑名单
  for (const pattern of cfg.commandBlacklist) {
    if (matchesPattern(normalizedCommand, pattern.toLowerCase())) {
      return {
        shouldDelegate: true,
        reason: `Command matches blocking pattern: "${pattern}" (estimated duration > ${cfg.durationThreshold}s)`,
        matchedPattern: pattern,
        suggestedPrompt: buildDelegationPrompt(command),
        suggestedTimeout: estimateTimeout(command),
      };
    }
  }

  // 检查 NODE_OPTIONS 环境变量 + build 组合
  if (normalizedCommand.includes('node_options') && normalizedCommand.includes('build')) {
    return {
      shouldDelegate: true,
      reason: 'NODE_OPTIONS with build command detected (likely memory-intensive build)',
      matchedPattern: 'NODE_OPTIONS + build',
      suggestedPrompt: buildDelegationPrompt(command),
      suggestedTimeout: estimateTimeout(command),
    };
  }

  // 检查管道/链式命令中是否包含耗时操作
  const chainedCommands = splitChainedCommands(normalizedCommand);
  for (const sub of chainedCommands) {
    for (const pattern of cfg.commandBlacklist) {
      if (matchesPattern(sub.trim(), pattern.toLowerCase())) {
        return {
          shouldDelegate: true,
          reason: `Chained command contains blocking pattern: "${pattern}"`,
          matchedPattern: pattern,
          suggestedPrompt: buildDelegationPrompt(command),
          suggestedTimeout: estimateTimeout(command),
        };
      }
    }
  }

  return { shouldDelegate: false };
}

/**
 * 批量检查多个命令
 */
export function checkCommands(
  commands: string[],
  config: Partial<MainSessionGuardConfig> = {},
): DelegationSuggestion[] {
  return commands.map(cmd => shouldDelegateToSubagent(cmd, config));
}

/**
 * 添加自定义黑名单模式
 */
export function extendBlacklist(
  baseConfig: Partial<MainSessionGuardConfig>,
  additionalPatterns: string[],
): MainSessionGuardConfig {
  const cfg: MainSessionGuardConfig = { ...DEFAULT_CONFIG, ...baseConfig };
  return {
    ...cfg,
    commandBlacklist: [...new Set([...cfg.commandBlacklist, ...additionalPatterns])],
  };
}

/**
 * 模式匹配：检查命令是否以某个模式开头或包含该模式
 */
function matchesPattern(command: string, pattern: string): boolean {
  // 精确前缀匹配
  if (command.startsWith(pattern)) return true;

  // 带参数的匹配（如 "npm install foo" 匹配 "npm install"）
  if (command.startsWith(pattern + ' ')) return true;

  // 路径前缀匹配（如 "./node_modules/.bin/next build"）
  const cmdBase = command.replace(/^(\.\/)?node_modules\/\.bin\//, '');
  if (cmdBase.startsWith(pattern)) return true;

  return false;
}

/**
 * 拆分链式命令（&&, ||, ;, |）
 */
function splitChainedCommands(command: string): string[] {
  return command.split(/\s*(?:&&|\|\||;|\|)\s*/);
}

/**
 * 根据命令类型估算超时时间
 */
function estimateTimeout(command: string): number {
  const lower = command.toLowerCase();

  if (lower.includes('build') || lower.includes('webpack') || lower.includes('next build')) {
    return 1200; // 构建类：20 分钟
  }
  if (lower.includes('install') || lower.includes('ci')) {
    return 600; // 安装类：10 分钟
  }
  if (lower.includes('test') || lower.includes('vitest') || lower.includes('jest')) {
    return 900; // 测试类：15 分钟
  }
  if (lower.includes('docker')) {
    return 1800; // Docker 类：30 分钟
  }

  return 600; // 默认 10 分钟
}

/**
 * 将命令转化为子任务 prompt
 */
function buildDelegationPrompt(command: string): string {
  return [
    `执行以下命令并报告结果：`,
    '',
    '```bash',
    command,
    '```',
    '',
    '要求：',
    '1. 执行命令并等待完成',
    '2. 如果失败，分析错误原因并尝试修复',
    '3. 报告最终执行结果（成功/失败 + 关键输出）',
  ].join('\n');
}
