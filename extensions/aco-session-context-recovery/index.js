import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const AGENTS_ROOT = '/root/.openclaw/agents';
const MEMORY_DIR = '/root/.openclaw/workspace/memory';
const EXTRACTIONS_DIR = '/root/.openclaw/workspace/memory/extractions';
const TMP_DIR = '/root/.openclaw/extensions/aco-session-context-recovery/tmp';
const RESET_WINDOW_MS = 5 * 60 * 1000;
const MAX_MESSAGES = 30;
const MAX_CHARS_PER_MSG = 500;
const RESET_FILE_PATTERN = /\.jsonl\.reset\.(\d{4}-\d{2}-\d{2}T[\d-]+\.\d+Z)$/;

function parseResetTimestamp(filename) {
  const m = filename.match(RESET_FILE_PATTERN);
  if (!m) return null;
  const iso = m[1].replace(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d+)Z/, '$1-$2-$3T$4:$5:$6.$7Z');
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function findLatestResetFile(sessionsDir) {
  let files;
  try { files = fs.readdirSync(sessionsDir); } catch { return null; }
  let best = null;
  let bestMs = 0;
  for (const name of files) {
    const ms = parseResetTimestamp(name);
    if (ms && ms > bestMs) {
      bestMs = ms;
      best = { path: path.join(sessionsDir, name), resetMs: ms, name };
    }
  }
  return best;
}

async function tailMessages(filePath, count) {
  const stat = fs.statSync(filePath);
  const startByte = Math.max(0, stat.size - 2 * 1024 * 1024);
  const stream = createReadStream(filePath, { start: startByte, encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const ring = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== 'message') continue;
    const msg = obj.message || obj;
    const role = msg.role;
    if (role !== 'user' && role !== 'assistant') continue;
    let text = '';
    const content = msg.content;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text)
        .join('\n');
    }
    if (!text.trim()) continue;
    ring.push({ role, text: text.slice(0, MAX_CHARS_PER_MSG) });
    if (ring.length > count * 2) ring.splice(0, ring.length - count);
  }
  return ring.slice(-count);
}

function loadDailyMemory() {
  const parts = [];
  const today = new Date();
  for (let offset = 0; offset <= 1; offset++) {
    const d = new Date(today);
    d.setDate(d.getDate() - offset);
    const ymd = d.toISOString().slice(0, 10);
    const file = path.join(MEMORY_DIR, `${ymd}.md`);
    try {
      const content = fs.readFileSync(file, 'utf8').trim();
      if (content) parts.push(`### ${ymd}\n${content}`);
    } catch {}
  }
  return parts.join('\n\n');
}

function findLatestExtraction(resetFilePath = '') {
  let files;
  try { files = fs.readdirSync(EXTRACTIONS_DIR); } catch { return null; }
  const markdownFiles = files
    .filter(name => name.endsWith('.md'))
    .map(name => {
      const filePath = path.join(EXTRACTIONS_DIR, name);
      try {
        const stat = fs.statSync(filePath);
        return { path: filePath, name, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (!markdownFiles.length) return null;

  const resetBase = resetFilePath ? path.basename(resetFilePath) : '';
  for (const item of markdownFiles) {
    try {
      const content = fs.readFileSync(item.path, 'utf8');
      if (resetFilePath && (content.includes(resetFilePath) || content.includes(resetBase))) {
        return { ...item, content };
      }
    } catch {}
  }

  try {
    const content = fs.readFileSync(markdownFiles[0].path, 'utf8');
    return { ...markdownFiles[0], content };
  } catch {
    return null;
  }
}

function buildRecoverySummary(messages, dailyMemory, resetFile, extraction) {
  const resetTime = new Date(resetFile.resetMs).toISOString();
  const lines = [
    '⚠️ 会话上下文恢复通知：本会话由 session reset 触发（上一个会话 transcript 过大被归档）。以下内容用于保持上下文连续性。',
    '',
    `归档文件: ${resetFile.path}`,
    '',
  ];
  if (extraction?.content) {
    lines.push('--- 压缩前会话关键信息提取 ---');
    lines.push(extraction.content.trim());
    lines.push('');
    lines.push(`⚠️ 本会话在 ${resetTime} 经历了 context 压缩。以上是从压缩前会话中提取的关键决策。如果对任何结论有疑虑，请直接读取原始 reset 文件验证，不要过度依赖提取摘要或注入的 30 条消息。原始文件路径：${resetFile.path}`);
    lines.push('');
  } else {
    lines.push(`⚠️ 本会话在 ${resetTime} 经历了 context 压缩，但暂未找到对应的关键信息提取文件。请直接读取原始 reset 文件验证关键结论。原始文件路径：${resetFile.path}`);
    lines.push('');
  }
  lines.push('--- 上一会话最近对话 ---');
  for (const m of messages) {
    const tag = m.role === 'user' ? '👤 用户' : '🤖 助手';
    lines.push(`${tag}: ${m.text}`);
    lines.push('');
  }
  if (dailyMemory) {
    lines.push('--- 今日工作记忆 ---');
    lines.push(dailyMemory);
  }
  return lines.join('\n');
}

const plugin = {
  id: 'aco-session-context-recovery',
  name: 'Session Context Recovery',
  version: '0.1.0',
  register(api) {
    api.on('before_prompt_build', async (event, context) => {
      try {
        const ctx = context || event?.context || {};
        const sessionKey = String(ctx.sessionKey || event?.sessionKey || '');
        if (!sessionKey.includes('feishu')) return null;
        const agentId = String(ctx.agentId || '').trim();
        const effectiveAgentId = (!agentId || agentId === 'main') ? 'main' : agentId;
        if (effectiveAgentId !== 'main') return null;
        const sessionsDir = path.join(AGENTS_ROOT, effectiveAgentId, 'sessions');
        const resetFile = findLatestResetFile(sessionsDir);
        if (!resetFile) return null;
        const ageMs = Date.now() - resetFile.resetMs;
        if (ageMs > RESET_WINDOW_MS) return null;
        const markerKey = Symbol.for('openclaw.aco-session-context-recovery.injected');
        if (globalThis[markerKey]?.has?.(sessionKey)) return null;
        if (!globalThis[markerKey]) globalThis[markerKey] = new Set();
        globalThis[markerKey].add(sessionKey);
        const messages = await tailMessages(resetFile.path, MAX_MESSAGES);
        if (!messages.length) return null;
        const dailyMemory = loadDailyMemory();
        const extraction = findLatestExtraction(resetFile.path);
        const summary = buildRecoverySummary(messages, dailyMemory, resetFile, extraction);
        fs.mkdirSync(TMP_DIR, { recursive: true });
        const tmpFile = path.join(TMP_DIR, `recovery-${Date.now()}.md`);
        fs.writeFileSync(tmpFile, summary);
        api.logger?.info?.(`[aco-session-context-recovery] injected recovery context for ${sessionKey} from ${resetFile.name} (${messages.length} msgs, extraction=${extraction?.name || 'none'}, age=${Math.round(ageMs / 1000)}s)`);
        return { prependContext: summary };
      } catch (err) {
        api.logger?.warn?.(`[aco-session-context-recovery] error: ${err.message}`);
        return null;
      }
    }, { priority: 990 });
    api.logger?.info?.('[aco-aco-session-context-recovery] plugin registered');
  }
};

export default plugin;
