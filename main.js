// ============================================================
// main.js — Electron 主进程
// 透明置顶桌宠 + 日志状态机 + Codex 生命周期联动 + 托盘 + 配置
// ============================================================
'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const CodexStateWatcher = require('./state-watcher');
const OpenCodeWatcher = require('./opencode-watcher');
const CodexLifecycleWatcher = require('./codex-watcher');
const ReminderManager = require('./reminders');
const SourceRouter = require('./source-router');

const BASE_W = 220;
const BASE_H = 310;
const MAX_LOG_BYTES = 2 * 1024 * 1024;   // 桌宠日志超过 2MB 时轮转（保留 .1）

const DEFAULT_CONFIG = {
  followMode: 'hide',
  startHidden: false,        // true: start hidden, only show when Codex process detected
  detectNames: ['codex', 'Codex'],
  pollMs: 2000,
  debounceTicks: 2,
  hideDelayMs: 5000,
  showStatusLabel: true,
  sound: true,
  scale: 1.0,
  theme: 'default',
  notify: true,            // 提醒到点是否发系统通知
  breakReminderMin: 45,    // 摸鱼提醒间隔（分钟），0 = 关闭
  breakReminderText: '🚶 起来活动一下，喝口水吧～'   // 摸鱼提醒文案（可自定义）
};

const configPath = () => path.join(__dirname, 'config.json');
function loadConfig() {
  try {
    // 去掉可能的 UTF-8 BOM（Notepad/PowerShell 保存常带），否则 JSON.parse 会失败
    const u = JSON.parse(fs.readFileSync(configPath(), 'utf8').replace(/^\uFEFF/, ''));
    return Object.assign({}, DEFAULT_CONFIG, u);
  } catch { return DEFAULT_CONFIG; }
}

let config = loadConfig();

// ---------- 配置热更新：监听 config.json，变更后动态生效（无需重启） ----------
let configWatcher = null;
let configReloadTimer = null;

function pushConfigToRenderer() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:config', {
      scale: config.scale,
      theme: config.theme,
      sound: config.sound,
      showStatusLabel: config.showStatusLabel
    });
  }
}

function applyConfigToRuntime(prev, next) {
  if (!next) return;
  // 进程检测参数（detectNames / pollMs / debounceTicks）
  if (lifeWatcher) {
    lifeWatcher.update({
      names: next.detectNames,
      pollMs: next.pollMs,
      debounceTicks: next.debounceTicks
    });
  }
  // 双源路由固定源（activeSource）
  if (router) router.setFixed(next.activeSource || 'auto');
  // 摸鱼提醒间隔（0 = 关闭）
  if (next.breakReminderMin !== prev.breakReminderMin) scheduleBreak();
  // 窗口缩放：保持左上角位置不变，更新窗口尺寸
  if (win && !win.isDestroyed() && next.scale && next.scale !== prev.scale) {
    const W = Math.round(BASE_W * next.scale);
    const H = Math.round(BASE_H * next.scale);
    const [x, y] = win.getPosition();
    win.setBounds({ x, y, width: W, height: H });
  }
  // 渲染层配置（皮肤 / 音效 / 状态标签 / 缩放）
  pushConfigToRenderer();
}

function watchConfig() {
  try {
    configWatcher = fs.watch(configPath(), () => {
      clearTimeout(configReloadTimer);
      configReloadTimer = setTimeout(() => {
        const prev = config;
        config = loadConfig();
        log('[config] hot-reloaded theme=' + config.theme +
            ' sound=' + config.sound + ' scale=' + config.scale +
            ' activeSource=' + config.activeSource +
            ' breakReminderMin=' + config.breakReminderMin);
        applyConfigToRuntime(prev, config);
      }, 300);
    });
  } catch (e) {
    log('[config] watch failed: ' + (e && e.message));
  }
}
let win = null;
let stateWatcher = null;
let openCodeWatcher = null;
let lifeWatcher = null;
let reminders = null;
let tray = null;
let manualState = null;
let router = null;                             // 双源 LRU 路由（Codex / OpenCode）

// ---------- 日志：写文件，绝不污染用户终端 ----------
function log(...args) {
  try {
    const p = path.join(app.getPath('userData'), 'codex-pet.log');
    // 日志轮转：超过 MAX_LOG_BYTES 后把旧文件改名 .1（覆盖更早的），避免无限膨胀
    try {
      const st = fs.statSync(p);
      if (st.size > MAX_LOG_BYTES) {
        const old = p + '.1';
        if (fs.existsSync(old)) fs.unlinkSync(old);
        fs.renameSync(p, old);
      }
    } catch {}
    fs.appendFileSync(p, `[${new Date().toISOString()}] ${args.join(' ')}\n`);
  } catch {}
  if (process.env.CODEX_PET_DEBUG) console.log(...args);
}

// ---------- 窗口位置记忆（默认贴右下角，不挡输入框） ----------
function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  const b = screen.getPrimaryDisplay().workArea;
  const W = Math.round(BASE_W * config.scale);
  const H = Math.round(BASE_H * config.scale);
  try {
    const d = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (typeof d.x === 'number' && typeof d.y === 'number') {
      return {
        x: Math.min(Math.max(d.x, b.x), b.x + b.width - W + 40),
        y: Math.min(Math.max(d.y, b.y), b.y + b.height - H + 40)
      };
    }
  } catch {}
  // 默认：屏幕右下角（桌宠惯例，避开输入区）
  return { x: b.x + b.width - W - 24, y: b.y + b.height - H - 24 };
}

let saveTimer = null;
function saveWindowState() {
  if (!win) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const [x, y] = win.getPosition();
      fs.writeFileSync(stateFile(), JSON.stringify({ x, y }));
    } catch {}
  }, 400);
}

// ---------- 状态推送 ----------
function sendState(st) {
  // 来源标记：🅒 Codex / 🅞 OpenCode / 无前缀 = 手动
  const tag = st.source === 'opencode' ? '🅞' : (st.source === 'codex' ? '🅒' : '');
  const payload = Object.assign({}, st);
  if (tag) payload.detail = tag + ' ' + (payload.detail || payload.label || '');
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:state', payload);
  }
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.webContents.send('pet:state', payload);
  }
}

function setManual(s) {
  manualState = s;
  if (s === null) {
    if (stateWatcher) stateWatcher.forceRefresh();
    if (openCodeWatcher) openCodeWatcher.forceRefresh();
  } else {
    const meta = CodexStateWatcher.STATE_META[s] || { label: s, bubble: '' };
    sendState({ state: s, label: meta.label, bubble: meta.bubble, detail: '手动预览', since: Date.now(), manual: true });
  }
}

// ---------- 窗口 ----------
function createWindow() {
  const W = Math.round(BASE_W * config.scale);
  const H = Math.round(BASE_H * config.scale);
  const pos = loadWindowState();

  win = new BrowserWindow({
    width: W,
    height: H,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // 置顶但不抢焦点：用 showInactive 显示，避免干扰用户正在输入的窗口
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!win || win.isDestroyed()) return;
    // startHidden mode: keep hidden at launch, show only after Codex is detected
    if (config.startHidden && !(lifeWatcher && lifeWatcher.present)) return;
    win.showInactive();
  });

  win.on('moved', saveWindowState);
  win.on('close', saveWindowState);
  win.on('closed', () => { win = null; });
}

function toggleWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isVisible()) win.hide();
  else win.showInactive();
}

// ---------- 独立详情面板窗口（可缩放/拖动，不与桌宠抢空间） ----------
let panelWin = null;

function panelStateFile() {
  return path.join(app.getPath('userData'), 'panel-state.json');
}

function loadPanelState() {
  try { return JSON.parse(fs.readFileSync(panelStateFile(), 'utf8')); } catch { return null; }
}

function savePanelState() {
  if (!panelWin || panelWin.isDestroyed()) return;
  try {
    const b = panelWin.getBounds();
    fs.writeFileSync(panelStateFile(), JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height }));
  } catch {}
}

function createPanelWindow() {
  if (panelWin && !panelWin.isDestroyed()) return;
  const st = loadPanelState();
  const W = (st && st.width >= 300) ? st.width : 380;
  const H = (st && st.height >= 340) ? st.height : 460;
  let x = (st && typeof st.x === 'number') ? st.x : null;
  let y = (st && typeof st.y === 'number') ? st.y : null;
  if (x == null || y == null) {
    // 默认放在桌宠左侧（空间不足则右侧）
    const wa = screen.getPrimaryDisplay().workArea;
    const b = (win && !win.isDestroyed())
      ? win.getBounds()
      : { x: wa.x + wa.width - BASE_W, y: wa.y + wa.height - BASE_H };
    if (b.x - W - 12 >= wa.x) { x = b.x - W - 12; y = b.y; }
    else { x = b.x + b.width + 12; y = b.y; }
  }
  panelWin = new BrowserWindow({
    width: W, height: H, x, y,
    minWidth: 300, minHeight: 340,
    resizable: true,
    title: '🪼 Codex 桌宠面板',
    show: false,
    backgroundColor: '#0a1c3d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  panelWin.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { panel: '1' } });
  panelWin.once('ready-to-show', () => { if (panelWin && !panelWin.isDestroyed()) panelWin.show(); });
  panelWin.on('moved', savePanelState);
  panelWin.on('resized', savePanelState);
  panelWin.on('close', (e) => {
    // 点 × 只隐藏（保留位置/数据），真正退出时销毁
    if (!panelWin._quitting) {
      e.preventDefault();
      panelWin.hide();
    }
  });
  panelWin.on('closed', () => { panelWin = null; });
}

function showPanelWindow() {
  createPanelWindow();
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.show();
    panelWin.focus();
  }
}

function hidePanelWindow() {
  if (panelWin && !panelWin.isDestroyed()) panelWin.hide();
}

// ---------- 菜单（窗口右键 + 托盘共用） ----------
function buildStateSubmenu() {
  return [
    { label: '🛋️ 空闲',     click: () => setManual('idle') },
    { label: '👂 收到指令', click: () => setManual('listening') },
    { label: '🧠 分析中',   click: () => setManual('thinking') },
    { label: '💻 写代码中', click: () => setManual('coding') },
    { label: '⏳ 运行中',   click: () => setManual('running') },
    { label: '🔍 搜索中',   click: () => setManual('searching') },
    { label: '✅ 完成',     click: () => setManual('done') },
    { label: '⚠️ 等待审批', click: () => setManual('approval') },
    { label: '💤 沉睡',     click: () => setManual('sleep') },
    { type: 'separator' },
    { label: '↺ 回到自动联动', click: () => setManual(null) }
  ];
}

// ---------- 提醒（C 方向） ----------
function buildReminderSubmenu() {
  return [
    { label: '💧 喝水（30 分钟后）', click: () => quickRemind(30, '喝口水吧～ 补充水分 💧') },
    { label: '🚶 走一走（45 分钟后）', click: () => quickRemind(45, '起来走一走，活动一下筋骨 🚶') },
    { label: '✍️ 自定义内容…', click: askCustomReminder },
    { type: 'separator' },
    { label: '⏱ 5 分钟后', click: () => quickRemind(5) },
    { label: '⏱ 15 分钟后', click: () => quickRemind(15) },
    { label: '⏱ 30 分钟后', click: () => quickRemind(30) },
    { label: '⏱ 1 小时后',  click: () => quickRemind(60) },
    { type: 'separator' },
    { label: '📋 查看 / 管理提醒', click: openReminderPanel },
    { label: '🗑 清空全部提醒', click: () => { reminders.clear(); toast('已清空全部提醒'); } }
  ];
}

// ---------- 主题切换（右键 / 托盘菜单：写入 config.json 持久化 + 立即生效） ----------
function setThemeConfig(theme) {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8').replace(/^\uFEFF/, '');
    const obj = JSON.parse(raw);
    obj.theme = theme;
    fs.writeFileSync(configPath(), JSON.stringify(obj, null, 2) + '\n');
    // 立即生效（config.json 的 fs.watch 会再兜底一次，无副作用）
    const prev = config;
    config = loadConfig();
    applyConfigToRuntime(prev, config);
    log('[theme] set ' + theme);
  } catch (err) {
    log('[theme] set failed: ' + (err && err.message));
  }
}

function buildThemeSubmenu() {
  const cur = config.theme || 'default';
  return [
    { label: '🪻 默认（蓝紫）', type: 'radio', checked: cur === 'default', click: () => setThemeConfig('default') },
    { label: '🌸 樱花粉', type: 'radio', checked: cur === 'sakura', click: () => setThemeConfig('sakura') },
    { label: '🌊 海洋蓝', type: 'radio', checked: cur === 'ocean', click: () => setThemeConfig('ocean') }
  ];
}

function quickRemind(min, text) {
  const r = reminders.add(min, text || `⏰ ${min} 分钟到啦，回来看看～`);
  log(`[reminder] set ${min}min #${r.id}`);
  toast(`已设置 ${min} 分钟提醒 ⏰`);
}

function askCustomReminder() {
  ensureVisible();
  showPanelWindow();
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('pet:askreminder');
}

function openReminderPanel() {
  ensureVisible();
  showPanelWindow();
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('pet:openpanel');
}

function ensureVisible() {
  if (win && !win.isDestroyed() && !win.isVisible()) win.showInactive();
}

function toast(text, seconds) {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) win.showInactive();
  win.webContents.send('pet:reminder-toast', { text: text || '', seconds: seconds || 1.8 });
}

function onReminderFire(r) {
  log(`[reminder] fire: ${r.text}`);
  const payload = { id: r.id, text: r.text, kind: r.kind };
  if (win && !win.isDestroyed()) {
    if (!win.isVisible()) win.showInactive();
    win.webContents.send('pet:reminder', payload);
  }
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.webContents.send('pet:reminder', payload);
  }
  if (config.notify !== false && Notification.isSupported()) {
    try {
      new Notification({ title: '🪼 桌宠提醒', body: r.text, silent: true }).show();
    } catch {}
  }
}

// 摸鱼提醒：递归续期（避免长 interval 漂移），0 = 关闭
function scheduleBreak() {
  clearTimeout(scheduleBreak._t);
  const min = config.breakReminderMin || 0;
  if (min <= 0) return;
  scheduleBreak._t = setTimeout(() => {
    onReminderFire({ id: 'break', text: config.breakReminderText || '🚶 起来活动一下，喝口水吧～', kind: 'break' });
    scheduleBreak();
  }, min * 60 * 1000);
}

// ---------- 托盘（P1） ----------
function trayIcon() {
  const p = path.join(__dirname, 'assets', 'tray.png');
  if (fs.existsSync(p)) return nativeImage.createFromPath(p);
  return nativeImage.createEmpty();
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Codex 像素水母');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '🪼 Codex 像素水母', enabled: false },
    { type: 'separator' },
    { label: '👁 显示 / 隐藏', click: toggleWindow },
    { label: '🎯 手动切换状态', submenu: buildStateSubmenu() },
    { label: '⏰ 提醒', submenu: buildReminderSubmenu() },
    { label: '🎨 外观主题', submenu: buildThemeSubmenu() },
    { type: 'separator' },
    { label: '🔄 重新加载', click: () => win && win.reload() },
    { label: '👋 退出桌宠', click: () => app.quit() }
  ]));
  tray.on('double-click', toggleWindow);
}

// ---------- Codex 生命周期联动（P0） ----------
function onCodexStarted() {
  log('[life] agent detected (codex/opencode)');
  if (!win || win.isDestroyed()) createWindow();
  else if (!win.isVisible()) win.showInactive();
}

function onCodexStopped() {
  log('[life] all agents stopped, followMode=' + config.followMode);
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    if (config.followMode === 'quit') {
      app.quit();
      return;
    }
    win.hide();
    hidePanelWindow();
  }, config.hideDelayMs);
}

// ---------- IPC ----------
ipcMain.handle('pet:getpos', () => (win ? win.getPosition() : [0, 0]));
ipcMain.on('pet:move', (e, { x, y }) => {
  if (win) win.setPosition(Math.round(x), Math.round(y));
});
ipcMain.on('pet:set-ignore-mouse', (e, { ignore }) => {
  // 透明区域点击穿透：true = 整窗穿透（forward 保留 mousemove 供悬停检测），false = 正常接收
  if (!win || win.isDestroyed()) return;
  if (ignore) win.setIgnoreMouseEvents(true, { forward: true });
  else win.setIgnoreMouseEvents(false);
});
ipcMain.handle('pet:getconfig', () => ({
  scale: config.scale,
  theme: config.theme,
  sound: config.sound,
  showStatusLabel: config.showStatusLabel
}));
ipcMain.handle('pet:timeline', () => {
  const w = router && router.getActive() === 'opencode' ? openCodeWatcher : stateWatcher;
  return w ? w.getTimeline() : [];
});
ipcMain.handle('pet:remind-add', (e, { minutes, text }) => {
  const m = Math.max(1, Math.min(24 * 60, parseInt(minutes, 10) || 5));
  const r = reminders.add(m, String(text || '⏰ 时间到啦！'));
  log(`[reminder] add #${r.id} ${m}min: ${r.text}`);
  return r;
});
ipcMain.handle('pet:remind-list', () => reminders.list());
ipcMain.handle('pet:remind-cancel', (e, id) => {
  reminders.remove(String(id));
  return true;
});
ipcMain.handle('pet:remind-clear', () => {
  reminders.clear();
  return true;
});
ipcMain.on('pet:contextmenu', (e, info) => {
  if (!win) return;
  const cur = (info && info.label) || '';
  const menu = Menu.buildFromTemplate([
    { label: `🪼 当前：${cur}`, enabled: false },
    { type: 'separator' },
    { label: '🎯 手动切换状态', submenu: buildStateSubmenu() },
    { label: '⏰ 提醒', submenu: buildReminderSubmenu() },
    { label: '🎨 外观主题', submenu: buildThemeSubmenu() },
    { type: 'separator' },
    { label: '🔄 重新加载', click: () => win && win.reload() },
    { label: '👋 退出桌宠', click: () => app.quit() }
  ]);
  menu.popup({ window: win });
});
ipcMain.on('pet:set-theme', (e, theme) => {
  if (theme === 'default' || theme === 'sakura' || theme === 'ocean') setThemeConfig(theme);
});
ipcMain.on('pet:panel-set', (e, open) => {
  if (open) showPanelWindow();
  else hidePanelWindow();
});

// ---------- 启动 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.showInactive(); }
  });

  // 允许 Web Audio 无需用户手势直接播放（音效）
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

  app.whenReady().then(() => {
    createWindow();
    createTray();
    watchConfig();

    // 提醒（C 方向）：加载持久化提醒 + 摸鱼提醒
    reminders = new ReminderManager({
      file: path.join(app.getPath('userData'), 'reminders.json')
    });
    reminders.load();
    reminders.on('fire', onReminderFire);
    reminders.start();
    scheduleBreak();

    // 双源路由（LRU 最后活跃者优先；config.activeSource 可固定）
    router = new SourceRouter({
      fixed: config.activeSource || 'auto',
      defaultSource: 'codex'
    });
    router.on('change', (st) => {
      if (manualState === null) sendState(st);
    });

    // 日志状态机（Phase 1）：Codex 通道
    stateWatcher = new CodexStateWatcher({
      sessionsDir: path.join(os.homedir(), '.codex', 'sessions')
    });
    stateWatcher.on('state', (st) => {
      log(`[state] ${st.state} — ${st.label} (${st.detail})`);
      router.push('codex', st);
    });
    stateWatcher.start();

    // OpenCode 通道（并行监听，互不干扰）
    openCodeWatcher = new OpenCodeWatcher();
    openCodeWatcher.on('state', (st) => {
      log(`[state:opencode] ${st.state} — ${st.label} (${st.detail})`);
      router.push('opencode', st);
    });
    openCodeWatcher.start();

    // 进程生命周期（P0）
    lifeWatcher = new CodexLifecycleWatcher({
      names: config.detectNames,
      pollMs: config.pollMs,
      debounceTicks: config.debounceTicks
    });
    lifeWatcher.on('started', onCodexStarted);
    lifeWatcher.on('stopped', onCodexStopped);
    lifeWatcher.start();

    // 冒烟测试：启动 6s 后退出
    if (process.argv.includes('--smoke')) {
      setTimeout(() => {
        log('SMOKE OK');
        console.log('SMOKE OK');
        app.quit();
      }, 6000);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    if (panelWin && !panelWin.isDestroyed()) {
      panelWin._quitting = true;
      panelWin.destroy();
    }
  });
}
