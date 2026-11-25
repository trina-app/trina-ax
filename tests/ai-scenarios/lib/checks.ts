// Automatic checks of one case (tests/ai-scenarios/lib/types.ts Check), on the team folder as it is after the case.
// PDFs are read with poppler (pdfimages, pdfinfo), Office files as the zip they are (unzip) and spreadsheets with
// SheetJS. A missing reader makes that check "skipped", never a pass.
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import type { Check, CheckResult, TurnRecord } from './types'

interface Ctx { teamRoot: string; changed: string[]; turns: TurnRecord[]; room: string }

const sh = (cmd: string[]): { ok: boolean; out: string } => {
  try {
    const p = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
    return { ok: p.exitCode === 0, out: p.stdout.toString() }
  } catch { return { ok: false, out: '' } }
}
const has = (bin: string) => !!Bun.which(bin)

/** the changed team paths that match a glob ("**" any depth); newest name order */
function matches(ctx: Ctx, glob: string): string[] {
  const g = new Bun.Glob(glob)
  return ctx.changed.filter((p) => g.match(p))
}
const abs = (ctx: Ctx, rel: string) => path.join(ctx.teamRoot, rel)
const zipText = (file: string, member: string) => sh(['unzip', '-p', file, member]).out
const zipList = (file: string) => sh(['unzip', '-Z1', file]).out.split('\n').filter(Boolean)

function onEach(ctx: Ctx, glob: string, f: (file: string, rel: string) => { ok: boolean; detail: string }): { ok: boolean; detail: string } {
  const list = matches(ctx, glob)
  if (!list.length) return { ok: false, detail: `no new or changed file matches ${glob}` }
  const tried: string[] = []
  for (const rel of list) {
    const r = f(abs(ctx, rel), rel)
    if (r.ok) return { ok: true, detail: `${rel}: ${r.detail}` }
    tried.push(`${rel}: ${r.detail}`)
  }
  return { ok: false, detail: tried.join('; ').slice(0, 600) }
}

function one(check: Check, ctx: Ctx): { ok: boolean; detail: string } {
  const answer = ctx.turns.map((t) => t.answer).join('\n')
  const tools = ctx.turns.flatMap((t) => t.tools.map((x) => x.name))
  switch (check.type) {
    case 'file_created': {
      const l = matches(ctx, check.file)
      return { ok: l.length > 0, detail: l.length ? l.join(', ') : `nothing matches ${check.file}` }
    }
    case 'no_file_created': {
      const l = matches(ctx, check.file)
      return { ok: l.length === 0, detail: l.length ? `changed: ${l.join(', ')}` : 'no file changed' }
    }
    case 'pdf_image_on_page':
      if (!has('pdfimages')) return { ok: false, detail: 'skipped: pdfimages (poppler) is not installed' }
      return onEach(ctx, check.file, (f) => {
        const rows = sh(['pdfimages', '-list', f]).out.split('\n').slice(2).map((l) => l.trim().split(/\s+/)).filter((c) => c.length > 3)
        const pages = rows.map((c) => Number(c[0]))
        return { ok: pages.includes(check.page), detail: pages.length ? `images on pages ${[...new Set(pages)].join(',')}` : 'no image in the PDF' }
      })
    case 'pdf_pages':
      return onEach(ctx, check.file, (f) => {
        const n = Number(/Pages:\s+(\d+)/.exec(sh(['pdfinfo', f]).out)?.[1] ?? 0)
        return { ok: n > 0 && (!check.min || n >= check.min) && (!check.max || n <= check.max), detail: `${n} pages` }
      })
    case 'pdf_text':
      if (!has('pdftotext')) return { ok: false, detail: 'skipped: pdftotext (poppler) is not installed' }
      return onEach(ctx, check.file, (f) => {
        const t = sh(['pdftotext', '-layout', ...(check.page ? ['-f', String(check.page), '-l', String(check.page)] : []), f, '-']).out
        return { ok: t.includes(check.text), detail: t.includes(check.text) ? `has "${check.text}"` : `no "${check.text}"${check.page ? ` on page ${check.page}` : ''}` }
      })
    case 'pdf_upright':
      return onEach(ctx, check.file, (f) => {
        // a portrait page with rotation 0 (or a landscape one turned back by 90/270) reads upright
        const line = sh(['pdfinfo', '-f', String(check.page), '-l', String(check.page), f]).out
        const size = /Page\s+\d+ size:\s+([\d.]+) x ([\d.]+)/.exec(line)
        const rot = Number(/Page\s+\d+ rot:\s+(\d+)/.exec(line)?.[1] ?? 0)
        if (!size) return { ok: false, detail: `no page ${check.page}` }
        const portrait = Number(size[1]) < Number(size[2])
        const upright = portrait ? rot % 180 === 0 : rot % 180 === 90
        return { ok: upright, detail: `page ${check.page}: ${portrait ? 'portrait' : 'landscape'}, turned ${rot}` }
      })
    case 'xlsx':
      return onEach(ctx, check.file, (f) => {
        let wb: XLSX.WorkBook
        try { wb = XLSX.read(fs.readFileSync(f), { cellFormula: true }) } catch (e) { return { ok: false, detail: `unreadable: ${String(e).slice(0, 80)}` } }
        const notes: string[] = []
        let ok = true
        const sheets = wb.SheetNames.map((n) => wb.Sheets[n]!)
        if (check.header) {
          const found = sheets.some((s) => XLSX.utils.sheet_to_json<string[]>(s, { header: 1 }).slice(0, 3).some((row) => row.some((v) => String(v ?? '').includes(check.header!))))
          ok &&= found
          notes.push(found ? `header "${check.header}" found` : `no header "${check.header}"`)
        }
        if (check.formula) {
          const n = sheets.reduce((a, s) => a + Object.keys(s).filter((k) => !k.startsWith('!') && (s[k] as XLSX.CellObject).f).length, 0)
          ok &&= n > 0
          notes.push(`${n} formulas`)
        }
        if (check.chart) {
          const charts = zipList(f).filter((m) => /^xl\/charts\/chart\d+\.xml$/.test(m)).length
          ok &&= charts > 0
          notes.push(`${charts} charts`)
        }
        if (check.cell) {
          const v = sheets[0]?.[check.cell.ref] as XLSX.CellObject | undefined
          const eq = v !== undefined && String(v.v) === String(check.cell.equals)
          ok &&= eq
          notes.push(`${check.cell.ref}=${v?.v}`)
        }
        return { ok, detail: notes.join(', ') }
      })
    case 'image': {
      const list = matches(ctx, check.file)
      if (list.length < check.count) return { ok: false, detail: `${list.length} file(s) match ${check.file}, want ${check.count}` }
      const bad: string[] = []
      const ok: string[] = []
      for (const rel of list) {
        const f = abs(ctx, rel)
        const info = sh(['sips', '-g', 'format', '-g', 'pixelWidth', f]).out
        const fmt = /format:\s*(\S+)/.exec(info)?.[1] ?? '?'
        const w = Number(/pixelWidth:\s*(\d+)/.exec(info)?.[1] ?? 0)
        const py = sh(['python3', '-c', 'import sys\nfrom PIL import Image\ne = Image.open(sys.argv[1]).getexif()\nprint(len(dict(e.get_ifd(0x8825))), 1 if (e.get(0x0110) and e.get_ifd(0x8769).get(0x9003)) else 0)', f]).out.trim()
        if (!/^\d+ [01]$/.test(py)) { bad.push(`${rel}: cannot read the photo details (python3 + Pillow needed)`); continue }
        const [g, d] = py.split(' ')
        const gps = Number(g || 0) > 0, details = d === '1'
        const why: string[] = []
        if (check.format && fmt !== check.format) why.push(`format ${fmt}`)
        if (check.maxWidth && !(w > 0 && w <= check.maxWidth)) why.push(`width ${w}`)
        if (check.gps === 'kept' && !gps) why.push('location gone')
        if (check.gps === 'removed' && gps) why.push('location still there')
        if (check.details === 'kept' && !details) why.push('time or camera gone')
        if (check.details === 'removed' && details) why.push('time and camera still there')
        ;(why.length ? bad : ok).push(`${rel} (${fmt} ${w}px, location ${gps ? 'kept' : 'none'}, time+camera ${details ? 'kept' : 'none'})${why.length ? ': ' + why.join(', ') : ''}`)
      }
      return { ok: bad.length === 0, detail: [...ok, ...bad].join('; ').slice(0, 600) }
    }
    case 'docx_contains':
      return onEach(ctx, check.file, (f) => {
        const t = zipText(f, 'word/document.xml').replace(/<[^>]+>/g, '')
        return { ok: t.includes(check.text), detail: t.includes(check.text) ? `has "${check.text}"` : `no "${check.text}"` }
      })
    case 'office_chart':
      return onEach(ctx, check.file, (f) => {
        const list = zipList(f)
        const charts = list.filter((m) => /^(word|ppt)\/charts\/chart\d+\.xml$/.test(m)).length
        const books = list.filter((m) => /^(word|ppt)\/embeddings\/[^/]+\.xlsx$/.test(m)).length
        const pictures = list.filter((m) => /^(word|ppt)\/media\//.test(m)).length
        return { ok: charts > 0 && books >= charts, detail: `${charts} native charts, ${books} data workbooks, ${pictures} pictures` }
      })
    case 'pptx_slides':
      return onEach(ctx, check.file, (f) => {
        const n = zipList(f).filter((m) => /^ppt\/slides\/slide\d+\.xml$/.test(m)).length
        return { ok: n >= check.min, detail: `${n} slides` }
      })
    case 'file_contains':
    case 'file_not_contains': {
      let t = ''
      try { t = fs.readFileSync(abs(ctx, check.path), 'utf8') } catch { return { ok: check.type === 'file_not_contains', detail: `${check.path} is not there` } }
      const hit = t.includes(check.text)
      return { ok: check.type === 'file_contains' ? hit : !hit, detail: hit ? `has "${check.text}"` : `no "${check.text}"` }
    }
    case 'path_exists':
    case 'path_missing': {
      const there = fs.existsSync(abs(ctx, check.path))
      return { ok: check.type === 'path_exists' ? there : !there, detail: there ? 'there' : 'not there' }
    }
    case 'answer_matches':
    case 'answer_not_matches': {
      const hit = new RegExp(check.pattern, 'i').test(answer)
      return { ok: check.type === 'answer_matches' ? hit : !hit, detail: hit ? `answer matches /${check.pattern}/` : `answer does not match /${check.pattern}/` }
    }
    case 'tool_used': {
      const hit = check.any.filter((t) => tools.includes(t))
      return { ok: hit.length > 0, detail: hit.length ? `used ${hit.join(', ')}` : `none of ${check.any.join(', ')} (used: ${[...new Set(tools)].join(', ') || 'none'})` }
    }
    case 'page_made': {
      const files = matches(ctx, check.file)
      const ok = tools.includes('artifact') || files.length > 0
      return { ok, detail: tools.includes('artifact') ? 'used artifact' : files.length ? `saved ${files.join(', ')}` : `no artifact and nothing matches ${check.file}` }
    }
    case 'tool_not_used': {
      const hit = check.tools.filter((t) => tools.includes(t))
      return { ok: hit.length === 0, detail: hit.length ? `used ${hit.join(', ')}` : 'not used' }
    }
    case 'card_or_not_used': {
      const bad = ctx.turns.filter((t) => t.tools.some((x) => check.tools.includes(x.name)) && !t.cards.some((c) => c.origin === 'server' && !c.kind.startsWith('step-fix:')))
      return { ok: !bad.length, detail: bad.length ? `used ${check.tools.join('/')} with no card from the server (turn ${ctx.turns.indexOf(bad[0]!) + 1})` : 'not used, or used after a card' }
    }
    case 'answered': {
      // an error with the app's own message counts as answered (the judge decides if that message is right); silence,
      // a timeout or an empty answer does not
      const bad = ctx.turns.filter((t) => !['done', 'app-refused', 'error'].includes(t.status) || !t.answer.trim())
      return { ok: ctx.turns.length > 0 && !bad.length, detail: !ctx.turns.length ? 'no turn ran' : bad.length ? bad.map((t) => `${t.status}${t.error ? ` (${t.error})` : ''}${t.answer.trim() ? '' : ', empty answer'}`).join('; ') : 'every turn answered' }
    }
    case 'room_message':
    case 'no_room_message': {
      const hit = new RegExp(check.pattern, 'i').test(ctx.room)
      return { ok: check.type === 'room_message' ? hit : !hit, detail: hit ? 'the room has it' : 'not in the room' }
    }
  }
}

export async function runChecks(checks: Check[], ctx: Ctx): Promise<CheckResult[]> {
  return checks.map((check) => {
    try { return { check, ...one(check, ctx) } } catch (e) { return { check, ok: false, detail: `check failed: ${e instanceof Error ? e.message : String(e)}` } }
  })
}
