// deepseek-balance-glass-panel —— DeepSeek 玻璃余额面板（DSH 插件包）
// 宿主侧：余额拉取、今日花销记账（余额差值法）、最近活跃会话用量/任务统计，
//         并通过 webServer 提供 /dsh-glass/stats.json 与 /dsh-glass/widget.js，
//         再用 tapIndex 把 widget.js 注入页面。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_TTL_MS = 30000

// 高峰时段（北京时间）：9:00–12:00、14:00–18:00
const PEAK_HOURS = [[9, 12], [14, 18]]
// DeepSeek CNY 单价（元 / 百万 token）：[空闲, 高峰] 命中 / 未命中 / 输出
const PRICE = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] }

const GLASS_LEDGER = path.join(DSH_HOME, '.dsh-glass-usage.json')
const WHALE_LEDGER = path.join(DSH_HOME, '.dshw-usage.json')
const GLASS_STATE = path.join(DSH_HOME, '.dsh-glass-state.json') // 最近活跃会话(重启恢复用)

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
}

function isPeakTime(ms) {
  const hour = new Date(Number(ms) + 8 * 3600000).getUTCHours()
  for (const [s, e] of PEAK_HOURS) if (hour >= s && hour < e) return true
  return false
}

function beijingDay(ms) {
  return Math.floor((Number(ms) + 8 * 3600000) / 86400000)
}

function todayDateStr() {
  const d = new Date(Date.now() + 8 * 3600000)
  const p = (n) => String(n).padStart(2, '0')
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(obj))
  } catch { /* 尽力而为：目录不可写则仅保留内存记账 */ }
}

const zero = () => ({ miss: 0, hit: 0, write: 0, out: 0 })

// 桶金额/数量换算(供 snapshotStats 与全局今日共用)
function costOfBuckets(b, peak, price0) {
  return (b.miss * price0.miss[peak ? 1 : 0] + b.hit * price0.hit[peak ? 1 : 0] + b.out * price0.out[peak ? 1 : 0]) / 1000000
}
function tokensOfBuckets(b) {
  return b.miss + b.hit + b.out + b.write
}

// 自定义价格解析:客户端在请求中携带 hit/miss/out(元/1M)与高峰倍率 peak。
// 未携带的项回落到 DeepSeek 官方价;peak 会把高峰列改为 闲时×倍率。
function parsePriceParams(url) {
  const qi = url ? url.indexOf('?') : -1
  if (qi < 0) return null
  let params = null
  try { params = new URLSearchParams(url.slice(qi + 1)) } catch { return null }
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    return isFinite(n) && n >= 0 ? Math.min(n, 1000000) : null
  }
  const hit = num(params.get('hit'))
  const miss = num(params.get('miss'))
  const out = num(params.get('out'))
  const peak = num(params.get('peak'))
  if (hit === null && miss === null && out === null && peak === null) return null
  const price = {
    hit: [hit !== null ? hit : PRICE.hit[0], hit !== null ? hit : PRICE.hit[1]],
    miss: [miss !== null ? miss : PRICE.miss[0], miss !== null ? miss : PRICE.miss[1]],
    out: [out !== null ? out : PRICE.out[0], out !== null ? out : PRICE.out[1]],
  }
  if (peak !== null) {
    price.hit[1] = price.hit[0] * peak
    price.miss[1] = price.miss[0] * peak
    price.out[1] = price.out[0] * peak
  }
  return price
}

// ---- 会话用量/任务统计（内存态，按会话）----
const states = new Map()

// 今日花销全局累计:所有会话的今日用量,由 session/event 实时喂入 + 首次请求冷读回填。
// lastByStep 的 key 带 sid,避免跨会话 (turn:step) 碰撞;replace 语义保证重复投递不重复计数。
let globalToday = { peak: zero(), idle: zero(), lastByStep: new Map(), key: beijingDay(Date.now()) }
let todayBackfillDay = -1

function entryFor(sid) {
  let e = states.get(sid)
  if (e === undefined) {
    e = {
      state: { peak: zero(), idle: zero(), lastByStep: new Map() },
      today: { peak: zero(), idle: zero(), lastByStep: new Map() },
      todayKey: beijingDay(Date.now()),
      lastSeq: 0,
      seeded: false,
      todos: null,
    }
    states.set(sid, e)
  }
  return e
}

function applyEvent(e, event, sid) {
  if (event.type === 'todo/write') {
    const list = event.data && event.data.todos
    if (Array.isArray(list)) {
      e.todos = list.map((t) => ({ content: String(t && t.content ? t.content : ''), status: t.status }))
    }
    return
  }
  let turn, step, usage
  if (event.type === 'assistant/chunk' && event.data && event.data.chunk && event.data.chunk.type === 'usage') {
    turn = event.data.turn; step = event.data.step; usage = event.data.chunk.usage
  } else if (event.type === 'assistant/message' && event.data && event.data.usage !== undefined) {
    turn = event.data.turn; step = event.data.step; usage = event.data.usage
  } else {
    return
  }
  const key = String(turn) + ':' + String(step)
  const peak = isPeakTime(event.time)
  const state = e.state
  const prev = state.lastByStep.get(key)
  if (prev !== undefined) {
    const pb = prev.peak ? state.peak : state.idle
    pb.miss -= prev.miss; pb.hit -= prev.hit; pb.write -= prev.write; pb.out -= prev.out
  }
  const b = peak ? state.peak : state.idle
  b.miss += usage.inputTokens || 0
  b.hit += usage.cacheReadTokens || 0
  b.write += usage.cacheWriteTokens || 0
  b.out += usage.outputTokens || 0
  state.lastByStep.set(key, {
    peak,
    miss: usage.inputTokens || 0,
    hit: usage.cacheReadTokens || 0,
    write: usage.cacheWriteTokens || 0,
    out: usage.outputTokens || 0,
  })
  // 今日桶滚动:事件所在天比 todayKey 更新(跨天首事件 / 冷读重放)才滚动,
  // 只向前不后退——重放昨日事件不会把昨天的用量当成「今天」。
  const day = beijingDay(event.time)
  if (day > e.todayKey) {
    e.todayKey = day
    e.today = { peak: zero(), idle: zero(), lastByStep: new Map() }
  }
  if (day === e.todayKey) {
    const today = e.today
    const tp = today.lastByStep.get(key)
    if (tp !== undefined) {
      const tb = tp.peak ? today.peak : today.idle
      tb.miss -= tp.miss; tb.hit -= tp.hit; tb.write -= tp.write; tb.out -= tp.out
    }
    const tb2 = peak ? today.peak : today.idle
    tb2.miss += usage.inputTokens || 0
    tb2.hit += usage.cacheReadTokens || 0
    tb2.write += usage.cacheWriteTokens || 0
    tb2.out += usage.outputTokens || 0
    today.lastByStep.set(key, {
      peak,
      miss: usage.inputTokens || 0,
      hit: usage.cacheReadTokens || 0,
      write: usage.cacheWriteTokens || 0,
      out: usage.outputTokens || 0,
    })
  }
  // 全局今日累计(所有会话):滚动规则同每会话今日桶,只向前不后退
  if (day > globalToday.key) {
    globalToday.key = day
    globalToday = { peak: zero(), idle: zero(), lastByStep: new Map(), key: day }
  }
  if (day === globalToday.key) {
    const gkey = sid + ':' + key
    const gp = globalToday.lastByStep.get(gkey)
    if (gp !== undefined) {
      const gb = gp.peak ? globalToday.peak : globalToday.idle
      gb.miss -= gp.miss; gb.hit -= gp.hit; gb.write -= gp.write; gb.out -= gp.out
    }
    const gb2 = peak ? globalToday.peak : globalToday.idle
    gb2.miss += usage.inputTokens || 0
    gb2.hit += usage.cacheReadTokens || 0
    gb2.write += usage.cacheWriteTokens || 0
    gb2.out += usage.outputTokens || 0
    globalToday.lastByStep.set(gkey, {
      peak,
      miss: usage.inputTokens || 0,
      hit: usage.cacheReadTokens || 0,
      write: usage.cacheWriteTokens || 0,
      out: usage.outputTokens || 0,
    })
  }
}

// ============================================================================
// 客户端 widget.js（自包含 vanilla JS，无 React / 无外部依赖）
// ============================================================================
const WIDGET_JS = `(function () {
  if (window.__dshGlassPanel) return
  window.__dshGlassPanel = true

  var STATS_URL = '/dsh-glass/stats.json'
  var LS_KEY = 'deepseek-balance-glass-panel-v1'
  var REFRESH_MS = 5000
  var MINW = 250
  var MINH = 170

  var CSS = [
    '.gp-root{position:fixed;z-index:2147483000;min-width:250px;min-height:170px;display:flex;flex-direction:column;border-radius:18px;overflow:hidden;background:linear-gradient(150deg,rgba(255,255,255,.52),rgba(255,255,255,.26) 55%,rgba(245,248,255,.3));-webkit-backdrop-filter:blur(26px) saturate(190%);backdrop-filter:blur(26px) saturate(190%);border:1px solid rgba(255,255,255,.65);box-shadow:0 24px 48px rgba(15,23,42,.16),0 4px 12px rgba(15,23,42,.07),inset 0 1px 0 rgba(255,255,255,.65);color:#1e293b;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,PingFang SC,Hiragino Sans GB,Microsoft YaHei,system-ui,sans-serif;user-select:none;-webkit-user-select:none;pointer-events:auto;animation:gp-in .22s ease}',
    '@keyframes gp-in{from{opacity:0;transform:scale(.96) translateY(4px)}to{opacity:1;transform:none}}',
    '.gp-topbar{display:flex;align-items:center;gap:7px;padding:9px 14px 4px;cursor:grab;flex:none}',
    '.gp-topbar:active{cursor:grabbing}',
    '.gp-btn{width:13px;height:13px;border-radius:50%;border:none;padding:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;position:relative;transition:transform .12s ease,filter .12s ease}',
    '.gp-btn:hover{transform:scale(1.15);filter:brightness(1.06)}',
    '.gp-btn:active{transform:scale(.92)}',
    '.gp-btn svg{width:8px;height:8px;display:block}',
    '.gp-btn-refresh{background:#28c840;color:#fff}',
    '.gp-btn-min{background:#ffbd2e;color:#fff}',
    '.gp-btn-close{background:#ff5f57;color:#fff}',
    '.gp-btn.refreshing svg{animation:gp-spin .8s linear infinite}',
    '@keyframes gp-spin{to{transform:rotate(360deg)}}',
    '.gp-tip{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%) translateY(3px);background:rgba(15,23,42,.85);color:#fff;font-size:11px;line-height:1;padding:4px 7px;border-radius:6px;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .12s ease,transform .12s ease;z-index:5}',
    '.gp-btn:hover .gp-tip{opacity:1;transform:translateX(-50%) translateY(0)}',
    '.gp-body{flex:1;padding:2px 14px 12px;display:flex;flex-direction:column;gap:7px;overflow:hidden}',
    '.gp-label{font-size:11px;letter-spacing:.08em;color:rgba(71,85,105,.85);font-weight:600}',
    '.gp-balance{font-size:30px;font-weight:700;line-height:1.1;letter-spacing:-.01em;color:#0f172a;display:flex;align-items:baseline;gap:2px}',
    '.gp-balance .gp-cny{font-size:16px;font-weight:600;color:rgba(71,85,105,.9)}',
    '.gp-balance-err{font-size:10.5px;line-height:1.35;color:#dc4c3e;margin-top:-3px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.gp-hint{font-size:10.5px;color:rgba(100,116,139,.85);line-height:1.35}',
    '.gp-task{font-size:11.5px;color:rgba(71,85,105,.9);display:flex;align-items:center;gap:5px;min-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.gp-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;padding:4px 7px;margin:0 -7px;border-radius:8px;cursor:pointer;color:rgba(30,41,59,.92);transition:background .12s ease}',
    '.gp-rowleft{display:flex;align-items:center;gap:7px;min-width:0}',
    '.gp-row:hover{background:rgba(255,255,255,.55)}',
    '.gp-row .gp-chev{width:10px;height:10px;color:rgba(71,85,105,.6);transition:transform .15s ease;flex:none;display:inline-flex}',
    '.gp-row.gp-open .gp-chev{transform:rotate(90deg)}',
    '.gp-row .gp-val{font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}',
    '.gp-detail{font-size:11.5px;color:rgba(71,85,105,.95);display:flex;flex-direction:column;gap:3px;padding:3px 8px 3px 16px;margin:0 -7px}',
    '.gp-drow{display:flex;justify-content:space-between;align-items:baseline;gap:8px}',
    '.gp-dlabel{color:rgba(100,116,139,.95);white-space:nowrap}',
    '.gp-dval{font-variant-numeric:tabular-nums;font-weight:600;color:rgba(30,41,59,.95);white-space:nowrap}',
    '.gp-peak{display:flex;align-items:center;gap:6px;font-size:12px;color:rgba(30,41,59,.95);margin-top:1px}',
    '.gp-dot{width:8px;height:8px;border-radius:50%;flex:none}',
    '.gp-dot-peak{background:#ff453a;box-shadow:0 0 6px rgba(255,69,58,.7)}',
    '.gp-dot-idle{background:#30d158;box-shadow:0 0 6px rgba(48,209,88,.7)}',
    '.gp-corner{position:absolute;width:30px;height:30px;pointer-events:auto;display:flex;align-items:center;justify-content:center;z-index:3}',
    '.gp-corner svg{width:22px;height:22px;display:block;color:rgba(100,116,139,.8);filter:drop-shadow(0 1px 1px rgba(15,23,42,.14));transition:color .15s ease}',
    '.gp-corner:hover svg{color:rgba(51,65,85,1)}',
    '.gp-corner-br{right:0;bottom:0;cursor:nwse-resize}',
    '.gp-corner-bl{left:0;bottom:0;cursor:nesw-resize}',
    '.gp-pill{position:fixed;z-index:2147483000;display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;background:linear-gradient(150deg,rgba(255,255,255,.55),rgba(255,255,255,.28));-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);border:1px solid rgba(255,255,255,.7);box-shadow:0 12px 28px rgba(15,23,42,.14);cursor:pointer;pointer-events:auto;font-size:13px;font-weight:600;color:#0f172a;font-family:inherit;user-select:none;animation:gp-in .18s ease}',
    '.gp-reopen{position:fixed;z-index:2147483000;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(150deg,rgba(255,255,255,.6),rgba(255,255,255,.32));-webkit-backdrop-filter:blur(20px) saturate(170%);backdrop-filter:blur(20px) saturate(170%);border:1px solid rgba(255,255,255,.75);box-shadow:0 8px 20px rgba(15,23,42,.14);cursor:pointer;pointer-events:auto;color:#334155;font-family:inherit;font-weight:700;font-size:14px;transition:transform .15s ease;animation:gp-in .18s ease}',
    '.gp-reopen:hover{transform:scale(1.1)}',
    '.gp-root.gp-dark{background:linear-gradient(150deg,rgba(28,33,46,.68),rgba(17,21,31,.52) 55%,rgba(36,42,58,.62));border-color:rgba(255,255,255,.13);box-shadow:0 24px 48px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.1);color:#e5eaf3}',
    '.gp-root.gp-dark .gp-label{color:rgba(160,172,192,.9)}',
    '.gp-root.gp-dark .gp-balance{color:#f1f5f9}',
    '.gp-root.gp-dark .gp-balance .gp-cny{color:rgba(160,172,192,.9)}',
    '.gp-root.gp-dark .gp-balance-err{color:#ff8a80}',
    '.gp-root.gp-dark .gp-hint{color:rgba(170,180,200,.85)}',
    '.gp-root.gp-dark .gp-task{color:rgba(170,180,200,.95)}',
    '.gp-root.gp-dark .gp-row{color:rgba(229,234,243,.95)}',
    '.gp-root.gp-dark .gp-row:hover{background:rgba(255,255,255,.08)}',
    '.gp-root.gp-dark .gp-row .gp-chev{color:rgba(170,180,200,.65)}',
    '.gp-root.gp-dark .gp-detail{color:rgba(170,180,200,.95)}',
    '.gp-root.gp-dark .gp-dlabel{color:rgba(160,172,192,.85)}',
    '.gp-root.gp-dark .gp-dval{color:rgba(233,238,247,.95)}',
    '.gp-root.gp-dark .gp-peak{color:rgba(229,234,243,.95)}',
    '.gp-root.gp-dark .gp-corner svg{color:rgba(190,200,220,.85)}',
    '.gp-root.gp-dark .gp-corner:hover svg{color:rgba(226,232,240,1)}',
    '.gp-pill.gp-dark{background:linear-gradient(150deg,rgba(28,33,46,.75),rgba(17,21,31,.6));border-color:rgba(255,255,255,.14);box-shadow:0 12px 28px rgba(0,0,0,.4);color:#f1f5f9}',
    '.gp-reopen.gp-dark{background:linear-gradient(150deg,rgba(28,33,46,.8),rgba(17,21,31,.66));border-color:rgba(255,255,255,.16);box-shadow:0 8px 20px rgba(0,0,0,.4);color:#cbd5e1}',
    '.gp-btn-menu{margin-left:auto;background:rgba(100,116,139,.28);color:rgba(51,65,85,.95)}',
    '.gp-btn-menu svg{width:10px;height:10px}',
    '.gp-menu{position:absolute;top:34px;right:12px;width:246px;padding:12px;border-radius:14px;background:rgba(255,255,255,.85);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);border:1px solid rgba(255,255,255,.72);box-shadow:0 16px 32px rgba(15,23,42,.18);display:none;flex-direction:column;gap:9px;z-index:6}',
    '.gp-menu-title{font-size:12px;font-weight:700;color:#0f172a}',
    '.gp-menu-row{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11.5px;color:rgba(71,85,105,.95)}',
    '.gp-menu-row input{width:88px;padding:4px 7px;border-radius:8px;border:1px solid rgba(100,116,139,.35);background:rgba(255,255,255,.9);color:#0f172a;font-size:12px;font-variant-numeric:tabular-nums;text-align:right;outline:none}',
    '.gp-menu-row input:focus{border-color:rgba(52,120,246,.85);box-shadow:0 0 0 2px rgba(52,120,246,.18)}',
    '.gp-menu-actions{display:flex;justify-content:space-between;gap:8px;margin-top:2px}',
    '.gp-menu-btn{flex:1;padding:5px 0;border-radius:8px;border:1px solid rgba(100,116,139,.3);background:rgba(255,255,255,.65);color:#334155;font-size:11.5px;font-weight:600;cursor:pointer;transition:filter .12s ease}',
    '.gp-menu-btn:hover{filter:brightness(.96)}',
    '.gp-menu-save{background:rgba(52,120,246,.92);border-color:transparent;color:#fff}',
    '.gp-menu-hint{font-size:10px;color:rgba(100,116,139,.8);line-height:1.4}',
    '.gp-menu-err{font-size:10.5px;color:#dc4c3e;display:none;line-height:1.4}',
    '.gp-root.gp-dark .gp-btn-menu{background:rgba(255,255,255,.16);color:#cbd5e1}',
    '.gp-root.gp-dark .gp-menu{background:rgba(24,29,41,.9);border-color:rgba(255,255,255,.13);box-shadow:0 16px 32px rgba(0,0,0,.5)}',
    '.gp-root.gp-dark .gp-menu-title{color:#f1f5f9}',
    '.gp-root.gp-dark .gp-menu-row{color:rgba(200,210,228,.92)}',
    '.gp-root.gp-dark .gp-menu-row input{background:rgba(15,20,32,.8);border-color:rgba(255,255,255,.18);color:#f1f5f9}',
    '.gp-root.gp-dark .gp-menu-btn{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.16);color:#cbd5e1}',
    '.gp-root.gp-dark .gp-menu-save{background:rgba(52,120,246,.9);border-color:transparent;color:#fff}',
    '.gp-root.gp-dark .gp-menu-hint{color:rgba(170,180,200,.8)}'
  ].join('\\n')

  var styleEl = document.createElement('style')
  styleEl.textContent = CSS
  document.head.appendChild(styleEl)

  function h(tag, attrs) {
    var el = document.createElement(tag)
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k]
        if (v === null || v === undefined) continue
        if (k === 'class') el.className = v
        else if (k === 'style') { for (var sk in v) el.style[sk] = v[sk] }
        else if (k === 'html') el.innerHTML = v
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
        else el.setAttribute(k, v)
      }
    }
    var kids = []
    for (var ai = 2; ai < arguments.length; ai++) {
      var c0 = arguments[ai]
      if (c0 === null || c0 === undefined) continue
      if (Array.isArray(c0)) { for (var aj = 0; aj < c0.length; aj++) kids.push(c0[aj]) }
      else kids.push(c0)
    }
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i]
      if (c === null || c === undefined) continue
      if (typeof c === 'string' || typeof c === 'number') el.appendChild(document.createTextNode(String(c)))
      else el.appendChild(c)
    }
    return el
  }

  var ICON_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>'
  var ICON_MIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>'
  var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>'
  var ICON_CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>'
  var ICON_GRIP_BR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round"><path d="M10 22 a20 20 0 0 0 12 -12"/></svg>'
  var ICON_GRIP_BL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round"><path d="M14 22 a20 20 0 0 1 -12 -12"/></svg>'
  var ICON_GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'

  function tip(text) { return h('span', { class: 'gp-tip' }, text) }

  var state = {
    minimized: false,
    closed: false,
    pos: null,
    size: null,
    dark: false,
    expSpend: false,
    expToday: false,
    expTokens: false,
    refreshing: false,
    refreshAt: 0,
    menuOpen: false,
    prices: null,
    stats: null,
    loadError: null
  }

  function readDark() { try { return !!document.body && document.body.hasAttribute('data-ds-dark-theme') } catch (e) { return false } }

  try { var saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null') } catch (e) { saved = null }
  var vw = window.innerWidth, vh = window.innerHeight
  state.size = (saved && saved.size) ? saved.size : { w: 300, h: 252 }
  state.pos = (saved && saved.pos) ? saved.pos : { left: Math.max(8, vw - 320), top: Math.max(8, vh - 272) }
  if (saved) { state.minimized = !!saved.minimized; state.closed = !!saved.closed }
  state.dark = readDark()

  var DEFAULT_PRICES = { hit: 0.05, miss: 1.5, out: 4.5, peak: 2 }
  function pickPrice(v, d) { var n = Number(v); return isFinite(n) && n >= 0 ? n : d }
  state.prices = (saved && saved.prices && typeof saved.prices === 'object')
    ? {
        hit: pickPrice(saved.prices.hit, DEFAULT_PRICES.hit),
        miss: pickPrice(saved.prices.miss, DEFAULT_PRICES.miss),
        out: pickPrice(saved.prices.out, DEFAULT_PRICES.out),
        peak: pickPrice(saved.prices.peak, DEFAULT_PRICES.peak)
      }
    : { hit: DEFAULT_PRICES.hit, miss: DEFAULT_PRICES.miss, out: DEFAULT_PRICES.out, peak: DEFAULT_PRICES.peak }

  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ pos: state.pos, size: state.size, minimized: state.minimized, closed: state.closed, prices: state.prices })) } catch (e) {}
  }

  function fmtMoney(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—'
    if (n >= 1) return n.toFixed(2)
    var s = n.toFixed(4).replace(/0+$/, '').replace(/\\.$/, '')
    return s === '0' ? '0.00' : s
  }
  function fmtTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\\.0$/, '') + 'M'
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\\.0$/, '') + 'K'
    return String(n)
  }

  // ---- 构建 DOM ----
  var balanceNum = h('span', null)
  var balanceErrEl = h('div', { class: 'gp-balance-err' })
  var loadErrEl = h('div', { class: 'gp-hint' })
  var taskEl = h('div', { class: 'gp-task' })

  var spendVal = h('span', { class: 'gp-val' }, '—')
  var spendPeakVal = h('span', { class: 'gp-dval' }, '—')
  var spendIdleVal = h('span', { class: 'gp-dval' }, '—')

  var todayVal = h('span', { class: 'gp-val' }, '—')
  var todayPeakVal = h('span', { class: 'gp-dval' }, '—')
  var todayIdleVal = h('span', { class: 'gp-dval' }, '—')
  var todayHint = h('div', { class: 'gp-hint' })

  var tokensVal = h('span', { class: 'gp-val' }, '—')
  var tokensHitVal = h('span', { class: 'gp-dval' }, '—')
  var tokensMissVal = h('span', { class: 'gp-dval' }, '—')
  var tokensOutVal = h('span', { class: 'gp-dval' }, '—')

  var peakDot = h('span', { class: 'gp-dot gp-dot-peak' })
  var peakWord = h('b', null, '梁文峰')

  var spendDetail = h('div', { class: 'gp-detail', style: { display: 'none' } },
    h('div', { class: 'gp-drow' }, h('span', { class: 'gp-dlabel' }, '高峰时期用量'), spendPeakVal),
    h('div', { class: 'gp-drow' }, h('span', { class: 'gp-dlabel' }, '空闲时间用量'), spendIdleVal))

  var todayDetail = h('div', { class: 'gp-detail', style: { display: 'none' } },
    h('div', { class: 'gp-drow' }, h('span', { class: 'gp-dlabel' }, '高峰时期用量'), todayPeakVal),
    h('div', { class: 'gp-drow' }, h('span', { class: 'gp-dlabel' }, '空闲时间用量'), todayIdleVal),
    todayHint)

  var tokensDetail = h('div', { class: 'gp-detail', style: { display: 'none' } },
    h('div', { class: 'gp-drow' }, h('span', { class: 'gp-dlabel' }, '缓存命中'), tokensHitVal),
    h('div', { class: 'gp-drow' }, h('span', { class: 'gp-dlabel' }, '未命中'), tokensMissVal),
    h('div', { class: 'gp-drow' }, h('span', { class: 'gp-dlabel' }, '输出'), tokensOutVal))

  var spendRow = h('div', { class: 'gp-row' },
    h('span', { class: 'gp-rowleft' },
      h('span', { class: 'gp-chev', html: ICON_CHEV }),
      h('span', null, '本次会话花销')),
    spendVal)
  var todayRow = h('div', { class: 'gp-row' },
    h('span', { class: 'gp-rowleft' },
      h('span', { class: 'gp-chev', html: ICON_CHEV }),
      h('span', null, '今日会话花销')),
    todayVal)
  var tokensRow = h('div', { class: 'gp-row' },
    h('span', { class: 'gp-rowleft' },
      h('span', { class: 'gp-chev', html: ICON_CHEV }),
      h('span', null, '本次对话消耗的 Tokens')),
    tokensVal)

  var refreshBtn = h('button', { class: 'gp-btn gp-btn-refresh', html: ICON_REFRESH }, tip('刷新'))
  var minBtn = h('button', { class: 'gp-btn gp-btn-min', html: ICON_MIN }, tip('最小化'))
  var closeBtn = h('button', { class: 'gp-btn gp-btn-close', html: ICON_X }, tip('关闭'))
  var menuBtn = h('button', { class: 'gp-btn gp-btn-menu', html: ICON_GEAR }, tip('价格设置'))

  var priceMissIn = h('input', { type: 'number', step: '0.01', min: '0' })
  var priceHitIn = h('input', { type: 'number', step: '0.01', min: '0' })
  var priceOutIn = h('input', { type: 'number', step: '0.01', min: '0' })
  var pricePeakIn = h('input', { type: 'number', step: '0.1', min: '0' })
  var menuErrEl = h('div', { class: 'gp-menu-err' })
  function menuRow(label, input) {
    return h('div', { class: 'gp-menu-row' }, h('span', null, label), input)
  }
  var menuResetBtn = h('button', { class: 'gp-menu-btn' }, '重置官方价')
  var menuSaveBtn = h('button', { class: 'gp-menu-btn gp-menu-save' }, '保存')
  var menuBox = h('div', { class: 'gp-menu' },
    h('div', { class: 'gp-menu-title' }, '价格设置（元 / 1M Tokens）'),
    menuRow('输入（未命中）', priceMissIn),
    menuRow('命中（缓存）', priceHitIn),
    menuRow('输出', priceOutIn),
    menuRow('高峰倍率', pricePeakIn),
    h('div', { class: 'gp-menu-actions' }, menuResetBtn, menuSaveBtn),
    h('div', { class: 'gp-menu-hint' }, '保存后立即生效并自动刷新，重启不丢失。外部模型计费不同时可在此自定义。'),
    menuErrEl)

  var topbar = h('div', { class: 'gp-topbar' }, refreshBtn, minBtn, closeBtn, menuBtn)

  var body = h('div', { class: 'gp-body' },
    h('div', { class: 'gp-label' }, 'DeepSeek 余额'),
    h('div', { class: 'gp-balance' }, h('span', { class: 'gp-cny' }, '￥'), balanceNum),
    balanceErrEl,
    loadErrEl,
    taskEl,
    spendRow, spendDetail,
    todayRow, todayDetail,
    tokensRow, tokensDetail,
    h('div', { class: 'gp-peak' }, peakDot, h('span', null, '现在是 '), peakWord, h('span', null, ' 时间')))

  var grip = h('div', { class: 'gp-corner', html: ICON_GRIP_BR, title: '拖拽调整大小' })

  var root = h('div', { class: 'gp-root' }, topbar, body, grip, menuBox)
  var pill = h('div', { class: 'gp-pill' },
    h('span', { class: 'gp-dot gp-dot-peak' }),
    h('span', null, '—'))
  var reopen = h('div', { class: 'gp-reopen', title: '打开 DeepSeek 余额面板' }, '¥')

  function edge() { return (state.pos.left + state.size.w / 2) < (window.innerWidth / 2) ? 'right' : 'left' }
  function applyPos() {
    root.style.left = state.pos.left + 'px'
    root.style.top = state.pos.top + 'px'
    var expanded = state.expSpend || state.expToday || state.expTokens
    if (state.menuOpen) {
      // 价格菜单弹出时:把面板撑大到能完整显示菜单,保存/关闭后缩回。
      // 菜单是绝对定位、不参与父容器高度,必须显式撑大,否则会被 overflow:hidden 裁掉。
      var menuW = menuBox.offsetWidth || 272
      var menuH = menuBox.offsetHeight || 0
      root.style.width = Math.max(state.size.w, menuW + 26) + 'px'
      root.style.height = 'auto'
      root.style.minHeight = Math.max(state.size.h, menuH + 42) + 'px'
    } else {
      root.style.width = state.size.w + 'px'
      root.style.height = expanded ? 'auto' : state.size.h + 'px'
      root.style.minHeight = expanded ? state.size.h + 'px' : ''
    }
  }
  function applyTheme() {
    var d = state.dark ? ' gp-dark' : ''
    root.className = 'gp-root' + d
    pill.className = 'gp-pill' + d
    reopen.className = 'gp-reopen' + d
  }
  function applyVisibility() {
    root.style.display = (state.closed || state.minimized) ? 'none' : 'flex'
    pill.style.display = state.minimized ? 'flex' : 'none'
    reopen.style.display = state.closed ? 'flex' : 'none'
    if (pill.style.display === 'flex') { pill.style.left = state.pos.left + 'px'; pill.style.top = state.pos.top + 'px' }
    if (reopen.style.display === 'flex') { reopen.style.left = state.pos.left + 'px'; reopen.style.top = state.pos.top + 'px' }
    grip.className = 'gp-corner ' + (edge() === 'right' ? 'gp-corner-br' : 'gp-corner-bl')
    grip.innerHTML = edge() === 'right' ? ICON_GRIP_BR : ICON_GRIP_BL
    spendDetail.style.display = state.expSpend ? 'flex' : 'none'
    todayDetail.style.display = state.expToday ? 'flex' : 'none'
    tokensDetail.style.display = state.expTokens ? 'flex' : 'none'
    spendRow.className = 'gp-row' + (state.expSpend ? ' gp-open' : '')
    todayRow.className = 'gp-row' + (state.expToday ? ' gp-open' : '')
    tokensRow.className = 'gp-row' + (state.expTokens ? ' gp-open' : '')
    menuBox.style.display = state.menuOpen ? 'flex' : 'none'
  }

  function render() {
    var s = state.stats
    var balance = s && s.balance ? s.balance : null
    var showValue = balance && balance.ok && balance.value !== null && balance.value !== undefined
    var spend = s && s.spend ? s.spend : null
    var today = s && s.today ? s.today : null
    var tokens = s && s.tokens ? s.tokens : null
    var todos = s && Array.isArray(s.todos) ? s.todos : null
    var goal = s && s.task ? s.task : null
    var isPeak = s ? (s.isPeak === true) : null

    balanceNum.textContent = showValue ? fmtMoney(balance.value) : '—'
    var berr = (balance && !balance.ok && balance.error) ? balance.error : (showValue ? null : (s ? '余额获取失败' : null))
    balanceErrEl.textContent = berr || ''
    balanceErrEl.style.display = berr ? 'block' : 'none'
    loadErrEl.textContent = state.loadError ? ('数据加载失败: ' + state.loadError) : ''
    loadErrEl.style.display = state.loadError ? 'block' : 'none'

    var taskText = '无进行中任务'
    if (todos && todos.length > 0) {
      var active = null
      for (var i = 0; i < todos.length; i++) { if (todos[i].status === 'in_progress') { active = todos[i]; break } }
      if (!active) for (var j = 0; j < todos.length; j++) { if (todos[j].status === 'pending') { active = todos[j]; break } }
      if (!active) active = todos[0]
      var suffix = active.status === 'in_progress' ? '（进行中）' : (active.status === 'pending' ? '（待办）' : '（已完成）')
      taskText = active.content + suffix
    } else if (goal) {
      taskText = goal.phase === 'active' ? goal.objective : goal.objective + '（' + goal.phase + '）'
    }
    taskEl.textContent = '任务：' + taskText

    spendVal.textContent = spend ? '￥' + fmtMoney(spend.total) : '—'
    spendPeakVal.textContent = spend ? '￥' + fmtMoney(spend.peak.cost) + ' · ' + fmtTokens(spend.peak.tokens) + ' tokens' : '—'
    spendIdleVal.textContent = spend ? '￥' + fmtMoney(spend.idle.cost) + ' · ' + fmtTokens(spend.idle.tokens) + ' tokens' : '—'

    todayVal.textContent = today ? '￥' + fmtMoney(today.total) : '—'
    todayPeakVal.textContent = today ? '￥' + fmtMoney(today.peak.cost) + ' · ' + fmtTokens(today.peak.tokens) + ' tokens' : '—'
    todayIdleVal.textContent = today ? '￥' + fmtMoney(today.idle.cost) + ' · ' + fmtTokens(today.idle.tokens) + ' tokens' : '—'
    todayHint.textContent = (today && today.error) ? today.error : ''
    todayHint.style.display = (today && today.error) ? 'block' : 'none'

    var totalTokens = tokens ? (tokens.hit + tokens.miss + tokens.out) : 0
    tokensVal.textContent = tokens ? fmtTokens(totalTokens) : '—'
    tokensHitVal.textContent = tokens ? fmtTokens(tokens.hit) : '—'
    tokensMissVal.textContent = tokens ? fmtTokens(tokens.miss) : '—'
    tokensOutVal.textContent = tokens ? fmtTokens(tokens.out) : '—'

    peakDot.className = 'gp-dot ' + (isPeak === false ? 'gp-dot-idle' : 'gp-dot-peak')
    peakWord.textContent = isPeak === false ? '梁文谷' : '梁文峰'
    pill.lastChild.textContent = showValue ? fmtMoney(balance.value) : '—'
    pill.firstChild.className = 'gp-dot ' + (isPeak === false ? 'gp-dot-idle' : 'gp-dot-peak')

    refreshBtn.className = 'gp-btn gp-btn-refresh' + (state.refreshing ? ' refreshing' : '')
    applyTheme()
    applyVisibility() // 先显示菜单再量尺寸,applyPos 才能按实际菜单大小撑大面板
    applyPos()
  }

  // DSH 客户端运行时把「当前选中的会话」持久化在 localStorage['dsh.sessions.current'],
  // 形如 {"sessionId":"session-...","subagentAddress":{...}};无选中/解析失败时返回空串。
  function currentSid() {
    try {
      var raw = localStorage.getItem('dsh.sessions.current')
      if (!raw) return ''
      var o = JSON.parse(raw)
      return (o && typeof o.sessionId === 'string') ? o.sessionId : ''
    } catch (e) { return '' }
  }
  function statsUrl(force) {
    var p = state.prices
    var q = '?hit=' + p.hit + '&miss=' + p.miss + '&out=' + p.out + '&peak=' + p.peak
    var sid = currentSid()
    if (sid) q += '&sid=' + encodeURIComponent(sid)
    return STATS_URL + q + (force ? '&refresh=1' : '')
  }

  function load(force) {
    if (force) {
      state.refreshing = true
      state.refreshAt = Date.now()
      render() // 立即渲染,让刷新图标在请求期间旋转
    }
    fetch(statsUrl(force), { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (d) {
        state.loadError = null
        if (d && typeof d === 'object') state.stats = d
        render()
      })
      .catch(function (err) {
        state.loadError = String(err && err.message ? err.message : err)
        render()
      })
      .finally(function () {
        if (force) {
          // 至少转满一圈(0.8s)再停止,避免快速请求时动画一闪而过
          var remain = 800 - (Date.now() - (state.refreshAt || Date.now()))
          setTimeout(function () {
            state.refreshing = false
            render()
          }, Math.max(0, remain))
        }
      })
  }

  // ---- 事件 ----
  function stop(e) { e.stopPropagation() }

  refreshBtn.addEventListener('pointerdown', stop)
  refreshBtn.addEventListener('click', function (e) { e.stopPropagation(); load(true) })
  minBtn.addEventListener('pointerdown', stop)
  minBtn.addEventListener('click', function (e) { e.stopPropagation(); state.minimized = true; save(); render() })
  closeBtn.addEventListener('pointerdown', stop)
  closeBtn.addEventListener('click', function (e) { e.stopPropagation(); state.closed = true; save(); render() })

  function fillPriceInputs() {
    priceMissIn.value = state.prices.miss
    priceHitIn.value = state.prices.hit
    priceOutIn.value = state.prices.out
    pricePeakIn.value = state.prices.peak
  }
  function readPriceInput(inp) {
    var n = Number(inp.value)
    return (inp.value !== '' && isFinite(n) && n >= 0) ? n : null
  }
  menuBtn.addEventListener('pointerdown', stop)
  menuBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    if (state.menuOpen) { state.menuOpen = false; render(); return }
    fillPriceInputs()
    menuErrEl.textContent = ''
    menuErrEl.style.display = 'none'
    state.menuOpen = true
    render()
  })
  menuSaveBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    var mv = readPriceInput(priceMissIn)
    var hv = readPriceInput(priceHitIn)
    var ov = readPriceInput(priceOutIn)
    var pv = readPriceInput(pricePeakIn)
    if (mv === null || hv === null || ov === null || pv === null) {
      menuErrEl.textContent = '请输入不小于 0 的有效数字'
      menuErrEl.style.display = 'block'
      return
    }
    state.prices = { hit: hv, miss: mv, out: ov, peak: pv }
    save()
    state.menuOpen = false
    render()
    load(true)
  })
  menuResetBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    state.prices = { hit: DEFAULT_PRICES.hit, miss: DEFAULT_PRICES.miss, out: DEFAULT_PRICES.out, peak: DEFAULT_PRICES.peak }
    fillPriceInputs()
    save()
    state.menuOpen = false
    render()
    load(true)
  })

  pill.addEventListener('click', function () { state.minimized = false; save(); render() })
  pill.addEventListener('pointerdown', startDrag)
  reopen.addEventListener('click', function () { state.closed = false; save(); render() })

  spendRow.addEventListener('click', function () { state.expSpend = !state.expSpend; render() })
  todayRow.addEventListener('click', function () { state.expToday = !state.expToday; render() })
  tokensRow.addEventListener('click', function () { state.expTokens = !state.expTokens; render() })

  topbar.addEventListener('pointerdown', startDrag)
  grip.addEventListener('pointerdown', startResize)

  function startDrag(ev) {
    if (ev.button !== 0) return
    ev.preventDefault()
    var sx = ev.clientX, sy = ev.clientY
    var l0 = state.pos.left, t0 = state.pos.top
    function move(mev) {
      state.pos.left = Math.min(Math.max(0, l0 + mev.clientX - sx), window.innerWidth - 40)
      state.pos.top = Math.min(Math.max(0, t0 + mev.clientY - sy), window.innerHeight - 24)
      applyPos(); applyVisibility()
    }
    function up() { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); save() }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function startResize(ev) {
    if (ev.button !== 0) return
    ev.preventDefault(); ev.stopPropagation()
    var sx = ev.clientX, sy = ev.clientY
    var w0 = state.size.w, h0 = state.size.h, l0 = state.pos.left
    var edg = edge()
    function move(mev) {
      var dx = mev.clientX - sx, dy = mev.clientY - sy
      var nw, nl = l0
      if (edg === 'right') { nw = Math.max(MINW, w0 + dx) } else { nw = Math.max(MINW, w0 - dx); nl = l0 + (w0 - nw) }
      var nh = Math.max(MINH, h0 + dy)
      state.size = { w: nw, h: nh }
      state.pos.left = nl
      applyPos()
    }
    function up() { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); save() }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  document.body.appendChild(root)
  document.body.appendChild(pill)
  document.body.appendChild(reopen)

  if (typeof MutationObserver !== 'undefined') {
    var mo = new MutationObserver(function () {
      var d = readDark()
      if (d !== state.dark) { state.dark = d; render() }
    })
    mo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  }

  load(false)
  setInterval(function () { load(false) }, REFRESH_MS)
  render()
})()
`

// ============================================================================
// 宿主插件
// ============================================================================
const name = 'deepseek-balance-glass-panel'
const inject = ['webServer', 'credentials']

function apply(ctx) {
  const sessions = ctx.get('sessions')
  const sessionProjections = ctx.get('sessionProjections')
  const sessionQuery = ctx.get('sessionQuery')
  const disposers = []

  // ---- 余额 ----
  let balanceCache = { at: 0, payload: null }
  let balanceInFlight = null

  // ---- 今日花销记账（余额差值法，与余额同一 DEEPSEEK_API_KEY 方法）----
  let ledger = (() => {
    const whale = readJson(WHALE_LEDGER)
    if (whale && typeof whale.todayUsage === 'number' && whale.date === todayDateStr()) {
      return { date: whale.date, lastBalance: typeof whale.lastBalance === 'number' ? whale.lastBalance : null, todayUsage: whale.todayUsage }
    }
    const own = readJson(GLASS_LEDGER)
    if (own && typeof own.todayUsage === 'number') {
      return { date: typeof own.date === 'string' ? own.date : null, lastBalance: typeof own.lastBalance === 'number' ? own.lastBalance : null, todayUsage: own.todayUsage }
    }
    return { date: null, lastBalance: null, todayUsage: 0 }
  })()

  function applyLedger(current) {
    const date = todayDateStr()
    if (ledger.date !== date) {
      ledger = { date, lastBalance: current, todayUsage: 0 }
    } else if (typeof ledger.lastBalance === 'number' && current < ledger.lastBalance) {
      ledger.todayUsage = (typeof ledger.todayUsage === 'number' ? ledger.todayUsage : 0) + (ledger.lastBalance - current)
    }
    ledger.lastBalance = current
    writeJson(GLASS_LEDGER, { date: ledger.date, lastBalance: ledger.lastBalance, todayUsage: ledger.todayUsage })
  }

  async function fetchBalance(force) {
    const now = Date.now()
    if (!force && balanceCache.payload && now - balanceCache.at < BALANCE_TTL_MS) return balanceCache.payload
    if (balanceInFlight) return balanceInFlight
    balanceInFlight = (async () => {
      let value = null
      let currency = 'CNY'
      let error = null
      try {
        let cred = null
        try { cred = await ctx.credentials.resolve('DEEPSEEK_API_KEY') } catch (err) { error = '凭据读取失败: ' + String((err && err.message) || err) }
        if (cred && cred.value) {
          try {
            const res = await fetch(BALANCE_URL, { headers: { Authorization: 'Bearer ' + cred.value }, signal: AbortSignal.timeout(20000) })
            if (res.ok) {
              const data = await res.json()
              const info = data && Array.isArray(data.balance_infos) ? data.balance_infos[0] : null
              if (info && info.total_balance !== undefined) {
                value = Number(info.total_balance)
                currency = String(info.currency || 'CNY')
              } else {
                error = '余额接口返回结构异常'
              }
            } else {
              error = 'HTTP ' + res.status
            }
          } catch (err) {
            error = String((err && err.message) || err)
          }
        } else if (!error) {
          error = '未配置 DEEPSEEK_API_KEY'
        }
        if (value === null && typeof ledger.lastBalance === 'number') {
          value = ledger.lastBalance
          currency = 'CNY'
          error = error || '余额接口失败,以下为最近观测值'
        }
        if (value !== null) applyLedger(value)
      } catch (err) {
        error = String((err && err.message) || err)
      }
      const payload = { ok: value !== null, value, currency, error: value === null ? (error || '获取失败') : error, at: Date.now() }
      balanceCache = { at: Date.now(), payload }
      return payload
    })()
    const p = balanceInFlight
    p.finally(() => { if (balanceInFlight === p) balanceInFlight = null }).catch(() => {})
    return p
  }

  // ---- 最近活跃会话跟踪 ----
  let currentSid = null
  // 重启后先从状态文件恢复最近活跃会话与其统计快照,避免重启后会话数据(花销/tokens/任务)为空
  let savedSnap = null
  let lastPersistedSid = null
  let lastPersistAt = 0
  let lastPersistedSnap = null
  try {
    const st = readJson(GLASS_STATE)
    if (st && typeof st.lastSid === 'string' && st.lastSid) currentSid = st.lastSid
    if (st && st.snap && typeof st.snap === 'object') savedSnap = st.snap
  } catch (err) { /* 无状态文件时从事件重新建立 */ }
  function persistSid(sid) {
    const now = Date.now()
    const snapChanged = savedSnap !== lastPersistedSnap
    if (!snapChanged && sid === lastPersistedSid && now - lastPersistAt < 10000) return
    lastPersistedSid = sid
    lastPersistAt = now
    lastPersistedSnap = savedSnap
    try { writeJson(GLASS_STATE, { lastSid: sid, lastAt: now, snap: savedSnap }) } catch (err) {}
  }
  try {
    disposers.push(ctx.on('session/event', (session, event) => {
      const sid = String(session.id)
      // 仅作「widget 未带 sid 参数」时的兜底;GLASS_STATE 由 getStats 以用户正在查看的会话写入
      currentSid = sid
      const e = entryFor(sid)
      if (event.seq >= e.lastSeq) {
        applyEvent(e, event, sid)
        e.lastSeq = event.seq + 1
      }
    }))
  } catch (err) {
    /* 事件不可用时仅失去实时性，轮询仍可冷读 */
  }

  async function sync(sid) {
    const e = entryFor(sid)
    if (sessions) {
      const session = sessions.get(sid)
      if (session && session.events) {
        const events = session.events
        const n = events.length
        if (n > e.lastSeq) {
          for (let i = e.lastSeq; i < n; i++) applyEvent(e, events[i], sid)
          e.lastSeq = n
        }
        return
      }
    }
    if (!e.seeded) {
      e.seeded = true
      if (sessionQuery) {
        try {
          // 冷读加 3s 超时,防止 readSession 挂起时 stats.json 请求也卡住
          const snap = await Promise.race([
            sessionQuery.readSession(sid),
            new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
          ])
          const events = snap && snap.events ? snap.events : []
          for (let i = 0; i < events.length; i++) applyEvent(e, events[i], sid)
          e.lastSeq = Math.max(e.lastSeq, events.length)
        } catch (err) { /* 冷读失败则下次重试 */ }
      }
    }
  }

  // 今日花销冷读回填(每日一次):重启后把所有会话(含仅持久化、未活跃的)今日事件重放进全局今日桶,
  // 补上「插件未运行时发生」的用量。sync 幂等(lastSeq/seeded),后续轮询只补新事件。
  async function backfillToday() {
    const day = beijingDay(Date.now())
    if (todayBackfillDay === day) return
    todayBackfillDay = day // 失败也当日不再重试;实时事件流仍会持续累计
    if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') return
    try {
      const records = await sessionQuery.listSessions()
      const sids = records
        .map((r) => r && r.header && r.header.id)
        .filter(Boolean)
        .slice(0, 50) // newest-first 上限,超大语料也不失控
      const CHUNK = 4
      for (let i = 0; i < sids.length; i += CHUNK) {
        await Promise.all(sids.slice(i, i + CHUNK).map((sid) => sync(sid).catch(() => {})))
      }
    } catch (err) { /* 回填失败不阻塞 */ }
  }

  function snapshotStats(sid, e, price) {
    let task = null
    let tokens = null
    let todos = null
    if (sessions && sessionProjections && sid) {
      try {
        const session = sessions.get(sid)
        if (session) {
          const snap = sessionProjections.snapshot(session)
          const goal = snap.values && snap.values.goal
          if (goal && goal.goal) task = { objective: goal.goal.objective, phase: goal.goal.phase }
          const tu = snap.values && snap.values.tokenUsage
          if (tu) tokens = { hit: tu.cacheReadTokens, miss: tu.uncachedInputTokens, write: tu.cacheWriteTokens, out: tu.outputTokens }
          const todoList = snap.values && snap.values.todos
          if (Array.isArray(todoList)) todos = todoList.map((t) => ({ content: String(t.content || ''), status: t.status }))
        }
      } catch (err) { /* 忽略投影快照失败 */ }
    }
    if (e && Array.isArray(e.todos) && e.todos.length > 0) todos = e.todos
    const price0 = price || PRICE
    const costOf = (b, peak) => costOfBuckets(b, peak, price0)
    const tokensOf = tokensOfBuckets
    if (tokens === null && e) {
      tokens = {
        hit: e.state.peak.hit + e.state.idle.hit,
        miss: e.state.peak.miss + e.state.idle.miss,
        write: e.state.peak.write + e.state.idle.write,
        out: e.state.peak.out + e.state.idle.out,
      }
    }
    // 事件累计只覆盖插件加载后的近端会话;投影 tokenUsage 才是全量权威值。
    // 以投影总量按事件峰谷比例放大:既得到真实总额,又保留峰谷拆分。
    // 桶(buckets)存放大后的 token 明细,重启兜底时可按当时价格重算金额。
    const ZB = { miss: 0, hit: 0, write: 0, out: 0 }
    let buckets = { peak: { ...ZB }, idle: { ...ZB } }
    const tBuckets = { peak: e ? e.today.peak : ZB, idle: e ? e.today.idle : ZB }
    if (e) {
      const evPeakTok = tokensOf(e.state.peak)
      const evIdleTok = tokensOf(e.state.idle)
      const evTotal = evPeakTok + evIdleTok
      const projTotal = tokens ? tokensOf(tokens) : evTotal
      if (evTotal > 0) {
        const scale = projTotal / evTotal
        const sb = (b) => ({ miss: b.miss * scale, hit: b.hit * scale, write: b.write * scale, out: b.out * scale })
        buckets = { peak: sb(e.state.peak), idle: sb(e.state.idle) }
      } else if (projTotal > 0) {
        // 尚无事件拆分数据:按当前峰谷状态整笔计入,保证总额正确
        const nowPeak = isPeakTime(Date.now())
        const norm = (t) => ({ miss: t.miss || 0, hit: t.hit || 0, write: t.write || 0, out: t.out || 0 })
        buckets = nowPeak
          ? { peak: norm(tokens), idle: { ...ZB } }
          : { peak: { ...ZB }, idle: norm(tokens) }
      }
    }
    const spend = {
      peak: { cost: costOf(buckets.peak, true), tokens: Math.round(tokensOf(buckets.peak)) },
      idle: { cost: costOf(buckets.idle, false), tokens: Math.round(tokensOf(buckets.idle)) },
      total: 0,
    }
    spend.total = spend.peak.cost + spend.idle.cost
    const today = {
      peak: { cost: costOf(tBuckets.peak, true), tokens: tokensOf(tBuckets.peak) },
      idle: { cost: costOf(tBuckets.idle, false), tokens: tokensOf(tBuckets.idle) },
      total: 0,
    }
    today.total = today.peak.cost + today.idle.cost
    return {
      task,
      todos,
      tokens,
      spend,
      today,
      buckets,
      todayBuckets: { peak: tBuckets.peak, idle: tBuckets.idle },
    }
  }

  function computeToday(localToday) {
    const lpeak = localToday.peak
    const lidle = localToday.idle
    const localTotal = lpeak.cost + lidle.cost
    const localTokens = (lpeak.tokens || 0) + (lidle.tokens || 0)
    // 当前会话今日有真实 token 用量:按当前(自定义)价格估算,自定义价格立即生效
    if (localTokens > 0 || localTotal > 0) {
      return { peak: lpeak, idle: lidle, total: localTotal, source: 'local' }
    }
    // 当前会话今日无事件数据:回退余额差值记账(真实扣款,今日全部会话)
    if (ledger.date === todayDateStr() && typeof ledger.todayUsage === 'number' && isFinite(ledger.todayUsage) && ledger.todayUsage > 0) {
      const total = ledger.todayUsage
      if (isPeakTime(Date.now())) {
        return { peak: { cost: total, tokens: 0 }, idle: { cost: 0, tokens: 0 }, total, source: 'balance', error: '今日暂无本会话事件,以下为余额差值记账(今日全部会话)' }
      }
      return { peak: { cost: 0, tokens: 0 }, idle: { cost: total, tokens: 0 }, total, source: 'balance', error: '今日暂无本会话事件,以下为余额差值记账(今日全部会话)' }
    }
    return { peak: lpeak, idle: lidle, total: 0, source: 'local' }
  }

  async function getStats(force, price, sid) {
    const balance = await fetchBalance(force)
    // 全局今日桶跨天滚动:无事件的新一天不能沿用昨天桶
    const dayNow = beijingDay(Date.now())
    if (globalToday.key !== dayNow) {
      globalToday.key = dayNow
      globalToday = { peak: zero(), idle: zero(), lastByStep: new Map(), key: dayNow }
    }
    // 首次请求(每日一次)冷读回填全部会话的今日用量;最多等 3 秒,超时则后台继续、下轮补全
    await Promise.race([backfillToday(), new Promise((resolve) => setTimeout(resolve, 3000))])
    // widget 上报的「当前选中的会话」优先;缺失时回退最近活跃会话(旧行为)
    const targetSid = (typeof sid === 'string' && sid) ? sid : currentSid
    let e = null
    if (targetSid) {
      const entry = entryFor(targetSid)
      const dayNow = beijingDay(Date.now())
      if (entry.todayKey !== dayNow) {
        entry.todayKey = dayNow
        entry.today = { peak: zero(), idle: zero(), lastByStep: new Map() }
      }
      await sync(targetSid)
      e = states.get(targetSid)
    }
    const stats = snapshotStats(targetSid, e, price)
    // 今日花销 = 全部会话今日用量之和(全局累计器),按当前(自定义)价格计价
    const price0 = price || PRICE
    const g = globalToday
    const todayLocal = {
      peak: { cost: costOfBuckets(g.peak, true, price0), tokens: tokensOfBuckets(g.peak) },
      idle: { cost: costOfBuckets(g.idle, false, price0), tokens: tokensOfBuckets(g.idle) },
      total: 0,
    }
    todayLocal.total = todayLocal.peak.cost + todayLocal.idle.cost
    const today = computeToday(todayLocal)

    // 有真实会话数据时,把统计快照持久化,供重启后会话未活跃时兜底。
    // 快照保存 token 桶而非算好的金额,兜底时可按当前价格重算。
    const snapTok = (b) => (b ? ((b.miss || 0) + (b.hit || 0) + (b.write || 0) + (b.out || 0)) : 0)
    const statTokTotal = stats.tokens ? snapTok(stats.tokens) : 0
    const hasLive = !!(statTokTotal > 0 || (stats.todos && stats.todos.length) || stats.task || stats.spend.total > 0)
    if (hasLive) {
      savedSnap = {
        at: Date.now(),
        tokens: stats.tokens,
        buckets: stats.buckets,
        todayBuckets: { peak: g.peak, idle: g.idle }, // 全局今日桶(重启兜底显示用)
        todos: stats.todos,
        task: stats.task,
      }
      if (targetSid) persistSid(targetSid)
    }

    // 重启后会话未活跃(无投影、无事件)时,用最近一次快照兜底,避免除余额外全是 0
    const snapTotal = savedSnap
      ? snapTok(savedSnap.tokens) + snapTok(savedSnap.buckets && savedSnap.buckets.peak) + snapTok(savedSnap.buckets && savedSnap.buckets.idle)
      : 0
    const snapHasData = !!(snapTotal > 0 || (savedSnap && savedSnap.todos && savedSnap.todos.length) || (savedSnap && savedSnap.task))
    if (!hasLive && snapHasData) {
      const price0 = price || PRICE
      const costOf = (b, peak) => costOfBuckets(b, peak, price0)
      const tokensOf = tokensOfBuckets
      const fromBuckets = (pk, id) => {
        const peak = { cost: costOf(pk, true), tokens: tokensOf(pk) }
        const idle = { cost: costOf(id, false), tokens: tokensOf(id) }
        return { peak, idle, total: peak.cost + idle.cost }
      }
      const spend = savedSnap.buckets
        ? fromBuckets(savedSnap.buckets.peak, savedSnap.buckets.idle)
        : savedSnap.spend
      const localToday = savedSnap.todayBuckets
        ? fromBuckets(savedSnap.todayBuckets.peak, savedSnap.todayBuckets.idle)
        : (savedSnap.today || { peak: { cost: 0, tokens: 0 }, idle: { cost: 0, tokens: 0 }, total: 0, source: 'local' })
      return {
        sessionId: targetSid,
        balance,
        isPeak: isPeakTime(Date.now()),
        task: savedSnap.task,
        todos: savedSnap.todos,
        tokens: savedSnap.tokens,
        spend,
        today: computeToday(localToday),
      }
    }

    return {
      sessionId: targetSid,
      balance,
      isPeak: isPeakTime(Date.now()),
      task: stats.task,
      todos: stats.todos,
      tokens: stats.tokens,
      spend: stats.spend,
      today,
    }
  }

  // ---- 路由 ----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-glass/stats.json',
    handler: async (req, res) => {
      try {
        const url = req.url || ''
        const force = url.indexOf('refresh=1') !== -1
        const price = parsePriceParams(url) || PRICE
        // 客户端 widget 把「当前选中的会话」(localStorage['dsh.sessions.current'])经 sid 参数上报;
        // 缺失时回退最近活跃会话。
        let sid = null
        const qi = url.indexOf('?')
        if (qi >= 0) {
          try {
            const q = new URLSearchParams(url.slice(qi + 1))
            const raw = q.get('sid')
            if (typeof raw === 'string' && raw && raw.length <= 200) sid = raw
          } catch (err) { /* 忽略坏 query */ }
        }
        const payload = await getStats(force, price, sid)
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(payload))
      } catch (err) {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-glass/widget.js',
    handler: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(WIDGET_JS)
    },
  }))

  disposers.push(ctx.webServer.tapIndex((html) => {
    if (html.indexOf('/dsh-glass/widget.js') !== -1) return html
    const tag = '<script defer src="/dsh-glass/widget.js"></script>'
    if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
    return html + tag
  }))

  ctx.effect(() => () => {
    for (const d of disposers) {
      try { d() } catch (err) {}
    }
  })
}

export { name, inject, apply }
