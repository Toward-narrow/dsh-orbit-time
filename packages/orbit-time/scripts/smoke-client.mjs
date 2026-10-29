#!/usr/bin/env node
/**
 * Headless smoke test for the built client bundle.
 *
 * Runs `lib/client.js` against the real React in a stubbed browser shell, then
 * renders the registered components with a representative host snapshot. This
 * catches the mistakes that are otherwise only visible inside a page: a missing
 * module in the wrapper, a typo in a module path, a bad hook call, or a
 * component that throws on real data shapes.
 *
 * Run: node scripts/smoke-client.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const require_ = createRequire(join(root, 'package.json'))

const React = require_('react')
const { renderToStaticMarkup } = require_('react-dom/server')

// ------------------------------------------------------------------ browser stub

const styleTags = []
const documentStub = {
  head: {
    appendChild(node) {
      styleTags.push(node)
    },
  },
  createElement(tag) {
    return { tagName: tag, dataset: {}, textContent: '', style: {}, appendChild() {}, remove() {} }
  },
  querySelector() {
    return null
  },
}

let registration = null
const windowStub = {
  __ModuleLoader__: {
    load(entry) {
      if (registration !== null) throw new Error('bundle registered twice: ' + entry.id)
      registration = entry
    },
  },
  document: documentStub,
  addEventListener() {},
  removeEventListener() {},
}

const failures = []

/**
 * Run one check. Most are synchronous and their value is used directly by the
 * next line, so this stays a normal function that happens to return a promise
 * for an async body: `check('…', async () => …)` can be awaited, and a resolved
 * value is reported like any other. Leaving the promise unresolved printed
 * `[object Promise]` — a log that says nothing and hides whether the body ran.
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
  failures.push(`${label}: ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n      ') : error}`)
  console.log(`  FAIL ${label}: ${error && error.message ? error.message : error}`)
  return undefined
}

// ------------------------------------------------------------------ load bundle

const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
console.log('orbit-time client smoke test')
console.log(`  bundle: ${(Buffer.byteLength(source, 'utf8') / 1024).toFixed(1)} kB`)

class StyleElement {
  constructor() {
    this.dataset = {}
    this.textContent = ''
  }
  remove() {}
}

const realDocument = {
  head: { appendChild: (node) => styleTags.push(node) },
  createElement: () => new StyleElement(),
  querySelector: () => null,
}

/**
 * The bundle captures `fetch` as a sandbox parameter, so the seat is a dispatcher
 * rather than a fixed stub: a check further down swaps in a recording one to
 * assert what the store actually puts on the wire when the calendar pages.
 */
let fetchImpl = () => Promise.reject(new Error('offline in smoke test'))
const dispatchFetch = (...args) => fetchImpl(...args)

const sandbox = {
  window: {
    ...windowStub,
    document: realDocument,
    fetch: dispatchFetch,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    location: { href: 'http://127.0.0.1:19387/' },
    screen: { availWidth: 1920, availHeight: 1040 },
  },
  document: realDocument,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch: dispatchFetch,
  EventSource: undefined,
}

const runner = new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'fetch', 'React', 'require', source)
check('bundle executes and registers', () => {
  runner(
    sandbox.window,
    realDocument,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    sandbox.fetch,
    React,
    (specifier) => {
      if (specifier === 'react') return React
      if (specifier === 'react/jsx-runtime') return require_('react/jsx-runtime')
      throw new Error('unexpected require: ' + specifier)
    },
  )
  if (registration === null) throw new Error('nothing registered')
  return registration.id
})

const factory = registration.factory
const exports_ = check('factory materializes', () => factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error('unexpected require: ' + specifier)
}))

if (exports_ === undefined) {
  console.error('\nsmoke test aborted: bundle did not materialize')
  process.exit(1)
}

check('exports apply + inject', () => {
  if (typeof exports_.apply !== 'function') throw new Error('apply is not a function')
  if (!Array.isArray(exports_.inject)) throw new Error('inject is not an array')
  return exports_.inject.join(', ')
})

/** Styles are inserted lazily on the first apply, so this runs after the seats. */
function checkStylesLater() {
  check('styles were inserted on apply', () => {
    if (styleTags.length === 0) throw new Error('no style tag inserted')
    const css = styleTags.map((tag) => tag.textContent).join('')
    if (!css.includes('.ot-root')) throw new Error('css missing .ot-root')
    return `${(Buffer.byteLength(css, 'utf8') / 1024).toFixed(1)} kB css`
  })
}

// ------------------------------------------------------------------ slot wiring

const registered = []
const ctxStub = {
  effect() {
    return () => {}
  },
  slots: {
    inject(slot, callback) {
      callback()
    },
    register(options, component) {
      registered.push({ slot: options.name, options, component })
      return () => {}
    },
  },
  layout: { selectPanel() {} },
  remote: {},
}

check('apply() registers all three seats', () => {
  exports_.apply(ctxStub)
  const slots = registered.map((entry) => entry.options.name)
  for (const expected of ['main', 'sidebar.panellist', 'shell.overlay']) {
    if (!slots.includes(expected)) throw new Error(`missing slot ${expected} (got ${slots.join(', ')})`)
  }
  const main = registered.find((entry) => entry.options.name === 'main')
  if (main.options.key !== 'orbit-time') throw new Error(`main panel key mismatch: ${main.options.key}`)
  const sidebar = registered.find((entry) => entry.options.name === 'sidebar.panellist')
  if (sidebar.options.id !== 'orbit-time') throw new Error(`sidebar panel id mismatch: ${sidebar.options.id}`)
  return slots.join(', ')
})

checkStylesLater()

// ------------------------------------------------------------------ fixtures

const now = Date.now()
function iso(offsetMinutes) {
  return new Date(now + offsetMinutes * 60_000).toISOString()
}

function event(overrides) {
  return {
    id: 'ev_' + (overrides.id || Math.random().toString(36).slice(2)),
    date: '2026-03-02',
    start: '09:00',
    end: '10:30',
    title: '高等数学 A',
    course: '数学',
    classroom: '三教 305',
    teacher: '李老师',
    location: '',
    category: '课程',
    status: '',
    priority: '',
    notes: '带上上次的作业',
    link: '',
    contact: '',
    owner: '张三',
    matchedBy: '张三',
    weekday: '周一',
    extras: {},
    source: { sheet: 'Sheet1', row: 3 },
    warnings: [],
    effectiveStart: '09:00',
    effectiveEnd: '10:30',
    startMs: now + 12 * 60_000,
    endMs: now + 102 * 60_000,
    phase: 'upcoming',
    done: false,
    snoozedUntil: null,
    minutesUntilStart: 12,
    minutesUntilEnd: 102,
    progress: 0,
    ...overrides,
  }
}

const currentEvent = event({ id: 'now', title: '项目例会', phase: 'current', startMs: now - 20 * 60_000, endMs: now + 25 * 60_000, minutesUntilStart: -20, minutesUntilEnd: 25, progress: 0.44, start: '13:00', end: '14:00' })
const pastEvent = event({ id: 'past', title: '英语听力', phase: 'past', startMs: now - 200 * 60_000, endMs: now - 120 * 60_000, minutesUntilStart: -200, minutesUntilEnd: -120, progress: 1, start: '07:00', end: '08:00' })
const nextEvent = event({ id: 'next', title: '数据结构实验', phase: 'upcoming', minutesUntilStart: 12, startMs: now + 12 * 60_000, endMs: now + 95 * 60_000 })

/**
 * The month payload the calendar draws: a Monday-first grid wide enough for the
 * whole month, matching what the host builds. March 2026 starts on a Sunday, so
 * the grid has to open with the last week of February — the boundary a
 * wrong-offset implementation gets wrong.
 */
function buildMonth() {
  const weekLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const onDay = {
    '2026-03-02': [
      { id: 'now', title: '项目例会', start: '13:00', end: '14:00', place: '三教 305', done: false },
      { id: 'past', title: '英语听力', start: '07:00', end: '08:00', place: '语音室 2', done: true },
    ],
    '2026-03-17': [{ id: 'duty', title: '示例支部晚自习考勤点名', start: '19:30', end: '20:50', place: 'A101', done: false }],
  }
  const grid = []
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(2026, 1, 23 + index)
    const dayKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    const items = onDay[dayKey] || []
    grid.push({
      dayKey,
      label: weekLabels[date.getDay()],
      dayOfMonth: date.getDate(),
      isToday: dayKey === '2026-03-02',
      count: items.filter((item) => !item.done).length,
      hasEvents: items.length > 0,
      firstStart: items.length > 0 ? items[0].start : '',
      titles: items.map((item) => item.title),
      inMonth: dayKey.startsWith('2026-03'),
      monthDay: date.getDate(),
    })
  }
  return {
    monthKey: '2026-03',
    year: 2026,
    month: 3,
    title: '2026 年 3 月',
    prevMonth: '2026-02',
    nextMonth: '2026-04',
    grid,
    dayCount: 2,
    eventCount: 3,
    // The open day's rows travel with the month; the grid carries only counts.
    items: onDay['2026-03-02'],
  }
}

const snapshot = {
  ok: true,
  now: new Date(now).toISOString(),
  serverTime: { iso: new Date(now).toISOString(), dayKey: '2026-03-02', minutes: 690, label: '11:30' },
  settings: {
    profile: { name: '张三', aliases: ['张老师'], timezone: '', locale: 'zh-CN' },
    workbook: { path: 'C:\\Users\\User\\Desktop\\日程.xlsx', sheet: '', headerRow: 0, mapping: {}, watch: true, importHorizonDays: 30, includeUndated: false },
    reminders: { enabled: true, offsetsMinutes: [30, 10, 5, 0], respectQuietHours: true, quietHours: { from: '22:30', to: '07:00' }, snoozeMinutes: [5, 10], osToast: true, sound: true },
    pomodoro: { focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, roundsBeforeLongBreak: 4, autoStartBreak: true, autoStartFocus: false, dailyGoalRounds: 8, tickingSound: false },
    ui: { showFloatingWidget: true, widgetCorner: 'bottom-right', accent: 'aurora', timelineDensity: 'comfortable', celebrateOnFinish: true },
    seedDemoData: false,
  },
  ownerNames: ['张三', '张老师'],
  excel: {
    path: 'C:\\Users\\User\\Desktop\\日程.xlsx',
    sheet: '总课表',
    sheets: ['总课表', 'Sheet2'],
    headerRow: 2,
    mapping: { date: '日期', start: '开始时间', person: '姓名', title: '事项' },
    unmapped: ['备注2'],
    headers: [
      { index: 0, text: '日期', field: 'date' },
      { index: 1, text: '开始时间', field: 'start' },
      { index: 2, text: '结束时间', field: 'end' },
      { index: 3, text: '事项', field: 'title' },
      { index: 4, text: '姓名', field: 'person' },
      { index: 5, text: '地点', field: 'location' },
    ],
    rowCount: 42,
    importedCount: 3,
    matchedCount: 5,
    filteredCount: 37,
    pastCount: 2,
    droppedRows: [],
    warnings: ['姓名来源列：姓名'],
    importedAt: iso(-6),
    mtimeMs: now,
    size: 4096,
    lastError: null,
    lastErrorAt: null,
  },
  day: {
    dayKey: '2026-03-02',
    events: [pastEvent, currentEvent, event({ id: 'a' }), nextEvent],
    stats: {
      dayKey: '2026-03-02',
      label: '周一',
      eventCount: 4,
      totalMinutes: 330,
      doneMinutes: 140,
      remainingMinutes: 190,
      freeSlots: [{ from: '11:45', to: '13:00', minutes: 75 }],
      completedRounds: 3,
      focusGoalRounds: 8,
      focusMinutesToday: 75,
    },
    undated: [event({ id: 'u', date: '', start: '', end: '', phase: 'undated', effectiveStart: '', effectiveEnd: '', startMs: null, endMs: null, minutesUntilStart: null, minutesUntilEnd: null, title: '待定：补交材料' })],
  },
  nextEvent,
  upcoming: [nextEvent, event({ id: 'b' })],
  week: [
    { dayKey: '2026-02-28', label: '周六', dayOfMonth: 28, isToday: false, count: 0, firstStart: '', titles: [] },
    { dayKey: '2026-03-02', label: '周一', dayOfMonth: 2, isToday: true, count: 4, firstStart: '07:00', titles: ['英语听力', '高等数学 A'] },
    { dayKey: '2026-03-03', label: '周二', dayOfMonth: 3, isToday: false, count: 2, firstStart: '09:00', titles: ['线性代数'] },
  ],
  month: buildMonth(),
  timer: {
    phase: 'focus',
    running: true,
    startedAt: now - 8 * 60_000,
    endsAt: now + 17 * 60_000,
    remainingMs: 17 * 60_000,
    round: 2,
    completedToday: 3,
    dayKey: '2026-03-02',
    subject: '复习傅里叶变换',
    history: [],
    config: { focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, roundsBeforeLongBreak: 4, autoStartBreak: true, autoStartFocus: false, dailyGoalRounds: 8, tickingSound: false },
  },
  feed: [
    { seq: 3, at: iso(-3), kind: 'reminder', level: 'urgent', title: '⏰ 5 分钟后开始 · 项目例会', body: '13:00 · 三教 305', eventId: 'now', offsetMinutes: 5, actions: ['snooze', 'done'] },
    { seq: 2, at: iso(-40), kind: 'import', level: 'info', title: '日程已更新', body: '抓取 3 条与你相关的日程' },
  ],
  generatedAt: new Date(now).toISOString(),
}

const storeStub = {
  get() {
    return {
      ready: true,
      loading: false,
      error: null,
      snapshot,
      day: '2026-03-02',
      lastFetchAt: now,
      stale: false,
      importState: {
        status: 'preview',
        message: '识别到工作表「总课表」，表头在第 2 行，共 42 行数据。',
        preview: {
          file: 'C:\\Users\\User\\Desktop\\日程.xlsx',
          sheets: ['总课表', 'Sheet2'],
          sheet: '总课表',
          headerRow: 2,
          rowCount: 42,
          headers: snapshot.excel.headers,
          mapping: snapshot.excel.mapping,
          unmapped: ['备注2'],
          warnings: ['姓名来源列：姓名'],
          ownerNames: ['张三'],
          matchedInPreview: 1,
          sample: [
            { row: 3, date: '2026-03-02', start: '09:00', end: '10:30', title: '高等数学 A', person: '张三', location: '三教 305', match: true, warnings: [], extras: {} },
            { row: 4, date: '2026-03-02', start: '14:00', end: '15:30', title: '大学物理', person: '李四', location: '二教 101', match: false, warnings: ['日期沿用上一行'], extras: { 备注2: 'x' } },
          ],
        },
        error: null,
      },
      notices: [
        { id: 'n1', level: 'urgent', title: '⏰ 5 分钟后开始 · 项目例会', body: '13:00 · 三教 305', eventId: 'now' },
        { id: 'n2', level: 'info', title: '日程已更新', body: '抓取 3 条' },
      ],
      floatOpen: false,
      companion: {
        messages: [
          { id: 'welcome', role: 'ai', speak: '我是 Orbyt。', detail: '我可以帮你抓日程、提醒、跑番茄。', chips: ['生成今日简报', '分析我的空档'] },
          { id: 'u1', role: 'user', text: '今天最该先做什么？' },
          { id: 'a1', role: 'ai', speak: '先做数据结构实验。', detail: '12 分钟后开始，建议先收尾手头的事。', chips: ['准备下一个日程'] },
          { id: 'b', role: 'ai', speak: '正在读你的日程…' },
        ],
        busy: true,
      },
    }
  },
  subscribe() {
    return () => {}
  },
  set() {},
  request() {
    return Promise.resolve({ ok: true, running: false })
  },
  refresh() {
    return Promise.resolve(snapshot)
  },
  setDay() {
    return Promise.resolve(snapshot)
  },
  saveSettings() {
    return Promise.resolve(snapshot.settings)
  },
  previewWorkbook() {
    return Promise.resolve({})
  },
  runImport() {
    return Promise.resolve({ importedCount: 3, filteredCount: 37 })
  },
  eventAction() {
    return Promise.resolve({})
  },
  timerAction() {
    return Promise.resolve({})
  },
  askCompanion() {
    return Promise.resolve({})
  },
  pushNotice() {},
  dismissNotice() {},
  clearFeed() {
    return Promise.resolve()
  },
  openFloatWindow() {
    return Promise.resolve({ ok: true, running: true })
  },
  stopFloatWindow() {
    return Promise.resolve({ ok: true })
  },
  hudStatus() {
    return Promise.resolve({ ok: true, running: false })
  },
  bootstrap() {},
  shutdown() {},
  currentTimer() {
    return {
      phase: 'focus',
      running: true,
      remainingMs: 17 * 60_000,
      totalMs: 25 * 60_000,
      progress: 0.32,
      round: 2,
      completedToday: 3,
      subject: '复习傅里叶变换',
      config: snapshot.timer.config,
    }
  },
  ACTION_LABELS: { brief: '生成今日简报' },
}

// ------------------------------------------------------------------ render

function render(label, element) {
  check(`render ${label}`, () => {
    const html = renderToStaticMarkup(element)
    if (typeof html !== 'string' || html.length === 0) throw new Error('empty markup')
    return `${html.length} chars`
  })
}

const h = React.createElement

// Public exports are per-module namespaces; the dashboard components live on the
// index namespace of the authoring graph.
const app = exports_['./index.js'] || exports_
const realStore = exports_['./store.js'].store
check('index namespace exposes components', () => {
  for (const name of ['Dashboard', 'Notices', 'FloatingWidget', 'SettingsView', 'OrbitGlyph']) {
    if (typeof app[name] !== 'function') throw new Error(`${name} is ${typeof app[name]}`)
  }
  return 'Dashboard, Notices, FloatingWidget, SettingsView, OrbitGlyph'
})

// Drive the REAL store rather than a stub: seeding it exercises the same
// subscription path the page uses, so an idle-looking render cannot pass.
realStore.set({
  snapshot,
  day: snapshot.day.dayKey,
  // The fixture is dated 2026-03 while the smoke test runs whenever it runs, so
  // the calendar's month has to be seeded the way a real fetch would seed it.
  month: snapshot.day.dayKey.slice(0, 7),
  ready: true,
  loading: false,
  error: null,
  importState: {
    status: 'preview',
    message: '识别到工作表「总课表」，表头在第 2 行，共 42 行数据。',
    preview: {
      file: snapshot.excel.path,
      sheets: snapshot.excel.sheets,
      sheet: snapshot.excel.sheet,
      headerRow: snapshot.excel.headerRow,
      rowCount: snapshot.excel.rowCount,
      headers: snapshot.excel.headers,
      mapping: snapshot.excel.mapping,
      unmapped: ['备注2'],
      warnings: ['姓名来源列：姓名'],
      ownerNames: ['张三'],
      matchedInPreview: 1,
      sample: [
        { row: 3, date: '2026-03-02', start: '09:00', end: '10:30', title: '高等数学 A', person: '张三', location: '三教 305', match: true, warnings: [], extras: {} },
        { row: 4, date: '2026-03-02', start: '14:00', end: '15:30', title: '大学物理', person: '李四', location: '二教 101', match: false, warnings: ['日期沿用上一行'], extras: { 备注2: 'x' } },
      ],
    },
    error: null,
  },
  notices: [
    { id: 'n1', level: 'urgent', title: '⏰ 5 分钟后开始 · 项目例会', body: '13:00 · 三教 305', eventId: 'now' },
    { id: 'n2', level: 'info', title: '日程已更新', body: '抓取 3 条' },
  ],
  companion: {
    messages: [
      { id: 'welcome', role: 'ai', greeting: true, speak: '我是 Orbyt。', detail: '我可以帮你抓日程、提醒、跑番茄。', chips: ['生成今日简报', '分析我的空档'] },
      { id: 'u1', role: 'user', text: '今天最该先做什么？' },
      { id: 'a1', role: 'ai', speak: '先做数据结构实验。', detail: '12 分钟后开始。', chips: ['准备下一个日程'], mode: 'model', fallback: null },
      { id: 'a2', role: 'ai', speak: '模型这会儿不可用，我先按规则说。', mode: 'local', fallback: { reason: 'model-error', detail: 'rate limited' } },
    ],
    busy: false,
  },
  assistant: { mode: 'model', reason: 'ready', detail: 'deepseek-account · deepseek-flash' },
})

render('Dashboard', h(app.Dashboard))
render('Notices', h(app.Notices))
render('FloatingWidget', h(app.FloatingWidget))
render('SettingsView', h(app.SettingsView, { store: realStore, snapshot }))
render('OrbitGlyph', h(app.OrbitGlyph, { size: 18 }))

// The confirmation step lives in the panel, not in a corner toast. This pins the
// shape of it: a sticky bar with the file name, what will be imported, what will
// be skipped, and one primary action — and no "AI 已读完…" toast on the side.
check('the import confirmation is an in-panel bar with the real import counts', () => {
  const utils = exports_['./util.js']
  const saved = utils.safeArray(realStore.get().notices)
  realStore.set({
    notices: [],
    importState: {
      status: 'ready',
      message: '这份表是值班网格表。',
      error: null,
      modelNote: '',
      preview: {
        file: 'C:\\Users\\x\\Desktop\\示例支部晚自习排班表.xlsx',
        sheet: 'Sheet1',
        headerRow: 1,
        rowCount: 120,
        headers: [],
        mapping: {},
        unmapped: [],
        warnings: [],
        plan: { rows: 120, matched: 7, importable: 4, past: 2, beyondHorizon: 1, undated: 0, firstDate: '2026-11-04', lastDate: '2026-12-16', horizonDays: 60, ownerNames: ['张三'] },
      },
      analysis: { mode: 'local', confidence: 0.78, summary: '网格表', hints: [], timeRules: [{ match: ['晚自习'], start: '19:30', end: '20:50' }], mapping: {}, missing: [] },
    },
  })
  const html = renderToStaticMarkup(h(app.SettingsView, { store: realStore, snapshot }))
  const needed = ['ot-confirm', '确认并导入', '将导入 4 条', '2026-11-04', '不导入：2 条在今天之前、1 条超过 60 天', '看看读表细节']
  for (const needle of needed) {
    if (!html.includes(needle)) throw new Error(`the confirmation bar is missing ${needle}`)
  }
  if (html.includes('AI 已读完')) throw new Error('the old toast copy is still in the panel')
  // Restore the seeded state for the checks that follow.
  realStore.set({ notices: saved })
  const noticeHtml = renderToStaticMarkup(h(app.Notices))
  if (!noticeHtml.includes('ot-notice-stack')) throw new Error('the notice stack has no inner container, so it cannot be clamped into the overlay')
  return 'sticky confirm bar, plan counts, no toast'
})

// The other half of the import page: a document or a picture is read into event
// drafts, not into a column mapping. The bar has to say what will be added, the
// rows have to be editable, and an unticked row must stay out of the count.
check('a reading shows its proposed events, editable, before anything is written', () => {
  realStore.set({
    importState: { status: 'idle', message: '', preview: null, analysis: null, error: null, modelNote: '' },
    extractState: {
      status: 'ready',
      message: '一份值班通知。',
      source: { kind: 'docx', type: 'Word 文档', file: '示例值班通知.docx', path: 'C:\\Users\\x\\Desktop\\示例值班通知.docx', chars: 120, pages: 0, imageCount: 0, notes: ['文档里有 1 张表格'] },
      analysis: {
        mode: 'model',
        model: { provider: 'deepseek-account', model: 'deepseek-flash' },
        events: [
          { date: '2026-11-04', start: '07:00', end: '07:30', title: '早打卡值班', location: '东区门口', notes: '带上签到表', confidence: 0.86 },
          { date: '2026-11-04', start: '19:30', end: '20:50', title: '晚自习考勤点名', location: '', notes: '', confidence: 0.6 },
        ],
        excluded: [{ title: '李四交材料', reason: '是 李四 的事，不是你的' }],
        summary: '读了两次值班，其中一条是别人的。',
        hints: ['早打卡在门口签到'],
        confidence: 0.72,
        modelNote: 'AI 读的',
      },
      plan: { rows: 1, matched: 1, importable: 1, past: 0, beyondHorizon: 0, undated: 0, firstDate: '2026-11-04', lastDate: '2026-11-04', horizonDays: 60, ownerNames: ['张三'] },
      draft: [
        { key: 'x0', date: '2026-11-04', start: '07:00', end: '07:30', title: '早打卡值班', location: '东区门口', notes: '带上签到表', confidence: 0.86, include: true },
        { key: 'x1', date: '2026-11-04', start: '19:30', end: '20:50', title: '晚自习考勤点名', location: '', notes: '', confidence: 0.6, include: false },
      ],
      error: null,
    },
  })
  const html = renderToStaticMarkup(h(app.SettingsView, { store: realStore, snapshot }))
  const needed = [
    'ot-confirm',
    '读完了「示例值班通知.docx」',
    '加入日程（1 条）',
    'AI 读出来的日程',
    'ot-extract-row',
    '早打卡值班',
    '晚自习考勤点名',
    '全不选',
    '不属于你',
  ]
  for (const needle of needed) {
    if (!html.includes(needle)) throw new Error(`the reading view is missing ${needle}`)
  }
  if (html.includes('加入日程（2 条）')) throw new Error('an unticked row was counted')
  // The file picker must offer the new formats, or the feature is unreachable
  // from the one control people actually click.
  for (const extension of ['.pdf', '.docx', '.png']) {
    if (!html.includes(extension)) throw new Error(`the picker does not accept ${extension}`)
  }
  realStore.set({ extractState: { status: 'idle', message: '', source: null, analysis: null, plan: null, draft: [], error: null } })
  return 'reading bar, editable rows, unticked rows excluded'
})

// A page refresh updates this bundle but not the host module, and the symptom —
// "importing a second roster still drops the first" — looks exactly like a fix
// that did nothing. The panel has to say which half is stale.
check('an older host half is called out instead of silently misbehaving', () => {
  realStore.set({ hostStale: true })
  const stale = renderToStaticMarkup(h(app.SettingsView, { store: realStore, snapshot }))
  if (!stale.includes('宿主半还是旧版本')) throw new Error('the stale-host banner is missing')
  if (!stale.includes('托盘退出')) throw new Error('the banner does not say how to fix it')
  realStore.set({ hostStale: false })
  const fresh = renderToStaticMarkup(h(app.SettingsView, { store: realStore, snapshot }))
  if (fresh.includes('宿主半还是旧版本')) throw new Error('the banner is shown on a matching host')
  return 'warns on a stale host, quiet otherwise'
})

check('Dashboard renders live data, not the loading state', () => {
  const html = renderToStaticMarkup(h(app.Dashboard))
  for (const needle of ['高等数学', 'ot-stat', 'ot-daychip', '数据结构实验']) {
    if (!html.includes(needle)) throw new Error(`dashboard markup is missing ${needle}`)
  }
  if (html.includes('正在连接 Orbit Time')) throw new Error('dashboard is stuck in its loading state')
  return `${html.length} chars`
})

check('the timeline offers the month calendar, and it is closed by default', () => {
  const html = renderToStaticMarkup(
    h(exports_['./timeline.js'].TimelineView, {
      store: realStore,
      snapshot,
      day: snapshot.day.dayKey,
      events: snapshot.day.events,
      stats: snapshot.day.stats,
      undated: snapshot.day.undated,
      now,
      onFocus: () => {},
      onReimport: () => {},
    }),
  )
  if (!html.includes('日历')) throw new Error('the day bar has no calendar toggle')
  // Closed on mount: the strip is the default view, and a month grid that opens
  // itself would push the day's schedule off the first screen.
  if (html.includes('ot-cal-grid')) throw new Error('the calendar rendered without being opened')
  return `${html.length} chars`
})

check('the month calendar marks days that have schedules, and lists the picked day', () => {
  const html = renderToStaticMarkup(
    h(exports_['./calendar.js'].CalendarView, {
      snapshot,
      day: snapshot.day.dayKey,
      onPickDay: () => {},
      onMonth: () => {},
      onClose: () => {},
    }),
  )
  for (const needle of [
    '2026 年 3 月',
    'ot-cal-grid',
    'ot-cal-cell',
    'data-marked="true"',
    '示例支部晚自习考勤点名',
    '2 天有日程 · 共 3 条',
  ]) {
    if (!html.includes(needle)) throw new Error(`calendar markup is missing ${needle}`)
  }
  // 42 cells in a Monday-first grid; March 2026 opens on a Sunday, so the first
  // row belongs to February. A wrong offset shows up here as a missing 23.
  const cells = html.split('ot-cal-cell').length - 1
  if (cells !== 42) throw new Error(`the grid has ${cells} cells, expected 42`)
  if (html.indexOf('>23<') === -1) throw new Error('the leading week of the previous month is missing')
  if (!html.includes('data-outside="true"')) throw new Error('days outside the month are not marked as such')

  // The cells' own labels have to advance one day at a time from the first one.
  // Everything else about a calendar can look right while the day each schedule
  // is filed under is off by a fortnight.
  const labels = html.match(/title="(\d+) 月 (\d+) 日 (周.)/g) || []
  if (labels.length !== 42) throw new Error(`only ${labels.length} cells carry a date label`)
  let previous = null
  for (const label of labels) {
    const [, month, day, weekday] = /title="(\d+) 月 (\d+) 日 (周.)/.exec(label)
    const date = new Date(2026, Number(month) - 1, Number(day))
    if (previous !== null && date.getTime() - previous.getTime() !== 86_400_000) {
      throw new Error(`the grid jumps from ${previous.toDateString()} to ${date.toDateString()}`)
    }
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    if (weekdays[date.getDay()] !== weekday) {
      throw new Error(`${date.toDateString()} is labelled ${weekday}, should be ${weekdays[date.getDay()]}`)
    }
    previous = date
  }
  const first = new Date(2026, 1, 23)
  if (previous === null || previous.getTime() - first.getTime() !== 41 * 86_400_000) {
    throw new Error('the grid does not end 41 days after 2026-02-23')
  }
  return `${html.length} chars, ${cells} cells, 2026-02-23 → 2026-04-05`
})

check('a day whose only schedule is finished still reads as a day, not as an empty one', () => {
  // The grid and the summary have to agree: a day whose only item was ticked off
  // still draws a marker, so a summary reading "共 0 条" over it must say why.
  const month = buildMonth()
  const dayKey = '2026-03-05'
  const cell = month.grid.find((entry) => entry.dayKey === dayKey)
  if (cell === undefined) throw new Error(`${dayKey} is not in the fixture grid`)
  cell.count = 0
  cell.titles = ['补交材料']
  cell.hasEvents = true
  // The whole month is finished, which is the state the summary has to explain
  // rather than flatten into "这个月没有日程".
  month.eventCount = 0
  month.dayCount = month.grid.filter((entry) => entry.inMonth && entry.hasEvents === true).length
  month.items = [{ id: 'done-only', title: '补交材料', start: '10:00', end: '10:30', place: '', done: true }]
  const html = renderToStaticMarkup(
    h(exports_['./calendar.js'].CalendarView, {
      snapshot: Object.assign({}, snapshot, { month }),
      day: dayKey,
      onPickDay: () => {},
      onMonth: () => {},
      onClose: () => {},
    }),
  )
  if (!/data-marked="true"/.test(html)) throw new Error('the finished-only day is not marked on the grid')
  if (!html.includes('其余已完成')) {
    throw new Error('the summary claims nothing is on over a dotted day: ' + html.slice(html.indexOf('ot-cal-summary'), html.indexOf('ot-cal-summary') + 300))
  }
  if (!html.includes('已完成 1 条')) throw new Error('the day list does not admit the item is still there')
  if (!/data-done="true"/.test(html)) throw new Error('the finished item is not flagged as done')
  return '1 marked day, 0 outstanding, 1 finished'
})

check('the calendar pages months through the store, not the open day', () => {
  if (typeof realStore.setMonth !== 'function') throw new Error('store.setMonth is missing')
  // The smoke fixture is dated 2026-03; the store's own month default is
  // whatever today is, so assert the relationship rather than a literal.
  const expected = snapshot.day.dayKey.slice(0, 7)
  if (realStore.get().month !== expected) throw new Error(`store month is ${realStore.get().month}, expected ${expected}`)
  realStore.set({ month: '2026-04' })
  if (realStore.get().month !== '2026-04') throw new Error('set() did not carry the month')
  if (realStore.get().day !== snapshot.day.dayKey) throw new Error('paging months moved the open day')
  realStore.set({ month: expected })
  if (realStore.get().month !== expected) throw new Error('the month could not be put back')
  return 'month is independent state'
})

// The grid is only as good as the request that fills it: the month the user is
// browsing has to be on the wire, not inferred by the host from the open day.
const calendarRequests = []
fetchImpl = (url) => {
  calendarRequests.push(String(url))
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(snapshot)) })
}
await check('the calendar puts the month it is browsing on the wire', async () => {
  realStore.set({ month: snapshot.day.dayKey.slice(0, 7) })
  await realStore.setMonth('2026-04')
  if (!calendarRequests.some((url) => url.includes('month=2026-04'))) {
    throw new Error(`setMonth sent ${JSON.stringify(calendarRequests)}`)
  }
  if (!calendarRequests.some((url) => url.includes('month=2026-04') && url.includes('day=' + snapshot.day.dayKey))) {
    throw new Error('paging months dropped the open day from the request')
  }
  await realStore.setDay('2026-04-17')
  const last = calendarRequests[calendarRequests.length - 1]
  if (!last.includes('day=2026-04-17') || !last.includes('month=2026-04')) {
    throw new Error(`picking a date sent ${last}`)
  }
  await realStore.setDay(snapshot.day.dayKey)
  return `${calendarRequests.length} requests, day and month together`
})

check('the add-event form renders, and adding one sends the date it was opened on', async () => {
  const formModule = exports_['./manual.js']
  // `now` is the panel's millisecond clock, exactly as the timeline passes it.
  // Handing the form a Date here once hid a crash: `now.getHours is not a
  // function` threw inside its first render and took the whole page blank, since
  // a render error has no boundary to land in. The value has to match the app's,
  // not be convenient for the test.
  const openAt = new Date(2026, 2, 17, 14, 37).getTime()
  const html = renderToStaticMarkup(
    h(formModule.ManualEventForm, {
      store: realStore,
      day: '2026-03-17',
      now: openAt,
      onCancel: () => {},
      onSaved: () => {},
    }),
  )
  for (const needle of ['ot-add-grid', '要做什么', '加进日程', 'type="date"', 'type="time"']) {
    if (!html.includes(needle)) throw new Error(`the form is missing ${needle}`)
  }
  // The date field defaults to the day the form was opened on, and the time to
  // the next full hour — a blank form should already be usable.
  if (!html.includes('value="2026-03-17"')) throw new Error('the date field does not default to the open day')
  if (!html.includes('value="15:00"')) throw new Error(`the start time is not the next full hour: ${html.match(/type="time" value="[^"]*"/g)}`)

  // The same timeline the user clicks in, so a crash inside the form's first
  // render is caught by the check that claims to cover the form.
  const timelineHtml = renderToStaticMarkup(
    h(exports_['./timeline.js'].TimelineView, {
      store: realStore,
      snapshot,
      day: snapshot.day.dayKey,
      events: snapshot.day.events,
      stats: snapshot.day.stats,
      undated: snapshot.day.undated,
      now: Date.now(),
      onFocus: () => {},
      onReimport: () => {},
    }),
  )
  if (!timelineHtml.includes('ot-daybar')) throw new Error('the timeline did not render')
  if (!timelineHtml.includes('加一条')) throw new Error('the timeline offers no way to add an event')

  const sent = []
  fetchImpl = (url, init) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')))
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(snapshot)) })
  }
  const day = await realStore.addEvent({ date: '2026-03-19', start: '08:00', end: '09:00', title: '交实验报告', manual: true })
  const body = sent.find((entry) => entry.action === 'add')
  if (body === undefined) throw new Error(`no add request was sent: ${JSON.stringify(sent)}`)
  if (body.event.date !== '2026-03-19' || body.event.title !== '交实验报告') {
    throw new Error(`the add request carried ${JSON.stringify(body.event)}`)
  }
  if (body.event.manual !== true) throw new Error('the row was not marked as hand-added')
  if (day !== '2026-03-19') throw new Error(`adding for the 19th left the panel on ${day}`)
  await realStore.setDay(snapshot.day.dayKey)
  return 'fields, defaults, request shape, and the day it opens'
})

check('companion view renders the transcript', () => {
  const html = renderToStaticMarkup(
    h(exports_['./companion.js'].CompanionView, {
      store: realStore,
      companion: realStore.get().companion,
      assistant: realStore.get().assistant,
      snapshot,
      settings: snapshot.settings,
      ownerNames: snapshot.ownerNames,
    }),
  )
  for (const needle of ['Orbyt', '生成今日简报', '先做数据结构实验']) {
    if (!html.includes(needle)) throw new Error(`companion markup is missing ${needle}`)
  }
  return `${html.length} chars`
})

check('the companion shows which brain answered each reply', () => {
  const html = renderToStaticMarkup(
    h(exports_['./companion.js'].CompanionView, {
      store: realStore,
      companion: realStore.get().companion,
      assistant: realStore.get().assistant,
      snapshot,
      settings: snapshot.settings,
      ownerNames: snapshot.ownerNames,
    }),
  )
  for (const needle of ['模型在线', 'deepseek-account · deepseek-flash', '内置规则回答', '模型返回错误']) {
    if (!html.includes(needle)) throw new Error(`companion markup is missing ${needle}`)
  }
  return 'mode chip + per-reply trace'
})

check('conversation history mirrors the transcript, minus the greeting', () => {
  const history = realStore.conversationHistory()
  // The client is a faithful mirror; enforcing turn alternation is the host's
  // job (see test-host's history-shaping check). This fixture ends with two
  // assistant turns precisely so the split of responsibilities is visible.
  if (history.length !== 3) throw new Error(`history has ${history.length} turns: ${JSON.stringify(history)}`)
  if (history[0].role !== 'user') throw new Error(`first turn is ${history[0].role}`)
  for (const turn of history) {
    if (typeof turn.text !== 'string' || turn.text.trim() === '') throw new Error(`empty turn: ${JSON.stringify(turn)}`)
  }
  if (JSON.stringify(history).includes('日程副驾') || JSON.stringify(history).includes('我是 Orbyt')) {
    throw new Error('the greeting was sent back as a model turn')
  }
  return history.map((turn) => `${turn.role}:${turn.text.slice(0, 8)}`).join(' -> ')
})

check('pomodoro view renders the ring and controls', () => {  const html = renderToStaticMarkup(
    h(exports_['./pomodoro.js'].PomodoroView, {
      store: realStore,
      timer: realStore.currentTimer(Date.now()),
      settings: snapshot.settings,
      now: Date.now(),
      nextTitle: snapshot.nextEvent.title,
      nextRelative: '12 分钟后',
    }),
  )
  for (const needle of ['ot-ring-arc', '复习傅里叶变换', '番茄钟设置']) {
    if (!html.includes(needle)) throw new Error(`pomodoro markup is missing ${needle}`)
  }
  return `${html.length} chars`
})

check('a render failure shows a card instead of taking the page down', () => {
  // The failure this pins down: `now.getHours()` on a number threw inside the
  // add form's first render, React unmounted the whole tree, and the user was
  // left with a blank window and no way back. The panel registers through this
  // boundary, so a render error has to end up on screen.
  const Catch = app.Catch
  if (typeof Catch !== 'function') throw new Error(`Catch is ${typeof Catch}`)
  const instance = new Catch({ children: null })
  instance.state = { error: new TypeError('date.getHours is not a function') }
  const html = renderToStaticMarkup(instance.render())
  for (const needle of ['ot-crash-card', 'date.getHours is not a function', '重新加载页面']) {
    if (!html.includes(needle)) throw new Error(`the crash card is missing ${needle}`)
  }
  // And the guarded component it wraps has to still render normally.
  const main = registered.filter((entry) => entry.options && entry.options.name === 'main').pop()
  const markup = renderToStaticMarkup(h(main.component))
  if (markup.includes('ot-crash-card')) throw new Error('the guarded panel rendered its crash card for no reason')
  return 'crash card on failure, panel untouched otherwise'
})

// The seats are registered with live component references; render each one the
// way its owner would, so a broken registration fails here rather than in a page.
for (const entry of registered) {
  if (!entry.options || typeof entry.options !== 'object') continue
  const label = String(entry.options.name) + (entry.options.key ? '#' + entry.options.key : '') + (entry.options.id ? '@' + entry.options.id : '')
  if (typeof entry.component === 'function') {
    render(`slot ${label}`, h(entry.component, { size: 16, active: false }))
  }
}

check('overlay component renders notices + widget', () => {
  const overlay = registered.find((entry) => entry.options && entry.options.name === 'shell.overlay')
  if (overlay === undefined) throw new Error('shell.overlay not registered')
  if (typeof overlay.component !== 'function') throw new Error('shell.overlay has no component')
  const html = renderToStaticMarkup(h(overlay.component))
  for (const needle of ['ot-notice', '5 分钟后开始']) {
    if (!html.includes(needle)) throw new Error(`overlay markup is missing ${needle}`)
  }
  return `${html.length} chars`
})

check('apply() is idempotent across reloads', () => {
  const before = registered.length
  exports_.apply(ctxStub)
  if (registered.length <= before) throw new Error('second apply registered nothing')
  const main = registered.filter((entry) => entry.options && entry.options.name === 'main').pop()
  if (typeof main.component !== 'function') throw new Error('second apply produced no component')
  const html = renderToStaticMarkup(h(main.component))
  if (!html.includes('高等数学')) throw new Error('re-materialized dashboard lost its data')
  return 're-materialized graph renders'
})

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} failure(s):`)
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('all smoke checks passed')
