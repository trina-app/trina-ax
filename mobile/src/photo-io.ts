// The system photo picker and the app's copies of what was picked (photo-pick-v1; the rules are in src/photos.ts).
// The page never gets a path or a URL: only names, types, sizes and the bytes, chunk by chunk.
import * as ImagePicker from 'expo-image-picker'
import { Directory, File, Paths } from 'expo-file-system'
import { Platform } from 'react-native'
import { base64Bytes, PhotoRefused, type PickIO } from './photos'

/** expo-image-picker keeps its copies in the cache's ImagePicker folder on both platforms. Startup empties it: a copy
 * left by a pick the app never finished (it was closed) is no one's. */
export function clearPickCache() { try { const dir = new Directory(Paths.cache, 'ImagePicker'); if (dir.exists) dir.delete() } catch { /* the OS may empty the cache itself */ } }

/** Android's older picker asks for storage access; iOS's PHPicker and Android's photo picker never ask. */
const refused = (error: unknown) => /permission/i.test(`${(error as { code?: unknown })?.code ?? ''} ${(error as Error)?.message ?? ''}`)

export function photoPickIO(): PickIO {
  return {
    async launch(limit) {
      let result: ImagePicker.ImagePickerResult
      try {
        result = await ImagePicker.launchImageLibraryAsync({
          // what the web input took (image/*,video/*); several at once, in the order picked
          mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, selectionLimit: limit, orderedSelection: true,
          // iOS: a HEIC photo comes as JPEG (an HEVC video as H.264), re-encoded at 0.9, which also drops its location and
          // other metadata. Android: the original bytes, as its file input gave them (re-encoding there would turn a GIF or
          // a WebP into a still PNG).
          preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
          quality: Platform.OS === 'ios' ? 0.9 : 1,
          exif: false, base64: false, legacy: false,
          // a photo kept only in iCloud comes down while the picker reads it
          shouldDownloadFromNetwork: true,
        })
      } catch (error) { throw refused(error) ? new PhotoRefused('photo_denied') : error }
      if (result.canceled || !result.assets) return []
      // the size of the copy on disk, not what the picker says (Android reports the original's)
      return result.assets.map(a => { const f = new File(a.uri); return { uri: a.uri, name: a.fileName, mime: a.mimeType, size: f.exists ? f.size : 0 } })
    },
    async read(uri, offset, length) {
      const handle = new File(uri).open()
      try {
        handle.offset = offset
        return base64Bytes(await handle.readBytes(length))
      } finally { handle.close() }
    },
    async remove(uri) { const f = new File(uri); if (f.exists) f.delete() },
  }
}
