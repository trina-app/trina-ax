// change_banner_text: the free-roam demo's banner words, changed on this server (demo/fakes/banners.ts). Offered only on a
// demo whose fakes have a banner kit. Before it the words were Higgsfield's make_banner, so a visitor who asked for a new
// headline got the connection's card "AI가 Higgsfield에 이 내용을 보내려고 해요 … 보낼까요?" and a step "Higgsfield ·
// Make banner" (owner, 11-22: "Higgsfield makes backgrounds; why does it say it's sending to Higgsfield?"). Nothing goes
// out for it: it is a local tool like make_file, with make_file's rule for a new team file (confirmSources: the
// wider-audience card only when more people can read the folder than what the chat read; placeProduced: the person's
// write access, a conflict copy, the file events) and no send card. The banner is saved at once into the chat's project
// folder (else the person's own folder) and comes back inline, with the Markdown image that shows it in the chat.
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { authorize } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import { componentC } from '../team-files/component'
import { inSkills } from '../skills/guard'
import { demoFakesOf } from '../demo/fakes'
import { BannerError } from '../demo/fakes/banner'
import { PREPARED_BANNER } from '../demo/fakes/banners'
import { confirmSources, placeProduced } from './make-file'
import type { ToolRegistry } from './registry'
import { savePathArg } from './save-target'

export const DEMO_BANNER_TOOL = 'change_banner_text'

const word = (what: string, max: number) => z.string().max(max * 2).optional().describe(what)
export const ChangeBannerTextInput = z.object({
  headline: word('the headline; a line break is "\\n"; *a word* in stars is italic (Latin letters)', 300),
  subline: word('the line under the headline', 400),
  eyebrow: word('the small line above the headline ("" for none)', 200),
  badge: word('the offer badge, e.g. "20% off" ("" for none)', 80),
  badge_note: word('beside the badge, e.g. "2 weeks only"', 80),
  button: word('the button\'s words ("" for none)', 80),
  size: z.enum(['1200x628', '1080x1080', '1080x1920']).optional().describe('web banner 1200x628, Instagram square 1080x1080, story 1080x1920 (default: the last banner\'s)'),
  scene: z.string().max(300).optional().describe('which of the prepared text-free photos, in a few words: one glass by the window, two glasses, the pouch close up, a café table. Give it when the user asks for another of these photos (e.g. a headline about two glasses with the two glasses); words alone never change the photo (default: the last banner\'s)'),
  save_as: z.string().max(500).optional().describe('team folder (ending in "/") or .png path to save into (default: this chat\'s project folder, else the user\'s own folder)'),
})

export const CHANGE_BANNER_TEXT_DESCRIPTION =
  'Change the words on the demo\'s ad banner (headline, the line under it, the offer badge, the button) or its size. Runs here on the server: ' +
  'the words are a text layer over a prepared text-free photo, so nothing is generated or sent anywhere. Give only the words that change ' +
  '(e.g. only `headline`); every word you leave out, the size and the photo stay as on the last banner (the launch banner at first). ' +
  'For a new background, photo or scene use Higgsfield\'s generate_image instead. The banner is saved at once into this chat\'s project folder ' +
  'and the result gives the Markdown image to show it in your answer.'

/** the folder of the chat's project this person may write, else their own folder */
function defaultFolder(ctx: AppContext, t: ToolCtx): string {
  const own = `users/${t.user.id}`
  if (!t.turnId) return own
  const r = ctx.db.query('SELECT p.folder_path FROM turns t JOIN chats c ON c.id = t.chat_id JOIN projects p ON p.id = c.project_id WHERE t.id = ? AND p.trashed_with IS NULL').get(t.turnId) as { folder_path: string } | null
  if (!r?.folder_path) return own
  const files = componentC(ctx).files
  try { authorize(files.fx, files.rules(), t.user, r.folder_path, 'write', { mustExist: false, createDirs: true }); return r.folder_path } catch { return own }
}

/** One line for the step and the audit log: the headline on one line ("작지 않아 큰 햇살이야!") */
export const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim()

export function registerDemoBanner(ctx: AppContext, reg: ToolRegistry): void {
  reg.register({
    name: DEMO_BANNER_TOOL,
    description: CHANGE_BANNER_TEXT_DESCRIPTION,
    input: ChangeBannerTextInput,
    available: () => !!demoFakesOf(ctx)?.banners.ready,
    describe: (a) => `${DEMO_BANNER_TOOL}${a.headline !== undefined ? ` "${oneLine(a.headline).slice(0, 120)}"` : ''}`,
    async run(a, t) {
      const banners = demoFakesOf(ctx)?.banners
      if (!banners?.ready) throw new ToolError('banners are not set up on this server')
      if (!t.turnId) throw new ToolError(`${DEMO_BANNER_TOOL} only works inside a chat turn`)
      const files = componentC(ctx).files
      // where it goes: save_as (a folder when it ends in "/"), else the project's folder; checked before drawing
      const wanted = a.save_as === undefined ? '' : savePathArg(a.save_as)
      const folder = !wanted ? defaultFolder(ctx, t) : wanted.endsWith('/') ? wanted.replace(/\/+$/, '') : null
      const targetFor = (name: string) => (folder !== null ? [folder, name].filter(Boolean).join('/') : /\.png$/i.test(wanted) ? wanted : `${wanted}.png`)
      const check = (target: string) => {
        if (inSkills(target)) throw new ToolError('a banner cannot be saved in a skills folder; pick another folder')
        return authorize(files.fx, files.rules(), t.user, target, 'write', { mustExist: false, createDirs: true }).segs
      }
      check(targetFor('banner.png'))
      let made
      try { made = await banners.make(a) } catch (e) {
        throw new ToolError(e instanceof BannerError ? e.message : 'the banner could not be made')
      }
      const name = `banner-${made.size}-${made.id.slice(-6)}.png`
      const target = targetFor(name)
      const segs = check(target)
      // the product's rule for a new team file the AI made from its own words (as make_file with no source)
      await confirmSources(ctx, files, t, target, segs, [])
      t.signal?.throwIfAborted()
      const workRoot = path.join(ctx.engineConfig.dataDir, 'work')
      fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 })
      const work = fs.mkdtempSync(path.join(workRoot, 'banner-'))
      try {
        const tmp = path.join(work, 'banner.png')
        fs.writeFileSync(tmp, made.png, { mode: 0o600, flag: 'wx' })
        const placed = await placeProduced(ctx, files, t, target.split('/').filter(Boolean), tmp, DEMO_BANNER_TOOL, undefined, { detail: { own: true }, thisAnswerOnly: true })
        const shown = placed.path.split('/').pop()!
        const w = made.words
        const view = { saved: placed.path, size: made.size, scene: made.scene, words: { headline: w.headline, subline: w.subline, eyebrow: w.eyebrow, badge: w.badge, badge_note: w.badgeNote, button: w.cta } }
        const text = `${JSON.stringify(view)}\n${PREPARED_BANNER}\nShow it in your answer as this Markdown image: ![${shown}](/api/files/download?path=${encodeURIComponent(placed.path)})` +
          (placed.conflictCopyOf ? `\n${placed.conflictCopyOf} already existed, so this was saved as a copy next to it.` : '')
        return {
          text,
          images: [{ type: 'image' as const, mimeType: 'image/png' as const, data: made.png.toString('base64') }],
          summary: `${DEMO_BANNER_TOOL} -> ${placed.path} ${placed.size}B ${made.size} ${made.scene}`,
          structured: { path: placed.path, size: placed.size, sha256: placed.sha256, banner: view },
        }
      } finally { fs.rmSync(work, { recursive: true, force: true }) }
    },
  })
}
