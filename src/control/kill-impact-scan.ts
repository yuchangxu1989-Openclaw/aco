/**
 * FR-K04: Kill impact scan
 *
 * Deterministic scanner that snapshots dirty worktree files before a Gateway
 * kill call, scans again after the kill, and reports what the killed session
 * may have left behind. No LLM, no rollback, no stash.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, appendFileSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';

export type KillImpactRiskLevel = 'low' | 'medium' | 'high';
export type KillImpactRecommendedAction = 'safe_to_proceed' | 'review_diff' | 'consider_stash_first';
export type KillImpactFileStatus = 'added' | 'modified' | 'deleted' | 'untracked' | 'reverted';

export interface KillImpactScanConfig {
  enabled?: boolean;
  outputDir?: string;
  repoRoot?: string;
  boardPath?: string;
  highRiskPathPrefixes?: string[];
  mediumRiskPathPrefixes?: string[];
  maxFileScan?: number;
  maxBoardScanBytes?: number;
  auditLogPath?: string;
}

export interface NormalizedKillImpactScanConfig {
  enabled: boolean;
  outputDir: string;
  repoRoot: string;
  boardPath: string;
  highRiskPathPrefixes: string[];
  mediumRiskPathPrefixes: string[];
  maxFileScan: number;
  maxBoardScanBytes: number;
  auditLogPath: string;
}

interface SnapshotFile {
  path: string;
  gitCode: string;
  status: KillImpactFileStatus;
  mtime: number;
  sizeBytes: number;
  hash: string | null;
}

export interface KillImpactSnapshot {
  sessionKey: string;
  takenAt: number;
  taskStartedAt: number;
  taskLabel: string;
  taskStatus: string;
  taskLastWriteAt: number;
  files: SnapshotFile[];
}

export interface AffectedFile {
  path: string;
  status: KillImpactFileStatus;
  mtime: number;
  sizeBytes: number;
}

export interface AffectedBoardEntry {
  taskId: string;
  label: string;
  status: string;
  lastWriteAt: number;
}

export interface KillImpactReport {
  sessionKey: string;
  killAt: number;
  taskStartedAt: number;
  taskLabel: string;
  affectedFiles: AffectedFile[];
  affectedBoardEntries: AffectedBoardEntry[];
  riskLevel: KillImpactRiskLevel;
  recommendedAction: KillImpactRecommendedAction;
}

export interface KillImpactDisabledReport {
  sessionKey: string;
  killAt: number;
  scanDisabled: true;
}

export interface KillImpactFailedReport {
  sessionKey: string;
  killAt: number;
  scanFailed: true;
  errorMessage: string;
}

export type KillImpactScanResult = KillImpactReport | KillImpactDisabledReport | KillImpactFailedReport;

const GIT_STATUS_COMMAND_FOR_AUDIT = 'git status --porcelain=v1 -uall';

function getDefaultOpenclawHome(): string {
  return process.env.OPENCLAW_HOME ?? join(homedir(), '.openclaw');
}

export function getDefaultKillImpactScanConfig(): NormalizedKillImpactScanConfig {
  const home = getDefaultOpenclawHome();
  return {
    enabled: true,
    outputDir: join(home, 'workspace', 'logs'),
    repoRoot: join(home, 'workspace'),
    boardPath: join(home, 'workspace', 'logs', 'subagent-task-board.json'),
    highRiskPathPrefixes: ['src/', 'docs/'],
    mediumRiskPathPrefixes: ['reports/', 'logs/'],
    maxFileScan: 1000,
    maxBoardScanBytes: 10 * 1024 * 1024,
    auditLogPath: join(home, 'workspace', 'logs', 'dispatch-guard-events.jsonl'),
  };
}

export const DEFAULT_KILL_IMPACT_SCAN_CONFIG: NormalizedKillImpactScanConfig = getDefaultKillImpactScanConfig();

export function normalizeKillImpactScanConfig(config: KillImpactScanConfig = {}): NormalizedKillImpactScanConfig {
  const outputDir = typeof config.outputDir === 'string' && config.outputDir.trim()
    ? config.outputDir.trim()
    : DEFAULT_KILL_IMPACT_SCAN_CONFIG.outputDir;
  return {
    enabled: config.enabled ?? DEFAULT_KILL_IMPACT_SCAN_CONFIG.enabled,
    outputDir,
    repoRoot: typeof config.repoRoot === 'string' && config.repoRoot.trim()
      ? config.repoRoot.trim()
      : DEFAULT_KILL_IMPACT_SCAN_CONFIG.repoRoot,
    boardPath: typeof config.boardPath === 'string' && config.boardPath.trim()
      ? config.boardPath.trim()
      : DEFAULT_KILL_IMPACT_SCAN_CONFIG.boardPath,
    highRiskPathPrefixes: sanitizePrefixes(config.highRiskPathPrefixes, DEFAULT_KILL_IMPACT_SCAN_CONFIG.highRiskPathPrefixes),
    mediumRiskPathPrefixes: sanitizePrefixes(config.mediumRiskPathPrefixes, DEFAULT_KILL_IMPACT_SCAN_CONFIG.mediumRiskPathPrefixes),
    maxFileScan: positiveIntegerOrDefault(config.maxFileScan, DEFAULT_KILL_IMPACT_SCAN_CONFIG.maxFileScan),
    maxBoardScanBytes: positiveIntegerOrDefault(config.maxBoardScanBytes, DEFAULT_KILL_IMPACT_SCAN_CONFIG.maxBoardScanBytes),
    auditLogPath: typeof config.auditLogPath === 'string' && config.auditLogPath.trim()
      ? config.auditLogPath.trim()
      : join(outputDir, 'dispatch-guard-events.jsonl'),
  };
}

export function validateKillImpactScanConfig(config: unknown): string[] {
  const errors: string[] = [];
  if (config === undefined) return errors;
  if (typeof config !== 'object' || config === null) return ['killImpactScan must be an object'];
  const cfg = config as Record<string, unknown>;
  if (cfg.enabled !== undefined && typeof cfg.enabled !== 'boolean') errors.push('killImpactScan.enabled must be a boolean');
  validateWritableDirectory(errors, cfg.outputDir, 'killImpactScan.outputDir');
  validateExistingDirectory(errors, cfg.repoRoot, 'killImpactScan.repoRoot');
  validateNonEmptyStringValue(errors, cfg.boardPath, 'killImpactScan.boardPath');
  validateStringArray(errors, cfg.highRiskPathPrefixes, 'killImpactScan.highRiskPathPrefixes');
  validateStringArray(errors, cfg.mediumRiskPathPrefixes, 'killImpactScan.mediumRiskPathPrefixes');
  validatePositiveInteger(errors, cfg.maxFileScan, 'killImpactScan.maxFileScan');
  validatePositiveInteger(errors, cfg.maxBoardScanBytes, 'killImpactScan.maxBoardScanBytes');
  return errors;
}

export function takeKillImpactSnapshot(sessionKey: string, config: KillImpactScanConfig = {}, nowMs = Date.now()): KillImpactSnapshot {
  const cfg = normalizeKillImpactScanConfig(config);
  const board = readBoardEntries(cfg);
  const task = findBoardTask(board, sessionKey);
  const taskStartedAt = extractTimestamp(task, ['startedAt', 'createdAt', 'startTime']) ?? nowMs;
  const taskLabel = extractString(task, ['label', 'taskLabel']) ?? '';
  const taskStatus = extractString(task, ['status']) ?? '';
  const taskLastWriteAt = extractTimestamp(task, ['lastWriteAt', 'updatedAt', 'completedAt', 'finishedAt']) ?? taskStartedAt;
  return {
    sessionKey,
    takenAt: nowMs,
    taskStartedAt,
    taskLabel,
    taskStatus,
    taskLastWriteAt,
    files: collectGitStatusFiles(cfg),
  };
}

export function scanKillImpactAfterKill(
  sessionKey: string,
  snapshot: KillImpactSnapshot,
  config: KillImpactScanConfig = {},
  killAt = Date.now(),
): KillImpactReport {
  const cfg = normalizeKillImpactScanConfig(config);
  const current = collectGitStatusFiles(cfg);
  const currentByPath = new Map(current.map(file => [file.path, file]));
  const affectedByPath = new Map<string, AffectedFile>();

  for (const file of current) {
    if (file.status === 'deleted' || file.mtime >= snapshot.taskStartedAt) {
      affectedByPath.set(file.path, {
        path: file.path,
        status: file.status,
        mtime: file.mtime,
        sizeBytes: file.sizeBytes,
      });
    }
  }

  for (const file of snapshot.files) {
    if (currentByPath.has(file.path) || (file.status !== 'deleted' && file.mtime < snapshot.taskStartedAt)) continue;
    affectedByPath.set(file.path, {
      path: file.path,
      status: detectRevertedStatus(cfg.repoRoot, file),
      mtime: file.mtime,
      sizeBytes: file.sizeBytes,
    });
  }

  const affectedFiles = Array.from(affectedByPath.values()).sort((a, b) => a.path.localeCompare(b.path));
  const affectedBoardEntries = findAffectedBoardEntries(readBoardEntries(cfg), sessionKey, snapshot.taskStartedAt, killAt);
  const riskLevel = classifyKillImpactRisk(affectedFiles, affectedBoardEntries, cfg);
  return {
    sessionKey,
    killAt,
    taskStartedAt: snapshot.taskStartedAt,
    taskLabel: snapshot.taskLabel,
    affectedFiles,
    affectedBoardEntries,
    riskLevel,
    recommendedAction: recommendedActionForRisk(riskLevel),
  };
}

export function persistKillImpactReport(report: KillImpactScanResult, config: KillImpactScanConfig = {}): void {
  const cfg = normalizeKillImpactScanConfig(config);
  mkdirSync(cfg.outputDir, { recursive: true });
  appendFileSync(join(cfg.outputDir, 'aco-kill-impact.jsonl'), JSON.stringify(report) + '\n', 'utf-8');
}

export function buildKillImpactDisabledReport(sessionKey: string, killAt = Date.now()): KillImpactDisabledReport {
  return { sessionKey, killAt, scanDisabled: true };
}

export function buildKillImpactFailedReport(sessionKey: string, error: unknown, killAt = Date.now()): KillImpactFailedReport {
  return { sessionKey, killAt, scanFailed: true, errorMessage: truncateError(error) };
}

export function appendKillImpactAuditEvent(decision: 'kill_impact_scan_failed' | 'kill_impact_scan_disabled', report: KillImpactScanResult, config: KillImpactScanConfig = {}): void {
  const cfg = normalizeKillImpactScanConfig(config);
  try {
    mkdirSync(dirname(cfg.auditLogPath), { recursive: true });
    const timestamp = new Date('killAt' in report ? report.killAt : Date.now()).toISOString();
    appendFileSync(cfg.auditLogPath, JSON.stringify({
      ts: timestamp,
      timestamp,
      eventType: 'dispatch.kill_impact_scan',
      rule: 'kill-impact-scan',
      decision,
      sessionKey: report.sessionKey,
      details: report,
    }) + '\n', 'utf-8');
  } catch {
    // Audit failure must not block kill.
  }
}

export function classifyKillImpactRisk(
  affectedFiles: Array<{ path: string }>,
  affectedBoardEntries: AffectedBoardEntry[],
  config: Pick<NormalizedKillImpactScanConfig, 'highRiskPathPrefixes' | 'mediumRiskPathPrefixes'> = DEFAULT_KILL_IMPACT_SCAN_CONFIG,
): KillImpactRiskLevel {
  if (affectedFiles.length === 0) return 'low';
  if (affectedFiles.some(file => matchesAnyPrefix(file.path, config.highRiskPathPrefixes))) return 'high';
  return 'medium';
}

export function recommendedActionForRisk(riskLevel: KillImpactRiskLevel): KillImpactRecommendedAction {
  switch (riskLevel) {
    case 'low': return 'safe_to_proceed';
    case 'medium': return 'review_diff';
    case 'high': return 'consider_stash_first';
  }
}

export function readKillImpactReports(logPath = join(getDefaultOpenclawHome(), 'workspace', 'logs', 'aco-kill-impact.jsonl')): KillImpactScanResult[] {
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, 'utf-8').trim();
  if (!raw) return [];
  return raw.split('\n').map(line => JSON.parse(line) as KillImpactScanResult);
}

function collectGitStatusFiles(cfg: NormalizedKillImpactScanConfig): SnapshotFile[] {
  const output = execFileSync('git', ['status', '--porcelain=v1', '-uall'], {
    cwd: cfg.repoRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const files = parseGitStatus(output, cfg.repoRoot);
  if (files.length > cfg.maxFileScan) throw new Error(`kill impact scan exceeded maxFileScan=${cfg.maxFileScan}`);
  return files;
}

function parseGitStatus(output: string, repoRoot: string): SnapshotFile[] {
  return output.split('\n').filter(Boolean).map(line => {
    const gitCode = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    const pathPart = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop()! : rawPath;
    const normalizedPath = normalizePath(pathPart.replace(/^"|"$/g, ''));
    const absolutePath = join(repoRoot, normalizedPath);
    const stat = safeStat(absolutePath);
    return {
      path: normalizedPath,
      gitCode,
      status: mapGitStatus(gitCode),
      mtime: stat?.mtimeMs ?? 0,
      sizeBytes: stat?.size ?? 0,
      hash: hashFile(absolutePath),
    };
  });
}

function mapGitStatus(code: string): KillImpactFileStatus {
  if (code === '??') return 'untracked';
  const primary = code[0] !== ' ' ? code[0] : code[1];
  if (primary === 'A') return 'added';
  if (primary === 'D') return 'deleted';
  return 'modified';
}

function detectRevertedStatus(repoRoot: string, snapshotFile: SnapshotFile): KillImpactFileStatus {
  if (snapshotFile.hash === null) return snapshotFile.status;
  const absolutePath = join(repoRoot, snapshotFile.path);
  if (!existsSync(absolutePath)) return snapshotFile.status;
  const currentHash = hashFile(absolutePath);
  if (currentHash === null || currentHash === snapshotFile.hash) return snapshotFile.status;
  const headHash = hashHeadFile(repoRoot, snapshotFile.path);
  return headHash !== null && currentHash === headHash ? 'reverted' : snapshotFile.status;
}

function hashFile(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 32);
  } catch {
    return null;
  }
}

function hashHeadFile(repoRoot: string, filePath: string): string | null {
  try {
    const content = execFileSync('git', ['show', `HEAD:${filePath}`], { cwd: repoRoot });
    return createHash('sha256').update(content).digest('hex').slice(0, 32);
  } catch {
    return null;
  }
}

function safeStat(path: string): { mtimeMs: number; size: number } | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function readBoardEntries(cfg: NormalizedKillImpactScanConfig): unknown[] {
  if (!existsSync(cfg.boardPath)) return [];
  const stat = statSync(cfg.boardPath);
  if (stat.size > cfg.maxBoardScanBytes) throw new Error(`kill impact scan exceeded maxBoardScanBytes=${cfg.maxBoardScanBytes}`);
  const parsed = JSON.parse(readFileSync(cfg.boardPath, 'utf-8')) as unknown;
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.tasks)) return obj.tasks;
    if (Array.isArray(obj.items)) return obj.items;
    if (Array.isArray(obj.entries)) return obj.entries;
    return Object.values(obj).filter(v => v && typeof v === 'object');
  }
  return [];
}

function findBoardTask(entries: unknown[], sessionKey: string): Record<string, unknown> | null {
  return entries.map(asRecord).find(entry => Boolean(entry) && recordContainsSession(entry!, sessionKey)) ?? null;
}

function findAffectedBoardEntries(entries: unknown[], sessionKey: string, startedAt: number, killAt: number): AffectedBoardEntry[] {
  const out: AffectedBoardEntry[] = [];
  for (const raw of entries) {
    const entry = asRecord(raw);
    if (!entry || !recordContainsSession(entry, sessionKey)) continue;
    const lastWriteAt = extractTimestamp(entry, ['lastWriteAt', 'updatedAt', 'completedAt', 'finishedAt', 'startedAt', 'createdAt']) ?? 0;
    if (lastWriteAt < startedAt || lastWriteAt > killAt) continue;
    out.push({
      taskId: extractString(entry, ['taskId', 'id', 'sessionId', 'sessionKey']) ?? sessionKey,
      label: extractString(entry, ['label', 'taskLabel']) ?? '',
      status: extractString(entry, ['status']) ?? '',
      lastWriteAt,
    });
  }
  return out;
}

function recordContainsSession(entry: Record<string, unknown>, sessionKey: string): boolean {
  return ['sessionKey', 'sessionId', 'id', 'taskId'].some(key => entry[key] === sessionKey)
    || JSON.stringify({ label: entry.label, reportPath: entry.reportPath, report: entry.report }).includes(sessionKey);
}

function extractString(entry: Record<string, unknown> | null, keys: string[]): string | null {
  if (!entry) return null;
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

function extractTimestamp(entry: Record<string, unknown> | null, keys: string[]): number | null {
  if (!entry) return null;
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function matchesAnyPrefix(filePath: string, prefixes: string[]): boolean {
  return prefixes.some(prefix => filePath.startsWith(prefix));
}

function sanitizePrefixes(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim())
    ? value.map(item => normalizePath(item.trim()))
    : fallback;
}

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function validateNonEmptyStringValue(errors: string[], value: unknown, path: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.trim().length === 0) errors.push(`${path} must be a non-empty string`);
}

function validateExistingDirectory(errors: string[], value: unknown, path: string): void {
  validateNonEmptyStringValue(errors, value, path);
  if (typeof value !== 'string' || value.trim().length === 0) return;
  try {
    if (!statSync(value).isDirectory()) errors.push(`${path} must be an existing directory`);
  } catch {
    errors.push(`${path} must be an existing directory`);
  }
}

function validateWritableDirectory(errors: string[], value: unknown, path: string): void {
  validateExistingDirectory(errors, value, path);
  if (typeof value !== 'string' || value.trim().length === 0) return;
  try {
    accessSync(value, constants.W_OK);
  } catch {
    errors.push(`${path} must be writable`);
  }
}

function validateStringArray(errors: string[], value: unknown, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim().length === 0)) {
    errors.push(`${path} must be an array of non-empty strings`);
  }
}

function validatePositiveInteger(errors: string[], value: unknown, path: string): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) errors.push(`${path} must be a positive integer`);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function truncateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 256);
}

export function toRepoRelativePath(repoRoot: string, filePath: string): string {
  return normalizePath(isAbsolute(filePath) ? relative(repoRoot, filePath) : filePath);
}
