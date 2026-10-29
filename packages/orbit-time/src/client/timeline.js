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

  function act(action, body) {
    setBusy(true)
    store
      .eventAction(action, Object.assign({ id: event.id }, body || {}))
      .catch(function (error) {
        store.pushNotice({ level: 'warn', title: '操作失败', body: String((error && error.message) || error) })
      })
      .then(function () {
        setBusy(false)
      })
  }

  var when =
    event.phase === 'current'
      ? '剩余 ' + Math.max(0, event.minutesUntilEnd || 0) + ' 分'
      : event.phase === 'upcoming'
        ? util.formatRelative(event.minutesUntilStart)
        : event.phase === 'past'
          ? '已结束'
          : ''

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
  if (util.safeArray(event.warnings).length > 0) {
    tags.push(
      h('span', { className: 'ot-tag ot-tag-warn', key: 'warn', title: util.safeArray(event.warnings).join('\n') }, '⚠ ', util.safeArray(event.warnings)[0]),
    )
  }

  return h(
    'article',
    {
      className: util.animationClass('ev:' + event.id, 'ot-ev'),
      'data-phase': phase,
      'data-done': event.done ? 'true' : 'false',
      'data-event-id': event.id,
    },
    h('i', { className: 'ot-ev-node' }),
    h(
      'div',
      { className: 'ot-ev-time' },
      h('div', { className: 'ot-ev-start' }, event.effectiveStart || event.start || '—'),
      event.effectiveEnd || event.end ? h('div', { className: 'ot-ev-end' }, (event.effectiveEnd || event.end)) : null,
    ),
    h(
      'div',
      { className: 'ot-ev-card' },
      h(
        'div',
        { className: 'ot-ev-head' },
        h('span', { className: 'ot-ev-title', title: event.title }, event.title),
        when ? h('span', { className: 'ot-ev-when' }, when) : null,
      ),
      event.effectiveStart !== event.start && event.start
        ? h('div', { className: 'ot-sub' }, '原定 ' + event.start + ' → 已顺延到 ' + event.effectiveStart)
        : null,
      tags.length > 0 ? h('div', { className: 'ot-tags' }, tags) : null,
      event.notes ? h('div', { className: 'ot-ev-notes', title: event.notes }, event.notes) : null,
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
        event.source && (event.source.sheet === '手动添加' || event.source.sheet === 'AI 读资料')
          ? h(
              'button',
              {
                type: 'button',
                className: 'ot-btn ot-btn-sm ot-btn-ghost',
                disabled: busy,
                title: event.source.sheet === 'AI 读资料' ? '删掉这条 AI 读出来的日程' : '删掉这条自己加的日程',
                onClick: function () {
                  if (typeof props.onDelete === 'function') props.onDelete(event)
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
                  props.onFocus(event.title)
                },
              },
              ui.glyph('play', 12),
              '番茄',
            )
          : null,
      ),
    ),
  )
}

function NextCard(props) {
  var next = props.next
  var now = props.now
  if (!next) {
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

  var startMs = next.startMs
  var remainingMs = startMs === null ? 0 : Math.max(0, startMs - now)
  var isCurrent = next.phase === 'current'
  var meta = [
    next.effectiveStart && next.effectiveEnd ? next.effectiveStart + '–' + next.effectiveEnd : next.effectiveStart || '全天',
    next.classroom || next.location,
    next.course,
    next.teacher,
  ]
    .filter(function (value) {
      return value && value !== ''
    })
    .join(' · ')

  return h(
    'div',
    { className: 'ot-card ot-next' },
    h(
      'div',
      { className: 'ot-next-main' },
      h(
        'div',
        { className: 'ot-next-time' },
        h('span', { className: 'ot-next-start' }, next.effectiveStart || '全天'),
        h('span', { className: 'ot-next-count' }, isCurrent ? '进行中 · 剩余 ' + Math.max(0, next.minutesUntilEnd || 0) + ' 分钟' : util.formatRelative(next.minutesUntilStart)),
      ),
      h('div', { className: 'ot-next-title', title: next.title }, next.title),
      h('div', { className: 'ot-next-meta' }, meta || '未填写地点'),
      h(
        'div',
        { className: 'ot-progress' },
        h('i', { style: { width: Math.round((isCurrent ? next.progress : 0) * 100) + '%' } }),
      ),
    ),
    h(
      'div',
      { className: 'ot-countdown' },
      isCurrent
        ? h('div', { className: 'ot-countdown-value' }, String(Math.max(0, next.minutesUntilEnd || 0)))
        : h('div', { className: 'ot-countdown-value' }, util.formatClock(remainingMs)),
      h('div', { className: 'ot-countdown-label' }, isCurrent ? '分钟后结束' : '后开始'),
    ),
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
      ui.button({ small: true, icon: 'refresh', title: '重新读取 Excel', onClick: function () { void props.onReimport() } }),
    ),
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
    h(NextCard, { next: snapshot && snapshot.nextEvent, now: now }),
    h('div', { style: { height: 12 } }),
    h(
      'div',
      { className: 'ot-grid ot-grid-4' },
      ui.stat({ animKey: 'tl-count', icon: 'calendar', label: dayLabel(day) + '日程', value: String(stats.eventCount || events.length), foot: stats.label ? stats.label : '' }),
      ui.stat({ animKey: 'tl-total', icon: 'clock', label: '总时长', value: Math.round(((stats.totalMinutes || 0) / 60) * 10) / 10 + ' h', foot: '含休息间隙' }),
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
              now: now,
              showOwner: true,
              snoozeMinutes: util.safeArray(snapshot && snapshot.settings.reminders.snoozeMinutes)[0] || 5,
              onFocus: props.onFocus,
              onDelete: function (event) {
                store
                  .removeEvent(event.id)
                  .then(function () {
                    store.pushNotice({ level: 'info', title: '已删除', body: event.title })
                  })
                  .catch(function (error) {
                    store.pushNotice({ level: 'warn', title: '删除失败', body: String((error && error.message) || error) })
                  })
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
                return h(EventRow, { key: event.id, event: event, store: store, now: now, onFocus: props.onFocus })
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
