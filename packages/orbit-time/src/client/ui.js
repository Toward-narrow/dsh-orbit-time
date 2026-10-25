/** Orbit Time client — reusable presentation atoms. */

var util = require('./util.js')
var React = util.React
var h = util.h

/** Inline glyphs kept as text so the bundle stays dependency-free. */
function glyph(name, size) {
  var common = {
    width: size || 14,
    height: size || 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    style: { flex: 'none' },
  }
  var paths = {
    play: [h('path', { key: 'p', d: 'M7 4.5 19 12 7 19.5z', fill: 'currentColor', stroke: 'none' })],
    pause: [
      h('rect', { key: 'a', x: 7, y: 5, width: 3.6, height: 14, rx: 1.2, fill: 'currentColor', stroke: 'none' }),
      h('rect', { key: 'b', x: 13.4, y: 5, width: 3.6, height: 14, rx: 1.2, fill: 'currentColor', stroke: 'none' }),
    ],
    reset: [h('path', { key: 'p', d: 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 5v5h5' })],
    skip: [
      h('path', { key: 'p', d: 'M6 5.5 16 12 6 18.5z', fill: 'currentColor', stroke: 'none' }),
      h('path', { key: 'l', d: 'M19 5v14' }),
    ],
    check: [h('path', { key: 'p', d: 'M4.5 12.5 9.5 17.5 19.5 6.5' })],
    clock: [
      h('circle', { key: 'c', cx: 12, cy: 12, r: 8.5 }),
      h('path', { key: 'p', d: 'M12 7.5V12l3.2 2' }),
    ],
    pin: [
      h('path', { key: 'p', d: 'M12 21s6.5-5.7 6.5-10.5A6.5 6.5 0 0 0 5.5 10.5C5.5 15.3 12 21 12 21z' }),
      h('circle', { key: 'c', cx: 12, cy: 10.4, r: 2.4 }),
    ],
    bell: [
      h('path', { key: 'p', d: 'M6 9.5a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13.5 6 9.5z' }),
      h('path', { key: 'q', d: 'M10 18.5a2 2 0 0 0 4 0' }),
    ],
    calendar: [
      h('rect', { key: 'r', x: 3.5, y: 5, width: 17, height: 15.5, rx: 2.5 }),
      h('path', { key: 'p', d: 'M3.5 10h17M8 3.5v3.5M16 3.5v3.5' }),
    ],
    sheet: [
      h('rect', { key: 'r', x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 }),
      h('path', { key: 'p', d: 'M3.5 9.5h17M9.5 9.5v10M15 9.5v10' }),
    ],
    spark: [
      h('path', { key: 'p', d: 'M12 3.5 13.9 9.6 20 11.5l-6.1 1.9L12 19.5l-1.9-6.1L4 11.5l6.1-1.9z' }),
    ],
    robot: [
      h('rect', { key: 'r', x: 4.5, y: 7.5, width: 15, height: 11, rx: 3 }),
      h('path', { key: 'p', d: 'M12 3.5v4M8.5 12.5v1.5M15.5 12.5v1.5' }),
    ],
    close: [h('path', { key: 'p', d: 'M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5' })],
    expand: [h('path', { key: 'p', d: 'M14 4.5h5.5V10M10 19.5H4.5V14M19.5 4.5 13 11M4.5 19.5 11 13' })],
    minus: [h('path', { key: 'p', d: 'M6 12h12' })],
    plus: [h('path', { key: 'p', d: 'M12 6v12M6 12h12' })],
    refresh: [h('path', { key: 'p', d: 'M20 11a8 8 0 1 0-2.4 5.7M20 5.5V11h-5.5' })],
    flame: [
      h('path', {
        key: 'p',
        d: 'M12 3s5 4.2 5 8.6a5 5 0 0 1-10 0C7 9.4 9 7.6 9 7.6s.6 2 1.8 2c1.4 0 1.2-4.6 1.2-6.6z',
      }),
    ],
    target: [
      h('circle', { key: 'c', cx: 12, cy: 12, r: 8 }),
      h('circle', { key: 'd', cx: 12, cy: 12, r: 3.4 }),
    ],
    trending: [h('path', { key: 'p', d: 'M4 16.5 9 11l3.6 3.6L20 7M20 7h-4.6M20 7v4.6' })],
    'chevron-left': [h('path', { key: 'p', d: 'M14.5 5.5 8 12l6.5 6.5' })],
    'chevron-right': [h('path', { key: 'p', d: 'M9.5 5.5 16 12l-6.5 6.5' })],
    orbit: [
      h('circle', { key: 'c', cx: 12, cy: 12, r: 3.6, fill: 'currentColor', stroke: 'none' }),
      h('ellipse', { key: 'e', cx: 12, cy: 12, rx: 8.6, ry: 4.3, transform: 'rotate(-28 12 12)' }),
      h('circle', { key: 'd', cx: 19.4, cy: 8.6, r: 1.5, fill: 'currentColor', stroke: 'none' }),
    ],
    // Six dots: the universal "this bit moves the window" mark, and the only
    // place on the card where a drag starts.
    grip: [
      h('circle', { key: 'a', cx: 9, cy: 6.5, r: 1.7, fill: 'currentColor', stroke: 'none' }),
      h('circle', { key: 'b', cx: 15, cy: 6.5, r: 1.7, fill: 'currentColor', stroke: 'none' }),
      h('circle', { key: 'c', cx: 9, cy: 12, r: 1.7, fill: 'currentColor', stroke: 'none' }),
      h('circle', { key: 'd', cx: 15, cy: 12, r: 1.7, fill: 'currentColor', stroke: 'none' }),
      h('circle', { key: 'e', cx: 9, cy: 17.5, r: 1.7, fill: 'currentColor', stroke: 'none' }),
      h('circle', { key: 'f', cx: 15, cy: 17.5, r: 1.7, fill: 'currentColor', stroke: 'none' }),
    ],
  }
  return h('svg', common, paths[name] || paths.spark)
}

/** The Pomodoro / countdown ring. */
function ring(props) {
  var size = props.size || 208
  var stroke = props.stroke || 10
  var radius = (size - stroke) / 2
  var circumference = 2 * Math.PI * radius
  var progress = util.clamp(props.progress || 0, 0, 1)
  var offset = circumference * (1 - progress)
  var gradientId = props.gradientId || 'ot-ring-gradient'
  var altId = gradientId + '-break'
  var center = size / 2
  return h(
    'div',
    {
      className: util.cx('ot-ring', props.className, props.break ? 'ot-ring-break' : null, props.running ? 'running' : null),
      style: { width: size, height: size },
    },
    h(
      'svg',
      { className: 'ot-ring-svg', viewBox: '0 0 ' + size + ' ' + size, role: 'img', 'aria-label': props.label || '计时进度' },
      h(
        'defs',
        null,
        h(
          'linearGradient',
          { id: gradientId, x1: '0%', y1: '0%', x2: '100%', y2: '100%' },
          h('stop', { offset: '0%', stopColor: 'var(--ot-accent)' }),
          h('stop', { offset: '100%', stopColor: 'var(--ot-accent-2)' }),
        ),
        h(
          'linearGradient',
          { id: altId, x1: '0%', y1: '0%', x2: '100%', y2: '100%' },
          h('stop', { offset: '0%', stopColor: 'var(--ot-accent-3)' }),
          h('stop', { offset: '100%', stopColor: 'var(--ot-accent)' }),
        ),
      ),
      h('circle', { className: 'ot-ring-track', cx: center, cy: center, r: radius, strokeWidth: stroke }),
      h('circle', {
        className: 'ot-ring-arc',
        cx: center,
        cy: center,
        r: radius,
        strokeWidth: stroke,
        strokeDasharray: String(circumference),
        strokeDashoffset: String(offset),
      }),
    ),
    h('div', { className: 'ot-ring-center' }, props.children),
  )
}

function stat(props) {
  return h(
    'div',
    { className: util.cx('ot-stat', util.animationClass(props.animKey, null)) },
    h('div', { className: 'ot-stat-label' }, props.icon ? h('span', { style: { marginRight: 5, verticalAlign: '-2px' } }, glyph(props.icon, 13)) : null, props.label),
    h('div', { className: 'ot-stat-value' }, props.value),
    props.foot ? h('div', { className: 'ot-stat-foot' }, props.foot) : null,
  )
}

/**
 * Build one button element.
 *
 * `createElement('button', config, icon, label)` looks obviously correct and is
 * not: the label is silently dropped, leaving icon-only buttons all over the
 * panel. Whatever the cause — a React build quirk, a bundler interaction — the
 * fix is to stop depending on it. The label is placed in the config's own
 * `children` array, and every call site goes through `ui.button`, which is a
 * plain function returning this element rather than a component.
 */
function createButtonElement(props, children) {
  var extra = {}
  if (props.title) extra.title = props.title
  /**
   * A ref handed to `ui.button` belongs to the `<button>` it builds.
   *
   * This function *is* the component: call sites write `ui.button({ ... })`, a
   * plain call, so React never inspects `props.ref` and a dropped ref is silent.
   * That is exactly how the small card's drag handle became a null ref — the dot
   * accepted a press and never moved, while the pill (an element ref on a
   * `<span>`) dragged fine. Copying it onto the element config is what makes
   * `ref` mean what every caller already assumed it meant.
   */
  if (props.ref !== undefined && props.ref !== null) extra.ref = props.ref
  var label = children === undefined || children === null ? props.children : children
  return h(
    'button',
    Object.assign(
      {
        type: 'button',
        className: util.cx('ot-btn', props.variant === 'primary' ? 'ot-btn-primary' : null, props.variant === 'ghost' ? 'ot-btn-ghost' : null, props.small ? 'ot-btn-sm' : null, props.iconOnly ? 'ot-btn-icon' : null, props.className),
        onClick: props.onClick,
        disabled: props.disabled === true,
        title: props.title,
        'aria-label': props.ariaLabel || props.title,
        children: [
          props.icon ? glyph(props.icon, props.small ? 12 : 14) : null,
          label === undefined || label === null ? null : label,
        ],
      },
      extra,
    ),
  )
}

function button(props, children) {
  return createButtonElement(props, children)
}

button.displayName = 'OrbitButton'

function switchRow(props) {
  return h(
    'label',
    { className: 'ot-switch' },
    h('input', {
      type: 'checkbox',
      checked: props.checked === true,
      onChange: function (event) {
        props.onChange(event.target.checked)
      },
    }),
    h('span', { className: 'ot-sub' }, props.label),
  )
}

function numberField(props) {
  return h(
    'div',
    { className: 'ot-field' },
    h('span', { className: 'ot-field-label' }, props.label),
    h('input', {
      className: 'ot-input ot-input-num',
      type: 'number',
      min: props.min === undefined ? 1 : props.min,
      max: props.max === undefined ? 999 : props.max,
      value: props.value,
      onChange: function (event) {
        var next = Number(event.target.value)
        if (Number.isFinite(next)) props.onChange(next)
      },
    }),
    props.suffix ? h('span', { className: 'ot-sub' }, props.suffix) : null,
  )
}

function textField(props) {
  return h(
    'div',
    { className: 'ot-field' },
    h('span', { className: 'ot-field-label' }, props.label),
    h('input', {
      className: 'ot-input',
      type: 'text',
      value: props.value === undefined || props.value === null ? '' : props.value,
      placeholder: props.placeholder || '',
      onChange: function (event) {
        props.onChange(event.target.value)
      },
      onKeyDown: props.onKeyDown,
    }),
  )
}

function note(props) {
  return h('div', { className: util.cx('ot-note', props.variant ? 'ot-note-' + props.variant : null) }, props.children)
}

function card(props) {
  return h(
    'section',
    { className: util.cx('ot-card', props.pad === false ? null : 'ot-card-pad', props.className) },
    props.title ? h('h3', { className: 'ot-card-title' }, h('i', { className: 'ot-dot' }), props.title, props.aside || null) : null,
    props.children,
  )
}

exports.glyph = glyph
exports.ring = ring
exports.stat = stat
exports.createButtonElement = createButtonElement
exports.button = button
exports.switchRow = switchRow
exports.numberField = numberField
exports.textField = textField
exports.note = note
exports.card = card
