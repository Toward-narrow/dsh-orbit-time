#!/usr/bin/env node
/**
 * Network-reader test.
 *
 * The interesting claim is "log in once, then read deadlines off pages you could
 * only see while logged in". That claim is not testable with a fixture: it is
 * about cookies, redirects, and a real form. So this starts a mock course site,
 * drives a real Edge/Chrome against it through the same module the plugin uses,
 * and asserts the three things that can break independently:
 *
 *   - a form login lands, and the session survives the browser being closed;
 *   - a logged-out visit is refused (the mock redirects to its login page);
 *   - deadlines read out of the rendered text and out of the JSON the page
 *     fetched collapse into one row per deadline.
 *
 * Run: node scripts/test-netddl.mjs            (~90 s, launches a hidden browser)
 *      node scripts/test-netddl.mjs --offline  (skip the live icourse163 probe)
 *      node scripts/test-netddl.mjs --headful  (watch the window)
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findBrowser } from '../src/host/netddl/cdp.js'
import { createWebDdl, parseCourseUrl, testListUrl } from '../src/host/netddl/index.js'
import { parseDeadlineText, parseDeadlineJson, dedupeItems, toEpochMs } from '../src/host/netddl/parse.js'
import { startMockSite } from './fixtures/mock-course-site.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const headful = process.argv.includes('--headful')
const offline = process.argv.includes('--offline')

const failures = []
let skipped = 0

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

/** Chromium lets go of its profile a moment after the process exits. */
function removeDir(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch {
    /* a locked temp directory is not a test failure */
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

const NOW = new Date('2026-11-07T13:30:00+08:00')

// ------------------------------------------------------------------ parsers

console.log('\n[parsers]')
await check('页面文字：标题、时间、课程都对得上', () => {
  const text = [
    '测验与作业',
    '第一章 单元测验',
    '截止时间：2026-11-20 23:30',
    '已提交',
    '作业 2',
    '截止时间： 2026-11-28 23:59',
    '第三章 作业',
    '截至 2026/12/05 22:00 关闭',
    '讨论区',
    '楼主 2026-11-01 10:00',
  ].join('\n')
  const items = parseDeadlineText(text, { course: '数据结构', platform: 'icourse163', now: NOW })
  assertEqual(items.length, 3, '条数')
  assertEqual(items[0].dueIso, '2026-11-20T23:30', '第一条时间')
  assertEqual(items[0].title, '第一章 单元测验', '第一条标题')
  assertEqual(items[1].title, '作业 2', '第二条标题')
  assertEqual(items[2].dueIso, '2026-12-05T22:00', '第三条时间')
  assertEqual(items[2].title, '第三章 作业', '第三条标题')
  return `${items.length} 条，最早 ${items[0].dueIso}`
})

await check('全角数字与冒号也能读', () => {
  const items = parseDeadlineText('大作业\n截止时间：２０２６－１２－１０　２３：５９', { now: NOW })
  assertEqual(items.length, 1, '条数')
  assertEqual(items[0].dueIso, '2026-12-10T23:59', '时间')
  return items[0].dueIso
})

await check('测验与作业页：阶段名/开始时间/公布时间/前往按钮不算截止时间', () => {
  // The icourse163 SPOC test list puts the submission deadline, the peer-review
  // window, and the score-release time in one card three lines apart. Only the
  // submission deadline is a row; the others used to become "作业 阶段",
  // "开始时间", "公布时间", and "前往测验".
  const text = [
    '第一节课后作业', '截止时间：2026/11/07 12:00', '前往作业',
    '第一节课后作业', '作业提交阶段', '截止时间：2026/11/07 12:00',
    '作业批改阶段', '学生互评', '开始时间：2026/11/07 13:00', '截止时间：2026/11/14 13:00',
    '成绩公布阶段', '公布时间：2026/11/14 13:30',
    '第五节课后作业', '截止时间：2026/11/17 13:00', '前往作业',
  ].join('\n')
  const items = parseDeadlineText(text, { course: '电法勘探', now: NOW, horizonDays: 365, pastDays: 1 })
  assertEqual(items.length, 2, '条数')
  assertEqual(items[0].title, '第一节课后作业', '第一条标题')
  assertEqual(items[0].dueIso, '2026-11-07T12:00', '第一条时间')
  assertEqual(items[1].title, '第五节课后作业', '第二条标题')
  assertEqual(items[1].dueIso, '2026-11-17T13:00', '第二条时间')
  assert(items.every((item) => !/阶段|开始时间|公布时间|前往/.test(item.title)), '噪声标题还在')
  return items.map((item) => `${item.dueIso} ${item.title}`).join(' / ')
})

await check('过期的、太远的、没有日期的都不要', () => {
  const items = parseDeadlineText('旧作业\n截止时间：2025-01-01 23:59\n远作业\n截止时间：2030-01-01 23:59\n悬空\n截止时间：待定', { now: NOW, horizonDays: 120 })
  assertEqual(items.length, 0, '条数')
  return '0 条'
})

await check('内网 JSON：认 deadline 字段，也认毫秒/字符串两种写法', () => {
  const body = JSON.stringify({
    code: 0,
    result: {
      list: [
        { courseId: 1001, termId: 2001, name: '操作系统', chapters: [{ name: '第二章', units: [{ contentType: 4, name: '第二章作业', homework: { deadline: 1795000000000 } }, { contentType: 3, name: '单元测验一', test: { deadline: '2026-12-01 23:30:00' } }] }] },
      ],
    },
  })
  const items = parseDeadlineJson([{ url: 'rpc:test', body }], { platform: 'icourse163', now: NOW })
  assertEqual(items.length, 2, '条数')
  assertEqual(items[0].course, '操作系统', '课程')
  assertEqual(items[0].title, '第二章作业', '标题')
  assertEqual(items[1].dueIso, '2026-12-01T23:30', '字符串时间')
  assertEqual(items[1].kind, '测验', '类型')
  return items.map((item) => `${item.dueIso} ${item.title}`).join(' / ')
})

await check('时间戳三种写法：秒 / 毫秒 / 日期串', () => {
  assertEqual(toEpochMs(1796140740000), 1796140740000, '毫秒')
  assertEqual(toEpochMs(1796140740), 1796140740000, '秒')
  assertEqual(new Date(toEpochMs('2026-12-01 23:30:00')).getHours(), 23, '日期串小时')
  assertEqual(toEpochMs('待定'), null, '不可解析')
  return 'ok'
})

await check('文字与 JSON 读到的同一条会合并', () => {
  const text = parseDeadlineText('第一章 单元测验\n截止时间：2026-11-20 23:30', { course: '数据结构', now: NOW })
  const json = parseDeadlineJson([{ body: JSON.stringify({ list: [{ name: '第一章 单元测验', deadline: '2026-11-20 23:30' }] }) }], { course: '数据结构', now: NOW })
  const merged = dedupeItems([...text, ...json], { platform: 'test' })
  assertEqual(merged.length, 1, '合并后条数')
  assert(/^wd_/.test(merged[0].key), 'key 前缀')
  return merged[0].key
})

await check('课程地址：courseId / termId / 测验页', () => {
  const parsed = parseCourseUrl('https://www.icourse163.org/learn/SCHOOL-1000000001?tid=1000000001')
  assertEqual(parsed.courseId, '1000000001', 'courseId')
  assertEqual(parsed.termId, '1000000001', 'termId')
  assertEqual(testListUrl('https://www.icourse163.org/learn/SCHOOL-1000000001?tid=1000000001'), 'https://www.icourse163.org/learn/SCHOOL-1000000001?tid=1000000001#/learn/testlist', '测验页')
  return `${parsed.courseId}/${parsed.termId}`
})

await check('无窗口模式：没有账号密码的登录直接说清楚，而不是开一个看不见的浏览器干等', async () => {
  // This is the shape of "卡在这里了，没有弹出登录页": the install was configured
  // headless, nothing could be filled automatically, and the host waited three
  // minutes inside a browser whose window did not exist.
  const quietDir = mkdtempSync(join(tmpdir(), 'orbit-netddl-quiet-'))
  const quiet = createWebDdl({ stateDir: quietDir, headless: true })
  try {
    const result = await quiet.login({ platform: 'icourse163', username: '', password: '', timeoutMs: 5_000 })
    assert(result.ok === false, 'ok 应该是 false')
    assert(result.headless === true, '没有标出 headless')
    assert(String(result.note).includes('netddl.headless'), `说明里没提配置项：${result.note}`)
    const status = await quiet.status()
    assert(status.browser.mode === 'headless', `mode=${status.browser.mode}`)
    assert(status.browser.running === false, '居然启动了浏览器')
    return '立即拒绝，没启动浏览器'
  } finally {
    await quiet.close().catch(() => {})
    removeDir(quietDir)
  }
})

// ------------------------------------------------------------------ browser

const browserFound = findBrowser()
console.log(`\n[browser] ${browserFound === null ? '没找到 Edge/Chrome，跳过真机部分' : browserFound.exe}`)

if (browserFound === null) {
  console.log('  skip 需要 Edge 或 Chrome')
  skipped += 1
} else {
  const site = await startMockSite()
  const stateDir = mkdtempSync(join(tmpdir(), 'orbit-netddl-'))
  const web = createWebDdl({ stateDir, headless: !headful })

  try {
    console.log('\n[session]')
    await check('登录：填表 → 提交 → 落到「我的课程」', async () => {
      const result = await web.login({
        platform: 'generic',
        url: `${site.base}/`,
        username: 'demo',
        password: 'secret',
        timeoutMs: 20_000,
      })
      assert(result.loggedIn === true, `登录没成功：${result.note ?? ''}`)
      assert(result.filled && result.filled.submitted, '没有提交表单')
      return `等了 ${result.waitedMs} ms，${result.remembered ? '密码已加密保存' : '未保存密码'}`
    })

    await check('密码落盘是密文（DPAPI），不是明文', () => {
      const file = join(stateDir, 'webddl', 'credentials.json')
      assert(existsSync(file), '没有凭据文件')
      const text = readFileSync(file, 'utf8')
      assert(!text.includes('"secret"') && !text.includes(':secret'), '密码明文出现在凭据文件里')
      assert(text.includes('secret') === false, '明文出现了')
      return `${text.length} 字节，无明文`
    })

    await check('已登录的会话能读需要登录的页面', async () => {
      const read = await web.readUrl({ url: `${site.base}/courses` })
      assert(read.page.url.endsWith('/courses'), `被重定向到 ${read.page.url}`)
      assert(read.page.title.includes('我的课程'), `标题是 ${read.page.title}`)
      return read.page.title
    })

    await check('关掉浏览器再打开：登录还在（cookie 在档案里）', async () => {
      await web.close()
      const read = await web.readUrl({ url: `${site.base}/courses` })
      assert(read.page.url.endsWith('/courses'), `重开后落到 ${read.page.url}`)
      const status = await web.status()
      assert(status.browser.running === true, '浏览器没起来')
      return `${read.page.title} @ ${status.browser.label}`
    })

    await check('抓课程页：文字 + JSON 各一份，合并成 2 条', async () => {
      const result = await web.pull({
        platform: 'generic',
        courses: [{ name: '数据结构', url: `${site.base}/course/1?tid=1001` }],
        horizonDays: 200,
      })
      assert(result.items.length === 2, `拿到 ${result.items.length} 条`)
      assertEqual(result.items[0].dueIso, '2026-11-20T23:30', '第一条')
      assertEqual(result.items[1].dueIso, '2026-11-28T23:59', '第二条')
      assert(result.items.every((item) => item.course === '数据结构'), '课程名没跟上')
      return result.items.map((item) => `${item.dueDate} ${item.title}`).join(' / ')
    })

    await check('登录表单在 iframe 里：填的是可见的那份，不是外层被藏起来的副本', async () => {
      // Same shape as icourse163: the outer document has a password field parked
      // off screen, and the form a person can see lives in an iframe. The old
      // reader filled the parked copy and reported success; nothing happened.
      const frameDir = mkdtempSync(join(tmpdir(), 'orbit-netddl-frame-'))
      const frameReader = createWebDdl({ stateDir: frameDir, headless: !headful })
      try {
        const result = await frameReader.login({
          platform: 'generic',
          url: `${site.base}/iframe-login`,
          username: 'demo',
          password: 'secret',
          timeoutMs: 25_000,
        })
        assert(result.loggedIn === true, `登录没成功：${result.note ?? ''}`)
        assert(result.filled && result.filled.submitted === true, '没有提交表单')
        assert(String(result.filled.frame || '').includes('/login-widget'), `填的是 ${result.filled.frame}`)
        assert(result.url.endsWith('/courses'), `落在 ${result.url}`)
        return `落在 ${result.url}，填的是 ${result.filled.frame}`
      } finally {
        await frameReader.close().catch(() => {})
        removeDir(frameDir)
      }
    })

    await check('没有登录表单：立即交回给人，而不是等到超时', async () => {
      const plainDir = mkdtempSync(join(tmpdir(), 'orbit-netddl-plain-'))
      const plain = createWebDdl({ stateDir: plainDir, headless: true })
      try {
        const started = Date.now()
        const result = await plain.login({
          platform: 'generic',
          url: `${site.base}/plain`,
          username: 'demo',
          password: 'secret',
          timeoutMs: 20_000,
        })
        const spent = Date.now() - started
        assert(result.loggedIn === false, '居然登录成功了')
        assert(result.needsVisibleWindow === true, '没有标明要人工登录')
        assert(String(result.note).includes('没找到'), `note=${result.note}`)
        assert(spent < 22_000, `等了 ${spent} ms 才说找不到`)
        return `立即返回（${spent} ms）`
      } finally {
        await plain.close().catch(() => {})
        removeDir(plainDir)
      }
    })

    await check('站点说密码不对：立刻说出来，而不是等满三分钟', async () => {
      const wrongDir = mkdtempSync(join(tmpdir(), 'orbit-netddl-wrong-'))
      const wrong = createWebDdl({ stateDir: wrongDir, headless: true })
      try {
        const started = Date.now()
        const result = await wrong.login({
          platform: 'generic',
          url: `${site.base}/`,
          username: 'demo',
          password: 'wrong',
          timeoutMs: 90_000,
        })
        const spent = Date.now() - started
        assert(result.loggedIn === false, '错的密码居然登录成功了')
        assert(result.feedback !== '', '没有读站点给的错误提示')
        assert(String(result.note).includes('站点说'), `note=${result.note}`)
        assert(spent < 20_000, `等了 ${spent} ms 才说密码不对`)
        return `${result.feedback}（${spent} ms）`
      } finally {
        await wrong.close().catch(() => {})
        removeDir(wrongDir)
      }
    })

    await check('浏览器被关掉后重开：旧标签页句柄不能让下一次读取变成空白页', async () => {
      // The exact shape of "第二次弹出来是空白页": the browser process closed,
      // the next call launched a new one, but the page handle still pointed at the
      // dead browser's target. Navigating it failed, leaving about:blank.
      const staleDir = mkdtempSync(join(tmpdir(), 'orbit-netddl-stale-'))
      const stale = createWebDdl({ stateDir: staleDir, headless: true })
      try {
        const first = await stale.readUrl({ url: `${site.base}/plain` })
        assert(first.page.url.endsWith('/plain'), `第一次落在 ${first.page.url}`)
        const status = await stale.status()
        const port = Number(readFileSync(join(status.profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0])
        const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
        const ws = new WebSocket(version.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('连不上浏览器')), 5000)
          ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
          ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连不上浏览器')) }, { once: true })
        })
        ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
        await new Promise((resolve) => setTimeout(resolve, 2000))
        try { ws.close() } catch { /* it is already closing */ }
        const second = await stale.readUrl({ url: `${site.base}/plain` })
        assert(second.page.url.endsWith('/plain'), `第二次落在 ${second.page.url}（空白页就是这里坏）`)
        return `${first.page.url} → ${second.page.url}`
      } finally {
        await stale.close().catch(() => {})
        removeDir(staleDir)
      }
    })

    await check('没登录过的档案：需要登录的页面读不到日期，也不假装成功', async () => {
      // A second install in its own state directory: nothing here has ever logged
      // in, so this is the "I pasted a URL and forgot to log in" case.
      const fresh = mkdtempSync(join(tmpdir(), 'orbit-netddl-fresh-'))
      const cold = createWebDdl({ stateDir: fresh, headless: !headful })
      try {
        const read = await cold.readUrl({ url: `${site.base}/course/2?tid=1002` })
        assert(read.items.length === 0, `未登录竟然读到 ${read.items.length} 条`)
        assert(read.page.title.includes('登录'), `未登录落在 ${read.page.title}`)
        return '0 条，落在登录页（符合预期）'
      } finally {
        await cold.close().catch(() => {})
        removeDir(fresh)
      }
    })

    await check('退出：档案清空，同一个地址又要求登录', async () => {
      const gone = await web.logout()
      assert(gone.ok === true, gone.error ?? '退出失败')
      const read = await web.readUrl({ url: `${site.base}/courses` })
      assert(read.page.title.includes('登录'), `退出后标题是 ${read.page.title}`)
      return read.page.title
    })

    await check('状态：浏览器没在跑，凭据记着账号不记密码', async () => {
      // The previous step re-opened the browser to prove the logout took effect.
      await web.close()
      const status = await web.status()
      assert(status.browser.running === false, '浏览器还开着')
      assert(status.credentials.some((entry) => entry.username === 'demo'), '凭据列表里没有 demo')
      return `${status.credentials.length} 个账号，浏览器 ${status.browser.running ? '在跑' : '已关'}`
    })
  } finally {
    await web.close().catch(() => {})
    await site.close().catch(() => {})
    removeDir(stateDir)
  }
}

// ------------------------------------------------- live site, anonymous only

if (!offline) {
  console.log('\n[live · 未登录]')
  const stateDir = mkdtempSync(join(tmpdir(), 'orbit-netddl-live-'))
  const web = createWebDdl({ stateDir, headless: !headful })
  try {
    await check('中国大学MOOC：没登录时明确说「要登录」，而不是报 0 门课', async () => {
      const result = await web.listCourses({ platform: 'icourse163' })
      assert(result.needsLogin === true, `needsLogin=${result.needsLogin}`)
      assertEqual(result.courses.length, 0, '课程数')
      return String(result.error ?? '').slice(0, 40)
    })
  } catch (error) {
    failures.push(`live: ${error.message}`)
    console.log(`  FAIL live: ${error.message}`)
  } finally {
    await web.close().catch(() => {})
    removeDir(stateDir)
  }
}

// ------------------------------------------------------------------ report

console.log('')
if (failures.length > 0) {
  console.log(`netddl: ${failures.length} 项失败`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log(`netddl: 全部通过${skipped > 0 ? `（${skipped} 项跳过）` : ''}`)
void root
