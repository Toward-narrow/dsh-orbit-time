/** Orbit Time client — the month calendar behind the timeline's 日历 button.
 *
 * The day strip shows ten days around today, which answers "what is next" and
 * cannot answer "which day did that roster put me on". Rosters are imported a
 * month or two ahead and land on scattered dates, so the calendar's job is the
 * long view: a whole month at a glance, every day that has anything marked on
 * it, and the items for whichever day is picked — without leaving the timeline.
 */

var util = require('./util.js')
var ui = require('./ui.js')
var React = util.React
var h = util.h

/** Monday-first, to match the grid the host builds. */
var WEEK_HEADS = ['一', '二', '三', '四', '五', '六', '日']

function monthKeyOf(dayKey) {
  return typeof dayKey === 'string' && /^\d{4}-\d{2}/.test(dayKey) ? dayKey.slice(0, 7) : util.todayKey().slice(0, 7)
}

/** How many event markers a cell will draw before it stops counting. */
var MAX_MARKERS = 3

function eventMarkers(cell) {
  var out = []
  if (cell.hasEvents !== true && cell.count <= 0) return out
  for (var i = 0; i < Math.min(cell.count, MAX_MARKERS); i += 1) {
    out.push(h('i', { key: i, className: 'ot-cal-mark' }))
  }
  if (cell.count > MAX_MARKERS) out.push(h('i', { key: 'more', className: 'ot-cal-mark ot-cal-mark-more' }))
  // A day whose schedules are all ticked off keeps a dot, hollowed out: the day
  // is not empty, it is done.
  if (cell.count === 0) out.push(h('i', { key: 'done', className: 'ot-cal-mark ot-cal-mark-done' }))
  return out
}

function cellTitle(cell) {
  var lines = [util.formatDay(cell.dayKey) + ' ' + (cell.label || '')]
  if (util.safeArray(cell.titles).length > 0) lines.push(util.safeArray(cell.titles).join('、'))
  else if (cell.count > 0) lines.push(cell.count + ' 条日程')
  else if (cell.hasEvents === true) lines.push('安排已完成')
  else lines.push('没有日程')
  return lines.join('\n')
}

function CalendarView(props) {
  var snapshot = props.snapshot
  var month = snapshot && snapshot.month
  var day = props.day
  if (!month || !Array.isArray(month.grid) || month.grid.length === 0) {
    return h(
      'div',
      { className: 'ot-cal' },
      h(ui.note, { variant: 'warn' }, '宿主进程还没返回月份数据——这一版宿主半需要重启一次（改了宿主代码，刷新页面不够）。'),
    )
  }

  var grid = month.grid
  var focus = null
  for (var i = 0; i < grid.length; i += 1) {
    if (grid[i].dayKey === day) focus = grid[i]
  }
  // The month carries the rows of the open day only — a whole month of full event
  // records is ~12 kB on a 4-second poll, and the panel never shows more than the
  // one day it has selected.
  var focusItems = util.safeArray(month.items)
  var completedHere = 0
  for (var j = 0; j < focusItems.length; j += 1) {
    if (focusItems[j].done === true) completedHere += 1
  }
  var activeHere = focusItems.length - completedHere
  if (focus && typeof focus.count === 'number' && focus.count > activeHere) activeHere = focus.count
  var todayKey = (snapshot.serverTime && snapshot.serverTime.dayKey) || util.todayKey()
  var monthKey = month.monthKey || monthKeyOf(day)
  var atTodayMonth = monthKey === todayKey.slice(0, 7)

  function pickDay(dayKey) {
    void props.onPickDay(dayKey)
  }

  function stepMonth(delta) {
    var key = delta < 0 ? month.prevMonth : month.nextMonth
    if (typeof key === 'string' && key !== '') void props.onMonth(key)
  }

  return h(
    'section',
    { className: 'ot-cal' },
    h(
      'div',
      { className: 'ot-cal-head' },
      ui.button({
        small: true,
        iconOnly: true,
        icon: 'chevron-left',
        className: 'ot-cal-flip',
        title: '上一个月',
        ariaLabel: '上一个月',
        onClick: function () {
          stepMonth(-1)
        },
      }),
      h(
        'div',
        { className: 'ot-cal-title' },
        h('b', null, month.title || monthKey),
        h('span', { className: 'ot-sub' }, focus ? util.formatDay(focus.dayKey) + ' · ' + (focus.label || '') : ''),
      ),
      h(
        'div',
        { className: 'ot-cal-summary' },
        // `dayCount` decides, not `eventCount`: a month whose only schedules are
        // ticked off still has dotted days, and saying "这个月没有日程" over them
        // would contradict the grid directly below the sentence.
        month.dayCount > 0
          ? month.dayCount +
            ' 天有日程 · 共 ' +
            month.eventCount +
            ' 条' +
            // "共 0 条" over a dotted grid is technically true and reads as a bug;
            // say where the counts went.
            (month.eventCount === 0 ? '（其余已完成）' : '')
          : h('span', { className: 'ot-sub' }, atTodayMonth ? '这个月还没有导入的日程' : '这个月没有日程'),
      ),
      h('div', { className: 'ot-headspace' }),
      ui.button({
        small: true,
        variant: 'primary',
        icon: 'plus',
        title: '在选中的这一天加一条自己的日程',
        onClick: function () {
          props.onAdd()
        },
      }, '加一条'),
      ui.button({
        small: true,
        icon: 'calendar',
        title: '回到今天所在的月份',
        disabled: atTodayMonth,
        onClick: function () {
          pickDay(todayKey)
        },
      }, '今天'),
      ui.button({
        small: true,
        iconOnly: true,
        icon: 'chevron-right',
        className: 'ot-cal-flip',
        title: '下一个月',
        ariaLabel: '下一个月',
        onClick: function () {
          stepMonth(1)
        },
      }),
    ),
    h(
      'div',
      { className: 'ot-cal-week' },
      WEEK_HEADS.map(function (label, index) {
        return h('span', { key: index }, label)
      }),
    ),
    h(
      'div',
      { className: 'ot-cal-grid' },
      grid.map(function (cell) {
        var outside = cell.inMonth === false
        return h(
          'button',
          {
            key: cell.dayKey,
            type: 'button',
            className: util.cx('ot-cal-cell', util.animationClass('cal:' + monthKey + ':' + cell.dayKey, null)),
            'data-outside': outside ? 'true' : 'false',
            'data-today': cell.isToday ? 'true' : 'false',
            'data-selected': cell.dayKey === day ? 'true' : 'false',
            'data-marked': cell.hasEvents === true || cell.count > 0 ? 'true' : 'false',
            title: cellTitle(cell),
            onClick: function () {
              pickDay(cell.dayKey)
            },
          },
          h('span', { className: 'ot-cal-daynum' }, String(cell.dayOfMonth)),
          h('span', { className: 'ot-cal-marks' }, eventMarkers(cell)),
        )
      }),
    ),
    h(
      'div',
      { className: 'ot-cal-items' },
      h(
        'div',
        { className: 'ot-cal-items-head' },
        h('b', null, util.formatDay(day) + ' ' + (focus ? focus.label : '')),
        activeHere > 0 ? h('span', { className: 'ot-tag' }, activeHere + ' 条') : null,
        activeHere === 0 && completedHere > 0 ? h('span', { className: 'ot-tag' }, '已完成 ' + completedHere + ' 条') : null,
      ),
      focusItems.length > 0
        ? focusItems.map(function (item) {
            return h(
              'div',
              { key: item.id, className: 'ot-cal-item', 'data-done': item.done ? 'true' : 'false' },
              h('span', { className: 'ot-cal-item-time' }, item.start || '全天'),
              h('span', { className: 'ot-cal-item-title', title: item.title }, item.title),
              item.origin === 'ai'
                ? h('span', { className: 'ot-tag ot-tag-ai' }, 'AI 读出')
                : item.manual === true
                  ? h('span', { className: 'ot-tag ot-tag-manual' }, '自己加的')
                  : null,
              item.place ? h('span', { className: 'ot-cal-item-place' }, item.place) : null,
              item.done ? h('span', { className: 'ot-cal-item-done' }, ui.glyph('check', 11), '已完成') : null,
            )
          })
        : h('div', { className: 'ot-sub' }, '这一天没有安排。'),
      h(
        'div',
        { className: 'ot-cal-actions' },
        h('span', { className: 'ot-sub' }, '点日期看那一天的完整时间轴；想加东西就点「加一条」'),
        h('div', { className: 'ot-headspace' }),
        ui.button({
          small: true,
          variant: 'ghost',
          icon: 'close',
          onClick: function () {
            props.onClose()
          },
        }, '收起日历'),
      ),
    ),
  )
}

exports.CalendarView = CalendarView
exports.monthKeyOf = monthKeyOf
