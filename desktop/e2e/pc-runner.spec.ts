// The PC runner in the real app, against a real shell and the real macOS jail (docs/DECISIONS.md "PC runner"): the person
// picks the workspace folder and answers in the app's own view; the team page can pass a call on and nothing more. A
// command that is allowed runs and its result reaches the server, one that is refused does not run, a chat allowance does
// not cover logins or secret files, nothing gets out of the folder, the AI never learns the folder's real path, and closing
// the app ends every command, whatever it started. macOS only for now, like the feature.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { ACME, addTeam, close, launch, newUserData, result, signIn, text, view, type ResultEnvelope } from './helpers'

test.skip(process.platform !== 'darwin', 'the PC runner is macOS only for now')

const pcBar = (app: ElectronApplication) => view(app, (u) => u.endsWith('/pc.html'))

async function pcCall(tool: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<{ callId: string; chatId: string }> {
  const r = await fetch('http://127.0.0.1:19151/test/pc-call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, args, ...extra }) })
  if (!r.ok) throw new Error(`pc call failed: ${r.status} ${await r.text()}`)
  return r.json()
}
const pcResult = (callId: string) => result(ACME, callId) as Promise<ResultEnvelope & { result: { approval: string; grants?: { login: boolean; secretFiles: boolean }; run?: { code: number | null; signal: string | null } } }>

/** The next dialog answers with this folder (the system's own dialog cannot be driven). */
const answerFolder = (app: ElectronApplication, folder: string) =>
  app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as never
  }, folder)

async function pickFolder(app: ElectronApplication, bar: Page, folder: string) {
  await answerFolder(app, folder)
  await bar.getByTestId('pc-folder-pick').click()
}

const running = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

interface Rig { app: ElectronApplication; bar: Page; page: Page; work: string; base: string }

async function rig(): Promise<Rig> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pc-e2e-')))
  const work = join(base, 'project')
  mkdirSync(work)
  writeFileSync(join(work, 'hello.txt'), 'line one\nline two\n')
  const app = await launch(newUserData())
  const page = await addTeam(app, 'acme.localhost:19151', ACME)
  await signIn(page)
  return { app, bar: await pcBar(app), page, work, base }
}

/** The first call of a project: it asks for the folder, then asks about the call. */
async function firstCall(r: Rig, tool: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const c = await pcCall(tool, args, extra)
  await expect(r.bar.getByTestId('pc-prompt')).toHaveAttribute('data-kind', 'folder')
  await pickFolder(r.app, r.bar, r.work)
  await expect(r.bar.getByTestId('pc-prompt')).toHaveAttribute('data-kind', 'call')
  return c
}

test('the person picks the folder, approves, the command runs there and the result reaches the server', async () => {
  const r = await rig()
  try {
    const c = await firstCall(r, 'pc_shell', { command: 'pwd; cat hello.txt; echo made > made.txt' })
    await expect(r.bar.getByTestId('pc-text')).toHaveText('pwd; cat hello.txt; echo made > made.txt')
    expect(existsSync(join(r.work, 'made.txt'))).toBe(false)
    await r.bar.getByTestId('pc-once').click()
    const res = await pcResult(c.callId)
    expect(res.result).toMatchObject({ ok: true, approval: 'once', run: { code: 0, signal: null } })
    expect(text(res)).toContain('Exit code 0.')
    expect(text(res)).toContain('line one')
    expect(readFileSync(join(r.work, 'made.txt'), 'utf8')).toBe('made\n')
    // the folder's real path and the person's name stay on this computer
    expect(text(res)).not.toContain(r.work)
    expect(text(res)).toContain('--- stdout ---\n.\n')
    // the time limit paused while the person decided, and the same folder is used without asking again
    const waits = await (await fetch(`http://127.0.0.1:19151/test/pc-waiting?callId=${c.callId}`)).json()
    expect(waits.waiting).toEqual([true, false, true, false]) // the folder (card and dialog), then the call
    const again = await pcCall('pc_shell', { command: 'echo second' })
    await expect(r.bar.getByTestId('pc-prompt')).toHaveAttribute('data-kind', 'call')
    await r.bar.getByTestId('pc-once').click()
    expect(text(await pcResult(again.callId))).toContain('second')
  } finally {
    await close(r.app)
    rmSync(r.base, { recursive: true, force: true })
  }
})

test('refused: nothing runs, and the AI is told to stop', async () => {
  const r = await rig()
  try {
    const c = await firstCall(r, 'pc_shell', { command: 'touch refused.txt' })
    await r.bar.getByTestId('pc-deny').click()
    const res = await pcResult(c.callId)
    expect(res.result).toMatchObject({ ok: false, approval: 'denied' })
    expect(text(res)).toContain('did not allow')
    expect(existsSync(join(r.work, 'refused.txt'))).toBe(false)
  } finally {
    await close(r.app)
    rmSync(r.base, { recursive: true, force: true })
  }
})

test('the team page can pass a call on but has no way to answer for the person', async () => {
  const r = await rig()
  try {
    const keys = await r.page.evaluate(() => Object.keys((window as any).mycelDesktop.pc).sort())
    expect(keys).toEqual(['cancel', 'onWaiting', 'run'])
    const c = await firstCall(r, 'pc_shell', { command: 'touch forged.txt' })
    expect(await r.page.evaluate(() => Boolean((window as any).ipcRenderer || (window as any).require))).toBe(false)
    // the answer's channel, arriving from the team page's view instead of the app's own: nothing happens
    const id = await r.bar.getByTestId('pc-prompt').locator('h2').getAttribute('id')
    await r.app.evaluate(({ ipcMain, webContents }, { promptId, origin }) => {
      const team = webContents.getAllWebContents().find((w) => w.getURL().startsWith(origin))!
      ipcMain.emit('ui:pc-answer', { sender: team, senderFrame: team.mainFrame }, { id: promptId, decision: 'once' })
    }, { promptId: id!.slice(2), origin: ACME })
    await new Promise((res) => setTimeout(res, 500))
    await expect(r.bar.getByTestId('pc-prompt')).toBeVisible()
    expect(existsSync(join(r.work, 'forged.txt'))).toBe(false)
    await r.bar.getByTestId('pc-deny').click()
    await pcResult(c.callId)
    expect(existsSync(join(r.work, 'forged.txt'))).toBe(false)
  } finally {
    await close(r.app)
    rmSync(r.base, { recursive: true, force: true })
  }
})

test('a chat allowance covers that chat only, never a login or a secret file, and can be taken back', async () => {
  const r = await rig()
  try {
    writeFileSync(join(r.work, '.env'), 'TOKEN=hunter2\n')
    const first = await firstCall(r, 'pc_shell', { command: 'echo one' })
    await r.bar.getByTestId('pc-chat').click()
    expect((await pcResult(first.callId)).result).toMatchObject({ ok: true, approval: 'chat' })
    const chatId = first.chatId
    // the same chat: no question
    const second = await pcCall('pc_write', { file_path: 'sub/dir/new.txt', content: 'written\n' }, { chatId })
    expect((await pcResult(second.callId)).result).toMatchObject({ ok: true, approval: 'chat' })
    expect(readFileSync(join(r.work, 'sub/dir/new.txt'), 'utf8')).toBe('written\n')
    // something that only mentions a login gets none: it runs as a plain command, in the jail
    const mention = await pcCall('pc_shell', { command: 'echo git push' }, { chatId })
    expect((await pcResult(mention.callId)).result).toMatchObject({ ok: true, approval: 'chat', grants: { login: false } })
    // a login command asks all the same, and "this chat" is not on the card
    const login = await pcCall('pc_shell', { command: 'git push origin main' }, { chatId })
    await expect(r.bar.getByTestId('pc-warn-login')).toBeVisible()
    await expect(r.bar.getByTestId('pc-chat')).toHaveCount(0)
    await r.bar.getByTestId('pc-deny').click()
    expect((await pcResult(login.callId)).result.approval).toBe('denied')
    // so does a secret file
    const secret = await pcCall('pc_read', { file_path: '.env' }, { chatId })
    await expect(r.bar.getByTestId('pc-warn-secret')).toBeVisible()
    await expect(r.bar.getByTestId('pc-chat')).toHaveCount(0)
    await r.bar.getByTestId('pc-once').click()
    const read = await pcResult(secret.callId)
    expect(read.result).toMatchObject({ ok: true, approval: 'once', grants: { login: false, secretFiles: true } })
    expect(text(read)).toContain('TOKEN=hunter2')
    // another chat asks
    const other = await pcCall('pc_shell', { command: 'echo other' })
    await expect(r.bar.getByTestId('pc-prompt')).toBeVisible()
    await r.bar.getByTestId('pc-deny').click()
    await pcResult(other.callId)
    // taken back: this chat asks again
    await r.bar.getByTestId('pc-revoke').click()
    const third = await pcCall('pc_shell', { command: 'echo three' }, { chatId })
    await expect(r.bar.getByTestId('pc-prompt')).toBeVisible()
    await r.bar.getByTestId('pc-deny').click()
    await pcResult(third.callId)
  } finally {
    await close(r.app)
    rmSync(r.base, { recursive: true, force: true })
  }
})

test('nothing gets out of the folder: writes, reads, links, secret files in a plain command', async () => {
  const r = await rig()
  const outside = join(r.base, 'outside.txt')
  writeFileSync(outside, 'OUTSIDE')
  writeFileSync(join(r.work, '.env'), 'TOKEN=hunter2\n')
  const marker = join(homedir(), `pc-e2e-${process.pid}.txt`)
  try {
    const c = await firstCall(r, 'pc_shell', {
      command: `echo x > '${marker}'; cat '${outside}'; ln -s '${outside}' link.txt; cat link.txt; cat ~/.ssh/config; cat .env; mv .env e.txt; cat e.txt; echo end`,
    })
    await r.bar.getByTestId('pc-chat').click()
    const res = await pcResult(c.callId)
    const t = text(res)
    expect(existsSync(marker)).toBe(false)
    expect(t).not.toContain('OUTSIDE')
    expect(t).not.toContain('hunter2')
    expect(t).toContain('Operation not permitted')
    expect(existsSync(join(r.work, '.env'))).toBe(true)
    // the file tools run in the same jail: a link inside the workspace reaches nothing
    const link = await pcCall('pc_read', { file_path: 'link.txt' }, { chatId: c.chatId })
    const out = await pcResult(link.callId)
    expect(out.result.ok).toBe(false)
    expect(text(out)).not.toContain('OUTSIDE')
    // a path out of the folder never reaches the person
    const up = await pcCall('pc_read', { file_path: '../outside.txt' }, { chatId: c.chatId })
    expect((await pcResult(up.callId)).result).toMatchObject({ ok: false, approval: 'none' })
    const git = await pcCall('pc_write', { file_path: '.git/hooks/pre-push', content: 'x' }, { chatId: c.chatId })
    expect((await pcResult(git.callId)).result).toMatchObject({ ok: false, approval: 'none' })
  } finally {
    rmSync(marker, { force: true })
    await close(r.app)
    rmSync(r.base, { recursive: true, force: true })
  }
})

test('a folder that is too wide is refused and asked again; a call with no folder is refused', async () => {
  const r = await rig()
  try {
    const c = await pcCall('pc_read', { file_path: 'hello.txt' })
    await expect(r.bar.getByTestId('pc-prompt')).toHaveAttribute('data-kind', 'folder')
    await pickFolder(r.app, r.bar, realpathSync(homedir()))
    await expect(r.bar.getByTestId('pc-folder-problem')).toBeVisible()
    await pickFolder(r.app, r.bar, r.work)
    await expect(r.bar.getByTestId('pc-prompt')).toHaveAttribute('data-kind', 'call')
    await r.bar.getByTestId('pc-once').click()
    expect(text(await pcResult(c.callId))).toContain('line two')
    const other = await pcCall('pc_read', { file_path: 'x' }, { project: { id: 'project-2', name: 'Other' } })
    await expect(r.bar.getByTestId('pc-prompt')).toHaveAttribute('data-kind', 'folder')
    await r.bar.getByTestId('pc-deny').click()
    expect((await pcResult(other.callId)).result).toMatchObject({ ok: false, approval: 'denied' })
  } finally {
    await close(r.app)
    rmSync(r.base, { recursive: true, force: true })
  }
})

test('the file tools: search, edit, read a part', async () => {
  const r = await rig()
  try {
    mkdirSync(join(r.work, 'node_modules/x'), { recursive: true })
    writeFileSync(join(r.work, 'node_modules/x/needle.txt'), 'needle\n')
    writeFileSync(join(r.work, 'src.ts'), 'const needle = 1\nconst other = 2\n')
    const c = await firstCall(r, 'pc_search', { pattern: 'needle' })
    await r.bar.getByTestId('pc-chat').click()
    expect(text(await pcResult(c.callId))).toBe('src.ts:1:const needle = 1')
    const chatId = c.chatId
    const list = await pcCall('pc_search', { glob: '*.ts' }, { chatId })
    expect(text(await pcResult(list.callId))).toBe('src.ts')
    const edit = await pcCall('pc_edit', { file_path: 'src.ts', old_string: 'needle', new_string: 'thread' }, { chatId })
    expect(text(await pcResult(edit.callId))).toContain('Edited src.ts')
    expect(readFileSync(join(r.work, 'src.ts'), 'utf8')).toContain('const thread = 1')
    const part = await pcCall('pc_read', { file_path: 'src.ts', offset: 2, limit: 1 }, { chatId })
    expect(text(await pcResult(part.callId))).toBe('     2\tconst other = 2')
  } finally {
    await close(r.app)
    rmSync(r.base, { recursive: true, force: true })
  }
})

test('stop ends the command and what it started; the server can cancel it too; a time limit holds', async () => {
  const r = await rig()
  const pidFile = () => Number(readFileSync(join(r.work, 'pid'), 'utf8'))
  try {
    const c = await firstCall(r, 'pc_shell', { command: 'sleep 300 & echo $! > pid; wait' })
    await r.bar.getByTestId('pc-chat').click()
    await expect.poll(() => existsSync(join(r.work, 'pid'))).toBe(true)
    await expect(r.bar.getByTestId('pc-line')).toHaveText('AI가 이 PC를 쓰는 중')
    const child = pidFile()
    expect(running(child)).toBe(true)
    await r.bar.getByTestId('pc-stop').click()
    const res = await pcResult(c.callId)
    expect(res.result).toMatchObject({ ok: false, run: { signal: 'stopped' } })
    expect(text(res)).toContain('pressed stop')
    await expect.poll(() => running(child), { timeout: 5000 }).toBe(false)

    // stop also took back the chat, so this one asks
    const c2 = await pcCall('pc_shell', { command: 'rm -f pid; sleep 300 & echo $! > pid; wait' })
    await r.bar.getByTestId('pc-chat').click()
    await expect.poll(() => { try { return running(pidFile()) } catch { return false } }).toBe(true)
    const child2 = pidFile()
    await fetch('http://127.0.0.1:19151/test/pc-cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: c2.callId }) })
    expect((await pcResult(c2.callId)).result.ok).toBe(false)
    await expect.poll(() => running(child2), { timeout: 5000 }).toBe(false)

    const c3 = await pcCall('pc_shell', { command: 'sleep 30', timeout_sec: 1 }, { chatId: c2.chatId })
    const res3 = await pcResult(c3.callId)
    expect(res3.result).toMatchObject({ ok: false, run: { signal: 'timeout' } })
    expect(text(res3)).toContain('time limit (1 s)')
  } finally {
    await close(r.app)
    rmSync(r.base, { recursive: true, force: true })
  }
})

test('a command that prints without end stays within the limit', async () => {
  const r = await rig()
  try {
    const c = await firstCall(r, 'pc_shell', { command: 'yes | head -c 2000000; echo; echo done >&2' })
    await r.bar.getByTestId('pc-once').click()
    const res = await pcResult(c.callId)
    expect(res.result.ok).toBe(true)
    expect(text(res).length).toBeLessThan(40_000)
    expect(text(res)).toContain('(output cut)')
    expect(text(res)).toContain('done')
  } finally {
    await close(r.app)
    rmSync(r.base, { recursive: true, force: true })
  }
})

test('a dev server keeps running until the app closes, opens only on the person\'s click, and ends with the app', async () => {
  const r = await rig()
  const port = 19159
  let closed = false
  try {
    writeFileSync(join(r.work, 'server.js'), `require('http').createServer((q, s) => s.end('dev server')).listen(${port}, '127.0.0.1'); require('fs').writeFileSync('server.pid', String(process.pid))`)
    const c = await firstCall(r, 'pc_shell', { command: 'node server.js', background: true, log_name: 'dev', preview_port: port })
    await r.bar.getByTestId('pc-once').click()
    const res = await pcResult(c.callId)
    expect(res.result.ok).toBe(true)
    expect(text(res)).toContain('Started in the background')
    await expect.poll(() => fetch(`http://127.0.0.1:${port}`).then((x) => x.text()).catch(() => '')).toBe('dev server')
    await expect(r.bar.getByTestId('pc-background')).toBeVisible()
    const pid = Number(readFileSync(join(r.work, 'server.pid'), 'utf8'))
    expect(running(pid)).toBe(true)
    // the button goes to the system browser: the in-app browser keeps refusing this computer
    await r.app.evaluate(({ shell }) => {
      ;(globalThis as any).__opened = []
      shell.openExternal = (async (u: string) => (globalThis as any).__opened.push(u)) as never
    })
    await r.bar.getByTestId('pc-preview').click()
    await expect.poll(() => r.app.evaluate(() => (globalThis as any).__opened)).toEqual([`http://127.0.0.1:${port}/`])
    await close(r.app)
    closed = true
    await expect.poll(() => running(pid), { timeout: 5000 }).toBe(false)
    await expect.poll(() => fetch(`http://127.0.0.1:${port}`).then(() => 'up').catch(() => 'down')).toBe('down')
  } finally {
    if (!closed) await close(r.app)
    rmSync(r.base, { recursive: true, force: true })
  }
})

test('closing the app ends a running foreground command and everything it started', async () => {
  const r = await rig()
  let closed = false
  try {
    const c = await firstCall(r, 'pc_shell', { command: 'sleep 300 & echo $! > child.pid; echo $$ > parent.pid; wait' })
    await r.bar.getByTestId('pc-once').click()
    await expect.poll(() => existsSync(join(r.work, 'child.pid')) && existsSync(join(r.work, 'parent.pid'))).toBe(true)
    await expect.poll(() => statSync(join(r.work, 'parent.pid')).size).toBeGreaterThan(0)
    const pids = ['child.pid', 'parent.pid'].map((f) => Number(readFileSync(join(r.work, f), 'utf8')))
    for (const p of pids) expect(running(p)).toBe(true)
    await close(r.app)
    closed = true
    for (const p of pids) await expect.poll(() => running(p), { timeout: 5000 }).toBe(false)
    expect(c.callId).toBeTruthy()
  } finally {
    if (!closed) await close(r.app)
    rmSync(r.base, { recursive: true, force: true })
  }
})

test('another person signs in: running commands end and the workspace folder is forgotten', async () => {
  const r = await rig()
  try {
    const c = await firstCall(r, 'pc_shell', { command: 'echo mine' })
    await r.bar.getByTestId('pc-once').click()
    await pcResult(c.callId)
    await signIn(r.page, 'someone-else')
    // any AI call checks who is signed in; the folder has to be chosen again
    const next = await pcCall('pc_shell', { command: 'echo yours' })
    await expect(r.bar.getByTestId('pc-prompt')).toHaveAttribute('data-kind', 'folder')
    await r.bar.getByTestId('pc-deny').click()
    expect((await pcResult(next.callId)).result.approval).toBe('denied')
  } finally {
    await close(r.app)
    rmSync(r.base, { recursive: true, force: true })
  }
})

test('the run log shows what ran and what was refused', async () => {
  const r = await rig()
  try {
    const c = await firstCall(r, 'pc_shell', { command: 'echo logged' })
    await r.bar.getByTestId('pc-once').click()
    await pcResult(c.callId)
    const d = await pcCall('pc_shell', { command: 'echo refused' })
    await r.bar.getByTestId('pc-log-button').click()
    await r.bar.getByTestId('pc-deny').click()
    await pcResult(d.callId)
    const log = r.bar.getByTestId('pc-log')
    await expect(log).toContainText('echo logged')
    await expect(log).toContainText('완료')
    await expect(log).toContainText('echo refused')
    await expect(log).toContainText('거부함')
  } finally {
    await close(r.app)
    rmSync(r.base, { recursive: true, force: true })
  }
})
