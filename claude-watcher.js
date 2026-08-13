// ============================================================
// claude-watcher.js — Claude Code 会话日志监听 + 状态机（纯 Node，无 Electron 依赖）
// 数据源：~/.claude/projects/<项目slug>/<sessionId>.jsonl（每行一个 JSON）
//   - 只跟踪主会话文件（UUID 命名）；subagents/ 与 tool-results/ 子目录被排除
//   - 审批无日志信号：tool_use 后 approvalAfterMs 内无 tool_result → 等待审批（启发式，可关）
// 用法：
//   node claude-watcher.js --live              # 实时监听当前 Claude Code 会话
//   node claude-watcher.js --replay <jsonl文件> # 回放历史会话验证状态机
//   node claude-watcher.js --test              # 自测
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { STATE_META } = require('./state-watcher');

const DEFAULT_OPTS = {
  sessionsDir: path.join(os.homedir(), '.claude', 'projects'),
  pollMs: 800,
  idleAfterMs: 60 * 1000,          // 60s 无事件 → 空闲（工作状态不回落，防止长命令误判）
  sleepAfterMs: 15 * 60 * 1000,    // 15min 无事件 → 沉睡
  listeningHoldMs: 2500,           // “收到指令”停留时长
  doneHoldMs: 8000,                // “完成”停留时长
  backfillBytes: 200 * 1024,       // 启动时最多回看 200KB 日志
  timelineMax: 10,                 // 最近活动时间线最多保留条数
  approvalAfterMs: 20000           // tool_use 无结果的超时启发式 → 等待审批（0 = 关闭）
};

// 工作状态：这些状态不会被 60s 静默误判为空闲（长命令执行中日志不会增加）
const WORK_STATES = new Set(['listening', 'thinking', 'coding', 'running', 'searching', 'approval']);

// 会话文件名形如 <uuid>.jsonl；子智能体是 agent-<uuid>.jsonl，靠 UUID 正则一并排除
const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

// 只读/无需授权的工具：不武装审批计时（执行快、不会等待用户批准）
const READONLY_TOOLS = /^(read|grep|glob|websearch|webfetch|ls|agent|task|askuserquestion)$/i;

class ClaudeCodeWatcher extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = Object.assign({}, DEFAULT_OPTS, opts);
    this.state = 'idle';
    this.lastDetail = '';
    this.currentFile = null;
    this.offset = 0;
    this.lastEventTime = 0;
    this.timer = null;
    this.listeningTimer = null;
    this.doneTimer = null;
    this.approvalTimer = null;       // 等待批准启发式计时
    this.lastStopReason = null;      // 最近一条 assistant 行的 stop_reason（判断回合是否真正结束）
    this.backfilling = false;
    this.timeline = [];
  }

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.opts.pollMs);
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.listeningTimer) clearTimeout(this.listeningTimer);
    if (this.doneTimer) clearTimeout(this.doneTimer);
    this.clearApprovalTimer();
    this.timer = null;
  }

  // 配置热更新：动态调整审批启发式（不重建 watcher）
  update(opts = {}) {
    if (typeof opts.approvalAfterMs === 'number') this.opts.approvalAfterMs = opts.approvalAfterMs;
  }

  forceRefresh() {
    this.offset = 0;
    this.lastStopReason = null;
    this.clearApprovalTimer();
    this.poll();
  }

  // ---------- 最近活动时间线（与 Codex watcher 同格式） ----------
  pushTimeline(icon, text) {
    this.timeline.push({ ts: Date.now(), icon: icon || '•', text: text || '' });
    if (this.timeline.length > this.opts.timelineMax) this.timeline.shift();
  }

  getTimeline() {
    return this.timeline.slice();
  }

  // 找到最新修改的主会话文件。
  // 双层排除：目录段跳过 subagents/ 与 tool-results/（子智能体日志增长时父文件静默，
  // 会劫持“最新 mtime”选择）；文件名只认 UUID.jsonl（防 agent-*.jsonl、memory.jsonl 等侧车文件）。
  findLatest() {
    let best = null;
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          const seg = e.name.toLowerCase();
          if (seg === 'subagents' || seg === 'tool-results') continue;
          walk(p);
        } else if (SESSION_FILE_RE.test(e.name)) {
          let st;
          try { st = fs.statSync(p); } catch { continue; }
          if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs, size: st.size };
        }
      }
    };
    walk(this.opts.sessionsDir);
    return best;
  }

  poll() {
    const f = this.findLatest();
    if (!f) return;

    if (!this.currentFile || f.path !== this.currentFile.path) {
      // 首次启动或会话切换：回看文件尾部，建立当前状态（期间静默，避免状态闪烁）
      this.currentFile = f;
      this.offset = Math.max(0, f.size - this.opts.backfillBytes);
      this.backfilling = true;
      this.lastStopReason = null;     // 会话切换：清掉旧会话的 stop_reason
      this.clearApprovalTimer();      // 会话切换：清掉旧会话的待批准计时
    }

    let st;
    try { st = fs.statSync(f.path); } catch { return; }
    if (st.size < this.offset) this.offset = 0; // 文件被截断/轮转
    if (st.size === this.offset) { this.checkIdle(); return; }

    const buf = Buffer.alloc(st.size - this.offset);
    const fd = fs.openSync(f.path, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, this.offset); } finally { fs.closeSync(fd); }
    this.offset = st.size;

    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (const line of lines) this.processLine(line);
    this.checkIdle();

    if (this.backfilling) {
      this.backfilling = false;
      // 回放结束：输出一次当前真实状态
      const meta = STATE_META[this.state] || { label: this.state, bubble: '' };
      this.emit('state', {
        state: this.state,
        label: meta.label,
        bubble: meta.bubble,
        detail: this.lastDetail,
        since: Date.now(),
        timeline: this.timeline.slice()
      });
    }
  }

  // ---------- 行分发 ----------
  processLine(line) {
    if (line.charCodeAt(0) === 0xFEFF) line = line.slice(1); // BOM 防御
    let j;
    try { j = JSON.parse(line); } catch { return; }
    if (!j || typeof j !== 'object') return;
    if (j.isSidechain === true) return; // 防御：子会话行不处理（正常已被 findLatest 排除）

    // 部分行类型缺 timestamp：用当前时间兜底（行刚被写入，就是“现在”），防 stale lastEventTime 误判空闲
    let t = Date.now();
    if (j.timestamp) {
      const p = new Date(j.timestamp).getTime();
      if (Number.isFinite(p)) t = p;
    }
    this.lastEventTime = Math.max(this.lastEventTime, t);

    switch (j.type) {
      case 'user':            this.handleUser(j); break;
      case 'assistant':       this.handleAssistant(j); break;
      case 'system':          this.handleSystem(j); break;
      case 'permission-mode':
        if (j.permissionMode === 'plan') this.setState('thinking', { detail: '规划中…' });
        break;
      // mode / last-prompt / summary / result（老版本）/ 未知类型：静默忽略（不崩溃）
    }
  }

  // ---------- user 行：人类输入 / 工具结果 / 子智能体通知 ----------
  handleUser(j) {
    // 任何 user 行都证明“不再等待批准”（批准结果= tool_result；回复= 文本），先清审批计时
    this.clearApprovalTimer();

    const content = j.message && j.message.content;
    const origin = j.origin && j.origin.kind;

    if (typeof content === 'string') {
      // 子智能体结束通知
      if (origin === 'task-notification' && /<status>completed<\/status>/.test(content)) {
        this.pushTimeline('🤖', '子智能体完成');
        this.setState('thinking', { detail: '子智能体完成，整合结果中…' });
        return;
      }
      // 人类输入（老版本可能缺 origin，按人类输入处理）
      if (origin === 'human' || !origin) {
        const text = clip(content, 40);
        this.pushTimeline('👂', text ? '收到指令: ' + text : '收到新指令');
        this.setState('listening', { detail: text ? '收到: ' + text : '收到新的指令' });
        clearTimeout(this.listeningTimer);
        this.listeningTimer = setTimeout(() => {
          if (this.state === 'listening') this.setState('thinking', { detail: '开始分析问题' });
        }, this.opts.listeningHoldMs);
      }
      return;
    }

    if (!Array.isArray(content)) return;
    let sawToolResult = false;
    for (const b of content) {
      if (!b || b.type !== 'tool_result') continue; // 附件等其他块：忽略
      sawToolResult = true;
      if (b.is_error === true) {
        this.pushTimeline('🔧', '工具执行出错');
        this.setState('thinking', { detail: '工具结果异常，排查中…' });
      } else {
        this.pushTimeline('🔧', '工具结果返回');
        if (this.state !== 'done') this.setState('thinking', { detail: '处理工具结果…' });
      }
    }
  }

  // ---------- assistant 行：thinking / text / tool_use 内容块 ----------
  handleAssistant(j) {
    const msg = j.message || {};
    if (msg.stop_reason) this.lastStopReason = msg.stop_reason;

    const content = msg.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'thinking') {
        this.setState('thinking', { detail: '深度思考中…' });
      } else if (b.type === 'text') {
        if (this.state !== 'approval' && this.state !== 'done') {
          this.setState('thinking', { detail: '正在组织回复…' });
        }
      } else if (b.type === 'tool_use') {
        this.handleToolUse(b);
      }
    }
  }

  // ---------- 工具调用 → 状态（按工具名分发） ----------
  handleToolUse(b) {
    const name = b.name || '';
    const input = (b.input && typeof b.input === 'object') ? b.input : {};

    if (/^(bash|powershell)$/i.test(name)) {
      const cmd = clip(input.command || '', 60);
      this.pushTimeline('⏳', cmd || 'shell 命令');
      this.setState('running', { detail: cmd ? '正在跑: ' + cmd : '执行命令中…' });
    } else if (/^(edit|write|multiedit|notebookedit)$/i.test(name)) {
      const file = clip(input.file_path || '', 48);
      this.pushTimeline('📝', file || name);
      this.setState('coding', { detail: file ? '修改: ' + file : '正在写代码…' });
    } else if (/^(read|grep|glob|websearch|webfetch|ls)$/i.test(name)) {
      const queries = Array.isArray(input.queries) ? input.queries.slice(0, 2).join('、') : '';
      const q = clip(input.file_path || input.query || input.pattern || input.url || queries || '', 48);
      this.pushTimeline('🔎', q || name);
      this.setState('searching', { detail: q ? '搜索: ' + q : '搜索资料中…' });
    } else if (/^(agent|task)$/i.test(name)) {
      const d = clip(input.description || '', 30);
      this.pushTimeline('🤖', '协调子智能体' + (d ? ': ' + d : ''));
      this.setState('thinking', { detail: '协调子智能体…' });
    } else if (/^todowrite$/i.test(name)) {
      this.setState('thinking', { detail: '更新任务计划…' });
    } else if (/^(enterplanmode|exitplanmode)$/i.test(name)) {
      this.setState('thinking', { detail: '规划中…' });
    } else if (/^askuserquestion$/i.test(name)) {
      // 提问工具：真正等待用户回答，直接进审批态（不等超时）
      this.pushTimeline('❓', '向你提问');
      this.setState('approval', { detail: '需要你回答…' });
    } else {
      // 未知/新工具：默认按写代码处理（同 Codex 通道惯例）
      this.pushTimeline('🛠', name || '工具调用');
      this.setState('coding', { detail: name || '工具调用中…' });
    }
    this.armApprovalTimer(name);
  }

  // ---------- 审批启发式 ----------
  // Claude 日志没有审批信号（等待批准时日志停更，与长命令无法区分）：
  // 可能需授权的工具调用后 approvalAfterMs 内无结果 → 判定“等待你的批准”。
  // 注意：每条 assistant 行后紧跟 turn_duration/last-prompt 行，只有 user 类行清除计时，
  // 否则启发式永远不会触发。误报（已批准长命令）在 tool_result 到达后自动恢复。
  armApprovalTimer(name) {
    this.clearApprovalTimer();
    if (!this.opts.approvalAfterMs || this.backfilling) return;
    if (READONLY_TOOLS.test(name)) return;
    this.approvalTimer = setTimeout(() => this.onApprovalTimeout(), this.opts.approvalAfterMs);
  }

  clearApprovalTimer() {
    if (this.approvalTimer) { clearTimeout(this.approvalTimer); this.approvalTimer = null; }
  }

  onApprovalTimeout() {
    this.approvalTimer = null;
    if (WORK_STATES.has(this.state) && this.state !== 'approval') {
      this.pushTimeline('⚠️', '等待你的批准…');
      this.setState('approval', { detail: '等待你的批准…' });
    }
  }

  // ---------- system 行：回合结束判定 ----------
  handleSystem(j) {
    if (j.subtype !== 'turn_duration') return;
    // 有子智能体在跑：本轮没真正结束
    if (j.pendingBackgroundAgentCount > 0) {
      this.pushTimeline('🤖', '协调子智能体');
      this.setState('thinking', { detail: '协调子智能体…' });
      return;
    }
    // 只有最后一个 assistant 行以 end_turn 收尾才算真正完成；
    // stop_reason=tool_use 是工具循环中的回合，等 tool_result 驱动状态（防误判完成）
    if (this.lastStopReason === 'end_turn') {
      this.clearApprovalTimer();
      this.pushTimeline('✅', '任务完成');
      this.setState('done', { detail: '任务完成' });
      clearTimeout(this.doneTimer);
      this.doneTimer = setTimeout(() => {
        if (this.state === 'done') this.setState('idle', { detail: '回到空闲' });
      }, this.opts.doneHoldMs);
    }
  }

  // ---------- 空闲 / 沉睡推断（与 Codex watcher 同逻辑） ----------
  checkIdle() {
    const now = Date.now();
    if (!this.lastEventTime) return;
    const dt = now - this.lastEventTime;

    if (dt > this.opts.sleepAfterMs) {
      if (this.state !== 'sleep') this.setState('sleep', { detail: '太久没动静，睡会儿…' });
      return;
    }
    // 工作状态不被 60s 静默误判（长命令执行中日志不增加）
    if (WORK_STATES.has(this.state)) return;
    if (dt > this.opts.idleAfterMs && this.state !== 'idle') {
      this.setState('idle', { detail: '空闲中' });
    }
  }

  setState(s, info) {
    const detail = (info && info.detail) || '';
    // 状态未变且详情未变才跳过（同状态的新 detail 也要推送，否则“正在跑: xxx”不会更新）
    if (this.state === s && detail === this.lastDetail) return;
    const stateChanged = this.state !== s;
    this.state = s;
    this.lastDetail = detail;
    if (this.backfilling) return; // 回放静默
    const meta = STATE_META[s] || { label: s, bubble: '' };
    this.emit('state', {
      state: s,
      label: meta.label,
      bubble: meta.bubble,
      detail: detail,
      since: Date.now(),
      timeline: this.timeline.slice(),
      stateChanged: stateChanged
    });
  }
}

// 工具：压缩空白 + 截断（中文按字符截）
function clip(s, n) {
  if (typeof s !== 'string') return '';
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ---------- 自测（无外部依赖：直接喂合成日志行，验证状态机推导） ----------
function runSelfTest() {
  let fail = 0;
  function assert(cond, name) {
    console.log((cond ? '  PASS ' : '  FAIL ') + name);
    if (!cond) fail++;
  }
  const NOW = new Date().toISOString();
  function jline(obj) {
    return JSON.stringify(Object.assign({ timestamp: NOW, isSidechain: false }, obj));
  }
  function userStr(text, origin) {
    return jline({ type: 'user', origin: { kind: origin || 'human' }, message: { role: 'user', content: text } });
  }
  function assistantBlock(block, stop) {
    return jline({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [block], stop_reason: stop || 'tool_use' } });
  }
  function toolUse(name, input, stop) {
    return assistantBlock({ type: 'tool_use', id: 'call_1', name: name, input: input || {} }, stop);
  }
  function toolResult(isError) {
    return jline({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'x', is_error: !!isError }] } });
  }
  function sysTurn(extra) {
    return jline(Object.assign({ type: 'system', subtype: 'turn_duration', durationMs: 100 }, extra || {}));
  }
  function make(extra) { return new ClaudeCodeWatcher(Object.assign({ listeningHoldMs: 0, doneHoldMs: 0 }, extra || {})); }

  console.log('== ClaudeCodeWatcher 状态机自测 ==');

  // 1. 用户输入 → listening（detail 含文本 + 时间线）
  {
    const w = make();
    w.processLine(userStr('帮我修一下 bug'));
    assert(w.state === 'listening', 'user 文本输入 → listening');
    assert(w.lastDetail.includes('帮我修一下 bug'), 'listening detail 含输入');
    assert(w.timeline.length === 1 && w.timeline[0].icon === '👂', '时间线记录 👂');
  }
  // 2. thinking 块 → thinking
  {
    const w = make();
    w.processLine(assistantBlock({ type: 'thinking', thinking: '…' }, 'tool_use'));
    assert(w.state === 'thinking' && w.lastDetail === '深度思考中…', 'thinking 块 → thinking');
  }
  // 3. text 块 → thinking（done 时不覆盖）
  {
    const w = make();
    w.processLine(assistantBlock({ type: 'text', text: '好的' }, 'end_turn'));
    assert(w.state === 'thinking' && w.lastDetail === '正在组织回复…', 'text 块 → thinking');
    w.setState('done', { detail: '任务完成' });
    w.processLine(assistantBlock({ type: 'text', text: '补充' }, 'end_turn'));
    assert(w.state === 'done', 'done 状态不被 text 块覆盖');
  }
  // 4. PowerShell → running（含命令详情）
  {
    const w = make();
    w.processLine(toolUse('PowerShell', { command: 'npm test' }));
    assert(w.state === 'running', 'PowerShell tool_use → running');
    assert(w.lastDetail.includes('npm test'), 'running detail 含命令');
  }
  // 5. Read → searching
  {
    const w = make();
    w.processLine(toolUse('Read', { file_path: 'D:\\proj\\a.js' }));
    assert(w.state === 'searching', 'Read tool_use → searching');
    assert(w.lastDetail.includes('a.js'), 'searching detail 含文件');
  }
  // 6. Write → coding
  {
    const w = make();
    w.processLine(toolUse('Write', { file_path: 'src/x.js' }));
    assert(w.state === 'coding', 'Write tool_use → coding');
    assert(w.lastDetail.includes('src/x.js'), 'coding detail 含文件');
  }
  // 7. Agent → thinking（协调子智能体）
  {
    const w = make();
    w.processLine(toolUse('Agent', { description: '探索代码' }));
    assert(w.state === 'thinking', 'Agent tool_use → thinking');
    assert(w.lastDetail.includes('协调子智能体'), 'thinking detail 含子智能体');
  }
  // 8. AskUserQuestion → approval（直接，不等超时）
  {
    const w = make();
    w.processLine(toolUse('AskUserQuestion', {}));
    assert(w.state === 'approval' && w.lastDetail.includes('需要你回答'), 'AskUserQuestion → approval');
  }
  // 9. tool_result 正常返回 → thinking（恢复）
  {
    const w = make();
    w.processLine(toolUse('PowerShell', { command: 'x' }));
    w.processLine(toolResult(false));
    assert(w.state === 'thinking' && w.lastDetail === '处理工具结果…', 'tool_result → thinking');
  }
  // 10. tool_result 出错 → thinking（异常详情）
  {
    const w = make();
    w.processLine(toolUse('PowerShell', { command: 'x' }));
    w.processLine(toolResult(true));
    assert(w.state === 'thinking' && w.lastDetail.includes('异常'), 'tool_result is_error → thinking 异常');
  }
  // 11. 完整工具循环：tool_use(tool_use) → turn_duration 不判 done → tool_result → end_turn → done
  {
    const w = make();
    w.processLine(toolUse('PowerShell', { command: 'npm run build' }, 'tool_use'));
    w.processLine(sysTurn({}));
    assert(w.state === 'running', '工具循环中 turn_duration 不判 done');
    w.processLine(toolResult(false));
    w.processLine(assistantBlock({ type: 'text', text: '构建完成' }, 'end_turn'));
    w.processLine(sysTurn({}));
    assert(w.state === 'done', 'end_turn + turn_duration → done');
  }
  // 12. turn_duration 带 pendingBackgroundAgentCount → thinking 而非 done
  {
    const w = make();
    w.processLine(assistantBlock({ type: 'text', text: '等子任务' }, 'end_turn'));
    w.processLine(sysTurn({ pendingBackgroundAgentCount: 1 }));
    assert(w.state === 'thinking' && w.lastDetail.includes('协调子智能体'), '子智能体未结束 → thinking');
  }
  // 13. task-notification → thinking（子智能体完成）
  {
    const w = make();
    w.processLine(userStr('<task-notification><status>completed</status></task-notification>', 'task-notification'));
    assert(w.state === 'thinking' && w.lastDetail.includes('子智能体完成'), 'task-notification → thinking');
    assert(w.timeline.some(t => t.icon === '🤖'), '时间线记录 🤖');
  }
  // 14. permission-mode plan → thinking；default → 忽略
  {
    const w = make();
    w.processLine(jline({ type: 'permission-mode', permissionMode: 'plan' }));
    assert(w.state === 'thinking' && w.lastDetail === '规划中…', 'plan mode → thinking 规划中');
    const d = w.lastDetail;
    w.processLine(jline({ type: 'permission-mode', permissionMode: 'default' }));
    assert(w.state === 'thinking' && w.lastDetail === d, 'permission-mode default 被忽略');
  }
  // 15. 审批超时启发式：running → approval → tool_result 恢复
  {
    const w = make({ approvalAfterMs: 1000 });
    w.processLine(toolUse('PowerShell', { command: 'npm install' }));
    assert(w.state === 'running' && w.approvalTimer !== null, 'tool_use 武装审批计时');
    w.onApprovalTimeout();
    assert(w.state === 'approval' && w.lastDetail.includes('等待你的批准'), '超时 → approval');
    w.processLine(toolResult(false));
    assert(w.state === 'thinking', 'tool_result 到达 → 恢复 thinking');
  }
  // 16. 审批计时清除规则：turn_duration 不清除，user 行清除；只读工具不武装
  {
    const w = make({ approvalAfterMs: 1000 });
    w.processLine(toolUse('PowerShell', { command: 'x' }));
    w.processLine(sysTurn({}));
    assert(w.approvalTimer !== null, 'turn_duration 不清除审批计时（关键回归）');
    w.processLine(toolResult(false));
    assert(w.approvalTimer === null, 'tool_result（user 行）清除审批计时');
    w.processLine(toolUse('Read', { file_path: 'a.js' }));
    assert(w.approvalTimer === null, '只读工具不武装审批计时');
    w.processLine(toolUse('PowerShell', { command: 'y' }));
    assert(w.approvalTimer !== null, '需授权工具重新武装');
    w.processLine(userStr('别跑这个'));
    assert(w.approvalTimer === null, '用户输入行清除审批计时');
  }
  // 17. isSidechain 行被忽略
  {
    const w = make();
    w.processLine(jline({ type: 'user', isSidechain: true, message: { role: 'user', content: '旁路' } }));
    assert(w.state === 'idle', 'isSidechain 行被忽略');
  }
  // 18. 坏行与未知类型不崩溃、不改状态
  {
    const w = make();
    w.processLine('this is not json');
    w.processLine(jline({ type: 'result' }));
    w.processLine(jline({ type: 'last-prompt', lastPrompt: 'x' }));
    w.processLine(jline({ type: 'mode', mode: 'normal' }));
    w.processLine(jline({ type: 'summary' }));
    assert(w.state === 'idle', '坏行 / 未知类型被静默忽略');
  }
  // 19. user content 为无 tool_result 的数组（附件）→ 不改状态
  {
    const w = make();
    w.processLine(jline({ type: 'user', message: { role: 'user', content: [{ type: 'image', source: {} }] } }));
    assert(w.state === 'idle', '附件块被忽略');
  }
  // 20. 多块 assistant 行全部处理
  {
    const w = make();
    const line = jline({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [
      { type: 'thinking', thinking: '…' },
      { type: 'tool_use', id: 'call_2', name: 'Bash', input: { command: 'ls' } }
    ], stop_reason: 'tool_use' } });
    w.processLine(line);
    assert(w.state === 'running', '多块行 [thinking, tool_use] 全部处理');
  }
  // 21. 命令详情截断到 60 字
  {
    const w = make();
    w.processLine(toolUse('Bash', { command: 'x'.repeat(200) }));
    const cmd = w.lastDetail.replace('正在跑: ', '');
    assert(cmd.length === 60 && cmd.endsWith('…'), '超长命令被截断到 60 字');
  }
  // 22. 工作状态免疫 / 非工作状态回 idle / 超长无事件 → 沉睡
  {
    const w = make();
    w.processLine(toolUse('PowerShell', { command: 'x' }));
    w.lastEventTime = Date.now() - 120000;
    w.checkIdle();
    assert(w.state === 'running', '工作状态(running)不被 60s 静默误判');
    w.setState('done', { detail: 'x' });
    w.lastEventTime = Date.now() - 120000;
    w.checkIdle();
    assert(w.state === 'idle', '非工作状态超时回 idle');
  }
  {
    const w = new ClaudeCodeWatcher({ idleAfterMs: 0, sleepAfterMs: 60000, listeningHoldMs: 0, doneHoldMs: 0 });
    w.processLine(toolUse('PowerShell', { command: 'x' }));
    w.lastEventTime = Date.now() - 120000;
    w.checkIdle();
    assert(w.state === 'sleep', '超长无事件 → 沉睡');
  }
  // 23. findLatest 排除 subagents/tool-results/非 UUID 文件（真实临时目录）
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-watcher-test-'));
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const proj = path.join(tmp, 'proj1');
    fs.mkdirSync(proj);
    const a = path.join(proj, sid + '.jsonl');
    fs.writeFileSync(a, '{}\n');
    const sess = path.join(proj, 'ssssssss-1111-2222-3333-444444444444');
    fs.mkdirSync(path.join(sess, 'subagents'), { recursive: true });
    fs.mkdirSync(path.join(sess, 'tool-results'), { recursive: true });
    fs.writeFileSync(path.join(sess, 'subagents', 'agent-bbbbbbbb-1111-2222-3333-444444444444.jsonl'), '{}\n');
    fs.writeFileSync(path.join(sess, 'tool-results', 'x.txt'), 'x');
    fs.writeFileSync(path.join(proj, 'memory.jsonl'), '{}\n');
    const w = new ClaudeCodeWatcher({ sessionsDir: tmp });
    const f = w.findLatest();
    assert(f && f.path === a, 'findLatest 排除 subagents/tool-results/非 UUID 文件');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 24. 新会话文件出现 → 切换并重置会话内状态
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-watcher-test-'));
    const a = path.join(tmp, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
    fs.writeFileSync(a, userStr('你好') + '\n');
    const w = new ClaudeCodeWatcher({ sessionsDir: tmp, listeningHoldMs: 0, doneHoldMs: 0, backfillBytes: 1024 });
    w.poll();
    assert(w.state === 'listening', '会话 A 回放建立状态');
    const b = path.join(tmp, 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
    fs.writeFileSync(b, toolUse('PowerShell', { command: 'npm test' }) + '\n');
    w.approvalTimer = setTimeout(() => {}, 99999);
    w.lastStopReason = 'end_turn';
    w.poll();
    assert(w.currentFile && w.currentFile.path === b, '新会话文件出现 → 切换');
    assert(w.state === 'running', '切换后回放新会话状态');
    assert(w.approvalTimer === null, '会话切换清空审批计时');
    assert(w.lastStopReason === 'tool_use', '会话切换丢弃旧 stop_reason，取新会话的');
    w.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(fail ? '\n-- RESULT: FAIL (' + fail + ')' : '\n-- RESULT: ALL PASS');
  process.exit(fail ? 1 : 0);
}

module.exports = ClaudeCodeWatcher;

// ---------- CLI ----------
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--replay' && args[1]) {
    const w = new ClaudeCodeWatcher({ idleAfterMs: 0 });
    const lines = fs.readFileSync(args[1], 'utf8').split('\n').filter(Boolean);
    w.on('state', s => console.log(`[${new Date(s.since).toLocaleTimeString()}] → ${s.state.padEnd(10)} ${s.label}  ${s.detail}`));
    console.log('replaying:', args[1], '\n');
    for (const line of lines) w.processLine(line);
    console.log('\nfinal state:', w.state, '| lastDetail:', w.lastDetail);
    console.log('\n-- timeline (' + w.timeline.length + ') --');
    for (const t of w.timeline) {
      console.log(`  [${new Date(t.ts).toLocaleTimeString()}] ${t.icon} ${t.text}`);
    }
  } else if (args[0] === '--live') {
    const w = new ClaudeCodeWatcher().start();
    w.on('state', s => console.log(`[${new Date().toLocaleTimeString()}] ${s.state.padEnd(10)} ${s.label}  ${s.detail}`));
    console.log('watching', w.opts.sessionsDir, '… (Ctrl+C to stop)');
    process.on('SIGINT', () => { w.stop(); process.exit(0); });
  } else if (args[0] === '--test') {
    runSelfTest();
  } else {
    console.log('用法: node claude-watcher.js --live | --replay <session.jsonl> | --test');
  }
}
