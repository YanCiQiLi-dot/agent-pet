// ============================================================
// dsh-watcher.js — DeepSeek Harness (DSH) 会话日志监听 + 状态机（纯 Node，无 Electron 依赖）
//
// 数据源：~/.dsh/sessions/<项目>/<会话id>/session.jsonl.zstd
//   - DSH 的持久化后端把会话事件写成"仅追加 JSONL"，默认 zstd 压缩：
//     第一个 frame 是 header 行，之后每个追加批次一个独立带 checksum 的 frame
//   - 写入有 ≤200ms 批处理窗口，轮询读尾部即可（与 Codex rollout 同等实时性）
//   - 事件类型（SessionEvent）：user/message、turn/start、step/start、
//     assistant/chunk、reasoning-chunks、text-chunks、tool-call-chunks、
//     tool/call、tool/result、turn/end …
//   - 解压用 fzstd（纯 JS zstd 解码，Electron 33 内置 Node 20 无原生 zstd）
//
// 用法：
//   node dsh-watcher.js --live              # 实时监听当前 DSH 会话
//   node dsh-watcher.js --replay <file>     # 回放 .jsonl.zstd / .jsonl 验证状态机
//   node dsh-watcher.js --test              # 状态机自测
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { decompress } = require('fzstd');

const DEFAULT_OPTS = {
  sessionsDir: path.join(os.homedir(), '.dsh', 'sessions'),
  pollMs: 800,
  idleAfterMs: 60 * 1000,          // 60s 无事件 → 空闲（工作状态不回落，防止长命令误判）
  sleepAfterMs: 15 * 60 * 1000,    // 15min 无事件 → 沉睡
  listeningHoldMs: 2500,           // “收到指令”停留时长
  doneHoldMs: 8000,                // “完成”停留时长
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

// ---------- zstd 帧扫描（与 DSH 后端同款结构：checksummed 拼接 frame） ----------
const ZSTD_MAGIC = 4247762216; // 0xFD2FB528 LE

// 扫描完整 zstd frame 边界；最后一个 frame 不完整时返回 tornStart（等下一轮补全）
// 参考 DSH dsh-session-persistence-jsonl 的 scanZstdFrames（标准 zstd frame 布局）
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  let tornStart = null;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) { tornStart = start; break; }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break; // 不是 frame 开头（异常，放弃剩余）
    offset += 4;
    if (offset === buffer.length) { tornStart = start; break; }
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) { tornStart = start; break; } // 保留位被置位：视为损坏尾部
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) { tornStart = start; break; }
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) { tornStart = start; break; }
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) { tornStart = start; break; } // 保留 block 类型
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) { tornStart = start; break; }
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (tornStart !== null) break;
    if (checksum) {
      if (buffer.length - offset < 4) { tornStart = start; break; }
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames, tornStart };
}

class DshWatcher extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = Object.assign({}, DEFAULT_OPTS, opts);
    if (process.env.DSH_HOME && !opts.sessionsDir) {
      this.opts.sessionsDir = path.join(process.env.DSH_HOME, 'sessions');
    }
    this.state = 'idle';
    this.lastDetail = '';
    this.lastEventTime = 0;
    this.timer = null;
    this.listeningTimer = null;
    this.doneTimer = null;
    this.currentFile = null;
    this.offset = 0;               // 已处理字节数（帧边界对齐）
    this.pendingLine = '';         // 跨 frame 被截断的 JSONL 行
    this.backfilling = false;      // 回放历史时静默，避免启动瞬间状态闪烁
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
    this.timer = null;
  }

  forceRefresh() {
    this.offset = 0;
    this.pendingLine = '';
    this.poll();
  }

  // ---------- 最近活动时间线 ----------
  pushTimeline(icon, text) {
    this.timeline.push({ ts: Date.now(), icon: icon || '•', text: text || '' });
    if (this.timeline.length > this.opts.timelineMax) this.timeline.shift();
  }

  getTimeline() {
    return this.timeline.slice();
  }

  // 找到最新修改的会话日志（session.jsonl.zstd 优先，兼容明文 session.jsonl）
  findLatest() {
    let best = null;
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === 'session.jsonl.zstd' || e.name === 'session.jsonl') {
          let st;
          try { st = fs.statSync(p); } catch { continue; }
          if (!best || st.mtimeMs > best.mtimeMs) {
            best = { path: p, mtimeMs: st.mtimeMs, size: st.size, compressed: e.name.endsWith('.zstd') };
          }
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
      // 首次启动或会话切换：从头回放该文件建立状态（zstd 帧必须从头解析），静默处理
      this.currentFile = f;
      this.offset = 0;
      this.pendingLine = '';
      this.backfilling = true;
    }

    let st;
    try { st = fs.statSync(f.path); } catch { return; }
    if (st.size < this.offset) { this.offset = 0; this.pendingLine = ''; } // 文件被截断/轮转
    if (st.size === this.offset) { this.checkIdle(); return; }

    const buf = Buffer.alloc(st.size - this.offset);
    const fd = fs.openSync(f.path, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, this.offset); } finally { fs.closeSync(fd); }

    if (f.compressed) {
      // 只处理完整 frame；撕裂尾部下一轮补全（DSH 崩溃恢复语义兼容）
      const { frames, tornStart } = scanZstdFrames(buf);
      for (const fr of frames) {
        try {
          const plain = decompress(buf.subarray(fr.start, fr.end));
          this.feedText(Buffer.from(plain).toString('utf8'));
        } catch { /* 单个 frame 损坏：跳过（正常不出现） */ }
      }
      this.offset += (tornStart !== null ? tornStart : buf.length);
    } else {
      this.feedText(buf.toString('utf8'));
      this.offset += buf.length;
    }
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

  // 喂入解压后的文本（处理跨 frame 截断行）
  feedText(text) {
    if (!text) return;
    const parts = text.split('\n');
    parts[0] = this.pendingLine + parts[0];
    this.pendingLine = parts.pop() || '';
    for (const part of parts) {
      const line = part.trim();
      if (line) this.processLine(line);
    }
  }

  processLine(line) {
    let j;
    try { j = JSON.parse(line); } catch { return; }
    if (!j.type) return;
    const t = Number.isFinite(j.time) ? j.time : null;
    if (t) this.lastEventTime = Math.max(this.lastEventTime, t);
    this.handleEvent(j);
  }

  // ---------- 事件 → 状态机 ----------
  handleEvent(e) {
    switch (e.type) {
      case 'user/message': {
        const text = this.extractText(e.data && e.data.content);
        if (text) {
          this.pushTimeline('👂', '收到指令: ' + clip(text, 40));
          this.setState('listening', { detail: '收到: ' + clip(text, 40) });
        } else {
          this.pushTimeline('👂', '收到新指令');
          this.setState('listening', { detail: '收到新的指令' });
        }
        clearTimeout(this.listeningTimer);
        this.listeningTimer = setTimeout(() => {
          if (this.state === 'listening') this.setState('thinking', { detail: '开始分析问题' });
        }, this.opts.listeningHoldMs);
        break;
      }
      case 'agent/inbox/spliced': {
        // 用户消息进入队列（先于 user/message，避免重复弹时间线）
        const ins = (e.data && e.data.inserted) || [];
        const text = ins.map((m) => this.extractText(m.content)).filter(Boolean).join(' ');
        this.setState('listening', { detail: text ? '收到: ' + clip(text, 40) : '收到新的指令' });
        clearTimeout(this.listeningTimer);
        this.listeningTimer = setTimeout(() => {
          if (this.state === 'listening') this.setState('thinking', { detail: '开始分析问题' });
        }, this.opts.listeningHoldMs);
        break;
      }
      case 'turn/start':
        this.pushTimeline('🚀', '回合开始');
        this.setState('thinking', { detail: '开始处理任务' });
        break;
      case 'step/start':
        // 回合内步骤：状态已在工作时不打断（避免刷屏）
        if (!WORK_STATES.has(this.state)) this.setState('thinking', { detail: '开始处理任务' });
        break;
      case 'reasoning-chunks':
        this.setState('thinking', { detail: '深度思考中…' });
        break;
      case 'text-chunks':
        if (this.state !== 'approval' && this.state !== 'done') {
          this.setState('thinking', { detail: '正在组织回复…' });
        }
        break;
      case 'tool-call-chunks':
        // 工具参数流式生成中（等完整 tool/call 再映射）
        if (this.state !== 'approval' && this.state !== 'done') {
          this.setState('thinking', { detail: '准备调用工具…' });
        }
        break;
      case 'tool/call':
        this.handleToolCall(e.data || {});
        break;
      case 'tool/result': {
        const denied = this.detectDenied(e.data);
        if (denied) {
          this.pushTimeline('⚠️', '需要你批准: ' + denied);
          this.setState('approval', { detail: '需要你批准：' + denied });
        } else if (this.state !== 'approval' && this.state !== 'done') {
          this.setState('thinking', { detail: '处理工具结果…' });
        }
        break;
      }
      case 'turn/end': {
        const reason = (e.data && e.data.reason && e.data.reason.kind) || '';
        if (reason === 'completed') {
          this.pushTimeline('✅', '任务完成');
          this.setState('done', { detail: '任务完成' });
          clearTimeout(this.doneTimer);
          this.doneTimer = setTimeout(() => {
            if (this.state === 'done') this.setState('idle', { detail: '回到空闲' });
          }, this.opts.doneHoldMs);
        } else {
          this.setState('thinking', { detail: '继续处理…' });
        }
        break;
      }
      case 'todo/write':
        this.pushTimeline('📋', '更新任务清单');
        if (this.state !== 'approval' && this.state !== 'done') {
          this.setState('thinking', { detail: '规划任务中…' });
        }
        break;
      case 'goal/change':
        if (this.state !== 'approval' && this.state !== 'done') {
          this.setState('thinking', { detail: '追踪目标中…' });
        }
        break;
      // session / permission/preset / sandbox/mode / approval/policy / request/header /
      // request/context / session/title / session/title-llm-request / assistant/chunk /
      // assistant/message：噪音或已被粗粒度事件覆盖，忽略
    }
  }

  // 从 message content 块提取纯文本
  extractText(content) {
    if (!Array.isArray(content)) return '';
    return content
      .map((c) => (c && c.type === 'text' && typeof c.text === 'string') ? c.text : '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 工具调用 → 状态（DSH 工具集：pwsh/read/write/edit/glob/grep/web_search/…）
  handleToolCall(data) {
    const name = data.name || '';
    const args = this.parseArgs(data.arguments);

    if (name === 'ask_user_question') {
      const q = clip(args.question || args.text || '', 48);
      this.pushTimeline('⚠️', '询问你: ' + (q || '问题'));
      this.setState('approval', { detail: q ? '需要你回答：' + q : '正在询问你…' });
    } else if (/^pwsh$|bash|shell|exec|terminal|powershell/i.test(name)) {
      const cmd = clip(args.command || args.cmd || args.script || '', 60);
      this.pushTimeline('⏳', cmd || '运行命令');
      this.setState('running', { detail: cmd ? '正在跑: ' + cmd : '执行命令中…' });
    } else if (/write|edit|patch/i.test(name)) {
      const file = clip(args.file_path || args.file || args.path || '', 48);
      const text = file ? '修改: ' + file : '正在写代码';
      this.pushTimeline('📝', text);
      this.setState('coding', { detail: text });
    } else if (/web_search|search/i.test(name)) {
      const q = clip(args.query || args.q || '', 48);
      this.pushTimeline('🔎', q || '搜索');
      this.setState('searching', { detail: q ? '搜索: ' + q : '搜索资料中…' });
    } else if (/glob|grep|read|find/i.test(name)) {
      const pat = clip(args.pattern || args.path || args.file_path || args.query || '', 48);
      const label = name === 'read' ? '读取: ' : '查找: ';
      this.pushTimeline('🔎', (pat ? label + pat : name));
      this.setState('searching', { detail: pat ? label + pat : '查找资料中…' });
    } else if (/subagent|workflow|agent/i.test(name)) {
      const target = clip(args.description || args.model || '', 30);
      this.pushTimeline('🤖', '协调子智能体' + (target ? ' (' + target + ')' : ''));
      this.setState('thinking', { detail: '协调子智能体…' });
    } else {
      this.pushTimeline('🛠', name);
      this.setState('thinking', { detail: name ? '正在执行 ' + name + ' …' : '分析中…' });
    }
  }

  parseArgs(raw) {
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch { return {}; }
    }
    return raw && typeof raw === 'object' ? raw : {};
  }

  // 沙箱拒绝启发式：tool/result 内容出现拒绝措辞 → 等待审批
  detectDenied(data) {
    if (!data || !data.message || !Array.isArray(data.message.content)) return '';
    let text = '';
    for (const c of data.message.content) {
      if (c && c.type === 'tool-result' && Array.isArray(c.content)) {
        for (const inner of c.content) {
          if (inner && inner.type === 'text' && typeof inner.text === 'string') text += inner.text + ' ';
        }
      }
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return '';
    // DSH 沙箱拒绝是官方固定格式：[sandbox: file access denied under <mode> mode]
    // 只匹配该格式与极强措辞，避免命令输出本身出现 denied/approval 等词造成误报
    const REJECT = /\[sandbox:[^\]]*denied|access denied under|permission denied under/i;
    if (REJECT.test(text.slice(0, 500))) {
      return clip(text.slice(0, 200), 48);
    }
    return '';
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
    // 状态未变且详情未变才跳过（同状态的新 detail 也要推送）
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

DshWatcher.STATE_META = STATE_META;

module.exports = DshWatcher;

// ---------- 自测（合成 SessionEvent 流，验证状态机推导） ----------
function runSelfTest() {
  let fail = 0;
  function assert(cond, name) {
    console.log((cond ? '  PASS ' : '  FAIL ') + name);
    if (!cond) fail++;
  }
  function ev(type, data) {
    return JSON.stringify({ type, time: Date.now(), seq: 0, data });
  }
  function tcall(name, args) {
    return ev('tool/call', { name, arguments: JSON.stringify(args || {}) });
  }
  function make() { return new DshWatcher({ listeningHoldMs: 0, doneHoldMs: 0 }); }

  console.log('== DshWatcher 状态机自测 ==');

  // 1. 收到指令 → listening
  {
    const w = make();
    w.processLine(ev('user/message', { content: [{ type: 'text', text: '帮我修 bug' }] }));
    assert(w.state === 'listening', 'user/message → listening');
    assert(w.lastDetail.includes('帮我修 bug'), 'listening detail 含消息文本');
  }
  // 2. agent/inbox/spliced → listening
  {
    const w = make();
    w.processLine(ev('agent/inbox/spliced', {
      inserted: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }]
    }));
    assert(w.state === 'listening', 'agent/inbox/spliced → listening');
  }
  // 3. 回合开始 → thinking
  {
    const w = make();
    w.processLine(ev('turn/start', { turn: 1 }));
    assert(w.state === 'thinking', 'turn/start → thinking');
  }
  // 4. 打包行 reasoning-chunks / text-chunks → thinking
  {
    const w = make();
    w.processLine(ev('reasoning-chunks', { turn: 1, step: 1, index: 0, dt: [1], texts: ['x'] }));
    assert(w.state === 'thinking', 'reasoning-chunks → thinking');
  }
  // 5. pwsh 命令 → running（含命令详情）
  {
    const w = make();
    w.processLine(tcall('pwsh', { command: 'npm test' }));
    assert(w.state === 'running', 'pwsh → running');
    assert(w.lastDetail.includes('npm test'), 'running detail 含命令');
  }
  // 6. web_search → searching（含关键词）
  {
    const w = make();
    w.processLine(tcall('web_search', { query: 'Codex API 文档' }));
    assert(w.state === 'searching', 'web_search → searching');
    assert(w.lastDetail.includes('Codex API'), 'searching detail 含关键词');
  }
  // 7. write → coding（含文件名）
  {
    const w = make();
    w.processLine(tcall('write', { file_path: 'src/main.js' }));
    assert(w.state === 'coding', 'write → coding');
    assert(w.lastDetail.includes('src/main.js'), 'coding detail 含文件名');
  }
  // 8. ask_user_question → approval
  {
    const w = make();
    w.processLine(tcall('ask_user_question', { question: '允许安装依赖吗？' }));
    assert(w.state === 'approval', 'ask_user_question → approval');
    assert(w.lastDetail.includes('允许安装'), 'approval detail 含问题');
  }
  // 9. 完成 → done
  {
    const w = make();
    w.processLine(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
    assert(w.state === 'done', 'turn/end completed → done');
  }
  // 10. 工具结果后回到推理；denied 文本 → approval
  {
    const w = make();
    w.processLine(ev('tool/result', {
      message: { source: { kind: 'tool' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] }
    }));
    assert(w.state === 'thinking', 'tool/result → thinking（工具结果处理中）');
    const w2 = make();
    w2.processLine(ev('tool/result', {
      message: { source: { kind: 'tool' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: '[sandbox: file access denied under read-only mode]' }] }] }
    }));
    assert(w2.state === 'approval', 'tool/result 沙箱拒绝格式 → approval');
    // 命令输出里恰好出现 denied 词（非拒绝形态）不应误判
    const w3 = make();
    w3.processLine(ev('tool/result', {
      message: { source: { kind: 'tool' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'PASS tool/result 含 denied → approval（普通命令输出）' }] }] }
    }));
    assert(w3.state === 'thinking', '命令输出含 denied 裸词不误判为审批');
  }
  // 11. 子智能体 → thinking
  {
    const w = make();
    w.processLine(tcall('subagent', { description: '审查代码' }));
    assert(w.state === 'thinking', 'subagent → thinking');
    assert(w.lastDetail.includes('子智能体'), 'subagent detail 文案');
  }
  // 12. 坏行 / 噪音事件被忽略（不崩溃）
  {
    const w = make();
    w.processLine('this is not json');
    w.processLine(ev('session', { id: 'x' }));
    w.processLine(ev('request/header', { header: {} }));
    w.processLine(ev('assistant/message', { message: {} }));
    assert(w.state === 'idle', '坏行与噪音事件被忽略（保持 idle）');
  }
  // 13. 工作状态不被静默误判为空闲；非工作状态超时回 idle；超长无事件 → 沉睡
  {
    const w = make();
    w.processLine(tcall('pwsh', { command: 'sleep 100' }));
    w.lastEventTime = Date.now() - 120000;
    w.checkIdle();
    assert(w.state === 'running', '工作状态(running)不被 60s 静默误判');
    w.setState('done', { detail: 'x' });
    w.lastEventTime = Date.now() - 120000;
    w.checkIdle();
    assert(w.state === 'idle', '非工作状态超时回 idle');
  }
  {
    const w = new DshWatcher({ idleAfterMs: 0, sleepAfterMs: 60000, listeningHoldMs: 0, doneHoldMs: 0 });
    w.processLine(tcall('pwsh', { command: 'x' }));
    w.lastEventTime = Date.now() - 120000;
    w.checkIdle();
    assert(w.state === 'sleep', '超长无事件 → 沉睡');
  }
  // 14. 帧扫描：构造 3 个拼接帧（含撕裂尾部）
  {
    const zlib = require('zlib');
    if (typeof zlib.zstdCompressSync === 'function') {
      const f1 = zlib.zstdCompressSync(Buffer.from('{"type":"session","id":"h"}\n'));
      const f2 = zlib.zstdCompressSync(Buffer.from('{"type":"turn/start","time":' + Date.now() + '}\n'));
      const junk = Buffer.from([0x28, 0xB5, 0x2F, 0xFD, 0x01]); // 撕裂的 frame 头
      const all = Buffer.concat([f1, f2, junk]);
      const { frames, tornStart } = scanZstdFrames(all);
      assert(frames.length === 2 && tornStart === f1.length + f2.length, '扫描出 2 个完整帧 + 撕裂尾部');
    } else {
      console.log('  SKIP 帧扫描测试（当前 Node 无 zstd 内置，仅运行时依赖 fzstd）');
    }
  }

  console.log(fail ? '\n-- RESULT: FAIL (' + fail + ')' : '\n-- RESULT: ALL PASS');
  process.exit(fail ? 1 : 0);
}

// ---------- CLI ----------
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args[0] === '--replay' && args[1]) {
    const w = new DshWatcher({ idleAfterMs: 0 });
    w.on('state', s => console.log(`[${new Date(s.since).toLocaleTimeString()}] → ${s.state.padEnd(10)} ${s.label}  ${s.detail}`));
    console.log('replaying:', args[1], '\n');
    w.currentFile = { path: args[1], compressed: args[1].endsWith('.zstd') };
    w.offset = 0;
    w.backfilling = false; // 回放模式：直接展示全部状态变化
    w.poll();
    console.log('\nfinal state:', w.state, '| lastDetail:', w.lastDetail);
    console.log('\n-- timeline (' + w.timeline.length + ') --');
    for (const t of w.timeline) {
      console.log(`  [${new Date(t.ts).toLocaleTimeString()}] ${t.icon} ${t.text}`);
    }
  } else if (args[0] === '--live') {
    const w = new DshWatcher();
    w.on('state', s => console.log(`[${new Date().toLocaleTimeString()}] ${s.state.padEnd(10)} ${s.label}  ${s.detail}`));
    w.start(); // 先注册再 start：start() 会同步执行首次 poll（backfill 结束会 emit 一次）
    console.log('watching', w.opts.sessionsDir, '… (Ctrl+C to stop)');
    process.on('SIGINT', () => { w.stop(); process.exit(0); });
  } else if (args[0] === '--test') {
    runSelfTest();
  } else {
    console.log('用法: node dsh-watcher.js --live | --replay <session.jsonl.zstd> | --test');
  }
}
