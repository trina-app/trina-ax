// promo_video_versions and a same-slot re-render never reach a version hidden from the asker (review of batch 2:
// a hidden answer's wording and private paths reached another person's AI, and the same slots skipped the check).
// Rows are put in directly; which versions are hidden comes from Artifacts.hiddenVersions (stubbed here: its own
// rules are tested with the artifact tool).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { PROMO_ARTIFACT_KEY, PromoVideoInput } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import { makeCApp, type CApp } from '../lib/c-app'
import { componentC } from '../../server/src/team-files/component'
import { makePromoVideo, promoVersions, sameAsEarlier } from '../../server/src/promo-video/tool'

let A: CApp
beforeAll(async () => { A = await makeCApp('promo-versions-hidden') })
afterAll(async () => { await A.close() })

const slots = (over: Record<string, unknown> = {}) => PromoVideoInput.parse({
  title: 'Secret plan video', company: 'Acme', website: 'acme.example', brand_color: '#0E5E4E',
  sources: ['users/alice/private/plan.md'],
  hook: { label: 'Your power bill', before: 'Guesswork', after: '18%', line: 'Customers as of 2025' },
  promise: { headline: ['See where the power', '*goes*'], sub: 'Live power data for every machine.', picture: 'groups/marketing/Brand/hero.png' },
  work: { kicker: 'Factory energy', headline: ['One sensor', 'per machine'], points: ['Live usage', 'Leak alerts'] },
  proof: { stats: [{ number: '18%', label: 'lower power bill' }] },
  cta: { line: 'Factory energy partner', offer: 'Free audit' },
  ...over,
})

function version(chat: string, n: number, by: string, input: unknown) {
  const id = uuidv7()
  A.ctx.db.query("INSERT INTO artifacts (id, chat_id, key, version, type, title, content) VALUES (?,?,?,?, 'html', 'v', '<p>v</p>')").run(id, chat, PROMO_ARTIFACT_KEY, n)
  A.ctx.db.query('INSERT INTO promo_videos (artifact_id, chat_id, user_id, spec, created_at) VALUES (?,?,?,?,?)')
    .run(id, chat, by, JSON.stringify({ title: `title by ${by}`, sources: ['users/alice/private/plan.md'], doc: { family: 'ink', music: 'bright' }, input }), new Date(Date.now() + n).toISOString())
  return id
}

describe('hidden promo video versions', () => {
  test('not listed, slots not given, and the same slots are checked again with the asker\'s rights', async () => {
    const chat = A.chat('alice')
    const secret = slots()
    const v1 = version(chat, 1, 'alice', secret)
    version(chat, 2, 'bob', slots({ title: 'Bob video', sources: ['shared/plan.md'], promise: { headline: ['See where the power', '*goes*'] } }))
    const arts = componentC(A.ctx).artifacts
    const real = arts.hiddenVersions.bind(arts)
    arts.hiddenVersions = (u: string) => (u === 'bob' ? new Set([v1]) : new Set<string>())
    try {
      const turn = A.turn('bob', chat)
      const tc = A.toolCtx('bob', turn)
      const list = promoVersions(A.ctx, {}, tc).text
      expect(list).not.toContain('title by alice')
      expect(list).toContain('version 2')
      expect(list).not.toContain('version 1')
      const one = promoVersions(A.ctx, { version: 1 }, tc).text
      expect(one).toContain('has no version 1')
      expect(one).not.toContain('users/alice/private')
      // the hidden version's exact slots: no shortcut, and the usual check refuses (bob cannot read alice's folder).
      expect(sameAsEarlier(A.ctx, tc, chat, secret)).toBeNull()
      await expect(makePromoVideo(A.ctx, secret, tc)).rejects.toThrow(/could not be read|not found or no access/)
      // alice sees her own version; still, a picture she cannot read now ends the shortcut (readPicture again)
      const ta = A.toolCtx('alice', A.turn('alice', chat))
      expect(promoVersions(A.ctx, { version: 1 }, ta).text).toContain('users/alice/private/plan.md')
      expect(sameAsEarlier(A.ctx, ta, chat, secret)).toBeNull()
      // with the picture there and readable, the shortcut gives back that version as checked then
      const pic = path.join(A.team, 'groups/marketing/Brand/hero.png')
      fs.mkdirSync(path.dirname(pic), { recursive: true })
      const b = Buffer.alloc(33 + 4096); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b, 0); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(1600, 16); b.writeUInt32BE(1200, 20); b[24] = 8; b[25] = 6
      fs.writeFileSync(pic, b)
      expect(sameAsEarlier(A.ctx, ta, chat, secret)).not.toBeNull()
      // and bob, for whom it is hidden, never gets it, even when he may read the brand picture (only the hidden filter)
      A.ctx.db.query("INSERT INTO group_members VALUES ('marketing', 'bob')").run()
      expect(sameAsEarlier(A.ctx, tc, chat, secret)).toBeNull()
      A.ctx.db.query("DELETE FROM group_members WHERE group_id = 'marketing' AND user_id = 'bob'").run()
      // a version bob may see whose picture he cannot read (marketing's brand folder): no shortcut either
      arts.hiddenVersions = () => new Set<string>()
      expect(sameAsEarlier(A.ctx, tc, chat, secret)).toBeNull()
    } finally { arts.hiddenVersions = real }
  })
})
