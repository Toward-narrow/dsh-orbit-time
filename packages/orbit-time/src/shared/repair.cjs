/**
 * Text and field repair shared by both halves.
 *
 * Why this exists
 * ---------------
 * A Chinese path reaches the config as byte-per-character nonsense:
 *
 *   C:\...\示例支部早打卡排班表.xlsx
 *   C:\...\ç¤ºä¾‹æ”¯éƒ¨æ—©æ‰“å¡æŽ’ç­è¡¨.xlsx
 *
 * That second string is the first one's UTF-8 bytes read through a single-byte
 * code page. Once such a value is persisted, the plugin faithfully re-saves it
 * forever and every file lookup fails with a "not found" that looks like the
 * user typed the path wrong. Repairing it at the boundary — and again whenever
 * a failed lookup looks like mojibake — turns a permanently broken install
 * back into a working one without asking the user to re-paste anything.
 *
 * The detection is deliberately narrow: a candidate must decode to bytes whose
 * UTF-8 interpretation is mostly CJK *and* its byte form must not already be a
 * valid UTF-8 sequence. Western text such as "Ã©" would otherwise be "repaired"
 * into "é" in strings that were correct to begin with.
 *
 * The module is written as CJS with named exports so the host can import it
 * (`import { repairMojibake } from '../shared/repair.js'`) and the client build
 * can inject it as one more authoring module.
 */

'use strict'

/**
 * Windows-1252's 0x80–0x9F band, which is where most of the damage shows up.
 * Codepoints outside this map and beyond 0xFF contribute nothing: a string that
 * contains them cannot be a pure single-byte decoding of UTF-8.
 */
var CP1252_EXTRA = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
}

function toBytes(text) {
  var out = []
  for (var i = 0; i < text.length; i += 1) {
    var code = text.charCodeAt(i)
    if (code <= 0xff) {
      out.push(code)
      continue
    }
    var mapped = CP1252_EXTRA[code]
    if (mapped === undefined) return null
    out.push(mapped)
  }
  return out
}

function utf8Decode(bytes) {
  var out = ''
  var i = 0
  while (i < bytes.length) {
    var byte = bytes[i]
    var need = 0
    var code = 0
    if (byte < 0x80) {
      out += String.fromCharCode(byte)
      i += 1
      continue
    } else if ((byte & 0xe0) === 0xc0) {
      need = 1
      code = byte & 0x1f
    } else if ((byte & 0xf0) === 0xe0) {
      need = 2
      code = byte & 0x0f
    } else if ((byte & 0xf8) === 0xf0) {
      need = 3
      code = byte & 0x07
    } else {
      return null
    }
    if (i + need >= bytes.length) return null
    for (var k = 1; k <= need; k += 1) {
      var next = bytes[i + k]
      if ((next & 0xc0) !== 0x80) return null
      code = (code << 6) | (next & 0x3f)
    }
    if (code > 0x10ffff) return null
    if (code >= 0xd800 && code <= 0xdfff) return null
    if (code > 0xffff) {
      var shifted = code - 0x10000
      out += String.fromCharCode(0xd800 + (shifted >> 10), 0xdc00 + (shifted & 0x3ff))
    } else {
      out += String.fromCharCode(code)
    }
    i += need + 1
  }
  return out
}

function utf8Encode(text) {
  var out = []
  for (var i = 0; i < text.length; i += 1) {
    var code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      var low = text.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
        i += 1
      }
    }
    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return out
}

function isCjk(code) {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    code === 0x3001 ||
    code === 0x3002 ||
    (code >= 0x3008 && code <= 0x3011) ||
    (code >= 0x2018 && code <= 0x201d)
  )
}

/** Windows separators are slashes too; treat the string as a path if it has one. */
function looksLikePath(text) {
  return /[\\/]/.test(text)
}

/**
 * Decode one layer of "UTF-8 read as a single-byte code page".
 *
 * @returns {string|null} the repaired text, or null when this is not mojibake
 *   (or when repairing it would not help).
 */
function repairMojibake(text) {
  if (typeof text !== 'string') return null
  if (text.length < 2) return null
  // A real UTF-8 value never reaches here: its own bytes round-trip unchanged,
  // which is exactly what the guard below rejects.
  if (!/[\u00c2-\u00c3\u00c5\u00c6\u00c7\u00c8-\u00cf\u00d0-\u00d7\u00d9-\u00df\u00e0-\u00ef]/.test(text)) return null

  var bytes = toBytes(text)
  if (bytes === null) return null

  var decoded = utf8Decode(bytes)
  if (decoded === null || decoded === '') return null

  // The property that makes this test sound: a *correct* multi-byte character
  // has its own UTF-8 bytes equal to `utf8Encode(text)`, not to `toBytes(text)`,
  // so a string that survives the byte view unchanged was never mis-decoded.
  var ownBytes = utf8Encode(text)
  if (ownBytes.length === bytes.length) {
    var identical = true
    for (var j = 0; j < bytes.length; j += 1) {
      if (ownBytes[j] !== bytes[j]) {
        identical = false
        break
      }
    }
    if (identical) return null
  }

  var cjk = 0
  var latin1Noise = 0
  for (var i = 0; i < decoded.length; i += 1) {
    var code = decoded.charCodeAt(i)
    if (isCjk(code)) cjk += 1
    else if (code >= 0xa0 && code <= 0xff) latin1Noise += 1
  }
  if (cjk === 0) return null
  if (latin1Noise > cjk) return null

  // A path is only worth repairing when the result is still a usable path.
  if (looksLikePath(text) && !looksLikePath(decoded)) return null
  return decoded
}

function hasNonAscii(text) {
  for (var i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 0x7f) return true
  }
  return false
}

/** Repair when possible, otherwise hand back the original string untouched. */
function repairText(value) {
  var fixed = repairMojibake(value)
  return fixed === null ? value : fixed
}

/**
 * Repair each element of a path, segment by segment.
 *
 * A 8.3-style join or a hand-typed prefix can leave some segments correct and
 * others mangled, and per-segment repair keeps the correct ones intact.
 */
function repairPath(path) {
  if (typeof path !== 'string' || path === '') return path
  var whole = repairMojibake(path)
  if (whole !== null) return whole
  var segments = path.split(/([\\/])/)
  var changed = false
  var out = segments.map(function (segment) {
    if (segment === '\\' || segment === '/') return segment
    var fixed = repairMojibake(segment)
    if (fixed === null) return segment
    changed = true
    return fixed
  })
  return changed ? out.join('') : path
}

/** Normalise a user-typed path: trim, strip wrapping quotes, repair encoding. */
function normalisePath(input) {
  if (typeof input !== 'string') return ''
  var text = input.trim().replace(/^"(.*)"$/, '$1').trim()
  if (text === '') return ''
  return repairPath(text)
}

exports.repairMojibake = repairMojibake
exports.repairText = repairText
exports.repairPath = repairPath
exports.normalisePath = normalisePath
