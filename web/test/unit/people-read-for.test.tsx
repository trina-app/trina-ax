// A guest who joins a room while it is open (store/people.ts useReadPeopleFor): the directory says who is a guest, so
// a name it does not have yet makes one more read (once for each person), and nothing else does.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { installDom, mount, removeDom } from './dom-host'
import { usePeople, useReadPeopleFor } from '../../src/store/people'

beforeAll(() => { installDom() })
afterAll(() => { removeDom() })

function Probe({ ids }: { ids: string[] | null }) {
  useReadPeopleFor(ids)
  return null
}

describe('useReadPeopleFor', () => {
  let loads = 0
  const realLoad = usePeople.getState().load
  beforeEach(() => {
    loads = 0
    usePeople.setState({ loaded: true, people: [], byId: { ann: { id: 'ann', name: 'Ann' } as never }, load: async () => { loads++ } })
  })
  afterAll(() => usePeople.setState({ load: realLoad }))

  test('everyone known: no read; one unknown person: one read, and not again on the next change', async () => {
    const m = await mount(<Probe ids={['ann']} />)
    expect(loads).toBe(0)
    await m.unmount()
    const m2 = await mount(<Probe ids={['ann', 'gina']} />)
    await m2.settle()
    expect(loads).toBe(1)
    // the directory still lacks her (a switched-off account): a re-render does not ask again
    usePeople.setState({ byId: { ann: { id: 'ann', name: 'Ann' } as never, other: { id: 'other', name: 'Other' } as never } })
    await m2.settle()
    expect(loads).toBe(1)
    await m2.unmount()
  })

  test('before the directory has been read, or with no list: nothing', async () => {
    usePeople.setState({ loaded: false })
    const m = await mount(<Probe ids={['gina']} />)
    await m.settle()
    expect(loads).toBe(0)
    await m.unmount()
    usePeople.setState({ loaded: true })
    const m2 = await mount(<Probe ids={null} />)
    await m2.settle()
    expect(loads).toBe(0)
    await m2.unmount()
  })
})
