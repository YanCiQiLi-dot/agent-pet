// ============================================================
// opencode-watcher.js — OpenCode 日志监听 + 状态机（纯 Node，无 Electron 依赖）
// 数据源（与 Codex 完全独立，可并行监听）：
//   - opencode.log            （XDG_DATA_HOME/opencode/log/opencode.log，key=value 结构化日志）
//   - prompt-history.jsonl    （XDG_STATE_HOME/opencode/prompt-history.jsonl，用户输入历史）
// 用法：
//   node opencode-watcher.js --live              # 实时监听当前 OpenCode
//   node opencode-watcher.js --replay <log文件>  # 回放历史日志验证状态机
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { STATE_META } = require('./state-watcher');

function xdgDir(envKey, fallback) {
  if (process.env[envKey]) return process.env[envKey];
  return path.join(os.homedir(), fallback);
}

const DEFAULT_OPTS = {
  logPath: path.join(xdgDir('XDG_DATA_HOME', path.join('.local', 'share')), 'opencode', 'log', 'opencode.log'),
  promptPath: path.join(xdgDir('XDG_STATE_HOME', path.join('.local', 'state')), 'opencode', 'prompt-history.jsonl'),
  pollMs: 800,
  idleAfterMs: 60 * 1000,          // 60s 无事件 → 空闲（工作状态不回落，防止长命令误判）
  sleepAfterMs: 15 * 60 * 1000,    // 15min 无事件 → 沉睡
  listeningHoldMs: 2500,           // “收到指令”停留时长
  doneHoldMs: 8000,                // “完成”停留时长
  backfillBytes: 200 * 1024,       // 启动时最多回看 200KB 日志
  timelineMax: 10                  // 最近活动时间线最多保留条数
};

// 工作状态：这些状态不会被 60s 静默误判为空闲（长命令执行中日志不会增加）
const WORK_STATES = new Set(['listening', 'thinking', 'coding', 'running', 'searching', 'approval']);

class OpenCodeWatcher extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = Object.assign({}, DEFAULT_OPTS, opts);
    this.state = 'idle';
    this.lastDetail = '';
    this.lastEventTime = 0;
    this.timer = null;
    this.listeningTimer = null;
    this.doneTimer = null;
    this.backfilling = false;
    this.timeline = [];
    this.offsets = { log: 0, prompt: 0 };
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
    this.offsets = { log: 0, prompt: 0 };
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

  // ---------- 增量读文件尾部（文件不存在/被轮转时静默容错） ----------
  readTail(file, key) {
    let st;
    try { st = fs.statSync(file); } catch { return; }
    // 首次启动：回看文件尾部（backfillBytes），期间静默，避免启动瞬间状态闪烁
    if (!this.offsets[key]) {
      this.offsets[key] = Math.max(0, st.size - this.opts.backfillBytes);
      this.backfilling = true;
    }
    if (st.size < this.offsets[key]) this.offsets[key] = 0; // 文件被截断/轮转
    if (st.size === this.offsets[key]) return;

    const buf = Buffer.alloc(st.size - this.offsets[key]);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, this.offsets[key]); } finally { fs.closeSync(fd); }
    this.offsets[key] = st.size;

    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (const line of lines) this.processLine(line, key);
  }

  poll() {
    this.readTail(this.opts.logPath, 'log');
    this.readTail(this.opts.promptPath, 'prompt');
    this.checkIdle();
    if (this.backfilling) {
      this.backfilling = false;
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

  processLine(line, key) {
    if (key === 'prompt') { this.processPrompt(line); return; }
    const j = parseKV(line);
    if (!j || !j.timestamp) return;
    const t = new Date(j.timestamp).getTime();
    if (!Number.isFinite(t)) return;
    this.lastEventTime = Math.max(this.lastEventTime, t);
    this.handleLog(j);
  }

  // ---------- prompt-history.jsonl：用户输入 → 收到指令 ----------
  processPrompt(line) {
    let j;
    try { j = JSON.parse(line); } catch { return; }
    if (!j || typeof j.input !== 'string') return;
    const text = clip(j.input, 40);
    this.pushTimeline('👂', text ? '收到指令: ' + text : '收到新指令');
    this.setState('listening', { detail: text ? '收到: ' + text : '收到新的指令' });
    clearTimeout(this.listeningTimer);
    this.listeningTimer = setTimeout(() => {
      if (this.state === 'listening') this.setState('thinking', { detail: '开始分析问题' });
    }, this.opts.listeningHoldMs);
  }

  // ---------- opencode.log 主分发 ----------
  handleLog(j) {
    const msg = j.message;
    switch (msg) {
      case 'asking':      this.handleAsking(j); break;
      case 'evaluated':   this.handleEvaluated(j); break;
      case 'stream':      this.handleStream(j); break;
      case 'touching file': this.handleTouchingFile(j); break;
      case 'exiting loop': this.handleExitingLoop(); break;
      case 'command':     this.handleCommand(j); break;
      case 'cancel':      this.handleCancel(); break;
      case 'created':     this.handleCreated(j); break;
      // stream error / loop / process / init / loading …：辅助信号，无需直接映射
    }
  }

  // 等待审批 / 等待回答
  handleAsking(j) {
    const id = j.id || '';
    if (id.startsWith('per_')) {
      let why = j.patterns || j.permission || '权限请求';
      // patterns 可能是 JSON 数组字符串（如 ["D:\\path\\*"]），提取第一个可读项
      if (typeof why === 'string' && why.trim().startsWith('[')) {
        try {
          const arr = JSON.parse(why);
          if (Array.isArray(arr) && arr.length) why = arr[0];
        } catch {}
      }
      why = clip(why, 48);
      this.pushTimeline('⚠️', '请求审批: ' + why);
      this.setState('approval', { detail: '需要你批准：' + why });
    } else {
      const n = j.questions ? String(j.questions) : '';
      this.pushTimeline('❓', '向你提问' + (n ? '（' + n + ' 个问题）' : ''));
      this.setState('approval', { detail: '需要你回答' + (n ? '（' + n + ' 个问题）' : '') });
    }
  }

  // 权限评估 = 工具执行前的信号（permission= 类型决定状态）
  handleEvaluated(j) {
    const perm = j.permission || '';
    const pattern = j.pattern || '';
    switch (perm) {
      case 'bash':
        this.pushTimeline('⏳', pattern ? '运行: ' + clip(pattern, 40) : 'shell 命令');
        this.setState('running', { detail: pattern ? '正在跑: ' + clip(pattern, 60) : '执行命令中…' });
        break;
      case 'edit':
        this.pushTimeline('📝', pattern ? '修改: ' + clip(pattern, 40) : '修改文件');
        this.setState('coding', { detail: pattern ? '修改: ' + clip(pattern, 48) : '正在写代码（编辑文件）' });
        break;
      case 'websearch':
        this.pushTimeline('🔎', pattern ? '搜索: ' + clip(pattern, 40) : '网络搜索');
        this.setState('searching', { detail: pattern ? '搜索: ' + clip(pattern, 48) : '网络搜索中…' });
        break;
      case 'webfetch':
        this.pushTimeline('🌐', pattern ? '访问: ' + clip(pattern, 40) : '网页访问');
        this.setState('searching', { detail: pattern ? '访问: ' + clip(pattern, 48) : '访问网页中…' });
        break;
      case 'grep':
      case 'glob':
        this.pushTimeline('🔎', pattern ? '搜索文件: ' + clip(pattern, 40) : '搜索文件');
        this.setState('searching', { detail: pattern ? '搜索文件: ' + clip(pattern, 48) : '搜索文件中…' });
        break;
      case 'task':
        this.pushTimeline('🤖', '协调子智能体' + (pattern ? ': ' + clip(pattern, 20) : ''));
        this.setState('thinking', { detail: '协调子智能体' + (pattern ? ': ' + clip(pattern, 30) : '') });
        break;
      case 'todowrite':
        this.setState('thinking', { detail: '更新任务计划' });
        break;
      case 'skill':
        this.setState('thinking', { detail: '使用技能: ' + clip(pattern, 30) });
        break;
      case 'read':
        this.setState('thinking', { detail: pattern ? '读取: ' + clip(pattern, 40) : '读取文件中…' });
        break;
      case 'external_directory':
        this.setState('thinking', { detail: pattern ? '访问外部目录: ' + clip(pattern, 40) : '访问外部目录…' });
        break;
      default:
        this.setState('thinking', { detail: perm || '处理工具调用…' });
    }
  }

  // 模型流式输出 → 分析中（small=true 是标题生成，忽略）
  handleStream(j) {
    if (j.small === 'true' || j.small === true) return;
    if (this.state !== 'approval' && this.state !== 'done') {
      this.setState('thinking', { detail: '正在生成回复…' });
    }
  }

  // 文件被写入 → 写代码中
  handleTouchingFile(j) {
    const file = j.file || '';
    const short = file ? file.split(/[\\/]/).pop() : '';
    this.pushTimeline('📝', short ? '改动: ' + short : '修改文件');
    if (this.state !== 'approval' && this.state !== 'done') {
      this.setState('coding', { detail: short ? '修改: ' + short : '正在写代码（文件变更）' });
    }
  }

  // 一轮循环结束 = 本轮任务完成，等待用户输入
  handleExitingLoop() {
    this.pushTimeline('✅', '任务完成');
    this.setState('done', { detail: '任务完成，等待你的下一步' });
    clearTimeout(this.doneTimer);
    this.doneTimer = setTimeout(() => {
      if (this.state === 'done') this.setState('idle', { detail: '回到空闲' });
    }, this.opts.doneHoldMs);
  }

  handleCommand(j) {
    const c = clip(j.command || '', 30);
    this.pushTimeline('🚀', c ? '执行命令: ' + c : '执行命令');
    this.setState('thinking', { detail: c ? '执行命令: ' + c : '执行命令…' });
  }

  handleCancel() {
    this.setState('idle', { detail: '已取消，回到空闲' });
  }

  handleCreated(j) {
    const title = j.title || j.slug || '';
    this.pushTimeline('🆕', title ? '新会话: ' + clip(title, 30) : '新会话');
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

// ---------- opencode.log 的 key=value 行解析 ----------
// timestamp=... level=INFO run=xxx message="exiting loop" session.id=ses_xxx
const KV_RE = /([A-Za-z0-9_.-]+)=("(?:[^"\\]|\\.)*"|[^\s]+)/g;
function parseKV(line) {
  const out = {};
  let m;
  KV_RE.lastIndex = 0;
  while ((m = KV_RE.exec(line))) {
    let v = m[2];
    if (v.startsWith('"')) {
      try { v = JSON.parse(v); } catch { v = v.slice(1, -1); }
    }
    out[m[1]] = v;
  }
  return Object.keys(out).length ? out : null;
}

// 工具：压缩空白 + 截断（中文按字符截）
function clip(s, n) {
  if (typeof s !== 'string') return '';
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ---------- 自测（无外部依赖：直接喂日志行，验证状态机推导） ----------
function runSelfTest() {
  let fail = 0;
  function assert(cond, name) {
    console.log((cond ? '  PASS ' : '  FAIL ') + name);
    if (!cond) fail++;
  }
  function logLine(msg, extra) {
    const kv = Object.assign({ timestamp: new Date().toISOString(), level: 'INFO', message: msg }, extra || {});
    return Object.keys(kv).map(k => k + '=' + JSON.stringify(kv[k])).join(' ');
  }
  function make() { return new OpenCodeWatcher({ listeningHoldMs: 0, doneHoldMs: 0 }); }

  console.log('== OpenCodeWatcher 状态机自测 ==');

  // 1. asking(per_) 审批 → approval（detail 取 patterns[0]）
  {
    const w = make();
    w.processLine(logLine('asking', { id: 'per_1', permission: 'bash', patterns: '["D:\\\\*"]' }), 'log');
    assert(w.state === 'approval', 'asking(per_) → approval');
    assert(w.lastDetail.includes('D:'), 'approval detail 取 patterns[0]');
  }
  // 2. evaluated bash → running
  {
    const w = make();
    w.processLine(logLine('evaluated', { permission: 'bash', pattern: 'npm test' }), 'log');
    assert(w.state === 'running', 'evaluated bash → running');
    assert(w.lastDetail.includes('npm test'), 'running detail 含命令');
  }
  // 3. evaluated edit → coding
  {
    const w = make();
    w.processLine(logLine('evaluated', { permission: 'edit', pattern: 'C:\\proj\\main.js' }), 'log');
    assert(w.state === 'coding', 'evaluated edit → coding');
  }
  // 4. touching file → coding（detail 只含文件名）
  {
    const w = make();
    w.processLine(logLine('touching file', { file: 'C:\\proj\\main.js' }), 'log');
    assert(w.state === 'coding', 'touching file → coding');
    assert(w.lastDetail.includes('main.js') && !w.lastDetail.includes('proj'), 'coding detail 只含文件名');
  }
  // 5. websearch → searching
  {
    const w = make();
    w.processLine(logLine('evaluated', { permission: 'websearch', pattern: 'Codex API' }), 'log');
    assert(w.state === 'searching', 'evaluated websearch → searching');
  }
  // 6. exiting loop → done
  {
    const w = make();
    w.processLine(logLine('exiting loop', {}), 'log');
    assert(w.state === 'done', 'exiting loop → done');
  }
  // 7. stream small=true 忽略；普通 stream → thinking
  {
    const w = make();
    w.processLine(logLine('stream', { small: 'true' }), 'log');
    assert(w.state === 'idle', 'stream small=true 被忽略');
    w.processLine(logLine('stream', {}), 'log');
    assert(w.state === 'thinking', 'stream → thinking');
  }
  // 8. prompt-history 输入 → listening
  {
    const w = make();
    w.processLine(JSON.stringify({ input: '你好' }), 'prompt');
    assert(w.state === 'listening', 'prompt-history input → listening');
    assert(w.lastDetail.includes('你好'), 'listening detail 含输入');
  }
  // 9. parseKV 解析带空格引号值
  {
    const j = parseKV('timestamp=2026-01-01T00:00:00Z message="hello world" level=INFO');
    assert(j && j.message === 'hello world', 'parseKV 解析带空格引号值');
  }
  // 10. 工作状态不被静默误判；非工作状态超时回 idle；超长无事件 → 沉睡
  {
    const w = make();
    w.processLine(logLine('evaluated', { permission: 'bash', pattern: 'long' }), 'log');
    w.lastEventTime = Date.now() - 120000;
    w.checkIdle();
    assert(w.state === 'running', '工作状态(running)不被 60s 静默误判');
    w.setState('done', { detail: 'x' });
    w.lastEventTime = Date.now() - 120000;
    w.checkIdle();
    assert(w.state === 'idle', '非工作状态超时回 idle');
  }
  {
    const w = new OpenCodeWatcher({ idleAfterMs: 0, sleepAfterMs: 60000, listeningHoldMs: 0, doneHoldMs: 0 });
    w.processLine(logLine('exiting loop', {}), 'log');
    w.lastEventTime = Date.now() - 120000;
    w.checkIdle();
    assert(w.state === 'sleep', '超长无事件 → 沉睡');
  }

  console.log(fail ? '\n-- RESULT: FAIL (' + fail + ')' : '\n-- RESULT: ALL PASS');
  process.exit(fail ? 1 : 0);
}

module.exports = OpenCodeWatcher;

// ---------- CLI ----------
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--replay' && args[1]) {
    const w = new OpenCodeWatcher({ idleAfterMs: 0 });
    const lines = fs.readFileSync(args[1], 'utf8').split('\n').filter(Boolean);
    w.on('state', s => console.log(`[${new Date(s.since).toLocaleTimeString()}] → ${s.state.padEnd(10)} ${s.label}  ${s.detail}`));
    console.log('replaying:', args[1], '\n');
    for (const line of lines) w.processLine(line, 'log');
    console.log('\nfinal state:', w.state, '| lastDetail:', w.lastDetail);
    console.log('\n-- timeline (' + w.timeline.length + ') --');
    for (const t of w.timeline) {
      console.log(`  [${new Date(t.ts).toLocaleTimeString()}] ${t.icon} ${t.text}`);
    }
  } else if (args[0] === '--live') {
    const w = new OpenCodeWatcher().start();
    w.on('state', s => console.log(`[${new Date().toLocaleTimeString()}] ${s.state.padEnd(10)} ${s.label}  ${s.detail}`));
    console.log('watching', w.opts.logPath);
    console.log('watching', w.opts.promptPath, '… (Ctrl+C to stop)');
    process.on('SIGINT', () => { w.stop(); process.exit(0); });
  } else if (args[0] === '--test') {
    runSelfTest();
  } else {
    console.log('用法: node opencode-watcher.js --live | --replay <opencode.log> | --test');
  }
}
