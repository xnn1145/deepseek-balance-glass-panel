# AGENT.md — deepseek-balance-glass-panel 维护与开发指南

本文件面向在本目录工作的 AI 编码助手（以及接手维护的人）。修改前先读这里，避免踩已知的坑。

## 这是什么

`deepseek-balance-glass-panel` 是 DeepSeek Harness（DSH）的一个 **bundle 插件包**：在 DSH Web 界面显示一个 macOS 风格毛玻璃面板，展示 DeepSeek 余额、今日/本次会话花销（峰谷拆分）、Token 用量与当前任务。

- 宿主半（Node）：`lib/index.js` 里的 `apply(ctx)`，跑在 DSH host 进程（**完整 Node 环境**，有全局 `fetch`、`node:fs`、`os.homedir()`）。
- 客户端半（浏览器）：`lib/index.js` 里的 `WIDGET_JS`（**`String.raw` 模板字符串**），是一段**自包含 vanilla JS**（无 React、无构建），通过 `webServer` 路由 `/dsh-glass/widget.js` 下发，再用 `tapIndex` 注入 `<script defer src="/dsh-glass/widget.js">`。

## 挂载方式

- `package.json` 的 `dsh.bundle.patch` 指向 `./cordis.patch.yml`。
- `cordis.patch.yml` 只做一件事：把 `id/name` 为 `deepseek-balance-glass-panel` 的行 insert 进 web profile。
- 安装：`dsh plugin --profile web add link:<本目录绝对路径>`（本地）或发布 npm 后 `dsh plugin --profile web add deepseek-balance-glass-panel`。

## 宿主半的关键约定

- 导出必须是 `export const name / inject / apply`（ESM，`package.json` 有 `"type": "module"`）。
- `inject = ['webServer', 'credentials']` 是**硬依赖**；`sessions` / `sessionProjections` 用 `ctx.get(...)` 按**可选**读取，全部判空（某些精简部署里缺失这些服务时，插件仍能显示余额 + 今日花销）。
- 所有副作用都登记到 `disposers`，最后由 `ctx.effect(() => () => disposers.forEach(d => d()))` 回收：`webServer.register`、`webServer.tapIndex`、`ctx.on('session/event', ...)` 的返回值都是 disposer，`setInterval` 也要登记。
- 余额：`ctx.credentials.resolve('DEEPSEEK_API_KEY')` → `cred.value`；`fetch(BALANCE_URL, { headers: { Authorization: 'Bearer ' + cred.value }, signal: AbortSignal.timeout(8000) })`。失败时保留上次数据并写 `stats.error`（面板内显示）。
- 今日花销 = **余额差值记账**：`refreshBalance()` 每次成功观测后执行——同日余额下降则 `ledger.todayUsage += 差值`；跨天（`todayDateStr()` 变）则归零重开。持久化到 `~/.dsh-glass-usage.json`。
- 记账种子：启动时若自己账本不是今天，优先读 `~/.dshw-usage.json`（小鲸鱼挂件，同口径：余额差值），其 `date === 今天` 则接续 `todayUsage` 与 `lastBalance`；否则从 0 开始。**两个文件彼此独立写入，不会互相覆盖**。
- 会话统计：`ctx.on('session/event', ...)` 调 `applyEvent(e, event)` 把事件里的 tokens 累加进该会话条目（`states` Map，按 sid 记），并返回本次事件成本（元）累计进当日 `usagePeak / usageIdle` 拆分。`pullSession()` 再用 `sessionProjections.snapshot(cur)` 的 `tokenUsage` **覆盖** tokens 并重算成本（以快照为准）。
- 任务：`todo/write` 事件里带 `{todos:[...]}`，直接 `updateTask(todos)` 更新 `stats.task`（过滤 completed/done/cancelled 等，取第一个进行中的）。**不要**依赖 `todos` 投影——它会在下一个 `turn/start` 被清空。没有 todo 时，`pullSession()` 里的 goal 投影兜底：goal 存在且 phase 不是已完成/阻塞类，就把 objective 当作当前任务。
- 峰谷定价 `PRICE = { hit: {idle:0.05, peak:0.1}, miss: {idle:1.5, peak:3.0}, out: {idle:4.5, peak:9.0} }`（元/百万 token）；高峰时段 `PEAK_HOURS = [9,10,11,12,14,15,16,17]`（北京时间 9-12、14-18，`isPeakTime` 用 UTC+8 后取小时判断）。DeepSeek 调价时改这里。

## 客户端半（WIDGET_JS）的关键约定

- **纯 vanilla JS，禁用 React/JSX/构建**。`WIDGET_JS` 是 **`String.raw` 模板字符串**：反斜杠原样保留（CSS 拼接的 `'\n'` 在文件里写单反斜杠即可），但**绝不能在内部使用反引号 `` ` `` 或 `${}`**——它们会与外层模板字符串冲突。字符串一律单/双引号 + `+` 拼接。
- CSS 用字符串数组 `[...].join('\n')` 组织，最后拼成 `<style>` 注入 `document.head`。
- 面板用 `h(tag, attrs, children)` 构建（attrs 支持 `class/style/html/on*`）；`render()` 每次重建 body/foot 的行节点（简单粗暴，5 秒轮询量级足够）。
- 展开/收起用事件委托（`.gp-row[data-key]` 点击切换 `state.collapsed`）；拖拽/缩放用 `pointerdown/move/up`（window 级监听）。
- 状态记忆 key：`localStorage['deepseek-balance-glass-panel-v1']`（保存位置/尺寸/主题/展开状态）。
- 数据端点：`GET /dsh-glass/stats.json`，5 秒轮询（无缓存参数，余额刷新由 host 侧 30s 定时 + 事件节流驱动）。
- 主题：右上角按钮在 玻璃/深色/浅色 三档间循环（`data-theme` 属性），**不**跟随 DSH 界面主题。
- 关闭后右下角显示 📊 悬浮按钮（`.gp-fab`）可重新打开。

## 修改后如何自检（不重启当前 DSH）

```powershell
# 1. 宿主 + 模板字符串整体语法
node --check lib/index.js

# 2. 抽取 WIDGET_JS 单独解析（确认浏览器脚本本身无语法错误）
node -e "const fs=require('fs');const s=fs.readFileSync('lib/index.js','utf8');const a=s.indexOf('const WIDGET_JS = String.raw`')+'const WIDGET_JS = String.raw`'.length;const b=s.indexOf('`',a);new Function(s.slice(a,b));console.log('WIDGET_JS OK')"
```

真实运行时验证：`curl http://127.0.0.1:3080/dsh-glass/stats.json` 与 `curl http://127.0.0.1:3080/dsh-glass/widget.js`。

## 已知边界

- 动态插件（`cordis_define`/`cordis_run`）与本插件包是**两套不同机制**：前者进程内临时、跨重启即失；本插件包持久挂载。不要把动态插件的 sandbox 绕行（helper 文件 / subprocess）带进来——真实插件直接用 `fetch`/`node:fs`。
- 会话三行跟随 `sessions.current`（当前会话），不是浏览器里选中的会话（客户端拿不到会话 id 的全局句柄）。这是刻意简化，README 已注明。
- 面板 `z-index` 用 `999999`（`.gp-panel` 与 `.gp-fab`），如需调整层级改 WIDGET_JS 里的 CSS。
