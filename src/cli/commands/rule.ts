/**
 * aco rule — 规则管理
 * FR-Z02 AC1: rule 子命令
 * FR-B04: 规则热更新
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hasFlag, getFlagValue } from '../parse-args.js';
import { getDataDir, fileExists, formatTable } from './shared.js';

interface RuleDef {
  ruleId: string;
  priority: number;
  description?: string;
  enabled: boolean;
  condition: {
    taskType?: string | string[];
    agentId?: string | string[];
    promptPattern?: string;
    roleRequired?: string | string[];
  };
  action: 'allow' | 'block' | 'warn' | 'route';
  routeTarget?: string;
  createdAt: string;
}

const HELP = `
aco rule — 调度规则管理

Usage:
  aco rule list                 列出所有规则
  aco rule show <ruleId>        查看规则详情
  aco rule add                  添加规则（FR-B04 AC1）
  aco rule remove <ruleId>      移除规则
  aco rule enable <ruleId>      启用规则
  aco rule disable <ruleId>     禁用规则
  aco rule load <file>          从文件批量加载规则（FR-B04 AC3）

Options:
  --help              显示帮助
  --json              JSON 格式输出
  --action <action>   规则动作（allow/block/warn/route）
  --priority <n>      规则优先级（数字越大越先匹配）
  --task-type <type>  匹配的任务类型
  --role <role>       要求的角色
  --agent <id>        匹配的 agentId
  --pattern <regex>   prompt 正则匹配
  --desc <text>       规则描述
  --route-to <id>     路由目标 agentId

Examples:
  aco rule list
  aco rule add --action block --task-type audit --role auditor --desc "审计任务必须由 auditor 执行"
  aco rule enable rule-abc123
  aco rule load rules.json
`.trim();

function getRulesPath(): string {
  return join(getDataDir(), 'rules.json');
}

async function loadRules(): Promise<RuleDef[]> {
  const path = getRulesPath();
  if (!(await fileExists(path))) return [];
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as RuleDef[];
}

async function saveRules(rules: RuleDef[]): Promise<void> {
  const dir = getDataDir();
  await mkdir(dir, { recursive: true });
  const path = getRulesPath();
  await writeFile(path, JSON.stringify(rules, null, 2), 'utf-8');
}

export async function ruleCommand(args: string[]): Promise<number> {
  if (hasFlag(args, 'help') || args.length === 0) {
    console.log(HELP);
    return 0;
  }

  const subcommand = args[0];
  const jsonOutput = hasFlag(args, 'json');

  switch (subcommand) {
    case 'list':
      return await listRules(jsonOutput);
    case 'show':
      return await showRule(args[1], jsonOutput);
    case 'add':
      return await addRule(args.slice(1));
    case 'remove':
      return await removeRule(args[1]);
    case 'enable':
      return await toggleRule(args[1], true);
    case 'disable':
      return await toggleRule(args[1], false);
    case 'load':
      return await loadRulesFromFile(args[1], jsonOutput);
    default:
      console.error(`Error [RULE_UNKNOWN_CMD]: Unknown subcommand '${subcommand}'`);
      console.error(`Suggestion: Run 'aco rule --help' for usage.`);
      return 1;
  }
}

async function listRules(json: boolean): Promise<number> {
  const rules = await loadRules();

  if (json) {
    console.log(JSON.stringify(rules, null, 2));
    return 0;
  }

  if (rules.length === 0) {
    console.log('No rules defined. Use "aco rule add" to create one.');
    return 0;
  }

  const headers = ['Rule ID', 'Action', 'Priority', 'Enabled', 'Description'];
  const rows = rules.map(r => [
    r.ruleId,
    r.action,
    String(r.priority),
    r.enabled ? '✓' : '✗',
    (r.description ?? '-').slice(0, 30),
  ]);
  console.log(formatTable(headers, rows));
  return 0;
}

async function showRule(ruleId: string | undefined, json: boolean): Promise<number> {
  if (!ruleId) {
    console.error('Error [RULE_MISSING_ID]: Please specify a rule ID.');
    console.error('Suggestion: Run "aco rule list" to see available rules.');
    return 1;
  }

  const rules = await loadRules();
  const rule = rules.find(r => r.ruleId === ruleId);

  if (!rule) {
    console.error(`Error [RULE_NOT_FOUND]: Rule '${ruleId}' not found.`);
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(rule, null, 2));
    return 0;
  }

  console.log(`Rule: ${rule.ruleId}`);
  console.log(`  Action:      ${rule.action}`);
  console.log(`  Priority:    ${rule.priority}`);
  console.log(`  Enabled:     ${rule.enabled}`);
  if (rule.description) console.log(`  Description: ${rule.description}`);
  if (rule.routeTarget) console.log(`  Route to:    ${rule.routeTarget}`);
  console.log(`  Condition:`);
  if (rule.condition.taskType) console.log(`    Task type: ${JSON.stringify(rule.condition.taskType)}`);
  if (rule.condition.agentId) console.log(`    Agent ID:  ${JSON.stringify(rule.condition.agentId)}`);
  if (rule.condition.roleRequired) console.log(`    Role:      ${JSON.stringify(rule.condition.roleRequired)}`);
  if (rule.condition.promptPattern) console.log(`    Pattern:   ${rule.condition.promptPattern}`);
  console.log(`  Created:     ${rule.createdAt}`);
  return 0;
}

async function addRule(args: string[]): Promise<number> {
  const action = getFlagValue(args, 'action');
  if (!action || !['allow', 'block', 'warn', 'route'].includes(action)) {
    console.error('Error [RULE_INVALID_ACTION]: --action is required (allow/block/warn/route).');
    return 1;
  }

  const priority = parseInt(getFlagValue(args, 'priority') ?? '50', 10);
  const taskType = getFlagValue(args, 'task-type');
  const role = getFlagValue(args, 'role');
  const agentId = getFlagValue(args, 'agent');
  const pattern = getFlagValue(args, 'pattern');
  const desc = getFlagValue(args, 'desc');
  const routeTo = getFlagValue(args, 'route-to');

  const condition: RuleDef['condition'] = {};
  if (taskType) condition.taskType = taskType;
  if (role) condition.roleRequired = role;
  if (agentId) condition.agentId = agentId;
  if (pattern) condition.promptPattern = pattern;

  const ruleId = `rule-${Date.now().toString(36)}`;
  const rule: RuleDef = {
    ruleId,
    priority,
    description: desc,
    enabled: true,
    condition,
    action: action as RuleDef['action'],
    routeTarget: routeTo,
    createdAt: new Date().toISOString(),
  };

  const rules = await loadRules();
  rules.push(rule);
  rules.sort((a, b) => b.priority - a.priority);
  await saveRules(rules);

  console.log(`✓ Rule created: ${ruleId}`);
  console.log(`  Action: ${action}, Priority: ${priority}`);
  if (desc) console.log(`  Description: ${desc}`);
  return 0;
}

async function removeRule(ruleId: string | undefined): Promise<number> {
  if (!ruleId) {
    console.error('Error [RULE_MISSING_ID]: Please specify a rule ID to remove.');
    return 1;
  }

  const rules = await loadRules();
  const idx = rules.findIndex(r => r.ruleId === ruleId);

  if (idx === -1) {
    console.error(`Error [RULE_NOT_FOUND]: Rule '${ruleId}' not found.`);
    return 1;
  }

  rules.splice(idx, 1);
  await saveRules(rules);
  console.log(`✓ Rule '${ruleId}' removed.`);
  return 0;
}

async function toggleRule(ruleId: string | undefined, enabled: boolean): Promise<number> {
  if (!ruleId) {
    console.error('Error [RULE_MISSING_ID]: Please specify a rule ID.');
    return 1;
  }

  const rules = await loadRules();
  const rule = rules.find(r => r.ruleId === ruleId);

  if (!rule) {
    console.error(`Error [RULE_NOT_FOUND]: Rule '${ruleId}' not found.`);
    return 1;
  }

  rule.enabled = enabled;
  await saveRules(rules);
  console.log(`✓ Rule '${ruleId}' ${enabled ? 'enabled' : 'disabled'}.`);
  return 0;
}

async function loadRulesFromFile(filePath: string | undefined, json: boolean): Promise<number> {
  if (!filePath) {
    console.error('Error [RULE_MISSING_FILE]: Please specify a file path.');
    console.error('Suggestion: aco rule load rules.json');
    return 1;
  }

  if (!(await fileExists(filePath))) {
    console.error(`Error [RULE_FILE_NOT_FOUND]: File '${filePath}' not found.`);
    return 1;
  }

  const content = await readFile(filePath, 'utf-8');
  let imported: RuleDef[];

  try {
    const parsed = JSON.parse(content);
    imported = Array.isArray(parsed) ? parsed : (parsed.rules ?? []);
  } catch (err) {
    console.error(`Error [RULE_PARSE_ERROR]: Failed to parse '${filePath}': ${(err as Error).message}`);
    return 1;
  }

  const rules = await loadRules();
  let added = 0;

  for (const r of imported) {
    if (!r.ruleId) r.ruleId = `rule-${Date.now().toString(36)}-${added}`;
    if (!r.createdAt) r.createdAt = new Date().toISOString();
    if (r.enabled === undefined) r.enabled = true;
    rules.push(r);
    added++;
  }

  rules.sort((a, b) => b.priority - a.priority);
  await saveRules(rules);

  if (json) {
    console.log(JSON.stringify({ file: filePath, added }, null, 2));
    return 0;
  }

  console.log(`✓ Loaded ${added} rules from '${filePath}'.`);
  return 0;
}
