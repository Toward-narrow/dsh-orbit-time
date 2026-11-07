/**
 * Orbit Time — turn a page or an internal API payload into deadline rows.
 *
 * Two readers, because course sites answer in two different ways:
 *
 *   `parseDeadlineText`  reads what a person sees: "作业 2 · 截止时间：2026-11-20 23:30".
 *   `parseDeadlineJson`  reads what the page *fetched*: any JSON object carrying a
 *                        deadline-ish key, walked depth-first without knowing the
 *                        vendor's schema.
 *
 * Keeping both here (and free of any browser or DSH import) is what makes the
 * interesting half testable: a fixture in, rows out.
 *
 * Everything is local time. The host runs in the same zone as the schedules it
 * imports, and a deadline shown as 23:30 must land on the timeline as 23:30.
 */

/** Boilerplate that is never a deadline title. */
const NOISE = new Set([
  '首页', '登录', '注册', '退出', '我的课程', '课程介绍', '全部课程', '更多', '展开', '收起',
  '收藏', '分享', '评论', '立即购买', '免费试学', '认证', '证书', '常见问题', '关于我们',
  '意见反馈', '客服', '下载app', '下载APP', '顶部', '返回', '上一页', '下一页', '搜索',
  '作业', '测验', '考试', '测试', '截止时间', '截止日期', '提交时间', '结束时间', '状态',
  '已提交', '未提交', '待提交', '未开始', '进行中', '已结束', '成绩', '得分', '查看详情',
  '立即挑战', '开始答题', '继续答题', '进入作业', '查看', '详情', '评分标准', '题目',
  '时间', '日期', '关闭', '开启', '期限', '剩余时间', '状态', '提示', '注意',
  // Lines that describe the shape of the assignment flow, not an assignment.
  '作业阶段', '作业提交阶段', '作业批改阶段', '成绩公布阶段', '成绩公布',
  '开始时间', '公布时间', '发布时间', '开放时间', '前往作业', '前往测验', '查看帮助',
])

/** Words that mark a line as *the* deadline line rather than just a date on a page. */
const DEADLINE_HINTS = /截止|截至|最后期限|提交截止|deadline|due\s*(?:date|time)?|ddl|expire|关闭时间|结束时间|提交时间|有效期至/i

/** What kind of coursework the row is, inferred from its own words. */
const KIND_HINTS = [
  [/作业|homework|assignment|hw/i, '作业'],
  [/测验|quiz|单元测|test/i, '测验'],
  [/考试|exam|期末|期中/i, '考试'],
  [/讨论|discussion/i, '讨论'],
]

/**
 * Full-width digits, colons, and slashes are what a Chinese site actually emits;
 * normalising them here means every rule below only ever sees ASCII.
 */
export function normaliseText(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\uFF1A]/g, ':')
    .replace(/[\uFF0F]/g, '/')
    // A Chinese IME emits these for "minus" and "dot" as casually as it emits
    // full-width digits; a date written with them is still a date.
    .replace(/[\uFF0D\u2010-\u2015\u2212]/g, '-')
    .replace(/[\uFF0E]/g, '.')
    .replace(/\u3000/g, ' ')
    .replace(/\r\n?/g, '\n')
}

const DATE_TIME = /(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:[^\d\n]{0,10}?)(\d{1,2})\s*[:.]\s*(\d{2})/g
const DATE_ONLY = /(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/g
const MONTH_DAY_TIME = /(?:^|[^\d])(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:[^\d\n]{0,10}?)(\d{1,2})\s*[:.]\s*(\d{2})/g

/** A local `YYYY-MM-DD` for a date object. */
export function isoDate(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** A local `HH:MM`. */
export function isoTime(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function validDate(year, month, day) {
  if (!(year >= 2000 && year <= 2100)) return null
  if (!(month >= 1 && month <= 12)) return null
  if (!(day >= 1 && day <= 31)) return null
  const date = new Date(year, month - 1, day, 0, 0, 0, 0)
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date
}

/** Stable id for one deadline: the same site row read twice keeps its identity. */
export function deadlineKey(parts) {
  const seed = [parts.platform ?? '', parts.course ?? '', parts.title ?? '', parts.dueIso ?? ''].join('|')
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `wd_${(hash >>> 0).toString(36)}`
}

/** Strip the deadline itself and the label around it out of a candidate title. */
function cleanTitle(raw) {
  let text = normaliseText(raw).replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  text = text
    // A literal, not the module-level `DATE_TIME`: sharing a global regex with
    // the scanning loop would reset its `lastIndex` and restart the scan forever.
    .replace(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:[^\d\n]{0,10}?)(\d{1,2})\s*[:.]\s*(\d{2})/g, ' ')
    .replace(/20\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?/g, ' ')
    .replace(/\d{1,2}\s*[:.]\s*\d{2}\s*(?:前|之前|截止)?/g, ' ')
    // "截止时间：", "截至  …  关闭", "deadline:" are labels, never titles.
    .replace(/(?:截止|截至|最后期限|结束|提交|关闭|deadline|due|ddl|expire)\s*(?:时间|日期|期限)?\s*[:：]?/gi, ' ')
    .replace(/^[-–—·•|:：,\s]+|[-–—·•|:：,\s]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return text.slice(0, 90)
}

function isNoise(text) {
  const key = normaliseText(text).replace(/\s+/g, '').toLowerCase()
  if (key === '') return true
  if (NOISE.has(key)) return true
  // A "title" that is only punctuation, a score, or a status word says nothing.
  if (/^[\d\s./:：%()（）\-–—]+$/.test(key)) return true
  return false
}

function kindOf(text) {
  for (const [pattern, label] of KIND_HINTS) {
    if (pattern.test(text)) return label
  }
  return ''
}

/**
 * Read deadlines out of visible text.
 *
 * @param {string} text page text (innerText), already the part that matters.
 * @param {object} options
 * @param {string} [options.course] course this text belongs to.
 * @param {string} [options.url] page the text came from.
 * @param {string} [options.platform]
 * @param {Date}   [options.now]
 * @param {number} [options.horizonDays] drop deadlines further out than this.
 * @param {number} [options.pastDays] keep how many days of already-passed rows.
 * @returns {Array<object>} normalised items, newest deadline first.
 */
export function parseDeadlineText(text, options = {}) {
  const source = normaliseText(text)
  if (source.trim() === '') return []
  const now = options.now instanceof Date ? options.now : new Date()
  const horizonDays = Number(options.horizonDays) > 0 ? Number(options.horizonDays) : 180
  const pastDays = Number.isFinite(options.pastDays) ? Number(options.pastDays) : 1
  const course = typeof options.course === 'string' ? options.course.trim() : ''
  const url = typeof options.url === 'string' ? options.url : ''
  const platform = typeof options.platform === 'string' ? options.platform : ''

  const lines = source.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim())
  const items = []
  const seen = new Set()

  const push = (match, lineIndex, matchedText, withTime) => {
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const date = validDate(year, month, day)
    if (date === null) return
    let hour = 23
    let minute = 59
    if (withTime) {
      hour = Number(match[4])
      minute = Number(match[5])
      if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) return
      date.setHours(hour, minute, 0, 0)
    } else {
      date.setHours(23, 59, 0, 0)
    }
    const deltaDays = (date.getTime() - now.getTime()) / 86_400_000
    if (deltaDays > horizonDays || deltaDays < -pastDays) return

    const line = lines[lineIndex] ?? ''
    const hinted = DEADLINE_HINTS.test(line)
    // "开始时间" and "公布时间" are clocks in the same card as the deadline, and
    // treating them as deadlines creates a second, wrong row for the same item.
    if (!hinted && /(?:开始|公布|发布|开放|起始)\s*(?:时间|日期)?/.test(line)) return
    let title = cleanTitle(line)
    if (isNoise(title)) {
      // The deadline line is often just "截止时间：…", with the title one or two
      // lines above it. Walk up, but never past another date: that one owns its
      // own title already.
      for (let back = 1; back <= 3; back += 1) {
        const candidate = lines[lineIndex - back]
        if (candidate === undefined || candidate === '') break
        if (/\d{4}\s*[-/.年]\s*\d{1,2}/.test(candidate)) break
        const cleaned = cleanTitle(candidate)
        if (!isNoise(cleaned)) {
          title = cleaned
          break
        }
      }
    }
    if (title === '') return
    const dueIso = `${isoDate(date)}T${isoTime(date)}`
    const key = `${dueIso}|${course}|${title}`
    if (seen.has(key)) return
    seen.add(key)
    items.push({
      platform,
      course,
      title: title.slice(0, 90),
      dueDate: isoDate(date),
      dueTime: withTime ? isoTime(date) : '',
      dueIso,
      dueMs: date.getTime(),
      kind: kindOf(`${line} ${title}`),
      confidence: hinted ? 0.92 : withTime ? 0.62 : 0.45,
      evidence: `${line || matchedText}`.slice(0, 160),
      url,
    })
  }

  DATE_TIME.lastIndex = 0
  let match = DATE_TIME.exec(source)
  while (match !== null) {
    const lineIndex = source.slice(0, match.index).split('\n').length - 1
    push(match, lineIndex, match[0], true)
    match = DATE_TIME.exec(source)
  }

  // A deadline page sometimes drops the clock ("截止日期：2026-11-20"). Those are
  // still real deadlines, but they are reported at end-of-day and rank below the
  // ones with a time; the same row must not be counted twice.
  DATE_ONLY.lastIndex = 0
  match = DATE_ONLY.exec(source)
  while (match !== null) {
    const lineIndex = source.slice(0, match.index).split('\n').length - 1
    const line = lines[lineIndex] ?? ''
    if (DEADLINE_HINTS.test(line) && !/\d{1,2}\s*[:.]\s*\d{2}/.test(line)) push(match, lineIndex, match[0], false)
    match = DATE_ONLY.exec(source)
  }

  // "11月20日 23:30" with no year, on a page that is obviously this term's.
  if (items.length === 0) {
    MONTH_DAY_TIME.lastIndex = 0
    match = MONTH_DAY_TIME.exec(source)
    while (match !== null) {
      const lineIndex = source.slice(0, match.index).split('\n').length - 1
      const line = lines[lineIndex] ?? ''
      /**
       * A bare "01-01 23:59" inside "2030-01-01 23:59" is the tail of a date that
       * already has a year, and inventing a year for it puts a phantom deadline on
       * the timeline. Because the pattern starts on the *separator*, the digit
       * immediately before the match is what gives the trick away.
       */
      const precededByDigit = /[0-9]/.test(source[match.index - 1] ?? '')
      const hasYearAlready = /20\d{2}\s*[-/.年]/.test(source.slice(Math.max(0, match.index - 12), match.index + 1))
      if (!precededByDigit && !hasYearAlready && DEADLINE_HINTS.test(line)) {
        const guess = new Date(now.getFullYear(), Number(match[1]) - 1, Number(match[2]), Number(match[3]), Number(match[4]), 0, 0)
        // A December page read in January is talking about last December only if
        // the date has already gone; otherwise it means this December.
        if (guess.getTime() < now.getTime() - 30 * 86_400_000) guess.setFullYear(now.getFullYear() + 1)
        if (Number.isFinite(guess.getTime())) {
          push([null, String(guess.getFullYear()), String(guess.getMonth() + 1), String(guess.getDate()), match[3], match[4]], lineIndex, match[0], true)
        }
      }
      match = MONTH_DAY_TIME.exec(source)
    }
  }

  return sortItems(items)
}

function sortItems(items) {
  return items.sort((left, right) => left.dueMs - right.dueMs)
}

// ---------------------------------------------------------------------------
// payload reader
// ---------------------------------------------------------------------------

/** Keys whose value is a deadline, in rough order of trustworthiness. */
const DEADLINE_KEYS = [
  /^(?:deadline|dead_line|deadlineMs|deadlineTime|ddl)$/i,
  /^(?:end_time|endTime|endDate|end_date|closeTime|close_time|expireTime|expire_time|expireDate|finishTime|finish_time|overTime|over_time)$/i,
  /^(?:submitDeadline|submit_deadline|submitEndTime|homeworkDeadline|testDeadline)$/i,
]

/** Keys whose value names the thing the deadline belongs to. */
const TITLE_KEYS = /^(?:name|title|testName|test_name|homeworkName|homework_name|unitName|chapterName|contentName|mocTermName|termName|courseName|subject)$/i

/** Keys that say which course/term this payload describes. */
const COURSE_KEYS = /^(?:courseName|mocTermName|termName|courseTitle|schoolName)$/i

function isDeadlineKey(key) {
  return DEADLINE_KEYS.some((pattern) => pattern.test(key))
}

/**
 * Turn a timestamp-ish value into epoch milliseconds.
 *
 * Sites emit seconds, milliseconds, and every date string format under the sun;
 * a value that cannot be pinned to a day is not a deadline and returns null.
 */
export function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null
    if (value > 1e12) return value
    if (value > 1e9) return Math.round(value * 1000)
    return null
  }
  if (typeof value !== 'string') return null
  const text = normaliseText(value).trim()
  if (text === '') return null
  if (/^\d{10}$/.test(text)) return Number(text) * 1000
  if (/^\d{13}$/.test(text)) return Number(text)
  // `\s*` before the optional clock is deliberate: an eager `\s*` would swallow
  // the separator the clock needs, and the regex would rather skip the group
  // than backtrack, silently turning "… 23:30" into "… 23:59".
  const match = /(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:[ T]*(\d{1,2})\s*[:.]\s*(\d{2}))?/.exec(text)
  if (match === null) return null
  const date = validDate(Number(match[1]), Number(match[2]), Number(match[3]))
  if (date === null) return null
  date.setHours(Number(match[4] ?? 23) || 0, Number(match[5] ?? 59) || 0, 0, 0)
  return date.getTime()
}

/**
 * Walk a decoded payload for deadline-bearing objects.
 *
 * The walk carries the nearest title and the nearest course name down the tree,
 * because the vendor puts them at different depths in different endpoints:
 * `{unit:{name, test:{deadline}}}`, `{name, deadline}`, `{chapterName, units:[…]}`.
 */
function walkPayload(node, context, items, options, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 14) return
  if (Array.isArray(node)) {
    for (const entry of node) walkPayload(entry, context, items, options, depth + 1)
    return
  }

  let title = context.title
  let course = context.course
  let kind = context.kind
  let deadline = null
  let deadlineKeyName = ''
  let extraTime = null

  for (const [key, value] of Object.entries(node)) {
    if (TITLE_KEYS.test(key) && typeof value === 'string' && value.trim() !== '') {
      const cleaned = cleanTitle(value)
      if (!isNoise(cleaned)) title = cleaned
    } else if (COURSE_KEYS.test(key) && typeof value === 'string' && value.trim() !== '') {
      course = value.trim().slice(0, 60)
    } else if (/^(?:contentType|type|unitType)$/i.test(key)) {
      // icourse163: 1 video, 3 test, 4 homework, 5 exam.
      const numeric = Number(value)
      if (numeric === 3) kind = '测验'
      else if (numeric === 4) kind = '作业'
      else if (numeric === 5) kind = '考试'
    } else if (isDeadlineKey(key)) {
      const millis = toEpochMs(value)
      if (millis !== null) {
        deadline = millis
        deadlineKeyName = key
      }
    } else if (/^(?:deadlineStr|deadlineText|endTimeStr|endTimeText|deadlineDesc)$/i.test(key) && typeof value === 'string') {
      const millis = toEpochMs(value)
      if (millis !== null) extraTime = millis
    }
  }

  /**
   * Some endpoints put the course name one level up as a bare `name` sitting
   * next to a `courseId`/`termId`, and a bare `name` is otherwise read as a
   * title. Without this branch a course-list payload would label every row with
   * its assignment but leave `course` empty.
   */
  if (Object.keys(node).some((key) => /^(?:courseId|termId|mocTermId)$/.test(key)) && typeof node.name === 'string' && node.name.trim() !== '') {
    course = node.name.trim().slice(0, 60)
  }

  const resolved = deadline ?? extraTime
  if (resolved !== null && title !== '') {    const date = new Date(resolved)
    const deltaDays = (resolved - options.now.getTime()) / 86_400_000
    if (deltaDays <= options.horizonDays && deltaDays >= -options.pastDays) {
      const dueIso = `${isoDate(date)}T${isoTime(date)}`
      const url = typeof options.url === 'string' ? options.url : ''
      items.push({
        platform: options.platform,
        course,
        title: title.slice(0, 90),
        dueDate: isoDate(date),
        dueTime: isoTime(date),
        dueIso,
        dueMs: resolved,
        kind: kind || kindOf(title),
        confidence: deadlineKeyName !== '' ? 0.9 : 0.7,
        evidence: `JSON ${deadlineKeyName || 'deadline'} = ${new Date(resolved).toISOString()}`,
        url,
      })
    }
  }

  for (const value of Object.values(node)) {
    if (value !== null && typeof value === 'object') {
      walkPayload(value, { title, course, kind }, items, options, depth + 1)
    }
  }
}

/**
 * Read deadlines out of the payloads a page fetched.
 *
 * @param {Array<{url?:string, body:string}>} payloads raw response bodies.
 * @param {object} options same shape as `parseDeadlineText`.
 * @returns {Array<object>}
 */
export function parseDeadlineJson(payloads, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date()
  const settings = {
    now,
    horizonDays: Number(options.horizonDays) > 0 ? Number(options.horizonDays) : 180,
    pastDays: Number.isFinite(options.pastDays) ? options.pastDays : 1,
    platform: typeof options.platform === 'string' ? options.platform : '',
    url: typeof options.url === 'string' ? options.url : '',
  }
  const items = []
  for (const payload of Array.isArray(payloads) ? payloads : []) {
    const body = typeof payload === 'string' ? payload : payload?.body
    if (typeof body !== 'string' || body.trim() === '') continue
    const trimmed = body.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue
    let decoded = null
    try {
      decoded = JSON.parse(trimmed)
    } catch {
      continue
    }
    const payloadUrl = typeof payload === 'object' && typeof payload.url === 'string' ? payload.url : settings.url
    walkPayload(decoded, { title: '', course: typeof options.course === 'string' ? options.course : '', kind: '' }, items, { ...settings, url: payloadUrl })
  }
  return sortItems(items)
}

/**
 * Collapse duplicate readings of the same deadline.
 *
 * Text and JSON both see the same assignment, and one course page mentions its
 * deadline in three widgets. The key is (course, title, instant); the survivor is
 * the one with the most evidence behind it, so a JSON hit beats a stray date on a
 * page, and a row with a deadline label beats one without.
 */
export function dedupeItems(items, options = {}) {
  const platform = typeof options.platform === 'string' ? options.platform : ''
  const byKey = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    if (item === null || typeof item !== 'object') continue
    if (!item.dueDate) continue
    const dueIso = item.dueIso || `${item.dueDate}T${item.dueTime || '23:59'}`
    const key = `${item.course ?? ''}|${item.title ?? ''}|${dueIso}`
    const existing = byKey.get(key)
    if (existing === undefined || (item.confidence ?? 0) > (existing.confidence ?? 0)) {
      byKey.set(key, { ...item, dueIso })
    }
  }
  const out = []
  for (const item of byKey.values()) {
    out.push({
      ...item,
      platform: item.platform || platform,
      key: deadlineKey(item),
    })
  }
  return sortItems(out)
}
