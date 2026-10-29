import path from 'node:path'
import type { FileService, ToolCtx } from '../files/service'
import { ext } from '../files/extract'
import { Denied, ToolError } from '../policy/errors'
import { deckShape, deckMismatch, type Deck } from '../tools/pptx-check'
import { normalizeImage, pptxAst, renderPptx, validatePptx, SAFE_INPUT_MAX } from './runner'
import { snapshot, recheck, type SourceSnapshot } from './source'
import { safeText } from './strings'
import { referencePptx } from './reference'

/** No inherited metadata/attributes can introduce a hidden background-image or remote asset. */
export async function preparePresentation(
  files: FileService,
  c: ToolCtx,
  pandoc: string,
  text: string,
  base: string[],
  want: { slides?: number; notes?: number; layouts?: string[] },
  sources: SourceSnapshot[],
) {
  const limit = () => new ToolError(safeText(files.db, c.user.id, 'limit'), 'safe_ops_limit')
  if (text.length > 100_000) throw limit()
  const ast = JSON.parse((await pptxAst(pandoc, text, c.signal)).toString())
  for (const key of Object.keys(ast.meta ?? {}))
    if (!['title', 'author', 'date'].includes(key)) throw new ToolError(safeText(files.db, c.user.id, 'input'))
  const shape = deckShape(ast)
  const inputs: Record<string, Uint8Array> = { 'reference.pptx': referencePptx() }
  const stack: unknown[] = [ast]
  let nodes = 0,
    images = 0,
    chars = 0,
    inputBytes = 0
  while (stack.length) {
    const v = stack.pop()
    if (++nodes > 20_000) throw limit()
    if (typeof v === 'string') {
      chars += v.length
      if (chars > 200_000) throw limit()
      continue
    }
    if (Array.isArray(v)) {
      stack.push(...v)
      continue
    }
    if (!v || typeof v !== 'object') continue
    const node = v as any
    if (['RawBlock', 'RawInline', 'Link'].includes(node.t))
      throw new ToolError(safeText(files.db, c.user.id, 'input'))
    // Only layout classes survive; all attributes (especially background-image) are refused.
    const attr =
      node.t === 'Header'
        ? node.c?.[1]
        : ['Div', 'Span', 'Code', 'CodeBlock', 'Image'].includes(node.t)
          ? node.c?.[0]
          : null
    if (Array.isArray(attr) && Array.isArray(attr[2]) && attr[2].length)
      throw new ToolError(safeText(files.db, c.user.id, 'input'))
    if (node.t === 'Image') {
      if (++images > 20) throw limit()
      const target = node.c?.[2]?.[0]
      if (typeof target !== 'string' || /^(?:[a-z][a-z0-9+.-]*:|[/\\~])/i.test(target))
        throw new Denied('image not found or no access')
      let decoded: string
      try {
        decoded = decodeURIComponent(target)
      } catch {
        throw new Denied('image not found or no access')
      }
      const candidates = [path.posix.normalize([...base, decoded].join('/')), path.posix.normalize(decoded)]
      let source: SourceSnapshot | undefined
      for (const candidate of candidates) {
        if (candidate.startsWith('..')) continue
        try {
          source = snapshot(files, c, candidate, SAFE_INPUT_MAX)
          break
        } catch {}
      }
      if (!source) throw new Denied('image not found or no access')
      inputBytes += source.bytes.length
      if (inputBytes > 32 * 1024 ** 2) throw limit()
      const image = await normalizeImage(ext(source.path), source.bytes, c.signal)
      files.quarantine.add(image,'image')
      recheck(files, c, source)
      sources.push(source)
      const name = 'image-' + images + '.jpg'
      inputs[name] = image
      node.c[2][0] = '/inputs/' + name
    }
    stack.push(...Object.values(node))
  }
  const bytes = await renderPptx(pandoc, JSON.stringify(ast), shape.level, inputs, c.signal)
  const deck = JSON.parse((await validatePptx(bytes, c.signal)).toString()) as Deck
  const mismatch = deckMismatch(deck, shape, want)
  if (mismatch) throw new ToolError(mismatch)
  for (const s of sources) recheck(files, c, s)
  return { bytes, deck }
}

