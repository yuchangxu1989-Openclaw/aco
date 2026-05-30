/**
 * Output Humanizer Guard Plugin v1.0.0
 * 
 * FR-I01: 出站消息人话门禁（Output Humanizer Guard）
 * 
 * 守卫主会话通过用户可见渠道发出的消息，检测技术标签并：
 * - 策略 C (remind): 阻断消息，注入系统级提醒要求重新生成
 * - 策略 B (rewrite): 调用 LLM 改写为人话后发出
 * 
 * 在 L2 插件层运行，独立于主会话上下文，不依赖模型对 prompt 的遵从度。
 */

import fs from 'fs';
import path from 'path';

// --- Singleton guard ---
const GUARD_GLOBAL_KEY = Symbol.for('openclaw.aco-output-humanizer-guard.instance');
const guardGlobal = globalThis[GUARD_GLOBAL_KEY] || (globalThis[GUARD_GLOBAL_KEY] = {
  registeredLogged: false,
  remindRetryCount: new Map(), // sessionKey -> retry count for strategy C
});

// --- Constants ---
const DEFAULT_AUDIT_PATH = '/root/.openclaw/workspace/logs/output-humanizer-guard-events.jsonl';
const REWRITE_TIMEOUT_MS = 30000;
const MAX_REMIND_RETRIES = 3;

// --- Built-in detection patterns (AC2, AC9) ---

/**
 * Pattern definitions for six categories of technical labels.
 * Each pattern has: category, regex, strictness level (which strictness modes include it).
 */
const BUILTIN_PATTERNS = [
  // Category 1: Agent ID (all strictness levels)
  {
    category: 'agent_id',
    pattern: /\b(?:sa|pm|audit|dev|ux|cc|re)-\d{2}\b/g,
    description: 'Agent ID 模式 (sa-01, pm-02, audit-01, dev-01, ux-01 等)',
    levels: ['strict', 'moderate', 'relaxed'],
  },
  // Category 2: File paths (all strictness levels)
  {
    category: 'file_path',
    pattern: /(?:\/root\/|~\/\.?openclaw\/|workspace\/|projects\/|\/usr\/lib\/|\/tmp\/|\/etc\/)[^\s,;)}\]'"]+/g,
    description: '文件路径 (/root/, workspace/, projects/ 等)',
    levels: ['strict', 'moderate', 'relaxed'],
  },
  // Category 3: FR/AC identifiers (strict + moderate)
  {
    category: 'fr_ac_id',
    pattern: /\b(?:FR|AC)-[A-Z]?\d+\b/g,
    description: 'FR/AC 编号 (FR-A01, AC-3, FR-I01 等)',
    levels: ['strict', 'moderate'],
  },
  // Category 4: Function/variable names (strict only)
  {
    category: 'code_identifier',
    pattern: /\b[a-z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]*){1,}\b/g,
    description: '驼峰命名函数/变量名 (getUserName, handleCompletion 等)',
    levels: ['strict'],
    minLength: 6,
  },
  {
    category: 'code_identifier',
    pattern: /\b[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*){1,}\b/g,
    description: '下划线命名函数/变量名 (task_board, user_name 等)',
    levels: ['strict'],
    minLength: 6,
  },
  // Category 5: Command line (strict + moderate)
  {
    category: 'command_line',
    pattern: /\b(?:git\s+(?:commit|push|pull|merge|rebase|checkout|clone|add|status|log|diff|stash|reset|branch)|npm\s+(?:publish|install|run|ci|init|test|start|build)|npx\s+\w+|openclaw\s+\w+|docker\s+\w+|curl\s+\S+|systemctl\s+\w+|sevo:\w+)\b/gi,
    description: '命令行 (git commit, npm publish, openclaw gateway 等)',
    levels: ['strict', 'moderate'],
  },
  // Category 6: Code snippets (strict only)
  {
    category: 'code_snippet',
    pattern: /(?:import\s+\{|require\s*\(|console\.log\s*\(|function\s*\(|const\s+\w+\s*=|let\s+\w+\s*=|export\s+(?:default|const|function)|=>\s*\{|async\s+function)/g,
    description: '代码片段 (import {, require(), console.log(), function(), const x =, => { 等)',
    levels: ['strict'],
  },
];

// Common English words that match camelCase pattern but are NOT code identifiers
const CAMEL_CASE_WHITELIST = new Set([
  'iPhone', 'iPad', 'macOS', 'iOS', 'YouTube', 'GitHub', 'GitLab',
  'JavaScript', 'TypeScript', 'WordPress', 'LinkedIn', 'OpenAI',
  'ChatGPT', 'PowerPoint', 'OneNote', 'OutLook', 'WeChat',
  'OpenClaw', 'ClawHub', 'SubAgent',
]);

// --- Utility functions ---

function sanitizeForLog(text, max = 50) {
  return String(text || '').slice(0, max).replace(/\b(sk-|xoxb-|xoxp-|ghp_|gho_|AKIA)[A-Za-z0-9_\-]{4,}/g, '[REDACTED]');
}

function nowIso() {
  return new Date().toISOString();
}

function appendAuditEvent(event) {
  try {
    const dir = path.dirname(DEFAULT_AUDIT_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ...event, timestamp: nowIso() }) + '\n';
    fs.appendFileSync(DEFAULT_AUDIT_PATH, line);
  } catch { /* non-critical */ }
}

/**
 * Extract channel from session key or context.
 * Session key format: "agent:<agentId>:<channel>:<type>:<id>"
 */
function extractChannel(ctx) {
  // Try ctx.channelId first
  if (ctx?.channelId) return ctx.channelId;
  
  // Try session key parsing
  const sk = ctx?.sessionKey || ctx?.sessionId || '';
  const parts = sk.split(':');
  // Format: agent:main:feishu:direct:ou_xxx
  if (parts.length >= 3 && parts[0] === 'agent') {
    return parts[2]; // channel is the 3rd segment
  }
  
  // Try session object
  if (ctx?.session?.channel?.type) return ctx.session.channel.type;
  if (ctx?.session?.meta?.channel?.type) return ctx.session.meta.channel.type;
  
  return null;
}

/**
 * Check if the message is from the main agent session (only intercept main -> user messages).
 */
function isMainSession(ctx) {
  const sk = ctx?.sessionKey || ctx?.sessionId || '';
  const parts = sk.split(':');
  // Main session: agent:main:<channel>:<type>:<id>
  if (parts.length >= 2 && parts[0] === 'agent' && parts[1] === 'main') return true;
  // Also check agentId directly
  if (ctx?.agentId === 'main' || ctx?.session?.agentId === 'main') return true;
  return false;
}

/**
 * Read LLM config from openclaw.json for rewrite calls (AC4).
 */
function readLlmConfig(preferredModel) {
  try {
    const cfgPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../openclaw.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const providers = cfg?.models?.providers || {};

    // If preferredModel specified, try to find matching provider
    if (preferredModel) {
      const [provId, modelId] = preferredModel.includes('/') 
        ? preferredModel.split('/', 2) 
        : [null, preferredModel];
      
      for (const [key, p] of Object.entries(providers)) {
        if (!p.apiKey || !p.baseUrl) continue;
        if (provId && key !== provId) continue;
        const models = Array.isArray(p.models) ? p.models : [];
        const found = models.find(m => m.id === modelId);
        if (found) {
          return { baseUrl: p.baseUrl.replace(/\/+$/, ''), apiKey: p.apiKey, model: found.id };
        }
      }
    }

    // Fallback: find any available chat model
    for (const p of Object.values(providers)) {
      if (!p.apiKey || !p.baseUrl) continue;
      const models = Array.isArray(p.models) ? p.models : [];
      const chatModel = models.find(m => m.id && !m.id.includes('thinking') && !m.id.includes('image'));
      if (chatModel) {
        return { baseUrl: p.baseUrl.replace(/\/+$/, ''), apiKey: p.apiKey, model: chatModel.id };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// --- Detection Engine (AC2) ---

/**
 * Detect technical labels in message content.
 * Returns array of matches: { category, matchedText, position, pattern }
 */
function detectTechnicalLabels(content, strictness, allowPatterns, customPatterns) {
  if (!content || typeof content !== 'string') return [];

  const matches = [];
  
  // Compile allow patterns (AC10)
  const allowRegexes = (allowPatterns || []).map(p => {
    try { return new RegExp(p); } catch { return null; }
  }).filter(Boolean);

  // Filter built-in patterns by strictness level (AC9)
  const activePatterns = BUILTIN_PATTERNS.filter(p => p.levels.includes(strictness));

  // Add custom patterns (AC13)
  const allPatterns = [...activePatterns];
  if (Array.isArray(customPatterns)) {
    for (const cp of customPatterns) {
      try {
        allPatterns.push({
          category: cp.category || 'custom',
          pattern: new RegExp(cp.pattern, 'g'),
          description: cp.description || 'custom pattern',
          levels: ['strict', 'moderate', 'relaxed'], // custom patterns always active
        });
      } catch { /* skip invalid regex */ }
    }
  }

  for (const patternDef of allPatterns) {
    // Reset regex lastIndex for global patterns
    const regex = new RegExp(patternDef.pattern.source, patternDef.pattern.flags);
    let match;
    
    while ((match = regex.exec(content)) !== null) {
      const matchedText = match[0];
      
      // Apply minLength filter (for code identifiers)
      if (patternDef.minLength && matchedText.length < patternDef.minLength) continue;
      
      // Skip whitelisted camelCase words
      if (patternDef.category === 'code_identifier' && CAMEL_CASE_WHITELIST.has(matchedText)) continue;
      
      // Check allow patterns (AC10) - skip if whitelisted
      const isAllowed = allowRegexes.some(r => r.test(matchedText));
      if (isAllowed) continue;

      matches.push({
        category: patternDef.category,
        matchedText,
        position: match.index,
        description: patternDef.description,
      });
    }
  }

  return matches;
}

// --- LLM Rewrite (AC4, Strategy B) ---

const REWRITE_SYSTEM_PROMPT = `你是一个消息改写助手。你的任务是将包含技术标签的消息改写为纯人话版本。

规则：
1. 去除所有 Agent ID（如 sa-01、pm-02）、文件路径、FR/AC 编号、函数名、命令行、代码片段
2. 保留消息的核心含义和信息
3. 用口语化、自然的中文表达
4. 不要添加任何解释说明，直接输出改写后的消息
5. 保持原消息的语气和情感色彩
6. 如果原消息提到了技术操作的结果，用人话描述结果即可（如"代码已提交"改为"改好了"）`;

async function rewriteMessage(content, llmConfig, timeoutMs) {
  if (!llmConfig) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const base = llmConfig.baseUrl;
    const chatUrl = base.endsWith('/v1') || base.includes('/v1/')
      ? `${base}/chat/completions`
      : `${base}/v1/chat/completions`;

    const response = await fetch(chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: llmConfig.model,
        messages: [
          { role: 'system', content: REWRITE_SYSTEM_PROMPT },
          { role: 'user', content: `请改写以下消息为纯人话版本（去除所有技术标签）：\n\n${content}` },
        ],
        max_tokens: 4096,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) return null;

    const data = await response.json();
    const rewritten = (data?.choices?.[0]?.message?.content || '').trim();
    return rewritten || null;
  } catch {
    return null; // timeout or network error
  }
}

// --- Remind prompt (AC5, Strategy C) ---

function buildRemindPrompt(matches) {
  const hitSummary = matches.map(m => `- [${m.category}] "${m.matchedText}"`).join('\n');
  return `⚠️ 系统守卫：你的回复包含以下技术标签，用户不应看到这些内容：

${hitSummary}

请立即重新生成不含任何技术标签的版本。要求：
1. 去除所有 Agent ID、文件路径、FR/AC 编号、函数名/变量名、命令行、代码片段
2. 用纯人话表达相同的意思
3. 直接输出改写后的内容，不要解释为什么要改写`;
}

// --- Plugin Definition ---

const outputHumanizerGuardPlugin = {
  id: 'aco-output-humanizer-guard',
  name: '出站消息人话门禁',
  description: 'FR-I01: 守卫主会话出站消息，检测技术标签并自动改写为人话或注入提醒',
  version: '1.0.0',

  register(api) {
    // Read plugin config with defaults (AC8, AC12)
    const pluginConfig = api.pluginConfig?.['aco-output-humanizer-guard'] || api.pluginConfig?.['output-humanizer-guard'] || {};
    const config = {
      enabled: pluginConfig.enabled !== false, // AC8: default true
      strategy: pluginConfig.strategy || 'remind', // AC3: default remind
      channels: pluginConfig.channels || ['feishu'], // AC7: default feishu
      strictness: pluginConfig.strictness || 'strict', // AC9: default strict
      allowPatterns: pluginConfig.allowPatterns || [], // AC10: default empty
      patterns: pluginConfig.patterns || [], // AC13: default empty
      rewriteModel: pluginConfig.rewriteModel || '', // AC4: default use host model
      rewriteTimeout: pluginConfig.rewriteTimeout || REWRITE_TIMEOUT_MS, // AC14: 30s
      remindMaxRetries: pluginConfig.remindMaxRetries || MAX_REMIND_RETRIES, // AC6: 3
    };

    // AC1: Hook into message_sending event (outbound message interception at L2 plugin layer)
    api.on(
      'message_sending',
      async (event, ctx) => {
        // AC8: Global kill switch
        if (!config.enabled) return null;

        const content = String(event.content || '');
        if (!content || content.length < 5) return null;

        // AC7: Channel filtering - only intercept configured channels
        const channel = extractChannel(ctx);
        if (channel && !config.channels.includes(channel)) {
          return null; // Channel not in whitelist, pass through
        }

        // Only intercept main session outbound messages
        if (!isMainSession(ctx)) return null;

        // AC2: Run detection engine
        const startTime = Date.now();
        const matches = detectTechnicalLabels(content, config.strictness, config.allowPatterns, config.patterns);
        const detectMs = Date.now() - startTime;

        // AC14: Performance tracking (detection should be < 50ms)
        const sessionKey = ctx?.sessionKey || ctx?.sessionId || 'unknown';

        // AC11: Always log scan event
        appendAuditEvent({
          type: 'output_guard_scan',
          sessionKey,
          channel,
          contentSnippet: sanitizeForLog(content),
          matchCount: matches.length,
          detectMs,
          strictness: config.strictness,
        });

        // No matches - pass through
        if (matches.length === 0) return null;

        // AC11: Log triggered event with details
        const hitCategories = [...new Set(matches.map(m => m.category))];
        const hitSnippets = matches.slice(0, 10).map(m => ({
          category: m.category,
          text: m.matchedText.slice(0, 30),
          position: m.position,
        }));

        appendAuditEvent({
          type: 'output_guard_triggered',
          sessionKey,
          channel,
          contentSnippet: sanitizeForLog(content),
          hitCategories,
          hitSnippets,
          matchCount: matches.length,
          strategy: config.strategy,
        });

        // --- Strategy dispatch ---

        if (config.strategy === 'rewrite') {
          // AC4: Strategy B - LLM rewrite
          return await handleRewriteStrategy(content, matches, config, sessionKey);
        } else {
          // AC5: Strategy C - Inject remind (default)
          return await handleRemindStrategy(content, matches, config, ctx, sessionKey);
        }
      },
      { priority: 1100 }, // Higher priority than fact-guard (1050) to run first
    );

    if (!guardGlobal.registeredLogged) {
      api.logger.info(`aco-output-humanizer-guard: plugin registered (v1.0.0, strategy=${config.strategy}, strictness=${config.strictness}, channels=${config.channels.join(',')})`);
      guardGlobal.registeredLogged = true;
    }
  },
};

/**
 * AC4: Strategy B (rewrite) - Call LLM to rewrite message as human-readable.
 */
async function handleRewriteStrategy(content, matches, config, sessionKey) {
  const llmConfig = readLlmConfig(config.rewriteModel);
  
  if (!llmConfig) {
    // No LLM available - log and pass through (fail-open)
    appendAuditEvent({
      type: 'output_guard_timeout',
      sessionKey,
      reason: 'no_llm_config_available',
      strategy: 'rewrite',
    });
    return null;
  }

  const rewritten = await rewriteMessage(content, llmConfig, config.rewriteTimeout);

  if (!rewritten) {
    // AC14: Rewrite timeout or failure - pass through original and log
    appendAuditEvent({
      type: 'output_guard_timeout',
      sessionKey,
      reason: 'rewrite_timeout_or_failure',
      strategy: 'rewrite',
    });
    return null; // fail-open
  }

  // Verify rewrite doesn't still contain technical labels
  const rewriteMatches = detectTechnicalLabels(rewritten, config.strictness, config.allowPatterns, config.patterns);
  
  appendAuditEvent({
    type: 'output_guard_rewrite_result',
    sessionKey,
    strategy: 'rewrite',
    originalSnippet: sanitizeForLog(content),
    rewrittenSnippet: sanitizeForLog(rewritten),
    residualMatches: rewriteMatches.length,
    result: rewriteMatches.length === 0 ? 'clean' : 'residual_labels',
  });

  // Replace message content with rewritten version
  return {
    cancel: false,
    content: rewritten,
  };
}

/**
 * AC5 + AC6: Strategy C (remind) - Block message and inject system prompt.
 * On 3rd retry failure, fallback to Strategy B (AC6).
 */
async function handleRemindStrategy(content, matches, config, ctx, sessionKey) {
  const retryKey = sessionKey;
  const currentRetries = guardGlobal.remindRetryCount.get(retryKey) || 0;

  // AC6: If exceeded max retries, fallback to Strategy B (rewrite)
  if (currentRetries >= config.remindMaxRetries) {
    // Reset retry counter
    guardGlobal.remindRetryCount.delete(retryKey);

    appendAuditEvent({
      type: 'output_guard_fallback',
      sessionKey,
      reason: `remind strategy exhausted after ${config.remindMaxRetries} retries, falling back to rewrite`,
      retries: currentRetries,
    });

    // Fallback to rewrite
    return await handleRewriteStrategy(content, matches, config, sessionKey);
  }

  // Increment retry counter
  guardGlobal.remindRetryCount.set(retryKey, currentRetries + 1);

  // AC5: Build remind prompt and block the message
  const remindPrompt = buildRemindPrompt(matches);

  appendAuditEvent({
    type: 'output_guard_remind',
    sessionKey,
    retry: currentRetries + 1,
    maxRetries: config.remindMaxRetries,
    hitCategories: [...new Set(matches.map(m => m.category))],
  });

  // Block the message and inject system-level instruction
  return {
    cancel: true,
    content: remindPrompt,
  };
}

export default outputHumanizerGuardPlugin;
