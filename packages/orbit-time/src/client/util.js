/** Orbit Time client — shared helpers. `__otReact` is the bundle's React closure. */

/* eslint-disable no-undef -- __otReact is injected by the generated wrapper. */
var React = __otReact

var API = '/api/orbit-time'

function cx() {
  var out = []
  for (var i = 0; i < arguments.length; i += 1) {
    var value = arguments[i]
    if (typeof value === 'string' && value !== '') out.push(value)
    else if (value && typeof value === 'object') {
      for (var key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key) && value[key]) out.push(key)
      }
    }
  }
  return out.join(' ')
}

/** createElement alias — the bundle has no JSX transform. */
var h = React.createElement

function pad2(value) {
  return String(value).padStart(2, '0')
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function toMinutes(hhmm) {
  if (typeof hhmm !== 'string') return null
  var match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (match === null) return null
  var hour = Number(match[1])
  var minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

function fromMinutes(total) {
  var wrapped = ((total % 1440) + 1440) % 1440
  return pad2(Math.floor(wrapped / 60)) + ':' + pad2(wrapped % 60)
}

function addMinutes(hhmm, delta) {
  var base = toMinutes(hhmm)
  return base === null ? '' : fromMinutes(base + delta)
}

function formatClock(ms) {
  var total = Math.max(0, Math.round(ms / 1000))
  var minutes = Math.floor(total / 60)
  var seconds = total % 60
  return pad2(minutes) + ':' + pad2(seconds)
}

function formatDuration(ms) {
  var total = Math.max(0, Math.round(ms / 1000))
  var hours = Math.floor(total / 3600)
  var minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return hours + ' 小时 ' + minutes + ' 分'
  if (minutes > 0) return minutes + ' 分'
  return total + ' 秒'
}

function formatRelative(minutes) {
  if (minutes === null || minutes === undefined) return '时间未定'
  if (minutes < -1) return '已过 ' + Math.abs(minutes) + ' 分钟'
  if (minutes <= 0) return '就是现在'
  if (minutes < 60) return minutes + ' 分钟后'
  var hours = Math.floor(minutes / 60)
  var rest = minutes % 60
  return rest === 0 ? hours + ' 小时后' : hours + ' 小时 ' + rest + ' 分后'
}

function formatDay(dayKey) {
  if (typeof dayKey !== 'string' || dayKey === '') return ''
  var parts = dayKey.split('-')
  if (parts.length !== 3) return dayKey
  return Number(parts[1]) + ' 月 ' + Number(parts[2]) + ' 日'
}

function todayKey() {
  var now = new Date()
  return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate())
}

function shiftDay(dayKey, delta) {
  var parts = String(dayKey).split('-').map(Number)
  var date = new Date(parts[0], parts[1] - 1, parts[2])
  date.setDate(date.getDate() + delta)
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
}

/** Element class names that receive an entrance animation the first time only. */
var seenAnimationKeys = new Set()

function animationClass(key, className) {
  if (key === undefined || key === null) return className
  if (seenAnimationKeys.has(key)) return className
  seenAnimationKeys.add(key)
  return cx(className, 'ot-enter')
}

/** Subscribe to a plain external store and re-render on change. */
function useStore(store) {
  var pair = React.useState(0)
  var setVersion = pair[1]
  React.useEffect(function () {
    return store.subscribe(function () {
      setVersion(function (value) {
        return value + 1
      })
    })
  }, [store])
  return store.get()
}

/** A 1 Hz clock that re-renders the consumer. */
function useNow(intervalMs) {
  var pair = React.useState(function () {
    return Date.now()
  })
  var setNow = pair[1]
  React.useEffect(function () {
    var handle = setInterval(function () {
      setNow(Date.now())
    }, intervalMs || 1000)
    return function () {
      clearInterval(handle)
    }
  }, [intervalMs])
  return pair[0]
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

exports.React = React
exports.API = API
exports.cx = cx
exports.h = h
exports.pad2 = pad2
exports.clamp = clamp
exports.toMinutes = toMinutes
exports.fromMinutes = fromMinutes
exports.addMinutes = addMinutes
exports.formatClock = formatClock
exports.formatDuration = formatDuration
exports.formatRelative = formatRelative
exports.formatDay = formatDay
exports.todayKey = todayKey
exports.shiftDay = shiftDay
exports.animationClass = animationClass
exports.useStore = useStore
exports.useNow = useNow
exports.safeArray = safeArray
