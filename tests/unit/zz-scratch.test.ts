import { test } from 'bun:test'
import { sameAsGroupOf } from '../../server/src/rooms/project-link'
import { harness, withOwner } from './a-lib'
test('x', async () => {
  const h = await harness('zz-scratch')
  await withOwner(h)
  try { console.log(sameAsGroupOf(h.ctx.db, 'nope')) } catch (e) { console.log('ERR', String(e)) }
  await h.close()
})
