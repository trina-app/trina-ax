import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { options, start } from '../../scripts/demo/start'

test('demo accepts explicit choices and rejects malformed options', () => {
  expect(options(['--port','19762','--locale','ko']).locale).toBe('ko')
  for (const args of [['--port','0'],['--port','no'],['--locale','ja'],['--data'],['--unknown','value']]) expect(() => options(args)).toThrow()
})
test('existing data is refused without changing its files', async () => {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.trina-refuse-'))
  try {
    fs.writeFileSync(path.join(root,'team-marker'),'must remain')
    await expect(start(['--port','19778','--data',root])).rejects.toThrow()
    expect(fs.readFileSync(path.join(root,'team-marker'),'utf8')).toBe('must remain')
    expect(fs.existsSync(path.join(root,'demo.json'))).toBe(false)
  } finally { fs.rmSync(root,{recursive:true,force:true}) }
})
test('busy port is refused before creating a data directory', async () => {
  const socket = net.createServer()
  await new Promise<void>((resolve,reject) => { socket.once('error',reject);socket.listen(19779,'127.0.0.1',resolve) })
  const dir = path.join(os.homedir(),`.trina-never-created-${Date.now()}`)
  try { await expect(start(['--port','19779','--data',dir])).rejects.toThrow();expect(fs.existsSync(dir)).toBe(false) }
  finally { await new Promise<void>(resolve => socket.close(()=>resolve())) }
})
