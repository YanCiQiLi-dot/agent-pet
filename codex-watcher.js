// ============================================================
// codex-watcher.js — 检测 Codex 进程生命周期（纯 Node）
// 用法:
//   node codex-watcher.js                 # 检测真实 Codex 进程
//   node codex-watcher.js --probe notepad # 用记事本模拟测试联动逻辑
// ============================================================
'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

class CodexLifecycleWatcher extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.names = opts.names || ['codex'];
    this.pollMs = opts.pollMs || 2000;
    this.debounceTicks = opts.debounceTicks || 2;
    this.present = false;
    this.tickCount = 0;
    this.timer = null;
  }

  start() {
    this.check();
    this.timer = setInterval(() => this.check(), this.pollMs);
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // 手动探测一次当前状态
  // 用 Get-Process（tasklist /FI 在部分受限环境会被拒绝访问）
  detect(cb) {
    const names = this.names.map(n => `'${n}'`).join(',');
    const child = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `@(Get-Process -Name ${names} -ErrorAction SilentlyContinue).Count`
    ], { windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => cb(false));
    child.on('close', () => {
      const n = parseInt(out.trim(), 10);
      cb(Number.isFinite(n) && n > 0);
    });
  }

  // 轮询 + 去抖（连续 debounceTicks 次一致才切换，防进程列表抖动）
  check() {
    this.detect(found => {
      if (found === this.present) {
        this.tickCount = 0;
        return;
      }
      this.tickCount++;
      if (this.tickCount >= this.debounceTicks) {
        this.present = found;
        this.tickCount = 0;
        this.emit(found ? 'started' : 'stopped', { at: Date.now() });
      }
    });
  }
}

module.exports = CodexLifecycleWatcher;

// ---------- CLI ----------
if (require.main === module) {
  const args = process.argv.slice(2);
  const probeIdx = args.indexOf('--probe');
  const names = probeIdx >= 0 && args[probeIdx + 1] ? [args[probeIdx + 1]] : ['codex'];
  const w = new CodexLifecycleWatcher({ names, debounceTicks: 2 });
  console.log(`[watcher] 正在检测进程: ${names.join(', ')} （Ctrl+C 停止）`);
  w.on('started', () => console.log(`[${new Date().toLocaleTimeString()}] → ${names[0]} 已启动`));
  w.on('stopped', () => console.log(`[${new Date().toLocaleTimeString()}] → ${names[0]} 已退出`));
  w.start();
  process.on('SIGINT', () => { w.stop(); process.exit(0); });
}
