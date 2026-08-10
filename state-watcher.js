// ============================================================
// state-watcher.js — Codex rollout 日志监听 + 状态机（纯 Node，无 Electron 依赖）
// 用法：
//   node state-watcher.js --live              # 实时监听当前 Codex 会话
//   node state-watcher.js --replay <file>     # 回放历史日志验证状态机
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const DEFAULT_OPTS = {
  sessionsDir: path.join(os.homedir(), '.codex', 'sessions'),
  pollMs: 800,
  idleAfterMs: 60 * 1000,          // 60s 无事件 → 空闲（工作状态不回落，防止长命令误判）
  sleepAfterMs: 15 * 60 * 1000,    // 15min 无事件 → 沉睡
  listeningHoldMs: 2500,           // “收到指令”停留时长
  doneHoldMs: 8000,                // “完成”停留时长
  backfillBytes: 200 * 1024,       // 启动时最多回看 200KB 日志
  timelineMax: 10                  // 最近活动时间线最多保留条数
};

const STATE_META = {
  idle:      { label: '空闲',     bubble: '咕噜咕噜～' },
  listening: { label: '收到指令', bubble: '收到！' },
  thinking:  { label: '分析中',   bubble: '让我想想…' },
  coding:    { label: '写代码中', bubble: '在写代码啦' },
  running:   { label: '运行中',   bubble: '正在跑…' },
  searching: { label: '搜索中',   bubble: '查资料中' },
  done:      { label: '完成',     bubble: '搞定！✨' },
  approval:  { label: '等待审批', bubble: '求求你点允许…' },
  sleep:     { label: '沉睡中',   bubble: 'Zzz…' }
};

// 工作状态：这些状态不会被 60s 静默误判为空闲（长命令执行中日志不会增加）
const WORK_STATES = new Set(['listening', 'thinking', 'coding', 'running', 'searching', 'approval']);

class CodexStateWatcher extends EventEmitter {
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
    this.backfilling = false;
    this.timeline = [];            // 最近活动时间线（B 方向新增）
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
    this.timer = null;
  }

  forceRefresh() {
    this.offset = 0;
    this.poll();
  }

  // ---------- 最近活动时间线（B 方向新增） ----------
  pushTimeline(icon, text) {
    this.timeline.push({ ts: Date.now(), icon: icon || '•', text: text || '' });
    if (this.timeline.length > this.opts.timelineMax) this.timeline.shift();
  }

  getTimeline() {
    return this.timeline.slice();
  }

  // 找到最新修改的 rollout 日志
  findLatest() {
    let best = null;
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
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
      // 首次启动或会话切换：回看文件尾部，建立当前状态
      this.currentFile = f;
      this.offset = Math.max(0, f.size - this.opts.backfillBytes);
      this.backfilling = true; // 回放历史时静默，避免启动瞬间状态闪烁
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

  processLine(line) {
    let j;
    try { j = JSON.parse(line); } catch { return; }
    if (!j.timestamp || !j.type) return;

    const t = new Date(j.timestamp).getTime();
    if (!Number.isFinite(t)) return;
    this.lastEventTime = Math.max(this.lastEventTime, t);

    const p = j.payload || {};
    if (j.type === 'event_msg') this.handleEventMsg(p);
    else if (j.type === 'response_item') this.handleResponseItem(p);
    // session_meta / world_state / turn_context 忽略
  }

  handleEventMsg(p) {
    switch (p.type) {
      case 'user_message':
        {
          const text = (p.message && typeof p.message === 'object' && p.message.text)
            ? clip(String(p.message.text), 40)
            : '';
          this.pushTimeline('👂', text ? '收到指令: ' + text : '收到新指令');
          this.setState('listening', { detail: text ? '收到: ' + text : '收到新的指令' });
        }
        clearTimeout(this.listeningTimer);
        this.listeningTimer = setTimeout(() => {
          if (this.state === 'listening') this.setState('thinking', { detail: '开始分析问题' });
        }, this.opts.listeningHoldMs);
        break;

      case 'task_started':
        this.pushTimeline('🚀', '任务开始');
        this.setState('thinking', { detail: '任务开始' });
        break;

      case 'agent_message':
        // 模型正在输出回复
        if (this.state !== 'done' && this.state !== 'approval') {
          this.setState('thinking', { detail: '正在组织回复…' });
        }
        break;

      case 'task_complete':
        this.pushTimeline('✅', '任务完成');
        this.setState('done', { detail: '任务完成' });
        clearTimeout(this.doneTimer);
        this.doneTimer = setTimeout(() => {
          if (this.state === 'done') this.setState('idle', { detail: '回到空闲' });
        }, this.opts.doneHoldMs);
        break;

      case 'patch_apply_end':
        if (this.state !== 'approval' && this.state !== 'done') {
          this.setState('thinking', { detail: p.success === false ? '补丁应用失败，检查一下…' : '补丁已应用' });
        }
        break;

      // token_count / thread_settings_applied：噪音，忽略
    }
  }

  handleResponseItem(p) {
    switch (p.type) {
      case 'reasoning':
        this.setState('thinking', { detail: '深度思考中…' });
        break;

      case 'function_call':
        this.handleToolCall(p);
        break;

      case 'custom_tool_call':
        this.handleCustomTool(p);
        break;

      case 'function_call_output':
        // 工具执行完，模型会继续推理
        if (this.state !== 'approval') this.setState('thinking', { detail: '处理工具结果…' });
        break;
    }
  }

  parseArgs(p) {
    // Codex 日志中参数可能在 arguments（JSON 字符串）或 input（纯文本/对象）
    let raw = p.arguments;
    if (raw === undefined || raw === null) raw = p.input;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch { return {}; }
    }
    return raw && typeof raw === 'object' ? raw : {};
  }

  handleToolCall(p) {
    const name = p.name || '';
    const args = this.parseArgs(p);

    // 等待审批：带 require_escalated 或 justification 的调用
    if (args.sandbox_permissions === 'require_escalated' || args.justification) {
      const why = clip(args.justification || '权限请求', 48);
      this.pushTimeline('⚠️', '请求审批: ' + why);
      this.setState('approval', { detail: '需要你批准：' + why });
      return;
    }
    if (/shell_command|terminal|exec/i.test(name)) {
      const cmd = clip(args.command || args.cmd || '', 60);
      this.pushTimeline('⏳', cmd || 'shell 命令');
      this.setState('running', { detail: cmd ? '正在跑: ' + cmd : '执行命令中…' });
    } else if (/search|open_page|find_in_page|browse/i.test(name)) {
      const q = name === 'search'
        ? clip((Array.isArray(args.queries) ? args.queries : []).slice(0, 2).join('、'), 48)
        : clip(args.url || args.query || args.pattern || '', 48);
      this.pushTimeline('🔎', q || name);
      this.setState('searching', { detail: q ? '搜索: ' + q : '搜索资料中…' });
    } else if (/apply_patch|edit|write/i.test(name)) {
      this.pushTimeline('📝', name);
      this.setState('coding', { detail: '写代码中…' });
    } else {
      this.pushTimeline('🛠', name);
      this.setState('coding', { detail: name });
    }
  }

  // 从 apply_patch 的 patch 文本中提取涉及的文件名
  extractPatchFiles(patchText) {
    const files = [];
    if (typeof patchText !== 'string') return files;
    const re = /^\*\*\* (?:Update File|Add File|Delete File|Move to):\s*(.+?)\s*$/gm;
    let m;
    while ((m = re.exec(patchText)) && files.length < 8) {
      const f = m[1].trim();
      if (f && !files.includes(f)) files.push(f);
    }
    return files;
  }

  handleCustomTool(p) {
    const name = p.name || '';
    const args = this.parseArgs(p);
    if (name === 'apply_patch') {
      const patchText = args.patch || args.patchText || (typeof p.input === 'string' ? p.input : '');
      const files = this.extractPatchFiles(patchText);
      const text = files.length
        ? clip('修改: ' + files.slice(0, 3).join(', ') + (files.length > 3 ? ' 等' + files.length + ' 个文件' : ''), 60)
        : '正在写代码（补丁应用）';
      this.pushTimeline('📝', text);
      this.setState('coding', { detail: text });
    } else if (/search|browse|open_page|find_in_page/i.test(name)) {
      const q = clip(args.url || args.query || args.pattern || '', 48);
      this.pushTimeline('🔎', q || name);
      this.setState('searching', { detail: q ? '搜索: ' + q : name });
    } else if (/spawn_agent|multi_agent|subagent/i.test(name)) {
      const target = clip(args.target || args.model || '', 30);
      this.pushTimeline('🤖', '协调子智能体' + (target ? ' (' + target + ')' : ''));
      this.setState('thinking', { detail: '协调子智能体…' });
    } else if (name) {
      this.pushTimeline('🛠', name);
      this.setState('coding', { detail: name });
    }
  }

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

CodexStateWatcher.STATE_META = STATE_META;

module.exports = CodexStateWatcher;

// ---------- CLI ----------
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--replay' && args[1]) {
    const w = new CodexStateWatcher({ idleAfterMs: 0 });
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
    const w = new CodexStateWatcher().start();
    w.on('state', s => console.log(`[${new Date().toLocaleTimeString()}] ${s.state.padEnd(10)} ${s.label}  ${s.detail}`));
    console.log('watching', w.opts.sessionsDir, '… (Ctrl+C to stop)');
    process.on('SIGINT', () => { w.stop(); process.exit(0); });
  } else {
    console.log('用法: node state-watcher.js --live | --replay <rollout.jsonl>');
  }
}
