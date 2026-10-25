/** Orbit Time client — settings, floating-window control, and the activity feed. */

var util = require('./util.js')
var ui = require('./ui.js')
var importView = require('./import-view.js')
var React = util.React
var h = util.h

function relativeAge(iso) {
  if (typeof iso !== 'string' || iso === '') return ''
  var then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  var seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return seconds + ' 秒前'
  if (seconds < 3600) return Math.round(seconds / 60) + ' 分钟前'
  if (seconds < 86400) return Math.round(seconds / 3600) + ' 小时前'
  return Math.round(seconds / 86400) + ' 天前'
}

function HudCard(props) {
  var store = props.store
  var snapshot = props.snapshot
  var settings = snapshot.settings
  var pair = React.useState(null)
  var status = pair[0]
  var setStatus = pair[1]
  var busyPair = React.useState(false)
  var busy = busyPair[0]
  var setBusy = busyPair[1]

  React.useEffect(
    function () {
      store
        .hudStatus()
        .then(function (payload) {
          setStatus(payload)
        })
        .catch(function () {
          setStatus({ ok: false, running: false })
        })
    },
    [store],
  )

  function start() {
    setBusy(true)
    store
      .openFloatWindow()
      .then(function (payload) {
        setStatus({ ok: payload.ok, running: payload.running === true, mode: payload.mode || 'pill' })
      })
      .catch(function (error) {
        store.pushNotice({ level: 'warn', title: '悬浮窗启动失败', body: String((error && error.message) || error) })
      })
      .then(function () {
        setBusy(false)
      })
  }

  function stop() {
    setBusy(true)
    store
      .stopFloatWindow()
      .then(function () {
        setStatus({ ok: true, running: false, mode: 'closed', closedByUser: true })
      })
      .catch(function () {})
      .then(function () {
        setBusy(false)
      })
  }

  var running = status !== null && status.running === true
  var mode = status !== null && status.mode ? status.mode : running ? 'pill' : 'closed'
  var closedByUser = status !== null && status.closedByUser === true

  function switchMode(next) {
    setBusy(true)
    store
      .setFloatMode(next)
      .then(function (payload) {
        setStatus({ ok: payload.ok !== false, running: payload.running === true, mode: payload.mode || next })
      })
      .catch(function (error) {
        store.pushNotice({ level: 'warn', title: '悬浮窗操作失败', body: String((error && error.message) || error) })
      })
      .then(function () {
        setBusy(false)
      })
  }

  var MODES = [
    { id: 'pill', label: '完整胶囊', hint: '232 × 64，圆环 + 倒计时 + 当前日程' },
    { id: 'mini', label: '最小圆点', hint: '56 × 56，只留一圈进度和剩余分钟' },
    { id: 'closed', label: '关闭', hint: '不显示，下次启动也不会自己冒出来' },
  ]

  return ui.card({
    title: '悬浮窗与界面',
    children: h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
      h(
        'div',
        { className: 'ot-row' },
        h(
          'span',
          { className: 'ot-chip ' + (running ? 'ot-chip-live' : closedByUser ? '' : 'ot-chip-warn') },
          running ? (mode === 'mini' ? '悬浮窗运行中 · 最小圆点' : '悬浮窗运行中 · 完整胶囊') : closedByUser ? '悬浮窗已关闭' : '悬浮窗未启动',
        ),
        ui.button({ variant: running ? undefined : 'primary', icon: 'expand', disabled: busy, onClick: start }, running ? '重新启动' : '重新显示'),
        running ? ui.button({ icon: 'close', disabled: busy, onClick: stop }, '关闭悬浮窗') : null,
      ),
      h(
        'div',
        { className: 'ot-seg' },
        MODES.map(function (entry) {
          return h(
            'button',
            {
              key: entry.id,
              type: 'button',
              className: 'ot-seg-item' + (mode === entry.id ? ' is-active' : ''),
              disabled: busy,
              title: entry.hint,
              onClick: function () {
                if (entry.id === mode) return
                switchMode(entry.id)
              },
            },
            entry.label,
          )
        }),
      ),
      h(
        'div',
        { className: 'ot-sub' },
        '桌面悬浮窗：圆环 = 开始/暂停，— = 最小化成小圆点，» = 打开面板，× = 关闭（关闭后不会自己回来，除非你在这里点「重新显示」）。最小态下 + 展开、× 关闭，底部那条三点拖动条是唯一能拖动窗口的地方；位置会被记住，拖到屏幕外会被自动拉回来。右键出菜单，双击打开主面板。',
      ),
      h(
        'div',
        { className: 'ot-sub' },
        '页面里的小卡片（下面这个开关控制的）：按住左侧的 ⠿ 才能拖动（只有它是拖动区，按钮和数字不会再被误拖走），位置记在浏览器里；— 收起成小圆点，⤢ 展开，× 把它从面板上拿掉 —— 关掉就是关掉，不留任何东西；想再看到它，把这个开关关掉再打开即可。',
      ),
      h('div', { style: { height: 2 } }),
      ui.switchRow({
        label: 'DSH 主窗口内也显示迷你悬浮卡片',
        checked: !(settings.ui && settings.ui.showFloatingWidget === false),
        onChange: function (value) {
          void store.saveSettings({ ui: { showFloatingWidget: value } })
        },
      }),
      ui.switchRow({
        label: '番茄完成时播放提示音',
        checked: settings.reminders.sound !== false,
        onChange: function (value) {
          void store.saveSettings({ reminders: { sound: value } })
        },
      }),
    ),
  })
}

function FeedCard(props) {
  var store = props.store
  var feed = util.safeArray(props.feed)
  return ui.card({
    title: '提醒与动态',
    aside: h('div', { className: 'ot-headspace' }),
    children: h(
      'div',
      null,
      h(
        'div',
        { className: 'ot-row', style: { marginBottom: 9 } },
        h('span', { className: 'ot-sub' }, feed.length + ' 条记录（宿主进程产生，浏览器关掉也会继续记）'),
        h('div', { className: 'ot-headspace' }),
        ui.button({
          small: true,
          variant: 'ghost',
          icon: 'close',
          onClick: function () {
            void store.clearFeed().catch(function () {})
          },
        }, '清空'),
      ),
      feed.length === 0
        ? h('div', { className: 'ot-empty' }, h('b', null, '还没有动态'), h('span', null, '导入日程后，提醒会出现在这里，同时弹出 Windows 通知。'))
        : h(
            'div',
            { className: 'ot-feed' },
            feed.map(function (entry) {
              return h(
                'div',
                { key: entry.seq || entry.at, className: 'ot-feed-item', 'data-level': entry.level || 'info' },
                h('span', { className: 'ot-feed-time' }, relativeAge(entry.at)),
                h(
                  'div',
                  { style: { minWidth: 0 } },
                  h('div', { className: 'ot-feed-title' }, entry.title || ''),
                  entry.body ? h('div', { className: 'ot-feed-body' }, entry.body) : null,
                ),
              )
            }),
          ),
    ),
  })
}

function AssistantCard(props) {
  var store = props.store
  var snapshot = props.snapshot
  var settings = snapshot.settings
  var assistant = props.assistant || { mode: 'unknown', detail: '' }
  var useModel = !(settings.assistant && settings.assistant.useModel === false)
  var model = (settings.assistant && settings.assistant.maxTokens) || 700

  React.useEffect(
    function () {
      void store.refreshAssistantStatus()
    },
    [store],
  )

  var live = assistant.mode === 'model'

  return ui.card({
    title: 'AI 助手 Orbyt',
    children: h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
      h(
        'div',
        { className: 'ot-row' },
        h(
          'span',
          { className: util.cx('ot-chip', live ? 'ot-chip-live' : 'ot-chip-warn') },
          live ? '模型在线' : '内置规则',
        ),
        assistant.detail ? h('span', { className: 'ot-chip' }, assistant.detail) : null,
      ),
      ui.switchRow({
        label: '用当前默认模型回答（关掉则纯本地规则，不消耗额度）',
        checked: useModel,
        onChange: function (value) {
          void store
            .saveSettings({ assistant: { useModel: value } })
            .then(function () {
              return store.refreshAssistantStatus()
            })
            .catch(function () {})
        },
      }),
      h(
        'div',
        { className: 'ot-sub' },
        useModel
          ? '开启后，自由提问和动作按钮由模型回答：只把上面那份日程 JSON 交给它，它看不到别的东西；每次提问会消耗少量额度。模型不可用时自动回落到内置规则，并在气泡下方标注原因。'
          : '当前所有回答都由内置规则在本地生成：按你的真实日程算时间、空档、番茄进度，不联网、不消耗额度。',
      ),
      h(
        'div',
        { className: 'ot-row' },
        ui.numberField({
          label: '单次回答上限',
          value: model,
          min: 100,
          max: 4000,
          suffix: 'tokens',
          onChange: function (value) {
            void store.saveSettings({ assistant: { maxTokens: value } }).catch(function () {})
          },
        }),
        ui.numberField({
          label: '携带历史',
          value: (settings.assistant && settings.assistant.historyTurns) || 6,
          min: 0,
          max: 20,
          suffix: '轮',
          onChange: function (value) {
            void store.saveSettings({ assistant: { historyTurns: value } }).catch(function () {})
          },
        }),
      ),
    ),
  })
}

function SettingsView(props) {
  var store = props.store
  var snapshot = props.snapshot
  var settings = snapshot.settings
  var pair = React.useState(null)
  var replyDraft = pair[0]
  var setReplyDraft = pair[1]
  var messages = util.safeArray(snapshot && snapshot.feed).filter(function (entry) {
    return entry.kind === 'reminder'
  })

  return h(
    'div',
    { className: 'ot-view' },
    // `onOpenTimeline` lets the import confirmation offer "查看日程时间轴" right
    // after an import, which is the moment a user wants to check the result.
    h(importView.ImportView, { store: store, snapshot: snapshot, onOpenTimeline: props.onOpenTimeline }),
    h('div', { style: { height: 12 } }),
    h(AssistantCard, { store: store, snapshot: snapshot, assistant: props.assistant }),
    h('div', { style: { height: 12 } }),
    h(HudCard, { store: store, snapshot: snapshot }),
    h('div', { style: { height: 12 } }),
    h(FeedCard, { store: store, feed: snapshot.feed }),
    h('div', { style: { height: 12 } }),
    ui.card({
      title: '提醒话术（可留空用默认）',
      children: h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h(
          'div',
          { className: 'ot-sub' },
          '已触发 ' + messages.length + ' 次日程提醒。提醒文案由宿主生成，按「还有多久开始」自动措辞。',
        ),
        h(
          'div',
          { className: 'ot-row' },
          ui.button({
            small: true,
            icon: 'bell',
            onClick: function () {
              void store
                .request('/assistant', { method: 'POST', body: JSON.stringify({ action: 'brief' }) })
                .catch(function () {})
            },
          }, '生成一条测试动态'),
          ui.button({
            small: true,
            variant: 'ghost',
            icon: 'reset',
            onClick: function () {
              void store
                .request('/events', { method: 'POST', body: JSON.stringify({ action: 'reset', id: '__all__' }) })
                .catch(function () {})
                .then(function () {
                  store.pushNotice({ level: 'info', title: '已重置提醒状态', body: '所有日程的提醒会重新计时。' })
                })
            },
          }, '重置提醒状态'),
        ),
        h('input', {
          className: 'ot-input',
          type: 'text',
          value: replyDraft === null ? '' : replyDraft,
          placeholder: '自定义签名（仅本地显示）',
          onChange: function (event) {
            setReplyDraft(event.target.value)
          },
        }),
      ),
    }),
  )
}

exports.SettingsView = SettingsView
exports.HudCard = HudCard
exports.FeedCard = FeedCard
exports.AssistantCard = AssistantCard
