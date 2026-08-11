// ============================================================
// source-router.js — 多数据源状态路由（LRU：最后活跃者优先）
// 支持 Codex / OpenCode 并行监听时决定"水母显示谁的状态"
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
    this.activeSource = opts.defaultSource || 'codex';
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
      // 当前源空闲/沉睡：若对端正在干活，切到对端；否则保持（显示空闲）
      const other = source === 'codex' ? 'opencode' : 'codex';
      if (this.lastState[other] && ACTIVE_STATES.has(this.lastState[other].state)) {
        this.activeSource = other;
      }
    }

    const cur = this.lastState[this.activeSource] || st;
    this.emit('change', Object.assign({}, cur, { source: this.activeSource }));
  }

  getActive() {
    return this.activeSource;
  }

  // 配置热更新：动态切换固定源（'auto' 恢复 LRU）
  setFixed(fixed) {
    this.fixed = fixed || 'auto';
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

  console.log(fail === 0 ? '\nALL PASS ✅' : `\n${fail} FAILED ❌`);
  process.exit(fail === 0 ? 0 : 1);
}
