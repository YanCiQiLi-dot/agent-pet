// ============================================================
// source-router.js — 多数据源状态路由（LRU：最后活跃者优先）
// 支持 Codex / OpenCode / Claude Code 并行监听时决定"水母显示谁的状态"
// 纯 Node，无 Electron 依赖；node source-router.js --test 自测
// ============================================================
'use strict';

const { EventEmitter } = require('events');

// 工作状态：这些状态（含 done，任务刚结束）算"最近活跃"，可抢占当前显示
const ACTIVE_STATES = new Set(['listening', 'thinking', 'coding', 'running', 'searching', 'approval', 'done']);

class SourceRouter extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.fixed='auto']  'auto'=LRU；或固定 'codex'/'opencode' 只监听该源
   * @param {string} [opts.defaultSource='codex']  初始展示源
   */
  constructor(opts = {}) {
    super();
    this.fixed = opts.fixed || 'auto';
    // 固定源时以其为初始活跃源（否则收到首个事件前 getActive 会返回默认源）
    this.activeSource = (this.fixed && this.fixed !== 'auto') ? this.fixed : (opts.defaultSource || 'codex');
    this.lastState = {};       // 各源最后状态缓存
    this.lastActive = {};      // 各源最后"真实工作"时间戳
  }

  push(source, st) {
    if (this.fixed !== 'auto' && this.fixed !== source) return;
    this.lastState[source] = st;

    const isActive = ACTIVE_STATES.has(st.state);
    if (isActive) {
      // 谁最后有真实工作事件，就显示谁（新活跃顶掉当前）
      this.lastActive[source] = Date.now();
      this.activeSource = source;
    } else if (this.activeSource === source) {
      // 当前源空闲/沉睡：在其余源中挑“最后活跃且仍在工作”的；没有则保持当前（显示空闲）
      let best = null, bestT = 0;
      for (const s of Object.keys(this.lastState)) {
        if (s === source) continue;
        if (ACTIVE_STATES.has(this.lastState[s].state) && (this.lastActive[s] || 0) > bestT) {
          best = s; bestT = this.lastActive[s] || 0;
        }
      }
      if (best) this.activeSource = best;
    }

    const cur = this.lastState[this.activeSource] || st;
    this.emit('change', Object.assign({}, cur, { source: this.activeSource }));
  }

  getActive() {
    return this.activeSource;
  }

  // 配置热更新：动态切换固定源（'auto' 恢复 LRU，保持当前活跃源）
  setFixed(fixed) {
    this.fixed = fixed || 'auto';
    if (this.fixed !== 'auto') this.activeSource = this.fixed;
  }
}

SourceRouter.ACTIVE_STATES = ACTIVE_STATES;

module.exports = SourceRouter;

// ---------- 自测 ----------
if (require.main === module && process.argv.includes('--test')) {
  let fail = 0;
  function assert(cond, name) {
    console.log((cond ? '  PASS ' : '  FAIL ') + name);
    if (!cond) fail++;
  }
  function st(state, detail) { return { state, label: state, bubble: '', detail: detail || '', since: Date.now() }; }

  console.log('== 场景 1：Codex 干活，OpenCode 空闲 → 显示 Codex ==');
  {
    const r = new SourceRouter();
    r.push('opencode', st('idle'));
    r.push('codex', st('coding'));
    assert(r.getActive() === 'codex', 'active=codex');
  }

  console.log('== 场景 2：OpenCode 新指令顶掉 Codex 写代码 ==');
  {
    const r = new SourceRouter();
    r.push('codex', st('coding'));
    r.push('opencode', st('listening'));
    assert(r.getActive() === 'opencode', 'active=opencode');
  }

  console.log('== 场景 3：OpenCode 空闲后，Codex 仍在写代码 → 切回 Codex ==');
  {
    const r = new SourceRouter();
    r.push('codex', st('coding'));
    r.push('opencode', st('listening'));
    r.push('opencode', st('idle'));
    assert(r.getActive() === 'codex', 'active=codex');
  }

  console.log('== 场景 4：双方都空闲 → 保持最后活跃者 ==');
  {
    const r = new SourceRouter();
    r.push('codex', st('coding'));
    r.push('codex', st('idle'));
    r.push('opencode', st('idle'));
    assert(r.getActive() === 'codex', 'active=codex（最后活跃）');
  }

  console.log('== 场景 5：Codex done 后 OpenCode 新活跃 → OpenCode ==');
  {
    const r = new SourceRouter();
    r.push('codex', st('done'));
    r.push('opencode', st('running'));
    assert(r.getActive() === 'opencode', 'active=opencode');
  }

  console.log('== 场景 6：固定 activeSource=opencode 时忽略 codex ==');
  {
    const r = new SourceRouter({ fixed: 'opencode' });
    r.push('codex', st('coding'));
    r.push('opencode', st('running'));
    assert(r.getActive() === 'opencode', 'active=opencode');
  }

  console.log('== 场景 7：事件带 source 标记，change 事件正确发出 ==');
  {
    const r = new SourceRouter();
    let last = null;
    r.on('change', (s) => { last = s; });
    r.push('opencode', st('searching', '搜索: x'));
    assert(last && last.source === 'opencode' && last.detail === '搜索: x', 'change 事件 source=opencode');
  }

  console.log('== 场景 8（三源）：Claude 干活顶掉其余源 ==');
  {
    const r = new SourceRouter();
    r.push('codex', st('idle'));
    r.push('opencode', st('idle'));
    r.push('claude', st('coding'));
    assert(r.getActive() === 'claude', 'active=claude');
  }

  console.log('== 场景 9（三源）：多源同时工作 → 取最后活跃者；其空闲后回退到次新活跃者 ==');
  {
    const r = new SourceRouter();
    r.lastActive = { codex: 1000, opencode: 2000 }; // 确定性：直接指定时间戳
    r.push('codex', st('running'));
    r.push('opencode', st('searching'));
    r.push('claude', st('idle'));
    assert(r.getActive() === 'opencode', 'active=opencode（最后活跃且仍在工作）');
    r.push('opencode', st('idle'));
    assert(r.getActive() === 'codex', 'opencode 空闲 → 回退到仍在工作的 codex');
  }

  console.log('== 场景 10（三源）：固定 activeSource=claude 时忽略其余源 ==');
  {
    const r = new SourceRouter({ fixed: 'claude' });
    r.push('codex', st('coding'));
    r.push('opencode', st('running'));
    assert(r.getActive() === 'claude', 'active=claude（固定源，其余推送被忽略）');
  }

  console.log('== 场景 11（三源）：全部空闲 → 保持最后活跃者 ==');
  {
    const r = new SourceRouter();
    r.push('codex', st('running'));
    r.push('codex', st('idle'));
    r.push('opencode', st('idle'));
    r.push('claude', st('idle'));
    assert(r.getActive() === 'codex', 'active=codex（最后活跃）');
  }

  console.log('== 场景 12（三源）：change 事件带 claude source 标记 ==');
  {
    const r = new SourceRouter();
    let last = null;
    r.on('change', (s) => { last = s; });
    r.push('claude', st('searching', '搜索: x'));
    assert(last && last.source === 'claude' && last.detail === '搜索: x', 'change 事件 source=claude');
  }

  console.log('== 场景 13（四源）：DSH 干活顶掉其余源 ==');
  {
    const r = new SourceRouter();
    r.push('codex', st('idle'));
    r.push('opencode', st('idle'));
    r.push('claude', st('idle'));
    r.push('dsh', st('running'));
    assert(r.getActive() === 'dsh', 'active=dsh');
  }

  console.log('== 场景 14（四源）：DSH 空闲后回退到仍在工作的源 ==');
  {
    const r = new SourceRouter();
    r.lastActive = { codex: 1000, dsh: 2000 };
    r.push('codex', st('running'));
    r.push('dsh', st('searching'));
    r.push('dsh', st('idle'));
    assert(r.getActive() === 'codex', 'dsh 空闲 → 回退到仍在工作的 codex');
  }

  console.log('== 场景 15（四源）：固定 activeSource=dsh 时忽略其余源 ==');
  {
    const r = new SourceRouter({ fixed: 'dsh' });
    r.push('codex', st('coding'));
    r.push('opencode', st('running'));
    assert(r.getActive() === 'dsh', 'active=dsh（固定源，其余推送被忽略）');
  }

  console.log('== 场景 16（四源）：change 事件带 dsh source 标记 ==');
  {
    const r = new SourceRouter();
    let last = null;
    r.on('change', (s) => { last = s; });
    r.push('dsh', st('searching', '搜索: x'));
    assert(last && last.source === 'dsh' && last.detail === '搜索: x', 'change 事件 source=dsh');
  }

  console.log(fail === 0 ? '\nALL PASS ✅' : `\n${fail} FAILED ❌`);
  process.exit(fail === 0 ? 0 : 1);
}
