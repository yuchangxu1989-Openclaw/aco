/**
 * Migration module — 域 Z：版本与升级
 * FR-Z05: 平滑升级，不丢失运行时状态
 */

export { MigrationManager } from './migration-manager.js';
export type {
  MigrationStep,
  MigrationRecord,
  MigrationState,
  MigrationFileSystem,
  MigrationManagerConfig,
} from './migration-manager.js';
