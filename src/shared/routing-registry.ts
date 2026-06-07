type RoleName = 'pm' | 'research' | 'architecture' | 'coding' | 'review' | 'ux';
type BuiltInRoleTag = 'coder' | 'auditor' | 'architect' | 'pm' | 'ux' | 'researcher';
type CodingTier = 'T1' | 'T2' | 'T3';
type AgentRuntime = 'acp' | 'subagent';
type NonCodingTier = 'research' | 'arch' | 'pm' | 'audit' | 'ux';

type RoleMap = Readonly<Record<RoleName, readonly string[]>>;
type RoleTagTaskTypes = Readonly<Record<BuiltInRoleTag, readonly string[]>>;
type AgentTierFallbackEntry = Readonly<{
  id: string;
  runtime: AgentRuntime;
  role: RoleName;
  tier: CodingTier | NonCodingTier;
}>;

export const ROLE_ALIASES: Readonly<Record<string, RoleName>> = Object.freeze({
  coding: 'coding',
  coder: 'coding',
  code: 'coding',
  development: 'coding',
  developer: 'coding',
  implement: 'coding',
  pm: 'pm',
  product: 'pm',
  spec: 'pm',
  requirements: 'pm',
  architecture: 'architecture',
  architect: 'architecture',
  ac: 'architecture',
  design: 'architecture',
  review: 'review',
  auditor: 'review',
  audit: 'review',
  ux: 'ux',
  research: 'research',
  researcher: 'research',
  analysis: 'research',
} satisfies Record<string, RoleName>);

export const ROLE_TAG_ALIASES: Readonly<Record<string, BuiltInRoleTag>> = Object.freeze({
  coding: 'coder',
  coder: 'coder',
  code: 'coder',
  development: 'coder',
  developer: 'coder',
  implement: 'coder',
  review: 'auditor',
  auditor: 'auditor',
  audit: 'auditor',
  architecture: 'architect',
  architect: 'architect',
  ac: 'architect',
  design: 'architect',
  research: 'researcher',
  researcher: 'researcher',
  analysis: 'researcher',
  pm: 'pm',
  product: 'pm',
  spec: 'pm',
  requirements: 'pm',
  ux: 'ux',
} satisfies Record<string, BuiltInRoleTag>);

export const ROLE_AGENT_FALLBACK: RoleMap = Object.freeze({
  pm: Object.freeze([]),
  research: Object.freeze([]),
  architecture: Object.freeze([]),
  coding: Object.freeze([]),
  review: Object.freeze([]),
  ux: Object.freeze([]),
});

export const ROLE_TASK_TYPES: RoleMap = Object.freeze({
  pm: Object.freeze(['spec', 'readme']),
  research: Object.freeze(['research']),
  architecture: Object.freeze(['architecture', 'ac', 'design']),
  coding: Object.freeze(['code', 'coding', 'refactoring', 'testing', 'bugfix']),
  review: Object.freeze(['audit', 'review', 'security']),
  ux: Object.freeze(['ux', 'ux_review', 'visual']),
});

export const ROLE_TAG_TASK_TYPES: RoleTagTaskTypes = Object.freeze({
  coder: Object.freeze(['coding', 'refactoring', 'testing', 'bugfix']),
  architect: Object.freeze(['architecture', 'design']),
  auditor: Object.freeze(['review', 'audit', 'security']),
  pm: Object.freeze(['requirements', 'spec', 'planning']),
  ux: Object.freeze(['ux_review', 'visual']),
  researcher: Object.freeze(['research', 'analysis']),
});

export const TASK_TYPE_EXPECTED_ROLE = Object.freeze({
  code: 'coding',
  coding: 'coding',
  refactoring: 'coding',
  testing: 'coding',
  bugfix: 'coding',
  spec: 'pm',
  requirements: 'pm',
  planning: 'pm',
  architecture: 'architecture',
  ac: 'architecture',
  design: 'architecture',
  research: 'research',
  analysis: 'research',
  audit: 'review',
  review: 'review',
  security: 'review',
  ux: 'ux',
  ux_review: 'ux',
  visual: 'ux',
  readme: 'pm',
} satisfies Record<string, RoleName>);

export const CODING_TIER_BY_AGENT_ID: Readonly<Record<string, CodingTier>> = Object.freeze({});

export const DEFAULT_AGENT_TIER_FALLBACK: readonly AgentTierFallbackEntry[] = Object.freeze([]);

export const HEALTH_SCAN_T1_AGENT_IDS = Object.freeze(
  Object.entries(CODING_TIER_BY_AGENT_ID)
    .filter(([, tier]) => tier === 'T1')
    .map(([id]) => id),
);

export function cloneArray<T>(value: readonly T[] | T[] | unknown): T[] {
  return Array.isArray(value) ? [...value] : [];
}

export function cloneRoleAgents(roleAgents: Readonly<Record<string, readonly string[]>> = ROLE_AGENT_FALLBACK): Record<string, string[]> {
  return Object.fromEntries(Object.entries(roleAgents).map(([role, agents]) => [role, cloneArray(agents)]));
}

export function cloneAgentTierFallback(): Array<{
  id: string;
  runtime: AgentRuntime;
  role: RoleName;
  tier: CodingTier | NonCodingTier;
}> {
  return DEFAULT_AGENT_TIER_FALLBACK.map((agent) => ({ ...agent }));
}

export function normalizeRole(role: unknown): RoleName | null {
  const value = String(role || '').trim().toLowerCase();
  return ROLE_ALIASES[value] ?? null;
}

export function normalizeRoleTag(role: unknown): string {
  const value = String(role || '').trim().toLowerCase();
  return ROLE_TAG_ALIASES[value] ?? value;
}

export function inferRoleByAgentId(_agentId: unknown): RoleName | null {
  return null;
}

export function inferTierByAgentId(_agentId: unknown): CodingTier | null {
  return null;
}

export function buildRoleTaskMapFromRoleAgents(
  roleAgents: Readonly<Record<string, readonly string[]>> | null = ROLE_AGENT_FALLBACK,
): Record<string, string[]> {
  const taskMap: Record<string, string[]> = {};
  const allAgents = new Set<string>();

  for (const [role, agents] of Object.entries(roleAgents || {})) {
    if (!Array.isArray(agents) || agents.length === 0) continue;
    agents.forEach((id) => allAgents.add(id));
    const taskTypes = ROLE_TASK_TYPES[role as RoleName] ?? [];
    for (const taskType of taskTypes) {
      if (!taskMap[taskType]) taskMap[taskType] = [];
      taskMap[taskType].push(...agents);
    }
  }

  if (allAgents.size > 0) taskMap['data-ops'] = [...allAgents];
  return taskMap;
}

export function buildTaskRoleMappingFromRoleTags(
  roleTagTaskTypes: Readonly<Record<string, readonly string[]>> | null = ROLE_TAG_TASK_TYPES,
): Record<string, string[]> {
  const mapping: Record<string, string[]> = {};
  for (const [roleTag, taskTypes] of Object.entries(roleTagTaskTypes || {})) {
    for (const taskType of taskTypes || []) {
      if (!mapping[taskType]) mapping[taskType] = [];
      mapping[taskType].push(roleTag);
    }
  }
  return mapping;
}

export function getValidRoles(): Set<string> {
  return new Set(Object.keys(ROLE_AGENT_FALLBACK));
}
