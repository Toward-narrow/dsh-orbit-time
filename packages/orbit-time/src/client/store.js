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
  /**
   * The corner stack, and it now only ever carries *reminders*.
   *
   * Every action that reported its result used to push a card here as well —
   * "已加进日程", "已删除", "已保存关注姓名" — and each one had to be dismissed by
   * hand while the page already showed the result (the row is on the timeline,
   * the count changed, the field kept its value). A reminder is the one kind of
   * message that genuinely arrives from nowhere and needs an action, so it is
   * the only kind that still floats over the panel.
   */
  notices: [],
  /**
   * The last click that could not do what it promised, shown in the page.
   *
   * Not a toast: a block in the panel body, belonging to no corner, never on a
   * timer. It exists for actions with no card of their own (the header's
   * floating-window button, the in-window mini card); actions that do have a
   * card render their own error next to themselves.
   */
  actionReport: null,
  floatOpen: false,
  /**
   * Reading deadlines off course sites.
   *
   * The password deliberately does **not** live here: it is a field of the login
   * form, passed straight to the host, and the host either discards it or hands
   * it to DPAPI. Keeping it in the page's shared state would leave it in memory
   * for the whole session and show it to every component that reads the store.
   */
  netddl: {
    platform: 'icourse163',
    status: null,
    /** Which step is running: '' | 'status' | 'login' | 'courses' | 'pull' | 'page' | 'commit' | 'logout'. */
    busy: '',
    message: '',
    /** How the last message should read: 'ok' | 'warn'. */
    level: 'ok',
    error: '',
    /** The host half predates the iframe/login/course fixes; actions would fail. */
    hostStale: false,
    courses: [],
    items: [],
    notes: [],
    page: null,
  },  /**
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
  /**
   * A long operation (a login the user is still finishing) must not leave the
   * panel waiting forever if the host dies mid-request: `fetch` has no timeout of
   * its own, so a dead socket pins the card at "等你登录…" with no way back.
   */
  var timeoutMs = init.timeoutMs
  delete init.timeoutMs
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    try {
      init.signal = AbortSignal.timeout(timeoutMs)
    } catch (error) {
      delete init.signal
    }
  }
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

/**
 * Put one reminder on the floating stack.
 *
 * Only the feed uses this (see `ingestFeed`), and only for entries the host
 * marked as reminders. Everything else that used to report back through a toast
 * now either says nothing (the result is the feedback) or says it inline —
 * `reportAction` for the few actions with no card, `ui.note` for the rest.
 */
function pushReminder(notice) {
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

/**
 * Report a click result in the panel itself.
 *
 * This is what is left of the "tell the user what happened" channel: one line
 * in the page body, replaced by the next result and dismissed by hand. It never
 * floats over the panel and never fades, so it cannot be the same complaint the
 * corner toast was. Successes do not use it at all — the page already changed.
 */
function reportAction(level, title, body) {
  set({
    actionReport: {
      id: 'r_' + Date.now() + '_' + Math.round(Math.random() * 1000),
      level: level || 'error',
      title: title || '',
      body: body === undefined || body === null ? '' : String(body),
    },
  })
}

function dismissActionReport() {
  if (state.actionReport !== null) set({ actionReport: null })
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
  //
  // The outcome is the caller's to show: the settings card renders it in place,
  // and the header button has no card of its own (`reportAction`). No toast.
  var payload = await request('/hud', { method: 'POST', body: JSON.stringify({ action: 'start' }) })
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
  // The status the card shows is the payload itself; a failed switch is reported
  // by the card that asked for it, in place.
  var payload = await request('/hud', { method: 'POST', body: JSON.stringify({ action: action }) })
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
      pushReminder({
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

/** Merge one field into the network-reader slice without dropping the rest. */
function netddlPatch(patch) {
  set({ netddl: Object.assign({}, state.netddl, patch) })
}

/**
 * A stale host would run the old login flow and hang for minutes; refuse before
 * the request instead of letting the click look like a freeze.
 */
function requireCurrentNetHost() {
  if (state.netddl.hostStale !== true) return
  var message = '宿主进程还是旧版「网络 DDL」：先托盘退出 DeepSeek Harness 再打开，然后刷新页面再试。'
  netddlPatch({ busy: '', error: message })
  throw new Error(message)
}

/** Ask the host what it knows: browser found, profile dir, saved accounts. */
async function refreshNetDdl() {
  try {
    var status = await request('/netddl/status', { timeoutMs: 10000 })
    /**
     * A refreshed page always gets the new client bundle, but the host half was
     * imported at app start. If it predates the iframe/saved-account login, the
     * panel must say so: otherwise the fix looks like it did nothing.
     */
    var hostStale = !(status && Number(status.api) >= 4)
    netddlPatch({
      status: status,
      hostStale: hostStale,
      error: hostStale
        ? '宿主进程还是旧版「网络 DDL」——它启动时加载的代码没有这次登录修复。关掉 DeepSeek Harness（托盘退出）再打开，然后刷新页面；只刷新页面换不掉宿主。'
        : '',
    })
    return status
  } catch (error) {
    var reason = String((error && error.message) || error)
    /**
     * A 404 here is almost never the user's fault: the page is the half that can
     * be refreshed, while the host is loaded once at app start. Ask `/health`
     * what this host generation can do before blaming anything else.
     */
    try {
      var health = await request('/health')
      if (!(health && Array.isArray(health.capabilities) && health.capabilities.indexOf('web-ddl') >= 0)) {
        reason = '宿主进程还不认识「网络 DDL」——它还是启动时加载的旧版本。关掉 DeepSeek Harness（托盘退出）再打开，然后刷新页面。'
      }
    } catch (probeError) {
      /* the original failure is the one worth showing */
    }
    netddlPatch({ error: reason })
    return null
  }
}

function netDdlSetPlatform(platform) {
  if (platform === state.netddl.platform) return
  netddlPatch({ platform: platform, courses: [], items: [], notes: [], page: null, message: '', error: '' })
}

/**
 * Open the login window and wait for it to succeed.
 *
 * This call can take a couple of minutes on purpose: the window is handed to the
 * user so they can solve a captcha, scan a QR code, or type an SMS code, and the
 * host keeps asking the site until it says the session is real. The panel says
 * so rather than looking frozen.
 */
async function netDdlLogin(options) {
  requireCurrentNetHost()
  var body = options || {}
  netddlPatch({
    busy: 'login',
    error: '',
    level: 'ok',
    // Two phases behind one message: the host takes a few seconds to launch the
    // browser, and a window that has not appeared yet otherwise reads as a hang.
    message: '正在启动浏览器窗口（第一次要几秒）。窗口出来后在里面登录——扫码、短信验证、拖滑块都行，登录成功这里会自己继续…',
  })
  try {
    var payload = await request('/netddl/login', {
      method: 'POST',
      body: JSON.stringify({ platform: state.netddl.platform, url: body.url || '', username: body.username || '', password: body.password || '', remember: body.remember !== false }),
      // The host waits for the person to finish a captcha / SMS for up to 150 s.
      timeoutMs: 200_000,
    })
    netddlPatch({
      busy: '',
      level: payload.loggedIn === true ? 'ok' : 'warn',
      message:
        payload.loggedIn === true
          ? '登录成功，这把浏览器档案会记住它。' +
            (payload.usedSaved
              ? '（用的是记住的账号）'
              : payload.remembered
                ? '密码已用 DPAPI 加密保存。'
                : payload.rememberNote || '')
          : payload.note || payload.error || '没等到登录成功。',
      // A refusal (headless install, no browser) is an explanation, not a failure
      // of the page: keep it in the same place the success message lives.
      error: '',
    })
    void refreshNetDdl()
    return payload
  } catch (error) {
    netddlPatch({ busy: '', error: String((error && error.message) || error) })
    throw error
  }
}

async function netDdlCheck() {
  requireCurrentNetHost()
  netddlPatch({ busy: 'check', error: '', message: '' })
  try {
    var payload = await request('/netddl/check', { method: 'POST', body: JSON.stringify({ platform: state.netddl.platform }), timeoutMs: 60_000 })
    netddlPatch({
      busy: '',
      level: payload.loggedIn === true ? 'ok' : 'warn',
      message: payload.loggedIn === true ? '登录还有效。' : payload.unknown === true ? payload.note || '浏览器还没启动：先登录，或直接抓一次——抓的时候会顺手确认登录态。' : '已经掉登录了，重新登一次。',
    })
    return payload
  } catch (error) {
    netddlPatch({ busy: '', error: String((error && error.message) || error) })
    throw error
  }
}

/** List the courses on the account, so the user picks what to read. */
async function netDdlScanCourses() {
  requireCurrentNetHost()
  netddlPatch({ busy: 'courses', error: '', message: '正在读「我的课程」…', items: [], notes: [], page: null })
  try {
    var payload = await request('/netddl/courses', { method: 'POST', body: JSON.stringify({ platform: state.netddl.platform }), timeoutMs: 150_000 })
    var courses = util.safeArray(payload.courses).map(function (course) {
      // A course whose term ended cannot have a future deadline; showing it is
      // still useful ("my course list is complete"), but ticking it would only
      // make the pull read a closed page.
      return Object.assign({}, course, { checked: course.ended !== true })
    })
    netddlPatch({
      busy: '',
      courses: courses,
      level: payload.ok === true ? 'ok' : 'warn',
      message: payload.ok === true ? '找到 ' + courses.length + ' 门课。' : payload.error || '没读到课程。',
      error: '',
      status: state.netddl.status,
    })
    void refreshNetDdl()
    return payload
  } catch (error) {
    netddlPatch({ busy: '', error: String((error && error.message) || error) })
    throw error
  }
}

function netDdlToggleCourse(id) {
  var courses = state.netddl.courses.map(function (course) {
    return course.id === id ? Object.assign({}, course, { checked: course.checked !== true }) : course
  })
  netddlPatch({ courses: courses })
}

function netDdlCheckAll(include) {
  var courses = state.netddl.courses.map(function (course) {
    return Object.assign({}, course, { checked: include === true })
  })
  netddlPatch({ courses: courses })
}

/**
 * Read every ticked course's deadline page.
 *
 * Nothing lands on the timeline here: the result is a proposal the user ticks
 * through, exactly like a document read. A scraper that writes straight to the
 * schedule would make a bad selector look like a scheduling decision.
 */
async function netDdlPull(options) {
  requireCurrentNetHost()
  var body = options || {}
  var chosen = state.netddl.courses.filter(function (course) {
    return course.checked === true
  })
  if (chosen.length === 0) throw new Error('先勾选至少一门课。')
  netddlPatch({ busy: 'pull', error: '', message: '正在逐门课读截止时间，课程多的话要等一会儿…' })
  try {
    var payload = await request('/netddl/pull', {
      method: 'POST',
      body: JSON.stringify({ platform: state.netddl.platform, courses: chosen, horizonDays: body.horizonDays || 180 }),
      timeoutMs: 300_000,
    })
    var nowMs = Date.now()
    var items = util.safeArray(payload.items).map(function (item, index) {
      // The deadline page keeps a few rows from earlier today (a submission that
      // closed at noon); show them, but do not tick a deadline that has passed.
      var future = typeof item.dueMs === 'number' ? item.dueMs >= nowMs : true
      return Object.assign({}, item, { key: item.key || 'w' + index, include: future })
    })
    netddlPatch({
      busy: '',
      items: items,
      notes: util.safeArray(payload.notes),
      page: null,
      level: items.length > 0 ? 'ok' : 'warn',
      message: items.length + ' 个截止时间，勾掉不想要的再入库。',
      error: '',
    })
    return payload
  } catch (error) {
    netddlPatch({ busy: '', error: String((error && error.message) || error) })
    throw error
  }
}

/** Read one arbitrary URL, filling a login form when credentials are given. */
async function netDdlReadPage(options) {
  requireCurrentNetHost()
  var body = options || {}
  netddlPatch({ busy: 'page', error: '', message: '正在打开这个页面…', items: [], notes: [], page: null, courses: [] })
  try {
    var payload = await request('/netddl/page', {
      method: 'POST',
      body: JSON.stringify({
        url: body.url,
        username: body.username || '',
        password: body.password || '',
        remember: body.remember !== false,
        label: body.label || '',
        horizonDays: body.horizonDays || 180,
      }),
      timeoutMs: 200_000,
    })
    var items = util.safeArray(payload.items).map(function (item, index) {
      return Object.assign({}, item, { key: item.key || 'w' + index, include: true })
    })
    netddlPatch({
      busy: '',
      items: items,
      notes: util.safeArray(payload.notes),
      page: payload.page || null,
      level: items.length > 0 ? 'ok' : 'warn',
      message: (payload.loginNote ? payload.loginNote + ' ' : '') + items.length + ' 个截止时间。',
      error: '',
    })
    return payload
  } catch (error) {
    netddlPatch({ busy: '', error: String((error && error.message) || error) })
    throw error
  }
}

/**
 * Read an arbitrary site with the model as the interpreter.
 *
 * The host does the browsing; the model plans which real links to follow and
 * decides which visible moments matter (deadlines, exams, registration windows,
 * lectures — not only DDLs). The page remains the source of truth: every item
 * carries an evidence line and a source URL.
 */
async function netDdlReadSite(options) {
  requireCurrentNetHost()
  var body = options || {}
  netddlPatch({
    busy: 'ai',
    error: '',
    message: 'AI 正在看这个网站：先判断页面结构，再决定跟进哪几个链接…',
    items: [],
    notes: [],
    page: null,
    courses: [],
  })
  try {
    var payload = await request('/netddl/ai', {
      method: 'POST',
      body: JSON.stringify({
        url: body.url,
        username: body.username || '',
        password: body.password || '',
        remember: body.remember !== false,
        label: body.label || '',
        horizonDays: body.horizonDays || 180,
      }),
      timeoutMs: 300_000,
    })
    var nowMs = Date.now()
    var items = util.safeArray(payload.items).map(function (item, index) {
      var future = typeof item.dueMs === 'number' ? item.dueMs >= nowMs : true
      return Object.assign({}, item, { key: item.key || 'w' + index, include: future })
    })
    var pages = util.safeArray(payload.pages)
    var modelLabel = payload.model && payload.model.model ? payload.model.model : ''
    var notes = util.safeArray(payload.notes)
    if (payload.loginNote) notes = notes.concat([payload.loginNote])
    netddlPatch({
      busy: '',
      items: items,
      notes: notes,
      page: payload.page || null,
      level: items.length > 0 ? 'ok' : 'warn',
      message:
        payload.mode === 'ai'
          ? 'AI 看了 ' + pages.length + ' 个页面（' + (modelLabel || '默认模型') + '），挑出 ' + items.length + ' 个时间节点。'
          : 'AI 不可用，按本地规则读了 ' + pages.length + ' 个页面，找到 ' + items.length + ' 条。',
      error: '',
    })
    return payload
  } catch (error) {
    netddlPatch({ busy: '', error: String((error && error.message) || error) })
    throw error
  }
}

function netDdlToggleItem(key) {
  var items = state.netddl.items.map(function (item) {
    return item.key === key ? Object.assign({}, item, { include: item.include === false }) : item
  })
  netddlPatch({ items: items })
}

function netDdlSelectAll(include) {
  var items = state.netddl.items.map(function (item) {
    return Object.assign({}, item, { include: include === true })
  })
  netddlPatch({ items: items })
}

/**
 * Put the ticked deadlines on the schedule and open the earliest day.
 *
 * Same reasoning as the document flow: the day comes from the rows, so a
 * December deadline read in November does not leave the user staring at an
 * unchanged November timeline.
 */
async function netDdlCommit() {
  var included = state.netddl.items.filter(function (item) {
    return item.include !== false
  })
  if (included.length === 0) throw new Error('先勾选至少一个时间节点。')
  netddlPatch({ busy: 'commit', error: '', message: '正在写进时间轴…' })
  try {
    /**
     * Ask for the day the earliest deadline lands on, not the day that happens to
     * be open: a December deadline filed in November should leave the user looking
     * at December, and the host builds the snapshot from the view it is asked for.
     */
    var earliest = included
      .map(function (item) {
        return item.dueDate
      })
      .filter(function (date) {
        return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      })
      .sort()[0]
    var query =
      earliest !== undefined
        ? '/netddl/commit?day=' + encodeURIComponent(earliest) + '&month=' + encodeURIComponent(earliest.slice(0, 7))
        : '/netddl/commit'
    var payload = await request(query, {
      method: 'POST',
      body: JSON.stringify({ items: included, platform: state.netddl.platform }),
    })
    var day = payload.firstDate || earliest || state.day
    set({
      snapshot: payload.snapshot || state.snapshot,
      day: day,
      month: String(day).slice(0, 7),
      netddl: Object.assign({}, state.netddl, {
        busy: '',
        items: [],
        notes: [],
        message: '已加入 ' + (payload.added || 0) + ' 条' + (payload.skipped && payload.skipped.length > 0 ? '；' + payload.skipped.length + ' 条已经在日程里，没有重复添加' : '') + '。',
        error: '',
      }),
    })
    return payload
  } catch (error) {
    netddlPatch({ busy: '', error: String((error && error.message) || error) })
    throw error
  }
}

async function netDdlLogout() {
  netddlPatch({ busy: 'logout', error: '', message: '' })
  try {
    var payload = await request('/netddl/logout', { method: 'POST', body: '{}' })
    netddlPatch({ busy: '', message: payload.ok === true ? '浏览器档案已清空，下次要重新登录。' : payload.error || '没清掉。', courses: [], items: [], page: null })
    void refreshNetDdl()
    return payload
  } catch (error) {
    netddlPatch({ busy: '', error: String((error && error.message) || error) })
    throw error
  }
}

function currentTimer(nowMs) {  var timer = (state.snapshot && state.snapshot.timer) || null
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
  pushReminder: pushReminder,
  dismissNotice: dismissNotice,
  reportAction: reportAction,
  dismissActionReport: dismissActionReport,
  clearFeed: clearFeed,
  openFloatWindow: openFloatWindow,
  stopFloatWindow: stopFloatWindow,
  setFloatMode: setFloatMode,
  hudStatus: hudStatus,
  reportUiEvent: reportUiEvent,
  reportOverlayLayout: reportOverlayLayout,
  checkHostBuild: checkHostBuild,
  refreshNetDdl: refreshNetDdl,
  netDdlSetPlatform: netDdlSetPlatform,
  netDdlLogin: netDdlLogin,
  netDdlCheck: netDdlCheck,
  netDdlScanCourses: netDdlScanCourses,
  netDdlToggleCourse: netDdlToggleCourse,
  netDdlCheckAll: netDdlCheckAll,
  netDdlPull: netDdlPull,
  netDdlReadPage: netDdlReadPage,
  netDdlReadSite: netDdlReadSite,
  netDdlToggleItem: netDdlToggleItem,
  netDdlSelectAll: netDdlSelectAll,
  netDdlCommit: netDdlCommit,
  netDdlLogout: netDdlLogout,
  bootstrap: bootstrap,
  shutdown: shutdown,
  currentTimer: currentTimer,
  ACTION_LABELS: ACTION_LABELS,
}
