// ============================================================
// reminders.js — 提醒管理器（纯 Node，无 Electron 依赖，可独立测试）
// C 方向：待办提醒 + 摸鱼提醒统一由本模块调度
// 用法：
//   node reminders.js --test   # 自测：添加 0.05 分钟提醒并验证触发
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class ReminderManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.file = opts.file || null;       // 持久化文件（JSON），null 则不落盘
    this.checkMs = opts.checkMs || 1000; // 到期检查间隔
    this.reminders = [];
    this.timer = null;
    this.fired = new Set();              // 本次运行已触发的 id（防止重复触发）
  }

  // ---------- 持久化 ----------
  load() {
    if (!this.file) return;
    try {
      const arr = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(arr)) {
        const now = Date.now();
        this.reminders = arr
          .filter(r => r && r.id && r.dueAt > now)   // 丢弃过期/损坏
          .map(r => ({ id: String(r.id), dueAt: +r.dueAt, text: String(r.text || '⏰ 时间到啦！'), kind: r.kind || 'custom', createdAt: +r.createdAt || now }));
      }
    } catch { this.reminders = []; }
    return this;
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.reminders, null, 2));
    } catch {}
  }

  // ---------- 增删查 ----------
  add(minutes, text, kind) {
    const m = Math.max(0.1, Math.min(24 * 60, Number(minutes) || 5));
    return this.addAt(Date.now() + m * 60 * 1000, text, kind || 'custom');
  }

  addAt(dueAt, text, kind) {
    const r = {
      id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      dueAt: +dueAt,
      text: String(text || '⏰ 时间到啦！'),
      kind: kind || 'custom',
      createdAt: Date.now()
    };
    this.reminders.push(r);
    this.save();
    return r;
  }

  remove(id) {
    const before = this.reminders.length;
    this.reminders = this.reminders.filter(r => r.id !== id);
    if (this.reminders.length !== before) this.save();
  }

  list() {
    return this.reminders.slice().sort((a, b) => a.dueAt - b.dueAt);
  }

  clear() {
    if (!this.reminders.length) return;
    this.reminders = [];
    this.save();
  }

  // ---------- 调度 ----------
  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => this.check(), this.checkMs);
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  check() {
    const now = Date.now();
    const due = this.reminders.filter(r => r.dueAt <= now);
    for (const r of due) {
      if (this.fired.has(r.id)) continue;
      this.fired.add(r.id);
      this.reminders = this.reminders.filter(x => x.id !== r.id);
      this.save();
      this.emit('fire', r);
    }
  }
}

module.exports = ReminderManager;

// ---------- CLI 自测 ----------
if (require.main === module && process.argv.includes('--test')) {
  const mgr = new ReminderManager({ file: path.join(require('os').tmpdir(), 'reminders-test.json'), checkMs: 200 });
  mgr.load();
  let fired = 0;
  mgr.on('fire', r => {
    fired++;
    console.log(`[OK] fired: ${r.text} (kind=${r.kind}, id=${r.id})`);
    if (fired >= 2) {
      mgr.stop();
      console.log('[PASS] reminders self-test passed');
      process.exit(0);
    }
  });
  mgr.start();
  mgr.add(0.05, '测试提醒 A');
  mgr.add(0.08, '测试提醒 B');
  setTimeout(() => {
    console.error('[FAIL] 提醒未触发');
    process.exit(1);
  }, 8000);
}
