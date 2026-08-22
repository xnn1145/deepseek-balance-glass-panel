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
- 今日花销 = **余额差值记账**：`applyLedger(current)` 在每次成功观测后执行——同日余额下降则 `todayUsage += 差值`；跨天（`todayDateStr()` 变）则归零重开。持久化到 `~/.dsh/.dsh-glass-usage.json`。
- 最近活跃会话：每次 `session/event` 把 `sid` 写入 `~/.dsh/.dsh-glass-state.json`（10 秒节流）；**插件重启后从这里恢复 `currentSid`**，配合 `sync()` 冷读/投影，让会话花销、tokens、任务在重启后不归零。
- 会话花销按**投影 tokenUsage 全量计价**：事件累计只覆盖插件加载后的近端事件，峰谷比例取事件、总额取投影（权威全量），避免压缩/重启后低估。
- 记账种子：启动时优先读 `~/.dsh/.dshw-usage.json`（小鲸鱼挂件），若其 `date === 今天` 则接续 `todayUsage`；否则读自己的 `.dsh-glass-usage.json`；都没有则从 0 开始。**两个文件彼此独立写入，不会互相覆盖**。
- 会话统计：`ctx.on('session/event', ...)` 维护「最近活跃会话」`currentSid`，并按 `(turn:step)` 折叠 usage（复刻 token-meter 的 replace 语义，避免重复计数）。`todo/write` 事件持久记录最新清单到 `e.todos`（**不要**依赖 `todos` 投影——它会在下一个 `turn/start` 被清空成 null）。
- 峰谷定价 `PRICE = { hit:[0.05,0.1], miss:[1.5,3.0], out:[4.5,9.0] }`（元/百万 token，[空闲,高峰]），高峰时段 `PEAK_HOURS = [[9,12],[14,18]]`（北京时间）。DeepSeek 调价时改这里。
- **自定义价格**：客户端右上角齿轮菜单把 输入/命中/输出 价格与高峰倍率存进 `localStorage['deepseek-balance-glass-panel-v1'].prices`，每次请求在 query 里带 `hit/miss/out/peak`；宿主用 `parsePriceParams(url)` 解析（非法值/缺省回落官方价，`peak` 把高峰列改为 闲时×倍率）后传入 `getStats(force, price)` → `snapshotStats(sid, e, price)`。**兜底快照存 token 桶（buckets/todayBuckets）而非算好的金额**，重启兜底时按当时价格重算，保证改了价格后各处金额一致。
- `hasLive` 判断**必须按 token 总量 > 0 或 todos/task 存在**，不能只看 `stats.tokens` 是否 truthy——重启后空会话的 tokens 是 `{0,0,0,0}` 对象（truthy），会把文件里的好快照覆盖成零快照。

## 客户端半（WIDGET_JS）的关键约定

- **纯 vanilla JS，禁用 React/JSX/构建**；不要用反引号模板字符串或 `${}` 写业务代码（它们会与外层 `WIDGET_JS` 模板字符串冲突）。字符串一律单/双引号 + `+` 拼接，正则里的字面量点写成 `[.]`（或确保双反斜杠转义）。
- CSS 用字符串数组 `[...].join('\\n')` 组织（外层模板字符串把 `\\n` 解码成浏览器可用的 `'\n'`）。**改 CSS/正则时务必保持双反斜杠**，否则外层模板字符串会二次转义导致浏览器脚本损坏。
- 面板结构一次 `h()` 构建，动态值用保存的引用在 `render()` 里更新 `textContent`；展开/收起、主题、最小化、关闭都走 `applyPos/applyTheme/applyVisibility/render` 统一刷新。
- 状态记忆 key：`localStorage['deepseek-balance-glass-panel-v1']`。
- 数据端点：`GET /dsh-glass/stats.json`（5 秒轮询，始终带 `?hit=&miss=&out=&peak=` 价格参数，`refresh=1` 强制刷新余额缓存）。
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
- 会话三行跟随「最近活跃会话」，不是浏览器当前选中的会话（客户端拿不到会话 id 的全局句柄）。这是刻意简化，README 已注明。
- 面板 z-index 用 `2147483000`，与鲸鱼挂件同量级；如需调整层级改 WIDGET_JS 里的 `.gp-root/.gp-pill/.gp-reopen` 的 `z-index`。
