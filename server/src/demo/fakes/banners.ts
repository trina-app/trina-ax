// The demo's banner maker (demo/fakes/index.ts DemoFakes.banners): draws a banner from the content folder's banner kit
// (banner.ts: a text-free photo made in advance under real type), so a visitor can change a banner's words. It is a
// local, built-in tool of this server (tools/demo-banner.ts change_banner_text), never a Higgsfield tool: the owner
// tried the demo (11-22) and got "AI가 Higgsfield에 이 내용을 보내려고 해요" for a headline change, although nothing
// leaves the machine. Higgsfield's generate_image stays the tool for a new background or photo.
//   <dataDir>/demo-fakes/state.json     the banners drawn (their size, scene and words: the next one starts from them)
//   <dataDir>/demo-fakes/banners/       the newest BANNERS_KEPT pictures (the disk cap)
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { FakeState, Generation } from './state'
import { BannerError, BANNER_SIZES, pickScene, renderBanner, sizeOf, type BannerKit, type BannerKitFile, type BannerSize, type BannerWords } from './banner'

/** a banner's photo is a prepared one; only its words were drawn */
export const PREPARED_BANNER = "The photo under the words is one of the demo's prepared photos: only the words were drawn new."
/** where the pictures are kept in the state folder (`<dataDir>/demo-fakes/banners/<id>.png`) */
export const BANNERS_DIR = 'banners'
/** the banners whose pictures are kept (the newest); an older one's picture is deleted */
export const BANNERS_KEPT = 30
const BANNER_PICTURE = /^banners\/([A-Za-z0-9_-]{1,64})\.png$/

/** The words as the AI wrote them, with a line break as a real one: the AI often writes "\n" as the two letters
 * backslash and n (the owner's card showed `작지 않아\n큰 햇살이야!`), sometimes "\r\n" or `<br>`. typst then draws a
 * real line break, never a backslash. */
export function withLineBreaks(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/(?:\\+r)?\\+n/g, '\n').replace(/<br\s*\/?>/gi, '\n')
}

/** the arguments of change_banner_text (tools/demo-banner.ts): every word optional */
export interface BannerArgs { size?: string; scene?: string; headline?: string; subline?: string; eyebrow?: string; badge?: string; badge_note?: string; button?: string }
export interface MadeBanner { id: string; png: Buffer; size: BannerSize; scene: string; words: BannerWords }

// ---- the banner's source: its words as a small text file in the team folder ----
// Owner's demo test 11-22: asked "흐린 아침 말고, 밝은 아침으로 해줘", the AI did not know the banner's words (they lived
// only in this server's state and an earlier tool result), rewrote the whole headline and dropped "작은 햇살". Plain
// Claude Code would read the file, edit one word and draw again. So each banner has a source file next to its pictures
// (the seed writes the launch banner's: scripts/demo/steepling/make.ts), the AI reads and edits it with the normal file
// tools, and change_banner_text draws the banner from it (tools/demo-banner.ts).

/** the source file's name, in the project's folder (else the person's own folder) */
export const BANNER_SOURCE_NAME = 'banner.json'
/** the source file's fields: the words as the tool names them, the photo (a scene id of the kit) and the sizes drawn */
export const BannerSourceFile = z.object({
  headline: z.string().max(300),
  subline: z.string().max(400).default(''),
  eyebrow: z.string().max(200).default(''),
  badge: z.string().max(80).default(''),
  badge_note: z.string().max(80).default(''),
  button: z.string().max(80).default(''),
  scene: z.string().max(300).optional(),
  sizes: z.array(z.enum(BANNER_SIZES)).min(1).max(3).optional(),
})
export type BannerSourceFile = z.infer<typeof BannerSourceFile>
export interface BannerSource { words: BannerWords; scene: string | null; sizes: BannerSize[] }

/** the launch banner as a source (the kit's words and scene, every size) */
export function launchSource(kit: BannerKitFile): BannerSource {
  return { words: { ...kit.words }, scene: kit.defaultScene ?? kit.scenes[0]!.id, sizes: [...BANNER_SIZES] }
}

/** The source file's text: one field per line, so changing a word is a one-line edit (a line break in a headline is "\n") */
export function bannerSourceText(src: BannerSource): string {
  const w = src.words
  const file: BannerSourceFile = { headline: w.headline, subline: w.subline, eyebrow: w.eyebrow, badge: w.badge, badge_note: w.badgeNote, button: w.cta, ...(src.scene ? { scene: src.scene } : {}), sizes: src.sizes }
  return `{\n${Object.entries(file).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}\n`
}

/** A source file's text as words, photo and sizes; a file that does not read fails with what to fix (never its text) */
export function parseBannerSource(text: string): BannerSource {
  let raw: unknown
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')) } catch (e) { throw new BannerError(`the banner's source is not valid JSON (${String((e as Error).message).slice(0, 160)}); fix the file and draw again`) }
  const r = BannerSourceFile.safeParse(raw)
  if (!r.success) throw new BannerError(`the banner's source does not read: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'file'}: ${i.message}`).join('; ').slice(0, 300)}`)
  const f = r.data
  const line = (v: string) => withLineBreaks(v)
  return {
    words: { headline: line(f.headline), subline: line(f.subline), eyebrow: line(f.eyebrow), badge: line(f.badge), badgeNote: line(f.badge_note), cta: line(f.button) },
    scene: f.scene?.trim() || null,
    sizes: f.sizes ? [...new Set(f.sizes)] : [...BANNER_SIZES],
  }
}

const cut = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? withLineBreaks(v).trim().slice(0, max) : undefined)

export class DemoBanners {
  constructor(private state: FakeState, private kit: BannerKit | null, private typst?: string | null) {}
  /** there is a banner kit to draw from */
  get ready(): boolean { return !!this.kit }
  /** the launch banner as a source (the first banner.json where none is yet), or null without a kit */
  launch(): BannerSource | null { return this.kit ? launchSource(this.kit) : null }

  /** The kit's photo for this size and scene under the words. Words not given, and the photo, are the last banner's
   * (the launch banner's words and scene at first). Only `scene` changes the photo: a headline whose words happen to
   * name a scene ("한 잔", "두 잔") keeps it (QA 11-22 A3: changing only the headline also changed the photo). */
  async make(a: BannerArgs): Promise<MadeBanner> {
    const kit = this.kit
    if (!kit) throw new BannerError('Banners are not set up in this demo.')
    const last = [...this.state.get().generations].reverse().find((g) => g.banner)?.banner
    const size: BannerSize = a.size === undefined && last && (BANNER_SIZES as readonly string[]).includes(last.size) ? last.size as BannerSize : sizeOf(a.size)
    const base: BannerWords = last?.words ?? kit.words
    const headline = cut(a.headline, 300)
    const words: BannerWords = {
      headline: headline ?? base.headline,
      subline: cut(a.subline, 400) ?? base.subline,
      eyebrow: cut(a.eyebrow, 200) ?? base.eyebrow,
      badge: cut(a.badge, 80) ?? base.badge,
      badgeNote: cut(a.badge_note, 80) ?? base.badgeNote,
      cta: cut(a.button, 80) ?? base.cta,
    }
    // the photo: the scene asked for; else the last banner's (the launch banner's at first); else, when that scene has
    // no photo in this size, the closest one that has
    const asked = typeof a.scene === 'string' && a.scene.trim() ? a.scene.trim().slice(0, 300) : ''
    const keep = last ? last.scene : kit.defaultScene ?? kit.scenes[0]!.id
    const kept = kit.scenes.find((s) => s.id === keep && s.photos[size])
    // a scene's own id ("two-cups", as a banner's source names it) is that scene when it has this size
    const byId = asked ? kit.scenes.find((s) => s.id === asked && s.photos[size]) : undefined
    const scene = byId ?? (asked ? pickScene(kit, size, asked) : kept ?? pickScene(kit, size, words.headline))
    if (!scene) throw new BannerError(`No photo for ${size} in this demo.`)
    const png = await renderBanner(kit, size, scene, words, this.typst === undefined ? undefined : this.typst)
    const id = this.state.nextId('banner')
    const dir = path.join(path.dirname(this.state.file), BANNERS_DIR)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(dir, `${id}.png`), png, { mode: 0o600 })
    const prompt = `Banner ${size}, ${scene.id}: ${words.headline.replace(/\n/g, ' / ')}`.slice(0, 4000)
    const g: Generation = { id, prompt, model: 'banner', picture: `${BANNERS_DIR}/${id}.png`, mime: 'image/png', createdAt: new Date().toISOString(), banner: { size, scene: scene.id, words } }
    this.state.update((d) => { d.generations.push(g) })
    this.pruneBanners(dir)
    return { id, png, size, scene: scene.id, words }
  }

  /** keep the pictures of the newest BANNERS_KEPT banners still in the state; delete every other file in the folder
   * (older banners, and those whose entry the state trimmed) */
  private pruneBanners(dir: string) {
    const keep = new Set(this.state.get().generations.filter((g) => BANNER_PICTURE.test(g.picture)).slice(-BANNERS_KEPT).map((g) => path.basename(g.picture)))
    let names: string[] = []
    try { names = fs.readdirSync(dir) } catch { return }
    for (const n of names) if (!keep.has(n)) { try { fs.rmSync(path.join(dir, n), { force: true }) } catch { /* next time */ } }
  }
}
