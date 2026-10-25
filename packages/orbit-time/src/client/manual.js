/** Orbit Time client — adding one event by hand.
 *
 * The Excel pipeline answers "what did the roster put me on". It cannot answer
 * "remind me about this at 3pm" — a workbook row is the only thing the importer
 * knows how to make, so anything not in a roster had nowhere to go. This form is
 * that somewhere: click the date on the calendar, type one line, done.
 *
 * Rows created here are marked as hand-added by the host and are kept across
 * re-imports (see `MANUAL_SHEET` in the host half), so they behave like the rest
 * of the schedule: reminders, the timeline, the companion, and the calendar all
 * treat them as ordinary events.
 */

var util = require('./util.js')
var ui = require('./ui.js')
var React = util.React
var h = util.h

/** Minutes past the hour, so `nextHourClock` never has to parse a clock string. */
function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes()
}

/** The next full hour, so a blank form opens on a round time. */
function nextHourClock(now) {
  var minutes = minutesOfDay(now)
  var next = (Math.floor(minutes / 60) + 1) * 60
  return next >= 1440 ? '23:00' : util.fromMinutes(next)
}

function blankDraft(dayKey, now) {
  var start = nextHourClock(now)
  return {
    date: dayKey,
    title: '',
    start: start,
    end: util.addMinutes(start, 60),
    location: '',
  }
}

/**
 * The add-event form.
 *
 * Kept deliberately to five fields. Every other field the event model carries
 * (course, teacher, category, notes…) is either something the roster knows or
 * something that can be typed into the title; asking for them would turn "remind
 * me at 3" into a data-entry form. `onSaved` gets the day the event landed on,
 * because the panel may need to follow it.
 *
 * `now` arrives as the panel's millisecond clock — that is what the timeline
 * hands every child — not as a Date. Calling `getHours()` on it threw inside this
 * form's first render, and because the panel has no error boundary the entire
 * page went blank. Coercing once, here, is the whole fix.
 */
function ManualEventForm(props) {
  var now = new Date(typeof props.now === 'number' ? props.now : Date.now())
  var pair = React.useState(function () {
    return blankDraft(props.day, now)
  })
  var draft = pair[0]
  var setDraft = pair[1]
  var busyPair = React.useState(false)
  var busy = busyPair[0]
  var setBusy = busyPair[1]
  var errorPair = React.useState('')
  var error = errorPair[0]
  var setError = errorPair[1]

  function edit(key) {
    return function (event) {
      var value = event.target.value
      setDraft(function (previous) {
        var next = Object.assign({}, previous)
        next[key] = value
        // Keep the end behind the start while the user types the start: an end
        // that is now before it would be rejected by nothing and shown as a
        // negative duration only on the timeline.
        if (key === 'start' && util.toMinutes(value) !== null && (util.toMinutes(previous.end) || 0) <= util.toMinutes(value)) {
          next.end = util.addMinutes(value, 60)
        }
        return next
      })
    }
  }

  function submit(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    // The button and the form both submit; whichever arrives second is a no-op
    // rather than a second copy of the same event.
    if (busy === true) return
    var title = String(draft.title || '').trim()
    if (title === '') {
      setError('先写一句这是什么——比如「交实验报告」。')
      return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(draft.date || ''))) {
      setError('日期要写成 2026-03-02 这样。')
      return
    }
    setError('')
    setBusy(true)
    props.store
      .addEvent({
        date: draft.date,
        start: draft.start,
        end: draft.end,
        title: title,
        location: String(draft.location || '').trim(),
        // No owner: this row is not from a roster, and pretending a name here
        // would make the next import compare against it.
        manual: true,
      })
      .then(function (day) {
        setBusy(false)
        props.store.pushNotice({
          level: 'success',
          title: '已加进日程',
          body: title + ' · ' + draft.date + (draft.start ? ' ' + draft.start : ''),
        })
        if (typeof props.onSaved === 'function') props.onSaved(day)
      })
      .catch(function (failure) {
        setBusy(false)
        setError(String((failure && failure.message) || failure))
      })
  }

  return h(
    'form',
    { className: 'ot-add', onSubmit: submit },
    h(
      'div',
      { className: 'ot-add-head' },
      h('b', null, '直接加一条'),
      h('span', { className: 'ot-sub' }, '只写这一行也行；时间留空就是全天备忘'),
      h('div', { className: 'ot-headspace' }),
      ui.button({
        small: true,
        variant: 'ghost',
        icon: 'close',
        title: '收起',
        onClick: function () {
          props.onCancel()
        },
      }, '收起'),
    ),
    h(
      'div',
      { className: 'ot-add-grid' },
      h(
        'label',
        { className: 'ot-add-title' },
        h('span', null, '要做什么'),
        h('input', {
          className: 'ot-input',
          type: 'text',
          value: draft.title,
          placeholder: '例如：交实验报告 / 找导师确认选题',
          autoFocus: true,
          onChange: edit('title'),
          onKeyDown: function (event) {
            if (event.key === 'Escape') props.onCancel()
          },
        }),
      ),
      h(
        'label',
        null,
        h('span', null, '日期'),
        h('input', { className: 'ot-input', type: 'date', value: draft.date, onChange: edit('date') }),
      ),
      h(
        'label',
        null,
        h('span', null, '开始'),
        h('input', { className: 'ot-input', type: 'time', value: draft.start, onChange: edit('start') }),
      ),
      h(
        'label',
        null,
        h('span', null, '结束'),
        h('input', { className: 'ot-input', type: 'time', value: draft.end, onChange: edit('end') }),
      ),
      h(
        'label',
        null,
        h('span', null, '地点'),
        h('input', {
          className: 'ot-input',
          type: 'text',
          value: draft.location,
          placeholder: '可不填',
          onChange: edit('location'),
        }),
      ),
    ),
    h(
      'div',
      { className: 'ot-add-foot' },
      h(
        'span',
        { className: 'ot-sub' },
        '提醒节奏跟着设置里的来；这条是你自己加的，重新导入 Excel 也不会被覆盖。',
      ),
      h('div', { className: 'ot-headspace' }),
      ui.button({
        small: true,
        variant: 'primary',
        icon: 'plus',
        disabled: busy,
        onClick: submit,
      }, busy ? '正在保存…' : '加进日程'),
    ),
    error !== '' ? ui.note({ variant: 'warn' }, error) : null,
  )
}

exports.ManualEventForm = ManualEventForm
exports.blankDraft = blankDraft
exports.nextHourClock = nextHourClock
