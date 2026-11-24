// Runs a standalone Electron fixture (fixtures/*-main.ts) until it prints its `<TAG> {json}` result line, then stops it
// and every helper it started (GPU, network, renderer: its process group) with SIGKILL, waits until all of them are gone,
// and returns the parsed JSON. Killing only the main process left the helpers running for up to minutes, still writing
// into the profile (cookies, cache, service worker database) while the spec removed it: rmSync failed with ENOTEMPTY.
// The result line is all a spec needs: Electron's own exit can take minutes on
// a busy Mac or a CI runner (a registered worker, a window that will not close), which said nothing about the test and
// stalled the whole run (the work-files fixture fix, PR #1015). Waiting for the exit is what this replaces.
//
// Every run's stdout and stderr go to e2e/.work/logs/<tag>-<time>.log, which CI uploads when the job fails.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LOGS = join(import.meta.dirname, '.work', 'logs')

/** The JSON after `<tag> ` on the first full line that starts with it; fails after `ms` or when the fixture exits first. */
export function fixtureResult<T = any>(cmd: string, args: string[], env: NodeJS.ProcessEnv, tag: string, ms: number): Promise<T> {
  const prefix = `${tag} `
  return new Promise((done, fail) => {
    const started = Date.now()
    // its own process group (detached): Electron's helpers stay in it, so one kill reaches them all
    const p = spawn(cmd, args, { env, detached: true })
    const killAll = () => { try { process.kill(-p.pid!, 'SIGKILL') } catch { /* already gone */ } }
    // the JSON once the run is over: 'close' comes when every process holding the fixture's stdout and stderr (the main
    // process and each helper) has exited, so nothing writes into the profile after this returns
    let result: { line: string } | null = null
    let out = ''
    let err = ''
    let settled = false
    const log = (how: string) => {
      try {
        mkdirSync(LOGS, { recursive: true })
        writeFileSync(join(LOGS, `${tag.toLowerCase()}-${started}.log`), `${how} after ${Date.now() - started} ms\n--- stdout\n${out}\n--- stderr\n${err}\n`)
      } catch { /* the log is a help, never the test */ }
    }
    const finish = (how: string, f: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      log(how)
      f()
    }
    // out of time: everything is killed and the failure comes at 'close', once nothing writes any more
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; killAll() }, ms)
    p.stdout.on('data', (b) => {
      out += String(b)
      const at = out.split('\n').findIndex((l) => l.startsWith(prefix))
      // the whole line: it is printed in one write, but a pipe may hand it over in pieces
      if (at < 0 || out.split('\n').length <= at + 1) return
      if (result) return
      result = { line: out.split('\n')[at]! }
      killAll()
    })
    p.stderr.on('data', (b) => { err += String(b) })
    p.on('error', (e) => finish('spawn error', () => fail(e)))
    // 'close', not 'exit': the fixtures print their line and exit at once, and 'exit' can come before the last of stdout
    // is read. The exit code is not checked: every fixture exits non-zero only without printing its line (or, for
    // rtc-main, with a report missing, which the spec checks key by key)
    // the main process ended by itself (or by the kill): its helpers go too, so 'close' follows
    p.on('exit', killAll)
    p.on('close', (code, signal) => {
      if (timedOut && !result) return finish('timed out', () => fail(new Error(`no ${tag} within ${ms} ms\n${err.slice(-2000)}`)))
      const line = result?.line ?? out.split('\n').find((l) => l.startsWith(prefix))
      if (line) return finish('result at close', () => { try { done(JSON.parse(line.slice(prefix.length)) as T) } catch (e) { fail(e) } })
      finish(`exited ${code ?? signal}`, () => fail(new Error(`fixture exited ${code ?? signal} without ${tag}\n${err.slice(-2000)}`)))
    })
  })
}
