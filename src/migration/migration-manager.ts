/**
 * MigrationManager — 域 Z：版本与升级
 * FR-Z05: 平滑升级，不丢失运行时状态
 *
 * AC1: npm update 后自动检测数据格式变更并执行迁移
 * AC2: 迁移前自动备份当前数据
 * AC3: 迁移失败时自动回滚到备份
 * AC4: CLI 命令 `aco version` 展示当前版本和可用更新
 */

import { EventBus } from '../event/event-bus.js';

// --- Types ---

export interface MigrationStep {
  /** Semantic version this migration targets (e.g. "0.5.0") */
  version: string;
  /** Human-readable description */
  description: string;
  /** Execute the migration. Receives the data directory path. */
  up(dataDir: string, fs: MigrationFileSystem): Promise<void>;
  /** Rollback the migration (best-effort). */
  down?(dataDir: string, fs: MigrationFileSystem): Promise<void>;
}

export interface MigrationRecord {
  version: string;
  appliedAt: string;
  success: boolean;
  error?: string;
}

export interface MigrationState {
  /** Current data schema version */
  schemaVersion: string;
  /** History of applied migrations */
  history: MigrationRecord[];
}

export interface MigrationFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  copyDir(src: string, dest: string): Promise<void>;
  removeDir(path: string): Promise<void>;
  listFiles(path: string): Promise<string[]>;
}

export interface MigrationManagerConfig {
  /** Data directory path (default: .aco) */
  dataDir: string;
  /** Current package version */
  currentVersion: string;
  /** Whether to auto-run migrations on init */
  autoMigrate: boolean;
}

// --- Helpers ---

/**
 * Compare two semver strings. Returns -1, 0, or 1.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

// --- MigrationManager ---

export class MigrationManager {
  private config: MigrationManagerConfig;
  private eventBus: EventBus;
  private fs?: MigrationFileSystem;
  private migrations: MigrationStep[] = [];
  private state: MigrationState = { schemaVersion: '0.0.0', history: [] };

  constructor(eventBus: EventBus, config: Partial<MigrationManagerConfig> = {}) {
    this.eventBus = eventBus;
    this.config = {
      dataDir: config.dataDir ?? '.aco',
      currentVersion: config.currentVersion ?? '0.5.1',
      autoMigrate: config.autoMigrate ?? true,
    };
  }

  /**
   * Set the file system implementation (for testability)
   */
  setFileSystem(fs: MigrationFileSystem): void {
    this.fs = fs;
  }

  /**
   * Register a migration step
   */
  registerMigration(step: MigrationStep): void {
    this.migrations.push(step);
    // Keep sorted by version
    this.migrations.sort((a, b) => compareSemver(a.version, b.version));
  }

  /**
   * FR-Z05 AC1: Detect and run pending migrations
   */
  async initialize(): Promise<{ migrated: boolean; from: string; to: string; errors: string[] }> {
    if (!this.fs) {
      return { migrated: false, from: '0.0.0', to: this.config.currentVersion, errors: ['No file system configured'] };
    }

    await this.loadState();
    const from = this.state.schemaVersion;

    if (!this.config.autoMigrate) {
      return { migrated: false, from, to: this.config.currentVersion, errors: [] };
    }

    const pending = this.getPendingMigrations();
    if (pending.length === 0) {
      // Update schema version even if no migrations needed
      if (compareSemver(this.config.currentVersion, from) > 0) {
        this.state.schemaVersion = this.config.currentVersion;
        await this.saveState();
      }
      return { migrated: false, from, to: this.config.currentVersion, errors: [] };
    }

    // FR-Z05 AC2: Backup before migration
    const backupDir = `${this.config.dataDir}/backups/pre-migration-${Date.now()}`;
    await this.backup(backupDir);

    const errors: string[] = [];
    let lastSuccessVersion = from;

    for (const step of pending) {
      try {
        this.eventBus.emit('migration:start', { version: step.version, description: step.description }).catch(() => {});
        await step.up(this.config.dataDir, this.fs);

        this.state.history.push({
          version: step.version,
          appliedAt: new Date().toISOString(),
          success: true,
        });
        lastSuccessVersion = step.version;

        this.eventBus.emit('migration:complete', { version: step.version }).catch(() => {});
      } catch (err) {
        const errorMsg = (err as Error).message;
        errors.push(`Migration ${step.version} failed: ${errorMsg}`);

        this.state.history.push({
          version: step.version,
          appliedAt: new Date().toISOString(),
          success: false,
          error: errorMsg,
        });

        this.eventBus.emit('migration:failed', { version: step.version, error: errorMsg }).catch(() => {});

        // FR-Z05 AC3: Rollback on failure
        await this.rollback(backupDir);
        break;
      }
    }

    this.state.schemaVersion = errors.length === 0 ? this.config.currentVersion : lastSuccessVersion;
    await this.saveState();

    return {
      migrated: errors.length === 0 && pending.length > 0,
      from,
      to: this.state.schemaVersion,
      errors,
    };
  }

  /**
   * Get migrations that haven't been applied yet
   */
  getPendingMigrations(): MigrationStep[] {
    return this.migrations.filter(m => compareSemver(m.version, this.state.schemaVersion) > 0);
  }

  /**
   * FR-Z05 AC4: Get version info
   */
  getVersionInfo(): { current: string; schema: string; pending: number } {
    return {
      current: this.config.currentVersion,
      schema: this.state.schemaVersion,
      pending: this.getPendingMigrations().length,
    };
  }

  /**
   * Get migration history
   */
  getHistory(): MigrationRecord[] {
    return [...this.state.history];
  }

  // --- Internal ---

  private async loadState(): Promise<void> {
    if (!this.fs) return;

    const statePath = `${this.config.dataDir}/migration-state.json`;
    try {
      if (await this.fs.exists(statePath)) {
        const content = await this.fs.readFile(statePath);
        this.state = JSON.parse(content) as MigrationState;
      }
    } catch {
      // If state file is corrupted, start fresh
      this.state = { schemaVersion: '0.0.0', history: [] };
    }
  }

  private async saveState(): Promise<void> {
    if (!this.fs) return;

    const statePath = `${this.config.dataDir}/migration-state.json`;
    await this.fs.writeFile(statePath, JSON.stringify(this.state, null, 2));
  }

  /**
   * FR-Z05 AC2: Backup current data
   */
  private async backup(backupDir: string): Promise<void> {
    if (!this.fs) return;

    try {
      await this.fs.mkdir(backupDir);
      await this.fs.copyDir(this.config.dataDir, backupDir);
      this.eventBus.emit('migration:backup_created', { path: backupDir }).catch(() => {});
    } catch (err) {
      // Backup failure is non-fatal but logged
      this.eventBus.emit('migration:backup_failed', {
        path: backupDir,
        error: (err as Error).message,
      }).catch(() => {});
    }
  }

  /**
   * FR-Z05 AC3: Rollback to backup
   */
  private async rollback(backupDir: string): Promise<void> {
    if (!this.fs) return;

    try {
      const exists = await this.fs.exists(backupDir);
      if (!exists) return;

      await this.fs.copyDir(backupDir, this.config.dataDir);
      this.eventBus.emit('migration:rollback_complete', { from: backupDir }).catch(() => {});
    } catch (err) {
      this.eventBus.emit('migration:rollback_failed', {
        from: backupDir,
        error: (err as Error).message,
      }).catch(() => {});
    }
  }
}
