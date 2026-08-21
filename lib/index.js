// deepseek-balance-glass-panel —— DeepSeek 玻璃余额面板（DSH 插件包）
// 主机端：余额 / 今日花销（余额差额账本，与 deepseek 官网口径一致）/ 会话统计 / 当前任务
// 客户端：悬浮玻璃拟态面板（vanilla JS，无构建、无依赖）
//
// 挂载方式：package.json 的 "dsh"."bundle"."patch" 指向 ./cordis.patch.yml，
// DSH 启动时把本插件注入 host 组合（格式参考 dsh-whale-widget）。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import { join, dirname } from 'node:path'

// ---------- 常量 ----------
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
// 单价（CNY / 百万 tokens）：hit=缓存读、miss=未命中输入、out=输出
const PRICE = {
  hit: { idle: 0.05, peak: 0.1 },
  miss: { idle: 1.5, peak: 3.0 },
  out: { idle: 4.5, peak: 9.0 },
}
// 北京时区高峰时段：9:00-12:00、14:00-18:00
const PEAK_HOURS = [9, 10, 11, 12, 14, 15, 16, 17]
const GLASS_LEDGER = '.dsh-glass-usage.json' // 本插件自己的当日账本（~ 下）
const WHALE_LEDGER = '.dshw-usage.json' // whale 插件的当日账本（作 seed，同口径：余额差额）
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

// ---------- 小工具 ----------
function beijingDay(ms) {
  const d = new Date(ms + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
function isPeakTime(ms) {
  const h = new Date(ms + 8 * 3600 * 1000).getUTCHours()
  return PEAK_HOURS.includes(h)
}
function todayDateStr() {
  return beijingDay(Date.now())
}
function readJson(file) {
  try {
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
function writeJson(file, obj) {
  try {
    const d = dirname(file)
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    writeFileSync(file, JSON.stringify(obj, null, 2))
  } catch {
    // 写失败忽略（只读环境也能正常显示）
  }
}

// ---------- 会话统计（可选服务；拿不到就显示占位） ----------
const states = new Map()
function entryFor(sid) {
  let e = states.get(sid)
  if (!e) {
    e = {
      sid,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      started: 0,
      last: 0,
      cost: 0,
      eventCount: 0,
    }
    states.set(sid, e)
  }
  return e
}
// 把一次事件里的 tokens 累计进会话条目，返回本次事件成本（元）
function applyEvent(e, ev) {
  const t = ev && ev.data && ev.data.tokens ? ev.data.tokens : ev && ev.tokens
  if (!t) return 0
  const now = Date.now()
  if (!e.started) e.started = now
  e.last = now
  e.eventCount++
  const input = t.inputTokens || 0
  const output = t.outputTokens || 0
  const cacheRead = t.cacheReadTokens || 0
  const cacheWrite = t.cacheWriteTokens || 0
  e.tokens.input += input
  e.tokens.output += output
  e.tokens.cacheRead += cacheRead
  e.tokens.cacheWrite += cacheWrite
  const p = isPeakTime(now) ? 'peak' : 'idle'
  const hit = cacheRead
  const miss = Math.max(0, input - cacheRead)
  const cost = (hit * PRICE.hit[p] + miss * PRICE.miss[p] + output * PRICE.out[p]) / 1e6
  e.cost += cost
  return cost
}

// ---------- 客户端面板（vanilla JS；String.raw 保持反斜杠原样） ----------
const WIDGET_JS = String.raw`(() => {
  if (window.__DSH_GLASS__) return
  window.__DSH_GLASS__ = true

  var LS_KEY = 'deepseek-balance-glass-panel-v1'
  var POLL_MS = 5000

  function fmt(n, d) {
    if (n == null || isNaN(n)) return '--'
    var v = Number(n)
    if (d == null) d = v >= 100 ? 0 : (v >= 10 ? 1 : 2)
    return v.toFixed(d)
  }
  function fmtK(n) {
    if (n == null || isNaN(n)) return '--'
    var v = Number(n)
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
    return String(Math.round(v))
  }
  function fmtTime(ms) {
    if (!ms) return '--:--'
    var d = new Date(ms)
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  function h(tag, attrs, children) {
    var el = document.createElement(tag)
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k]
        if (v == null) continue
        if (k === 'class') el.className = v
        else if (k === 'style') el.style.cssText = v
        else if (k === 'html') el.innerHTML = v
        else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v)
        else el.setAttribute(k, v)
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) {
        var c = children[i]
        if (c == null) continue
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
      }
    }
    return el
  }

  var ICONS = {
    chev: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 10 10 6 6 2"/></svg>',
    sun: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><circle cx="8" cy="8" r="3.2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3"/></svg>',
    moon: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5 6 6 0 1 0 13.5 10.2z"/></svg>',
    close: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3l10 10M13 3L3 13"/></svg>',
  }

  var state = { theme: 'glass', x: 24, y: 24, w: 300, h: 0, collapsed: {}, stats: null }
  try {
    var saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null')
    if (saved) {
      if (saved.theme) state.theme = saved.theme
      if (typeof saved.x === 'number') state.x = saved.x
      if (typeof saved.y === 'number') state.y = saved.y
      if (typeof saved.w === 'number') state.w = saved.w
      if (typeof saved.h === 'number') state.h = saved.h
    }
  } catch (e) {}

  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)) } catch (e) {}
  }

  var CSS = [
    '.gp-panel{position:fixed;left:24px;top:24px;width:300px;z-index:999999;display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:rgba(30,41,59,.92);border-radius:18px;background:rgba(255,255,255,.62);border:1px solid rgba(255,255,255,.65);box-shadow:0 12px 40px rgba(15,23,42,.16),inset 0 1px 0 rgba(255,255,255,.7);backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4);overflow:hidden;user-select:none;font-size:13px;line-height:1.45}',
    '.gp-panel[data-theme="dark"]{color:rgba(226,232,240,.94);background:rgba(15,23,42,.74);border-color:rgba(148,163,184,.28);box-shadow:0 12px 40px rgba(0,0,0,.5),inset 0 1px 0 rgba(148,163,184,.18)}',
    '.gp-panel[data-theme="light"]{color:rgba(30,41,59,.95);background:rgba(255,255,255,.96);border-color:rgba(15,23,42,.1);box-shadow:0 12px 40px rgba(15,23,42,.18)}',
    '.gp-head{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:grab;background:rgba(255,255,255,.35);border-bottom:1px solid rgba(148,163,184,.18);flex:none}',
    '.gp-head:active{cursor:grabbing}',
    '.gp-panel[data-theme="dark"] .gp-head{background:rgba(30,41,59,.35)}',
    '.gp-dots{display:flex;gap:5px;flex:none}',
    '.gp-dot{width:11px;height:11px;border-radius:50%;border:1px solid rgba(15,23,42,.08);flex:none}',
    '.gp-dot.r{background:#ff5f57}.gp-dot.y{background:#febc2e}.gp-dot.g{background:#28c840}',
    '.gp-title{flex:1;font-size:12px;font-weight:600;letter-spacing:.3px;text-align:center;opacity:.9}',
    '.gp-icon-btn{display:flex;align-items:center;justify-content:center;width:22px;height:22px;border:none;border-radius:6px;background:transparent;color:inherit;opacity:.75;cursor:pointer;flex:none;padding:0}',
    '.gp-icon-btn:hover{background:rgba(148,163,184,.25);opacity:1}',
    '.gp-body{padding:8px 12px 10px;flex:1 1 auto;overflow-y:auto;max-height:60vh}',
    '.gp-row{display:flex;align-items:center;justify-content:flex-start;gap:8px;font-size:12.5px;padding:7px 8px;margin:0 -8px;border-radius:9px;cursor:pointer;transition:background .12s ease}',
    '.gp-row:hover{background:rgba(148,163,184,.16)}',
    '.gp-row .gp-chev{display:flex;flex:none;opacity:.55;transition:transform .15s ease}',
    '.gp-row.open .gp-chev{transform:rotate(90deg)}',
    '.gp-row .gp-label{font-weight:500;white-space:nowrap}',
    '.gp-row .gp-val{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}',
    '.gp-row .gp-val.dim{opacity:.55;font-weight:500}',
    '.gp-sub{display:none;padding:2px 8px 8px 24px;font-size:12px}',
    '.gp-row.open + .gp-sub{display:block}',
    '.gp-sub-line{display:flex;justify-content:space-between;gap:8px;padding:2.5px 0;opacity:.78}',
    '.gp-sub-line b{font-weight:600;font-variant-numeric:tabular-nums;opacity:1}',
    '.gp-err{padding:3px 8px 6px;font-size:11px;color:#dc2626;opacity:.85}',
    '.gp-foot{display:flex;align-items:center;gap:7px;padding:8px 14px 10px;font-size:11px;opacity:.72;border-top:1px solid rgba(148,163,184,.16);flex:none}',
    '.gp-peak-dot{width:8px;height:8px;border-radius:50%;flex:none}',
    '.gp-peak-dot.on{background:#f59e0b;box-shadow:0 0 6px rgba(245,158,11,.9)}',
    '.gp-peak-dot.off{background:#34d399;box-shadow:0 0 6px rgba(52,211,153,.8)}',
    '.gp-time{margin-left:auto;font-variant-numeric:tabular-nums}',
    '.gp-resize{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;opacity:.35;background:linear-gradient(135deg,transparent 50%,currentColor 50%);border-bottom-right-radius:16px}',
    '.gp-resize:hover{opacity:.8}',
    '.gp-fab{position:fixed;left:16px;bottom:16px;z-index:999999;width:40px;height:40px;border-radius:50%;display:none;align-items:center;justify-content:center;cursor:pointer;font-size:18px;background:rgba(255,255,255,.72);border:1px solid rgba(255,255,255,.6);box-shadow:0 6px 20px rgba(15,23,42,.2);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);color:rgba(30,41,59,.9)}',
    '.gp-fab:hover{transform:scale(1.06)}'
  ].join('\n')

  var style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  var panel = h('div', { class: 'gp-panel' })
  panel.style.left = state.x + 'px'
  panel.style.top = state.y + 'px'
  panel.style.width = state.w + 'px'
  if (state.h > 0) panel.style.height = state.h + 'px'

  // ---------- 头部（拖拽区） ----------
  function cycleTheme() {
    var list = ['glass', 'dark', 'light']
    var i = list.indexOf(state.theme)
    state.theme = list[(i + 1) % list.length]
    panel.setAttribute('data-theme', state.theme)
    themeBtn.innerHTML = state.theme === 'dark' ? ICONS.moon : ICONS.sun
    save()
  }
  function hidePanel() {
    panel.style.display = 'none'
    fab.style.display = 'flex'
  }
  function showPanel() {
    panel.style.display = 'flex'
    fab.style.display = 'none'
  }

  var themeBtn = h('button', { class: 'gp-icon-btn', title: '切换主题', onclick: cycleTheme })
  themeBtn.innerHTML = ICONS.sun
  var closeBtn = h('button', { class: 'gp-icon-btn', title: '关闭', onclick: hidePanel })
  closeBtn.innerHTML = ICONS.close
  var head = h('div', { class: 'gp-head' }, [
    h('span', { class: 'gp-dots' }, [
      h('span', { class: 'gp-dot r' }),
      h('span', { class: 'gp-dot y' }),
      h('span', { class: 'gp-dot g' })
    ]),
    h('span', { class: 'gp-title' }, ['DeepSeek 玻璃面板']),
    themeBtn,
    closeBtn
  ])

  var bodyEl = h('div', { class: 'gp-body' })
  var footEl = h('div', { class: 'gp-foot' })
  var resize = h('div', { class: 'gp-resize', title: '拖拽调整大小' })

  panel.appendChild(head)
  panel.appendChild(bodyEl)
  panel.appendChild(footEl)
  panel.appendChild(resize)
  document.body.appendChild(panel)
  panel.setAttribute('data-theme', state.theme)

  var fab = h('div', { class: 'gp-fab', title: '打开面板', onclick: showPanel }, ['📊'])
  document.body.appendChild(fab)

  // ---------- 渲染 ----------
  function render() {
    var s = state.stats
    var bal = s && s.balance ? s.balance : null
    var today = s ? s.todayUsage : 0
    var peak = s ? s.todayPeak : 0
    var idle = s ? s.todayIdle : 0
    var sess = s && s.session ? s.session : null
    var task = s && s.task ? s.task : null
    var hasTask = !!(task && task.status === 'running' && task.text)

    var rows = []

    if (s && !s.ok && s.error) {
      rows.push(h('div', { class: 'gp-err' }, [esc(s.error)]))
    }

    // 余额（静态行，不展开）
    rows.push(h('div', { class: 'gp-row bal', style: 'cursor:default' }, [
      h('span', { class: 'gp-label' }, ['余额']),
      h('span', { class: 'gp-val', style: 'font-size:13px' }, ['¥' + fmt(bal ? bal.total : null)])
    ]))

    // 今日花销（可展开：高峰 / 闲时）
    var spendOpen = !!state.collapsed.spend
    rows.push(h('div', { class: 'gp-row' + (spendOpen ? ' open' : ''), 'data-key': 'spend' }, [
      h('span', { class: 'gp-chev', html: ICONS.chev }),
      h('span', { class: 'gp-label' }, ['今日花销']),
      h('span', { class: 'gp-val' }, ['¥' + fmt(today)])
    ]))
    rows.push(h('div', { class: 'gp-sub' }, [
      h('div', { class: 'gp-sub-line' }, [h('span', {}, ['高峰时段']), h('b', {}, ['¥' + fmt(peak)])]),
      h('div', { class: 'gp-sub-line' }, [h('span', {}, ['闲时时段']), h('b', {}, ['¥' + fmt(idle)])])
    ]))

    // 本次会话（可展开：tokens 明细）
    var sessOpen = !!state.collapsed.session
    var sessVal = sess
      ? '¥' + fmt(sess.cost) + ' · ' + fmtK((sess.tokens.input || 0) + (sess.tokens.output || 0))
      : '无会话'
    rows.push(h('div', { class: 'gp-row' + (sessOpen ? ' open' : ''), 'data-key': 'session' }, [
      h('span', { class: 'gp-chev', html: ICONS.chev }),
      h('span', { class: 'gp-label' }, ['本次会话']),
      h('span', { class: 'gp-val' }, [sessVal])
    ]))
    rows.push(h('div', { class: 'gp-sub' }, [
      h('div', { class: 'gp-sub-line' }, [h('span', {}, ['输入']), h('b', {}, [fmtK(sess ? sess.tokens.input : 0)])]),
      h('div', { class: 'gp-sub-line' }, [h('span', {}, ['输出']), h('b', {}, [fmtK(sess ? sess.tokens.output : 0)])]),
      h('div', { class: 'gp-sub-line' }, [h('span', {}, ['缓存读']), h('b', {}, [fmtK(sess ? sess.tokens.cacheRead : 0)])]),
      h('div', { class: 'gp-sub-line' }, [h('span', {}, ['缓存写']), h('b', {}, [fmtK(sess ? sess.tokens.cacheWrite : 0)])]),
      h('div', { class: 'gp-sub-line' }, [h('span', {}, ['事件数']), h('b', {}, [sess ? String(sess.events) : '--'])])
    ]))

    // 当前任务（可展开：完整文本）
    var taskOpen = !!state.collapsed.task
    var taskVal = hasTask ? String(task.text).slice(0, 16) : '无进行中任务'
    rows.push(h('div', { class: 'gp-row' + (taskOpen ? ' open' : ''), 'data-key': 'task' }, [
      h('span', { class: 'gp-chev', html: ICONS.chev }),
      h('span', { class: 'gp-label' }, ['当前任务']),
      h('span', { class: 'gp-val' + (hasTask ? '' : ' dim') }, [taskVal])
    ]))
    rows.push(h('div', { class: 'gp-sub' }, [
      h('div', { class: 'gp-sub-line', style: 'white-space:pre-wrap;line-height:1.5' }, [
        h('span', {}, [hasTask ? esc(task.text) : '暂无进行中的任务，开始一个任务后这里会显示。'])
      ])
    ]))

    bodyEl.innerHTML = ''
    for (var i = 0; i < rows.length; i++) bodyEl.appendChild(rows[i])

    // 底部：高峰状态 + 更新时间
    var peakNow = s ? !!s.peakNow : false
    footEl.innerHTML = ''
    footEl.appendChild(h('span', { class: 'gp-peak-dot' + (peakNow ? ' on' : ' off') }))
    footEl.appendChild(h('span', {}, [peakNow ? '高峰计费中' : '闲时计费']))
    footEl.appendChild(h('span', { class: 'gp-time' }, ['更新 ' + fmtTime(s ? s.updatedAt : 0)]))
  }

  // 展开 / 收起（事件委托）
  panel.addEventListener('click', function (ev) {
    var row = ev.target.closest ? ev.target.closest('.gp-row') : null
    if (!row || !row.getAttribute('data-key')) return
    var k = row.getAttribute('data-key')
    state.collapsed[k] = !state.collapsed[k]
    save()
    render()
  })

  // ---------- 拖拽 ----------
  var drag = null
  head.addEventListener('pointerdown', function (ev) {
    if (ev.target.closest && ev.target.closest('.gp-icon-btn')) return
    drag = { sx: ev.clientX, sy: ev.clientY, ox: state.x, oy: state.y }
    ev.preventDefault()
  })
  window.addEventListener('pointermove', function (ev) {
    if (!drag) return
    state.x = Math.max(0, Math.min(window.innerWidth - 80, drag.ox + ev.clientX - drag.sx))
    state.y = Math.max(0, Math.min(window.innerHeight - 60, drag.oy + ev.clientY - drag.sy))
    panel.style.left = state.x + 'px'
    panel.style.top = state.y + 'px'
  })
  window.addEventListener('pointerup', function () {
    if (!drag) return
    drag = null
    save()
  })

  // ---------- 缩放 ----------
  var rz = null
  resize.addEventListener('pointerdown', function (ev) {
    rz = { sx: ev.clientX, sy: ev.clientY, ow: state.w, oh: state.h || panel.offsetHeight }
    ev.preventDefault()
    ev.stopPropagation()
  })
  window.addEventListener('pointermove', function (ev) {
    if (!rz) return
    state.w = Math.max(240, Math.min(480, rz.ow + ev.clientX - rz.sx))
    state.h = Math.max(160, rz.oh + ev.clientY - rz.sy)
    panel.style.width = state.w + 'px'
    panel.style.height = state.h + 'px'
  })
  window.addEventListener('pointerup', function () {
    if (!rz) return
    rz = null
    save()
  })

  // ---------- 轮询 ----------
  function poll() {
    fetch('/dsh-glass/stats.json')
      .then(function (r) { return r.json() })
      .then(function (j) {
        state.stats = j
        render()
      })
      .catch(function () { /* 保留旧数据 */ })
  }
  poll()
  setInterval(poll, POLL_MS)
})()`

// ---------- 插件主体 ----------
export const name = 'deepseek-balance-glass-panel'
export const inject = ['webServer', 'credentials']

export function apply(ctx) {
  const stats = {
    ok: false,
    error: '',
    updatedAt: 0,
    peakNow: false,
    balance: { available: 0, total: 0, currency: 'CNY' },
    todayUsage: 0,
    todayPeak: 0,
    todayIdle: 0,
    session: null,
    task: { text: '', status: 'none' },
  }

  // 账本：余额差额 = 今日花销（与 deepseek 官网口径一致）
  let dayKey = todayDateStr()
  let ledger = readJson(join(os.homedir(), GLASS_LEDGER))
  if (!ledger || ledger.date !== dayKey) {
    const whale = readJson(join(os.homedir(), WHALE_LEDGER))
    if (whale && whale.date === dayKey && typeof whale.todayUsage === 'number') {
      ledger = { date: dayKey, lastBalance: whale.lastBalance ?? null, todayUsage: whale.todayUsage, todayPeak: 0, todayIdle: 0 }
    } else {
      ledger = { date: dayKey, lastBalance: null, todayUsage: 0, todayPeak: 0, todayIdle: 0 }
    }
    writeJson(join(os.homedir(), GLASS_LEDGER), ledger)
  }
  // 当日高峰/闲时拆分（来自会话事件的计价累计）
  let usagePeak = ledger.todayPeak || 0
  let usageIdle = ledger.todayIdle || 0

  const sessions = ctx.get('sessions')
  const projections = ctx.get('sessionProjections')
  let lastTodos = []
  let lastTodoAt = 0

  const storeLedger = () => {
    ledger.todayPeak = usagePeak
    ledger.todayIdle = usageIdle
    writeJson(join(os.homedir(), GLASS_LEDGER), ledger)
  }

  // 任务显示：todos projection 会在 turn/start 被清空，
  // 所以跟踪最近一次 todo/write 事件里的列表（持久于插件状态）
  function updateTask(todos) {
    if (!todos || !todos.length) {
      stats.task = { text: '', status: 'none' }
      return
    }
    const active = todos.filter((t) => !/^(completed|done|cancelled|skipped|failed)$/i.test(String(t.status || '')))
    if (active.length) {
      stats.task = { text: String(active[0].content || '').slice(0, 40), status: 'running' }
    } else {
      stats.task = { text: '', status: 'none' }
    }
  }

  async function pullSession() {
    try {
      const cur = sessions && sessions.current
      if (!cur || !cur.sid) {
        stats.session = null
        return
      }
      const e = entryFor(cur.sid)
      if (projections && projections.snapshot) {
        const snap = await projections.snapshot(cur)
        const v = snap && snap.values ? snap.values : null
        const tu = v && v.tokenUsage
        if (tu) {
          e.tokens.cacheRead = tu.cacheReadTokens || 0
          e.tokens.cacheWrite = tu.cacheWriteTokens || 0
          e.tokens.input = tu.uncachedInputTokens || 0
          e.tokens.output = tu.outputTokens || 0
        }
        const p = isPeakTime(Date.now()) ? 'peak' : 'idle'
        e.cost = (e.tokens.cacheRead * PRICE.hit[p] + e.tokens.input * PRICE.miss[p] + e.tokens.output * PRICE.out[p]) / 1e6
        const goal = v && v.goal
        stats.session = {
          sid: cur.sid,
          title: goal && goal.objective ? String(goal.objective).slice(0, 30) : String(cur.sid || '').slice(0, 30),
          phase: goal && goal.phase ? String(goal.phase) : '',
          tokens: { input: e.tokens.input, output: e.tokens.output, cacheRead: e.tokens.cacheRead, cacheWrite: e.tokens.cacheWrite },
          cost: e.cost,
          events: e.eventCount,
        }
        // goal 兜底：没有 todo 任务时，进行中的 goal 也算“当前任务”
        if (
          stats.task.status === 'none' &&
          goal && goal.objective &&
          !/^(completed|done|blocked|cancelled|failed|skipped)$/i.test(String(goal.phase || ''))
        ) {
          stats.task = { text: String(goal.objective).slice(0, 40), status: 'running' }
        }
      } else {
        stats.session = {
          sid: cur.sid,
          title: String(cur.sid || '').slice(0, 30),
          phase: '',
          tokens: { input: e.tokens.input, output: e.tokens.output, cacheRead: e.tokens.cacheRead, cacheWrite: e.tokens.cacheWrite },
          cost: e.cost,
          events: e.eventCount,
        }
      }
    } catch {
      stats.session = null
    }
  }

  async function refreshBalance() {
    try {
      const cred = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
      if (!cred || !cred.value) {
        stats.error = '缺少 DEEPSEEK_API_KEY'
        stats.updatedAt = Date.now()
        return
      }
      const res = await fetch(BALANCE_URL, {
        headers: { Authorization: 'Bearer ' + cred.value },
        signal: AbortSignal.timeout(8000),
      })
      const j = await res.json()
      const infos = j.balance_infos || []
      const info = infos.find((b) => b.currency === 'CNY') || infos[0]
      if (!info) {
        stats.error = j.error && j.error.message ? String(j.error.message) : '余额接口无数据'
        stats.updatedAt = Date.now()
        return
      }
      const available = Number(info.total_balance || 0)
      const granted = Number(info.granted_balance || 0)
      const total = available + granted
      stats.balance = { available, total, currency: String(info.currency || 'CNY') }
      if (ledger.lastBalance != null) {
        const delta = Math.max(0, ledger.lastBalance - total)
        if (delta > 0) {
          ledger.todayUsage += delta
          storeLedger()
        }
      }
      ledger.lastBalance = total
      storeLedger()
      stats.todayUsage = ledger.todayUsage
      stats.todayPeak = usagePeak
      stats.todayIdle = usageIdle
      stats.ok = true
      stats.error = ''
      stats.updatedAt = Date.now()
    } catch (err) {
      stats.error = '余额获取失败：' + (err && err.message ? String(err.message) : String(err))
      stats.updatedAt = Date.now()
    }
  }

  async function refreshAll() {
    const dk = todayDateStr()
    if (dk !== dayKey) {
      dayKey = dk
      ledger = { date: dk, lastBalance: null, todayUsage: 0, todayPeak: 0, todayIdle: 0 }
      usagePeak = 0
      usageIdle = 0
      storeLedger()
    }
    stats.peakNow = isPeakTime(Date.now())
    await Promise.all([refreshBalance(), pullSession()])
  }

  // ---------- webServer 路由 ----------
  const disposers = []
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-glass/stats.json',
      handler() {
        return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(stats) }
      },
    }),
  )
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-glass/widget.js',
      handler() {
        return { status: 200, headers: { 'Content-Type': 'application/javascript; charset=utf-8' }, body: WIDGET_JS }
      },
    }),
  )
  disposers.push(ctx.webServer.tapIndex((html) => html + '\n<script defer src="/dsh-glass/widget.js"></script>'))

  // ---------- 事件订阅 ----------
  if (ctx.on) {
    disposers.push(
      ctx.on('session/event', (session, event) => {
        if (!session || !session.sid) return
        const e = entryFor(session.sid)
        const cost = applyEvent(e, event)
        if (cost > 0) {
          if (isPeakTime(Date.now())) usagePeak += cost
          else usageIdle += cost
          storeLedger()
        }
        // 任务：记住最近一次 todo/write 列表
        if (event && (event.type === 'todo/write' || (event.data && Array.isArray(event.data.todos)))) {
          const todos = event.data && event.data.todos ? event.data.todos : []
          if (todos.length) {
            lastTodos = todos
            lastTodoAt = Date.now()
          }
          updateTask(todos)
        }
        scheduleRefresh()
      }),
    )
  }

  // 事件触发的刷新做 1.5s 节流
  let refreshTimer = null
  function scheduleRefresh() {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void refreshAll()
    }, 1500)
  }

  // 每 30s 定时刷新
  const timer = setInterval(() => {
    void refreshAll()
  }, 30000)
  disposers.push(() => clearInterval(timer))

  // 初始刷新
  void refreshAll()

  ctx.effect(() => () => {
    disposers.forEach((d) => {
      try {
        d()
      } catch {}
    })
    if (refreshTimer) clearTimeout(refreshTimer)
  })
}
