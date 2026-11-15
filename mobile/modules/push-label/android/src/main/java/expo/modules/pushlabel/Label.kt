// Who and where in a room push on Android (docs/DECISIONS.md "Android notifications name who and where"), the same rules
// as the iPhone's notification service extension (plugins/notification-service/NotificationService.swift). A room push
// (code room.*) or a chat shared by name (chat.shared) comes data-only with the gateway's generic words in `data`. The
// app asks its own team, with the label key it keeps on this phone (LabelStore), for the title: who and where ("민준 ·
// #마케팅 › 스레드", a DM "민준"), never the message's text. The text stays the gateway's generic line.
//
// It asks only the team address the app stored, never anything from the payload, over https, without cookies, cache or
// redirects, for at most TIMEOUT_MS; on any failure the generic title stays.
package expo.modules.pushlabel

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.HttpsURLConnection

/** What the app keeps for the messaging service (src/labels.ts LabelItem, once the team registered the phone). */
data class LabelAccess(val origin: String, val deviceId: String, val key: String)

object Label {
  /** the whole ask, connection and answer: FCM gives a high-priority message about 20 s, the phone shows it after this */
  const val TIMEOUT_MS = 4_000L
  const val MAX_ANSWER = 4096

  /** [A-Za-z0-9_-]{min,max}: the ids and keys the team server uses */
  fun token(s: String?, min: Int, max: Int): Boolean =
    s != null && s.length in min..max && s.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_' }

  fun isId(s: String?) = token(s, 1, 100)

  /** A room notice (who and where) or a chat shared with the person by name (who shared it, never the chat's title). */
  fun named(code: String?) = code != null && (code.startsWith("room.") || code == "chat.shared")

  /** https://host[:port] and nothing else (the app saved the team's origin, src/address.ts), or null. */
  fun teamOrigin(raw: String?): String? {
    if (raw == null || raw.length > 2048) return null
    val u = try { URI(raw) } catch (_: Exception) { return null }
    val host = u.host
    if (u.scheme != "https" || host.isNullOrEmpty() || u.rawUserInfo != null || u.rawQuery != null || u.rawFragment != null || !u.rawPath.isNullOrEmpty()) return null
    val origin = if (u.port == -1) "https://$host" else "https://$host:${u.port}"
    return if (origin == raw) origin else null
  }

  /** The stored item (src/labels.ts: { v: 1, origin, key, deviceId }), or null without a device id or when it is odd. */
  fun access(raw: String?): LabelAccess? {
    if (raw == null || raw.length > 2048) return null
    return try {
      val o = JSONObject(raw)
      if (o.optInt("v", 0) != 1) return null
      val origin = teamOrigin(o.optString("origin", "")) ?: return null
      val deviceId = o.optString("deviceId", "").takeIf { isId(it) } ?: return null
      val key = o.optString("key", "").takeIf { token(it, 43, 43) } ?: return null
      LabelAccess(origin, deviceId, key)
    } catch (_: Exception) { null }
  }

  /** The ask's address and body for this push of this phone's device on its current team, or null. */
  fun request(data: Map<String, String>, access: LabelAccess?): Pair<URL, String>? {
    if (access == null || !named(data["code"])) return null
    val notificationId = data["notificationId"]?.takeIf { isId(it) } ?: return null
    // a push for another device (a previous team's) is not this item's to ask about
    if (data["device"] != access.deviceId) return null
    val url = URL("${access.origin}/api/push/devices/${access.deviceId}/label")
    if (url.protocol != "https" || "https://${url.authority}" != access.origin) return null
    return url to JSONObject().put("key", access.key).put("notificationId", notificationId).toString()
  }

  /** The team's title: a 200 JSON object with a title, or null (an empty answer, an older server, anything else). */
  fun title(status: Int, contentType: String?, body: ByteArray?): String? {
    if (status != 200 || body == null || body.size > MAX_ANSWER || !(contentType ?: "").lowercase().startsWith("application/json")) return null
    return try {
      val raw = JSONObject(String(body, Charsets.UTF_8)).opt("title") as? String ?: return null
      plain(raw).takeIf { it.isNotEmpty() }
    } catch (_: Exception) { null }
  }

  /** One plain line, the server's plainLabel again (shared/src/api/notifications.ts): no control or format characters
   * (bidirectional overrides, zero-width spaces; the emoji joiner stays), no line breaks, single spaces, at most `max`. */
  fun plain(s: String, max: Int = 120): String {
    val b = StringBuilder()
    var i = 0
    while (i < s.length) {
      val c = s.codePointAt(i)
      i += Character.charCount(c)
      if (c == 0x200D) { b.appendCodePoint(c); continue }
      when (Character.getType(c).toByte()) {
        Character.FORMAT -> {}
        Character.CONTROL, Character.LINE_SEPARATOR, Character.PARAGRAPH_SEPARATOR -> b.append(' ')
        else -> b.appendCodePoint(c)
      }
    }
    val line = b.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
    if (line.codePointCount(0, line.length) <= max) return line
    return line.substring(0, line.offsetByCodePoints(0, max - 1)).trimEnd() + "…"
  }

  /** Asks the team; the title, or null on any failure or after TIMEOUT_MS. Blocks the caller (FCM's worker thread). */
  fun ask(data: Map<String, String>, access: LabelAccess?): String? {
    val (url, body) = request(data, access) ?: return null
    val result = AtomicReference<String?>(null)
    val conn = url.openConnection() as? HttpsURLConnection ?: return null
    val worker = Thread {
      try {
        conn.instanceFollowRedirects = false
        conn.useCaches = false
        conn.connectTimeout = TIMEOUT_MS.toInt()
        conn.readTimeout = TIMEOUT_MS.toInt()
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("Accept", "application/json")
        // the team server's CSRF rule for a request without a session (server/src/http/middleware.ts)
        conn.setRequestProperty("x-mycel-csrf", "1")
        conn.setRequestProperty("Cookie", "")
        conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        val status = conn.responseCode
        val bytes = if (status == HttpURLConnection.HTTP_OK) readAtMost(conn, MAX_ANSWER + 1) else null
        result.set(title(status, conn.contentType, bytes))
      } catch (_: Exception) {
      } finally { conn.disconnect() }
    }
    worker.isDaemon = true
    worker.start()
    worker.join(TIMEOUT_MS)
    if (worker.isAlive) { conn.disconnect(); return null }
    return result.get()
  }

  private fun readAtMost(conn: HttpURLConnection, limit: Int): ByteArray? {
    val out = ByteArrayOutputStream()
    conn.inputStream.use { input ->
      val buf = ByteArray(1024)
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        out.write(buf, 0, n)
        if (out.size() > limit) return null
      }
    }
    return out.toByteArray()
  }
}
