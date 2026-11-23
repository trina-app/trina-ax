// `save_promo_video` (AI flow check FL-16, QA TC-3817): the chat's promo video saved as an .mp4 file in the team folder,
// so the person can send or share it (share_with_person, post_to_room) like any file. Before, the video was only the
// preview beside the chat and the AI could only tell the person to download it by hand.
// The MP4 is the same render as the preview's download button (render.ts): one render at a time on the server, a
// finished one reused. So the tool exists only where that render runs (mp4Available: a Linux team server with the list's
// video group, or a development Mac); elsewhere
// it is not offered, and the promo_video result tells the AI to say plainly that this server cannot save the video as a
// file. The file is placed like every file the AI makes (tools/make-file.ts placeProduced: the person's write access,
// a conflict copy over a file not read in this turn, the turn's write budget, the audit), and the files whose content
// is in the video (its material and pictures) are its sources: a save where more people can read than those files asks
// the person first (the wider-audience card, confirmSources), as make_file does. Never under skills/.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { HttpError } from '../http/errors'
import { badSegment } from '../policy/names'
import { Denied, ToolError } from '../policy/errors'
import { inSkills } from '../skills/guard'
import { componentC } from '../team-files/component'
import { confirmSources, placeProduced } from '../tools/make-file'
import type { ToolRegistry } from '../tools/registry'
import { DURATION } from './layout'
import { mp4Available, mp4Why, noFileReason, promoVideoFile, promoVideoInfo, renderPromoVideo, type StoredSpec } from './render'
import { teamPathOf } from './spec'

export const SAVE_PROMO_TOOL = 'save_promo_video'
export const SavePromoVideoInput = z.strictObject({
  save_as: z.string().trim().min(1).max(1000).optional()
    .describe('Team path of the .mp4 to write, e.g. "groups/marketing/videos/new-product.mp4". Default: the person\'s own folder (users/<id>/videos/<title>.mp4).'),
})

export const SAVE_PROMO_DESCRIPTION =
  `Save this chat's promo video (made with promo_video; ${DURATION} s with music) as an .mp4 file in the team folder, so it can be sent or shared like any file ` +
  '(share_with_person, post_to_room). Call it when the person wants the video as a file, or to send, share or post it. Rendering takes about a minute or two. ' +
  'Without `save_as` it goes to the person\'s own folder. The length is fixed by the template; it cannot be shortened.'

/** a render's wait: the render's own limit (4 minutes) and the queue in front of it */
const WAIT_MS = 10 * 60_000
let pollMs = 1000
/** Tests poll faster (null: back to one second). */
export function setSavePollForTests(ms: number | null) { pollMs = ms ?? 1000 }

/** the video's title as a file name; one the file rules would refuse (a reserved or too long name) is "promo-video" */
const fileTitle = (title: string) => {
  const t = [...title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, 60).join('')
  return t && !badSegment(`${t}.mp4`) ? t : 'promo-video'
}

/** The team files whose content is in the video: its material and its pictures. */
export function videoSources(spec: StoredSpec): string[] {
  const d = spec.doc
  const pics = [d.logo, d.promise.picture, d.work.picture, d.proof.picture].filter((p): p is NonNullable<typeof p> => !!p).map((p) => teamPathOf(p.src))
  return [...new Set([...spec.sources, ...pics])]
}

export async function savePromoVideo(ctx: AppContext, a: z.output<typeof SavePromoVideoInput>, t: ToolCtx): Promise<{ text: string; summary: string; structured: Record<string, unknown> }> {
  if (!t.turnId) throw new ToolError('save_promo_video only works inside a chat turn')
  const turn = ctx.db.query('SELECT chat_id, user_id FROM turns WHERE id = ?').get(t.turnId) as { chat_id: string; user_id: string } | null
  if (!turn) throw new ToolError('unknown turn')
  if (turn.user_id !== t.user.id) throw new Denied('turn belongs to another person')
  const why = mp4Why(ctx)
  if (why) throw new ToolError(`This server cannot save the promo video as a file (only the preview next to the chat is made here; ${noFileReason(why)}). Nothing was saved. Tell the person so in one plain sentence with that reason.`)
  // the newest version this person may see (never one an answer hidden from them made: Artifacts.hiddenVersions)
  const hidden = componentC(ctx).artifacts.hiddenVersions(t.user.id, turn.chat_id)
  const row = (ctx.db.query('SELECT artifact_id, spec FROM promo_videos WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC').all(turn.chat_id) as { artifact_id: string; spec: string }[]).find((r) => !hidden.has(r.artifact_id)) ?? null
  if (!row) throw new ToolError('There is no promo video in this chat yet: make it with promo_video first.')
  const spec = JSON.parse(row.spec) as StoredSpec
  // where: the person's own folder unless they named a place; never a skills folder (skills/guard.ts)
  // a save_as that ends in "/" is a folder: the file takes the video's title there
  const named = a.save_as?.replace(/^\/+/, '')
  const target = (named === undefined ? `users/${t.user.id}/videos/${fileTitle(spec.title)}` : named.endsWith('/') ? `${named}${fileTitle(spec.title)}` : named.replace(/\.mp4$/i, '')) + '.mp4'
  const segs = target.split('/').filter(Boolean)
  if (segs.some((s) => badSegment(s))) throw new ToolError(`'${target}' is not a valid file name`)
  if (inSkills(segs.join('/'))) throw new ToolError('videos cannot be saved in a skills folder (skills/, a group\'s or a project\'s: skills and rules people\'s AI follows); pick another folder')
  // the render (or the finished one), waited for within this answer
  // the person whose chat it is, or someone it is shared with who may open every picture in it (render.ts rowFor):
  // anyone else gets plain words
  let info: ReturnType<typeof renderPromoVideo>
  try { info = renderPromoVideo(ctx, t.user.id, row.artifact_id) } catch (e) {
    if (e instanceof HttpError) throw new ToolError('This person cannot save this promo video as a file: it shows pictures they cannot open. Nothing was saved. The person whose chat this is can save it.')
    throw e
  }
  const until = Date.now() + WAIT_MS
  while (info.mp4.state === 'rendering' && Date.now() < until) {
    t.signal?.throwIfAborted()
    await Bun.sleep(pollMs)
    info = promoVideoInfo(ctx, t.user.id, row.artifact_id)
  }
  if (info.mp4.state !== 'done') throw new ToolError(info.mp4.state === 'rendering'
    ? 'The video is still rendering; nothing was saved yet. Tell the person it takes a little longer and to ask again in a minute.'
    : 'The video could not be rendered to a file this time; nothing was saved. Tell the person so in one plain sentence; they can still play it next to the chat.')
  const files = componentC(ctx).files
  // the wider-audience card for its material and pictures, before anything is placed
  await confirmSources(ctx, files, t, segs.join('/'), segs, videoSources(spec))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-promo-'))
  try {
    const tmp = path.join(work, 'video.mp4')
    fs.copyFileSync(promoVideoFile(ctx, t.user.id, row.artifact_id).abs, tmp)
    const made = await placeProduced(ctx, files, t, segs, tmp, SAVE_PROMO_TOOL, undefined, { thisAnswerOnly: true, detail: { from: `promo video ${row.artifact_id}` } })
    const mb = (made.size / 1048576).toFixed(1)
    return {
      text: (made.conflictCopyOf
        ? `'${made.conflictCopyOf}' already exists and was not read in this turn, so the video was saved as '${made.path}' (${mb} MB, ${DURATION} s). Tell the user about both.`
        : `Saved the video as ${made.path} (${mb} MB, ${DURATION} s with music).`) +
        ' To send it to someone or post it in a room, use share_with_person or post_to_room with this path.',
      summary: `${SAVE_PROMO_TOOL} -> ${made.path} ${made.size}B${made.conflictCopyOf ? ' (conflict copy)' : ''}`,
      structured: { path: made.path, size: made.size, sha256: made.sha256 },
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

export function registerSavePromoVideo(ctx: AppContext, reg: ToolRegistry): void {
  reg.register({
    name: SAVE_PROMO_TOOL,
    description: SAVE_PROMO_DESCRIPTION,
    input: SavePromoVideoInput,
    // only where the MP4 can be rendered (read at each turn's start: an install or a removal shows without a restart)
    available: () => mp4Available(ctx),
    describe: (a) => `${SAVE_PROMO_TOOL}${a.save_as ? ` -> ${a.save_as}` : ''}`,
    run: (a, t) => savePromoVideo(ctx, a, t),
  })
}
