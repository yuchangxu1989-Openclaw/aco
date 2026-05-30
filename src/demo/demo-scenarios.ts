/**
 * DemoScenarios — 预定义演示场景数据
 * FR-K12: Demo 命令开箱即用
 */

export interface DemoAgent {
  agentId: string;
  tier: 'T1' | 'T2' | 'T3';
  roles: string[];
}

export interface DemoTask {
  taskId: string;
  label: string;
  description: string;
  priority: number;
  timeout: number;
  expectedRole: string;
  willFail?: boolean;
  failTokens?: number;
}

export interface DemoBlockedTask {
  taskId: string;
  label: string;
  description: string;
  blockReason: string;
  ruleId: string;
}

export interface DemoRule {
  id: string;
  pattern: string;
  action: 'block';
  description: string;
}

export interface DemoScenario {
  agents: DemoAgent[];
  tasks: DemoTask[];
  blockedTasks: DemoBlockedTask[];
  rules: DemoRule[];
}

export const DEFAULT_DEMO_SCENARIO: DemoScenario = {
  agents: [
    { agentId: 'demo-coder', tier: 'T1', roles: ['coder'] },
    { agentId: 'demo-auditor', tier: 'T2', roles: ['auditor'] },
    { agentId: 'demo-researcher', tier: 'T2', roles: ['researcher'] },
  ],
  tasks: [
    {
      taskId: 'task-001',
      label: 'implement-login',
      description: '实现用户登录功能',
      priority: 80,
      timeout: 600,
      expectedRole: 'coder',
      willFail: true,
      failTokens: 500,
    },
    {
      taskId: 'task-002',
      label: 'research-competitors',
      description: '调研竞品方案',
      priority: 50,
      timeout: 1200,
      expectedRole: 'researcher',
    },
    {
      taskId: 'task-003',
      label: 'code-audit-auth',
      description: '代码审计',
      priority: 60,
      timeout: 600,
      expectedRole: 'auditor',
    },
  ],
  blockedTasks: [
    {
      taskId: 'task-004',
      label: 'deploy-prod-v2',
      description: '部署到生产环境',
      blockReason: '匹配 label 模式 "deploy-prod*"',
      ruleId: 'block-prod-deploy',
    },
  ],
  rules: [
    {
      id: 'block-prod-deploy',
      pattern: 'deploy-prod*',
      action: 'block',
      description: '禁止直接部署生产环境',
    },
  ],
};
