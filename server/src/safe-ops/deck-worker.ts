// Legacy PPTX count/notes check, now contained like the existing office worker.
import fs from 'node:fs'
import { readDeck } from '../tools/pptx-check'
import { checkZip } from '../files/zip-guard'
if (import.meta.main) {
  try {
    const b = Buffer.from(await Bun.stdin.arrayBuffer())
    if (b.length > 32 * 1024 ** 2) throw new Error('limit')
    checkZip(b)
    fs.writeFileSync('deck.pptx', b, { mode: 0o600 })
    process.stdout.write(JSON.stringify(readDeck('deck.pptx')))
  } catch {
    process.exit(3)
  }
}
