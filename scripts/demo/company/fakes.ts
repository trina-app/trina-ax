// A demo content folder's fake Gmail, Google Drive and Higgsfield (the free-roam demo; scripts/demo/steepling/README.md
// "Fake Gmail, Drive and Higgsfield"). The server's demo fakes (server/src/demo/fakes/, decision
// docs/decisions/20261119-demo-fakes.md) read a folder named by the demo file's `fakes.content`:
//
//   gmail.json    { me: { name, email }, messages: [{ id?, threadId?, from, to, cc?, subject, date, body, labels?, attachments? }] }
//                 from/to/cc as "Name <address>"; date an ISO time or "-<n>d" / "-<n>h" / "-<n>m"; labels Gmail's
//                 (INBOX, SENT, UNREAD …; default INBOX, or SENT for mail from `me`); attachments by file name
//   drive.json    { me: { name, email }, files: [{ id, name, mimeType?, parent?, text?, modifiedTime? }] }
//   higgsfield/   pictures (png, jpg, webp), picked by the words of their file names
//   higgsfield/banner/   optional: the banner kit (kit.json, text-free photos, fonts) change_banner_text draws (never Higgsfield)
//                 banners from (server/src/demo/fakes/banner.ts); copied whole
//
// These schemas check the same shapes here (the server's own are server/src/demo/fakes/gmail.ts and drive.ts and win
// where they differ), plus what the demo's content promises: every address a reserved `.example` one. The snapshot
// builder writes the folder into the snapshot as <base>/fakes/ with every relative time made an ISO time of the build,
// so mail, rooms and chats tell one story.
import fs from 'node:fs'
import path from 'node:path'
import { FakeDrive, FakeGmail, RELATIVE_TIME } from '../../../shared/src/demo-fakes'

export { FakeDrive, FakeGmail }

export const FAKES_DIR = 'fakes'
export const FAKE_GMAIL_FILE = 'gmail.json'
export const FAKE_DRIVE_FILE = 'drive.json'
export const FAKE_PICTURES_DIR = 'higgsfield'
export const FAKE_BANNER_DIR = 'banner'

export interface Fakes { gmail: FakeGmail | null; drive: FakeDrive | null; pictures: string[]; banner: boolean }

/** a relative time ("-90m") as an ISO time `now` minus that; an ISO time stays */
export function absoluteTime(d: string, now: number): string {
  const m = RELATIVE_TIME.exec(d)
  if (!m) return new Date(Date.parse(d)).toISOString()
  return new Date(now - Number(m[1]) * (m[2] === 'd' ? 86_400_000 : m[2] === 'h' ? 3_600_000 : 60_000)).toISOString()
}

/** Read <content>/fakes/; every problem goes to `problems`. */
export function readFakes(contentDir: string, problems: string[]): Fakes {
  const dir = path.join(contentDir, FAKES_DIR)
  const json = <T>(name: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }): T | null => {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) return null
    let raw: unknown
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { problems.push(`${FAKES_DIR}/${name} cannot be read: ${(e as Error).message}`); return null }
    const r = schema.safeParse(raw)
    if (!r.success) { problems.push(...r.error.issues.slice(0, 10).map((i) => `${FAKES_DIR}/${name} ${i.path.map(String).join('.') || '(top)'}: ${i.message}`)); return null }
    return r.data
  }
  const pics = path.join(dir, FAKE_PICTURES_DIR)
  const pictures = fs.existsSync(pics) ? fs.readdirSync(pics).filter((n) => !n.startsWith('.') && n !== FAKE_BANNER_DIR).sort() : []
  for (const n of pictures) if (!/\.(png|jpe?g|webp)$/i.test(n)) problems.push(`${FAKES_DIR}/${FAKE_PICTURES_DIR}/${n}: a png, jpg or webp picture`)
  const bannerDir = path.join(pics, FAKE_BANNER_DIR)
  const banner = fs.existsSync(bannerDir)
  if (banner && !fs.existsSync(path.join(bannerDir, 'kit.json'))) problems.push(`${FAKES_DIR}/${FAKE_PICTURES_DIR}/${FAKE_BANNER_DIR}: no kit.json`)
  return { gmail: json(FAKE_GMAIL_FILE, FakeGmail), drive: json(FAKE_DRIVE_FILE, FakeDrive), pictures, banner }
}

/** Copy <content>/fakes/ to `to`, relative times made absolute (the snapshot's <base>/fakes/). */
export function writeFakesAt(contentDir: string, fakes: Fakes, to: string, now: number): void {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 })
  if (fakes.gmail) {
    const out: FakeGmail = { ...fakes.gmail, messages: fakes.gmail.messages.map((m) => ({ ...m, date: absoluteTime(m.date, now) })) }
    fs.writeFileSync(path.join(to, FAKE_GMAIL_FILE), JSON.stringify(out, null, 2) + '\n', { mode: 0o600 })
  }
  if (fakes.drive) {
    const out: FakeDrive = { ...fakes.drive, files: fakes.drive.files.map((f) => (f.modifiedTime ? { ...f, modifiedTime: absoluteTime(f.modifiedTime, now) } : f)) }
    fs.writeFileSync(path.join(to, FAKE_DRIVE_FILE), JSON.stringify(out, null, 2) + '\n', { mode: 0o600 })
  }
  if (fakes.pictures.length) {
    fs.mkdirSync(path.join(to, FAKE_PICTURES_DIR), { recursive: true, mode: 0o700 })
    for (const n of fakes.pictures) fs.copyFileSync(path.join(contentDir, FAKES_DIR, FAKE_PICTURES_DIR, n), path.join(to, FAKE_PICTURES_DIR, n))
  }
  if (fakes.banner) fs.cpSync(path.join(contentDir, FAKES_DIR, FAKE_PICTURES_DIR, FAKE_BANNER_DIR), path.join(to, FAKE_PICTURES_DIR, FAKE_BANNER_DIR), { recursive: true })
}
