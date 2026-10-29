/** Orbit Time client — process-wide observable state plus the HTTP verbs. */

var util = require('./util.js')
var API = util.API

var listeners = new Set()

var state = {
  ready: false,
  loading: false,
  error: null,
  snapshot: null,
  day: util.todayKey(),
  /** Which month the calendar panel is showing, `YYYY-MM`. */
  month: util.todayKey().slice(0, 7),
  lastFetchAt: 0,
  stale: false,
  importState: {
    status: 'idle',
    message: '',
    preview: null,
    analysis: null,
    error: null,
    /** Why the last analysis did not use the model, when it did not. */
    modelNote: '',
  },
  /**
   * The "read anything" draft: a document, a picture or pasted text that the
   * host turned into candidate events.
   *
   * Separate from `importState` because the two flows answer different
   * questions. An Excel read produces a *mapping* and a verified count ("这些行
   * 属于你"); a document read produces *events* that may need editing one by one.
   * Sharing one blob made the confirmation bar describe the wrong thing.
   */
  extractState: {
    status: 'idle', // idle | reading | ready | saving | done | error
    message: '',
    source: null,
    analysis: null,
    plan: null,
    /** The candidate events, as edited by the user, each with `key` + `include`. */
    draft: [],
    error: null,
  },
  notices: [],
  floatOpen: false,
  /**
   * Whether the *host* half is older than this page.
   *
   * The two halves are installed together but loaded at different moments: the
   * client bundle is re-fetched on every page refresh, while the host module is
   * imported once when the app starts. A page refresh therefore updates the panel
   * and leaves the old import logic running underneath — which looks exactly like
   * "the fix did nothing". `/health` reports `stateDir` only in the newer host, so
   * its absence is a reliable signal that the app needs a restart, and the panel
   * says so instead of letting the user guess.
   */
  hostStale: false,
  /** Which brain the companion is using, reported by the host. */
  assistant: { mode: 'unknown', reason: 'unknown', detail: '' },
  companion: {
    messages: [
      {
        id: 'welcome',
        role: 'ai',
        // The greeting is UI copy, not a model turn: sending it back would make
        // the provider read it as something Orbyt actually said.
        greeting: true,
        speak: '我是 Orbyt，你的日程副驾。拖一份 Excel、通知、截图给我，或者直接问我今天的安排。',
        detail: '我可以帮你：从 Excel / 文档 / 图片里读出属于你的日程、在开始前 30/10/5 分钟提醒、陪你跑番茄钟。',
        chips: ['生成今日简报', '分析我的空档', '提醒是怎么设置的？'],
      },
    ],
    busy: false,
  },
}

function get() {
  return state
}

function subscribe(listener) {
  listeners.add(listener)
  return function () {
    listeners.delete(listener)
  }
}

function notify() {
  for (var listener of Array.from(listeners)) {
    try {
      listener()
    } catch (error) {
      console.error('[orbit-time] store listener failed', error)
    }
  }
}

function set(patch) {
  state = Object.assign({}, state, patch)
  notify()
}

async function request(path, options) {
  var init = options ? Object.assign({}, options) : {}
  init.headers = Object.assign({ 'content-type': 'application/json' }, init.headers || {})
  var response = await fetch(API + path, init)
  var text = await response.text()
  var payload = null
  if (text !== '') {
    try {
      payload = JSON.parse(text)
    } catch (error) {
      throw new Error('接口返回的不是 JSON：' + text.slice(0, 200))
    }
  }
  if (!response.ok) {
    throw new Error((payload && payload.error) || response.status + ' ' + response.statusText)
  }
  return payload
}

async function refresh(day) {
  var target = day || state.day
  // The month is asked for explicitly rather than derived by the host from the
  // open day: "which month is on screen" is the browser's calendar question, and
  // sending it keeps the grid from jumping a month for a user whose timezone is
  // not the host's.
  var month = state.month || String(target).slice(0, 7)
  var query = '/snapshot?day=' + encodeURIComponent(target) + '&month=' + encodeURIComponent(month)
  try {
    var payload = await request(query, { method: 'GET' })
    set({
      snapshot: payload,
      ready: true,
      loading: false,
      error: null,
      lastFetchAt: Date.now(),
      stale: false,
      month: (payload && payload.month && payload.month.monthKey) || month,
    })
    return payload
  } catch (error) {
    set({ loading: false, error: String((error && error.message) || error), stale: state.snapshot !== null })
    throw error
  }
}

/**
 * Ask the host which build it is.
 *
 * `stateDir` arrived with the import/state-directory fix, so an answer without it
 * comes from a host half that predates that work. Cheap and read-only: one GET,
 * swallowed on failure — a diagnostic must never break the panel.
 */
function checkHostBuild() {
  void request('/health')
    .then(function (payload) {
      var stale = !(payload && typeof payload === 'object' && typeof payload.stateDir === 'string' && payload.stateDir !== '')
      if (stale !== state.hostStale) set({ hostStale: stale })
    })
    .catch(function () {
      /* offline: leave the flag alone */
    })
}

function setDay(day) {
  set({ day: day, month: String(day).slice(0, 7) })
  return refresh(day)
}

/**
 * Page the calendar to another month.
 *
 * The open day is left alone: paging months is browsing, not navigating. The
 * user picks a date when they mean to go there, and picking one calls `setDay`.
 */
function setMonth(month) {
  set({ month: month })
  return refresh()
}

async function saveSettings(patch) {
  var payload = await request('/settings', { method: 'POST', body: JSON.stringify({ settings: patch }) })
  set({ snapshot: Object.assign({}, state.snapshot, { settings: payload.settings }) })
  return payload.settings
}

async function previewWorkbook(options) {
  set({ importState: Object.assign({}, state.importState, { status: 'loading', message: '正在读取 Excel…', error: null }) })
  try {
    var payload = await request('/preview', { method: 'POST', body: JSON.stringify(options || {}) })
    set({
      importState: {
        status: 'preview',
        message: '识别到工作表「' + payload.sheet + '」，表头在第 ' + payload.headerRow + ' 行，共 ' + payload.rowCount + ' 行数据。',
        preview: payload,
        analysis: state.importState.analysis,
        error: null,
      },
    })
    return payload
  } catch (error) {
    set({
      importState: {
        status: 'error',
        message: '',
        preview: null,
        analysis: null,
        error: String((error && error.message) || error),
      },
    })
    throw error
  }
}

/**
 * Read the workbook and let the host explain it.
 *
 * One action covers what used to take three: locate the file, work out what the
 * sheet is, and propose a mapping. The result carries both the proposal and the
 * preview rows, so the panel can render a verdict the user can accept in one
 * click or correct field by field.
 */
async function analyzeWorkbook(options) {
  // A workbook read and a document read are two pending confirmations for the
  // same schedule; only one may be on screen at a time.
  if (state.extractState.status !== 'idle') resetExtraction()
  set({
    importState: Object.assign({}, state.importState, {
      status: 'analyzing',
      message: '正在读这份表，判断版式和字段…',
      error: null,
    }),
  })
  try {
    var payload = await request('/analyze', { method: 'POST', body: JSON.stringify(options || {}) })
    var analysis = payload.analysis || {}
    var note = ''
    if (analysis.mode !== 'model') {
      note = analysis.modelDetail
        ? '本机判断（' + analysis.modelDetail + '）'
        : '本机判断（没有可用的模型）'
    }
    set({
      importState: {
        status: 'ready',
        message: analysis.summary || '已读完这份表。',
        preview: payload,
        analysis: analysis,
        error: null,
        modelNote: note,
      },
    })
    return payload
  } catch (error) {
    set({
      importState: Object.assign({}, state.importState, {
        status: 'error',
        message: '',
        error: String((error && error.message) || error),
      }),
    })
    throw error
  }
}

/**
 * Clear the import draft, so the panel goes back to "pick a file".
 *
 * The confirmation step is a *place* in the panel, not a toast: after importing,
 * the panel says so and offers to import another roster. Leaving the previous
 * file's verdict on screen made that second import look like it would replace the
 * first one.
 */
function resetImport() {
  set({
    importState: {
      status: 'idle',
      message: '',
      preview: null,
      analysis: null,
      error: null,
      modelNote: '',
    },
  })
}

async function runImport(options) {
  set({ importState: Object.assign({}, state.importState, { status: 'loading', message: '正在抓取属于你的日程…', error: null }) })
  try {
    var payload = await request('/import', { method: 'POST', body: JSON.stringify(options || {}) })
    if (!payload.ok) throw new Error(payload.error || '导入失败')
    var excel = payload.excel || {}
    // The import covers every configured roster, not only the file just
    // confirmed — saying so here is what stops "the second import replaced the
    // first" from being a reasonable reading of the panel.
    var fileCount = util.safeArray(excel.sources).length
    set({
      importState: {
        status: 'done',
        message:
          '已抓取 ' +
          (excel.importedCount || 0) +
          ' 条日程' +
          (fileCount > 1 ? '（共 ' + fileCount + ' 份表一起导入）' : '') +
          '，跳过 ' +
          (excel.filteredCount || 0) +
          ' 条不属于你的行' +
          (excel.carriedCount > 0 ? '；另有 ' + excel.carriedCount + ' 条来自暂时读不到的表，先保留着' : '') +
          '。',
        preview: state.importState.preview,
        analysis: state.importState.analysis,
        error: null,
        modelNote: state.importState.modelNote,
      },
      snapshot: payload.snapshot || state.snapshot,
    })
    return payload.excel
  } catch (error) {
    set({ importState: Object.assign({}, state.importState, { status: 'error', error: String((error && error.message) || error) }) })
    throw error
  }
}

function idleExtraction() {
  return { status: 'idle', message: '', source: null, analysis: null, plan: null, draft: [], error: null }
}

function resetExtraction() {
  set({ extractState: idleExtraction() })
}

/**
 * Read a document, a picture or pasted text into candidate events.
 *
 * This is a *reading*, not an import: nothing lands on the timeline until
 * `commitExtraction`. An open workbook draft is dropped first so the page only
 * ever shows one pending confirmation.
 */
async function extractSource(options) {
  if (state.importState.status !== 'idle') resetImport()
  set({
    extractState: Object.assign(idleExtraction(), {
      status: 'reading',
      message: '正在读这份资料，找里面的日期和时间…',
    }),
  })
  try {
    var payload = await request('/extract', { method: 'POST', body: JSON.stringify(options || {}) })
    var analysis = payload.analysis || {}
    var draft = util.safeArray(analysis.events).map(function (event, index) {
      return Object.assign({}, event, { key: 'x' + index, include: true })
    })
    set({
      extractState: {
        status: 'ready',
        message: analysis.summary || '',
        source: payload.source || null,
        analysis: analysis,
        plan: payload.plan || null,
        draft: draft,
        error: null,
      },
    })
    return payload
  } catch (error) {
    var reason = String((error && error.message) || error)
    /**
     * A host that predates this feature has no `/extract` route, while the page
     * is the half that can be refreshed independently. Ask the host what it can
     * do before blaming the file: `/health` carries a capability list in this
     * build, and an older one does not.
     */
    try {
      var health = await request('/health')
      if (!(health && Array.isArray(health.capabilities) && health.capabilities.indexOf('read-documents') >= 0)) {
        reason = '宿主进程还不认识「读资料」这个动作，它还是启动时加载的旧版本。关掉 DeepSeek Harness（托盘退出）再打开，然后刷新页面。'
      }
    } catch (probeError) {
      /* the original failure is the one worth showing */
    }
    set({
      extractState: Object.assign(idleExtraction(), {
        status: 'error',
        error: reason,
      }),
    })
    throw error
  }
}

/** Replace one draft row's fields as the user edits it. */
function updateExtraction(key, patch) {
  var draft = state.extractState.draft.map(function (event) {
    return event.key === key ? Object.assign({}, event, patch) : event
  })
  set({ extractState: Object.assign({}, state.extractState, { draft: draft }) })
}

function toggleExtraction(key) {
  var draft = state.extractState.draft.map(function (event) {
    return event.key === key ? Object.assign({}, event, { include: event.include === false }) : event
  })
  set({ extractState: Object.assign({}, state.extractState, { draft: draft }) })
}

function selectAllExtraction(include) {
  var draft = state.extractState.draft.map(function (event) {
    return Object.assign({}, event, { include: include === true })
  })
  set({ extractState: Object.assign({}, state.extractState, { draft: draft }) })
}

/**
 * Put the ticked rows on the schedule, and open the day they land on.
 *
 * The day comes from the rows themselves: a notice read on Thursday for next
 * Monday should not leave the user staring at an unchanged Thursday timeline
 * wondering whether it worked.
 */
async function commitExtraction() {
  var current = state.extractState
  var included = current.draft.filter(function (event) {
    return event.include !== false
  })
  if (included.length === 0) throw new Error('先勾选至少一条日程。')
  var source = current.source || {}
  var events = included.map(function (event) {
    return {
      date: event.date,
      start: event.start,
      end: event.end,
      title: event.title,
      location: event.location,
      notes: event.notes,
      person: event.person,
      confidence: event.confidence,
    }
  })
  var dates = events
    .map(function (event) {
      return event.date
    })
    .filter(function (date) {
      return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    })
    .sort()
  var day = dates.length > 0 ? dates[0] : state.day
  set({ extractState: Object.assign({}, current, { status: 'saving', message: '正在把勾选的日程写进时间轴…', error: null }) })
  try {
    var query = '/extract/commit?day=' + encodeURIComponent(day) + '&month=' + encodeURIComponent(day.slice(0, 7))
    var payload = await request(query, {
      method: 'POST',
      body: JSON.stringify({ file: source.file, path: source.path, events: events }),
    })
    var skipped = util.safeArray(payload.skipped)
    set({
      day: day,
      month: day.slice(0, 7),
      snapshot: payload.snapshot || state.snapshot,
      extractState: Object.assign({}, state.extractState, {
        status: 'done',
        message:
          '已加入 ' +
          (payload.added || 0) +
          ' 条日程' +
          (skipped.length > 0 ? '；另外 ' + skipped.length + ' 条已经在日程里，没有重复添加' : '') +
          '。',
        draft: [],
      }),
    })
    return payload
  } catch (error) {
    set({
      extractState: Object.assign({}, state.extractState, {
        status: 'ready',
        error: String((error && error.message) || error),
      }),
    })
    throw error
  }
}

async function eventAction(action, body) {
  var payload = await request('/events', {
    method: 'POST',
    body: JSON.stringify(Object.assign({ action: action }, body || {})),
  })
  if (payload.snapshot) set({ snapshot: payload.snapshot })
  return payload
}

/**
 * Add one event by hand, and show the day it landed on.
 *
 * `POST /events add` marks the row as hand-added, which is what keeps it out of
 * the next Excel import's way — see the host's `MANUAL_SHEET`. Opening the day it
 * landed on is part of the action: an event added for the 20th while the 15th is
 * on screen would otherwise look like it went nowhere.
 */
async function addEvent(draft) {
  var date = String(draft.date || '')
  if (date !== '' && date !== state.day) set({ day: date, month: date.slice(0, 7) })
  await request('/events', { method: 'POST', body: JSON.stringify({ action: 'add', event: draft }) })
  await refresh(state.day)
  return state.day
}

async function removeEvent(id) {
  var payload = await request('/events', { method: 'POST', body: JSON.stringify({ action: 'remove', id: id }) })
  if (payload.snapshot) set({ snapshot: payload.snapshot })
  else await refresh(state.day)
  return payload
}

async function timerAction(action, body) {
  var payload = await request('/timer', {
    method: 'POST',
    body: JSON.stringify(Object.assign({ action: action }, body || {})),
  })
  if (payload.timer) {
    set({ snapshot: Object.assign({}, state.snapshot, { timer: payload.timer }) })
  }
  return payload
}

/**
 * The prior turns to send with a question, as plain role/text pairs. The host
 * decides how many to keep; sending a little more than needed keeps that policy
 * in one place.
 */
function conversationHistory() {
  var out = []
  var messages = state.companion.messages
  for (var i = 0; i < messages.length; i += 1) {
    var message = messages[i]
    if (message.greeting === true) continue
    if (message.role === 'user' && typeof message.text === 'string' && message.text.trim() !== '') {
      out.push({ role: 'user', text: message.text.trim() })
    } else if (message.role === 'ai' && typeof message.speak === 'string' && message.speak.trim() !== '') {
      out.push({ role: 'assistant', text: message.speak.trim() })
    }
  }
  return out.slice(-8)
}

async function askCompanion(action, extra) {
  var current = state.companion
  var question = (extra && extra.question) || ''
  var pendingId = 'u_' + Date.now()
  var messages = current.messages.slice()
  if (question !== '') {
    messages.push({ id: pendingId, role: 'user', text: question })
  }
  var history = conversationHistory()
  set({ companion: { messages: messages, busy: true } })
  try {
    var payload = await request('/assistant', {
      method: 'POST',
      body: JSON.stringify(Object.assign({ action: action, history: history }, extra || {})),
    })
    var reply = payload.reply || {}
    var next = messages.slice()
    if (question === '' && action !== 'brief') {
      next.push({ id: 'u_' + Date.now(), role: 'user', text: labelOfAction(action) })
    }
    next.push({
      id: 'ai_' + Date.now(),
      role: 'ai',
      speak: reply.speak || '',
      detail: reply.detail || '',
      chips: reply.chips || [],
      mode: reply.mode || 'local',
      fallback: reply.fallback || null,
    })
    set({
      companion: { messages: next.slice(-24), busy: false },
      snapshot: payload.snapshot || state.snapshot,
      assistant: payload.status || state.assistant,
    })
    return reply
  } catch (error) {
    var failed = messages.slice()
    failed.push({ id: 'err_' + Date.now(), role: 'ai', speak: '我这会儿联系不上宿主进程。', detail: String((error && error.message) || error) })
    set({ companion: { messages: failed.slice(-24), busy: false } })
    throw error
  }
}

/** Refresh the companion capability label without asking a question. */
async function refreshAssistantStatus() {
  try {
    var payload = await request('/assistant', { method: 'POST', body: JSON.stringify({ action: 'status' }) })
    if (payload && payload.status) set({ assistant: payload.status })
    return payload ? payload.status : null
  } catch (error) {
    return null
  }
}

var ACTION_LABELS = {
  brief: '生成今日简报',
  prep: '准备下一个日程',
  focus: '帮我开始专注',
  review: '复盘今天的进度',
  gap: '分析我的空档',
  mood: '给我一点状态建议',
}

function labelOfAction(action) {
  return ACTION_LABELS[action] || action
}

function pushNotice(notice) {
  var id = 'n_' + Date.now() + '_' + Math.round(Math.random() * 1000)
  var entry = Object.assign({ id: id, at: Date.now() }, notice)
  set({ notices: state.notices.concat([entry]).slice(-4) })
  if (entry.sticky !== true) {
    setTimeout(function () {
      dismissNotice(id)
    }, entry.ttlMs || 15_000)
  }
  return id
}

function dismissNotice(id) {
  var next = state.notices.filter(function (notice) {
    return notice.id !== id
  })
  if (next.length !== state.notices.length) set({ notices: next })
}

async function clearFeed() {
  await request('/feed', { method: 'DELETE' })
  set({ snapshot: Object.assign({}, state.snapshot, { feed: [] }) })
}

async function openFloatWindow() {
  // The desktop shell denies `window.open` to pages, so the floating widget is a
  // host-spawned always-on-top process instead of a browser popup.
  var payload = await request('/hud', { method: 'POST', body: JSON.stringify({ action: 'start' }) })
  if (!payload.ok) {
    pushNotice({ level: 'warn', title: '悬浮窗启动失败', body: payload.error || '未知原因' })
  } else if (payload.running === false) {
    // The widget is not broken — the user closed it. Say so instead of claiming
    // a launch that deliberately did not happen.
    pushNotice({ level: 'info', title: '悬浮窗保持关闭', body: '你之前用悬浮窗上的 × 关掉了它。点「重新显示」可以再打开。' })
  } else {
    pushNotice({ level: 'info', title: '悬浮窗已启动', body: '胶囊上的 — 最小化为小圆点，× 关闭；按住窗口任意位置可以拖动。右键或双击还有更多操作。' })
  }
  set({ floatOpen: payload.ok === true && payload.running !== false, hudMode: payload.mode || null })
  return payload
}

async function stopFloatWindow() {
  var payload = await request('/hud', { method: 'POST', body: JSON.stringify({ action: 'stop' }) })
  set({ floatOpen: false })
  return payload
}

/**
 * Switch the widget between its three states.
 *
 * `mini` and `restore` are the panel's mirror of the widget's own — and ×
 * buttons; the widget is the one that owns the transition, so these just tell
 * the host which state to launch it in.
 */
async function setFloatMode(mode) {
  var action = mode === 'mini' ? 'minimize' : mode === 'closed' ? 'stop' : 'restore'
  var payload = await request('/hud', { method: 'POST', body: JSON.stringify({ action: action }) })
  if (payload && payload.ok === false) {
    pushNotice({ level: 'warn', title: '悬浮窗操作失败', body: payload.error || '未知原因' })
  }
  set({ hudMode: payload ? payload.mode || mode : null, floatOpen: payload ? payload.running === true : false })
  return payload
}

async function hudStatus() {
  var payload = await request('/hud', { method: 'GET' })
  set({ hudMode: payload.mode || null, hudClosedByUser: payload.closedByUser === true, floatOpen: payload.running === true })
  return payload
}

/**
 * Diagnostics channel.
 *
 * These fire from the page and land on the host's `/debug`, which is the only
 * way to tell "the click never arrived" from "the handler threw": a path that
 * never increments proves the DOM never delivered the event at all. Failures are
 * swallowed on purpose — a diagnostic must never break the feature it measures.
 */
async function reportUiEvent(name, card) {
  try {
    await request('/debug/client', {
      method: 'POST',
      body: JSON.stringify({ kind: 'event', name: name, at: new Date().toISOString(), card: card || null }),
    })
  } catch (error) {
    /* diagnostics only */
  }
}

async function reportOverlayLayout(layout) {
  try {
    await request('/debug/client', {
      method: 'POST',
      body: JSON.stringify({ kind: 'layout', at: new Date().toISOString(), layout: layout }),
    })
  } catch (error) {
    /* diagnostics only */
  }
}

var polling = null
var noticeSeq = 0
var stream = null

function ingestFeed(feed) {
  var list = util.safeArray(feed)
  var highest = noticeSeq
  var fresh = []
  for (var i = 0; i < list.length; i += 1) {
    var entry = list[i]
    if (typeof entry.seq === 'number' && entry.seq > noticeSeq) {
      if (entry.seq > highest) highest = entry.seq
      fresh.push(entry)
    }
  }
  noticeSeq = highest
  for (var j = fresh.length - 1; j >= 0; j -= 1) {
    var item = fresh[j]
    if (item.kind === 'reminder' || item.level === 'urgent') {
      pushNotice({
        level: item.level === 'urgent' ? 'urgent' : 'info',
        title: item.title,
        body: item.body,
        eventId: item.eventId,
        actions: item.actions,
        ttlMs: item.level === 'urgent' ? 45_000 : 25_000,
      })
    }
  }
}

function openStream() {
  if (typeof EventSource !== 'function') return
  try {
    stream = new EventSource(API + '/events-stream')
    stream.onmessage = function (message) {
      try {
        var payload = JSON.parse(message.data)
        if (payload && payload.type === 'feed' && payload.entry) {
          ingestFeed([payload.entry])
          scheduleRefresh()
        } else if (payload && (payload.type === 'reminder' || payload.type === 'import')) {
          scheduleRefresh()
        }
      } catch (error) {
        console.error('[orbit-time] stream frame failed', error)
      }
    }
    stream.onerror = function () {
      /* EventSource reconnects on its own. */
    }
  } catch (error) {
    console.error('[orbit-time] stream unavailable', error)
  }
}

var refreshTimer = null
function scheduleRefresh() {
  if (refreshTimer !== null) return
  refreshTimer = setTimeout(function () {
    refreshTimer = null
    void refresh().catch(function () {})
  }, 400)
}

function bootstrap() {
  if (polling !== null) return
  set({ loading: true })
  checkHostBuild()
  void refresh()
    .then(function (payload) {
      if (payload && Array.isArray(payload.feed)) {
        // Seed the notice cursor so a page load does not replay old reminders.
        for (var i = 0; i < payload.feed.length; i += 1) {
          var seq = payload.feed[i].seq
          if (typeof seq === 'number' && seq > noticeSeq) noticeSeq = seq
        }
        ingestFeed(payload.feed)
      }
    })
    .catch(function () {})
  polling = setInterval(function () {
    void refresh().catch(function () {})
  }, 4000)
  openStream()
}

function shutdown() {
  if (polling !== null) {
    clearInterval(polling)
    polling = null
  }
  if (stream !== null) {
    try {
      stream.close()
    } catch (error) {
      /* ignore */
    }
    stream = null
  }
}

function currentTimer(nowMs) {
  var timer = (state.snapshot && state.snapshot.timer) || null
  if (timer === null) return null
  var remaining = timer.remainingMs || 0
  if (timer.running && timer.endsAt) {
    remaining = Math.max(0, timer.endsAt - nowMs)
  }
  var phaseMinutes =
    timer.phase === 'focus'
      ? timer.config.focusMinutes
      : timer.phase === 'short'
        ? timer.config.shortBreakMinutes
        : timer.phase === 'long'
          ? timer.config.longBreakMinutes
          : 0
  var totalMs = phaseMinutes * 60_000
  return {
    phase: timer.phase,
    running: timer.running,
    remainingMs: remaining,
    totalMs: totalMs,
    progress: totalMs > 0 ? util.clamp(1 - remaining / totalMs, 0, 1) : 0,
    round: timer.round,
    completedToday: timer.completedToday,
    subject: timer.subject,
    config: timer.config,
  }
}

exports.store = {
  get: get,
  subscribe: subscribe,
  set: set,
  request: request,
  refresh: refresh,
  setDay: setDay,
  setMonth: setMonth,
  saveSettings: saveSettings,
  previewWorkbook: previewWorkbook,
  analyzeWorkbook: analyzeWorkbook,
  resetImport: resetImport,
  runImport: runImport,
  extractSource: extractSource,
  resetExtraction: resetExtraction,
  updateExtraction: updateExtraction,
  toggleExtraction: toggleExtraction,
  selectAllExtraction: selectAllExtraction,
  commitExtraction: commitExtraction,
  eventAction: eventAction,
  addEvent: addEvent,
  removeEvent: removeEvent,
  timerAction: timerAction,
  askCompanion: askCompanion,
  refreshAssistantStatus: refreshAssistantStatus,
  conversationHistory: conversationHistory,
  pushNotice: pushNotice,
  dismissNotice: dismissNotice,
  clearFeed: clearFeed,
  openFloatWindow: openFloatWindow,
  stopFloatWindow: stopFloatWindow,
  setFloatMode: setFloatMode,
  hudStatus: hudStatus,
  reportUiEvent: reportUiEvent,
  reportOverlayLayout: reportOverlayLayout,
  checkHostBuild: checkHostBuild,
  bootstrap: bootstrap,
  shutdown: shutdown,
  currentTimer: currentTimer,
  ACTION_LABELS: ACTION_LABELS,
}
