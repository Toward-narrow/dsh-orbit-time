// Read-only probe: dump the INTEGRITY resource payload from a PE file's .rsrc section.
import { readFileSync } from 'node:fs'

const buf = readFileSync(process.argv[2])
const e_lfanew = buf.readUInt32LE(0x3c)
const coff = e_lfanew + 4
const numSections = buf.readUInt16LE(coff + 2)
const optSize = buf.readUInt16LE(coff + 16)
let sp = coff + 20 + optSize
const sections = []
for (let i = 0; i < numSections; i++) {
  sections.push({
    name: buf.subarray(sp, sp + 8).toString('ascii').replace(/\0+$/, ''),
    vsize: buf.readUInt32LE(sp + 8),
    va: buf.readUInt32LE(sp + 12),
    rawSize: buf.readUInt32LE(sp + 16),
    rawPtr: buf.readUInt32LE(sp + 20),
  })
  sp += 40
}
const rsrc = sections.find((s) => s.name === '.rsrc')
const base = rsrc.rawPtr
const rva2off = (rva) => {
  for (const s of sections) if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return rva - s.va + s.rawPtr
  return -1
}
const nameOf = (entryOffset, nameField) => {
  if (!(nameField & 0x80000000)) return '#' + nameField
  const so = base + (nameField & 0x7fffffff)
  const len = buf.readUInt16LE(so)
  return buf.subarray(so + 2, so + 2 + len * 2).toString('utf16le')
}
const walk = (dirOff, depth, path) => {
  const named = buf.readUInt16LE(dirOff + 12)
  const ided = buf.readUInt16LE(dirOff + 14)
  for (let i = 0; i < named + ided; i++) {
    const e = dirOff + 16 + i * 8
    const nameField = buf.readUInt32LE(e)
    const offField = buf.readUInt32LE(e + 4)
    const label = nameOf(e, nameField)
    if (offField & 0x80000000) walk(base + (offField & 0x7fffffff), depth + 1, [...path, label])
    else {
      const dataEntry = base + offField
      const dataRva = buf.readUInt32LE(dataEntry)
      const size = buf.readUInt32LE(dataEntry + 4)
      const off = rva2off(dataRva)
      const bytes = buf.subarray(off, off + size)
      console.log(`RESOURCE ${[...path, label].join(' / ')} size=${size}`)
      if (size < 4096) console.log('   payload:', JSON.stringify(bytes.toString('utf8')))
      else console.log('   payload(head, utf16):', JSON.stringify(bytes.subarray(0, 400).toString('utf16le')))
    }
  }
}
walk(base, 0, [])
