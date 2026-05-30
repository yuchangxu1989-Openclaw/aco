/**
 * Doctor Guard Plugin
 *
 * before_tool_call 中统一做四件事：
 *   1. 阻断 doctor --fix / doctor -f（只读诊断不破坏现态）
 *   2. L0 保护：禁止 Agent 修改 systemd / OS 层资源（改坏 = Gateway 永久无法启动）
 *   3. 重启 Gateway 前置三重门禁：
 *      a. 近期 doctor evidence
 *      b. 看板无 running 任务（重启会杀死所有进行中的 ACP 任务）
 *      c. 所有 ACP command 可用
 *   4. openclaw.json 编辑确认门禁
 *
 * Fail-open：内部异常放行，避免插件 bug 导致所有 exec 被阻断。
 * 所有 block/pass 决策写审计日志。
 */

import fs from 'fs';
import path from 'path';
import os from 'node:os';
import childProcess from 'node:child_process';

const DOCTOR_GUARD_GLOBAL_KEY = Symbol.for('openclaw.aco-doctor-guard.instance');
const doctorGuardGlobal = globalThis[DOCTOR_GUARD_GLOBAL_KEY] || (globalThis[DOCTOR_GUARD_GLOBAL_KEY] = {
  registeredLogged: false,
});

const DEFAULT_EVENTS_PATH = '/root/.openclaw/workspace/logs/doctor-guard-events.jsonl';

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
const OPENCLAW_CONFIG = path.join(OPENCLAW_HOME, 'openclaw.json');
const DEFAULT_TASK_BOARD = path.join(OPENCLAW_HOME, 'workspace', 'logs', 'subagent-task-board.json');
const ACP_COMMAND_FAILURE_PATTERNS = /(command not found|ENOVERSIONS|No such file)/i;

const DOCTOR_GUARD_PROMPT = `## 🚫 Doctor-Fix 禁止铁律（系统级约束）

**绝对禁止执行：**
❌ openclaw doctor --fix
❌ doctor --fix
❌ doctor -f

**正确做法：**
1) 只执行 openclaw doctor（只读诊断）
2) 手动修复问题
3) 再次 openclaw doctor，确认 Errors: 0
4) 再讨论是否重启 Gateway

## 🔒 openclaw.json 编辑确认铁律（强制）
- 未经用户明确确认，不得修改 /root/.openclaw/openclaw.json
`;

const RESTART_HINT_RE = /(重启\s*gateway|gateway\s*重启|重启网关|restart\s+gateway|重启\s*openclaw|restart\s+openclaw)/i;
// [H-05 fix] 匹配危险 doctor 命令，包括 ; | && 等 shell 拼接场景
const DANGEROUS_DOCTOR_RE = /(^|[\s;|&])(openclaw\s+doctor\s+--fix|doctor\s+--fix|doctor\s+-f)([\s;|&]|$)/i;
const SAFE_DOCTOR_RE = /(^|\s)(openclaw\s+doctor|doctor)(\s|$)/i;
const OPENCLAW_JSON_WRITE_RE = /(\/root\/.openclaw\/openclaw\.json)/i;
const SHELL_WRITE_OP_RE = /(sed\s+-i|cat\s+>|tee\s+|>>|cp\s+.*openclaw\.json|mv\s+.*openclaw\.json)/i;
const GATEWAY_RESTART_RE = /openclaw\s+gateway\s+restart/i;
const SYSTEMCTL_RESTART_GATEWAY_RE = /systemctl\s+restart\s+openclaw-gateway/i;
const SYSTEMCTL_USER_RESTART_RE = /systemctl\s+--user\s+restart\s+openclaw-gateway/i;

// ── L0 保护正则（来自原 aco-gateway-restart-guard）──────────────────────
const RE_SYSTEMCTL_EDIT_GATEWAY = /\bsystemctl\b[^\n;|&]*\bedit\b[^\n;|&]*\bopenclaw[-_]gateway\b/i;
const RE_GATEWAY_SERVICE_FILE_WRITE = /(?:>|>>|tee\b|cp\b|mv\b|sed\s+-i\b|cat\s+>|cat\s*<<[^]*?>)[^\n;|&]*systemd[^\n;|&]*openclaw[-_]gateway\.service/i;
const RE_ETC_SYSTEMD_WRITE = /(?:>|>>|tee\b|cp\b|mv\b|sed\s+-i\b|cat\s+>|cat\s*<<[^]*?>|install\b|chmod\b|chown\b)[^\n;|&]*\/etc\/systemd\//i;
const RE_EXEC_START_PRE = /\bExecStartPre\s*=/;
const RE_SYSTEMCTL_RELOAD_STOP_GATEWAY = /\bsystemctl\b[^\n;|&]*\b(reload|stop)\b[^\n;|&]*\bopenclaw[-_]gateway\b/i;
const RE_OPENCLAW_GATEWAY_RELOAD_STOP = /\bopenclaw\b\s+gateway\s+(reload|stop)\b/i;
const PATH_SYSTEMD_FILE = /(?:^|\/)(?:\.config\/)?systemd\/(?:user|system)\/[^/]*openclaw[-_]gateway[^/]*\.service$/i;
const PATH_ETC_SYSTEMD = /^\/etc\/systemd\//;

const L0_BLOCK_MESSAGE = '[L2 Guard] 禁止修改 L0/L1 层（systemd/OS/OpenClaw 核心代码）。L0/L1 改错会导致 Gateway 永久无法启动。如需修改，请用户手动操作。注意：L6（AGENTS.md/MEMORY.md 等文档约束）只是备忘，拦不住任何操作；只有本 L2 插件层才能确定性阻断危险行为。';

const DOCTOR_EVIDENCE_TTL_MS = 10 * 60 * 1000;
const doctorEvidenceBySession = new Map();

function buildRestartBoardBlockMessage(running) {
  return `[L2 Guard] Gateway 重启被阻断：看板有 ${running} 个 running 任务。重启会杀死所有进行中的 ACP 任务。请等任务完成后再重启。`;
}

function buildAcpCommandBlockMessage(failures) {
  const details = failures.map((f) => `${f.agentId}: ${f.command}`).join('；');
  return `[L2 Guard] Gateway 重启被阻断：ACP command 不可用：${details}。请先修复 openclaw.json 中对应 agent 的 command，再重启 Gateway。`;
}

function countRunningTasks(boardPath) {
  const raw = fs.readFileSync(boardPath, 'utf8');
  if (!raw || !raw.trim()) return 0;
  const board = JSON.parse(raw);
  const tasks = Array.isArray(board?.tasks) ? board.tasks : Array.isArray(board) ? board : [];
  let n = 0;
  for (const t of tasks) {
    if (t && t.status === 'running') n += 1;
  }
  return n;
}

function getCommandExecutable(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed) return '';
  if (trimmed[0] === '"' || trimmed[0] === "'") {
    const quote = trimmed[0];
    const end = trimmed.indexOf(quote, 1);
    return end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  return trimmed.split(/\s+/)[0];
}

function isScriptPathCommand(command) {
  const executable = getCommandExecutable(command);
  if (!executable || !executable.includes('/')) return false;
  if (!/\.(sh|bash|zsh|fish)$/i.test(executable) && !executable.includes('/scripts/')) return false;
  fs.accessSync(executable, fs.constants.F_OK | fs.constants.X_OK);
  return true;
}

function verifyAcpCommand(command) {
  try {
    if (isScriptPathCommand(command)) return { ok: true };
    const probe = `timeout 5 ${command} --help 2>&1 || timeout 5 ${command} 2>&1`;
    const output = childProcess.execSync(probe, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: '/bin/bash',
      timeout: 12000,
    });
    if (ACP_COMMAND_FAILURE_PATTERNS.test(output)) {
      return { ok: false, output };
    }
    return { ok: true };
  } catch (e) {
    const output = `${e?.stdout || ''}${e?.stderr || ''}${e?.message || e}`;
    return { ok: !ACP_COMMAND_FAILURE_PATTERNS.test(output), output };
  }
}

function verifyAcpCommands(configPath = OPENCLAW_CONFIG) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  const agents = config?.plugins?.entries?.acpx?.config?.agents || {};
  const failures = [];

  for (const [agentId, agent] of Object.entries(agents)) {
    const command = String(agent?.command || '').trim();
    if (!command) continue;
    const result = verifyAcpCommand(command);
    if (!result.ok) failures.push({ agentId, command, output: result.output });
  }

  return failures;
}

function nowMs() {
  return Date.now();
}

function sessionKeyOf(ctx = {}) {
  return String(ctx.sessionKey || ctx.sessionId || 'global');
}

function markDoctorEvidence(ctx) {
  doctorEvidenceBySession.set(sessionKeyOf(ctx), nowMs());
}

function hasRecentDoctorEvidence(ctx) {
  const t = doctorEvidenceBySession.get(sessionKeyOf(ctx));
  return typeof t === 'number' && (nowMs() - t) <= DOCTOR_EVIDENCE_TTL_MS;
}

function extractCommandLikeText(event = {}) {
  const a = event.arguments;
  if (!a) return '';
  if (typeof a === 'string') return a;
  if (typeof a === 'object') {
    const candidates = [a.command, a.cmd, a.script, a.shell, a.input, a.text].filter(Boolean);
    if (candidates.length > 0) return candidates.map(String).join(' ');
    try { return JSON.stringify(a); } catch { return ''; }
  }
  return String(a || '');
}

function isExecLikeTool(toolName = '') {
  const t = String(toolName || '').toLowerCase();
  return t.includes('exec') || t.includes('shell') || t.includes('terminal') || t === 'bash';
}

function isEditLikeTool(toolName = '') {
  const t = String(toolName || '').toLowerCase();
  return t === 'edit' || t === 'write' || t === 'multiedit' || t === 'write_file' || t === 'create_file';
}

function evaluateL0ExecCommand(cmd) {
  if (!cmd) return null;
  if (RE_SYSTEMCTL_EDIT_GATEWAY.test(cmd)) {
    return { ruleId: 'gateway.l0.systemctl_edit', match: 'systemctl edit openclaw-gateway' };
  }
  if (RE_GATEWAY_SERVICE_FILE_WRITE.test(cmd)) {
    return { ruleId: 'gateway.l0.gateway_service_write', match: 'write openclaw-gateway.service' };
  }
  if (RE_ETC_SYSTEMD_WRITE.test(cmd)) {
    return { ruleId: 'gateway.l0.etc_systemd_write', match: 'write /etc/systemd/' };
  }
  if (RE_EXEC_START_PRE.test(cmd)) {
    return { ruleId: 'gateway.l0.exec_start_pre', match: 'ExecStartPre' };
  }
  return null;
}

function evaluateL0FilePath(filePath) {
  if (!filePath) return null;
  if (PATH_SYSTEMD_FILE.test(filePath) || PATH_ETC_SYSTEMD.test(filePath)) {
    return { ruleId: 'gateway.l0.file_write_systemd', match: filePath };
  }
  return null;
}

const doctorGuardPlugin = {
  id: 'aco-doctor-guard',
  name: 'Doctor 命令守卫',
  description: '阻止 doctor --fix；L0 保护 systemd/OS；Gateway 重启前置 doctor+看板+ACP command 三重门禁；openclaw.json 写保护',
  version: '1.3.0',

  register(api) {
    const EVENTS_PATH = process.env.DOCTOR_GUARD_EVENTS_PATH || DEFAULT_EVENTS_PATH;
    const cfg = api?.pluginConfig?.['aco-doctor-guard'] || api?.pluginConfig?.['doctor-guard'] || {};
    const taskBoardPath = cfg.taskBoardPath || process.env.GATEWAY_GUARD_TASK_BOARD || DEFAULT_TASK_BOARD;

    const appendAuditEvent = (entry) => {
      try {
        fs.mkdirSync(path.dirname(EVENTS_PATH), { recursive: true });
        const rec = {
          timestamp: new Date().toISOString(),
          pluginId: 'aco-doctor-guard',
          ...entry,
        };
        fs.appendFileSync(EVENTS_PATH, `${JSON.stringify(rec)}\n`);
      } catch (e) {
        api.logger.warn(`[aco-doctor-guard] failed to write audit: ${e.message}`);
      }
    };

    // 1) 提示注入
    api.on('before_prompt_build', async (_event) => {
      return {
        prependContext: DOCTOR_GUARD_PROMPT,
      };
    }, { priority: 1000 });

    // 2) 功能型硬阻断：before_tool_call
    api.on('before_tool_call', async (event, ctx) => {
      try {
        const toolName = String(event.toolName || '');
        const cmdText = extractCommandLikeText(event);
        const normalized = cmdText.trim();

        if (!isExecLikeTool(toolName)) {
          // edit/write 工具：先检查 systemd 文件路径（L0 保护）
          if (isEditLikeTool(toolName)) {
            const filePath = String(event?.params?.path || event?.params?.file_path || event?.params?.target || '');
            const l0FileVerdict = evaluateL0FilePath(filePath);
            if (l0FileVerdict) {
              appendAuditEvent({ decision: 'block', ruleId: l0FileVerdict.ruleId, reason: `L0 protection: ${l0FileVerdict.match}`, toolName, path: filePath });
              return { block: true, blockReason: L0_BLOCK_MESSAGE };
            }
          }

          // L2: edit/write 工具对 openclaw.json 的写保护
          if (toolName === 'edit' || toolName === 'write') {
            const filePath = String(event?.params?.path || '');
            if (/openclaw\.json/i.test(filePath)) {
              const reason = '已阻断：edit/write 工具不得直接修改 openclaw.json。需用户明确确认后通过 shell 命令执行。';
              appendAuditEvent({ decision: 'block', ruleId: 'doctor.config.edit_write_blocked', reason, toolName, path: filePath });
              return { block: true, blockReason: reason };
            }
          }
          return null;
        }

        // A. doctor --fix 硬阻断
        if (DANGEROUS_DOCTOR_RE.test(normalized)) {
          const reason = '已阻断危险命令：doctor --fix / doctor -f。仅允许 openclaw doctor（只读诊断）。';
          appendAuditEvent({ decision: 'block', ruleId: 'doctor.fix.forbidden', reason, toolName });
          return { block: true, blockReason: reason };
        }

        // L0 保护：systemd / OS 层修改
        const l0ExecVerdict = evaluateL0ExecCommand(normalized);
        if (l0ExecVerdict) {
          appendAuditEvent({ decision: 'block', ruleId: l0ExecVerdict.ruleId, reason: `L0 protection: ${l0ExecVerdict.match}`, toolName, probe: normalized.slice(0, 240) });
          return { block: true, blockReason: L0_BLOCK_MESSAGE };
        }

        // B. systemctl --user restart openclaw-gateway 硬阻断（会杀掉自身进程树）
        if (SYSTEMCTL_USER_RESTART_RE.test(normalized)) {
          const reason = '已阻断：systemctl --user restart openclaw-gateway 会杀掉自身进程树。必须使用 openclaw gateway restart。';
          appendAuditEvent({ decision: 'block', ruleId: 'doctor.restart.systemctl_user_forbidden', reason, toolName });
          return { block: true, blockReason: reason };
        }

        // systemctl reload/stop openclaw-gateway / openclaw gateway reload|stop —— 与 restart 同源治理
        const isReloadStop = RE_SYSTEMCTL_RELOAD_STOP_GATEWAY.test(normalized) || RE_OPENCLAW_GATEWAY_RELOAD_STOP.test(normalized);
        const isRestart = GATEWAY_RESTART_RE.test(normalized) || SYSTEMCTL_RESTART_GATEWAY_RE.test(normalized);

        // C. Gateway 重启/reload/stop 三重门禁：doctor evidence + 看板 idle + ACP command 可用
        if (isRestart || isReloadStop) {
          // C-1. 近期 doctor evidence
          if (!hasRecentDoctorEvidence(ctx)) {
            const reason = '已阻断：重启/reload/stop Gateway 前需要近期 doctor 验证证据。请先执行 openclaw doctor --non-interactive --no-workspace-suggestions 并确认 Errors: 0。';
            appendAuditEvent({ decision: 'block', ruleId: 'doctor.restart.no_evidence', reason, toolName });
            return { block: true, blockReason: reason };
          }

          // C-2. 看板 running 任务检查（fail-open：看板不可读放行）
          let running = 0;
          try {
            running = countRunningTasks(taskBoardPath);
          } catch (e) {
            appendAuditEvent({
              decision: 'observe',
              ruleId: 'gateway.restart.board_unreadable',
              reason: `task board unreadable, fail-open: ${e.message}`,
              toolName,
            });
          }
          if (running > 0) {
            appendAuditEvent({
              decision: 'block',
              ruleId: 'gateway.restart.running_tasks_present',
              reason: `${running} running tasks on board`,
              toolName,
              running,
            });
            return { block: true, blockReason: buildRestartBoardBlockMessage(running) };
          }

          // C-3. ACP command 可用性验证
          let acpFailures = [];
          try {
            acpFailures = verifyAcpCommands();
          } catch (e) {
            appendAuditEvent({
              decision: 'observe',
              ruleId: 'gateway.restart.config_unreadable',
              reason: `openclaw.json unreadable, fail-open: ${e.message}`,
              toolName,
            });
          }
          if (acpFailures.length > 0) {
            appendAuditEvent({
              decision: 'block',
              ruleId: 'gateway.restart.acp_command_unavailable',
              reason: `${acpFailures.length} ACP commands unavailable`,
              toolName,
              failures: acpFailures,
            });
            return { block: true, blockReason: buildAcpCommandBlockMessage(acpFailures) };
          }

          appendAuditEvent({
            decision: 'allow',
            ruleId: 'gateway.restart.all_gates_passed',
            reason: 'doctor evidence + board idle + ACP commands available, restart allowed',
            toolName,
          });
        }

        // D. openclaw.json 明显写操作门禁
        if (OPENCLAW_JSON_WRITE_RE.test(normalized) && SHELL_WRITE_OP_RE.test(normalized)) {
          const reason = '已阻断：检测到对 /root/.openclaw/openclaw.json 的写操作。需先获得用户明确确认后再执行。';
          appendAuditEvent({ decision: 'block', ruleId: 'doctor.config.shell_write_blocked', reason, toolName });
          return { block: true, blockReason: reason };
        }

        // E. 记录 doctor 证据（检测到安全 doctor 命令）
        if (SAFE_DOCTOR_RE.test(normalized) && !DANGEROUS_DOCTOR_RE.test(normalized)) {
          markDoctorEvidence(ctx);
          appendAuditEvent({ decision: 'pass', ruleId: 'doctor.safe.evidence_recorded', reason: 'safe doctor command detected, evidence recorded', toolName });
        }

        return null;
      } catch (e) {
        // fail-open：插件出错时放行，避免阻断所有 exec
        try {
          api?.logger?.warn?.(`[aco-doctor-guard] internal error, fail-open: ${e?.message || e}`);
        } catch { /* swallow */ }
        return null;
      }
    }, { priority: 1100 });

    // 3) 重启前置门禁（轻量）：message_sending
    api.on('message_sending', async (event, ctx) => {
      const content = String(event.content || '');
      if (!RESTART_HINT_RE.test(content)) return null;

      if (!hasRecentDoctorEvidence(ctx)) {
        const reason = '消息包含"建议重启 Gateway/OpenClaw"，但缺少近期 doctor 验证证据。';
        appendAuditEvent({ decision: 'block', ruleId: 'doctor.message.restart_no_evidence', reason, toolName: 'message_sending' });
        return {
          cancel: true,
          content: '已阻断该发送：当前消息包含"建议重启 Gateway/OpenClaw"，但缺少近期 doctor 验证证据。请先执行 openclaw doctor（不带 --fix）并确认 Errors: 0。',
        };
      }
      appendAuditEvent({ decision: 'allow', ruleId: 'doctor.message.restart_with_evidence', reason: 'restart mention with recent doctor evidence', toolName: 'message_sending' });
      return null;
    }, { priority: 1050 });

    if (!doctorGuardGlobal.registeredLogged) {
      api.logger.info('aco-doctor-guard: plugin registered (v1.3.0, merged gateway-restart-guard)');
      doctorGuardGlobal.registeredLogged = true;
    }
  },
};

export default doctorGuardPlugin;

// 测试钩子：仅供单测使用，不影响插件运行时
export const __test__ = {
  evaluateL0ExecCommand,
  evaluateL0FilePath,
  countRunningTasks,
  verifyAcpCommands,
  verifyAcpCommand,
  L0_BLOCK_MESSAGE,
  buildRestartBoardBlockMessage,
  buildAcpCommandBlockMessage,
};
