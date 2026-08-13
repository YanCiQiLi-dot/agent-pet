// ============================================================
// launcher.js — 可选守护进程：让桌宠进程严格跟随 Codex 生灭
// （配合 config.followMode = "quit" 使用；默认 hide 模式不需要它）
// 用法: node launcher.js   （保持常驻运行）
// ============================================================
'use strict';

const { spawn, execFile } = require('child_process');
const path = require('path');

const ELECTRON = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
const NAMES = ['codex', 'opencode', 'claude'];
let petProc = null;

function codexRunning(cb) {
  const names = NAMES.map(n => `'${n}'`).join(',');
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', `@(Get-Process -Name ${names} -ErrorAction SilentlyContinue).Count`], { windowsHide: true }, (err, stdout) => {
    if (err) return cb(false);
    const n = parseInt((stdout || '').trim(), 10);
    cb(Number.isFinite(n) && n > 0);
  });
}

function startPet() {
  if (petProc) return;
  console.log(`[launcher] ${new Date().toLocaleTimeString()} Codex 已启动 → 拉起桌宠`);
  petProc = spawn(ELECTRON, ['.'], { cwd: __dirname, windowsHide: false, stdio: 'ignore' });
  petProc.on('exit', () => { petProc = null; });
}

function stopPet() {
  if (!petProc) return;
  console.log(`[launcher] ${new Date().toLocaleTimeString()} Codex 已退出 → 结束桌宠`);
  petProc.kill();
  petProc = null;
}

console.log('[launcher] 守护已启动，等待 Codex…');
setInterval(() => {
  codexRunning(up => {
    if (up) startPet();
    else stopPet();
  });
}, 3000);
