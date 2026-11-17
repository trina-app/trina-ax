// make_file pptx (pandoc path): a picture added to a slide that has text (TC-4445). pandoc puts "text followed by
// a picture" on its "Content with Caption" layout: the title becomes the small bold caption title, the text goes into
// the small caption box without bullets, and the picture's alt text is written once more as a caption under the
// picture (often repeating what the picture itself says). So a deck where one slide got a photo looked broken next
// to its other slides.
// Before the second pandoc run, such a slide is rewritten into two columns (text, picture), which pandoc puts on the
// "Two Content" layout: the title and the text keep the layout's size and bullets like every other slide. The alt
// text of those pictures is dropped, so no caption is drawn (pandoc names the picture after its file either way).
// Slides that already use columns, pictures alone, pictures inside a sentence, slides with more than one picture and
// slides with a table are left as they are.

type Node = { t?: string; c?: unknown }

const level = (b: Node) => (b.t === 'Header' && Array.isArray(b.c) ? Number(b.c[0]) : 0)
const classes = (b: Node): string[] => {
  if (b.t !== 'Div' || !Array.isArray(b.c)) return []
  const attr = b.c[0]
  return Array.isArray(attr) && Array.isArray(attr[1]) ? (attr[1] as string[]) : []
}
const isNotes = (b: Node) => classes(b).includes('notes')
const isColumns = (b: Node) => classes(b).includes('columns')

const BLANK = new Set(['Space', 'SoftBreak', 'LineBreak'])
/** the inlines of a paragraph that holds nothing but pictures, else null */
function pictureInlines(b: Node): Node[] | null {
  if ((b.t !== 'Para' && b.t !== 'Plain') || !Array.isArray(b.c)) return null
  const xs = b.c as Node[]
  return xs.some((x) => x.t === 'Image') && xs.every((x) => x.t === 'Image' || BLANK.has(x.t ?? '')) ? xs : null
}
/** a Figure (pandoc's implicit figure from `![alt](path)` on its own line): its pictures, else null */
function figureInlines(b: Node): Node[] | null {
  if (b.t !== 'Figure' || !Array.isArray(b.c) || !Array.isArray(b.c[2])) return null
  const out: Node[] = []
  for (const x of b.c[2] as Node[]) {
    const p = pictureInlines(x)
    if (!p) return null
    out.push(...p)
  }
  return out.length ? out : null
}
/** the picture as a paragraph with no alt text (pandoc draws the alt text as a caption) */
function bare(inlines: Node[]): Node {
  for (const x of inlines) if (x.t === 'Image' && Array.isArray(x.c)) x.c[1] = []
  return { t: 'Para', c: inlines }
}
const column = (blocks: Node[]): Node => ({ t: 'Div', c: [['', ['column'], []], blocks] })

/** Rewrites, in place, the slides of a pandoc document tree that hold both text and a picture (see above). */
export function pictureBesideText(ast: { blocks?: Node[] }, slideLevel: number): void {
  const blocks = Array.isArray(ast.blocks) ? ast.blocks : []
  const out: Node[] = []
  let body: Node[] = []
  const flush = () => {
    const notes = body.filter(isNotes)
    const rest = body.filter((b) => !isNotes(b))
    const pics = rest.map((b) => figureInlines(b) ?? pictureInlines(b))
    const images = pics.flatMap((p) => p ?? []).filter((x) => x.t === 'Image').length
    const hasText = pics.some((p) => p === null)
    // one picture only: pandoc draws just the first picture of a column. No table: text then a table in one column
    // goes on the "Comparison" layout, with the text in its small heading box.
    if (images !== 1 || !hasText || rest.some((b) => isColumns(b) || b.t === 'Table')) { out.push(...body); body = []; return }
    const text = rest.filter((_, i) => pics[i] === null)
    const pictures = pics.filter((p): p is Node[] => p !== null).map(bare)
    // the column that comes first in the Markdown stays on the left
    const pictureFirst = pics[0] !== null
    const cols = pictureFirst ? [column(pictures), column(text)] : [column(text), column(pictures)]
    out.push({ t: 'Div', c: [['', ['columns'], []], cols] }, ...notes)
    body = []
  }
  for (const b of blocks) {
    const l = level(b)
    if ((l >= 1 && l <= slideLevel) || b.t === 'HorizontalRule') { flush(); out.push(b); continue }
    body.push(b)
  }
  flush()
  ast.blocks = out
}
