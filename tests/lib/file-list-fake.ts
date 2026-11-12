// A stand-in for the file list's reader model (server/src/file-list/reader.ts Reader): no model is ever called in
// tests. It answers one JSON line per file of a call, from what the server sent it, and records every call (the paths,
// the blocks) so a test can tell what was read and that a call held files of one access unit only.
import type { Block, Reader, ReaderAnswer } from '../../server/src/file-list/reader'

export interface FakeFile { id: number; path: string; text: string; images: number }
export interface FakeCall { files: FakeFile[]; blocks: Block[] }

/** The files of one call, read back from its blocks. */
export function filesOf(blocks: Block[]): FakeFile[] {
  const out: FakeFile[] = []
  let cur: FakeFile | null = null
  for (const b of blocks) {
    if (b.type === 'image') { if (cur) cur.images++; continue }
    const m = /^<file id="(\d+)" path="([^"]*)"[^>]*>(?: images?:)?\n?([\s\S]*?)(?:\n<\/file>)?$/.exec(b.text)
    if (m) { cur = { id: Number(m[1]), path: m[2]!, text: m[3] ?? '', images: 0 }; out.push(cur) }
  }
  return out
}

/** The default answer: a "document" whose phrase quotes the start of the file's own text (so a leak of one file's
 * text into another file's list would show), and the CANARY tokens it holds as names. */
export function defaultAnswer(f: FakeFile): Record<string, unknown> {
  const first = f.text.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').slice(0, 60) ?? ''
  const canaries = [...f.text.matchAll(/CANARY-[A-Z]+-\d+/g)].map((m) => m[0])
  return { id: f.id, type: f.images ? 'photo' : 'document', names: [...new Set(canaries)].slice(0, 4), date: '', what: first || 'a picture', lang: 'en' }
}

export class FakeReader implements Reader {
  readonly engine = 'fake' as const
  readonly model = 'fake-model'
  images = true
  calls: FakeCall[] = []
  /** what the "model" writes for one call (default: one defaultAnswer line per file) */
  answer: (files: FakeFile[]) => string = (files) => files.map((f) => JSON.stringify(defaultAnswer(f))).join('\n')
  /** throw this (a limit, a failure) on the next calls */
  fail: Error | null = null
  async read(blocks: Block[], signal: AbortSignal): Promise<ReaderAnswer> {
    signal.throwIfAborted()
    const files = filesOf(blocks)
    this.calls.push({ files, blocks })
    if (this.fail) throw this.fail
    return { text: this.answer(files), usage: { input: 100 * files.length, output: 20 * files.length, costUsd: 0.0001 * files.length } }
  }
  /** every path read so far */
  paths(): string[] { return this.calls.flatMap((c) => c.files.map((f) => f.path)) }
  reset() { this.calls = []; this.fail = null }
}
