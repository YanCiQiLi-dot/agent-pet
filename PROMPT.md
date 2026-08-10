# 🪼 「程序状态桌宠」制作 Prompt（可复制版）

> 使用方法：把本文件完整粘贴给任意 AI 助手（或按此清单人工开发），即可复现一个会实时反映【目标程序】工作状态的像素风桌面宠物。
> 本 Prompt 基于一次真实开发历程提炼（目标程序：Codex CLI 智能体，宠物：像素小水母——默认形象，开发前应先询问用户想要的形象）。所有标注 ✅ 的要点均为实测踩坑后验证过的结论。

---

## 一、角色与任务

你是一名桌面应用开发工程师。请为【目标程序】（默认案例：Codex CLI，一个运行在终端里的 AI 智能体）制作一个**桌面宠物**：

- 宠物形象：**开发前必须先问用户想要什么形象的像素宠物**（候选：水母 / 小猫 / 小狗 / 狐狸 / 幽灵 / 机器人 / 恐龙 / 蘑菇…，也允许自由描述或发参考图；用户没要求时默认粉紫渐变小水母），悬浮在桌面角落，透明背景、始终置顶；形象一律保持**像素风**（Canvas 程序化像素画 + `image-rendering: pixelated`）
- 宠物能**真实反映目标程序的工作状态**（空闲 / 收到指令 / 分析中 / 写代码中 / 运行中 / 搜索中 / 完成 / 等待审批 / 沉睡），每个状态有专属动画 + 气泡文字
- 宠物**跟随目标程序启停**：目标程序打开 → 宠物出现；目标程序关闭 → 宠物消失
- 支持拖动、右键菜单、托盘图标、音效、皮肤/大小配置
- **需求确认（开发前必做）**：开工第一步先确认：① 宠物形象（见上）；② 主题色 / 大小；③ 是否需要音效、托盘、开机自启（给出推荐默认值）。确认完再动手，避免返工

## 二、技术栈

- **桌面壳**：Electron（透明无边框置顶窗口）—— 用 HTML/CSS/Canvas 做动画最容易，生态成熟
- **角色渲染**：Canvas 2D 程序化像素画（逻辑分辨率 48×60，CSS 放大 + `image-rendering: pixelated`）
- **状态感知**：纯 Node 日志监听（轮询目标程序的结构化日志文件尾部）
- **启停感知**：进程检测（Windows 下用 PowerShell `Get-Process`）
- **零外部素材**：图标用 PIL 生成、音效用 Web Audio 合成、像素画用代码绘制

## 三、分阶段实施

### Phase 0 —— 需求确认 + 动画原型（先在浏览器里跑）
0. **需求确认（必做）**：向用户确认想要什么形象的像素宠物（候选：水母 / 小猫 / 小狗 / 狐狸 / 幽灵 / 机器人 / 恐龙 / 蘑菇…，或自由描述 / 发参考图；未指定默认水母），并确认主题色、大小、音效、托盘、开机自启等偏好（给出推荐默认值）。形象必须保持像素风
1. 按用户确认的形象写角色绘制器 `<角色>.js`（默认 `jellyfish.js` 水母）：程序化绘制像素角色
   - ✅ 用 `fill(ctx, x, y, w, h, color)` 统一封装 `ctx.fillRect`，**坐标必须 `Math.round()` 取整**！浮点坐标会让 1px 细线被抗锯齿半透明混合"吃掉"（实测 Bug #2）
   - 角色本体：伞盖（逐行像素圆）+ 波浪裙边 + 触手（分段正弦摆动）+ 眼睛/嘴/腮红
   - 每种状态 = 眼睛形态 + 嘴巴形态 + 专属特效（思考泡泡 / 迷你键盘 / 进度条 / 放大镜 / 星星 / 眼泪 / Zzz）
   - 动画：`requestAnimationFrame` 全局时间 t，漂浮 `oy = sin(t*2.2)*1.5`，眨眼周期
2. `pet.js`：状态切换按钮 + 气泡 + 画廊模式（`?gallery=1` 一屏展示全部状态）
3. 验收：浏览器打开 `index.html`，9 种状态动画全部可见、可切换

### Phase 1 —— 桌面窗口 + 真实日志联动
1. **日志监听器 `state-watcher.js`**（纯 Node，可独立测试）
   - 轮询【目标程序的日志目录】，取**最新修改的会话日志文件**，只读新增字节（记录 offset）
   - ✅ 日志行格式：`{"timestamp": "...", "type": "...", "payload": {...}}`，逐行 JSON.parse 容错跳过坏行
   - 首次启动回看文件尾部（~200KB）建立当前状态，**回放期间静默**（只记状态不发事件，回放完一次性发出），避免启动瞬间状态闪烁（实测优化）
2. **状态机**（以 Codex rollout 日志为例，实测事件格式）：
   - 顶层类型：`session_meta / event_msg / response_item / world_state / turn_context`
   - `event_msg.payload.type`：`user_message` / `task_started` / `agent_message` / `token_count`(噪音，忽略) / `task_complete` / `patch_apply_end` / `thread_settings_applied`(忽略)
   - `response_item.payload.type`：`reasoning` / `message` / `function_call` / `function_call_output` / `custom_tool_call`(+`_output`)
   - 映射表：
     - `user_message` → 收到指令（2.5s 后转分析中）
     - `task_started` / `reasoning` / `agent_message` / `function_call_output` → 分析中
     - `custom_tool_call name=apply_patch` / `patch_apply_end` → 写代码中
     - `function_call name=shell_command` → 运行中
     - `function_call name=search/open_page/find_in_page` → 搜索中
     - `function_call` 的 `arguments` 含 `"sandbox_permissions":"require_escalated"` 或 `justification` → **等待审批**（✅ 这是审批的可靠信号，取 justification 作为气泡文案）
     - `task_complete` → 完成（8s 后回落空闲）
     - 60s 无新事件 → 空闲（**工作状态不被静默误判**：长命令执行中日志不会增长，只有非工作状态才回落空闲）
     - 15min 无事件 → 沉睡
   - ✅ 状态机的 `switch` 标签**必须与状态名一致**（Bug #1：曾用特效名做 case 标签，导致 7 个状态特效全部失效，只有碰巧同名的"分析中"生效）
3. **Electron 主进程 `main.js`**：
   - 窗口：`transparent: true, frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#00000000'`
   - ✅ **默认贴屏幕右下角**（桌宠惯例，避免挡住目标程序的输入框——实测用户反馈 Bug）
   - ✅ **用 `showInactive()` 显示，永不抢焦点**（否则会打断用户输入，实测 Bug）
   - ✅ 置顶级别用 `'floating'` 而非 `'screen-saver'`（后者会压过全屏/输入框）
   - ✅ 主进程日志**写文件**（`app.getPath('userData')` 下），不要 console.log，避免污染用户终端（实测 Bug）
   - 窗口位置记忆：写入 userData 下的 JSON
   - 拖动：渲染层 mousedown 记录起点 + IPC `getPos`/`moveTo`，mousemove 实时 setPosition（比 `-webkit-app-region: drag` 更可控，右键菜单不受影响）
   - 右键菜单：手动切换 9 状态 / 回到自动联动 / 重新加载 / 退出
   - 冒烟测试：`--smoke` 参数，启动 6s 后打印 SMOKE OK 并退出（自动化验证）
4. **preload.js**：`contextBridge` 暴露 `onState / getPos / moveTo / showMenu / getConfig`（contextIsolation: true，不开 nodeIntegration）
5. 验收：`npm install` + `npm start`，桌宠浮在桌面，真机日志联动状态正确

### Phase 2 —— 启停联动 + 托盘 + 音效 + 皮肤
1. **启停检测 `codex-watcher.js`**（纯 Node）：
   - ✅ 用 `powershell -NoProfile -NonInteractive -Command "@(Get-Process -Name '目标进程名' -ErrorAction SilentlyContinue).Count"` 检测
   - ✅ **不要用 `tasklist /FI`**：它在部分受限环境返回 Access denied（实测）
   - 轮询 2s + **去抖 2 次**（连续 2 次一致才切换，防进程列表抖动）
   - 事件：`started`（→ 显示/创建窗口）、`stopped`（→ hide 模式：延迟 5s 隐藏窗口；quit 模式：退出进程）
   - 诚实提示：若桌宠进程彻底退出，就没人监听 Codex 再次启动——要么桌宠常驻托盘（推荐，hide 模式），要么配一个轻量守护进程 `launcher.js`（检测到 Codex 启动就拉起桌宠、退出就结束桌宠）
2. **托盘**：PIL 画 32×32 像素图标 → `assets/tray.png` → `Tray` + 菜单（显示/隐藏、手动状态、退出），双击切换显隐
3. **音效**：Web Audio 合成（零素材）：`tone(freq, dur, type, vol, delay)` 用 Oscillator + Gain 包络；主进程加 `app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')`
4. **皮肤/大小**：`config.json`（项目根目录）：`theme`（default/sakura/ocean 覆盖调色板）、`scale`、`sound`、`showStatusLabel`、`followMode`（hide 隐藏 / quit 退出）、`startHidden`（true: 启动隐藏，检测到目标进程才显示；false: 启动即显示）、`detectNames`；改完托盘"重新加载"即生效
5. 验收：关闭目标程序 → 宠物消失；重新打开 → 宠物出现（≤4s）

### Phase 3 —— 部署与开机自启（本轮 Debug 实测 2026-08-05）
1. **“不会自动出现”的根因**：桌宠本身没有任何自启动机制（启动文件夹 / 注册表 Run / 计划任务均无），README 里的“开机自启”原本是未完成项 → 必须显式注册自启动，否则开机后永远得手动 `npm start`。
2. **开机自启（Windows，实测）**：往启动文件夹放 `.lnk`：
   - `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Codex桌宠.lnk`
   - Target：`<项目>\node_modules\electron\dist\electron.exe`（本项目即 `D:\codex-pet\...`）
   - Args：`"<项目绝对路径>"`（electron 传项目目录即等价 `electron .`）
   - WorkDir：`<项目绝对路径>`
   - 创建：`(New-Object -ComObject WScript.Shell).CreateShortcut($lnk)` 后 `.Save()`；受限环境可能抛 `UnauthorizedAccessException`，需提权
   - 移除自启：直接删该 `.lnk` 即可
3. **桌面快捷方式（固定创建，双击即启动）**：
   - **必做（交付项，不是可选项）**：在桌面创建 `Codex桌宠.lnk`，Target / Args / WorkDir 与开机自启完全一致（Target：`<项目>\node_modules\electron\dist\electron.exe`，Args：`"<项目绝对路径>"`，WorkDir：`<项目绝对路径>`），只是位置放在桌面
   - 创建：`(New-Object -ComObject WScript.Shell).CreateShortcut($lnk)`，设 `.TargetPath / .Arguments / .WorkingDirectory` 后 `.Save()`；完整可复制示例见 README「桌面快捷方式」
   - ✅ 真实桌面路径用 `[Environment]::GetFolderPath('Desktop')` 获取：OneDrive 重定向 / 系统语言非英文时 `%USERPROFILE%\Desktop` 可能不存在或不对（踩坑 #16）
   - 图标：默认 electron.exe 图标即可；想换成桌宠图标可 `.IconLocation = "<项目>\assets\tray.png, 0"`
   - 与开机自启的区别：桌面快捷方式 = 双击手动启动；开机自启 = 登录自动启动；两者互不替代、可同时存在

4. **`startHidden` 模式（本轮新增配置）**：
   - `config.json`：`"startHidden": true`；`main.js` 的 `DEFAULT_CONFIG` 默认 `false`（保持旧行为：启动即显示）
   - 逻辑：`win.once('ready-to-show')` 中 `if (config.startHidden && !(lifeWatcher && lifeWatcher.present)) return;` → 不 show，窗口保持隐藏、托盘常驻
   - 行为：开机 → 不弹窗（托盘待命）；目标程序启动 → 出现；目标程序退出 → `hideDelayMs`(5s) 后隐藏
   - 时序注意：`ready-to-show` 可能早于首次进程检测完成，此时 `lifeWatcher.present` 仍为 false → 窗口先隐藏，靠 `started` 事件兜底显示（去抖 2×2s，最多约 4s 出现，属正常，不是 bug）
5. **CLI 版联动（实测，回答“你是 CLI 版也能实现吗”）**：进程检测用 `Get-Process -Name codex`，CLI 版（`codex.exe`，经 npm shim `codex.cmd` 拉起）的进程名同样是 `codex` → 检测完全通用，不区分桌面版/CLI 版；`Get-Process` 不区分大小写，`detectNames` 写一个即可
6. **重启 / 热更新姿势（实测）**：
   - 先停：`Get-Process electron | Where-Object { $_.Path -like 'D:\codex-pet*' } | Stop-Process -Force`（⚠️ 必须按项目路径过滤！裸 `Stop-Process -Name electron` 会误杀 VS Code 等其他 Electron 应用）
   - 再启：`Start-Process 'D:\codex-pet\node_modules\electron\dist\electron.exe' -ArgumentList 'D:\codex-pet' -WorkingDirectory 'D:\codex-pet'`
   - 验证：看 `%APPDATA%\codex-pet\codex-pet.log` 是否出现 `[life] Codex started / stopped`、`[state] ...`
7. **改代码前先备份**：`main.js` / `config.json` 等改动前 copy 一份 `.bak`（本轮留了 `main.js.bak`、`config.json.bak`、`PROMPT.md.bak`），出问题秒回滚

### Phase 4 —— 状态扩展 + 提醒功能（B+C 方向，2026-08-08）
1. **动态详情（B）**：桌宠不只是切状态，还要显示“正在干什么”
   - `state-watcher.js` 为每个工具调用提取 `detail`：`shell_command` → `正在跑: <command>`（截断 60 字符）；`search` → `搜索: <query>`；`open_page` → `搜索: <url>`；`apply_patch` → `修改: <文件名列表>`（最多列 3 个 + “等 N 个文件”）；审批 → `需要你批准: <justification>`
   - ✅ **踩坑：Codex 新日志里 `apply_patch` 的补丁文本在 `payload.input`（纯文本），不在 `payload.arguments`！** `parseArgs()` 必须兼容 `arguments`（JSON 字符串/对象）和 `input`（纯文本/对象）两种来源，否则文件名单永远提取不到（实测兜底文案“正在写代码（补丁应用）”）
   - ✅ **同状态 detail 也要推送**：原 `setState` 只在状态变化时 emit，导致连续两条 `running`（不同命令）第二条 detail 被吞。改为 `state 未变 && detail 未变` 才跳过，emit 时带 `stateChanged` 标记
   - 渲染层：`detail` 不弹气泡（防刷屏），显示在状态标签下方的 `#detailLine` 小字（工作状态显示、空闲/沉睡隐藏）
2. **最近活动时间线（B）**：`pushTimeline(icon, text)` 记录最近 10 条工具活动（📝 改文件 / ⏳ 跑命令 / 🔎 搜索 / ⚠️ 审批 / 🤖 子智能体…），随 `state` 事件带出；`pet:timeline` IPC 可主动拉取；双击水母打开「详情面板」展示
3. **详情面板（B+C）**：双击水母打开（替代原来“双击只弹气泡”）：
   - 头部：当前状态 + detail；🕒 最近活动列表（最新在上）；⏰ 待办提醒列表（剩余分钟 + 单条可删）
   - 底部：快速提醒（5/15/30/60 分钟）+ 自定义分钟输入框（Enter 或 ＋）
   - ✅ **踩坑：块级作用域**。`pet.js` 里 Electron 分支（`if (IS_ELECTRON) {}`）内声明的 `function renderTimeline()` 等是块级作用域，顶层 `applyState()` 调用会 ReferenceError → 用顶层 `panelHooks` 对象在分支内注册、顶层调用，避免作用域问题
4. **提醒管理器（C）**：新增 `reminders.js`（纯 Node、无 Electron 依赖、可独立测试）
   - `ReminderManager`：`add(minutes, text)` / `addAt` / `remove` / `list` / `clear`，持久化到 userData `reminders.json`（重启桌宠不丢），`start()` 每秒检查到期
   - 到期：主进程发 `pet:reminder` IPC + 系统通知（`Notification`，`config.notify` 开关）→ 渲染层水母弹跳动画 + 气泡 + 音效
   - 入口：右键/托盘菜单「⏰ 提醒」（5/15/30/60 分钟 + 自定义 + 查看管理 + 清空）；面板内也可添加
   - 摸鱼提醒：`config.breakReminderMin`（默认 45 分钟，0=关闭），主进程递归 `setTimeout` 续期（避免长 interval 漂移），到点发 `kind: 'break'` 提醒
5. **菜单接线**：右键菜单与托盘菜单都加「⏰ 提醒」子菜单；「自定义分钟…」→ 发 `pet:askreminder` → 渲染层打开面板并聚焦输入框

## 四、项目结构（交付模板）

```
your-pet/
├─ package.json        # main: main.js; devDependencies: electron
├─ config.json         # 联动模式/检测名/音效/皮肤/大小
├─ main.js             # Electron 主进程（窗口/托盘/菜单/IPC/启停接入）
├─ preload.js          # contextBridge 桥接
├─ state-watcher.js    # 日志监听 + 状态机（纯 Node，--replay 可回放验证）
├─ codex-watcher.js    # 进程生命周期检测（--probe 可模拟测试）
├─ reminders.js        # 提醒管理器（纯 Node，--test 可自测；待办 + 摸鱼）
├─ launcher.js         # 可选守护进程（quit 模式用）
├─ assets/tray.png     # 托盘图标（PIL 生成）
└─ renderer/
   ├─ index.html       # 桌宠窗口（?gallery=1 画廊调试）
   ├─ style.css        # 透明背景 + pixelated + 状态标签
   ├─ jellyfish.js     # 像素角色绘制器（按用户确认的形象实现；默认水母，可整体替换）
   └─ pet.js           # 渲染层：状态应用/拖动/气泡/音效/画廊
```

## 五、测试清单（按序执行）

1. `node --check` 全部 JS 语法
2. `node state-watcher.js --replay <真实日志>` 回放验证状态推导（✅ 能看出每个状态对应的日志事件）
2.5 `node reminders.js --test` 提醒自测（添加 0.05 分钟提醒，验证到期触发 + 持久化）
3. 去抖单测：注入模拟探测器，验证"连续 2 次一致才触发、抖动不误报"
4. `electron . --smoke` 冒烟测试（自动退出，验证窗口/状态机/生命周期/托盘初始化无崩溃）
5. 真机验收：
   - [ ] 水母浮在右下角，可拖动，位置重启不丢
   - [ ] 目标程序干活时，状态跟着变（分析→写码→运行→完成）
   - [ ] 请求审批时，宠物进入"等待审批"状态
   - [ ] 关掉目标程序 → 宠物 5s 内消失；重开 → 4s 内出现
   - [ ] 托盘：显示/隐藏、手动状态、退出都正常
   - [ ] 音效随状态播放；`config.json` 改皮肤/大小后"重新加载"生效

   - [ ] 开机自启：启动文件夹存在 `Codex桌宠.lnk`；重启后桌宠进程在（startHidden 下托盘待命、不弹窗）
   - [ ] 桌面快捷方式：桌面存在 `Codex桌宠.lnk` 且双击能直接拉起桌宠（无需进目录 npm start）
   - [ ] 启停联动：启动目标程序 → ≤4s 出现；退出 → 5s 隐藏（看 `%APPDATA%\codex-pet\codex-pet.log` 的 `[life] Codex started/stopped`）
   - [ ] CLI 版（非桌面版）同样能联动：进程名 `codex` 即被检测到

## 六、踩坑速查（血泪经验，直接抄）

| # | 坑 | 现象 | 解法 |
|---|---|---|---|
| 1 | 状态机 switch 用错标签 | 只有碰巧同名的状态有特效 | case 用状态名或统一走 `st.fx` 分发 |
| 2 | 浮点坐标 fillRect | 1px 细线消失（被抗锯齿半透明混合） | 所有 fillRect 坐标 `Math.round()` |
| 3 | 窗口抢焦点 | 用户输入被打断/输入框出现异常文本 | `showInactive()` 显示；不主动 focus |
| 4 | 默认窗口位置随机 | 挡住目标程序输入框 | 默认贴屏幕右下角 |
| 5 | console.log 刷屏 | 污染用户终端 | 日志写 userData 文件 |
| 6 | tasklist /FI 被拒 | Access denied | 用 PowerShell `Get-Process` |
| 7 | 启动回放闪烁 | 打开瞬间状态乱跳 | 回放静默，结束后一次性发状态 |
| 8 | 单实例冲突 | 旧实例占锁导致新实例秒退 | `app.requestSingleInstanceLock()` + 启动前先停旧实例 |
| 9 | 长命令被误判空闲 | 日志不增长但宠物回空闲 | 工作状态不被静默阈值回落 |
| 10 | 无头截图验证 | 无法肉眼确认渲染 | `msedge --headless=new --screenshot` + PIL 像素统计 + 视觉模型质检 |
| 11 | 以为“会自动出现” | 开机后桌宠没影 | 自启动要显式注册：启动文件夹 .lnk（Target=electron.exe，Args=项目目录） |
| 12 | 受限环境写 Startup | WScript.Save 抛 UnauthorizedAccessException | 提权执行；或改用注册表 HKCU\...\Run |
| 13 | startHidden 开机不弹窗 | 用户以为坏了 | 预期行为：托盘待命，检测到目标进程才显示（去抖 ≤4s） |
| 14 | 重启桌宠误杀其他 Electron | VS Code 等被 Stop-Process 全杀 | 按进程路径过滤 `<项目>*` 再 Stop-Process |
| 15 | ready-to-show 早于首次检测 | startHidden 下窗口晚约 4s 才出现 | 正常时序，靠 started 事件兜底显示 |
| 16 | `%USERPROFILE%\Desktop` 不存在 | 快捷方式建错位置（OneDrive / 系统重定向） | 用 `[Environment]::GetFolderPath('Desktop')` 获取真实桌面路径 |
| 17 | `apply_patch` 参数在 `payload.input` | 文件名单提取不到（一直显示兜底文案） | `parseArgs()` 兼容 `arguments` 与 `input` 两个字段 |
| 18 | 同状态 detail 被吞 | 连续两条 `running` 只显示第一条命令 | `setState` 改为“状态与 detail 都未变才跳过”，并带 `stateChanged` 标记 |
| 19 | 块内函数顶层不可见 | `applyState` 调 `renderTimeline` ReferenceError | 顶层 `panelHooks` 注册/调用，避免块级作用域坑 |
| 20 | 沙箱/受限环境建新目录失败 | `New-Item features` Access denied | 新模块先放项目根（与 state-watcher.js 平级），二期多 Agent 再统一目录 |
| 21 | 透明窗口整块矩形拦截鼠标 | 桌宠四周（尤其下方）点不动下层窗口 | `setIgnoreMouseEvents(true,{forward:true})` + 渲染层 `elementFromPoint` 命中检测，仅画布/面板接收鼠标 |

## 七、扩展建议（做成"你自己的"）

- **换形象**：开发前先问用户想要的形象；后续想换只需重写 `renderer/<角色>.js` 的绘制函数（保持 `Role.draw(ctx, state, t)` 接口）
- **换目标程序**：改 `config.detectNames`（进程名）+ `state-watcher.js` 的日志目录与事件映射（先分析它的日志格式再写映射）
- **加状态**：`STATE_META` 加一行 + 角色绘制器加眼睛/嘴/特效参数 + 菜单/托盘同步
- **多语言**：气泡文案集中在一个表里，方便本地化
