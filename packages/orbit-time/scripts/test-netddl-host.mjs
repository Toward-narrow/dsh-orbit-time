#!/usr/bin/env node
/**
 * Host-half test for the network deadlines.
 *
 * The browser part is covered by `test-netddl.mjs`; this covers the half that
 * turns a scraped row into something the dashboard can actually show — the route
 * table, the commit, the counter, the dedupe, and the fact that the row lands in
 * the bucket an Excel import does not rebuild.
 *
 * Boots `lib/index.js` the way the Cordis loader would, with a mock context, and
 * drives it over a real HTTP server.
 *
 * Run: node scripts/test-netddl-host.mjs
 */
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startMockSite } from './fixtures/mock-course-site.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const failures = []
async function check(label, fn) {
  try {
    const detail = await fn()
    console.log(`  ok   ${label}${detail === undefined ? '' : ' — ' + detail}`)
    return detail
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
    console.log(`  FAIL ${label}: ${error.message}`)
    return undefined
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const scratch = mkdtempSync(join(tmpdir(), 'orbit-netddl-host-'))
process.env.DSH_HOME = scratch

// ------------------------------------------------------------------ mock ctx

const routes = new Map()
const logs = []
const handles = []
const disposers = []

const services = {
  /**
   * A fake model service, enough for `askModel`'s streaming seam. It answers the
   * two generic-reader prompts from the page bundle itself; this proves the route
   * is wired, not that a vendor model is good.
   */
  llm: {
    stream(call) {
      const prompt = (call.messages.at(-1)?.content ?? []).map((part) => part.text ?? '').join('\n')
      const planning = /网页结构侦察员/.test(String(call.system ?? ''))
      let text = ''
      if (planning) {
        const page = JSON.parse(prompt).页面
        const link = (label) => page.links.find((entry) => entry.label.includes(label))?.href ?? ''
        if (page.url.endsWith('/ai-home')) {
          text = JSON.stringify({ site: 'AI 测试站', pageKind: 'course-list', action: 'follow', links: [{ href: link('电法勘探'), label: '电法勘探' }] })
        } else if (page.url.endsWith('/ai-course')) {
          text = JSON.stringify({ site: 'AI 测试站', pageKind: 'course-list', action: 'follow', steps: [{ kind: 'click', label: '测验与作业' }] })
        } else {
          text = JSON.stringify({ site: 'AI 测试站', pageKind: 'assignment-list', action: 'extract', links: [] })
        }
      } else {
        const pages = JSON.parse(prompt).页面
        const source = pages.find((entry) => entry.url.endsWith('/ai-assignments'))?.url ?? pages[0].url
        text = JSON.stringify({
          items: [
            { title: '第五节课后作业', course: '电法勘探', kind: '作业', dueDate: '2026-11-17', dueTime: '13:00', importance: 'high', evidence: '截止时间：2026-11-17 13:00', sourceUrl: source, confidence: 0.9 },
            { title: '课程讲座', course: '电法勘探', kind: '讲座', dueDate: '2026-12-01', dueTime: '19:00', importance: 'medium', evidence: '讲座时间：2026-12-01 19:00', sourceUrl: source, confidence: 0.8 },
          ],
        })
      }
      return (async function* () {
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  },
  agentDefaultModel: {
    currentSelection: () => ({ provider: 'mock', model: 'mock' }),
  },
  orbitTimeSpawn: () => ({
    pid: 424242,
    stdin: { end() {} },
    stdout: { on() {} },
    stderr: { on() {} },
    kill() {},
    on() {
      return this
    },
  }),
}

const ctx = {
  get: (name) => services[name],
  logger: {
    info: (...args) => logs.push(['info', args.join(' ')]),
    warn: (...args) => logs.push(['warn', args.join(' ')]),
    error: (...args) => logs.push(['error', args.join(' ')]),
  },
  webServer: {
    port: 0,
    register(route) {
      if (route.kind !== 'exact') throw new Error(`unexpected route kind ${route.kind}`)
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  interval(callback, delay) {
    const handle = setInterval(callback, delay)
    // Real intervals keep Node alive; a test that leaves three of them running
    // prints its verdict and then hangs, which reads as a stall rather than a pass.
    handles.push(handle)
    return () => {
      clearInterval(handle)
      const at = handles.indexOf(handle)
      if (at !== -1) handles.splice(at, 1)
    }
  },
  timeout(callback, delay) {
    const handle = setTimeout(callback, delay)
    handles.push(handle)
    return () => {
      clearTimeout(handle)
      const at = handles.indexOf(handle)
      if (at !== -1) handles.splice(at, 1)
    }
  },
  /**
   * The host registers teardown effects; a mock that ignored them would leave the
   * scraper's browser connected and hold the process open.
   */
  effect(factory) {
    const dispose = factory()
    disposers.push(dispose)
    return () => {}
  },
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const handler = routes.get(url.pathname)
  if (handler === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'no route ' + url.pathname }))
    return
  }
  void handler(req, res)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${server.address().port}/api/orbit-time`
const site = await startMockSite()

const host = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
host.apply(ctx, {
  profile: { name: '张三' },
  workbook: { path: '', watch: false, sources: [] },
  reminders: { enabled: false },
  ui: { showFloatingWidget: false },
  // Headless: a host test must not flash a browser window on the developer's screen.
  netddl: { headless: true },
})

async function call(path, options) {
  const response = await fetch(base + path, options)
  const text = await response.text()
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`${path} 返回的不是 JSON：${text.slice(0, 160)}`)
  }
  return { status: response.status, payload }
}

const post = (path, body) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const ITEMS = [
  { key: 'wd_aaa', course: '数据结构', title: '第一章 单元测验', dueDate: '2026-11-20', dueTime: '23:30', url: 'https://mooc.example/learn/a#/learn/testlist', evidence: '截止时间：2026-11-20 23:30', confidence: 0.92 },
  { key: 'wd_bbb', course: '操作系统', title: '进程调度实验报告', dueDate: '2026-12-05', dueTime: '22:00', url: 'https://mooc.example/learn/b', confidence: 0.9 },
]

console.log('orbit-time network deadline host test')

await check('健康检查列出了这项能力', async () => {
  const { payload } = await call('/health')
  assert(Array.isArray(payload.capabilities) && payload.capabilities.includes('web-ddl'), 'capabilities 里没有 web-ddl')
  return payload.capabilities.join(', ')
})

await check('路由表里挂上了 /netddl/*', async () => {
  const wanted = ['/netddl/status', '/netddl/login', '/netddl/check', '/netddl/courses', '/netddl/pull', '/netddl/page', '/netddl/ai', '/netddl/commit', '/netddl/logout', '/netddl/close']
  for (const path of wanted) {
    if (!routes.has('/api/orbit-time' + path)) throw new Error(`缺少路由 ${path}`)
  }
  return `${wanted.length} 条`
})

await check('状态接口报出浏览器、档案目录和已入库条数', async () => {
  const { payload } = await call('/netddl/status')
  // The page uses this to tell a host that predates the iframe login apart from
  // one that can actually drive it; dropping it turns the fix into a silent no-op.
  assert(payload.api === 4, `api=${payload.api}`)
  assert(typeof payload.profileDir === 'string' && payload.profileDir.includes('webddl'), 'profileDir 不对')
  assert(payload.browser !== undefined && payload.browser.found === true, '没找到浏览器')
  assert(payload.count === 0, `初始条数 ${payload.count}`)
  return `api ${payload.api} · ${payload.browser.label} · ${payload.count} 条`
})

await check('AI 路由：模型回调接进通用网页读取', async () => {
  try {
    const { payload } = await post('/netddl/ai', {
      url: `${site.base}/ai-home`,
      label: 'AI 测试站',
      horizonDays: 365,
    })
    assert(payload.ok === true, payload.error || 'ok 不是 true')
    assert(payload.mode === 'ai', `mode=${payload.mode}`)
    assert(payload.items.length === 2, `items=${payload.items.length}`)
    assert(payload.pages.length === 3, `pages=${payload.pages.length}`)
    assert(payload.model && payload.model.provider === 'mock', JSON.stringify(payload.model))
    assert(payload.items.some((item) => item.kind === '讲座'), '非 DDL 的讲座没保留')
    return `${payload.pages.length} 页 → ${payload.items.length} 条（${payload.model.provider}）`
  } finally {
    // The AI test is the only one that needs a browser; leave the host in the
    // "not running" state the later login tests assert on.
    await post('/netddl/close', {})
  }
})

await check('确认入库：两条都上了时间轴', async () => {
  const { payload } = await post('/netddl/commit', { items: ITEMS })
  assert(payload.ok === true, 'ok 不是 true')
  assert(payload.added === 2, `added=${payload.added}`)
  assert(payload.snapshot.webCount === 2, `webCount=${payload.snapshot.webCount}`)
  // The snapshot's day is *today*; these deadlines are weeks out, so the rows are
  // checked through /events below rather than through the day projection.
  return `added=2 webCount=${payload.snapshot.webCount}`
})

await check('事件带上了「网络 DDL」来源、课程和截止时间', async () => {
  const { payload } = await call('/events')
  const rows = payload.events.filter((event) => event.source && event.source.sheet === '网络 DDL')
  assert(rows.length === 2, `来源标记的行 ${rows.length} 条`)
  const first = rows.find((row) => row.id === 'wd_aaa')
  assert(first !== undefined, '没找到 wd_aaa')
  assert(first.date === '2026-11-20' && first.start === '23:30', `时间 ${first.date} ${first.start}`)
  // 23:30 plus half an hour crosses midnight, and this plugin writes the next
  // day's zero hour as 00:00 — the same convention `addMinutes` already uses.
  assert(first.end === '00:00', `结束时间 ${first.end}`)
  assert(first.course === '数据结构', `课程 ${first.course}`)
  assert(first.notes.includes('截止 2026-11-20 23:30'), '备注里没有截止时间')
  assert(first.notes.includes('https://mooc.example'), '备注里没有原文地址')
  return `${first.date} ${first.start} ${first.title}`
})

await check('同一批再点一次：不重复，全部报「已经在日程里了」', async () => {
  const { payload } = await post('/netddl/commit', { items: ITEMS })
  assert(payload.added === 0, `added=${payload.added}`)
  assert(payload.skipped.length === 2, `skipped=${payload.skipped.length}`)
  assert(payload.skipped[0].reason.includes('已经在日程里'), payload.skipped[0].reason)
  return '0 新增 / 2 跳过'
})

await check('不同读取器给同一个截止时间算出不同 key：按人看的行去重', async () => {
  // The old adapter and the AI reader hash their platform into the key; the
  // timeline must still not show the same assignment twice.
  const { payload } = await post('/netddl/commit', {
    items: [{
      key: 'wd_ccc',
      course: '数据结构',
      title: '第一章  单元测验',
      dueDate: '2026-11-20',
      dueTime: '23:30',
      url: 'https://mooc.example/learn/a#/learn/testlist',
      evidence: 'AI 读到的同一行',
    }],
  })
  assert(payload.added === 0, `added=${payload.added}`)
  assert(payload.skipped.length === 1 && payload.skipped[0].reason.includes('已经在日程里'), JSON.stringify(payload.skipped))
  return '换个 key 也认得出是同一条'
})

await check('行进了「自己加的」那一桶，导入冲不掉', async () => {
  const path = join(scratch, 'storages', 'orbit-time', 'runtime.json')
  // persistSoon debounces by 800 ms.
  for (let attempt = 0; attempt < 20 && !existsSync(path); attempt += 1) await new Promise((done) => setTimeout(done, 100))
  let parsed = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (Array.isArray(parsed.manualEvents) && parsed.manualEvents.length >= 2) break
    } catch {
      /* mid-write */
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  assert(parsed !== null, 'runtime.json 没写出来')
  const manual = (parsed.manualEvents ?? []).filter((row) => row.source && row.source.sheet === '网络 DDL')
  assert(manual.length === 2, `manualEvents 里的网络行 ${manual.length} 条`)
  assert(parsed.webddl && parsed.webddl.added === 2, 'webddl 摘要没落盘')
  return `manualEvents ${manual.length} 条，webddl 摘要已落盘`
})

await check('没选课就抓：报错说清楚，不是空结果', async () => {
  const { status, payload } = await post('/netddl/pull', { platform: 'icourse163', courses: [] })
  assert(status === 500, `HTTP ${status}`)
  assert(payload.ok === false && /先选/.test(payload.error), payload.error)
  return payload.error
})

await check('浏览器没启动时，检查登录不顺手拉起一个浏览器', async () => {
  const { payload } = await post('/netddl/check', { platform: 'icourse163' })
  assert(payload.ok === true, 'ok 不是 true')
  assert(payload.unknown === true, `unknown=${payload.unknown}`)
  assert(String(payload.note).includes('没在跑'), payload.note)
  const state = await call('/netddl/status')
  assert(state.payload.browser.running === false, '检查登录把浏览器拉起来了')
  return '未启动、未擅自启动'
})

await check('这套装的是无窗口模式：没账号密码的登录被明确拒绝，而不是干等', async () => {
  const { status, payload } = await post('/netddl/login', { platform: 'icourse163' })
  assert(status === 200, `HTTP ${status}`)
  assert(payload.ok === false, 'ok 不是 false')
  assert(payload.headless === true, '结果里没有 headless 标记')
  assert(String(payload.note).includes('netddl.headless'), payload.note)
  const state = await call('/netddl/status')
  assert(state.payload.browser.mode === 'headless', `mode=${state.payload.browser.mode}`)
  assert(state.payload.browser.running === false, '拒绝时不该启动浏览器')
  return '立即返回说明，未启动浏览器'
})

await check('入库时可以指定看哪一天：快照落在最早的截止日', async () => {
  // The panel asks for the day the earliest deadline lands on, so the user is
  // looking at the timeline the new row is actually on.
  const third = { key: 'wd_ccc', course: '数据结构', title: '第三章 作业', dueDate: '2026-12-09', dueTime: '23:59', confidence: 0.9 }
  const { payload } = await post('/netddl/commit?day=2026-12-09&month=2026-12', { items: [third] })
  assert(payload.added === 1, `added=${payload.added}`)
  assert(payload.snapshot.day.dayKey === '2026-12-09', `快照落在 ${payload.snapshot.day.dayKey}`)
  const onDay = payload.snapshot.day.events.filter((event) => event.id === 'wd_ccc')
  assert(onDay.length === 1, `那一天的事件 ${onDay.length} 条`)
  return `2026-12-09 上 1 条`
})

server.close()
try {
  await site.close()
} catch {
  /* the mock site's server may already be gone */
}
for (const dispose of disposers) {
  try {
    dispose()
  } catch {
    /* ignore */
  }
}
for (const handle of handles) {
  clearInterval(handle)
  clearTimeout(handle)
}
try {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
} catch {
  /* a locked scratch directory is not a failure */
}

console.log('')
if (failures.length > 0) {
  console.log(`netddl-host: ${failures.length} 项失败`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log('netddl-host: 全部通过')
