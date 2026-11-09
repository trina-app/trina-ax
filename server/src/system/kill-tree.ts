// Ending a program that starts processes of its own (a headless browser): the promo video's HyperFrames CLI
// (promo-video/render.ts) and the HTML print (files/html-pdf.ts). By process id, never by a name pattern.
import { spawnSync } from 'node:child_process'

/** Kill a process and everything under it, by process id: its own group (it was started detached) and the group of
 * each process under it that leads one (puppeteer starts Chrome in a group of its own, so killing the CLI's group
 * alone would leave the browser running), then each of those processes. The tree is read once, before any kill (a
 * killed parent's children move to init and could not be found after). Never by a name pattern. */
export function killTree(pid: number): void {
  const tree = descendants(pid)
  const groups = new Set([pid, ...tree.filter((x) => x.pgid === x.pid).map((x) => x.pid)])
  for (const g of groups) { try { process.kill(-g, 'SIGKILL') } catch { /* gone */ } }
  for (const x of [{ pid }, ...tree]) { try { process.kill(x.pid, 'SIGKILL') } catch { /* gone */ } }
}

/** Every process under `root` (children, their children…), from one `ps` listing. */
function descendants(root: number): { pid: number; pgid: number }[] {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 5000 })
  if (r.status !== 0 || !r.stdout) return []
  const byParent = new Map<number, { pid: number; pgid: number }[]>()
  for (const line of r.stdout.split('\n')) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number)
    if (!pid || ppid === undefined || pgid === undefined || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue
    const kids = byParent.get(ppid)
    if (kids) kids.push({ pid, pgid })
    else byParent.set(ppid, [{ pid, pgid }])
  }
  const out: { pid: number; pgid: number }[] = []
  const seen = new Set([root])
  for (let i = -1; i < out.length; i++) {
    for (const c of byParent.get(i < 0 ? root : out[i]!.pid) ?? []) if (!seen.has(c.pid)) { seen.add(c.pid); out.push(c) }
  }
  return out
}
