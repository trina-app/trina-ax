// change_banner_text: the free-roam demo's banner, drawn on this server from its source file (demo/fakes/banners.ts).
// Offered only on a demo whose fakes have a banner kit. Before it the words were Higgsfield's make_banner, so a visitor
// who asked for a new headline got the connection's card "AI가 Higgsfield에 이 내용을 보내려고 해요 … 보낼까요?" (owner,
// 11-22). Nothing goes out for it: it is a local tool like make_file, with make_file's rule for a new team file
// (confirmSources: the wider-audience card only when more people can read the folder than what the chat read;
// placeProduced: the person's write access, a conflict copy, the file events) and no send card.
//
// The words live in a small text file next to the banner's pictures, <project folder>/banner.json (the seed writes the
// launch banner's). The AI reads it and changes words with the normal read and edit tools, as plain Claude Code would
// ("흐린 아침 말고 밝은 아침" is a one-word edit), then calls this tool, which draws every size from it and saves the
// pictures. Owner's demo test 11-22: before, the AI had to retype every word as this tool's arguments without seeing
// them; it took a word on the banner for a new-scene request, rewrote the headline with made-up words and dropped
// "작은 햇살". The word arguments stay for older chats: they are written into the source first.
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { AppContext } from '../context'
import type { Principal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import { componentC } from '../team-files/component'
import { inSkills } from '../skills/guard'
import { demoFakesOf } from '../demo/fakes'
import { BannerError, type BannerWords } from '../demo/fakes/banner'
import { BANNER_SOURCE_NAME, bannerSourceText, parseBannerSource, PREPARED_BANNER, type BannerSource, type MadeBanner } from '../demo/fakes/banners'
import { readRegular, sha256 } from '../files/store'
import { confirmSources, placeProduced } from './make-file'
import type { ToolRegistry } from './registry'
import { savePathArg } from './save-target'

export const DEMO_BANNER_TOOL = 'change_banner_text'
/** the most a banner's source file may be (it holds a few lines of words) */
const SOURCE_MAX = 64 * 1024

const word = (what: string, max: number) => z.string().max(max * 2).optional().describe(`${what}. Older chats only: to change words, edit the banner's source file instead`)
export const ChangeBannerTextInput = z.object({
  source: z.string().max(500).optional().describe(`the banner's source file, a .json path in the team folder (default: ${BANNER_SOURCE_NAME} in this chat's project folder, else in the user's own folder; made from the launch banner when there is none)`),
  headline: word('the headline; a line break is "\\n"', 300),
  subline: word('the line under the headline', 400),
  eyebrow: word('the small line above the headline ("" for none)', 200),
  badge: word('the offer badge ("" for none)', 80),
  badge_note: word('beside the badge', 80),
  button: word('the button\'s words ("" for none)', 80),
  size: z.enum(['1200x628', '1080x1080', '1080x1920']).optional().describe('draw only this size this time (default: every size the source lists)'),
  scene: z.string().max(300).optional().describe('another of the prepared text-free photos, in a few words (one glass by the window, two glasses, the pouch close up, a café table), only when the user asks for another photo; it is written into the source'),
  save_as: z.string().max(500).optional().describe('team folder (ending in "/") to save the pictures into (default: the source file\'s folder)'),
})

export const CHANGE_BANNER_TEXT_DESCRIPTION =
  'Draw the demo\'s ad banner from its source file and save the pictures (every size). Runs here on the server: the words are a text layer over a prepared ' +
  'text-free photo, so nothing is generated or sent anywhere. The banner\'s words (headline, subline, eyebrow, badge, badge_note, button), its photo (scene) ' +
  `and its sizes are in a small JSON file, ${BANNER_SOURCE_NAME}, in this chat's project folder. To change words: read that file, edit only the words the user named ` +
  'with the edit tool (e.g. "change grey mornings to green mornings": replace grey with green; every other word stays), then call this tool to draw it again. ' +
  'For a new background, photo or scene use Higgsfield\'s generate_image instead. The chat shows the saved pictures by itself (each size labelled): never repeat them as Markdown images.'

/** the folder of the chat's project this person may write, else their own folder */
function defaultFolder(ctx: AppContext, user: Principal, chatId: string | null): string {
  const own = `users/${user.id}`
  if (!chatId) return own
  const r = ctx.db.query('SELECT p.folder_path FROM chats c JOIN projects p ON p.id = c.project_id WHERE c.id = ? AND p.trashed_with IS NULL').get(chatId) as { folder_path: string } | null
  if (!r?.folder_path) return own
  const files = componentC(ctx).files
  try { authorize(files.fx, files.rules(), user, r.folder_path, 'write', { mustExist: false, createDirs: true }); return r.folder_path } catch { return own }
}
const chatOfTurn = (db: Database, turnId: string): string | null => (db.query('SELECT chat_id FROM turns WHERE id = ?').get(turnId) as { chat_id: string } | null)?.chat_id ?? null

/** The banner's source file for this person in this chat: <project folder>/banner.json (else their own folder), and
 * whether it is there yet. The demo note names it every turn (chat/prompt.ts demoBannerSource). */
export function bannerSourceFor(ctx: AppContext, user: Principal, chatId: string | null): { path: string; exists: boolean } {
  const p = `${defaultFolder(ctx, user, chatId)}/${BANNER_SOURCE_NAME}`
  const files = componentC(ctx).files
  try { return { path: p, exists: !!authorize(files.fx, files.rules(), user, p, 'read', { mustExist: false }).exists } } catch { return { path: p, exists: false } }
}

/** What the result tells the AI about the pictures: the chat shows them already (ToolResult.stepImages), so its
 * answer says in words what changed and never repeats them as Markdown images or links (a retyped path showed one size
 * twice, 11-22). */
export const bannerShownText = (sizes: string[]) =>
  `The chat already shows ${sizes.length > 1 ? `these ${sizes.length} pictures` : 'this picture'} under this step, each labelled with its size (${sizes.join(', ')}). ` +
  'Do not write them as Markdown images or links in your answer (that would show a picture twice): say in words what changed.'

/** One line for the step and the audit log: the headline on one line ("작지 않아 큰 햇살이야!") */
export const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim()

/** the word arguments (older chats' calls) and the source's words they set */
const ARG_FIELDS = { headline: 'headline', subline: 'subline', eyebrow: 'eyebrow', badge: 'badge', badge_note: 'badgeNote', button: 'cta' } as const
type ArgField = keyof typeof ARG_FIELDS

export function registerDemoBanner(ctx: AppContext, reg: ToolRegistry): void {
  reg.register({
    name: DEMO_BANNER_TOOL,
    description: CHANGE_BANNER_TEXT_DESCRIPTION,
    input: ChangeBannerTextInput,
    available: () => !!demoFakesOf(ctx)?.banners.ready,
    describe: (a) => `${DEMO_BANNER_TOOL}${a.source ? ` ${a.source.slice(0, 200)}` : ''}${a.headline !== undefined ? ` "${oneLine(a.headline).slice(0, 120)}"` : ''}`,
    async run(a, t) {
      const banners = demoFakesOf(ctx)?.banners
      const launch = banners?.launch()
      if (!banners?.ready || !launch) throw new ToolError('banners are not set up on this server')
      if (!t.turnId) throw new ToolError(`${DEMO_BANNER_TOOL} only works inside a chat turn`)
      const files = componentC(ctx).files
      // the source: the path given (a .json file), else the project's banner.json (else the person's own folder)
      const sourceArg = a.source !== undefined ? savePathArg(a.source) : bannerSourceFor(ctx, t.user, chatOfTurn(ctx.db, t.turnId)).path
      if (!/\.json$/i.test(sourceArg)) throw new ToolError(`the banner's source is a .json file (e.g. ${BANNER_SOURCE_NAME}); give its path`)
      if (inSkills(sourceArg)) throw new ToolError('a banner\'s source cannot be in a skills folder')
      // a folder not made yet (a project with no files): the source is not there, and the first call makes it
      const at = (() => { try { return authorize(files.fx, files.rules(), t.user, sourceArg, 'read', { mustExist: false }) } catch (e) { if (e instanceof ToolError && e.code === 'not_found') return authorize(files.fx, files.rules(), t.user, sourceArg, 'write', { mustExist: false, createDirs: true }); throw e } })()
      let src: BannerSource
      let had: string | null = null
      if (at.exists) {
        if (at.st!.isDirectory()) throw new ToolError(`'${at.rel}' is a folder`)
        let bytes: Buffer
        try { bytes = readRegular(path.join(files.fx.root, ...at.segs), SOURCE_MAX, at.st).bytes } catch { throw new ToolError(`'${at.rel}' could not be read as a banner's source (at most ${SOURCE_MAX / 1024} KB)`) }
        had = bytes.toString('utf8')
        try { src = parseBannerSource(had) } catch (e) { throw new ToolError(e instanceof BannerError ? `${at.rel}: ${e.message}` : 'the banner\'s source could not be read') }
        // read here: a change below replaces the file as read in this answer, never one changed since (placeProduced)
        t.files.readHashes.set(at.rel, sha256(bytes))
      } else src = launch
      // an older chat's word arguments, and a photo asked for, go into the source first
      const words: BannerWords = { ...src.words }
      const given = (Object.keys(ARG_FIELDS) as ArgField[]).filter((k) => typeof a[k] === 'string')
      for (const k of given) words[ARG_FIELDS[k]] = a[k]!
      const scene = a.scene?.trim() ? a.scene.trim() : src.scene
      // where the pictures go: save_as (a folder), else the source's folder; checked before drawing
      const wanted = a.save_as === undefined ? '' : savePathArg(a.save_as)
      if (wanted && /\.\w+$/.test(wanted.replace(/\/+$/, '')) && !wanted.endsWith('/')) throw new ToolError('save_as is a folder (ending in "/"): every size is saved there')
      const folder = wanted ? wanted.replace(/\/+$/, '') : at.segs.slice(0, -1).join('/')
      const targetFor = (name: string) => [folder, name].filter(Boolean).join('/')
      const check = (target: string) => {
        if (inSkills(target)) throw new ToolError('a banner cannot be saved in a skills folder; pick another folder')
        return authorize(files.fx, files.rules(), t.user, target, 'write', { mustExist: false, createDirs: true }).segs
      }
      check(targetFor('banner.png'))
      const made: MadeBanner[] = []
      for (const size of a.size ? [a.size] : src.sizes) {
        try { made.push(await banners.make({ size, scene: scene ?? undefined, headline: words.headline, subline: words.subline, eyebrow: words.eyebrow, badge: words.badge, badge_note: words.badgeNote, button: words.cta })) } catch (e) {
          throw new ToolError(e instanceof BannerError ? e.message : 'the banner could not be made')
        }
        t.signal?.throwIfAborted()
      }
      const first = made[0]!
      const name = (m: MadeBanner) => targetFor(`banner-${m.size}-${m.id.slice(-6)}.png`)
      // the product's rule for a new team file the AI made: the source it read counts (as make_file's sources)
      await confirmSources(ctx, files, t, name(first), check(name(first)), had === null ? [] : [at.rel])
      t.signal?.throwIfAborted()
      const workRoot = path.join(ctx.engineConfig.dataDir, 'work')
      fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 })
      const work = fs.mkdtempSync(path.join(workRoot, 'banner-'))
      try {
        // the source as drawn: written when there was none, or when this call's arguments changed it (the AI's own
        // edits are in it already)
        let sourceSaved = at.rel
        const next = bannerSourceText({ words: first.words, scene: first.scene, sizes: src.sizes })
        if (had === null || ((given.length || a.scene?.trim()) && next !== had)) {
          const tmp = path.join(work, BANNER_SOURCE_NAME)
          fs.writeFileSync(tmp, next, { mode: 0o600, flag: 'wx' })
          sourceSaved = (await placeProduced(ctx, files, t, at.segs, tmp, DEMO_BANNER_TOOL, undefined, { detail: { own: true } })).path
        }
        const saved: { path: string; size: string; bytes: number; sha256: string; conflictCopyOf?: string }[] = []
        for (const m of made) {
          const segs = check(name(m))
          const tmp = path.join(work, `${m.id}.png`)
          fs.writeFileSync(tmp, m.png, { mode: 0o600, flag: 'wx' })
          const placed = await placeProduced(ctx, files, t, segs, tmp, DEMO_BANNER_TOOL, undefined, { detail: { own: true }, thisAnswerOnly: true })
          saved.push({ path: placed.path, size: m.size, bytes: placed.size, sha256: placed.sha256, ...(placed.conflictCopyOf ? { conflictCopyOf: placed.conflictCopyOf } : {}) })
        }
        const w = first.words
        const view = { saved: saved[0]!.path, files: saved.map((x) => x.path), source: sourceSaved, size: first.size, scene: first.scene, words: { headline: w.headline, subline: w.subline, eyebrow: w.eyebrow, badge: w.badge, badge_note: w.badgeNote, button: w.cta } }
        const text = `${JSON.stringify(view)}\n` +
          `The banner's words are in ${sourceSaved}: to change them, edit that file (only the words the user named), then call ${DEMO_BANNER_TOOL} again.\n` +
          `${PREPARED_BANNER}\n${bannerShownText(saved.map((x) => x.size))}` +
          saved.filter((x) => x.conflictCopyOf).map((x) => `\n${x.conflictCopyOf} already existed, so this was saved as a copy next to it.`).join('')
        return {
          text,
          images: [{ type: 'image' as const, mimeType: 'image/png' as const, data: first.png.toString('base64') }],
          summary: `${DEMO_BANNER_TOOL} -> ${saved.map((x) => `${x.path} ${x.bytes}B`).join(', ')} ${first.scene}`,
          structured: { path: saved[0]!.path, size: saved[0]!.bytes, sha256: saved[0]!.sha256, files: saved, banner: view },
          // the chat shows every saved size under this step itself, each labelled with its size: the AI retyped the
          // Markdown before and showed the 1080x1080 file twice and the story size never (replay, 11-22)
          stepImages: saved.map((x) => ({ path: x.path, alt: `banner ${x.size}`, label: x.size })),
        }
      } finally { fs.rmSync(work, { recursive: true, force: true }) }
    },
  })
}
