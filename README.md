# DSH 余额面板（DeepSeek Balance Panel）

> 📦 项目地址：<https://github.com/xnn1145/deepseek-balance-glass-panel>

DeepSeek Harness（DSH）Web 界面上的浮动 **macOS 风格毛玻璃面板**：DeepSeek 余额、今日/本次会话花销（峰谷拆分）、Token 用量与当前任务，随页面打开自动出现。本项目是标准 DSH 插件包，可通过 `dsh plugin` 安装/卸载。

## 功能

- 💰 **余额**：调用 `api.deepseek.com/user/balance`（`DEEPSEEK_API_KEY`），30 秒缓存 + 手动刷新；接口失败时回退为「最近观测余额」并给出提示，不直接报错
- 📊 **今日会话花销**：按**全部会话今日 Token 用量之和 × 当前价格**实时估算（自定义价格立即生效；后台会话、子代理会话一并计入）；仅当全局今日无任何用量数据时回退为余额差值记账（与余额同一把 `DEEPSEEK_API_KEY`，每次观测余额后按差值记账，持久化到 `~/.dsh/.dsh-glass-usage.json`，跨天自动归零）
- 🧾 **本次会话花销**：按当前选中会话事件实时统计，拆分为 **高峰时期用量 / 空闲时间用量**
- 🕐 **峰谷时段**：高峰 = 北京时间 9:00–12:00 与 14:00–18:00；底部红/绿点显示「现在是 峰 / 谷 时间」
- 🪙 **Token 用量**：本次对话的 缓存命中 / 未命中 / 输出
- ⚙️ **自定义价格**：右上角齿轮菜单可配置 输入/命中/输出 每 1M Token 的价格与高峰倍率（存 localStorage，重启不丢），适配计费不同的外部模型；一键「重置官方价」
- 📝 **任务**：持久显示最后一次 `todo_write` 的清单（跨轮次保留，不随 turn 清空），无清单时回退到当前 goal
- 🎨 **macOS 风玻璃**：深浅色自动跟随 DSH 界面主题、展开项时面板自动向下
- 🖱️ **拖拽 + 角缩放**：单圆弧缩放手柄（面板在左半边则手柄在右下角，反之左下角）
- 💾 位置/尺寸/最小化/关闭状态记忆（localStorage）

> 会话相关行（本次花销、Token、任务）反映**浏览器当前选中的会话**——切换会话后面板在几秒内自动跟随，不受后台其他会话影响；「今日会话花销」则是**全部会话的累计**。

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

安装完成后重启 `dsh web`，再刷新浏览器（F5）即可看到右下角面板。

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

- `/dsh-glass/stats.json` → 200，返回 `{"balance":{...},"today":{...},"spend":{...},"tokens":{...},"task":...,"isPeak":...}`
- `/dsh-glass/widget.js` → 200，`application/javascript`
- 浏览器 F5 后右下角出现玻璃面板

## 常见问题

- **面板不出现**：确认 `dsh plugin add` 成功；`dsh --profile web --dump-config` 能看到 `deepseek-balance-glass-panel`；重启 `dsh web` 后 F5。
- **余额报「未配置 DEEPSEEK_API_KEY」**：去 DSH 配置凭据。
- **今日花销为 0**：全部会话今天都还没有 Token 用量事件（新会话/无事件时会话）时显示 0；随便说一句话后即可看到。跨天自动从 0 重新计。
- **切换会话后面板数据没变**：面板的会话行（本次花销/Token/任务）跟随浏览器当前选中的会话，最多 5 秒内自动刷新；「今日会话花销」是全部会话累计，不随切换变化。若长时间不变，点左上角刷新按钮强制刷新。
- **会话行显示「—」**：当前选中的会话还没有用量事件；随便说一句话后即可看到。
- **外部模型花销算得不对**：点面板右上角**齿轮**，按你实际被收取的价格填写「输入（未命中）/命中（缓存）/输出」每 1M Token 价格；高峰期按「高峰倍率」计（外部模型通常是统一价，填 1 即可）。保存后立即生效并自动刷新，今日/本次花销都会按新价格重算。
- **本地开发改了代码不生效**：`link:` 安装时改源码后重启 `dsh web`（ESM 模块缓存）；已发布版本需 `npm publish` 新版本后 `dsh plugin --profile web update deepseek-balance-glass-panel`。
