/**
 * aco dispatch — 任务派发
 * FR-Z04 AC2: 通过 OpenClaw Adapter 实际派发任务
 * FR-A01: 任务创建
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasFlag, getFlagValue } from '../parse-args.js';
import { getDataDir, fileExists } from './shared.js';
import { OpenClawAdapter } from '../../adapter/openclaw-adapter.js';
import type { OpenClawAdapterConfig } from '../../adapter/openclaw-adapter.js';

const HELP = `
aco dispatch — 派发任务到 Agent

Usage:
  aco dispatch <agentId> -m <message>     派发任务到指定 Agent
  aco dispatch -m <message>               自动选择 Agent 派发

Options:
  --help                  显示帮助
  -m, --message <msg>     任务 prompt（必填）
  --label <label>         任务标签
  --timeout <seconds>     超时时间（默认 600s）
  --tier <T1-T4>          目标梯队
  --json                  JSON 格式输出

Examples:
  aco dispatch hermes -m "实现用户登录功能"
  aco dispatch -m "修复 bug #123" --label "bugfix-123" --timeout 1200
  aco dispatch cc -m "代码审查" --tier T1
`.trim();

interface AdapterFileConfig {
  adapter?: {
    type?: string;
    config?: Record<string, unknown>;
  };
}

async function loadAdapterConfig(): Promise<OpenClawAdapterConfig> {
  const config: OpenClawAdapterConfig = {};

  // Try to read from aco.config.json
  const configPaths = [
    join(process.cwd(), 'aco.config.json'),
    join(getDataDir(), '..', 'aco.config.json'),
  ];

  for (const p of configPaths) {
    if (await fileExists(p)) {
      try {
        const content = await readFile(p, 'utf-8');
        const parsed = JSON.parse(content) as AdapterFileConfig;
        if (parsed.adapter?.config) {
          const ac = parsed.adapter.config;
          if (typeof ac.gatewayUrl === 'string') config.gatewayUrl = ac.gatewayUrl;
          if (typeof ac.authToken === 'string') config.authToken = ac.authToken;
          if (typeof ac.openclawConfigPath === 'string') config.openclawConfigPath = ac.openclawConfigPath;
        }
        break;
      } catch { /* skip invalid config */ }
    }
  }

  // Environment variables override file config
  if (process.env.OPENCLAW_GATEWAY_URL) {
    config.gatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  }
  if (process.env.OPENCLAW_AUTH_TOKEN) {
    config.authToken = process.env.OPENCLAW_AUTH_TOKEN;
  }

  return config;
}

export async function dispatchCommand(args: string[]): Promise<number> {
  if (hasFlag(args, 'help') || args.length === 0) {
    console.log(HELP);
    return 0;
  }

  // Parse message (support both --message and -m)
  let message = getFlagValue(args, 'message');
  if (!message) {
    const mIdx = args.indexOf('-m');
    if (mIdx !== -1 && mIdx + 1 < args.length && !args[mIdx + 1].startsWith('-')) {
      message = args[mIdx + 1];
    }
  }
  if (!message) {
    console.error('Error [DISPATCH_NO_MESSAGE]: Message is required.');
    console.error('Suggestion: Use -m or --message to specify the task prompt.');
    console.error('Example: aco dispatch hermes -m "实现用户登录功能"');
    return 1;
  }

  // Parse agent ID (first positional arg that's not a flag or flag value)
  let agentId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      // Skip flag and its value
      if (a !== '-m' && !a.startsWith('--')) continue;
      const next = args[i + 1];
      if (next && !next.startsWith('-')) i++;
      continue;
    }
    // Check this isn't a value for a preceding flag
    if (i > 0) {
      const prev = args[i - 1];
      if (prev === '-m' || prev === '--message' || prev === '--label' || prev === '--timeout' || prev === '--tier') {
        continue;
      }
    }
    agentId = a;
    break;
  }

  const label = getFlagValue(args, 'label') ?? `dispatch-${Date.now()}`;
  const timeoutStr = getFlagValue(args, 'timeout');
  const timeout = timeoutStr ? parseInt(timeoutStr, 10) : 600;
  const jsonOutput = hasFlag(args, 'json');

  if (isNaN(timeout) || timeout < 1) {
    console.error('Error [DISPATCH_INVALID_TIMEOUT]: Timeout must be a positive number.');
    return 1;
  }

  // Load adapter config and create adapter
  const adapterConfig = await loadAdapterConfig();
  const adapter = new OpenClawAdapter(adapterConfig);

  // If no agentId specified, try to discover agents and pick one
  let targetAgent = agentId;
  if (!targetAgent) {
    const agents = await adapter.discoverAgents();
    if (agents.length === 0) {
      console.error('Error [DISPATCH_NO_AGENT]: No agent specified and no agents discovered.');
      console.error('Suggestion: Specify an agent ID or run "aco pool sync" first.');
      return 1;
    }
    // Pick the first available agent
    targetAgent = agents[0].agentId;
    if (!jsonOutput) {
      console.log(`Auto-selected agent: ${targetAgent}`);
    }
  }

  // Dispatch the task
  try {
    const sessionId = await adapter.spawnTask(targetAgent, message, {
      timeoutSeconds: timeout,
      label,
    });

    if (jsonOutput) {
      console.log(JSON.stringify({
        success: true,
        sessionId,
        agentId: targetAgent,
        label,
        timeout,
      }, null, 2));
    } else {
      console.log(`✓ Task dispatched successfully`);
      console.log(`  Session:  ${sessionId}`);
      console.log(`  Agent:    ${targetAgent}`);
      console.log(`  Label:    ${label}`);
      console.log(`  Timeout:  ${timeout}s`);
    }

    adapter.dispose();
    return 0;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    if (jsonOutput) {
      console.log(JSON.stringify({ success: false, error: errMsg }, null, 2));
    } else {
      console.error(`Error [DISPATCH_FAILED]: ${errMsg}`);
      if (errMsg.includes('ECONNREFUSED') || errMsg.includes('fetch failed')) {
        console.error('Suggestion: Is the OpenClaw Gateway running? Check with "openclaw gateway status".');
        console.error(`Gateway URL: ${adapterConfig.gatewayUrl ?? 'http://localhost:4141'}`);
      }
    }

    adapter.dispose();
    return 1;
  }
}
