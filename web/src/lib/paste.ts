// The files a paste carries (a screenshot, a picture copied in a browser or the desktop app, a file copied in Finder or
// Explorer), for the message boxes (components/rooms/RoomComposer.tsx, components/chat/Composer.tsx). The clipboard's
// `files` and its file `items` are the same files in today's browsers; where `files` comes empty, the items give them.
export function pastedFiles(data: Pick<DataTransfer, 'files' | 'items'> | null | undefined): File[] {
  if (!data) return []
  const files = Array.from(data.files ?? [])
  if (files.length) return files
  return Array.from(data.items ?? [])
    .filter((i) => i.kind === 'file')
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f)
}
