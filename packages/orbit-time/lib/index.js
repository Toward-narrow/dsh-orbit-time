/**
 * Orbit Time — host half.
 *
 * Owns everything the browser cannot: the on-disk runtime state, the Excel
 * pipeline (openpyxl through the bundled Python), the reminder engine, and OS
 * notifications. The client half talks to it over plain HTTP routes registered
 * on the composed web server, so the plugin needs no generated Typert/Remote
 * face and stays installable as an ordinary local package.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, rmSync } from 'node:fs'
import * as childProcess from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { repairText, normalisePath } from './shared-repair.cjs'

export const name = 'orbit-time'
/**
 * `webServer` and `timer` are hard requirements. `llm`, `agentDefaultModel`, and
 * the process-spawn seam are read with `ctx.get()` instead, so the plugin still
 * mounts — with its rule-based companion — in a composition that has no model
 * wired up.
 */
export const inject = ['webServer', 'timer']

const require_ = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const PARSE_SCRIPT = join(HERE, 'parse-xlsx.py')
const READ_SCRIPT = join(HERE, 'read-document.py')

const ROUTE_BASE = '/api/orbit-time'
const STATE_DIR_NAME = 'orbit-time'
const SCAN_INTERVAL_MS = 10_000
const MAX_FEED = 60
/**
 * The marker that says a row was typed in by hand.
 *
 * It lives on the row's `source.sheet` rather than in a separate list because it
 * has to survive a restart: the persisted events are the only place a hand-added
 * row exists at all. Declared at module scope so the load path can recognise
 * already-persisted manual rows.
 */
const MANUAL_SHEET = '手动添加'

/**
 * The marker for a row the model read out of a document or a picture.
 *
 * Same job as `MANUAL_SHEET` — the row has no spreadsheet behind it, so the next
 * import must not sweep it away — but a different origin, because "I typed this"
 * and "Orbyt read this off a photo" are different things to see on the timeline,
 * and deleting one should not look like deleting the other.
 */
const AI_SHEET = 'AI 读资料'

/** Formats each pipeline owns. Excel has its own parser; everything else is read as material. */
const EXCEL_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.xls'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'])
const TEXT_EXTENSIONS = new Set([
  '.txt', '.text', '.md', '.markdown', '.csv', '.tsv', '.json', '.ics',
  '.log', '.yaml', '.yml', '.ini', '.conf', '.xml', '.html', '.htm',
])
const DOCUMENT_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...TEXT_EXTENSIONS, '.pdf', '.docx', '.doc', '.pptx'])
const IMAGE_MEDIA_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }


// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function deepMerge(base, patch) {
  if (!isObject(patch)) return base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = isObject(value) && isObject(out[key]) ? deepMerge(out[key], value) : value
  }
  return out
}

function localDayKey(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function localMinutes(date) {
  return date.getHours() * 60 + date.getMinutes()
}

function toMinutes(hhmm) {
  if (typeof hhmm !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

function fromMinutes(total) {
  const wrapped = ((total % 1440) + 1440) % 1440
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`
}

function addMinutes(hhmm, delta) {
  const base = toMinutes(hhmm)
  if (base === null) return ''
  return fromMinutes(base + delta)
}

function shortId(prefix, seed) {
  let hash = 2166136261
  const text = String(seed)
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${prefix}_${(hash >>> 0).toString(36)}`
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * How this plugin starts the two helper processes it owns: the floating HUD and
 * the PowerShell toast.
 *
 * `ctx.get('orbitTimeSpawn')` is an explicit seam, not a service the harness
 * ships. It exists for two reasons: the tests need to observe the exact argument
 * list without opening a real topmost window, and a future subprocess service
 * (with job-object containment) can be substituted without touching this file.
 * The default is Node's own spawn.
 */
function spawnProcess(ctx, command, args, options) {
  const injected = ctx.get?.('orbitTimeSpawn')
  if (typeof injected === 'function') return injected(command, args, options)
  return childProcess.spawn(command, args, options)
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`
  return `${seconds} 秒`
}

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * The workbook location to use when none is configured.
 *
 * The Desktop is the answer on Windows because it is where a schedule export
 * usually lands and it needs no typing: dropping a workbook there is enough for
 * the first import. Any other platform gets an empty default, which surfaces as
 * "point me at a file" rather than a guess.
 */
function defaultWorkbookPath() {
  if (process.platform !== 'win32') return ''
  const home = process.env.USERPROFILE || process.env.HOME
  return home ? join(home, 'Desktop') : ''
}

// ---------------------------------------------------------------------------
// state location
// ---------------------------------------------------------------------------

/**
 * The harness home this plugin keeps its state under.
 *
 * Mirrors the resolution documented by `@deepseek-ai/dsh-home-paths` — an
 * explicit `$DSH_HOME` first, then `~/.dsh` — because *this* process is not one
 * the harness exports `DSH_HOME` to: that variable is injected into model shell
 * calls by `dsh-shell-env`, not into plugin code. Reading only the environment
 * therefore resolved to `os.tmpdir()` inside the desktop app, and that location
 * is not durable: Windows deletes temp files (Storage Sense, disk cleanup, "free
 * up disk space"), which took the imported schedule, the configured rosters, the
 * uploaded workbook copies and the user's settings with it. "导入的日程过几天就
 * 没了" was exactly that, and no amount of re-importing could survive it.
 */
function resolveHarnessHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (fromEnv !== '') return { dir: fromEnv, explicit: true }
  const home = typeof homedir === 'function' ? homedir() : ''
  return { dir: home === '' ? join(tmpdir(), '.dsh') : join(home, '.dsh'), explicit: false }
}

/**
 * Files worth carrying over from a previous, less durable state directory.
 *
 * Only the user's own data: the two JSON files and the uploaded workbook copies.
 * The HUD's runtime files (`hud.pid`, `hud-alive.json`, `hud-mode.json`) are
 * deliberately excluded — they describe a process generation that has already
 * ended, and copying a stale pid into a new host's state directory is how an
 * unrelated process gets chased by the orphan reaper.
 */
const LEGACY_STATE_FILES = ['config.json', 'runtime.json']

/**
 * Move a previous run's state into the durable directory, once.
 *
 * An install that already used the temp directory has real user data there: the
 * roster paths it was pointed at, the imported events, the hand-added rows. The
 * upgrade must not look like a wipe, so the first start under the durable
 * location copies what it finds instead of starting clean.
 */
function adoptLegacyState(target, legacy, report) {
  if (legacy === target) return
  if (!existsSync(legacy)) return
  const hasOwn = LEGACY_STATE_FILES.some((file) => existsSync(join(target, file)))
  if (hasOwn) return
  let moved = 0
  for (const file of LEGACY_STATE_FILES) {
    const from = join(legacy, file)
    if (!existsSync(from)) continue
    try {
      copyFileSync(from, join(target, file))
      moved += 1
    } catch (error) {
      report?.(`could not migrate ${file}: ${error?.message ?? error}`)
    }
  }
  const uploadsFrom = join(legacy, 'uploads')
  if (existsSync(uploadsFrom)) {
    const uploadsTo = join(target, 'uploads')
    try {
      mkdirSync(uploadsTo, { recursive: true })
      for (const name of readdirSync(uploadsFrom)) {
        const from = join(uploadsFrom, name)
        try {
          if (statSync(from).isFile()) {
            copyFileSync(from, join(uploadsTo, name))
            moved += 1
          }
        } catch {
          /* one unreadable file is not a reason to abandon the rest */
        }
      }
    } catch (error) {
      report?.(`could not migrate uploads: ${error?.message ?? error}`)
    }
  }
  if (moved > 0) report?.(`migrated ${moved} state file(s) from ${legacy}`)
}

/**
 * Decide where state lives, creating the directory and migrating an older one.
 *
 * The temp directory remains a last resort so a host whose home is read-only
 * still mounts; it is reached only when the durable location cannot be created
 * or written.
 */
function prepareStateDir(report) {
  const resolved = resolveHarnessHome()
  const durable = join(resolved.dir, 'storages', STATE_DIR_NAME)
  const legacy = join(tmpdir(), STATE_DIR_NAME)
  const candidates = durable === legacy ? [durable] : [durable, legacy]
  let lastError = null
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true })
      // mkdir succeeding is not proof of writability (an existing read-only
      // directory reports success), so probe with a real write.
      const probe = join(dir, '.write-probe')
      writeFileSync(probe, String(Date.now()), 'utf8')
      unlinkSync(probe)
      /**
       * Only the *default* home adopts the old temp directory.
       *
       * An explicit `DSH_HOME` names a different install with its own state; the
       * OS temp directory is shared by every install on the machine, so adopting
       * from it there would mean one profile silently importing another profile's
       * schedules (and would make a test or CI run depend on the developer's
       * machine). The migration exists for exactly one case: this app wrote to
       * temp because the variable was unset, and now it doesn't.
       */
      if (dir === durable && !resolved.explicit) {
        try {
          adoptLegacyState(durable, legacy, report)
        } catch (error) {
          report?.(`legacy state migration skipped: ${error?.message ?? error}`)
        }
      }
      return { dir, migratedFrom: dir === durable && !resolved.explicit && existsSync(legacy) ? legacy : null }
    } catch (error) {
      lastError = error
      report?.(`state directory unusable: ${dir} (${error?.message ?? error})`)
    }
  }
  throw new Error(`没有可写的状态目录：${lastError?.message ?? '未知原因'}`)
}

function defaultConfig() {
  return {
    profile: {
      name: '',
      aliases: [],
      timezone: '',
      locale: 'zh-CN',
    },
    workbook: {
      path: '',
      sheet: '',
      headerRow: 0,
      mapping: {},
      watch: true,
      importHorizonDays: 30,
      includeUndated: false,
      /**
       * Additional workbooks. A duty roster and a study-hall roster are separate
       * files with separate shapes, and one path cannot describe both.
       *
       *   sources:
       *     - path: "C:\\...\\早打卡排班表.xlsx"
       *       subject: "早打卡值班"
       *       note: "7:00 到岗，门口查验早打卡"
       *       timeRules:
       *         - { match: ["早打卡"], start: "07:00", end: "07:30" }
       *
       * `timeRules` supplies the start/end for matrix rosters, which carry no
       * clock times of their own; the first rule whose keyword appears in the
       * sheet name, the file name, or the text above the grid wins.
       *
       * `note` says what the duty *is*. A roster usually states that in prose
       * beside the grid ("点名时间：19：30 20：50", "①一人负责两个班的晚自习考勤"),
       * and that text is read automatically when `note` is empty.
       */
      sources: [],
      /** Label for matrix entries when neither the source nor the sheet names one. */
      subject: '',
      /**
       * What a duty is, for installs with a single roster. Ignored once `sources`
       * names more than one — one shared sentence cannot describe two duties.
       */
      note: '',
      /** Keyword-matched time rules applied to every source. */
      timeRules: [],
      /**
       * ISO date of the Monday in "第1周", for week-block rosters. Without it
       * those rows can only be placed on a weekday, not a date.
       */
      weekOneMonday: '',
    },
    reminders: {
      enabled: true,
      offsetsMinutes: [30, 10, 5, 0],
      respectQuietHours: true,
      quietHours: { from: '22:30', to: '07:00' },
      snoozeMinutes: [5, 10],
      osToast: true,
      sound: true,
    },
    pomodoro: {
      focusMinutes: 25,
      shortBreakMinutes: 5,
      longBreakMinutes: 15,
      roundsBeforeLongBreak: 4,
      autoStartBreak: true,
      autoStartFocus: false,
      dailyGoalRounds: 8,
      tickingSound: false,
    },
    ui: {
      showFloatingWidget: true,
      widgetCorner: 'bottom-right',
      accent: 'aurora',
      timelineDensity: 'comfortable',
      celebrateOnFinish: true,
    },
    /**
     * Orbyt's brain.
     *
     * With `useModel` on and a model available, free-form questions and the
     * action chips are answered by the configured model, grounded in the loaded
     * schedule. When it is off — or the model call fails — the same answers come
     * from the built-in rule engine, so the panel is never left without a reply.
     * Every answer reports which one produced it.
     */
    assistant: {
      useModel: true,
      maxTokens: 700,
      timeoutMs: 45_000,
      historyTurns: 6,
    },
    seedDemoData: false,
  }
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host root context.
 * @param {Record<string, unknown>} rawConfig - loader entry config.
 */
export function apply(ctx, rawConfig = {}) {
  const config = deepMerge(defaultConfig(), rawConfig)
  const startedAt = Date.now()
  /**
   * Where the plugin keeps its state.
   *
   * `$DSH_HOME/storages/<name>` is the real answer — see `prepareStateDir()` for
   * why the variable alone is not enough, and why an older temp directory gets
   * migrated rather than abandoned. The fallback must NOT live inside the
   * installed package: reinstalling is a remove-and-copy, which would delete the
   * running instance's state file out from under it and leave the floating
   * widget reading a path that no longer exists.
   */
  const stateLocation = prepareStateDir((note) => ctx.logger?.warn?.(`[orbit-time] ${note}`))
  const stateDir = stateLocation.dir
  const configPath = join(stateDir, 'config.json')
  const runtimePath = join(stateDir, 'runtime.json')
  const hudStatePath = join(stateDir, 'hud-state.json')
  const hudPidPath = join(stateDir, 'hud.pid')
  const hudAlivePath = join(stateDir, 'hud-alive.json')
  const hudStatusPath = join(stateDir, 'hud-status.json')
  let hudProcess = null

  /**
   * The widget currently on screen, if there is one.
   *
   * This reference used to be a spawn-time variable and nothing else, which made
   * the visible truth ("a HUD window is on screen") and the host's truth ("did I
   * spawn a process?") two different things. They diverge on the first app
   * restart: the widget outlives the host that started it, the new host has a
   * null reference, and every control aimed at it — the panel's 关闭悬浮窗, the
   * three-state switch — becomes a no-op against a window that is plainly right
   * there.
   *
   * So there is a second, durable record: `hud.pid` names the process and
   * `hud-alive.json` is rewritten by the widget on every frame (every ~0.5 s, and
   * deleted as it exits). A file that fresh can only have been written by a
   * widget that is running right now, which is exactly the question `running`
   * answers — and it costs a `statSync` rather than the second-long PowerShell
   * spawn that asking Windows "which process owns that window?" would cost on a
   * path the panel polls.
   *
   * A pid on disk outlives the process it named and the OS hands the number out
   * again, but nothing here is killed on this answer alone: `hud.ps1 -shutdown`
   * re-checks identity itself before stopping anything.
   */
  function liveHudPid() {
    if (hudProcess !== null) return hudProcess.pid ?? null
    try {
      if (!existsSync(hudAlivePath) || !existsSync(hudPidPath)) return null
      const age = Date.now() - statSync(hudAlivePath).mtimeMs
      if (!Number.isFinite(age) || age > 5000) return null
      const pid = Number(readFileSync(hudPidPath, 'utf8').trim())
      if (!Number.isFinite(pid) || pid <= 0) return null
      // Signal 0 asks whether the process exists without touching it.
      process.kill(pid, 0)
      return pid
    } catch {
      return null
    }
  }

  function clearHudPid() {
    try {
      if (existsSync(hudPidPath)) unlinkSync(hudPidPath)
    } catch {
      /* ignore */
    }
  }

  mkdirSync(stateDir, { recursive: true })

  // ---- persisted user configuration ---------------------------------------
  let userConfig = {}
  try {
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
      if (isObject(parsed)) userConfig = parsed
    }
  } catch (error) {
    ctx.logger?.warn?.('[orbit-time] config.json unreadable, using defaults: %s', error?.message ?? error)
  }
  let settings = deepMerge(config, userConfig)

  // ---- encoding self-heal --------------------------------------------------
  /**
   * Undo "UTF-8 read as a single-byte code page" in every string the config
   * carries. A single corrupted value — a workbook path whose Chinese name was
   * decoded as Latin-1 somewhere upstream and then saved — otherwise survives
   * every restart: the import keeps failing with a "file not found" that points
   * at a path the user never typed, and re-pasting it into the panel is the only
   * way out. Repairing once at load makes the install recover on its own.
   *
   * Only user-editable text is touched. Numbers, booleans, and identifiers are
   * left exactly as they are.
   */
  function healValue(key, value) {
    if (typeof value === 'string') {
      if (key === 'path' || key === 'file' || key === 'configuredPath') return normalisePath(value)
      return repairText(value)
    }
    if (Array.isArray(value)) return value.map((item) => healValue(key, item))
    if (isObject(value)) return healObject(value)
    return value
  }

  function healObject(source) {
    const out = {}
    for (const [key, value] of Object.entries(source)) out[key] = healValue(key, value)
    return out
  }

  /**
   * Repair the persisted and configured layers, then write the fixed config
   * back so the next start begins clean.
   *
   * Runs on the *merged* settings, not just the file: the loader entry in
   * `cordis.patch.yml` is a config layer too, and a mis-decoded path is just as
   * likely to have been written there.
   *
   * The result is carried to the end of the setup block instead of being
   * persisted here. `persistConfig` writes `configSynced`, which is declared
   * further down, so calling it this early is a temporal-dead-zone error — the
   * repair would look like it worked while silently failing to save.
   */
  function healSettings() {
    const before = JSON.stringify(settings)
    settings = healObject(settings)
    return JSON.stringify(settings) !== before
  }

  const healedConfig = healSettings()
  if (healedConfig) ctx.logger?.info?.('[orbit-time] repaired mis-decoded config text (mojibake)')

  // ---- runtime state (timer, import metadata, manual overrides, feed) ------
  let runtime = {
    excel: null,
    events: [],
    /** Rows added by hand, kept out of the import's reach — see `mergeManualEvents`. */
    manualEvents: [],
    manualSeq: 0,
    overrides: {},
    feed: [],
    feedSeq: 0,
    lastScanAt: null,
    scanErrors: [],
    /** The last document the model read, so the panel can say what it was. */
    lastExtraction: null,
  }
  try {
    if (existsSync(runtimePath)) {
      const parsed = JSON.parse(readFileSync(runtimePath, 'utf8'))
      if (isObject(parsed)) runtime = deepMerge(runtime, parsed)
    }
  } catch (error) {
    ctx.logger?.warn?.('[orbit-time] runtime.json unreadable, starting clean: %s', error?.message ?? error)
  }

  // Last-run metadata is replayed on every page load, so a pre-repair error
  // message would keep accusing the user of a path that no longer exists.
  if (isObject(runtime.excel)) runtime.excel = healObject(runtime.excel)
  /**
   * A `runtime.json` written before hand-added rows had their own bucket keeps
   * them only inside `events`. Recover them from the marker on the row itself,
   * otherwise the first import of this session would drop every one of them —
   * the exact complaint ("自己加的日程重启就没了") that the bucket was added for.
   */
  if (!Array.isArray(runtime.manualEvents) || runtime.manualEvents.length === 0) {
    const recovered = runtime.events.filter((event) => isObject(event) && isSelfMadeSheet(event.source?.sheet))
    if (recovered.length > 0) runtime.manualEvents = recovered
  }
  if (!Number.isFinite(Number(runtime.manualSeq)) || Number(runtime.manualSeq) < 0) runtime.manualSeq = 0

  const timer = createTimerState(settings)
  const fired = new Map() // `${eventId}:${offset}` -> ISO time
  const clients = new Set()

  let persistTimer = null
  // Set when the host itself has just written config.json, so the watcher below
  // does not re-apply the host's own write.
  let configSynced = false
  function persistSoon() {
    if (persistTimer !== null) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      try {
        writeFileSync(
          runtimePath,
          JSON.stringify(
            {
              excel: runtime.excel,
              events: runtime.events,
              // The hand-added rows are their own bucket: an import rebuilds
              // `events` from the workbook, so without this line every row the
              // user typed would be gone after a restart — the list existed and
              // was never written.
              manualEvents: runtime.manualEvents,
              manualSeq: runtime.manualSeq,
              overrides: runtime.overrides,
              feed: runtime.feed.slice(0, MAX_FEED),
              feedSeq: runtime.feedSeq,
              lastScanAt: runtime.lastScanAt,
              scanErrors: Array.isArray(runtime.scanErrors) ? runtime.scanErrors.slice(-10) : [],
            },
            null,
            2,
          ),
          'utf8',
        )
      } catch (error) {
        ctx.logger?.warn?.('[orbit-time] runtime persist failed: %s', error?.message ?? error)
      }
    }, 800)
    if (typeof persistTimer.unref === 'function') persistTimer.unref()
  }

  function persistConfig() {
    userConfig = {
      profile: settings.profile,
      workbook: settings.workbook,
      reminders: settings.reminders,
      pomodoro: settings.pomodoro,
      ui: settings.ui,
    }
    try {
      writeFileSync(configPath, JSON.stringify(userConfig, null, 2), 'utf8')
      configSynced = true
    } catch (error) {
      ctx.logger?.warn?.('[orbit-time] config write failed: %s', error?.message ?? error)
    }
  }

  // Deferred from `healSettings` so the write happens after `configSynced`
  // exists. Without it the repaired path would live only in memory and come
  // back broken on the next start.
  if (healedConfig) persistConfig()

  /**
   * Notice a `config.json` that changed underneath us.
   *
   * Settings were read once at mount and cached, so editing the file — by hand,
   * or by another tool — was silently ignored until the next app start. The panel
   * offers `ui.showFloatingWidget`, which means the file is a supported way to set
   * it, so the two have to agree.
   *
   * `configSynced` marks the moment the host wrote the file itself: the panel's own
   * save path already applied that change, and re-applying it would only risk
   * fighting a concurrent edit.
   */
  function applyExternalConfig() {
    let parsed = null
    try {
      if (!existsSync(configPath)) return
      parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch {
      // Mid-write or malformed: try again next tick.
      return
    }
    if (!isObject(parsed)) return
    if (configSynced) {
      configSynced = false
      return
    }
    // A hand-edited file is exactly where a copied path can arrive already
    // mis-decoded, so the same repair runs on every external reload.
    const wanted = healObject(deepMerge(config, parsed))
    if (JSON.stringify(wanted) === JSON.stringify(settings)) return
    const wasEnabled = settings.ui?.showFloatingWidget !== false
    settings = wanted
    userConfig = parsed
    if (JSON.stringify(healObject(parsed)) !== JSON.stringify(parsed)) {
      ctx.logger?.info?.('[orbit-time] repaired mis-decoded text in config.json')
      persistConfig()
    }
    timer.config = { ...timer.config, ...settings.pomodoro }
    ctx.logger?.info?.('[orbit-time] config.json changed on disk; settings reloaded')
    // Turning the widget back on has to actually bring it back, or the switch is
    // a lie in both directions.
    if (wasEnabled === false && settings.ui?.showFloatingWidget !== false && hudProcess === null) startHud()
  }

  function pushFeed(entry) {
    runtime.feedSeq += 1
    runtime.feed.unshift({ ...entry, seq: runtime.feedSeq, at: new Date().toISOString() })
    if (runtime.feed.length > MAX_FEED) runtime.feed.length = MAX_FEED
    persistSoon()
    broadcast({ type: 'feed', entry: runtime.feed[0] })
  }

  function broadcast(payload) {
    for (const send of clients) {
      try {
        send(payload)
      } catch {
        clients.delete(send)
      }
    }
  }

  // ---- event normalisation -------------------------------------------------

  function activeNames() {
    const names = [settings.profile.name, ...(settings.profile.aliases ?? [])]
    return names.map((value) => String(value ?? '').trim()).filter((value) => value.length > 0)
  }

  /** Markers that turn a name mention into an exclusion, e.g. "不含张三". */
  const NEGATION = /(不含|不包括|不参与|无需|不用|排除|除|非|not\s|exclude)/i

  /**
   * Whether a cell names one of the configured owners. A roster cell is a loose
   * field — it can hold one name, several separated by 、/,/、or a sentence — so
   * this is a substring test with a negation guard: "不含张三" means the row
   * belongs to everyone else.
   */
  function matchesOwner(text) {
    const names = activeNames()
    if (names.length === 0) return true
    const haystack = String(text ?? '').toLowerCase().replace(/\s+/g, '')
    if (haystack === '') return false
    for (const candidate of names) {
      const needle = candidate.toLowerCase().replace(/\s+/g, '')
      if (needle === '') continue
      let from = 0
      for (;;) {
        const at = haystack.indexOf(needle, from)
        if (at === -1) break
        const before = haystack.slice(0, at)
        const boundary = Math.max(
          before.lastIndexOf('、'),
          before.lastIndexOf(','),
          before.lastIndexOf('，'),
          before.lastIndexOf('/'),
          before.lastIndexOf('|'),
          before.lastIndexOf('；'),
          before.lastIndexOf(';'),
        )
        const context = before.slice(boundary + 1)
        if (!NEGATION.test(context)) return true
        from = at + needle.length
      }
    }
    return false
  }

  /**
   * Rows the user typed in themselves, and how they are kept.
   *
   * An import **replaces** the imported part of `runtime.events`, which is
   * correct for workbook rows — the file is the source of truth and a deleted row
   * must disappear. A hand-added row has no file behind it, so before this it
   * vanished silently on the next scan (including the one every file-watcher tick
   * can trigger). They live in their own list, are persisted with it, and are
   * merged back in; the marker is the source sheet, which also survives a restart
   * because the value is stored on the row itself. `MANUAL_SHEET` is declared at
   * module scope — see the load path, which has to recognise the marker before
   * this block exists.
   */

  function isManualEvent(event) {
    return isObject(event) && isSelfMadeSheet(event.source?.sheet)
  }

  /** Rows that have no file behind them: typed in, or read out of a document. */
  function isSelfMadeSheet(sheet) {
    return sheet === MANUAL_SHEET || sheet === AI_SHEET
  }

  function manualRows() {
    return Array.isArray(runtime.manualEvents) ? runtime.manualEvents.filter((row) => isObject(row)) : []
  }

  /** How many rows each origin contributes, for the panel's counters. */
  function selfMadeCounts() {
    let typed = 0
    let read = 0
    for (const row of manualRows()) {
      if (row.source?.sheet === AI_SHEET) read += 1
      else typed += 1
    }
    return { typed, read }
  }

  function nextManualIndex() {
    runtime.manualSeq = (Number(runtime.manualSeq) || 0) + 1
    return `m${runtime.manualSeq}`
  }

  /** Imported rows first, then by hand — the timeline sorts anyway. */
  function mergeManualEvents(rows) {
    const manual = manualRows().filter((row) => !rows.some((other) => other.id === row.id))
    runtime.events = [...rows, ...manual]
    runtime.manualEvents = manual
    return runtime.manualEvents.length
  }

  function normaliseEvent(raw, index) {
    const date = String(raw.date ?? '').trim()
    let start = String(raw.start ?? '').trim()
    const end = String(raw.end ?? '').trim()
    if (start === '' && date !== '' && /[ T]\d{1,2}[:：.]\d{2}/.test(String(raw.start_raw ?? ''))) {
      start = ''
    }
    const durationMinutes = Number.isFinite(raw.durationMinutes) ? raw.durationMinutes : null
    let endTime = end
    if (endTime === '' && start !== '' && durationMinutes !== null && durationMinutes > 0) {
      endTime = addMinutes(start, durationMinutes)
    }
    if (endTime === '' && start !== '') endTime = addMinutes(start, 60)

    const title =
      String(raw.title ?? '').trim() ||
      String(raw.course ?? '').trim() ||
      String(raw.classroom ?? '').trim() ||
      '未命名日程'

    /**
     * Which roster an imported row came from.
     *
     * `row._source` is the sheet that was actually parsed for this row, so a
     * multi-file import labels each event with its own worksheet instead of the
     * primary file's ("Sheet1" used to leak onto every roster). The path is kept
     * too: when one roster cannot be read on the next scan, its rows are carried
     * over by path, and without it there is no way to tell whose rows are whose.
     * It is also part of the id seed, so two rosters that happen to schedule the
     * same title at the same time stay two distinct events.
     */
    const origin = isObject(raw._source) ? raw._source : null
    const originPath = String(origin?.file ?? runtime.excel?.path ?? '')
    const id = shortId('ev', `${originPath}|${date}|${start}|${title}|${index}`)
    const ownerField = String(raw.person ?? '').trim()
    return {
      id,
      date,
      start,
      end: endTime,
      title,
      course: String(raw.course ?? '').trim(),
      classroom: String(raw.classroom ?? '').trim(),
      teacher: String(raw.teacher ?? '').trim(),
      location: String(raw.location ?? '').trim(),
      category: String(raw.category ?? '').trim(),
      status: String(raw.status ?? '').trim(),
      priority: String(raw.priority ?? '').trim(),
      notes: String(raw.notes ?? '').trim(),
      link: String(raw.link ?? '').trim(),
      contact: String(raw.contact ?? '').trim(),
      owner: ownerField,
      matchedBy: ownerField,
      weekday: String(raw.weekday ?? '').trim(),
      extras: isObject(raw.extras) ? raw.extras : {},
      source: {
        // A row the user typed in carries a marker instead of a worksheet: it has
        // no file, no row number, and must not be swept away by the next import.
        sheet: raw.manual === true ? MANUAL_SHEET : String(origin?.sheet ?? runtime.excel?.sheet ?? ''),
        path: raw.manual === true ? '' : originPath,
        row: raw._row ?? null,
      },
      warnings: Array.isArray(raw._warnings) ? raw._warnings : [],
    }
  }

  // ---- derived event views -------------------------------------------------

  function startMsOf(event) {
    if (event.date === '' || event.start === '') return null
    const parsed = new Date(`${event.date}T${event.start}:00`)
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime()
  }

  function endMsOf(event) {
    const startMs = startMsOf(event)
    if (startMs === null) return null
    if (event.end !== '') {
      const parsed = new Date(`${event.date}T${event.end}:00`)
      if (!Number.isNaN(parsed.getTime())) {
        // An end before the start means the event crosses midnight.
        return parsed.getTime() >= startMs ? parsed.getTime() : parsed.getTime() + 86_400_000
      }
    }
    return startMs + 60 * 60 * 1000
  }

  function overrideOf(event) {
    return runtime.overrides[event.id] ?? {}
  }

  function viewEvent(event, now) {
    const override = overrideOf(event)
    const startMs = startMsOf(event)
    const endMs = endMsOf(event)
    const nowMs = now.getTime()
    let phase = 'upcoming'
    if (startMs === null) phase = 'undated'
    else if (nowMs >= endMs) phase = 'past'
    else if (nowMs >= startMs) phase = 'current'
    const isCurrent = phase === 'current'
    return {
      ...event,
      effectiveStart: override.start ?? event.start,
      effectiveEnd: override.end ?? event.end,
      startMs,
      endMs,
      phase,
      /**
       * Explicit, because `phase` alone was not enough: `nextEventOf` returns
       * whichever event is in flight, and consumers that read it as "the next
       * thing starting" produced nonsense like "已过 5 分钟开始".
       */
      isCurrent,
      done: override.done === true,
      snoozedUntil: override.snoozedUntil ?? null,
      minutesUntilStart: startMs === null ? null : Math.round((startMs - nowMs) / 60_000),
      minutesUntilEnd: endMs === null ? null : Math.round((endMs - nowMs) / 60_000),
      progress:
        startMs !== null && endMs !== null && endMs > startMs
          ? clamp((nowMs - startMs) / (endMs - startMs), 0, 1)
          : 0,
    }
  }

  function eventsForDay(dayKey) {
    return runtime.events
      .filter((event) => event.date === dayKey && !(overrideOf(event).done === true))
      .sort((left, right) => {
        const leftMs = startMsOf(left)
        const rightMs = startMsOf(right)
        if (leftMs === null && rightMs === null) return left.title.localeCompare(right.title)
        if (leftMs === null) return 1
        if (rightMs === null) return -1
        return leftMs - rightMs
      })
  }

  function upcomingEvents(now, limit = 8) {
    const nowMs = now.getTime()
    return runtime.events
      .map((event) => ({ event, startMs: startMsOf(event) }))
      .filter((row) => row.startMs !== null && row.startMs >= nowMs)
      .sort((left, right) => left.startMs - right.startMs)
      .slice(0, limit)
      .map((row) => viewEvent(row.event, now))
  }

  function nextEventOf(now) {
    const nowMs = now.getTime()
    const candidates = runtime.events
      .map((event) => ({ event, startMs: startMsOf(event), endMs: endMsOf(event) }))
      .filter((row) => row.startMs !== null && row.endMs !== null && row.endMs >= nowMs)
      .sort((left, right) => left.startMs - right.startMs)
    if (candidates.length === 0) return null
    const current = candidates.find((row) => row.startMs <= nowMs && nowMs < row.endMs)
    const chosen = current ?? candidates[0]
    return viewEvent(chosen.event, now)
  }

  function freeSlots(now, windowMinutes = 480, minGapMinutes = 20) {
    const base = localMinutes(now)
    const dayKey = localDayKey(now)
    const busy = eventsForDay(dayKey)
      .map((event) => {
        const start = toMinutes(overrideOf(event).start ?? event.start)
        const end = toMinutes(overrideOf(event).end ?? event.end) ?? (start === null ? null : start + 60)
        return start === null || end === null ? null : [start, end <= start ? end + 1440 : end]
      })
      .filter((value) => value !== null)
      .sort((left, right) => left[0] - right[0])

    const slots = []
    let cursor = Math.max(base, ...(busy.length > 0 ? [Math.min(...busy.map((row) => row[0]))] : [base]))
    cursor = Math.max(cursor, base)
    const limit = Math.max(base, Math.min(1440, base + windowMinutes))
    for (const [start, end] of busy) {
      if (end <= cursor) continue
      if (start - cursor >= minGapMinutes) {
        slots.push({ from: fromMinutes(cursor), to: fromMinutes(start), minutes: start - cursor })
      }
      cursor = Math.max(cursor, end)
      if (cursor >= limit) break
    }
    if (limit - cursor >= minGapMinutes) {
      slots.push({ from: fromMinutes(cursor), to: fromMinutes(limit), minutes: limit - cursor })
    }
    return slots.slice(0, 5)
  }

  // ---- workbook analysis ---------------------------------------------------

  /**
   * Field keywords, best match first.
   *
   * These are the vocabulary of the sheets this plugin actually meets: an
   * academic timetable, a duty roster, a study-hall list. Matching is longest
   * keyword wins, and a header hit always beats a value hit, so `上课时间` is
   * read as a start time rather than as the date column.
   */
  const ANALYZE_FIELDS = [
    { key: 'person', label: '姓名 / 参会人', required: true, keywords: ['姓名', '参会人', '值班人', '值班人员', '学生', '成员', '人员', 'name', '值班', '同学'] },
    { key: 'date', label: '日期', required: true, keywords: ['日期', '上课日期', 'date', '星期', '周次', '时间'] },
    { key: 'start', label: '开始时间', required: true, keywords: ['开始时间', '上课时间', '起始时间', '开始', '起止', 'start', '时间'] },
    { key: 'end', label: '结束时间', required: false, keywords: ['结束时间', '下课时间', '截止时间', '结束', 'end', 'finish'] },
    { key: 'duration', label: '时长', required: false, keywords: ['时长', '持续', 'duration', '课时'] },
    { key: 'title', label: '事项 / 标题', required: false, keywords: ['事项', '标题', '活动', '内容', '事由', 'title', 'subject', '任务'] },
    { key: 'course', label: '课程', required: false, keywords: ['课程', '科目', 'course', '课程名称'] },
    { key: 'classroom', label: '班级', required: false, keywords: ['班级', '班次', 'class', '教学班'] },
    { key: 'teacher', label: '教师', required: false, keywords: ['教师', '老师', '任课', '授课', 'teacher', '监考'] },
    { key: 'location', label: '地点', required: false, keywords: ['地点', '教室', '场地', '位置', 'location', 'room', '考点'] },
    { key: 'notes', label: '备注', required: false, keywords: ['备注', '说明', 'note', 'remark', '备注信息'] },
  ]

  /**
   * Time rules guessed from the sheet's own vocabulary.
   *
   * A duty roster records *who* is on duty on a date but never *when*, so the
   * clock has to come from somewhere. Guessing from the file name beats making
   * the user type `07:00` by hand, and every guess is shown before it applies.
   */
  const ANALYZE_TIME_RULES = [
    { match: ['早打卡', '打卡', '早班', '早自习'], start: '07:00', end: '07:30', label: '早打卡 / 早班' },
    { match: ['晚自习', '晚自习考勤', '自习', '晚班'], start: '19:30', end: '20:50', label: '晚自习 / 晚班' },
    { match: ['升旗', '晨会'], start: '07:30', end: '08:00', label: '升旗 / 晨会' },
    { match: ['值班', '值日'], start: '08:00', end: '18:00', label: '值班' },
    { match: ['考试', '监考'], start: '09:00', end: '11:00', label: '考试 / 监考' },
  ]

  function normaliseHeader(value) {
    return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '')
  }

  function longestKeywordHit(text, keywords) {
    const haystack = normaliseHeader(text)
    if (haystack === '') return 0
    let best = 0
    for (const keyword of keywords) {
      const needle = normaliseHeader(keyword)
      if (needle !== '' && haystack.includes(needle) && needle.length > best) best = needle.length
    }
    return best
  }

  /**
   * Which column best answers each field.
   *
   * A keyword in the header is worth more than the same keyword in a value, so
   * header scores are weighted; ties break toward the left-most column because
   * rosters put the identifier column first. Each column is claimed at most once
   * and in field order, so `开始时间` and `结束时间` cannot both land on the
   * same generic `时间` column.
   *
   * Values come from the parser's own mapping when it recognised a column, and
   * from the `extras` bag (unmapped-but-non-empty cells, keyed by header text)
   * for every column it did not. Both are best-effort: a header hit alone is
   * enough to propose a mapping.
   */
  function inferMapping(parsed) {
    const headers = Array.isArray(parsed.headers) ? parsed.headers : []
    const sample = Array.isArray(parsed.preview) ? parsed.preview : []
    const columns = headers
      .map((header) => ({ text: String(header?.text ?? '').trim(), field: header?.field ?? null }))
      .filter((column) => column.text !== '')
    if (columns.length === 0) return {}

    const valuesFor = (column) =>
      sample
        .map((row) => {
          if (!isObject(row)) return ''
          if (column.field !== null && typeof row[column.field] === 'string') return row[column.field]
          const extras = isObject(row.extras) ? row.extras : {}
          return typeof extras[column.text] === 'string' ? extras[column.text] : ''
        })
        .filter((value) => value.trim() !== '')
        .slice(0, 12)

    const scores = columns.map((column) => {
      const entry = {}
      for (const field of ANALYZE_FIELDS) {
        const headerHit = longestKeywordHit(column.text, field.keywords)
        let valueHit = 0
        for (const value of valuesFor(column)) {
          const hit = longestKeywordHit(value, field.keywords)
          if (hit > valueHit) valueHit = hit
        }
        entry[field.key] = headerHit * 10 + valueHit
      }
      return entry
    })

    const taken = new Set()
    const mapping = {}
    for (const field of ANALYZE_FIELDS) {
      let best = null
      for (let index = 0; index < columns.length; index += 1) {
        if (taken.has(index)) continue
        const score = scores[index][field.key]
        if (score <= 0) continue
        if (best === null || score > best.score) best = { index, score }
      }
      if (best !== null) {
        mapping[field.key] = columns[best.index].text
        taken.add(best.index)
      }
    }
    return mapping
  }

  /** Time rules whose keywords appear in the file name, sheet name, or headers. */
  function inferTimeRules(parsed, mapping) {
    const haystack = [
      parsed.file,
      parsed.sheet,
      ...(Array.isArray(parsed.sheets) ? parsed.sheets : []),
      ...(Array.isArray(parsed.headers) ? parsed.headers.map((header) => header?.text) : []),
      // The prose above the grid is where a roster names its own clock
      // ("点名时间：19：30 20：50"), so it counts as evidence too.
      ...(Array.isArray(parsed.sheetNotes) ? parsed.sheetNotes : []),
      mapping.title,
      mapping.course,
      mapping.person,
    ]
      .filter((value) => typeof value === 'string')
      .join(' ')
    const rules = []
    for (const rule of ANALYZE_TIME_RULES) {
      if (rule.match.some((keyword) => haystack.includes(keyword))) {
        rules.push({ match: rule.match.slice(0, 2), start: rule.start, end: rule.end })
      }
    }
    return rules
  }

  /**
   * The Monday that anchors a 「第N周」 roster, when one can be worked out.
   *
   * Three sources, best first: a date written in the file name, a week label in
   * the sheet body (`第2周` is enough to know the shape even when the anchor is
   * unknown), and finally the current week. Only the first is a real answer —
   * the others are placeholders that the panel shows to the user so they can
   * correct it rather than silently importing the wrong dates.
   */
  function inferWeekOne(parsed) {
    const haystack = [parsed.file, parsed.sheet, ...(Array.isArray(parsed.sheets) ? parsed.sheets : [])]
      .filter((value) => typeof value === 'string')
      .join(' ')
    const explicit = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/.exec(haystack)
    if (explicit !== null) {
      const month = String(explicit[2]).padStart(2, '0')
      const day = String(explicit[3]).padStart(2, '0')
      const date = new Date(`${explicit[1]}-${month}-${day}T00:00:00`)
      if (!Number.isNaN(date.getTime())) {
        // Snap to the Monday of that week: 「第1周」 always starts on one.
        const shift = (date.getDay() + 6) % 7
        date.setDate(date.getDate() - shift)
        return localDayKey(date)
      }
    }
    // Week labels live in the sheet body, not in its name: for a block roster
    // the parser reports the blocks as rows, so scan the previewed values too.
    const bodyText = (Array.isArray(parsed.preview) ? parsed.preview : [])
      .map((row) => (isObject(row) ? Object.values(row).filter((value) => typeof value === 'string').join(' ') : ''))
      .join(' ')
    if (!/第\s*\d+\s*周/.test(haystack + ' ' + bodyText)) return ''
    const now = new Date()
    now.setDate(now.getDate() - ((now.getDay() + 6) % 7))
    return localDayKey(now)
  }

  /**
   * A grid roster, read structurally rather than by dictionary name.
   *
   * The parser's own verdict is the strong signal, so it is trusted outright.
   * When it fell back to `records` the shape is still checkable: a grid roster
   * produces one record per filled cell with no start time of its own, and its
   * `person` values are the names that sat in the cells. Several same-length
   * records whose person column is populated but whose clock is empty is the
   * fingerprint of a grid the layout detector missed.
   */
  function detectGrid(parsed) {
    const layout = String(parsed.layout ?? 'records')
    if (layout === 'matrix' || layout === 'matrixDate' || layout === 'matrixWeek') {
      return { grid: true, layout }
    }
    const sample = Array.isArray(parsed.preview) ? parsed.preview : []
    const rows = sample.filter(isObject)
    if (rows.length < 3) return { grid: false, layout: 'records' }
    const named = rows.filter((row) => String(row.person ?? '').trim() !== '').length
    const clocked = rows.filter((row) => String(row.start ?? '').trim() !== '').length
    const grid = named === rows.length && clocked === 0 && String(parsed.sheet ?? '') !== ''
    return { grid, layout: grid ? 'matrix' : 'records' }
  }

  /**
   * The whole local read of one workbook.
   *
   * This is the answer the panel shows when no model is wired up, and the draft
   * the model is asked to confirm or correct when one is. Keeping a real
   * deterministic analyzer behind the AI path is what makes the feature safe to
   * promise: it cannot come back empty.
   */
  function analyzeLocally(parsed) {
    const grid = detectGrid(parsed)
    // A grid roster has no columns to map — the parser's "值班日期 / 星期 /
    // 开始时间" list is its own synthetic schema for the records it synthesised,
    // not anything the user could point at in the sheet. Reporting it as a
    // mapping would be actively misleading, so a grid reports none.
    const mapping = grid.grid ? {} : inferMapping(parsed)
    const timeRules = inferTimeRules(parsed, mapping)
    const weekOneMonday = inferWeekOne(parsed)

    const filled = ANALYZE_FIELDS.filter((field) => typeof mapping[field.key] === 'string' && mapping[field.key] !== '')
    const missing = grid.grid
      ? []
      : ANALYZE_FIELDS.filter((field) => field.required && (mapping[field.key] ?? '') === '')
    let confidence = 0.35
    if (grid.grid) confidence = timeRules.length > 0 ? 0.78 : 0.5
    else confidence = Math.min(0.95, 0.4 + filled.length * 0.06)

    const fileName = basename(String(parsed.file ?? ''))
    const layoutLabel = grid.grid ? '值班 / 网格表（单元格里直接写名字）' : '一行一条日程的记录表'
    const summary = grid.grid
      ? `把「${fileName}」看成了${layoutLabel}：${parsed.rowCount ?? 0} 行记录` +
        (timeRules.length > 0 ? `，时间按关键词取 ${timeRules[0].start}–${timeRules[0].end}` : '，还没定出时间') +
        (weekOneMonday !== '' ? `，周次锚点 ${weekOneMonday}` : '') +
        '。'
      : `把「${fileName}」看成了${layoutLabel}：识别出 ${filled.length} 个字段` +
        (missing.length > 0 ? `，还缺 ${missing.map((field) => field.label).join('、')}` : '') +
        '。'

    const hints = grid.grid
      ? [
          '网格表不需要列映射：单元格里的名字就是排班结果。',
          timeRules.length > 0
            ? `时间来自文件名/工作表名里的「${timeRules[0].match[0]}」，要改就改关键词或直接写 timeRules。`
            : '没有匹配到时间关键词，导入后这些日程没有开始时间。',
        ]
      : [
          '列映射按表头文字匹配，可在下面手动改。',
          missing.length > 0 ? `必填字段还没配齐：${missing.map((field) => field.label).join('、')}。` : '必填字段已配齐，可以直接导入。',
        ]

    return {
      mode: 'local',
      layout: grid.layout,
      mapping,
      timeRules,
      weekOneMonday,
      subject: timeRules.length > 0 ? timeRules[0].match[0] : '',
      confidence: Number(confidence.toFixed(2)),
      summary,
      hints,
      missing: missing.map((field) => field.label),
      grid: grid.grid,
      filled: filled.length,
    }
  }

  /** The analyzer's system prompt: a strict contract, no prose. */
  const ANALYZE_SYSTEM = [
    '你是一个 Excel 排班表结构分析器。用户会给你一份表格的表头、样例数据、表格上方的说明文字和一些事实。',
    '你的唯一任务是判断这份表属于哪种版式，并给出字段映射，用 JSON 回答。',
    '',
    '版式只有两种：',
    '- records：一行一条记录，表头行里有「日期 / 开始时间 / 姓名」这类列名。',
    '- matrix：值班表/网格表，单元格里直接写名字，靠日期表头或「第N周 + 周一…周日」定位。',
    '',
    '只输出一个 JSON 对象，不要 Markdown、不要解释、不要代码围栏。字段：',
    '{',
    '  "layout": "records" | "matrix",',
    '  "mapping": { "person": "列名", "date": "列名", "start": "列名", "end": "列名", "duration": "", "title": "", "course": "", "classroom": "", "teacher": "", "location": "", "notes": "" },',
    '  "timeRules": [{ "match": ["关键词"], "start": "HH:MM", "end": "HH:MM" }],',
    '  "weekOneMonday": "YYYY-MM-DD 或空字符串",',
    '  "subject": "这份表的事项名，例如 晚自习考勤点名",',
    '  "confidence": 0 到 1 的小数,',
    '  "summary": "一两句中文，说明你怎么看这份表，给用户看",',
    '  "hints": ["给用户看的提醒，最多 3 条"]',
    '}',
    '',
    '硬性要求：',
    '- mapping 的值必须是「给定的列名」之一，不能自创列名；没有把握就留空字符串。',
    '- matrix 版式的 mapping 必须全部留空：网格表没有列映射。',
    '- timeRules 只在表里没有明确时间列、需要按关键词补时间时才给；match 用表里真实出现过的词。表外文字写明的时间就是它的上下班时间。',
    '- subject 要照着「表外文字」和文件名写清楚这件事**干什么**（值班、考勤点名、值班巡查…），不要只重复文件名。',
    '- 不要编造文件里没有的信息。',
  ].join('\n')

  /** Compact, model-friendly view of one parsed workbook. */
  function buildAnalyzeFacts(parsed) {
    const sample = (Array.isArray(parsed.preview) ? parsed.preview : []).slice(0, 6).map((row) => {
      if (!isObject(row)) return {}
      const cells = {}
      for (const column of Array.isArray(parsed.headers) ? parsed.headers : []) {
        const text = String(column?.text ?? '').trim()
        if (text === '') continue
        const extra = isObject(row.extras) ? row.extras[text] : undefined
        const own = column?.field !== null && column?.field !== undefined ? row[column.field] : undefined
        const value = typeof own === 'string' && own !== '' ? own : extra
        if (typeof value === 'string' && value !== '') cells[text] = value.slice(0, 24)
      }
      return cells
    })
    return JSON.stringify(
      {
        文件: parsed.file,
        工作表: parsed.sheet,
        全部工作表: parsed.sheets,
        解析器判断的版式: parsed.layout ?? 'records',
        表头行号: parsed.headerRow,
        数据行数: parsed.rowCount,
        表头: (Array.isArray(parsed.headers) ? parsed.headers : []).map((header) => header?.text).filter(Boolean),
        样例前几行: sample,
        表外文字: Array.isArray(parsed.sheetNotes) ? parsed.sheetNotes : [],
        解析器给出的初步映射: parsed.mapping ?? {},
        解析器告警: parsed.warnings ?? [],
        今天: localDayKey(new Date()),
      },
      null,
      1,
    )
  }

  /** First JSON object in a model reply, tolerating fences and stray prose. */
  function extractJsonObject(text) {
    const source = String(text ?? '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/,'')
    const start = source.indexOf('{')
    if (start < 0) return null
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < source.length; index += 1) {
      const char = source[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            const parsed = JSON.parse(source.slice(start, index + 1))
            return isObject(parsed) ? parsed : null
          } catch {
            return null
          }
        }
      }
    }
    return null
  }

  /** Keep only mapping entries that name a column the sheet really has. */
  function sanitiseMapping(candidate, parsed) {
    if (!isObject(candidate)) return {}
    const available = new Set(
      (Array.isArray(parsed.headers) ? parsed.headers : [])
        .map((header) => String(header?.text ?? '').trim())
        .filter((text) => text !== ''),
    )
    const out = {}
    for (const field of ANALYZE_FIELDS) {
      const value = candidate[field.key]
      if (typeof value !== 'string' || value.trim() === '') continue
      const text = value.trim()
      if (available.has(text)) out[field.key] = text
    }
    return out
  }

  function sanitiseTimeRules(candidate) {
    if (!Array.isArray(candidate)) return []
    const out = []
    for (const rule of candidate.slice(0, 4)) {
      if (!isObject(rule)) continue
      const match = (Array.isArray(rule.match) ? rule.match : [rule.match])
        .filter((value) => typeof value === 'string' && value.trim() !== '')
        .map((value) => value.trim())
        .slice(0, 3)
      const start = /^\d{1,2}:\d{2}$/.test(String(rule.start ?? '')) ? String(rule.start) : ''
      const end = /^\d{1,2}:\d{2}$/.test(String(rule.end ?? '')) ? String(rule.end) : ''
      if (match.length === 0 || start === '' || end === '') continue
      out.push({ match, start, end })
    }
    return out
  }

  /**
   * Read a workbook and say what it is.
   *
   * The deterministic pass always runs; the model, when one is configured, is
   * asked to confirm or correct it and to write the sentence the user reads. A
   * model failure is reported as a reason rather than swallowed, so the panel
   * can say "AI 不可用，这是本地判断" instead of pretending nothing happened.
   */
  async function analyzeWorkbook(options = {}) {
    const parsed = await readWorkbook({
      path: options.path,
      sheet: typeof options.sheet === 'string' && options.sheet !== '' ? options.sheet : undefined,
      previewRows: 12,
    })
    const local = analyzeLocally(parsed)
    const status = assistantStatus()
    if (options.useModel === false || status.mode !== 'model') {
      return {
        parsed,
        analysis: { ...local, mode: 'local', modelReason: status.mode === 'model' ? 'disabled' : status.reason, modelDetail: status.detail },
      }
    }

    const model = await askModel(
      buildAnalyzeFacts(parsed),
      null,
      [],
      { system: ANALYZE_SYSTEM, maxTokens: 900 },
    )
    if (!model.ok) {
      ctx.logger?.warn?.('[orbit-time] workbook analysis fell back to local rules (' + model.reason + '): ' + model.detail)
      return { parsed, analysis: { ...local, mode: 'local', modelReason: model.reason, modelDetail: model.detail } }
    }

    const proposal = extractJsonObject(model.text)
    if (proposal === null) {
      return {
        parsed,
        analysis: { ...local, mode: 'local', modelReason: 'unparsable', modelDetail: '模型没有按要求返回 JSON', modelText: String(model.text).slice(0, 600) },
      }
    }

    const grid = proposal.layout === 'matrix' || (proposal.layout === undefined && local.grid)
    // `local.mapping` is empty for a grid on purpose, so the deterministic
    // fallback for a records sheet has to come from the raw inference.
    const mapping = grid ? {} : { ...inferMapping(parsed), ...sanitiseMapping(proposal.mapping, parsed) }
    const timeRules = sanitiseTimeRules(proposal.timeRules)
    const missing = grid ? [] : ANALYZE_FIELDS.filter((field) => field.required && (mapping[field.key] ?? '') === '')

    return {
      parsed,
      analysis: {
        mode: 'model',
        model: { provider: model.provider, model: model.model },
        layout: grid ? 'matrix' : 'records',
        mapping,
        timeRules: timeRules.length > 0 ? timeRules : local.timeRules,
        weekOneMonday:
          typeof proposal.weekOneMonday === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(proposal.weekOneMonday)
            ? proposal.weekOneMonday
            : local.weekOneMonday,
        subject: typeof proposal.subject === 'string' ? repairText(proposal.subject.trim()) : local.subject,
        confidence: Number.isFinite(Number(proposal.confidence)) ? clamp(Number(proposal.confidence), 0, 1) : local.confidence,
        summary: typeof proposal.summary === 'string' && proposal.summary.trim() !== '' ? repairText(proposal.summary.trim()) : local.summary,
        hints: (Array.isArray(proposal.hints) ? proposal.hints : local.hints)
          .filter((hint) => typeof hint === 'string' && hint.trim() !== '')
          .map((hint) => repairText(hint.trim()))
          .slice(0, 3),
        missing: missing.map((field) => field.label),
        grid,
        filled: ANALYZE_FIELDS.filter((field) => (mapping[field.key] ?? '') !== '').length,
        localSummary: local.summary,
      },
    }
  }

  // ---- Excel pipeline ------------------------------------------------------

  /**
   * Directories a bare file *name* is looked for in.
   *
   * A pasted path is often just the file name, and the old answer — "join it to
   * the home directory, otherwise resolve it relative to the process" — put the
   * file in the plugin's own install directory, which is nobody's idea of where
   * a spreadsheet lives. Searching the places a person actually keeps one, and
   * the workspace the plugin is running in, turns "找不到文件" into a hit.
   */
  function workbookSearchBases() {
    const home = process.env.USERPROFILE || process.env.HOME || ''
    const bases = []
    const push = (value) => {
      if (typeof value === 'string' && value !== '' && !bases.includes(value)) bases.push(value)
    }
    push(process.cwd())
    push(settings.workbook.workspaceDir)
    if (home !== '') {
      push(home)
      for (const folder of ['Desktop', 'Documents', 'Downloads', 'OneDrive/Desktop', 'OneDrive/文档']) {
        push(join(home, folder))
      }
    }
    // The profile directory, so a path that was previously resolved into it can
    // still be found if the file really is there.
    if (process.env.DSH_PROFILE_DIR) push(process.env.DSH_PROFILE_DIR)
    return bases
  }

  function resolveWorkbookPath(candidate) {
    const trimmed = typeof candidate === 'string' ? candidate.trim().replace(/^"|"$/g, '') : ''
    // A blank setting means "use the default location", never "no location":
    // an operator who clears the field should fall back to the Desktop rather
    // than lose the watcher entirely.
    if (trimmed === '') return defaultWorkbookPath()
    if (existsSync(trimmed)) return resolve(trimmed)
    if (isAbsolute(trimmed)) return resolve(trimmed)
    // A relative path — or a bare file name — is searched for rather than
    // guessed at, so the answer is either a real file or the original string.
    for (const base of workbookSearchBases()) {
      const joined = join(base, trimmed)
      if (existsSync(joined)) return resolve(joined)
    }
    return resolve(trimmed)
  }

  /**
   * Turn a configured location into the workbook actually read.
   *
   * A directory is a first-class answer: the default is the Desktop, so the
   * operator can just drop a schedule there and press import. Choosing inside a
   * folder picks the newest workbook, because a stale export is never the one
   * somebody just saved.
   */
  function findWorkbookIn(target) {
    if (target === '') return { path: '', candidates: [], error: null }
    let stat = null
    try {
      stat = statSyncLazy(target)
    } catch (error) {
      return { path: target, candidates: [], error: `找不到文件或目录：${target}` }
    }
    if (!stat.isDirectory()) return { path: target, candidates: [target], error: null }

    let names = []
    try {
      names = readdirSync(target)
    } catch (error) {
      return { path: target, candidates: [], error: `无法读取目录：${error?.message ?? error}` }
    }
    const candidates = names
      .filter((name) => /\.(xlsx|xlsm|xls)$/i.test(name) && !name.startsWith('~$'))
      .map((name) => join(target, name))
      .filter((full) => {
        try {
          return statSyncLazy(full).isFile()
        } catch {
          return false
        }
      })
      .sort((left, right) => {
        try {
          return statSyncLazy(right).mtimeMs - statSyncLazy(left).mtimeMs
        } catch {
          return 0
        }
      })

    if (candidates.length === 0) {
      return { path: target, candidates: [], error: `这个文件夹里没有 Excel 文件（.xlsx / .xlsm / .xls）：${target}` }
    }
    return { path: candidates[0], candidates, error: null }
  }

  function pythonCandidates() {
    const list = []
    if (process.env.DSH_PYTHON) list.push(process.env.DSH_PYTHON)
    const dshHome = process.env.DSH_HOME
    if (dshHome) {
      list.push(join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'))
    }
    /*
     * The desktop app does not export `DSH_HOME` into a plugin process, so the
     * bundled interpreter was never found by that branch and the plugin fell
     * through to whatever `python` happened to be on PATH. That works for
     * openpyxl by luck; the document reader needs PyMuPDF and python-docx, which
     * ship with the managed runtime specifically. Look there by the resolved
     * harness home too — the same place `prepareStateDir` already trusts.
     */
    try {
      list.push(join(resolveHarnessHome().dir, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'))
    } catch {
      /* no home: the PATH candidates still apply */
    }
    try {
      const payload = require_('@deepseek-ai/dsh-workspace-dependencies')
      if (typeof payload?.pythonPath === 'string') list.push(payload.pythonPath)
    } catch {
      /* optional resolver, ignore */
    }
    list.push('python', 'python3')
    return list
  }

  function runPython(script, args, timeoutMs = 60_000) {
    return new Promise((resolvePromise, reject) => {
      const candidates = pythonCandidates()
      let index = 0
      const attempt = () => {
        if (index >= candidates.length) {
          reject(new Error(`找不到可用的 Python 解释器（已尝试：${candidates.join(', ')}）`))
          return
        }
        const executable = candidates[index]
        index += 1
        let child
        try {
          child = spawnProcess(ctx, executable, [script, ...args], { windowsHide: true })
        } catch {
          attempt()
          return
        }
        let stdout = ''
        let stderr = ''
        let settled = false
        const timer_ = setTimeout(() => {
          if (settled) return
          settled = true
          try {
            child.kill()
          } catch {
            /* ignore */
          }
          reject(new Error(`读取文件超时（${timeoutMs} ms）`))
        }, timeoutMs)
        child.stdout?.on('data', (chunk) => {
          stdout += chunk
        })
        child.stderr?.on('data', (chunk) => {
          stderr += chunk
        })
        child.on('error', (error) => {
          if (settled) return
          settled = true
          clearTimeout(timer_)
          if (error.code === 'ENOENT') attempt()
          else reject(error)
        })
        child.on('close', (code) => {
          if (settled) return
          settled = true
          clearTimeout(timer_)
          if (code !== 0 && stdout.trim() === '') {
            reject(new Error(`Python 退出码 ${code}: ${stderr.trim().slice(0, 800)}`))
            return
          }
          resolvePromise({ stdout, stderr, code })
        })
      }
      attempt()
    })
  }

  async function readWorkbook(options = {}) {
    const configured = resolveWorkbookPath(options.path !== undefined ? options.path : settings.workbook.path)
    if (configured === '') throw new Error('还没有设置 Excel 日程文件路径。')
    const located = findWorkbookIn(configured)
    if (located.error !== null) throw new Error(located.error)
    const workbookPath = located.path
    if (!existsSync(workbookPath)) throw new Error(`找不到文件：${workbookPath}`)
    const payload = {
      sheet: options.sheet ?? (settings.workbook.sheet === '' ? undefined : settings.workbook.sheet),
      headerRow: options.headerRow ?? (settings.workbook.headerRow > 0 ? settings.workbook.headerRow : undefined),
      mapping: { ...settings.workbook.mapping, ...(isObject(options.mapping) ? options.mapping : {}) },
      previewRows: options.previewRows ?? 12,
      subject: options.subject ?? settings.workbook.subject ?? undefined,
      note: options.note ?? settings.workbook.note ?? undefined,
      timeRules: Array.isArray(options.timeRules)
        ? options.timeRules
        : Array.isArray(settings.workbook.timeRules)
          ? settings.workbook.timeRules
          : undefined,
      weekOneMonday: options.weekOneMonday ?? (settings.workbook.weekOneMonday || undefined),
      region: options.region,
    }
    const { stdout, stderr } = await runPython(PARSE_SCRIPT, [workbookPath, JSON.stringify(payload)])
    let parsed
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new Error(`Excel 解析输出无法识别：${(stderr || stdout).slice(0, 600)}`)
    }
    if (parsed?.ok !== true) throw new Error(String(parsed?.error ?? 'Excel 解析失败'))
    parsed.chosenFrom = located.candidates.length > 1 ? located.candidates : undefined
    parsed.configuredPath = configured
    return parsed
  }

  /**
   * Every configured workbook, in order, each counted once.
   *
   * `workbook.path` describes the primary file and `workbook.sources` adds more,
   * each with its own subject and time rules — a duty roster and a study-hall
   * roster are separate exports with separate shapes.
   *
   * An unset primary path falls back to the Desktop, which is a convenience for
   * a single-file setup. When explicit sources exist, that fallback is skipped:
   * treating an empty Desktop as a third source would report a file error for a
   * location the operator never named.
   *
   * A file covered by both settings is a normal state, not a mistake — the panel
   * writes the analysed file to `workbook.path`, and that same roster is usually
   * already in `sources`. Reading it twice imports every event twice, so a
   * duplicate path is dropped and the primary wins, because it carries the
   * subject the user just confirmed in the panel.
   *
   * The workbook-level `subject` and `note` are fallbacks for a *single* roster
   * ("this install has one spreadsheet"). Once `sources` names more than one,
   * each entry speaks for itself: a leftover label from the last analysed file
   * must not describe a roster it was never written for, or the study-hall duty
   * gets handed the morning check-in's name.
   *
   * A file can legitimately appear in both places: the panel writes the analysed
   * workbook to `workbook.path`, and the same roster is usually already listed in
   * `sources`. Then the *listed* entry wins, because it is the one carrying a
   * subject and a note; taking the bare primary instead is what reduced the
   * evening roster to its worksheet name ("Sheet1").
   */
  function configuredSources() {
    const extras = (Array.isArray(settings.workbook.sources) ? settings.workbook.sources : []).filter(
      (source) => isObject(source) && resolveWorkbookPath(source.path) !== '',
    )
    const explicitPrimary = typeof settings.workbook.path === 'string' && settings.workbook.path.trim() !== ''
    // A shared label is only meaningful while it can only mean one roster.
    const shared = extras.length <= 1
    const list = []
    const index = new Map()
    const push = (source) => {
      const key = source.path.toLowerCase()
      const at = index.get(key)
      if (at !== undefined) {
        list[at] = source
        return
      }
      index.set(key, list.length)
      list.push(source)
    }
    if (explicitPrimary || extras.length === 0) {
      const primary = resolveWorkbookPath(settings.workbook.path)
      if (primary !== '') {
        push({
          path: primary,
          subject: settings.workbook.subject || '',
          note: settings.workbook.note || '',
          timeRules: settings.workbook.timeRules,
          sheet: settings.workbook.sheet || undefined,
          mapping: settings.workbook.mapping,
          weekOneMonday: settings.workbook.weekOneMonday || undefined,
        })
      }
    }
    for (const source of extras) {
      push({
        path: resolveWorkbookPath(source.path),
        subject: source.subject || (shared ? settings.workbook.subject || '' : ''),
        note: source.note || (shared ? settings.workbook.note || '' : ''),
        timeRules: Array.isArray(source.timeRules) ? source.timeRules : settings.workbook.timeRules,
        sheet: source.sheet || undefined,
        // Each roster has its own columns and its own week anchor. These were
        // written by the panel's adoption but never read back, so the *last*
        // analysed file's mapping leaked onto every other roster on the next
        // import — the second sheet "suddenly" read the wrong columns.
        mapping: isObject(source.mapping) ? source.mapping : settings.workbook.mapping,
        weekOneMonday: source.weekOneMonday || settings.workbook.weekOneMonday || undefined,
      })
    }
    return list
  }

  /** The configured entry a path belongs to, matched by full path, then by name. */
  function configuredEntryFor(path, list) {
    const target = String(resolveWorkbookPath(path)).toLowerCase()
    if (target === '') return undefined
    const exact = list.find((source) => source.path.toLowerCase() === target)
    if (exact !== undefined) return exact
    // An uploaded copy is a different path (`<状态目录>/uploads/…`) holding the
    // same workbook, so the file name is the only thing that still matches.
    const name = target.split(/[\\/]/).pop()
    return name === undefined || name === '' ? undefined : list.find((source) => source.path.toLowerCase().endsWith(name))
  }

  /**
   * Which of two labels to keep for the same roster.
   *
   * The panel's proposal is derived from the file ("晚自习"), the configured one
   * is what a person wrote down once ("示例支部晚自习考勤点名"). A proposal that
   * says *less* than the label already on file must not replace it.
   */
  function betterLabel(proposed, configured) {
    const left = String(proposed ?? '').trim()
    const right = String(configured ?? '').trim()
    if (right === '') return left
    if (left === '') return right
    return left.length >= right.length ? left : right
  }

  /**
   * The list of workbooks this run reads: always the **union** of everything
   * configured, never just the one file a request names.
   *
   * This is the fix for "导入第二份，第一份就没了". The panel posts the path it
   * just analysed, and scoping the read to that single file meant the import
   * rebuilt `runtime.events` from one roster — every event from every other
   * roster disappeared, and the timeline looked like the earlier import had been
   * overwritten. A named file is now an *edit to the set*, not a replacement for
   * it:
   *
   *   - a path that belongs to a configured roster (by path, or by file name for
   *     a dropped copy) takes that entry's place for this run, keeping its
   *     subject, note, time rules and mapping;
   *   - anything else joins the set, so a newly dropped roster is added rather
   *     than swapped in.
   *
   * Per-file options (`mapping`, `sheet`, `timeRules`, `subject`, `note`) apply
   * to the named file only. Applying them to every roster was the other half of
   * the same bug: the first roster's column mapping was pushed onto the second.
   */
  async function readAllSources(options = {}) {
    const sources = configuredSources()
    const requestedPath = typeof options.path === 'string' && options.path.trim() !== '' ? resolveWorkbookPath(options.path) : ''
    const requested = requestedPath !== ''
    const configuredEntry = requested ? configuredEntryFor(requestedPath, sources) : undefined
    const hasSheet = typeof options.sheet === 'string' && options.sheet !== ''
    let list = sources
    if (requested) {
      if (configuredEntry !== undefined) {
        list = sources.map((source) =>
          source === configuredEntry
            ? {
                path: requestedPath,
                subject: betterLabel(options.subject, source.subject),
                note: betterLabel(options.note, source.note),
                timeRules: Array.isArray(options.timeRules) ? options.timeRules : source.timeRules,
                sheet: hasSheet ? options.sheet : source.sheet,
                mapping: isObject(options.mapping) ? options.mapping : source.mapping,
                weekOneMonday: source.weekOneMonday,
              }
            : source,
        )
      } else {
        list = [
          {
            path: requestedPath,
            subject: String(options.subject ?? '').trim(),
            note: String(options.note ?? '').trim(),
            timeRules: Array.isArray(options.timeRules) ? options.timeRules : settings.workbook.timeRules,
            sheet: hasSheet ? options.sheet : undefined,
            mapping: isObject(options.mapping) ? options.mapping : settings.workbook.mapping,
            weekOneMonday: options.weekOneMonday || settings.workbook.weekOneMonday || undefined,
          },
          ...sources,
        ]
      }
    }
    if (list.length === 0) throw new Error('还没有设置 Excel 日程文件路径。')
    const results = []
    const failures = []
    for (const source of list) {
      try {
        const parsed = await readWorkbook({
          path: source.path,
          subject: source.subject,
          note: source.note,
          timeRules: source.timeRules,
          sheet: source.sheet,
          headerRow: options.headerRow,
          mapping: source.mapping,
          weekOneMonday: source.weekOneMonday,
          previewRows: options.previewRows,
        })
        results.push(parsed)
      } catch (error) {
        failures.push({ path: source.path, error: error?.message ?? String(error) })
      }
    }
    if (results.length === 0) {
      const first = failures[0]
      throw new Error(first ? `${first.path}: ${first.error}` : '没有可读取的 Excel 文件')
    }
    return { results, failures, requestedPath }
  }

  /**
   * What importing this parsed sheet would keep — counted over every row.
   *
   * The confirmation step has to be able to say what the button will do, and the
   * preview sample is twelve rows: "样例里命中 3 行" is a statement about the
   * sample, not about the import. This mirrors `importWorkbook`'s own filters
   * (owner match, the future-only horizon, undated rows) so the number shown
   * before the click is the number that lands afterwards.
   */
  function summarizeImportPlan(parsed) {
    const names = activeNames()
    const wantAll = names.length === 0
    const horizon = Number(settings.workbook.importHorizonDays)
    const horizonDays = Number.isFinite(horizon) && horizon > 0 ? Math.round(horizon) : 30
    const todayKey = localDayKey(new Date())
    const horizonKey = localDayKey(new Date(Date.now() + horizonDays * 86_400_000))
    const rows = Array.isArray(parsed.rows) ? parsed.rows : []
    let matched = 0
    let ready = 0
    let past = 0
    let beyond = 0
    let undated = 0
    let firstDate = ''
    let lastDate = ''
    for (const row of rows) {
      const haystacks = parsed.layout === 'records' ? [row.person, row.teacher, row.notes] : [row.person]
      if (!wantAll && !haystacks.some((value) => matchesOwner(value))) continue
      matched += 1
      if (row.date === '') {
        undated += 1
        if (settings.workbook.includeUndated) ready += 1
        continue
      }
      if (firstDate === '' || row.date < firstDate) firstDate = row.date
      if (lastDate === '' || row.date > lastDate) lastDate = row.date
      if (row.date < todayKey) past += 1
      else if (row.date > horizonKey) beyond += 1
      else ready += 1
    }
    return {
      rows: rows.length,
      matched,
      importable: ready,
      past,
      beyondHorizon: beyond,
      undated,
      firstDate,
      lastDate,
      horizonDays,
      ownerNames: names,
    }
  }

  /**
   * The parsed workbook a request named, else the first one read.
   *
   * The union read means `results` holds every roster, so taking `results[0]` as
   * "the file you asked about" would describe the wrong sheet: the panel previews
   * the file the user picked, and that file is not necessarily the first in the
   * configured order.
   */
  function pickRequested(results, requestedPath) {
    const wanted = String(requestedPath ?? '').toLowerCase()
    if (wanted === '') return results[0]
    const exact = results.find((entry) => String(entry.configuredPath ?? entry.file ?? '').toLowerCase() === wanted)
    if (exact !== undefined) return exact
    const name = wanted.split(/[\\/]/).pop()
    if (name === undefined || name === '') return results[0]
    const byName = results.find((entry) => String(entry.file ?? '').toLowerCase().endsWith(name))
    return byName ?? results[0]
  }

  async function importWorkbook(options = {}) {
    const { results, failures } = await readAllSources(options)

    const names = activeNames()
    const wantAll = options.filterByOwner === false || names.length === 0
    const horizon = Number(settings.workbook.importHorizonDays)
    const todayKey = localDayKey(new Date())
    const horizonKey = localDayKey(new Date(Date.now() + (Number.isFinite(horizon) ? horizon : 30) * 86_400_000))

    const kept = []
    const dropped = []
    let totalRows = 0
    const sources = []
    let index = 0
    for (const parsed of results) {
      const rows = parsed.rows ?? []
      totalRows += rows.length
      let matchedHere = 0
      for (const row of rows) {
        if (row.date === '') {
          if (settings.workbook.includeUndated) {
            row._source = parsed
            kept.push(row)
            matchedHere += 1
          } else {
            dropped.push({ row: row._row, reason: '没有日期', file: parsed.file })
          }
          continue
        }
        // A matrix roster has no name column: the cell IS the name, so the
        // owner check is the row's whole identity. A record table has explicit
        // owner-ish columns, checked in order of authority.
        const haystacks = parsed.layout === 'records'
          ? [row.person, row.teacher, row.notes]
          : [row.person]
        if (wantAll || haystacks.some((value) => matchesOwner(value))) {
          row._source = parsed
          kept.push(row)
          matchedHere += 1
        } else {
          dropped.push({ row: row._row, reason: `“${row.person || '(空)'}” 不匹配 ${names.join('/')}`, file: parsed.file })
        }
      }
      sources.push({
        file: parsed.file,
        configuredPath: parsed.configuredPath ?? parsed.file,
        sheet: parsed.sheet,
        sheets: parsed.sheets ?? [],
        layout: parsed.layout ?? 'records',
        headerRow: parsed.headerRow,
        mapping: parsed.mapping ?? {},
        unmapped: parsed.unmapped ?? [],
        headers: parsed.headers ?? [],
        rowCount: rows.length,
        matchedHere,
        warnings: parsed.warnings ?? [],
        chosenFrom: parsed.chosenFrom ?? null,
      })
      index += 1
    }
    void index

    const inHorizon = kept.filter((row) => row.date >= todayKey && row.date <= horizonKey)
    const pastCount = kept.length - inHorizon.length
    const chosen = options.includePast === true ? kept : inHorizon

    /**
     * A roster that could not be read this time keeps the rows it already had.
     *
     * The alternative — rebuild `events` from whatever happened to parse — turns a
     * temporarily locked file (Excel holding it open, a share offline for a
     * minute, a path that moved) into half the schedule vanishing, and nothing
     * brings it back until the next successful import. Rows already on record stay
     * until their own roster is read again, and the failure is reported separately.
     */
    const failedKeys = new Set()
    for (const failure of failures) {
      const resolved = String(resolveWorkbookPath(failure.path)).toLowerCase()
      if (resolved !== '') failedKeys.add(resolved)
      const name = resolved.split(/[\\/]/).pop()
      if (name !== undefined && name !== '') failedKeys.add(name)
    }
    const carried = failedKeys.size === 0
      ? []
      : runtime.events.filter((event) => {
          if (isManualEvent(event)) return false
          const origin = String(event.source?.path ?? '').toLowerCase()
          if (origin === '') return false
          const name = origin.split(/[\\/]/).pop()
          return failedKeys.has(origin) || (name !== undefined && failedKeys.has(name))
        })

    const previousIds = new Set(runtime.events.map((event) => event.id))
    const events = [...carried, ...chosen.map((row, position) => normaliseEvent(row, position))]
    const changed = events.filter((event) => !previousIds.has(event.id)).length
    // `removed` counts imported rows that are gone. A hand-added row was never in
    // the file, so the import saying it "removed" one would be a lie; a row carried
    // over from an unreadable file was not removed at all.
    const removed = runtime.events.filter((event) => !isManualEvent(event)).length - events.filter((event) => previousIds.has(event.id)).length

    const primary = pickRequested(sources, options.path)
    runtime.excel = {
      path: primary.file,
      configuredPath: primary.configuredPath,
      chosenFrom: primary.chosenFrom,
      sheet: primary.sheet,
      sheets: primary.sheets,
      headerRow: primary.headerRow,
      mapping: primary.mapping,
      unmapped: primary.unmapped,
      headers: primary.headers,
      layout: primary.layout,
      rowCount: totalRows,
      importedCount: events.length,
      manualCount: manualRows().length,
      matchedCount: kept.length,
      filteredCount: totalRows - kept.length,
      carriedCount: carried.length,
      pastCount: options.includePast === true ? 0 : pastCount,
      droppedRows: dropped.slice(0, 40),
      warnings: sources.flatMap((source) => source.warnings),
      sources,
      failures,
      importedAt: new Date().toISOString(),
      mtimeMs: null,
      size: null,
      lastError: failures.length > 0 ? failures.map((failure) => `${failure.path}: ${failure.error}`).join('；') : null,
      lastErrorAt: failures.length > 0 ? new Date().toISOString() : null,
    }
    runtime.events = events
    mergeManualEvents(events)
    const selfMade = selfMadeCounts()
    runtime.excel.manualCount = selfMade.typed
    runtime.excel.readCount = selfMade.read
    runtime.lastScanAt = new Date().toISOString()

    const summary = sources
      .map((source) => `${source.sheet}(${source.rowCount} 行/${source.matchedHere} 条)`)
      .join('、')
    const manual = selfMade.typed + selfMade.read
    pushFeed({
      kind: 'import',
      level: failures.length > 0 ? 'warn' : 'info',
      title: '日程已更新',
      body:
        `共 ${sources.length} 份表，抓取 ${events.length} 条与你相关的日程 · ${summary}` +
        (manual > 0 ? `；另有 ${manual} 条自己加 / 从资料里读出来的日程保留着` : '') +
        (carried.length > 0 ? `；${carried.length} 条来自这次没读到的表，先原样保留` : ''),
      meta: {
        kept: events.length,
        total: totalRows,
        changed,
        removed,
        files: sources.length,
        manual,
        carried: carried.length,
        requested: options.path ?? null,
      },
    })
    if (failures.length > 0) {
      pushFeed({
        kind: 'import',
        level: 'warn',
        title: '有文件没能读取',
        body: failures.map((failure) => `${failure.path}：${failure.error}`).join('\n').slice(0, 300),
      })
    }
    persistSoon()
    broadcast({ type: 'import', count: events.length, files: sources.length })
    return { ...runtime.excel, changed, removed }
  }

  function safeStat(path) {
    try {
      // eslint-disable-next-line no-undef -- node builtin resolved lazily
      return statSyncLazy(path)
    } catch {
      return null
    }
  }

  let statSyncImpl = null
  function statSyncLazy(path) {
    if (statSyncImpl === null) {
      statSyncImpl = require_('node:fs').statSync
    }
    return statSyncImpl(path)
  }

  // ---- uploaded material ---------------------------------------------------

  /**
   * Where a dropped file lands.
   *
   * Inside the state directory rather than the OS temp root, so it is cleaned up
   * with everything else the plugin owns and never collides with another
   * process's scratch file.
   */
  const UPLOAD_DIR = join(stateDir, 'uploads')
  /** Scratch directory for page images rendered out of a PDF or a Word file. */
  const READ_TMP_DIR = join(stateDir, 'read-tmp')

  /**
   * Persist a file the browser handed us.
   *
   * A drop or a file picker gives the page the bytes but never the path, so the
   * panel uploads them and the host reads from disk — the same code path as a
   * pasted path, which keeps one reader instead of two. Only the newest few are
   * kept: a saved schedule is a read-only snapshot that the next drop replaces.
   */
  function saveUpload(fileName, base64) {
    const raw = String(fileName ?? '').replace(/[\\/]/g, '_').trim() || 'dropped.xlsx'
    const extension = extensionOf(raw)
    if (!EXCEL_EXTENSIONS.has(extension) && !DOCUMENT_EXTENSIONS.has(extension)) {
      throw new Error(`这个格式还读不了：${raw}。可以拖 Excel、PDF、Word(.docx)、PPT(.pptx)、纯文本或图片。`)
    }
    if (typeof base64 !== 'string' || base64 === '') throw new Error('上传内容为空。')
    const buffer = Buffer.from(base64, 'base64')
    if (buffer.length === 0) throw new Error('上传内容无法解码。')
    mkdirSync(UPLOAD_DIR, { recursive: true })
    const target = join(UPLOAD_DIR, raw)
    writeFileSync(target, buffer)

    // Prune, newest first, so the directory cannot grow without bound.
    try {
      const stale = readdirSync(UPLOAD_DIR)
        .filter((entry) => entry !== raw)
        .map((entry) => ({ entry, at: statSync(join(UPLOAD_DIR, entry)).mtimeMs }))
        .sort((left, right) => right.at - left.at)
        .slice(9)
      for (const item of stale) unlinkSync(join(UPLOAD_DIR, item.entry))
    } catch {
      /* pruning is best-effort */
    }
    return target
  }

  // ---- material → schedule -------------------------------------------------
  //
  // A roster is not the only way a schedule reaches a person. A notice taped to
  // a door, a Word file from the class group, a screenshot of the duty table, or
  // a paragraph pasted out of a chat all say "you are on at 19:30" — none of them
  // has columns, and none of them is a spreadsheet. This pipeline reads those:
  // text is pulled out locally (PDF / Word / PPT / plain text), pictures and
  // scanned pages are handed to the model as images, and the model answers with
  // concrete events. When no model is available a deterministic scanner still
  // finds the lines that carry a date and a time, so the feature degrades the way
  // the workbook importer does — with a reason instead of a spinner.

  function extensionOf(path) {
    const match = /\.([A-Za-z0-9]+)$/.exec(String(path ?? ''))
    return match === null ? '' : '.' + match[1].toLowerCase()
  }

  /** Which reader owns this path. */
  function sourceKindOf(path) {
    const extension = extensionOf(path)
    if (EXCEL_EXTENSIONS.has(extension)) return 'excel'
    if (IMAGE_EXTENSIONS.has(extension)) return 'image'
    if (TEXT_EXTENSIONS.has(extension)) return 'text'
    if (extension === '.pdf') return 'pdf'
    if (extension === '.docx' || extension === '.doc') return 'docx'
    if (extension === '.pptx') return 'pptx'
    return 'unknown'
  }

  /**
   * A path the user typed, resolved the same way a workbook path is.
   *
   * Blank stays blank here: an empty document field means "nothing to read",
   * not "use whatever is on the Desktop". A bare file name is still searched for
   * in the places people keep files.
   */
  function resolveResourcePath(candidate) {
    const trimmed = typeof candidate === 'string' ? candidate.trim().replace(/^"|"$/g, '') : ''
    if (trimmed === '') return ''
    if (existsSync(trimmed)) return resolve(trimmed)
    if (isAbsolute(trimmed)) return resolve(trimmed)
    for (const base of workbookSearchBases()) {
      const joined = join(base, trimmed)
      if (existsSync(joined)) return resolve(joined)
    }
    return resolve(trimmed)
  }

  /** Decode a text file without assuming UTF-8, which a Chinese Windows box rarely uses. */
  function readTextFile(path) {
    const buffer = readFileSync(path)
    let text = buffer.toString('utf8')
    if (text.includes('\uFFFD')) {
      try {
        text = new TextDecoder('gb18030').decode(buffer)
      } catch {
        /* Node without full ICU: keep the replacement characters */
      }
    }
    text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const limit = 24_000
    return { text: text.slice(0, limit), truncated: text.length > limit }
  }

  /**
   * Drop scratch directories a crashed or interrupted read left behind.
   *
   * Each read names its own directory and deletes it on the way out, so anything
   * still here is a leftover. Pruning is bounded and best-effort: a scratch
   * directory that survives a crash is not worth failing a read over.
   */
  function pruneReadTmp() {
    try {
      if (!existsSync(READ_TMP_DIR)) return
      const entries = readdirSync(READ_TMP_DIR)
        .map((entry) => {
          try {
            return { entry, at: statSync(join(READ_TMP_DIR, entry)).mtimeMs }
          } catch {
            return { entry, at: 0 }
          }
        })
        .sort((left, right) => right.at - left.at)
      for (const [index, item] of entries.entries()) {
        if (index < 12 && Date.now() - item.at < 2 * 86_400_000) continue
        rmSync(join(READ_TMP_DIR, item.entry), { recursive: true, force: true })
      }
    } catch {
      /* best-effort */
    }
  }

  /**
   * Read one piece of material into text plus page images.
   *
   * @returns {Promise<{kind:string,file:string,path:string,text:string,chars:number,
   *   truncated:boolean,pages:Array<object>,images:string[],notes:string[],meta:object}>}
   */
  async function readResource(options = {}) {
    const pasted = typeof options.text === 'string' ? options.text.trim() : ''
    if (pasted !== '') {
      const limit = 24_000
      return {
        kind: 'text',
        file: typeof options.label === 'string' && options.label.trim() !== '' ? options.label.trim() : '粘贴的文字',
        path: '',
        text: pasted.slice(0, limit),
        chars: Math.min(pasted.length, limit),
        truncated: pasted.length > limit,
        pages: [],
        images: [],
        notes: [],
        meta: {},
        scratchDir: '',
        pasted: true,
      }
    }

    const resolved = resolveResourcePath(options.path)
    if (resolved === '') throw new Error('还没有指定要读的文件。')
    if (!existsSync(resolved)) throw new Error(`找不到文件：${resolved}`)
    let info = null
    try {
      info = statSyncLazy(resolved)
    } catch (error) {
      throw new Error(`无法读取文件：${error?.message ?? error}`)
    }
    if (!info.isFile()) throw new Error(`这不是一个文件：${resolved}`)

    const kind = sourceKindOf(resolved)
    if (kind === 'excel') throw new Error('Excel 排班表请走「读表」这条路：它按列映射解析，比 AI 猜得更准。')
    if (kind === 'unknown') {
      throw new Error(`这个格式还读不了（${extensionOf(resolved) || '无扩展名'}）：${basename(resolved)}。可以读 PDF / Word(.docx) / PPT(.pptx) / 纯文本 / 图片。`)
    }
    if (kind === 'text') {
      // A log file the size of a disk is not a schedule; refusing it up front
      // beats loading it into memory to find that out.
      if (info.size > 8_000_000) throw new Error(`这个文本文件太大了（${Math.round(info.size / 1_048_576)} MB）。先截取相关的那一段再读。`)
      const decoded = readTextFile(resolved)
      if (decoded.text.trim() === '') throw new Error('这个文件是空的。')
      return {
        kind,
        file: basename(resolved),
        path: resolved,
        text: decoded.text,
        chars: decoded.text.length,
        truncated: decoded.truncated,
        pages: [],
        images: [],
        notes: decoded.truncated ? ['文件很长，只读了前 24000 字。'] : [],
        meta: {},
        scratchDir: '',
      }
    }

    // One scratch directory per read: a second request must not delete the page
    // images the first one is still handing to the model.
    const outDir = join(READ_TMP_DIR, shortId('read', `${Date.now()}|${resolved}|${Math.random()}`))
    mkdirSync(outDir, { recursive: true })
    pruneReadTmp()
    let parsed = null
    try {
      const { stdout, stderr } = await runPython(
        READ_SCRIPT,
        [resolved, JSON.stringify({ outDir, maxChars: 24_000, maxImages: 4 })],
        90_000,
      )
      try {
        parsed = JSON.parse(stdout)
      } catch {
        throw new Error(`读取结果无法识别：${(stderr || stdout).slice(0, 400)}`)
      }
    } catch (error) {
      try {
        rmSync(outDir, { recursive: true, force: true })
      } catch {
        /* scratch cleanup is best-effort */
      }
      throw error
    }
    if (parsed?.ok !== true) {
      try {
        rmSync(outDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      throw new Error(String(parsed?.error ?? '这个文件读不了'))
    }
    const images = Array.isArray(parsed.images) ? parsed.images.filter((path) => typeof path === 'string' && existsSync(path)) : []
    return {
      kind: typeof parsed.kind === 'string' ? parsed.kind : kind,
      file: basename(resolved),
      path: resolved,
      text: typeof parsed.text === 'string' ? parsed.text : '',
      chars: Number(parsed.chars) || 0,
      truncated: parsed.truncated === true,
      pages: Array.isArray(parsed.pages) ? parsed.pages : [],
      images,
      notes: Array.isArray(parsed.notes) ? parsed.notes.filter((note) => typeof note === 'string') : [],
      meta: isObject(parsed.meta) ? parsed.meta : {},
      scratchDir: outDir,
    }
  }

  /** Save decoded images into the attachment store and keep the references. */
  async function saveImageAttachments(images) {
    if (images.length === 0) return []
    const attachments = ctx.get?.('attachments')
    if (!attachments || typeof attachments.saveImages !== 'function') {
      throw new Error('当前组合里没有图片附件服务，读不了图。')
    }
    const inputs = []
    for (const image of images) {
      const extension = extensionOf(image)
      const mediaType = IMAGE_MEDIA_TYPES[extension]
      if (mediaType === undefined) continue
      inputs.push({ data: readFileSync(image), mediaType, name: basename(image) })
    }
    if (inputs.length === 0) throw new Error('这些图片的格式读不了（只支持 PNG / JPEG / WebP / GIF）。')
    return attachments.saveImages(inputs)
  }

  const KIND_LABELS = {
    text: '文字',
    image: '图片',
    pdf: 'PDF',
    docx: 'Word 文档',
    pptx: 'PPT',
  }

  // ---- material → schedule: what the model is asked ------------------------

  /**
   * The extraction contract.
   *
   * Everything here is a rule the panel can check afterwards: dates are ISO,
   * times are 24-hour, and the only thing that makes a row "yours" is the name
   * filter. The prompt says so explicitly because a model's default instinct is
   * to summarise the document — a summary cannot be put on a timeline.
   */
  const EXTRACT_SYSTEM = [
    '你是日程抽取器。用户给你一份资料（一段文字、一个文档的节选，或几张图片），',
    '你只做一件事：把里面「这个人要在什么时候做什么」变成确定的日程条目。',
    '',
    '只输出 JSON，不要解释，不要 Markdown 代码块：',
    '{',
    '  "events": [',
    '    {',
    '      "date": "YYYY-MM-DD",',
    '      "start": "HH:MM",',
    '      "end": "HH:MM",',
    '      "title": "这件事叫什么（8–24 字，写具体动作，不要只抄文件名）",',
    '      "location": "地点，没有就留空",',
    '      "person": "这条是谁的事，资料里没写就留空",',
    '      "notes": "原文里需要记住的要求（带什么、找谁、注意什么），没有就留空",',
    '      "confidence": 0.8',
    '    }',
    '  ],',
    '  "summary": "一两句中文：这份资料是什么、你读到了什么",',
    '  "hints": ["给用户的提醒，最多 3 条"]',
    '}',
    '',
    '硬性要求：',
    '- 今天几号、星期几、关注的人是谁，都在「资料事实」里。相对日期（明天、下周三、本周五）要换算成具体日期。',
    '- 只保留「关注的人」要参加的条目；明确写着是别人值班/开会/交材料的，不要放进来。',
    '- 没有日期的条目不要输出；没有具体时间的条目 start / end 留空字符串（当作全天）。',
    '- 时间是 24 小时制。跨零点（例如 23:30–00:30）照实写，不要拆成两天。',
    '- 图片如果是表格，按行列关系读出「谁、哪天、几点、做什么」，不要只描述表格长什么样。',
    '- 不确定的日期宁可不输出，绝对不要编造资料里没有的日期、地点或人名。',
    '- 同一件事只输出一次。',
  ].join('\n')

  const EXTRACT_QUESTION = '把这份资料里属于我的日程读出来，按约定的 JSON 返回。'

  /** The facts the model is allowed to reason from, as compact JSON. */
  function buildExtractFacts(source, context) {
    const facts = {
      今天: context.todayKey,
      星期: context.weekday,
      现在: `${pad2(context.today.getHours())}:${pad2(context.today.getMinutes())}`,
      关注的人: context.ownerNames.length > 0 ? context.ownerNames : ['（没有设置姓名，资料里所有日程都收下）'],
      只保留未来天数: context.horizonDays,
      时区: context.timezone,
      资料: {
        文件名: source.file,
        类型: KIND_LABELS[source.kind] ?? source.kind,
        页数: source.pages.length > 0 ? source.pages.length : undefined,
        字数: source.chars > 0 ? source.chars : undefined,
        附带图片: source.images.length > 0 ? `${source.images.length} 张，内容在用户消息的图片里` : undefined,
        说明: source.notes.length > 0 ? source.notes : undefined,
      },
    }
    if (source.text !== '') {
      facts.资料文字 = source.truncated ? `${source.text}\n（资料太长，后文被截断）` : source.text
    } else if (source.images.length > 0) {
      facts.资料文字 = `这份资料没有可读的文字层，内容全在附带的 ${source.images.length} 张图片里。`
    }
    return JSON.stringify(facts, null, 1)
  }

  // ---- material → schedule: validation -------------------------------------

  function pad2(value) {
    return String(value).padStart(2, '0')
  }

  function isoDateOf(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  }

  /** A date the timeline can sort, or '' if it cannot be one. */
  function validIsoDate(value) {
    const text = String(value ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return ''
    const date = new Date(`${text}T00:00:00`)
    if (Number.isNaN(date.getTime())) return ''
    return isoDateOf(date) === text ? text : ''
  }

  /** `9:5` -> `09:05`, `19：30` -> `19:30`, anything unusable -> ''. */
  function normaliseClock(value) {
    const match = /^(\d{1,2})\s*[:：.]\s*(\d{1,2})$/.exec(String(value ?? '').trim())
    if (match === null) return ''
    const hour = Number(match[1])
    const minute = Number(match[2])
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) return ''
    return `${pad2(hour)}:${pad2(minute)}`
  }

  function clockOf(minutes) {
    const wrapped = ((minutes % 1440) + 1440) % 1440
    return `${pad2(Math.floor(wrapped / 60))}:${pad2(wrapped % 60)}`
  }

  /**
   * Keep the rows the timeline can actually use, and say why the rest went.
   *
   * The model is not trusted to have followed the rules, so this re-checks every
   * field and drops anything that would render as a broken row. Exclusions are
   * returned rather than swallowed: "it read 12 rows but only 4 are mine" is a
   * fact the confirmation step has to be able to state.
   */
  function sanitiseExtractedEvents(rawEvents, context) {
    const events = []
    const excluded = []
    const seen = new Set()
    for (const raw of Array.isArray(rawEvents) ? rawEvents.slice(0, 80) : []) {
      if (!isObject(raw)) continue
      const title = repairText(String(raw.title ?? raw.course ?? '').trim())
        .replace(/^["'「『]+|["'」』]+$/g, '')
        .slice(0, 80)
        .trim()
      if (title === '') {
        excluded.push({ title: '（没有标题）', reason: '没有标题' })
        continue
      }
      const date = validIsoDate(raw.date)
      if (date === '') {
        excluded.push({ title, reason: '没有可用的日期' })
        continue
      }
      const person = repairText(String(raw.person ?? '').trim()).slice(0, 40)
      if (person !== '' && context.ownerNames.length > 0 && !matchesOwner(person)) {
        excluded.push({ title, reason: `是 ${person} 的事，不是你的` })
        continue
      }
      const start = normaliseClock(raw.start)
      let end = normaliseClock(raw.end)
      if (start !== '' && end === '') end = addMinutes(start, 60)
      if (start === '') end = ''
      const key = `${date}|${start}|${title}`
      if (seen.has(key)) continue
      seen.add(key)
      events.push({
        date,
        start,
        end,
        title,
        location: repairText(String(raw.location ?? raw.place ?? '').trim()).slice(0, 80),
        notes: repairText(String(raw.notes ?? raw.note ?? '').trim()).slice(0, 300),
        person,
        confidence: Number.isFinite(Number(raw.confidence)) ? clamp(Number(raw.confidence), 0.05, 0.99) : 0.55,
      })
    }
    events.sort((left, right) => `${left.date}T${left.start}`.localeCompare(`${right.date}T${right.start}`))
    return { events, excluded }
  }

  /** How many of the extracted rows the import filters would keep. */
  function summarizeExtractPlan(events, context) {
    const horizonKey = isoDateOf(new Date(context.today.getTime() + context.horizonDays * 86_400_000))
    let importable = 0
    let past = 0
    let beyondHorizon = 0
    let undated = 0
    let firstDate = ''
    let lastDate = ''
    for (const event of events) {
      if (event.date === '') {
        undated += 1
        continue
      }
      if (firstDate === '' || event.date < firstDate) firstDate = event.date
      if (lastDate === '' || event.date > lastDate) lastDate = event.date
      if (event.date < context.todayKey) past += 1
      else if (event.date > horizonKey) beyondHorizon += 1
      else importable += 1
    }
    return {
      rows: events.length,
      matched: events.length,
      importable,
      past,
      beyondHorizon,
      undated,
      firstDate,
      lastDate,
      horizonDays: context.horizonDays,
      ownerNames: context.ownerNames,
    }
  }

  // ---- material → schedule: the local fallback -----------------------------
  //
  // No model, no problem: a notice that says "11月4日 07:00-07:30 早打卡值班"
  // states everything the timeline needs, and a scanner can read it without
  // understanding anything else. That is the floor this feature stands on — when
  // the model is off, out of quota, or looking at a picture it cannot see, the
  // panel still shows what the file plainly says and labels it 本机读的.

  const LOCAL_RELATIVE_DAYS = { 今天: 0, 今日: 0, 今晚: 0, 明天: 1, 明日: 1, 明晚: 1, 后天: 2, 大后天: 3 }
  const LOCAL_WEEKDAYS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 0 }
  const LOCAL_TIME_PREFIX = '上午|下午|晚上|傍晚|中午|早上|凌晨|早|晚'

  function localHour(prefix, hour) {
    const text = String(prefix ?? '')
    if (text === '下午' || text === '晚上' || text === '晚' || text === '傍晚') return hour < 12 ? hour + 12 : hour
    if (text === '中午') return hour < 11 ? hour + 12 : hour
    if (text === '凌晨') return hour === 12 ? 0 : hour
    return hour
  }

  /** The first date in one line, plus the exact substring that stated it. */
  function findLocalDate(text, today) {
    let match = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/.exec(text)
    if (match !== null) {
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
      if (!Number.isNaN(date.getTime()) && date.getMonth() === Number(match[2]) - 1) return { date, token: match[0] }
    }
    match = /(?<![\d:])(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(text)
    if (match !== null) {
      const month = Number(match[1])
      const day = Number(match[2])
      const date = new Date(today.getFullYear(), month - 1, day)
      if (!Number.isNaN(date.getTime()) && date.getMonth() === month - 1) {
        // A date far in the past is next year's: "12月3日" read in January.
        if (date.getTime() < today.getTime() - 180 * 86_400_000) date.setFullYear(date.getFullYear() + 1)
        return { date, token: match[0] }
      }
    }
    // 11-04 / 11/4, but never the "00-07" inside "07:00-07:30".
    match = /(?<![\d:])(\d{1,2})\s*[-/]\s*(\d{1,2})(?![\d:])/.exec(text)
    if (match !== null) {
      const month = Number(match[1])
      const day = Number(match[2])
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        const date = new Date(today.getFullYear(), month - 1, day)
        if (!Number.isNaN(date.getTime()) && date.getMonth() === month - 1) {
          if (date.getTime() < today.getTime() - 180 * 86_400_000) date.setFullYear(date.getFullYear() + 1)
          return { date, token: match[0] }
        }
      }
    }
    match = /(大后天|后天|明天|明日|今天|今日|今晚|明晚)/.exec(text)
    if (match !== null) {
      const offset = LOCAL_RELATIVE_DAYS[match[1]] ?? 0
      return { date: new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset), token: match[0] }
    }
    match = /(下)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/.exec(text)
    if (match !== null) {
      const target = LOCAL_WEEKDAYS[match[2]]
      if (target !== undefined) {
        let delta = (target - today.getDay() + 7) % 7
        if (match[1] === '下') delta = delta === 0 ? 7 : delta + 7
        return { date: new Date(today.getFullYear(), today.getMonth(), today.getDate() + delta), token: match[0] }
      }
    }
    return null
  }

  /** The first clock range (or single clock time) in one line. */
  function findLocalTime(text) {
    const range = new RegExp(
      `(${LOCAL_TIME_PREFIX})?\\s*(\\d{1,2})\\s*[:：点时]\\s*(\\d{1,2})?\\s*分?\\s*(?:[-–—~～]|至|到)\\s*` +
        `(${LOCAL_TIME_PREFIX})?\\s*(\\d{1,2})\\s*[:：点时]\\s*(\\d{1,2})?\\s*分?`,
    ).exec(text)
    if (range !== null) {
      const startHour = localHour(range[1], Number(range[2]))
      const startMinute = Number(range[3] || 0)
      const endHour = localHour(range[4], Number(range[5]))
      const endMinute = Number(range[6] || 0)
      if (startHour <= 23 && startMinute <= 59 && endHour <= 23 && endMinute <= 59) {
        let start = startHour * 60 + startMinute
        let end = endHour * 60 + endMinute
        // "下午 3 点到 5 点": the second half lost its 下午 but still means 17:00.
        if (end <= start && endHour < 12 && end + 12 * 60 > start) end += 12 * 60
        if (end > start) return { start: clockOf(start), end: clockOf(end), token: range[0], ranged: true }
      }
    }
    const single = new RegExp(`(${LOCAL_TIME_PREFIX})?\\s*(\\d{1,2})\\s*[:：点时]\\s*(\\d{1,2})?\\s*分?`).exec(text)
    if (single !== null) {
      const hour = localHour(single[1], Number(single[2]))
      const minute = Number(single[3] || 0)
      if (hour <= 23 && minute <= 59) {
        const start = clockOf(hour * 60 + minute)
        return { start, end: addMinutes(start, 60), token: single[0], ranged: false }
      }
    }
    return null
  }

  const LOCAL_ACTION_WORDS = /(交|提交|报名|开会|会议|值班|点名|考试|上课|答辩|面试|截止|打卡|培训|讲座|活动|签到|交付|出差|体检|缴费|复习|晚自习|早自习)/

  function extractFromLine(line, context) {
    const text = String(line ?? '').trim()
    if (text.length < 4) return null
    const dateHit = findLocalDate(text, context.today)
    if (dateHit === null) return null
    let rest = text.replace(dateHit.token, ' ')
    // The weekday is already encoded in the date; "（周三）" in the title is noise.
    rest = rest.replace(/[（(]\s*(?:周|星期|礼拜)[一二三四五六日天]\s*[)）]/g, ' ')
    const timeHit = findLocalTime(rest)
    if (timeHit !== null) rest = rest.replace(timeHit.token, ' ')
    // A date with no clock still schedules something, but only when the line
    // says what to do — otherwise every dated sentence in a memo becomes an event.
    if (timeHit === null && !LOCAL_ACTION_WORDS.test(text)) return null
    const title = rest
      .replace(/^[\s·•●▪◦◆◇\-–—*#>、,，.。:：;；|]+/, '')
      .replace(/^(?:通知|备注|注意|安排|事项|内容)\s*[:：]\s*/, '')
      .replace(/^[（(【[]?\s*\d{1,2}\s*[.、)）\]】]\s*/, '')
      .replace(/\s+/g, ' ')
      .replace(/[，,。.;；:：、\s]+$/, '')
      .trim()
      .slice(0, 60)
    if (title.length < 2) return null
    return {
      date: isoDateOf(dateHit.date),
      start: timeHit === null ? '' : timeHit.start,
      end: timeHit === null ? '' : timeHit.end,
      title,
      location: '',
      notes: '',
      person: '',
      confidence: 0.4,
    }
  }

  function extractLocally(text, context) {
    const events = []
    const seen = new Set()
    // A notice often packs several items into one paragraph, so units are
    // sentences as well as lines.
    const units = String(text).split(/\n+|\r+|(?<=[。；;])/u)
    for (const unit of units) {
      const event = extractFromLine(unit, context)
      if (event === null) continue
      const key = `${event.date}|${event.start}|${event.title}`
      if (seen.has(key)) continue
      seen.add(key)
      events.push(event)
    }
    events.sort((left, right) => `${left.date}T${left.start}`.localeCompare(`${right.date}T${right.start}`))
    return events
  }

  // ---- material → schedule: one read ---------------------------------------

  function extractContext() {
    const now = new Date()
    const horizon = Number(settings.workbook.importHorizonDays)
    return {
      today: now,
      todayKey: localDayKey(now),
      weekday: WEEKDAY_LABELS[now.getDay()] ?? '',
      horizonDays: Number.isFinite(horizon) && horizon > 0 ? Math.round(horizon) : 30,
      ownerNames: activeNames(),
      timezone: settings.profile?.timezone || '本机时区',
    }
  }

  function localSummary(events, source) {
    if (events.length === 0) {
      return source.kind === 'image'
        ? '这张图里没读出日程。'
        : '本机规则没有在这份资料里找到「日期 + 时间」都明确的句子。'
    }
    return `本机按「日期 + 时间」找出 ${events.length} 条候选日程。`
  }

  function localHints(source) {
    const hints = []
    if (source.kind === 'image') hints.push('图片需要能看图的模型，本机只能读文字文件。')
    else hints.push('本机规则只看句子里的日期和时间；打开模型能读懂「下周三之前」这类说法。')
    if (source.truncated) hints.push('资料很长，只读了前面一部分。')
    return hints
  }

  /**
   * Read one piece of material and propose events for it.
   *
   * Returns the proposal; it does not touch the schedule. Committing is a
   * separate, explicit action — the same rule the workbook importer follows.
   *
   * Page images are rendered into a per-read scratch directory, handed to the
   * model, and deleted here whatever the outcome: they are an input to one read,
   * not state.
   */
  async function extractSchedule(options = {}) {
    const source = await readResource(options)
    try {
      return await proposeFromSource(source, options)
    } finally {
      if (source.scratchDir) {
        try {
          rmSync(source.scratchDir, { recursive: true, force: true })
        } catch {
          /* scratch cleanup is best-effort */
        }
      }
    }
  }

  async function proposeFromSource(source, options = {}) {
    const startedAt = Date.now()
    const context = extractContext()
    const local = source.text !== '' ? extractLocally(source.text, context) : []
    const status = assistantStatus()

    if (status.mode !== 'model' || options.useModel === false) {
      if (source.kind === 'image') {
        const why = status.mode === 'model' ? '这次没有让模型参与' : `模型用不了：${status.detail}`
        throw new Error(`读图片需要模型看图，但现在${why}。可以在设置里打开模型，或者把图片里的文字复制成一段文字再读。`)
      }
      return {
        source: publicSource(source),
        analysis: {
          mode: 'local',
          reason: status.mode === 'model' ? 'disabled' : status.reason,
          detail: status.detail,
          events: local,
          excluded: [],
          summary: localSummary(local, source),
          hints: localHints(source),
          confidence: local.length > 0 ? 0.42 : 0.1,
          modelNote: `本机读的（${status.mode === 'model' ? '这次没有让模型参与' : status.detail}）`,
        },
        plan: summarizeExtractPlan(local, context),
        elapsedMs: Date.now() - startedAt,
      }
    }

    const model = await askModel(EXTRACT_QUESTION, null, [], {
      system: `${EXTRACT_SYSTEM}\n\n资料事实（JSON）：\n${buildExtractFacts(source, context)}`,
      maxTokens: 1800,
      images: source.images.map((path) => ({ path, name: basename(path) })),
    })

    if (!model.ok) {
      ctx.logger?.warn?.(`[orbit-time] document extraction fell back to local rules (${model.reason}): ${model.detail}`)
      return {
        source: publicSource(source),
        analysis: {
          mode: 'local',
          reason: model.reason,
          detail: model.detail,
          events: local,
          excluded: [],
          summary: localSummary(local, source),
          hints: localHints(source),
          confidence: local.length > 0 ? 0.42 : 0.1,
          modelNote: `本机读的（${model.detail}）`,
        },
        plan: summarizeExtractPlan(local, context),
        elapsedMs: Date.now() - startedAt,
      }
    }

    const proposal = extractJsonObject(model.text)
    if (proposal === null) {
      return {
        source: publicSource(source),
        analysis: {
          mode: 'local',
          reason: 'unparsable',
          detail: '模型没有按要求返回 JSON',
          events: local,
          excluded: [],
          summary: localSummary(local, source),
          hints: localHints(source),
          confidence: local.length > 0 ? 0.42 : 0.1,
          modelText: String(model.text).slice(0, 600),
          modelNote: '本机读的（模型没有按要求返回 JSON）',
        },
        plan: summarizeExtractPlan(local, context),
        elapsedMs: Date.now() - startedAt,
      }
    }

    const { events, excluded } = sanitiseExtractedEvents(proposal.events, context)
    /*
     * "The model says there is nothing here" and "the file plainly says there is"
     * cannot both be right. When they disagree, the deterministic reading wins and
     * is labelled as such — a silent empty result would look like the feature
     * failed, and asking the user to trust a model that missed an explicit
     * "11月4日 07:00" is worse than admitting which half produced the rows.
     */
    if (events.length === 0 && local.length > 0) {
      return {
        source: publicSource(source),
        analysis: {
          mode: 'local',
          reason: 'model-empty',
          detail: '模型没从这份资料里读出日程',
          events: local,
          excluded,
          summary: `模型没读出日程，本机按日期时间找到 ${local.length} 条。`,
          hints: ['看一下下面这些是不是真的日程，再决定加不加。'],
          confidence: 0.35,
          modelNote: '本机读的（模型返回了空结果）',
        },
        plan: summarizeExtractPlan(local, context),
        elapsedMs: Date.now() - startedAt,
      }
    }

    const summary = typeof proposal.summary === 'string' && proposal.summary.trim() !== ''
      ? repairText(proposal.summary.trim()).slice(0, 300)
      : events.length > 0
        ? `从这份资料里读出 ${events.length} 条日程。`
        : '这份资料里没有找到明确的日程。'
    const hints = (Array.isArray(proposal.hints) ? proposal.hints : [])
      .filter((hint) => typeof hint === 'string' && hint.trim() !== '')
      .map((hint) => repairText(hint.trim()).slice(0, 120))
      .slice(0, 3)

    return {
      source: publicSource(source),
      analysis: {
        mode: 'model',
        model: { provider: model.provider, model: model.model },
        events,
        excluded,
        summary,
        hints,
        confidence: events.length > 0 ? 0.72 : 0.3,
        modelNote: 'AI 读的',
      },
      plan: summarizeExtractPlan(events, context),
      elapsedMs: Date.now() - startedAt,
    }
  }

  /** What the panel is told about the file, without leaking scratch paths. */
  function publicSource(source) {
    return {
      kind: source.kind,
      type: KIND_LABELS[source.kind] ?? source.kind,
      file: source.file,
      path: source.path,
      chars: source.chars,
      truncated: source.truncated,
      pages: source.pages.length,
      scannedPages: source.pages.filter((page) => page.scanned === true).length,
      imageCount: source.images.length,
      notes: source.notes,
      pasted: source.pasted === true,
    }
  }

  // ---- material → schedule: committing -------------------------------------

  function buildExtractedEvent(raw, source) {
    const date = validIsoDate(raw.date)
    const title = repairText(String(raw.title ?? '').trim())
      .replace(/^["'「『]+|["'」』]+$/g, '')
      .slice(0, 80)
      .trim()
    if (date === '' || title === '') return null
    const start = normaliseClock(raw.start)
    let end = normaliseClock(raw.end)
    if (start !== '' && end === '') end = addMinutes(start, 60)
    if (start === '') end = ''
    // Deterministic per (file, when, what): reading the same notice twice must
    // not put the same meeting on the timeline twice.
    const id = shortId('ai', `${source.file}|${date}|${start}|${title}`)
    return {
      id,
      date,
      start,
      end,
      title,
      course: '',
      classroom: '',
      teacher: '',
      location: repairText(String(raw.location ?? '').trim()).slice(0, 80),
      // The origin is carried by `source.sheet` (and rendered from it); putting
      // it in `category` as well printed the same "AI 读出" tag twice.
      category: '',
      status: '',
      priority: '',
      notes: repairText(String(raw.notes ?? '').trim()).slice(0, 400),
      link: '',
      contact: '',
      owner: repairText(String(raw.person ?? '').trim()).slice(0, 40),
      matchedBy: '',
      weekday: '',
      extras: {
        readFrom: source.file,
        readFromPath: source.path,
        confidence: Number.isFinite(Number(raw.confidence)) ? clamp(Number(raw.confidence), 0, 1) : null,
      },
      source: { sheet: AI_SHEET, path: source.path, row: null },
      warnings: [],
    }
  }

  /**
   * Put the accepted rows on the schedule.
   *
   * They join `manualEvents`, the list imports never rebuild — a document has no
   * file watcher re-reading it, so "read once, kept until deleted" is the only
   * behaviour that does not lose the row on the next Excel scan. The marker is
   * `AI_SHEET`, which keeps them distinguishable from typed rows.
   */
  function commitExtraction(body) {
    const source = {
      file: String(body.file ?? '').trim() || '资料',
      path: typeof body.path === 'string' ? body.path : '',
    }
    const incoming = Array.isArray(body.events) ? body.events : []
    const known = new Set(runtime.events.map((event) => event.id))
    const committed = []
    const skipped = []
    for (const raw of incoming.slice(0, 60)) {
      if (!isObject(raw)) continue
      const event = buildExtractedEvent(raw, source)
      if (event === null) {
        skipped.push({ title: String(raw.title ?? ''), reason: '日期或标题不完整' })
        continue
      }
      if (known.has(event.id)) {
        skipped.push({ title: event.title, reason: '已经在日程里了' })
        continue
      }
      known.add(event.id)
      committed.push(event)
    }
    if (committed.length === 0) return { added: 0, skipped, events: [], firstDate: '' }

    runtime.events = [...runtime.events, ...committed]
    runtime.manualEvents = [...manualRows(), ...committed]
    runtime.lastExtraction = {
      file: source.file,
      path: source.path,
      at: new Date().toISOString(),
      added: committed.length,
    }
    const first = committed.slice().sort((left, right) => `${left.date}T${left.start}`.localeCompare(`${right.date}T${right.start}`))[0]
    pushFeed({
      kind: 'import',
      level: 'success',
      title: `🤖 从《${source.file}》读出 ${committed.length} 条日程`,
      body: committed
        .slice(0, 4)
        .map((event) => `${event.date} ${event.start || '全天'} ${event.title}`)
        .join('\n')
        .slice(0, 400),
      meta: { read: committed.length, skipped: skipped.length, file: source.file },
    })
    persistSoon()
    broadcast({ type: 'import', count: runtime.events.length, files: 0 })
    return { added: committed.length, skipped, events: committed, firstDate: first?.date ?? '' }
  }

  // ---- pomodoro timer ------------------------------------------------------

  function createTimerState(source) {
    return {
      phase: 'idle', // idle | focus | short | long
      running: false,
      startedAt: null,
      endsAt: null,
      remainingMs: 0,
      round: 1,
      completedToday: 0,
      dayKey: localDayKey(new Date()),
      subject: '',
      history: [],
      config: { ...source.pomodoro },
    }
  }

  function phaseMinutes(phase) {
    const source = timer.config ?? settings.pomodoro
    if (phase === 'focus') return Number(source.focusMinutes) || 25
    if (phase === 'short') return Number(source.shortBreakMinutes) || 5
    if (phase === 'long') return Number(source.longBreakMinutes) || 15
    return 0
  }

  function timerTick() {
    const now = Date.now()
    const todayKey = localDayKey(new Date(now))
    if (timer.dayKey !== todayKey) {
      timer.dayKey = todayKey
      timer.completedToday = 0
    }
    if (!timer.running) return
    timer.remainingMs = Math.max(0, (timer.endsAt ?? now) - now)
    if (timer.remainingMs > 0) return

    const finished = timer.phase
    timer.running = false
    timer.remainingMs = 0
    timer.endsAt = null
    timer.history.unshift({ phase: finished, endedAt: new Date(now).toISOString(), subject: timer.subject })
    timer.history = timer.history.slice(0, 20)

    if (finished === 'focus') {
      timer.completedToday += 1
      pushFeed({
        kind: 'focus',
        level: 'success',
        title: '🍅 一个番茄完成',
        body: `今天第 ${timer.completedToday} 个专注完成${timer.subject ? `（${timer.subject}）` : ''}。休息一下，眼睛也需要间隙。`,
      })
      void notify('专注结束', `第 ${timer.completedToday} 个番茄完成，去休息一下。`)
      const rounds = Number(timer.config.roundsBeforeLongBreak) || 4
      const nextPhase = timer.completedToday % rounds === 0 ? 'long' : 'short'
      if (timer.config.autoStartBreak) startPhase(nextPhase, { auto: true })
    } else {
      pushFeed({
        kind: 'break',
        level: 'info',
        title: '☕ 休息结束',
        body: timer.config.autoStartFocus ? '自动进入下一个专注。' : '准备好后开始下一个专注吧。',
      })
      void notify('休息结束', '回到轨道上，开始下一个专注。')
      if (timer.config.autoStartFocus) startPhase('focus', { auto: true })
    }
    persistSoon()
  }

  function startPhase(phase, options = {}) {
    const minutes = phaseMinutes(phase)
    timer.phase = phase
    timer.running = true
    timer.startedAt = Date.now()
    timer.endsAt = timer.startedAt + minutes * 60_000
    timer.remainingMs = minutes * 60_000
    if (options.subject !== undefined) timer.subject = String(options.subject ?? '')
    if (options.auto !== true) {
      pushFeed({
        kind: 'timer',
        level: 'info',
        title: phase === 'focus' ? '▶︎ 开始专注' : '☕ 开始休息',
        body: `${minutes} 分钟${timer.subject && phase === 'focus' ? ` · ${timer.subject}` : ''}`,
      })
    }
    persistSoon()
    return timer
  }

  // ---- reminder engine -----------------------------------------------------

  const OFFSET_LABELS = new Map([
    [0, '现在开始'],
    [1, '1 分钟后开始'],
    [5, '5 分钟后开始'],
    [10, '10 分钟后开始'],
    [15, '15 分钟后开始'],
    [30, '30 分钟后开始'],
    [60, '1 小时后开始'],
    [120, '2 小时后开始'],
    [1440, '明天'],
  ])

  /**
   * How late a rung may still be delivered.
   *
   * Stored start times have minute precision while the clock ticks in seconds,
   * so a "1 minute before" rung is due anywhere inside a 60-second window and a
   * naive `minutesLeft <= offset` test drops it whenever the scan lands at
   * 1.05 minutes. This grace window also covers a host that was busy or asleep:
   * a rung that came due while nothing was listening is still worth delivering
   * shortly after, and anything older than the window is silently skipped so a
   * restart does not replay the whole morning.
   */
  const RUNG_GRACE_MINUTES = 5

  function inQuietHours(date) {
    if (settings.reminders.respectQuietHours !== true) return false
    const from = toMinutes(settings.reminders.quietHours?.from)
    const to = toMinutes(settings.reminders.quietHours?.to)
    if (from === null || to === null) return false
    const now = localMinutes(date)
    if (from === to) return false
    return from < to ? now >= from && now < to : now >= from || now < to
  }

  function reminderScan(now) {
    if (settings.reminders.enabled !== true) return
    const offsets = (settings.reminders.offsetsMinutes ?? [30, 10, 5, 0])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .sort((left, right) => right - left)
    if (offsets.length === 0) return
    const nowMs = now.getTime()

    for (const event of runtime.events) {
      const override = overrideOf(event)
      if (override.done === true) continue
      const startMs = startMsOf(event)
      if (startMs === null) continue
      const minutesLeft = (startMs - nowMs) / 60_000
      if (minutesLeft < -RUNG_GRACE_MINUTES || minutesLeft > 1500) continue
      if (typeof override.snoozedUntil === 'string') {
        const snoozeMs = Date.parse(override.snoozedUntil)
        if (!Number.isNaN(snoozeMs)) {
          if (nowMs < snoozeMs) continue
          if (nowMs - snoozeMs < 60_000) {
            delete runtime.overrides[event.id].snoozedUntil
            fired.set(`${event.id}:snooze`, now.toISOString())
            fireReminder(event, -1, now, { snoozed: true })
            continue
          }
        }
      }
      for (const offset of offsets) {
        // Each rung owns the window [offset - grace, offset + 0.5]: the extra
        // half minute absorbs the minute-granularity rounding of stored times.
        const elapsed = offset - minutesLeft
        if (elapsed < -0.5 || elapsed > RUNG_GRACE_MINUTES) continue
        // "Starting now" is absolute, so it must not jump the gun just because
        // a start time rounded down to the minute the host is already inside.
        if (offset === 0 && minutesLeft > 0.5) continue
        const key = `${event.id}:${offset}`
        if (fired.has(key)) continue
        fired.set(key, now.toISOString())
        fireReminder(event, offset, now, { late: elapsed > 1 })
      }
    }
    if (fired.size > 4000) {
      const cutoff = nowMs - 3 * 86_400_000
      for (const [key, at] of fired) {
        if (Date.parse(at) < cutoff) fired.delete(key)
      }
    }
  }

  function fireReminder(event, offset, now, extra = {}) {
    const late = extra.late === true
    const label =
      extra.snoozed === true
        ? '稍后提醒'
        : offset < 0 || late
          ? '现在开始'
          : (OFFSET_LABELS.get(offset) ?? `${offset} 分钟后开始`)
    const timeText = event.start === '' ? '全天' : event.start
    const where = event.location || event.classroom || event.teacher || ''
    const body = [timeText, where, event.course].filter((value) => value && value !== '').join(' · ')
    const urgency = offset <= 5 || offset < 0 ? 'urgent' : offset <= 30 ? 'soon' : 'info'
    const title = offset <= 5 || offset < 0 ? `⏰ ${label}` : `🔔 ${label}`

    pushFeed({
      kind: 'reminder',
      level: urgency === 'urgent' ? 'urgent' : 'info',
      title: `${title} · ${event.title}`,
      body,
      eventId: event.id,
      offsetMinutes: offset,
      late,
      actions: ['snooze', 'done', 'open'],
      meta: { start: event.start, end: event.end, date: event.date },
    })
    void notify(
      `${title} · ${event.title}`,
      `${body || '即将开始'}${offset > 0 && !late ? `（还有 ${formatDuration(offset * 60_000)}）` : ''}`,
      urgency === 'urgent',
    )
    broadcast({ type: 'reminder', eventId: event.id, offsetMinutes: offset, title: event.title })
  }

  const TOAST_SCRIPT = [
    "$ErrorActionPreference='Stop'",
    '$payload = [Console]::In.ReadToEnd()',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] > $null',
    "$doc = New-Object Windows.Data.Xml.Dom.XmlDocument",
    '$doc.LoadXml($payload)',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('DeepSeek Harness').Show($toast)",
  ].join('; ')

  function xmlEscape(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  }

  let lastToastAt = 0
  async function notify(title, body, urgent = false) {
    if (settings.reminders.osToast !== true) return
    const now = Date.now()
    if (now - lastToastAt < 700) return
    lastToastAt = now
    if (process.platform !== 'win32') {
      ctx.logger?.info?.('[orbit-time] %s — %s', title, body)
      return
    }
    const xml =
      '<toast duration="' +
      (urgent ? 'long' : 'short') +
      '"><visual><binding template="ToastGeneric"><text>' +
      xmlEscape(title) +
      '</text><text>' +
      xmlEscape(body) +
      '</text></binding></visual><audio src="' +
      (settings.reminders.sound === false ? 'ms-winsoundevent:Notification.Silent' : 'ms-winsoundevent:Notification.Default') +
      '"/></toast>'
    try {
      const child = spawnProcess(ctx, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', TOAST_SCRIPT], {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe'],
      })
      child.stdin?.end(Buffer.from(xml, 'utf8'))
      child.on('error', () => {})
      child.stderr?.on('data', () => {})
    } catch (error) {
      ctx.logger?.warn?.('[orbit-time] toast failed: %s', error?.message ?? error)
    }
  }

  // ---- HTTP surface --------------------------------------------------------

  function sendJson(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload ?? null), 'utf8')
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
    const buffer = Buffer.from(body, 'utf8')
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': String(buffer.length),
      'cache-control': 'no-store',
    })
    res.end(buffer)
  }

  function readBody(req, limit = 2 * 1024 * 1024) {
    return new Promise((resolvePromise, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (text.trim() === '') {
          resolvePromise({})
          return
        }
        try {
          resolvePromise(JSON.parse(text))
        } catch (error) {
          reject(new Error(`请求体不是合法 JSON: ${error.message}`))
        }
      })
      req.on('error', reject)
    })
  }

  /**
   * Requests per path, so "the button does nothing" can be answered with
   * evidence: a path that never increments means the click never left the page
   * (a pointer-events or stacking problem), while one that increments means the
   * request arrived and the fault is downstream.
   */
  const requestCounts = new Map()
  /** UI-side diagnostic reports, keyed by kind. */
  const uiReports = new Map()

  function route(path, handler) {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}${path}`,
      handler: async (req, res) => {
        requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1)
        try {
          await handler(req, res)
        } catch (error) {
          const message = error?.message ?? String(error)
          ctx.logger?.warn?.('[orbit-time] %s failed: %s', path, message)
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: message })
          else res.end()
        }
      },
    })
    ctx.effect(() => dispose, `orbit-time: route ${path}`)
  }

  // ---- derived payloads ----------------------------------------------------

  function statsFor(dayKey) {
    const dayEvents = eventsForDay(dayKey)
    const now = new Date()
    const isToday = dayKey === localDayKey(now)
    let totalMinutes = 0
    let doneMinutes = 0
    let remainingMinutes = 0
    for (const event of dayEvents) {
      const start = toMinutes(overrideOf(event).start ?? event.start)
      const end = toMinutes(overrideOf(event).end ?? event.end) ?? (start === null ? null : start + 60)
      if (start === null || end === null) continue
      const span = end > start ? end - start : end + 1440 - start
      totalMinutes += span
      if (isToday) {
        const nowMin = localMinutes(now)
        if (nowMin >= end) doneMinutes += span
        else if (nowMin > start) doneMinutes += nowMin - start
        if (nowMin < end) remainingMinutes += end - Math.max(nowMin, start)
      }
    }
    const focusGoal = Number(timer.config?.dailyGoalRounds) || 8
    return {
      dayKey,
      label: WEEKDAY_LABELS[new Date(`${dayKey}T00:00:00`).getDay()] ?? '',
      eventCount: dayEvents.length,
      totalMinutes,
      doneMinutes,
      remainingMinutes,
      freeSlots: isToday ? freeSlots(now) : [],
      completedRounds: timer.dayKey === dayKey ? timer.completedToday : 0,
      focusGoalRounds: focusGoal,
      focusMinutesToday: (timer.dayKey === dayKey ? timer.completedToday : 0) * (Number(timer.config?.focusMinutes) || 25),
    }
  }

  function buildSnapshot(dayKeyInput, monthKeyInput) {
    const now = new Date()
    const dayKey = typeof dayKeyInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dayKeyInput) ? dayKeyInput : localDayKey(now)
    const dayEvents = eventsForDay(dayKey).map((event) => viewEvent(event, now))
    const undated = runtime.events
      .filter((event) => event.date === '')
      .map((event) => viewEvent(event, now))
    return {
      ok: true,
      now: now.toISOString(),
      serverTime: {
        iso: now.toISOString(),
        dayKey: localDayKey(now),
        minutes: localMinutes(now),
        label: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      },
      settings: {
        profile: settings.profile,
        workbook: { ...settings.workbook, path: settings.workbook.path },
        reminders: settings.reminders,
        pomodoro: settings.pomodoro,
        ui: settings.ui,
      },
      ownerNames: activeNames(),
      excel: runtime.excel,
      /**
       * How many rows did not come from a spreadsheet, split by origin: rows the
       * user typed, and rows the model read out of a document. They live in the
       * same bucket and survive imports the same way, but "自己加的 3 条" should
       * not quietly include three things Orbyt read off a photo.
       */
      manualCount: selfMadeCounts().typed,
      readCount: selfMadeCounts().read,
      day: { dayKey, events: dayEvents, stats: statsFor(dayKey), undated },
      nextEvent: nextEventOf(now),
      upcoming: upcomingEvents(now, 8),
      week: buildWeek(now),
      month: buildMonth(now, monthKeyInput, dayKey),
      timer: { ...timer },
      feed: runtime.feed.slice(0, MAX_FEED),
      generatedAt: now.toISOString(),
    }
  }

  /**
   * One calendar day, summarised for the strip and for the month grid.
   *
   * `count`/`titles` come from `eventsForDay`, so a day the user has marked done
   * reads as *empty* here exactly as it does on the timeline — the calendar is a
   * view of the same schedule, not a second opinion about it. `hasEvents` is the
   * exception, and deliberately so: the grid exists to answer "is anything on the
   * 15th", and a day whose only schedule was ticked off is not the same answer as
   * an empty one. The grid draws a marker from `hasEvents` and the month summary
   * counts with it, so a dotted day can never be missing from the totals.
   *
   * The month grid carries only this summary: 42 days of full event records is
   * ~12 kB per response on a 4-second poll, and the panel only ever shows the
   * items of the one day that is open (see `itemsForDay`).
   */
  function daySummary(date, todayKey) {
    const dayKey = localDayKey(date)
    const list = eventsForDay(dayKey)
    const scheduled = runtime.events.some((event) => event.date === dayKey)
    return {
      dayKey,
      label: WEEKDAY_LABELS[date.getDay()] ?? '',
      dayOfMonth: date.getDate(),
      isToday: dayKey === todayKey,
      count: list.length,
      hasEvents: scheduled,
      firstStart: list.length > 0 ? (overrideOf(list[0]).start ?? list[0].start) : '',
      titles: list.slice(0, 4).map((event) => event.title),
    }
  }

  /**
   * The rows the calendar lists for the day it has open.
   *
   * Unlike the grid's counts, this includes events the user has ticked off, and
   * flags them: "the only thing on that day, and I finished it" is not the same
   * answer as an empty day, and the grid should not hide the difference. The cap
   * exists because the list sits under the grid, not in place of the timeline.
   */
  function itemsForDay(dayKey, limit = 8) {
    return runtime.events
      .filter((event) => event.date === dayKey)
      // Same order as the timeline itself: by clock time, timeless rows last.
      // Sorting on the raw instant instead put a row that starts now in among
      // rows from earlier in the day.
      .sort((left, right) => {
        const leftMs = startMsOf(left)
        const rightMs = startMsOf(right)
        if (leftMs === null && rightMs === null) return left.title.localeCompare(right.title)
        if (leftMs === null) return 1
        if (rightMs === null) return -1
        return leftMs - rightMs
      })
      .slice(0, limit)
      .map((event) => ({
        id: event.id,
        title: event.title,
        start: overrideOf(event).start ?? event.start ?? '',
        end: overrideOf(event).end ?? event.end ?? '',
        place: event.classroom || event.location || '',
        done: overrideOf(event).done === true,
        manual: isManualEvent(event),
        origin: event.source?.sheet === AI_SHEET ? 'ai' : isManualEvent(event) ? 'manual' : 'import',
      }))
  }

  function buildWeek(now) {
    const todayKey = localDayKey(now)
    const days = []
    for (let offset = -2; offset <= 7; offset += 1) {
      days.push(daySummary(new Date(now.getTime() + offset * 86_400_000), todayKey))
    }
    return days
  }

  /**
   * A month as the panel's calendar shows it.
   *
   * The grid is always seven columns starting on Monday and always ends on a
   * whole week, so the layout is a pure function of the month rather than of how
   * the days happen to fall — a calendar that reflows between five and six rows
   * makes "the 15th" a different pixel every month. Cells outside the month are
   * still real days (they carry their own counts and are selectable); `inMonth`
   * is what tells them apart.
   *
   * `monthKey` is validated rather than trusted, and comes from the page when the
   * user pages through months so the grid follows the browser's calendar rather
   * than the host's.
   */
  function buildMonth(now, monthKey, openDayKey) {
    const todayKey = localDayKey(now)
    const source = typeof monthKey === 'string' && /^\d{4}-\d{2}$/.test(monthKey) ? monthKey : localDayKey(now).slice(0, 7)
    const year = Number(source.slice(0, 4))
    const month = Number(source.slice(5, 7))
    const daysInMonth = new Date(year, month, 0).getDate()
    // Monday-first: JS counts Sunday as 0, the grid counts it as 6.
    const lead = (new Date(year, month - 1, 1).getDay() + 6) % 7
    const cells = lead + daysInMonth <= 35 ? 35 : 42
    const grid = []
    let markedDays = 0
    let markedEvents = 0
    for (let index = 0; index < cells; index += 1) {
      const cell = daySummary(new Date(year, month - 1, 1 - lead + index), todayKey)
      cell.inMonth = cell.dayKey.slice(0, 7) === source
      cell.monthDay = Number(cell.dayKey.slice(8, 10))
      // Counted from the same signal the grid draws its marker from, so "N 天有
      // 日程" can never disagree with the number of dotted days above it.
      if (cell.inMonth && cell.hasEvents) {
        markedDays += 1
        markedEvents += cell.count
      }
      grid.push(cell)
    }
    return {
      monthKey: source,
      year,
      month,
      title: `${year} 年 ${month} 月`,
      prevMonth: localDayKey(new Date(year, month - 2, 1)).slice(0, 7),
      nextMonth: localDayKey(new Date(year, month, 1)).slice(0, 7),
      grid,
      dayCount: markedDays,
      eventCount: markedEvents,
      // Only the open day's rows travel with the month — see `itemsForDay`.
      items: itemsForDay(openDayKey ?? todayKey),
    }
  }

  // ---- routes --------------------------------------------------------------

  route('/health', (req, res) => {
    sendJson(res, 200, {
      ok: true,
      name,
      version: '0.1.0',
      platform: process.platform,
      ownerNames: activeNames(),
      workbook: settings.workbook.path,
      events: runtime.events.length,
      manualEvents: manualRows().length,
      sources: configuredSources().map((source) => source.path),
      // Where the schedule is actually stored. The panel shows this, because
      // "my import disappeared" is nearly always a question about this path.
      stateDir,
      migratedFrom: stateLocation.migratedFrom,
      lastScanAt: runtime.lastScanAt,
      /**
       * What this host generation can do.
       *
       * The page can be refreshed without the app restarting, so a new panel can
       * meet an old host. The panel probes this before blaming the user's file
       * for what is really a missing route.
       */
      capabilities: ['read-documents'],
    })
  })

  route('/debug/client', async (req, res) => {
    const body = await readBody(req)
    const kind = String(body.kind ?? 'unknown')
    if (kind === 'layout') {
      runtime.clientLayout = { at: new Date().toISOString(), layout: body.layout }
    } else if (kind === 'event') {
      const name = String(body.name ?? '?')
      runtime.clientEvents = runtime.clientEvents ?? []
      // The card travels with the event when the page can describe it: "the ×
      // does nothing" is a different bug depending on whether the stylesheet is
      // still in the document and whether the hit test at that button reaches
      // our own node, and only the page knows either.
      runtime.clientEvents.push({ name, at: new Date().toISOString(), card: body.card ?? null })
      if (runtime.clientEvents.length > 40) runtime.clientEvents.splice(0, runtime.clientEvents.length - 40)
    }
    uiReports.set(kind, (uiReports.get(kind) ?? 0) + 1)
    persistSoon()
    sendJson(res, 200, { ok: true })
  })

  route('/debug', (req, res) => {
    const counts = {}
    for (const [path, count] of [...requestCounts.entries()].sort((left, right) => right[1] - left[1])) {
      counts[path] = count
    }
    sendJson(res, 200, {
      ok: true,
      since: new Date(startedAt).toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      // A request path missing from here means the click never left the page.
      requests: counts,
      uiReports: Object.fromEntries(uiReports),
      clientLayout: runtime.clientLayout ?? null,
      clientEvents: runtime.clientEvents ?? [],
      stateDir,
      hud: {
        running: hudProcess !== null,
        pid: hudProcess?.pid ?? null,
        log: HUD_LOG,
        script: HUD_SCRIPT,
        logTail: readHudLogTail(12),
      },
      timer: { phase: timer.phase, running: timer.running, remainingMs: Math.round(timer.remainingMs) },
      events: runtime.events.length,
      feed: runtime.feed.length,
    })
  })

  /**
   * The projection a request is asking for: which day is open, and which month
   * the calendar is showing. Both are optional, both are validated downstream.
   */
  function requestedView(req) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    return {
      url,
      day: url.searchParams.get('day') ?? undefined,
      month: url.searchParams.get('month') ?? undefined,
    }
  }

  route('/snapshot', (req, res) => {
    const view = requestedView(req)
    sendJson(res, 200, buildSnapshot(view.day, view.month))
  })

  route('/settings', async (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, settings })
      return
    }
    const body = await readBody(req)
    if (body.settings !== undefined && !isObject(body.settings)) {
      sendJson(res, 400, { ok: false, error: 'settings 必须是对象' })
      return
    }
    const patch = isObject(body.settings) ? body.settings : body
    settings = deepMerge(settings, patch)
    if (isObject(patch.pomodoro)) timer.config = { ...timer.config, ...settings.pomodoro }
    persistConfig()
    pushFeed({ kind: 'settings', level: 'info', title: '设置已保存', body: '新的配置已写入 orbit-time/config.json。' })
    sendJson(res, 200, { ok: true, settings })
  })

  route('/preview', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const body = req.method === 'POST' ? await readBody(req) : {}
    /**
     * A preview reads, it does not decide.
     *
     * This handler used to write the previewed path into `workbook.path`, so
     * merely looking at a file promoted it to the install's primary roster — the
     * other half of "第二份把第一份顶掉了": the preview of roster B silently
     * replaced roster A's configuration before anyone pressed import. Only
     * `/import` (an explicit confirmation) may change which files are configured.
     */
    if (isObject(body.settings)) {
      settings = deepMerge(settings, body.settings)
      persistConfig()
    }
    const requestedPath = typeof body.path === 'string' && body.path.trim() !== '' ? normalisePath(body.path) : undefined
    const { results, failures } = await readAllSources({
      path: requestedPath,
      sheet: typeof body.sheet === 'string' && body.sheet !== '' ? body.sheet : undefined,
      headerRow: Number.isFinite(body.headerRow) ? body.headerRow : undefined,
      mapping: isObject(body.mapping) ? body.mapping : undefined,
      timeRules: Array.isArray(body.timeRules) ? body.timeRules : undefined,
      previewRows: Number.isFinite(body.previewRows) ? body.previewRows : 12,
    })
    const names = activeNames()
    const primary = pickRequested(results, requestedPath)
    const sample = (primary.preview ?? []).map((row) => ({
      row: row._row,
      date: row.date,
      start: row.start,
      end: row.end,
      title: row.title || row.course || '',
      person: row.person,
      location: row.location || row.classroom || '',
      notes: row.notes || '',
      match: names.length === 0 ? null : matchesOwner(row.person) || matchesOwner(row.teacher),
      warnings: row._warnings ?? [],
      extras: row.extras ?? {},
    }))
    const files = results.map((parsed) => ({
      file: parsed.file,
      sheet: parsed.sheet,
      sheets: parsed.sheets,
      layout: parsed.layout ?? 'records',
      headerRow: parsed.headerRow,
      rowCount: parsed.rowCount,
      mapping: parsed.mapping,
      warnings: parsed.warnings,
    }))
    sendJson(res, 200, {
      ok: true,
      file: primary.file,
      configuredPath: primary.configuredPath ?? primary.file,
      chosenFrom: primary.chosenFrom ?? null,
      sheets: primary.sheets,
      sheet: primary.sheet,
      layout: primary.layout ?? 'records',
      headerRow: primary.headerRow,
      rowCount: primary.rowCount,
      headers: primary.headers,
      mapping: primary.mapping,
      unmapped: primary.unmapped,
      warnings: results.flatMap((parsed) => parsed.warnings ?? []),
      files,
      failures,
      ownerNames: names,
      matchedInPreview: sample.filter((row) => row.match === true).length,
      sample,
    })
  })

  /**
   * Read a workbook and explain it.
   *
   * The panel's "AI 读表" action lands here. It is deliberately one round trip:
   * locate the file, parse it, run the deterministic analyzer, optionally let the
   * model refine it, and hand back both the proposal and the preview rows the
   * user needs to judge it. Doing this in pieces would mean the panel had to
   * re-post state the host already has.
   */
  route('/analyze', async (req, res) => {
    const body = req.method === 'POST' ? await readBody(req, 24 * 1024 * 1024) : {}
    let uploaded = ''
    if (isObject(body.file) && typeof body.file.base64 === 'string') {
      uploaded = saveUpload(body.file.name, body.file.base64)
      ctx.logger?.info?.(`[orbit-time] analysis reading an uploaded workbook: ${body.file.name}`)
    }
    const requested = uploaded !== '' || (typeof body.path === 'string' && body.path.trim() !== '')
    /**
     * Reading a file never changes the configuration.
     *
     * Analysing used to persist a pasted path as `workbook.path` "so the next
     * import points at the same file" — which meant merely *reading* roster B
     * re-pointed the install away from roster A. Under the union import there is
     * nothing to point: the confirmed path travels with the `/import` request, and
     * only that request may add or change a roster. Dropped copies were already
     * spared this; pasted paths are now treated the same way.
     */
    const { parsed, analysis } = await analyzeWorkbook({
      path: uploaded !== '' ? uploaded : requested ? normalisePath(body.path) : undefined,
      sheet: typeof body.sheet === 'string' ? body.sheet : undefined,
      useModel: body.useModel !== false,
    })

    const names = activeNames()
    const sample = (parsed.preview ?? []).map((row) => ({
      row: row._row,
      date: row.date,
      start: row.start,
      end: row.end,
      title: row.title || row.course || '',
      person: row.person,
      location: row.location || row.classroom || '',
      notes: row.notes || '',
      match: names.length === 0 ? null : matchesOwner(row.person) || matchesOwner(row.teacher),
      warnings: row._warnings ?? [],
      extras: row.extras ?? {},
    }))
    /**
     * What "确认并导入" would actually do, counted over the whole sheet.
     *
     * The preview only carries a dozen sample rows, so the panel could not say
     * "将导入 4 条" — it said "样例里命中 3 行", which is a statement about the
     * sample, not about the import. The confirmation step needs the real number,
     * or the user is approving something they cannot see.
     */
    const plan = summarizeImportPlan(parsed)

    sendJson(res, 200, {
      ok: true,
      file: parsed.file,
      configuredPath: parsed.configuredPath ?? parsed.file,
      chosenFrom: parsed.chosenFrom ?? null,
      sheets: parsed.sheets,
      sheet: parsed.sheet,
      layout: parsed.layout ?? 'records',
      headerRow: parsed.headerRow,
      rowCount: parsed.rowCount,
      headers: parsed.headers,
      unmapped: parsed.unmapped,
      mapping: analysis.mapping,
      timeRules: analysis.timeRules,
      weekOneMonday: analysis.weekOneMonday,
      subject: analysis.subject,
      warnings: parsed.warnings ?? [],
      failures: [],
      ownerNames: names,
      matchedInPreview: sample.filter((row) => row.match === true).length,
      sample,
      analysis,
      plan,
      assistant: (({ mode, reason, detail }) => ({ mode, reason, detail }))(assistantStatus()),
    })
  })

  /**
   * Adopt an analysis: save the mapping, time rules, and week anchor, then import.
   *
   * "确认并导入" has to be a single action. Writing the settings first and asking
   * the panel to call `/import` afterwards would leave a window where the saved
   * configuration and the imported schedule disagree, and would double the round
   * trips for the most common thing a user does.
   */
  route('/import', async (req, res) => {
    const body = req.method === 'POST' ? await readBody(req) : {}
    if (isObject(body.settings)) {
      settings = deepMerge(settings, body.settings)
      persistConfig()
    }
    /**
     * Adopt the file the panel just confirmed.
     *
     * When it is one of the configured rosters, the *entry* is updated in place —
     * that is where its subject, note, and time rules live. Making it the primary
     * path instead left the roster described twice (once by `sources`, once by a
     * bare `workbook.path`).
     *
     * A roster nobody configured yet is **added** to `sources` instead of being
     * written over `workbook.path`. Overwriting the primary used to be how the
     * second import lost the first: the first roster stayed in `sources` with no
     * primary, or was replaced outright, and the import that followed rebuilt the
     * whole schedule from the one file it had just read. Adding is also what makes
     * "先导入早打卡，再导入晚自习" end with both on the timeline.
     */
    const confirmedPath = typeof body.path === 'string' && body.path.trim() !== '' ? resolveWorkbookPath(normalisePath(body.path)) : ''
    const configured = configuredSources()
    const confirmedEntry = confirmedPath === '' ? undefined : configuredEntryFor(confirmedPath, configured)
    const adopt = (target, props, { fillOnly = false } = {}) => {
      for (const key of ['subject', 'note', 'weekOneMonday']) {
        if (typeof props[key] !== 'string' || props[key].trim() === '') continue
        // `fillOnly` guards a label that already exists: the panel's proposal is
        // derived from the file ("晚自习"), while a configured one is what a
        // person wrote down ("示例支部晚自习考勤点名"). A guess may fill a gap,
        // never overwrite the answer.
        if (fillOnly && betterLabel('', target[key] ?? '') !== '') continue
        target[key] = props[key]
      }
      if (Array.isArray(props.timeRules) && props.timeRules.length > 0) target.timeRules = props.timeRules
      if (isObject(props.mapping) && Object.keys(props.mapping).length > 0) target.mapping = props.mapping
    }
    const configuredList = Array.isArray(settings.workbook.sources) ? settings.workbook.sources : []
    const sources = configuredList.filter((item) => isObject(item))
    if (confirmedEntry !== undefined) {
      const entry = sources.find((item) => String(item.path ?? '').toLowerCase() === String(confirmedEntry.path).toLowerCase())
      if (entry !== undefined) {
        adopt(entry, body, { fillOnly: true })
        persistConfig()
      } else if (String(settings.workbook.path ?? '').toLowerCase() === String(confirmedEntry.path).toLowerCase()) {
        // The confirmed file is the primary, not a `sources` entry: adopt into the
        // workbook-level labels it actually reads from.
        adopt(settings.workbook, body, { fillOnly: true })
        persistConfig()
      }
    } else if (confirmedPath !== '') {
      const alreadyListed = sources.some((item) => String(item.path ?? '').toLowerCase() === confirmedPath.toLowerCase())
      /**
       * Only a file that is actually there becomes a roster.
       *
       * A pasted path can be confirmed while the file sits on a share that is
       * offline, or after someone renamed it. Recording that path would make every
       * later import report the same failure for a roster the user never really
       * configured — and would survive restarts, so it could not fix itself.
       */
      const readable = existsSync(confirmedPath)
      if (!alreadyListed && readable) {
        settings.workbook.sources = [
          ...sources,
          {
            path: confirmedPath,
            subject: typeof body.subject === 'string' ? body.subject.trim() : '',
            note: typeof body.note === 'string' ? body.note.trim() : '',
            timeRules: Array.isArray(body.timeRules) ? body.timeRules : settings.workbook.timeRules,
            sheet: typeof body.sheet === 'string' && body.sheet !== '' ? body.sheet : undefined,
            mapping: isObject(body.mapping) ? body.mapping : undefined,
            weekOneMonday: typeof body.weekOneMonday === 'string' && body.weekOneMonday !== '' ? body.weekOneMonday : undefined,
          },
        ]
        // A single-file install keeps using `workbook.path` as its one roster.
        if (sources.length === 0 && String(settings.workbook.path ?? '').trim() === '') settings.workbook.path = confirmedPath
        adopt(settings.workbook, body, { fillOnly: true })
        persistConfig()
      }
    }
    try {
      const result = await importWorkbook({
        path: typeof body.path === 'string' && body.path.trim() !== '' ? normalisePath(body.path) : undefined,
        sheet: typeof body.sheet === 'string' && body.sheet !== '' ? body.sheet : undefined,
        headerRow: Number.isFinite(body.headerRow) ? body.headerRow : undefined,
        mapping: isObject(body.mapping) ? body.mapping : undefined,
        timeRules: Array.isArray(body.timeRules) ? body.timeRules : undefined,
        // The one-file import carries what the panel just confirmed about *this*
        // file. Without it, importing a roster the panel already understands fell
        // back to the worksheet name and the file's own label was lost.
        subject: typeof body.subject === 'string' && body.subject.trim() !== '' ? body.subject : undefined,
        note: typeof body.note === 'string' && body.note.trim() !== '' ? body.note : undefined,
        filterByOwner: body.filterByOwner !== false,
        includePast: body.includePast === true,
      })
      const view = requestedView(req)
      sendJson(res, 200, { ok: true, excel: result, snapshot: buildSnapshot(view.day, view.month) })
    } catch (error) {
      runtime.excel = {
        ...(runtime.excel ?? {}),
        lastError: error?.message ?? String(error),
        lastErrorAt: new Date().toISOString(),
      }
      persistSoon()
      sendJson(res, 200, { ok: false, error: error?.message ?? String(error) })
    }
  })

  /**
   * Read a document, a picture, or pasted text and propose events.
   *
   * One round trip, like `/analyze`: locate the file (or decode the upload),
   * pull out its text and page images, let the model turn them into events (or
   * fall back to the local scanner), and hand back the proposal plus the counts
   * the confirmation step needs. Reading never writes to the schedule — only
   * `/extract/commit` does.
   */
  route('/extract', async (req, res) => {
    const body = req.method === 'POST' ? await readBody(req, 24 * 1024 * 1024) : {}
    try {
      let path = ''
      if (isObject(body.file) && typeof body.file.base64 === 'string') {
        path = saveUpload(body.file.name, body.file.base64)
        ctx.logger?.info?.(`[orbit-time] reading an uploaded document: ${body.file.name}`)
      } else if (typeof body.path === 'string' && body.path.trim() !== '') {
        path = normalisePath(body.path)
      }
      const text = typeof body.text === 'string' ? body.text : ''
      if (path === '' && text.trim() === '') {
        sendJson(res, 400, { ok: false, error: '要么给一个文件，要么把要读的文字贴进来。' })
        return
      }
      const result = await extractSchedule({ path, text, useModel: body.useModel !== false })
      sendJson(res, 200, {
        ok: true,
        ...result,
        assistant: (({ mode, reason, detail }) => ({ mode, reason, detail }))(assistantStatus()),
      })
    } catch (error) {
      sendJson(res, 422, { ok: false, error: error?.message ?? String(error) })
    }
  })

  /**
   * Adopt a reading: the rows the user kept become schedule entries.
   *
   * They go into the self-made bucket (`AI_SHEET`), so no later Excel import can
   * erase them, and the id is derived from the file and the event itself, so
   * confirming the same notice twice cannot duplicate it.
   */
  route('/extract/commit', async (req, res) => {
    const body = req.method === 'POST' ? await readBody(req) : {}
    if (!Array.isArray(body.events) || body.events.length === 0) {
      sendJson(res, 400, { ok: false, error: '没有勾选任何日程。' })
      return
    }
    const result = commitExtraction(body)
    const view = requestedView(req)
    sendJson(res, 200, { ok: true, ...result, snapshot: buildSnapshot(view.day, view.month) })
  })

  route('/events', async (req, res) => {
    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const day = url.searchParams.get('day')
      sendJson(res, 200, { ok: true, events: day ? eventsForDay(day) : runtime.events })
      return
    }
    const body = await readBody(req)
    const action = String(body.action ?? '')
    const event = runtime.events.find((row) => row.id === body.id)
    if (action === 'add') {
      if (!isObject(body.event)) {
        sendJson(res, 400, { ok: false, error: '缺少 event 对象' })
        return
      }
      const created = normaliseEvent({ ...body.event, manual: body.event.manual !== false }, nextManualIndex())
      // A row with no time is a real note, not a today item: leaving the date
      // empty keeps it in the undated bucket instead of silently scheduling it
      // at midnight.
      if (created.date === '' && created.start !== '') created.date = localDayKey(new Date())
      runtime.events.push(created)
      // The same decision as above: a row created by hand (the panel's default)
      // is kept in its own list so the next import cannot erase it. A caller that
      // explicitly asks for an import-shaped row (`manual: false`) only joins
      // this run's rows.
      if (isManualEvent(created)) runtime.manualEvents = [...manualRows(), created]
      pushFeed({
        kind: 'event',
        level: 'success',
        title: `＋ 已添加 · ${created.title}`,
        body: [created.date, created.start === '' ? '全天' : `${created.start}${created.end ? '–' + created.end : ''}`, created.location]
          .filter((value) => value && value !== '')
          .join(' · '),
      })
      persistSoon()
      broadcast({ type: 'import', count: runtime.events.length, files: 0 })
      sendJson(res, 200, { ok: true, event: created })
      return
    }
    if (event === undefined) {
      sendJson(res, 404, { ok: false, error: `找不到日程 ${body.id}` })
      return
    }
    switch (action) {
      case 'done': {
        runtime.overrides[event.id] = { ...overrideOf(event), done: body.done !== false }
        if (body.done !== false) {
          pushFeed({ kind: 'event', level: 'success', title: `✓ 已完成 · ${event.title}`, body: event.start })
        }
        break
      }
      case 'snooze': {
        const minutes = Number(body.minutes) || 5
        runtime.overrides[event.id] = {
          ...overrideOf(event),
          snoozedUntil: new Date(Date.now() + minutes * 60_000).toISOString(),
        }
        pushFeed({ kind: 'event', level: 'info', title: `😴 稍后提醒 · ${event.title}`, body: `${minutes} 分钟后再提醒一次` })
        break
      }
      case 'shift': {
        const delta = Number(body.minutes) || 0
        const override = overrideOf(event)
        const baseStart = override.start ?? event.start
        if (baseStart === '') {
          sendJson(res, 400, { ok: false, error: '该日程没有时间，无法顺延' })
          return
        }
        const baseEnd = override.end ?? event.end
        runtime.overrides[event.id] = {
          ...override,
          start: addMinutes(baseStart, delta),
          end: baseEnd === '' ? '' : addMinutes(baseEnd, delta),
          shiftedMinutes: (Number(override.shiftedMinutes) || 0) + delta,
        }
        for (const key of [...fired.keys()]) {
          if (key.startsWith(`${event.id}:`)) fired.delete(key)
        }
        pushFeed({
          kind: 'event',
          level: 'info',
          title: `↔︎ 已顺延 · ${event.title}`,
          body: `${baseStart} → ${addMinutes(baseStart, delta)}`,
        })
        break
      }
      case 'remove': {
        runtime.events = runtime.events.filter((row) => row.id !== event.id)
        // Otherwise the next merge would resurrect it out of `manualEvents`.
        runtime.manualEvents = manualRows().filter((row) => row.id !== event.id)
        for (const key of [...fired.keys()]) {
          if (key.startsWith(`${event.id}:`)) fired.delete(key)
        }
        delete runtime.overrides[event.id]
        break
      }
      case 'reset': {
        delete runtime.overrides[event.id]
        for (const key of [...fired.keys()]) {
          if (key.startsWith(`${event.id}:`)) fired.delete(key)
        }
        break
      }
      default:
        sendJson(res, 400, { ok: false, error: `未知操作 ${action}` })
        return
    }
    persistSoon()
    const view = requestedView(req)
    sendJson(res, 200, { ok: true, snapshot: buildSnapshot(view.day, view.month) })
  })

  route('/timer', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const body = req.method === 'POST' ? await readBody(req) : {}
    const action = String(body.action ?? 'state')
    switch (action) {
      case 'state':
        break
      case 'start':
        startPhase(body.phase === 'short' || body.phase === 'long' ? body.phase : 'focus', {
          subject: body.subject,
        })
        break
      case 'pause':
        if (timer.running) {
          timer.remainingMs = Math.max(0, (timer.endsAt ?? Date.now()) - Date.now())
          timer.running = false
          timer.endsAt = null
          pushFeed({ kind: 'timer', level: 'info', title: '⏸ 已暂停', body: formatDuration(timer.remainingMs) })
        }
        break
      case 'resume':
        if (!timer.running && timer.phase !== 'idle' && timer.remainingMs > 0) {
          timer.running = true
          timer.startedAt = Date.now()
          timer.endsAt = Date.now() + timer.remainingMs
          pushFeed({ kind: 'timer', level: 'info', title: '▶︎ 继续', body: formatDuration(timer.remainingMs) })
        }
        break
      case 'reset':
        timer.running = false
        timer.phase = 'idle'
        timer.remainingMs = 0
        timer.startedAt = null
        timer.endsAt = null
        timer.subject = ''
        break
      case 'skip':
        if (timer.phase === 'focus') {
          timer.completedToday += 1
          const rounds = Number(timer.config.roundsBeforeLongBreak) || 4
          startPhase(timer.completedToday % rounds === 0 ? 'long' : 'short', { auto: true })
        } else {
          startPhase('focus', { auto: true })
        }
        break
      case 'next': {
        const focus = timer.phase === 'focus'
        startPhase(focus ? 'short' : 'focus', { subject: body.subject })
        break
      }
      default:
        sendJson(res, 400, { ok: false, error: `未知计时器操作 ${action}` })
        return
    }
    persistSoon()
    sendJson(res, 200, { ok: true, timer: { ...timer }, serverTime: { iso: new Date().toISOString() } })
  })

  route('/feed', async (req, res) => {
    if (req.method === 'DELETE') {
      runtime.feed = []
      persistSoon()
      sendJson(res, 200, { ok: true, feed: [] })
      return
    }
    sendJson(res, 200, { ok: true, feed: runtime.feed })
  })

  route('/assistant', async (req, res) => {
    const body = await readBody(req)
    const action = String(body.action ?? '')
    if (action === 'reply' && isObject(body.settings)) {
      settings = deepMerge(settings, body.settings)
      persistConfig()
    }
    const view = requestedView(req)
    const snapshot = buildSnapshot(view.day, view.month)

    // `status` is the capability probe the panel uses to label the companion
    // before anyone has asked it anything.
    if (action === 'status') {
      const status = assistantStatus()
      sendJson(res, 200, {
        ok: true,
        status: { mode: status.mode, reason: status.reason, detail: status.detail },
        snapshot,
      })
      return
    }

    const local = composeAnswer(action, body, snapshot)
    const question = String(body.question ?? '').trim() || local.speak || '给我今天的简报'
    const history = Array.isArray(body.history) ? body.history : []

    let reply = local
    let model = { ok: false, reason: 'not-attempted' }
    if (action !== 'reply') {
      model = await askModel(question, snapshot, history)
      if (model.ok) {
        // The model supplies the words; the rule engine still supplies the
        // follow-up chips, because those are UI affordances rather than prose.
        reply = { speak: model.text, detail: '', chips: local.chips, model: { provider: model.provider, model: model.model } }
      } else if (model.reason !== 'disabled' && model.reason !== 'no-service' && model.reason !== 'no-model') {
        ctx.logger?.warn?.('[orbit-time] model answer failed (' + model.reason + '): ' + model.detail)
      }
    }

    const answerMode = model.ok ? 'model' : 'local'
    const answer = {
      ...reply,
      mode: answerMode,
      detail: reply.detail ?? '',
      fallback: model.ok ? undefined : { reason: model.reason, detail: model.detail },
    }
    if (action !== 'reply') {
      pushFeed({
        kind: 'ai',
        level: 'info',
        title: `🤖 ${String(answer.speak).slice(0, 40)}`,
        body: answerMode === 'model' ? `由 ${model.model} 生成` : `内置规则回答（${model.reason}）`,
      })
    }
    sendJson(res, 200, { ok: true, reply: answer, status: assistantStatus(), snapshot })
  })

  // ---- AI companion --------------------------------------------------------

  /** Which model route Orbyt would use, or null when none is wired up. */
  function resolveModelRoute() {
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    if (isObject(selection) && typeof selection.provider === 'string' && typeof selection.model === 'string') {
      return {
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: typeof selection.reasoningEffort === 'string' ? selection.reasoningEffort : undefined,
      }
    }
    return null
  }

  function assistantStatus() {
    const llm = ctx.get?.('llm')
    const route = resolveModelRoute()
    const enabled = settings.assistant?.useModel !== false
    if (!enabled) return { mode: 'local', reason: 'disabled', detail: '已在设置里关闭模型，Orbyt 使用内置规则回答。' }
    if (!llm || typeof llm.stream !== 'function') {
      return { mode: 'local', reason: 'no-service', detail: '当前组合里没有可用的模型服务。' }
    }
    if (route === null) return { mode: 'local', reason: 'no-model', detail: '没有解析到默认模型。' }
    return { mode: 'model', reason: 'ready', detail: `${route.provider} · ${route.model}`, route }
  }

  /** The schedule facts Orbyt is allowed to reason about, as compact JSON. */
  function buildAssistantContext(snapshot) {
    const day = snapshot.day
    const timerView = {
      phase: timer.phase,
      running: timer.running,
      remainingMinutes: timer.phase === 'idle' ? 0 : Math.round(timer.remainingMs / 60_000),
      subject: timer.subject,
      completedToday: timer.completedToday,
      goal: Number(timer.config?.dailyGoalRounds) || 8,
      focusMinutes: Number(timer.config?.focusMinutes) || 25,
    }
    const shrink = (event) => ({
      title: event.title,
      date: event.date,
      start: event.effectiveStart || event.start,
      end: event.effectiveEnd || event.end,
      phase: event.phase,
      done: event.done,
      inMinutes: event.minutesUntilStart,
      minutesLeft: event.phase === 'current' ? event.minutesUntilEnd : undefined,
      place: event.classroom || event.location || undefined,
      teacher: event.teacher || undefined,
      course: event.course || undefined,
      notes: event.notes ? String(event.notes).slice(0, 120) : undefined,
      owner: event.owner || undefined,
      warnings: isEmpty(event.warnings) ? undefined : event.warnings,
    })
    return JSON.stringify(
      {
        现在: snapshot.serverTime.label,
        今天: day.dayKey,
        星期: day.stats.label,
        关注的人: snapshot.ownerNames,
        今日日程: day.events.map(shrink),
        未定时间: day.undated.map(shrink),
        接下来的日程: snapshot.upcoming.map(shrink),
        统计: {
          条数: day.stats.eventCount,
          总分钟: day.stats.totalMinutes,
          已完成分钟: day.stats.doneMinutes,
          空档: day.stats.freeSlots,
          今日番茄: day.stats.completedRounds,
          番茄目标: day.stats.focusGoalRounds,
        },
        番茄钟: timerView,
        提醒设置: {
          提前分钟: settings.reminders.offsetsMinutes,
          静音时段: settings.reminders.quietHours,
        },
      },
      null,
      1,
    )
  }

  function isEmpty(value) {
    return !Array.isArray(value) || value.length === 0
  }

  const ORBYT_SYSTEM = [
    '你是 Orbyt，一个嵌在日程仪表盘里的日程副驾。',
    '',
    '说话方式：',
    '- 用中文，口语化、简短，像坐在旁边的同事，不像客服。',
    '- 每次先给一句结论，再给必要的细节；总长度控制在 120 字以内。',
    '- 可以有一点点幽默，但不要卖萌、不要堆 emoji（最多一个）。',
    '- 有具体时间就说具体时间（"还有 22 分钟"比"很快"好）。',
    '',
    '硬性要求：',
    '- 只使用下面「你的数据」里出现的事实。不要编造日程、地点、人名或时间。',
    '- 数据里没有的，就直说不知道，并告诉用户可以去哪一页补充。',
    '- 用户问「帮我准备/该先做什么」时，给可执行的下一步，而不是泛泛建议。',
    '- 不要输出 Markdown 标题或表格，用短句和换行就够。',
    '',
    '你的数据（JSON）：',
  ].join('\n')

  function shrinkHistory(history) {
    if (!Array.isArray(history)) return []
    const limit = Math.max(0, Math.min(20, Number(settings.assistant?.historyTurns) || 6))
    const turns = []
    for (const entry of history) {
      if (!isObject(entry)) continue
      if (entry.role !== 'user' && entry.role !== 'assistant') continue
      const text = typeof entry.text === 'string' ? entry.text.trim() : ''
      if (text === '') continue
      turns.push({ role: entry.role, text: text.slice(0, 500) })
    }
    // Prior turns are context, never grounding: drop them all rather than send
    // an assistant turn the model never said, which some providers reject.
    const window = turns.slice(-limit)
    while (window.length > 0 && window[0].role !== 'user') window.shift()
    return window
  }

  /**
   * Answer one question with the configured model.
   *
   * Streaming is used rather than a buffered call because the same service backs
   * the chat surface; collecting the text deltas here keeps this a plain
   * request/response for the panel. Every failure is returned, not thrown: the
   * caller falls back to the rule engine and says so.
   *
   * @param {string} question - the user turn.
   * @param {unknown} snapshot - schedule facts, for the companion's system prompt.
   * @param {unknown} history - prior turns.
   * @param {{ system?: string, maxTokens?: number, images?: Array<{path:string,name?:string}> }} [options] -
   *   overrides. The workbook analyzer supplies its own system prompt and a larger
   *   token budget; the document reader additionally attaches pictures of the
   *   pages it could not read as text. All callers share this transport so route
   *   selection, the vision check, retry-without-effort, and every failure mode
   *   behave identically.
   */
  async function askModel(question, snapshot, history, options = {}) {
    const status = assistantStatus()
    if (status.mode !== 'model') return { ok: false, reason: status.reason, detail: status.detail }

    const controller = new AbortController()
    const budget = Number(settings.assistant?.timeoutMs) || 45_000
    const timerHandle = setTimeout(() => controller.abort(), budget)
    if (typeof timerHandle.unref === 'function') timerHandle.unref()

    const messages = shrinkHistory(history).map((turn) => ({ role: turn.role, content: [{ type: 'text', text: turn.text }] }))
    const userContent = [{ type: 'text', text: question }]

    /**
     * Pictures ride along as real image blocks, which the harness's attachment
     * service turns into provider-specific bytes. Two things are checked before
     * that happens: the service has to exist in this composition (it is optional
     * here, like `llm`), and the *route* has to declare image input — otherwise
     * the provider rejects the whole call and the user reads a transport error
     * instead of "this model cannot see pictures".
     */
    const pictures = Array.isArray(options.images) ? options.images.filter((image) => typeof image?.path === 'string') : []
    if (pictures.length > 0) {
      const llm = ctx.get?.('llm')
      let modalities = null
      try {
        if (llm && typeof llm.resolveModelInfo === 'function') {
          const info = await llm.resolveModelInfo(status.route.provider, status.route.model, controller.signal)
          modalities = Array.isArray(info?.inputModalities) ? info.inputModalities : null
        }
      } catch {
        /* capability lookup is advisory: let the adapter be the judge */
      }
      if (Array.isArray(modalities) && !modalities.includes('image')) {
        clearTimeout(timerHandle)
        return {
          ok: false,
          reason: 'no-vision',
          detail: `${status.route.provider} · ${status.route.model} 不支持读图，换一个支持视觉的模型再读，或者把图片里的文字复制成一段文字。`,
        }
      }
      let refs = []
      try {
        refs = await saveImageAttachments(pictures.map((image) => image.path))
      } catch (error) {
        clearTimeout(timerHandle)
        return { ok: false, reason: 'image-rejected', detail: error?.message ?? String(error) }
      }
      for (const ref of refs) userContent.push({ type: 'image', attachment: ref })
    }

    messages.push({ role: 'user', content: userContent })

    const call = {
      provider: status.route.provider,
      model: status.route.model,
      system: options.system ?? ORBYT_SYSTEM + '\n' + buildAssistantContext(snapshot),
      messages,
      maxTokens: Number(options.maxTokens ?? settings.assistant?.maxTokens) || 700,
      signal: controller.signal,
    }
    if (status.route.reasoningEffort !== undefined) call.reasoningEffort = status.route.reasoningEffort

    try {
      const llm = ctx.get('llm')
      let chunks = null
      if (typeof llm.prepareCall === 'function') {
        // Binding the call keeps HMR from mixing one adapter's capability result
        // with another adapter's stream. It also validates the route up front:
        // an explicit reasoning effort the model does not support rejects here,
        // and the retry below runs without it rather than failing the answer.
        try {
          const prepared = await llm.prepareCall(
            {
              provider: status.route.provider,
              model: status.route.model,
              ...(status.route.reasoningEffort === undefined ? {} : { reasoningEffort: status.route.reasoningEffort }),
              maxTokens: call.maxTokens,
            },
            controller.signal,
          )
          chunks = prepared.stream(call)
        } catch (error) {
          ctx.logger?.warn?.('[orbit-time] prepareCall failed, retrying plainly: ' + (error?.message ?? error))
          delete call.reasoningEffort
          chunks = null
        }
      }
      if (chunks === null) chunks = llm.stream(call)

      let text = ''
      let reasoning = ''
      let finish = null
      for await (const chunk of chunks) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
        else if (chunk.type === 'finish') finish = chunk.reason
      }
      if (finish && finish.kind === 'error') {
        return { ok: false, reason: 'model-error', detail: finish.failure?.message ?? '模型调用失败' }
      }
      if (finish && finish.kind === 'aborted') {
        return { ok: false, reason: 'aborted', detail: finish.failure?.message ?? '模型调用被中断' }
      }
      const spoken = text.trim()
      if (spoken === '') {
        return { ok: false, reason: 'empty', detail: reasoning.trim() === '' ? '模型没有返回内容' : '模型只返回了推理，没有正文' }
      }
      return { ok: true, text: spoken, provider: status.route.provider, model: status.route.model }
    } catch (error) {
      return { ok: false, reason: 'threw', detail: error?.message ?? String(error) }
    } finally {
      clearTimeout(timerHandle)
    }
  }

  // ---- AI companion: a local, data-grounded reasoning pass -----------------

  function composeAnswer(action, body, snapshot) {
    const question = String(body.question ?? '').trim()
    const names = snapshot.ownerNames
    const next = snapshot.nextEvent
    const currentEvent = snapshot.day.events.find((event) => event.phase === 'current')
    const day = snapshot.day
    const stats = day.stats

    const greeting = () => {
      const hour = new Date().getHours()
      if (hour < 6) return `${names[0] ?? '你'}，这个点还没睡？`
      if (hour < 11) return `早上好${names[0] ? `，${names[0]}` : ''}`
      if (hour < 14) return `中午好${names[0] ? `，${names[0]}` : ''}`
      if (hour < 19) return `下午好${names[0] ? `，${names[0]}` : ''}`
      return `晚上好${names[0] ? `，${names[0]}` : ''}`
    }

    const relative = (minutes) => {
      if (minutes === null) return '时间未定'
      if (minutes < 0) return `已过 ${Math.abs(minutes)} 分钟`
      if (minutes === 0) return '就是现在'
      if (minutes < 60) return `${minutes} 分钟后`
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      return rest === 0 ? `${hours} 小时后` : `${hours} 小时 ${rest} 分钟后`
    }

    const detailOf = (event) => {
      if (event === null || event === undefined) return ''
      return [event.start && event.end ? `${event.start}–${event.end}` : event.start || '全天', event.location || event.classroom, event.course, event.teacher]
        .filter((value) => value && value !== '')
        .join(' · ')
    }

    if (action === 'brief') {
      const lines = []
      lines.push(`${greeting()}。今天你有 ${stats.eventCount} 条日程，共 ${Math.round(stats.totalMinutes / 60 * 10) / 10} 小时，已完成约 ${Math.round(stats.doneMinutes / 60 * 10) / 10} 小时。`)
      if (currentEvent) lines.push(`正在进行：${currentEvent.title}（${detailOf(currentEvent)}），还剩 ${relative(-currentEvent.minutesUntilEnd).replace('已过 ', '')}。`)
      if (next) lines.push(`接下来：${next.title}，${relative(next.minutesUntilStart)}开始。`)
      else if (!currentEvent) lines.push('今天已经没有后续日程了，可以留给自己。')
      if (stats.freeSlots.length > 0) {
        lines.push(`空档：${stats.freeSlots.slice(0, 2).map((slot) => `${slot.from}–${slot.to}`).join('、')}。`)
      }
      return {
        speak: lines[0],
        detail: lines.slice(1).join('\n'),
        chips: ['今天最该先做什么？', '帮我找个专注时段', '半小时前的提醒够不够？'],
      }
    }

    if (action === 'prep') {
      // `nextEvent` is whichever event is in flight, which may already have
      // started. Preparing for something you are already inside is not useful, so
      // an in-flight event is answered as "you are in it, here is the wrap-up"
      // and a genuinely upcoming one gets the full lead-in checklist.
      const inFlight = next !== null && next !== undefined && next.isCurrent === true ? next : currentEvent
      const upcoming = next !== null && next !== undefined && next.isCurrent === false ? next : null
      const target = upcoming ?? inFlight
      if (!target) {
        return { speak: '接下来没有日程，先给自己倒杯水吧。', detail: '', chips: ['生成今日简报'] }
      }
      const checklist = []
      if (upcoming !== null) {
        const until = upcoming.minutesUntilStart
        checklist.push(`确认时间地点：${detailOf(upcoming) || '未填写，建议补上'}`)
        if (upcoming.link) checklist.push(`会前 10 分钟测试链接：${upcoming.link}`)
        if (upcoming.notes) checklist.push(`带上材料：${upcoming.notes.slice(0, 60)}`)
        if (until !== null && until > 40) {
          checklist.push(`还有 ${relative(until)}，可以先做半个番茄（${snapshot.settings.pomodoro.focusMinutes} 分钟）`)
        }
        if (until !== null && until <= 10) checklist.push('立刻收尾手头的事，别再开新坑')
        return {
          speak: `${upcoming.title} ${relative(until)}开始，准备清单我列好了。`,
          detail: checklist.map((line, index) => `${index + 1}. ${line}`).join('\n'),
          chips: ['现在开一个番茄', '推后 10 分钟', '生成今日简报'],
        }
      }
      const left = inFlight.minutesUntilEnd
      checklist.push(`结束时间：${inFlight.effectiveEnd || '未填写'}`)
      if (left !== null && left <= 15) checklist.push(`还剩 ${left} 分钟，可以开始收尾了`)
      if (inFlight.notes) checklist.push(`别忘了：${inFlight.notes.slice(0, 60)}`)
      if (upcoming === null) checklist.push('之后没有其他日程，结束后可以留给自己')
      return {
        speak: `${inFlight.title} 正在进行${left !== null ? `，还剩 ${left} 分钟` : ''}。`,
        detail: checklist.map((line, index) => `${index + 1}. ${line}`).join('\n'),
        chips: ['现在开一个番茄', '生成今日简报'],
      }
    }

    if (action === 'focus') {
      const minutes = Number(body.minutes) || Number(snapshot.settings.pomodoro.focusMinutes) || 25
      // Prefer a genuinely upcoming event over one that is already running.
      const upcoming = next !== null && next !== undefined && next.isCurrent === false ? next : null
      const subject = upcoming?.title ?? currentEvent?.title ?? '当前任务'
      const conflict = snapshot.day.events.find(
        (event) => event.phase === 'upcoming' && event.minutesUntilStart !== null && event.minutesUntilStart < minutes,
      )
      const detail = conflict
        ? `注意：${conflict.title} 会在 ${relative(conflict.minutesUntilStart)}开始，${minutes} 分钟的番茄可能被打断，建议改成 ${Math.max(5, (conflict.minutesUntilStart ?? 25) - 5)} 分钟。`
        : '这段时间是干净的，我把它标成专注块。'
      return {
        speak: `好，${minutes} 分钟专注，主题「${subject}」。`,
        detail,
        chips: ['开始专注', '换个主题', '稍后再说'],
      }
    }

    if (action === 'review') {
      const done = snapshot.day.events.filter((event) => event.phase === 'past' || event.done)
      const rounds = stats.completedRounds
      const goal = stats.focusGoalRounds
      const ratio = goal > 0 ? Math.round((rounds / goal) * 100) : 0
      const detail = [
        `已完成日程 ${done.length} 条：${done.slice(0, 5).map((event) => event.title).join('、') || '暂无'}`,
        `番茄 ${rounds}/${goal}（${ratio}%），专注约 ${stats.focusMinutesToday} 分钟`,
        ratio >= 100 ? '目标达成，今天可以给自己一点奖励。' : `再 ${goal - rounds} 个番茄就达标。`,
      ].join('\n')
      return { speak: `今天过了 ${Math.round((stats.doneMinutes / Math.max(1, stats.totalMinutes)) * 100)}% 的日程时间。`, detail, chips: ['生成今日简报', '分析我的空档'] }
    }

    if (action === 'gap') {
      const slots = stats.freeSlots
      if (slots.length === 0) {
        return { speak: '今天排得很满，几乎没有 20 分钟以上的空档。', detail: '建议把非关键的事挪到明天，保护注意力。', chips: ['哪些可以推后？', '生成今日简报'] }
      }
      const longest = slots.reduce((best, slot) => (slot.minutes > best.minutes ? slot : best), slots[0])
      return {
        speak: `最长的空档是 ${longest.from}–${longest.to}，共 ${longest.minutes} 分钟。`,
        detail: `按 ${snapshot.settings.pomodoro.focusMinutes} 分钟一个番茄，这里能放 ${Math.floor(longest.minutes / (Number(snapshot.settings.pomodoro.focusMinutes) || 25))} 个。\n其余空档：${slots.slice(1).map((slot) => `${slot.from}–${slot.to}`).join('、') || '无'}`,
        chips: ['开始专注', '今天最该先做什么？'],
      }
    }

    if (action === 'mood') {
      const hour = new Date().getHours()
      const lines = [
        hour < 6 ? '凌晨的专注力是个陷阱，效率高但代价在后面。' : hour < 9 ? '早上第一件事最好别是回消息。' : hour < 12 ? '上午适合啃硬骨头。' : hour < 14 ? '饭后 20 分钟别硬撑，走走更好。' : hour < 18 ? '下午三点是低谷，安排机械性工作。' : '晚上适合收尾，不适合开工。',
        currentEvent ? `你现在在「${currentEvent.title}」。` : next ? `下一个是「${next.title}」，${relative(next.minutesUntilStart)}。` : '现在没有日程。',
        stats.completedRounds > 0 ? `今天已经完成 ${stats.completedRounds} 个番茄，保持节奏。` : '今天还没有番茄，先来一个？',
      ]
      return { speak: lines[0], detail: lines.slice(1).join('\n'), chips: ['开始专注', '生成今日简报', '分析我的空档'] }
    }

    // Free-form question: answer from the loaded schedule with keyword routing.
    if (question !== '') {
      const lowered = question.toLowerCase()
      if (/提醒|闹钟|提前/.test(question)) {
        const offsets = snapshot.settings.reminders.offsetsMinutes ?? []
        return {
          speak: `我会在 ${offsets.map((value) => (value === 0 ? '开始时' : `${value} 分钟前`)).join('、')} 提醒你。`,
          detail: snapshot.settings.reminders.enabled ? '提醒来自宿主进程，浏览器关掉也会照常弹出 Windows 通知。' : '提醒当前是关闭的，设置里可以打开。',
          chips: ['半小时前的提醒够不够？', '生成今日简报'],
        }
      }
      if (/番茄|专注|focus/.test(lowered)) {
        return composeAnswer('focus', body, snapshot)
      }
      if (/空档|空闲|free|gap/.test(lowered)) {
        return composeAnswer('gap', body, snapshot)
      }
      if (/总结|简报|概览|今天怎么样|brief/.test(question)) {
        return composeAnswer('brief', body, snapshot)
      }
      const hits = snapshot.day.events.filter((event) =>
        [event.title, event.course, event.location, event.classroom, event.teacher, event.notes]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(lowered) || lowered.includes(String(value).toLowerCase())),
      )
      if (hits.length > 0) {
        return {
          speak: `找到 ${hits.length} 条相关日程。`,
          detail: hits.map((event) => `• ${event.start || '全天'} ${event.title} ${detailOf(event)}`).join('\n'),
          chips: ['生成今日简报', '帮我找个专注时段'],
        }
      }
      return {
        speak: '这个问题我暂时只能靠你的日程来回答。',
        detail: `我目前能看到：今天 ${stats.eventCount} 条日程${next ? `，最近一条是「${next.title}」${relative(next.minutesUntilStart)}开始` : ''}。\n试试问我：今天最该先做什么、哪里有 longest 空档、番茄进度如何。`,
        chips: ['生成今日简报', '分析我的空档', '准备下一个日程'],
      }
    }

    return composeAnswer('brief', body, snapshot)
  }

  // ---- floating window & mini app ------------------------------------------

  const HUD_SCRIPT = join(HERE, 'hud.ps1')
  const HUD_LOG = join(stateDir, 'hud-interactions.log')

  /** The tail of the widget's own log — the other half of "the click did nothing". */
  function readHudLogTail(lines) {
    try {
      if (!existsSync(HUD_LOG)) return []
      const all = readFileSync(HUD_LOG, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '')
      return all.slice(-lines)
    } catch {
      return []
    }
  }

  function buildHudState() {
    const now = new Date()
    const snapshot = buildSnapshot(localDayKey(now))
    const remainingMs = timer.running ? Math.max(0, (timer.endsAt ?? Date.now()) - Date.now()) : timer.remainingMs
    const totalMinutes = phaseMinutes(timer.phase)
    const next = snapshot.nextEvent
    const nextMeta = next
      ? [next.effectiveStart || '全天', next.classroom || next.location].filter((value) => value && value !== '').join(' · ')
      : ''
    return {
      publishedAt: now.toISOString(),
      phase: timer.phase,
      running: timer.running,
      remainingSeconds: Math.round(remainingMs / 1000),
      totalSeconds: Math.round(totalMinutes * 60),
      subject: timer.subject || '',
      completedToday: timer.completedToday,
      nextTitle: next ? next.title : '今天没有日程',
      nextMeta,
      nextMinutes: next && next.isCurrent !== true && next.minutesUntilStart !== null ? next.minutesUntilStart : null,
      nextPhase: next ? next.phase : null,
      nextIsCurrent: next ? next.isCurrent === true : false,
      dayLabel: `${snapshot.day.dayKey} ${snapshot.day.stats.label}`,
      eventCount: snapshot.day.events.length,
      eventsToday: snapshot.day.events.slice(0, 12).map((event) => ({
        start: event.effectiveStart || event.start || '',
        title: event.title,
        phase: event.phase,
        done: event.done,
        classroom: event.classroom || event.location || '',
      })),
      ownerNames: snapshot.ownerNames,
      excelError: runtime.excel?.lastError ?? null,
    }
  }

  function writeHudState() {
    try {
      writeFileSync(hudStatePath, JSON.stringify(buildHudState(), null, 2), 'utf8')
    } catch (error) {
      ctx.logger?.warn?.('[orbit-time] HUD state write failed: ' + (error?.message ?? error))
    }
  }

  /**
   * What the host half believes about the floating window, written beside the
   * state it publishes.
   *
   * "The buttons do nothing" has two halves — the widget's own log says whether a
   * click arrived, and this says whether the host was in a position to act on it.
   * Without it the only evidence is a file that stopped being written, which does
   * not say whether the bridge is running, disabled, or throwing.
   */
  function writeHudStatus() {
    if (typeof hudStatusPath !== 'string' || hudStatusPath === '') return
    try {
      const requests = (() => {
        try {
          return readdirSync(stateDir).filter((name) => name.startsWith('hud-request-') && name.endsWith('.json')).length
        } catch {
          return -1
        }
      })()
      writeFileSync(
        hudStatusPath,
        JSON.stringify(
          {
            at: new Date().toISOString(),
            hudEnabled: settings.ui?.showFloatingWidget !== false,
            ownsProcess: hudProcess !== null,
            hudPid: liveHudPid(),
            spawnedPid: hudProcess?.pid ?? null,
            bridgeTicks,
            bridgePublished,
            bridgeProblems,
            pendingRequests: requests,
            statePath: hudStatePath,
            scriptPath: HUD_SCRIPT,
            scriptExists: existsSync(HUD_SCRIPT),
          },
          null,
          2,
        ),
        'utf8',
      )
    } catch {
      /* the status file is a convenience; never let it break the bridge */
    }
  }

  function readHudRequests() {    let names = []
    try {
      names = readdirSync(stateDir).filter((name) => name.startsWith('hud-request-') && name.endsWith('.json'))
    } catch {
      return
    }
    for (const name of names) {
      const full = join(stateDir, name)
      let payload = null
      try {
        payload = JSON.parse(readFileSync(full, 'utf8'))
      } catch {
        // A partially written request: skip it this round.
        continue
      }
      try {
        unlinkSync(full)
      } catch {
        /* ignore */
      }
      if (!isObject(payload)) continue
      const action = String(payload.action ?? '')
      let outcome = 'ok'
      try {
        outcome = applyHudAction(action, payload)
      } catch (error) {
        outcome = error?.message ?? String(error)
        ctx.logger?.warn?.('[orbit-time] HUD action failed: ' + outcome)
      }
      if (typeof payload.id === 'string' && payload.id !== '') {
        try {
          writeFileSync(join(stateDir, `hud-response-${payload.id}.json`), JSON.stringify({ ok: outcome === 'ok', outcome }), 'utf8')
        } catch {
          /* ignore */
        }
      }
    }
  }

  function applyHudAction(action, payload) {
    switch (action) {
      case 'toggle':
        if (timer.running) {
          timer.remainingMs = Math.max(0, (timer.endsAt ?? Date.now()) - Date.now())
          timer.running = false
          timer.endsAt = null
        } else if (timer.phase === 'idle' || timer.remainingMs <= 0) {
          startPhase('focus', { subject: timer.subject })
        } else {
          timer.running = true
          timer.startedAt = Date.now()
          timer.endsAt = Date.now() + timer.remainingMs
        }
        break
      case 'skip':
        if (timer.phase === 'focus') {
          timer.completedToday += 1
          const rounds = Number(timer.config.roundsBeforeLongBreak) || 4
          startPhase(timer.completedToday % rounds === 0 ? 'long' : 'short', { auto: true })
        } else {
          startPhase('focus', { auto: true })
        }
        break
      case 'reset':
        timer.running = false
        timer.phase = 'idle'
        timer.remainingMs = 0
        timer.startedAt = null
        timer.endsAt = null
        timer.subject = ''
        break
      case 'reimport':
        void importWorkbook({}).catch((error) => {
          pushFeed({ kind: 'import', level: 'warn', title: '悬浮窗触发的导入失败', body: error?.message ?? String(error) })
        })
        break
      case 'hide':
        stopHud()
        break
      case 'ping':
        break
      default:
        return `unknown HUD action ${action}`
    }
    persistSoon()
    writeHudState()
    return 'ok'
  }

  /**
   * Take the widget off the screen.
   *
   * Three ways in, because the process may not be this host's child:
   *
   *   1. `hud.ps1 -shutdown` if the widget is still running. It is the only
   *      thing that can write "closed" *before* exiting, which is what stops the
   *      next launch from restoring it — the reason a close button that only
   *      killed the process looked broken.
   *   2. The child handle, when this host is the one that spawned it.
   *   3. The pid in `hud.pid`, for a widget left behind by a previous host
   *      generation. Without this the panel's 关闭悬浮窗 does nothing at all.
   *
   * The pid is only ever killed through PowerShell, after that script has
   * confirmed the process is really hud.ps1: a stale pid file read by a later
   * boot can name a completely unrelated program, and this must never be the
   * thing that kills it.
   */
  function stopHud() {
    const pid = liveHudPid()
    if (pid !== null && process.platform === 'win32' && existsSync(HUD_SCRIPT)) {
      try {
        childProcess.spawnSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HUD_SCRIPT, '-statePath', hudStatePath, '-port', '0', '-shutdown'],
          { encoding: 'utf8', timeout: 20000, windowsHide: true },
        )
      } catch (error) {
        ctx.logger?.warn?.('[orbit-time] could not ask the widget to close: ' + (error?.message ?? error))
      }
    }
    if (hudProcess !== null) {
      try {
        hudProcess.kill()
      } catch {
        /* ignore */
      }
      hudProcess = null
    } else if (pid !== null) {
      try {
        process.kill(pid)
      } catch (error) {
        ctx.logger?.warn?.('[orbit-time] could not stop the widget process: ' + (error?.message ?? error))
      }
    }
    clearHudPid()
    broadcast({ type: 'hud', running: false })
  }

  function webPort() {
    const port = ctx.webServer?.port
    return Number.isFinite(port) && port > 0 ? port : 0
  }

  /**
   * The dashboard URL the HUD opens on double-click.
   *
   * The web server's own port is authoritative, but it is `0` until the listener
   * binds — and passing `0` would give the widget a dead "open panel" button, so
   * the configured web URL is the fallback. An empty result is honest: hud.ps1
   * then builds the URL itself from `-port`, which is also empty, and the button
   * does nothing instead of opening a broken address.
   */
  function dashboardUrl() {
    const port = webPort()
    if (port > 0) return `http://127.0.0.1:${port}/`
    const configured = process.env.DSH_WEB_URL
    if (typeof configured === 'string' && /^https?:\/\//.test(configured)) {
      // DSH_WEB_URL carries no trailing slash; the widget opens this verbatim,
      // so normalize rather than assume one form.
      return configured.endsWith('/') ? configured : configured + '/'
    }
    return ''
  }

  /**
   * What the widget's own controls decided.
   *
   * The pill's × and the mini state's × write `hud-mode.json` before the process
   * exits. Without asking, the host would see a dead child and faithfully start
   * it again — a close button that does not close anything. `askHudMode` reads
   * that file through the widget itself, so there is exactly one implementation
   * of "where does the preference live".
   *
   * Returns 'pill' | 'mini' | 'closed', or null when it cannot be determined
   * (no script yet, PowerShell missing) — in which case the caller proceeds, so
   * a broken probe never makes the widget unlaunchable.
   */
  /**
   * Which of the three states the widget was left in, or null when it cannot be
   * determined.
   *
   * This spawns PowerShell, which costs about a second and blocks the host's
   * event loop for as long as it runs — and the panel asks on mount and on every
   * `/hud` GET. A host that stalls for a second per request reads as an app that
   * has stopped responding, which is a worse bug than the one being diagnosed.
   *
   * The cache is keyed on the preference file's mtime rather than on a clock:
   * the file *is* the answer, so when it has not changed the answer cannot have
   * changed either, and when anything writes it the next ask re-probes. A timed
   * cache could not make that promise — the widget writes the file the instant
   * the user closes it, and a stale "pill" at that moment is exactly the bug
   * where × appears to do nothing.
   */
  let hudModeCache = { mtime: null, state: null }
  /** The preference file's mtime, or null when it does not exist yet. */
  function hudModeStamp() {
    try {
      return statSyncLazy(join(stateDir, 'hud-mode.json')).mtimeMs
    } catch {
      return null
    }
  }
  function askHudMode() {
    if (process.platform !== 'win32' || !existsSync(HUD_SCRIPT)) return null
    if (hudModeStamp() === hudModeCache.mtime) return hudModeCache.state
    try {
      const result = childProcess.spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HUD_SCRIPT, '-statePath', hudStatePath, '-port', '0', '-keepClosed'],
        { encoding: 'utf8', timeout: 6000, windowsHide: true },
      )
      const text = String(result?.stdout ?? '').trim()
      if (text === '') return hudModeCache.state
      const parsed = JSON.parse(text.split(/\r?\n/).pop())
      const state = String(parsed.state ?? '')
      if (state === 'closed' || state === 'mini' || state === 'pill') {
        hudModeCache = { mtime: hudModeStamp(), state }
        return state
      }
      return null
    } catch (error) {
      ctx.logger?.warn?.('[orbit-time] could not read the HUD mode: ' + (error?.message ?? error))
      return null
    }
  }

  /**
   * Write the widget's mode preference on its behalf.
   *
   * The file is the widget's own storage — the panel is only allowed to write it
   * so the two agree on where the preference lives. The position is preserved,
   * because changing state should not move the window.
   */
  function writeHudModePreference(state) {
    const path = join(stateDir, 'hud-mode.json')
    let x = null
    let y = null
    try {
      if (existsSync(path)) {
        const current = JSON.parse(readFileSync(path, 'utf8'))
        if (Number.isFinite(current?.x)) x = current.x
        if (Number.isFinite(current?.y)) y = current.y
      }
    } catch {
      /* fall through to the defaults */
    }
    try {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(path, JSON.stringify({ state, x, y, at: new Date().toISOString() }), 'utf8')
    } catch (error) {
      ctx.logger?.warn?.('[orbit-time] could not write the HUD mode: ' + (error?.message ?? error))
    }
  }

  function startHud(options = {}) {
    const existing = liveHudPid()
    if (existing !== null) return { ok: true, running: true, pid: existing }
    if (process.platform !== 'win32') {
      return { ok: false, error: '悬浮窗目前只在 Windows 上可用。' }
    }
    if (!existsSync(HUD_SCRIPT)) {
      return { ok: false, error: `找不到悬浮窗脚本：${HUD_SCRIPT}` }
    }
    // `force` is the panel's explicit "show it again", which must win over a
    // previous close; the automatic launch on mount must not.
    if (options.force !== true && askHudMode() === 'closed') {
      return { ok: true, running: false, closedByUser: true }
    }
    writeHudState()
    const port = webPort()
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-STA',
      '-File',
      HUD_SCRIPT,
      '-statePath',
      hudStatePath,
      '-port',
      String(port),
      // The widget appends one line per interaction here. It is the only way to
      // tell "the window ignores my clicks" from "the window never got them".
      '-logPath',
      HUD_LOG,
    ]
    // Ask the widget which state to adopt, so a plain start honours the user's
    // last choice instead of always coming back as the full pill.
    const wanted = askHudMode()
    if (wanted === 'mini') args.push('-mode', 'mini')
    const url = dashboardUrl()
    if (url !== '') args.push('-dashboardUrl', url)
    const child = spawnProcess(ctx, 'powershell.exe', args, { windowsHide: true, detached: false, stdio: 'ignore' })
    hudProcess = child
    try {
      writeFileSync(hudPidPath, String(child.pid), 'utf8')
    } catch {
      /* ignore */
    }
    child.on('exit', () => {
      if (hudProcess === child) hudProcess = null
      try {
        if (existsSync(hudPidPath)) unlinkSync(hudPidPath)
      } catch {
        /* ignore */
      }
      broadcast({ type: 'hud', running: false })
    })
    child.on('error', (error) => {
      ctx.logger?.warn?.('[orbit-time] HUD failed to start: ' + (error?.message ?? error))
      if (hudProcess === child) hudProcess = null
    })
    broadcast({ type: 'hud', running: true })
    return { ok: true, running: true, pid: child.pid }
  }

  route('/hud', async (req, res) => {
    if (req.method === 'GET') {
      const pid = liveHudPid()
      sendJson(res, 200, { ok: true, running: pid !== null, pid, state: buildHudState() })
      return
    }
    const body = await readBody(req)
    const action = String(body.action ?? 'status')
    if (action === 'status') {
      // Read-only: probing the widget must never spawn it as a side effect.
      // `mode` reports which of the three states the user left it in, so the
      // panel can offer "show it again" instead of a button that does nothing.
      const mode = askHudMode()
      const pid = liveHudPid()
      sendJson(res, 200, {
        ok: true,
        running: pid !== null,
        pid,
        mode: mode ?? 'pill',
        closedByUser: mode === 'closed',
        state: buildHudState(),
      })
      return
    }
    if (action === 'stop') {
      stopHud()
      sendJson(res, 200, { ok: true, running: false })
      return
    }
    if (action === 'minimize') {
      // The widget owns its own transitions; asking it is done by launching it
      // with the mode it should adopt, which also covers "it is not running".
      if (liveHudPid() === null) {
        const started = startHud({ force: true })
        if (started.ok !== true) {
          sendJson(res, 200, started)
          return
        }
      }
      writeHudModePreference('mini')
      stopHud()
      sendJson(res, 200, startHud({ force: true }))
      return
    }
    if (action === 'restore') {
      writeHudModePreference('pill')
      stopHud()
      sendJson(res, 200, startHud({ force: true }))
      return
    }
    if (action !== 'start' && action !== 'restart') {
      sendJson(res, 400, { ok: false, error: `未知悬浮窗操作 ${action}` })
      return
    }
    if (action === 'restart') stopHud()
    // An explicit start or restart from the panel is a request to see the
    // widget, so it overrides a previous close.
    const result = startHud({ force: true })
    sendJson(res, 200, result)
  })

  route('/open-float', (req, res) => {
    // One host-owned floating window: a separate topmost process, because the
    // desktop shell exposes no window API to plugins.
    const result = startHud({ force: true })
    sendJson(res, 200, { ...result, hud: true, port: webPort(), dashboardUrl: dashboardUrl() })
  })

  route('/events-stream', (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    res.write(': orbit-time stream open\n\n')
    const send = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    }
    clients.add(send)
    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        /* closed */
      }
    }, 20_000)
    if (typeof keepAlive.unref === 'function') keepAlive.unref()
    req.on('close', () => {
      clearInterval(keepAlive)
      clients.delete(send)
    })
  })

  route('/export', (req, res) => {
    const payload = {
      exportedAt: new Date().toISOString(),
      excel: runtime.excel,
      events: runtime.events,
      overrides: runtime.overrides,
      lastExtraction: runtime.lastExtraction,
      settings,
    }
    const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8')
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="orbit-time-export-${localDayKey(new Date())}.json"`,
      'content-length': String(body.length),
    })
    res.end(body)
  })

  // ---- lifecycle -----------------------------------------------------------

  // Clock: drives the timer, reminders, and the day rollover.
  const stopTick = ctx.interval(() => {
    try {
      timerTick()
      reminderScan(new Date())
    } catch (error) {
      ctx.logger?.warn?.('[orbit-time] tick failed: %s', error?.message ?? error)
    }
  }, 1000)
  ctx.effect(() => stopTick, 'orbit-time: clock')

  // Workbook watcher: re-import when any configured file's mtime changes.
  let lastSignature = null
  const stopScan = ctx.interval(() => {
    if (settings.workbook.watch !== true) return
    const sources = configuredSources()
    if (sources.length === 0) return
    try {
      // One signature over every source, so adding a file or touching any one of
      // them triggers the same re-import path.
      const parts = []
      for (const source of sources) {
        const located = findWorkbookIn(source.path)
        if (located.error !== null || located.path === '') {
          parts.push(`${source.path}:missing`)
          continue
        }
        const stat = statSyncLazy(located.path)
        parts.push(`${located.path}:${stat.mtimeMs}:${stat.size}`)
      }
      const signature = parts.join('|')
      if (lastSignature === null) {
        lastSignature = signature
        /**
         * First tick of a session: if the rosters are configured but the schedule
         * is empty, the state file is the thing that was lost — not the workbook.
         * Rebuilding here means a wiped or stale `runtime.json` heals itself
         * within ten seconds of the host starting instead of waiting for the user
         * to notice an empty timeline and import again by hand.
         */
        if (runtime.events.length === 0) {
          ctx.logger?.info?.('[orbit-time] configured rosters but no events on record; rebuilding')
          void importWorkbook({}).catch((error) => {
            ctx.logger?.warn?.('[orbit-time] rebuild import failed: ' + (error?.message ?? error))
          })
        }
        return
      }
      if (signature === lastSignature) return
      lastSignature = signature
      ctx.logger?.info?.('[orbit-time] workbook changed, re-importing')
      void importWorkbook({}).catch((error) => {
        runtime.excel = {
          ...(runtime.excel ?? {}),
          lastError: error?.message ?? String(error),
          lastErrorAt: new Date().toISOString(),
        }
        persistSoon()
        pushFeed({
          kind: 'import',
          level: 'warn',
          title: '自动重新导入失败',
          body: error?.message ?? String(error),
        })
      })
    } catch (error) {
      ctx.logger?.warn?.('[orbit-time] watch failed: ' + (error?.message ?? error))
    }
  }, SCAN_INTERVAL_MS)
  ctx.effect(() => stopScan, 'orbit-time: workbook watch')

  // Pick up a config.json changed by something other than this panel.
  const stopConfigWatch = ctx.interval(applyExternalConfig, 1500)
  ctx.effect(() => stopConfigWatch, 'orbit-time: config watch')

  // Floating HUD: publish state and collect the widget's action requests.
  //
  // The publish used to be gated on `hudProcess !== null`, which made one killed
  // child fatal: the host's reference went null, the bridge stopped, and every
  // action the widget sent afterwards piled up unread. The user sees a widget
  // whose buttons do nothing and a timer that never counts down — and nothing in
  // the plugin said why. State and requests now flow whenever the HUD is enabled,
  // whoever owns the window.
  let bridgeTicks = 0
  let bridgePublished = null
  let bridgeProblems = []
  const stopHudTick = ctx.interval(() => {
    try {
      writeHudState()
      bridgeTicks += 1
      bridgePublished = new Date().toISOString()
      bridgeProblems = []
      // Only a widget this host started is asked for actions: an orphaned one
      // has no pipe back, and consuming its requests would apply actions twice.
      if (hudProcess !== null) readHudRequests()
      if (bridgeTicks % 8 === 0) writeHudStatus()
    } catch (error) {
      bridgeProblems = [String(error?.message ?? error)]
      ctx.logger?.warn?.('[orbit-time] HUD tick failed: %s', error?.message ?? error)
    }
  }, 700)
  ctx.effect(() => stopHudTick, 'orbit-time: HUD bridge')
  ctx.effect(() => () => stopHud(), 'orbit-time: HUD teardown')

  // First import attempt, right after the tree settles.
  ctx.timeout(() => {
    // A trace of this block, written before anything in it can fail.
    //
    // "The floating window never appeared" has three separate causes — the
    // scheduled start never ran, it ran and declined, or it ran and the spawn
    // failed — and from outside they look identical: no window, and a state file
    // that stopped being written. This records which one happened, in the order
    // the decisions were taken.
    const trace = []
    const note = (text) => {
      trace.push(`${new Date().toISOString()} ${text}`)
      try {
        writeFileSync(join(stateDir, 'hud-startup.log'), trace.join('\n') + '\n', 'utf8')
      } catch {
        /* the trace is a convenience */
      }
    }
    try {
      note(`startup block entered · workbook.path=${JSON.stringify(settings.workbook?.path ?? null)} · showFloatingWidget=${String(settings.ui?.showFloatingWidget)}`)
      // Reap a HUD orphaned by a previous host generation. The shutdown has to
      // go through hud.ps1: it is what writes "closed" before exiting, and it
      // checks the command line before killing anything, so a stale pid file can
      // never take an unrelated process down with it.
      try {
        if (existsSync(hudPidPath)) {
          const stale = Number(readFileSync(hudPidPath, 'utf8').trim())
          if (Number.isFinite(stale) && stale > 0) {
            if (process.platform === 'win32' && existsSync(HUD_SCRIPT)) {
              childProcess.spawnSync(
                'powershell.exe',
                ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HUD_SCRIPT, '-statePath', hudStatePath, '-port', '0', '-shutdown', '-keepClosed'],
                { encoding: 'utf8', timeout: 20000, windowsHide: true },
              )
            }
          }
          clearHudPid()
          note(`reaped the previous widget pid ${stale}`)
        } else {
          note('no previous widget pid to reap')
        }
      } catch (error) {
        note('reap failed: ' + (error?.message ?? error))
      }
      for (const name of (() => {
        try {
          return readdirSync(stateDir)
        } catch {
          return []
        }
      })()) {
        if (name.startsWith('hud-request-') || name.startsWith('hud-response-')) {
          try {
            unlinkSync(join(stateDir, name))
          } catch {
            /* ignore */
          }
        }
      }

      /**
       * The startup import is gated on "did anyone configure a roster", not on
       * `workbook.path`.
       *
       * This install lists its rosters in `workbook.sources` and leaves `path`
       * empty (the documented two-roster shape). The old guard read `path === ''`
       * as "nothing configured", skipped the import entirely, and left the panel
       * showing whatever `runtime.json` happened to hold — so losing that file
       * (a restart after a temp cleanup, a crashed write) meant an empty timeline
       * that never rebuilt itself. A roster in `sources` is just as configured.
       */
      const configuredNow = configuredSources()
      const explicitTarget = String(settings.workbook.path ?? '').trim() !== '' || (Array.isArray(settings.workbook.sources) && settings.workbook.sources.length > 0)
      if (!explicitTarget) {
        // Still worth starting the HUD: the timer works without a workbook.
        if (settings.ui.showFloatingWidget !== false) {
          note('no workbook configured; starting the widget')
          note('startHud -> ' + JSON.stringify(startHud()))
        } else {
          note('the widget is switched off in settings; not starting it')
        }
        return
      }
      note(`importing ${configuredNow.length} configured roster(s) first; events on file=${runtime.events.length}`)
      // `finally`, not `then`: a `.then` after a `.catch` is skipped whenever the
      // catch does not rethrow, so a workbook that failed to import also silently
      // cost the operator the floating widget. That is exactly the failure the
      // catch block above promises not to cause.
      void importWorkbook({})
        .catch((error) => {
          ctx.logger?.warn?.('[orbit-time] initial import failed: ' + (error?.message ?? error))
          runtime.excel = {
            ...(runtime.excel ?? {}),
            lastError: error?.message ?? String(error),
            lastErrorAt: new Date().toISOString(),
          }
          persistSoon()
          note('import failed: ' + (error?.message ?? error))
          // A missing or unreadable workbook must not cost the operator the timer
          // and the floating widget, so the HUD starts either way.
        })
        .finally(() => {
          if (settings.ui.showFloatingWidget !== false) {
            note('starting the widget after the import')
            note('startHud -> ' + JSON.stringify(startHud()))
          } else {
            note('the widget is switched off in settings; not starting it')
          }
        })
    } catch (error) {
      note('startup block threw: ' + (error?.message ?? error))
      ctx.logger?.warn?.('[orbit-time] HUD startup failed: ' + (error?.message ?? error))
    }
  }, 1200)

  ctx.logger?.info?.(
    '[orbit-time] ready · state=%s · owner=%s · events=%d',
    stateDir,
    activeNames().join('/') || '(未设置)',
    runtime.events.length,
  )
}
