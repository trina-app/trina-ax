import { expect, test } from 'bun:test'
import dns from 'node:dns/promises'
import { isPrivateHost } from '../../server/src/realtime/private-net'

test('a synchronous DNS refusal cannot leave a later unhandled timeout', async () => {
  const original = dns.lookup
  dns.lookup = (() => { throw new Error('synthetic resolver refusal') }) as typeof dns.lookup
  try {
    expect(await isPrivateHost('public.example.org')).toBe(false)
    // The old implementation returned false but left a rejecting timeout outside its Promise.race.
    await Bun.sleep(1600)
  } finally { dns.lookup = original }
})
