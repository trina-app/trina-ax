// What the demo's fake services remember (demo/fakes/index.ts): the mail a visitor sent or drafted, label changes,
// the pictures they generated. One instance per visitor, so one file per data folder:
//   <dataDir>/demo-fakes/state.json   (0600 in a 0700 folder; written whole, through a temporary file)
// A file that cannot be read starts over empty (logged): the demo's content folder still holds everything seeded.
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

export const STATE_DIR = 'demo-fakes'
export const STATE_FILE = 'state.json'
/** the most the state keeps of each list (a loop cannot fill the disk); the oldest go first */
export const STATE_MAX_ITEMS = 500

const Mail = z.object({
  id: z.string().max(64),
  threadId: z.string().max(64),
  from: z.string().max(400),
  to: z.string().max(4000),
  cc: z.string().max(4000).optional(),
  bcc: z.string().max(4000).optional(),
  subject: z.string().max(1000),
  date: z.string().max(64),
  body: z.string().max(200_000),
  labels: z.array(z.string().max(100)).max(50),
  /** attachment names only (the bytes are never kept) */
  attachments: z.array(z.string().max(300)).max(50).optional(),
})
export type StoredMail = z.infer<typeof Mail>

const Generation = z.object({
  id: z.string().max(64),
  prompt: z.string().max(4000),
  model: z.string().max(100),
  /** the canned picture's file name (in the content folder) or "built-in" */
  picture: z.string().max(300),
  mime: z.string().max(100),
  createdAt: z.string().max(64),
  /** a banner change_banner_text drew (banners.ts): its size, scene and words (the next one starts from them) */
  banner: z.object({
    size: z.string().max(20),
    scene: z.string().max(40),
    words: z.object({ eyebrow: z.string().max(200), headline: z.string().max(300), subline: z.string().max(400), badge: z.string().max(80), badgeNote: z.string().max(80), cta: z.string().max(80) }),
  }).optional(),
})
export type Generation = z.infer<typeof Generation>

const State = z.object({
  v: z.literal(1),
  seq: z.number().int().min(0),
  sent: z.array(Mail).max(STATE_MAX_ITEMS),
  drafts: z.array(Mail).max(STATE_MAX_ITEMS),
  /** a message's labels as changed by the visitor (replaces its own labels) */
  labels: z.record(z.string().max(64), z.array(z.string().max(100)).max(50)),
  userLabels: z.array(z.object({ id: z.string().max(64), name: z.string().max(200) })).max(200),
  generations: z.array(Generation).max(STATE_MAX_ITEMS),
})
export type FakeStateData = z.infer<typeof State>

const empty = (): FakeStateData => ({ v: 1, seq: 0, sent: [], drafts: [], labels: {}, userLabels: [], generations: [] })

export class FakeState {
  readonly file: string
  private data: FakeStateData | null = null
  constructor(dataDir: string, private warn: (m: string) => void = () => {}) {
    this.file = path.join(dataDir, STATE_DIR, STATE_FILE)
  }

  get(): FakeStateData {
    if (this.data) return this.data
    let raw: string | null = null
    try { raw = fs.readFileSync(this.file, 'utf8') } catch { /* none yet */ }
    if (raw !== null) {
      try { this.data = State.parse(JSON.parse(raw)) } catch { this.warn('demo fakes: the saved state could not be read; starting over') }
    }
    return (this.data ??= empty())
  }

  /** a new id with this prefix ("m", "d", "job"): never one used before on this instance */
  nextId(prefix: string): string {
    const d = this.get()
    d.seq++
    return `${prefix}${Date.now().toString(36)}${d.seq.toString(36).padStart(3, '0')}`
  }

  /** change the state and write it down at once */
  update(fn: (d: FakeStateData) => void): void {
    const d = this.get()
    fn(d)
    for (const k of ['sent', 'drafts', 'generations'] as const) if (d[k].length > STATE_MAX_ITEMS) d[k].splice(0, d[k].length - STATE_MAX_ITEMS)
    this.save()
  }

  private save() {
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}
