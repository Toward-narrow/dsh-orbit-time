/**
 * Orbit Time client — Excel import.
 *
 * The page has one job: turn a spreadsheet into a schedule without making the
 * user learn how this plugin reads spreadsheets. So the default path is a single
 * button — pick a file, the host reads it, the model says what it is, and one
 * click imports it. Column mapping is still here, but it is an escape hatch
 * rather than a required step: it lives behind "手动调整" and is filled in for
 * you.
 */

var util = require('./util.js')
var ui = require('./ui.js')
var React = util.React
var h = util.h
var repair = require('./shared/repair.cjs')

var FIELDS = [
  { key: 'person', label: '姓名 / 参会人', required: true, hint: '按这一列里的名字过滤出你的行' },
  { key: 'date', label: '日期', required: true, hint: '支持 2026-03-02、3月2日、Excel 日期' },
  { key: 'start', label: '开始时间', required: true, hint: '支持 9:00、9点、上午9:30、14:00-15:00' },
  { key: 'end', label: '结束时间', required: false, hint: '留空则按 1 小时或时长列推算' },
  { key: 'duration', label: '时长', required: false, hint: '例如 90、1.5、90分钟' },
  { key: 'title', label: '事项 / 标题', required: false, hint: '抓不到时回落到课程名' },
  { key: 'course', label: '课程', required: false, hint: '' },
  { key: 'classroom', label: '班级', required: false, hint: '' },
  { key: 'teacher', label: '教师', required: false, hint: '' },
  { key: 'location', label: '地点', required: false, hint: '' },
  { key: 'notes', label: '备注', required: false, hint: '' },
]

function formatAge(iso) {
  if (typeof iso !== 'string' || iso === '') return '从未导入'
  var then = Date.parse(iso)
  if (Number.isNaN(then)) return iso
  var seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return seconds + ' 秒前'
  if (seconds < 3600) return Math.round(seconds / 60) + ' 分钟前'
  if (seconds < 86400) return Math.round(seconds / 3600) + ' 小时前'
  return Math.round(seconds / 86400) + ' 天前'
}

/** Last path segment, for a label that fits on one line. */
function fileNameOf(path) {
  if (typeof path !== 'string') return ''
  var parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function confidenceLabel(value) {
  var number = Number(value)
  if (!Number.isFinite(number)) return { text: '未知', tone: 'mid' }
  var percent = Math.round(number * 100)
  if (percent >= 75) return { text: '很有把握 ' + percent + '%', tone: 'high' }
  if (percent >= 45) return { text: '大概看懂了 ' + percent + '%', tone: 'mid' }
  return { text: '不太确定 ' + percent + '%', tone: 'low' }
}

/** A readable one-liner for a time rule, used in the chips under the verdict. */
function describeRule(rule) {
  if (!rule || typeof rule !== 'object') return ''
  var match = util.safeArray(rule.match).join(' / ')
  return (match === '' ? '默认' : match) + ' → ' + rule.start + '–' + rule.end
}

/** `2026-10-28 → 2026-12-09`, or '' when the sheet has no dated rows. */
function describeSpan(plan) {
  if (!plan || plan.firstDate === '' || plan.lastDate === '') return ''
  if (plan.firstDate === plan.lastDate) return plan.firstDate
  return plan.firstDate + ' → ' + plan.lastDate
}

/**
 * What the import will do, in one line, from the host's own count.
 *
 * The numbers come from `/analyze`'s `plan`, which counts every row with the same
 * filters the import uses. A confirmation that cannot say how much it imports is
 * asking the user to approve something they cannot see.
 */
function describePlan(plan) {
  if (!plan) return ''
  var parts = ['将导入 ' + plan.importable + ' 条']
  var span = describeSpan(plan)
  if (span !== '') parts.push(span)
  return parts.join(' · ')
}

/** Everything the plan is *not* going to import, so the count is not a surprise. */
function describePlanSkips(plan) {
  if (!plan) return ''
  var notes = []
  if (plan.past > 0) notes.push(plan.past + ' 条在今天之前')
  if (plan.beyondHorizon > 0) notes.push(plan.beyondHorizon + ' 条超过 ' + plan.horizonDays + ' 天')
  if (plan.undated > 0) notes.push(plan.undated + ' 条没有日期')
  if (plan.matched === 0) notes.push('没有一条属于 ' + util.safeArray(plan.ownerNames).join(' / '))
  return notes.length === 0 ? '' : '不导入：' + notes.join('、')
}

/**
 * The confirmation step.
 *
 * This used to be a toast in the corner of the window ("AI 已读完…确认后即可导入"),
 * which was wrong in three separate ways: it lived outside the panel the user was
 * looking at, it was covered by the window's own controls, and it disappeared on
 * a timer — so the "确认" step was something to catch before it vanished rather
 * than a place in the flow. It is now a sticky bar at the top of the import page:
 * which file was read, what will be imported, what will be skipped, and one
 * primary button. It stays until the user acts.
 */
function ConfirmBar(props) {
  var store = props.store
  var importState = props.importState
  var plan = props.plan
  var fileName = props.fileName
  var busy = importState.status === 'analyzing' || importState.status === 'loading'
  var status = importState.status
  // `preview` is the same decision state as `ready`: `/preview` (the 重新预览
  // button) produced rows and a mapping, just without a model verdict. Treating it
  // as "not ready" left the bar on screen with no buttons to press.
  var ready = status === 'ready' || status === 'preview'

  if (status === 'idle' && !busy) return null

  var tone = status === 'error' ? 'error' : status === 'done' ? 'done' : busy ? 'busy' : 'ready'
  var confidence = props.analysis ? confidenceLabel(props.analysis.confidence) : null

  var headline
  if (busy) headline = importState.message || '正在读表…'
  else if (status === 'error') headline = '这次没能读完这份表'
  else if (status === 'done') headline = importState.message || '导入完成'
  else headline = fileName === '' ? '这份表读完了，确认后就能导入' : '读完了「' + fileName + '」'

  var detail = null
  if (ready && plan) {
    detail = h(
      'div',
      { className: 'ot-confirm-lines' },
      h('div', { className: 'ot-confirm-line' }, ui.glyph('calendar', 12), h('span', null, describePlan(plan))),
      describePlanSkips(plan) !== '' ? h('div', { className: 'ot-confirm-line ot-warn-text' }, ui.glyph('clock', 12), h('span', null, describePlanSkips(plan))) : null,
    )
  } else if (status === 'done') {
    detail = h(
      'div',
      { className: 'ot-confirm-lines' },
      h('div', { className: 'ot-confirm-line' }, ui.glyph('check', 12), h('span', null, '这份表已经加入日程；再导入一份也不会把这份顶掉。')),
    )
  } else if (status === 'error' && importState.error) {
    detail = h('div', { className: 'ot-confirm-lines' }, h('div', { className: 'ot-confirm-line ot-warn-text' }, importState.error))
  }

  var actions = []
  if (ready) {
    actions.push(
      ui.button({ variant: 'primary', icon: 'check', disabled: busy, onClick: props.onConfirm }, '确认并导入'),
      ui.button({ icon: 'refresh', small: true, disabled: busy, onClick: props.onRepick }, '换一个文件'),
      ui.button({ variant: 'ghost', small: true, disabled: busy, onClick: props.onDetails }, '看看读表细节'),
    )
  } else if (status === 'done') {
    actions.push(
      ui.button({ variant: 'primary', icon: 'plus', onClick: props.onAnother }, '再导入一份'),
      props.onOpenTimeline ? ui.button({ icon: 'calendar', small: true, onClick: props.onOpenTimeline }, '查看日程时间轴') : null,
    )
  } else if (status === 'error') {
    actions.push(ui.button({ icon: 'refresh', small: true, onClick: props.onRetry }, '再读一次'), ui.button({ variant: 'ghost', small: true, onClick: props.onReset }, '重新选文件'))
  }

  return h(
    'div',
    { className: 'ot-confirm', 'data-tone': tone, role: 'status', 'aria-live': 'polite' },
    h(
      'div',
      { className: 'ot-confirm-head' },
      busy ? h('span', { className: 'ot-typing' }, h('i'), h('i'), h('i')) : ui.glyph(status === 'done' ? 'check' : status === 'error' ? 'close' : 'spark', 15),
      h('strong', { className: 'ot-confirm-title' }, headline),
      confidence && ready ? h('span', { className: 'ot-pill', 'data-tone': confidence.tone }, confidence.text) : null,
      h('div', { className: 'ot-headspace' }),
      h('span', { className: 'ot-confirm-hint' }, ready ? '这一步只在你点确认后才会写进日程' : ''),
    ),
    detail,
    actions.filter(Boolean).length > 0 ? h('div', { className: 'ot-confirm-actions' }, actions) : null,
  )
}

function ImportView(props) {
  var store = props.store
  var snapshot = props.snapshot
  var settings = snapshot.settings
  var workbook = settings.workbook
  var excel = snapshot.excel
  var importState = store.get().importState

  var pair = React.useState(repair.repairPath(workbook.path || ''))
  var path = pair[0]
  var setPath = pair[1]

  var mapPair = React.useState({})
  var overrides = mapPair[0]
  var setOverrides = mapPair[1]

  var sheetPair = React.useState('')
  var sheet = sheetPair[0]
  var setSheet = sheetPair[1]

  var advancedPair = React.useState(false)
  var showAdvanced = advancedPair[0]
  var setShowAdvanced = advancedPair[1]

  var dragPair = React.useState(false)
  var dragging = dragPair[0]
  var setDragging = dragPair[1]

  var namePair = React.useState(
    (settings.profile.name || '') +
      (util.safeArray(settings.profile.aliases).length > 0 ? ' / ' + util.safeArray(settings.profile.aliases).join(' / ') : ''),
  )
  var nameDraft = namePair[0]
  var setNameDraft = namePair[1]

  var fileInput = React.useRef(null)
  /** The details card, so "看看读表细节" can bring it into view. */
  var detailsRef = React.useRef(null)
  var analysis = importState.analysis
  var preview = importState.preview
  var plan = (preview && preview.plan) || null
  var busy = importState.status === 'analyzing' || importState.status === 'loading'

  /**
   * What the mapping selects should show. An explicit user override wins, then
   * the analysis, then whatever the parser itself recognised.
   */
  var effectiveMapping = {}
  var sources = [analysis && analysis.mapping, preview && preview.mapping, excel && excel.mapping]
  for (var s = 0; s < sources.length; s += 1) {
    var source = sources[s]
    if (source && typeof source === 'object') {
      for (var sourceKey in source) {
        if (Object.prototype.hasOwnProperty.call(source, sourceKey) && effectiveMapping[sourceKey] === undefined) {
          effectiveMapping[sourceKey] = source[sourceKey]
        }
      }
    }
  }

  var headers = (preview && preview.headers) || (excel && excel.headers) || []
  var columnChoices = headers
    .filter(function (header) {
      return header.text !== ''
    })
    .map(function (header) {
      return header.text
    })

  /**
   * Grid or record table.
   *
   * `analysis.grid` is the host's verdict and is authoritative; the layout
   * string is only consulted when there is no analysis yet. Both are checked
   * for the `matrix*` family, because the parser distinguishes `matrixDate`
   * from `matrixWeek` and only the prefix is stable.
   */
  function matrixLayout(layout) {
    return typeof layout === 'string' && layout.indexOf('matrix') === 0
  }

  var isGrid = analysis
    ? analysis.grid === true
    : matrixLayout(preview && preview.layout) || matrixLayout(excel && excel.layout)

  function saveProfile() {
    var parts = nameDraft
      .split(/[/,，、|]/)
      .map(function (value) {
        return value.trim()
      })
      .filter(function (value) {
        return value !== ''
      })
    if (parts.length === 0) {
      store.pushNotice({ level: 'warn', title: '姓名不能为空', body: '至少填一个用于过滤 Excel 的名字。' })
      return
    }
    store
      .saveSettings({ profile: { name: parts[0], aliases: parts.slice(1) } })
      .then(function () {
        store.pushNotice({ level: 'info', title: '已保存关注姓名', body: parts.join(' / ') })
      })
      .catch(function (error) {
        store.pushNotice({ level: 'warn', title: '保存失败', body: String((error && error.message) || error) })
      })
  }

  /** Reset per-file state whenever a different workbook is read. */
  function clearDraft() {
    setOverrides({})
    setSheet('')
  }

  /**
   * Ask the host to read the workbook and explain it.
   *
   * `pathValue` exists so the drop-zone path and the file-picker path can share
   * one implementation; both end up in the same store action.
   *
   * No toast on success any more: the result is the confirmation bar at the top
   * of this page, which is where the user is already looking and stays until it
   * is acted on. A toast that fades was the whole complaint about this step.
   */
  function analyze(pathValue) {
    clearDraft()
    void store.analyzeWorkbook({ path: pathValue === undefined ? path : pathValue }).catch(function (error) {
      store.pushNotice({ level: 'warn', title: '读表失败', body: String((error && error.message) || error) })
    })
  }

  /** Upload path: the browser has the bytes but never the file path. */
  function analyzeFile(file) {
    if (!file) return
    if (!/\.(xlsx|xlsm|xls)$/i.test(file.name)) {
      store.pushNotice({ level: 'warn', title: '这个文件读不了', body: '只支持 .xlsx / .xlsm / .xls，请另存为 xlsx 再拖进来。' })
      return
    }
    setPath(file.name)
    clearDraft()
    store.set({
      importState: Object.assign({}, store.get().importState, {
        status: 'analyzing',
        message: '正在上传「' + file.name + '」并读表…',
        error: null,
      }),
    })
    if (typeof file.arrayBuffer !== 'function') {
      store.pushNotice({ level: 'warn', title: '浏览器不支持读取该文件', body: '请改用「粘贴路径」方式。' })
      return
    }
    file
      .arrayBuffer()
      .then(function (buffer) {
        var bytes = new Uint8Array(buffer)
        var chunk = 0x8000
        var binary = ''
        for (var i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
        }
        return store.analyzeWorkbook({ file: { name: file.name, base64: btoa(binary) } })
      })
      .catch(function (error) {
        store.pushNotice({ level: 'warn', title: '读表失败', body: String((error && error.message) || error) })
      })
  }

  function onDrop(event) {
    event.preventDefault()
    setDragging(false)
    var files = event.dataTransfer && event.dataTransfer.files
    if (files && files.length > 0) analyzeFile(files[0])
  }

  /** Adopt the analysis, then import in the same request. */
  function confirmAndImport() {
    var patch = buildAdoption()
    // The named file is an *edit to the configured set*, not a replacement for it:
    // the host reads every configured roster and merges the result, so confirming
    // a second roster adds it instead of swapping the first one out. For a dropped
    // file the name is the saved copy; the host matches it to its configured entry
    // by file name.
    void store
      .runImport(Object.assign({ path: importedFile() }, patch))
      .then(function () {
        // The result is on screen (confirmation bar + feed). A toast for something
        // the user is already looking at is noise, and it was the thing that made
        // this step feel like a popup instead of a confirmation.
        setShowAdvanced(false)
      })
      .catch(function (error) {
        store.pushNotice({ level: 'warn', title: '导入失败', body: String((error && error.message) || error) })
      })
  }

  /** Drop back to the file picker without losing the configured rosters. */
  function importAnother() {
    clearDraft()
    store.resetImport()
    if (fileInput.current) fileInput.current.click()
  }

  function scrollToDetails() {
    if (!detailsRef.current) return
    var node = detailsRef.current
    if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  /** The file the analysis actually read: the uploaded copy when there is one. */
  function importedFile() {
    if (preview && typeof preview.configuredPath === 'string' && preview.configuredPath !== '') return repair.repairPath(preview.configuredPath)
    if (preview && typeof preview.file === 'string' && preview.file !== '') return repair.repairPath(preview.file)
    return path
  }

  /**
   * The settings an accepted analysis turns into.
   *
   * Writing the guessed rules down is what makes the next refresh, and the file
   * watcher, agree with what the user just saw — otherwise a re-import would
   * silently fall back to the previous configuration.
   */
  function buildAdoption() {
    var patch = { mapping: overrides, sheet: sheet || undefined }
    if (analysis) {
      if (analysis.grid === true || matrixLayout(analysis.layout)) {
        patch.timeRules = util.safeArray(analysis.timeRules)
        if (analysis.weekOneMonday) patch.weekOneMonday = analysis.weekOneMonday
        if (analysis.subject) patch.subject = analysis.subject
        // What the duty *is*, which the model read out of the sheet's own
        // prose (rooms, roll-call window, the notes beside the grid).
        if (analysis.note) patch.note = analysis.note
      } else if (util.safeArray(analysis.timeRules).length > 0) {
        patch.timeRules = analysis.timeRules
      }
    }
    return patch
  }

  function doPreview() {
    void store
      .previewWorkbook({
        path: path,
        sheet: sheet || undefined,
        mapping: overrides,
        timeRules: analysis && matrixLayout(analysis.layout) ? util.safeArray(analysis.timeRules) : undefined,
      })
      .catch(function (error) {
        store.pushNotice({ level: 'warn', title: '读取失败', body: String((error && error.message) || error) })
      })
  }

  function setOverride(field, value) {
    var next = Object.assign({}, overrides)
    if (value === '') delete next[field]
    else next[field] = value
    setOverrides(next)
  }

  // ---- card 3: the verdict -------------------------------------------------

  var verdict = null
  if (analysis) {
    var confidence = confidenceLabel(analysis.confidence)
    verdict = h(
      'div',
      { className: 'ot-verdict', 'data-tone': confidence.tone },
      h(
        'div',
        { className: 'ot-verdict-head' },
        ui.glyph(analysis.mode === 'model' ? 'robot' : 'spark', 14),
        h('strong', null, analysis.mode === 'model' ? 'AI 读完了这份表' : '本机读完了这份表'),
        h('span', { className: 'ot-pill', 'data-tone': confidence.tone }, confidence.text),
        analysis.model && analysis.model.model
          ? h('span', { className: 'ot-verdict-model' }, analysis.model.provider + ' · ' + analysis.model.model)
          : null,
      ),
      h('div', { className: 'ot-verdict-body' }, analysis.summary || ''),
      util.safeArray(analysis.hints).length > 0
        ? h(
            'ul',
            { className: 'ot-verdict-hints' },
            util.safeArray(analysis.hints).map(function (hint, index) {
              return h('li', { key: 'hint' + index }, hint)
            }),
          )
        : null,
      h(
        'div',
        { className: 'ot-verdict-tags' },
        h('span', { className: 'ot-tag' }, '版式：' + (isGrid ? '值班 / 网格表' : '记录表')),
        h('span', { className: 'ot-tag' }, '工作表：' + ((preview && preview.sheet) || '?')),
        h('span', { className: 'ot-tag' }, '表头第 ' + ((preview && preview.headerRow) || '?') + ' 行'),
        h('span', { className: 'ot-tag' }, ((preview && preview.rowCount) || 0) + ' 行数据'),
        util.safeArray(analysis.timeRules).length > 0
          ? h('span', { className: 'ot-tag' }, '时间：' + describeRule(analysis.timeRules[0]))
          : null,
        analysis.weekOneMonday ? h('span', { className: 'ot-tag' }, '周次锚点 ' + analysis.weekOneMonday) : null,
        plan && snapshot.ownerNames.length > 0
          ? h('span', { className: 'ot-tag' }, '属于你的 ' + plan.matched + ' 行')
          : null,
      ),
      importState.modelNote ? h('div', { className: 'ot-sub' }, importState.modelNote) : null,
      h(
        'div',
        { className: 'ot-verdict-actions' },
        ui.button({ variant: 'primary', icon: 'check', disabled: busy, onClick: confirmAndImport }, '确认并导入'),
        ui.button({ icon: 'refresh', small: true, disabled: busy, onClick: doPreview }, '重新预览'),
        h(
          'button',
          {
            type: 'button',
            className: 'ot-linkbtn',
            onClick: function () {
              setShowAdvanced(!showAdvanced)
            },
          },
          showAdvanced ? '收起手动调整' : '手动调整列映射',
        ),
        h('span', { className: 'ot-headspace' }),
        util.safeArray(analysis.missing).length > 0
          ? h('span', { className: 'ot-sub ot-warn-text' }, '还缺：' + analysis.missing.join('、'))
          : null,
      ),
    )
  }

  var previewTable =
    preview && util.safeArray(preview.sample).length > 0
      ? h(
          'div',
          { className: 'ot-table-wrap', style: { marginTop: 10 } },
          h(
            'table',
            { className: 'ot-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, '行'),
                h('th', null, '日期'),
                h('th', null, '开始'),
                h('th', null, '结束'),
                h('th', null, '事项'),
                h('th', null, '姓名'),
                h('th', null, '地点'),
                h('th', null, '是否属于你'),
              ),
            ),
            h(
              'tbody',
              null,
              preview.sample.map(function (row) {
                return h(
                  'tr',
                  { key: 'row' + row.row, 'data-match': row.match === false ? 'false' : 'true' },
                  h('td', null, String(row.row)),
                  h('td', null, row.date || '—'),
                  h('td', null, row.start || '—'),
                  h('td', null, row.end || '—'),
                  h('td', null, row.title || '—'),
                  h('td', null, row.person || '—'),
                  h('td', null, row.location || '—'),
                  h('td', null, row.match === null ? '未设置姓名' : row.match ? '✓ 你的' : '✗ 跳过'),
                )
              }),
            ),
          ),
        )
      : null

  var advanced =
    showAdvanced && (preview || excel)
      ? h(
          'div',
          { className: 'ot-advanced' },
          h(
            'div',
            { className: 'ot-row ot-advanced-head' },
            h('span', { className: 'ot-field-label' }, '工作表'),
            h(
              'select',
              {
                className: 'ot-input',
                style: { flex: 'none', width: 200 },
                value: sheet || ((preview || excel) && (preview || excel).sheet) || '',
                onChange: function (event) {
                  setSheet(event.target.value)
                },
              },
              util.safeArray((preview || excel) && (preview || excel).sheets).map(function (name) {
                return h('option', { key: name, value: name }, name)
              }),
            ),
            h('span', { className: 'ot-sub' }, '换工作表后点「重新预览」'),
          ),
          isGrid
            ? h(
                'div',
                { className: 'ot-note', style: { marginTop: 8 } },
                '这份表是网格版式：单元格里直接写名字，所以没有「列」可以映射。要改时间，请改文件名或工作表名里的关键词，或者直接在配置里写 timeRules。',
              )
            : h(
                'div',
                { className: 'ot-mapping-list', style: { marginTop: 8 } },
                FIELDS.map(function (field) {
                  var current = overrides[field.key] || effectiveMapping[field.key] || ''
                  var matched = current !== ''
                  return h(
                    'div',
                    { className: 'ot-maprow', key: field.key, 'data-matched': matched ? 'true' : 'false' },
                    h(
                      'span',
                      { className: 'ot-map-label' },
                      field.label,
                      field.required ? h('span', { style: { color: 'var(--ot-danger)' } }, ' *') : null,
                    ),
                    h(
                      'select',
                      {
                        className: 'ot-input',
                        value: current,
                        onChange: function (event) {
                          setOverride(field.key, event.target.value)
                        },
                      },
                      h('option', { value: '' }, matched ? '（忽略这一列）' : '（未匹配）'),
                      columnChoices.map(function (text) {
                        return h('option', { key: text, value: text }, text)
                      }),
                    ),
                    h('span', { className: 'ot-map-hint' }, matched ? '' : field.hint),
                  )
                }),
              ),
          preview && util.safeArray(preview.unmapped).length > 0
            ? h('div', { className: 'ot-sub', style: { marginTop: 8 } }, '未使用的列：' + preview.unmapped.join('、'))
            : null,
        )
      : null

  var warnings = preview ? util.safeArray(preview.warnings) : util.safeArray(excel && excel.warnings)

  /**
   * Which file the confirmation is about. The analysis is the truth while a draft
   * is open; after the import has landed, the last imported file is named by the
   * host's metadata, so the bar still says which roster it was.
   */
  var confirmFileName = (function () {
    if (preview && typeof preview.file === 'string' && preview.file !== '') return fileNameOf(repair.repairPath(preview.file))
    if (importState.status === 'done' && excel && typeof excel.path === 'string') return fileNameOf(excel.path)
    if (typeof path === 'string' && path !== '') return fileNameOf(path)
    return ''
  })()

  return h(
    'div',
    { className: 'ot-view ot-import' },

    /**
     * The two halves load at different moments. A page refresh brings in this
     * panel; the host module was imported when the app started, so it can still be
     * the old import logic. Saying so here is the difference between "the fix did
     * nothing" and "the fix is waiting for a restart".
     */
    store.get().hostStale
      ? ui.note({
          variant: 'error',
          children:
            '宿主半还是旧版本：这份面板已经是新的，但真正执行导入的宿主进程还是启动时加载的那一份 —— ' +
            '所以现在「导入第二份」仍然会把第一份顶掉。关掉 DeepSeek Harness（托盘退出）再打开即可，刷新页面不够。',
        })
      : null,

    // ---- 0 · the confirmation step -----------------------------------------
    //
    // First thing on the page, and sticky: reading a sheet produces a decision, so
    // the decision lives where the reading happened instead of in a corner toast.
    h(ConfirmBar, {
      store: store,
      importState: importState,
      plan: plan,
      analysis: analysis,
      fileName: confirmFileName,
      onConfirm: confirmAndImport,
      onRepick: function () {
        store.resetImport()
        if (fileInput.current) fileInput.current.click()
      },
      onDetails: scrollToDetails,
      onAnother: importAnother,
      onRetry: function () {
        analyze()
      },
      onReset: function () {
        store.resetImport()
      },
      onOpenTimeline: props.onOpenTimeline || null,
    }),

    // ---- 1 · who -----------------------------------------------------------
    ui.card({
      title: '1 · 关注的人',
      children: h(
        'div',
        null,
        h(
          'div',
          { className: 'ot-inline-form' },
          h('input', {
            className: 'ot-input',
            type: 'text',
            value: nameDraft,
            placeholder: '你的名字，多个用 / 分隔，例如：张三 / 张老师',
            onChange: function (event) {
              setNameDraft(event.target.value)
            },
            onKeyDown: function (event) {
              if (event.key === 'Enter') saveProfile()
            },
          }),
          ui.button({ variant: 'primary', icon: 'check', onClick: saveProfile }, '保存'),
        ),
        h(
          'div',
          { className: 'ot-sub', style: { marginTop: 6 } },
          '只有「姓名 / 参会人」列里包含这些名字的行才会进入日程表。当前生效：',
          h('strong', null, util.safeArray(snapshot.ownerNames).join(' / ') || '（未设置，将导入全部行）'),
        ),
      ),
    }),

    h('div', { className: 'ot-gap' }),

    // ---- 2 · the file ------------------------------------------------------
    ui.card({
      title: '2 · Excel 文件',
      children: h(
        'div',
        null,
        h(
          'div',
          {
            className: util.cx('ot-drop', dragging ? 'ot-drop-active' : null),
            onClick: function () {
              if (!busy && fileInput.current) fileInput.current.click()
            },
            onDragOver: function (event) {
              event.preventDefault()
              setDragging(true)
            },
            onDragLeave: function () {
              setDragging(false)
            },
            onDrop: onDrop,
          },
          h('div', { className: 'ot-drop-title' }, busy ? '正在读表…' : '选一个 Excel，AI 直接帮你读'),
          h(
            'div',
            { className: 'ot-drop-sub' },
            '点这里选文件，也可以直接把 .xlsx / .xlsm 拖进来。读完会告诉你这是什么表、认出哪些字段，再让你确认导入。',
          ),
          h(
            'div',
            { className: 'ot-drop-actions' },
            ui.button({
              variant: 'primary',
              icon: 'spark',
              disabled: busy,
              onClick: function (event) {
                // The wrapper already opens the picker; without this the click
                // would reach it twice and the dialog would close immediately.
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                if (fileInput.current) fileInput.current.click()
              },
            }, busy ? '正在读表…' : '选择 Excel'),
            ui.button({
              icon: 'sheet',
              disabled: busy || path.trim() === '',
              onClick: function (event) {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                analyze()
              },
            }, '按已填的路径读表'),
          ),
          h('input', {
            ref: fileInput,
            type: 'file',
            accept: '.xlsx,.xlsm,.xls',
            className: 'ot-file-hidden',
            onChange: function (event) {
              var file = event.target.files && event.target.files[0]
              // Reset so picking the same file twice still fires a change.
              event.target.value = ''
              analyzeFile(file)
            },
          }),
        ),

        h(
          'details',
          { className: 'ot-details' },
          h('summary', null, '或者直接粘贴文件路径', path ? h('code', null, fileNameOf(path)) : null),
          h(
            'div',
            { className: 'ot-inline-form', style: { marginTop: 8 } },
            h('input', {
              className: 'ot-input',
              type: 'text',
              value: path,
              placeholder: 'C:\\Users\\你的账号\\Desktop\\排班表.xlsx（填文件夹也行，会选最新的那个）',
              onChange: function (event) {
                setPath(event.target.value)
                // A new path invalidates the column choices made for the old one.
                clearDraft()
              },
              onKeyDown: function (event) {
                if (event.key === 'Enter' && path.trim() !== '') analyze()
              },
            }),
            ui.button({ icon: 'spark', disabled: busy || path.trim() === '', onClick: function () { analyze() } }, '读这份表'),
          ),
          h(
            'div',
            { className: 'ot-sub', style: { marginTop: 6 } },
            '填文件夹时会选其中「最近修改」的那个 Excel；资源管理器里 Shift + 右键文件 →「复制文件地址」可拿到完整路径。',
          ),
        ),

        excel && excel.path
          ? h(
              'div',
              { className: 'ot-note', style: { marginTop: 10 } },
              '当前文件：',
              h('strong', null, excel.path),
              h('br'),
              '工作表「' + (excel.sheet || '?') + '」· 表头第 ' + excel.headerRow + ' 行 · ' + (excel.rowCount || 0) + ' 行数据 · 已抓取 ' + (excel.importedCount || 0) + ' 条 · ' + formatAge(excel.importedAt),
              excel.matchedCount !== undefined ? h('span', null, ' · 命中 ' + excel.matchedCount + ' 行，过滤 ' + excel.filteredCount + ' 行') : null,
              util.safeArray(excel.chosenFrom).length > 1
                ? h(
                    'div',
                    { className: 'ot-sub', style: { marginTop: 6 } },
                    '这个文件夹里有 ' + excel.chosenFrom.length + ' 个 Excel，已按修改时间选最新的。其余：' + excel.chosenFrom.slice(1, 4).map(function (full) { return fileNameOf(full) }).join('、'),
                  )
                : null,
              excel.lastError ? h('div', { className: 'ot-note ot-note-error', style: { marginTop: 8 } }, '上次错误：' + excel.lastError) : null,
            )
          : null,

        h(
          'div',
          { className: 'ot-row ot-inline-form', style: { marginTop: 10 } },
          ui.switchRow({
            label: '文件变化时自动重新抓取',
            checked: workbook.watch !== false,
            onChange: function (value) {
              void store.saveSettings({ workbook: { watch: value } })
            },
          }),
          h('span', { className: 'ot-headspace' }),
          ui.numberField({
            label: '只看未来',
            value: workbook.importHorizonDays,
            min: 1,
            max: 365,
            suffix: '天',
            onChange: function (value) {
              void store.saveSettings({ workbook: { importHorizonDays: value } })
            },
          }),
        ),
      ),
    }),

    h('div', { className: 'ot-gap' }),

    // ---- 3 · what it is ----------------------------------------------------
    //
    // The details behind the confirmation: what the sheet looked like, how sure
    // the reader was, the sample rows, and the column mapping. The decision itself
    // is the bar at the top — this card is where you go to double-check it.
    h(
      'div',
      { ref: detailsRef },
      ui.card({
        title: '3 · 读表细节',
        children: h(
          'div',
          null,
          importState.status === 'error' && importState.error
            ? ui.note({ variant: 'error', children: importState.error })
            : importState.status === 'analyzing'
              ? h(
                  'div',
                  { className: 'ot-working' },
                  h('span', { className: 'ot-typing' }, h('i'), h('i'), h('i')),
                  h('span', null, importState.message || '正在读表…'),
                )
              : importState.status === 'done' && importState.message
                ? ui.note({ variant: 'ok', children: importState.message })
                : analysis
                  ? null
                  : ui.note({
                      children: '拖一个 Excel 进来，或者点「选择 Excel」；读完会在页面顶部给你一张确认卡，说清楚要导入什么，再让你决定。',
                    }),

          verdict,
          advanced,
          previewTable,
          warnings.length > 0
            ? h('div', { className: 'ot-sub', style: { marginTop: 10 } }, '读表提示：' + warnings.slice(0, 4).join('；'))
            : null,
        ),
      }),
    ),

    h('div', { className: 'ot-gap' }),

    // ---- 4 · reminders -----------------------------------------------------
    ui.card({
      title: '提醒设置',
      children: h(
        'div',
        { className: 'ot-grid ot-grid-2' },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          ui.switchRow({
            label: '开启提醒',
            checked: settings.reminders.enabled !== false,
            onChange: function (value) {
              void store.saveSettings({ reminders: { enabled: value } })
            },
          }),
          ui.textField({
            label: '提前提醒',
            value: util.safeArray(settings.reminders.offsetsMinutes).join(','),
            placeholder: '30,10,5,0',
            onChange: function (value) {
              var list = value
                .split(/[,，\s]+/)
                .map(function (part) {
                  return Number(part)
                })
                .filter(function (value2) {
                  return Number.isFinite(value2) && value2 >= 0 && value2 <= 1440
                })
              void store.saveSettings({ reminders: { offsetsMinutes: list } })
            },
          }),
          h('div', { className: 'ot-sub' }, '0 表示「正好开始时」再提醒一次。默认 30 / 10 / 5 / 0，共四次。'),
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          ui.switchRow({
            label: '同时弹出 Windows 系统通知',
            checked: settings.reminders.osToast !== false,
            onChange: function (value) {
              void store.saveSettings({ reminders: { osToast: value } })
            },
          }),
          ui.switchRow({
            label: '夜间静音',
            checked: settings.reminders.respectQuietHours !== false,
            onChange: function (value) {
              void store.saveSettings({ reminders: { respectQuietHours: value } })
            },
          }),
          h(
            'div',
            { className: 'ot-row' },
            ui.textField({
              label: '静音时段',
              value: (settings.reminders.quietHours && settings.reminders.quietHours.from) || '22:30',
              onChange: function (value) {
                void store.saveSettings({ reminders: { quietHours: { from: value } } })
              },
            }),
            h('span', { className: 'ot-sub' }, '→'),
            ui.textField({
              label: '',
              value: (settings.reminders.quietHours && settings.reminders.quietHours.to) || '07:00',
              onChange: function (value) {
                void store.saveSettings({ reminders: { quietHours: { to: value } } })
              },
            }),
          ),
        ),
      ),
    }),
  )
}

exports.ImportView = ImportView
exports.FIELDS = FIELDS
