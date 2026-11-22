// The Files screen's uploads when a name is taken (web/src/lib/uploadPlans.ts; QA TC-7241): asked per file, Replace
// sends the name on disk with onExists 'replace', Keep both the picked name with 'rename', Cancel leaves the file out, a
// folder of that name is never replaced, and a failed check sends everything as before.
import { describe, expect, test } from 'bun:test'
import { uploadPlans, type UploadClash } from '../../src/lib/uploadPlans'

const file = (name: string) => new File(['x'], name)

describe('uploadPlans', () => {
  test('free names go up as before; each taken name is asked, with the name on disk', async () => {
    const asked: UploadClash[] = []
    const answers: Record<string, 'keep' | 'replace' | null> = { 'minutes.docx': 'replace', 'photo.png': 'keep', 'skip.txt': null }
    const plans = await uploadPlans([file('new.txt'), file('minutes.docx'), file('photo.png'), file('skip.txt')], {
      taken: async (names) => ({ taken: names.filter((n) => n !== 'new.txt').map((n) => ({ name: n, existing: n === 'minutes.docx' ? 'Minutes.docx' : n, type: 'file' as const })) }),
      ask: async (c) => { asked.push(c); return answers[c.name]! },
    })
    expect(asked.map((c) => c.name)).toEqual(['minutes.docx', 'photo.png', 'skip.txt'])
    expect(plans.map((p) => [p.file.name, p.name, p.onExists])).toEqual([
      ['new.txt', 'new.txt', 'rename'],
      ['minutes.docx', 'Minutes.docx', 'replace'],
      ['photo.png', 'photo.png', 'rename'],
    ])
  })

  test('a folder of that name: a Replace answer never replaces it', async () => {
    const plans = await uploadPlans([file('Photos')], {
      taken: async () => ({ taken: [{ name: 'Photos', existing: 'Photos', type: 'folder' }] }),
      ask: async (c) => { expect(c.type).toBe('folder'); return 'replace' },
    })
    expect(plans).toEqual([])
  })

  test('the check fails (an older server, the network): every file goes up as before, nobody is asked', async () => {
    let asked = 0
    const plans = await uploadPlans([file('a.txt'), file('b.txt')], {
      taken: async () => { throw new Error('404') },
      ask: async () => { asked++; return 'replace' },
    })
    expect(asked).toBe(0)
    expect(plans.map((p) => p.onExists)).toEqual(['rename', 'rename'])
  })
})
