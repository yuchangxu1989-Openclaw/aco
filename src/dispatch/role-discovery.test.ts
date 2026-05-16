import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from '../event/event-bus.js';
import { RoleDiscovery } from './role-discovery.js';
import type { HostAdapter, DiscoveredAgent } from '../types/index.js';

function createMockAdapter(agents: DiscoveredAgent[]): HostAdapter {
  return {
    spawnTask: vi.fn(),
    killTask: vi.fn(),
    steerTask: vi.fn(),
    getTaskStatus: vi.fn(),
    getAgentStatus: vi.fn(),
    getSessionState: vi.fn(),
    subscribeEvents: vi.fn(),
    discoverAgents: vi.fn().mockResolvedValue(agents),
  };
}

describe('RoleDiscovery', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  describe('discover (AC1+AC2)', () => {
    it('should build RoleAgentsMap from discovered agents with roles', async () => {
      const agents: DiscoveredAgent[] = [
        { agentId: 'agent-a', roles: ['coder'], model: 'claude-sonnet' },
        { agentId: 'agent-b', roles: ['coder', 'architect'], model: 'claude-opus' },
        { agentId: 'agent-c', roles: ['auditor'], model: 'gpt-4o' },
      ];
      const adapter = createMockAdapter(agents);
      const discovery = new RoleDiscovery(eventBus, adapter);

      const result = await discovery.discover();

      expect(result.roleAgents.get('coder')).toEqual(['agent-a', 'agent-b']);
      expect(result.roleAgents.get('architect')).toEqual(['agent-b']);
      expect(result.roleAgents.get('auditor')).toEqual(['agent-c']);
      expect(result.agentCount).toBe(3);
    });

    it('should normalize spec role names to internal RoleTags', async () => {
      const agents: DiscoveredAgent[] = [
        { agentId: 'dev-01', roles: ['coding'], model: 'claude-sonnet' },
        { agentId: 'rev-01', roles: ['review'], model: 'gpt-4o' },
        { agentId: 'arch-01', roles: ['architecture'], model: 'claude-opus' },
        { agentId: 'res-01', roles: ['research'], model: 'gpt-4o' },
      ];
      const adapter = createMockAdapter(agents);
      const discovery = new RoleDiscovery(eventBus, adapter);

      const result = await discovery.discover();

      // "coding" → "coder", "review" → "auditor", etc.
      expect(result.roleAgents.get('coder')).toEqual(['dev-01']);
      expect(result.roleAgents.get('auditor')).toEqual(['rev-01']);
      expect(result.roleAgents.get('architect')).toEqual(['arch-01']);
      expect(result.roleAgents.get('researcher')).toEqual(['res-01']);
    });

    it('should not contain hardcoded Agent IDs in mappings (AC2)', async () => {
      const agents: DiscoveredAgent[] = [
        { agentId: 'custom-agent-xyz', roles: ['pm'] },
      ];
      const adapter = createMockAdapter(agents);
      const discovery = new RoleDiscovery(eventBus, adapter);

      const result = await discovery.discover();

      // The mapping should only contain agents from discovery, not hardcoded ones
      expect(result.roleAgents.get('pm')).toEqual(['custom-agent-xyz']);
      expect(result.agentCount).toBe(1);
    });

    it('should build RoleTaskMap from default mapping', async () => {
      const adapter = createMockAdapter([{ agentId: 'a', roles: ['coder'] }]);
      const discovery = new RoleDiscovery(eventBus, adapter);

      const result = await discovery.discover();

      expect(result.roleTaskMap.get('coding')).toEqual(['coder']);
      expect(result.roleTaskMap.get('audit')).toEqual(['auditor']);
      expect(result.roleTaskMap.get('architecture')).toEqual(['architect']);
      expect(result.roleTaskMap.get('research')).toEqual(['researcher']);
    });
  });

  describe('getEnforcementMode (AC3)', () => {
    it('should return skip when 0 agents discovered', async () => {
      const adapter = createMockAdapter([]);
      const discovery = new RoleDiscovery(eventBus, adapter);

      await discovery.discover();

      expect(discovery.getEnforcementMode()).toBe('skip');
    });

    it('should return skip when 1 agent discovered', async () => {
      const adapter = createMockAdapter([{ agentId: 'solo', roles: ['coder'] }]);
      const discovery = new RoleDiscovery(eventBus, adapter);

      await discovery.discover();

      expect(discovery.getEnforcementMode()).toBe('skip');
    });

    it('should return warn when multiple agents but none have roles', async () => {
      const agents: DiscoveredAgent[] = [
        { agentId: 'agent-1' },
        { agentId: 'agent-2' },
        { agentId: 'agent-3' },
      ];
      const adapter = createMockAdapter(agents);
      const discovery = new RoleDiscovery(eventBus, adapter);

      await discovery.discover();

      expect(discovery.getEnforcementMode()).toBe('warn');
    });

    it('should return enforce when some agents have roles', async () => {
      const agents: DiscoveredAgent[] = [
        { agentId: 'agent-1', roles: ['coder'] },
        { agentId: 'agent-2', roles: [] },
        { agentId: 'agent-3' },
      ];
      const adapter = createMockAdapter(agents);
      const discovery = new RoleDiscovery(eventBus, adapter);

      await discovery.discover();

      expect(discovery.getEnforcementMode()).toBe('enforce');
    });
  });

  describe('getAgentTier (AC4)', () => {
    it('should infer T1 for opus/o1/gpt-4 models', async () => {
      const agents: DiscoveredAgent[] = [
        { agentId: 'opus-agent', roles: ['coder'], model: 'claude-opus-4' },
      ];
      const adapter = createMockAdapter(agents);
      const discovery = new RoleDiscovery(eventBus, adapter);

      await discovery.discover();

      expect(discovery.getAgentTier('opus-agent')).toBe('T1');
    });

    it('should infer T2 for sonnet/gpt-4o models', async () => {
      const agents: DiscoveredAgent[] = [
        { agentId: 'sonnet-agent', roles: ['coder'], model: 'claude-sonnet-4' },
      ];
      const adapter = createMockAdapter(agents);
      const discovery = new RoleDiscovery(eventBus, adapter);

      await discovery.discover();

      expect(discovery.getAgentTier('sonnet-agent')).toBe('T2');
    });

    it('should infer T2 for gpt-4o (not T1)', async () => {
      const agents: DiscoveredAgent[] = [
        { agentId: 'gpt4o-agent', roles: ['auditor'], model: 'gpt-4o' },
      ];
      const adapter = createMockAdapter(agents);
      const discovery = new RoleDiscovery(eventBus, adapter);

      await discovery.discover();

      expect(discovery.getAgentTier('gpt4o-agent')).toBe('T2');
    });

    it('should infer T3 for haiku/mini models', async () => {
      const agents: DiscoveredAgent[] = [
        { agentId: 'haiku-agent', roles: ['coder'], model: 'claude-haiku-3' },
      ];
      const adapter = createMockAdapter(agents);
      const discovery = new RoleDiscovery(eventBus, adapter);

      await discovery.discover();

      expect(discovery.getAgentTier('haiku-agent')).toBe('T3');
    });

    it('should infer T4 for agents without model (subagent)', async () => {
      const agents: DiscoveredAgent[] = [
        { agentId: 'sub-agent', roles: ['coder'] },
      ];
      const adapter = createMockAdapter(agents);
      const discovery = new RoleDiscovery(eventBus, adapter);

      await discovery.discover();

      expect(discovery.getAgentTier('sub-agent')).toBe('T4');
    });

    it('should return undefined for unknown agent', async () => {
      const adapter = createMockAdapter([{ agentId: 'known', roles: ['coder'] }]);
      const discovery = new RoleDiscovery(eventBus, adapter);

      await discovery.discover();

      expect(discovery.getAgentTier('unknown-agent')).toBeUndefined();
    });
  });

  describe('refresh (AC5)', () => {
    it('should update mappings when agents change', async () => {
      const initialAgents: DiscoveredAgent[] = [
        { agentId: 'agent-1', roles: ['coder'], model: 'sonnet' },
      ];
      const adapter = createMockAdapter(initialAgents);
      const discovery = new RoleDiscovery(eventBus, adapter);

      await discovery.discover();
      expect(discovery.getSnapshot().agentCount).toBe(1);

      // Simulate config change: new agent added
      const updatedAgents: DiscoveredAgent[] = [
        { agentId: 'agent-1', roles: ['coder'], model: 'sonnet' },
        { agentId: 'agent-2', roles: ['auditor'], model: 'opus' },
      ];
      (adapter.discoverAgents as ReturnType<typeof vi.fn>).mockResolvedValue(updatedAgents);

      const result = await discovery.refresh();

      expect(result.agentCount).toBe(2);
      expect(result.roleAgents.get('auditor')).toEqual(['agent-2']);
    });

    it('should emit audit event on refresh', async () => {
      const adapter = createMockAdapter([{ agentId: 'a', roles: ['coder'] }]);
      const discovery = new RoleDiscovery(eventBus, adapter);

      const events: unknown[] = [];
      eventBus.on('audit', (e) => { events.push(e); });

      await discovery.discover();
      await discovery.refresh();

      // Should have events from both discover and refresh
      expect(events.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getSnapshot (AC6)', () => {
    it('should return complete mapping after discover', async () => {
      const agents: DiscoveredAgent[] = [
        { agentId: 'dev', roles: ['coder'], model: 'sonnet' },
        { agentId: 'rev', roles: ['auditor'], model: 'opus' },
      ];
      const adapter = createMockAdapter(agents);
      const discovery = new RoleDiscovery(eventBus, adapter);

      await discovery.discover();
      const snapshot = discovery.getSnapshot();

      expect(snapshot.agentCount).toBe(2);
      expect(snapshot.mode).toBe('enforce');
      expect(snapshot.rolesFound).toContain('coder');
      expect(snapshot.rolesFound).toContain('auditor');
      expect(snapshot.timestamp).toBeGreaterThan(0);
      expect(snapshot.roleAgents.get('coder')).toEqual(['dev']);
      expect(snapshot.roleAgents.get('auditor')).toEqual(['rev']);
    });
  });

  describe('checkRoleMatch', () => {
    it('should allow all in skip mode', async () => {
      const adapter = createMockAdapter([{ agentId: 'solo', roles: ['coder'] }]);
      const discovery = new RoleDiscovery(eventBus, adapter);

      await discovery.discover();

      const result = discovery.checkRoleMatch('audit', 'solo');
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('skipped');
    });

    it('should allow matching role in enforce mode', async () => {
      const agents: DiscoveredAgent[] = [
        { agentId: 'dev', roles: ['coder'], model: 'sonnet' },
        { agentId: 'rev', roles: ['auditor'], model: 'opus' },
      ];
      const adapter = createMockAdapter(agents);
      const discovery = new RoleDiscovery(eventBus, adapter);

      await discovery.discover();

      const result = discovery.checkRoleMatch('coding', 'dev');
      expect(result.allowed).toBe(true);
    });

    it('should block mismatched role in enforce mode', async () => {
      const agents: DiscoveredAgent[] = [
        { agentId: 'dev', roles: ['coder'], model: 'sonnet' },
        { agentId: 'rev', roles: ['auditor'], model: 'opus' },
      ];
      const adapter = createMockAdapter(agents);
      const discovery = new RoleDiscovery(eventBus, adapter);

      await discovery.discover();

      const result = discovery.checkRoleMatch('audit', 'dev');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('mismatch');
    });

    it('should warn but allow mismatched role in warn mode', async () => {
      const agents: DiscoveredAgent[] = [
        { agentId: 'agent-1', model: 'sonnet' },
        { agentId: 'agent-2', model: 'opus' },
      ];
      const adapter = createMockAdapter(agents);
      const discovery = new RoleDiscovery(eventBus, adapter);

      await discovery.discover();
      expect(discovery.getEnforcementMode()).toBe('warn');

      // In warn mode, unknown agents are allowed
      const result = discovery.checkRoleMatch('coding', 'agent-1');
      expect(result.allowed).toBe(true);
    });

    it('should allow task types with no role requirement defined', async () => {
      const agents: DiscoveredAgent[] = [
        { agentId: 'dev', roles: ['coder'], model: 'sonnet' },
        { agentId: 'rev', roles: ['auditor'], model: 'opus' },
      ];
      const adapter = createMockAdapter(agents);
      const discovery = new RoleDiscovery(eventBus, adapter);

      await discovery.discover();

      const result = discovery.checkRoleMatch('unknown-task-type', 'dev');
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('No role requirement');
    });

    it('should block unknown agent in enforce mode', async () => {
      const agents: DiscoveredAgent[] = [
        { agentId: 'dev', roles: ['coder'], model: 'sonnet' },
        { agentId: 'rev', roles: ['auditor'], model: 'opus' },
      ];
      const adapter = createMockAdapter(agents);
      const discovery = new RoleDiscovery(eventBus, adapter);

      await discovery.discover();

      const result = discovery.checkRoleMatch('coding', 'ghost-agent');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not found');
    });
  });

  describe('dispose', () => {
    it('should clear refresh timer', async () => {
      const adapter = createMockAdapter([{ agentId: 'a', roles: ['coder'] }]);
      const discovery = new RoleDiscovery(eventBus, adapter, { refreshIntervalMs: 1000 });

      await discovery.discover();
      // Should not throw
      discovery.dispose();
    });
  });

  describe('custom config', () => {
    it('should use custom task role mapping', async () => {
      const agents: DiscoveredAgent[] = [
        { agentId: 'ops', roles: ['devops'], model: 'sonnet' },
        { agentId: 'dev', roles: ['coder'], model: 'sonnet' },
      ];
      const adapter = createMockAdapter(agents);
      const discovery = new RoleDiscovery(eventBus, adapter, {
        defaultTaskRoleMapping: {
          deploy: ['devops'],
          coding: ['coder'],
        },
      });

      await discovery.discover();

      const result1 = discovery.checkRoleMatch('deploy', 'ops');
      expect(result1.allowed).toBe(true);

      const result2 = discovery.checkRoleMatch('deploy', 'dev');
      expect(result2.allowed).toBe(false);
    });
  });
});
