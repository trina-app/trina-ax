// Steepling's banner kit for the server's change_banner_text (server/src/demo/fakes/banner.ts): the launch banner as
// layers, a text-free photo per scene and size (../assets/banner/, made by make-backgrounds.py) plus its words, taken
// from the scripted story's own banner words (scripts/demo/mina/source/banners/copy.<locale>.json) so the first banner
// change_banner_text draws is the story's. Written into the content folder by make.ts:
//
//   fakes/higgsfield/banner/   kit.json, bg-<scene>-<size>.jpg, fonts/
//   fakes/higgsfield/<name>.jpg  the other scenes' web-size photos, for generate_image (picked by their names' words)
import fs from 'node:fs'
import path from 'node:path'
import { BannerKitFile } from '../../../../server/src/demo/fakes/banner'

const OWN = path.join(import.meta.dir, '..', 'assets', 'banner')
const COPY = path.join(import.meta.dir, '..', '..', 'mina', 'source', 'banners')

/** copy.<locale>.json's HTML (<br>, <em>) as change_banner_text's words ("\n", *italic*) */
export const plainWords = (html: string) => html.replace(/<br\s*\/?>/gi, '\n').replace(/<em>([\s\S]*?)<\/em>/gi, '*$1*').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&')

/** The scene of the story's launch banner (scripts/demo/mina/assets/campaign-banner.<locale>.jpg is this photo under
 * the same words and layout): change_banner_text's first banner uses it, so a words-only change keeps the photo. */
export const LAUNCH_SCENE = 'one-cup'

/** the other scenes' photos as generate_image pictures: `10-`… so the story's `00-` photo wins a tie */
export const SCENE_PICTURES: Record<string, string> = {
  'two-cups': '10-two-glasses-iced-yuzu-ginger-tea-pouch-two-cups-pair-두-잔-두잔-유리잔-파우치.jpg',
  pouch: '20-pouch-close-up-packshot-yuzu-ginger-파우치-클로즈업-제품-패키지.jpg',
  cafe: '30-cafe-table-marble-iced-yuzu-ginger-tea-pouch-카페-테이블-매장.jpg',
}

export function bannerKit(locale: string): BannerKitFile {
  const copy = JSON.parse(fs.readFileSync(path.join(COPY, `copy.${locale}.json`), 'utf8')) as Record<string, string>
  const { scenes } = JSON.parse(fs.readFileSync(path.join(OWN, 'scenes.json'), 'utf8')) as { scenes: BannerKitFile['scenes'] }
  if (!scenes.some((s) => s.id === LAUNCH_SCENE)) throw new Error(`banner kit: no scene ${LAUNCH_SCENE} in scenes.json`)
  return BannerKitFile.parse({
    lang: locale,
    brand: copy.brand,
    pouchName: copy.pouchName,
    pouchKind: copy.pouchKind,
    words: {
      eyebrow: plainWords(copy.eyebrow!), headline: plainWords(copy.headline!), subline: plainWords(copy.productLine!),
      badge: plainWords(copy.badge!), badgeNote: plainWords(copy.badgeDates!), cta: plainWords(copy.cta!),
    },
    defaultScene: LAUNCH_SCENE,
    scenes,
  })
}

/** Write the kit into a content folder (`out`, the folder holding fakes/). */
export function writeBannerKit(locale: string, out: string): void {
  const kit = bannerKit(locale)
  const dir = path.join(out, 'fakes', 'higgsfield', 'banner')
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'kit.json'), JSON.stringify(kit, null, 1) + '\n')
  for (const s of kit.scenes) for (const p of Object.values(s.photos)) fs.copyFileSync(path.join(OWN, p.file), path.join(dir, p.file))
  for (const f of fs.readdirSync(path.join(OWN, 'fonts'))) fs.copyFileSync(path.join(OWN, 'fonts', f), path.join(dir, 'fonts', f))
  for (const [scene, name] of Object.entries(SCENE_PICTURES)) {
    const p = kit.scenes.find((s) => s.id === scene)?.photos['1200x628']
    if (p) fs.copyFileSync(path.join(OWN, p.file), path.join(out, 'fakes', 'higgsfield', name))
  }
}
