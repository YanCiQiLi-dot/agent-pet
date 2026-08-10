// ============================================================
// cat.js — 像素坐姿橘猫绘制器（opencode 桌宠形象）
// 逻辑画布 48x60，由 CSS 放大 + pixelated 保持像素感。
// 接口与水母一致：window.Cat = { W, H, PAL, STATES, THEMES, setTheme, draw(ctx, state, t) }
// 视角：坐姿全身像（头适中 + 坐姿身体 + 前腿并拢 + 尾巴卷身侧），参考用户实拍坐姿橘猫
// ============================================================
(function () {
  'use strict';

  var W = 48, H = 60;

  var PAL = {
    fur:    '#F7A93C', // 主橘黄
    furL:   '#FFC766', // 亮橘（渐变上部 / 高光）
    furD:   '#E88A2E', // 深橘（条纹 / 阴影）
    cream:  '#FFF3E0', // 米白（肚皮 / 前腿）
    pink:   '#FF6B9D', // 粉（鼻 / 腮红 / 内耳）
    eye:    '#3E2723', // 深黑棕（眼）
    line:   '#4E342E', // 深棕描边
    white:  '#FFFFFF',
    tongue: '#FF9EB5', // 舌头粉
    bubble: '#8FE8FF', // 思考泡泡 / 放大镜
    star:   '#FFE97A', // 星星 / 感叹号
    tear:   '#6ECFFF', // 眼泪
    code:   '#5ED6C8'  // 代码 / 进度
  };

  // 状态配置（与水母一致）
  var STATES = {
    idle:      { label: '空闲',     bubble: '喵呜～',        eyes: 'open',  mouth: 'dot',   fx: null,       bob: 1.0 },
    listening: { label: '收到指令', bubble: '喵！收到！',     eyes: 'big',   mouth: 'o',     fx: 'bang',     bob: 1.4 },
    thinking:  { label: '分析中',   bubble: '喵…让我想想',   eyes: 'half',  mouth: 'wave',  fx: 'thought',  bob: 0.8 },
    coding:    { label: '写代码中', bubble: '爪子在写码',     eyes: 'focus', mouth: 'flat',  fx: 'code',     bob: 0.6 },
    running:   { label: '运行中',   bubble: '正在跑…',       eyes: 'line',  mouth: 'flat',  fx: 'progress', bob: 0.9 },
    searching: { label: '搜索中',   bubble: '找资料喵',      eyes: 'focus', mouth: 'flat',  fx: 'search',   bob: 0.8 },
    done:      { label: '完成',     bubble: '搞定！✨',       eyes: 'happy', mouth: 'smile', fx: 'stars',    bob: 1.8 },
    approval:  { label: '等待审批', bubble: '喵…求批准',     eyes: 'teary', mouth: 'wave',  fx: 'tear',     bob: 1.0 },
    sleep:     { label: '沉睡中',   bubble: 'Zzz…',          eyes: 'line',  mouth: 'dot',   fx: 'zzz',      bob: 0.4 }
  };

  // 皮肤主题：换毛色
  var THEMES = {
    default: null,
    sakura: {
      fur: '#F5A8C4', furL: '#FFC9DC', furD: '#E07FA3',
      cream: '#FFF0F6', pink: '#FF8FB8', eye: '#3A1A2E', line: '#5E2A48',
      white: '#FFFFFF', tongue: '#FFC9DC', bubble: '#FFD3E8',
      star: '#FFE97A', tear: '#8FE8FF', code: '#7FE0C8'
    },
    ocean: {
      fur: '#8FC0E8', furL: '#B8DCF7', furD: '#6AA6D6',
      cream: '#EEF7FF', pink: '#FFC9E8', eye: '#0B2A40', line: '#1F4E78',
      white: '#FFFFFF', tongue: '#B8DCF7', bubble: '#8FE8FF',
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

  // 带描边的行绘制（先 line 宽行，再内部色窄行）
  function row(ctx, x, y, w, color, oy) {
    fill(ctx, x - 1, y + oy, w + 2, 1, PAL.line);
    fill(ctx, x, y + oy, w, 1, color);
  }

  // ---------- 尾巴（从右后侧卷到身前，摆动） ----------
  function drawTail(ctx, t, oy) {
    var sway = Math.round(Math.sin(t * 2.8) * 1.5);
    fill(ctx, 34, 38 + oy, 2, 3, PAL.line);
    fill(ctx, 34, 39 + oy, 2, 2, PAL.fur);
    fill(ctx, 36 + sway, 40 + oy, 2, 3, PAL.line);
    fill(ctx, 36 + sway, 41 + oy, 2, 2, PAL.fur);
    fill(ctx, 38 + sway, 43 + oy, 2, 3, PAL.line);
    fill(ctx, 38 + sway, 44 + oy, 2, 2, PAL.furD);
    fill(ctx, 39 + sway, 46 + oy, 2, 2, PAL.line);
  }

  // ---------- 身体（坐姿：肩窄臀宽 + 前腿并拢 + 肚皮） ----------
  function drawBody(ctx, oy) {
    // 主体（每行带描边）
    var rows = [
      { y: 20, x: 18, w: 12 },
      { y: 21, x: 16, w: 16 },
      { y: 22, x: 15, w: 18 },
      { y: 23, x: 14, w: 20 },
      { y: 24, x: 13, w: 22 },
      { y: 25, x: 13, w: 22 },
      { y: 26, x: 13, w: 22 },
      { y: 27, x: 13, w: 22 },
      { y: 28, x: 13, w: 22 },
      { y: 29, x: 13, w: 22 },
      { y: 30, x: 13, w: 22 },
      { y: 31, x: 13, w: 22 },
      { y: 32, x: 13, w: 22 },
      { y: 33, x: 13, w: 22 },
      { y: 34, x: 13, w: 22 },
      { y: 35, x: 13, w: 22 },
      { y: 36, x: 13, w: 22 },
      { y: 37, x: 13, w: 22 },
      { y: 38, x: 13, w: 22 },
      { y: 39, x: 13, w: 22 },
      { y: 40, x: 13, w: 22 },
      { y: 41, x: 14, w: 20 },
      { y: 42, x: 15, w: 18 },
      { y: 43, x: 16, w: 16 }
    ];
    for (var i = 0; i < rows.length; i++) {
      row(ctx, rows[i].x, rows[i].y, rows[i].w, PAL.fur, oy);
    }

    // 背部条纹（两段）
    fill(ctx, 15, 25 + oy, 3, 1, PAL.furD);
    fill(ctx, 30, 25 + oy, 3, 1, PAL.furD);
    fill(ctx, 15, 29 + oy, 3, 1, PAL.furD);
    fill(ctx, 30, 29 + oy, 3, 1, PAL.furD);
    fill(ctx, 15, 33 + oy, 3, 1, PAL.furD);
    fill(ctx, 30, 33 + oy, 3, 1, PAL.furD);

    // 肚皮米白（圆）
    var belly = [
      { y: 24, x: 19, w: 10 },
      { y: 25, x: 18, w: 12 },
      { y: 26, x: 17, w: 14 },
      { y: 27, x: 17, w: 14 },
      { y: 28, x: 17, w: 14 },
      { y: 29, x: 17, w: 14 },
      { y: 30, x: 17, w: 14 },
      { y: 31, x: 17, w: 14 },
      { y: 32, x: 17, w: 14 },
      { y: 33, x: 17, w: 14 },
      { y: 34, x: 17, w: 14 },
      { y: 35, x: 17, w: 14 },
      { y: 36, x: 17, w: 14 },
      { y: 37, x: 18, w: 12 },
      { y: 38, x: 19, w: 10 }
    ];
    for (var b = 0; b < belly.length; b++) {
      fill(ctx, belly[b].x, belly[b].y + oy, belly[b].w, 1, PAL.cream);
    }

    // 前腿（并拢直立，两条 + 中间缝）
    fill(ctx, 16, 43 + oy, 6, 7, PAL.line);
    fill(ctx, 17, 44 + oy, 4, 6, PAL.cream);
    fill(ctx, 26, 43 + oy, 6, 7, PAL.line);
    fill(ctx, 27, 44 + oy, 4, 6, PAL.cream);
    // 爪线
    fill(ctx, 18, 49 + oy, 2, 1, PAL.furL);
    fill(ctx, 28, 49 + oy, 2, 1, PAL.furL);
  }

  // ---------- 头（适中圆头 + 三角耳，叠在身体上方） ----------
  function drawHead(ctx, oy) {
    // 左耳（描边 + 填充 + 内耳粉）
    row(ctx, 16, 2, 4, PAL.fur, oy);
    row(ctx, 15, 3, 6, PAL.fur, oy);
    row(ctx, 15, 4, 6, PAL.fur, oy);
    row(ctx, 16, 5, 4, PAL.fur, oy);
    fill(ctx, 16, 3 + oy, 2, 2, PAL.pink);
    // 右耳
    row(ctx, 28, 2, 4, PAL.fur, oy);
    row(ctx, 27, 3, 6, PAL.fur, oy);
    row(ctx, 27, 4, 6, PAL.fur, oy);
    row(ctx, 28, 5, 4, PAL.fur, oy);
    fill(ctx, 30, 3 + oy, 2, 2, PAL.pink);

    // 头（圆，x 16-31，y 6-20；每行带描边）
    var headRows = [
      { y: 6,  x: 19, w: 10 },
      { y: 7,  x: 17, w: 14 },
      { y: 8,  x: 16, w: 16 },
      { y: 9,  x: 16, w: 16 },
      { y: 10, x: 16, w: 16 },
      { y: 11, x: 16, w: 16 },
      { y: 12, x: 16, w: 16 },
      { y: 13, x: 16, w: 16 },
      { y: 14, x: 16, w: 16 },
      { y: 15, x: 16, w: 16 },
      { y: 16, x: 16, w: 16 },
      { y: 17, x: 16, w: 16 },
      { y: 18, x: 16, w: 16 },
      { y: 19, x: 17, w: 14 },
      { y: 20, x: 18, w: 12 }
    ];
    for (var i = 0; i < headRows.length; i++) {
      row(ctx, headRows[i].x, headRows[i].y, headRows[i].w, PAL.fur, oy);
    }
    // 顶部渐变（亮橘）
    fill(ctx, 17, 7 + oy, 14, 3, PAL.furL);
    fill(ctx, 18, 8 + oy, 12, 2, PAL.furL);
    // 头顶条纹
    fill(ctx, 19, 9 + oy, 3, 1, PAL.furD);
    fill(ctx, 26, 9 + oy, 3, 1, PAL.furD);
  }

  // ---------- 脸部（黑眼 + 高光 + 粉鼻 + 小嘴 + 腮红 + 胡须） ----------
  function drawFace(ctx, st, t, oy) {
    var eyeY = 11 + oy;
    var blink = isBlink(t) && st.eyes === 'open';

    // 左眼
    if (st.eyes === 'big') {
      fill(ctx, 18, eyeY - 1, 5, 6, PAL.eye);
      fill(ctx, 19, eyeY, 2, 2, PAL.white);
    } else if (st.eyes === 'happy') {
      fill(ctx, 19, eyeY + 2, 2, 1, PAL.eye);
      fill(ctx, 21, eyeY + 1, 1, 1, PAL.eye);
    } else if (st.eyes === 'line' || blink) {
      fill(ctx, 19, eyeY + 2, 3, 1, PAL.eye);
    } else if (st.eyes === 'half') {
      fill(ctx, 19, eyeY + 1, 3, 1, PAL.eye);
      fill(ctx, 19, eyeY + 2, 3, 2, PAL.fur);
      fill(ctx, 19, eyeY + 4, 3, 1, PAL.eye);
    } else if (st.eyes === 'teary') {
      fill(ctx, 18, eyeY - 1, 5, 6, PAL.eye);
      fill(ctx, 19, eyeY, 2, 2, PAL.white);
    } else { // open / focus
      fill(ctx, 19, eyeY, 3, 5, PAL.eye);
      fill(ctx, 19, eyeY, 1, 2, PAL.white);
      if (st.eyes === 'focus') fill(ctx, 21, eyeY + 3, 1, 1, PAL.white);
    }

    // 右眼
    if (st.eyes === 'big') {
      fill(ctx, 25, eyeY - 1, 5, 6, PAL.eye);
      fill(ctx, 27, eyeY, 2, 2, PAL.white);
    } else if (st.eyes === 'happy') {
      fill(ctx, 27, eyeY + 2, 2, 1, PAL.eye);
      fill(ctx, 25, eyeY + 1, 1, 1, PAL.eye);
    } else if (st.eyes === 'line' || blink) {
      fill(ctx, 26, eyeY + 2, 3, 1, PAL.eye);
    } else if (st.eyes === 'half') {
      fill(ctx, 26, eyeY + 1, 3, 1, PAL.eye);
      fill(ctx, 26, eyeY + 2, 3, 2, PAL.fur);
      fill(ctx, 26, eyeY + 4, 3, 1, PAL.eye);
    } else if (st.eyes === 'teary') {
      fill(ctx, 25, eyeY - 1, 5, 6, PAL.eye);
      fill(ctx, 27, eyeY, 2, 2, PAL.white);
    } else {
      fill(ctx, 26, eyeY, 3, 5, PAL.eye);
      fill(ctx, 27, eyeY, 1, 2, PAL.white);
      if (st.eyes === 'focus') fill(ctx, 28, eyeY + 3, 1, 1, PAL.white);
    }

    // 腮红（2x2 粉点）
    fill(ctx, 17, eyeY + 5, 2, 2, PAL.pink);
    fill(ctx, 29, eyeY + 5, 2, 2, PAL.pink);

    // 鼻子（粉倒三角）
    fill(ctx, 22, eyeY + 6, 4, 1, PAL.pink);
    fill(ctx, 23, eyeY + 7, 2, 1, PAL.pink);

    // 嘴
    var my = eyeY + 9;
    if (st.mouth === 'smile') {
      fill(ctx, 20, my, 8, 1, PAL.line);
      fill(ctx, 21, my + 1, 6, 1, PAL.line);
      fill(ctx, 21, my + 1, 6, 1, PAL.tongue);
    } else if (st.mouth === 'o') {
      fill(ctx, 22, my, 4, 3, PAL.line);
      fill(ctx, 23, my + 1, 2, 1, PAL.tongue);
    } else if (st.mouth === 'wave') {
      fill(ctx, 21, my, 1, 1, PAL.line);
      fill(ctx, 23, my + 1, 2, 1, PAL.line);
      fill(ctx, 26, my, 1, 1, PAL.line);
    } else if (st.mouth === 'flat') {
      fill(ctx, 21, my + 1, 6, 1, PAL.line);
    } else { // dot
      fill(ctx, 23, my + 1, 2, 1, PAL.line);
    }

    // 胡须（每侧 2-3 根，短）
    fill(ctx, 8, eyeY + 3, 5, 1, PAL.furD);
    fill(ctx, 7, eyeY + 6, 5, 1, PAL.furD);
    fill(ctx, 8, eyeY + 9, 5, 1, PAL.furD);
    fill(ctx, 35, eyeY + 3, 5, 1, PAL.furD);
    fill(ctx, 36, eyeY + 6, 5, 1, PAL.furD);
    fill(ctx, 35, eyeY + 9, 5, 1, PAL.furD);
  }

  // ---------- 状态特效（位置适配坐姿猫） ----------
  function drawFx(ctx, st, t, oy) {
    var top = 6 + oy;
    var eyeY = 11 + oy;

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
        fill(ctx, 21, 0 + oy, 2, 4, PAL.star);
        fill(ctx, 21, 5 + oy, 2, 1, PAL.star);
        break;
      }
      case 'code': {
        fill(ctx, 37, 26 + oy, 9, 6, PAL.furD);
        fill(ctx, 38, 27 + oy, 2, 1, PAL.white);
        fill(ctx, 43, 27 + oy, 2, 1, PAL.white);
        fill(ctx, 38, 29 + oy, 2, 1, PAL.white);
        fill(ctx, 43, 29 + oy, 2, 1, PAL.white);
        fill(ctx, 38, 31 + oy, 2, 1, PAL.white);
        fill(ctx, 43, 31 + oy, 2, 1, PAL.white);
        var kx = Math.floor(t * 3) % 2 === 0 ? 38 : 43;
        var ky = Math.floor(t * 2) % 3;
        fill(ctx, kx, 27 + oy + ky * 2, 2, 1, PAL.code);
        var row = Math.floor(t * 2) % 3;
        fill(ctx, 15, 2 + oy + row, 6, 1, PAL.code);
        break;
      }
      case 'progress': {
        var px = 10, pw = 28, py = 57 + oy;
        fill(ctx, px, py, pw, 2, PAL.furD);
        var prog = (t * 0.35) % 1;
        fill(ctx, px, py, Math.max(1, Math.round(pw * prog)), 2, PAL.code);
        break;
      }
      case 'search': {
        fill(ctx, 1, 14 + oy, 6, 6, PAL.bubble);
        fill(ctx, 2, 15 + oy, 4, 4, PAL.cream);
        fill(ctx, 1, 14 + oy, 1, 6, PAL.furD);
        fill(ctx, 6, 14 + oy, 1, 6, PAL.furD);
        fill(ctx, 1, 14 + oy, 6, 1, PAL.furD);
        fill(ctx, 1, 19 + oy, 6, 1, PAL.furD);
        fill(ctx, 6, 20 + oy, 1, 3, PAL.furD);
        fill(ctx, 7, 22 + oy, 2, 1, PAL.furD);
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
        fill(ctx, 19, eyeY + 6, 2, 3, PAL.tear);
        fill(ctx, 27, eyeY + 6, 2, 3, PAL.tear);
        break;
      }
      case 'zzz': {
        var zy = Math.round((t * 0.7) % 6);
        fill(ctx, 35, 8 + oy - zy, 4, 1, PAL.bubble);
        fill(ctx, 36, 9 + oy - zy, 3, 1, PAL.bubble);
        fill(ctx, 35, 10 + oy - zy, 4, 1, PAL.bubble);
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

    drawTail(ctx, t, oy);
    drawBody(ctx, oy);
    drawHead(ctx, oy);
    drawFace(ctx, st, t, oy);
    drawFx(ctx, st, t, oy);
  }

  window.Cat = { W: W, H: H, PAL: PAL, STATES: STATES, THEMES: THEMES, setTheme: setTheme, draw: draw };
})();
