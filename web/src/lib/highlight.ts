// Split a text into parts for a match highlight (file content search, R2-ETC-02). The match is literal text in any
// case, as the server's search (ripgrep -F -i). The caller renders the parts as text nodes and <mark>, never as HTML.

export interface TextPart { text: string; match: boolean }

export function highlightParts(text: string, query: string): TextPart[] {
  const q = query.trim().normalize('NFC')
  const s = text.normalize('NFC')
  if (!q) return [{ text: s, match: false }]
  const low = s.toLowerCase(), lq = q.toLowerCase()
  // toLowerCase can change the length of some characters; then the text is shown without a highlight
  if (low.length !== s.length || lq.length !== q.length) return [{ text: s, match: false }]
  const parts: TextPart[] = []
  let from = 0
  for (let at = low.indexOf(lq); at >= 0; at = low.indexOf(lq, at + lq.length)) {
    if (at > from) parts.push({ text: s.slice(from, at), match: false })
    parts.push({ text: s.slice(at, at + lq.length), match: true })
    from = at + lq.length
  }
  if (from < s.length || !parts.length) parts.push({ text: s.slice(from), match: false })
  return parts
}
