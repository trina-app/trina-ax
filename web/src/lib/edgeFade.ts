// A row that scrolls sideways on a phone (tabs, the Admin menu) fades at an edge that has more behind it, so a cut
// label reads as "scroll for more". This says which edges: 2px of slack, so a row that fits never fades.

export function edgeFade(scrollLeft: number, scrollWidth: number, clientWidth: number): { start: boolean; end: boolean } {
  if (scrollWidth - clientWidth <= 2) return { start: false, end: false }
  // right-to-left rows report a scrollLeft of 0 down to a negative number: the distance from the start is its size
  const fromStart = Math.abs(scrollLeft)
  return { start: fromStart > 2, end: fromStart < scrollWidth - clientWidth - 2 }
}
