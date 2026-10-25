// Read-only probe: Electron fuse wire + PE resource type names of an installed exe.
import { openSync, readSync, closeSync, readFileSync } from 'node:fs'

const exe = process.argv[2]
const buf = readFileSync(exe)

// ---- fuse wire ----
const SENT = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii')
let off = buf.indexOf(SENT)
const all = []
while (off >= 0) {
  all.push(off)
  off = buf.indexOf(SENT, off + 1)
}
console.log('sentinel occurrences:', all.length, all)
if (all.length > 0) {
  const s = all[0]
  const w = buf.subarray(s + SENT.length, s + SENT.length + 40)
  console.log('raw after sentinel (hex):', w.toString('hex').replace(/(..)/g, '$1 '))
  console.log('raw after sentinel (chr):', JSON.stringify(w.toString('latin1')))
}

// ---- PE resources ----
const e_lfanew = buf.readUInt32LE(0x3c)
const coff = e_lfanew + 4
const numSections = buf.readUInt16LE(coff + 2)
const optSize = buf.readUInt16LE(coff + 16)
const opt = coff + 20
const magic = buf.readUInt16LE(opt)
const sections = []
let sp = opt + optSize
for (let i = 0; i < numSections; i++) {
  const name = buf.subarray(sp, sp + 8).toString('ascii').replace(/\0+$/, '')
  sections.push({
    name,
    vsize: buf.readUInt32LE(sp + 8),
    va: buf.readUInt32LE(sp + 12),
    rawSize: buf.readUInt32LE(sp + 16),
    rawPtr: buf.readUInt32LE(sp + 20),
  })
  sp += 40
}
console.log('PE magic:', magic.toString(16), 'sections:', sections.map((s) => s.name).join(','))
const rva2off = (rva) => {
  for (const s of sections) if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return rva - s.va + s.rawPtr
  return -1
}
const rsrc = sections.find((s) => s.name === '.rsrc')
if (!rsrc) { console.log('no .rsrc section'); process.exit(0) }
const base = rsrc.rawPtr
const named = buf.readUInt16LE(base + 12)
const ided = buf.readUInt16LE(base + 14)
console.log('.rsrc namedEntries:', named, 'idEntries:', ided)
const types = []
for (let i = 0; i < named + ided; i++) {
  const e = base + 16 + i * 8
  const nameField = buf.readUInt32LE(e)
  if (nameField & 0x80000000) {
    const so = base + (nameField & 0x7fffffff)
    const len = buf.readUInt16LE(so)
    types.push(buf.subarray(so + 2, so + 2 + len * 2).toString('utf16le'))
  } else {
    types.push('#' + nameField)
  }
}
console.log('resource TYPE names:', JSON.stringify(types))
console.log('has ELECTRONASAR resource type:', types.includes('ELECTRONASAR'))
