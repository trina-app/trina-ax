// The bulk guard of a project folder (docs/decisions/20261121-ai-scratch-files.md). On potenlab.trina.app one command of
// a project chat downloaded a GitHub repo into the project folder: 13,181 new files in one answer, each recorded as a
// team file (devenv/track.ts). Now, when the commands of one answer add more than BULK_FILES files or BULK_BYTES bytes
// of new files to a project folder, the command that crosses the line asks the person before its new files are
// recorded: keep them in the project folder, or move them to the chat's scratch folder ($TRINA_WORK/from-project/...).
// "Always allow" (kind bulk_files) keeps them without asking from then on. No answer (a scheduled run, a sub-agent, the
// card timed out, the person said move) moves them.
//
// The move runs as a command in the sandbox (runCommand: the same folders as the AI's own commands, the project folder
// and $TRINA_WORK), never as a server rename: a running job could swap a folder for a link while the server moves, and
// a server move would then take a server file. Only the files the command created move: a folder born during the
// command moves as one (with the node_modules or .venv in it, which the snapshot does not count), else the file alone.
// A changed file never moves.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { AppContext } from '../context'
import type { Change } from './snapshot'
import { audit } from '../admin/audit'
import { runCommand, scratchOf, srtConfig, type Space } from './srt/runner'

/** new files of one answer in a project folder before the card */
export const BULK_FILES = 500
/** new bytes of one answer in a project folder before the card (200 MB) */
export const BULK_BYTES = 200 * 1024 * 1024

/** how long the bulk card waits: the project folder's other commands wait while it is open (no answer: the files move) */
export const BULK_CARD_MS = 120_000

/** What one answer's commands added to project folders so far, and whether the person said keep. */
export interface BulkState { files: number; bytes: number; kept: boolean }
export const newBulkState = (): BulkState => ({ files: 0, bytes: 0, kept: false })

/** The card's facts: the new files of this command, their size, the folders (project-relative) that hold most of them. */
export interface BulkAsk { files: number; bytes: number; folders: { path: string; files: number }[]; project: string }

export const mb = (n: number) => (n / 1024 ** 2 >= 10 ? Math.round(n / 1024 ** 2).toString() : (n / 1024 ** 2).toFixed(1))

/** The top folders (first two levels under the project folder) that hold the most new files, at most 5. */
export function bulkFolders(project: string, created: readonly Change[]): { path: string; files: number }[] {
  const by = new Map<string, number>()
  for (const c of created) {
    const rel = c.path.slice(project.length + 1)
    const parts = rel.split('/')
    const key = parts.length > 2 ? parts.slice(0, 2).join('/') + '/' : parts.length === 2 ? parts[0] + '/' : '(the project folder)'
    by.set(key, (by.get(key) ?? 0) + 1)
  }
  return [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, n]) => ({ path: p, files: n }))
}

/** Over the line for this answer once these new files count too? */
export function overBulk(st: BulkState, files: number, bytes: number): boolean {
  return !st.kept && (st.files + files > BULK_FILES || st.bytes + bytes > BULK_BYTES)
}

/**
 * The project-relative paths to move: for each created file the highest folder above it (inside the project folder)
 * that was born while the command ran (birth time at or after `startedMs`), else the file itself. Nested ones go once.
 * Only lstat on the server (nothing followed, nothing opened).
 */
export function movableRoots(teamRoot: string, project: string, created: readonly Change[], startedMs: number, present: Iterable<string> = []): string[] {
  const projAbs = path.join(teamRoot, project)
  // a folder that holds any file this command did not create (a teammate's save during the command) never moves whole
  const made = new Set(created.map((c) => c.path))
  const mixed = new Set<string>()
  for (const p of present) {
    if (made.has(p) || !p.startsWith(project + '/')) continue
    const parts = p.slice(project.length + 1).split('/')
    for (let i = 1; i < parts.length; i++) mixed.add(parts.slice(0, i).join('/'))
  }
  const born = new Map<string, boolean>()
  const bornNow = (rel: string) => {
    let b = born.get(rel)
    if (b === undefined) {
      try { const st = fs.lstatSync(path.join(projAbs, rel)); b = st.isDirectory() && st.birthtimeMs > 0 && st.birthtimeMs >= startedMs } catch { b = false }
      born.set(rel, b)
    }
    return b
  }
  const roots = new Set<string>()
  for (const c of created) {
    if (!c.path.startsWith(project + '/')) continue
    const rel = c.path.slice(project.length + 1)
    const parts = rel.split('/')
    let root = rel
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/')
      if (!mixed.has(d) && bornNow(d)) { root = d; break }
    }
    roots.add(root)
  }
  const sorted = [...roots].sort()
  const out: string[] = []
  for (const r of sorted) if (!out.some((o) => r.startsWith(o + '/'))) out.push(r)
  return out
}

/** The shell lines of the move (bash and macOS bash 3.2 alike): read the NUL-separated list, move each entry under the
 * destination with its folders, never over something there (mv -n), remove the list, print how many went. */
export function moveScript(listName: string, dest: string): string {
  return [
    `L="$TRINA_WORK/${listName}"; D="$TRINA_WORK/${dest}"; n=0; f=`,
    'while IFS= read -r -d \'\' f; do d="${f%/*}"; [ "$d" = "$f" ] && d=.; mkdir -p -- "$D/$d" && mv -n -- "$f" "$D/$f" && n=$((n+1)); done < "$L"',
    'rm -f -- "$L"; echo "TRINA-MOVED:$n"',
  ].join('\n')
}

/**
 * Move the created files of one command out of the project folder into the chat's scratch folder, in the sandbox.
 * Returns the team paths that are gone from the project folder now (the window leaves them out of its record) and
 * where they went (`$TRINA_WORK/<dest>`), or why nothing moved.
 */
export async function moveToScratch(ctx: AppContext, o: { space: Space; project: string; created: readonly Change[]; startedMs: number; present?: readonly string[]; signal?: AbortSignal }): Promise<{ moved: Set<string>; dest: string } | { moved: Set<string>; error: string }> {
  const none = new Set<string>()
  const c = srtConfig()
  const scratch = scratchOf(ctx, c, o.space, undefined, true)
  if (!scratch) return { moved: none, error: 'this chat has no work folder now' }
  const roots = movableRoots(ctx.files.fx.root, o.project, o.created, o.startedMs, o.present ?? [])
  if (!roots.length) return { moved: none, error: 'nothing to move' }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  const dest = `from-project/${stamp}`
  const listName = `.trina-move-${crypto.randomUUID()}`
  // the list file: a new name right in the scratch folder (made by the server, its parent not writable by a run), 'wx'
  // never writes through a link a run put there
  try { fs.writeFileSync(path.join(scratch, listName), roots.map((r) => r + '\0').join(''), { flag: 'wx', mode: 0o600 }) } catch (e) { return { moved: none, error: `the list could not be written (${(e as Error).message})` } }
  const r = await runCommand(ctx, { space: o.space, cwd: '', command: moveScript(listName, dest), shown: 'move new files to the work folder', timeoutMs: 600_000, ...(o.signal ? { signal: o.signal } : {}) })
  try { fs.rmSync(path.join(scratch, listName), { force: true }) } catch {}
  // what is gone from the project folder now (lstat only), also after a failed or stopped move (part of it may have
  // gone): every created file under a root that went
  const projAbs = path.join(ctx.files.fx.root, o.project)
  const gone = roots.filter((rel) => { try { fs.lstatSync(path.join(projAbs, rel)); return false } catch { return true } })
  const moved = new Set<string>()
  for (const ch of o.created) {
    const rel = ch.path.slice(o.project.length + 1)
    if (gone.some((g) => rel === g || rel.startsWith(g + '/'))) moved.add(ch.path)
  }
  if (!r.ok) return { moved, error: r.message.slice(0, 300) }
  if (!moved.size) return { moved, error: r.value.stderr.slice(0, 300) || 'nothing moved' }
  return { moved, dest }
}

/** The audit row of a bulk decision. */
export function auditBulk(ctx: AppContext, o: { userId: string; turnId: string; chatId: string | null; projectId: string | null; files: number; bytes: number; decision: 'keep' | 'move' | 'kept_before' | 'move_failed'; asked: boolean; moved?: number; dest?: string }) {
  // never throws: after a move the window must still leave out what went
  try { auditRow(ctx, o) } catch (e) { ctx.log?.warn?.('dev env bulk audit row failed', { err: e }) }
}
function auditRow(ctx: AppContext, o: Parameters<typeof auditBulk>[1]) {
  audit(ctx.db, { actor: o.userId, action: 'dev_env.bulk_files', target: o.projectId, detail: { turnId: o.turnId, chatId: o.chatId, files: o.files, bytes: o.bytes, decision: o.decision, asked: o.asked, ...(o.moved !== undefined ? { moved: o.moved } : {}), ...(o.dest ? { dest: o.dest } : {}) } })
}

type T = Record<'ko' | 'en' | 'id' | 'ja' | 'es' | 'zh', string>
const t = (ko: string, en: string, id: string, ja: string, es: string, zh: string): T => ({ ko, en, id, ja, es, zh })
/** The bulk card's words ({files}, {mb}, {project}: filled by bulkCard). */
export const BULK_TEXT = {
  ask: t('AI 명령이 프로젝트 폴더 {project}에 새 파일 {files}개({mb}MB)를 만들었어요. 팀 모두가 보는 폴더예요. 프로젝트 폴더에 둘까요, 이 채팅의 작업 폴더로 옮길까요?',
    'An AI command made {files} new files ({mb} MB) in the project folder {project}, which the whole team sees. Keep them in the project folder, or move them to this chat\'s work folder?',
    'Perintah AI membuat {files} berkas baru ({mb} MB) di folder proyek {project}, yang dilihat seluruh tim. Simpan di folder proyek, atau pindahkan ke folder kerja obrolan ini?',
    'AIのコマンドがプロジェクトフォルダー{project}に新しいファイルを{files}個（{mb}MB）作りました。チーム全員が見るフォルダーです。プロジェクトフォルダーに残しますか、このチャットの作業フォルダーに移しますか？',
    'Un comando de la IA creó {files} archivos nuevos ({mb} MB) en la carpeta del proyecto {project}, que ve todo el equipo. ¿Los deja en la carpeta del proyecto o los mueve a la carpeta de trabajo de este chat?',
    'AI 命令在项目文件夹 {project} 中新建了 {files} 个文件（{mb} MB），整个团队都能看到这个文件夹。要留在项目文件夹，还是移到这个对话的工作文件夹？'),
  folders: t('주로 들어간 폴더', 'Mostly in', 'Sebagian besar di', '主なフォルダー', 'Sobre todo en', '主要在'),
  keep: t('프로젝트 폴더에 두기', 'Keep in the project folder', 'Simpan di folder proyek', 'プロジェクトフォルダーに残す', 'Dejar en la carpeta del proyecto', '留在项目文件夹'),
  move: t('작업 폴더로 옮기기', 'Move to the work folder', 'Pindahkan ke folder kerja', '作業フォルダーに移す', 'Mover a la carpeta de trabajo', '移到工作文件夹'),
}

/** The card's question and its details line, in the person's language. */
export function bulkCard(ask: BulkAsk, L: keyof T, place: (p: string) => string = (p) => p): { question: string; details: { label: string; text: string }[]; keep: string; move: string } {
  const question = BULK_TEXT.ask[L].replace('{files}', ask.files.toLocaleString(L)).replace('{mb}', mb(ask.bytes)).replace('{project}', place(ask.project))
  const text = ask.folders.map((f) => `${f.path} (${f.files.toLocaleString(L)})`).join('\n')
  return { question, details: text ? [{ label: BULK_TEXT.folders[L], text }] : [], keep: BULK_TEXT.keep[L], move: BULK_TEXT.move[L] }
}
