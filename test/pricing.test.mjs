// 官方峰谷规则、最新价格与内嵌 widget 的自检（node --test test）。
// 规则来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// 2026 放假安排：https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isPeakTime, isBeijingHoliday, PRICE, apply } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const bj = (iso) => Date.parse(iso)

test('官方价：deepseek-flash 闲时价，且高峰为闲时两倍', () => {
  assert.deepEqual([...PRICE.hit], [0.02, 0.04])
  assert.deepEqual([...PRICE.miss], [1, 2])
  assert.deepEqual([...PRICE.out], [4, 8])
  for (const key of ['hit', 'miss', 'out']) {
    assert.equal(PRICE[key][1], PRICE[key][0] * 2)
  }
})

test('高峰时段：周一至周五 9–12、14–18，边界 12/18 归闲时', () => {
  assert.equal(isPeakTime(bj('2026-10-19T08:59:00+08:00')), false)
  assert.equal(isPeakTime(bj('2026-10-19T09:00:00+08:00')), true)
  assert.equal(isPeakTime(bj('2026-10-19T11:59:00+08:00')), true)
  assert.equal(isPeakTime(bj('2026-10-19T12:00:00+08:00')), false)
  assert.equal(isPeakTime(bj('2026-10-19T13:59:00+08:00')), false)
  assert.equal(isPeakTime(bj('2026-10-19T14:00:00+08:00')), true)
  assert.equal(isPeakTime(bj('2026-10-19T17:59:00+08:00')), true)
  assert.equal(isPeakTime(bj('2026-10-19T18:00:00+08:00')), false)
  assert.equal(isPeakTime(bj('2026-10-19T00:30:00+08:00')), false)
})

test('周末全天空闲（含调休上班的周六）', () => {
  assert.equal(isPeakTime(bj('2026-10-17T10:00:00+08:00')), false) // 周六
  assert.equal(isPeakTime(bj('2026-10-18T14:00:00+08:00')), false) // 周日
  assert.equal(isPeakTime(bj('2026-10-10T10:00:00+08:00')), false) // 国庆调休上班的周六
})

test('法定节假日全天空闲', () => {
  assert.equal(isBeijingHoliday(bj('2026-10-01T00:00:00+08:00')), true)
  assert.equal(isPeakTime(bj('2026-10-01T10:00:00+08:00')), false) // 国庆
  assert.equal(isPeakTime(bj('2026-02-17T10:00:00+08:00')), false) // 春节假期内的工作日
  assert.equal(isPeakTime(bj('2026-10-08T10:00:00+08:00')), true) // 国庆后周四
  assert.equal(isPeakTime(bj('2027-01-01T10:00:00+08:00')), false) // 固定元旦
})

test('内嵌 WIDGET_JS 可独立解析', () => {
  const marker = 'const WIDGET_JS = `'
  const start = source.indexOf(marker) + marker.length
  const end = source.indexOf('`', start)
  assert.ok(start > marker.length && end > start, 'WIDGET_JS 模板标记存在')
  const code = source.slice(start, end)
  assert.doesNotThrow(() => new Function(code))
})

test('客户端默认价与宿主 PRICE 的闲时价一致，高峰倍率为 2', () => {
  const match = /var PRESETS = (\{[\s\S]*?\})\s*var DEFAULT_PRICES = (\{[^}]*\})/.exec(source)
  assert.ok(match, 'PRESETS 与 DEFAULT_PRICES 存在')
  const presets = new Function('return (' + match[1] + ')')()
  const prices = new Function('var PRESETS = ' + match[1] + '; return (' + match[2] + ')')()
  assert.equal(prices.hit, PRICE.hit[0])
  assert.equal(prices.miss, PRICE.miss[0])
  assert.equal(prices.out, PRICE.out[0])
  assert.equal(prices.peak, 2)
  assert.equal(presets.flash.hit, 0.02)
  assert.equal(presets.pro.hit, 0.15)
  assert.equal(presets.pro.miss, 4.5)
  assert.equal(presets.pro.out, 13.5)
})

test('用结构化 index 注入加载 widget（Desktop dsh-app:// 兼容）', () => {
  const handlers = new Map()
  const routes = []
  const ctx = {
    get: () => undefined,
    on: (name, handler) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    effect: (factory) => {
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
      tapIndex: () => {
        throw new Error('tapIndex must not be used: DSH Desktop does not render the HTTP index')
      },
      collectIndexInjections: () => {
        const table = []
        handlers.get('webserver/index-inject')?.(table)
        return table
      },
    },
  }
  apply(ctx)
  const table = ctx.webServer.collectIndexInjections()
  assert.equal(table.filter((row) => row.kind === 'script-src' && row.src === '/dsh-glass/widget.js').length, 1)
  assert.ok(routes.some((route) => route.path === '/dsh-glass/health'), 'health 诊断端点已注册')
  assert.ok(routes.some((route) => route.path === '/dsh-glass/stats.json'))
  assert.ok(routes.some((route) => route.path === '/dsh-glass/widget.js'))
})
