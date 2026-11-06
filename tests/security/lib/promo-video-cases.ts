// The promo video's state and its MP4 (docs/DECISIONS.md "V"; server/src/promo-video/render.ts): only the person whose
// chat holds the video, never the team's owner or admins (a chat is its owner's alone). Alice's video is a row of
// promo_videos on her artifact in chat A with a finished MP4 whose bytes and title carry her artifact canary, so a 2xx
// to anyone else leaks it. A finished MP4 is never rendered again, so no browser runs here (on a development Mac with
// the HyperFrames CLI installed, too).
import fs from 'node:fs'
import path from 'node:path'
import { PROMO_STYLES } from '@mycel/shared/api'
import type { Spec } from './cases'
import { C, type World } from './world'

/** alice's promo video (made once, on the first case that needs it): its id */
function alicePromo(w: World): string {
  const id = w.ids.artifact
  const ctx = w.inst.ctx
  const dir = path.join(ctx.engineConfig.dataDir, 'promo-videos')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.mp4`)
  if (!fs.existsSync(file)) fs.writeFileSync(file, `MP4 ${C.aliceArtifact}`)
  const now = new Date().toISOString()
  ctx.db.query("INSERT OR IGNORE INTO promo_videos (artifact_id, chat_id, user_id, spec, mp4_state, mp4_ms, mp4_bytes, rendered_at, created_at) VALUES (?, ?, 'alice', ?, 'done', 1, ?, ?, ?)")
    .run(id, w.ids.chatA, JSON.stringify({ title: `promo ${C.aliceArtifact}`, sources: [], doc: { family: PROMO_STYLES[0] } }), fs.statSync(file).size, now, now)
  return id
}

export const PROMO_VIDEO_SPECS: Record<string, Spec> = {
  getPromoVideo: { build: (c, w) => c.get(`/api/promo-videos/${alicePromo(w)}`), scope: 'own-alice' },
  // the MP4 is there: alice's press gives it back (or 404 where this server cannot make one), nothing is rendered
  renderPromoVideo: { build: (c, w) => c.post(`/api/promo-videos/${alicePromo(w)}/mp4`), scope: 'own-alice' },
  downloadPromoVideo: { build: (c, w) => c.get(`/api/promo-videos/${alicePromo(w)}/mp4`), scope: 'own-alice' },
}
