// The demo's banner maker (demo/fakes/index.ts DemoFakes.banners): draws a banner from the content folder's banner kit
// (banner.ts: a text-free photo made in advance under real type), so a visitor can change a banner's words. It is a
// local, built-in tool of this server (tools/demo-banner.ts change_banner_text), never a Higgsfield tool: the owner
// tried the demo (11-22) and got "AI가 Higgsfield에 이 내용을 보내려고 해요" for a headline change, although nothing
// leaves the machine. Higgsfield's generate_image stays the tool for a new background or photo.
//   <dataDir>/demo-fakes/state.json     the banners drawn (their size, scene and words: the next one starts from them)
//   <dataDir>/demo-fakes/banners/       the newest BANNERS_KEPT pictures (the disk cap)
import fs from 'node:fs'
import path from 'node:path'
import type { FakeState, Generation } from './state'
import { BannerError, BANNER_SIZES, pickScene, renderBanner, sizeOf, type BannerKit, type BannerSize, type BannerWords } from './banner'

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

const cut = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? withLineBreaks(v).trim().slice(0, max) : undefined)

export class DemoBanners {
  constructor(private state: FakeState, private kit: BannerKit | null, private typst?: string | null) {}
  /** there is a banner kit to draw from */
  get ready(): boolean { return !!this.kit }

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
    const scene = asked ? pickScene(kit, size, asked) : kept ?? pickScene(kit, size, words.headline)
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
