# AGENT.md — deepseek-balance-glass-panel 维护与开发指南

本文件面向在本目录工作的 AI 编码助手（以及接手维护的人）。修改前先读这里，避免踩已知的坑。

## 这是什么

`deepseek-balance-glass-panel` 是 DeepSeek Harness（DSH）的一个 **bundle 插件包**：在 DSH Web / Desktop 界面右下角显示一个 macOS 风格毛玻璃面板，展示 DeepSeek 余额、今日/本次会话花销（峰谷拆分）、Token 用量与当前任务。

- 宿主半（Node）：`lib/index.js` 里的 `apply(ctx)`，跑在 DSH host 进程（**完整 Node 环境**，有全局 `fetch`、`node:fs`、`os.homedir()`）。
- 客户端半（浏览器）：`lib/index.js` 里的 `WIDGET_JS` 模板字符串，是一段**自包含 vanilla JS**（无 React、无构建），通过 `webServer` 路由 `/dsh-glass/widget.js` 下发；页面通过 **结构化 index 注入**（`webserver/index-inject` 的 `script-src` 行）加载它。**不要用 `webServer.tapIndex` 注入本 widget**：DSH Desktop 的 `dsh-app://app/` 文档不经过 `webServer.renderIndex`，raw tap 会被忽略（这是桌面端曾经看不到面板的根因）。

## 挂载方式

- `package.json` 的 `dsh.bundle.patch` 指向 `./cordis.patch.yml`。
- `cordis.patch.yml` 只做一件事：把 `id/name` 为 `deepseek-balance-glass-panel` 的行 insert 进当前 profile。
- **profile 必须和运行端一致**：DSH Desktop 用 `desktop`，`dsh web` 用 `web`。桌面端默认加载 `desktop` profile，装到 `web` 不会出现。
- **`desktop` profile 由桌面应用独占管理**：普通 `dsh plugin --profile desktop ...` 会报 `profile "desktop" is managed exclusively by the Electron application`，`dsh --profile desktop --dump-config` 同样不可用。DSH Desktop 请用「设置 → 插件」或 `plugin_manager`（`install_bundle`/`remove_bundle`，target 为本目录绝对路径）；`dsh web` 才用 `dsh plugin --profile web add link:<本目录绝对路径>`（发布 npm 后同理）。
- **不要手写 profile 的 `package.json`/`cordis.patch.yml`，也不要在 profile 里手动跑 pnpm**；安装/卸载交给插件管理器。

## 页面注入机制（dsh web / DSH Desktop）

- DSH Desktop 主窗口加载的是 `dsh-app://app/`：桌面进程 `serveWebDocument` 只从 dist 读 index，并把 **Host 启动时**收集的 `injections` 通过 `dsh-desktop:boot` IPC 交给渲染器；渲染器 boot 再逐行应用。它**不会**调用 `webServer.renderIndex`，所以 `tapIndex` 在桌面端完全无效。
- 正确做法：`ctx.on('webserver/index-inject', table => table.push({ kind:'script-src', placement:'body', src:'/dsh-glass/widget.js' }))`。`dsh web` 的 `renderIndex` 与桌面 boot 都应用 `script-src` 行。
- 桌面 `dsh-app://app/` 协议会把非静态路径（含 `/dsh-glass/widget.js`、`/dsh-glass/stats.json`）带 Host cookie 转发到 Host HTTP 服务，所以 widget 用**相对 URL**即可同时兼容两端；不要写成绝对 `http://127.0.0.1:<port>`（端口每次启动不同）。
- **桌面壳在 Host 启动时缓存 `injections`**：更新插件 host 代码后，仅刷新页面不够，必须完全重启 DSH Desktop（让 Host 重新 start 并重新收集注入）；页面刷新只会拿到旧的缓存注入。
- `/dsh-glass/health` 返回 `{ok:true,injected:true}` 表示当前 Host 的注入表已包含 widget 行；这是排查桌面端不显示的第一入口。

## 宿主半的关键约定

- 导出 `export { name, inject, apply }`；为了 `test/` 直接导入，另导出 `isPeakTime`、`isBeijingHoliday`、`PRICE`（加载器只使用前三个）。
- `inject = ['webServer', 'credentials']` 是**硬依赖**；`sessions` / `sessionProjections` / `sessionQuery` / `deepseekAccount` 用 `ctx.get(...)` 按**可选**读取，全部判空（保证某些精简部署里缺失这些服务时插件仍能显示余额 + 今日花销）。
- 所有副作用都要登记到 `disposers`，最后由 `ctx.effect(() => () => disposers.forEach(d => d()))` 回收：`webServer.register`、`webServer.tapIndex`、`ctx.on('session/event', ...)` 的返回值都是 disposer。
- 余额：先 `ctx.credentials.resolve('DEEPSEEK_API_KEY')` → `cred.value`；`fetch(BALANCE_URL, { headers: { Authorization: 'Bearer ' + cred.value }, signal: AbortSignal.timeout(20000) })`。只有 API key 未配置或请求失败时，才用 `ctx.get('deepseekAccount')` 的 `getBalance({ version, locale: 'zh_CN', timezoneOffsetSeconds })` 兜底（充值钱包 + 赠送钱包按币种求和，优先 CNY，8 秒超时）；再失败才回退 `ledger.lastBalance` 并带 error 提示。**API key 成功时不要查账户余额**。余额 payload 的 `source` 为 `api` / `account` / `ledger`。
- 今日花销：**全部会话今日用量之和**（全局累计器 `globalToday`，key 为 `${sid}:${turn}:${step}` 防跨会话碰撞，replace 语义防重复计数），按当前（自定义）价格计价（`computeToday` 的 `local` 分支，自定义价格立即生效）；仅当全局今日无任何 token 数据时回退**余额差值记账**（`applyLedger(current)` 每次成功观测后执行——同日余额下降则 `todayUsage += 差值`；跨天归零重开。持久化到 `~/.dsh/.dsh-glass-usage.json`），并在响应里带 `error` 提示。不要把余额差值当作今日主源——它依赖「扣款发生在观测窗口内」，跨天/重启/外部模型（余额不动）时恒为 0。
- **今日冷读回填 `backfillToday()`**：每日一次（`todayBackfillDay` 守卫），用 `sessionQuery.listSessions()` 枚举全部会话（newest-first，上限 50），`sync()` 逐会话重放事件补进 `globalToday`，覆盖「插件未运行时发生的用量」；并发 4 路、`getStats` 里 `Promise.race` 最多等 3 秒（超时后台继续、下轮补全）。`sessionQuery` 缺失时无回填，今日 = 插件运行期间的实时累计。
- 当前会话跟踪：**widget 每次请求把浏览器当前选中的会话经 `sid` 参数上报**（读取 DSH 客户端运行时持久化的 `localStorage['dsh.sessions.current']` 的 `sessionId`）。宿主 `getStats(force, price, sid)` 里 `targetSid = sid || currentSid`：有 `sid` 用 widget 上报的（即用户正在看的会话），缺失才回退 `currentSid`（最近活跃，`ctx.on('session/event')` 只维护兜底值，**不再**在该处 `persistSid`）。`~/.dsh/.dsh-glass-state.json` 的 `lastSid`/快照由 `getStats` 以 `targetSid` 写入（10 秒节流），**插件重启后恢复的就是用户最近查看的会话**，配合 `sync()` 冷读/投影，会话花销、tokens、任务在重启后不归零。
- 会话花销按**投影 tokenUsage 全量计价**：事件累计只覆盖插件加载后的近端事件，峰谷比例取事件、总额取投影（权威全量），避免压缩/重启后低估。
- 记账种子：启动时优先读 `~/.dsh/.dshw-usage.json`（小鲸鱼挂件），若其 `date === 今天` 则接续 `todayUsage`；否则读自己的 `.dsh-glass-usage.json`；都没有则从 0 开始。**两个文件彼此独立写入，不会互相覆盖**。
- 会话统计：`ctx.on('session/event', ...)` 按会话维护 `(turn:step)` 折叠 usage（复刻 token-meter 的 replace 语义，避免重复计数），并维护兜底 `currentSid`。`todo/write` 事件持久记录最新清单到 `e.todos`（**不要**依赖 `todos` 投影——它会在下一个 `turn/start` 被清空成 null）。`applyEvent(e, event, sid)` 的今日桶（每会话与 `globalToday`）只**向前**滚动（`day > key` 才清空重建），冷读重放昨日事件不会污染今日。

## 峰谷定价（2026-10-17 官网同步）

- `PEAK_HOURS = [[9,12],[14,18]]`（北京时间）。
- `PRICE = { hit:[0.02,0.04], miss:[1,2], out:[4,8] }`（元/百万 token，`[闲时, 高峰]`），对应 `deepseek-flash`。**官方 2026-09-10 12:00 起生效，2026-10-17 V4.1-Flash-1017 价格未变**；高峰 = 闲时 × 2。
- `CHINA_HOLIDAY_RANGES`：2026 年国务院放假安排全段（元旦、春节、清明、劳动节、端午、中秋、国庆）。**周末与法定节假日全天空闲**；`FIXED_STATUTORY_MMDD` 是 01-01、05-01、05-02、10-01～10-03 的固定公历法定日兜底。
- `isPeakTime(ms)`：北京时间为周六/周日 → false；`isBeijingHoliday` → false；否则小时落在 `PEAK_HOURS` 才 true（12:00/18:00 整点归闲时）。**不要再把周末做成“某个日期之后才空闲”的日期门**：官网当前规则没有该条件。
- 官方调价时改 `PRICE`，客户端 `PRESETS` 也要同步改（`test/pricing.test.mjs` 会校验两份默认价一致）；改时段改 `PEAK_HOURS`；改节假日改 `CHINA_HOLIDAY_RANGES`/`FIXED_STATUTORY_MMDD`。
- 2027 年放假通知发布后，把全年放假段补进 `CHINA_HOLIDAY_RANGES`；固定公历日已兜底，但春节/清明/端午/中秋等农历节日在通知前无法准确判定。
- 历史事件一律按**当前价格**估算（面板既有口径）；不要声称历史账单精确。

## 客户端半（WIDGET_JS）的关键约定

- **纯 vanilla JS，禁用 React/JSX/构建**；不要用反引号模板字符串或 `${}` 写业务代码（它们会与外层 `WIDGET_JS` 模板字符串冲突）。字符串一律单/双引号 + `+` 拼接，正则里的字面量点写成 `[.]`（或确保双反斜杠转义）。
- CSS 用字符串数组 `[...].join('\\n')` 组织（外层模板字符串把 `\\n` 解码成浏览器可用的 `'\n'`）。**改 CSS/正则时务必保持双反斜杠**，否则外层模板字符串会二次转义导致浏览器脚本损坏。
- 面板结构一次 `h()` 构建，动态值用保存的引用在 `render()` 里更新 `textContent`；展开/收起、主题、最小化、关闭都走 `applyPos/applyTheme/applyVisibility/render` 统一刷新。
- 状态记忆 key：`localStorage['deepseek-balance-glass-panel-v1']`；保存时带 `pricesVersion: 2`。
- **官方价与迁移**：`PRESETS = { flash, pro }`，`DEFAULT_PRICES` 取 `PRESETS.flash`；旧版默认价 `{hit:0.05, miss:1.5, out:4.5, peak:2}` 且没有 `pricesVersion: 2` 的存档会自动迁移到新默认价，用户真正自定义过的价格保留。客户端菜单的「官方价模型」只是快速填充，最终仍以保存的四个数值为准，请求 query 仍只带 `hit/miss/out/peak`。
- **余额币种**：`balance.currency === 'USD'` 时余额前缀显示 `$`，否则 `￥`；花销金额仍按 CNY 价格计算。
- 数据端点：`GET /dsh-glass/stats.json`（5 秒轮询，始终带 `?hit=&miss=&out=&peak=` 价格参数与 `&sid=<当前选中会话>`，`refresh=1` 强制刷新余额缓存）。`currentSid()` 每次请求前读取 `localStorage['dsh.sessions.current']`（DSH 客户端运行时维护，形如 `{"sessionId":"...","subagentAddress":{...}}`），无选中/解析失败返回空串、不带 `sid`（宿主回退最近活跃）。切换会话后 ≤5 秒（轮询周期）面板自动跟随。
- **价格菜单撑大面板**：`.gp-menu` 是绝对定位、不参与父容器高度，而 `.gp-root` 有 `overflow:hidden`，所以菜单弹出时 `applyPos` 必须显式把面板撑到 `menuBox.offsetHeight/Width + 边距`（高度 auto + minHeight、宽度不小于 菜单宽+26），关闭后缩回 `state.size`。**`render()` 里 `applyVisibility` 必须先于 `applyPos`**，否则量到的 offset 还是 0（display:none）。新增的「官方价模型」下拉在菜单里，菜单高度会变，但仍走同一套 `applyPos`。
- 深浅主题：监听 `document.body` 的 `data-ds-dark-theme` 属性（MutationObserver）。

## 修改后如何自检（不重启当前 DSH）

```powershell
# 0. 依赖：Node 22+（DSH Desktop 自带 node 也可）
node --version

# 1. 宿主 + 模板字符串整体语法
node --check lib/index.js

# 2. 峰谷/节假日/官方价/内嵌脚本自检
npm test
# 若在 DSH 沙箱里 `node --test test` 报 spawn EPERM，直接用：
node test/pricing.test.mjs
```

真实运行时验证（端口换成桌面窗口/GUI 实际端口；`dsh web` 默认 3080）：

```powershell
curl http://127.0.0.1:<端口>/dsh-glass/health
curl http://127.0.0.1:<端口>/dsh-glass/stats.json
curl http://127.0.0.1:<端口>/dsh-glass/widget.js
```

- `/dsh-glass/health` → 200，`{"ok":true,"injected":true}` 表示 Host 的 index 注入表已包含 widget 行；桌面端排查第一入口
- `/dsh-glass/stats.json` → 200，含 `balance`、`spend`、`today`、`tokens`、`isPeak`；`balance.source` 为 `api`/`account`/`ledger`
- `/dsh-glass/widget.js` → 200，`application/javascript`，含 `PRESETS`/`deepseek-v4-pro`/`pricesVersion`
- **完全重启 DSH Desktop** 后右下角出现面板；只刷新页面拿不到新的缓存注入

## 已知边界

- 动态插件（`cordis_define`/`cordis_run`）与本插件包是**两套不同机制**：前者进程内临时、跨重启即失；本插件包持久挂载。不要把动态插件的 sandbox 绕行（helper 文件 / subprocess）带进来——真实插件直接用 `fetch`/`node:fs`。
- 会话三行（本次花销、Token、任务）跟随**浏览器当前选中的会话**：widget 每次请求带上从 `localStorage['dsh.sessions.current']` 读出的 `sid` 参数（DSH 客户端运行时维护该 key，选中会话时写入、无选中/失效时清空）。宿主的 `getStats` 用 `sid` 优先，缺失时回退「最近活跃会话」。若未来 DSH 改动该 localStorage key，widget 会自动退化为「最近活跃」行为，不会报错。**「今日会话花销」是全局的**（全部会话累计），不随选中会话变化。
- 全局今日回填上限 50 个最新会话、每日一次、首请求最多等 3 秒；被压缩（compaction）会话的今日 token 可能略低估，此时若全局今日无任何 token 数据则走余额差值兜底。
- 面板 z-index 用 `2147483000`，与鲸鱼挂件同量级；如需调整层级改 WIDGET_JS 里的 `.gp-root/.gp-pill/.gp-reopen` 的 `z-index`。
- `link:` 安装指向本仓库目录；移动/删除目录会导致插件失效。`web` profile 里若还保留旧 GitHub 安装副本，它不会自动获得本目录的修改，需要另行 `link:` 重装或 `dsh plugin --profile web update`。
- 桌面端账户余额依赖 `deepseekAccount` 服务（Desktop 默认具备）；精简部署/`dsh web` 没有该服务时自动跳过，退回 API key 路径。
