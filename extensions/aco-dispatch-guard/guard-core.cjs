'use strict';

const fs = require('fs');
const path = require('path');

const OPENCLAW_CONFIG = '/root/.openclaw/openclaw.json';
const DEFAULT_EVENTS_PATH = '/root/.openclaw/workspace/logs/dispatch-guard-events.jsonl';

const PUBLISH_PLATFORM_RULES = [
  {
    ruleId: 'dispatch.publish.three_platform_check',
    promptPatterns: [
      /npm.*publish|发布.*npm|publish.*npm/i,
      /clawhub.*publish|发布.*clawhub/i,
      /发布.*0\.[0-9]/i,
      /publish.*0\.[0-9]/i,
    ],
    requiredKeywords: [
      { pattern: /github|独立仓|independent.*repo/i, label: 'GitHub 独立仓库' },
    ],
    warnMessage: '发布任务缺少 GitHub 独立仓库推送步骤。三平台同步铁律：npm + ClawHub + GitHub 独立仓库缺一不可。',
  },
];

// ── Role-Task Matching (shared with index.js) ──────────────────────
const ROLE_TASK_MAP = {
  spec: ['pm-01', 'pm-02'],
  ac: ['sa-01', 'sa-02'],
  code: ['cc', 'free-code', 'opencode', 'codex', 'hermes', 'dev-01', 'dev-02'],
  audit: ['audit-01', 'audit-02'],
  ux: ['ux-01'],
  readme: ['pm-01', 'pm-02'],
};

const TASK_TYPE_PATTERNS = [
  { type: 'spec',  patterns: [/spec/i, /product-requirements/i, /FR-/i, /需求/] },
  { type: 'ac',    patterns: [/AC-/i, /验收/, /架构文档/, /arc42/i] },
  { type: 'audit', patterns: [/audit/i, /审计/, /review/i] },
  { type: 'readme', patterns: [/README/i] },
];

function detectTaskType(text) {
  for (const { type, patterns } of TASK_TYPE_PATTERNS) {
    if (patterns.some((re) => re.test(text))) return type;
  }
  return 'code';
}

const TASK_ROUTING_RULES = [
  {
    ruleId: 'dispatch.routing.spec_writing',
    promptPatterns: [
      /写入.*spec|写入.*product-requirements/i,
      /spec.*回灌|回灌.*spec/i,
      /新增.*FR-|追加.*FR-|补充.*FR-/i,
      /域\s*[A-Z].*开箱|域\s*[A-Z].*商用/i,
      /产品规格.*写作|spec.*backfill/i,
    ],
    allowedAgents: ['pm-01', 'pm-02', 'codex'],
    blockMessage: 'spec 写作任务必须派给 pm 池（pm-01/pm-02/codex），当前 agentId={agentId} 不在允许列表',
  },
  {
    ruleId: 'dispatch.routing.audit_independence',
    promptPatterns: [
      /审计任务|质量审计|代码审查|安全审查/i,
      /audit.*task|quality.*audit|code.*review/i,
    ],
    allowedAgents: ['audit-01', 'audit-02', 'codex'],
    blockMessage: '审计任务必须派给审计池（audit-01/audit-02/codex），当前 agentId={agentId} 不在允许列表',
  },
];

function nowIso() {
  return new Date().toISOString();
}

function readOpenclawConfig() {
  return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));
}

function listAgentIds() {
  const cfg = readOpenclawConfig();
  return new Set((cfg.agents?.list || []).map((x) => x?.id).filter(Boolean));
}

function inferRuleId(errorMessage = '') {
  if (/missing agentId/.test(errorMessage)) return 'dispatch.agent.required';
  if (/agentId .* not in openclaw\.json/.test(errorMessage)) return 'dispatch.agent.not_in_config';
  if (/agentId main is forbidden/.test(errorMessage)) return 'dispatch.agent.main_forbidden';
  if (/prompt is required/.test(errorMessage)) return 'dispatch.prompt.required';
  if (/timeoutSec/.test(errorMessage)) return 'dispatch.timeout.below_minimum';
  return 'dispatch.unknown';
}

function appendAuditEvent(entry = {}, eventsPath = DEFAULT_EVENTS_PATH) {
  const rec = {
    timestamp: nowIso(),
    pluginId: 'agent-dispatch-guard',
    ...entry,
  };
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  fs.appendFileSync(eventsPath, `${JSON.stringify(rec)}\n`);
  return rec;
}

function validateEnqueuePayload(payload = {}, opts = {}) {
  const eventsPath = opts.eventsPath || DEFAULT_EVENTS_PATH;
  const source = opts.source || 'unknown';

  const agentId = String(payload.agentId || '').trim();
  const prompt = String(payload.prompt || '').trim();
  const timeoutSec = Number(payload.timeoutSec || 0);

  let auditLogged = false;

  try {
    if (!agentId) throw new Error('enqueue payload missing agentId');
    if (agentId === 'main') throw new Error('agentId main is forbidden for dispatch');

    const agents = listAgentIds();
    if (!agents.has(agentId)) {
      throw new Error(`agentId ${agentId} not in openclaw.json agents.list`);
    }

    if (!prompt) throw new Error('enqueue payload prompt is required');
    if (!Number.isFinite(timeoutSec) || timeoutSec < 600) {
      throw new Error(`timeoutSec ${timeoutSec} below minimum 600`);
    }

    for (const rule of TASK_ROUTING_RULES) {
      const matched = rule.promptPatterns.some((re) => re.test(prompt));
      if (matched && !rule.allowedAgents.includes(agentId)) {
        const msg = rule.blockMessage.replace('{agentId}', agentId);
        appendAuditEvent({
          decision: 'block',
          ruleId: rule.ruleId,
          reason: msg,
          source,
          agentId,
          timeoutSec,
        }, eventsPath);
        auditLogged = true;
        throw new Error(msg);
      }
    }

    for (const rule of PUBLISH_PLATFORM_RULES) {
      const isPublishTask = rule.promptPatterns.some((re) => re.test(prompt));
      if (isPublishTask) {
        for (const kw of rule.requiredKeywords) {
          if (!kw.pattern.test(prompt)) {
            appendAuditEvent({
              decision: 'warn',
              ruleId: rule.ruleId,
              reason: `${rule.warnMessage} 缺少: ${kw.label}`,
              source,
              agentId,
              timeoutSec,
            }, eventsPath);
          }
        }
      }
    }

    appendAuditEvent({
      decision: 'allow',
      ruleId: 'dispatch.enqueue.valid',
      reason: 'payload validated',
      source,
      agentId,
      timeoutSec,
    }, eventsPath);

    return {
      ok: true,
      agentId,
      timeoutSec,
    };
  } catch (err) {
    if (!auditLogged) {
      const reason = String(err?.message || err);
      appendAuditEvent({
        decision: 'block',
        ruleId: inferRuleId(reason),
        reason,
        source,
        agentId: agentId || null,
        timeoutSec: Number.isFinite(timeoutSec) ? timeoutSec : null,
      }, eventsPath);
    }
    throw err;
  }
}

module.exports = {
  validateEnqueuePayload,
  appendAuditEvent,
  inferRuleId,
  detectTaskType,
  ROLE_TASK_MAP,
};
