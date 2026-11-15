// JS side of the label item (src/push.ts labels on Android): read, write and delete it. The key never crosses the
// bridge to the page; only the app's own code calls this.
package expo.modules.pushlabel

import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PushLabelModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PushLabel")

    AsyncFunction("getItem") {
      store().read()
    }

    AsyncFunction("setItem") { value: String? ->
      if (!store().write(value)) throw IllegalStateException("push label item not stored")
    }
  }

  private fun store() = LabelStore(appContext.reactContext ?: throw Exceptions.ReactContextLost())
}
