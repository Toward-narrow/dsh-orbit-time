/** Orbit Time client — Pomodoro focus view. */

var util = require('./util.js')
var ui = require('./ui.js')
var React = util.React
var h = util.h

var PHASE_TEXT = {
  idle: '准备开始',
  focus: '专注中',
  short: '短休息',
  long: '长休息',
}

var PHASE_HINT = {
  idle: '选一个主题，然后开始一个番茄',
  focus: '别切窗口，把注意力留在这一件事上',
  short: '站起来走走，看看远处',
  long: '好好休息，回来再战',
}

function PomodoroView(props) {
  var timer = props.timer
  var settings = props.settings
  var pomodoro = settings.pomodoro
  var now = props.now
  var pair = React.useState('')
  var draftSubject = pair[0]
  var setDraftSubject = pair[1]
  var lastPhase = React.useRef(timer.phase)

  React.useEffect(
    function () {
      if (lastPhase.current !== timer.phase) {
        lastPhase.current = timer.phase
        setDraftSubject('')
      }
    },
    [timer.phase],
  )

  var busyPair = React.useState(false)
  var busy = busyPair[0]
  var setBusy = busyPair[1]

  function run(action, extra) {
    setBusy(true)
    props.store
      .timerAction(action, extra)
      .catch(function (error) {
        props.store.pushNotice({ level: 'warn', title: '计时器操作失败', body: String((error && error.message) || error) })
      })
      .then(function () {
        setBusy(false)
      })
  }

  function save(patch) {
    props.store.saveSettings({ pomodoro: patch }).catch(function (error) {
      props.store.pushNotice({ level: 'warn', title: '保存失败', body: String((error && error.message) || error) })
    })
  }

  var totalRounds = Math.max(1, Number(pomodoro.roundsBeforeLongBreak) || 4)
  var doneInCycle = timer.phase === 'idle' ? 0 : ((timer.completedToday % totalRounds) + totalRounds) % totalRounds
  var rounds = []
  for (var index = 0; index < totalRounds; index += 1) {
    rounds.push(
      h('i', {
        key: 'r' + index,
        className: 'ot-round',
        'data-done': index < doneInCycle ? 'true' : 'false',
        'data-current': timer.phase === 'focus' && index === doneInCycle ? 'true' : 'false',
      }),
    )
  }

  var goal = Math.max(1, Number(pomodoro.dailyGoalRounds) || 8)
  var goalRatio = util.clamp(timer.completedToday / goal, 0, 1)
  var isBreak = timer.phase === 'short' || timer.phase === 'long'

  return h(
    'div',
    { className: 'ot-view' },
    h(
      'div',
      { className: 'ot-card ot-card-pad' },
      h(
        'div',
        { className: 'ot-pomo' },
        ui.ring({
          size: 208,
          progress: timer.progress,
          running: timer.running,
          break: isBreak,
          label: PHASE_TEXT[timer.phase] + ' ' + util.formatClock(timer.remainingMs),
          children: [
            h('div', { className: 'ot-ring-time', key: 'time' }, util.formatClock(timer.remainingMs)),
            h('div', { className: 'ot-ring-phase', key: 'phase' }, PHASE_TEXT[timer.phase] || timer.phase),
            timer.subject ? h('div', { className: 'ot-ring-subject', key: 'subject', title: timer.subject }, timer.subject) : null,
          ],
        }),
        h(
          'div',
          { className: 'ot-pomo-side' },
          h('div', { className: 'ot-sub' }, PHASE_HINT[timer.phase] || ''),
          h(
            'div',
            { className: 'ot-row' },
            timer.running
              ? ui.button({ variant: 'primary', icon: 'pause', onClick: function () { run('pause') }, disabled: busy }, '暂停')
              : ui.button(
                  {
                    variant: 'primary',
                    icon: 'play',
                    onClick: function () {
                      if (timer.phase === 'idle' || timer.remainingMs <= 0) run('start', { phase: 'focus', subject: draftSubject || timer.subject })
                      else run('resume')
                    },
                    disabled: busy,
                  },
                  timer.phase === 'idle' || timer.remainingMs <= 0 ? '开始专注' : '继续',
                ),
            ui.button({ icon: 'skip', onClick: function () { run('skip') }, disabled: busy, title: isBreak ? '跳到专注' : '完成并休息' }),
            ui.button({ icon: 'reset', onClick: function () { run('reset') }, disabled: busy, title: '重置' }),
          ),
          h('div', { className: 'ot-field' },
            h('span', { className: 'ot-field-label' }, '专注主题'),
            h('input', {
              className: 'ot-input',
              type: 'text',
              // Show what the running phase is actually about; the field is only
              // a draft when nothing is in flight.
              placeholder: timer.phase === 'idle' && props.nextTitle ? '例如：' + props.nextTitle : '这个番茄要做什么？',
              value: draftSubject !== '' ? draftSubject : timer.phase === 'idle' ? '' : timer.subject,
              onChange: function (event) {
                setDraftSubject(event.target.value)
              },
              onKeyDown: function (event) {
                if (event.key === 'Enter') run('start', { phase: 'focus', subject: draftSubject || timer.subject })
              },
            }),
          ),
          h('div', { className: 'ot-row' },
            h('span', { className: 'ot-sub' }, '本轮'),
            h('div', { className: 'ot-rounds' }, rounds),
          ),
          h('div', { className: 'ot-row' },
            h('span', { className: 'ot-sub' }, '今日目标'),
            h('div', { className: 'ot-progress', style: { flex: 1, marginTop: 0 } },
              h('i', { style: { width: Math.round(goalRatio * 100) + '%' } }),
            ),
            h('span', { className: 'ot-sub ot-mono' }, timer.completedToday + '/' + goal),
          ),
        ),
      ),
    ),
    h('div', { style: { height: 12 } }),
    h(
      'div',
      { className: 'ot-grid ot-grid-4' },
      ui.stat({ animKey: 'pomo-done', icon: 'flame', label: '今日番茄', value: String(timer.completedToday), foot: timer.completedToday >= goal ? '目标已达成 🎉' : '还差 ' + (goal - timer.completedToday) + ' 个' }),
      ui.stat({ animKey: 'pomo-min', icon: 'clock', label: '专注时长', value: Math.round((timer.completedToday * (Number(pomodoro.focusMinutes) || 25)) / 60 * 10) / 10 + ' h', foot: '每个 ' + pomodoro.focusMinutes + ' 分钟' }),
      ui.stat({ animKey: 'pomo-cycle', icon: 'target', label: '本周期', value: doneInCycle + '/' + totalRounds, foot: '之后进入 ' + pomodoro.longBreakMinutes + ' 分钟长休息' }),
      ui.stat({
        animKey: 'pomo-next',
        icon: 'trending',
        label: '最近日程',
        value: props.nextTitle ? props.nextRelative || '--' : '--',
        foot: props.nextTitle || '今天没有后续日程',
      }),
    ),
    h('div', { style: { height: 12 } }),
    ui.card({
      title: '番茄钟设置',
      children: h(
        'div',
        { className: 'ot-grid ot-grid-2' },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          ui.numberField({ label: '专注时长', value: pomodoro.focusMinutes, min: 1, max: 180, suffix: '分钟', onChange: function (value) { save({ focusMinutes: value }) } }),
          ui.numberField({ label: '短休息', value: pomodoro.shortBreakMinutes, min: 1, max: 60, suffix: '分钟', onChange: function (value) { save({ shortBreakMinutes: value }) } }),
          ui.numberField({ label: '长休息', value: pomodoro.longBreakMinutes, min: 1, max: 120, suffix: '分钟', onChange: function (value) { save({ longBreakMinutes: value }) } }),
          ui.numberField({ label: '长休息间隔', value: pomodoro.roundsBeforeLongBreak, min: 2, max: 12, suffix: '个番茄', onChange: function (value) { save({ roundsBeforeLongBreak: value }) } }),
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          ui.numberField({ label: '每日目标', value: pomodoro.dailyGoalRounds, min: 1, max: 40, suffix: '个番茄', onChange: function (value) { save({ dailyGoalRounds: value }) } }),
          ui.switchRow({ label: '专注结束自动开始休息', checked: pomodoro.autoStartBreak, onChange: function (value) { save({ autoStartBreak: value }) } }),
          ui.switchRow({ label: '休息结束自动开始专注', checked: pomodoro.autoStartFocus, onChange: function (value) { save({ autoStartFocus: value }) } }),
          ui.note({ children: '计时由宿主进程驱动：即使关掉页面，番茄结束与日程提醒依然会通过 Windows 通知送达。' }),
        ),
      ),
    }),
    h('div', { style: { height: 10 } }),
    h('div', { className: 'ot-sub', style: { textAlign: 'right' } }, '页面时间 ' + new Date(now).toLocaleTimeString('zh-CN', { hour12: false })),
  )
}

exports.PomodoroView = PomodoroView
