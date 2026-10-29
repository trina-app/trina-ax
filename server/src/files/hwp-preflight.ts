// Runs ONLY in the isolated worker. Bounds expansion before rhwp parses or lays out a document.
import fs from 'node:fs'
import { SaxesParser } from 'saxes'
import zlib from 'node:zlib'
import * as XLSX from 'xlsx'
import { HWP_LIMITS as L, type HwpReason } from '@mycel/shared/hwp'
import { imageSize } from '../uploads/image'
import { checkZip, isZip } from './zip-guard'

const reject = (reason: HwpReason): never => { throw new Error(reason) }
export function preflight(bytes: Uint8Array, ext: string) {
  if (!bytes.length) reject('damaged')
  if (bytes.length > L.inputBytes) reject('limit')
  const zip = isZip(bytes)
  if (zip !== (ext === 'hwpx')) reject('unsupported')
  if (zip) {
    try { checkZip(bytes, { total: L.expandedBytes, entries: L.entries }) } catch (e) {
      const s = String(e)
      reject(/encrypted/.test(s) ? 'locked' : /complex|larger|expands/.test(s) ? 'limit' : 'damaged')
    }
  } else if (Buffer.from(bytes.subarray(0, 8)).toString('hex') !== 'd0cf11e0a1b11ae1') reject('unsupported')
  let c: { FullPaths: string[]; FileIndex: { content?: Uint8Array | number[] }[] }
  try { c = XLSX.CFB.read(Buffer.from(bytes), { type: 'buffer' }) } catch { return reject('damaged') }
  if (c.FileIndex.length > L.entries) reject('limit')
  const parts = c.FullPaths.map((p, i) => ({ name: p.replace(/^Root Entry\//, ''), bytes: Buffer.from(c.FileIndex[i]?.content ?? []) }))
  let expanded = 0, cells = 0
  const image = (b: Uint8Array) => {
    const size = imageSize(b)
    if (!size) reject('unsupported')
    if (size!.width * size!.height > 16_000_000) reject('limit')
  }
  const count = (b: Uint8Array) => { expanded += b.length; if (expanded > L.expandedBytes) reject('limit') }
  if (zip) {
    let sections = 0
    for (const p of parts) {
      count(p.bytes)
      if (/^BinData\//i.test(p.name) && p.bytes.length) image(p.bytes)
      if (/encrypt|drm/i.test(p.name)) reject('locked')
      if (!/\.xml$|\.hpf$|\.rdf$/i.test(p.name)) continue
      const xml = new TextDecoder('utf-8', { fatal: true }).decode(p.bytes)
      // No DTD/entities, scripts, linked objects, or remote resources. A preview cannot resolve external files.
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) reject('unsupported')
      if (/<(?:\w+:)?(?:script|ole|video|audio)\b/i.test(xml)) reject('unsupported')
      if (/\b(?:href|src)\s*=\s*["'](?:https?:|file:|\/)/i.test(xml)) reject('unsupported')
      let depth = 0
      const parser = new SaxesParser({ xmlns: false })
      parser.on('error', () => reject('damaged'))
      parser.on('opentag', tag => {
        if (++depth > 64) reject('limit')
        for (const [key, value] of Object.entries(tag.attributes)) {
          if (/^(rowCnt|colCnt|rowSpan|colSpan)$/.test(key) && (!/^\d+$/.test(value) || +value > 256)) reject('limit')
        }
        if (/(?:^|:)tbl$/.test(tag.name)) {
          const rows = Number(tag.attributes.rowCnt ?? 0), cols = Number(tag.attributes.colCnt ?? 0)
          if (rows * cols > L.cells) reject('limit')
        }
        if (/(?:^|:)tc$/.test(tag.name) && ++cells > L.cells) reject('limit')
      })
      parser.on('closetag', () => { depth-- })
      parser.write(xml).close()
      if (/^Contents\/section\d+\.xml$/i.test(p.name)) {
        if (!/<(?:\w+:)?sec\b/.test(xml) || !/<(?:\w+:)?p\b/.test(xml)) reject('damaged')
        sections++
      }
    }
    if (!sections) reject('damaged')
  } else {
    const header = parts.find(p => p.name === 'FileHeader')?.bytes
    if (!header || header.length < 40 || header.subarray(0, 17).toString() !== 'HWP Document File') reject('unsupported')
    const flags = header!.readUInt32LE(36)
    if (flags & 2) reject('locked')
    if (flags & 4) reject('distribution')
    if (flags & (16 | 256 | 512)) reject('unsupported')
    let sections = 0
    for (const p of parts) {
      if (!p.bytes.length) continue
      let b = p.bytes
      if (/^(BodyText\/Section\d+|DocInfo)$/.test(p.name)) {
        if (flags & 1) {
          try { b = zlib.inflateRawSync(b, { maxOutputLength: Math.max(1, L.expandedBytes - expanded) }) } catch { reject('limit') }
        }
        for (let i = 0; i < b.length;) {
          if (i + 4 > b.length) reject('damaged')
          const h = b.readUInt32LE(i); i += 4
          let len = h >>> 20
          if (len === 4095) { if (i + 4 > b.length) reject('damaged'); len = b.readUInt32LE(i); i += 4 }
          if (i + len > b.length) reject('damaged')
          if (((h >>> 10) & 1023) > 64) reject('limit')
          // HWPTAG_TABLE: flags:u32, rowCount:u16, colCount:u16.
          if ((h & 1023) === 77) {
            if (len < 8) reject('damaged')
            const rows = b.readUInt16LE(i + 4), cols = b.readUInt16LE(i + 6)
            cells += rows * cols
            if (rows > L.rows || cols > L.cols || cells > L.cells) reject('limit')
          }
          i += len
        }
        if (p.name.startsWith('BodyText/')) sections++
      }
      if (/^BinData\//i.test(p.name)) {
        if (flags & 1) { try { b = zlib.inflateRawSync(b, { maxOutputLength: Math.max(1, L.expandedBytes - expanded) }) } catch { /* BinData may be stored uncompressed. Pixel signature still required. */ } }
        image(b)
      }
      if (/Ole/i.test(p.name)) reject('unsupported')
      count(b)
    }
    if (!sections) reject('damaged')
  }
}
if (import.meta.main) {
  try { preflight(fs.readFileSync(process.argv[2]!), process.argv[3]!); process.stdout.write('ok') }
  catch (e) { process.stdout.write(['locked','distribution','damaged','unsupported','limit'].includes((e as Error).message) ? (e as Error).message : 'damaged'); process.exitCode = 3 }
}
