/** Orbit Time client — the Orbyt AI companion panel. */

var util = require('./util.js')
var ui = require('./ui.js')
var React = util.React
var h = util.h

var QUICK_ACTIONS = [
  { action: 'brief', label: '今日简报', icon: 'spark' },
  { action: 'prep', label: '准备下一个', icon: 'bell' },
  { action: 'gap', label: '找空档', icon: 'clock' },
  { action: 'focus', label: '开个番茄', icon: 'target' },
  { action: 'review', label: '复盘进度', icon: 'trending' },
  { action: 'mood', label: '状态建议', icon: 'flame' },
]

function labelFor(action) {
  for (var i = 0; i < QUICK_ACTIONS.length; i += 1) {
    if (QUICK_ACTIONS[i].action === action) return QUICK_ACTIONS[i].label
  }
  return action
}

function Message(props) {
  var message = props.message
  var store = props.store
  var isAI = message.role === 'ai'
  var chips = util.safeArray(message.chips).filter(function (chip) {
    return typeof chip === 'string' && chip !== ''
  })
  var fallback = message.fallback
  return h(
    'div',
    { className: util.cx('ot-msg', isAI ? 'ot-msg-ai' : 'ot-msg-user') },
    message.text ? h('div', null, message.text) : null,
    message.speak ? h('div', { className: 'ot-msg-speak' }, message.speak) : null,
    message.detail ? h('div', { className: 'ot-msg-detail' }, message.detail) : null,
    fallback
      ? h(
          'div',
          { className: 'ot-msg-trace', title: fallback.detail || '' },
          '这条由内置规则回答（' + describeFallback(fallback.reason) + '）',
        )
      : null,
    chips.length > 0
      ? h(
          'div',
          { className: 'ot-chips' },
          chips.map(function (chip, index) {
            var action = props.resolveChip ? props.resolveChip(chip) : null
            return h(
              'button',
              {
                key: 'chip' + index,
                type: 'button',
                className: 'ot-chipbtn',
                onClick: function () {
                  if (action !== null) props.onAction(action)
                  else props.onAsk(chip)
                },
              },
              chip,
            )
          }),
        )
      : null,
  )
}

/** Human phrasing for why the model was not used. */
function describeFallback(reason) {
  var table = {
    disabled: '模型已在设置里关闭',
    'no-service': '当前组合没有模型服务',
    'no-model': '没有解析到默认模型',
    threw: '模型调用出错',
    'model-error': '模型返回错误',
    aborted: '模型调用超时',
    empty: '模型没有返回内容',
    'not-attempted': '未尝试模型',
  }
  return table[reason] || String(reason || '未知原因')
}

function CompanionView(props) {
  var companion = props.companion
  var store = props.store
  var messages = util.safeArray(companion.messages)
  var pair = React.useState('')
  var draft = pair[0]
  var setDraft = pair[1]
  var scroller = React.useRef(null)

  React.useEffect(
    function () {
      var node = scroller.current
      if (node !== null) node.scrollTop = node.scrollHeight
    },
    [messages.length, companion.busy],
  )

  function send(action, extra) {
    var payload = Object.assign({}, extra || {})
    if (action === 'focus' && payload.minutes === undefined) {
      payload.minutes = (props.settings.pomodoro && props.settings.pomodoro.focusMinutes) || 25
    }
    void store.askCompanion(action, payload).catch(function () {})
  }

  function ask(question) {
    if (question.trim() === '') return
    void store.askCompanion('ask', { question: question.trim() }).catch(function () {})
  }

  /** Route a suggested chip back to a structured action when it names one. */
  function resolveChip(chip) {
    for (var i = 0; i < QUICK_ACTIONS.length; i += 1) {
      if (chip.indexOf(QUICK_ACTIONS[i].label) !== -1) return QUICK_ACTIONS[i].action
    }
    if (/开.*番茄|开始专注|专注/.test(chip)) return 'focus'
    if (/空档|空闲/.test(chip)) return 'gap'
    if (/简报|总结|概览/.test(chip)) return 'brief'
    if (/推后|顺延/.test(chip)) return 'prep'
    if (/提醒/.test(chip)) return 'brief'
    return null
  }

  var next = props.snapshot && props.snapshot.nextEvent
  var assistant = props.assistant || { mode: 'unknown', detail: '' }
  var usingModel = assistant.mode === 'model'

  React.useEffect(
    function () {
      void store.refreshAssistantStatus()
    },
    [store],
  )

  return h(
    'div',
    { className: 'ot-view ot-comp' },
    h(
      'div',
      { className: 'ot-comp-head' },
      h('div', { className: 'ot-avatar', 'data-busy': companion.busy ? 'true' : 'false' }),
      h(
        'div',
        null,
        h(
          'div',
          { className: 'ot-comp-name' },
          'Orbyt',
          h(
            'span',
            {
              className: util.cx('ot-model-chip', usingModel ? 'ot-model-chip-live' : 'ot-model-chip-local'),
              title: assistant.detail || '',
            },
            usingModel ? '模型在线' : '内置规则',
          ),
        ),
        h('div', { className: 'ot-comp-state' }, companion.busy ? '正在读你的日程…' : next ? '下一个：' + next.title + ' · ' + util.formatRelative(next.minutesUntilStart) : '待命中'),
      ),
      h('div', { className: 'ot-headspace' }),
      h(
        'div',
        { className: 'ot-sub', style: { textAlign: 'right' } },
        props.ownerNames.length > 0 ? '关注 ' + props.ownerNames[0] : '未设置姓名',
        assistant.detail ? h('div', { style: { fontSize: 10.5, opacity: 0.75 } }, assistant.detail) : null,
      ),
    ),
    h(
      'div',
      { className: 'ot-chips', style: { marginTop: 2 } },
      QUICK_ACTIONS.map(function (item) {
        return h(
          'button',
          {
            key: item.action,
            type: 'button',
            className: 'ot-chipbtn',
            disabled: companion.busy,
            onClick: function () {
              send(item.action)
            },
          },
          ui.glyph(item.icon, 11),
          ' ',
          item.label,
        )
      }),
    ),
    h(
      'div',
      { className: 'ot-msgs', ref: scroller },
      messages.map(function (message) {
        return h(Message, {
          key: message.id,
          message: message,
          store: store,
          onAction: function (action) {
            send(action)
          },
          onAsk: ask,
          resolveChip: resolveChip,
        })
      }),
      companion.busy
        ? h(
            'div',
            { className: 'ot-msg ot-msg-ai' },
            h('span', { className: 'ot-typing' }, h('i'), h('i'), h('i')),
          )
        : null,
    ),
    h(
      'div',
      { className: 'ot-composer' },
      h('input', {
        className: 'ot-input',
        type: 'text',
        placeholder: '问我：今天最该先做什么？',
        value: draft,
        onChange: function (event) {
          setDraft(event.target.value)
        },
        onKeyDown: function (event) {
          if (event.key === 'Enter' && !event.shiftKey) {
            ask(draft)
            setDraft('')
          }
        },
      }),
      ui.button({
        variant: 'primary',
        icon: 'spark',
        disabled: companion.busy || draft.trim() === '',
        onClick: function () {
          ask(draft)
          setDraft('')
        },
      }, '发送'),
    ),
    h(
      'div',
      { className: 'ot-sub', style: { fontSize: 11 } },
      usingModel
        ? 'Orbyt 用当前默认模型回答，并且只把上面这份日程数据交给它——它看不到别的东西，每次提问会消耗少量额度。'
        : 'Orbyt 目前用内置规则回答：完全基于你已导入的日程与番茄数据本地生成，不消耗模型额度。',
    ),
  )
}

exports.CompanionView = CompanionView
exports.QUICK_ACTIONS = QUICK_ACTIONS
