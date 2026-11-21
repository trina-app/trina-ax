// The label item on this phone (src/labels.ts): the team's origin, this phone's device id there and the label key. The
// app writes it through PushLabelModule; LabelMessagingService reads it. Encrypted with an AES key in the Android
// Keystore that never leaves this phone, so a backup restored on another phone (or after a reinstall) cannot read it:
// the same promise as the iPhone's AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY keychain item. Before the phone's first unlock
// the app's storage is closed, the read fails and the push keeps the generic title.
package expo.modules.pushlabel

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class LabelStore(context: Context) {
  companion object {
    const val FILE = "team-ax.push-label"
    const val ITEM = "label"
    const val ALIAS = "team-ax.push-label"
    private const val KEYSTORE = "AndroidKeyStore"
    private val lock = Any()
  }

  private val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

  /** The stored text, or null (none, or one this phone's key cannot read). */
  fun read(): String? = synchronized(lock) {
    try {
      val stored = prefs.getString(ITEM, null) ?: return null
      val parts = stored.split(':')
      if (parts.size != 2) return null
      val key = existingKey() ?: return null
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
      String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
    } catch (_: Exception) { null }
  }

  /** Writes the text, or deletes the item (null). Returns whether it is stored as asked. */
  fun write(value: String?): Boolean = synchronized(lock) {
    if (value == null) return prefs.edit().remove(ITEM).commit()
    if (value.length > 2048) return false
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, existingKey() ?: newKey())
    val sealed = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    prefs.edit().putString(ITEM, sealed).commit()
  }

  private fun existingKey(): SecretKey? {
    val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    return (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey
  }

  private fun newKey(): SecretKey {
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    gen.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return gen.generateKey()
  }
}
