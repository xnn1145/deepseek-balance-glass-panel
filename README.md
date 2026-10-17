# DSH 余额面板（DeepSeek Balance Panel）

> 📦 项目地址：<https://github.com/xnn1145/deepseek-balance-glass-panel>

DeepSeek Harness（DSH）**Web / Desktop** 界面上的浮动 **macOS 风格毛玻璃面板**：DeepSeek 余额、今日/本次会话花销（峰谷拆分）、Token 用量与当前任务，随页面打开自动出现。本项目是标准 DSH 插件包，可通过 `dsh plugin` 安装/卸载。

> **桌面端用户注意**：DSH Desktop 默认加载 `desktop` profile，`dsh web` 加载 `web` profile。装错 profile 时插件不会出现在桌面端——请按下面「安装」里对应的 profile 安装。

## 功能

- 💰 **余额**：优先调用 `api.deepseek.com/user/balance`（`DEEPSEEK_API_KEY`）；桌面端没有 API key 但已登录 DeepSeek 账户时，自动改用账户余额（充值 + 赠送钱包）；30 秒缓存 + 手动刷新；接口失败时回退为「最近观测余额」并给出提示，不直接报错
- 📊 **今日会话花销**：按**全部会话今日 Token 用量之和 × 当前价格**实时估算（自定义价格立即生效；后台会话、子代理会话一并计入）；仅当全局今日无任何用量数据时回退为余额差值记账（与余额同一份账户，每次观测余额后按差值记账，持久化到 `~/.dsh/.dsh-glass-usage.json`，跨天自动归零）
- 🧾 **本次会话花销**：按当前选中会话事件实时统计，拆分为 **高峰时期用量 / 空闲时间用量**
- 🕐 **峰谷时段（2026-10-17 官网同步）**：高峰 = **北京时间周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00**；其余时段，包括**周末及法定节假日全天**均按闲时价（闲时价 = 高峰价的一半）。面板「现在是 峰 / 谷 时间」指示同样生效
- 🪙 **Token 用量**：本次对话的 缓存命中 / 未命中 / 输出
- ⚙️ **官方价预设 + 自定义价格**：右上角齿轮菜单可切换 `deepseek-flash` / `deepseek-v4-pro` 官方价，或按外部模型填写 输入/命中/输出 每 1M Token 的闲时价与高峰倍率（存 localStorage，重启不丢）；一键「重置官方价」
- 📝 **任务**：持久显示最后一次 `todo_write` 的清单（跨轮次保留，不随 turn 清空），无清单时回退到当前 goal
- 🎨 **macOS 风玻璃**：深浅色自动跟随 DSH 界面主题、展开项时面板自动向下
- 🖱️ **拖拽 + 角缩放**：单圆弧缩放手柄（面板在左半边则手柄在右下角，反之左下角）
- 💾 位置/尺寸/最小化/关闭状态记忆（localStorage）

> 会话相关行（本次花销、Token、任务）反映**浏览器当前选中的会话**——切换会话后面板在几秒内自动跟随，不受后台其他会话影响；「今日会话花销」则是**全部会话的累计**。

## 官方定价（2026-10-17 同步）

价格单位：**元 / 百万 tokens**；高峰价 = 闲时价 × 2。

| 模型 | 缓存命中（闲时 / 高峰） | 输入未命中（闲时 / 高峰） | 输出（闲时 / 高峰） |
| --- | --- | --- | --- |
| `deepseek-flash`（V4.1-Flash-1017） | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro` | 0.15 / 0.30 | 4.5 / 9.0 | 13.5 / 27.0 |

**峰谷规则**：北京时间周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天，均为空闲时段。

**2026 年法定节假日（按国务院放假安排全段）**：元旦 01-01～01-03；春节 02-15～02-23；清明 04-04～04-06；劳动节 05-01～05-05；端午 06-19～06-21；中秋 09-25～09-27；国庆 10-01～10-07。

**来源**：

- 模型 & 价格：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>
- 峰谷定价上线（2026-08-17 生效）：<https://api-docs.deepseek.com/zh-cn/news/news260813>
- V4.1 Flash 降价（2026-09-10 12:00 生效）：<https://api-docs.deepseek.com/zh-cn/news/news260910>
- 最新版 V4.1-Flash-1017（2026-10-17，价格不变）：<https://api-docs.deepseek.com/zh-cn/news/news261017>
- 2026 年放假安排：<https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm>

> 2027 年国务院放假通知通常 11 月发布。代码里已包含固定公历法定日（元旦、劳动节、国庆节）兜底；春节/清明/端午/中秋等 2027 具体日期待官方通知后补进 `lib/index.js` 的 `CHINA_HOLIDAY_RANGES`。

## 目录结构

```text
deepseek-balance-glass-panel/
├── package.json          # DSH bundle 插件元数据（含 locale/icon 导出）
├── cordis.patch.yml      # 插件挂载声明
├── README.md             # 本文件
├── AGENT.md              # 面向 AI 编码助手的维护/开发指南
├── icon.svg              # 插件管理器/设置页图标
├── locale/
│   ├── zh.json           # 插件标题/描述（中文）
│   └── en.json           # 插件标题/描述（英文）
├── lib/
│   └── index.js          # 宿主侧插件本体（含内嵌客户端 widget.js）
└── test/
    └── pricing.test.mjs  # 峰谷/节假日/官方价/内嵌脚本自检
```

## 获取

源码在 GitHub：<https://github.com/xnn1145/deepseek-balance-glass-panel>（`git clone` 或页面右上角 **Code → Download ZIP**）。

## 安装

### 先确认运行端与 profile

| 运行方式 | profile | 安装方式 |
| --- | --- | --- |
| DSH Desktop 桌面应用 | `desktop` | 桌面应用「设置 → 插件」或 `plugin_manager`（普通 CLI 不可用） |
| `dsh web` 浏览器服务 | `web` | `dsh plugin --profile web add ...` |

**装到 `web` profile 不会在 DSH Desktop 出现**（反之亦然）。

> **DSH Desktop 的 `desktop` profile 由桌面应用独占管理**：普通 `dsh plugin --profile desktop ...` 会报 `profile "desktop" is managed exclusively by the Electron application`。请通过桌面应用的插件管理器安装/启用本目录，或让 DSH Desktop 会话里的 Agent 用 `plugin_manager` 的 `install_bundle` 指向本目录绝对路径。`dsh web` 的 `web` profile 仍用下面的 CLI。

### 方式 A：本地安装（推荐开发/自用）

**DSH Desktop**：在桌面应用「设置 → 插件」中安装/启用本目录；如果该界面只接受包名/仓库地址，就让桌面会话里的 Agent 用 `plugin_manager` 的 `install_bundle` 指向本目录绝对路径。**不要**用普通 `dsh plugin --profile desktop`（会被拒绝）。

**`dsh web`**：在仓库目录的**上一级**执行，把 `<本目录绝对路径>` 换成实际路径：

```powershell
dsh plugin --profile web add link:<本目录绝对路径>
```

例如目录在 `D:\git\deepseek-balance-glass-panel`：

```powershell
dsh plugin --profile web add link:D:\git\deepseek-balance-glass-panel
```

安装完成后：

- DSH Desktop：**完全退出并重新启动桌面应用**（不是只刷新页面；桌面壳在 Host 启动时缓存页面注入）；
- `dsh web`：重启 `dsh web`，浏览器 F5。

`link:` 安装是指向本仓库目录的链接，**不要移动/删除该目录**，否则插件失效。

### 方式 B：发布至 npm 后安装

```powershell
cd deepseek-balance-glass-panel
npm publish
```

对方机器上：

- DSH Desktop：在桌面应用「设置 → 插件」中安装 `deepseek-balance-glass-panel`，或让桌面会话里的 Agent 用 `plugin_manager` 安装；
- `dsh web`：`dsh plugin --profile web add deepseek-balance-glass-panel`。

## 卸载

- **DSH Desktop**：桌面应用「设置 → 插件」中卸载/停用 `deepseek-balance-glass-panel`；或让桌面会话里的 Agent 用 `plugin_manager` 的 `remove_bundle`。
- **`dsh web`**：`dsh plugin --profile web remove deepseek-balance-glass-panel`。

## 凭据与余额来源

- **API key（Web/桌面都可用）**：在 DSH 凭据服务中配置 `DEEPSEEK_API_KEY`，用于 `api.deepseek.com/user/balance`
- **DeepSeek 账户（桌面端推荐）**：在 DSH Desktop 的「设置 → 账户」登录 DeepSeek；没有 API key 时面板会自动读取充值余额 + 赠送余额
- **今日花销**：无需额外令牌；优先用全部会话的今日 Token 估算，缺失时用余额差值记账

## 验证

```powershell
# 1. 插件是否启用：DSH Desktop 在「设置 → 插件」中查看；或让桌面会话里的 Agent 用 plugin_manager 的 list_bundles 查看
#    dsh web 可以用：dsh --profile web --dump-config | Select-String -Pattern "glass"

# 2. 单元测试（峰谷边界、节假日、官方价、内嵌脚本语法）
npm test

# 3. 运行时端点（把 <端口> 换成桌面窗口/GUI 实际端口）
curl http://127.0.0.1:<端口>/dsh-glass/health
curl http://127.0.0.1:<端口>/dsh-glass/stats.json
curl http://127.0.0.1:<端口>/dsh-glass/widget.js
```

- `/dsh-glass/health` → 200，返回 `{"ok":true,"injected":true}`：当前 Host 的 index 注入表已包含 widget 行（桌面端排查第一入口）
- `/dsh-glass/stats.json` → 200，返回 `{"balance":{...},"today":{...},"spend":{...},"tokens":{...},"task":...,"isPeak":...}`；`balance.source` 为 `api` / `account` / `ledger`
- `/dsh-glass/widget.js` → 200，`application/javascript`
- widget 通过结构化 index 注入加载：`dsh web` 在 index 渲染时注入，DSH Desktop 在启动时由宿主把注入表交给桌面壳；**完全重启桌面应用**后右下角出现玻璃面板

## 常见问题

- **DSH Desktop 里看不到面板**：确认已在桌面应用「设置 → 插件」中启用 `deepseek-balance-glass-panel`。DSH Desktop 的主窗口是 `dsh-app://app/`，不走 `webServer.tapIndex`；本插件通过结构化 index 注入加载 widget。**更新过插件代码后必须完全退出并重启桌面应用**（只刷新页面会拿到旧缓存注入）。先看 `/dsh-glass/health` 是否为 `{"ok":true,"injected":true}`；若为 `injected:false` 或 404，说明 Host 还是旧插件代码/未重启。仍失败再看插件状态是否 `applied`。
- **余额报「未配置 DEEPSEEK_API_KEY」**：去 DSH 配置 API key，或在桌面端「设置 → 账户」登录 DeepSeek；两者都未配置时面板会明确提示。
- **今日花销为 0**：全部会话今天都还没有 Token 用量事件（新会话/无事件时会话）时显示 0；随便说一句话后即可看到。跨天自动从 0 重新计。
- **切换会话后面板数据没变**：面板的会话行（本次花销/Token/任务）跟随浏览器当前选中的会话，最多 5 秒内自动刷新；「今日会话花销」是全部会话累计，不随切换变化。若长时间不变，点左上角刷新按钮强制刷新。
- **会话行显示「—」**：当前选中的会话还没有用量事件；随便说一句话后即可看到。
- **价格不对 / 想用 V4 Pro**：点右上角**齿轮**，在「官方价模型」选择 `deepseek-flash` 或 `deepseek-v4-pro`，再点「保存」；菜单里的价格是**闲时价**，高峰价自动按「高峰倍率」（默认 2）计算。外部模型计费不同时可直接改四个输入框（通常高峰倍率填 1）。
- **法定节假日计费不对**：2026 年按国务院放假安排全段已内置；2027 年春节/清明/端午/中秋等日期需等官方通知后更新 `CHINA_HOLIDAY_RANGES`（固定公历法定日已兜底）。
- **本地开发改了代码不生效**：`link:` 安装时改源码后，`dsh web` 重启进程再 F5；**DSH Desktop 必须完全退出并重新启动**（Host 启动时重新收集 index 注入，只 F5 不够；ESM 模块也有缓存）。已发布版本需 `npm publish` 新版本后，`dsh web` 用 `dsh plugin --profile web update deepseek-balance-glass-panel`，DSH Desktop 在「设置 → 插件」中更新/重装。
