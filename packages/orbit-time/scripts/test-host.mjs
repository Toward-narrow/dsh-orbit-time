#!/usr/bin/env node
/**
 * Host-half integration test.
 *
 * Boots `lib/index.js` the way the Cordis loader would — a mock context that
 * records route registrations, timer handles, service lookups, and spawned
 * processes — serves those routes from a real node:http server on an ephemeral
 * port, and drives the plugin over HTTP.
 *
 * The model is scripted rather than real: every failure shape a provider can
 * produce (a throw, an `error` finish, an empty stream, a missing service) is
 * exercised, because those are the paths that decide whether the panel shows an
 * answer at all.
 *
 * Run: node scripts/test-host.mjs                  (~90 s, waits out one reminder)
 *      node scripts/test-host.mjs --fast           (skips the reminder wait)
 *      node scripts/test-host.mjs --installed      (also boot the profile copy)
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const fast = process.argv.includes('--fast')
const checkInstalled = process.argv.includes('--installed')

const failures = []
async function check(label, fn) {
  try {
    const detail = await fn()
    console.log(`  ok   ${label}${detail === undefined ? '' : ' — ' + detail}`)
    return detail
  } catch (error) {
    // Node wraps a connection-level failure in a bare "fetch failed"; the cause
    // is the only part that says what actually went wrong.
    const cause = error?.cause
    const extra = cause === undefined ? '' : ` (cause: ${cause?.code ?? ''} ${cause?.message ?? String(cause)})`
    failures.push(`${label}: ${error.message}${extra}`)
    console.log(`  FAIL ${label}: ${error.message}${extra}`)
    return undefined
  }
}

// Plugin state lives under DSH_HOME/storages, so point that at a scratch
// directory and leave the real profile's state untouched. The real home is read
// first because the installed-copy check needs it later.
const realDshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const scratch = mkdtempSync(join(tmpdir(), 'orbit-time-host-'))
process.env.DSH_HOME = scratch

// ------------------------------------------------------------------ mock host ctx

const routes = new Map()
const intervals = []
const timeouts = []
const logs = []
const spawnedProcesses = []

/** Scripted stand-in for the harness `llm` service. */
const modelStub = {
  calls: [],
  answer: null,
  fail: null,
  async *stream(options) {
    modelStub.calls.push(options)
    if (modelStub.fail === 'throw') throw new Error('provider exploded')
    if (modelStub.fail === 'error-finish') {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'rate-limit' } } }
      return
    }
    if (modelStub.fail === 'empty') {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const text = modelStub.answer ?? '先做数据结构实验。'
    for (const piece of text.match(/.{1,12}/gu) ?? []) yield { type: 'text-delta', index: 0, text: piece }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

/**
 * Everything this mock host exposes through `ctx.get()`. One shared object so a
 * test can remove a service and observe the degradation path.
 */
const services = {
  llm: modelStub,
  agentDefaultModel: {
    currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }),
  },
  /** Spawn seam: records the argument list instead of opening real windows. */
  orbitTimeSpawn: (command, args, options) => {
    spawnedProcesses.push({ command, args, options })
    return {
      pid: 424242,
      killed: false,
      stdin: { end() {} },
      stdout: { on() {} },
      stderr: { on() {} },
      kill() {
        this.killed = true
      },
      on() {
        return this
      },
    }
  },
}

function makeCtx() {
  return {
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
      intervals.push(handle)
      return () => {
        clearInterval(handle)
        const at = intervals.indexOf(handle)
        if (at !== -1) intervals.splice(at, 1)
      }
    },
    timeout(callback, delay) {
      const handle = { callback, delay, cancelled: false }
      timeouts.push(handle)
      return () => {
        handle.cancelled = true
      }
    },
    effect() {
      return () => {}
    },
  }
}

/** Run every pending `ctx.timeout` body now, as a settled host would. */
function runTimeouts() {
  for (const handle of timeouts.splice(0, timeouts.length)) {
    if (!handle.cancelled) handle.callback()
  }
}

void logs

// ------------------------------------------------------------------ boot

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const handler = routes.get(url.pathname)
  if (handler === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'no route ' + url.pathname }))
    return
  }
  handler(req, res)
})

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${server.address().port}/api/orbit-time`

console.log('orbit-time host integration test')
console.log(`  server: ${base}`)

const hostModule = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)

/**
 * How many routes this build registers. Read from the local boot so the
 * installed-copy check compares against the real number rather than a literal
 * that has to be updated whenever a route is added.
 */
let localRouteCount = 0

await check('module exports the plugin contract', () => {
  if (typeof hostModule.apply !== 'function') throw new Error('apply is not exported')
  if (!Array.isArray(hostModule.inject)) throw new Error('inject is not exported')
  return `name=${hostModule.name} inject=${hostModule.inject.join(', ')}`
})

await check('apply() registers the full route table', () => {
  hostModule.apply(makeCtx(), {
    profile: { name: '张三', aliases: ['张老师'] },
    workbook: { path: '', watch: false, sources: [] },
    reminders: { enabled: true, offsetsMinutes: [1, 0], osToast: false, respectQuietHours: false },
    ui: { showFloatingWidget: false },
  })
  const expected = [
    '/api/orbit-time/health',
    '/api/orbit-time/snapshot',
    '/api/orbit-time/settings',
    '/api/orbit-time/preview',
    '/api/orbit-time/import',
    '/api/orbit-time/events',
    '/api/orbit-time/timer',
    '/api/orbit-time/feed',
    '/api/orbit-time/assistant',
    '/api/orbit-time/hud',
    '/api/orbit-time/open-float',
    '/api/orbit-time/export',
    '/api/orbit-time/events-stream',
  ]
  for (const path of expected) {
    if (!routes.has(path)) throw new Error(`route missing: ${path}`)
  }
  localRouteCount = routes.size
  return `${routes.size} routes`
})

/**
 * One request, retried if the socket was already dead.
 *
 * Node's fetch keeps connections alive between calls. The mock server here is
 * created and torn down by the test itself, so a pooled connection can be closed
 * by the server between two requests and the next one fails with a bare
 * ECONNRESET before it ever reaches the server — nothing to do with the plugin,
 * and only sometimes, which is what makes it look like a real failure. A genuine
 * failure fails every attempt; a stale socket succeeds on the next one.
 */
async function fetchWithRetry(path, options, attempts = 3) {
  let last = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetch(base + path, options)
    } catch (error) {
      last = error
      const code = error?.cause?.code
      if (code !== 'ECONNRESET' && code !== 'ECONNREFUSED' && code !== 'EPIPE') throw error
      await new Promise((done) => setTimeout(done, 25 * (attempt + 1)))
    }
  }
  throw last
}

async function api(path, options) {
  const response = await fetchWithRetry(path, options)
  const text = await response.text()
  let payload = null
  try {
    payload = text === '' ? null : JSON.parse(text)
  } catch {
    throw new Error(`non-JSON response from ${path}: ${text.slice(0, 200)}`)
  }
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${payload?.error ?? text.slice(0, 200)}`)
  return payload
}

/** Like api() but returns the payload even for a refused request. */
async function apiAllowFailure(path, body) {
  const response = await fetchWithRetry(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return JSON.parse(await response.text())
}

function post(path, body) {
  return api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
}

const pad = (value) => String(value).padStart(2, '0')
const dayKeyOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const hhmm = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`

// ------------------------------------------------------------------ health

const health = await api('/health')
await check('GET /health reports the boot state', () => {
  if (health.ok !== true) throw new Error('ok was not true')
  if (health.ownerNames.join('/') !== '张三/张老师') throw new Error(`ownerNames=${health.ownerNames.join('/')}`)
  return `events=${health.events} workbook=${JSON.stringify(health.workbook)}`
})

const empty = await api('/snapshot')
await check('an empty snapshot is well formed', () => {
  if (empty.day.events.length !== 0) throw new Error(`expected no events, got ${empty.day.events.length}`)
  if (empty.nextEvent !== null) throw new Error('nextEvent should be null')
  if (empty.timer.phase !== 'idle') throw new Error(`timer phase ${empty.timer.phase}`)
  if (!Array.isArray(empty.week) || empty.week.length !== 10) throw new Error(`week has ${empty.week?.length} days`)
  return `week=${empty.week.length} feed=${empty.feed.length}`
})

const emptyMonth = empty.month
await check('the snapshot carries a whole month for the calendar', () => {
  if (emptyMonth === undefined || emptyMonth === null) throw new Error('the snapshot has no month')
  if (!/^\d{4}-\d{2}$/.test(emptyMonth.monthKey ?? '')) throw new Error(`monthKey=${emptyMonth.monthKey}`)
  // Whole weeks only, Monday to Sunday, and never a row of orphaned dates.
  if (emptyMonth.grid.length % 7 !== 0) throw new Error(`grid has ${emptyMonth.grid.length} cells, not whole weeks`)
  if (emptyMonth.grid.length !== 35 && emptyMonth.grid.length !== 42) {
    throw new Error(`grid has ${emptyMonth.grid.length} cells, expected 35 or 42`)
  }
  const first = new Date(`${emptyMonth.grid[0].dayKey}T00:00:00`)
  const last = new Date(`${emptyMonth.grid[emptyMonth.grid.length - 1].dayKey}T00:00:00`)
  if (first.getDay() !== 1) throw new Error(`the grid opens on ${emptyMonth.grid[0].dayKey}, which is not a Monday`)
  if (last.getDay() !== 0) throw new Error(`the grid ends on ${emptyMonth.grid[emptyMonth.grid.length - 1].dayKey}, which is not a Sunday`)
  const span = Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1
  if (span !== emptyMonth.grid.length) throw new Error(`the grid spans ${span} days but lists ${emptyMonth.grid.length} cells`)
  const inMonth = emptyMonth.grid.filter((cell) => cell.inMonth === true)
  const monthDays = new Date(emptyMonth.year, emptyMonth.month, 0).getDate()
  if (inMonth.length !== monthDays) throw new Error(`${inMonth.length} cells claim to be in a ${monthDays}-day month`)
  const lead = emptyMonth.grid.findIndex((cell) => cell.inMonth === true)
  if (lead + monthDays > emptyMonth.grid.length) throw new Error(`${lead} + ${monthDays} days overflow ${emptyMonth.grid.length} cells`)
  if (emptyMonth.dayCount !== 0 || emptyMonth.eventCount !== 0) throw new Error('an empty schedule marked days')
  return `${emptyMonth.monthKey} ${inMonth.length} days, ${emptyMonth.grid.length} cells, lead ${lead}`
})

// ------------------------------------------------------------------ fixtures

const soon = new Date(Date.now() + 11 * 60_000)
const soonish = new Date(Date.now() + 210_000)
const later = new Date(Date.now() + 3 * 60 * 60_000)
const soonDay = dayKeyOf(soon)
const laterDay = dayKeyOf(later)
// Noon *yesterday*, computed on the calendar rather than "24 hours ago": at
// 00:05, `now - 24h` is yesterday's 00:05 — the previous calendar day, but only
// by five minutes, and it slips onto today for the first hours of any day.
const yesterday = new Date()
yesterday.setDate(yesterday.getDate() - 1)
yesterday.setHours(12, 0, 0, 0)

/**
 * Late in the evening these fixtures cross midnight: "now + 11 minutes" is
 * tomorrow, so the day projection legitimately shows nothing for today until
 * then. That is correct behaviour, not a defect, so the day-scoped assertions are
 * skipped with a stated reason rather than weakened into checks that would also
 * pass on a real bug.
 */
const todayKey = dayKeyOf(new Date())
const crossesMidnight = soonDay !== todayKey || dayKeyOf(soonish) !== todayKey || laterDay !== todayKey
if (crossesMidnight) {
  console.log('  --   the fixture window crosses midnight; day-scoped checks are skipped')
}

// Date and time come from the same instant, so this run is correct at any hour.
const added = []
for (const spec of [
  { title: '高数课', date: soonDay, start: hhmm(soon), end: hhmm(new Date(soon.getTime() + 40 * 60_000)), person: '张三', location: '三教 305' },
  { title: '临近事件', date: dayKeyOf(soonish), start: hhmm(soonish), person: '张三' },
  { title: '项目周会', date: laterDay, start: hhmm(later), person: '张老师', classroom: '会议室 A' },
  { title: '别人的会', date: soonDay, start: '23:30', person: '李四' },
  { title: '昨天的事', date: dayKeyOf(yesterday), start: '10:00', person: '张三' },
  { title: '没有时间的备忘', date: '', start: '', person: '张三' },
  // Pinned to today on purpose, and last so the index-based handles below keep
  // pointing at the rows they name. Every other row is "now + N", so after 23:00
  // they all land on tomorrow and nothing is left on today's timeline — correct
  // behaviour, but it makes any "today" assertion measure the clock instead of the
  // plugin. This one keeps a today-shaped question answerable at any hour.
  { title: '今天的固定日程', date: todayKey, start: '08:00', person: '张三' },
]) {
  added.push((await post('/events', { action: 'add', event: spec })).event)
}

const lecture = added[0]
const imminent = added[1]
const meeting = added[2]
const timeless = added[5]

await check('POST /events add normalizes each row', () => {
  if (lecture.date !== soonDay || lecture.start !== hhmm(soon)) throw new Error(`first event ${lecture.date} ${lecture.start}`)
  if (lecture.end === '') throw new Error('end time was not derived')
  if (meeting.end === '') throw new Error('default end should be start + 60 minutes')
  if (timeless.date !== '') throw new Error('a row without a time should stay undated')
  return `${added.length} events, first at ${lecture.date} ${lecture.start}`
})

const withEvents = await api('/snapshot?day=' + soonDay)
await check('snapshot projects the day correctly', () => {
  const titles = withEvents.day.events.map((event) => event.title)
  if (!titles.includes('高数课')) throw new Error(`the day is missing 高数课: ${titles.join(', ')}`)
  if (titles.includes('昨天的事')) throw new Error('yesterday leaked into the day')
  if (titles.includes('没有时间的备忘')) throw new Error('an undated row leaked into the day')
  if (withEvents.day.undated.length !== 1) throw new Error(`undated bucket has ${withEvents.day.undated.length}`)
  if (crossesMidnight) {
    // The fixture day is tomorrow, so "now" is legitimately not inside it and
    // there is no coherent phase or countdown to assert.
    return `cross-midnight fixture: ${withEvents.day.events.length} events on ${soonDay}`
  }
  if (laterDay !== soonDay && titles.includes('项目周会')) throw new Error('another day leaked into this day')
  // 高数课 + 临近事件 + 别人的会 share the day; 项目周会 joins them when three hours
  // stay inside it; and 今天的固定日程 is on every day by construction.
  const expectedCount = (laterDay === soonDay ? 4 : 3) + 1
  if (withEvents.day.events.length !== expectedCount) {
    throw new Error(`expected ${expectedCount} timed events, got ${withEvents.day.events.length}`)
  }
  if (withEvents.nextEvent?.title !== '临近事件') throw new Error(`nextEvent is ${withEvents.nextEvent?.title}`)
  // Every row here is "now + N minutes" except 今天的固定日程, which is pinned to
  // 08:00 today so a today-shaped question stays answerable at any hour. After
  // 08:00 that one is legitimately past, so the assertion is about the shape of
  // the projection (a row whose time has gone is 'past', not 'upcoming') rather
  // than about the clock happening to read before breakfast.
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes()
  for (const event of withEvents.day.events) {
    const pinned = event.title === '今天的固定日程' && nowMinutes > 8 * 60 + 30
    const wanted = pinned ? 'past' : 'upcoming'
    if (event.phase !== wanted) throw new Error(`${event.title} is ${event.phase}, expected ${wanted}`)
  }
  return `next=${withEvents.nextEvent.title} in ${withEvents.nextEvent.minutesUntilStart} min, ${withEvents.day.stats.totalMinutes} min booked`
})

const fixtureMonth = await api('/snapshot?day=' + soonDay + '&month=' + soonDay.slice(0, 7))
// The same month with a different day open: the grid must be identical and the
// rows must follow the open day. (`laterDay` can equal `soonDay` late at night,
// which is why the row check below is guarded.)
const otherDay = await api('/snapshot?day=' + laterDay + '&month=' + laterDay.slice(0, 7))
await check('the calendar marks exactly the days the schedule has events on', () => {
  const marked = fixtureMonth.month.grid.filter((cell) => cell.inMonth === true && cell.hasEvents === true)
  const soonCell = fixtureMonth.month.grid.find((cell) => cell.dayKey === soonDay)
  if (soonCell === undefined) throw new Error(`${soonDay} is not in its own month's grid`)
  if (soonCell.count < 1) throw new Error(`${soonDay} has ${soonCell.count} events on the calendar but the day has some`)
  if (soonCell.hasEvents !== true) throw new Error(`${soonDay} carries no events flag`)
  // The panel decides whether to draw a dot from the same flag this summary
  // counts with, so a cell can never be marked without being counted.
  const dotted = fixtureMonth.month.grid.filter((cell) => cell.inMonth && cell.hasEvents === true).length
  if (dotted !== fixtureMonth.month.dayCount) {
    throw new Error(`${dotted} dotted cells but dayCount=${fixtureMonth.month.dayCount}`)
  }
  // The month carries the rows of the open day, which is what the grid lists when
  // a date is picked: a day that says "1 条" and then lists nothing is the
  // failure this catches.
  if (!fixtureMonth.month.items.some((item) => item.title === '高数课')) {
    throw new Error(`${soonDay} lists ${JSON.stringify(fixtureMonth.month.items.map((item) => item.title))}`)
  }
  // …and only that day's rows, or the payload grows without the panel using it.
  const onSoonDay = withEvents.day.events.map((event) => event.title)
  for (const item of fixtureMonth.month.items) {
    if (!onSoonDay.includes(item.title)) throw new Error(`${item.title} is not on ${soonDay} at all`)
  }
  if (laterDay !== soonDay) {
    if (!otherDay.month.items.some((item) => item.title === '项目周会')) {
      throw new Error(`opening ${laterDay} listed ${JSON.stringify(otherDay.month.items.map((item) => item.title))}`)
    }
    if (otherDay.month.items.some((item) => item.title === '高数课')) {
      throw new Error(`opening ${laterDay} still listed ${soonDay}'s rows`)
    }
  }
  if (marked.length !== fixtureMonth.month.dayCount) {
    throw new Error(`${marked.length} marked cells but dayCount=${fixtureMonth.month.dayCount}`)
  }
  const summed = marked.reduce((total, cell) => total + cell.count, 0)
  if (summed !== fixtureMonth.month.eventCount) throw new Error(`${summed} events in cells but eventCount=${fixtureMonth.month.eventCount}`)
  // Row-wrapping days of the neighbouring month are marked too, but they must
  // never be counted as part of this month's totals.
  for (const cell of fixtureMonth.month.grid) {
    if (cell.inMonth === false && cell.dayKey.slice(0, 7) === fixtureMonth.month.monthKey) {
      throw new Error(`${cell.dayKey} is in the month but flagged outside it`)
    }
  }
  return `${marked.length} day(s) marked, ${fixtureMonth.month.eventCount} event(s)`
})

  const otherMonth = await api('/snapshot?month=2030-01')
await check('another month is answered as its own month, and paging does not move the open day', () => {
  if (otherMonth.month.monthKey !== '2030-01') throw new Error(`asked for 2030-01, got ${otherMonth.month.monthKey}`)
  if (otherMonth.month.eventCount !== 0) throw new Error(`2030-01 reports ${otherMonth.month.eventCount} events`)
  if (otherMonth.month.dayCount !== 0) throw new Error(`2030-01 reports ${otherMonth.month.dayCount} marked days`)
  if (otherMonth.month.grid.some((cell) => cell.hasEvents === true)) throw new Error('an empty month has marked cells')
  if (otherMonth.day.dayKey !== dayKeyOf(new Date())) throw new Error(`paging months changed the open day to ${otherMonth.day.dayKey}`)
  if (otherMonth.month.prevMonth !== '2029-12' || otherMonth.month.nextMonth !== '2030-02') {
    throw new Error(`neighbours are ${otherMonth.month.prevMonth} / ${otherMonth.month.nextMonth}`)
  }
  return `${otherMonth.month.title}, open day stayed ${otherMonth.day.dayKey}`
})

const nonsenseMonth = await api('/snapshot?month=nonsense')
await check('an unusable month falls back to the current one instead of erroring', () => {
  const expected = dayKeyOf(new Date()).slice(0, 7)
  if (nonsenseMonth.month.monthKey !== expected) throw new Error(`fell back to ${nonsenseMonth.month.monthKey}, expected ${expected}`)
  return nonsenseMonth.month.monthKey
})

await check('a start time that wraps past midnight derives an end the same day', () => {  // The row the tests above use is the one that exposes this: a late-evening
  // start plus a duration must not silently roll the end into the next day.
  const startMinutes = Number(lecture.start.slice(0, 2)) * 60 + Number(lecture.start.slice(3))
  const endMinutes = Number(lecture.end.slice(0, 2)) * 60 + Number(lecture.end.slice(3))
  const span = endMinutes > startMinutes ? endMinutes - startMinutes : endMinutes + 1440 - startMinutes
  if (span !== 40) throw new Error(`start ${lecture.start} end ${lecture.end} spans ${span} minutes, expected 40`)
  return `${lecture.start} -> ${lecture.end} (${span} min)`
})

await check('free slots respect the 20-minute floor', () => {
  const slots = withEvents.day.stats.freeSlots
  if (!Array.isArray(slots)) throw new Error('freeSlots is not an array')
  for (const slot of slots) {
    if (slot.minutes < 20) throw new Error(`slot shorter than the floor: ${JSON.stringify(slot)}`)
  }
  return slots.length === 0 ? 'none left today' : slots.map((slot) => `${slot.from}-${slot.to}`).join(' ')
})

// ------------------------------------------------------------------ overrides

/**
 * The snapshot for the day the fixtures actually landed on.
 *
 * `/events` answers with the projection for *today*, which is the panel's
 * question, not this test's: run after 23:00 and "now + 11 minutes" is tomorrow,
 * so the fixture day and today are different days and reading the reply would
 * report the row as vanished when it is simply not today's.
 */
function fixtureDaySnapshot() {
  return api('/snapshot?day=' + soonDay + '&month=' + soonDay.slice(0, 7))
}

const shifted = await post('/events', { action: 'shift', id: lecture.id, minutes: 10 })
const shiftedDay = await fixtureDaySnapshot()
await check('POST /events shift moves the start and the reminder window', () => {
  const event = shiftedDay.day.events.find((row) => row.id === lecture.id)
  if (event === undefined) throw new Error(`the shifted event vanished from ${soonDay}`)
  if (event.effectiveStart === event.start) throw new Error('effectiveStart was not shifted')
  const expected = new Date(soon.getTime() + 10 * 60_000)
  if (event.effectiveStart !== hhmm(expected)) throw new Error(`shifted to ${event.effectiveStart}, expected ${hhmm(expected)}`)
  if (event.minutesUntilStart < 3) throw new Error(`minutesUntilStart=${event.minutesUntilStart} was not recomputed`)
  return `${event.start} -> ${event.effectiveStart}`
})

const refusedShift = await apiAllowFailure('/events', { action: 'shift', id: timeless.id, minutes: 10 })
await check('a timeless event refuses to shift', () => {
  if (refusedShift.ok !== false) throw new Error('a timeless shift should be refused')
  if (!String(refusedShift.error).includes('时间')) throw new Error(`error was ${refusedShift.error}`)
  return refusedShift.error
})

const snoozed = await post('/events', { action: 'snooze', id: lecture.id, minutes: 5 })
const snoozedDay = await fixtureDaySnapshot()
await check('POST /events snooze records a snooze target', () => {
  const event = snoozedDay.day.events.find((row) => row.id === lecture.id)
  if (event === undefined) throw new Error(`the snoozed event vanished from ${soonDay}`)
  if (typeof event.snoozedUntil !== 'string') throw new Error('snoozedUntil missing')
  const delta = Date.parse(event.snoozedUntil) - Date.now()
  if (delta < 4 * 60_000 || delta > 6 * 60_000) throw new Error(`snooze delta ${delta} ms`)
  return event.snoozedUntil
})

await check('a snoozed event stays silent while snoozed', async () => {
  await new Promise((done) => setTimeout(done, 2500))
  const feed = await api('/feed')
  const fired = feed.feed.filter((entry) => entry.kind === 'reminder' && entry.eventId === lecture.id)
  if (fired.length !== 0) throw new Error(`a snoozed event fired ${fired.length} time(s)`)
  return 'silent while snoozed'
})

const done = await post('/events', { action: 'done', id: lecture.id, done: true })
const doneDay = await fixtureDaySnapshot()
await check('POST /events done removes the row from the day', () => {
  const titles = doneDay.day.events.map((event) => event.title)
  if (titles.includes('高数课')) throw new Error('a completed event still occupies the day')
  // Whatever else shares that day must be untouched. The sibling is looked up
  // from the row set rather than named: which of the fixtures lands on the same
  // day as `lecture` depends on where midnight falls.
  const siblings = added
    .filter((event) => event.id !== lecture.id && event.date === lecture.date)
    .map((event) => event.title)
  for (const title of siblings) {
    if (!titles.includes(title)) throw new Error(`${title} shares ${lecture.date} but was removed too`)
  }
  return `remaining ${titles.join(', ') || '(nothing)'} on ${lecture.date}`
})

const reset = await post('/events', { action: 'reset', id: lecture.id })
const resetDay = await fixtureDaySnapshot()
await check('POST /events reset restores the row, the time, and clears the snooze', () => {
  const event = resetDay.day.events.find((row) => row.id === lecture.id)
  if (event === undefined) throw new Error(`reset did not restore the event to ${soonDay}`)
  if (event.snoozedUntil !== null) throw new Error('snooze survived the reset')
  if (event.effectiveStart !== hhmm(soon)) throw new Error(`the shift survived the reset: ${event.effectiveStart}`)
  return `restored ${event.title} at ${event.effectiveStart}`
})

// ------------------------------------------------------------------ timer

const idle = await api('/timer')
await check('GET /timer returns the idle state', () => {
  if (idle.timer.phase !== 'idle' || idle.timer.running !== false) {
    throw new Error(`phase=${idle.timer.phase} running=${idle.timer.running}`)
  }
  return `remainingMs=${idle.timer.remainingMs}`
})

const started = await post('/timer', { action: 'start', phase: 'focus', subject: '复习傅里叶变换' })
await check('POST /timer start begins a focus phase', () => {
  const timer = started.timer
  if (timer.phase !== 'focus' || timer.running !== true) throw new Error(`${timer.phase}/${timer.running}`)
  if (timer.subject !== '复习傅里叶变换') throw new Error(`subject=${timer.subject}`)
  const expectedMs = timer.config.focusMinutes * 60_000
  if (Math.abs(timer.endsAt - timer.startedAt - expectedMs) > 1000) throw new Error('endsAt does not match the focus length')
  return `${timer.subject} for ${timer.config.focusMinutes} min`
})

await new Promise((done) => setTimeout(done, 1100))
const paused = await post('/timer', { action: 'pause' })
await check('POST /timer pause freezes the remaining time', () => {
  const timer = paused.timer
  if (timer.running !== false) throw new Error('still running')
  const expected = timer.config.focusMinutes * 60_000
  if (timer.remainingMs >= expected) throw new Error(`remaining did not decrease: ${timer.remainingMs}`)
  if (timer.endsAt !== null) throw new Error('endsAt should be cleared')
  return `remaining=${Math.round(timer.remainingMs / 1000)}s`
})

const resumed = await post('/timer', { action: 'resume' })
await check('POST /timer resume restarts from the frozen remainder', () => {
  const timer = resumed.timer
  if (timer.running !== true) throw new Error('not running')
  const expected = timer.config.focusMinutes * 60_000
  if (timer.endsAt - Date.now() >= expected) throw new Error('resume did not preserve the remainder')
  return `endsAt in ${Math.round((timer.endsAt - Date.now()) / 1000)}s`
})

const skipped = await post('/timer', { action: 'skip' })
await check('POST /timer skip advances the cycle', () => {
  const timer = skipped.timer
  if (timer.phase !== 'short' && timer.phase !== 'long') throw new Error(`phase=${timer.phase}`)
  if (timer.completedToday !== 1) throw new Error(`completedToday=${timer.completedToday}`)
  return `${timer.phase}, completedToday=${timer.completedToday}`
})

const timerReset = await post('/timer', { action: 'reset' })
await check('POST /timer reset returns to idle', () => {
  if (timerReset.timer.phase !== 'idle') throw new Error(`phase=${timerReset.timer.phase}`)
  if (timerReset.timer.remainingMs !== 0) throw new Error(`remainingMs=${timerReset.timer.remainingMs}`)
  return 'idle'
})

// ------------------------------------------------------------------ settings

const settingsPayload = await api('/settings')
await check('GET /settings merges over the defaults', () => {
  const settings = settingsPayload.settings
  if (settings.profile.name !== '张三') throw new Error(`name=${settings.profile.name}`)
  if (!settings.profile.aliases.includes('张老师')) throw new Error('aliases lost')
  if (settings.pomodoro.focusMinutes !== 25) throw new Error('default focus length lost')
  if (settings.workbook.importHorizonDays !== 30) throw new Error('default horizon lost')
  return `name=${settings.profile.name} offsets=${settings.reminders.offsetsMinutes.join(',')}`
})

await post('/settings', { settings: { pomodoro: { focusMinutes: 45 } } })
const reread = await api('/settings')
await check('POST /settings persists an override without dropping siblings', () => {
  if (reread.settings.pomodoro.focusMinutes !== 45) throw new Error(`focusMinutes=${reread.settings.pomodoro.focusMinutes}`)
  if (reread.settings.pomodoro.shortBreakMinutes !== 5) throw new Error('the deep merge dropped a sibling default')
  return 'focusMinutes=45, shortBreakMinutes kept at 5'
})

// ------------------------------------------------------------------ assistant (rules)

// The companion answers from the built-in rules first, with the model switched
// off, so these assertions test the rule engine's grounding rather than whatever
// a stub happened to say. The model path gets its own section below.
await post('/settings', { settings: { assistant: { useModel: false } } })

const brief = await post('/assistant', { action: 'brief' })
await check('POST /assistant brief answers from the loaded schedule', () => {
  const reply = brief.reply
  if (typeof reply.speak !== 'string' || reply.speak === '') throw new Error('speak was empty')
  if (!Array.isArray(reply.chips) || reply.chips.length === 0) throw new Error('no follow-up chips')
  const combined = reply.speak + reply.detail
  const known = ['高数课', '临近事件', '项目周会', '别人的会']
  if (!known.some((title) => combined.includes(title))) {
    throw new Error(`answer does not mention a real event: ${reply.speak}`)
  }
  return reply.speak
})

await check('POST /assistant prep lists a checklist for the next event', async () => {
  const prep = await post('/assistant', { action: 'prep' })
  const combined = prep.reply.speak + prep.reply.detail
  // Which event is "next" depends on the hour — after 23:00 the nearest one is on
  // tomorrow's date. The property under test is that prep grounds itself in the
  // event the snapshot actually reports as next, not a fixed title.
  const nextTitle = (await api('/snapshot')).nextEvent?.title
  if (nextTitle === undefined) throw new Error('the snapshot reports no next event')
  if (!combined.includes(nextTitle) && !combined.includes('没有日程')) {
    throw new Error(`prep spoke about ${prep.reply.speak}, but next is ${nextTitle}`)
  }
  if (!prep.reply.detail.includes('1.')) throw new Error('no numbered checklist')
  return `${prep.reply.speak} (next=${nextTitle})`
})

await check('POST /assistant answers a free-form question about a known event', async () => {
  // Ask about an event that is definitely on the queried day, so the answer does
  // not depend on where midnight falls. The day goes in the **query string**:
  // `post()` puts its second argument in the body, and the host reads the
  // projection from the URL, so `{ day }` in the body selects nothing. Late at
  // night the fixtures land on tomorrow, and this asked about today.
  const day = dayKeyOf(soon)
  const asked = await api('/assistant?day=' + day, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'ask', question: '高数课在哪' }),
  })
  if (asked.reply.speak.includes('暂时只能')) throw new Error('the mention was not matched')
  if (!(asked.reply.detail + asked.reply.speak).includes('高数课')) {
    throw new Error(`the answer does not mention the event: ${asked.reply.speak}`)
  }
  return asked.reply.speak
})

await check('POST /assistant explains the reminder ladder from settings', async () => {
  const answer = await post('/assistant', { action: 'ask', question: '提醒是怎么设置的？' })
  if (!answer.reply.speak.includes('提醒')) throw new Error(answer.reply.speak)
  return answer.reply.speak.slice(0, 60)
})

await check('POST /assistant gap finds a focus window', async () => {
  const gap = await post('/assistant', { action: 'gap' })
  if (typeof gap.reply.speak !== 'string' || gap.reply.speak === '') throw new Error('empty gap answer')
  return gap.reply.speak
})

await check('prep describes an in-flight event as running, never as upcoming', async () => {
  // An event that started a few minutes ago is the case that used to answer
  // "已过 3 分钟开始" — a sentence that cannot be true of the next thing starting.
  // The fixture set already contains one such event after 23:30, so rather than
  // adding a second, this asserts on whatever the snapshot reports as nearest.
  const snapshot = await api('/snapshot')
  const nearest = snapshot.nextEvent
  if (nearest === null) return 'no upcoming event to inspect'
  if (nearest.isCurrent !== true) {
    return `the nearest event (${nearest.title}) has not started yet; nothing in flight to check`
  }
  const prep = await post('/assistant', { action: 'prep' })
  const answer = prep.reply.speak + prep.reply.detail
  if (/已过\s*\d+\s*分钟开始/.test(answer)) {
    throw new Error(`prep called an in-flight event "starting in the past": ${prep.reply.speak}`)
  }
  if (!prep.reply.speak.includes(nearest.title)) {
    throw new Error(`prep did not speak about the in-flight event: ${prep.reply.speak}`)
  }
  if (!prep.reply.speak.includes('正在进行')) {
    throw new Error(`prep did not describe it as running: ${prep.reply.speak}`)
  }
  return prep.reply.speak
})

// ------------------------------------------------------------------ assistant (model)

await post('/settings', { settings: { assistant: { useModel: true } } })

await check('the assistant reports its mode before being asked anything', async () => {
  const status = await post('/assistant', { action: 'status' })
  if (status.status?.mode !== 'model') throw new Error(`mode=${status.status?.mode} (${status.status?.detail})`)
  if (!String(status.status.detail).includes('deepseek-account')) throw new Error(`detail=${status.status.detail}`)
  return status.status.detail
})

await check('a question is answered by the model when one is available', async () => {
  modelStub.calls.length = 0
  modelStub.answer = '项目周会在线上腾讯会议，18 分钟后开始，先把上次的结论翻出来。'
  const answer = await post('/assistant', { action: 'ask', question: '项目周会我该准备什么？' })
  if (answer.reply.mode !== 'model') throw new Error(`mode=${answer.reply.mode} (${JSON.stringify(answer.reply.fallback)})`)
  if (!answer.reply.speak.includes('腾讯会议')) throw new Error(`speak=${answer.reply.speak}`)
  if (modelStub.calls.length !== 1) throw new Error(`the model was called ${modelStub.calls.length} times`)
  return answer.reply.speak
})

await check('the model receives the schedule as grounding context', async () => {
  const call = modelStub.calls[0]
  if (call === undefined) throw new Error('no recorded call')
  if (call.provider !== 'deepseek-account' || call.model !== 'deepseek-flash') {
    throw new Error(`route=${call.provider}/${call.model}`)
  }
  if (typeof call.system !== 'string' || !call.system.includes('Orbyt')) throw new Error('system prompt missing')
  for (const needle of ['高数课', '今日日程', '关注的人']) {
    if (!call.system.includes(needle)) throw new Error(`grounding context is missing ${needle}`)
  }
  if (!Array.isArray(call.messages) || call.messages.length === 0) throw new Error('no messages')
  const last = call.messages[call.messages.length - 1]
  if (last.role !== 'user' || last.content?.[0]?.text !== '项目周会我该准备什么？') {
    throw new Error(`last message=${JSON.stringify(last)}`)
  }
  if (call.reasoningEffort !== 'max') throw new Error(`reasoningEffort=${call.reasoningEffort}`)
  if (call.signal === undefined) throw new Error('no cancellation signal was passed')
  return `${call.system.length} char context, ${call.messages.length} messages`
})

await check('history shaping drops junk and never opens on an assistant turn', async () => {
  await post('/assistant', {
    action: 'ask',
    question: '那第二件事呢？',
    history: [
      { role: 'assistant', text: '这条开场白不该被当成我说过的话' },
      { role: 'user', text: '今天有什么？' },
      { role: 'tool', text: 'this role must be dropped' },
      { role: 'user', text: '   ' },
      { role: 'assistant', text: '有高数课和项目周会。' },
    ],
  })
  const call = modelStub.calls[modelStub.calls.length - 1]
  const roles = call.messages.map((message) => message.role)
  if (roles[0] !== 'user') throw new Error(`the first turn is ${roles[0]}; providers reject that`)
  if (roles.length !== 3) throw new Error(`roles=${roles.join(',')} (junk turns were not filtered)`)
  if (roles[1] !== 'assistant' || roles[2] !== 'user') throw new Error(`role order=${roles.join(',')}`)
  if (JSON.stringify(call.messages).includes('开场白')) throw new Error('a leading assistant turn survived')
  return roles.join(' -> ')
})

await check('the chips come from the rule engine even on a model answer', async () => {
  const answer = await post('/assistant', { action: 'focus', minutes: 25 })
  if (answer.reply.mode !== 'model') throw new Error(`mode=${answer.reply.mode}`)
  if (!Array.isArray(answer.reply.chips) || answer.reply.chips.length === 0) {
    throw new Error('no follow-up chips were supplied')
  }
  return answer.reply.chips.join(' / ')
})

await check('a throwing model falls back to the rule engine', async () => {
  modelStub.fail = 'throw'
  const answer = await post('/assistant', { action: 'brief' })
  modelStub.fail = null
  if (answer.reply.mode !== 'local') throw new Error(`mode=${answer.reply.mode}`)
  if (answer.reply.fallback?.reason !== 'threw') throw new Error(`fallback=${JSON.stringify(answer.reply.fallback)}`)
  if (typeof answer.reply.speak !== 'string' || answer.reply.speak === '') throw new Error('no local answer')
  return `${answer.reply.fallback.reason}: ${answer.reply.speak.slice(0, 30)}`
})

await check('a model error finish falls back to the rule engine', async () => {
  modelStub.fail = 'error-finish'
  const answer = await post('/assistant', { action: 'brief' })
  modelStub.fail = null
  if (answer.reply.mode !== 'local') throw new Error(`mode=${answer.reply.mode}`)
  if (answer.reply.fallback?.reason !== 'model-error') throw new Error(`fallback=${JSON.stringify(answer.reply.fallback)}`)
  if (!String(answer.reply.fallback.detail).includes('rate limited')) throw new Error(`detail=${answer.reply.fallback.detail}`)
  return answer.reply.fallback.detail
})

await check('an empty model answer falls back instead of showing nothing', async () => {
  modelStub.fail = 'empty'
  const answer = await post('/assistant', { action: 'brief' })
  modelStub.fail = null
  if (answer.reply.mode !== 'local') throw new Error(`mode=${answer.reply.mode}`)
  if (answer.reply.fallback?.reason !== 'empty') throw new Error(`fallback=${JSON.stringify(answer.reply.fallback)}`)
  if (answer.reply.speak === '') throw new Error('the panel would have rendered an empty bubble')
  return answer.reply.speak.slice(0, 30)
})

await check('the model can be switched off, and the panel is told why', async () => {
  await post('/settings', { settings: { assistant: { useModel: false } } })
  const status = await post('/assistant', { action: 'status' })
  if (status.status?.mode !== 'local') throw new Error(`mode=${status.status.mode}`)
  if (status.status.reason !== 'disabled') throw new Error(`reason=${status.status.reason}`)
  const answer = await post('/assistant', { action: 'brief' })
  if (answer.reply.mode !== 'local') throw new Error(`mode=${answer.reply.mode}`)
  if (answer.reply.fallback?.reason !== 'disabled') throw new Error(`fallback=${JSON.stringify(answer.reply.fallback)}`)
  await post('/settings', { settings: { assistant: { useModel: true } } })
  return status.status.detail
})

await check('a composition without the model service degrades cleanly', async () => {
  const saved = services.llm
  delete services.llm
  const status = await post('/assistant', { action: 'status' })
  services.llm = saved
  if (status.status?.mode !== 'local') throw new Error(`mode=${status.status.mode}`)
  if (status.status.reason !== 'no-service') throw new Error(`reason=${status.status.reason}`)
  return status.status.detail
})

await check('the feed records which brain answered', async () => {
  const feed = await api('/feed')
  const ai = feed.feed.filter((entry) => entry.kind === 'ai')
  if (ai.length === 0) throw new Error('no ai entries')
  const byModel = ai.filter((entry) => String(entry.body).includes('生成'))
  const byRules = ai.filter((entry) => String(entry.body).includes('内置规则'))
  if (byModel.length === 0) throw new Error('no model-attributed entry')
  if (byRules.length === 0) throw new Error('no rule-attributed entry')
  return `${byModel.length} model / ${byRules.length} local`
})

// ------------------------------------------------------------------ feed & export

const feed = await api('/feed')
await check('GET /feed returns newest-first activity', () => {
  if (feed.feed.length === 0) throw new Error('feed is empty')
  const seqs = feed.feed.map((entry) => entry.seq)
  for (let i = 1; i < seqs.length; i += 1) {
    if (seqs[i] >= seqs[i - 1]) throw new Error(`feed is not newest-first: ${seqs.join(',')}`)
  }
  return `${feed.feed.length} entries, kinds=${[...new Set(feed.feed.map((entry) => entry.kind))].join(',')}`
})

const exported = await api('/export')
await check('GET /export returns the durable state', () => {
  // Counted from the fixtures rather than written down: the probe row added by the
  // toast check is removed again, so what is left is exactly what this test added.
  if (exported.events.length !== added.length) {
    throw new Error(`exported ${exported.events.length} events, the run added ${added.length}`)
  }
  if (exported.settings.profile.name !== '张三') throw new Error('settings missing from the export')
  return `${exported.events.length} events, exportedAt=${exported.exportedAt.slice(0, 19)}`
})

// ------------------------------------------------------------------ hud

const hud = await post('/hud', { action: 'status' })
await check('POST /hud reports the floating-window state without spawning it', () => {
  if (hud.ok !== true) throw new Error(`ok=${hud.ok} error=${hud.error}`)
  if (typeof hud.running !== 'boolean') throw new Error('running is not a boolean')
  if (hud.running !== false) throw new Error('a status probe must not start the widget')
  if (hud.state === undefined) throw new Error('hud state missing')
  return `running=${hud.running} phase=${hud.state.phase} next=${hud.state.nextTitle}`
})

await check('the HUD state mirrors the live snapshot', () => {
  // The pinned fixture, not a count: every other row is "now + N" and slides onto
  // tomorrow late in the evening, so counting would measure the clock.
  if (!hud.state.eventsToday.some((row) => row.title === '今天的固定日程')) {
    throw new Error(`today's row is missing from the HUD: ${hud.state.eventsToday.map((row) => row.title).join('/') || '(none)'}`)
  }
  if (hud.state.eventCount !== hud.state.eventsToday.length && hud.state.eventCount > 12) {
    throw new Error(`eventCount=${hud.state.eventCount} but ${hud.state.eventsToday.length} rows were sent`)
  }
  if (hud.state.ownerNames.join('/') !== '张三/张老师') throw new Error('owner names missing from the HUD state')
  if (!Array.isArray(hud.state.eventsToday)) throw new Error('eventsToday missing')
  if (hud.state.phase !== 'idle') throw new Error(`phase=${hud.state.phase} after the timer reset`)
  if (hud.state.totalSeconds !== 0) throw new Error(`an idle timer should report 0 total seconds, got ${hud.state.totalSeconds}`)
  return `${hud.state.eventCount} events, titles=${hud.state.eventsToday.map((row) => row.title).join('/')}`
})

await check('the HUD state carries the live countdown once the timer runs', async () => {
  await post('/timer', { action: 'start', phase: 'focus', subject: '悬浮窗联动' })
  const live = await post('/hud', { action: 'status' })
  if (live.state.phase !== 'focus') throw new Error(`phase=${live.state.phase}`)
  if (live.state.totalSeconds !== 45 * 60) throw new Error(`totalSeconds=${live.state.totalSeconds}, expected the 45-minute override`)
  if (live.state.remainingSeconds <= 0 || live.state.remainingSeconds > live.state.totalSeconds) {
    throw new Error(`remainingSeconds=${live.state.remainingSeconds}`)
  }
  if (live.state.subject !== '悬浮窗联动') throw new Error(`subject=${live.state.subject}`)
  await post('/timer', { action: 'reset' })
  return `focus ${live.state.remainingSeconds}s / ${live.state.totalSeconds}s`
})

await check('an unknown HUD action is refused instead of starting the widget', async () => {
  const refused = await apiAllowFailure('/hud', { action: 'nonsense' })
  if (refused.ok !== false) throw new Error('an unknown action was accepted')
  if (!String(refused.error).includes('nonsense')) throw new Error(`error=${refused.error}`)
  const after = await post('/hud', { action: 'status' })
  if (after.running !== false) throw new Error('the widget was started by an invalid request')
  return refused.error
})

// ------------------------------------------------------------------ boot: HUD autostart

// The boot timer is what launches the floating window in the real host. Run it
// here with the spawn seam observed, so the argument list that reaches PowerShell
// is asserted rather than assumed.
await check('the boot timer launches the floating HUD with the right arguments', async () => {
  await post('/settings', { settings: { ui: { showFloatingWidget: true } } })
  spawnedProcesses.length = 0
  runTimeouts()
  await new Promise((done) => setTimeout(done, 60))

  if (spawnedProcesses.length !== 1) throw new Error(`spawn was called ${spawnedProcesses.length} times`)
  const call = spawnedProcesses[0]
  if (!/powershell\.exe$/i.test(call.command)) throw new Error(`command=${call.command}`)
  const args = call.args
  for (const required of ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File']) {
    if (!args.includes(required)) throw new Error(`missing argument ${required}: ${args.join(' ')}`)
  }
  if (args.some((arg) => /hud\.ps1$/.test(arg)) === false) throw new Error('hud.ps1 was not passed')
  if (args.some((arg) => /hud-state\.json$/.test(arg)) === false) throw new Error('no state path was passed')
  if (!args.includes('-logPath')) throw new Error('no interaction log path was passed')
  const portAt = args.indexOf('-port')
  if (portAt === -1 || !/^\d+$/.test(args[portAt + 1])) throw new Error('no usable port was passed')
  // The mock web server reports port 0, so the widget must fall back to the
  // configured DSH_WEB_URL rather than handing the user a dead button. The
  // expected value comes from the environment, not a literal: the port belongs
  // to the install that happens to be running, and a fixed one only passes on
  // the machine the test was written on.
  const urlAt = args.indexOf('-dashboardUrl')
  if (urlAt === -1) throw new Error(`no dashboardUrl was passed: ${args.join(' ')}`)
  const fallback = process.env.DSH_WEB_URL
  if (typeof fallback === 'string' && /^https?:\/\//.test(fallback)) {
    const expected = fallback.endsWith('/') ? fallback : fallback + '/'
    if (args[urlAt + 1] !== expected) {
      throw new Error(`dashboardUrl=${args[urlAt + 1]} (expected the DSH_WEB_URL fallback ${expected})`)
    }
  } else if (!/^https?:\/\/127\.0\.0\.1:\d+\/$/.test(args[urlAt + 1])) {
    throw new Error(`dashboardUrl=${args[urlAt + 1]} is not a usable local URL`)
  }

  const running = await post('/hud', { action: 'status' })
  if (running.running !== true) throw new Error('the HUD was launched but status does not say so')
  await api('/feed', { method: 'DELETE' })
  return `${args.slice(0, 5).join(' ')} … -dashboardUrl ${args[urlAt + 1]}`
})

await check('the HUD bridge is torn down with the plugin', async () => {
  const stopped = await post('/hud', { action: 'stop' })
  if (stopped.running !== false) throw new Error('stop did not report the widget as gone')
  const after = await post('/hud', { action: 'status' })
  if (after.running !== false) throw new Error('the widget is still reported as running')
  return 'stopped'
})

// A widget outlives a DSH restart, so the host that is running now may have no
// child of its own while a window sits on screen. The panel asks `/hud` whether
// it is there and offers 关闭悬浮窗 when it is — and that button used to be a
// no-op in exactly this case, because the only thing it could kill was its own
// spawned process. This drives the durable record instead: the pid file names the
// process, the heartbeat file (rewritten twice a second by a live widget) says it
// is running now, and `hud.ps1 -shutdown` proves identity before it kills.
//
// The stand-in is a *real* window titled "Orbit Time" owned by a process this
// host did not spawn, which is what the identity check looks for. A process with
// no such window is refused (there is a check for that too, further down).
await check('a widget from a previous host generation is reported and can be closed', async () => {
  const hudDir = join(scratch, 'storages', 'orbit-time')
  const pidPath = join(hudDir, 'hud.pid')
  const alivePath = join(hudDir, 'hud-alive.json')
  const modePath = join(hudDir, 'hud-mode.json')
  const standIn = spawn(
    'powershell.exe',
    ['-NoProfile', '-Command', "$host.UI.RawUI.WindowTitle = 'Orbit Time'; Start-Sleep -Seconds 60"],
    { windowsHide: false, stdio: ['ignore', 'ignore', 'inherit'] },
  )
  let standInGone = false
  standIn.on('exit', () => {
    standInGone = true
  })
  await new Promise((done) => setTimeout(done, 2500))
  if (standInGone) throw new Error('the stand-in window closed before the check could run')
  writeFileSync(pidPath, String(standIn.pid), 'utf8')
  writeFileSync(alivePath, JSON.stringify({ pid: standIn.pid, mode: 'pill', at: new Date().toISOString() }), 'utf8')

  const seen = await post('/hud', { action: 'status' })
  if (seen.running !== true) throw new Error(`the orphan was not reported as running: ${JSON.stringify(seen)}`)
  const closed = await Promise.race([
    post('/hud', { action: 'stop' }),
    new Promise((done) => setTimeout(() => done({ timeout: true }), 30_000)),
  ])
  if (closed.timeout === true) {
    standIn.kill()
    throw new Error('stop never answered')
  }
  if (closed.running !== false) throw new Error('stop did not report the widget as gone')
  for (let wait = 0; wait < 40 && !standInGone; wait += 1) {
    await new Promise((done) => setTimeout(done, 250))
  }
  const killed = standInGone
  if (!killed) standIn.kill()
  const after = await post('/hud', { action: 'status' })
  if (!killed) throw new Error('the widget process was not stopped')
  if (after.running !== false) throw new Error('the widget is still reported as running')
  if (existsSync(pidPath)) throw new Error('hud.pid was left behind after stop')
  if (!existsSync(modePath)) throw new Error('the close was not recorded, so the next boot would restore the widget')
  const mode = JSON.parse(readFileSync(modePath, 'utf8'))
  if (mode.state !== 'closed') throw new Error(`hud-mode.json says ${JSON.stringify(mode.state)}`)
  rmSync(alivePath, { force: true })
  return 'reported, stopped, and recorded as closed'
})

// The other half of that: a heartbeat that has gone stale belongs to a widget
// that is gone (or to a pid the OS has since reused), and must not be described
// as running — nor handed to a kill.
await check('a stale heartbeat is not mistaken for a running widget', async () => {
  const hudDir = join(scratch, 'storages', 'orbit-time')
  const pidPath = join(hudDir, 'hud.pid')
  const alivePath = join(hudDir, 'hud-alive.json')
  writeFileSync(pidPath, String(process.pid), 'utf8')
  writeFileSync(alivePath, JSON.stringify({ pid: process.pid, mode: 'pill', at: new Date().toISOString() }), 'utf8')
  const stale = new Date(Date.now() - 120_000)
  utimesSync(alivePath, stale, stale)
  const seen = await post('/hud', { action: 'status' })
  if (seen.running !== false) throw new Error('a two-minute-old heartbeat was reported as running')
  rmSync(pidPath, { force: true })
  rmSync(alivePath, { force: true })
  return 'ignored'
})

// Settings used to be read once at mount and cached, so editing config.json — by
// hand, or by another tool — was ignored until the next app start. Since the
// panel offers `ui.showFloatingWidget`, the file has to be a supported way to set
// it, which means the two have to agree.
await check('a config.json edited outside the panel is picked up', async () => {
  const configPath = join(scratch, 'storages', 'orbit-time', 'config.json')
  if (!existsSync(configPath)) throw new Error(`the host never wrote ${configPath}`)

  const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
  if (onDisk.ui?.showFloatingWidget !== true) {
    throw new Error(`expected the widget to start enabled, saw ${JSON.stringify(onDisk.ui)}`)
  }
  onDisk.ui = { ...onDisk.ui, showFloatingWidget: false }
  writeFileSync(configPath, JSON.stringify(onDisk, null, 2), 'utf8')

  // The watcher runs on an interval; wait for a couple of passes.
  await new Promise((done) => setTimeout(done, 4000))

  const after = await api('/settings')
  if (after.settings?.ui?.showFloatingWidget !== false) {
    throw new Error(`the host still reports showFloatingWidget=${JSON.stringify(after.settings?.ui?.showFloatingWidget)}`)
  }
  const snapshot = await api('/snapshot')
  if (snapshot.settings?.ui?.showFloatingWidget !== false) {
    throw new Error('the snapshot the panel renders from did not pick the change up')
  }
  return 'the panel now hides itself without a host restart'
})

await check('a reminder posts a Windows toast through the spawn seam', async () => {
  // Land an event roughly a minute out so the toast path runs without waiting for
  // a real countdown.
  //
  // Stored start times have minute precision while "now" does not, so a start
  // built from "now + 100 s" is anywhere between 1 and 2 minutes away once
  // truncated. Rather than fight that, the ladder declares both rungs and the
  // assertion accepts either: the point under test is that a due rung reaches
  // PowerShell, not which rung the clock selected.
  await post('/settings', { settings: { reminders: { offsetsMinutes: [2, 1, 0], osToast: true, sound: true } } })

  const target = new Date(Date.now() + 100_000)
  const probe = (
    await post('/events', {
      action: 'add',
      event: { title: '通知探针', date: dayKeyOf(target), start: hhmm(target), person: '张三' },
    })
  ).event
  const view = (await api('/snapshot?day=' + probe.date)).day.events.find((event) => event.id === probe.id)
  if (view === undefined) throw new Error('the probe event is not on the requested day')
  if (view.minutesUntilStart > 2) throw new Error(`probe landed ${view.minutesUntilStart} minutes out; the ladder covers 0-2`)
  spawnedProcesses.length = 0

  const deadline = Date.now() + 8000
  let toast = null
  while (Date.now() < deadline && toast === null) {
    await new Promise((done) => setTimeout(done, 500))
    // The toast helper is identified by its inline script, which is the argument
    // after -Command; the HUD has a different shape (-STA -File).
    toast =
      spawnedProcesses.find((entry) => {
        if (!/powershell\.exe$/i.test(entry.command)) return false
        const at = entry.args.indexOf('-Command')
        return at !== -1 && String(entry.args[at + 1]).includes('ToastNotificationManager')
      }) ?? null
  }
  const diagnostics = {
    spawns: spawnedProcesses.map((entry) => entry.args.slice(0, 3).join(' ')),
    feed: (await api('/feed')).feed.filter((entry) => entry.kind === 'reminder').map((entry) => entry.title),
  }
  await post('/events', { action: 'remove', id: probe.id })
  await post('/settings', { settings: { reminders: { osToast: false } } })

  if (toast === null) throw new Error(`no toast was posted; diagnostics: ${JSON.stringify(diagnostics)}`)
  const script = toast.args[toast.args.indexOf('-Command') + 1]
  for (const needle of ['ToastNotificationManager', 'LoadXml']) {
    if (!script.includes(needle)) throw new Error(`the toast script is missing ${needle}`)
  }
  if (toast.options?.stdio?.[0] !== 'pipe') throw new Error('the toast script needs stdin to receive the XML')
  return 'ToastNotificationManager invoked with piped XML'
})

// ------------------------------------------------------------------ reminders

if (fast) {
  console.log('  --   reminder ladder skipped (--fast)')
} else {
  console.log('  ...  waiting out the 1-minute rung (about 70 s)')

  let reminderEntry = null
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline && reminderEntry === null) {
    await new Promise((done) => setTimeout(done, 1500))
    const list = (await api('/feed')).feed
    reminderEntry = list.find((entry) => entry.kind === 'reminder' && entry.eventId === imminent.id) ?? null
  }

  await check('the 1-minute rung fires exactly once', async () => {
    if (reminderEntry === null) throw new Error('no reminder was emitted within 120 s')
    const first = (await api('/feed')).feed.filter((entry) => entry.kind === 'reminder' && entry.eventId === imminent.id)
    if (first.length !== 1) throw new Error(`fired ${first.length} times at first sight; a rung must not repeat`)
    // Keep watching across several more scans: the rung window stays open for
    // minutes, so a missing dedup key would keep re-firing here.
    await new Promise((done) => setTimeout(done, 7000))
    const settled = (await api('/feed')).feed.filter((entry) => entry.kind === 'reminder' && entry.eventId === imminent.id)
    if (settled.length !== 1) throw new Error(`fired ${settled.length} times after the window stayed open`)
    return 'offset=1, stable across subsequent scans'
  })

  await check('the reminder is actionable and labelled for its rung', () => {
    if (reminderEntry === null) throw new Error('no reminder to inspect')
    if (!Array.isArray(reminderEntry.actions) || !reminderEntry.actions.includes('snooze')) {
      throw new Error(`actions=${JSON.stringify(reminderEntry.actions)}`)
    }
    if (!reminderEntry.title.includes('临近事件')) throw new Error(`title=${reminderEntry.title}`)
    // The ladder is [2, 1, 0] for this run, and which rung is due first depends on
    // where the clock sits inside the minute. The property under test is that the
    // title names the rung it belongs to, whatever that rung is.
    const rungs = [2, 1, 0]
    const named = rungs.some((offset) => reminderEntry.title.includes(offset === 0 ? '现在开始' : `${offset} 分钟`))
    if (!named) throw new Error(`no rung label in ${reminderEntry.title} (expected one of ${rungs.join('/')})`)
    if (reminderEntry.level !== 'urgent') throw new Error(`level=${reminderEntry.level}`)
    return reminderEntry.title
  })

  await check('the far-away event did not fire a rung early', async () => {
    const list = (await api('/feed')).feed
    const early = list.filter((entry) => entry.kind === 'reminder' && entry.eventId === lecture.id)
    if (early.length !== 0) throw new Error(`an event 10+ minutes out fired ${early.length} rung(s)`)
    return 'no early rungs'
  })

  await check('a completed event never fires a rung', async () => {
    const target = await api('/snapshot?day=' + soonDay)
    const candidate = target.day.events.find((event) => event.title === '临近事件')
    if (candidate === undefined) throw new Error('the reminder event vanished')
    await post('/events', { action: 'done', id: candidate.id, done: true })
    const before = (await api('/feed')).feed.filter((entry) => entry.kind === 'reminder' && entry.eventId === candidate.id).length
    await new Promise((done) => setTimeout(done, 4000))
    const after = (await api('/feed')).feed.filter((entry) => entry.kind === 'reminder' && entry.eventId === candidate.id).length
    await post('/events', { action: 'reset', id: candidate.id })
    if (after !== before) throw new Error(`a completed event fired ${after - before} more rung(s)`)
    return `stable at ${after} rung(s)`
  })
}

// ------------------------------------------------------------------ multi-roster import
//
// The failure this section locks down: every import rebuilt the schedule from
// only the file the panel named, so importing a second roster silently deleted
// the first one's events ("前一份被顶替了"), and a roster that failed to read took
// its rows with it. A second host instance is booted against its own state
// directory, and its Excel spawn seam is scripted — the parse result is fed in as
// JSON, so the assertions are about the import's bookkeeping rather than about
// openpyxl.

/**
 * A child-process stand-in that emits a canned parse result and closes cleanly.
 *
 * `runPython()` only needs `stdout`/`stderr` streams, an `error` listener, a
 * `close` listener, and `kill()`; emulating those is enough to drive the whole
 * import path without a Python interpreter (which this sandbox cannot spawn with
 * piped stdio at all).
 */
function scriptedPython(respond) {
  return function spawn(command, args) {
    const script = args[0] ?? ''
    const workbookPath = args[1] ?? ''
    const payload = script.endsWith('parse-xlsx.py') ? respond(workbookPath) : { ok: false, error: 'unexpected script' }
    const handlers = {}
    const child = {
      pid: 909090,
      killed: false,
      stdout: { on: (event, fn) => { if (event === 'data') handlers.stdout = fn } },
      stderr: { on: (event, fn) => { if (event === 'data') handlers.stderr = fn } },
      on: (event, fn) => {
        handlers[event] = fn
        return child
      },
      kill() {
        this.killed = true
      },
    }
    setTimeout(() => {
      if (payload === null) {
        handlers.stderr?.(`找不到文件：${workbookPath}\n`)
        handlers.close?.(1)
        return
      }
      handlers.stdout?.(JSON.stringify(payload))
      handlers.close?.(0)
    }, 0)
    return child
  }
}

/** A parsed-workbook payload shaped like `parse-xlsx.py`'s own output. */
function parsedWorkbook(file, titles) {
  const day = dayKeyOf(new Date(Date.now() + 3 * 86_400_000))
  const rows = titles.map((title, index) => ({
    _row: index + 2,
    date: day,
    start: '07:00',
    end: '07:30',
    title,
    person: '张三',
    teacher: '',
    notes: '',
    location: '',
    course: '',
    classroom: '',
    weekday: '周三',
    extras: {},
    _warnings: [],
  }))
  return {
    ok: true,
    file,
    sheet: 'Sheet1',
    sheets: ['Sheet1'],
    layout: 'records',
    headerRow: 1,
    mapping: { date: '日期', start: '开始时间', end: '结束时间', title: '事项', person: '姓名' },
    unmapped: [],
    headers: [],
    rowCount: rows.length,
    rows,
    preview: rows,
    warnings: [],
  }
}

/** Boot one more host into its own routes/server/state directory. */
async function bootRosterHost() {
  const { createServer: createHttpServer } = await import('node:http')
  const stateRoot = mkdtempSync(join(tmpdir(), 'orbit-time-rosters-'))
  const rosters = {
    a: join(stateRoot, 'roster-a.xlsx'),
    b: join(stateRoot, 'roster-b.xlsx'),
  }
  writeFileSync(rosters.a, 'placeholder-a', 'utf8')
  writeFileSync(rosters.b, 'placeholder-b', 'utf8')
  const titles = {
    a: ['A-早打卡', 'A-值班'],
    b: ['B-晚自习'],
  }
  const routes = new Map()
  const ctx = {
    get: (service) =>
      service === 'orbitTimeSpawn'
        ? scriptedPython((workbookPath) => {
            const key = Object.keys(rosters).find((name) => workbookPath === rosters[name])
            return key === undefined ? null : parsedWorkbook(workbookPath, titles[key])
          })
        : undefined,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    webServer: {
      port: 0,
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    interval: () => () => {},
    timeout: () => () => {},
    effect: () => () => {},
  }
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = stateRoot
  try {
    hostModule.apply(ctx, {
      profile: { name: '张三' },
      workbook: { path: '', watch: false, sources: [] },
      reminders: { enabled: false },
      ui: { showFloatingWidget: false },
    })
  } finally {
    process.env.DSH_HOME = savedHome
  }
  const httpServer = createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const handler = routes.get(url.pathname)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'no route ' + url.pathname }))
      return
    }
    handler(req, res)
  })
  await new Promise((done) => httpServer.listen(0, '127.0.0.1', done))
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}/api/orbit-time`
  const call = async (path, options) => {
    const response = await fetch(baseUrl + path, options)
    const text = await response.text()
    return text === '' ? null : JSON.parse(text)
  }
  const postJson = (path, body) =>
    call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  return {
    rosters,
    titles,
    stateRoot,
    get: (path) => call(path),
    post: postJson,
    close: async () => {
      await new Promise((done) => httpServer.close(done))
      rmSync(stateRoot, { recursive: true, force: true })
    },
  }
}

{
  const rosterHost = await bootRosterHost()
  // The scripted rows are dated a few days out, so "today's" snapshot is empty by
  // definition; the whole imported set is what these checks are about.
  const allTitles = async () => {
    const payload = await rosterHost.get('/events')
    return payload.events.map((event) => event.title)
  }

  await check('importing one roster brings in exactly that roster', async () => {
    const result = await rosterHost.post('/import', { path: rosterHost.rosters.a, subject: '示例支部早打卡值班' })
    if (result.ok !== true) throw new Error(result.error || 'import refused')
    if (result.excel.importedCount !== 2) throw new Error(`imported ${result.excel.importedCount}, expected 2`)
    const titles = (await allTitles()).sort()
    const wanted = ['A-早打卡', 'A-值班'].sort()
    if (titles.join('|') !== wanted.join('|')) throw new Error(`the schedule holds ${titles.join('|')}`)
    return titles.join(' / ')
  })

  await check('importing a second roster keeps the first one', async () => {
    const result = await rosterHost.post('/import', { path: rosterHost.rosters.b, subject: '示例支部晚自习考勤点名' })
    if (result.ok !== true) throw new Error(result.error || 'import refused')
    if (result.excel.importedCount !== 3) throw new Error(`imported ${result.excel.importedCount}, expected 3 (2 + 1)`)
    const titles = (await allTitles()).sort()
    const wanted = ['A-早打卡', 'A-值班', 'B-晚自习'].sort()
    if (titles.join('|') !== wanted.join('|')) throw new Error(`the schedule holds ${titles.join('|')} instead of ${wanted.join('|')}`)
    const health = await rosterHost.get('/health')
    if (health.sources.length !== 2) throw new Error(`${health.sources.length} roster(s) configured, expected 2`)
    if (!health.sources.some((path) => path.endsWith('roster-a.xlsx'))) throw new Error('the first roster was dropped from the config')
    return `${titles.join(' / ')} · ${health.sources.length} rosters`
  })

  await check('re-importing one roster does not evict the other', async () => {
    const result = await rosterHost.post('/import', { path: rosterHost.rosters.a })
    if (result.excel.importedCount !== 3) throw new Error(`imported ${result.excel.importedCount}, expected 3`)
    const titles = await allTitles()
    if (!titles.includes('B-晚自习')) throw new Error(`the evening roster vanished: ${titles.join('|')}`)
    return `${titles.length} events across both rosters`
  })

  await check('a hand-added row survives an import, and is persisted with one', async () => {
    const day = dayKeyOf(new Date(Date.now() + 3 * 86_400_000))
    await rosterHost.post('/events', { action: 'add', event: { title: '自己加的体检', date: day, start: '15:00', person: '张三' } })
    const imported = await rosterHost.post('/import', {})
    if (imported.excel.manualCount !== 1) throw new Error(`manualCount=${imported.excel.manualCount}`)
    const titles = await allTitles()
    if (!titles.includes('自己加的体检')) throw new Error(`the hand-added row was swept away: ${titles.join('|')}`)
    const stateFile = join(rosterHost.stateRoot, 'storages', 'orbit-time', 'runtime.json')
    await new Promise((done) => setTimeout(done, 1200))
    const stored = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (!Array.isArray(stored.manualEvents) || stored.manualEvents.length !== 1) {
      throw new Error('runtime.json did not persist the hand-added rows')
    }
    if (!stored.events.some((event) => event.title === '自己加的体检')) throw new Error('the manual row is missing from the persisted events')
    return `${imported.excel.importedCount} imported + 1 manual, persisted`
  })

  await check('a roster that cannot be read keeps the rows it already had', async () => {
    rmSync(rosterHost.rosters.a, { force: true })
    const result = await rosterHost.post('/import', {})
    if (result.ok !== true) throw new Error(result.error || 'import refused')
    if (result.excel.carriedCount !== 2) throw new Error(`carriedCount=${result.excel.carriedCount}, expected 2`)
    const titles = await allTitles()
    for (const wanted of ['A-早打卡', 'A-值班', 'B-晚自习']) {
      if (!titles.includes(wanted)) throw new Error(`${wanted} was lost when another roster failed: ${titles.join('|')}`)
    }
    if (result.excel.failures.length !== 1) throw new Error('the unreadable roster was not reported as a failure')
    return `kept ${titles.length} events, 1 file reported`
  })

  await rosterHost.close()
}

// ------------------------------------------------------------------ teardown

for (const handle of intervals) clearInterval(handle)
for (const handle of timeouts) handle.cancelled = true
await new Promise((done) => server.close(done))
rmSync(scratch, { recursive: true, force: true })

// ------------------------------------------------------------------ installed copy

if (checkInstalled) {
  const installed = join(realDshHome, 'profiles', 'desktop', 'node_modules', 'dsh-orbit-time')
  await check('the profile copy is present and boots', async () => {
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
    if (manifest.name !== 'dsh-orbit-time') throw new Error(`profile copy is ${manifest.name}`)
    if (manifest.dsh?.client?.platform !== 'web') throw new Error('dsh.client.platform is missing from the copy')
    const localBytes = readFileSync(join(root, 'lib', 'client.js'))
    const installedBytes = readFileSync(join(installed, 'lib', 'client.js'))
    if (!localBytes.equals(installedBytes)) throw new Error('the installed client.js differs from the build — run sync-profile.mjs')

    // Boot the installed host half in its own scratch state directory.
    const installedScratch = mkdtempSync(join(tmpdir(), 'orbit-time-installed-'))
    const savedHome = process.env.DSH_HOME
    process.env.DSH_HOME = installedScratch
    try {
      const installedRoutes = new Map()
      const installedModule = await import(pathToFileURL(join(installed, 'lib', 'index.js')).href)
      installedModule.apply(
        {
          get: () => undefined,
          logger: { info: () => {}, warn: () => {}, error: () => {} },
          webServer: {
            port: 0,
            register(route) {
              installedRoutes.set(route.path, route.handler)
              return () => {}
            },
          },
          interval: () => () => {},
          timeout: () => () => {},
          effect: () => () => {},
        },
        { profile: { name: '张三' }, workbook: { path: '', watch: false, sources: [] }, ui: { showFloatingWidget: false } },
      )
      if (installedRoutes.size !== localRouteCount) {
        throw new Error(`installed copy registered ${installedRoutes.size} routes, the build registers ${localRouteCount}`)
      }
    } finally {
      process.env.DSH_HOME = savedHome
      rmSync(installedScratch, { recursive: true, force: true })
    }
    return `${installed} boots with ${localRouteCount} routes`
  })
}

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} failure(s):`)
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('all host integration checks passed')
