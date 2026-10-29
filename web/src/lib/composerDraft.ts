/** Append a recovery request for review without discarding a draft or duplicating a repeated click. */
export function mergeDraft(current: string, request: string): string {
  if (!request || current.includes(request)) return current
  return current ? `${current}\n\n${request}` : request
}
