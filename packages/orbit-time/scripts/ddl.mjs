#!/usr/bin/env node
/**
 * Read your course deadlines from a terminal.
 *
 * The panel is the friendly way in; this is the honest one. It runs the same
 * module the plugin runs, against the same browser profile and the same state
 * directory, so anything this prints is what the panel would show — and when the
 * panel gets something wrong, this is where the raw answer can be read.
 *
 * Usage:
 *   node scripts/ddl.mjs status
 *   node scripts/ddl.mjs login --user demo@example.com --pass '…'        # 中国大学MOOC
 *   node scripts/ddl.mjs login --platform generic --url https://… --user u --pass p
 *   node scripts/ddl.mjs courses
 *   node scripts/ddl.mjs pull [--days 120] [--json out.json] [--ics out.ics]
 *   node scripts/ddl.mjs page <url> [--user u] [--pass p] [--json out.json]
 *   node scripts/ddl.mjs push --file out.json        # 写进正在运行的 Orbit Time
 *   node scripts/ddl.mjs logout
 *
 * Flags:
 *   --headless   不显示浏览器窗口（默认显示：和面板用同一个模式，免得两边抢档案）
 *   --platform   icourse163（默认）| generic
 *   --days N     只看未来 N 天（默认 180）
 *   --json PATH  把结果写成 JSON
 *   --ics PATH   把结果写成日历文件（可直接导入 Outlook / 手机日历）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createWebDdl } from '../src/host/netddl/index.js'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'status'

function flag(name, fallback = undefined) {
  const index = argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const next = argv[index + 1]
  if (next === undefined || next.startsWith('--')) return true
  return next
}

const has = (name) => argv.includes(`--${name}`)

const stateDir = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'storages', 'orbit-time')
  : join(homedir(), '.dsh', 'storages', 'orbit-time')

const platform = flag('platform', 'icourse163')
const days = Number(flag('days', 180)) || 180
// Headful by default, matching the plugin: the profile on disk is shared between
// the two entry points, and a mode switch makes one of them close the other's
// browser mid-read.
const headless = has('headless')
const jsonPath = typeof flag('json') === 'string' ? flag('json') : ''
const icsPath = typeof flag('ics') === 'string' ? flag('ics') : ''

const web = createWebDdl({
  stateDir,
  logger: { info: (line) => console.log(`  · ${String(line).replace('[orbit-time] ', '')}`), warn: (line) => console.error(`  ! ${String(line)}`) },
  headless,
})

function pad(text, width) {
  const value = String(text ?? '')
  let visible = 0
  for (const char of value) visible += /[\u4e00-\u9fa5\uff00-\uffef]/.test(char) ? 2 : 1
  return value + ' '.repeat(Math.max(1, width - visible))
}

function printItems(items) {
  if (items.length === 0) {
    console.log('  （没有读到截止时间）')
    return
  }
  console.log(`  ${pad('截止', 20)}${pad('课程', 22)}${pad('内容', 30)}来源`)
  for (const item of items) {
    const when = `${item.dueDate} ${item.dueTime || '全天'}`
    const course = item.course || '—'
    const kind = item.kind ? `[${item.kind}] ` : ''
    console.log(`  ${pad(when, 20)}${pad(course.slice(0, 11), 22)}${pad(kind + item.title, 30)}${Math.round((item.confidence ?? 0) * 100)}%`)
  }
}

/** An .ics the phone calendar can import, one VEVENT per deadline. */
function toIcs(items) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const local = (item, addMinutes = 0) => {
    const date = new Date(`${item.dueDate}T${item.dueTime || '23:59'}:00`)
    date.setMinutes(date.getMinutes() + addMinutes)
    const pad2 = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}T${pad2(date.getHours())}${pad2(date.getMinutes())}00`
  }
  const escape = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Orbit Time//Web DDL//CN', 'CALSCALE:GREGORIAN', 'X-WR-TIMEZONE:Asia/Shanghai']
  for (const item of items) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${item.key}@orbit-time`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${local(item)}`,
      `DTEND:${local(item, 30)}`,
      `SUMMARY:${escape(`${item.course ? `${item.course} · ` : ''}${item.kind ? `[${item.kind}] ` : ''}${item.title}`)}`,
      `DESCRIPTION:${escape(`${item.dueDate} ${item.dueTime || '全天'} 截止\n${item.url ?? ''}\n${item.evidence ?? ''}`)}`,
      'BEGIN:VALARM',
      'TRIGGER:-PT2H',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escape(`${item.title} 还有 2 小时截止`)}`,
      'END:VALARM',
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n')
}

/** Hand the rows to a running DSH host, so they land on the timeline. */
async function pushToHost(file, port) {
  const payload = JSON.parse(readFileSync(file, 'utf8'))
  const items = Array.isArray(payload) ? payload : payload.items
  if (!Array.isArray(items)) {
    console.error('这个文件里没有 items 数组。')
    process.exit(1)
  }
  const response = await fetch(`http://127.0.0.1:${port}/api/orbit-time/netddl/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items }),
  })
  const text = await response.text()
  if (!response.ok) {
    console.error(`HTTP ${response.status} ${text.slice(0, 300)}`)
    console.error('端口对不对？面板打开时地址栏里的那个端口就是。')
    process.exit(1)
  }
  let answer = null
  try {
    answer = JSON.parse(text)
  } catch {
    /* the summary below is the useful part */
  }
  console.log(`已入库：新增 ${answer?.added ?? '?'} 条，跳过 ${answer?.skipped?.length ?? 0} 条。`)
}

async function main() {
  if (command === 'status') {
    const status = await web.status()
    console.log(`浏览器：${status.browser.found ? status.browser.exe : '没找到 Edge/Chrome'}`)
    console.log(`档案：  ${status.profileDir}`)
    console.log(`状态：  ${status.browser.running ? `在跑（${status.browser.headless ? '无窗口' : '有窗口'}）` : '没在跑'}`)
    console.log(`密码：  ${status.credentials.length === 0 ? '没存' : status.credentials.map((entry) => `${entry.id}:${entry.username}`).join(', ')}`)
    if (status.lastError) console.log(`最近错误：${status.lastError}`)
    await web.close()
    return
  }

  if (command === 'login') {
    const result = await web.login({
      platform,
      url: flag('url', ''),
      username: flag('user', ''),
      password: flag('pass', ''),
      remember: !has('no-remember'),
      timeoutMs: Number(flag('timeout', 180_000)),
    })
    console.log(result.loggedIn ? '登录成功。' : `没成功：${result.note}`)
    if (result.remembered === false && result.rememberNote) console.log(result.rememberNote)
    if (result.screenshot) console.log(`截图：${result.screenshot}`)
    await web.close()
    process.exit(result.loggedIn ? 0 : 2)
  }

  if (command === 'courses') {
    const result = await web.listCourses({ platform })
    if (!result.ok) console.log(result.error ?? '没读到课程')
    for (const course of result.courses ?? []) console.log(`  ${course.name}    ${course.url}`)
    await web.close()
    process.exit(result.ok ? 0 : 2)
  }

  if (command === 'pull') {
    const scanned = await web.listCourses({ platform })
    if (!scanned.ok) {
      console.error(scanned.error ?? scanned.note ?? '没读到课程')
      await web.close()
      process.exit(2)
    }
    console.log(`课程 ${scanned.courses.length} 门，开始读截止时间…`)
    const result = await web.pull({ platform, courses: scanned.courses, horizonDays: days })
    printItems(result.items)
    for (const note of result.notes ?? []) console.log(`  · ${note}`)
    if (jsonPath !== '') {
      writeFileSync(jsonPath, JSON.stringify({ at: result.at, platform, courses: result.courses, items: result.items }, null, 2), 'utf8')
      console.log(`JSON：${jsonPath}`)
    }
    if (icsPath !== '') {
      writeFileSync(icsPath, toIcs(result.items), 'utf8')
      console.log(`日历：${icsPath}（${result.items.length} 条，含提前 2 小时提醒）`)
    }
    await web.close()
    process.exit(result.items.length > 0 ? 0 : 3)
  }

  if (command === 'page') {
    const url = argv[1]
    if (url === undefined || url.startsWith('--')) {
      console.error('用法：node scripts/ddl.mjs page <url> [--user u --pass p]')
      process.exit(1)
    }
    const result = await web.readUrl({
      url,
      username: flag('user', ''),
      password: flag('pass', ''),
      horizonDays: days,
      label: flag('label', ''),
      remember: !has('no-remember'),
    })
    console.log(`${result.page.title}  ${result.page.url}`)
    if (result.loginNote) console.log(`  · ${result.loginNote}`)
    printItems(result.items)
    for (const note of result.notes ?? []) console.log(`  · ${note}`)
    if (result.page.screenshot) console.log(`截图：${result.page.screenshot}`)
    if (jsonPath !== '') {
      writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf8')
      console.log(`JSON：${jsonPath}`)
    }
    if (icsPath !== '') {
      writeFileSync(icsPath, toIcs(result.items), 'utf8')
      console.log(`日历：${icsPath}`)
    }
    await web.close()
    process.exit(result.items.length > 0 ? 0 : 3)
  }

  if (command === 'push') {
    const file = flag('file', '')
    const port = flag('port', '')
    if (typeof file !== 'string' || !existsSync(file)) {
      console.error('用法：node scripts/ddl.mjs push --file out.json --port <DSH 端口>')
      process.exit(1)
    }
    if (typeof port !== 'string' || port === '') {
      console.error('要指定 DSH 的端口：--port 19387（面板地址栏里的那个端口）')
      process.exit(1)
    }
    await pushToHost(file, port)
    return
  }

  if (command === 'logout') {
    const result = await web.logout()
    console.log(result.ok ? '浏览器档案已清空。' : result.error)
    process.exit(result.ok ? 0 : 1)
  }

  console.log('用法：node scripts/ddl.mjs [status|login|courses|pull|page|push|logout]')
  process.exit(1)
}

main().catch(async (error) => {
  console.error(`出错了：${error?.message ?? error}`)
  await web.close().catch(() => {})
  process.exit(1)
})
