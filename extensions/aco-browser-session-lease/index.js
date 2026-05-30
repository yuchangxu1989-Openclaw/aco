/**
 * Browser Session Lease — 浏览器工位租约管理
 *
 * 职责：
 * - 独占申请：同一时刻只有一个 Agent 持有浏览器工位
 * - 超时回收：租约超过 300s 未续期自动释放
 * - Owner 追踪：记录当前持有者 agentId + sessionKey
 * - 看板可见：租约状态与 task board 格式兼容
 *
 * 与 aco-run-watchdog 的 task board 格式兼容：
 * - 租约事件写入 logs/browser-workbench-events.jsonl
 * - 租约状态可被 task board 查询
 */

import fs from 'fs';
import path from 'path';

const LEASE_STATE_PATH = '/root/.openclaw/workspace/state/browser/lease.json';
const EVENTS_PATH = '/root/.openclaw/workspace/logs/browser-workbench-events.jsonl';
const DEFAULT_LEASE_TTL_MS = 300_000; // 300s

function nowIso() { return new Date().toISOString(); }
function nowMs() { return Date.now(); }

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function appendEvent(event) {
  ensureDir(EVENTS_PATH);
  fs.appendFileSync(EVENTS_PATH, JSON.stringify({ timestamp: nowIso(), ...event }) + '\n');
}

function readLease() {
  try {
    return JSON.parse(fs.readFileSync(LEASE_STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeLease(lease) {
  ensureDir(LEASE_STATE_PATH);
  const tmp = `${LEASE_STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lease, null, 2) + '\n');
  fs.renameSync(tmp, LEASE_STATE_PATH);
}

function clearLease() {
  try { fs.unlinkSync(LEASE_STATE_PATH); } catch {}
}

/**
 * 申请浏览器工位租约
 * @param {Object} params
 * @param {string} params.agentId - 申请者 agentId
 * @param {string} params.sessionKey - 申请者 sessionKey
 * @param {string} [params.purpose] - 用途描述
 * @param {number} [params.ttlMs] - 租约时长 (ms)，默认 300000
 * @returns {{ ok: boolean, lease?: Object, reason?: string }}
 */
export function acquire({ agentId, sessionKey, purpose, ttlMs }) {
  const lease = readLease();
  const t = nowMs();
  const effectiveTtl = ttlMs || DEFAULT_LEASE_TTL_MS;

  // 检查现有租约是否过期
  if (lease && lease.expiresAt) {
    const expiresMs = new Date(lease.expiresAt).getTime();
    if (t < expiresMs) {
      // 租约未过期，拒绝
      appendEvent({
        type: 'lease_acquire_rejected',
        requester: { agentId, sessionKey },
        holder: { agentId: lease.agentId, sessionKey: lease.sessionKey },
        reason: 'lease_held',
        expiresAt: lease.expiresAt,
      });
      return {
        ok: false,
        reason: `浏览器工位被 ${lease.agentId} 持有，到期时间 ${lease.expiresAt}`,
        holder: lease,
      };
    }
    // 租约已过期，回收
    appendEvent({
      type: 'lease_expired_reclaimed',
      previousHolder: { agentId: lease.agentId, sessionKey: lease.sessionKey },
      reclaimedBy: { agentId, sessionKey },
    });
  }

  // 授予租约
  const newLease = {
    agentId,
    sessionKey,
    purpose: purpose || null,
    acquiredAt: nowIso(),
    expiresAt: new Date(t + effectiveTtl).toISOString(),
    ttlMs: effectiveTtl,
  };
  writeLease(newLease);
  appendEvent({ type: 'lease_acquired', ...newLease });
  return { ok: true, lease: newLease };
}

/**
 * 续期租约（仅当前持有者可续期）
 * @param {Object} params
 * @param {string} params.sessionKey - 当前持有者 sessionKey
 * @param {number} [params.ttlMs] - 续期时长
 * @returns {{ ok: boolean, lease?: Object, reason?: string }}
 */
export function renew({ sessionKey, ttlMs }) {
  const lease = readLease();
  if (!lease || lease.sessionKey !== sessionKey) {
    return { ok: false, reason: '非当前持有者，无法续期' };
  }
  const effectiveTtl = ttlMs || lease.ttlMs || DEFAULT_LEASE_TTL_MS;
  lease.expiresAt = new Date(nowMs() + effectiveTtl).toISOString();
  lease.renewedAt = nowIso();
  writeLease(lease);
  appendEvent({ type: 'lease_renewed', sessionKey, expiresAt: lease.expiresAt });
  return { ok: true, lease };
}

/**
 * 释放租约（仅当前持有者可释放）
 * @param {Object} params
 * @param {string} params.sessionKey - 当前持有者 sessionKey
 * @returns {{ ok: boolean, reason?: string }}
 */
export function release({ sessionKey }) {
  const lease = readLease();
  if (!lease) {
    return { ok: true, reason: '无活跃租约' };
  }
  if (lease.sessionKey !== sessionKey) {
    return { ok: false, reason: '非当前持有者，无法释放' };
  }
  appendEvent({ type: 'lease_released', agentId: lease.agentId, sessionKey });
  clearLease();
  return { ok: true };
}

/**
 * 查询当前租约状态
 * @returns {{ active: boolean, lease?: Object }}
 */
export function status() {
  const lease = readLease();
  if (!lease) return { active: false };
  const expired = nowMs() >= new Date(lease.expiresAt).getTime();
  if (expired) {
    appendEvent({ type: 'lease_expired_on_query', agentId: lease.agentId, sessionKey: lease.sessionKey });
    clearLease();
    return { active: false, expired: true, previousHolder: lease };
  }
  return { active: true, lease };
}

// Plugin 接口（与 OpenClaw 扩展系统兼容）
const browserSessionLeasePlugin = {
  id: 'aco-browser-session-lease',
  name: '浏览器工位租约',
  version: '0.1.0',

  register(api) {
    // 定期检查过期租约（60s 间隔）
    const timer = setInterval(() => {
      const lease = readLease();
      if (!lease) return;
      if (nowMs() >= new Date(lease.expiresAt).getTime()) {
        appendEvent({
          type: 'lease_expired_auto_reclaim',
          agentId: lease.agentId,
          sessionKey: lease.sessionKey,
          expiredAt: lease.expiresAt,
        });
        clearLease();
        api.logger.info(`[aco-browser-session-lease] 租约过期自动回收: agent=${lease.agentId}`);
      }
    }, 60_000);
    timer.unref?.();

    api.logger.info('aco-browser-session-lease: plugin registered');
  },
};

export default browserSessionLeasePlugin;
