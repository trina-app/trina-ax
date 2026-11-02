// The PC runner through the whole chain, which the other specs split up: a message typed in the real web app inside the real
// desktop app -> the real server -> an AI tool call (fake engine) -> pc.call -> the app's approval view -> a real command in
// the jail -> pc.result -> the answer in the chat. It is the only test that runs web/src/lib/pcRelay.ts with the real bridge.
// The server treats every request as one person signed in from the desktop app (tests/lib/pc-chain-server.ts).
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { close, launch, newUserData, ROOT, view, welcome } from './helpers'

test.skip(process.platform !== 'darwin', 'the PC runner is macOS only for now')

const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
let server: ChildProcess
let info: { port: number; chatId: string; projectId: string }

test.beforeAll(async () => {
  server = spawn('bun', ['../tests/lib/pc-chain-server.ts'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] })
  info = await new Promise((resolve, reject) => {
    let out = ''
    server.stdout!.on('data', (d) => {
      out += String(d)
      const line = out.split('\n').find((l) => l.startsWith('{"port"'))
      if (line) resolve(JSON.parse(line))
    })
    server.on('exit', (c) => reject(new Error(`server exited: ${c}`)))
  })
})
test.afterAll(() => { server?.kill('SIGTERM') })

test('a message becomes a command on this computer and its answer comes back to the chat', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pc-chain-')))
  const work = join(base, 'project')
  mkdirSync(work)
  writeFileSync(join(work, 'package.json'), '{"name":"falcon","version":"1.0.0"}\n')
  const origin = `http://acme.localhost:${info.port}`
  const app = await launch(newUserData())
  try {
    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as never
    }, work)
    const w = await welcome(app)
    await w.getByRole('textbox', { name: '팀 주소' }).fill(`acme.localhost:${info.port}`)
    await w.getByRole('button', { name: '연결' }).click()
    const page = await view(app, (u) => u.startsWith(origin))
    await page.goto(`${origin}/c/${info.chatId}`)
    const bar = await view(app, (u) => u.endsWith('/pc.html'))

    await page.getByTestId('composer-input').fill(fake(
      { tool: 'pc_write', args: { file_path: 'src/hello.js', content: 'console.log("hello from " + require("path").basename(process.cwd()))\n' } },
      { tool: 'pc_shell', args: { command: 'node src/hello.js && git --version | cut -c1-3' }, sayResult: true },
    ))
    await page.getByTestId('send').click()

    await expect(bar.getByTestId('pc-prompt')).toHaveAttribute('data-kind', 'folder')
    await bar.getByTestId('pc-folder-pick').click()
    await expect(bar.getByTestId('pc-prompt')).toHaveAttribute('data-tool', 'pc_write')
    await expect(bar.getByTestId('pc-text')).toHaveText('src/hello.js')
    await expect(bar.getByTestId('pc-detail')).toContainText('hello from')
    await bar.getByTestId('pc-once').click()
    await expect(bar.getByTestId('pc-prompt')).toHaveAttribute('data-tool', 'pc_shell')
    await bar.getByTestId('pc-chat').click()

    const answer = page.getByTestId('assistant-message').last()
    await expect(answer).toHaveAttribute('data-status', 'done', { timeout: 60_000 })
    await expect(answer).toContainText('Exit code 0.')
    await expect(answer).toContainText('hello from project')
    await expect(answer).not.toContainText(work)
    expect(readFileSync(join(work, 'src/hello.js'), 'utf8')).toContain('hello from')
    expect(existsSync(join(work, 'src/hello.js'))).toBe(true)
  } finally {
    await close(app)
    rmSync(base, { recursive: true, force: true })
  }
})
