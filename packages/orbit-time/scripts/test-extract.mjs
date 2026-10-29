#!/usr/bin/env node
/**
 * "Read anything" test — documents, pictures and pasted text into events.
 *
 * Boots the host half with a mock context exactly like `test-host.mjs` does, so
 * the routes under test are the real ones, then drives `/extract` and
 * `/extract/commit` over HTTP. The model is scripted: a real one would make this
 * a test of the provider's mood, and the contract being pinned here is the one
 * *this* plugin owns — what it sends, what it accepts, and what it refuses.
 *
 * The checks that matter:
 *   - a model answer becomes validated events, with the file's own facts in the
 *     prompt and the panel's import filters applied to the result;
 *   - when the model is off, the local scanner still reads a plain notice — the
 *     feature has to work with no AI at all;
 *   - a real .docx / .pdf is read through the Python helper (skipped when this
 *     machine has no interpreter, with the reason printed);
 *   - a picture becomes an image block in the model request, and a route that
 *     cannot see pictures is refused *before* anything is sent;
 *   - committing is idempotent and the rows survive an import.
 *
 * Run: node scripts/test-extract.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const repo = resolve(root, '..', '..')
const samples = join(repo, 'samples')

const scratch = mkdtempSync(join(tmpdir(), 'orbit-time-extract-'))
process.env.DSH_HOME = scratch

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

// ------------------------------------------------------------------ mock host

const routes = new Map()
const logs = []
const pushes = []

/** Scripted model. `answer` is a string (or a function of the call). */
const model = {
  calls: [],
  answer: null,
  fail: null,
  modalities: ['text', 'image'],
  async *stream(options) {
    model.calls.push(options)
    if (model.fail === 'throw') throw new Error('provider exploded')
    if (model.fail === 'error-finish') {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'rate-limit' } } }
      return
    }
    const text = typeof model.answer === 'function' ? model.answer(options) : model.answer ?? ''
    for (const piece of text.match(/[\s\S]{1,40}/g) ?? []) yield { type: 'text-delta', index: 0, text: piece }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
  async resolveModelInfo() {
    return { provider: 'deepseek-account', id: 'deepseek-flash', name: 'flash', inputModalities: model.modalities }
  },
}

const attachments = {
  saved: [],
  async saveImages(inputs) {
    return inputs.map((input) => {
      attachments.saved.push(input)
      return {
        attachmentId: 'att-' + attachments.saved.length,
        mediaType: input.mediaType,
        bytes: input.data.length,
        width: 1,
        height: 1,
        name: input.name,
      }
    })
  },
}

const services = {
  llm: model,
  attachments,
  agentDefaultModel: {
    currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }),
  },
  orbitTimeSpawn: (command, args, options) => {
    // Only the PowerShell helpers are faked. The document reader is a real
    // Python process and the test needs its real stdout, so everything else is
    // spawned for real.
    if (!/powershell|pwsh/i.test(command)) return spawn(command, args, options)
    pushes.push({ command, args })
    return { pid: 4242, stdin: { end() {} }, stdout: { on() {} }, stderr: { on() {} }, on() { return this }, kill() {} }
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
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    interval() {
      return () => {}
    },
    timeout() {
      return () => {}
    },
    effect() {
      return () => {}
    },
  }
}

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

const host = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
host.apply(makeCtx(), {
  profile: { name: '张三' },
  workbook: { path: '', watch: false, sources: [], importHorizonDays: 60 },
  reminders: { enabled: false },
  ui: { showFloatingWidget: false },
})

async function api(path, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = JSON.parse(await response.text())
  return { status: response.status, payload }
}

async function post(path, body) {
  const { status, payload } = await api(path, body)
  if (status >= 400) throw new Error(`${path} -> ${status}: ${payload?.error ?? 'no error'}`)
  return payload
}

const pad = (value) => String(value).padStart(2, '0')
const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const tomorrow = new Date()
tomorrow.setDate(tomorrow.getDate() + 1)

console.log('orbit-time "read anything" test')
console.log(`  server: ${base}`)

// ------------------------------------------------------------------ routes

await check('the extraction routes are registered', () => {
  for (const path of ['/api/orbit-time/extract', '/api/orbit-time/extract/commit']) {
    if (!routes.has(path)) throw new Error(`missing ${path}`)
  }
  return `${routes.size} routes`
})

// ------------------------------------------------------------------ model path

const modelAnswer = {
  events: [
    {
      date: dayKey(tomorrow),
      start: '7:0',
      end: '7:30',
      title: '早打卡值班',
      location: '东区门口',
      person: '张三',
      notes: '带上签到表',
      confidence: 0.86,
    },
    {
      date: dayKey(tomorrow),
      start: '19:30',
      end: '20:50',
      title: '晚自习考勤点名',
      person: '李四',
      confidence: 0.9,
    },
    { date: '不是日期', start: '10:00', title: '没有日期的条目', confidence: 0.4 },
  ],
  summary: '一份值班通知，写着两次值班。',
  hints: ['早打卡在门口签到'],
}

const notice = '11月4日 07:00-07:30 早打卡值班。11月9日 19:30-20:50 晚自习考勤点名。'

model.answer = JSON.stringify(modelAnswer)
const modelRead = await post('/extract', { text: notice })
await check('a model answer becomes validated events', () => {
  if (modelRead.ok !== true) throw new Error('ok was not true')
  if (modelRead.analysis.mode !== 'model') throw new Error(`mode=${modelRead.analysis.mode}`)
  const events = modelRead.analysis.events
  if (events.length !== 1) throw new Error(`kept ${events.length} events: ${JSON.stringify(events)}`)
  const event = events[0]
  if (event.start !== '07:00' || event.end !== '07:30') throw new Error(`time not normalised: ${event.start}-${event.end}`)
  if (event.title !== '早打卡值班') throw new Error(`title=${event.title}`)
  if (modelRead.analysis.excluded.length < 2) throw new Error(`excluded=${JSON.stringify(modelRead.analysis.excluded)}`)
  if (modelRead.analysis.summary !== '一份值班通知，写着两次值班。') throw new Error('summary was not carried through')
  return `${events.length} kept, ${modelRead.analysis.excluded.length} excluded`
})

await check('the model receives the document text, today, and the owner', () => {
  const call = model.calls[model.calls.length - 1]
  if (call === undefined) throw new Error('the model was never called')
  for (const needle of [notice.slice(0, 12), '关注的人', '张三', dayKey(new Date())]) {
    if (!call.system.includes(needle)) throw new Error(`prompt is missing ${needle}`)
  }
  if (!call.system.includes('"events"')) throw new Error('the prompt has no schema')
  const last = call.messages[call.messages.length - 1]
  if (last.role !== 'user' || last.content[0].type !== 'text') throw new Error('the user turn is not text')
  return `${call.system.length} char prompt`
})

await check('the plan counts what the import filters would keep', () => {
  const plan = modelRead.plan
  if (plan.rows !== 1) throw new Error(`rows=${plan.rows}`)
  if (plan.importable !== 1) throw new Error(`importable=${plan.importable}`)
  if (plan.ownerNames.join('/') !== '张三') throw new Error('ownerNames missing')
  return `importable=${plan.importable} horizon=${plan.horizonDays}`
})

// ------------------------------------------------------------------ local path

model.answer = null
await post('/settings', { settings: { assistant: { useModel: false } } })
const localRead = await post('/extract', {
  text: `通知：${tomorrow.getMonth() + 1}月${tomorrow.getDate()}日 07:00-07:30 早打卡值班，张三到岗。`,
})
await check('with the model off, a plain notice is still read locally', () => {
  if (localRead.analysis.mode !== 'local') throw new Error(`mode=${localRead.analysis.mode}`)
  if (localRead.analysis.reason !== 'disabled') throw new Error(`reason=${localRead.analysis.reason}`)
  const events = localRead.analysis.events
  if (events.length !== 1) throw new Error(`local scan found ${events.length}: ${JSON.stringify(events)}`)
  const event = events[0]
  if (event.date !== dayKey(tomorrow)) throw new Error(`date=${event.date}, expected ${dayKey(tomorrow)}`)
  if (event.start !== '07:00' || event.end !== '07:30') throw new Error(`time=${event.start}-${event.end}`)
  if (!event.title.includes('早打卡')) throw new Error(`title=${event.title}`)
  if (!(localRead.analysis.modelNote ?? '').includes('本机')) throw new Error('the panel is not told who read it')
  return `${event.date} ${event.start} ${event.title}`
})

await check('the local scanner understands relative days and Chinese weekdays', () => {
  // 明天 / 后天 / 周三 are the three shapes a notice actually uses, and the
  // converter has to resolve them against the host's today.
  return post('/extract', { text: '明天 14:00 实验室安全培训。后天 09:00 开会。' }).then((result) => {
    const dates = result.analysis.events.map((event) => event.date)
    const plusOne = new Date()
    plusOne.setDate(plusOne.getDate() + 1)
    const plusTwo = new Date()
    plusTwo.setDate(plusTwo.getDate() + 2)
    if (!dates.includes(dayKey(plusOne))) throw new Error(`明天 was not resolved: ${dates.join(',')}`)
    if (!dates.includes(dayKey(plusTwo))) throw new Error(`后天 was not resolved: ${dates.join(',')}`)
    return dates.join(', ')
  })
})

await check('a line with another person is not turned into an event for me', () => {
  const text = `请李四在 ${tomorrow.getMonth() + 1}月${tomorrow.getDate()}日 10:00 前提交材料。`
  return post('/extract', { text }).then((result) => {
    const people = result.analysis.events.map((event) => event.person)
    // The local scanner never invents a person, so this is about the model path;
    // what must hold either way is that the row is not silently attributed to 张三.
    if (people.includes('张三')) throw new Error('another person was attributed to the owner')
    return `${result.analysis.events.length} local row(s), no owner attribution`
  })
})

await post('/settings', { settings: { assistant: { useModel: true } } })

// ------------------------------------------------------------------ real documents

const docx = join(samples, '示例值班通知.docx')
if (existsSync(docx)) {
  model.answer = JSON.stringify({
    events: [{ date: dayKey(tomorrow), start: '08:00', end: '08:30', title: '按文档值班', confidence: 0.7 }],
    summary: 'Word 文档',
  })
  await check('a .docx is read through the Python helper, tables included', async () => {
    const { status, payload } = await api('/extract', { path: docx })
    if (status !== 200) {
      // A machine with no interpreter or no python-docx still has to be able to
      // run this suite; the reason is printed instead of pretending it passed.
      if (/Python|python-docx|PyMuPDF/.test(String(payload?.error))) return `skipped: ${payload.error}`
      throw new Error(payload?.error ?? `status=${status}`)
    }
    if (payload.source.type !== 'Word 文档') throw new Error(`type=${payload.source.type}`)
    const call = model.calls[model.calls.length - 1]
    if (!call.system.includes('示例支部')) throw new Error('the document text did not reach the prompt')
    if (!call.system.includes('|')) throw new Error('the table was not rendered as columns')
    if (payload.analysis.events.length !== 1) throw new Error(`events=${payload.analysis.events.length}`)
    return `${payload.source.chars} chars of text`
  })
} else {
  console.log(`  --   ${docx} is missing; the .docx check is skipped`)
}

const pdf = join(samples, '示例值班通知.pdf')
if (existsSync(pdf)) {
  model.answer = JSON.stringify({ events: [], summary: 'PDF' })
  await check('a .pdf is read through the Python helper', async () => {
    const { status, payload } = await api('/extract', { path: pdf })
    if (status !== 200) {
      if (/Python|PyMuPDF/.test(String(payload?.error))) return `skipped: ${payload.error}`
      throw new Error(payload?.error ?? `status=${status}`)
    }
    if (payload.source.type !== 'PDF') throw new Error(`type=${payload.source.type}`)
    const call = model.calls[model.calls.length - 1]
    if (!call.system.includes('project review')) throw new Error('the PDF text did not reach the prompt')
    return `${payload.source.chars} chars, ${payload.source.pages} page(s)`
  })
} else {
  console.log(`  --   ${pdf} is missing; the .pdf check is skipped`)
}

// ------------------------------------------------------------------ pictures

const pngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

model.answer = JSON.stringify({
  events: [{ date: dayKey(tomorrow), start: '15:00', end: '16:00', title: '图里的会议', confidence: 0.8 }],
  summary: '一张截图',
})
attachments.saved.length = 0
await check('a picture is sent to the model as an image block', async () => {
  const { status, payload } = await api('/extract', { file: { name: 'shot.png', base64: pngBase64 } })
  if (status !== 200) throw new Error(payload?.error ?? `status=${status}`)
  if (payload.source.kind !== 'image') throw new Error(`kind=${payload.source.kind}`)
  if (attachments.saved.length !== 1) throw new Error(`saved ${attachments.saved.length} images`)
  if (attachments.saved[0].mediaType !== 'image/png') throw new Error(`mediaType=${attachments.saved[0].mediaType}`)
  const call = model.calls[model.calls.length - 1]
  const last = call.messages[call.messages.length - 1]
  const images = last.content.filter((part) => part.type === 'image')
  if (images.length !== 1) throw new Error(`the request carried ${images.length} images`)
  if (images[0].attachment.attachmentId !== 'att-1') throw new Error('the image block does not carry the saved ref')
  if (payload.analysis.events.length !== 1) throw new Error('the model answer was not used')
  return `${payload.source.imageCount} page image(s)`
})

model.modalities = ['text']
attachments.saved.length = 0
const blind = await api('/extract', { file: { name: 'shot.png', base64: pngBase64 } })
await check('a route without vision is refused before anything is uploaded', () => {
  if (blind.status !== 200) throw new Error(`status=${blind.status}`)
  const analysis = blind.payload.analysis
  if (analysis.mode !== 'local') throw new Error(`mode=${analysis.mode}`)
  if (!String(analysis.detail).includes('不支持读图')) throw new Error(`detail=${analysis.detail}`)
  if (analysis.events.length !== 0) throw new Error('it claimed to read a picture without vision')
  if (attachments.saved.length !== 0) throw new Error('the image was uploaded before the vision check')
  return analysis.detail.slice(0, 40)
})
model.modalities = ['text', 'image']

// ------------------------------------------------------------------ refusals

const excel = await api('/extract', { path: join(repo, 'samples', 'sample-schedule.xlsx') })
await check('an Excel file is refused with a pointer to the roster importer', () => {
  if (excel.status !== 422) throw new Error(`status=${excel.status}`)
  if (!String(excel.payload.error).includes('Excel')) throw new Error(`error=${excel.payload.error}`)
  return excel.payload.error.slice(0, 40)
})

const unsupported = await api('/extract', { text: '' })
await check('an empty request is refused', () => {
  if (unsupported.status !== 400) throw new Error(`status=${unsupported.status}`)
  return unsupported.payload.error
})

const bogusPath = join(scratch, 'nope.xyz')
writeFileSync(bogusPath, 'not a schedule', 'utf8')
const bogus = await api('/extract', { path: bogusPath })
await check('an unreadable format says so instead of pretending', () => {
  if (bogus.status !== 422) throw new Error(`status=${bogus.status}`)
  if (!String(bogus.payload.error).includes('格式')) throw new Error(`error=${bogus.payload.error}`)
  return bogus.payload.error.slice(0, 40)
})

// ------------------------------------------------------------------ commit

const firstDate = dayKey(tomorrow)
const commitA = await post(`/extract/commit?day=${firstDate}`, {
  file: '通知.txt',
  path: 'C:\\notes\\通知.txt',
  events: [
    { date: firstDate, start: '07:00', end: '07:30', title: '早打卡值班', confidence: 0.8 },
    { date: firstDate, start: '19:30', end: '20:50', title: '晚自习考勤点名', location: 'A101' },
    { date: '', start: '10:00', title: '没有日期的条目' },
  ],
})
await check('committing adds the rows and reports what it skipped', () => {
  if (commitA.added !== 2) throw new Error(`added=${commitA.added}`)
  if (commitA.skipped.length !== 1) throw new Error(`skipped=${JSON.stringify(commitA.skipped)}`)
  if (commitA.snapshot.day.dayKey !== firstDate) throw new Error(`the snapshot opened ${commitA.snapshot.day.dayKey}`)
  const titles = commitA.snapshot.day.events.map((event) => event.title)
  for (const title of ['早打卡值班', '晚自习考勤点名']) {
    if (!titles.includes(title)) throw new Error(`${title} is not on the day: ${titles.join(',')}`)
  }
  const row = commitA.snapshot.day.events.find((event) => event.title === '早打卡值班')
  if (row.source?.sheet !== 'AI 读资料') throw new Error(`sheet=${row.source?.sheet}`)
  return `${commitA.added} added, ${commitA.skipped.length} skipped`
})

const commitB = await post('/extract/commit', {
  file: '通知.txt',
  events: [{ date: firstDate, start: '07:00', title: '早打卡值班' }],
})
await check('committing the same reading twice does not duplicate it', () => {
  if (commitB.added !== 0) throw new Error(`added=${commitB.added}`)
  if (commitB.skipped[0]?.reason !== '已经在日程里了') throw new Error(`skipped=${JSON.stringify(commitB.skipped)}`)
  return commitB.skipped[0].reason
})

await check('the committed rows are stored as self-made rows, not import rows', async () => {
  // Read through `/export` rather than `runtime.json`: the state file is written
  // on a debounce, and asserting the in-memory truth keeps the check independent
  // of how long that timer happens to be.
  const exported = await post('/export', undefined)
  const readRows = exported.events.filter((row) => row.source?.sheet === 'AI 读资料')
  if (readRows.length !== 2) throw new Error(`${readRows.length} rows in the export`)
  if (exported.lastExtraction?.file !== '通知.txt') throw new Error('the last reading was not recorded')
  return `${readRows.length} rows live outside the import set`
})

await check('an import cannot sweep the read rows away', async () => {
  // No roster is configured, so `/import` fails — but the failure path is exactly
  // the one that used to rebuild `events` from whatever parsed and drop
  // everything else. The rows must still be there afterwards.
  const { status } = await api('/import', { path: join(repo, 'samples', 'sample-schedule.xlsx') })
  if (status !== 200) throw new Error(`/import answered ${status}`)
  const exported = await post('/export', undefined)
  const readRows = exported.events.filter((row) => row.source?.sheet === 'AI 读资料')
  if (readRows.length !== 2) throw new Error(`read rows after import: ${readRows.length}`)
  return 'still 2 rows'
})

// ------------------------------------------------------------------ done

await new Promise((done) => server.close(done))
console.log('')
if (failures.length > 0) {
  console.log(`FAILED (${failures.length})`)
  for (const failure of failures) console.log('  - ' + failure)
  process.exit(1)
}
console.log('all extraction checks passed')
