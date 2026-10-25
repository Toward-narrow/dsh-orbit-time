#!/usr/bin/env node
/**
 * Two rosters, one install: the labels must survive the panel.
 *
 * The failure this pins down was invisible to every existing check. Importing a
 * roster through 设置/导入 posted the analysed path, and the host rebuilt that
 * source from the request alone — dropping the `subject` and `note` configured
 * for it. Entries came back titled after their worksheet ("Sheet1"), and when the
 * dropped file was an uploaded copy, `workbook.path` was promoted to that copy so
 * the same duty imported twice: once from `sources` with its real name, once from
 * the copy as "Sheet1".
 *
 * These checks boot a real host with two configured rosters and drive the panel's
 * three request shapes: a pasted path, a dropped file (upload), and a plain
 * re-import of everything.
 *
 * Run: node scripts/test-labels.mjs
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
const PYTHON =
  process.env.DSH_PYTHON ||
  join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')

if (!existsSync(PYTHON)) {
  console.error(`python not found at ${PYTHON}; set DSH_PYTHON to override`)
  process.exit(1)
}

const failures = []

/**
 * Run one check. A check body that awaits is awaited here too: without that the
 * label printed `[object Promise]` and a rejected fetch surfaced as an unhandled
 * rejection instead of a failure line.
 */
function check(label, fn) {
  try {
    const value = fn()
    if (value !== null && typeof value === 'object' && typeof value.then === 'function') {
      return value.then(
        (settled) => finish(label, settled),
        (error) => failed(label, error),
      )
    }
    return finish(label, value)
  } catch (error) {
    return failed(label, error)
  }
}

function finish(label, value) {
  console.log(`  ok   ${label}${value === undefined ? '' : ' — ' + value}`)
  return value
}

function failed(label, error) {
  failures.push(`${label}: ${error.message}`)
  console.log(`  FAIL ${label}: ${error.message}`)
  return undefined
}

console.log('orbit-time roster label check')

const workDir = mkdtempSync(join(tmpdir(), 'orbit-time-labels-'))
const scratch = mkdtempSync(join(tmpdir(), 'orbit-time-labels-state-'))
process.env.DSH_HOME = scratch

const MORNING = join(workDir, '早打卡排班表.xlsx')
const EVENING = join(workDir, '晚自习排班表.xlsx')

/**
 * The Monday of the current week, used as the roster's week-1 anchor.
 *
 * It used to be a hardcoded 2026-08-31, which made the whole test rot: eight weeks
 * from that Monday stopped reaching "today" in late October, every generated row
 * fell in the past, the import legitimately filtered them all out, and the label
 * checks failed for a reason that had nothing to do with labels. Anchoring on the
 * running week keeps the fixture permanently future-facing.
 */
function mondayOfThisWeek() {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${mm}-${dd}`
}

const WEEK_ONE_MONDAY = mondayOfThisWeek()

function generate(target, weeks, ...modes) {
  const result = spawnSync(PYTHON, [join(root, 'scripts', 'make-week-roster.py'), target, String(weeks), ...modes], {
    encoding: 'utf8',
    windowsHide: true,
    // Chinese in the output path otherwise trips the child's ANSI-code-page
    // stdout before the workbook is ever saved.
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `exit ${result.status}`)
  return target
}

await check('two roster workbooks generated', () => {
  // `uniform` keeps the same name in every week, so the roster has rows in the
  // future window no matter when this runs — eight weeks from *this* Monday.
  generate(MORNING, 8, 'uniform')
  generate(EVENING, 8, 'uniform', 'prose')
  return `${MORNING.split('\\').pop()} + ${EVENING.split('\\').pop()} (week 1 = ${WEEK_ONE_MONDAY})`
})

// ------------------------------------------------------------------ boot

const routes = new Map()
const timers = []
const hostModule = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
hostModule.apply(
  {
    logger: { info() {}, warn() {}, error() {} },
    webServer: {
      port: 0,
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    interval(callback, delay) {
      const handle = setInterval(callback, delay)
      handle.unref?.()
      timers.push(handle)
      return () => clearInterval(handle)
    },
    timeout(callback, delay) {
      const handle = setTimeout(callback, delay)
      handle.unref?.()
      timers.push(handle)
      return () => clearTimeout(handle)
    },
    effect: () => () => {},
  },
  {
    profile: { name: '值班员1号' },
    workbook: {
      // The state the panel leaves behind: the analysed file also became the
      // primary path while the same roster is listed with its own label.
      path: EVENING,
      watch: false,
      subject: '',
      note: '',
      timeRules: [{ match: ['晚自习'], start: '19:30', end: '20:50' }],
      weekOneMonday: WEEK_ONE_MONDAY,
      sources: [
        { path: MORNING, subject: '早打卡值班（配置里的名字）', timeRules: [{ match: ['早打卡'], start: '07:00', end: '07:30' }] },
        {
          path: EVENING,
          subject: '晚自习考勤点名（配置里的名字）',
          note: '按点名册点名，核实后同步到在线文档。',
          timeRules: [{ match: ['晚自习'], start: '19:30', end: '20:50' }],
        },
      ],
    },
    reminders: { enabled: false, osToast: false },
    ui: { showFloatingWidget: false },
    assistant: { useModel: false },
  },
)

const server = createServer((req, res) => {
  const handler = routes.get(new URL(req.url, 'http://x').pathname)
  if (handler === undefined) {
    res.writeHead(404).end('{}')
    return
  }
  handler(req, res)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${server.address().port}/api/orbit-time`

async function call(path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return JSON.parse(await response.text())
}

const titlesOf = (payload) => {
  const events = [...(payload.snapshot?.day?.events ?? []), ...(payload.snapshot?.upcoming ?? [])]
  return events.map((event) => event.title)
}
const uniqueTitles = (payload) => [...new Set(titlesOf(payload))].sort()

const pad = (value) => String(value).padStart(2, '0')
const now = new Date()
const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

// ------------------------------------------------- a plain re-import of everything

const plain = await call('/import', {})
await check('every configured roster keeps its own label', () => {
  const titles = uniqueTitles(plain)
  if (!titles.includes('早打卡值班（配置里的名字）')) throw new Error(`morning label lost: ${titles.join(' / ')}`)
  if (!titles.includes('晚自习考勤点名（配置里的名字）')) throw new Error(`evening label lost: ${titles.join(' / ')}`)
  return titles.join(' / ')
})

await check('the roster listed twice is imported once', () => {
  const evening = titlesOf(plain).filter((title) => title.startsWith('晚自习'))
  const sheetNamed = titlesOf(plain).filter((title) => title === 'Sheet1')
  if (sheetNamed.length > 0) throw new Error(`the bare primary path won and titled entries ${sheetNamed[0]}`)
  if (evening.length === 0) throw new Error('no evening entries at all')
  return `${evening.length} evening entries, no duplicates`
})

await check('a configured note reaches the entries', () => {
  const event = [...(plain.snapshot?.upcoming ?? [])].find((item) => item.title.startsWith('晚自习'))
  if (!event) throw new Error('no evening event to inspect')
  if (event.notes !== '按点名册点名，核实后同步到在线文档。') throw new Error(`notes were ${JSON.stringify(event.notes)}`)
  return event.notes
})

// ------------------------------------------------- a pasted path from the panel

const analysed = await call('/analyze', { path: EVENING, useModel: false })
const pasted = await call('/import', {
  path: EVENING,
  subject: analysed.subject,
  timeRules: analysed.timeRules,
  weekOneMonday: analysed.weekOneMonday,
})
await check('the panel’s own guess does not overwrite the configured label', () => {
  const titles = uniqueTitles(pasted)
  const evening = titles.filter((title) => title.startsWith('晚自习'))
  if (evening.length === 0) throw new Error(`evening label lost: ${titles.join(' / ')}`)
  if (evening.length !== 1 || evening[0] !== '晚自习考勤点名（配置里的名字）') {
    throw new Error(`evening entries were labelled ${evening.join(' / ')}`)
  }
  // Confirming one roster is an edit to the configured set, not a reset of it.
  if (!titles.some((title) => title.startsWith('早打卡'))) {
    throw new Error(`the morning roster disappeared when the evening one was confirmed: ${titles.join(' / ')}`)
  }
  return `${evening[0]} (panel proposed ${JSON.stringify(analysed.subject)}), both rosters kept`
})

// ------------------------------------------------- a dropped file (upload)

const bytes = readFileSync(EVENING)
const uploaded = await call('/analyze', {
  file: { name: '晚自习排班表.xlsx', base64: bytes.toString('base64') },
  useModel: false,
})
const afterUpload = JSON.parse(await (await fetch(`${base}/snapshot`)).text())
await check('analysis of a dropped file leaves workbook.path alone', () => {
  const primary = String(afterUpload.settings.workbook.path)
  if (primary !== EVENING) throw new Error(`workbook.path became ${primary}`)
  return primary.split('\\').pop()
})

const dropped = await call('/import', {
  path: uploaded.configuredPath ?? uploaded.file,
  subject: uploaded.subject,
  timeRules: uploaded.timeRules,
  weekOneMonday: uploaded.weekOneMonday,
})
await check('an uploaded copy still imports under the roster’s own label', () => {
  const titles = uniqueTitles(dropped)
  const evening = titles.filter((title) => title.startsWith('晚自习'))
  if (evening.length !== 1 || evening[0] !== '晚自习考勤点名（配置里的名字）') {
    throw new Error(`expected one configured evening label, saw ${evening.join(' / ') || '(none)'}`)
  }
  return evening[0]
})

await check('the uploaded copy did not add a second source', () => {
  const sources = dropped.snapshot.excel.sources ?? []
  // Two rosters are configured, so the union reads two; the copy takes its own
  // roster's place for this run instead of joining as a third source.
  if (sources.length !== 2) throw new Error(`imported ${sources.length} sources: ${sources.map((s) => s.file).join(', ')}`)
  const evening = sources.filter((source) => /晚自习/.test(source.file))
  if (evening.length !== 1) throw new Error(`${evening.length} evening sources: ${evening.map((source) => source.file).join(', ')}`)
  return sources.map((source) => `${source.file.split('\\').pop()} (${source.matchedHere})`).join(', ')
})

// ------------------------------------------------- a row typed in by hand

/**
 * An import rebuilds the *workbook* rows, which is right for them: the file is the
 * source of truth and a deleted row must disappear. A row the user typed has no
 * file behind it, so it lives in its own list on the host — otherwise it vanished
 * on the next scan, including the one a file-watcher tick triggers, and the user
 * would have to notice on their own.
 */
const manualTitle = '手动加的一条'
const created = await call('/events', {
  action: 'add',
  event: { date: todayKey, start: '09:00', title: manualTitle, location: '自习室' },
})

await check('a hand-added row is marked as one', () => {
  const event = created.event
  if (event === undefined) throw new Error(`no event came back: ${JSON.stringify(created)}`)
  // The marker is the source sheet, stored on the row, so it also survives a
  // restart — and it is what the panel labels "自己加的".
  if (event.source?.sheet !== '手动添加') throw new Error(`source sheet was ${JSON.stringify(event.source)}`)
  if (event.owner !== '') throw new Error(`a hand-added row claimed an owner: ${JSON.stringify(event.owner)}`)
  return `${event.date} ${event.start} ${event.title}`
})

await check('the new row is on the schedule the panel reads', async () => {
  const snapshot = JSON.parse(await (await fetch(`${base}/snapshot?day=${todayKey}`)).text())
  const onDay = (snapshot.day.events ?? []).find((event) => event.title === manualTitle)
  if (onDay === undefined) throw new Error(`not on ${todayKey}: ${(snapshot.day.events ?? []).map((e) => e.title).join(' / ')}`)
  if (snapshot.manualCount !== 1) throw new Error(`manualCount=${snapshot.manualCount}`)
  const monthItems = (snapshot.month?.items ?? []).filter((item) => item.title === manualTitle)
  // The calendar's own list has to see it too, and say where it came from.
  if (monthItems.length !== 1) throw new Error(`the calendar lists it ${monthItems.length} time(s)`)
  if (monthItems[0].manual !== true) throw new Error('the calendar does not mark it as hand-added')
  return `${snapshot.manualCount} manual row(s), month items carry the flag`
})

// ------------------------------------------------- the import must not eat it
//
// The shorter roster replaces the configured morning workbook *in place*, which is
// how a real revision arrives: same file, fewer weeks. Importing a differently
// named copy instead would add a second roster (by design — see the multi-roster
// checks in test-host.mjs), and then nothing would have left the file at all.

generate(MORNING, 4, 'uniform')

const afterImport = await call('/import', { path: MORNING })
await check('re-importing keeps the hand-added row and still drops what left the file', () => {
  const titles = uniqueTitles(afterImport)
  if (!titles.includes(manualTitle)) {
    throw new Error(`the manual row did not survive the import: ${titles.join(' / ')}`)
  }
  // The other half matters just as much: keeping everything would look like a
  // pass here while breaking the promise that the file is the source of truth.
  if (!(afterImport.excel?.removed > 0)) {
    throw new Error(`the shorter roster removed nothing (removed=${afterImport.excel?.removed})`)
  }
  if (afterImport.snapshot?.manualCount !== 1) throw new Error(`manualCount=${afterImport.snapshot?.manualCount}`)
  if (!(afterImport.excel?.manualCount >= 1)) throw new Error(`the import summary hid the manual row: ${afterImport.excel?.manualCount}`)
  return `${afterImport.excel.importedCount} imported, ${afterImport.excel.removed} removed, manual row kept`
})

const deleted = await call('/events', { action: 'remove', id: created.event.id })
await check('deleting a hand-added row really deletes it', () => {
  const titles = uniqueTitles(deleted)
  if (titles.includes(manualTitle)) throw new Error('the row came back from the dead')
  if (deleted.snapshot?.manualCount !== 0) throw new Error(`manualCount=${deleted.snapshot?.manualCount}`)
  return 'gone, and not resurrected by the merge'
})

for (const handle of timers) handle.unref?.()
server.close()
rmSync(workDir, { recursive: true, force: true })
rmSync(scratch, { recursive: true, force: true })

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} failure(s):`)
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('all roster label checks passed')
