import fs from 'node:fs';
import path from 'node:path';

const AUDIT_LOG_PATH = '/root/.openclaw/workspace/logs/aco-anti-crawl-guard-events.jsonl';

const RESEARCH_KEYWORDS = [
  'research', '调研',
  'crawl', 'scrape', '抓取', '爬取',
  'data collection', '数据采集',
  'platform data', '平台数据',
  'gather information', '信息收集',
  'scraping', 'crawling',
  '竞品数据', '竞品分析.*数据',
  'market research', 'market data',
  'public data', 'public info',
  'harvest',
];

function hasResearchIntent(prompt, label) {
  const text = [label || '', prompt || ''].join(' ').toLowerCase();
  return RESEARCH_KEYWORDS.some((kw) => {
    try {
      return new RegExp(kw, 'iu').test(text);
    } catch {
      return text.includes(kw.toLowerCase());
    }
  });
}

const ANTI_CRAWL_INJECTION = `

## 反爬处理（自动注入）
遇到 403/Cloudflare/验证码/反爬时：
1. 首先尝试公开 API（如 Indiegogo API）
2. 其次用第三方数据服务（Apify 等）
3. 最终兜底：使用 \`bash /root/.openclaw/workspace/scripts/fetch-with-browser.sh <url>\` 获取页面内容
不允许放弃任何数据源，标记"被反爬"然后跳过 = 任务失败。`;

function appendAuditLog(entry) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    const record = {
      timestamp: new Date().toISOString(),
      plugin: 'aco-research-anti-crawl-guard',
      ...entry,
    };
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(record) + '\n');
  } catch {}
}

export default {
  id: 'aco-research-anti-crawl-guard',
  name: 'aco-research-anti-crawl-guard',
  version: '1.0.0',
  description: 'Injects anti-crawl handling instructions into task prompts with research/gathering intent',

  register(api) {
    const config = api.pluginConfig?.['aco-research-anti-crawl-guard'] || {};
    const enabled = config.enabled !== false;
    const extraKeywords = Array.isArray(config.extraKeywords) ? config.extraKeywords : [];
    const excludeLabels = Array.isArray(config.excludeLabels) ? config.excludeLabels : ['healthcheck', 'heartbeat'];
    const allKeywords = extraKeywords.length > 0
      ? [...RESEARCH_KEYWORDS, ...extraKeywords]
      : RESEARCH_KEYWORDS;

    if (!enabled) {
      api.logger?.info?.('[aco-research-anti-crawl-guard] disabled via config');
      return;
    }

    // Intercept sessions_spawn to inject anti-crawl guard into research task prompts
    api.on(
      'before_tool_call',
      (event, hookCtx) => {
        try {
          const toolName = String(event?.toolName || hookCtx?.toolName || '');
          if (toolName !== 'sessions_spawn') return null;

          const args = event?.params || {};
          const label = String(args.label || '');
          const prompt = String(args.prompt || '');

          if (excludeLabels.some((pat) => label.startsWith(pat))) return null;

          if (!hasResearchIntent(prompt, label)) return null;

          appendAuditLog({
            event: 'anti_crawl_injected',
            label,
            promptPreview: prompt.slice(0, 200),
            sessionKey: typeof hookCtx?.sessionKey === 'string' ? hookCtx.sessionKey : null,
          });

          return {
            modifyParams: {
              prompt: prompt + ANTI_CRAWL_INJECTION,
            },
          };
        } catch (e) {
          api.logger?.warn?.(`[aco-research-anti-crawl-guard] before_tool_call error: ${e.message}`);
          return null;
        }
      },
      { priority: 850 },
    );

    api.logger?.info?.('[aco-research-anti-crawl-guard] registered (v1.0.0)');
  },
};
