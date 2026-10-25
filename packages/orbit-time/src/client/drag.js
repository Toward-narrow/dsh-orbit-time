/**
 * Orbit Time client — moving the in-page floating card, and remembering where.
 *
 * Three rules, each of which was a bug before it was a rule:
 *
 *  1. **A drag starts only on a grip.** The card is 300 px of controls, text and
 *     a countdown laid over the panel. When any part of it could start a move,
 *     pressing a button that jittered by four pixels became a drag and the button
 *     never fired — "点开那个按钮" failed at random. A grip is also the honest
 *     affordance: a grab cursor on a surface that only moves when dragged from
 *     one documented spot is a lie, and this is that spot.
 *
 *  2. **The position is written to the element, not into React state.** A drag
 *     that calls `setState` on every `pointermove` re-renders the card — and the
 *     card subscribes to the store, so a re-render is a store read, a fresh
 *     element tree and a React commit, per mouse event, several hundred times a
 *     second. That is what "拖起来很卡" was: the card waiting on React to catch
 *     up with the pointer. The element's own `style.left/top` is applied
 *     directly, and moves are coalesced to one per animation frame, so the card
 *     tracks the pointer instead of the render loop.
 *
 *  3. **A drag never becomes a click.** The press is deferred until the pointer
 *     has travelled past a small threshold, and the `click` the browser fires
 *     afterwards is swallowed in the capture phase, so a button that was part of
 *     a drag does not also fire.
 *
 * The position is remembered in `localStorage` — per browser, and thrown away by
 * a cache clear, which is the right lifetime for "where I parked this card".
 */

/* eslint-disable no-undef -- localStorage is provided by the browser. */

var util = require('./util.js')
var React = util.React

var POSITION_KEY = 'orbit-time.float.position'
var COLLAPSED_KEY = 'orbit-time.float.collapsed'
/** A press that travels less than this is a click, not a drag. */
var DRAG_THRESHOLD = 4

/**
 * The browser seat, or `null` when there is not one.
 *
 * The components that use this are rendered on a server too — the plugin's own
 * smoke test renders the whole tree through `react-dom/server` — and there is no
 * `localStorage`, no `requestAnimationFrame` and no viewport there. Everything
 * below therefore reaches the browser through this, so one missing seat means
 * "the card keeps its default corner" rather than a crashed render.
 */
function host() {
  return typeof window === 'undefined' || window === null ? null : window
}

function readPosition() {
  var seat = host()
  try {
    var raw = seat === null ? null : seat.localStorage.getItem(POSITION_KEY)
    if (typeof raw !== 'string' || raw === '') return null
    var parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    if (!Number.isFinite(parsed.left) || !Number.isFinite(parsed.top)) return null
    return { left: parsed.left, top: parsed.top }
  } catch (error) {
    return null
  }
}

function writePosition(box) {
  var seat = host()
  if (seat === null) return
  try {
    seat.localStorage.setItem(POSITION_KEY, JSON.stringify({ left: Math.round(box.left), top: Math.round(box.top) }))
  } catch (error) {
    /* a private-mode browser refuses storage; the card still drags */
  }
}

/** The remembered collapsed/expanded choice, or `fallback` when there is none. */
function readCollapsed(fallback) {
  var seat = host()
  if (seat === null) return fallback
  try {
    var raw = seat.localStorage.getItem(COLLAPSED_KEY)
    if (raw === '1') return true
    if (raw === '0') return false
  } catch (error) {
    /* ignore */
  }
  return fallback
}

function writeCollapsed(value) {
  var seat = host()
  if (seat === null) return
  try {
    seat.localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0')
  } catch (error) {
    /* ignore */
  }
}

/** The viewport, with a sane fallback for a render that has no browser. */
function viewport() {
  var seat = host()
  return {
    width: seat === null || !Number.isFinite(seat.innerWidth) ? 1280 : seat.innerWidth,
    height: seat === null || !Number.isFinite(seat.innerHeight) ? 800 : seat.innerHeight,
  }
}

/**
 * Next frame, or the closest thing this environment has to one.
 *
 * Only the initial clamp uses this — the drag itself writes synchronously, for
 * the reason given at `paint`.
 */
function frameScheduler() {
  var seat = host()
  if (seat !== null && typeof seat.requestAnimationFrame === 'function') {
    return {
      schedule: function (fn) {
        return seat.requestAnimationFrame(fn)
      },
      cancel: function (handle) {
        if (typeof seat.cancelAnimationFrame === 'function') seat.cancelAnimationFrame(handle)
      },
    }
  }
  return {
    schedule: function (fn) {
      return setTimeout(fn, 16)
    },
    cancel: function (handle) {
      clearTimeout(handle)
    },
  }
}

/** Keep a box inside the viewport, leaving `margin` px of breathing room. */
function clampBox(box, margin) {
  var screen = viewport()
  var maxLeft = Math.max(margin, screen.width - box.width - margin)
  var maxTop = Math.max(margin, screen.height - box.height - margin)
  return {
    left: util.clamp(box.left, margin, maxLeft),
    top: util.clamp(box.top, margin, maxTop),
    width: box.width,
    height: box.height,
  }
}

/** The resting place for a card that has no remembered position. */
function defaultBox(width, height, margin) {
  var screen = viewport()
  return clampBox(
    { left: screen.width - width - margin, top: screen.height - height - margin, width: width, height: height },
    margin,
  )
}

/**
 * `useLayoutEffect` in a browser, `useEffect` anywhere else.
 *
 * React warns about a layout effect during a server render, and the plugin's own
 * smoke test renders this tree through `react-dom/server`. There is nothing to
 * lay out there, so the passive effect is the correct one to use.
 */
var useBrowserEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect

/**
 * Position a floating card, and make its grip move it.
 *
 * The position is reported as a `style` for the card element, and it is not
 * decoration:
 *
 *   **A React element does not survive a shape change.** Collapsing to the dot
 *   and growing back replaces the DOM node — the `div` of the mini is a different
 *   element from the `div` of the expanded card — so a position that only ever
 *   existed as an inline style on the old node is simply gone. The new node then
 *   lays out at its default position, and the card that was parked in the corner
 *   reappears somewhere else entirely (in practice: half off the bottom of the
 *   screen, which is what "点开大的之后就成这样了" was).
 *
 * So the position lives in a ref that every render reads, and the card carries it
 * as a style on whichever element is currently mounted. The drag still writes the
 * element directly — that is what keeps it from waiting on React — and the ref
 * keeps the two in step.
 *
 * `options.handle` is the grip: the one element a press has to land inside for the
 * card to move. Everything else on the card keeps its own click.
 */
function useFloatingPosition(options) {
  var width = (options && options.width) || 244
  var margin = (options && options.margin) || 12
  var ref = React.useRef(null)
  /** The grip: the one element a press has to land inside to move the card. */
  var gripRef = React.useRef(null)
  var boxRef = React.useRef(null)
  /**
   * The last box this shape occupied, kept after its element is gone.
   *
   * A collapse unmounts one card and mounts the other in the same commit, and
   * React detaches the outgoing element's ref *before* the new element's layout
   * effect runs — so asking the old element where it was at that moment always
   * answers "nowhere". This is the answer, and it outlives the element.
   */
  var cached = React.useRef(null)
  /**
   * True once the *user* put this shape somewhere, as opposed to it having a
   * position merely because it inherited one. Only the first kind is worth
   * keeping across a shape change — see `inherit`.
   */
  var dragged = React.useRef(false)
  var session = React.useRef(null)
  var scheduler = React.useRef(null)
  /** When the last real move ended, so its click can be swallowed too. */
  var lastDrag = React.useRef(0)
  /** Whether the missing-ref fallback has been reported already (once per card). */
  var warnedGrip = React.useRef(false)
  var dragPair = React.useState(false)
  var setDragging = dragPair[1]

  if (scheduler.current === null) scheduler.current = frameScheduler()

  /** Move the element and remember where it is, for the next render. */
  var applyBox = React.useCallback(function (next) {
    boxRef.current = next
    cached.current = next
    var node = ref.current
    if (node === null) return
    node.style.left = Math.round(next.left) + 'px'
    node.style.top = Math.round(next.top) + 'px'
  }, [])

  /** The card's box as it is right now, at its real size. */
  var measure = React.useCallback(function () {
    var node = ref.current
    if (node === null) return null
    var rect = node.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width || width, height: rect.height }
  }, [width])

  // Layout effect, not `useEffect`: the card is positioned from storage before
  // the browser paints, so a remembered spot never flashes at the default corner
  // first. It is a no-op where there is no browser to lay out in.
  useBrowserEffect(function () {
    var seat = host()
    if (seat === null) return undefined
    if (boxRef.current === null) {
      var stored = readPosition()
      applyBox(stored === null ? defaultBox(width, 220, margin) : { left: stored.left, top: stored.top, width: width, height: 220 })
    }
    // Once the card has painted at its real size, pull it back inside the
    // viewport: a position saved on a bigger window is off screen otherwise.
    var handle = scheduler.current.schedule(function () {
      var now = measure()
      if (now !== null) applyBox(clampBox(now, margin))
    })
    function onResize() {
      var now = measure()
      if (now !== null) applyBox(clampBox(now, margin))
    }
    seat.addEventListener('resize', onResize)
    return function () {
      scheduler.current.cancel(handle)
      seat.removeEventListener('resize', onResize)
    }
  }, [applyBox, margin, measure, width])

  /**
   * The drag, listened for on the document rather than on the grip.
   *
   * This is the mechanism, not an optimisation. A React handler on the grip
   * depends on three things being true at once: React's delegated listener is
   * attached to a root this card is actually inside, the press is not retargeted
   * away from it, and the grip keeps receiving moves for the whole gesture. Any
   * one of them failing leaves a card that looks right, reports its layout
   * correctly, and cannot be dragged or clicked *at the same time* — which is
   * exactly the report that arrived twice ("拖还拖不动", "还没有办法按 ×").
   *
   * Listening on the document removes all three. A press is recognised by asking
   * whether its target sits inside the grip, so it does not matter what element
   * the browser hands us — the grip's own `<svg>`, a wrapper, whatever the app
   * puts around the overlay. Moves and the release are read from the same place,
   * so a drag survives the pointer leaving the card entirely, and no pointer
   * capture has to be negotiated at all.
   *
   * The card's own buttons are untouched: a press that does not start inside the
   * grip never opens a session, so `click` reaches them exactly as React expects.
   */
  useBrowserEffect(function () {
    var seat = host()
    if (seat === null || seat.document === undefined) return undefined
    var doc = seat.document
    var target = options && options.handle ? options.handle : null
    /**
     * The grip element, or `null` when there is none to find.
     *
     * The handle normally arrives as a ref from the card. A ref is a plain field,
     * so a caller that hands one to something which drops it gets no error at
     * all: the card looks exactly right, reports its layout, and quietly refuses
     * every press. That was the small card — its grip is a `<button>` built by
     * `ui.button`, which did not forward `ref`, so `gripNode()` answered `null`
     * and the dot never moved.
     *
     * The grips therefore carry `data-ot-grip`, and when the ref is empty the
     * card's own subtree answers instead. Only one shape is mounted at a time, so
     * this is unambiguous; a press inside the returned node still starts the drag
     * through the same path.
     */
    function gripNode() {
      if (target === null) return null
      var node = typeof target === 'function' ? target() : target.current
      if (node !== null && node !== undefined) return node
      var root = ref.current
      var found = root === null || root === undefined || typeof root.querySelector !== 'function' ? null : root.querySelector('[data-ot-grip]')
      if (found !== null && found !== undefined && !warnedGrip.current) {
        warnedGrip.current = true
        note('grip ref never attached; falling back to [data-ot-grip]')
      }
      return found
    }
    function press(event) {
      if (event.button !== 0 || event.isPrimary === false) return
      var grip = gripNode()
      if (grip === null || grip === undefined) return
      // Is this press inside the grip? The target may be the grip's own `<svg>`,
      // a wrapper the app added, or the grip itself — walking up from the target
      // answers that without caring which.
      var node = event.target
      var inside = false
      while (node !== null && node !== undefined) {
        if (node === grip) {
          inside = true
          break
        }
        node = node.parentNode
      }
      if (!inside) return
      var start = measure()
      if (start === null) return
      session.current = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: start.left,
        top: start.top,
        width: start.width,
        height: start.height,
        moved: false,
      }
      note('press on the grip at ' + Math.round(start.left) + ',' + Math.round(start.top))
      // React's `click` fires after `pointerup`; the capture phase gets there
      // first and is the only place a drag can be told from a click.
      doc.addEventListener('click', swallowClick, true)
    }
    function move(event) {
      var current = session.current
      if (current === null || event.pointerId !== current.id) return
      var dx = event.clientX - current.startX
      var dy = event.clientY - current.startY
      if (current.moved !== true) {
        if (Math.abs(dx) <= DRAG_THRESHOLD && Math.abs(dy) <= DRAG_THRESHOLD) return
        current.moved = true
        setDragging(true)
        note('drag started')
      }
      if (event.cancelable) event.preventDefault()
      paint(clampBox({ left: current.left + dx, top: current.top + dy, width: current.width, height: current.height }, margin))
    }
    function release(event) {
      finish(event)
    }
    function cancel() {
      finish(null)
    }
    doc.addEventListener('pointerdown', press, true)
    doc.addEventListener('pointermove', move, true)
    doc.addEventListener('pointerup', release, true)
    doc.addEventListener('pointercancel', cancel, true)
    return function () {
      doc.removeEventListener('pointerdown', press, true)
      doc.removeEventListener('pointermove', move, true)
      doc.removeEventListener('pointerup', release, true)
      doc.removeEventListener('pointercancel', cancel, true)
    }
    // `finish`, `note`, `paint` and `swallowClick` only ever read refs, so their
    // identities are not part of what this effect depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, margin, options])

  function swallowClick(event) {
    // A click is swallowed for exactly one reason: it is the tail of a drag. The
    // test is the tail window, not the session — the browser delivers `click`
    // immediately after the release, so 250 ms covers it with room to spare,
    // while the session object would also swallow a click that happens to land
    // in the moment between a release and the next press.
    var tail = Date.now() - lastDrag.current < 250
    if (tail) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  function finish(event) {
    var seat = host()
    var current = session.current
    if (current !== null && current.moved === true) {
      lastDrag.current = Date.now()
      // This shape now has a position of its own, and a shape change must not
      // quietly move the card back to wherever the other one was.
      dragged.current = true
    }
    if (seat !== null && seat.document !== undefined) {
      // The click the browser dispatches after this release is delivered after
      // this handler returns, so the swallow listener has to outlive the call.
      seat.setTimeout(function () {
        seat.document.removeEventListener('click', swallowClick, true)
      }, 0)
    }
    if (current === null) return
    session.current = null
    setDragging(false)
    if (current.moved !== true) return
    // What is remembered is the box the drag computed, not a fresh measurement.
    // A measurement taken here goes through `getBoundingClientRect`, which reports
    // the *animated* box while the entrance animation is still playing — so a
    // drag started within the first third of a second stored a spot a few pixels
    // away from the one on screen, and the next load put the card there. The
    // computed box is the exact one.
    if (boxRef.current !== null) writePosition(boxRef.current)
  }

  function paint(next) {
    // Applied synchronously, not on the next animation frame.
    //
    // A frame-scheduled write lags whenever frames are scarce — a busy page, a
    // background tab, a heavy re-render elsewhere — and a card that arrives a
    // frame late behind the pointer is exactly what "拖起来很卡" describes. The
    // pointer itself delivers one move per frame at most, and writing two
    // properties onto one element is the cheapest thing in this file; React is
    // not involved at all. A redundant write is skipped.
    var current = boxRef.current
    if (current !== null && Math.round(current.left) === Math.round(next.left) && Math.round(current.top) === Math.round(next.top)) {
      return
    }
    applyBox(next)
  }

  /**
   * A note for the host's /debug, so a drag that does nothing is not a mystery.
   *
   * `reportUiEvent` is the panel's channel; this is the drag's, and it is the
   * page that has to supply it because only the page can see a pointer event at
   * all. Every branch that can silently give up writes one line.
   */
  function note(text) {
    var seat = host()
    if (seat === null || typeof seat.__otDragNote !== 'function') return
    try {
      seat.__otDragNote(text)
    } catch (error) {
      /* diagnostics only */
    }
  }

  return {
    ref: ref,
    gripRef: gripRef,
    dragging: dragPair[0],
    /**
     * The remembered position as a style, for whichever element is mounted.
     *
     * Read from the ref at render time on purpose: the drag writes the element
     * directly and never re-renders, so a render that *does* happen (the shape
     * changed, the store ticked) picks up the live position rather than a stale
     * copy of it.
     */
    style: boxRef.current === null ? null : { left: Math.round(boxRef.current.left) + 'px', top: Math.round(boxRef.current.top) + 'px' },
    /**
     * The position the other shape had, for a shape that has never been dragged.
     *
     * Collapsing and growing back are one card changing shape, so the new shape
     * has to appear where the old one was — otherwise it jumps to its own
     * remembered corner, which reads as "点开之后跑到别的地方去了". A position the
     * user actually dragged *this* shape to is kept, and a shape that has never
     * been dragged keeps following: two shapes, one card.
     */
    position: function () {
      return cached.current
    },
    adopt: function (box) {
      if (dragged.current || box === null) return
      applyBox({ left: box.left, top: box.top, width: width, height: 220 })
    },
  }
}

exports.useFloatingPosition = useFloatingPosition
exports.readCollapsed = readCollapsed
exports.writeCollapsed = writeCollapsed
exports.clampBox = clampBox
