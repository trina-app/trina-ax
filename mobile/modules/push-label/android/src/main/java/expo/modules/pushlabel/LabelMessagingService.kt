// FCM's entry point for this app: expo-notifications' own service, with one change. A data-only room push (the gateway
// sends one only to a phone that registered a label key, shared/src/cloud-protocol/push-gateway.ts "Label") is shown
// with the team's title (who and where, Label.ask) and the gateway's generic line as its text. Everything else, and
// every failure, goes on exactly as expo-notifications does it: the gateway's generic title and line.
//
// The notification goes through expo-notifications (NotificationsService.receive): quiet in the foreground as the app
// asks (src/push.ts quietForeground), channel "default", and a tap reaches the app with the push's own data (the trigger
// keeps the FCM message, so content.data stays { notificationId, code, path, device, ... }).
package expo.modules.pushlabel

import android.content.Context
import expo.modules.notifications.notifications.interfaces.INotificationContent
import expo.modules.notifications.notifications.model.NotificationContent
import expo.modules.notifications.notifications.model.NotificationRequest
import expo.modules.notifications.notifications.model.RemoteNotificationContent
import expo.modules.notifications.notifications.enums.NotificationPriority
import expo.modules.notifications.notifications.model.triggers.FirebaseNotificationTrigger
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import expo.modules.notifications.service.interfaces.FirebaseMessagingDelegate as MessagingDelegate
import expo.modules.notifications.service.delegates.FirebaseMessagingDelegate

class LabelMessagingService : ExpoFirebaseMessagingService() {
  override val firebaseMessagingDelegate: MessagingDelegate by lazy { LabelMessagingDelegate(this) }
}

class LabelMessagingDelegate(context: Context) : FirebaseMessagingDelegate(context) {
  override fun createNotificationRequest(identifier: String, content: INotificationContent, notificationTrigger: FirebaseNotificationTrigger): NotificationRequest {
    val named = try { named(content, notificationTrigger) } catch (_: Throwable) { null }
    return if (named != null) super.createNotificationRequest(named.first, named.second, notificationTrigger)
    else super.createNotificationRequest(identifier, content, notificationTrigger)
  }

  /** The notification's id and words for a data-only room push, or null (then expo-notifications' own). */
  private fun named(content: INotificationContent, trigger: FirebaseNotificationTrigger): Pair<String, INotificationContent>? {
    if (content !is RemoteNotificationContent || !content.isDataOnly) return null
    val data = trigger.remoteMessage.data
    if (!Label.named(data["code"])) return null
    // the notification's id is the team's notice id, as Android's tag was with the gateway's notification block: the
    // same notice sent again replaces it
    val notificationId = data["notificationId"]?.takeIf { Label.isId(it) } ?: return null
    val generic = data["title"]?.takeIf { it.isNotEmpty() }
    val text = data["message"]?.takeIf { it.isNotEmpty() } ?: return null
    val title = Label.ask(data, Label.access(LabelStore(context).read())) ?: generic
    val words = NotificationContent.Builder()
      .setTitle(title)
      .setText(text)
      .setPriority(NotificationPriority.HIGH)
      .useDefaultSound()
      .setAutoDismiss(true)
      .build()
    return notificationId to words
  }
}
