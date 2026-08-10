// ============================================================
// octopus.js — 像素小章鱼绘制器（opencode 桌宠形象，水母同款画风）
// 逻辑画布 48x60，由 CSS 放大 + pixelated 保持像素感。
// 接口与水母一致：window.Octopus = { W, H, PAL, STATES, THEMES, setTheme, draw(ctx, state, t) }
// 画风：低饱和淡紫圆头 + 两个小角 + 小黑点圆眼 + 极小嘴 + 细长触手末端尖（水母同款）
// ============================================================
(function () {
  'use strict';

  var W = 48, H = 60;

  var PAL = {
    main:   '#B39DD9', // 低饱和淡紫（头）
    mid:    '#C9B5E8', // 中调紫
    light:  '#E3D4F7', // 浅紫（高光 / 触手）
    pale:   '#F2EAFB', // 极浅（触手末端 / 感器点）
    deep:   '#9A80C9', // 深紫（吸盘 / 边缘）
    blush:  '#FFC9E8', // 粉腮红
    eye:    '#3A3040', // 深紫灰（眼，水母同款调性）
    white:  '#FFFFFF',
    bubble: '#8FE8FF', // 思考泡泡 / 放大镜（水母同款）
    star:   '#FFE97A', // 星星 / 感叹号
    tear:   '#6ECFFF', // 眼泪
    code:   '#5ED6C8'  // 代码 / 进度
  };

  // 状态配置（与水母一致）
  var STATES = {
    idle:      { label: '空闲',     bubble: '咕噜咕噜～',      eyes: 'open',  mouth: 'dot',   fx: null,       bob: 1.0 },
    listening: { label: '收到指令', bubble: '收到！',          eyes: 'big',   mouth: 'o',     fx: 'bang',     bob: 1.4 },
    thinking:  { label: '分析中',   bubble: '让我想想…',       eyes: 'half',  mouth: 'wave',  fx: 'thought',  bob: 0.8 },
    coding:    { label: '写代码中', bubble: '触手在写码',      eyes: 'focus', mouth: 'flat',  fx: 'code',     bob: 0.6 },
    running:   { label: '运行中',   bubble: '正在跑…',         eyes: 'line',  mouth: 'flat',  fx: 'progress', bob: 0.9 },
    searching: { label: '搜索中',   bubble: '查资料中',        eyes: 'focus', mouth: 'flat',  fx: 'search',   bob: 0.8 },
    done:      { label: '完成',     bubble: '搞定！✨',         eyes: 'happy', mouth: 'smile', fx: 'stars',    bob: 1.8 },
    approval:  { label: '等待审批', bubble: '求求你点允许…',   eyes: 'teary', mouth: 'wave',  fx: 'tear',     bob: 1.0 },
    sleep:     { label: '沉睡中',   bubble: 'Zzz…',            eyes: 'line',  mouth: 'dot',   fx: 'zzz',      bob: 0.4 }
  };

  // 皮肤主题：换配色（粉章鱼 / 蓝章鱼）
  var THEMES = {
    default: null,
    sakura: {
      main: '#F2A8C8', mid: '#F7BFDA', light: '#FBD9EA',
      pale: '#FFEAF4', deep: '#DE82AC', blush: '#FF8FB8',
      eye: '#3A1A2E', white: '#FFFFFF', bubble: '#FFD3E8',
      star: '#FFE97A', tear: '#8FE8FF', code: '#7FE0C8'
    },
    ocean: {
      main: '#8FC4E8', mid: '#A9D5F2', light: '#CFE9FA',
      pale: '#E7F4FD', deep: '#5EA6D8', blush: '#FFC9E8',
      eye: '#0B2A40', white: '#FFFFFF', bubble: '#8FE8FF',
      star: '#FFE97A', tear: '#8FE8FF', code: '#9BE88A'
    }
  };

  function setTheme(name) {
    var t = THEMES[name];
    if (!t) return false;
    Object.keys(t).forEach(function (k) { PAL[k] = t[k]; });
    return true;
  }

  function fill(ctx, x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  }

  function isBlink(t) {
    var m = t % 3.4;
    return m > 3.0 && m < 3.14;
  }

  // ---------- 触手（细长，底部波浪摆动，末端浅色 + 深色吸盘） ----------
  function drawTentacles(ctx, t, oy) {
    var base = 25 + oy;
    var xs = [16, 20, 24, 28, 32];
    var segs = 3, segH = 4;
    for (var i = 0; i < xs.length; i++) {
      var x = xs[i];
      var prev = { x: x, y: base };
      for (var s = 1; s <= segs; s++) {
        var yy = base + s * segH;
        var xx = x + Math.round(Math.sin(t * 2.6 + i * 1.3 + s * 0.8) * (s / segs) * 3);
        var yTop = Math.min(prev.y, yy);
        fill(ctx, xx - 1, yTop, 2, Math.max(2, Math.abs(yy - prev.y)), PAL.mid);
        prev = { x: xx, y: yy };
      }
      // 末端：浅色 + 深色吸盘（水母末端粉点同款思路）
      fill(ctx, prev.x - 1, prev.y - 1, 2, 2, PAL.pale);
      fill(ctx, prev.x - 1, prev.y, 1, 1, PAL.deep);
    }
    // 两侧短触手
    for (var j = 0; j < 2; j++) {
      var ex = j === 0 ? 13 : 33;
      var sway = Math.round(Math.sin(t * 2.6 + j * 3.1) * 2);
      fill(ctx, ex + sway, base + 2, 2, 3, PAL.light);
      fill(ctx, ex + sway, base + 5, 2, 1, PAL.pale);
    }
  }

  // ---------- 头（圆润小头 + 两个小角 + 感器点） ----------
  function drawHead(ctx, oy) {
    // 小角
    fill(ctx, 19, 4 + oy, 2, 3, PAL.main);
    fill(ctx, 20, 3 + oy, 1, 1, PAL.light);
    fill(ctx, 27, 4 + oy, 2, 3, PAL.main);
    fill(ctx, 28, 3 + oy, 1, 1, PAL.light);

    // 头（小圆：x 15-32，y 8-25）
    var headRows = [
      { y: 8,  x: 19, w: 10 },
      { y: 9,  x: 17, w: 14 },
      { y: 10, x: 16, w: 16 },
      { y: 11, x: 15, w: 18 },
      { y: 12, x: 15, w: 18 },
      { y: 13, x: 15, w: 18 },
      { y: 14, x: 15, w: 18 },
      { y: 15, x: 15, w: 18 },
      { y: 16, x: 15, w: 18 },
      { y: 17, x: 15, w: 18 },
      { y: 18, x: 15, w: 18 },
      { y: 19, x: 15, w: 18 },
      { y: 20, x: 15, w: 18 },
      { y: 21, x: 15, w: 18 },
      { y: 22, x: 15, w: 18 },
      { y: 23, x: 15, w: 18 },
      { y: 24, x: 16, w: 16 },
      { y: 25, x: 17, w: 14 }
    ];
    for (var i = 0; i < headRows.length; i++) {
      fill(ctx, headRows[i].x, headRows[i].y + oy, headRows[i].w, 1, PAL.main);
    }

    // 顶部高光（水母伞盖同款小块）
    fill(ctx, 18, 10 + oy, 3, 2, PAL.light);
    fill(ctx, 27, 10 + oy, 3, 2, PAL.light);
    // 感器点（头顶一圈小点，水母同款）
    fill(ctx, 17, 12 + oy, 1, 1, PAL.pale);
    fill(ctx, 30, 12 + oy, 1, 1, PAL.pale);
    fill(ctx, 24, 11 + oy, 1, 1, PAL.pale);
  }

  // ---------- 脸部（小黑点圆眼 + 2x2 腮红 + 极小嘴） ----------
  function drawFace(ctx, st, t, oy) {
    var eyeY = 13 + oy;
    var blink = isBlink(t) && st.eyes === 'open';

    // 左眼
    if (st.eyes === 'big') {
      fill(ctx, 18, eyeY - 1, 4, 4, PAL.eye);
      fill(ctx, 19, eyeY, 1, 1, PAL.white);
    } else if (st.eyes === 'happy') {
      fill(ctx, 19, eyeY + 1, 1, 1, PAL.eye);
      fill(ctx, 20, eyeY, 1, 1, PAL.eye);
      fill(ctx, 21, eyeY + 1, 1, 1, PAL.eye);
    } else if (st.eyes === 'line' || blink) {
      fill(ctx, 19, eyeY + 1, 3, 1, PAL.eye);
    } else if (st.eyes === 'half') {
      fill(ctx, 19, eyeY + 1, 3, 1, PAL.eye);
      fill(ctx, 19, eyeY + 2, 1, 1, PAL.eye);
    } else if (st.eyes === 'teary') {
      fill(ctx, 18, eyeY - 1, 4, 4, PAL.eye);
      fill(ctx, 19, eyeY, 1, 1, PAL.white);
    } else { // open / focus
      fill(ctx, 19, eyeY, 3, 3, PAL.eye);
      fill(ctx, 19, eyeY, 1, 1, PAL.white);
      if (st.eyes === 'focus') fill(ctx, 21, eyeY + 2, 1, 1, PAL.white);
    }

    // 右眼
    if (st.eyes === 'big') {
      fill(ctx, 26, eyeY - 1, 4, 4, PAL.eye);
      fill(ctx, 27, eyeY, 1, 1, PAL.white);
    } else if (st.eyes === 'happy') {
      fill(ctx, 27, eyeY + 1, 1, 1, PAL.eye);
      fill(ctx, 26, eyeY, 1, 1, PAL.eye);
      fill(ctx, 28, eyeY + 1, 1, 1, PAL.eye);
    } else if (st.eyes === 'line' || blink) {
      fill(ctx, 26, eyeY + 1, 3, 1, PAL.eye);
    } else if (st.eyes === 'half') {
      fill(ctx, 26, eyeY + 1, 3, 1, PAL.eye);
      fill(ctx, 28, eyeY + 2, 1, 1, PAL.eye);
    } else if (st.eyes === 'teary') {
      fill(ctx, 26, eyeY - 1, 4, 4, PAL.eye);
      fill(ctx, 27, eyeY, 1, 1, PAL.white);
    } else {
      fill(ctx, 26, eyeY, 3, 3, PAL.eye);
      fill(ctx, 26, eyeY, 1, 1, PAL.white);
      if (st.eyes === 'focus') fill(ctx, 28, eyeY + 2, 1, 1, PAL.white);
    }

    // 腮红（2x2 粉点）
    fill(ctx, 16, eyeY + 4, 2, 2, PAL.blush);
    fill(ctx, 30, eyeY + 4, 2, 2, PAL.blush);

    // 极小嘴
    var my = eyeY + 7;
    if (st.mouth === 'smile') {
      fill(ctx, 21, my, 4, 1, PAL.eye);
      fill(ctx, 20, my + 1, 1, 1, PAL.eye);
      fill(ctx, 25, my + 1, 1, 1, PAL.eye);
    } else if (st.mouth === 'o') {
      fill(ctx, 22, my, 2, 2, PAL.eye);
    } else if (st.mouth === 'wave') {
      fill(ctx, 21, my, 1, 1, PAL.eye);
      fill(ctx, 23, my + 1, 2, 1, PAL.eye);
      fill(ctx, 26, my, 1, 1, PAL.eye);
    } else if (st.mouth === 'flat') {
      fill(ctx, 21, my + 1, 4, 1, PAL.eye);
    } else { // dot
      fill(ctx, 23, my + 1, 1, 1, PAL.eye);
    }
  }

  // ---------- 状态特效（水母同款，位置适配小章鱼） ----------
  function drawFx(ctx, st, t, oy) {
    var top = 8 + oy;
    var eyeY = 13 + oy;

    switch (st.fx) {
      case 'thought': {
        for (var k = 0; k < 3; k++) {
          var ph = (t * 0.45 + k / 3) % 1;
          var bx = 6 + Math.round(Math.sin(t * 1.6 + k * 2) * 2);
          var by = Math.max(0, Math.round(top - 4 - ph * 4));
          fill(ctx, bx, by, 2, 2, PAL.bubble);
        }
        fill(ctx, 3, top - 4, 1, 1, PAL.bubble);
        fill(ctx, 5, top - 2, 1, 1, PAL.bubble);
        fill(ctx, 7, top, 1, 1, PAL.bubble);
        break;
      }
      case 'bang': {
        fill(ctx, 21, 2 + oy, 2, 4, PAL.star);
        fill(ctx, 21, 7 + oy, 2, 1, PAL.star);
        break;
      }
      case 'code': {
        fill(ctx, 37, 27 + oy, 9, 6, PAL.deep);
        fill(ctx, 38, 28 + oy, 2, 1, PAL.white);
        fill(ctx, 43, 28 + oy, 2, 1, PAL.white);
        fill(ctx, 38, 30 + oy, 2, 1, PAL.white);
        fill(ctx, 43, 30 + oy, 2, 1, PAL.white);
        fill(ctx, 38, 32 + oy, 2, 1, PAL.white);
        fill(ctx, 43, 32 + oy, 2, 1, PAL.white);
        var kx = Math.floor(t * 3) % 2 === 0 ? 38 : 43;
        var ky = Math.floor(t * 2) % 3;
        fill(ctx, kx, 28 + oy + ky * 2, 2, 1, PAL.code);
        var row = Math.floor(t * 2) % 3;
        fill(ctx, 16, 4 + oy + row, 6, 1, PAL.code);
        break;
      }
      case 'progress': {
        var px = 10, pw = 28, py = 53 + oy;
        fill(ctx, px, py, pw, 2, PAL.deep);
        var prog = (t * 0.35) % 1;
        fill(ctx, px, py, Math.max(1, Math.round(pw * prog)), 2, PAL.code);
        break;
      }
      case 'search': {
        fill(ctx, 1, 16 + oy, 6, 6, PAL.bubble);
        fill(ctx, 2, 17 + oy, 4, 4, PAL.pale);
        fill(ctx, 1, 16 + oy, 1, 6, PAL.deep);
        fill(ctx, 6, 16 + oy, 1, 6, PAL.deep);
        fill(ctx, 1, 16 + oy, 6, 1, PAL.deep);
        fill(ctx, 1, 21 + oy, 6, 1, PAL.deep);
        fill(ctx, 6, 22 + oy, 1, 3, PAL.deep);
        fill(ctx, 7, 24 + oy, 2, 1, PAL.deep);
        break;
      }
      case 'stars': {
        var pts = [[3, 12 + oy], [41, 10 + oy], [42, 26 + oy], [3, 30 + oy]];
        for (var i = 0; i < pts.length; i++) {
          if (Math.sin(t * 5 + i * 2.1) > -0.5) fill(ctx, pts[i][0], pts[i][1], 2, 2, PAL.star);
        }
        break;
      }
      case 'tear': {
        fill(ctx, 19, eyeY + 5, 2, 3, PAL.tear);
        fill(ctx, 27, eyeY + 5, 2, 3, PAL.tear);
        break;
      }
      case 'zzz': {
        var zy = Math.round((t * 0.7) % 6);
        fill(ctx, 35, 10 + oy - zy, 4, 1, PAL.bubble);
        fill(ctx, 36, 11 + oy - zy, 3, 1, PAL.bubble);
        fill(ctx, 35, 12 + oy - zy, 4, 1, PAL.bubble);
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
    drawHead(ctx, oy);
    drawFace(ctx, st, t, oy);
    drawFx(ctx, st, t, oy);
  }

  window.Octopus = { W: W, H: H, PAL: PAL, STATES: STATES, THEMES: THEMES, setTheme: setTheme, draw: draw };
})();
