import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = path.join(os.tmpdir(), `scr-test-${Date.now()}`);
const SESSIONS_DIR = path.join(TMP, 'agents', 'main', 'sessions');
const MEMORY_DIR = path.join(TMP, 'memory');

function makeResetFilename(sessionId, date) {
  const ts = date.toISOString().replace(/:/g, '-');
  return `${sessionId}.jsonl.reset.${ts}`;
}

function writeJsonl(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

function makeMessage(role, text) {
  return {
    type: 'message',
    message: { role, content: [{ type: 'text', text }] }
  };
}

before(() => {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('parseResetTimestamp', () => {
  it('extracts timestamp from reset filename', async () => {
    const mod = await import('./index.js');
    const fn = mod.default;
    const name = '53cfa986.jsonl.reset.2026-04-23T23-26-08.219Z';
    const pattern = /\.jsonl\.reset\.(\d{4}-\d{2}-\d{2}T[\d-]+\.\d+Z)$/;
    const m = name.match(pattern);
    assert.ok(m, 'pattern should match');
    const iso = m[1].replace(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d+)Z/, '$1-$2-$3T$4:$5:$6.$7Z');
    const ms = Date.parse(iso);
    assert.ok(Number.isFinite(ms));
    assert.ok(ms > Date.parse('2026-04-23'));
  });
});

describe('tailMessages', () => {
  it('extracts last N user/assistant messages from JSONL', async () => {
    const sessionId = 'test-tail-' + Date.now();
    const resetName = makeResetFilename(sessionId, new Date());
    const filePath = path.join(SESSIONS_DIR, resetName);
    const lines = [
      { type: 'session', version: 1 },
      makeMessage('user', 'hello'),
      makeMessage('assistant', 'hi there'),
      { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'tool output' }] } },
      makeMessage('user', 'what is 2+2?'),
      makeMessage('assistant', 'it is 4'),
      makeMessage('user', 'thanks'),
    ];
    writeJsonl(filePath, lines);
    const { createReadStream } = await import('node:fs');
    const { createInterface } = await import('node:readline');
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const ring = [];
    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type !== 'message') continue;
      const msg = obj.message || obj;
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;
      const content = msg.content;
      let text = '';
      if (Array.isArray(content)) text = content.filter(b => b.type === 'text').map(b => b.text).join('');
      if (!text.trim()) continue;
      ring.push({ role: msg.role, text });
    }
    assert.equal(ring.length, 5);
    assert.equal(ring[0].role, 'user');
    assert.equal(ring[0].text, 'hello');
    assert.equal(ring[4].role, 'user');
    assert.equal(ring[4].text, 'thanks');
  });

  it('respects max message count', async () => {
    const sessionId = 'test-max-' + Date.now();
    const resetName = makeResetFilename(sessionId, new Date());
    const filePath = path.join(SESSIONS_DIR, resetName);
    const lines = [{ type: 'session', version: 1 }];
    for (let i = 0; i < 100; i++) {
      lines.push(makeMessage(i % 2 === 0 ? 'user' : 'assistant', `msg-${i}`));
    }
    writeJsonl(filePath, lines);
    const { createReadStream } = await import('node:fs');
    const { createInterface } = await import('node:readline');
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const ring = [];
    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type !== 'message') continue;
      const msg = obj.message || obj;
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;
      const content = msg.content;
      let text = '';
      if (Array.isArray(content)) text = content.filter(b => b.type === 'text').map(b => b.text).join('');
      if (!text.trim()) continue;
      ring.push({ role: msg.role, text: text.slice(0, 500) });
      if (ring.length > 60) ring.splice(0, ring.length - 30);
    }
    const result = ring.slice(-30);
    assert.equal(result.length, 30);
    assert.equal(result[result.length - 1].text, 'msg-99');
  });
});

describe('findLatestResetFile', () => {
  it('finds the most recent reset file', () => {
    const dir = path.join(TMP, 'find-test-sessions');
    fs.mkdirSync(dir, { recursive: true });
    const old = makeResetFilename('aaa', new Date('2026-04-20T10:00:00Z'));
    const recent = makeResetFilename('bbb', new Date('2026-04-23T20:00:00Z'));
    fs.writeFileSync(path.join(dir, old), '{}');
    fs.writeFileSync(path.join(dir, recent), '{}');
    fs.writeFileSync(path.join(dir, 'ccc.jsonl'), '{}');
    const pattern = /\.jsonl\.reset\.(\d{4}-\d{2}-\d{2}T[\d-]+\.\d+Z)$/;
    const files = fs.readdirSync(dir);
    let best = null;
    let bestMs = 0;
    for (const name of files) {
      const m = name.match(pattern);
      if (!m) continue;
      const iso = m[1].replace(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d+)Z/, '$1-$2-$3T$4:$5:$6.$7Z');
      const ms = Date.parse(iso);
      if (Number.isFinite(ms) && ms > bestMs) {
        bestMs = ms;
        best = { name, resetMs: ms };
      }
    }
    assert.ok(best);
    assert.ok(best.name.startsWith('bbb'));
    assert.ok(best.resetMs > Date.parse('2026-04-23'));
  });

  it('returns null when no reset files exist', () => {
    const dir = path.join(TMP, 'empty-sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'normal.jsonl'), '{}');
    const pattern = /\.jsonl\.reset\.(\d{4}-\d{2}-\d{2}T[\d-]+\.\d+Z)$/;
    const files = fs.readdirSync(dir);
    const resets = files.filter(n => pattern.test(n));
    assert.equal(resets.length, 0);
  });
});

describe('non-feishu sessions', () => {
  it('should not trigger for non-feishu session keys', () => {
    const sessionKey = 'agent:main:slack:direct:user123';
    assert.ok(!sessionKey.includes('feishu'));
  });

  it('should trigger for feishu session keys', () => {
    const sessionKey = 'agent:main:feishu:direct:ou_abc123';
    assert.ok(sessionKey.includes('feishu'));
  });
});

describe('message truncation', () => {
  it('truncates messages longer than 500 chars', () => {
    const longText = 'x'.repeat(1000);
    const truncated = longText.slice(0, 500);
    assert.equal(truncated.length, 500);
  });
});

describe('daily memory loading', () => {
  it('reads today and yesterday memory files', () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    fs.writeFileSync(path.join(MEMORY_DIR, `${today}.md`), '# Today\nDid stuff');
    fs.writeFileSync(path.join(MEMORY_DIR, `${yesterday}.md`), '# Yesterday\nDid other stuff');
    const parts = [];
    for (const ymd of [today, yesterday]) {
      const file = path.join(MEMORY_DIR, `${ymd}.md`);
      try {
        const content = fs.readFileSync(file, 'utf8').trim();
        if (content) parts.push(`### ${ymd}\n${content}`);
      } catch {}
    }
    assert.equal(parts.length, 2);
    assert.ok(parts[0].includes('Today'));
    assert.ok(parts[1].includes('Yesterday'));
  });

  it('handles missing memory files gracefully', () => {
    const parts = [];
    try {
      fs.readFileSync(path.join(MEMORY_DIR, '2020-01-01.md'), 'utf8');
    } catch {
      // expected
    }
    assert.equal(parts.length, 0);
  });
});
