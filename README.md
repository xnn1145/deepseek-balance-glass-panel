# DSH 余额面板（DeepSeek Balance Panel）

> 📦 项目地址：<https://github.com/xnn1145/deepseek-balance-glass-panel>

DeepSeek Harness（DSH）Web 界面上的浮动 **macOS 风格毛玻璃面板**：DeepSeek 余额、今日/本次会话花销（峰谷拆分）、Token 用量与当前任务，随页面打开自动出现。本项目是标准 DSH 插件包，可通过 `dsh plugin` 安装/卸载。

## 功能

- 💰 **余额**：调用 `api.deepseek.com/user/balance`（`DEEPSEEK_API_KEY`），页面加载时与每 30 秒自动刷新；接口失败时保留上次数据并给出提示，不直接报错
- 📊 **今日会话花销（余额记账法）**：与余额同一把 `DEEPSEEK_API_KEY`——每次观测余额后按**差值自动记账**（持久化到 `~/.dsh-glass-usage.json`，跨天自动归零重开）
- 🧾 **本次会话花销**：按会话事件实时统计，拆分为 **高峰时期用量 / 空闲时间用量**
- 🕐 **峰谷时段**：高峰 = 北京时间 9:00–12:00 与 14:00–18:00；底部圆点实时显示「高峰计费中 / 闲时计费」
- 🪙 **Token 用量**：本次对话的 输入 / 输出 / 缓存读 / 缓存写 / 事件数
- 📝 **任务**：持久显示最后一次 `todo/write` 的清单（跨轮次保留，不随 turn 清空），无清单时回退到当前 goal
- 🎨 **macOS 风玻璃**：三档主题（玻璃 / 深色 / 浅色），右上角按钮循环切换
- 🖱️ **拖拽 + 角缩放**：标题栏拖拽移动，右下角手柄调整大小
- 💾 位置 / 尺寸 / 主题 / 展开状态记忆（localStorage）；关闭后右下角 📊 按钮可重新打开

> 会话相关三行（本次花销、Token、任务）反映**最近活跃的会话**——即你正在输入的那个会话。

## 目录结构

```text
deepseek-balance-glass-panel/
├── package.json          # DSH bundle 插件元数据
├── cordis.patch.yml      # 插件挂载声明
├── README.md             # 本文件
├── AGENT.md              # 面向 AI 编码助手的维护/开发指南
└── lib/
    └── index.js          # 宿主侧插件本体（含内嵌客户端 widget.js）
```

## 获取

源码在 GitHub：<https://github.com/xnn1145/deepseek-balance-glass-panel>（`git clone` 或页面右上角 **Code → Download ZIP**）。

## 安装

### 方式 A：本地安装

把整个 `deepseek-balance-glass-panel/` 目录拷给对方，然后在对方机器上：

```powershell
dsh plugin --profile web add link:<deepseek-balance-glass-panel 目录的绝对路径>
```

例如目录放在 `D:\plugins\deepseek-balance-glass-panel`：

```powershell
dsh plugin --profile web add link:D:\plugins\deepseek-balance-glass-panel
```

安装完成后重启 `dsh web`，再刷新浏览器（F5）即可看到面板（默认左上角，可拖到任意位置）。

### 方式 B：发布至 npm 后安装

```powershell
cd deepseek-balance-glass-panel
npm publish
```

对方任意机器上：

```powershell
dsh plugin --profile web add deepseek-balance-glass-panel
```

## 卸载

```powershell
dsh plugin --profile web remove deepseek-balance-glass-panel
```

## 凭据

- **余额**：需要 `DEEPSEEK_API_KEY`（在 DSH 凭据服务中配置），用于 `api.deepseek.com/user/balance`
- **今日花销**：无需额外令牌，复用上面的余额密钥做差值记账

## 验证

```powershell
dsh --profile web --dump-config | Select-String -Pattern "glass"

curl http://127.0.0.1:3080/dsh-glass/stats.json
curl http://127.0.0.1:3080/dsh-glass/widget.js
```

- `/dsh-glass/stats.json` → 200，返回 `{"ok":true,"error":"","updatedAt":...,"peakNow":false,"balance":{"available":3.5,"total":4.39,"currency":"CNY"},"todayUsage":2.32,"todayPeak":1.5,"todayIdle":0.82,"session":{...},"task":{"text":"...","status":"running"}}`
- `/dsh-glass/widget.js` → 200，`application/javascript`
- 浏览器 F5 后出现玻璃面板（默认左上角）

## 常见问题

- **面板不出现**：确认 `dsh plugin add` 成功；`dsh --profile web --dump-config` 能看到 `deepseek-balance-glass-panel`；重启 `dsh web` 后 F5。
- **余额报「缺少 DEEPSEEK_API_KEY」**：去 DSH 配置凭据。
- **今日花销为 0 或从 0 开始**：余额记账法需要先完成一次余额观测（加载后自动完成），之后消费才会累积；跨天后自动从 0 重新计。
- **会话三行显示「— / 无会话」**：当前还没有活跃会话事件；随便说一句话后即可看到。
- **任务显示「无进行中任务」**：既没有 `todo/write` 清单，也没有进行中的 goal；开始一个任务后会自动出现。
- **本地开发改了代码不生效**：`link:` 安装时改源码后重启 `dsh web`（ESM 模块缓存）；已发布版本需 `npm publish` 新版本后 `dsh plugin --profile web update deepseek-balance-glass-panel`。
