/** Orbit Time client — deadlines read off the web.
 *
 * The Excel pipeline answers "what does the roster say", the document reader
 * answers "what does this file say", and this answers "what does the site I have
 * to log into say". Three sources, one destination: the timeline.
 *
 * The shape of the flow is deliberate:
 *
 *   log in → pick courses → read → *review* → commit
 *
 * Reading never writes to the schedule. A scraper that commits on its own makes a
 * bad selector indistinguishable from a scheduling decision, and the user only
 * finds out when a wrong item fires a reminder at 23:30.
 *
 * The password is component state, not store state: it goes straight from the
 * input to the host, which either discards it or encrypts it with DPAPI. Nothing
 * here keeps it after the request settles.
 */

var util = require('./util.js')
var ui = require('./ui.js')
var React = util.React
var h = util.h

var PLATFORM_LABELS = {
  icourse163: '中国大学MOOC',
  generic: '任意网页',
  ai: 'AI 智能页',
}

function readNetddl(store) {
  var state = store.get()
  return state.netddl || { platform: 'icourse163', status: null, busy: '', message: '', error: '', courses: [], items: [], notes: [], page: null }
}

/** `23:30` or `全天`; a deadline with no clock is the end of its day. */
function whenLabel(item) {
  return item.dueTime ? item.dueTime : '全天'
}

function daysUntil(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return null
  var target = new Date(dateKey + 'T00:00:00')
  var today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((target.getTime() - today.getTime()) / 86_400_000)
}

/** "还有 3 天" / "今天" / "已经过了" — the number that makes a list actionable. */
function countdownLabel(dateKey) {
  var days = daysUntil(dateKey)
  if (days === null) return ''
  if (days < 0) return '已过期'
  if (days === 0) return '今天'
  if (days === 1) return '明天'
  if (days <= 14) return days + ' 天后'
  return ''
}

function StatusLine(props) {
  var status = props.status
  if (status === null || status === undefined) {
    return h(
      'div',
      { className: 'ot-net-status' },
      h(
        'span',
        { className: 'ot-sub' },
        '正在和宿主握手…（如果一直是这样，刷新页面；刷新后还这样说明宿主是启动时加载的旧版本，要重启 DeepSeek Harness）',
      ),
      h(
        'span',
        { className: 'ot-net-actions' },
        ui.button({
          small: true,
          variant: 'ghost',
          icon: 'refresh',
          onClick: function () {
            props.onRefresh()
          },
        }, '再握一次'),
      ),
    )
  }
  var browser = status.browser || {}
  var saved = util.safeArray(status.credentials)
  var pieces = []
  pieces.push(browser.found === true ? '浏览器：' + (browser.label || 'Edge') : '没找到 Edge / Chrome')
  if (browser.running === true) pieces.push(browser.headless === true ? '正在运行（无窗口）' : '正在运行（有窗口）')
  else pieces.push('未启动')
  // Which mode this install runs in, whether or not the browser is up — the
  // difference decides whether a login can even show a window.
  if (browser.mode === 'headless') pieces.push('模式：无窗口（登录需要窗口）')
  if (typeof status.count === 'number') pieces.push('已入库 ' + status.count + ' 条')
  if (saved.length > 0) pieces.push('记住的账号：' + saved.map(function (entry) { return entry.username || entry.id }).join(' / '))
  return h(
    'div',
    { className: 'ot-net-status' },
    h('span', { className: 'ot-sub' }, pieces.join(' · ')),
    h(
      'span',
      { className: 'ot-sub ot-net-path', title: status.profileDir || '' },
      '登录档案：' + String(status.profileDir || '').replace(/^.*[\\/]storages[\\/]/, '…\\'),
    ),
  )
}

/** One row of the review list: what will be written, and whether it is ticked. */
function DeadlineRow(props) {
  var item = props.item
  var ticked = item.include !== false
  var countdown = countdownLabel(item.dueDate)
  return h(
    'label',
    { className: util.cx('ot-net-row', ticked ? null : 'ot-net-row-off') },
    h('input', {
      type: 'checkbox',
      checked: ticked,
      onChange: function () {
        props.onToggle(item.key)
      },
    }),
    h(
      'span',
      { className: 'ot-net-when' },
      h('b', null, item.dueDate),
      h('span', { className: 'ot-net-clock' }, whenLabel(item)),
      countdown !== '' ? h('i', { className: 'ot-net-count' }, countdown) : null,
    ),
    h(
      'span',
      { className: 'ot-net-what' },
      h('span', { className: 'ot-net-title' }, (item.kind ? '[' + item.kind + '] ' : '') + item.title),
      item.course ? h('span', { className: 'ot-tag' }, item.course) : null,
      item.importance === 'high'
        ? h('span', { className: 'ot-tag ot-tag-web', title: 'AI 判断：错过会影响成绩或资格' }, '重要')
        : item.importance === 'medium'
          ? h('span', { className: 'ot-tag', title: 'AI 判断：需要安排时间' }, '关注')
          : null,
      item.url ? h('a', { className: 'ot-net-link', href: item.url, target: '_blank', rel: 'noreferrer', onClick: function (event) { event.stopPropagation() } }, '原页面') : null,
    ),
    h('span', { className: 'ot-net-conf', title: item.evidence || '' }, Math.round((item.confidence || 0) * 100) + '%'),
  )
}

function CourseRow(props) {
  var course = props.course
  var ticked = course.checked === true
  return h(
    'label',
    { className: util.cx('ot-net-course', ticked ? null : 'ot-net-row-off') },
    h('input', {
      type: 'checkbox',
      checked: ticked,
      onChange: function () {
        props.onToggle(course.id)
      },
    }),
    h('span', { className: 'ot-net-course-name' }, course.name),
    course.ended
      ? h('span', { className: 'ot-tag', title: '学期已结束' + (course.termEnd ? '（' + course.termEnd + '）' : '') }, '已结束')
      : null,
    course.url ? null : h('span', { className: 'ot-tag ot-tag-manual', title: '没有课程页链接，会走课程接口读' }, '接口'),
  )
}

function LoginCard(props) {
  var net = props.net
  var busy = net.busy !== ''
  var status = net.status || {}
  var browser = status.browser || {}
  var headlessMode = browser.mode === 'headless'
  var pair = React.useState('')
  var username = pair[0]
  var setUsername = pair[1]
  var passPair = React.useState('')
  var password = passPair[0]
  var setPassword = passPair[1]
  var rememberPair = React.useState(true)
  var remember = rememberPair[0]
  var setRemember = rememberPair[1]
  var saved = util.safeArray(status.credentials)
  /**
   * Put the remembered account in the field once the status arrives. The password
   * stays empty and is never sent to the page: the host reads it from DPAPI when
   * the button is clicked.
   */
  React.useEffect(function () {
    if (username !== '' || saved.length === 0) return
    var remembered = saved[0].username || ''
    if (remembered !== '') setUsername(remembered)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [net.status])

  function submit(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    if (busy) return
    props.store
      .netDdlLogin({ username: username.trim(), password: password, remember: remember })
      .then(function (payload) {
        // Once the host has the password (or has decided not to keep it), the page
        // has no reason to hold it any longer.
        if (payload && payload.loggedIn) setPassword('')
      })
      .catch(function () {
        /* the error is already on the net slice */
      })
  }

  return h(
    'section',
    { className: 'ot-card ot-card-pad' },
    h('h3', { className: 'ot-card-title' }, h('i', { className: 'ot-dot' }), '登录一次，之后靠浏览器档案'),
    h(
      'p',
      { className: 'ot-sub' },
      '点下面的按钮会弹出一个 Edge 窗口。账号密码留空就用记住的那份，填了就用这里的；能自动填就自动填，要扫码 / 短信验证 / 拖滑块，就在那个窗口里完成——登录成功了这里会自己继续。',
    ),
    saved.length > 0
      ? h(
        'p',
        { className: 'ot-sub' },
        '已记住：' + saved.map(function (entry) { return entry.username || entry.id }).join(' / ') + '。两栏都留空，点「打开登录窗口」会自动用这份登录。',
      )
      : null,
    /**
     * Say it before the click, not after the wait: with a headless install the
     * window cannot exist, and the host would refuse after a few seconds of
     * "正在启动窗口…" that looks exactly like the hang this note prevents.
     */
    headlessMode
      ? ui.note({ variant: 'warn' }, '这台机器配置成了无窗口浏览器（netddl.headless = true），登录窗口打不开。把 cordis.patch.yml 里那条删掉或改成 false 再重启 DeepSeek Harness；也可以先在命令行跑一次 `pnpm run ddl -- login`（同一个档案），之后无窗口也能抓。')
      : null,
    h(
      'form',
      { className: 'ot-net-login', onSubmit: submit },
      ui.textField({
        label: '账号（手机号 / 邮箱）',
        value: username,
        placeholder: '留空用记住的账号；没有再在窗口里手动登录',
        onChange: setUsername,
      }),
      h(
        'div',
        { className: 'ot-field' },
        h('span', { className: 'ot-field-label' }, '密码'),
        h('input', {
          className: 'ot-input',
          type: 'password',
          value: password,
          autoComplete: 'off',
          placeholder: '只用于填表；勾了「记住」才加密存本机',
          onChange: function (event) {
            setPassword(event.target.value)
          },
        }),
      ),
      h(
        'div',
        { className: 'ot-net-login-foot' },
        ui.switchRow({ label: '记住密码（Windows DPAPI 加密，只在本机可用）', checked: remember, onChange: setRemember }),
        h('div', { className: 'ot-headspace' }),
        ui.button({ variant: 'primary', icon: 'orbit', disabled: busy, onClick: submit }, busy && net.busy === 'login' ? '等你登录…' : '打开登录窗口'),
        ui.button({ variant: 'ghost', icon: 'refresh', disabled: busy, onClick: function () { props.store.netDdlCheck().catch(function () {}) } }, '检查登录'),
        ui.button({ variant: 'ghost', icon: 'close', disabled: busy, onClick: function () { props.store.netDdlLogout().catch(function () {}) } }, '清除登录'),
      ),
    ),
  )
}

function CourseCard(props) {
  var net = props.net
  var busy = net.busy !== ''
  var courses = util.safeArray(net.courses)
  var chosen = courses.filter(function (course) {
    return course.checked === true
  })
  return h(
    'section',
    { className: 'ot-card ot-card-pad' },
    h('h3', { className: 'ot-card-title' }, h('i', { className: 'ot-dot' }), '你的课程'),
    h(
      'div',
      { className: 'ot-net-actions' },
      ui.button({ icon: 'refresh', disabled: busy, onClick: function () { props.store.netDdlScanCourses().catch(function () {}) } }, busy && net.busy === 'courses' ? '正在读…' : '读我的课程'),
      courses.length > 0 ? ui.button({ variant: 'ghost', onClick: function () { props.store.netDdlCheckAll(true) } }, '全选') : null,
      courses.length > 0 ? ui.button({ variant: 'ghost', onClick: function () { props.store.netDdlCheckAll(false) } }, '全不选') : null,
      h('div', { className: 'ot-headspace' }),
      ui.button({ variant: 'primary', icon: 'clock', disabled: busy || chosen.length === 0, onClick: function () { props.store.netDdlPull({}).catch(function () {}) } }, busy && net.busy === 'pull' ? '正在抓…' : '抓这些课的截止时间'),
    ),
    courses.length === 0
      ? h('p', { className: 'ot-sub' }, '先「读我的课程」，或者直接去「任意网页」贴一个课程页地址。')
      : h('div', { className: 'ot-net-courses' }, courses.map(function (course) {
        return h(CourseRow, { key: course.id || course.name, course: course, onToggle: function (id) { props.store.netDdlToggleCourse(id) } })
      })),
  )
}

function PageCard(props) {
  var net = props.net
  var busy = net.busy !== ''
  var urlPair = React.useState('')
  var url = urlPair[0]
  var setUrl = urlPair[1]
  var userPair = React.useState('')
  var username = userPair[0]
  var setUsername = userPair[1]
  var passPair = React.useState('')
  var password = passPair[0]
  var setPassword = passPair[1]

  function submit(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    if (busy) return
    var target = url.trim()
    if (!/^https?:\/\//i.test(target)) {
      props.onError('地址要以 http:// 或 https:// 开头。')
      return
    }
    props.store
      .netDdlReadPage({ url: target, username: username.trim(), password: password, remember: true })
      .then(function (payload) {
        if (payload && payload.loginNote && payload.items && payload.items.length > 0) setPassword('')
      })
      .catch(function () {
        /* reported through the net slice */
      })
  }

  return h(
    'section',
    { className: 'ot-card ot-card-pad' },
    h('h3', { className: 'ot-card-title' }, h('i', { className: 'ot-dot' }), '抓一个网页'),
    h('p', { className: 'ot-sub' }, '作业页、教务系统、课程公告都行。如果它有登录表单，账号密码会先填进去；填不了的验证就交给你。'),
    h(
      'form',
      { className: 'ot-net-page', onSubmit: submit },
      h(
        'div',
        { className: 'ot-field ot-net-url' },
        h('span', { className: 'ot-field-label' }, '页面地址'),
        h('input', {
          className: 'ot-input',
          type: 'text',
          value: url,
          placeholder: 'https://… （要看到截止时间的那个页面）',
          onChange: function (event) {
            setUrl(event.target.value)
          },
        }),
      ),
      ui.textField({ label: '账号（可选）', value: username, placeholder: '这个页面要登录才填', onChange: setUsername }),
      h(
        'div',
        { className: 'ot-field' },
        h('span', { className: 'ot-field-label' }, '密码（可选）'),
        h('input', {
          className: 'ot-input',
          type: 'password',
          value: password,
          autoComplete: 'off',
          onChange: function (event) {
            setPassword(event.target.value)
          },
        }),
      ),
      h(
        'div',
        { className: 'ot-net-actions' },
        ui.button({ variant: 'primary', icon: 'spark', disabled: busy, onClick: submit }, busy && net.busy === 'page' ? '正在读…' : '抓这个页面'),
      ),
    ),
  )
}

function AiCard(props) {
  var net = props.net
  var busy = net.busy !== ''
  var urlPair = React.useState('')
  var url = urlPair[0]
  var setUrl = urlPair[1]
  var labelPair = React.useState('')
  var label = labelPair[0]
  var setLabel = labelPair[1]
  var userPair = React.useState('')
  var username = userPair[0]
  var setUsername = userPair[1]
  var passPair = React.useState('')
  var password = passPair[0]
  var setPassword = passPair[1]

  function submit(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    if (busy) return
    var target = url.trim()
    if (!/^https?:\/\//i.test(target)) {
      props.onError('地址要以 http:// 或 https:// 开头。')
      return
    }
    props.store
      .netDdlReadSite({ url: target, label: label.trim(), username: username.trim(), password: password, remember: true })
      .then(function (payload) {
        if (payload && payload.ok && password !== '') setPassword('')
      })
      .catch(function () {
        /* reported through the net slice */
      })
  }

  return h(
    'section',
    { className: 'ot-card ot-card-pad' },
    h('h3', { className: 'ot-card-title' }, h('i', { className: 'ot-dot' }), '让 AI 先看网站，再决定读哪里'),
    h(
      'p',
      { className: 'ot-sub' },
      '不用为每个站点写一套规则：浏览器负责打开、登录、翻页和取文字；AI 负责判断这是什么网站、该跟进哪些真实链接，以及哪些日期/时间节点值得进日程——不只有“截止时间”。',
    ),
    h(
      'p',
      { className: 'ot-sub' },
      'AI 只能从页面实际存在的链接里选，不能编 URL；每一条日期也会由代码重新校验，模型编出来的条目不会直接进时间轴。',
    ),
    h(
      'form',
      { className: 'ot-net-page', onSubmit: submit },
      h(
        'div',
        { className: 'ot-field ot-net-url' },
        h('span', { className: 'ot-field-label' }, '从哪个页面开始'),
        h('input', {
          className: 'ot-input',
          type: 'text',
          value: url,
          placeholder: 'https://… （课程中心 / 作业页 / 公告页都行）',
          onChange: function (event) {
            setUrl(event.target.value)
          },
        }),
      ),
      ui.textField({ label: '课程或站点名（可选）', value: label, placeholder: '例如：电法勘探 / 学校教务系统', onChange: setLabel }),
      ui.textField({ label: '账号（可选）', value: username, placeholder: '页面需要登录才填', onChange: setUsername }),
      h(
        'div',
        { className: 'ot-field' },
        h('span', { className: 'ot-field-label' }, '密码（可选）'),
        h('input', {
          className: 'ot-input',
          type: 'password',
          value: password,
          autoComplete: 'off',
          placeholder: '只用于填表；勾了「记住」才加密存本机',
          onChange: function (event) {
            setPassword(event.target.value)
          },
        }),
      ),
      h(
        'div',
        { className: 'ot-net-actions' },
        ui.button({ variant: 'primary', icon: 'spark', disabled: busy, onClick: submit }, busy && net.busy === 'ai' ? 'AI 正在读…' : '让 AI 读这个网站'),
      ),
    ),
  )
}

function ResultCard(props) {
  var net = props.net
  var items = util.safeArray(net.items)
  if (items.length === 0) return null
  var chosen = items.filter(function (item) {
    return item.include !== false
  })
  var busy = net.busy !== ''
  return h(
    'section',
    { className: 'ot-card ot-card-pad ot-net-result' },
    h(
      'h3',
      { className: 'ot-card-title' },
      h('i', { className: 'ot-dot' }),
      '读到的时间节点（' + items.length + '）',
      h(
        'span',
        { className: 'ot-net-actions' },
        ui.button({ small: true, variant: 'ghost', onClick: function () { props.store.netDdlSelectAll(true) } }, '全选'),
        ui.button({ small: true, variant: 'ghost', onClick: function () { props.store.netDdlSelectAll(false) } }, '全不选'),
      ),
    ),
    h('div', { className: 'ot-net-rows' }, items.map(function (item) {
      return h(DeadlineRow, { key: item.key, item: item, onToggle: function (key) { props.store.netDdlToggleItem(key) } })
    })),
    h(
      'div',
      { className: 'ot-net-commit' },
      h('span', { className: 'ot-sub' }, '勾选的会写进时间轴，并带上「网络 DDL」标；以后重新导入 Excel 也不会冲掉。'),
      h('div', { className: 'ot-headspace' }),
      ui.button({ variant: 'primary', icon: 'check', disabled: busy || chosen.length === 0, onClick: function () { props.store.netDdlCommit().catch(function () {}) } }, busy && net.busy === 'commit' ? '正在写…' : '加进日程（' + chosen.length + ' 条）'),
    ),
  )
}

function NetDdlView(props) {
  var net = props.netddl
  var busy = net.busy !== ''

  React.useEffect(function () {
    if (net.status !== null) return
    var cancelled = false
    var timer = null
    /**
     * The status is read once when the tab opens, but a page can be refreshed
     * while the host is still starting; one retry turns that race into a loaded
     * card instead of "还没和宿主对上话" until the next manual refresh.
     */
    props.store.refreshNetDdl().then(function (status) {
      if (cancelled || status !== null) return
      timer = setTimeout(function () {
        if (!cancelled) props.store.refreshNetDdl()
      }, 1500)
    })
    return function () {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
    // The login flow can be long; the status is cheap, so ask once when the tab
    // opens and let the user refresh explicitly after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  var tabs = Object.keys(PLATFORM_LABELS).map(function (id) {
    return h(
      'button',
      {
        key: id,
        type: 'button',
        className: util.cx('ot-net-tab', net.platform === id ? 'ot-net-tab-on' : null),
        disabled: busy,
        onClick: function () {
          props.store.netDdlSetPlatform(id)
        },
      },
      PLATFORM_LABELS[id],
    )
  })

  return h(
    'div',
    { className: 'ot-netddl' },
    h(
      'section',
      { className: 'ot-card ot-card-pad' },
      h('h3', { className: 'ot-card-title' }, h('i', { className: 'ot-dot' }), '从网上读截止时间'),
      h('p', { className: 'ot-sub' }, '登录一次，之后每次打开这个页签点「抓」就行。读到的每一条都要你勾过才进日程。'),
      h('div', { className: 'ot-net-tabs' }, tabs),
      h(StatusLine, {
        status: net.status,
        onRefresh: function () {
          props.store.refreshNetDdl()
        },
      }),
      net.message !== '' ? ui.note({ variant: net.level === 'warn' ? 'warn' : 'ok' }, net.message) : null,
      net.error !== '' ? ui.note({ variant: 'warn' }, net.error) : null,
      util.safeArray(net.notes).length > 0
        ? h('div', { className: 'ot-net-notes' }, net.notes.map(function (note, index) {
          return h('div', { key: 'n' + index, className: 'ot-sub' }, '· ' + note)
        }))
        : null,
      net.page !== null && net.page !== undefined
        ? h(
          'div',
          { className: 'ot-sub ot-net-pageinfo' },
          '读的是：' + (net.page.title || '(没有标题)') + ' · ' + net.page.chars + ' 字 · ' + net.page.payloads + ' 个 JSON 响应',
          net.page.screenshot ? h('span', null, ' · 截图：' + net.page.screenshot) : null,
        )
        : null,
    ),
    net.platform === 'icourse163' ? h(LoginCard, { store: props.store, net: net }) : null,
    net.platform === 'icourse163' ? h(CourseCard, { store: props.store, net: net }) : null,
    net.platform === 'generic'
      ? h(PageCard, {
        store: props.store,
        net: net,
        onError: function (message) {
          props.store.set({ netddl: Object.assign({}, props.store.get().netddl, { error: message }) })
        },
      })
      : null,
    net.platform === 'ai'
      ? h(AiCard, {
        store: props.store,
        net: net,
        onError: function (message) {
          props.store.set({ netddl: Object.assign({}, props.store.get().netddl, { error: message }) })
        },
      })
      : null,
    h(ResultCard, { store: props.store, net: net }),
  )
}

exports.NetDdlView = NetDdlView
exports.PLATFORM_LABELS = PLATFORM_LABELS
