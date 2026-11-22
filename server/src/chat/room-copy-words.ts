// The AI's sentences about who may open something, left out of an answer's room copy (chat/answer-share.ts).
/**
 * The AI's words about who may open something ("이 파일은 지금 저만 열 수 있습니다", "only you can open it") are true in the
 * chat they were written in, not in a room (QA TC-r2b-06: the file went with the message and everyone there could open
 * it): such a sentence is left out of the room's copy, where each link shows who can open it. Code blocks stay as they are.
 */
export function dropWhoCanOpen(text: string): string {
  let fence = false
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; out.push(line); continue }
    if (fence || !WHO_CAN_OPEN.some((re) => re.test(line))) { out.push(line); continue }
    // the sentences of the line, each with its end mark and the space after it
    // (a sentence ends at a mark followed by a space or the line's end: "report.pdf" stays one word)
    const parts = line.match(/.+?(?:[.!?。！？]+(?=\s|$)|$)\s*/g) ?? [line]
    const kept = parts.filter((p) => !WHO_CAN_OPEN.some((re) => re.test(p))).join('').replace(/\s+$/, '')
    // a line that was only such a sentence (a list item too) goes whole
    if (kept.replace(/^\s*([-*+]|\d+[.)])?\s*/, '').trim()) out.push(kept)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}
const WHO_CAN_OPEN: RegExp[] = [
  /(저|제가|나|내가|본인|당신|회원님|사용자님|고객님)만\s*(이\s*)?(열|볼|보실|여실|열어\s*볼|확인할|확인하실|접근할|접근하실)\s*수\s*있/,
  // only a person named by name may open it (QA TC-f2-c03)
  // (only the AI's own note about a file, the end of its sentence: never content such as a document only one person may see)
  /(지금은|현재|아직|파일은|문서는|폴더는|이 파일|그 파일)[^.!?。]{0,40}[가-힣A-Za-z]{1,20}\s*(님|씨)만\s*(이\s*)?(열|볼|보실|여실|열어\s*볼|접근할|접근하실)\s*수\s*(있어요|있습니다|있음)(?=[.!?。]|\s*$)/,
  /(다른\s*(사람|분|팀원)[은들이]*|아무도)[^.!?。]{0,30}(파일|문서|채팅|대화|링크|폴더)[^.!?。]{0,20}(열|볼|접근할)\s*수\s*(없|있지\s*않)/,
  /(파일|문서|채팅|대화|링크|폴더)[^.!?。]{0,30}(다른\s*(사람|분|팀원)[은들이]*|아무도)[^.!?。]{0,20}(열|볼|접근할)\s*수\s*(없|있지\s*않)/,
  /\bonly (you|i|me|the user)\b[^.!?]{0,40}\b(can|could|are able to)\s+(open|see|view|access)\b/i,
  /\bonly (you|i|me|the user) (have|has) access\b/i,
  /\b(no one|nobody) else\b[^.!?]{0,40}\b(can|could)\s+(open|see|view|access)\b/i,
  /\b(only visible to|private to) (you|me)\b/i,
  /(あなた|自分|私)だけ(が)?[^。]{0,15}(開け|開く|見られ|見る|閲覧)/,
  /只有(你|您|我)[^。]{0,10}(能|可以)(打开|看到|查看|访问)/,
  /\bsolo (tú|usted|yo)\b[^.!?]{0,40}\b(puede|puedes|puedo|pueden)\s+(abrir|ver|acceder)\b/i,
  /\bhanya (kamu|anda|saya)\b[^.!?]{0,40}\b(bisa|dapat)\s+(membuka|melihat|mengakses)\b/i,
]
