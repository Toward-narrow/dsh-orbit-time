#!/usr/bin/env node
/**
 * Render the dashboard to a static HTML preview and (optionally) a PNG.
 *
 * This is the closest thing to looking at the real panel without restarting the
 * app: the built client bundle is materialized with the real React, the
 * Dashboard component is rendered to markup with a representative host snapshot,
 * and the plugin's own stylesheet is inlined around it. Theme tokens are seeded
 * to the harness's dark-theme values so colours resolve the way they will in the
 * app.
 *
 * Usage:
 *   node scripts/preview-panel.mjs              write preview/panel.html
 *   node scripts/preview-panel.mjs --png        also rasterize with Edge/Chrome
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const require_ = createRequire(join(root, 'package.json'))
const React = require_('react')
const { renderToStaticMarkup } = require_('react-dom/server')

const wantPng = process.argv.includes('--png')
const outDir = join(root, 'preview')
mkdirSync(outDir, { recursive: true })

// ------------------------------------------------------------------ load bundle

const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const styles = readFileSync(join(root, 'src', 'client', 'styles.css'), 'utf8')

let registration = null
const styleTags = []
const documentStub = {
  head: { appendChild: (node) => styleTags.push(node) },
  createElement: () => ({ dataset: {}, style: {}, textContent: '', remove() {} }),
  querySelector: () => null,
}

new Function(
  'window',
  'document',
  'console',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'fetch',
  'React',
  'require',
  source,
)(
  { __ModuleLoader__: { load: (entry) => { registration = entry } }, addEventListener() {}, removeEventListener() {} },
  documentStub,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  () => Promise.reject(new Error('offline')),
  React,
  (specifier) => {
    if (specifier === 'react') return React
    throw new Error('unexpected require: ' + specifier)
  },
)

const exports_ = registration.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error('unexpected require: ' + specifier)
})
const app = exports_['./index.js']
const store = exports_['./store.js'].store

// ------------------------------------------------------------------ fixture

const now = Date.now()
const iso = (minutes) => new Date(now + minutes * 60_000).toISOString()
const pad = (value) => String(value).padStart(2, '0')

/**
 * One clock for the whole fixture: `nowMinute`, rounded down to the minute.
 *
 * Milliseconds otherwise survive the round trip and print `07:59` for a fixture
 * written as 08:00, so the screenshot quietly disagrees with the code that
 * produced it. Everything downstream — event instants, day keys, the calendar
 * grid — derives from this one instant and from the pure `dayKey(offsetDays)`
 * helper; a second source of "today" is how this fixture previously drifted onto
 * the wrong day.
 */
const nowMinute = new Date(now)
nowMinute.setSeconds(0, 0)
const base = nowMinute.getTime()
const clock = (offsetMinutes) => {
  const date = new Date(base + offsetMinutes * 60_000)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}
const dayKey = (offsetDays) => {
  const date = new Date(base + offsetDays * 86_400_000)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** An instant on the current local day, as an offset from the fixture's clock. */
function atToday(hour, minute) {
  return Math.round((new Date(base).setHours(hour, minute || 0, 0, 0) - base) / 60_000)
}

function makeEvent(spec) {
  const startMs = spec.startOffsetMinutes === null ? null : base + spec.startOffsetMinutes * 60_000
  const endMs = startMs === null ? null : startMs + (spec.minutes || 60) * 60_000
  const phase = spec.phase || (startMs === null ? 'undated' : endMs <= base ? 'past' : startMs <= base ? 'current' : 'upcoming')
  return {
    id: 'ev_' + spec.title.replace(/\W/g, ''),
    date: spec.date,
    start: startMs === null ? '' : clock(spec.startOffsetMinutes),
    end: endMs === null ? '' : clock(spec.startOffsetMinutes + (spec.minutes || 60)),
    title: spec.title,
    course: spec.course || '',
    classroom: spec.classroom || '',
    teacher: spec.teacher || '',
    location: spec.location || '',
    category: spec.category || '',
    status: '',
    priority: '',
    notes: spec.notes || '',
    link: '',
    contact: '',
    owner: '张三',
    matchedBy: '张三',
    weekday: spec.weekday || '',
    extras: {},
    source: { sheet: '总课表', row: spec.row || 4 },
    warnings: spec.warnings || [],
    effectiveStart: startMs === null ? '' : clock(spec.startOffsetMinutes),
    effectiveEnd: endMs === null ? '' : clock(spec.startOffsetMinutes + (spec.minutes || 60)),
    startMs,
    endMs,
    phase,
    done: false,
    snoozedUntil: null,
    minutesUntilStart: startMs === null ? null : Math.round((startMs - nowMinute.getTime()) / 60_000),
    minutesUntilEnd: endMs === null ? null : Math.round((endMs - nowMinute.getTime()) / 60_000),
    progress: startMs !== null && endMs !== null && endMs > startMs ? Math.min(1, Math.max(0, (nowMinute.getTime() - startMs) / (endMs - startMs))) : 0,
  }
}

const events = [
  makeEvent({ title: '英语听力', date: dayKey(0), startOffsetMinutes: atToday(8, 0), minutes: 45, teacher: '王老师', classroom: '语音室 2', row: 4 }),
  makeEvent({ title: '高等数学 A', date: dayKey(0), startOffsetMinutes: atToday(10, 0), minutes: 90, course: '数学', classroom: '三教 305', teacher: '李老师', notes: '带上上次作业，这次讲傅里叶级数', row: 5 }),
  makeEvent({ title: '项目周会', date: dayKey(0), startOffsetMinutes: atToday(19, 30), minutes: 60, location: '线上腾讯会议', category: '会议', notes: '同步本周进度与风险', phase: 'current', row: 6 }),
  makeEvent({ title: '数据结构实验', date: dayKey(0), startOffsetMinutes: atToday(21, 0), minutes: 110, course: '计算机', classroom: '实验楼 B210', teacher: '陈老师', notes: '提前装好环境', row: 7 }),
  makeEvent({ title: '1:1 沟通', date: dayKey(0), startOffsetMinutes: atToday(23, 0), minutes: 30, location: '会议室 A', category: '沟通', row: 8 }),
  makeEvent({ title: '教研活动', date: dayKey(1), startOffsetMinutes: atToday(9, 0) + 1440, minutes: 90, location: '阶梯教室', category: '教研', warnings: ['日期沿用上一行'], row: 9 }),
  makeEvent({ title: '客户拜访', date: dayKey(1), startOffsetMinutes: atToday(15, 0) + 1440, minutes: 60, location: '客户现场', category: '外勤', row: 10 }),
]

/**
 * Schedules further out than the fan of events above, so the calendar preview
 * shows what it exists for: a roster landing on scattered days across a month,
 * not just "today is busy".
 */
events.push(
  makeEvent({ title: '示例支部早打卡值班', date: dayKey(6), startOffsetMinutes: atToday(7, 0) + 6 * 1440, minutes: 30, category: '值班', notes: '查验示例支部早打卡，按表签到。', row: 14 }),
  makeEvent({ title: '示例支部晚自习考勤点名', date: dayKey(9), startOffsetMinutes: atToday(19, 30) + 9 * 1440, minutes: 80, classroom: 'A101', category: '值班', row: 15 }),
  makeEvent({ title: '示例支部早打卡值班', date: dayKey(13), startOffsetMinutes: atToday(7, 0) + 13 * 1440, minutes: 30, category: '值班', row: 16 }),
  makeEvent({ title: '示例支部晚自习考勤点名', date: dayKey(20), startOffsetMinutes: atToday(19, 30) + 20 * 1440, minutes: 80, classroom: 'A102', category: '值班', row: 17 }),
)

function byTitle(title) {
  return events.find((event) => event.title === title)
}

/**
 * One event the user typed in themselves, so the preview shows the "自己加的"
 * marker and the calendar's own list rather than only imported rows.
 */
const manualEvent = makeEvent({
  title: '交实验报告',
  date: dayKey(0),
  startOffsetMinutes: atToday(17, 0),
  minutes: 30,
  location: '实验楼 B210',
  row: 18,
})
manualEvent.source = { sheet: '手动添加', row: null }
events.push(manualEvent)

// The in-flight event is named rather than picked by index: which row is "now"
// depends on the hour the preview is rendered at, and the panel's whole
// in-flight treatment is only visible when one event really is in flight.
const currentEvent = events[2]
const nextEvent = byTitle('数据结构实验')
const dutyEvent = byTitle('示例支部晚自习考勤点名')
const totalMinutes = events.reduce((sum, event) => sum + (event.endMs - event.startMs) / 60_000, 0)
const doneMinutes = events
  .filter((event) => event.startMs !== null && event.startMs < nowMinute.getTime())
  .reduce((sum, event) => sum + Math.min(nowMinute.getTime(), event.endMs) - event.startMs, 0) / 60_000

const snapshot = {
  ok: true,
  now: nowMinute.toISOString(),
  serverTime: { iso: nowMinute.toISOString(), dayKey: dayKey(0), minutes: 0, label: clock(0) },
  settings: {
    profile: { name: '张三', aliases: ['张老师'], timezone: '', locale: 'zh-CN' },
    workbook: { path: 'C:\\Users\\User\\Desktop\\2026春季学期值班与课程安排表.xlsx', sheet: '', headerRow: 0, mapping: {}, watch: true, importHorizonDays: 30, includeUndated: false },
    reminders: { enabled: true, offsetsMinutes: [30, 10, 5, 0], respectQuietHours: true, quietHours: { from: '22:30', to: '07:00' }, snoozeMinutes: [5, 10], osToast: true, sound: true },
    pomodoro: { focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, roundsBeforeLongBreak: 4, autoStartBreak: true, autoStartFocus: false, dailyGoalRounds: 8, tickingSound: false },
    ui: { showFloatingWidget: true, widgetCorner: 'bottom-right', accent: 'aurora', timelineDensity: 'comfortable', celebrateOnFinish: true },
    seedDemoData: false,
  },
  ownerNames: ['张三', '张老师'],
  excel: {
    path: 'C:\\Users\\User\\Desktop\\2026春季学期值班与课程安排表.xlsx',
    sheet: '总课表',
    sheets: ['总课表', '说明'],
    headerRow: 3,
    mapping: { date: '日期', start: '开始时间', end: '结束时间', title: '事项', person: '姓名', location: '地点', notes: '备注' },
    unmapped: ['签到码'],
    headers: [
      { index: 0, text: '日期', field: 'date' },
      { index: 1, text: '星期', field: 'weekday' },
      { index: 2, text: '开始时间', field: 'start' },
      { index: 3, text: '结束时间', field: 'end' },
      { index: 4, text: '事项', field: 'title' },
      { index: 5, text: '姓名', field: 'person' },
      { index: 6, text: '地点', field: 'location' },
      { index: 7, text: '备注', field: 'notes' },
      { index: 8, text: '签到码', field: null },
    ],
    rowCount: 11,
    importedCount: events.length,
    matchedCount: 8,
    filteredCount: 3,
    pastCount: 0,
    droppedRows: [],
    warnings: ['姓名来源列：姓名'],
    importedAt: iso(-2),
    mtimeMs: now,
    size: 6911,
    lastError: null,
    lastErrorAt: null,
  },
  day: {
    dayKey: dayKey(0),
    events: events.filter((event) => event.date === dayKey(0)).sort((left, right) => left.startMs - right.startMs),
    stats: {
      dayKey: dayKey(0),
      label: '周' + '日一二三四五六'[nowMinute.getDay()],
      eventCount: events.filter((event) => event.date === dayKey(0)).length,
      totalMinutes,
      doneMinutes,
      remainingMinutes: totalMinutes - doneMinutes,
      freeSlots: [{ from: clock(35), to: clock(180), minutes: 145 }],
      completedRounds: 3,
      focusGoalRounds: 8,
      focusMinutesToday: 75,
    },
    undated: [makeEvent({ title: '待定：补交材料', date: '', startOffsetMinutes: null, row: 12 })],
  },
  nextEvent,
  upcoming: events.filter((event) => event.startMs !== null && event.startMs > nowMinute.getTime()).slice(0, 4),
  week: [-2, -1, 0, 1, 2, 3, 4].map((offset) => {
    const key = dayKey(offset)
    const onDay = events.filter((event) => event.date === key)
    return {
      dayKey: key,
      label: '周' + '日一二三四五六'[new Date(base + offset * 86_400_000).getDay()],
      dayOfMonth: new Date(base + offset * 86_400_000).getDate(),
      isToday: offset === 0,
      count: onDay.length,
      firstStart: onDay.length > 0 ? onDay[0].start : '',
      titles: onDay.map((event) => event.title),
    }
  }),
  timer: {
    phase: 'focus',
    running: true,
    startedAt: now - 7 * 60_000,
    endsAt: now + 18 * 60_000,
    remainingMs: 18 * 60_000,
    round: 2,
    completedToday: 3,
    dayKey: dayKey(0),
    subject: '复习傅里叶级数',
    history: [],
    config: { focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, roundsBeforeLongBreak: 4, autoStartBreak: true, autoStartFocus: false, dailyGoalRounds: 8, tickingSound: false },
  },
  feed: [
    { seq: 6, at: iso(-1), kind: 'reminder', level: 'urgent', title: '⏰ 5 分钟后开始 · ' + nextEvent.title, body: nextEvent.start + ' · ' + nextEvent.classroom + ' · ' + nextEvent.course, eventId: nextEvent.id, offsetMinutes: 5, actions: ['snooze', 'done'] },
    { seq: 5, at: iso(-12), kind: 'reminder', level: 'info', title: '🔔 30 分钟后开始 · ' + nextEvent.title, body: nextEvent.start + ' · ' + nextEvent.classroom, eventId: nextEvent.id, offsetMinutes: 30, actions: ['snooze', 'done'] },
    { seq: 4, at: iso(-30), kind: 'focus', level: 'success', title: '🍅 一个番茄完成', body: '今天第 3 个专注完成（复习傅里叶级数）。休息一下。' },
    { seq: 3, at: iso(-52), kind: 'import', level: 'info', title: '日程已更新', body: '从「总课表」抓取 ' + events.length + ' 条与你相关的日程（共 11 行，过滤掉 3 行）。' },
  ],
  generatedAt: new Date(now).toISOString(),
}

/**
 * The month the calendar draws, built the way the host builds it: Monday-first,
 * whole weeks, with each day's items inline. Derived from the fixture's own
 * clock, so the preview is right in whatever month it is rendered.
 *
 * The name is `todayDate` on purpose: a bare `today` here once shadowed the
 * module's `dayKey` helper, and its `NaN` keys put every date in the grid on the
 * wrong day while the grid still looked perfectly plausible.
 */
const todayDate = nowMinute
const monthStart = new Date(todayDate.getFullYear(), todayDate.getMonth(), 1)
const monthDays = new Date(todayDate.getFullYear(), todayDate.getMonth() + 1, 0).getDate()
const lead = (monthStart.getDay() + 6) % 7
const cells = lead + monthDays <= 35 ? 35 : 42
const monthGrid = []
for (let index = 0; index < cells; index += 1) {
  // `index - lead` is the position in the grid, not a day offset: cell 0 of a
  // month whose first day is a Thursday is three days *before the 1st*, which is
  // fifteen days before today. Converting through the day of the month keeps the
  // grid and the day keys in one coordinate system — mixing the two puts the
  // right numbers under the wrong dates, and the grid still looks like a
  // calendar while every schedule lands on a day it is not on.
  const offset = 1 - lead + index - todayDate.getDate()
  const key = dayKey(offset)
  const date = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate() + offset)
  const onDay = events.filter((event) => event.date === key)
  monthGrid.push({
    dayKey: key,
    label: '周' + '日一二三四五六'[date.getDay()],
    dayOfMonth: date.getDate(),
    isToday: key === dayKey(0),
    count: onDay.length,
    hasEvents: onDay.length > 0,
    firstStart: onDay.length > 0 ? onDay[0].start : '',
    titles: onDay.map((event) => event.title),
    inMonth: date.getMonth() === todayDate.getMonth(),
    monthDay: date.getDate(),
  })
}
const monthItemCount = events.filter((event) => event.date.slice(0, 7) === dayKey(0).slice(0, 7)).length
snapshot.month = {
  monthKey: dayKey(0).slice(0, 7),
  year: todayDate.getFullYear(),
  month: todayDate.getMonth() + 1,
  title: `${todayDate.getFullYear()} 年 ${todayDate.getMonth() + 1} 月`,
  prevMonth: dayKey(-todayDate.getDate()).slice(0, 7),
  nextMonth: dayKey(monthDays - todayDate.getDate() + 1).slice(0, 7),
  grid: monthGrid,
  dayCount: monthGrid.filter((cell) => cell.inMonth && cell.count > 0).length,
  eventCount: monthItemCount,
  // As the host sends it: the rows of the open day, and nothing else — the grid
  // itself carries only counts and titles.
  items: events
    .filter((event) => event.date === dayKey(0))
    .map((event) => ({
      id: event.id,
      title: event.title,
      start: event.start,
      end: event.end,
      place: event.classroom || event.location || '',
      done: false,
      manual: event.source?.sheet === '手动添加',
    })),
}
snapshot.manualCount = events.filter((event) => event.source?.sheet === '手动添加').length

// The panel reads live state, so seed the real store and force a re-render with
// the same subscription path a page uses.
store.set({
  snapshot,
  day: snapshot.day.dayKey,
  ready: true,
  // `OT_PREVIEW_STALE=1` renders the "host half is older than this page" banner,
  // which is the state a user is in after a page refresh that did not come with an
  // app restart. Off by default so the checked-in preview shows the normal page.
  hostStale: process.env.OT_PREVIEW_STALE === '1',
  loading: false,
  error: null,
  importState: {
    // The state the page is in right after "读表": a completed analysis and the
    // host's import plan, which is what the confirmation bar is built from.
    status: 'ready',
    message: `识别到工作表「${snapshot.excel.sheet}」，表头在第 ${snapshot.excel.headerRow} 行，共 ${snapshot.excel.rowCount} 行数据。`,
    preview: {
      file: snapshot.excel.path,
      sheets: snapshot.excel.sheets,
      sheet: snapshot.excel.sheet,
      headerRow: snapshot.excel.headerRow,
      rowCount: snapshot.excel.rowCount,
      headers: snapshot.excel.headers,
      mapping: snapshot.excel.mapping,
      unmapped: snapshot.excel.unmapped,
      warnings: snapshot.excel.warnings,
      ownerNames: snapshot.ownerNames,
      matchedInPreview: 4,
      plan: {
        rows: snapshot.excel.rowCount,
        matched: 7,
        importable: 6,
        past: 1,
        beyondHorizon: 0,
        undated: 0,
        firstDate: dayKey(1),
        lastDate: dayKey(9),
        horizonDays: 30,
        ownerNames: snapshot.ownerNames,
      },
      sample: [
        { row: 4, date: dayKey(0), start: clock(-260), end: clock(-200), title: '英语听力', person: '张三、李四', location: '语音室 2', match: true, warnings: [], extras: { 签到码: 'ENG-01' } },
        { row: 5, date: dayKey(0), start: clock(-80), end: clock(10), title: '高等数学 A', person: '张三', location: '三教 305', match: true, warnings: [], extras: { 签到码: 'MATH-02' } },
        { row: 6, date: dayKey(0), start: clock(-22), end: clock(38), title: '项目周会', person: '王五, 张三', location: '线上腾讯会议', match: true, warnings: [], extras: { 签到码: 'MTG-03' } },
        { row: 7, date: dayKey(0), start: clock(28), end: clock(138), title: '数据结构实验', person: '张三', location: '实验楼 B210', match: true, warnings: [], extras: { 签到码: 'DS-04' } },
        { row: 8, date: dayKey(0), start: clock(320), end: clock(410), title: '教研活动', person: '全体教师', location: '阶梯教室', match: true, warnings: ['日期沿用上一行'], extras: { 签到码: 'RES-05' } },
        { row: 9, date: dayKey(0), start: clock(400), end: clock(460), title: '晚自习辅导', person: '赵六', location: '图书馆 2F', match: false, warnings: [], extras: { 签到码: 'TUT-06' } },
      ],
    },
    error: null,
    /**
     * A completed analysis, so the 设置 / 导入 preview shows what the page looks
     * like after the model has read a workbook — the state the user actually
     * lands in. Without it the preview only ever showed the empty prompt, which
     * is exactly the state least worth reviewing.
     */
    analysis: {
      mode: 'model',
      model: { provider: 'deepseek-account', model: 'deepseek-flash' },
      layout: 'records',
      mapping: { person: '姓名', date: '日期', start: '开始时间', end: '结束时间', title: '事项', location: '地点' },
      timeRules: [],
      weekOneMonday: '',
      subject: '',
      confidence: 0.86,
      summary: '把「2026 春季课表.xlsx」看成了记录表：识别出 6 个字段，姓名列是「姓名」，可以直接导入。',
      hints: [
        '列映射按表头文字匹配，可在下面手动改。',
        '必填字段已配齐，可以直接导入。',
      ],
      missing: [],
      grid: false,
      filled: 6,
    },
    modelNote: '',
  },
  notices: [
    { id: 'n1', level: 'urgent', title: '⏰ 5 分钟后开始 · ' + nextEvent.title, body: nextEvent.start + ' · ' + nextEvent.classroom + ' · ' + nextEvent.course, eventId: nextEvent.id },
  ],
  companion: {
    messages: [
      { id: 'w1', role: 'ai', greeting: true, speak: '我是 Orbyt，你的日程副驾。', detail: '我能把 Excel 里属于你的日程抓出来、在开始前 30/10/5 分钟提醒你，还能陪你跑番茄钟。', chips: ['生成今日简报', '分析我的空档', '提醒是怎么设置的？'] },
      { id: 'u1', role: 'user', text: '今天最该先做什么？' },
      {
        id: 'a1',
        role: 'ai',
        speak: '先把「' + currentEvent.title + '」收尾，然后去实验楼。',
        detail:
          currentEvent.title + '还在进行，线上会议；「' + nextEvent.title + '」' + nextEvent.start + ' 在 ' + nextEvent.classroom + ' 开始，走过去大概 6 分钟。\n' +
          '再往后今天的空档不多，明天 ' + dutyEvent.start + ' 那次考勤点名更值得提前看一眼。',
        chips: ['准备下一个日程', '现在开一个番茄'],
        mode: 'model',
        fallback: null,
      },
      {
        id: 'a2',
        role: 'ai',
        speak: '模型这会儿没回上，我先按内置规则说：今天 7 条日程，已完成 2.7 小时。',
        detail: '',
        chips: ['生成今日简报'],
        mode: 'local',
        fallback: { reason: 'model-error', detail: 'rate limited' },
      },
    ],
    busy: false,
  },
  assistant: { mode: 'model', reason: 'ready', detail: 'deepseek-account · deepseek-flash' },
})

/**
 * The other state of the import page: a document has just been read.
 *
 * Kept behind a flag so the default preview stays the workbook flow. This is the
 * state that cannot be reached by refreshing a page — it needs a real file and a
 * real model — and therefore the one most worth looking at before shipping.
 */
if (process.env.OT_PREVIEW_READ === '1') {
  store.set({
    importState: { status: 'idle', message: '', preview: null, analysis: null, error: null, modelNote: '' },
    extractState: {
      status: 'ready',
      message: '一份值班通知，读出两次值班；其中一条是李四的事。',
      source: {
        kind: 'docx',
        type: 'Word 文档',
        file: '示例值班通知.docx',
        path: 'C:\\Users\\x\\Desktop\\示例值班通知.docx',
        chars: 240,
        truncated: false,
        pages: 0,
        scannedPages: 0,
        imageCount: 0,
        notes: ['文档里有 1 张表格，已按「列 | 列 | 列」的文本读出来。'],
        pasted: false,
      },
      analysis: {
        mode: 'model',
        model: { provider: 'deepseek-account', model: 'deepseek-flash' },
        events: [],
        excluded: [{ title: '李四交材料', reason: '是 李四 的事，不是你的' }],
        summary: '一份 11 月的值班通知：早打卡两次、晚自习考勤一次。',
        hints: ['早打卡在东区门口查验，提前 5 分钟到岗。'],
        confidence: 0.72,
        modelNote: 'AI 读的',
      },
      plan: {
        rows: 3,
        matched: 3,
        importable: 3,
        past: 0,
        beyondHorizon: 0,
        undated: 0,
        firstDate: dayKey(7),
        lastDate: dayKey(21),
        horizonDays: 60,
        ownerNames: snapshot.ownerNames,
      },
      draft: [
        { key: 'x0', date: dayKey(7), start: '07:00', end: '07:30', title: '早打卡值班', location: '东区门口', notes: '查验早打卡，按表签到', confidence: 0.86, include: true },
        { key: 'x1', date: dayKey(7), start: '19:30', end: '20:50', title: '晚自习考勤点名', location: '3 班 A101', notes: '先找班委取考勤记录', confidence: 0.74, include: true },
        { key: 'x2', date: dayKey(21), start: '07:00', end: '07:30', title: '早打卡值班', location: '东区门口', notes: '', confidence: 0.6, include: true },
        { key: 'x3', date: dayKey(14), start: '10:00', end: '11:00', title: '替班（不是我的）', location: '', notes: '', confidence: 0.3, include: false },
      ],
      error: null,
    },
  })
}

// ------------------------------------------------------------------ markup

const activeTab = process.argv.find((arg) => arg.startsWith('--tab='))?.slice(6) || 'timeline'
const tabLabels = { timeline: '日程时间轴', calendar: '日程时间轴 · 日历', add: '日程时间轴 · 加一条', pomodoro: '番茄专注', companion: 'AI 助手', settings: '设置 / 导入' }

/**
 * The calendar as the user reaches it: inside the timeline, under the day strip,
 * with its toggle showing as pressed. Rendering the panel on its own would skip
 * the very thing being reviewed — where the button lives and what opens under it.
 */
function dayStrip() {
  const tabs = snapshot.week
    .map(
      (entry) =>
        `<button type="button" class="ot-daychip" data-active="${entry.dayKey === snapshot.day.dayKey}">` +
        `<span>${entry.isToday ? '今天' : entry.label}</span><b>${entry.dayOfMonth}</b>` +
        (entry.count > 0 ? '<i></i>' : '') +
        '</button>',
    )
    .join('')
  const addButton =
    '<button type="button" class="ot-btn ot-btn-sm ot-btn-primary">' +
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 6v12M6 12h12"></path></svg>加一条</button>'
  return (
    `<div class="ot-daybar"><div class="ot-daylist">${tabs}</div><div class="ot-headspace"></div>` +
    (activeTab === 'add' ? '' : addButton) +
    '<button type="button" class="ot-btn ot-btn-sm ot-btn-primary">' +
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"></rect><path d="M3.5 10h17M8 3.5v3.5M16 3.5v3.5"></path></svg>日历</button>' +
    '<button type="button" class="ot-btn ot-btn-sm"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M20 11a8 8 0 1 0-2.4 5.7M20 5.5V11h-5.5"></path></svg></button></div>'
  )
}

function renderTab(tab) {
  const map = {
    timeline: () => React.createElement(exports_['./timeline.js'].TimelineView, {
      store,
      snapshot,
      day: snapshot.day.dayKey,
      events: snapshot.day.events,
      stats: snapshot.day.stats,
      undated: snapshot.day.undated,
      now,
      onFocus: () => {},
      onReimport: () => {},
    }),
    calendar: () => {
      const calendar = React.createElement(exports_['./calendar.js'].CalendarView, {
        snapshot,
        day: snapshot.day.dayKey,
        onPickDay: () => {},
        onMonth: () => {},
        onAdd: () => {},
        onClose: () => {},
      })
      return React.createElement('div', {
        dangerouslySetInnerHTML: { __html: dayStrip() + renderToStaticMarkup(calendar) },
      })
    },
    add: () => {
      const calendar = React.createElement(exports_['./calendar.js'].CalendarView, {
        snapshot,
        day: snapshot.day.dayKey,
        onPickDay: () => {},
        onMonth: () => {},
        onAdd: () => {},
        onClose: () => {},
      })
      const form = React.createElement(exports_['./manual.js'].ManualEventForm, {
        store,
        day: snapshot.day.dayKey,
        now: new Date(now),
        onCancel: () => {},
        onSaved: () => {},
      })
      return React.createElement('div', {
        dangerouslySetInnerHTML: { __html: dayStrip() + renderToStaticMarkup(form) + renderToStaticMarkup(calendar) },
      })
    },
    pomodoro: () => React.createElement(exports_['./pomodoro.js'].PomodoroView, {
      store,
      timer: store.currentTimer(now),
      settings: snapshot.settings,
      now,
      nextTitle: nextEvent.title,
      nextRelative: nextEvent.minutesUntilStart + ' 分钟后',
    }),
    companion: () => React.createElement(exports_['./companion.js'].CompanionView, {
      store,
      companion: store.get().companion,
      assistant: store.get().assistant,
      snapshot,
      settings: snapshot.settings,
      ownerNames: snapshot.ownerNames,
    }),
    settings: () => React.createElement(exports_['./settings.js'].SettingsView, { store, snapshot }),
  }
  return renderToStaticMarkup(map[tab]())
}

function shell(body, tab) {
  const header = renderToStaticMarkup(React.createElement(app.Dashboard))
  // Dashboard emits the whole <div class="ot-root"> shell; keep its header and
  // swap the body for the requested tab so the preview never nests two roots.
  const openTag = header.slice(0, header.indexOf('>') + 1)
  const chrome = header.slice(0, header.indexOf('<nav'))
  const notices = renderToStaticMarkup(React.createElement(app.Notices))
  const widget = renderToStaticMarkup(React.createElement(app.FloatingWidget, { __preview: true }))
  const tabs = Object.keys(tabLabels)
    .map(
      (id) =>
        `<button type="button" class="ot-tab" data-active="${id === tab}">${tabLabels[id]}` +
        (id === 'timeline' ? `<span class="ot-badge">${events.length}</span>` : '') +
        (id === 'pomodoro' ? '<span class="ot-badge">18:00</span>' : '') +
        '</button>',
    )
    .join('')
  const noticesInner = notices.replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '')
  const widgetInner = widget.replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '')
  // The in-window widget and the floating notice stack are both fixed-position
  // in the app, so they would cover the transcript here. The widget gets its own
  // preview; the notice stack is small enough to keep for the toast design.
  const showWidget = process.env.OT_PREVIEW_WIDGET === '1'
  return (
    openTag +
    chrome +
    `<nav class="ot-tabs" role="tablist">${tabs}</nav>` +
    `<div class="ot-body">${body}</div>` +
    `<div class="ot-notices"><div class="ot-notice-stack">${noticesInner}</div></div>` +
    (showWidget
      ? `<div class="ot-float-shell" style="position:absolute;right:16px;bottom:16px;width:288px;max-height:60%">${widgetInner}</div>`
      : '') +
    '</div>'
  )
}

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>Orbit Time · 面板预览</title>
<style>
  /* Harness dark-theme token values, so the plugin's var() fallbacks resolve
     exactly as they do in the app. */
  :root {
    --dsw-alias-bg-base: #0d0f14;
    --dsw-alias-bg-layer-1: #161920;
    --dsw-alias-bg-layer-2: #1d212a;
    --dsw-alias-bg-overlay: rgba(20, 23, 30, 0.86);
    --dsw-alias-border-l1: rgba(255, 255, 255, 0.09);
    --dsw-alias-border-l2: rgba(255, 255, 255, 0.17);
    --dsw-alias-brand-primary: #4d8dff;
    --dsw-alias-label-primary: #f2f4f8;
    --dsw-alias-label-secondary: #b7bfcc;
    --dsw-alias-state-error-primary: #ff6b6b;
    --dsw-alias-state-success-primary: #3fd18b;
    --dsw-alias-state-warn-primary: #f0a83c;
  }
  html, body { margin: 0; height: 100%; background: #0d0f14; }
  body { font-family: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif; }
  /* The real main panel is roughly this wide next to the sidebar. */
  .preview-frame { position: relative; width: 940px; height: 940px; margin: 0 auto; }
  .preview-frame > .ot-root { position: relative; height: 940px; }
  /* A screenshot is a still of the settled page. Headless Chrome writes the
     frame while the entrance animations are still running, which is why a
     capture used to come out washed out: the whole panel was caught at
     partial opacity. Collapsing the durations lands on the final state. */
  .ot-root *, .ot-root *::before, .ot-root *::after {
    animation-duration: 0.001ms !important;
    animation-delay: 0s !important;
    transition-duration: 0.001ms !important;
  }

  ${styles}
</style></head>
<body><div class="preview-frame">${shell(renderTab(activeTab), activeTab)}</div></body></html>`

const htmlPath = join(outDir, `${process.env.OT_PREVIEW_NAME || 'panel-' + activeTab}.html`)
writeFileSync(htmlPath, html, 'utf8')
console.log(`preview: wrote ${htmlPath} (${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)} kB, tab=${activeTab})`)

if (wantPng) {
  const browsers = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]
  const browser = browsers.find((candidate) => existsSync(candidate))
  if (browser === undefined) {
    console.log('preview: no Edge/Chrome found, skipping the PNG')
  } else {
    const pngPath = join(outDir, `${process.env.OT_PREVIEW_NAME || 'panel-' + activeTab}.png`)
    const result = spawnSync(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--default-background-color=00000000',
        '--virtual-time-budget=4000',
        `--window-size=940,940`,
        `--screenshot=${pngPath}`,
        pathToFileURL(htmlPath).href,
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 90_000 },
    )
    if (result.error) console.log(`preview: browser failed: ${result.error.message}`)
    else if (!existsSync(pngPath)) console.log(`preview: no PNG produced (exit ${result.status})\n${(result.stderr || '').slice(0, 600)}`)
    else console.log(`preview: wrote ${pngPath}`)
  }
}
