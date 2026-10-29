/** Orbit Time client — dashboard shell, notices, and the floating mini widget. */

var util = require('./util.js')
var ui = require('./ui.js')
var store = require('./store.js')
var timeline = require('./timeline.js')
var pomodoro = require('./pomodoro.js')
var companion = require('./companion.js')
var importView = require('./import-view.js')
var settings = require('./settings.js')
var drag = require('./drag.js')
var React = util.React
var h = util.h

var TABS = [
  { id: 'timeline', label: '日程时间轴' },
  { id: 'pomodoro', label: '番茄专注' },
  { id: 'companion', label: 'AI 助手' },
  { id: 'settings', label: '设置 / 导入' },
]

/**
 * Report what the page's own layout says about this overlay entry.
 *
 * "The button does nothing" has exactly two possible causes — the click never
 * reaches the element (a stacking or pointer-events problem in an ancestor) or
 * it arrives and the handler fails — and they are indistinguishable from the
 * host side. The page is the only place that knows, so it sends the computed
 * styles of its ancestor chain plus its own bounding box, and the host exposes
 * them on /debug.
 */
function describeOverlayHost() {
  try {
    var roots = document.querySelectorAll('.ot-float-shell, .ot-float-mini, .ot-notices')
    var report = { found: roots.length, roots: [], ancestors: [], viewport: { w: window.innerWidth, h: window.innerHeight } }
    var stopAt = null
    for (var i = 0; i < roots.length; i += 1) {
      var node = roots[i]
      var box = node.getBoundingClientRect()
      report.roots.push({
        cls: String(node.className),
        pointerEvents: getComputedStyle(node).pointerEvents,
        zIndex: getComputedStyle(node).zIndex,
        rect: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
        // What is actually painted at the card's top-right button, which is the
        // question the user is really asking.
        hitAtButton: hitTest(node),
      })
      if (stopAt === null) stopAt = node
    }
    var walker = stopAt
    var depth = 0
    while (walker !== null && depth < 8) {
      var style = getComputedStyle(walker)
      var chainBox = walker.getBoundingClientRect()
      report.ancestors.push({
        tag: walker.tagName.toLowerCase(),
        cls: String(walker.className).slice(0, 80),
        pointerEvents: style.pointerEvents,
        zIndex: style.zIndex,
        position: style.position,
        overflow: style.overflow,
        rect: { x: Math.round(chainBox.x), y: Math.round(chainBox.y), w: Math.round(chainBox.width), h: Math.round(chainBox.height) },
      })
      walker = walker.parentElement
      depth += 1
    }
    return report
  } catch (error) {
    return { error: String((error && error.message) || error) }
  }
}

/** What element is on top at the card's header buttons. */
function hitTest(node) {
  try {
    var box = node.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return 'no box'
    var x = box.right - 30
    var y = box.top + 24
    var top = document.elementFromPoint(x, y)
    if (top === null) return 'nothing at ' + Math.round(x) + ',' + Math.round(y)
    var inOurs = top.closest && top.closest('.ot-float-shell, .ot-float-mini')
    return (inOurs ? 'ours: ' : 'THEIRS: ') + top.tagName.toLowerCase() + '.' + String(top.className).slice(0, 60)
  } catch (error) {
    return 'hit test failed: ' + String((error && error.message) || error)
  }
}

/** What a point inside the element's top-left corner actually hits. */
function hitAt(box) {
  if (box.width < 1 || box.height < 1) return 'no box'
  try {
    var top = document.elementFromPoint(box.left + Math.min(12, box.width / 2), box.top + Math.min(12, box.height / 2))
    if (top === null) return 'nothing'
    return top.tagName.toLowerCase() + '.' + String(top.className).slice(0, 34)
  } catch (error) {
    return 'failed'
  }
}

/** The drag's own notes, as the page last wrote them. */
function readDragLog() {
  try {
    var raw = window.localStorage.getItem('orbit-time.drag-log')
    if (typeof raw !== 'string' || raw === '') return []
    var parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.slice(-8) : []
  } catch (error) {
    return []
  }
}

/**
 * Everything about the card that a screenshot cannot show.
 *
 * Two reports in a row said the same thing — "拖还拖不动", "按 × 没反应" — while the
 * same bundle passed its own browser test, so the difference has to be in the
 * live DOM rather than in the component: is the plugin's stylesheet still in the
 * document, does each element carry the styles written for it, and does the hit
 * test at the grip and at the × reach our own nodes at all. The page is the only
 * place that knows, so the page answers, and the answer rides along with every
 * interaction the widget reports.
 */
function describeCard() {
  try {
    var styleTag = document.querySelector('style[data-plugin-css="dsh-orbit-time/styles.css"]')
    var root = document.querySelector('.ot-float-shell, .ot-float-mini')
    var report = {
      stylesheet: styleTag === null ? 'MISSING' : String(styleTag.textContent.length) + ' chars',
      root: root === null ? null : String(root.className),
      // What the drag made of the last few pointer events. Written by the drag
      // itself, so it is here even when the host was never told.
      dragLog: readDragLog(),
      entries: [],
    }
    if (root === null) return report
    var nodes = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')).slice(0, 20))
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i]
      var style = getComputedStyle(node)
      var box = node.getBoundingClientRect()
      report.entries.push({
        tag: node.tagName.toLowerCase(),
        cls: String(node.className).slice(0, 40),
        pe: style.pointerEvents,
        cursor: style.cursor,
        pos: style.position,
        rect: Math.round(box.left) + ',' + Math.round(box.top) + ' ' + Math.round(box.width) + 'x' + Math.round(box.height),
        hit: hitAt(box),
      })
    }
    return report
  } catch (error) {
    return { error: String((error && error.message) || error) }
  }
}

/* ------------------------------------------------------------------ notices */

function Notices() {
  var state = util.useStore(store.store)
  var notices = util.safeArray(state.notices)
  if (notices.length === 0) return null
  return h(
    'div',
    { className: 'ot-root ot-notices', role: 'status', 'aria-live': 'polite' },
    // One inner stack, so the outer box can fill the overlay layer (see the CSS:
    // `inset: 0` keeps the cards inside whatever containing block the harness's
    // overlay layer turns out to establish) while the cards keep their own width
    // and scroll as a group.
    h(
      'div',
      { className: 'ot-notice-stack' },
      notices.map(function (notice) {
        return h(
          'div',
          { key: notice.id, className: 'ot-notice', 'data-level': notice.level || 'info' },
          h('div', { className: 'ot-notice-title' }, notice.title),
          notice.body ? h('div', { className: 'ot-notice-body' }, notice.body) : null,
          h(
            'div',
            { className: 'ot-notice-actions' },
            notice.eventId
              ? ui.button({
                  small: true,
                  icon: 'check',
                  onClick: function () {
                    void store.store.eventAction('done', { id: notice.eventId }).catch(function () {})
                    store.store.dismissNotice(notice.id)
                  },
                }, '已完成')
              : null,
            notice.eventId
              ? ui.button({
                  small: true,
                  icon: 'clock',
                  onClick: function () {
                    void store.store.eventAction('snooze', { id: notice.eventId, minutes: 5 }).catch(function () {})
                    store.store.dismissNotice(notice.id)
                  },
                }, '5 分钟后再提醒')
              : null,
            ui.button({ small: true, variant: 'ghost', icon: 'close', onClick: function () { store.store.dismissNotice(notice.id) } }, '关闭'),
          ),
        )
      }),
    ),
  )
}

/* --------------------------------------------------------------- main panel */

function Dashboard() {
  var state = util.useStore(store.store)
  var now = util.useNow(1000)
  var pair = React.useState('timeline')
  var tab = pair[0]
  var setTab = pair[1]
  var scroller = React.useRef(null)

  React.useEffect(function () {
    store.store.bootstrap()
    return function () {
      store.store.shutdown()
    }
  }, [])

  var snapshot = state.snapshot
  var timer = snapshot ? store.store.currentTimer(now) : null
  var day = state.day
  var excel = snapshot && snapshot.excel

  function focusOn(title) {
    setTab('pomodoro')
    if (title) {
      void store.store.timerAction('start', { phase: 'focus', subject: title }).catch(function () {})
    }
  }

  function reimport() {
    void store.store
      .runImport({})
      .then(function (result) {
        store.store.pushNotice({ level: 'info', title: '已重新抓取', body: result.importedCount + ' 条日程' })
      })
      .catch(function (error) {
        store.store.pushNotice({ level: 'warn', title: '重新抓取失败', body: String((error && error.message) || error) })
      })
  }

  if (snapshot === null) {
    return h(
      'div',
      { className: 'ot-root' },
      h('div', { className: 'ot-aurora' }),
      h(
        'div',
        { className: 'ot-body', style: { display: 'grid', placeItems: 'center' } },
        h(
          'div',
          { style: { textAlign: 'center' } },
          h('div', { className: 'ot-avatar', style: { margin: '0 auto 12px' } }),
          h('div', { style: { fontWeight: 600 } }, state.error ? '连接宿主进程失败' : '正在连接 Orbit Time…'),
          h('div', { className: 'ot-sub', style: { marginTop: 6, maxWidth: 320 } }, state.error || '正在读取日程与番茄状态。'),
        ),
      ),
    )
  }

  var stats = snapshot.day.stats || {}
  var next = snapshot.nextEvent
  var ownerNames = util.safeArray(snapshot.ownerNames)

  return h(
    'div',
    { className: 'ot-root' },
    h('div', { className: 'ot-aurora' }),
    h(
      'header',
      { className: 'ot-header' },
      h(
        'div',
        { className: 'ot-headrow' },
        h('h1', { className: 'ot-title' }, 'Orbit Time'),
        h('span', { className: 'ot-subtitle' }, timeline.dayLabel(day) + ' · ' + (stats.eventCount || 0) + ' 条日程'),
        h('div', { className: 'ot-headspace' }),
        h(
          'div',
          { className: 'ot-headmeta' },
          ownerNames.length > 0
            ? h('span', { className: 'ot-chip ot-chip-owner', title: 'Excel 里只抓取这些名字的行' }, ui.glyph('spark', 11), ownerNames.join(' / '))
            : h('span', { className: 'ot-chip ot-chip-warn' }, ui.glyph('spark', 11), '未设置姓名'),
          h(
            'span',
            { className: 'ot-chip ' + (excel && excel.lastError ? 'ot-chip-warn' : 'ot-chip-live'), title: excel ? excel.path : '尚未导入 Excel' },
            excel ? (excel.lastError ? '导入异常' : '已同步 ' + (excel.importedCount || 0) + ' 条') : '未导入',
          ),
          // Rows typed in by hand are not in any workbook, so the import's own
          // count would read as if they had been lost.
          snapshot.manualCount > 0
            ? h('span', { className: 'ot-chip ot-chip-manual', title: '这些是你自己加的，重新导入 Excel 也不会被覆盖' }, ui.glyph('plus', 11), '自己加的 ' + snapshot.manualCount + ' 条')
            : null,
          // Rows the model read out of a document or a picture. Counted apart
          // from typed rows: "读了 6 条" is not "我自己加了 6 条".
          snapshot.readCount > 0
            ? h('span', { className: 'ot-chip ot-chip-ai', title: '这些是 AI 从资料里读出来的，重新导入 Excel 也不会被覆盖' }, ui.glyph('robot', 11), 'AI 读出 ' + snapshot.readCount + ' 条')
            : null,
          h('span', { className: 'ot-chip' }, ui.glyph('clock', 11), snapshot.serverTime.label),
          ui.button({
            small: true,
            iconOnly: true,
            icon: 'expand',
            title: '打开置顶悬浮小窗',
            onClick: function () {
              store.store.openFloatWindow()
            },
          }),
        ),
      ),
    ),
    h(
      'nav',
      { className: 'ot-tabs', role: 'tablist' },
      TABS.map(function (entry) {
        var badge = null
        if (entry.id === 'timeline' && stats.eventCount) badge = stats.eventCount
        if (entry.id === 'pomodoro' && timer && timer.running) badge = util.formatClock(timer.remainingMs)
        return h(
          'button',
          {
            key: entry.id,
            type: 'button',
            role: 'tab',
            className: 'ot-tab',
            'data-active': tab === entry.id ? 'true' : 'false',
            'aria-selected': tab === entry.id ? 'true' : 'false',
            onClick: function () {
              setTab(entry.id)
            },
          },
          entry.label,
          badge !== null ? h('span', { className: 'ot-badge' }, String(badge)) : null,
        )
      }),
    ),
    h(
      'div',
      { className: 'ot-body', ref: scroller },
      tab === 'timeline'
        ? h(timeline.TimelineView, {
            store: store.store,
            snapshot: snapshot,
            day: day,
            events: snapshot.day.events,
            stats: stats,
            undated: snapshot.day.undated,
            now: now,
            onFocus: focusOn,
            onReimport: reimport,
          })
        : null,
      tab === 'pomodoro' && timer
        ? h(pomodoro.PomodoroView, {
            store: store.store,
            timer: timer,
            settings: snapshot.settings,
            now: now,
            nextTitle: next ? next.title : '',
            nextRelative: next ? util.formatRelative(next.minutesUntilStart) : '',
          })
        : null,
      tab === 'companion'
        ? h(companion.CompanionView, {
            store: store.store,
            companion: state.companion,
            assistant: state.assistant,
            snapshot: snapshot,
            settings: snapshot.settings,
            ownerNames: ownerNames,
          })
        : null,
      tab === 'settings'
        ? h(settings.SettingsView, {
            store: store.store,
            snapshot: snapshot,
            assistant: state.assistant,
            onOpenTimeline: function () {
              setTab('timeline')
            },
          })
        : null,
    ),
  )
}

/* ------------------------------------------------------------- floating widget */

/**
 * Report a UI interaction, with the live card attached.
 *
 * The extra payload is the whole point: "the × does nothing" is answered by
 * knowing whether the stylesheet is still in the document and whether the hit
 * test at that button reaches our own node — and that can only be read at the
 * moment the user acts.
 */
function reportUi(name) {
  store.store.reportUiEvent(name, describeCard())
}

/**
 * The in-page floating card.
 *
 * Two states, one rule each:
 *
 *   pill   ring + clock + the next event, with — (collapse), ⤢ (open the desktop
 *          widget) and × (hide)
 *   mini   56 px dot: the ring and the remaining minutes, with × to hide and ⤢ to
 *          grow back
 *
 * Both states are draggable from anywhere that is not a control, and the spot is
 * remembered in `localStorage`, because the card covers the panel underneath it
 * and "I cannot move it out of the way" and "I cannot close it" are the same
 * complaint from the user's side.
 *
 * Hiding is local state, not the persisted `showFloatingWidget` setting: this
 * closes the card you are looking at, and the settings switch is the one that
 * means "never". A closed card leaves a small chip behind so it can be brought
 * back without going to look for the setting.
 */
function FloatingWidget() {
  var state = util.useStore(store.store)
  var now = util.useNow(1000)
  var expandedPair = React.useState(function () {
    return drag.readCollapsed(false) === false
  })
  var expanded = expandedPair[0]
  var setExpanded = expandedPair[1]
  var hiddenPair = React.useState(false)
  var hidden = hiddenPair[0]
  var setHidden = hiddenPair[1]
  var reported = React.useRef(false)
  /** True until the first commit: a first mount has no outgoing shape to adopt. */
  var firstShape = React.useRef(true)

  // Two cards, two remembered spots: collapsing must not drop the expanded card
  // at the corner the dot was parked in — and a shape that the user never placed
  // appears where the other one was, because a collapse is one card changing
  // shape, not two cards swapping places.
  //
  // The grip refs are created here and handed *in*, because the drag listens on
  // the document and needs to know which element counts as the handle (see
  // `useFloatingPosition`). A press anywhere else on the card never starts a
  // drag, so the buttons keep their clicks.
  var pillGrip = React.useRef(null)
  var miniGrip = React.useRef(null)
  var pill = drag.useFloatingPosition({ width: 300, margin: 12, handle: pillGrip })
  var mini = drag.useFloatingPosition({ width: 248, margin: 12, handle: miniGrip })

  // The drag's own diagnostics channel. Whatever the pointer does to the grip is
  // reported with the live layout attached, because "拖不动" has two halves — the
  // event never arrived, or it arrived and the move was refused — and only the
  // page can tell them apart.
  //
  // It goes to two places on purpose: the host's `/debug` (which a restart may
  // not have caught up with) and `localStorage`, which the next page load can
  // read back through `describeCard`. A diagnostic that depends on a process the
  // user has to restart is not a diagnostic.
  React.useEffect(function () {
    var seat = typeof window === 'undefined' ? null : window
    if (seat === null) return undefined
    var pending = null
    seat.__otDragNote = function (text) {
      var line = new Date().toISOString().slice(11, 19) + ' ' + text
      try {
        var log = JSON.parse(seat.localStorage.getItem('orbit-time.drag-log') || '[]')
        log.push(line)
        seat.localStorage.setItem('orbit-time.drag-log', JSON.stringify(log.slice(-12)))
      } catch (error) {
        /* a refused storage must not break the drag */
      }
      if (pending !== null) return
      // One report per second at most: a drag produces a note per event, and the
      // point is to see the first one, not to flood the route.
      pending = setTimeout(function () {
        pending = null
      }, 1000)
      reportUi('drag: ' + line)
    }
    return function () {
      if (pending !== null) clearTimeout(pending)
      seat.__otDragNote = undefined
    }
  }, [])

  React.useLayoutEffect(function () {
    // First mount: this shape has no predecessor, so it keeps whatever spot it
    // read from storage. Adopting the *other* shape's box here is what parked the
    // expanded card at the dot's default position (248 px wide, bottom-right) —
    // the dot's box, not the card's, which is why the card could start half off
    // the right edge on a narrow window.
    if (firstShape.current) {
      firstShape.current = false
      return
    }
    // The outgoing shape's element is already detached by the time this runs, so
    // the position comes from the hook's own record rather than from the DOM.
    if (expanded) pill.adopt(mini.position())
    else mini.adopt(pill.position())
    // Only a *shape change* adopts. Listing the hook's own functions as deps made
    // this run on every render — they are new objects each time — so any store
    // tick (the 1 Hz clock is enough) pulled the card back to the other shape's
    // remembered spot, mid-use and mid-drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded])

  React.useEffect(function () {
    store.store.bootstrap()
  }, [])

  // One layout report per page load: enough to answer "why is it dead" without
  // turning the route into a stream.
  React.useEffect(function () {
    if (reported.current) return
    reported.current = true
    var timerHandle = setTimeout(function () {
      void store.store.reportOverlayLayout(describeOverlayHost())
    }, 1500)
    return function () {
      clearTimeout(timerHandle)
    }
  }, [])

  function collapse() {
    drag.writeCollapsed(true)
    setExpanded(false)
    reportUi('collapse')
  }

  function grow() {
    drag.writeCollapsed(false)
    setExpanded(true)
    reportUi('expand-card')
  }

  /** Close the card in this page. The settings switch is the durable "never". */
  function hide() {
    // Reported *before* the card leaves the DOM: the report carries the live
    // layout, and once this renders there is nothing left to describe.
    reportUi('hide-card')
    setHidden(true)
  }

  function expandWindow() {
    reportUi('expand-window')
    store.store
      .openFloatWindow()
      .catch(function (error) {
        store.store.pushNotice({
          level: 'warn',
          title: '悬浮窗启动失败',
          body: String((error && error.message) || error),
        })
      })
  }

  function timerCommand(action, extra) {
    store.store.reportUiEvent('timer:' + action)
    return store.store.timerAction(action, extra).catch(function (error) {
      store.store.pushNotice({
        level: 'warn',
        title: '计时器操作失败',
        body: String((error && error.message) || error),
      })
    })
  }

  var snapshot = state.snapshot
  if (snapshot === null) return null
  if (snapshot.settings && snapshot.settings.ui && snapshot.settings.ui.showFloatingWidget === false) return null

  // The × takes the card off the panel and leaves nothing behind. It used to
  // leave a 「显示小卡片」 chip in the corner, which is one more floating thing on
  // top of the panel — the opposite of what closing a floating card is for. The
  // card comes back the way any other preference does: the switch in
  // 设置 / 导入 (`ui.showFloatingWidget`). The collapsed/expanded memory is
  // untouched, so showing it again brings back whichever shape it was in.
  if (hidden) return null

  var timer = store.store.currentTimer(now)
  var next = snapshot.nextEvent
  var upcoming = util.safeArray(snapshot.day.events).filter(function (event) {
    return event.phase !== 'past' && !event.done
  })

  var remainingMs = next && next.startMs !== null ? Math.max(0, next.startMs - now) : 0

  if (!expanded) {
    return h(
      'div',
      {
        // The position rides on the style, not on a one-off DOM write: growing
        // back replaces this node, and a remembered spot has to survive that.
        className: util.cx('ot-root ot-float-mini', mini.dragging ? 'is-dragging' : null),
        style: Object.assign({ width: 248 }, mini.style),
        ref: mini.ref,
      },
      ui.button({
        small: true,
        iconOnly: true,
        icon: 'grip',
        variant: 'ghost',
        className: 'ot-grip',
        // The grip is the handle the drag looks for: a press inside it moves the
        // card, a press anywhere else belongs to whatever was pressed.
        ref: miniGrip,
        // The handle the drag looks for arrives as a ref, and a ref is silent when
        // it never attaches. The attribute is the fallback the drag can find by
        // itself (see `gripNode()` in drag.js), so a dropped ref costs the card a
        // hover cursor at worst — never the drag.
        'data-ot-grip': 'mini',
        // No onClick: this control exists to be dragged, and a tap on it that
        // did something else would be a surprise. The card is expanded from the
        // ⤢ button beside it.
        title: '按住这里拖动小卡片',
        ariaLabel: '拖动小卡片',
      }),
      ui.ring({
        size: 34,
        stroke: 4,
        className: 'ot-float-mini-ring',
        progress: timer ? timer.progress : 0,
        break: timer ? timer.phase === 'short' || timer.phase === 'long' : false,
        gradientId: 'ot-mini-gradient',
        children: h(
          'span',
          { style: { fontSize: 9, fontWeight: 700, fontVariantNumeric: 'tabular-nums' } },
          timer && timer.phase !== 'idle' ? String(Math.ceil(timer.remainingMs / 60000)) : '▶',
        ),
      }),
      h(
        'div',
        { className: 'ot-float-mini-body' },
        h('div', { className: 'ot-float-mini-time' }, next ? util.formatClock(remainingMs) : '--:--'),
        h('div', { className: 'ot-float-mini-meta', title: next ? next.title : '今天没有日程' }, next ? next.title : '今天没有日程'),
      ),
      h(
        'div',
        { className: 'ot-float-mini-actions' },
        ui.button({ small: true, iconOnly: true, icon: 'expand', title: '展开', onClick: grow }),
        ui.button({ small: true, iconOnly: true, variant: 'ghost', icon: 'close', title: '收起小卡片', onClick: hide }),
      ),
    )
  }

  return h(
    'div',
    {
      className: util.cx('ot-root ot-float-shell', pill.dragging ? 'is-dragging' : null),
      // `left`/`top` come from the remembered position; `right`/`bottom` are the
      // resting corner for the first paint, before the layout effect has measured
      // anything. Both present is fine — with `left` set, that one wins.
      style: Object.assign(
        {
          position: 'fixed',
          right: 18,
          bottom: 18,
          zIndex: 30,
          width: 300,
          maxHeight: 'min(70vh, 560px)',
        },
        pill.style,
      ),
      ref: pill.ref,
    },
    h(
      'div',
      { className: 'ot-float-head' },
      h(
        'span',
        { className: 'ot-grip', title: '按住这里拖动卡片', ref: pillGrip, 'data-ot-grip': 'pill' },
        ui.glyph('grip', 14),
      ),
      h('span', { className: 'ot-float-title' }, 'Orbit Time'),
      h('div', { className: 'ot-headspace' }),
      ui.button({ small: true, iconOnly: true, icon: 'expand', title: '在桌面悬浮窗中打开', onClick: expandWindow }),
      ui.button({ small: true, iconOnly: true, icon: 'minus', title: '收起为小圆点', onClick: collapse }),
      ui.button({ small: true, iconOnly: true, variant: 'ghost', icon: 'close', title: '关闭这张卡片', onClick: hide }),
    ),
    timer
      ? h(
          'div',
          { style: { display: 'grid', placeItems: 'center' } },
          ui.ring({
            size: 138,
            stroke: 9,
            className: 'ot-ring',
            progress: timer.progress,
            running: timer.running,
            break: timer.phase === 'short' || timer.phase === 'long',
            gradientId: 'ot-widget-gradient',
            label: '计时 ' + util.formatClock(timer.remainingMs),
            children: [
              h('div', { className: 'ot-ring-time ot-float-time', key: 't' }, util.formatClock(timer.remainingMs)),
              h('div', { className: 'ot-ring-phase', key: 'p' }, timer.phase === 'focus' ? '专注' : timer.phase === 'idle' ? '待机' : '休息'),
            ],
          }),
          h(
            'div',
            { className: 'ot-row', style: { justifyContent: 'center', marginTop: 8 } },
            timer.running
              ? ui.button({ small: true, icon: 'pause', onClick: function () { timerCommand('pause') } }, '暂停')
              : ui.button({ small: true, variant: 'primary', icon: 'play', onClick: function () { timerCommand(timer.phase === 'idle' || timer.remainingMs <= 0 ? 'start' : 'resume', { phase: 'focus' }) } }, '开始'),
            ui.button({ small: true, icon: 'skip', title: '完成当前阶段', onClick: function () { timerCommand('skip') } }),
          ),
        )
      : null,
    h(
      'div',
      { className: 'ot-float-next' },
      h('div', { className: 'ot-float-next-title' }, next ? next.title : '接下来没有日程'),
      h(
        'div',
        { className: 'ot-float-next-meta' },
        next
          ? (next.effectiveStart || '全天') + ' · ' + util.formatRelative(next.minutesUntilStart) + (next.classroom ? ' · ' + next.classroom : '')
          : '享受空白时间',
      ),
    ),
    h(
      'div',
      { className: 'ot-float-list' },
      upcoming.slice(0, 8).map(function (event) {
        return h(
          'div',
          { key: event.id, className: 'ot-float-row', 'data-phase': event.phase },
          h('span', { className: 'ot-float-row-time' }, event.effectiveStart || '—'),
          h('span', { className: 'ot-float-row-title', title: event.title }, event.title),
          event.phase === 'current'
            ? h('span', { className: 'ot-badge' }, '进行中')
            : h('span', { className: 'ot-sub', style: { fontSize: 10.5 } }, util.formatRelative(event.minutesUntilStart)),
        )
      }),
    ),
    h(
      'div',
      { className: 'ot-float-foot' },
      ui.button({
        small: true,
        icon: 'check',
        disabled: !next,
        onClick: function () {
          if (next) void store.store.eventAction('done', { id: next.id, done: true }).catch(function () {})
        },
      }, '完成'),
      ui.button({
        small: true,
        icon: 'clock',
        disabled: !next,
        onClick: function () {
          if (next) void store.store.eventAction('snooze', { id: next.id, minutes: 5 }).catch(function () {})
        },
      }, '稍后 5 分'),
    ),
  )
}

exports.Dashboard = Dashboard
exports.Notices = Notices
exports.FloatingWidget = FloatingWidget
exports.TABS = TABS
