// Documents and media by their name's extension (docs/decisions/20261119-channel-project-link.md): the kinds a person
// saves into a linked project's folder in one click (Save to project), and the AI saves there from the channel's side
// chat without the room card. Nothing a project's dev environment runs by its name (a script, a config, a Makefile) and
// nothing that can hold script when opened (svg, html). Anything else goes through the save sheet or a card.

/** The extensions (lower case, no dot). */
export const PROJECT_PLAIN_EXT: readonly string[] = [
  'md', 'txt', 'csv', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'hwp', 'hwpx',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'mp4', 'mov', 'webm', 'mp3', 'm4a', 'wav',
]
const PLAIN = new Set(PROJECT_PLAIN_EXT)

/** Is this file name a document or media kind (its last extension, after NFKC, any case)? A dotfile, a name with no
 * extension and an empty name are not. `x.pdf.sh` is a `.sh`. */
export function isProjectPlainName(name: string): boolean {
  const n = name.normalize('NFKC').trim()
  const base = n.split('/').pop() ?? ''
  if (!base || base.startsWith('.')) return false
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return false
  return PLAIN.has(base.slice(dot + 1).toLowerCase())
}
