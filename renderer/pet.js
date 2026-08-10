// ============================================================
// pet.js — 桌宠渲染层：Electron 联动 / 浏览器调试 / 画廊
// ============================================================
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var IS_ELECTRON = typeof window.petAPI !== 'undefined';
  var currentState = 'idle';
  var currentInfo = null;
  var prevState = null;
  var soundOn = true;
  var timeline = [];       // 最近活动时间线（B）
  var reminders = [];      // 待办提醒（C）
  var panelOpen = false;   // 详情面板是否打开
  var panelHooks = null;   // Electron 分支注册的面板刷新函数（避免作用域问题）

  if (IS_ELECTRON) document.body.classList.add('electron');
  else document.body.classList.add('browser');

  // ---------- 气泡 ----------
  function showBubble(text, holdMs) {
    var bubble = document.getElementById('bubble');
    if (!bubble) return;
    bubble.textContent = text;
    bubble.classList.add('show');
    clearTimeout(showBubble._t);
    showBubble._t = setTimeout(function () { bubble.classList.remove('show'); }, holdMs || 2400);
  }

  // ---------- Web Audio 合成音效（P2，零素材） ----------
  var AC = null;
  function ensureAudio() {
    if (!AC) {
      try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { AC = null; }
    }
    if (AC && AC.state === 'suspended') AC.resume();
  }
  function tone(freq, dur, type, vol, delay) {
    if (!soundOn || !AC) return;
    var t0 = AC.currentTime + (delay || 0);
    var o = AC.createOscillator();
    var g = AC.createGain();
    o.type = type || 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.08, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(AC.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  var SOUNDS = {
    listening: function () { tone(660, .12, 'triangle', .06); tone(880, .16, 'triangle', .06, .09); },
    thinking:  function () { tone(440, .25, 'sine', .05); tone(330, .30, 'sine', .04, .12); },
    coding:    function () { tone(700, .05, 'square', .03); tone(520, .06, 'square', .03, .07); tone(840, .05, 'square', .03, .14); },
    running:   function () { tone(300, .40, 'sawtooth', .03); },
    searching: function () { tone(880, .10, 'sine', .05); tone(1100, .12, 'sine', .04, .10); },
    done:      function () { tone(523, .12, 'triangle', .07); tone(659, .12, 'triangle', .07, .10); tone(784, .20, 'triangle', .07, .20); },
    approval:  function () { tone(392, .30, 'sine', .05); tone(349, .40, 'sine', .05, .20); },
    sleep:     function () { tone(200, .50, 'sine', .03); }
  };
  function playSound(state) {
    if (!soundOn) return;
    ensureAudio();
    var f = SOUNDS[state];
    if (f) f();
  }

  // ---------- 状态应用 ----------
  function applyState(st) {
    if (!st || !Jellyfish.STATES[st.state]) return;
    if (st.state !== prevState) {
      prevState = st.state;
      if (st.bubble && !st.manual) showBubble(st.bubble);
      playSound(st.state);
    }
    currentState = st.state;
    currentInfo = st;
    if (st.timeline) timeline = st.timeline;
    var el = document.getElementById('statusText');
    if (el) el.textContent = st.label || Jellyfish.STATES[st.state].label;
    // B 方向：动态详情行（工作状态显示“正在干什么”，空闲/沉睡隐藏）
    var dl = document.getElementById('detailLine');
    if (dl) {
      if (st.detail && st.state !== 'idle' && st.state !== 'sleep') {
        dl.textContent = st.detail;
        dl.hidden = false;
      } else {
        dl.textContent = '';
        dl.hidden = true;
      }
    }
    // 面板打开时同步刷新
    if (panelOpen && IS_ELECTRON) {
      if (panelHooks) {
        panelHooks.renderPanelHeader();
        panelHooks.renderTimeline();
      }
    }
  }

  // ---------- Electron 联动 ----------
  if (IS_ELECTRON) {
    var shell = document.getElementById('petShell');
    var canvas = document.getElementById('pet');
    var statusEl = document.getElementById('status');

    // 应用配置（皮肤 / 音效 / 状态标签 / 缩放）
    window.petAPI.getConfig().then(function (cfg) {
      if (!cfg) return;
      soundOn = cfg.sound !== false;
      if (cfg.theme) Jellyfish.setTheme(cfg.theme);
      if (cfg.showStatusLabel === false && statusEl) statusEl.classList.add('hidden');
      if (cfg.scale && cfg.scale !== 1) {
        canvas.style.width = Math.round(192 * cfg.scale) + 'px';
        canvas.style.height = Math.round(240 * cfg.scale) + 'px';
        shell.style.width = Math.round(220 * cfg.scale) + 'px';
        shell.style.height = Math.round(310 * cfg.scale) + 'px';
      }
    });

    window.petAPI.onState(applyState);

    // 拖动窗口
    var dragging = false, startX = 0, startY = 0, winPos = null, moved = 0;
    canvas.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      dragging = true; moved = 0;
      startX = e.screenX; startY = e.screenY;
      window.petAPI.getPos().then(function (p) { winPos = p; });
      shell.classList.add('dragging');
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging || !winPos) return;
      var dx = e.screenX - startX, dy = e.screenY - startY;
      moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
      window.petAPI.moveTo(winPos[0] + dx, winPos[1] + dy);
    });
    window.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      shell.classList.remove('dragging');
      if (moved < 6) showBubble('戳我干嘛！(◍•ᴗ•◍)');
    });

    // 双击：打开详情面板（状态 + 时间线 + 提醒）
    canvas.addEventListener('dblclick', openPanel);

    // 右键菜单
    document.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      window.petAPI.showMenu({
        label: (currentInfo && currentInfo.label) || Jellyfish.STATES[currentState].label
      });
    });

    // ---------- 透明区域点击穿透（只在水母本体/详情面板上接收鼠标） ----------
    // 窗口是 220x310 的透明矩形，但可见内容只有画布与标签；不处理的话，
    // 整块矩形（尤其画布下方）都会在系统层拦截下层窗口的点击。
    var lastMouse = { x: -1, y: -1 };
    function syncMouseIgnore() {
      var el = document.elementFromPoint(lastMouse.x, lastMouse.y);
      var interactive = !!el && (el.id === 'pet' || el.closest('#panel') || dragging);
      window.petAPI.setIgnoreMouseEvents(!interactive);
    }
    document.addEventListener('mousemove', function (e) {
      lastMouse.x = e.clientX; lastMouse.y = e.clientY;
      syncMouseIgnore();
    });
    document.addEventListener('mouseleave', function () {
      lastMouse.x = -1; lastMouse.y = -1;
      window.petAPI.setIgnoreMouseEvents(true);
    });
    // 启动即穿透；悬停到画布/面板时由上面的 mousemove 自动开启（forward 会持续转发 mousemove）
    window.petAPI.setIgnoreMouseEvents(true);

    // ---------- 详情面板（B：时间线 + C：提醒） ----------
    var panel = document.getElementById('panel');

    function fmtClock(ts) {
      var d = new Date(ts);
      function p(n) { return n < 10 ? '0' + n : '' + n; }
      return p(d.getHours()) + ':' + p(d.getMinutes());
    }

    function openPanel() {
      if (!panel) return;
      panelOpen = true;
      panel.hidden = false;
      renderPanelHeader();
      renderTimeline();
      renderReminders();
    }

    function closePanel() {
      panelOpen = false;
      if (panel) panel.hidden = true;
    }

    function renderPanelHeader() {
      var ps = document.getElementById('panelState');
      var pd = document.getElementById('panelDetail');
      if (ps) ps.textContent = (currentInfo && currentInfo.label) || Jellyfish.STATES[currentState].label;
      if (pd) pd.textContent = (currentInfo && currentInfo.detail) || '';
    }

    function renderTimeline() {
      var ul = document.getElementById('timelineList');
      if (!ul) return;
      ul.innerHTML = '';
      var items = timeline.slice().reverse(); // 最新在上
      if (!items.length) {
        var empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = '暂无活动记录';
        ul.appendChild(empty);
        return;
      }
      for (var i = 0; i < items.length; i++) {
        var li = document.createElement('li');
        var ic = document.createElement('span'); ic.className = 'tl-icon'; ic.textContent = items[i].icon;
        var tx = document.createElement('span'); tx.className = 'tl-text'; tx.textContent = items[i].text;
        var tm = document.createElement('span'); tm.className = 'tl-time'; tm.textContent = fmtClock(items[i].ts);
        li.appendChild(ic); li.appendChild(tx); li.appendChild(tm);
        ul.appendChild(li);
      }
    }

    function renderReminders() {
      var ul = document.getElementById('reminderList');
      if (!ul) return;
      ul.innerHTML = '';
      if (!reminders.length) {
        var empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = '暂无提醒（下方按钮添加）';
        ul.appendChild(empty);
        return;
      }
      for (var i = 0; i < reminders.length; i++) {
        (function (r) {
          var li = document.createElement('li');
          var tx = document.createElement('span'); tx.className = 'tl-text'; tx.textContent = r.text;
          var tm = document.createElement('span'); tm.className = 'tl-time';
          tm.textContent = '剩 ' + Math.max(1, Math.round((r.dueAt - Date.now()) / 60000)) + ' 分';
          var x = document.createElement('button'); x.className = 'rm-x'; x.textContent = '×';
          x.title = '取消此提醒';
          x.addEventListener('click', function () {
            window.petAPI.cancelReminder(r.id).then(function () { refreshReminders(); });
          });
          li.appendChild(tx); li.appendChild(tm); li.appendChild(x);
          ul.appendChild(li);
        })(reminders[i]);
      }
    }

    // 注册面板刷新钩子（供顶层 applyState 使用）
    panelHooks = {
      renderPanelHeader: renderPanelHeader,
      renderTimeline: renderTimeline,
      renderReminders: renderReminders
    };

    function refreshTimeline() {
      window.petAPI.getTimeline().then(function (ts) {
        timeline = ts || [];
        if (panelOpen) renderTimeline();
      });
    }

    function refreshReminders() {
      window.petAPI.listReminders().then(function (rs) {
        reminders = rs || [];
        if (panelOpen) renderReminders();
      });
    }

    function addCustom() {
      var m = parseInt(customMin.value, 10);
      if (!m || m < 1 || m > 1440) { showBubble('请输入 1~1440 的分钟数'); customMin.focus(); return; }
      window.petAPI.addReminder(m, '⏰ ' + m + ' 分钟到啦，回来看看～').then(function () {
        customMin.value = '';
        refreshReminders();
        showBubble('已设置 ' + m + ' 分钟提醒 ⏰');
      });
    }

    // 面板交互绑定
    var panelClose = document.getElementById('panelClose');
    if (panelClose) panelClose.addEventListener('click', closePanel);

    var qBtns = document.querySelectorAll('.panel-foot .q');
    for (var qi = 0; qi < qBtns.length; qi++) {
      (function (b) {
        b.addEventListener('click', function () {
          var m = parseInt(b.getAttribute('data-min'), 10) || 5;
          window.petAPI.addReminder(m, '⏰ ' + m + ' 分钟到啦，回来看看～').then(function () {
            refreshReminders();
            showBubble('已设置 ' + m + ' 分钟提醒 ⏰');
          });
        });
      })(qBtns[qi]);
    }

    var btnAddCustom = document.getElementById('btnAddCustom');
    var customMin = document.getElementById('customMin');
    if (btnAddCustom) btnAddCustom.addEventListener('click', addCustom);
    if (customMin) customMin.addEventListener('keydown', function (e) { if (e.key === 'Enter') addCustom(); });

    var btnClearReminders = document.getElementById('btnClearReminders');
    if (btnClearReminders) btnClearReminders.addEventListener('click', function () {
      window.petAPI.clearReminders().then(function () {
        refreshReminders();
        showBubble('已清空全部提醒');
      });
    });

    // 提醒事件：到点弹跳 + 气泡 + 音效
    window.petAPI.onReminder(function (r) {
      showBubble('⏰ ' + r.text, 6000);
      playSound('done');
      var sh = document.getElementById('petShell');
      if (sh) {
        sh.classList.remove('bounce');
        void sh.offsetWidth;   // 强制重排，重新触发动画
        sh.classList.add('bounce');
      }
      refreshReminders();
    });

    window.petAPI.onReminderToast(function (t) {
      showBubble(t.text, (t.seconds || 1.8) * 1000);
    });

    window.petAPI.onAskReminder(function () {
      openPanel();
      if (customMin) customMin.focus();
    });

    window.petAPI.onOpenPanel(openPanel);

    // 启动时拉一次时间线/提醒（面板状态由事件流持续更新）
    refreshTimeline();
    refreshReminders();

    // 动画循环
    var t0 = performance.now();
    (function frame(now) {
      Jellyfish.draw(canvas.getContext('2d'), currentState, (now - t0) / 1000);
      requestAnimationFrame(frame);
    })(t0);
    return;
  }

  // ---------- 浏览器调试模式 ----------
  var devPanel = document.getElementById('devPanel');
  var devCanvas = document.getElementById('pet');
  var devCtx = devCanvas.getContext('2d');
  var buttonsBox = document.getElementById('buttons');
  devPanel.hidden = false;

  var names = Object.keys(Jellyfish.STATES);
  for (var i = 0; i < names.length; i++) {
    (function (n) {
      var b = document.createElement('button');
      b.textContent = Jellyfish.STATES[n].label;
      b.setAttribute('data-state', n);
      b.addEventListener('click', function () {
        setDevState(n);
        markActive(b);
      });
      buttonsBox.appendChild(b);
    })(names[i]);
  }
  var demoBtn = document.createElement('button');
  demoBtn.className = 'demo';
  demoBtn.textContent = '▶ 自动演示';
  buttonsBox.appendChild(demoBtn);

  var demoOn = false, demoIdx = 0, demoTimer = null;
  demoBtn.addEventListener('click', function () {
    demoOn = !demoOn;
    demoBtn.textContent = demoOn ? '⏹ 停止演示' : '▶ 自动演示';
    if (demoOn) { demoIdx = 0; advance(); }
    else if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
  });
  function advance() {
    if (!demoOn) return;
    var n = names[demoIdx % names.length];
    demoIdx++;
    setDevState(n);
    var btn = buttonsBox.querySelector('[data-state="' + n + '"]');
    if (btn) markActive(btn);
    demoTimer = setTimeout(advance, 2600);
  }
  function setDevState(n) {
    currentState = n;
    prevState = n;
    document.getElementById('statusText').textContent = Jellyfish.STATES[n].label;
    showBubble(Jellyfish.STATES[n].bubble);
  }
  function markActive(btn) {
    var all = buttonsBox.querySelectorAll('button');
    for (var j = 0; j < all.length; j++) all[j].classList.remove('active');
    btn.classList.add('active');
  }

  devCanvas.addEventListener('click', function () { showBubble('戳我干嘛！(◍•ᴗ•◍)'); });
  setDevState('idle');

  var t0b = performance.now();
  (function frame(now) {
    Jellyfish.draw(devCtx, currentState, (now - t0b) / 1000);
    requestAnimationFrame(frame);
  })(t0b);

  // ---------- 画廊模式（两种模式通用） ----------
  if (params.get('gallery') !== null) {
    var single = document.getElementById('petShell');
    var wrap = document.getElementById('galleryWrap');
    var hint = document.getElementById('galleryHint');
    if (single) single.hidden = true;
    if (devPanel) devPanel.hidden = true;
    if (hint) hint.hidden = false;
    if (wrap) {
      var cells = [];
      for (var k = 0; k < names.length; k++) {
        var cell = document.createElement('div');
        cell.className = 'gcell';
        var label = document.createElement('div');
        label.className = 'glabel';
        label.textContent = Jellyfish.STATES[names[k]].label;
        var c = document.createElement('canvas');
        c.width = 48; c.height = 60;
        cell.appendChild(label);
        cell.appendChild(c);
        wrap.appendChild(cell);
        cells.push({ ctx: c.getContext('2d'), name: names[k] });
      }
      var tg = performance.now();
      (function gf(now) {
        var t = (now - tg) / 1000;
        for (var m = 0; m < cells.length; m++) {
          Jellyfish.draw(cells[m].ctx, cells[m].name, t);
        }
        requestAnimationFrame(gf);
      })(tg);
    }
  }
})();
