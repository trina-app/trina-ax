// Cut a picked photo to a square of AVATAR_PX in a canvas before it is sent (shared/src/avatar.ts). Drawing it again
// leaves out everything the file carried besides the picture (camera data, the place it was taken); the server cuts
// metadata out too and does not trust this.
import { AVATAR_MAX_BYTES, AVATAR_PX } from '@mycel/shared'

const INPUT_TYPES = ['image/png', 'image/jpeg', 'image/webp']
export const isPhotoFile = (f: File) => INPUT_TYPES.includes(f.type)

export interface Photo { blob: Blob; type: string; url: string }

/** The centre square of the picture at AVATAR_PX × AVATAR_PX, as WebP (JPEG where the browser cannot write WebP); null when the file is no picture. */
export async function squarePhoto(file: File): Promise<Photo | null> {
  if (!isPhotoFile(file)) return null
  let bitmap: ImageBitmap
  try { bitmap = await createImageBitmap(file) } catch { return null }
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    if (!side) return null
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = AVATAR_PX
    const g = canvas.getContext('2d')
    if (!g) return null
    g.imageSmoothingQuality = 'high'
    g.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX)
    for (const [type, q] of [['image/webp', 0.9], ['image/jpeg', 0.9], ['image/jpeg', 0.7]] as const) {
      const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, type, q))
      if (blob && blob.type === type && blob.size <= AVATAR_MAX_BYTES) return { blob, type, url: URL.createObjectURL(blob) }
    }
    return null
  } finally {
    bitmap.close()
  }
}
