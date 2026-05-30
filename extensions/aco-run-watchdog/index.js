// [idle-alert] 2026-04-19 — 子 Agent 疑似卡死告警
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

const OPENCLAW_DIST_DIR = '/usr/lib/node_modules/openclaw/dist';
function resolveDistModulePath({ prefix, suffix = '.js', patternLabel = `${prefix}*${suffix}` }) {
  const matches = fs.readdirSync(OPENCLAW_DIST_DIR)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix) && !name.includes('delivery-runtime'))
    .map((name) => ({
      name,
      fullPath: path.join(OPENCLAW_DIST_DIR, name),
      mtimeMs: fs.statSync(path.join(OPENCLAW_DIST_DIR, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));

  const picked = matches[0];
  if (!picked) {
    throw new Error(`[aco-run-watchdog] dist module not found for pattern ${patternLabel} under ${OPENCLAW_DIST_DIR}`);
  }
  return picked.fullPath;
}

const TASK_REGISTRY_MODULE_PATH = resolveDistModulePath({ prefix: 'task-registry-', patternLabel: 'task-registry-*.js' });
const ACP_SESSION_STATE_DIR = '/root/.openclaw/workspace/state/sessions';

const WATCHDOG_GLOBAL_KEY = Symbol.for('openclaw.aco-run-watchdog.instance');
const watchdogGlobal = globalThis[WATCHDOG_GLOBAL_KEY] || (globalThis[WATCHDOG_GLOBAL_KEY] = {
  intervalStarted: false,
  registeredLogged: false,
  loadLogged: false,
  reapedAcpKeys: new Set(),
  memoryBreaker: { consecutiveFails: 0, tripped: false, lastTrippedAt: null },
  idleAlertLastSent: new Map(),
  autoAdvanceNotices: new Map(),
  toolTraces: new Map(), // [tool-trace] sessionKey -> { taskId, agentId, label, startedAt, calls: [] }
});

const STATE_PATH = '/root/.openclaw/workspace/logs/run-watchdog-state.json';
const EVENTS_PATH = '/root/.openclaw/workspace/logs/run-watchdog-events.jsonl';
const BOARD_PATH = '/root/.openclaw/workspace/logs/subagent-task-board.json';
const SUBAGENT_INDEX_PATH = '/root/.openclaw/workspace/logs/subagent-task-index.json';
const RECOVERY_PATH = '/root/.openclaw/workspace/logs/run-watchdog-recovery.json';
const RECOVERY_LOCK_PATH = '/root/.openclaw/workspace/logs/run-watchdog-recovery.lock';
// [H-07 fix] 环境变量边界校验：不低于 300000ms (5min)，不超过 7200000ms (2h)
const STALE_MS = Math.max(300000, Math.min(7200000, Number(process.env.RUN_WATCHDOG_STALE_MS || 1800000)));
// [idle-alert] 子 Agent 疑似卡死告警阈值：默认 5min，最小 3min，最大 30min
const IDLE_ALERT_MS = Math.max(180000, Math.min(1800000, Number(process.env.RUN_WATCHDOG_IDLE_ALERT_MS || 300000)));
const ACP_STALE_MS = Math.max(300000, Math.min(7200000, Number(process.env.RUN_WATCHDOG_ACP_STALE_MS || 1800000)));
const AUTO_RECOVER = process.env.RUN_WATCHDOG_AUTO_RECOVER === '1';
const WATCHDOG_BUILD = '2026-04-10-recovery-probe-1';
const BOARD_BRIDGE_SCRIPT = '/root/.openclaw/workspace/scripts/local-subagent-board.js';
const BOARD_NOTIFY_EVENTS_PATH = '/root/.openclaw/workspace/logs/subagent-notify-events.jsonl';

// [tool-trace] 工具调用链记录
const TOOL_TRACES_DIR = '/root/.openclaw/workspace/logs/tool-traces';
const TOOL_TRACE_ENABLED = process.env.RUN_WATCHDOG_TOOL_TRACE !== '0'; // default enabled, set '0' to disable

function now() { return Date.now(); }
function nowIso() { return new Date().toISOString(); }
// [M-08 fix] 日志脱敏：截断并替换可能的密钥模式
function sanitizeForLog(text, max = 50) {
  return String(text || '').slice(0, max).replace(/\b(sk-|xoxb-|xoxp-|ghp_|gho_|AKIA)[A-Za-z0-9_\-]{4,}/g, '[REDACTED]');
}
function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  ensureDir(file);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function appendEvent(event) {
  ensureDir(EVENTS_PATH);
  fs.appendFileSync(EVENTS_PATH, JSON.stringify({ timestamp: nowIso(), ...event }) + '\n');
}
function acquireLock(file) {
  try {
    ensureDir(file);
    const fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}
function releaseLock(file) {
  try { fs.unlinkSync(file); } catch {}
}
function writeRecovery(record) {
  writeJson(RECOVERY_PATH, record);
}
function maybeRecover(rec, api) {
  api.logger.warn(`[aco-run-watchdog] maybeRecover entered sessionKey=${rec.sessionKey || 'unknown'} autoRecover=${AUTO_RECOVER ? '1' : '0'}`);
  const recovery = {
    timestamp: nowIso(),
    mode: AUTO_RECOVER ? 'auto-recover' : 'record-only',
    sessionKey: rec.sessionKey || null,
    senderId: rec.senderId || null,
    channel: rec.channel || null,
    staleAt: rec.staleAt || nowIso(),
    action: AUTO_RECOVER ? 'gateway_restart' : 'none',
    status: 'recorded'
  };
  writeRecovery(recovery);
  appendEvent({ type: 'recovery_recorded', ...recovery });
  if (!AUTO_RECOVER) return;
  if (!acquireLock(RECOVERY_LOCK_PATH)) {
    appendEvent({ type: 'recovery_skipped_locked', sessionKey: rec.sessionKey || null });
    return;
  }
  recovery.status = 'started';
  writeRecovery(recovery);
  appendEvent({ type: 'recovery_started', sessionKey: rec.sessionKey || null, action: 'gateway_restart' });
  execFile('openclaw', ['gateway', 'restart'], { timeout: 120000 }, (error, stdout, stderr) => {
    const result = {
      ...recovery,
      finishedAt: nowIso(),
      status: error ? 'failed' : 'completed',
      exitCode: error && typeof error.code === 'number' ? error.code : 0,
      stdout: String(stdout || '').slice(-4000),
      stderr: String(stderr || '').slice(-4000),
      error: error ? String(error.message || error) : null
    };
    writeRecovery(result);
    appendEvent({
      type: 'recovery_finished',
      sessionKey: rec.sessionKey || null,
      status: result.status,
      exitCode: result.exitCode,
      error: result.error
    });
    releaseLock(RECOVERY_LOCK_PATH);
  });
}
// Simple mutex for board read-modify-write atomicity
let boardLock = Promise.resolve();
function withBoardLock(fn) {
  boardLock = boardLock.then(fn, fn);
  return boardLock;
}

function loadBoard() {
  try {
    const raw = fs.readFileSync(BOARD_PATH, 'utf8');
    const obj = JSON.parse(raw || '{}');
    if (obj && Array.isArray(obj.tasks)) return obj;
  } catch {}
  return { version: 1, updatedAt: nowIso(), tasks: [] };
}
function saveBoard(board) {
  ensureDir(BOARD_PATH);
  board.updatedAt = nowIso();
  const tmp = `${BOARD_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(board, null, 2) + '\n');
  fs.renameSync(tmp, BOARD_PATH);
}
function loadIndex() {
  return readJson(SUBAGENT_INDEX_PATH, { tasksBySession: {} });
}
function saveIndex(index) {
  writeJson(SUBAGENT_INDEX_PATH, index);
}
function upsertBoardTask(task) {
  const board = loadBoard();
  const existing = board.tasks.find((t) => t.id === task.id);
  if (existing) Object.assign(existing, task);
  else board.tasks.push(task);
  saveBoard(board);
}
function createTaskId(prefix = 'subagent') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
async function pushBoardSnapshot(reason, taskId = null) {
  return await new Promise((resolve) => {
    execFile('node', [BOARD_BRIDGE_SCRIPT, 'send-snapshot', reason], { timeout: 30000 }, (error, stdout, stderr) => {
      const result = {
        ok: !error,
        reason,
        taskId,
        error: error ? String(error.message || error) : null,
        stdoutTail: String(stdout || '').slice(-1000),
        stderrTail: String(stderr || '').slice(-1000)
      };
      appendEvent({ type: 'board_snapshot_emit', ...result });
      resolve(result);
    });
  });
}
function upsertSubagentBoardTask({ childSessionKey, agentId, label, task: taskText, mode, status, createdAt, startedAt, finishedAt, error, exitCode, stdoutTail, stderrTail }) {
  // Derive label from task text first line if not explicitly provided
  if (!label && taskText) {
    const firstLine = String(taskText).split('\n').find(l => l.trim().replace(/^#+\s*/, '').trim());
    if (firstLine) label = firstLine.trim().replace(/^#+\s*/, '').trim().slice(0, 120);
  }
  // L2 fallback: never allow 'subagent-task' as title — generate from agentId + timestamp
  if (!label) {
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    label = `${agentId || 'unknown'}-task-${ts}`;
    // Log warning so we can trace missing labels
    try { const fs = require('fs'); fs.appendFileSync('/root/.openclaw/workspace/logs/run-watchdog-events.jsonl', JSON.stringify({ type: 'WARN_MISSING_LABEL', agentId, childSessionKey, ts: new Date().toISOString() }) + '\n'); } catch(_) {}
  }
  if (!childSessionKey) return null;
  const board = loadBoard();
  // Dedup: if an acp_ entry already exists for this childSessionKey, reuse it instead of creating a subagent_ duplicate
  const acpExisting = board.tasks.find((t) => t.id && t.id.startsWith('acp_') && t.meta?.childSessionKey === childSessionKey);
  if (acpExisting) {
    // Update the existing acp_ entry in-place, don't create a subagent_ duplicate
    const taskId = acpExisting.id;
    const existing = acpExisting;
    const prevStatus = existing?.status;
    const baseCreatedAt = existing?.createdAt || createdAt || nowIso();
    const baseStartedAt = existing?.startedAt || startedAt || createdAt || nowIso();
    const next = {
      id: taskId,
      title: label || existing?.title || 'subagent-task',
      agentId: agentId || existing?.agentId || 'unknown',
      prompt: existing?.prompt ?? null,
      timeoutSec: existing?.timeoutSec ?? null,
      deliverable: existing?.deliverable ?? null,
      status,
      createdAt: baseCreatedAt,
      updatedAt: nowIso(),
      startedAt: baseStartedAt,
      finishedAt: finishedAt || existing?.finishedAt || null,
      exitCode: Number.isFinite(exitCode) ? exitCode : (existing?.exitCode ?? null),
      error: error || null,
      stdoutTail: typeof stdoutTail === 'string' ? stdoutTail : (existing?.stdoutTail || ''),
      stderrTail: typeof stderrTail === 'string' ? stderrTail : (existing?.stderrTail || ''),
      meta: {
        ...(existing?.meta || {}),
        source: 'run-watchdog-subagent-hooks',
        childSessionKey,
        mode: mode || existing?.meta?.mode || null,
      }
    };
    let persisted = existing || null;
    if (existing) {
      Object.assign(existing, next);
      persisted = existing;
    } else {
      board.tasks.push(next);
      persisted = next;
    }
    saveBoard(board);
    persisted._statusChanged = !existing || prevStatus !== status;
    persisted._runningDrained = prevStatus === 'running' && !board.tasks.some((t) => t?.status === 'running');
    // [L2 per-agent-advance] Check if THIS agent has no more running tasks
    persisted._agentFreed = prevStatus === 'running' && agentId && !board.tasks.some((t) => t?.status === 'running' && t?.agentId === agentId);
    persisted._freedAgentId = agentId || null;
    return persisted;
  }
  // Non-ACP path: use index-based subagent_ id
  const index = loadIndex();
  const tasksBySession = index.tasksBySession || {};
  let taskId = tasksBySession[childSessionKey];
  if (!taskId) {
    taskId = createTaskId('subagent');
    tasksBySession[childSessionKey] = taskId;
    index.tasksBySession = tasksBySession;
    saveIndex(index);
  }
  const existing = board.tasks.find((t) => t.id === taskId);
  const prevStatus = existing?.status;
  const baseCreatedAt2 = existing?.createdAt || createdAt || nowIso();
  const baseStartedAt2 = existing?.startedAt || startedAt || createdAt || nowIso();
  const next2 = {
    id: taskId,
    title: label || existing?.title || 'subagent-task',
    agentId: agentId || existing?.agentId || 'unknown',
    prompt: existing?.prompt ?? null,
    timeoutSec: existing?.timeoutSec ?? null,
    deliverable: existing?.deliverable ?? null,
    status,
    createdAt: baseCreatedAt2,
    updatedAt: nowIso(),
    startedAt: baseStartedAt2,
    finishedAt: finishedAt || existing?.finishedAt || null,
    exitCode: Number.isFinite(exitCode) ? exitCode : (existing?.exitCode ?? null),
    error: error || null,
    stdoutTail: typeof stdoutTail === 'string' ? stdoutTail : (existing?.stdoutTail || ''),
    stderrTail: typeof stderrTail === 'string' ? stderrTail : (existing?.stderrTail || ''),
    meta: {
      ...(existing?.meta || {}),
      source: 'run-watchdog-subagent-hooks',
      childSessionKey,
      mode: mode || existing?.meta?.mode || null,
    }
  };
  let persisted = null;
  if (existing) {
    Object.assign(existing, next2);
    persisted = existing;
  } else {
    board.tasks.push(next2);
    persisted = next2;
  }
  saveBoard(board);
  persisted._statusChanged = !existing || prevStatus !== status;
  persisted._runningDrained = prevStatus === 'running' && !board.tasks.some((t) => t?.status === 'running');
  // [L2 per-agent-advance] Check if THIS agent has no more running tasks
  const resolvedAgentId2 = agentId || existing?.agentId || 'unknown';
  persisted._agentFreed = prevStatus === 'running' && resolvedAgentId2 !== 'unknown' && !board.tasks.some((t) => t?.status === 'running' && t?.agentId === resolvedAgentId2);
  persisted._freedAgentId = resolvedAgentId2;
  return persisted;
}

function normalizeLedgerStatus(task) {
  const raw = String(task?.status || '').toLowerCase();
  if (raw === 'queued') return 'queued';
  if (raw === 'running') return 'running';
  if (raw === 'succeeded') return 'succeeded';
  if (raw === 'timed_out') return 'timed_out';
  if (raw === 'cancelled') return 'cancelled';
  if (raw === 'lost') return 'failed';
  return 'failed';
}

function parseIsoMs(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function findAcpSessionState(childSessionKey) {
  if (!childSessionKey) return null;
  try {
    const prefix = encodeURIComponent(String(childSessionKey)).replace(/%3A/g, '%3A');
    const names = fs.readdirSync(ACP_SESSION_STATE_DIR)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json') && !name.endsWith('.tmp'))
      .sort((a, b) => {
        const ap = path.join(ACP_SESSION_STATE_DIR, a);
        const bp = path.join(ACP_SESSION_STATE_DIR, b);
        return fs.statSync(bp).mtimeMs - fs.statSync(ap).mtimeMs;
      });
    const picked = names[0];
    if (!picked) return null;
    const file = path.join(ACP_SESSION_STATE_DIR, picked);
    const json = safeReadJson(file);
    if (!json) return null;
    return { file, json };
  } catch {
    return null;
  }
}

function readProcStat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = raw.lastIndexOf(')');
    if (end < 0) return null;
    const tail = raw.slice(end + 2).trim().split(/\s+/);
    if (tail.length < 3) return null;
    const ppid = Number(tail[1]);
    const pgid = Number(tail[2]);
    if (!Number.isFinite(ppid) || !Number.isFinite(pgid)) return null;
    return { pid: Number(pid), ppid, pgid };
  } catch {
    return null;
  }
}

function scanProcEntries({ includeCwd = false } = {}) {
  const entries = [];
  let names = [];
  try {
    names = fs.readdirSync('/proc');
  } catch {
    return entries;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const stat = readProcStat(name);
    if (!stat) continue;
    if (includeCwd) {
      try {
        stat.cwd = fs.readlinkSync(`/proc/${name}/cwd`);
      } catch {
        stat.cwd = null;
      }
    }
    entries.push(stat);
  }
  return entries;
}

function collectDescendantPids(rootPid, entries) {
  const descendants = new Set();
  const queue = [Number(rootPid)];
  while (queue.length) {
    const current = queue.shift();
    for (const entry of entries) {
      if (entry.ppid !== current || descendants.has(entry.pid)) continue;
      descendants.add(entry.pid);
      queue.push(entry.pid);
    }
  }
  return descendants;
}

function killProcessTree(pid, signal) {
  const numPid = Number(pid);
  if (!Number.isFinite(numPid) || numPid <= 0) return 0;
  const stat = readProcStat(numPid);
  if (!stat) return 0;

  if (stat.pgid === numPid) {
    const entries = scanProcEntries();
    const members = entries.filter((entry) => entry.pgid === stat.pgid);
    try {
      process.kill(-stat.pgid, signal);
      return members.length || 1;
    } catch {}
  }

  const entries = scanProcEntries();
  const targets = [numPid, ...collectDescendantPids(numPid, entries)];
  const seen = new Set();
  let killed = 0;
  for (const targetPid of targets) {
    if (seen.has(targetPid)) continue;
    seen.add(targetPid);
    try {
      process.kill(targetPid, signal);
      killed += 1;
    } catch {}
  }
  return killed;
}

function killOrphanChildren(pid) {
  const entries = scanProcEntries({ includeCwd: true });
  let killed = 0;
  for (const entry of entries) {
    if (entry.ppid !== 1) continue;
    if (!entry.cwd || !entry.cwd.includes('.openclaw/agents/')) continue;
    try {
      process.kill(entry.pid, 'SIGTERM');
      killed += 1;
    } catch {}
  }
  return killed;
}

function reapStaleAcpProcesses() {
  const board = loadBoard();
  const terminalStatuses = new Set(['succeeded', 'failed', 'timed_out']);
  for (const task of board.tasks) {
    const sk = task?.meta?.childSessionKey;
    if (!sk || !sk.includes(':acp:')) continue;
    if (!terminalStatuses.has(task.status)) continue;
    if (watchdogGlobal.reapedAcpKeys.has(sk)) continue;
    const state = findAcpSessionState(sk);
    const pid = state?.json?.pid;
    if (!pid || !Number.isFinite(Number(pid))) {
      watchdogGlobal.reapedAcpKeys.add(sk);
      continue;
    }
    const numPid = Number(pid);
    try {
      fs.readFileSync(`/proc/${numPid}/cmdline`);
    } catch {
      // Process already gone
      killOrphanChildren(numPid);
      watchdogGlobal.reapedAcpKeys.add(sk);
      continue;
    }
    // Process still alive — SIGTERM
    const killed = killProcessTree(numPid, 'SIGTERM');
    if (killed <= 0) {
      killOrphanChildren(numPid);
      watchdogGlobal.reapedAcpKeys.add(sk);
      continue;
    }
    appendEvent({ type: 'acp_process_reaped', sessionKey: sk, pid: numPid, signal: 'SIGTERM', treeKilled: killed });
    // 5s grace then SIGKILL if still alive
    setTimeout(() => {
      try {
        fs.readFileSync(`/proc/${numPid}/cmdline`);
        const forceKilled = killProcessTree(numPid, 'SIGKILL');
        appendEvent({ type: 'acp_process_reaped', sessionKey: sk, pid: numPid, signal: 'SIGKILL', treeKilled: forceKilled });
      } catch {
        // Already gone after SIGTERM
        killOrphanChildren(numPid);
      }
    }, 5000);
    watchdogGlobal.reapedAcpKeys.add(sk);
  }
}

function resolveAcpRunningOverride(task, existing) {
  const startedMs = typeof task?.startedAt === 'number'
    ? task.startedAt
    : parseIsoMs(existing?.startedAt) || parseIsoMs(existing?.createdAt) || parseIsoMs(task?.createdAt);
  const ageMs = Number.isFinite(startedMs) ? now() - startedMs : null;
  const state = findAcpSessionState(task?.childSessionKey);
  const stateJson = state?.json || null;
  const stateUpdatedMs = parseIsoMs(stateJson?.updated_at) || parseIsoMs(stateJson?.last_used_at) || parseIsoMs(stateJson?.created_at);
  const stateIdleMs = Number.isFinite(stateUpdatedMs) ? now() - stateUpdatedMs : null;
  const lastSeq = Number(stateJson?.last_seq || 0);
  const closed = stateJson?.closed === true;
  const noProgress = lastSeq <= 0;
  if (!closed && noProgress && Number.isFinite(ageMs) && ageMs >= ACP_STALE_MS && Number.isFinite(stateIdleMs) && stateIdleMs >= ACP_STALE_MS) {
    const finishedMs = stateUpdatedMs || startedMs || now();
    return {
      status: 'failed',
      finishedAt: new Date(finishedMs).toISOString(),
      error: `stale acp task reclaimed: running > ${Math.floor(ACP_STALE_MS / 1000)}s with no session progress`,
      stderrTail: tailTaskText(`state=${state?.file || 'missing'} closed=${closed} last_seq=${lastSeq} state_idle_ms=${stateIdleMs ?? 'unknown'}`),
      exitCode: 124,
      meta: {
        staleReclaimed: true,
        staleStatePath: state?.file || null,
        staleStateIdleMs: stateIdleMs,
        staleAgeMs: ageMs,
      }
    };
  }
  return null;
}

function tailTaskText(value, max = 1200) {
  if (!value) return '';
  const s = String(value);
  return s.length <= max ? s : s.slice(-max);
}

async function syncAcpTaskLedgerToBoard(api) {
  try {
    const mod = await import(TASK_REGISTRY_MODULE_PATH);
    const listTaskRecords = mod?.l || mod?.listTaskRecords;
    if (typeof listTaskRecords !== 'function') return { ok: false, reason: 'listTaskRecords unavailable' };
    const tasks = listTaskRecords();
    const acpTasks = tasks.filter((task) => task && task.runtime === 'acp' && task.scopeKind === 'session' && task.childSessionKey && task.runId);
    if (!acpTasks.length) return { ok: true, scanned: 0, upserted: 0 };
    const { statusChanged, upserted, board } = await withBoardLock(() => {
      const board = loadBoard();
    let upserted = 0;
    let statusChanged = false;
    for (const task of acpTasks) {
      const id = `acp_${String(task.runId).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const existing = board.tasks.find((t) => t.id === id);
      const prevStatus = existing?.status || null;
      const startedAt = typeof task.startedAt === 'number' ? new Date(task.startedAt).toISOString() : (existing?.startedAt || (typeof task.createdAt === 'number' ? new Date(task.createdAt).toISOString() : nowIso()));
      const createdAt = existing?.createdAt || (typeof task.createdAt === 'number' ? new Date(task.createdAt).toISOString() : startedAt);
      const finishedAt = typeof task.endedAt === 'number' ? new Date(task.endedAt).toISOString() : (existing?.finishedAt || null);
      const status = normalizeLedgerStatus(task);
      const runningOverride = status === 'running' ? resolveAcpRunningOverride(task, existing) : null;
      const effectiveStatus = runningOverride?.status || status;
      const next = {
        id,
        title: task.label || task.task || existing?.title || 'acp-task',
        agentId: task.agentId || String(task.childSessionKey).split(':')[1] || existing?.agentId || 'unknown',
        prompt: task.task || existing?.prompt || null,
        timeoutSec: existing?.timeoutSec ?? null,
        deliverable: existing?.deliverable ?? null,
        status: effectiveStatus,
        createdAt,
        updatedAt: nowIso(),
        startedAt,
        finishedAt: runningOverride?.finishedAt || finishedAt,
        exitCode: runningOverride?.exitCode ?? existing?.exitCode ?? (effectiveStatus === 'succeeded' ? 0 : null),
        error: runningOverride?.error ?? task.error ?? null,
        stdoutTail: tailTaskText(task.terminalSummary || task.progressSummary || existing?.stdoutTail || ''),
        stderrTail: runningOverride?.stderrTail ?? (effectiveStatus === 'succeeded' ? (existing?.stderrTail || '') : tailTaskText(task.error || existing?.stderrTail || '')),
        meta: {
          ...(existing?.meta || {}),
          source: 'task-ledger-acp',
          childSessionKey: task.childSessionKey,
          runId: task.runId,
          ownerKey: task.ownerKey || null,
          deliveryStatus: task.deliveryStatus || null,
          ...(runningOverride?.meta || {})
        }
      };
      if (existing) {
        if (prevStatus !== effectiveStatus) statusChanged = true;
        Object.assign(existing, next);
      } else {
        statusChanged = true;
        board.tasks.push(next);
      }
      upserted += 1;
    }
    saveBoard(board);
    return { statusChanged, upserted, board };
    });
    appendEvent({ type: 'acp_ledger_sync', scanned: acpTasks.length, upserted });
    // Push board snapshot only when a task is new or its status actually changed
    if (statusChanged) {
      await pushBoardSnapshot('acp_ledger_sync');
    }
    return { ok: true, scanned: acpTasks.length, upserted };
  } catch (error) {
    appendEvent({ type: 'acp_ledger_sync_failed', error: String(error?.message || error) });
    api?.logger?.warn?.(`[aco-run-watchdog] acp ledger sync failed: ${String(error?.message || error)}`);
    return { ok: false, error: String(error?.message || error) };
  }
}

function syncStaleToBoard(rec) {
  if (String(rec?.sessionKey || '').startsWith('agent:main:')) {
    appendEvent({
      type: 'dispatch_stale_main_skipped_board_sync',
      sessionKey: rec?.sessionKey || null,
      senderId: rec?.senderId || null,
      channel: rec?.channel || null,
      startedAt: rec?.startedAt || null,
      staleAt: rec?.staleAt || nowIso()
    });
    return;
  }
  const board = loadBoard();
  const taskId = `watchdog-${Buffer.from(String(rec.sessionKey || 'unknown')).toString('base64').replace(/[^a-zA-Z0-9]/g,'').slice(0,24)}`;
  const existing = board.tasks.find((t) => t.id === taskId);
  const payload = {
    id: taskId,
    title: 'main-session-stale-dispatch',
    agentId: 'main',
    prompt: rec.bodyPreview || null,
    timeoutSec: Math.floor(STALE_MS / 1000),
    deliverable: null,
    status: 'failed',
    createdAt: rec.startedAt || nowIso(),
    updatedAt: nowIso(),
    startedAt: rec.startedAt || nowIso(),
    finishedAt: nowIso(),
    exitCode: 124,
    error: `run-watchdog stale dispatch: no final send within ${Math.floor(STALE_MS / 1000)}s`,
    stdoutTail: '',
    stderrTail: '',
    meta: {
      source: 'run-watchdog',
      sessionKey: rec.sessionKey || null,
      senderId: rec.senderId || null,
      channel: rec.channel || null,
      staleAt: rec.staleAt || nowIso()
    }
  };
  if (existing) {
    Object.assign(existing, payload);
  } else {
    board.tasks.push(payload);
  }
  saveBoard(board);
}
function resolveRequesterSessionKey(runId, childSessionKey = null) {
  try {
    const runsState = readJson('/root/.openclaw/subagents/runs.json', { runs: {} });
    if (runId && runsState?.runs?.[runId]?.requesterSessionKey) {
      return String(runsState.runs[runId].requesterSessionKey);
    }
    if (childSessionKey) {
      for (const run of Object.values(runsState?.runs || {})) {
        if (run?.childSessionKey === childSessionKey && run?.requesterSessionKey) {
          return String(run.requesterSessionKey);
        }
      }
    }
  } catch {}
  return null;
}

function queueAutoAdvanceNotice(requesterSessionKey) {
  if (!requesterSessionKey || !String(requesterSessionKey).startsWith('agent:main:')) return false;
  const existing = watchdogGlobal.autoAdvanceNotices.get(requesterSessionKey);
  if (existing?.pending) return false;
  // [L2 auto-advance fallback] 当最后一个 running 子任务结束时，向主会话注入一次性提醒，兜底推进下一批任务。
  watchdogGlobal.autoAdvanceNotices.set(requesterSessionKey, {
    pending: true,
    createdAt: nowIso(),
    message: '所有运行中任务已完成，请检查待办队列并派发下一批任务。',
  });
  appendEvent({ type: 'auto_advance_notice_queued', requesterSessionKey });
  return true;
}

// [L2 per-agent-advance] 单个 agent 空闲时立即提醒主会话派发，不等所有任务归零
function queuePerAgentAdvanceNotice(requesterSessionKey, freedAgentId) {
  if (!requesterSessionKey || !String(requesterSessionKey).startsWith('agent:main:')) return false;
  if (!freedAgentId) return false;
  const dedupeKey = `${requesterSessionKey}::agent::${freedAgentId}`;
  const existing = watchdogGlobal.autoAdvanceNotices.get(dedupeKey);
  if (existing?.pending) return false;
  watchdogGlobal.autoAdvanceNotices.set(dedupeKey, {
    pending: true,
    createdAt: nowIso(),
    message: `Agent ${freedAgentId} 已空闲，请检查待办队列派发下一个任务。`,
  });
  appendEvent({ type: 'per_agent_advance_notice_queued', requesterSessionKey, freedAgentId });
  return true;
}

function consumeAutoAdvanceNotice(sessionKey) {
  // Collect all matching notices: exact key + per-agent keys for this session
  const messages = [];
  for (const [key, rec] of watchdogGlobal.autoAdvanceNotices.entries()) {
    if (!rec?.pending || !rec?.message) continue;
    // Match exact sessionKey or per-agent keys prefixed with sessionKey
    if (key === sessionKey || key.startsWith(`${sessionKey}::agent::`)) {
      messages.push(rec.message);
      watchdogGlobal.autoAdvanceNotices.delete(key);
      appendEvent({ type: 'auto_advance_notice_injected', requesterSessionKey: sessionKey, noticeKey: key });
    }
  }
  if (messages.length === 0) return null;
  // Deduplicate and join
  return [...new Set(messages)].join('\n');
}

function isMainSessionKey(sessionKey) {
  return String(sessionKey || '').startsWith('agent:main:');
}

function keyOf(evt, ctx) {
  return String(ctx?.sessionKey || evt?.sessionKey || 'unknown');
}

// [idle-alert] Detect running subagent sessions with no recent transcript activity
function checkIdleAgents(api) {
  try {
    const board = loadBoard();
    const runningTasks = board.tasks.filter((t) => t.status === 'running');
    if (!runningTasks.length) return;
    const t = now();
    for (const task of runningTasks) {
      const childSessionKey = task?.meta?.childSessionKey;
      if (!childSessionKey) continue;
      const parts = String(childSessionKey).split(':');
      const agentId = parts[1] || '';
      if (!agentId) continue;
      // Find the session transcript .jsonl file
      const sessionsDir = `/root/.openclaw/agents/${agentId}/sessions`;
      let transcriptPath = null;
      try {
        // Try sessionId from the key (last segment)
        const sessionId = parts[parts.length - 1] || '';
        if (sessionId) {
          const candidates = fs.readdirSync(sessionsDir)
            .filter((name) => name.startsWith(sessionId) && name.endsWith('.jsonl'))
            .map((name) => path.join(sessionsDir, name));
          if (candidates.length) transcriptPath = candidates[0];
        }
        // Fallback: sessions.json lookup
        if (!transcriptPath) {
          const sessionsIndex = readJson(path.join(sessionsDir, 'sessions.json'), {});
          const entry = sessionsIndex[childSessionKey];
          const realSessionId = entry?.sessionId;
          if (realSessionId) {
            const fallback = fs.readdirSync(sessionsDir)
              .filter((name) => name.startsWith(realSessionId) && name.endsWith('.jsonl'))
              .map((name) => path.join(sessionsDir, name));
            if (fallback.length) transcriptPath = fallback[0];
          }
        }
      } catch {}
      if (!transcriptPath) continue;
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(transcriptPath).mtimeMs;
      } catch { continue; }
      const idleMs = t - mtimeMs;
      if (idleMs < IDLE_ALERT_MS) continue;
      // Dedup: don't re-alert within IDLE_ALERT_MS of last alert for this task
      const taskId = task.id;
      const lastSent = watchdogGlobal.idleAlertLastSent.get(taskId);
      if (lastSent && (t - lastSent) < IDLE_ALERT_MS) continue;
      // Fire idle alert
      const idleMinutes = Math.floor(idleMs / 60000);
      const alertPayload = {
        type: 'idle-alert',
        taskId,
        label: task.title || task.id,
        agentId: task.agentId || agentId,
        idleMs,
        idleMinutes,
        transcriptPath,
        suggestion: '\u5efa\u8bae\u68c0\u67e5\u662f\u5426\u5361\u6b7b\uff0c\u53ef kill + \u62c6\u5206\u91cd\u6d3e',
      };
      appendEvent(alertPayload);
      api.logger.warn(`[aco-run-watchdog] idle-alert: task=${taskId} agent=${alertPayload.agentId} label="${alertPayload.label}" idle=${idleMinutes}min`);
      // Record the send time AFTER successful append
      watchdogGlobal.idleAlertLastSent.set(taskId, t);
    }
  } catch (e) {
    api.logger.warn(`[aco-run-watchdog] checkIdleAgents failed: ${e.message}`);
  }
}

// ============================================================
// [tool-trace] Tool call chain recording helpers
// ============================================================

/**
 * Initialize a trace buffer for a newly spawned subagent task.
 * Called from subagent_spawned hook.
 */
function initToolTrace(sessionKey, { taskId, agentId, label }) {
  if (!TOOL_TRACE_ENABLED || !sessionKey) return;
  watchdogGlobal.toolTraces.set(sessionKey, {
    taskId: taskId || null,
    agentId: agentId || 'unknown',
    label: label || null,
    startedAt: nowIso(),
    calls: [],
  });
}

/**
 * Append a single tool call record to the in-memory trace buffer.
 * Called from after_tool_call hook.
 */
function appendToolTraceCall(sessionKey, callData) {
  if (!TOOL_TRACE_ENABLED || !sessionKey) return;
  const trace = watchdogGlobal.toolTraces.get(sessionKey);
  if (!trace) return;
  trace.calls.push(callData);
}

/**
 * Extract a brief parameter summary from tool call event data.
 * Keeps file paths, truncates commands, omits large content.
 */
function summarizeToolParams(evt) {
  const params = evt?.params || evt?.arguments || evt?.input || {};
  const summary = {};
  // Common tool parameter extraction
  if (params.path) summary.path = String(params.path).slice(0, 200);
  if (params.command) summary.command = sanitizeForLog(String(params.command), 100);
  if (params.query) summary.query = String(params.query).slice(0, 100);
  if (params.url) summary.url = sanitizeForLog(String(params.url), 200);
  if (params.prompt) summary.prompt = String(params.prompt).slice(0, 100);
  if (params.action) summary.action = String(params.action).slice(0, 50);
  if (params.sessionId) summary.sessionId = String(params.sessionId).slice(0, 80);
  // For edit tool: show file path and number of edits
  if (params.edits && Array.isArray(params.edits)) summary.editCount = params.edits.length;
  // For write tool: show file path and content length
  if (params.content) summary.contentLength = String(params.content).length;
  // For exec: show workdir if present
  if (params.workdir) summary.workdir = String(params.workdir).slice(0, 100);
  // Fallback: if no known params extracted, grab first 3 keys
  if (Object.keys(summary).length === 0) {
    const keys = Object.keys(params).slice(0, 3);
    for (const k of keys) {
      const v = params[k];
      if (typeof v === 'string') summary[k] = sanitizeForLog(v, 100);
      else if (typeof v === 'number' || typeof v === 'boolean') summary[k] = v;
    }
  }
  return summary;
}

/**
 * Flush the accumulated tool trace for a session to disk.
 * Called from subagent_ended hook.
 * Returns the trace file path (relative) or null.
 */
function flushToolTrace(sessionKey, { taskId, agentId, status, finishedAt }) {
  if (!TOOL_TRACE_ENABLED || !sessionKey) return null;
  const trace = watchdogGlobal.toolTraces.get(sessionKey);
  // Clean up the in-memory buffer regardless
  watchdogGlobal.toolTraces.delete(sessionKey);
  const resolvedAgentId = agentId || trace?.agentId || 'unknown';
  const resolvedTaskId = taskId || trace?.taskId || 'unknown';
  const ts = Date.now();
  const fileName = `${resolvedTaskId}-${resolvedAgentId}-${ts}.json`;
  const filePath = path.join(TOOL_TRACES_DIR, fileName);
  const traceDoc = {
    version: 1,
    taskId: resolvedTaskId,
    agentId: resolvedAgentId,
    sessionKey,
    label: trace?.label || null,
    status: status || 'unknown',
    startedAt: trace?.startedAt || null,
    finishedAt: finishedAt || nowIso(),
    totalCalls: trace?.calls?.length || 0,
    calls: trace?.calls || [],
    // Task-level summary even if no individual tool calls were captured
    summary: {
      toolCounts: {},
      totalDurationMs: 0,
      successCount: 0,
      failureCount: 0,
    },
  };
  // Build summary statistics
  for (const call of traceDoc.calls) {
    const name = call.tool_name || 'unknown';
    traceDoc.summary.toolCounts[name] = (traceDoc.summary.toolCounts[name] || 0) + 1;
    if (typeof call.duration_ms === 'number') traceDoc.summary.totalDurationMs += call.duration_ms;
    if (call.success === true) traceDoc.summary.successCount++;
    else if (call.success === false) traceDoc.summary.failureCount++;
  }
  try {
    ensureDir(filePath);
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(traceDoc, null, 2) + '\n');
    fs.renameSync(tmp, filePath);
    appendEvent({ type: 'tool_trace_flushed', taskId: resolvedTaskId, agentId: resolvedAgentId, file: fileName, totalCalls: traceDoc.totalCalls });
    return fileName;
  } catch (e) {
    appendEvent({ type: 'tool_trace_flush_failed', taskId: resolvedTaskId, agentId: resolvedAgentId, error: String(e.message) });
    return null;
  }
}

const plugin = {
  id: 'aco-run-watchdog',
  name: 'Run Watchdog',
  version: '0.1.0',
  register(api) {
    const load = () => readJson(STATE_PATH, { sessions: {} });
    const save = (state) => writeJson(STATE_PATH, state);

    if (!watchdogGlobal.loadLogged) {
      appendEvent({ type: 'plugin_loaded', build: WATCHDOG_BUILD, autoRecover: AUTO_RECOVER });
      api.logger.info(`run-watchdog: build=${WATCHDOG_BUILD} autoRecover=${AUTO_RECOVER ? '1' : '0'}`);
      watchdogGlobal.loadLogged = true;
    }

    api.on('before_prompt_build', (evt, ctx) => {
      const sessionKey = String(ctx?.sessionKey || evt?.sessionKey || '');
      if (!isMainSessionKey(sessionKey)) return null;
      const notice = consumeAutoAdvanceNotice(sessionKey);
      if (!notice) return null;
      api.logger.info(`[aco-run-watchdog] auto-advance notice injected sessionKey=${sessionKey}`);
      return { prependContext: notice };
    }, { priority: 980 });

    api.on('before_dispatch', (evt, ctx) => {
      const state = load();
      const key = keyOf(evt, ctx);
      state.sessions[key] = {
        sessionKey: key,
        senderId: ctx?.senderId || evt?.senderId || null,
        channel: evt?.channel || ctx?.channelId || null,
        startedAt: nowIso(),
        startedMs: now(),
        status: 'running',
        bodyPreview: sanitizeForLog(evt?.body || evt?.content || '')
      };
      save(state);
      appendEvent({ type: 'dispatch_started', sessionKey: key, bodyPreview: state.sessions[key].bodyPreview });
      return null;
    }, { priority: 100 });

    api.on('message_sending', (evt) => {
      const state = load();
      const sessions = state.sessions || {};
      const t = now();
      let changed = false;
      for (const [key, rec] of Object.entries(sessions)) {
        if (!rec || rec.status !== 'running') continue;
        rec.lastSendAt = nowIso();
        rec.lastSendMs = t;
        rec.status = 'sent';
        changed = true;
        appendEvent({ type: 'message_sending', sessionKey: key, to: evt?.to || null });
      }
      if (changed) save(state);
      return null;
    }, { priority: 100 });

    api.on('message_sent', (evt) => {
      const state = load();
      const sessions = state.sessions || {};
      const t = now();
      let changed = false;
      for (const [key, rec] of Object.entries(sessions)) {
        if (!rec || (rec.status !== 'running' && rec.status !== 'sent')) continue;
        rec.lastSentAt = nowIso();
        rec.lastSentMs = t;
        rec.status = evt?.success ? 'completed' : 'send_error';
        rec.error = evt?.success ? null : String(evt?.error || 'message send failed');
        changed = true;
        appendEvent({ type: 'message_sent', sessionKey: key, success: !!evt?.success, error: rec.error || null });
      }
      if (changed) save(state);
      return null;
    }, { priority: 100 });

    api.on('subagent_spawned', async (evt, ctx) => {
      appendEvent({
        type: 'subagent_spawned_hook_enter',
        eventChildSessionKey: evt?.childSessionKey || null,
        ctxChildSessionKey: ctx?.childSessionKey || null,
        agentId: evt?.agentId || null,
        label: evt?.label || null,
        runId: evt?.runId || ctx?.runId || null
      });
      const childSessionKey = evt?.childSessionKey || ctx?.childSessionKey || null;
      const task = await withBoardLock(() => upsertSubagentBoardTask({
        childSessionKey,
        agentId: evt?.agentId,
        label: evt?.label,
        task: evt?.task,
        mode: evt?.mode,
        status: 'running',
        createdAt: nowIso(),
        startedAt: nowIso(),
      }));
      if (task?.id && task._statusChanged) {
        await pushBoardSnapshot('subagent_spawned', task.id);
      }
      // [tool-trace] Initialize trace buffer for this subagent task
      if (childSessionKey) {
        initToolTrace(childSessionKey, {
          taskId: task?.id || null,
          agentId: evt?.agentId || null,
          label: evt?.label || null,
        });
      }
    }, { priority: 100 });

    api.on('subagent_ended', async (evt, ctx) => {
      appendEvent({
        type: 'subagent_ended_hook_enter',
        eventChildSessionKey: evt?.childSessionKey || null,
        eventTargetSessionKey: evt?.targetSessionKey || null,
        ctxChildSessionKey: ctx?.childSessionKey || null,
        outcome: evt?.outcome || null,
        status: evt?.status || null,
        success: evt?.success === true,
        runId: evt?.runId || ctx?.runId || null
      });
      const sessionKey = evt?.childSessionKey || evt?.targetSessionKey || ctx?.childSessionKey;
      const outcome = String(evt?.outcome || '').toLowerCase();
      const nominalOk = outcome === 'ok' || evt?.status === 'completed' || evt?.status === 'succeeded' || evt?.success === true;
      // Zero-token defense: if completion reports success but runtime=0s, tokens=0, no result text,
      // treat as failed (e.g. embedded fallback 403, ACP process silent exit)
      const stats = evt?.stats || evt?.usage || {};
      const totalTokens = Number(stats.totalTokens || stats.total_tokens || 0) + Number(stats.inputTokens || stats.input_tokens || stats.in || 0) + Number(stats.outputTokens || stats.output_tokens || stats.out || 0);
      const hasResult = !!(evt?.result || evt?.resultText || evt?.frozenResultText || '').toString().trim();
      const runtimeSec = Number(stats.runtime || stats.runtimeMs || 0);
      // Read session jsonl BEFORE zeroTokenFail check so stdoutTail can serve as evidence
      let stdoutTail = '';
      let stderrTail = '';
      let frozenResultFromRuns = '';
      let resolvedAgentId = evt?.agentId;
      let resolvedLabel = evt?.label;
      if (sessionKey) {
        try {
          const agentId = String(sessionKey).split(':')[1] || '';
          const sessionId = String(sessionKey).split(':').slice(-1)[0] || '';
          if (!resolvedAgentId && agentId) resolvedAgentId = agentId;
          if (agentId && sessionId) {
            const sessionsDir = `/root/.openclaw/agents/${agentId}/sessions`;
            let picked = null;
            // Strategy 1: direct match by spawn UUID (works for some ACP paths)
            try {
              const directCandidates = fs.readdirSync(sessionsDir)
                .filter((name) => name.startsWith(sessionId) && name.includes('.jsonl'))
                .map((name) => path.join(sessionsDir, name))
                .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
              picked = directCandidates[0] || null;
            } catch {}
            // Strategy 2: look up real sessionId from sessions.json via childSessionKey
            if (!picked) {
              try {
                const sessionsIndex = readJson(path.join(sessionsDir, 'sessions.json'), {});
                const entry = sessionsIndex[sessionKey];
                const realSessionId = entry?.sessionId;
                if (realSessionId) {
                  const fallbackCandidates = fs.readdirSync(sessionsDir)
                    .filter((name) => name.startsWith(realSessionId) && name.includes('.jsonl'))
                    .map((name) => path.join(sessionsDir, name))
                    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
                  picked = fallbackCandidates[0] || null;
                }
              } catch {}
            }
            // Strategy 3: look up from runs.json via childSessionKey field
            if (!picked) {
              try {
                const runsState = readJson('/root/.openclaw/subagents/runs.json', { runs: {} });
                for (const run of Object.values(runsState?.runs || {})) {
                  if (run?.childSessionKey === sessionKey) {
                    // Capture frozenResultText FIRST (before session file lookup which may throw)
                    if (!hasResult && run.frozenResultText) {
                      frozenResultFromRuns = run.frozenResultText;
                    }
                    // Extract agentId + sessionId from run's childSessionKey or sessionFile if available
                    const runAgentId = String(run.childSessionKey || '').split(':')[1] || agentId;
                    const runSessionsDir = `/root/.openclaw/agents/${runAgentId}/sessions`;
                    const runSessionsIndex = readJson(path.join(runSessionsDir, 'sessions.json'), {});
                    const runEntry = runSessionsIndex[run.childSessionKey];
                    const runRealSessionId = runEntry?.sessionId;
                    if (runRealSessionId) {
                      const runCandidates = fs.readdirSync(runSessionsDir)
                        .filter((name) => name.startsWith(runRealSessionId) && name.includes('.jsonl'))
                        .map((name) => path.join(runSessionsDir, name))
                        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
                      picked = runCandidates[0] || null;
                    }
                    break;
                  }
                }
              } catch {}
            }
            // Strategy 4: fallback to most recently modified .jsonl in sessions dir
            if (!picked) {
              try {
                const allJsonl = fs.readdirSync(sessionsDir)
                  .filter((name) => name.endsWith('.jsonl') && !name.includes('acp-stream'))
                  .map((name) => ({ name, mtime: fs.statSync(path.join(sessionsDir, name)).mtimeMs }))
                  .sort((a, b) => b.mtime - a.mtime);
                if (allJsonl[0]) picked = path.join(sessionsDir, allJsonl[0].name);
              } catch {}
            }
            if (picked && fs.existsSync(picked)) {
              const raw = fs.readFileSync(picked, 'utf8');
              stdoutTail = String(raw).slice(-1200);
            }
          }
          try {
            const board = loadBoard();
            const existing = board.tasks.find((t) => t?.meta?.childSessionKey === sessionKey);
            if (existing?.title && !resolvedLabel) resolvedLabel = existing.title;
            if (existing?.agentId && !resolvedAgentId) resolvedAgentId = existing.agentId;
          } catch {}
        } catch (err) {
          stderrTail = String(err?.message || err || '').slice(-1200);
        }
      }
      // Zero-token defense: exempt if exitCode===0, session has actual output, frozenResultText exists, or explicit success signals
      const hasSessionOutput = !!stdoutTail.trim();
      const hasFrozenResult = !!frozenResultFromRuns.trim();
      const explicitExit0 = evt?.exitCode === 0;
      const zeroTokenFail = nominalOk && totalTokens === 0 && !hasResult && runtimeSec <= 1
        && !hasSessionOutput && !hasFrozenResult && !explicitExit0;
      const ok = nominalOk && !zeroTokenFail;
      if (zeroTokenFail) {
        appendEvent({
          type: 'zero_token_fail_detected',
          childSessionKey: sessionKey,
          nominalOutcome: outcome,
          totalTokens,
          hasResult,
          runtimeSec,
          hasSessionOutput,
          hasFrozenResult,
          explicitExit0,
        });
      }
      // [tool-trace] P2-02: Flush trace to disk FIRST, then upsert board with toolTraceFile in single lock
      let toolTraceFile = null;
      if (sessionKey) {
        toolTraceFile = flushToolTrace(sessionKey, {
          taskId: null, // resolved from trace buffer inside flushToolTrace
          agentId: resolvedAgentId,
          status: ok ? 'succeeded' : 'failed',
          finishedAt: typeof evt?.endedAt === 'number' ? new Date(evt.endedAt).toISOString() : nowIso(),
        });
      }
      const task = await withBoardLock(() => {
        const result = upsertSubagentBoardTask({
          childSessionKey: sessionKey,
          agentId: resolvedAgentId,
          label: resolvedLabel,
          mode: evt?.mode,
          status: ok ? 'succeeded' : 'failed',
          createdAt: evt?.startedAt || nowIso(),
          startedAt: evt?.startedAt || nowIso(),
          finishedAt: typeof evt?.endedAt === 'number' ? new Date(evt.endedAt).toISOString() : nowIso(),
          error: ok ? null : (zeroTokenFail ? 'zero-token completion: agent reported success but produced 0 tokens and no output (likely embedded fallback 403 or ACP silent exit)' : String(evt?.error || outcome || 'subagent ended with failure')),
          exitCode: typeof evt?.exitCode === 'number' ? evt.exitCode : null,
          stdoutTail,
          stderrTail,
        });
        // Attach trace file reference in same board lock (single write)
        if (toolTraceFile && result?.id) {
          const board = loadBoard();
          const entry = board.tasks.find((t) => t.id === result.id);
          if (entry) {
            entry.toolTraceFile = toolTraceFile;
            entry.updatedAt = nowIso();
            saveBoard(board);
          }
        }
        return result;
      });
      if (task?.id && task._statusChanged) {
        await pushBoardSnapshot('subagent_ended', task.id);
      }
      // [L2 per-agent-advance] 单 agent 空闲即提醒，粒度优先于全部归零
      if (task?._agentFreed && task._freedAgentId) {
        const requesterSessionKey = resolveRequesterSessionKey(evt?.runId || ctx?.runId || null, sessionKey);
        if (queuePerAgentAdvanceNotice(requesterSessionKey, task._freedAgentId)) {
          api.logger.info(`[aco-run-watchdog] per-agent advance notice queued agent=${task._freedAgentId} requester=${requesterSessionKey}`);
        }
      }
      // [L2 auto-advance fallback] 所有任务归零时的兜底提醒
      if (task?._runningDrained) {
        const requesterSessionKey = resolveRequesterSessionKey(evt?.runId || ctx?.runId || null, sessionKey);
        if (queueAutoAdvanceNotice(requesterSessionKey)) {
          api.logger.info(`[aco-run-watchdog] auto-advance notice queued requesterSessionKey=${requesterSessionKey}`);
        }
      }
    }, { priority: 100 });

    if (!watchdogGlobal.intervalStarted) {
      const timer = setInterval(() => {
        try {
          syncAcpTaskLedgerToBoard(api).catch(() => {});
          reapStaleAcpProcesses();
          // [idle-alert] Check for idle running agents
          checkIdleAgents(api);
          // [tool-trace] P2-01: Clean up stale trace buffers (>30min without subagent_ended)
          if (TOOL_TRACE_ENABLED) {
            const staleTraceMs = 30 * 60 * 1000; // 30 minutes
            const traceNow = now();
            for (const [sk, trace] of watchdogGlobal.toolTraces.entries()) {
              const startedMs = trace?.startedAt ? Date.parse(trace.startedAt) : null;
              if (Number.isFinite(startedMs) && (traceNow - startedMs) > staleTraceMs) {
                watchdogGlobal.toolTraces.delete(sk);
                appendEvent({ type: 'tool_trace_stale_cleaned', sessionKey: sk, agentId: trace?.agentId || 'unknown', ageMs: traceNow - startedMs });
                api.logger.warn(`[aco-run-watchdog] stale tool trace cleaned sessionKey=${sk} age=${Math.floor((traceNow - startedMs) / 60000)}min`);
              }
            }
          }
          try {
            watchdogGlobal.reconciledRunIds ||= new Set();
            const runsState = readJson('/root/.openclaw/subagents/runs.json', { runs: {} });
            const board = loadBoard();
            const reconciledThisCycle = [];
            for (const [runId, run] of Object.entries(runsState?.runs || {})) {
              if (!run || run.endedAt == null) continue;
              if (watchdogGlobal.reconciledRunIds.has(runId)) continue;
              const childSessionKey = run.childSessionKey;
              if (!childSessionKey) continue;
              const existingTask = board.tasks.find((task) => task?.status === 'running' && task?.meta?.childSessionKey === childSessionKey);
              if (!existingTask) continue;
              const reconciledStatus = run?.outcome?.status === 'ok' ? 'succeeded' : 'failed';
              const endedAt = new Date(run.endedAt);
              const finishedAt = Number.isNaN(endedAt.getTime()) ? nowIso() : endedAt.toISOString();
              reconciledThisCycle.push({ runId, childSessionKey, existingTask, reconciledStatus, finishedAt, run });
            }
            if (reconciledThisCycle.length > 0) {
              const upsertedRunIds = reconciledThisCycle.map(r => r.runId);
              upsertedRunIds.forEach(id => watchdogGlobal.reconciledRunIds.add(id));
              void withBoardLock(() => {
                for (const r of reconciledThisCycle) {
                  upsertSubagentBoardTask({
                    childSessionKey: r.childSessionKey,
                    agentId: r.existingTask.agentId,
                    label: r.existingTask.title,
                    mode: r.existingTask?.meta?.mode,
                    status: r.reconciledStatus,
                    createdAt: r.existingTask.createdAt,
                    startedAt: r.existingTask.startedAt,
                    finishedAt: r.finishedAt,
                    error: r.reconciledStatus === 'failed' ? String(r.run?.outcome?.error || r.existingTask.error || 'subagent run ended with failure') : null,
                    exitCode: Number.isFinite(r.run?.outcome?.exitCode) ? r.run.outcome.exitCode : (r.existingTask.exitCode ?? null),
                    stdoutTail: r.existingTask.stdoutTail,
                    stderrTail: r.existingTask.stderrTail,
                  });
                }
              })
                .then(() => pushBoardSnapshot('runs_reconcile_batch', null))
                .catch(() => {
                  upsertedRunIds.forEach(id => watchdogGlobal.reconciledRunIds.delete(id));
                });
            }
          } catch {}
          const state = load();
          const sessions = state.sessions || {};
          const t = now();
          let changed = false;
          for (const [key, rec] of Object.entries(sessions)) {
            if (!rec || rec.status !== 'running') continue;
            if (!rec.startedMs || t - rec.startedMs < STALE_MS) continue;
            rec.status = 'stale';
            rec.staleAt = nowIso();
            rec.staleMs = t;
            changed = true;
            appendEvent({
              type: 'dispatch_stale',
              sessionKey: key,
              ageMs: t - rec.startedMs,
              bodyPreview: rec.bodyPreview || null
            });
            syncStaleToBoard(rec);
            maybeRecover(rec, api);
            api.logger.warn(`[aco-run-watchdog] stale dispatch detected sessionKey=${key} ageMs=${t - rec.startedMs}`);
          }
          if (changed) save(state);
        } catch (e) {
          api.logger.warn(`[aco-run-watchdog] interval failed: ${e.message}`);
        }
      }, 5000);  // Was 60000; reduced to 5s to catch ACP running state before tasks complete
      timer.unref?.();
      watchdogGlobal.intervalStarted = true;
    }

    // === Memory-core circuit breaker ===
    const MEMORY_BREAKER_THRESHOLD = 3;
    const MEMORY_BREAKER_TIMEOUT_MS = 30000; // 30s = considered hung
    const MEMORY_BREAKER_EVENTS_PATH = '/root/.openclaw/workspace/logs/memory-breaker-events.jsonl';

    function appendBreakerEvent(event) {
      try {
        ensureDir(MEMORY_BREAKER_EVENTS_PATH);
        fs.appendFileSync(MEMORY_BREAKER_EVENTS_PATH, JSON.stringify({ timestamp: nowIso(), ...event }) + '\n');
      } catch {}
    }

    // [H-06 fix] 不再自动写 openclaw.json，改为只记录建议
    function disableMemoryCore(api, reason) {
      try {
        api.logger.warn(`[aco-run-watchdog] memory-core circuit breaker TRIPPED: ${reason}. 建议手动禁用 memory-core 插件。`);
        appendBreakerEvent({ type: 'breaker_tripped', reason, action: 'log_recommendation_only' });
        // Notify user via lark-cli
        const msg = `⚠️ memory-core 熔断：${reason}。已自动禁用 memory-core，Gateway 将自动 reload。memory_search 降级为纯文本。`;
        execFile('lark-cli', ['im', '+messages-send',
          '--user-id', 'ou_ba47b9dd81419f75c4febdd199bde7d8',
          '--markdown', msg], { timeout: 15000 }, () => {});
      } catch (e) {
        api.logger.warn(`[aco-run-watchdog] memory-core breaker disable failed: ${e.message}`);
      }
    }

    // [tool-trace] Capture all tool calls and associate with running subagent sessions
    api.on('after_tool_call', (evt, ctx) => {
      if (!TOOL_TRACE_ENABLED) return;
      const sessionKey = ctx?.sessionKey || evt?.sessionKey || null;
      if (!sessionKey) return;
      // Only record for sessions that have an active trace buffer (i.e., spawned subagents)
      if (!watchdogGlobal.toolTraces.has(sessionKey)) return;
      const callRecord = {
        timestamp: nowIso(),
        tool_name: evt?.toolName || evt?.tool || 'unknown',
        params_summary: summarizeToolParams(evt),
        duration_ms: typeof evt?.durationMs === 'number' ? evt.durationMs : null,
        success: evt?.error ? false : true,
        error: evt?.error ? String(evt.error).slice(0, 200) : null,
      };
      appendToolTraceCall(sessionKey, callRecord);
    }, { priority: 60 }); // priority 60: run before memory breaker (50) but after most hooks

    api.on('after_tool_call', (evt) => {
      if (evt?.toolName !== 'memory_search') return;
      const breaker = watchdogGlobal.memoryBreaker;
      if (breaker.tripped) return; // already tripped this process lifetime
      const duration = evt?.durationMs || 0;
      const hasError = !!evt?.error;
      const isHung = duration >= MEMORY_BREAKER_TIMEOUT_MS;
      if (hasError || isHung) {
        breaker.consecutiveFails++;
        appendBreakerEvent({
          type: 'memory_search_fail',
          durationMs: duration,
          error: evt?.error || (isHung ? `timeout ${duration}ms` : null),
          consecutiveFails: breaker.consecutiveFails
        });
        if (breaker.consecutiveFails >= MEMORY_BREAKER_THRESHOLD) {
          breaker.tripped = true;
          breaker.lastTrippedAt = nowIso();
          disableMemoryCore(api, `memory_search 连续 ${breaker.consecutiveFails} 次失败/超时 (最近: ${duration}ms)`);
        }
      } else {
        // Success - reset counter
        if (breaker.consecutiveFails > 0) {
          breaker.consecutiveFails = 0;
          appendBreakerEvent({ type: 'memory_search_ok', durationMs: duration, resetCounter: true });
        }
      }
    }, { priority: 50 });

    if (!watchdogGlobal.registeredLogged) {
      api.logger.info('aco-run-watchdog: plugin registered (with memory-core breaker)');
      watchdogGlobal.registeredLogged = true;
    }
  }
};

export default plugin;
