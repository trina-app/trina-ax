// The lock screen of a named room push, as the iPhone's default (Show Previews: When Unlocked;
// docs/decisions/20261121-android-push-who-where.md "Lock screen"): while the phone is locked, Android shows only the
// gateway's generic title and line; who, where and the first line show once it is unlocked. Android's own lock-screen
// setting still applies on top: "hide sensitive content" shows the same generic words, "don't show notifications" none.
//
// expo-notifications posts every notification from its NotificationsService (a broadcast receiver it finds by the
// action expo.modules.notifications.NOTIFICATION_EVENT). This subclass is the app's only one (plugins/push-label.js
// removes expo-notifications' receiver from the manifest), and its presentation delegate adds the public version to
// the notification expo-notifications built. Everything else is expo-notifications' own.
package expo.modules.pushlabel

import android.app.Notification as AndroidNotification
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.graphics.drawable.IconCompat
import expo.modules.notifications.notifications.model.Notification
import expo.modules.notifications.notifications.model.NotificationBehaviorRecord
import expo.modules.notifications.notifications.model.triggers.FirebaseNotificationTrigger
import expo.modules.notifications.service.NotificationsService
import expo.modules.notifications.service.delegates.ExpoPresentationDelegate
import expo.modules.notifications.service.interfaces.PresentationDelegate

class LabelNotificationsService : NotificationsService() {
  override fun getPresentationDelegate(context: Context): PresentationDelegate = LabelPresentationDelegate(context)
}

class LabelPresentationDelegate(context: Context) : ExpoPresentationDelegate(context) {
  override suspend fun createNotification(notification: Notification, notificationBehavior: NotificationBehaviorRecord?): AndroidNotification {
    val built = super.createNotification(notification, notificationBehavior)
    try { lockScreen(notification, built) } catch (_: Throwable) {}
    return built
  }

  /** A data-only room push (the gateway's Label, with its generic words in data): the public version is those words. */
  private fun lockScreen(notification: Notification, built: AndroidNotification) {
    val trigger = notification.notificationRequest.trigger as? FirebaseNotificationTrigger ?: return
    val data = trigger.remoteMessage.data
    if (trigger.remoteMessage.notification != null || !Label.named(data["code"])) return
    val title = data["title"]?.let { Label.plain(it) }?.takeIf { it.isNotEmpty() } ?: return
    val text = data["message"]?.let { Label.plain(it, 200) }?.takeIf { it.isNotEmpty() } ?: return
    val channelId = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) built.channelId else null
    val builder = if (channelId != null) NotificationCompat.Builder(context, channelId) else NotificationCompat.Builder(context)
    val icon = built.smallIcon?.let { IconCompat.createFromIcon(context, it) }
    if (icon != null) builder.setSmallIcon(icon) else builder.setSmallIcon(context.applicationInfo.icon)
    built.visibility = NotificationCompat.VISIBILITY_PRIVATE
    built.publicVersion = builder
      .setContentTitle(title)
      .setContentText(text)
      .setWhen(built.`when`)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .build()
  }
}
