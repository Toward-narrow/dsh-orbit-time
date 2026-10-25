#!/usr/bin/env node
/**
 * Focused checks for the rebuilt 设置 / 导入 page.
 *
 * Renders the real bundle with a real store, because the failures worth catching
 * here are structural: a control rendered without its label, an action missing
 * from the verdict, or the page falling back to "map every column yourself" when
 * an analysis is present. Static markup can prove all of those.
 *
 * Usage: node scripts/test-import-panel.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

// --- minimal page environment: the bundle is a lazy-CJS browser artifact ------
let registered = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registered = entry
    },
  },
}
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: '', appendChild() {}, remove() {} }),
  head: { appendChild() {} },
}

const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const reactDomClient = require('react-dom/client')

globalThis.__otReact = React
const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
// eslint-disable-next-line no-new-func -- executing the artifact under test
new Function('require', 'window', 'document', 'React', bundle)(
  (name) => (name === 'react' ? React : name === 'react-dom/client' ? reactDomClient : require(name)),
  globalThis.window,
  globalThis.document,
  React,
)

const exports_ = registered.factory((name) => (name === 'react' ? React : require(name)))
const app = exports_['./index.js'] || exports_
const store = exports_['./store.js'].store

let failures = 0
function check(label, fn) {
  try {
    const detail = fn()
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label} — ${error.message}`)
  }
}

/** The smallest snapshot the import page needs to render. */
function makeSnapshot(overrides = {}) {
  return {
    ok: true,
    now: new Date().toISOString(),
    serverTime: { iso: new Date().toISOString(), dayKey: '2026-10-12', minutes: 600, label: '10:00' },
    settings: {
      profile: { name: '张三', aliases: [] },
      workbook: { path: '', watch: true, importHorizonDays: 200, sources: [], timeRules: [] },
      reminders: { enabled: true, offsetsMinutes: [30, 10, 5, 0], osToast: true, respectQuietHours: true, quietHours: { from: '22:30', to: '07:00' } },
      pomodoro: { focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, roundsBeforeLongBreak: 4, dailyGoalRounds: 8 },
      ui: { showFloatingWidget: false },
    },
    ownerNames: ['张三'],
    excel: null,
    day: { dayKey: '2026-10-12', events: [], stats: { label: '周一', eventCount: 0, totalMinutes: 0, doneMinutes: 0, remainingMinutes: 0, freeSlots: [], completedRounds: 0, focusGoalRounds: 8, focusMinutesToday: 0 }, undated: [] },
    nextEvent: null,
    upcoming: [],
    week: [],
    timer: { phase: 'idle', running: false, remainingMs: 0, round: 1, completedToday: 0, subject: '', config: { focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, dailyGoalRounds: 8 } },
    feed: [],
    generatedAt: new Date().toISOString(),
    ...overrides,
  }
}

const GRID_ANALYSIS = {
  mode: 'model',
  model: { provider: 'deepseek-account', model: 'deepseek-flash' },
  layout: 'matrixDate',
  mapping: {},
  timeRules: [{ match: ['早打卡', '打卡'], start: '07:00', end: '07:30' }],
  weekOneMonday: '2026-08-31',
  subject: '早打卡',
  confidence: 0.88,
  summary: '把这份表看成值班网格：78 行记录，时间按「早打卡」取 07:00–07:30。',
  hints: ['网格表不需要列映射。', '必填字段已配齐，可以直接导入。'],
  missing: [],
  grid: true,
  filled: 0,
}

const RECORD_ANALYSIS = {
  mode: 'local',
  layout: 'records',
  mapping: { person: '姓名', date: '日期', start: '开始时间' },
  timeRules: [],
  weekOneMonday: '',
  subject: '',
  confidence: 0.52,
  summary: '把这份表看成记录表：识别出 3 个字段，还缺 结束时间。',
  hints: ['列映射按表头文字匹配，可在下面手动改。'],
  missing: ['结束时间'],
  grid: false,
  filled: 3,
  modelReason: 'no-service',
  modelDetail: '当前组合里没有可用的模型服务。',
}

const PREVIEW = {
  file: 'C:\\Users\\User\\project\\dsh-orbit-time\\示例支部早打卡排班表.xlsx',
  configuredPath: 'C:\\Users\\User\\project\\dsh-orbit-time\\示例支部早打卡排班表.xlsx',
  sheets: ['Sheet1'],
  sheet: 'Sheet1',
  layout: 'matrixDate',
  headerRow: 1,
  rowCount: 78,
  headers: [
    { index: 0, text: '值班日期', field: null },
    { index: 1, text: '星期', field: null },
  ],
  mapping: {},
  unmapped: [],
  warnings: ['识别为值班表网格：日期表头在第 1 行，共 13 列、78 条记录。'],
  ownerNames: ['张三'],
  matchedInPreview: 1,
  // The host's own count of the whole sheet — what the confirmation bar reads.
  plan: {
    rows: 78,
    matched: 1,
    importable: 1,
    past: 0,
    beyondHorizon: 0,
    undated: 0,
    firstDate: '2026-10-28',
    lastDate: '2026-11-18',
    horizonDays: 60,
    ownerNames: ['张三'],
  },
  sample: [
    { row: 2, date: '2026-10-28', start: '07:00', end: '07:30', title: '早打卡值班', person: '张三', location: '东门', match: true, warnings: [], extras: {} },
    { row: 3, date: '2026-11-18', start: '07:00', end: '07:30', title: '早打卡值班', person: '李四', location: '东门', match: false, warnings: [], extras: {} },
  ],
}

const S = join(root, 'src', 'client', 'styles.css')
const css = readFileSync(S, 'utf8')

function render(snapshot) {
  return renderToStaticMarkup(React.createElement(app.SettingsView, { store, snapshot }))
}

// `--dump` prints the markup instead of asserting, which is what you want when a
// needle goes missing and the reason is not obvious from the failure text.
const DUMP = process.argv.includes('--dump')

// ---- 1. an analysis is on screen: the verdict is the interface --------------
store.set({
  snapshot: makeSnapshot(),
  ready: true,
  loading: false,
  error: null,
  importState: { status: 'ready', message: GRID_ANALYSIS.summary, preview: PREVIEW, analysis: GRID_ANALYSIS, error: null, modelNote: '' },
})

const withAnalysis = render(makeSnapshot())
if (DUMP) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(root, '..', '..', '.cache', 'import-panel.html'), withAnalysis, 'utf8')
  console.log('dumped markup to .cache/import-panel.html')
  process.exit(0)
}
check('the verdict leads with what the model decided', () => {
  for (const needle of ['AI 读完了这份表', GRID_ANALYSIS.summary, '很有把握 88%', 'deepseek-account · deepseek-flash']) {
    if (!withAnalysis.includes(needle)) throw new Error(`missing ${needle}`)
  }
  return 'summary, confidence pill, and model chip all present'
})
check('the confirmation is a bar at the top of the page, before anything else', () => {
  for (const needle of ['ot-confirm', '读完了「示例支部早打卡排班表.xlsx」', '将导入 1 条 · 2026-10-28 → 2026-11-18']) {
    if (!withAnalysis.includes(needle)) throw new Error(`missing ${needle}`)
  }
  // Before the first card: reading a sheet produces a decision, so it leads.
  if (withAnalysis.indexOf('ot-confirm') > withAnalysis.indexOf('1 · 关注的人')) {
    throw new Error('the confirmation bar is below the first card')
  }
  return 'sticky bar first, with the import counts'
})
check('one click imports', () => {
  if (!withAnalysis.includes('确认并导入')) throw new Error('missing the primary action')
  return '确认并导入'
})
check('the verdict reports the facts behind it', () => {
  for (const needle of ['版式：值班 / 网格表', '工作表：Sheet1', '78 行数据', '07:00–07:30', '周次锚点 2026-08-31', '属于你的 1 行']) {
    if (!withAnalysis.includes(needle)) throw new Error(`missing ${needle}`)
  }
  return 'layout, sheet, rows, time rule, week anchor, matched rows'
})
check('column mapping is not in the way of an import', () => {
  // The mapping grid is identified by its own container class, not by a label:
  // the same words appear in the help text above it.
  if (withAnalysis.includes('ot-mapping-list')) throw new Error('the mapping grid is expanded by default')
  if (!withAnalysis.includes('手动调整列映射')) throw new Error('missing the escape hatch')
  return 'collapsed, with 手动调整列映射 available'
})
check('a grid says why there is nothing to map', () => {
  if (withAnalysis.includes('（未匹配）')) throw new Error('a grid should not show unmatched column selects')
  return 'no phantom "未匹配" selects'
})
check('the file step has one obvious action', () => {
  for (const needle of ['选一个 Excel，AI 直接帮你读', '选择 Excel', '或者直接粘贴文件路径']) {
    if (!withAnalysis.includes(needle)) throw new Error(`missing ${needle}`)
  }
  return 'pick, drop, or paste'
})

// ---- 2. a records sheet with gaps: the escape hatch is reachable -------------
store.set({
  importState: { status: 'ready', message: RECORD_ANALYSIS.summary, preview: { ...PREVIEW, layout: 'records', mapping: RECORD_ANALYSIS.mapping }, analysis: RECORD_ANALYSIS, error: null, modelNote: '本机判断（当前组合里没有可用的模型服务）' },
})
const withRecords = render(makeSnapshot())
check('a local verdict says so instead of pretending', () => {
  if (!withRecords.includes('本机读完了这份表')) throw new Error('missing the local-mode heading')
  if (!withRecords.includes('本机判断')) throw new Error('missing the fallback reason')
  return '本机读完了这份表 + reason'
})
check('missing required fields are called out', () => {
  if (!withRecords.includes('还缺：结束时间')) throw new Error('missing the gap warning')
  return '还缺：结束时间'
})

// ---- 3. nothing read yet: the page still tells you what to do --------------
store.set({
  importState: { status: 'idle', message: '', preview: null, analysis: null, error: null, modelNote: '' },
})
const fresh = render(makeSnapshot())
check('the empty state is an instruction, not a blank card', () => {
  if (!fresh.includes('拖一个 Excel 进来') && !fresh.includes('选一个 Excel')) throw new Error('no guidance on an empty page')
  return 'guidance present'
})

// ---- 4. a failure is readable ----------------------------------------------
store.set({
  importState: { status: 'error', message: '', preview: null, analysis: null, error: 'C:\\nope\\排班表.xlsx：找不到文件或目录。', modelNote: '' },
})
const failed = render(makeSnapshot())
check('a read failure shows the host message verbatim', () => {
  if (!failed.includes('找不到文件或目录')) throw new Error('the error text was swallowed')
  if (!failed.includes('ot-note-error')) throw new Error('the error is not styled as an error')
  return 'error surfaced in the error note'
})

// ---- 5. the stylesheet carries the classes the page uses --------------------
check('every class the page renders has a rule', () => {
  const used = new Set()
  for (const match of withAnalysis.matchAll(/class="([^"]+)"/g)) {
    for (const name of match[1].split(/\s+/)) if (name.startsWith('ot-')) used.add(name)
  }
  const missing = [...used].filter((name) => !css.includes(`.${name}`))
  if (missing.length > 0) throw new Error(`no rule for ${missing.join(', ')}`)
  return `${used.size} classes checked`
})

console.log(failures === 0 ? '\nall import-panel checks passed' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
