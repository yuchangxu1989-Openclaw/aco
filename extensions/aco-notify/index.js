import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const AUDIT_LOG_PATH = '/root/.openclaw/workspace/logs/aco-notify-closure-events.jsonl';

const NOTIFY_USER_ID = 'ou_ba47b9dd81419f75c4febdd199bde7d8';

export default {
  id: 'aco-notify',
  name: 'aco-notify',
  version: '1.6.1',
  description: 'Dual-mechanism: L2 message_sending auto-forward + L6 before_prompt_build reminder',

  register(api) {
    const config = api.pluginConfig?.['aco-notify'] || {};
    const userId = config.userId || config.notify?.userId || NOTIFY_USER_ID;
    const excludeLabels = config.excludeLabels || ['healthcheck', 'heartbeat'];
    const closureTimeoutMs = config.closureTimeoutMs || 120000;
    const minForwardContentLength = config.minForwardContentLength || 20;

    const spawnedSessions = new Map();
    const pendingClosures = new Map();

    function shouldExclude(label) {
      if (!label) return false;
      return excludeLabels.some(pattern => {
        if (pattern.startsWith('/') && pattern.endsWith('/')) {
          return new RegExp(pattern.slice(1, -1)).test(label);
        }
        return label.startsWith(pattern);
      });
    }

    function formatDuration(ms) {
      if (!ms || ms <= 0) return '?';
      const sec = Math.round(ms / 1000);
      if (sec < 60) return `${sec}s`;
      const min = Math.floor(sec / 60);
      const remainSec = sec % 60;
      if (remainSec === 0) return `${min}min`;
      return `${min}m${remainSec}s`;
    }

    function extractAgentId(sessionKey) {
      if (!sessionKey) return 'unknown';
      const parts = sessionKey.split(':');
      if (parts.length >= 2 && parts[0] === 'agent') return parts[1];
      return 'unknown';
    }

    function appendAuditLog(entry) {
      try {
        fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
        const record = {
          timestamp: new Date().toISOString(),
          plugin: 'aco-notify',
          ...entry,
        };
        fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(record) + '\n');
      } catch (e) {
        api.logger?.warn?.(`[aco-notify] audit log write failed: ${e.message}`);
      }
    }

    function sendToFeishu(content) {
      const truncated = content.length > 4000
        ? content.slice(0, 4000) + '\n\n...（详细内容已省略）'
        : content;
      const escaped = truncated.replace(/'/g, "'\\''");
      const cmd = `lark-cli im +messages-send --user-id ${userId} --markdown '${escaped}'`;
      try {
        execSync(cmd, { timeout: 15000, stdio: 'pipe' });
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    function handleClosureTimeout(closureId, data) {
      const { agentId, label, duration } = data;
      appendAuditLog({
        event: 'closure_missed',
        closureId,
        agentId,
        label,
        duration,
        reason: `no summary detected within ${closureTimeoutMs}ms`,
      });
      pendingClosures.delete(closureId);
    }

    function isExecTool(toolName) {
      if (!toolName) return false;
      const normalized = toolName.toLowerCase();
      return normalized === 'bash' || normalized === 'exec' || normalized === 'shell';
    }

    function resolveOutboundContext(event = {}, ctx = {}) {
      const ctxSessionKey = String(ctx?.sessionKey || ctx?.sessionId || '');
      const eventSessionKey = String(event?.sessionKey || event?.metadata?.sessionKey || '');
      const sessionKey = ctxSessionKey || eventSessionKey;
      const channel = String(ctx?.channelId || event?.metadata?.channel || event?.channel || '');
      const to = String(event?.to || ctx?.conversationId || '');
      const content = String(event?.content || '');
      const explicitAgentId = String(ctx?.agentId || event?.agentId || event?.metadata?.agentId || '').trim();
      const parsedAgentId = extractAgentId(sessionKey);
      const effectiveAgentId = explicitAgentId || (parsedAgentId === 'unknown' ? '' : parsedAgentId);

      const hasPending = pendingClosures.size > 0;
      const contentLongEnough = content.trim().length >= minForwardContentLength;
      const isFeishuChannel = channel === 'feishu' || sessionKey.includes(':feishu:') || sessionKey.includes('feishu');
      const targetMatchesUser = to === userId || to.includes(userId);
      const sessionAllowsMain = effectiveAgentId ? effectiveAgentId === 'main' : true;

      return {
        ctxSessionKey,
        eventSessionKey,
        sessionKey,
        channel,
        to,
        content,
        explicitAgentId,
        effectiveAgentId: effectiveAgentId || 'unknown',
        hasPending,
        pendingSize: pendingClosures.size,
        contentLength: content.length,
        minForwardContentLength,
        contentLongEnough,
        isFeishuChannel,
        targetMatchesUser,
        sessionAllowsMain,
        shouldForward: hasPending && contentLongEnough && isFeishuChannel && targetMatchesUser && sessionAllowsMain,
      };
    }

    function appendMessageSendingDebug(resolved) {
      appendAuditLog({
        event: 'message_sending_debug',
        invoked: true,
        pendingSize: resolved.pendingSize,
        contentLength: resolved.contentLength,
        ctxSessionKey: resolved.ctxSessionKey || null,
        eventSessionKey: resolved.eventSessionKey || null,
        channel: resolved.channel || null,
        to: resolved.to || null,
        explicitAgentId: resolved.explicitAgentId || null,
        effectiveAgentId: resolved.effectiveAgentId,
        checks: {
          hasPending: resolved.hasPending,
          contentLongEnough: resolved.contentLongEnough,
          minForwardContentLength: resolved.minForwardContentLength,
          isFeishuChannel: resolved.isFeishuChannel,
          targetMatchesUser: resolved.targetMatchesUser,
          sessionAllowsMain: resolved.sessionAllowsMain,
          shouldForward: resolved.shouldForward,
        },
        pendingClosureIds: [...pendingClosures.keys()].slice(0, 5),
      });
    }

    // --- Event: subagent_spawned ---
    api.on('subagent_spawned', (event) => {
      try {
        const key = event.childSessionKey;
        if (!key) return;
        spawnedSessions.set(key, {
          label: event.label || '',
          agentId: event.agentId || extractAgentId(key),
          spawnedAt: Date.now()
        });
        if (spawnedSessions.size > 200) {
          const cutoff = Date.now() - 2 * 60 * 60 * 1000;
          for (const [k, v] of spawnedSessions) {
            if (v.spawnedAt < cutoff) spawnedSessions.delete(k);
          }
        }
      } catch {}
    });

    // --- Event: subagent_ended ---
    api.on('subagent_ended', (event) => {
      try {
        const sessionKey = event.targetSessionKey || '';
        const isAcp = sessionKey.includes(':acp:');
        const isSubagent = sessionKey.includes(':subagent:');
        if (!isAcp && !isSubagent) return;

        const spawnData = spawnedSessions.get(sessionKey);
        if (spawnData) spawnedSessions.delete(sessionKey);

        const agentId = spawnData?.agentId || extractAgentId(sessionKey);
        const label = spawnData?.label || '';
        if (shouldExclude(label)) return;

        const outcome = String(event.outcome || '').toLowerCase();
        const failed = outcome === 'error' || outcome === 'timeout';
        const icon = failed ? '❌' : '✅';

        let runtimeMs = 0;
        if (spawnData?.spawnedAt && event.endedAt) {
          runtimeMs = event.endedAt - spawnData.spawnedAt;
        } else if (spawnData?.spawnedAt) {
          runtimeMs = Date.now() - spawnData.spawnedAt;
        }
        const duration = formatDuration(runtimeMs);

        const closureId = `${agentId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        const timer = setTimeout(() => {
          handleClosureTimeout(closureId, { agentId, label, duration, icon });
        }, closureTimeoutMs);
        if (timer.unref) timer.unref();

        pendingClosures.set(closureId, {
          agentId, label, duration, icon, timer,
          completedAt: Date.now(),
          sessionKey,
          larkSent: false,
        });

        appendAuditLog({
          event: 'completion_registered', closureId, agentId, label, duration, outcome,
          timeoutMs: closureTimeoutMs,
        });
      } catch (e) {
        api.logger?.warn?.(`[aco-notify] subagent_ended error: ${e.message}`);
      }
    });

    // --- Event: before_prompt_build ---
    // Dual role: cleanup confirmed closures + inject reminders (L6 fallback)
    api.on(
      'before_prompt_build',
      (event, context) => {
        try {
          const ctx = context || event?.context || {};
          const sessionKey = String(ctx.sessionKey || event?.sessionKey || '');
          if (!sessionKey.includes('feishu')) return null;

          const agentId = String(ctx.agentId || '').trim();
          const effectiveAgentId = (!agentId || agentId === 'main') ? 'main' : agentId;
          if (effectiveAgentId !== 'main') return null;

          // Cleanup confirmed closures
          for (const [closureId, data] of pendingClosures) {
            if (data.larkSent) {
              clearTimeout(data.timer);
              appendAuditLog({
                event: 'closure_detected', closureId, agentId: data.agentId,
                label: data.label, duration: data.duration,
                method: 'before_prompt_cleanup', latencyMs: Date.now() - data.completedAt,
              });
              pendingClosures.delete(closureId);
            }
          }

          // Check for unsent pending closures
          const unsent = [...pendingClosures.values()].filter(d => !d.larkSent);

          if (unsent.length > 0) {
            // Strong reminder: pending closure awaiting delivery
            const labels = unsent.map(d => d.label || d.agentId).join(', ');
            return {
              inject: `\n[aco-notify] ⚠️ 子会话已完成（${labels}），请立即将进展总结精简扼要发到飞书给用户看。使用 lark-cli 发送。\n`,
            };
          }

          // Persistent reminder: no pending closure, but always remind
          return {
            inject: `\n[aco-notify] 子会话任务完成时，必须将进展总结精简扼要发到飞书给用户看。\n`,
          };
        } catch (e) {
          api.logger?.warn?.(`[aco-notify] before_prompt_build error: ${e.message}`);
          return null;
        }
      },
      { priority: 980 },
    );

    // --- Event: message_sending ---
    // L2: auto-forward main agent reply to feishu when pending closures exist
    api.on(
      'message_sending',
      (event, ctx) => {
        try {
          const resolved = resolveOutboundContext(event, ctx);
          appendMessageSendingDebug(resolved);

          if (!resolved.shouldForward) return null;

          const unsentClosures = [...pendingClosures.entries()].filter(([, data]) => !data.larkSent);
          if (unsentClosures.length === 0) return null;

          const result = sendToFeishu(resolved.content);

          for (const [closureId, data] of unsentClosures) {
            data.larkSent = true;
            clearTimeout(data.timer);

            appendAuditLog({
              event: 'l2_auto_forward', closureId, agentId: data.agentId,
              label: data.label, duration: data.duration,
              contentLength: resolved.content.length,
              sendResult: result.success ? 'ok' : result.error,
              latencyMs: Date.now() - data.completedAt,
              channel: resolved.channel || null,
              to: resolved.to || null,
            });
          }
        } catch (e) {
          api.logger?.warn?.(`[aco-notify] message_sending error: ${e.message}`);
        }
        return null;
      },
      { priority: 900 },
    );

    // --- Event: after_tool_call ---
    // Redundant detection: mark larkSent if main session manually calls lark-cli
    api.on(
      'after_tool_call',
      (evt, ctx) => {
        try {
          if (pendingClosures.size === 0) return;

          const toolName = evt?.toolName || evt?.tool || '';
          if (!isExecTool(toolName)) return;

          const params = evt?.params || evt?.arguments || evt?.input || {};
          const command = String(params.command || '');
          if (!command.includes('lark-cli') || !command.includes('im')) return;

          const sessionKey = String(ctx?.sessionKey || evt?.sessionKey || '');
          if (!sessionKey.includes('feishu')) return;

          for (const [closureId, data] of pendingClosures) {
            if (!data.larkSent) {
              data.larkSent = true;
              appendAuditLog({
                event: 'lark_send_detected', closureId,
                agentId: data.agentId, label: data.label,
                command: command.slice(0, 200),
              });
            }
          }
        } catch (e) {
          api.logger?.warn?.(`[aco-notify] after_tool_call error: ${e.message}`);
        }
      },
      { priority: 100 },
    );

    api.logger?.info?.('[aco-notify] plugin registered (v1.6.1 — dual: L2 auto-forward + L6 reminder)');
  }
};
