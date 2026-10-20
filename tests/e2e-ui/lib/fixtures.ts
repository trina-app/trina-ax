// Files the owner uploads in the scenario: a Word document (pandoc), a spreadsheet (SheetJS), a PDF, a Markdown
// note with a fact only it contains (Claude has to find and summarise it), a PNG, and the 200 MB file for the
// chunked upload through the relay.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import * as XLSX from 'xlsx'
import { makePdf } from '../../lib/pdf'
import { WORK } from './dev'

export const FIX = path.join(WORK, 'fixtures')

/** the fact Claude must find in shared/ (only in the Markdown note) */
export const LAUNCH_FACT = { code: 'Project Kestrel', date: '2026-11-18', budget: '42,000' }
export const FINANCE_CANARY = 'FIN-SECRET-5531'

export interface Fixtures { docx: string; xlsx: string; pdf: string; md: string; png: string; notes: string; financeCsv: string }

function crc32(buf: Buffer): number {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

/** A small RGB PNG (gradient with a dark square), written without image libraries. */
export function makePng(w = 160, h = 100): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      const box = x > 50 && x < 110 && y > 25 && y < 75
      raw[o] = box ? 20 : Math.round((x / w) * 255)
      raw[o + 1] = box ? 40 : Math.round((y / h) * 255)
      raw[o + 2] = box ? 60 : 180
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

export function makeFixtures(): Fixtures {
  fs.mkdirSync(FIX, { recursive: true })
  const p = (n: string) => path.join(FIX, n)

  const md = [
    '# Launch plan',
    '',
    `The next product launch is **${LAUNCH_FACT.code}**. It goes live on ${LAUNCH_FACT.date}.`,
    `The approved marketing budget is ${LAUNCH_FACT.budget} USD, split 60% online ads and 40% events.`,
    '',
    '## Owners',
    '- Alice: campaign',
    '- Bob: budget tracking',
    '',
  ].join('\n')
  fs.writeFileSync(p('launch-plan.md'), md)

  // the shared note two people's AI edit at the same time (step 5)
  fs.writeFileSync(p('team-notes.md'), ['# Team notes', '', 'Status: draft', '', 'Next meeting: Monday', ''].join('\n'))

  const docSrc = p('brief.src.md')
  fs.writeFileSync(docSrc, '# Quarterly brief\n\nRevenue grew in Q3. This document is the brief for the board.\n\n| Region | Revenue |\n|---|---|\n| North | 120 |\n| South | 95 |\n')
  execFileSync('pandoc', [docSrc, '-o', p('brief.docx')])

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Month', 'Leads'], ['July', 310], ['August', 342], ['September', 401]]), 'Leads')
  fs.writeFileSync(p('leads.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))

  fs.writeFileSync(p('policy.pdf'), makePdf(['Travel policy', 'Book flights two weeks ahead.', 'Hotels up to 150 USD per night.']))
  fs.writeFileSync(p('diagram.png'), makePng())
  fs.writeFileSync(p('budget-2027.csv'), `item,amount\nsalaries,910000\nsecret code,${FINANCE_CANARY}\n`)

  return { docx: p('brief.docx'), xlsx: p('leads.xlsx'), pdf: p('policy.pdf'), md: p('launch-plan.md'), png: p('diagram.png'), notes: p('team-notes.md'), financeCsv: p('budget-2027.csv') }
}

/** A file of `mb` MB of pseudo-random bytes (written in 8 MB pieces); returns its path and sha256. */
export function makeBigFile(mb: number): { file: string; sha256: string } {
  fs.mkdirSync(FIX, { recursive: true })
  const file = path.join(FIX, `big-${mb}mb.bin`)
  const shaFile = `${file}.sha256`
  if (fs.existsSync(file) && fs.existsSync(shaFile) && fs.statSync(file).size === mb * 1024 * 1024) return { file, sha256: fs.readFileSync(shaFile, 'utf8').trim() }
  const fd = fs.openSync(file, 'w')
  const h = crypto.createHash('sha256')
  const piece = 8 * 1024 * 1024
  for (let i = 0; i < (mb * 1024 * 1024) / piece; i++) {
    const b = crypto.randomBytes(piece)
    h.update(b)
    fs.writeSync(fd, b)
  }
  fs.closeSync(fd)
  const sha = h.digest('hex')
  fs.writeFileSync(shaFile, sha)
  return { file, sha256: sha }
}

export function sha256File(file: string): string {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const b = Buffer.alloc(8 * 1024 * 1024)
  for (let n; (n = fs.readSync(fd, b, 0, b.length, null)) > 0;) h.update(b.subarray(0, n))
  fs.closeSync(fd)
  return h.digest('hex')
}
