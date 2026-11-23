// A silent sync push (code phone.sync, docs/AGENTS/plan/20261123-0705-phone-badge-sync.md): the person read things on
// another device, and the team lists the notices it pushed to this phone that are read now (`clear`, ids joined by ","),
// the whole set of the push day each time. This takes those off the tray, as Slack does, and the launcher's count
// follows. Nothing is ever shown for a sync: LabelMessagingDelegate stops it here, before expo-notifications.
//
// The tray entry of a notice has the notice id as its tag: drawn by the system from the push's notification block (the
// gateway's android.notification.tag), or posted by expo-notifications with that id as its identifier (data.tag, or the
// notice id LabelMessagingDelegate gives a named room push). Group summaries left without a notification go too.
package expo.modules.pushlabel

import android.app.Notification
import android.app.NotificationManager
import android.content.Context

object Sync {
  const val CODE = "phone.sync"
  /** the contract's PUSH_SYNC_MAX_CLEAR */
  const val MAX_CLEAR = 40

  fun isSync(data: Map<String, String>): Boolean = data["code"] == CODE

  /** The listed notice ids, only well-formed ones, at most MAX_CLEAR. */
  fun ids(data: Map<String, String>): Set<String> =
    (data["clear"] ?: "").split(',').filter { Label.isId(it) }.take(MAX_CLEAR).toSet()

  /** Takes the listed notices off the tray. Never throws. */
  fun apply(context: Context, data: Map<String, String>) {
    try {
      val ids = ids(data)
      if (ids.isEmpty()) return
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
      val summary = { n: android.service.notification.StatusBarNotification -> (n.notification.flags and Notification.FLAG_GROUP_SUMMARY) != 0 }
      val active = nm.activeNotifications
      val gone = active.filter { !summary(it) && it.tag != null && it.tag in ids }
      for (n in gone) nm.cancel(n.tag, n.id)
      if (gone.isEmpty()) return
      val left = active.filterNot { n -> gone.any { it.tag == n.tag && it.id == n.id } }
      for (s in left.filter(summary)) {
        val group = s.notification.group ?: continue
        if (left.none { !summary(it) && it.notification.group == group }) nm.cancel(s.tag, s.id)
      }
    } catch (_: Throwable) {}
  }
}
