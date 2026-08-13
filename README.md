# 🪼 Codex / OpenCode / Claude Code 像素水母桌宠

一只悬浮在桌面角落、会**真实反映 Codex、OpenCode 与 Claude Code 工作状态**的像素风小水母。
三个 CLI 可同时联动：谁在干活就显示谁（LRU 最后活跃者优先，详见下文「三 CLI 联动」）。

> 🐾 **形象可自定义**：本项目的开发 Prompt（[PROMPT.md](PROMPT.md)）要求开工前先询问你想要什么**像素风**形象（水母 / 小猫 / 小狗 / 狐狸 / 幽灵 / 机器人 / 恐龙 / 蘑菇…，未指定默认水母），所以随时可以让 AI 按它重做一个你喜欢的角色。

## 运行

```bash
cd D:\codex-pet
npm install        # 首次需要（下载 Electron）
npm start          # 启动桌宠
```

> 💡 **已配置开机自启**：启动文件夹里的 `Codex桌宠.lnk` 会在登录后自动拉起桌宠（`startHidden` 下先藏在托盘、不弹窗）。删除该快捷方式即可取消自启。
> 💡 **桌面快捷方式**：桌面已固定创建 `Codex桌宠.lnk`，双击即可启动（等价 `npm start`），详见下文「桌面快捷方式」。
> 💡 **默认只跟随 CLI 出现**（`config.json` 的 `startHidden: true`）：启动后先在托盘待命，检测到 Codex / OpenCode / Claude Code 任一进程才显示；全部退出 5 秒后自动隐藏。想恢复“启动即显示”，把 `startHidden` 改为 `false`。

### 桌面快捷方式（默认已创建）

本项目交付时会在桌面**固定创建** `Codex桌宠.lnk`，双击即可启动（等价 `npm start`），无需每次进目录敲命令。快捷方式丢失或被删除时，用下面命令一键重建：

```powershell
$desktop = [Environment]::GetFolderPath('Desktop')   # 自动获取真实桌面（兼容 OneDrive 重定向）
$lnk  = Join-Path $desktop 'Codex桌宠.lnk'
$ws   = New-Object -ComObject WScript.Shell
$s    = $ws.CreateShortcut($lnk)
$s.TargetPath       = 'D:\codex-pet\node_modules\electron\dist\electron.exe'
$s.Arguments        = '"D:\codex-pet"'
$s.WorkingDirectory = 'D:\codex-pet'
$s.Save()
```

双击桌面的 **Codex桌宠** 即可启动桌宠；删除该快捷方式不影响开机自启。


## 交互

- **拖动**：按住水母拖动到任意位置（位置会被记住）
- **单击**：戳一戳冒气泡
- **双击**：打开**独立面板窗口**（桌宠旁，可拖动/缩放，标签页切换最近活动 / 待办提醒，详见下文「状态详情与提醒」）
- **右键**：手动切换状态 / 回到自动联动 / 重新加载 / 退出
- **右键 ⏰ 提醒**：💧 喝水 / 🚶 走一走 快捷提醒、自定义内容、5/15/30/60 分钟、查看管理、清空全部
- **右键 🎨 外观主题**：蓝紫（默认）/ 樱花粉 / 海洋蓝 一键切换（写入 config.json 持久化）
- **托盘**：右下角托盘图标常驻；双击显示/隐藏，右键可手动切状态/设置提醒/退出
- **透明区域不挡鼠标**：桌宠只在画布/详情面板上接收鼠标，四周透明区域（尤其下方）会点击穿透到下层窗口

## 状态详情与提醒（B+C 拓展）

### 🕒 动态详情
桌宠状态标签下方会实时显示"正在干什么"（不弹气泡、不打扰）：

| 状态 | 详情示例 |
|---|---|
| 💻 写代码中 | `📝 修改: main.js, config.json 等 3 个文件` |
| ⏳ 运行中 | `正在跑: npm test` |
| 🔍 搜索中 | `搜索: Codex API 文档` |
| ⚠️ 等待审批 | `需要你批准：允许我下载依赖…` |
| 🤖 分析中 | `协调子智能体…` |

### 🕒 最近活动时间线
双击水母打开详情面板，可以看到最近 **10 条**工具活动（改文件/跑命令/搜索/审批/子智能体），最新在最上。

### ⏰ 待办提醒
- **添加**：右键 → `⏰ 提醒`（5/15/30/60 分钟 / 自定义）；或双击水母在面板底部快速添加
- **到点**：水母弹跳 + 气泡 + 音效 + 系统通知（`config.json` 的 `notify` 可关）
- **持久化**：提醒存 `%APPDATA%\codex-pet\reminders.json`，重启桌宠不丢
- **管理**：面板内可单条删除；右键菜单可清空全部

### 🚶 摸鱼提醒
`config.json` 的 `breakReminderMin`（默认 `45` 分钟）到点提醒你起来活动；设为 `0` 关闭。
`breakReminderText` 可自定义摸鱼提醒文案（默认 `🚶 起来活动一下，喝口水吧～`）。

## 自定义形象

当前形象是像素小水母（默认）。想换一个像素风角色：

- **最小改动**：重写 `renderer/jellyfish.js` 的绘制函数（保持 `Jellyfish.draw(ctx, state, t)` 接口即可，`pet.js`、状态动画、菜单都不用动）
- **重新生成**：把 [PROMPT.md](PROMPT.md) 发给 AI，它会先问你想要什么形象再开发（保持像素风：Canvas 程序化像素画 + `image-rendering: pixelated`）

## 状态联动（Codex：`~/.codex/sessions/**/rollout-*.jsonl`；OpenCode：`opencode.log` + `prompt-history.jsonl`；Claude Code：`~/.claude/projects/**/*.jsonl`）


| 状态 | Codex 日志信号（`rollout-*.jsonl`） | OpenCode 日志信号（`opencode.log` + `prompt-history.jsonl`） | Claude Code 日志信号（会话 `.jsonl`） |
|---|---|---|---|
| 🛋️ 空闲 | 60s 无新事件 | 60s 无新事件 | 60s 无新事件 |
| 👂 收到指令 | `user_message` 事件 | `prompt-history.jsonl` 新增输入 | `user` 行文本输入（`origin.kind=human`） |
| 🧠 分析中 | `task_started` / `reasoning` / `agent_message` / 工具结果处理 | `message=stream` / `permission=read/task/todowrite/skill` | `assistant` 的 `thinking`/`text` 块、`tool_result`、`Agent` 工具、`turn_duration` 带 `pendingBackgroundAgentCount` |
| 💻 写代码中 | `custom_tool_call: apply_patch` | `permission=edit` / `touching file` | `tool_use`: Edit / Write / MultiEdit / NotebookEdit |
| ⏳ 运行中 | `function_call: shell_command` | `permission=bash`（含命令详情） | `tool_use`: Bash / PowerShell（含命令详情） |
| 🔍 搜索中 | `search` / `open_page` / `find_in_page` | `permission=websearch/webfetch/grep/glob` | `tool_use`: Read / Grep / Glob / WebSearch / WebFetch |
| ✅ 完成 | `task_complete`（8s 后回落空闲） | `exiting loop`（8s 后回落空闲） | `turn_duration` 且上一 assistant 行 `stop_reason=end_turn`（8s 后回落空闲） |
| ⚠️ 等待审批 | 工具调用带 `require_escalated` / `justification` | `message=asking`（`per_`=批准 / `que_`=回答） | `AskUserQuestion` 工具（直接）；或需授权工具无结果超时 `approvalAfterMs`（默认 20s） |
| 💤 沉睡 | 15 分钟无任何事件 | 15 分钟无任何事件 | 15 分钟无任何事件 |

> ⚠️ **Claude Code 审批的局限**：其日志没有审批信号（等待批准时日志停更，与长命令无法区分），只能用超时启发式——需授权工具（Bash/Edit/…）调用后 `approvalAfterMs` 内无结果即判定“等待审批”。已批准的长命令同样静默，可能误显示“等待审批”，工具结果返回后自动恢复；`approvalAfterMs: 0` 可关闭该启发式。

> 状态详情会带上来源标记：🅒 = Codex，🅞 = OpenCode，🄲 = Claude Code。

## 三 CLI 联动（LRU 最后活跃者优先）

`config.json` 的 `activeSource: "auto"` 时，三个 CLI 同时运行由**最后活跃者优先**：

1. 谁最后有真实工作事件（分析/写代码/运行/搜索/审批/完成），水母就显示谁
2. 空闲 / 沉睡**不抢占**对方；当前源空闲时，若另一个正在干活会自动切过去
3. 详情行前缀标记来源（🅒 Codex / 🅞 OpenCode / 🄲 Claude Code），时间线同样来自当前活跃源
4. 也可固定只监听一个：`activeSource: "codex"` / `"opencode"` / `"claude"`

逻辑在 `source-router.js`（纯 Node，`npm run router-test` 自测）。

## 调试工具

```bash
npm run watch      # 终端实时查看状态机推导结果（无需启动桌宠）
npm run replay -- <rollout文件>   # 回放历史日志，验证状态推导
npm run opencode-watch   # 实时查看 OpenCode 状态推导（无需启动桌宠）
npm run opencode-replay -- <opencode.log>  # 回放 OpenCode 日志验证状态推导
npm run claude-watch     # 实时查看 Claude Code 状态推导（无需启动桌宠）
npm run claude-replay -- <会话.jsonl>  # 回放 Claude Code 会话日志验证状态推导
npm run claude-test      # Claude Code 状态机自测
npm run router-test      # 多源 LRU 切换逻辑自测
npm run state-test       # Codex 状态机自测（node state-watcher.js --test）
npm run opencode-test    # OpenCode 状态机自测（node opencode-watcher.js --test）
npm run preview    # 浏览器打开动画原型（画廊模式 ?gallery=1）
npm run remind-test # 提醒模块自测（node reminders.js --test）
```

> 🔄 **配置热更新**：修改 `config.json` 后无需重启桌宠，约 0.3 秒后自动生效（皮肤 / 音效 / 状态标签 / 缩放 / 检测进程名 / 轮询间隔 / 摸鱼提醒等）。桌宠日志超过 2MB 会自动轮转保留 `.1`。

## 配置（config.json）

| 键 | 说明 | 当前值 |
|---|---|---|
| `followMode` | `hide`：Codex 退出后隐藏窗口（托盘常驻）；`quit`：随 Codex 退出 | `hide` |
| `startHidden` | `true`：启动先隐藏，检测到 Codex 才显示；`false`：启动即显示 | `true` |
| `detectNames` | 要检测的进程名（任一存在即显示桌宠） | `["codex", "Codex", "opencode", "claude"]` |
| `activeSource` | `auto`：三 CLI 最后活跃者优先；`codex` / `opencode` / `claude`：固定只监听一个 | `auto` |
| `pollMs` / `debounceTicks` | 进程检测轮询间隔 / 去抖次数 | `2000` / `2` |
| `hideDelayMs` | Codex 退出后延迟隐藏窗口的毫秒数 | `5000` |
| `scale` | 桌宠大小倍率 | `1.0` |
| `theme` | 皮肤（default/sakura/ocean…） | `default` |
| `sound` / `showStatusLabel` | 音效 / 状态标签开关 | `true` |
| `notify` | 提醒到点是否发系统通知 | `true` |
| `breakReminderMin` | 摸鱼提醒间隔（分钟），`0` 关闭 | `45` |
| `breakReminderText` | 摸鱼提醒文案（可自定义） | `🚶 起来活动一下，喝口水吧～` |
| `approvalAfterMs` | Claude Code 审批启发式超时（毫秒），`0` 关闭 | `20000` |

## 目录


```
codex-pet/
├─ package.json       # 启动脚本 / 依赖（electron）
├─ PROMPT.md          # 可复现的开发 Prompt（含"先问形象"要求）
├─ config.json        # 联动模式 / 检测名 / 音效 / 皮肤 / startHidden
├─ main.js            # Electron 主进程（透明置顶窗口、菜单、位置记忆、启停联动）
├─ preload.js         # 安全桥接
├─ state-watcher.js   # 日志监听 + 状态机（纯 Node，可独立测试）
├─ opencode-watcher.js# OpenCode 日志监听 + 状态机（纯 Node，可独立测试）
├─ claude-watcher.js  # Claude Code 会话日志监听 + 状态机（纯 Node，可独立测试）
├─ source-router.js   # 多源 LRU 路由（谁在干活显示谁，--test 自测）
├─ codex-watcher.js   # 进程生命周期检测（纯 Node，--probe 可模拟）
├─ reminders.js       # 提醒管理器（纯 Node，--test 可自测；待办 + 摸鱼）
├─ launcher.js        # 可选守护进程（followMode=quit 时用）
├─ assets/tray.png    # 托盘图标
└─ renderer/
   ├─ index.html      # 桌宠窗口页面（?gallery=1 画廊调试）
   ├─ style.css
   ├─ jellyfish.js    # 像素水母绘制器（可换成任意像素形象）
   └─ pet.js          # 渲染层逻辑
```

## 路线图

- ✅ Phase 0：像素水母 + 状态动画
- ✅ Phase 1：Electron 透明置顶窗口 + 真实日志联动 + 拖动/菜单
- ✅ Phase 2：音效、托盘图标、开机自启（启动文件夹 .lnk）、多皮肤
- ✅ Phase 3（2026-08-05）：startHidden —— 开机托盘待命、仅 Codex 运行时出现；CLI 版同样联动
- ✅ Phase 4（2026-08-08）：状态扩展 —— 动态详情（正在跑什么/改哪个文件）+ 最近活动时间线 + 详情面板
- ✅ Phase 4（2026-08-08）：提醒功能 —— 待办提醒（持久化/系统通知/弹跳动画）+ 摸鱼提醒
- ✅ Phase 5（2026-08-09）：OpenCode 兼容 —— 新增 `opencode-watcher.js` 并行监听 + `source-router.js` LRU 双源切换（🅒/🅞 来源标记）
- ✅ Phase 6（2026-08-13）：Claude Code 兼容 —— 新增 `claude-watcher.js` 并行监听（`~/.claude/projects` 会话日志）+ 路由推广为三源 LRU（🄲 来源标记）+ 审批超时启发式
