// 내 스킬 가져오기 (docs/DECISIONS.md "K — 내 스킬 가져오기"): reads the skills in a folder the person picked or dropped
// and makes the body of POST /api/skill-shares. Nothing leaves the browser before this has filtered it:
//  - only known paths are opened. In a .claude folder: skills/*/ (a folder with SKILL.md: its files, at most 3 folders
//    down), plugins/**/skills/*/SKILL.md (only the name goes up, as excluded `plugin`; nothing in it is read),
//    commands/*.md and CLAUDE.md. A picked skills/ folder: each skill folder in it; a picked skill folder: that one.
//    projects/, todos/, history.jsonl, .credentials.json, settings*.json and the rest are never opened, nor listed:
//    the .claude folder itself is never listed, its known names are asked for one by one;
//  - text files (SHARE_TEXT_EXTENSIONS) go as text, small images as base64, script files as their path with no
//    content (the server judges whether the skill needs them; it never runs them), anything else stays behind;
//  - a skill with a file over SKILL_SHARE_LIMITS.fileBytes, over skillBytes or over skillFiles goes up as its name only
//    (excluded `too_big`); a secret file name (.env, *.pem, id_rsa …) or a text file in which findSecrets finds
//    anything (shared/src/secrets.ts) sends the name and the kind only (excluded `secret`), never the content;
//  - CLAUDE.md goes without the lines that hold a secret.
// Three ways in give the same walk (ScanDir): a File System Access handle (Chrome, Edge: fromHandle), a dropped folder
// (any browser: fromEntry, read lazily) and the file list of <input webkitdirectory> (Safari, Firefox and the desktop
// app, which lists every file of the picked folder: fromFiles, of which only the known paths are read).
import { findSecrets } from '@mycel/shared'
import { SHARE_IMAGE_EXTENSIONS, SHARE_SCRIPT_EXTENSIONS, SHARE_TEXT_EXTENSIONS, SKILL_SHARE_LIMITS, type CreateSkillShare, type ShareExcludedIn, type ShareFileIn, type ShareSkillIn, type SkillShareSource } from '@mycel/shared/api'
import { isSystemName } from './folderUpload'

/** A folder as the walk sees it: a child is asked for by name; `list` gives names only (nothing is opened). */
export interface ScanDir {
  readonly name: string
  /** the child folder of this name, or null (missing, or not a folder) */
  dir(name: string): Promise<ScanDir | null>
  /** the child file of this name, or null (missing, or not a file) */
  file(name: string): Promise<ScanFile | null>
  list(): Promise<{ name: string; kind: 'file' | 'directory' }[]>
}
export interface ScanFile {
  readonly name: string
  /** the file itself: its size is known without reading it */
  get(): Promise<Blob>
}

/** What the picked folder turned out to be. */
export type ScanKind = 'claude' | 'skills' | 'skill' | 'none'
export interface ScanResult {
  kind: ScanKind
  /** the body for POST /api/skill-shares; null when nothing was found */
  body: CreateSkillShare | null
  /** skills left out because there were more than SKILL_SHARE_LIMITS.skills */
  cut: number
}

/** Folders inside a skill that are never read (tooling, not the skill). Dot folders are skipped too. */
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv', 'dist', 'build'])
/** How far down a skill's own files are read: SKILL.md at 0, templates/a.md at 1, … a/b/c/x.md at 3. */
export const SKILL_DEPTH_MAX = 3
/** How far down plugins/ is searched for skills/ folders (marketplaces/<m>/plugins/<p>/skills/<s> is 5). */
const PLUGIN_DEPTH_MAX = 7
/** At most this many folders under plugins/ are looked at: plugin caches hold whole repositories. */
const PLUGIN_DIRS_MAX = 2000

/** File names that hold a key whatever is in them: never read, the skill goes as excluded `secret`. */
const SECRET_FILES: [RegExp, string][] = [
  [/^\.env(?:\..*)?$/i, 'env'],
  [/\.(?:pem|key|p12|pfx)$/i, 'private-key'],
  [/^id_(?:rsa|ed25519|ecdsa|dsa)/i, 'private-key'],
  [/^\.npmrc$/i, 'npm'],
  [/^\.netrc$/i, 'credentials'],
  [/^\.?credentials/i, 'credentials'],
]
export const secretFileKind = (name: string): string | null => SECRET_FILES.find(([re]) => re.test(name))?.[1] ?? null

const TEXT = new Set<string>(SHARE_TEXT_EXTENSIONS)
const IMAGE = new Set<string>(SHARE_IMAGE_EXTENSIONS)
const SCRIPT = new Set<string>(SHARE_SCRIPT_EXTENSIONS)
const extOf = (name: string) => {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** A name that can be one part of a path inside a skill: not empty, not "." or "..", no slash, backslash or NUL. */
export const safeName = (name: string) => !!name && name !== '.' && name !== '..' && !/[/\\\u0000]/.test(name)
const cap = (name: string) => name.normalize('NFC').slice(0, 100)

async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** One skill folder: its files as they go up, or why it cannot go. */
type Collected = { files: ShareFileIn[] } | { excluded: 'secret'; kind: string } | { excluded: 'too_big' }

async function collectSkill(root: ScanDir): Promise<Collected> {
  // first the names only: a key file's name excludes the skill before anything in it is read
  const listed: { dir: ScanDir; name: string; path: string; ext: string }[] = []
  let secret: string | null = null
  const walk = async (d: ScanDir, prefix: string, depth: number): Promise<void> => {
    for (const entry of await d.list()) {
      if (secret) return
      const name = entry.name.normalize('NFC')
      if (!safeName(entry.name) || isSystemName(name)) continue
      if (entry.kind === 'directory') {
        if (name.startsWith('.') || SKIP_DIRS.has(name) || depth >= SKILL_DEPTH_MAX) continue
        const child = await d.dir(entry.name)
        if (child) await walk(child, `${prefix}${name}/`, depth + 1)
        continue
      }
      secret = secretFileKind(name)
      if (secret || name.startsWith('.')) continue
      const ext = extOf(name)
      if (SCRIPT.has(ext) || TEXT.has(ext) || IMAGE.has(ext)) listed.push({ dir: d, name: entry.name, path: prefix + name, ext })
    }
  }
  await walk(root, '', 0)
  if (secret) return { excluded: 'secret', kind: secret }
  if (listed.length > SKILL_SHARE_LIMITS.skillFiles) return { excluded: 'too_big' }
  // then the contents, the size of each known before it is read
  const files: ShareFileIn[] = []
  let bytes = 0
  for (const x of listed) {
    if (SCRIPT.has(x.ext)) { files.push({ path: x.path, text: '' }); continue }
    const blob = await (await x.dir.file(x.name))?.get()
    if (!blob) continue
    bytes += blob.size
    if (blob.size > SKILL_SHARE_LIMITS.fileBytes || bytes > SKILL_SHARE_LIMITS.skillBytes) return { excluded: 'too_big' }
    if (TEXT.has(x.ext)) {
      const text = await blob.text()
      const found = findSecrets(text)
      if (found.length) return { excluded: 'secret', kind: found[0]!.kind }
      files.push({ path: x.path, text })
    } else files.push({ path: x.path, base64: await base64Of(blob) })
  }
  return { files }
}

/** CLAUDE.md as it goes up: at most SKILL_SHARE_LIMITS.ruleInBytes, without every line a secret touches (a key block
 * over several lines takes all of them). Null when nothing is left. */
export async function ruleText(blob: Blob): Promise<string | null> {
  const text = await blob.slice(0, SKILL_SHARE_LIMITS.ruleInBytes).text()
  const spans = findSecrets(text)
  const kept: string[] = []
  let at = 0
  for (const line of text.split('\n')) {
    const start = at
    const end = at + line.length
    at = end + 1
    if (!spans.some((s) => s.start <= end && s.end > start)) kept.push(line)
  }
  const out = kept.join('\n').slice(0, SKILL_SHARE_LIMITS.ruleInBytes)
  return out.trim() ? out : null
}

class Gather {
  skills: ShareSkillIn[] = []
  excluded: ShareExcludedIn[] = []
  cut = 0
  private names = new Set<string>()
  exclude(e: ShareExcludedIn) {
    if (this.excluded.length < SKILL_SHARE_LIMITS.excluded) this.excluded.push({ ...e, name: cap(e.name) })
  }
  get full() { return this.skills.length >= SKILL_SHARE_LIMITS.skills }
  /** one skill folder (it has a SKILL.md) */
  async skill(dir: ScanDir, origin: 'user' | 'project' = 'user') {
    if (this.full) { this.cut++; return }
    const c = await collectSkill(dir)
    if ('excluded' in c) this.exclude({ name: dir.name, origin, reason: c.excluded, ...(c.excluded === 'secret' ? { kind: c.kind } : {}) })
    else if (c.files.length) this.skills.push({ name: cap(dir.name), origin, files: c.files })
  }
  /** every folder of a skills/ folder: a skill when it has SKILL.md, else excluded `not_skill` */
  async skillsFolder(dir: ScanDir) {
    for (const entry of await dir.list()) {
      if (entry.kind !== 'directory' || !safeName(entry.name) || entry.name.startsWith('.') || isSystemName(entry.name)) continue
      const child = await dir.dir(entry.name)
      if (!child) continue
      if (await child.file('SKILL.md')) await this.skill(child)
      else this.exclude({ name: entry.name, reason: 'not_skill' })
    }
  }
  /** commands/*.md: each one a candidate of its own (listed under 그 밖에) */
  async commands(dir: ScanDir) {
    for (const entry of await dir.list()) {
      const name = entry.name.normalize('NFC')
      if (entry.kind !== 'file' || !safeName(entry.name) || name.startsWith('.') || extOf(name) !== 'md') continue
      const base = name.slice(0, -3)
      if (this.full) { this.cut++; continue }
      const blob = await (await dir.file(entry.name))?.get()
      if (!blob) continue
      if (blob.size > SKILL_SHARE_LIMITS.fileBytes) { this.exclude({ name: base, origin: 'command', reason: 'too_big' }); continue }
      const text = await blob.text()
      const found = findSecrets(text)
      if (found.length) this.exclude({ name: base, origin: 'command', reason: 'secret', kind: found[0]!.kind })
      else this.skills.push({ name: cap(base), origin: 'command', files: [{ path: name, text }] })
    }
  }
  /** plugins/**\/skills/*\/SKILL.md: names only (a plugin's skill is installed as the plugin, never copied) */
  async plugins(dir: ScanDir) {
    let seen = 0
    const walk = async (d: ScanDir, depth: number): Promise<void> => {
      for (const entry of await d.list()) {
        if (seen >= PLUGIN_DIRS_MAX) return
        if (entry.kind !== 'directory' || !safeName(entry.name) || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
        const child = await d.dir(entry.name)
        seen++
        if (!child) continue
        if (entry.name === 'skills') {
          for (const s of await child.list()) {
            if (s.kind !== 'directory' || !safeName(s.name) || s.name.startsWith('.')) continue
            const skill = await child.dir(s.name)
            const name = cap(s.name)
            if (skill && !this.names.has(name) && (await skill.file('SKILL.md'))) {
              this.names.add(name)
              this.exclude({ name, origin: 'plugin', reason: 'plugin' })
            }
          }
        } else if (depth < PLUGIN_DEPTH_MAX) await walk(child, depth + 1)
      }
    }
    await walk(dir, 1)
  }
}

/** Walk a picked or dropped folder (see the top of this file). */
export async function scanFolder(picked: ScanDir, source: Extract<SkillShareSource, 'browser' | 'desktop'>): Promise<ScanResult> {
  const g = new Gather()
  let root = picked
  let kind: ScanKind = 'none'
  let where = picked.name
  let rule: string | null = null
  // asked for by name, one at a time: the folder itself is never listed
  const probe = async (d: ScanDir) => ({ skillMd: await d.file('SKILL.md'), skills: await d.dir('skills'), plugins: await d.dir('plugins'), commands: await d.dir('commands'), claudeMd: await d.file('CLAUDE.md') })
  let p = await probe(root)
  // a project folder with its .claude in it
  if (!p.skillMd && !p.skills && !p.plugins && !p.commands && !p.claudeMd && root.name !== '.claude') {
    const inner = await root.dir('.claude')
    if (inner) { root = inner; p = await probe(root) }
  }
  if (p.skillMd) {
    kind = 'skill'
    await g.skill(root)
  } else if (p.skills || p.plugins || p.commands || p.claudeMd) {
    kind = 'claude'
    where = root.name === '.claude' ? '.claude' : root.name
    if (p.skills) await g.skillsFolder(p.skills)
    if (p.commands) await g.commands(p.commands)
    if (p.plugins) await g.plugins(p.plugins)
    if (p.claudeMd) rule = await ruleText(await p.claudeMd.get())
  } else {
    // a skills/ folder: by its name, or by a skill folder in it
    let skills = root.name === 'skills'
    if (!skills) {
      for (const entry of await root.list()) {
        if (entry.kind !== 'directory' || !safeName(entry.name) || entry.name.startsWith('.')) continue
        if (await (await root.dir(entry.name))?.file('SKILL.md')) { skills = true; break }
      }
    }
    if (skills) {
      kind = 'skills'
      where = root.name === 'skills' ? '.claude/skills' : root.name
      await g.skillsFolder(root)
    }
  }
  if (!g.skills.length && !g.excluded.length && !rule) return { kind: kind === 'none' ? 'none' : kind, body: null, cut: g.cut }
  const body: CreateSkillShare = { source, where: cap(where), skills: g.skills }
  if (g.excluded.length) body.excluded = g.excluded
  if (rule) body.rule = { text: rule }
  return { kind, body, cut: g.cut }
}

// ---- the three ways in

/** The parts of FileSystemDirectoryHandle used here (Chrome and Edge: showDirectoryPicker). */
export interface DirectoryHandleLike {
  readonly kind: 'directory'
  readonly name: string
  getDirectoryHandle(name: string): Promise<DirectoryHandleLike>
  getFileHandle(name: string): Promise<{ readonly name: string; getFile(): Promise<File> }>
  entries(): AsyncIterable<[string, { readonly kind: 'file' | 'directory' }]>
}

export function fromHandle(h: DirectoryHandleLike): ScanDir {
  return {
    name: h.name,
    async dir(name) {
      try { return fromHandle(await h.getDirectoryHandle(name)) } catch { return null }
    },
    async file(name) {
      try {
        const f = await h.getFileHandle(name)
        return { name: f.name, get: () => f.getFile() }
      } catch { return null }
    },
    async list() {
      const out: { name: string; kind: 'file' | 'directory' }[] = []
      for await (const [name, child] of h.entries()) out.push({ name, kind: child.kind })
      return out
    },
  }
}

/** The parts of FileSystemDirectoryEntry used here (a dropped folder, any browser). */
export interface DirectoryEntryLike {
  readonly name: string
  readonly isDirectory: boolean
  readonly isFile: boolean
  getDirectory(path: string, options: object, ok: (e: DirectoryEntryLike) => void, fail: (e: unknown) => void): void
  getFile(path: string, options: object, ok: (e: FileEntryLike) => void, fail: (e: unknown) => void): void
  createReader(): { readEntries(ok: (entries: (DirectoryEntryLike | FileEntryLike)[]) => void, fail: (e: unknown) => void): void }
}
export interface FileEntryLike {
  readonly name: string
  readonly isDirectory: boolean
  readonly isFile: boolean
  file(ok: (f: File) => void, fail: (e: unknown) => void): void
}

export function fromEntry(e: DirectoryEntryLike): ScanDir {
  return {
    name: e.name,
    dir: (name) => new Promise((resolve) => e.getDirectory(name, {}, (d) => resolve(d.isDirectory ? fromEntry(d) : null), () => resolve(null))),
    file: (name) => new Promise((resolve) => e.getFile(name, {}, (f) => resolve(f.isFile ? { name: f.name, get: () => new Promise<File>((ok, no) => f.file(ok, no)) } : null), () => resolve(null))),
    async list() {
      const reader = e.createReader()
      const out: { name: string; kind: 'file' | 'directory' }[] = []
      // one batch per call (Chromium: 100) and an empty batch at the end
      for (;;) {
        const batch = await new Promise<(DirectoryEntryLike | FileEntryLike)[]>((resolve, reject) => reader.readEntries(resolve, reject))
        if (!batch.length) return out
        for (const x of batch) out.push({ name: x.name, kind: x.isDirectory ? 'directory' : 'file' })
      }
    },
  }
}

interface Tree { dirs: Map<string, Tree>; files: Map<string, File> }
const tree = (): Tree => ({ dirs: new Map(), files: new Map() })
function dirOfTree(name: string, t: Tree): ScanDir {
  return {
    name,
    dir: async (n) => { const d = t.dirs.get(n.normalize('NFC')); return d ? dirOfTree(n, d) : null },
    file: async (n) => { const f = t.files.get(n.normalize('NFC')); return f ? { name: n, get: async () => f } : null },
    list: async () => [...[...t.dirs.keys()].map((n) => ({ name: n, kind: 'directory' as const })), ...[...t.files.keys()].map((n) => ({ name: n, kind: 'file' as const }))],
  }
}

/** The file list of <input webkitdirectory>: every file of the picked folder, each with its path from that folder
 * (webkitRelativePath). The walk reads only the known paths among them; a path with an empty, "." or ".." part is
 * dropped. Null without files. */
export function fromFiles(files: readonly File[]): ScanDir | null {
  const root = tree()
  let rootName: string | null = null
  for (const file of files) {
    const parts = (file.webkitRelativePath || file.name).normalize('NFC').split('/')
    if (parts.length < 2 || !parts.every(safeName)) continue
    rootName ??= parts[0]!
    if (parts[0] !== rootName) continue
    let t = root
    for (const part of parts.slice(1, -1)) {
      let next = t.dirs.get(part)
      if (!next) t.dirs.set(part, (next = tree()))
      t = next
    }
    t.files.set(parts[parts.length - 1]!, file)
  }
  return rootName === null ? null : dirOfTree(rootName, root)
}

/** The first folder of a drop, read in the drop event (the browser empties the list after it). */
export function droppedFolder(dt: { items?: ArrayLike<DataTransferItem> | null } | null): ScanDir | null {
  for (const item of Array.from(dt?.items ?? [])) {
    const entry = item.kind === 'file' ? item.webkitGetAsEntry?.() : null
    if (entry?.isDirectory) return fromEntry(entry as unknown as DirectoryEntryLike)
  }
  return null
}

// ---- what this browser can do

type PickerWindow = { showDirectoryPicker?: (o: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<DirectoryHandleLike> }

/** Chrome and Edge: the folder window gives a handle, and only what the walk asks for is opened. */
export const canPickHandle = () => typeof window !== 'undefined' && typeof (window as unknown as PickerWindow).showDirectoryPicker === 'function'
/** <input webkitdirectory>: Safari, Firefox, Chrome and the desktop app (not phones' browsers in practice). */
export const canPickInput = () => typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype

/** Open the folder window (Chrome, Edge). Null when the person closes it. Call it straight from a click. */
export async function pickClaudeFolder(): Promise<ScanDir | null> {
  try {
    const h = await (window as unknown as PickerWindow).showDirectoryPicker!({ id: 'claude', mode: 'read' })
    return fromHandle(h)
  } catch (e) {
    if ((e as { name?: string } | null)?.name === 'AbortError') return null
    throw e
  }
}
