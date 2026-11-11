/** Orbit Time client — plugin entry: contributes the panel, the sidebar icon, and the overlay. */

var util = require('./util.js')
var panel = require('./panel.js')
var settings = require('./settings.js')
var React = util.React
var h = util.h

/** Client services this plugin uses. Kept minimal: slots + layout + remote. */
var inject = ['slots', 'layout', 'remote']

/**
 * Record a client-side failure where it can still be read later.
 *
 * A blank window has no console and no stack: by the time the user reports it,
 * the only evidence left is "it was white". The host already had a route for
 * diagnostics the page can describe (`/debug/client`), so every uncaught error
 * and every render the boundary caught is written there too — `~/.dsh/storages/
 * orbit-time/runtime.json` then says what actually broke, in the words React
 * used, long after the page that produced it was reloaded away.
 *
 * Never throws and never retries: a diagnostic that can break the page it is
 * diagnosing is worse than no diagnostic.
 */
var REPORTED = typeof Set === 'function' ? new Set() : null

function reportClientError(source, message, stack) {
  try {
    var text = String(message === undefined || message === null ? '未知错误' : message)
    // One line per distinct failure per page load: a render loop can throw the
    // same error hundreds of times and would otherwise flush the whole record.
    if (REPORTED !== null) {
      if (REPORTED.has(text)) return
      if (REPORTED.size > 20) return
      REPORTED.add(text)
    }
    var store = require('./store.js').store
    if (!store || typeof store.reportUiEvent !== 'function') return
    void store.reportUiEvent('crash:' + source + ': ' + text.slice(0, 160), {
      message: text.slice(0, 600),
      stack: String(stack || '').slice(0, 1800),
    })
  } catch (error) {
    /* diagnostics only */
  }
}

/**
 * Catch what React cannot.
 *
 * The boundary below only sees errors thrown while rendering *this* plugin's
 * surfaces. An error thrown from an event handler, a timer, or a promise that
 * nothing awaits lands outside it — and a promise rejection during a refresh is
 * exactly the shape of "I clicked, and then the page was gone". These two
 * listeners are the only place such a thing can be seen.
 */
function installErrorReporting() {
  if (typeof window === 'undefined') return
  if (window.__otErrorReporting === true) return
  window.__otErrorReporting = true
  window.addEventListener('error', function (event) {
    // A failed <img>/<script> load has no `error` object; it is not worth a line.
    if (!event || !event.error) return
    reportClientError('window', event.message || event.error.message, event.error.stack)
  })
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason
    if (reason === undefined || reason === null) return
    reportClientError('rejection', reason.message || reason, reason.stack)
  })
}

/** Sidebar glyph — a small orbit mark, drawn inline. */
function OrbitGlyph(props) {
  var size = (props && props.size) || 16
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      style: { display: 'block' },
    },
    h('circle', { cx: 12, cy: 12, r: 4.2, fill: 'currentColor' }),
    h('ellipse', {
      cx: 12,
      cy: 12,
      rx: 9.2,
      ry: 4.6,
      stroke: 'currentColor',
      strokeWidth: 1.5,
      opacity: 0.72,
      transform: 'rotate(-28 12 12)',
    }),
    h('circle', { cx: 20.2, cy: 8.2, r: 1.7, fill: 'currentColor' }),
  )
}

/**
 * Last line of defence: never take the page down with us.
 *
 * A throw anywhere in a render — a wrong prop type, a bad index, a host that has
 * not been restarted yet — unmounts the *entire* React tree, and the harness has
 * no boundary of its own. The user sees a blank window with no way back, and the
 * only clue is a devtools console they have no reason to open. That is exactly
 * how a one-line `now.getHours()` bug looked.
 *
 * So the panel, the sidebar entry, and the overlay are each wrapped: a failure
 * becomes a readable card on that surface, with the message and a reload button,
 * and the rest of the app keeps working.
 */
function CrashCard(props) {
  var error = props.error || {}
  return h(
    'div',
    { className: 'ot-root ot-crash' },
    h('div', { className: 'ot-aurora' }),
    h(
      'div',
      { className: 'ot-crash-card' },
      h('h2', null, 'Orbit Time 这一块没能画出来'),
      h('div', { className: 'ot-sub' }, '页面其余部分还能用。下面这行就是原因；改完插件代码刷新页面即可。'),
      h('pre', { className: 'ot-crash-msg' }, error.message || '未知错误'),
      h(
        'div',
        { className: 'ot-crash-actions' },
        h(
          'button',
          { type: 'button', className: 'ot-btn ot-btn-sm ot-btn-primary', onClick: function () { window.location.reload() } },
          '重新加载页面',
        ),
        h('button', { type: 'button', className: 'ot-btn ot-btn-sm ot-btn-ghost', onClick: props.onRetry }, '再试一次'),
      ),
      error.stack ? h('details', null, h('summary', null, '技术细节'), h('pre', { className: 'ot-crash-msg' }, error.stack)) : null,
    ),
  )
}

/** The guard itself: `componentDidCatch` has no hook form. */
class Catch extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
    this.reset = this.reset.bind(this)
  }

  static getDerivedStateFromError(error) {
    return { error: error }
  }

  componentDidCatch(error) {
    // The card on screen is for the person looking at it; this line is for the
    // person trying to fix it after the page has been reloaded and the console
    // cleared.
    reportClientError('render', error && (error.message || error), error && error.stack)
    // eslint-disable-next-line no-console -- the console is the durable record
    console.error('[orbit-time] render failed:', error)
  }

  reset() {
    this.setState({ error: null })
  }

  render() {
    if (this.state.error !== null) return h(CrashCard, { error: this.state.error, onRetry: this.reset })
    return h(React.Fragment, null, this.props.children)
  }
}

/** Wrap a component so its failures land in the boundary above. */
function guarded(component) {
  return function Guarded(props) {
    return h(Catch, null, h(component, props))
  }
}

function apply(ctx) {
  // Installed before anything renders, so a failure during the first paint is
  // recorded too — that is the case where there is no boundary yet and the page
  // simply stays empty.
  installErrorReporting()

  // Main panel: the dashboard itself.
  ctx.slots.inject('main', function () {
    return ctx.slots.register({ name: 'main', key: 'orbit-time' }, guarded(panel.Dashboard))
  })

  // Sidebar entry: the panel's id is derived from the registration id, and
  // selecting it dispatches the `main` slot above.
  ctx.slots.inject('sidebar.panellist', function () {
    return ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: 'orbit-time',
        order: 40,
        label: function () {
          return 'Orbit Time · 日程仪表盘'
        },
      },
      function (slotProps) {
        return h(
          'span',
          {
            title: 'Orbit Time · 日程仪表盘',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: slotProps && slotProps.active ? 1 : 0.82,
            },
          },
          h(OrbitGlyph, { size: (slotProps && slotProps.size) || 16 }),
        )
      },
    )
  })

  // Frame-wide layer: reminder toasts and the in-window mini card.
  ctx.slots.inject('shell.overlay', function () {
    return ctx.slots.register(
      { name: 'shell.overlay', id: 'orbit-time-notices', order: 60, label: 'Orbit Time 提醒' },
      guarded(function Overlay() {
        return h(React.Fragment, null, h(panel.Notices), h(panel.FloatingWidget))
      }),
    )
  })
}

exports.apply = apply
exports.inject = inject
exports.Catch = Catch
exports.reportClientError = reportClientError
exports.installErrorReporting = installErrorReporting
exports.Dashboard = panel.Dashboard
exports.Notices = panel.Notices
exports.FloatingWidget = panel.FloatingWidget
exports.SettingsView = settings.SettingsView
exports.OrbitGlyph = OrbitGlyph
