/**
 * RecoveryManager — 域 G：故障恢复
 * FR-G03: Agent 异常后自动恢复服务能力
 */

import { EventBus } from '../event/event-bus.js';
import { ResourcePool } from '../pool/resource-pool.js';
import type { HostAdapter } from '../types/index.js';

// --- Configuration ---

export interface RecoveryManagerConfig {
  /** 探测性派发超时（ms），默认 60s */
  probeTimeoutMs: number;
  /** 探测性派发的 prompt */
  probePrompt: string;
  /** 恢复后等待稳定时间（ms），默认 5s */
  stabilizationDelayMs: number;
}

export const DEFAULT_RECOVERY_CONFIG: RecoveryManagerConfig = {
  probeTimeoutMs: 60_000,
  probePrompt: 'Health probe: respond with OK to confirm availability.',
  stabilizationDelayMs: 5_000,
};

// --- Recovery State ---

export type RecoveryPhase = 'detected' | 'probing' | 'confirmed' | 'failed';

export interface RecoveryAttempt {
  agentId: string;
  phase: RecoveryPhase;
  startedAt: number;
  completedAt?: number;
  probeTaskId?: string;
  success?: boolean;
}

// --- RecoveryManager ---

export class RecoveryManager {
  private config: RecoveryManagerConfig;
  private activeRecoveries = new Map<string, RecoveryAttempt>();
  private recoveryHistory: RecoveryAttempt[] = [];
  private hostAdapter?: HostAdapter;

  constructor(
    private eventBus: EventBus,
    private resourcePool: ResourcePool,
    config?: Partial<RecoveryManagerConfig>,
  ) {
    this.config = { ...DEFAULT_RECOVERY_CONFIG, ...config };
    this.setupEventListeners();
  }

  setHostAdapter(adapter: HostAdapter): void {
    this.hostAdapter = adapter;
  }

  // --- FR-G03 AC1: Detect recovery opportunity ---

  /**
   * Called when an agent transitions from stale/offline back to a responsive state.
   * Initiates the recovery flow.
   */
  async initiateRecovery(agentId: string): Promise<RecoveryAttempt> {
    const existing = this.activeRecoveries.get(agentId);
    if (existing && existing.phase === 'probing') {
      return existing; // Already recovering
    }

    const attempt: RecoveryAttempt = {
      agentId,
      phase: 'detected',
      startedAt: Date.now(),
    };
    this.activeRecoveries.set(agentId, attempt);

    this.eventBus.emit('recovery:initiated', { agentId }).catch(() => {});

    // FR-G03 AC2: Send probe task
    await this.sendProbeTask(attempt);

    return attempt;
  }

  /**
   * FR-G03 AC2: Exploratory dispatch — low priority, short timeout
   */
  private async sendProbeTask(attempt: RecoveryAttempt): Promise<void> {
    attempt.phase = 'probing';

    if (!this.hostAdapter) {
      // No host adapter — simulate success
      await this.sleep(this.config.stabilizationDelayMs);
      this.confirmRecovery(attempt.agentId);
      return;
    }

    try {
      const sessionId = await this.hostAdapter.spawnTask(
        attempt.agentId,
        this.config.probePrompt,
        { timeoutSeconds: Math.ceil(this.config.probeTimeoutMs / 1000), label: 'health-probe' },
      );
      attempt.probeTaskId = sessionId;

      // Wait for probe result with timeout
      const result = await this.waitForProbeResult(attempt);
      if (result) {
        this.confirmRecovery(attempt.agentId);
      } else {
        this.failRecovery(attempt.agentId, 'probe_timeout');
      }
    } catch (err) {
      this.failRecovery(attempt.agentId, `probe_error: ${(err as Error).message}`);
    }
  }

  /**
   * Wait for probe task to complete
   */
  private async waitForProbeResult(attempt: RecoveryAttempt): Promise<boolean> {
    if (!this.hostAdapter || !attempt.probeTaskId) return false;

    const deadline = Date.now() + this.config.probeTimeoutMs;

    while (Date.now() < deadline) {
      try {
        const status = await this.hostAdapter.getTaskStatus(attempt.probeTaskId);
        if (status.status === 'succeeded' || status.status === 'complete') {
          return true;
        }
        if (status.status === 'failed' || status.status === 'timeout') {
          return false;
        }
      } catch {
        // Probe check failed, continue waiting
      }
      await this.sleep(2_000);
    }

    return false;
  }

  /**
   * FR-G03 AC3: Confirm recovery — agent rejoins scheduling pool
   */
  confirmRecovery(agentId: string): void {
    const attempt = this.activeRecoveries.get(agentId);
    if (!attempt) return;

    attempt.phase = 'confirmed';
    attempt.completedAt = Date.now();
    attempt.success = true;

    // Restore agent to idle
    this.resourcePool.recover(agentId);

    // FR-G03 AC4: Emit recovery event for audit
    this.eventBus.emit('recovery:confirmed', {
      agentId,
      durationMs: attempt.completedAt - attempt.startedAt,
    }).catch(() => {});

    this.archiveRecovery(agentId);
  }

  /**
   * Recovery failed — agent stays offline
   */
  failRecovery(agentId: string, reason: string): void {
    const attempt = this.activeRecoveries.get(agentId);
    if (!attempt) return;

    attempt.phase = 'failed';
    attempt.completedAt = Date.now();
    attempt.success = false;

    this.eventBus.emit('recovery:failed', { agentId, reason }).catch(() => {});

    this.archiveRecovery(agentId);
  }

  // --- Query ---

  getActiveRecovery(agentId: string): RecoveryAttempt | undefined {
    return this.activeRecoveries.get(agentId);
  }

  getRecoveryHistory(): RecoveryAttempt[] {
    return [...this.recoveryHistory];
  }

  isRecovering(agentId: string): boolean {
    const attempt = this.activeRecoveries.get(agentId);
    return attempt?.phase === 'probing' || attempt?.phase === 'detected';
  }

  // --- Private ---

  private setupEventListeners(): void {
    // FR-G03 AC1: Listen for agent recovery signals
    this.eventBus.on('health:heartbeat_restored', (payload: unknown) => {
      const { agentId } = payload as { agentId: string };
      const agent = this.resourcePool.get(agentId);
      if (agent && (agent.status === 'stale' || agent.status === 'offline')) {
        this.initiateRecovery(agentId).catch(() => {});
      }
    });
  }

  private archiveRecovery(agentId: string): void {
    const attempt = this.activeRecoveries.get(agentId);
    if (attempt) {
      this.recoveryHistory.push(attempt);
      this.activeRecoveries.delete(agentId);
      // Keep last 100 records
      if (this.recoveryHistory.length > 100) {
        this.recoveryHistory = this.recoveryHistory.slice(-50);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
