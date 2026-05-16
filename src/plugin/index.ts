/**
 * ACO Plugin Export — FR-Z04 AC2/AC4
 *
 * Usage:
 *   import { OpenClawAdapter } from '@self-evolving-harness/aco/plugin';
 *
 *   const adapter = new OpenClawAdapter({
 *     gatewayUrl: 'http://localhost:4141',
 *   });
 *
 *   scheduler.setHostAdapter(adapter);
 */

export { OpenClawAdapter } from '../adapter/openclaw-adapter.js';
export type { OpenClawAdapterConfig } from '../adapter/openclaw-adapter.js';

// Re-export HostAdapter interface for custom adapter implementations (FR-Z04 AC3)
export type {
  HostAdapter,
  HostEvent,
  SpawnOptions,
  SessionState,
  DiscoveredAgent,
} from '../types/index.js';
