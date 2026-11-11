/** Orbit Time client — today's timeline, week strip, and the "next up" card. */

var util = require('./util.js')
var ui = require('./ui.js')
var calendar = require('./calendar.js')
var manual = require('./manual.js')
var React = util.React
var h = util.h

function dayLabel(dayKey) {
  var today = util.todayKey()
  if (dayKey === today) return '今天'
  if (dayKey === util.shiftDay(today, 1)) return '明天'
  if (dayKey === util.shiftDay(today, -1)) return '昨天'
  var parts = String(dayKey).split('-').map(Number)
  var date = new Date(parts[0], parts[1] - 1, parts[2])
  var names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return names[date.getDay()] || dayKey
}

function EventRow(props) {
  var event = props.event
  var store = props.store
  var phase = event.done ? 'past' : event.phase
  var pair = React.useState(false)
  var busy = pair[0]
  var setBusy = pair[1]
  // Where the click failed is where it says so: under this row's own buttons.
  // It used to be a corner toast that covered the page and had to be dismissed.
  var errorPair = React.useState('')
  var error = errorPair[0]
  var setError = errorPair[1]
  // Open in place, over the row itself, so the thing being changed is still on
  // screen while it is changed. A modal would have covered the day behind it.
  var editPair = React.useState(false)
  var editing = editPair[0]
  var setEditing = editPair[1]

  function act(action, body) {
    setBusy(true)
    setError('')
    store
      .eventAction(action, Object.assign({ id: event.id }, body || {}))
      .catch(function (failure) {
        setError(String((failure && failure.message) || failure))
      })
      .then(function () {
        setBusy(false)
      })
  }

  /** Deleting is the same shape: the row disappears, or says why it did not. */
  function remove() {
    if (typeof props.onDelete !== 'function') return
    setBusy(true)
    setError('')
    Promise.resolve()
      .then(function () {
        return props.onDelete(event)
      })
      .catch(function (failure) {
        setError(String((failure && failure.message) || failure))
      })
      .then(function () {
        setBusy(false)
      })
  }

  /**
   * What this row says about its clock, in the shape it actually has.
   *
   * The three shapes are not the same sentence. An open task has no "剩余 N 分"
   * to report — that number used to come from a fabricated end, and showing it
   * was the entire "一直显示 0:00" problem: the countdown ran out while the work
   * was nowhere near done. Now the row says how long it has been running.
   */
  var when = ''
  if (event.phase === 'current') {
    if (event.timeShape === 'open') {
      when = '已进行 ' + Math.max(0, -(event.minutesUntilStart || 0)) + ' 分 · 没设结束'
    } else {
      when = '剩余 ' + Math.max(0, event.minutesUntilEnd || 0) + ' 分'
    }
  } else if (event.phase === 'upcoming') {
    when = event.timeShape === 'due' ? util.formatRelative(event.minutesUntilStart) + '截止' : util.formatRelative(event.minutesUntilStart)
  } else if (event.phase === 'past') {
    when = event.timeShape === 'due' ? '已过截止' : '已结束'
  }

  var tags = []
  if (event.classroom) tags.push(h('span', { className: 'ot-tag', key: 'room' }, ui.glyph('pin', 11), event.classroom))
  else if (event.location) tags.push(h('span', { className: 'ot-tag', key: 'loc' }, ui.glyph('pin', 11), event.location))
  if (event.teacher) tags.push(h('span', { className: 'ot-tag', key: 'teacher' }, event.teacher))
  if (event.course && event.course !== event.title) tags.push(h('span', { className: 'ot-tag', key: 'course' }, event.course))
  if (event.category) tags.push(h('span', { className: 'ot-tag', key: 'cat' }, event.category))
  if (event.owner && props.showOwner !== false) tags.push(h('span', { className: 'ot-tag ot-tag-owner', key: 'owner' }, event.owner))
  // Rows typed in by hand have no roster behind them, and look identical to an
  // imported one otherwise — including when the Excel file is later swapped.
  if (event.source && event.source.sheet === '手动添加') tags.push(h('span', { className: 'ot-tag ot-tag-manual', key: 'manual' }, '自己加的'))
  // Rows the model read out of a document: no file watcher re-reads them, so
  // they behave like typed rows — but they are not something the user wrote.
  if (event.source && event.source.sheet === 'AI 读资料') {
    tags.push(h('span', { className: 'ot-tag ot-tag-ai', key: 'ai', title: 'AI 从资料里读出来的日程' }, 'AI 读出'))
  }
  // Deadlines read off a course site: no file behind them either, and the user
  // needs to know the date came from the site rather than from a roster.
  if (event.source && event.source.sheet === '网络 DDL') {
    tags.push(h('span', { className: 'ot-tag ot-tag-web', key: 'web', title: '从网上（课程平台 / 网页）读到的截止时间' }, '网络 DDL'))
  }
  // A row the user has corrected says so, and the same badge offers the way back:
  // the roster's version is still there underneath, and "a change I cannot undo"
  // is the reason people stop using an edit button.
  if (event.edited === true) {
    tags.push(
      h('span', { className: 'ot-tag ot-tag-edited', key: 'edited', title: '这一条被你改过；Excel 原表没动' }, '已修改'),
    )
  }
  // A shape badge, because "没有结束时间" is a property of the row and not an
  // accident of the import. Without it the timeline just looks like it lost a value.
  if (event.timeShape === 'due') tags.push(h('span', { className: 'ot-tag ot-tag-shape', key: 'shape' }, '截止'))
  else if (event.timeShape === 'open') tags.push(h('span', { className: 'ot-tag ot-tag-shape', key: 'shape' }, '做到完为止'))
  if (util.safeArray(event.warnings).length > 0) {
    tags.push(
      h('span', { className: 'ot-tag ot-tag-warn', key: 'warn', title: util.safeArray(event.warnings).join('\n') }, '⚠ ', util.safeArray(event.warnings)[0]),
    )
  }

  // The second line under the time column: a deadline has no end to print, and
  // "—" there reads as missing data rather than as a deliberate shape.
  var endLine = ''
  if (event.timeShape === 'due') endLine = '截止'
  else if (event.timeShape === 'open') endLine = '没有结束'
  else endLine = event.effectiveEnd || event.end || ''

  return h(
    'article',
    {
      className: util.animationClass('ev:' + event.id, 'ot-ev'),
      'data-phase': phase,
      'data-done': event.done ? 'true' : 'false',
      'data-shape': event.timeShape || 'span',
      'data-editing': editing ? 'true' : 'false',
      'data-event-id': event.id,
    },
    h('i', { className: 'ot-ev-node' }),
    h(
      'div',
      { className: 'ot-ev-time' },
      h('div', { className: 'ot-ev-start' }, event.effectiveStart || event.start || '—'),
      endLine !== '' ? h('div', { className: 'ot-ev-end' }, endLine) : null,
    ),
    h(
      'div',
      { className: 'ot-ev-card' },
      h(
        'div',
        { className: 'ot-ev-head' },
        h('span', { className: 'ot-ev-title', title: event.effectiveTitle || event.title }, event.effectiveTitle || event.title),
        when ? h('span', { className: 'ot-ev-when' }, when) : null,
      ),
      // Only where the roster and the correction differ: "原定 … → 已顺延" on a row
      // that was never moved would be noise on every imported line.
      (event.effectiveStart && event.effectiveStart !== event.start) || (event.effectiveDate && event.effectiveDate !== event.date) || (event.effectiveTitle && event.effectiveTitle !== event.title)
        ? h(
            'div',
            { className: 'ot-sub ot-ev-moved' },
            '原定 ' +
              [event.date, event.start].filter(function (value) { return value && value !== '' }).join(' ') +
              (event.title !== (event.effectiveTitle || event.title) ? ' · ' + event.title : '') +
              ' → 现在 ' +
              [event.effectiveDate, event.effectiveStart].filter(function (value) { return value && value !== '' }).join(' '),
          )
        : null,
      tags.length > 0 ? h('div', { className: 'ot-tags' }, tags) : null,
      event.notes ? h('div', { className: 'ot-ev-notes', title: event.notes }, event.notes) : null,
      editing
        ? h(manual.EventEditor, {
            store: store,
            event: event,
            day: props.day,
            now: props.now,
            onCancel: function () {
              setEditing(false)
            },
            onSaved: function () {
              setEditing(false)
              if (typeof props.onEdited === 'function') props.onEdited(event)
            },
            onReset: function () {
              setBusy(true)
              setError('')
              return store
                .resetEvent(event.id)
                .then(function () {
                  setBusy(false)
                  setEditing(false)
                })
                .catch(function (failure) {
                  setBusy(false)
                  setError(String((failure && failure.message) || failure))
                })
            },
          })
        : null,
      h(
        'div',
        { className: 'ot-ev-actions' },
        h(
          'button',
          {
            type: 'button',
            className: 'ot-btn ot-btn-sm' + (event.done ? '' : ' ot-btn-ghost'),
            disabled: busy,
            onClick: function () {
              act('done', { done: !event.done })
            },
          },
          ui.glyph('check', 12),
          event.done ? '取消完成' : '完成',
        ),
        // Editing is offered on every row, imported ones included. The importer
        // owns the *file*; it has never had a claim on what the user means by it.
        h(
          'button',
          {
            type: 'button',
            className: 'ot-btn ot-btn-sm ot-btn-ghost',
            disabled: busy,
            'aria-expanded': editing ? 'true' : 'false',
            title: '改这一条的时间、标题、地点（Excel 原表不动）',
            onClick: function () {
              setEditing(!editing)
            },
          },
          ui.glyph('pen', 12),
          editing ? '收起修改' : '改一下',
        ),
        event.phase !== 'past'
          ? h(
              'button',
              {
                type: 'button',
                className: 'ot-btn ot-btn-sm ot-btn-ghost',
                disabled: busy,
                onClick: function () {
                  act('snooze', { minutes: props.snoozeMinutes || 5 })
                },
              },
              ui.glyph('bell', 12),
              '稍后 ' + (props.snoozeMinutes || 5) + ' 分',
            )
          : null,
        event.start
          ? h(
              'button',
              {
                type: 'button',
                className: 'ot-btn ot-btn-sm ot-btn-ghost',
                disabled: busy,
                title: '把这条日程整体推后 10 分钟',
                onClick: function () {
                  act('shift', { minutes: 10 })
                },
              },
              '+10 分',
            )
          : null,
        // Only self-made rows: an imported row deleted here would come back on
        // the next file scan, which is the file doing its job, not a bug to hide.
        // A row the model read off a document has no file behind it either, so it
        // is deletable for the same reason.
        event.source && (event.source.sheet === '手动添加' || event.source.sheet === 'AI 读资料' || event.source.sheet === '网络 DDL')
          ? h(
              'button',
              {
                type: 'button',
                className: 'ot-btn ot-btn-sm ot-btn-ghost',
                disabled: busy,
                title:
                  event.source.sheet === 'AI 读资料'
                    ? '删掉这条 AI 读出来的日程'
                    : event.source.sheet === '网络 DDL'
                      ? '删掉这条从网上读到的截止时间'
                      : '删掉这条自己加的日程',
                onClick: function () {
                  remove()
                },
              },
              ui.glyph('close', 12),
              '删除',
            )
          : null,
        event.minutesUntilStart !== null && event.minutesUntilStart > 0
          ? h(
              'button',
              {
                type: 'button',
                className: 'ot-btn ot-btn-sm ot-btn-ghost',
                disabled: busy,
                title: '用这条日程开始一个番茄',
                onClick: function () {
                  props.onFocus(event.effectiveTitle || event.title)
                },
              },
              ui.glyph('play', 12),
              '番茄',
            )
          : null,
      ),
      error !== '' ? ui.note({ variant: 'error' }, error) : null,
    ),
  )
}

/**
 * The one card at the top of the day: what is happening, and what is next.
 *
 * It used to answer one question with one row, and the row it picked was
 * whichever came first — so a long class, or a task with no end, occupied the
 * card for its whole duration and the appointment after it was invisible. That is
 * the "看不到之后的状态" complaint, and it was the card's shape that caused it, not
 * the data.
 *
 * Two lanes now, and neither can hide the other:
 *
 *   top     what the clock is inside — with a countdown if it has an end, and
 *           "已进行 42 分" if it does not, because an open task has no finish line
 *           to count down to
 *   bottom  what starts next, with its own countdown
 *
 * When only one of them exists the other lane is simply absent rather than
 * filled with an empty placeholder: a card that says "no next up" in a slot that
 * looks like data is worse than a shorter card.
 */
function NextCard(props) {
  var next = props.next
  var current = props.current
  var now = props.now

  if (!next && !current) {
    return h(
      'div',
      { className: 'ot-card ot-next' },
      h(
        'div',
        { className: 'ot-next-main' },
        h('div', { className: 'ot-next-title' }, '接下来没有日程了'),
        h('div', { className: 'ot-next-meta' }, '今天是空的，或者日程已经全部结束。要不要开一个番茄？'),
      ),
      h('div', { className: 'ot-countdown' }, h('div', { className: 'ot-countdown-value' }, '☕')),
    )
  }

  /** One lane: a title, a line of detail, and a number on the right. */
  function lane(event, kind) {
    if (!event) return null
    var isCurrent = kind === 'current'
    var openEnded = isCurrent && (event.timeShape === 'open' || event.minutesUntilEnd === null)
    var startMs = event.startMs
    var remainingMs = startMs === null ? 0 : Math.max(0, startMs - now)
    /**
     * The place line: where it is, and nothing about when.
     *
     * It used to open with `15:30–17:00` while the line above it already said
     * `15:30 → 17:00` — the same range twice, in two formats, on one card. The
     * clock belongs to the header, which is the part that is meant to be read.
     */
    var meta = [event.classroom || event.location, event.course, event.teacher]
      .filter(function (value) {
        return value && value !== ''
      })
      .join(' · ')

    var big
    var label
    if (openEnded) {
      // Elapsed, not remaining: an open task has no finish line, and a countdown
      // to a number that does not exist is exactly what used to read "0 分钟".
      var elapsed = Math.max(0, -(event.minutesUntilStart || 0))
      big = String(elapsed)
      label = elapsed < 1 ? '刚开始' : '分钟前开始'
    } else if (isCurrent) {
      big = String(Math.max(0, event.minutesUntilEnd || 0))
      label = '分钟后结束'
    } else {
      big = util.formatCountdown(remainingMs)
      label = event.timeShape === 'due' ? '后截止' : '后开始'
    }

    /**
     * The status word beside the clock, and the rule it follows.
     *
     * For the running lane it says what the clock cannot: that this is happening
     * now. For the next lane it says nothing at all, because the only thing left
     * to say would be "in 1 day 5 hours" — which is exactly what the big number
     * on the right already is. Putting both on one card is what made the header
     * read `15:30 →17:00 1 天 5 小时后` with a second `1 天 5 小时` filling the
     * right half of the card.
     */
    var status = ''
    if (openEnded) status = '进行中 · 没有结束时间'
    else if (isCurrent) status = '进行中'
    else if (event.timeShape === 'due') status = event.effectiveEnd ? '' : '截止'

    return h(
      'div',
      { className: 'ot-next-lane', 'data-kind': kind },
      h(
        'div',
        { className: 'ot-next-main' },
        h(
          'div',
          { className: 'ot-next-time' },
          h('span', { className: 'ot-next-start' }, event.effectiveStart || '全天'),
          event.effectiveEnd
            ? h('span', { className: 'ot-next-sep' }, '→ ' + event.effectiveEnd)
            : null,
          status !== '' ? h('span', { className: 'ot-next-count' }, status) : null,
          event.edited === true ? h('span', { className: 'ot-next-edited', title: '这一条被你改过' }, '已修改') : null,
        ),
        h('div', { className: 'ot-next-title', title: event.effectiveTitle || event.title }, event.effectiveTitle || event.title),
        meta !== '' ? h('div', { className: 'ot-next-meta' }, meta) : null,
        /**
         * A bar only where it measures something.
         *
         * An open task has no length, so a bar would be decoration. A row that has
         * not started is at 0% by definition, so its bar is a permanently empty
         * track — which on a card this sparse reads as a broken element rather
         * than as "not begun".
         */
        isCurrent && !openEnded
          ? h('div', { className: 'ot-progress' }, h('i', { style: { width: Math.round((event.progress || 0) * 100) + '%' } }))
          : null,
      ),
      h(
        'div',
        {
          className:
            'ot-countdown' +
            (openEnded ? ' ot-countdown-open' : '') +
            // "1 天 5 小时" is a phrase, not a clock: it needs its own size or it
            // outshouts the event it describes.
            (big.indexOf('天') !== -1 ? ' ot-countdown-long' : ''),
        },
        h('div', { className: 'ot-countdown-value' }, big),
        h('div', { className: 'ot-countdown-label' }, label),
      ),
    )
  }

  var hasBoth = Boolean(next && current)
  return h(
    'div',
    { className: 'ot-card ot-next' + (hasBoth ? ' ot-next-both' : '') },
    lane(current, 'current'),
    hasBoth ? h('div', { className: 'ot-next-divide' }, h('span', null, '然后')) : null,
    lane(next, 'next'),
  )
}

function TimelineView(props) {
  var store = props.store
  var snapshot = props.snapshot
  var day = props.day
  var now = props.now
  var events = util.safeArray(props.events)
  var stats = props.stats || {}
  var [filter, setFilter] = React.useState('all')
  // Closed by default: the strip already answers "what is next", and the month
  // grid is the deliberate long look — see calendar.js.
  var [showCalendar, setShowCalendar] = React.useState(false)
  // Adding an event opens the same form from the calendar, the day bar, and the
  // empty state; keeping the flag here means those three share one form instead
  // of three copies that drift apart.
  var [adding, setAdding] = React.useState(false)
  // A re-read of the roster reports where the button is, not in a corner. The
  // success needs no line at all: the counts and the rows below are the result.
  var [reimporting, setReimporting] = React.useState(false)
  var [reimportError, setReimportError] = React.useState('')

  function reimport() {
    if (reimporting) return
    setReimporting(true)
    setReimportError('')
    store
      .runImport({})
      .catch(function (error) {
        setReimportError(String((error && error.message) || error))
      })
      .then(function () {
        setReimporting(false)
      })
  }

  var visible = events.filter(function (event) {
    if (filter === 'todo') return !event.done && event.phase !== 'past'
    if (filter === 'done') return event.done || event.phase === 'past'
    return true
  })

  var week = util.safeArray(snapshot && snapshot.week)
  var focusMinutes = Number((snapshot && snapshot.settings.pomodoro.focusMinutes) || 25)

  return h(
    'div',
    { className: 'ot-view' },
    h(
      'div',
      { className: 'ot-daybar' },
      h('div', { className: 'ot-daylist' },
        week.map(function (entry) {
          return h(
            'button',
            {
              key: entry.dayKey,
              type: 'button',
              className: 'ot-daychip',
              'data-active': entry.dayKey === day ? 'true' : 'false',
              onClick: function () {
                void store.setDay(entry.dayKey).catch(function () {})
              },
              title: util.safeArray(entry.titles).join('、'),
            },
            h('span', null, entry.isToday ? '今天' : entry.label),
            h('b', null, String(entry.dayOfMonth)),
            entry.count > 0 ? h('i', null) : null,
          )
        }),
      ),
      h('div', { className: 'ot-headspace' }),
      ui.button({
        small: true,
        variant: adding ? 'primary' : undefined,
        icon: 'plus',
        title: '不经过 Excel，直接给自己加一条日程',
        onClick: function () {
          setAdding(!adding)
        },
      }, '加一条'),
      ui.button({
        small: true,
        variant: showCalendar ? 'primary' : undefined,
        icon: 'calendar',
        title: '按月份看已经导入的日程安排在哪几天',
        onClick: function () {
          setShowCalendar(!showCalendar)
        },
      }, '日历'),
      ui.button({
        small: true,
        icon: 'refresh',
        disabled: reimporting,
        title: reimporting ? '正在重新读取 Excel…' : '重新读取 Excel',
        onClick: reimport,
      }),
    ),
    reimportError !== '' ? ui.note({ variant: 'error' }, '重新抓取失败：' + reimportError) : null,
    adding
      ? h(manual.ManualEventForm, {
          store: store,
          day: day,
          now: now,
          onCancel: function () {
            setAdding(false)
          },
          onSaved: function (savedDay) {
            setAdding(false)
            // The new row is the confirmation now that no toast announces it, so
            // nothing may hide it: the "已完成" filter would (a fresh row is not
            // done), and a form opened on one day must not leave it off-screen on
            // another.
            setFilter('all')
            // Land on the day the event went to, calendar open, so the new row is
            // visible in the timeline below rather than off-screen on another date.
            setShowCalendar(true)
            if (savedDay && savedDay !== day) void store.setDay(savedDay).catch(function () {})
          },
        })
      : null,
    showCalendar
      ? h(calendar.CalendarView, {
          snapshot: snapshot,
          day: day,
          onPickDay: function (dayKey) {
            void store.setDay(dayKey).catch(function () {})
          },
          onMonth: function (monthKey) {
            void store.setMonth(monthKey).catch(function () {})
          },
          onAdd: function () {
            setAdding(true)
          },
          onClose: function () {
            setShowCalendar(false)
          },
        })
      : null,
    h(NextCard, { next: snapshot && snapshot.nextEvent, current: snapshot && snapshot.currentEvent, now: now }),
    h('div', { style: { height: 12 } }),
    h(
      'div',
      { className: 'ot-grid ot-grid-4' },
      ui.stat({ animKey: 'tl-count', icon: 'calendar', label: dayLabel(day) + '日程', value: String(stats.eventCount || events.length), foot: stats.label ? stats.label : '' }),
      ui.stat({
        animKey: 'tl-total',
        icon: 'clock',
        label: '总时长',
        value: Math.round(((stats.totalMinutes || 0) / 60) * 10) / 10 + ' h',
        // "含休息间隙" stopped being true once open tasks stopped inventing an
        // end: the number is now only the time rows actually account for, and
        // saying why it looks small is better than letting it look wrong.
        foot: (stats.openCount || 0) > 0 ? '不含没有结束的 ' + stats.openCount + ' 条' : (stats.dueCount || 0) > 0 ? '不含截止时刻' : '含休息间隙',
      }),
      ui.stat({ animKey: 'tl-done', icon: 'check', label: '已完成', value: Math.round(((stats.doneMinutes || 0) / 60) * 10) / 10 + ' h', foot: (stats.totalMinutes ? Math.round((stats.doneMinutes / stats.totalMinutes) * 100) : 0) + '% 的日程时间' }),
      ui.stat({
        animKey: 'tl-free',
        icon: 'spark',
        label: '下一个空档',
        value: util.safeArray(stats.freeSlots).length > 0 ? stats.freeSlots[0].from : '—',
        foot: util.safeArray(stats.freeSlots).length > 0 ? '可放 ' + Math.max(1, Math.floor(stats.freeSlots[0].minutes / focusMinutes)) + ' 个番茄' : '今天排满了',
      }),
    ),
    h('div', { style: { height: 12 } }),
    h(
      'div',
      { className: 'ot-row', style: { marginBottom: 10 } },
      h('span', { className: 'ot-sub' }, '共 ' + events.length + ' 条'),
      h('div', { className: 'ot-headspace' }),
      ['all', 'todo', 'done'].map(function (key) {
        var labels = { all: '全部', todo: '未完成', done: '已完成' }
        return h(
          'button',
          {
            key: key,
            type: 'button',
            className: 'ot-btn ot-btn-sm' + (filter === key ? ' ot-btn-primary' : ' ot-btn-ghost'),
            onClick: function () {
              setFilter(key)
            },
          },
          labels[key],
        )
      }),
    ),
    visible.length === 0
      ? h(
          'div',
          { className: 'ot-empty' },
          h('b', null, events.length === 0 ? '这一天没有你的日程' : '当前筛选下没有日程'),
          h('span', null, events.length === 0 ? '可以自己加一条，或者去「导入」页检查姓名与列匹配。' : '切换筛选条件看看。'),
          events.length === 0
            ? h(
                'div',
                { style: { marginTop: 12 } },
                ui.button({
                  small: true,
                  variant: 'primary',
                  icon: 'plus',
                  onClick: function () {
                    setAdding(true)
                  },
                }, '给这天加一条'),
              )
            : null,
        )
      : h(
          'div',
          { className: 'ot-tl' },
          visible.map(function (event) {
            return h(EventRow, {
              key: event.id,
              event: event,
              store: store,
              day: day,
              now: now,
              showOwner: true,
              snoozeMinutes: util.safeArray(snapshot && snapshot.settings.reminders.snoozeMinutes)[0] || 5,
              onFocus: props.onFocus,
              // The row keeps the promise so it can report its own failure; the
              // deleted row disappearing is the success message.
              onDelete: function (event) {
                return store.removeEvent(event.id)
              },
              onEdited: function () {
                // The reply already carried a fresh snapshot, but a row moved to
                // another date has to leave this list too, and only a re-read is
                // guaranteed to reflect that.
                void store.refresh(day).catch(function () {})
              },
            })
          }),
        ),
    util.safeArray(props.undated).length > 0
      ? h(
          'div',
          { style: { marginTop: 14 } },
          ui.card({
            title: '未定时间的日程',
            children: h(
              'div',
              { className: 'ot-tl' },
              props.undated.map(function (event) {
                return h(EventRow, { key: event.id, event: event, store: store, day: day, now: now, onFocus: props.onFocus })
              }),
            ),
          }),
        )
      : null,
    h('div', { style: { height: 8 } }),
  )
}

exports.TimelineView = TimelineView
exports.NextCard = NextCard
exports.EventRow = EventRow
exports.dayLabel = dayLabel
