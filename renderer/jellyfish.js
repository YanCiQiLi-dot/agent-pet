// ============================================================
// jellyfish.js — 像素小水母绘制器（Phase 0）
// 逻辑画布 48x60，由 CSS 放大 + pixelated 保持像素感。
// 暴露 window.Jellyfish = { W, H, PAL, STATES, draw(ctx, state, t) }
// ============================================================
(function () {
  'use strict';

  var W = 48, H = 60;

  var PAL = {
    deep:   '#6A4FD8', // 伞盖深紫
    mid:    '#8A6BF0', // 伞盖中紫
    light:  '#B79BFF', // 伞盖浅紫
    pale:   '#DCCBFF', // 高光 / 触手
    frill:  '#FFC9E8', // 裙边粉
    blush:  '#FF9EC7', // 腮红
    eye:    '#2A2140', // 眼睛
    white:  '#FFFFFF',
    bubble: '#8FE8FF', // 思考泡泡 / 放大镜
    star:   '#FFE97A', // 星星 / 感叹号
    tear:   '#6ECFFF', // 眼泪
    code:   '#5ED6C8'  // 代码 / 进度
  };

  // 状态配置（Phase 1 将改为由真实 Codex 日志事件驱动）
  var STATES = {
    idle:      { label: '空闲',      bubble: '咕噜咕噜～',      eyes: 'open',  mouth: 'dot',   fx: null,       bob: 1.0 },
    listening: { label: '收到指令',  bubble: '收到！',          eyes: 'big',   mouth: 'o',     fx: 'bang',     bob: 1.4 },
    thinking:  { label: '分析中',    bubble: '让我想想…',       eyes: 'half',  mouth: 'wave',  fx: 'thought',  bob: 0.8 },
    coding:    { label: '写代码中',  bubble: '在写代码啦',      eyes: 'focus', mouth: 'flat',  fx: 'code',     bob: 0.6 },
    running:   { label: '运行中',    bubble: '正在跑…',         eyes: 'line',  mouth: 'flat',  fx: 'progress', bob: 0.9 },
    searching: { label: '搜索中',    bubble: '查资料中',        eyes: 'focus', mouth: 'flat',  fx: 'search',   bob: 0.8 },
    done:      { label: '完成',      bubble: '搞定！✨',         eyes: 'happy', mouth: 'smile', fx: 'stars',    bob: 1.8 },
    approval:  { label: '等待审批',  bubble: '求求你点允许…',   eyes: 'teary', mouth: 'wave',  fx: 'tear',     bob: 1.0 },
    sleep:     { label: '沉睡中',    bubble: 'Zzz…',            eyes: 'line',  mouth: 'dot',   fx: 'zzz',      bob: 0.4 }
  };

  // 皮肤主题（P3）：覆盖调色板
  var THEMES = {
    default: null,
    sakura: {
      deep:   '#C64D8C', mid:   '#EC7FB4', light: '#F9B8D8',
      pale:   '#FFDDEE', frill: '#FFE3F2', blush: '#FF8FB8',
      eye:    '#3A1A2E', white: '#FFFFFF', bubble: '#FFD3E8',
      star:   '#FFE97A', tear:  '#8FE8FF', code:  '#7FE0C8'
    },
    ocean: {
      deep:   '#1F6FA8', mid:   '#3E9AD6', light: '#7FC4EE',
      pale:   '#BFE3F8', frill: '#A8F0E6', blush: '#FF9EC7',
      eye:    '#0B2A40', white: '#FFFFFF', bubble: '#8FE8FF',
      star:   '#FFE97A', tear:  '#8FE8FF', code:  '#9BE88A'
    }
  };

  // 初始调色板副本（default 时恢复蓝紫原色）
  var DEFAULT_PAL = Object.assign({}, PAL);

  // 切换皮肤（覆盖 PAL 对应色；default/未知名 → 恢复初始调色板）
  function setTheme(name) {
    var t = THEMES[name];
    if (!t) {
      Object.keys(DEFAULT_PAL).forEach(function (k) { PAL[k] = DEFAULT_PAL[k]; });
      return true;
    }
    Object.keys(t).forEach(function (k) { PAL[k] = t[k]; });
    return true;
  }

  function fill(ctx, x, y, w, h, color) {
    ctx.fillStyle = color;
    // 像素画必须落在整数像素网格上，否则细线会被抗锯齿半透明混合"吃掉"
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  }

  // 眨眼：每 ~3.4s 闭眼 0.14s
  function isBlink(t) {
    var m = t % 3.4;
    return m > 3.0 && m < 3.14;
  }

  // ---------- 触手 ----------
  function drawTentacles(ctx, t, oy) {
    var base = Math.round(6 + 12 + oy + 4); // 伞盖底 + 下摆
    var xs = [15, 19, 24, 29, 33];
    var segs = 6, segH = 3;
    for (var i = 0; i < xs.length; i++) {
      var x = xs[i];
      var prev = { x: x, y: base };
      for (var s = 1; s <= segs; s++) {
        var yy = base + s * segH;
        var xx = x + Math.round(Math.sin(t * 2.6 + i * 1.4 + s * 0.8) * (s / segs) * 3);
        var yTop = Math.min(prev.y, yy);
        fill(ctx, xx - 1, yTop, 2, Math.max(2, Math.abs(yy - prev.y)), PAL.pale);
        prev = { x: xx, y: yy };
      }
      fill(ctx, prev.x - 1, prev.y - 1, 2, 2, PAL.frill); // 末端粉点
    }
  }

  // ---------- 伞盖 + 下摆 + 裙边 ----------
  function drawBell(ctx, t, oy) {
    var cx = 24;
    var top = 6 + oy;
    var r = 13;

    // 圆顶（逐行像素近似）
    for (var y = 1; y <= 13; y++) {
      var half = Math.round(Math.sqrt(r * r - (y - 13) * (y - 13)));
      fill(ctx, Math.round(cx - half), Math.round(top + y), Math.max(1, Math.round(half * 2)), 1, PAL.mid);
    }
    // 顶点单点
    fill(ctx, cx, top, 1, 1, PAL.mid);

    // 高光 + 纹理
    fill(ctx, cx - 9, top + 4, 4, 3, PAL.light);
    fill(ctx, cx + 3, top + 3, 2, 2, PAL.pale);
    fill(ctx, cx - 2, top + 8, 2, 2, PAL.pale);

    // 下摆波浪
    var cy = top + 12;
    for (var x = cx - r; x <= cx + r; x++) {
      var wave = Math.round((Math.sin((x - (cx - r)) * Math.PI / 4.5) + 1) * 1.5);
      for (var yy = 0; yy <= wave; yy++) {
        fill(ctx, x, cy + yy, 1, 1, PAL.light);
      }
    }
    // 裙边粉
    for (var x2 = cx - r; x2 <= cx + r; x2++) {
      var w2 = Math.round((Math.sin((x2 - (cx - r)) * Math.PI / 4.5) + 1) * 1.5);
      fill(ctx, x2, cy + w2 + 1, 1, 1, PAL.frill);
    }
  }

  // ---------- 脸部 ----------
  function drawFace(ctx, st, t, oy) {
    var eyeY = Math.round(6 + oy + 9);
    var blink = isBlink(t) && st.eyes === 'open';

    if (st.eyes === 'big') {
      fill(ctx, 16, eyeY, 4, 4, PAL.eye);
      fill(ctx, 17, eyeY + 1, 1, 1, PAL.white);
      fill(ctx, 28, eyeY, 4, 4, PAL.eye);
      fill(ctx, 29, eyeY + 1, 1, 1, PAL.white);
    } else if (st.eyes === 'happy') {
      fill(ctx, 17, eyeY + 1, 1, 2, PAL.eye);
      fill(ctx, 18, eyeY, 1, 1, PAL.eye);
      fill(ctx, 19, eyeY + 1, 1, 1, PAL.eye);
      fill(ctx, 29, eyeY + 1, 1, 2, PAL.eye);
      fill(ctx, 28, eyeY, 1, 1, PAL.eye);
      fill(ctx, 30, eyeY + 1, 1, 1, PAL.eye);
    } else if (st.eyes === 'line' || blink) {
      fill(ctx, 17, eyeY + 1, 3, 1, PAL.eye);
      fill(ctx, 28, eyeY + 1, 3, 1, PAL.eye);
    } else if (st.eyes === 'half') {
      fill(ctx, 17, eyeY + 1, 3, 1, PAL.eye);
      fill(ctx, 28, eyeY + 1, 3, 1, PAL.eye);
      fill(ctx, 17, eyeY + 2, 1, 1, PAL.eye);
      fill(ctx, 30, eyeY + 2, 1, 1, PAL.eye);
    } else if (st.eyes === 'teary') {
      fill(ctx, 16, eyeY, 4, 4, PAL.eye);
      fill(ctx, 17, eyeY + 1, 1, 1, PAL.white);
      fill(ctx, 28, eyeY, 4, 4, PAL.eye);
      fill(ctx, 29, eyeY + 1, 1, 1, PAL.white);
    } else { // open / focus
      fill(ctx, 17, eyeY, 2, 2, PAL.eye);
      fill(ctx, 29, eyeY, 2, 2, PAL.eye);
      if (st.eyes === 'focus') {
        fill(ctx, 17, eyeY, 1, 1, PAL.white);
        fill(ctx, 29, eyeY, 1, 1, PAL.white);
      }
    }

    // 腮红
    fill(ctx, 13, eyeY + 3, 2, 1, PAL.blush);
    fill(ctx, 33, eyeY + 3, 2, 1, PAL.blush);

    // 嘴巴
    var my = eyeY + 5;
    if (st.mouth === 'smile') {
      fill(ctx, 22, my, 5, 1, PAL.eye);
      fill(ctx, 21, my + 1, 1, 1, PAL.eye);
      fill(ctx, 26, my + 1, 1, 1, PAL.eye);
    } else if (st.mouth === 'o') {
      fill(ctx, 23, my, 2, 2, PAL.eye);
    } else if (st.mouth === 'wave') {
      fill(ctx, 22, my, 1, 1, PAL.eye);
      fill(ctx, 24, my + 1, 1, 1, PAL.eye);
      fill(ctx, 26, my, 1, 1, PAL.eye);
    } else if (st.mouth === 'flat') {
      fill(ctx, 22, my, 5, 1, PAL.eye);
    } else { // dot
      fill(ctx, 24, my, 1, 2, PAL.eye);
    }
  }

  // ---------- 状态特效 ----------
  function drawFx(ctx, st, t, oy) {
    var top = 6 + oy;
    var eyeY = Math.round(6 + oy + 9);

    switch (st.fx) {
      case 'thought': {
        for (var k = 0; k < 3; k++) {
          var ph = (t * 0.45 + k / 3) % 1;
          var bx = 19 + Math.round(Math.sin(t * 1.6 + k * 2) * 2);
          var by = Math.max(0, Math.round(top + 2 - ph * 4));
          fill(ctx, bx, by, 2, 2, PAL.bubble);
        }
        fill(ctx, 36, top + 2, 1, 1, PAL.bubble);
        fill(ctx, 38, top + 4, 1, 1, PAL.bubble);
        fill(ctx, 40, top + 6, 1, 1, PAL.bubble);
        break;
      }
      case 'bang': {
        fill(ctx, 33, top - 6, 2, 4, PAL.star);
        fill(ctx, 33, top - 1, 2, 1, PAL.star);
        break;
      }
      case 'code': {
        // 迷你键盘（右侧）
        fill(ctx, 35, 22 + oy, 9, 6, PAL.deep);
        fill(ctx, 36, 23 + oy, 3, 1, PAL.white);
        fill(ctx, 40, 23 + oy, 3, 1, PAL.white);
        fill(ctx, 36, 25 + oy, 3, 1, PAL.white);
        fill(ctx, 40, 25 + oy, 3, 1, PAL.white);
        fill(ctx, 36, 27 + oy, 3, 1, PAL.white);
        fill(ctx, 40, 27 + oy, 3, 1, PAL.white);
        // 敲击中的键（闪烁）
        var kx = Math.floor(t * 3) % 2 === 0 ? 36 : 40;
        var ky = Math.floor(t * 2) % 3;
        fill(ctx, kx, 23 + oy + ky * 2, 3, 1, PAL.code);
        // 伞盖上滚动的代码小条
        var row = Math.floor(t * 2) % 3;
        fill(ctx, 13, 8 + oy + row * 2, 7, 1, PAL.code);
        break;
      }
      case 'progress': {
        var px = 13, pw = 22, py = 44 + oy;
        fill(ctx, px, py, pw, 2, PAL.deep);
        var prog = (t * 0.35) % 1;
        fill(ctx, px, py, Math.max(1, Math.round(pw * prog)), 2, PAL.code);
        // 小沙漏
        fill(ctx, 12, 12 + oy, 4, 1, PAL.pale);
        fill(ctx, 13, 13 + oy, 2, 1, PAL.pale);
        fill(ctx, 12, 14 + oy, 4, 1, PAL.pale);
        break;
      }
      case 'search': {
        // 放大镜（左上）
        fill(ctx, 4, 16 + oy, 6, 6, PAL.bubble);
        fill(ctx, 5, 17 + oy, 4, 4, PAL.pale);
        fill(ctx, 4, 16 + oy, 1, 6, PAL.deep);
        fill(ctx, 9, 16 + oy, 1, 6, PAL.deep);
        fill(ctx, 4, 16 + oy, 6, 1, PAL.deep);
        fill(ctx, 4, 21 + oy, 6, 1, PAL.deep);
        fill(ctx, 9, 22 + oy, 1, 3, PAL.deep);
        fill(ctx, 10, 24 + oy, 2, 1, PAL.deep);
        break;
      }
      case 'stars': {
        var pts = [[5, 9 + oy], [39, 7 + oy], [41, 24 + oy], [4, 28 + oy]];
        for (var i = 0; i < pts.length; i++) {
          var tw = Math.sin(t * 5 + i * 2.1) > -0.5;
          if (tw) fill(ctx, pts[i][0], pts[i][1], 2, 2, PAL.star);
        }
        break;
      }
      case 'tear': {
        fill(ctx, 15, eyeY + 5, 2, 3, PAL.tear);
        fill(ctx, 31, eyeY + 5, 2, 3, PAL.tear);
        break;
      }
      case 'zzz': {
        var zy = Math.round((t * 0.7) % 6);
        fill(ctx, 34, 6 + oy - zy, 4, 1, PAL.pale);
        fill(ctx, 35, 7 + oy - zy, 3, 1, PAL.pale);
        fill(ctx, 34, 8 + oy - zy, 4, 1, PAL.pale);
        break;
      }
    }
  }

  // ---------- 主绘制 ----------
  function draw(ctx, stateName, t) {
    var st = STATES[stateName] || STATES.idle;
    ctx.clearRect(0, 0, W, H);

    var jump = stateName === 'done' ? -Math.abs(Math.sin(t * 6)) * 3 : 0;
    var oy = Math.sin(t * 2.2 + 0.6) * 1.5 * (st.bob || 1) + jump;

    drawTentacles(ctx, t, oy);
    drawBell(ctx, t, oy);
    drawFace(ctx, st, t, oy);
    drawFx(ctx, st, t, oy);
  }

  window.Jellyfish = { W: W, H: H, PAL: PAL, STATES: STATES, THEMES: THEMES, setTheme: setTheme, draw: draw };
})();
