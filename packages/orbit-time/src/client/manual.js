/** Orbit Time client — adding one event by hand, and correcting one that moved.
 *
 * The Excel pipeline answers "what did the roster put me on". It cannot answer
 * "remind me about this at 3pm" — a workbook row is the only thing the importer
 * knows how to make, so anything not in a roster had nowhere to go. This form is
 * that somewhere: click the date on the calendar, type one line, done.
 *
 * It is also the correction surface. Whatever the row's origin, the same form
 * opens over it with its current values, and saving sends an `edit` that becomes
 * an override — see `CORRECTABLE` in the host half for why the roster row itself
 * is never rewritten.
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

/**
 * How a row knows when it happens.
 *
 * This is the answer to "有些事情的结束时间不好设置". Forcing every row into a
 * start and an end made the app invent one, and an invented end is worse than no
 * end: it says you are free at a time you are not, and it hides the rest of the
 * day behind a block that looks busy but is not.
 *
 *   span  有开始也有结束 — a lecture, a meeting, a shift
 *   open  开始了，做完为止 — a task you cannot timebox
 *   due   只有一个截止时刻 — a submission deadline
 */
var SHAPES = [
  {
    key: 'span',
    label: '有起止时间',
    hint: '课表、会议这种知道几点结束的',
  },
  {
    key: 'open',
    label: '只有开始',
    hint: '做到几点不好说，做完再点完成',
  },
  {
    key: 'due',
    label: '只要截止',
    hint: '只有交作业 / 报名这类一个时刻',
  },
]

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
    // A new row still defaults to a span: that is what most rows are, and the
    // other two shapes are one click away rather than the default surprise.
    timeShape: 'span',
    end: util.addMinutes(start, 60),
    location: '',
    notes: '',
  }
}

/**
 * The draft for an existing row, so the form opens on its real values.
 *
 * Reads `effective*` rather than the raw fields: an imported row that was already
 * corrected has to show the corrected time, or saving again would quietly revert
 * it to what the roster said.
 */
function draftFromEvent(event) {
  var shape = event.timeShape === 'open' || event.timeShape === 'due' ? event.timeShape : 'span'
  return {
    id: event.id,
    date: event.effectiveDate || event.date || util.todayKey(),
    title: event.effectiveTitle || event.title || '',
    start: event.effectiveStart || event.start || '',
    timeShape: shape,
    end: shape === 'span' ? event.effectiveEnd || event.end || '' : '',
    location: event.location || '',
    notes: event.notes || '',
    // Remembered so "看起来没改" saves nothing and the panel can say so.
    original: {
      title: event.effectiveTitle || event.title || '',
      date: event.effectiveDate || event.date || '',
      start: event.effectiveStart || event.start || '',
      end: event.effectiveEnd || event.end || '',
      timeShape: shape,
      location: event.location || '',
      notes: event.notes || '',
    },
  }
}

/**
 * The add / edit form.
 *
 * Kept deliberately small. Every other field the event model carries (course,
 * teacher, category…) is either something the roster knows or something that can
 * be typed into the title; asking for them would turn "remind me at 3" into a
 * data-entry form. `onSaved` gets the day the event landed on, because the panel
 * may need to follow it.
 *
 * `now` arrives as the panel's millisecond clock — that is what the timeline
 * hands every child — not as a Date. Calling `getHours()` on it threw inside this
 * form's first render, and because the panel has no error boundary the entire
 * page went blank. Coercing once, here, is the whole fix.
 */
function ManualEventForm(props) {
  var now = new Date(typeof props.now === 'number' ? props.now : Date.now())
  var editing = typeof props.event === 'object' && props.event !== null
  var pair = React.useState(function () {
    return editing ? draftFromEvent(props.event) : blankDraft(props.day, now)
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
        if (key === 'start' && next.timeShape === 'span' && util.toMinutes(value) !== null && (util.toMinutes(previous.end) || 0) <= util.toMinutes(value)) {
          next.end = util.addMinutes(value, 60)
        }
        return next
      })
    }
  }

  /** Switching shape decides whether the end field is even shown. */
  function setShape(shape) {
    setDraft(function (previous) {
      var next = Object.assign({}, previous)
      next.timeShape = shape
      if (shape !== 'span') next.end = ''
      else if (next.end === '') next.end = util.addMinutes(next.start, 60)
      return next
    })
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
    if (draft.timeShape === 'span' && draft.start !== '' && draft.end !== '' && util.toMinutes(draft.end) !== null && util.toMinutes(draft.start) !== null) {
      if (util.toMinutes(draft.end) === util.toMinutes(draft.start)) {
        setError('开始和结束不能是同一时刻；要「没有结束时间」，把上面切成「只有开始」。')
        return
      }
    }
    setError('')
    setBusy(true)

    var payload = {
      date: draft.date,
      // An open or due row has no end by definition. Sending the stale `end` here
      // is how a shape change would be silently undone on the next read.
      start: draft.start,
      end: draft.timeShape === 'span' ? draft.end : '',
      timeShape: draft.timeShape,
      title: title,
      location: String(draft.location || '').trim(),
      notes: String(draft.notes || '').trim(),
    }

    var work
    if (editing) {
      // Only what actually changed, so an untouched field keeps following the
      // roster if the roster is later corrected. Saving an identical form sends
      // an empty patch, which the host refuses — so it is short-circuited here.
      var patch = {}
      Object.keys(payload).forEach(function (key) {
        if (String(payload[key]) !== String(draft.original[key] ?? '')) patch[key] = payload[key]
      })
      if (Object.keys(patch).length === 0) {
        setBusy(false)
        if (typeof props.onCancel === 'function') props.onCancel()
        return
      }
      work = props.store.updateEvent(draft.id, patch)
    } else {
      // No owner: this row is not from a roster, and pretending a name here
      // would make the next import compare against it.
      work = props.store.addEvent(Object.assign({ manual: true }, payload))
    }

    work
      .then(function (day) {
        setBusy(false)
        // No "已保存" toast. The form closes, the panel jumps to the day it
        // landed on, and the row is right there — that *is* the confirmation.
        if (typeof props.onSaved === 'function') props.onSaved(day || draft.date)
      })
      .catch(function (failure) {
        setBusy(false)
        setError(String((failure && failure.message) || failure))
      })
  }

  var shapeHint = '只写这一行也行；时间留空就是全天备忘'
  for (var i = 0; i < SHAPES.length; i += 1) {
    if (SHAPES[i].key === draft.timeShape) shapeHint = SHAPES[i].hint
  }

  return h(
    'form',
    { className: 'ot-add' + (editing ? ' ot-add-edit' : ''), onSubmit: submit },
    h(
      'div',
      { className: 'ot-add-head' },
      h('b', null, editing ? '改这一条' : '直接加一条'),
      h('span', { className: 'ot-sub' }, shapeHint),
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
      { className: 'ot-add-shapes', role: 'radiogroup', 'aria-label': '这条日程的时间形式' },
      SHAPES.map(function (shape) {
        return h(
          'button',
          {
            key: shape.key,
            type: 'button',
            role: 'radio',
            'aria-checked': draft.timeShape === shape.key ? 'true' : 'false',
            className: 'ot-shape' + (draft.timeShape === shape.key ? ' ot-shape-on' : ''),
            title: shape.hint,
            onClick: function () {
              setShape(shape.key)
            },
          },
          h('span', { className: 'ot-shape-dot' }),
          h('span', null, shape.label),
        )
      }),
    ),
    h(
      'div',
      { className: 'ot-add-grid' + (draft.timeShape === 'span' ? '' : ' ot-add-grid-no-end') },
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
        h('span', null, draft.timeShape === 'due' ? '截止' : '开始'),
        h('input', { className: 'ot-input', type: 'time', value: draft.start, onChange: edit('start') }),
      ),
      // The end field exists only where it means something. Showing a greyed-out
      // one for the other two shapes invites the user to fill in exactly the
      // number they just said they do not know.
      draft.timeShape === 'span'
        ? h(
            'label',
            null,
            h('span', null, '结束'),
            h('input', { className: 'ot-input', type: 'time', value: draft.end, onChange: edit('end') }),
          )
        : h(
            'div',
            { className: 'ot-add-note' },
            h('span', null, '结束'),
            h('b', null, draft.timeShape === 'due' ? '不需要' : '不设'),
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
      h(
        'label',
        { className: 'ot-add-notes' },
        h('span', null, '备注'),
        h('input', {
          className: 'ot-input',
          type: 'text',
          value: draft.notes,
          placeholder: '可不填',
          onChange: edit('notes'),
        }),
      ),
    ),
    h(
      'div',
      { className: 'ot-add-foot' },
      h(
        'span',
        { className: 'ot-sub' },
        editing
          ? '改的是这一条在你眼里的时间与标题；Excel 原表不动，重新导入也不会把它改回去。'
          : '提醒节奏跟着设置里的来；这条是你自己加的，重新导入 Excel 也不会被覆盖。',
      ),
      h('div', { className: 'ot-headspace' }),
      editing && props.onReset
        ? ui.button({
            small: true,
            variant: 'ghost',
            icon: 'refresh',
            title: '丢掉所有修改，回到 Excel 里的原样',
            disabled: busy,
            onClick: function () {
              setBusy(true)
              setError('')
              Promise.resolve()
                .then(function () {
                  return props.onReset()
                })
                .catch(function (failure) {
                  setBusy(false)
                  setError(String((failure && failure.message) || failure))
                })
            },
          }, '还原')
        : null,
      ui.button({
        small: true,
        variant: 'primary',
        icon: editing ? 'check' : 'plus',
        disabled: busy,
        onClick: submit,
      }, busy ? '正在保存…' : editing ? '保存修改' : '加进日程'),
    ),
    error !== '' ? ui.note({ variant: 'warn' }, error) : null,
  )
}

/**
 * The few controls a row carries when it is being changed rather than completed.
 *
 * Separate from the row's main action set on purpose: "完成 / 稍后 / 顺延" are
 * things you do *to* a schedule, while these change what the schedule says. Mixing
 * them into one strip made the destructive one (删除) sit next to the frequent one
 * (完成) with nothing but an icon between them.
 */
function EventEditor(props) {
  return h(
    'div',
    { className: 'ot-ev-edit' },
    h(ManualEventForm, {
      store: props.store,
      day: props.event.effectiveDate || props.event.date || props.day,
      now: props.now,
      event: props.event,
      onCancel: props.onCancel,
      onSaved: props.onSaved,
      onReset: props.onReset,
    }),
  )
}

exports.ManualEventForm = ManualEventForm
exports.EventEditor = EventEditor
exports.blankDraft = blankDraft
exports.nextHourClock = nextHourClock
exports.draftFromEvent = draftFromEvent
exports.SHAPES = SHAPES
