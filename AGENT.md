# AGENT.md — deepseek-balance-glass-panel 维护与开发指南

本文件面向在本目录工作的 AI 编码助手（以及接手维护的人）。修改前先读这里，避免踩已知的坑。

## 这是什么

`deepseek-balance-glass-panel` 是 DeepSeek Harness（DSH）的一个 **bundle 插件包**：在 DSH Web 界面右下角显示一个 macOS 风格毛玻璃面板，展示 DeepSeek 余额、今日/本次会话花销（峰谷拆分）、Token 用量与当前任务。

- 宿主半（Node）：`lib/index.js` 里的 `apply(ctx)`，跑在 DSH host 进程（**完整 Node 环境**，有全局 `fetch`、`node:fs`、`os.homedir()`）。
- 客户端半（浏览器）：`lib/index.js` 里的 `WIDGET_JS` 模板字符串，是一段**自包含 vanilla JS**（无 React、无构建），通过 `webServer` 路由 `/dsh-glass/widget.js` 下发，再用 `tapIndex` 注入 `<script defer src="/dsh-glass/widget.js">`。

## 挂载方式

- `package.json` 的 `dsh.bundle.patch` 指向 `./cordis.patch.yml`。
- `cordis.patch.yml` 只做一件事：把 `id/name` 为 `deepseek-balance-glass-panel` 的行 insert 进 web profile。
- 安装：`dsh plugin --profile web add link:<本目录绝对路径>`（本地）或发布 npm 后 `dsh plugin --profile web add deepseek-balance-glass-panel`。

## 宿主半的关键约定

- 导出必须是 `export { name, inject, apply }`。
- `inject = ['webServer', 'credentials']` 是**硬依赖**；`sessions` / `sessionProjections` / `sessionQuery` 用 `ctx.get(...)` 按**可选**读取，全部判空（保证某些精简部署里缺失这些服务时插件仍能显示余额 + 今日花销）。
- 所有副作用都要登记到 `disposers`，最后由 `ctx.effect(() => () => disposers.forEach(d => d()))` 回收：`webServer.register`、`webServer.tapIndex`、`ctx.on('session/event', ...)` 的返回值都是 disposer。
- 余额：`ctx.credentials.resolve('DEEPSEEK_API_KEY')` → `cred.value`；`fetch(BALANCE_URL, { headers: { Authorization: 'Bearer ' + cred.value }, signal: AbortSignal.timeout(20000) })`。失败时回退 `ledger.lastBalance` 并带 error 提示。
- 今日花销：**全部会话今日用量之和**（全局累计器 `globalToday`，key 为 `${sid}:${turn}:${step}` 防跨会话碰撞，replace 语义防重复计数），按当前（自定义）价格计价（`computeToday` 的 `local` 分支，自定义价格立即生效）；仅当全局今日无任何 token 数据时回退**余额差值记账**（`applyLedger(current)` 每次成功观测后执行——同日余额下降则 `todayUsage += 差值`；跨天归零重开。持久化到 `~/.dsh/.dsh-glass-usage.json`），并在响应里带 `error` 提示。不要把余额差值当作今日主源——它依赖「扣款发生在观测窗口内」，跨天/重启/外部模型（余额不动）时恒为 0。
- **今日冷读回填 `backfillToday()`**：每日一次（`todayBackfillDay` 守卫），用 `sessionQuery.listSessions()` 枚举全部会话（newest-first，上限 50），`sync()` 逐会话重放事件补进 `globalToday`，覆盖「插件未运行时发生的用量」；并发 4 路、`getStats` 里 `Promise.race` 最多等 3 秒（超时后台继续、下轮补全）。`sessionQuery` 缺失时无回填，今日 = 插件运行期间的实时累计。
- 当前会话跟踪：**widget 每次请求把浏览器当前选中的会话经 `sid` 参数上报**（读取 DSH 客户端运行时持久化的 `localStorage['dsh.sessions.current']` 的 `sessionId`）。宿主 `getStats(force, price, sid)` 里 `targetSid = sid || currentSid`：有 `sid` 用 widget 上报的（即用户正在看的会话），缺失才回退 `currentSid`（最近活跃，`ctx.on('session/event')` 只维护兜底值，**不再**在该处 `persistSid`）。`~/.dsh/.dsh-glass-state.json` 的 `lastSid`/快照由 `getStats` 以 `targetSid` 写入（10 秒节流），**插件重启后恢复的就是用户最近查看的会话**，配合 `sync()` 冷读/投影，会话花销、tokens、任务在重启后不归零。
- 会话花销按**投影 tokenUsage 全量计价**：事件累计只覆盖插件加载后的近端事件，峰谷比例取事件、总额取投影（权威全量），避免压缩/重启后低估。
- 记账种子：启动时优先读 `~/.dsh/.dshw-usage.json`（小鲸鱼挂件），若其 `date === 今天` 则接续 `todayUsage`；否则读自己的 `.dsh-glass-usage.json`；都没有则从 0 开始。**两个文件彼此独立写入，不会互相覆盖**。
- 会话统计：`ctx.on('session/event', ...)` 按会话维护 `(turn:step)` 折叠 usage（复刻 token-meter 的 replace 语义，避免重复计数），并维护兜底 `currentSid`。`todo/write` 事件持久记录最新清单到 `e.todos`（**不要**依赖 `todos` 投影——它会在下一个 `turn/start` 被清空成 null）。`applyEvent(e, event, sid)` 的今日桶（每会话与 `globalToday`）只**向前**滚动（`day > key` 才清空重建），冷读重放昨日事件不会污染今日。
- 峰谷定价 `PRICE = { hit:[0.05,0.1], miss:[1.5,3.0], out:[4.5,9.0] }`（元/百万 token，[空闲,高峰]），高峰时段 `PEAK_HOURS = [[9,12],[14,18]]`（北京时间）。**官方峰谷规则调整（2026-08-23 00:00 北京时间起）**：周末（周六/周日）全天不再区分峰谷，统一按低谷（空闲）价——`isPeakTime` 里 `WEEKEND_FLAT_START_MS` 之前（含）的周六/周日仍按工作日峰谷计费，之后（含）的周末全天返回 false（低谷）。DeepSeek 调价时改 `PRICE`，改时段/周末规则改 `PEAK_HOURS` / `WEEKEND_FLAT_START_MS` / `isBeijingWeekend`。
- **自定义价格**：客户端右上角齿轮菜单把 输入/命中/输出 价格与高峰倍率存进 `localStorage['deepseek-balance-glass-panel-v1'].prices`，每次请求在 query 里带 `hit/miss/out/peak`；宿主用 `parsePriceParams(url)` 解析（非法值/缺省回落官方价，`peak` 把高峰列改为 闲时×倍率）后传入 `getStats(force, price, sid)` → `snapshotStats(sid, e, price)`。**兜底快照存 token 桶（buckets/todayBuckets）而非算好的金额**，重启兜底时按当时价格重算，保证改了价格后各处金额一致。
- `hasLive` 判断**必须按 token 总量 > 0 或 todos/task 存在**，不能只看 `stats.tokens` 是否 truthy——重启后空会话的 tokens 是 `{0,0,0,0}` 对象（truthy），会把文件里的好快照覆盖成零快照。

## 客户端半（WIDGET_JS）的关键约定

- **纯 vanilla JS，禁用 React/JSX/构建**；不要用反引号模板字符串或 `${}` 写业务代码（它们会与外层 `WIDGET_JS` 模板字符串冲突）。字符串一律单/双引号 + `+` 拼接，正则里的字面量点写成 `[.]`（或确保双反斜杠转义）。
- CSS 用字符串数组 `[...].join('\\n')` 组织（外层模板字符串把 `\\n` 解码成浏览器可用的 `'\n'`）。**改 CSS/正则时务必保持双反斜杠**，否则外层模板字符串会二次转义导致浏览器脚本损坏。
- 面板结构一次 `h()` 构建，动态值用保存的引用在 `render()` 里更新 `textContent`；展开/收起、主题、最小化、关闭都走 `applyPos/applyTheme/applyVisibility/render` 统一刷新。
- 状态记忆 key：`localStorage['deepseek-balance-glass-panel-v1']`。
- 数据端点：`GET /dsh-glass/stats.json`（5 秒轮询，始终带 `?hit=&miss=&out=&peak=` 价格参数与 `&sid=<当前选中会话>`，`refresh=1` 强制刷新余额缓存）。`currentSid()` 每次请求前读取 `localStorage['dsh.sessions.current']`（DSH 客户端运行时维护，形如 `{"sessionId":"...","subagentAddress":{...}}`），无选中/解析失败返回空串、不带 `sid`（宿主回退最近活跃）。切换会话后 ≤5 秒（轮询周期）面板自动跟随。
- **价格菜单撑大面板**：`.gp-menu` 是绝对定位、不参与父容器高度，而 `.gp-root` 有 `overflow:hidden`，所以菜单弹出时 `applyPos` 必须显式把面板撑到 `menuBox.offsetHeight/Width + 边距`（高度 auto + minHeight、宽度不小于 菜单宽+26），关闭后缩回 `state.size`。**`render()` 里 `applyVisibility` 必须先于 `applyPos`**，否则量到的 offset 还是 0（display:none）。
- 深浅主题：监听 `document.body` 的 `data-ds-dark-theme` 属性（MutationObserver）。

## 修改后如何自检（不重启当前 DSH）

```powershell
# 1. 宿主 + 模板字符串整体语法
node --check lib/index.js

# 2. 抽取 WIDGET_JS 单独解析（确认浏览器脚本本身无语法错误）
node -e "const fs=require('fs');const s=fs.readFileSync('lib/index.js','utf8');const a=s.indexOf('const WIDGET_JS = `')+'const WIDGET_JS = `'.length;const b=s.indexOf('`',a);new Function(s.slice(a,b));console.log('WIDGET_JS OK')"
```

真实运行时验证：`curl http://127.0.0.1:3080/dsh-glass/stats.json` 与 `curl http://127.0.0.1:3080/dsh-glass/widget.js`。

## 已知边界

- 动态插件（`cordis_define`/`cordis_run`）与本插件包是**两套不同机制**：前者进程内临时、跨重启即失；本插件包持久挂载。不要把动态插件的 sandbox 绕行（helper 文件 / subprocess）带进来——真实插件直接用 `fetch`/`node:fs`。
- 会话三行（本次花销、Token、任务）跟随**浏览器当前选中的会话**：widget 每次请求带上从 `localStorage['dsh.sessions.current']` 读出的 `sid` 参数（DSH 客户端运行时维护该 key，选中会话时写入、无选中/失效时清空）。宿主的 `getStats` 用 `sid` 优先，缺失时回退「最近活跃会话」。若未来 DSH 改动该 localStorage key，widget 会自动退化为「最近活跃」行为，不会报错。**「今日会话花销」是全局的**（全部会话累计），不随选中会话变化。
- 全局今日回填上限 50 个最新会话、每日一次、首请求最多等 3 秒；被压缩（compaction）会话的今日 token 可能略低估，此时若全局今日无任何 token 数据则走余额差值兜底。
- 面板 z-index 用 `2147483000`，与鲸鱼挂件同量级；如需调整层级改 WIDGET_JS 里的 `.gp-root/.gp-pill/.gp-reopen` 的 `z-index`。
