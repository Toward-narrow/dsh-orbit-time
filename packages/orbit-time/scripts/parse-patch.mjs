/**
 * Read the `orbit-time` entry out of a DSH profile patch layer.
 *
 * The `yaml` package the loader uses is packed inside the Electron asar and is
 * not importable from a profile script, so this carries its own reader for the
 * subset a loader patch actually uses: nested maps, block sequences, flow
 * sequences and flow maps, quoted and plain scalars. Anything it does not
 * understand throws rather than being guessed at — a silently wrong config is
 * worse than a loud failure.
 *
 * Kept in its own module so `test-patch-parser.mjs` can hold it to the real
 * profile file.
 */

/** Drop a YAML comment, ignoring `#` inside quotes. */
export function stripComment(line) {
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote !== null) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index)
  }
  return line
}

function prepare(text) {
  const rows = []
  for (const raw of text.split(/\r?\n/)) {
    const body = stripComment(raw)
    if (body.trim() === '') continue
    rows.push({ indent: body.length - body.replace(/^\s*/, '').length, body: body.trim() })
  }
  return rows
}

function parseNodes(rows, cursor, indent) {
  const first = rows[cursor.at]
  if (first === undefined) return null
  return first.body.startsWith('- ') ? parseSeq(rows, cursor, indent) : parseMap(rows, cursor, indent)
}

function parseSeq(rows, cursor, indent) {
  const out = []
  while (cursor.at < rows.length) {
    const row = rows[cursor.at]
    if (row.indent !== indent || !row.body.startsWith('- ')) break
    const inline = row.body.slice(2).trim()
    if (inline === '') {
      cursor.at += 1
      const next = rows[cursor.at]
      out.push(next === undefined || next.indent <= indent ? null : parseNodes(rows, cursor, next.indent))
      continue
    }
    if (/^[^:]+:(\s|$)/.test(inline)) {
      // Rewrite the dash line as the first key of an ordinary map, so a nested
      // sequence under a later sibling key (timeRules under a source) sees the
      // real rows and stops at the next dash on its own.
      rows[cursor.at] = { indent: indent + 2, body: inline }
      out.push(parseMap(rows, cursor, indent + 2))
      continue
    }
    cursor.at += 1
    out.push(scalar(inline))
  }
  return out
}

function parseMap(rows, cursor, indent) {
  const out = {}
  while (cursor.at < rows.length) {
    const row = rows[cursor.at]
    if (row.indent !== indent) break
    // A dash at a shallower indent ends this map; one at this indent is a
    // sequence under an earlier key, which is not this map's business.
    if (row.body.startsWith('- ')) break
    const at = row.body.indexOf(':')
    if (at === -1) throw new Error(`unsupported YAML line: ${row.body}`)
    const key = row.body.slice(0, at).trim()
    const rest = row.body.slice(at + 1).trim()
    cursor.at += 1
    if (rest === '') {
      const next = rows[cursor.at]
      out[key] = next === undefined || next.indent <= indent ? null : parseNodes(rows, cursor, next.indent)
    } else {
      out[key] = scalar(rest)
    }
  }
  return out
}

export function scalar(text) {
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim()
    return inner === '' ? [] : splitFlow(inner).map(scalar)
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    const inner = text.slice(1, -1).trim()
    const out = {}
    if (inner === '') return out
    for (const part of splitFlow(inner)) {
      const at = part.indexOf(':')
      out[part.slice(0, at).trim()] = scalar(part.slice(at + 1).trim())
    }
    return out
  }
  const quoted = /^"(.*)"$/s.exec(text) || /^'(.*)'$/s.exec(text)
  if (quoted) return quoted[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"')
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~' || text === '') return null
  if (/^-?\d+$/.test(text)) return Number(text)
  return text
}

/** Split a flow collection on commas that are not inside quotes. */
export function splitFlow(text) {
  const parts = []
  let current = ''
  let quote = null
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === ',') {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim() !== '') parts.push(current.trim())
  return parts
}

/**
 * Parse a whole patch layer and return the `orbit-time` entry, or null.
 *
 * A loader patch is either an override of an existing entry id or an `insert:`
 * list. Only the insert form can introduce a new plugin, so an entry found at
 * the top level is reported as the mistake it is rather than being returned as
 * if it worked — that is exactly the failure that made the plugin invisible.
 *
 * @param {string} text - raw YAML of the profile's cordis.patch.yml.
 */
export function readOrbitTimeConfig(text) {
  const entries = readPatchEntries(text)
  const inserted = []
  for (const patch of entries) {
    if (Array.isArray(patch.insert)) {
      for (const row of patch.insert) {
        if (row && typeof row === 'object') inserted.push(row)
      }
    }
  }
  const found = inserted.find((row) => row.id === 'orbit-time')
  if (found !== undefined) return found

  const topLevel = entries.find((patch) => patch.id === 'orbit-time' && patch.name !== undefined)
  if (topLevel !== undefined) {
    throw new Error(
      'the orbit-time entry is a top-level patch, which the loader treats as an OVERRIDE of an existing ' +
        'entry id. Wrap it in an `insert:` list or the plugin will never mount.',
    )
  }
  return null
}

/**
 * Parse a whole patch layer into its sequence of entries.
 *
 * Each `- ` at a given indent starts one entry; rows deeper than that dash, up
 * to the next dash at the same or shallower indent, belong to it. Keys sit two
 * columns right of the dash, which is the indent the map itself is parsed at.
 */
export function readPatchEntries(text) {
  const rows = prepare(text)
  const out = []
  let index = 0
  while (index < rows.length) {
    if (!rows[index].body.startsWith('- ')) {
      index += 1
      continue
    }
    const dashIndent = rows[index].indent
    const scoped = [{ indent: dashIndent + 2, body: rows[index].body.slice(2).trim() }]
    let probe = index + 1
    while (probe < rows.length) {
      const row = rows[probe]
      if (row.indent <= dashIndent && row.body.startsWith('- ')) break
      scoped.push(row)
      probe += 1
    }
    out.push(parseMap(scoped, { at: 0 }, dashIndent + 2))
    index = probe
  }
  return out
}
