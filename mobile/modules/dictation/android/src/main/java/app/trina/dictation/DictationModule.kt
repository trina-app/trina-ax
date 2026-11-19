// Voice input on this Android phone, for the app's bridge (src/dictation.ts, capability dictation-v1;
// docs/decisions/20261119-android-dictation.md): the same calls as the iPhone's module (ios/DictationModule.swift), but
// the system's SpeechRecognizer opens the microphone itself (Android 12 cannot be handed the page's sound), so check()
// says `micInApp` and the page records nothing then; push() is ignored. Only the phone's on-device recognizer is used
// (createOnDeviceSpeechRecognizer, Android 12+; Android 13+ says which languages it has and fetches a missing one):
// never the phone's default recognizer, which may send the sound to its maker (2026-11-19 decision). A phone without an
// on-device recognizer for the language says unsupported, and the team server transcribes. Partial results are guesses; Android ends an utterance at a
// pause and the recognizer is started again at once until stop(). Events, by the id start() was given: text,
// level (0-1, the page's wave), done (after stop, every word final), error (it ended on its own; the words stay).
package app.trina.dictation

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.LocaleList
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Locale

private const val EVENT = "onDictation"
/** no "ready for speech" by then: the recognizer did not start (the page uses the team server) */
private const val START_TIMEOUT_MS = 4000L
/** after stop(), the last words by then, else what was heard is the text */
private const val STOP_TIMEOUT_MS = 2500L
/** the wave: at most one level this often */
private const val LEVEL_EVERY_MS = 80L
/** the longest text one event carries (src/protocol.ts MAX_DICTATION_TEXT) */
private const val MAX_TEXT = 20_000
/** after "ready for speech", this long before start() says yes: a recognizer that lacks the language (Google's
 * offline Speech Services without that language pack, measured on the Note10) refuses it within a few milliseconds of
 * being ready; that is a start that did not happen (the team server, silently), not a recording that stopped. The
 * microphone already listens meanwhile, so no word is lost. */
private const val CONFIRM_MS = 500L
/** a model download (Android 13+) asked about every 2 s for this long, then 'failed' */
private const val INSTALL_DEADLINE_MS = 65_000L

class DictationModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var session: Session? = null
  /** what check() found per locale: the on-device recognizer has it (true) or only the default one (false) */
  private val onDeviceFor = mutableMapOf<String, Boolean>()
  /** locales a recognizer refused (no language pack): check() says unsupported for them until the app restarts */
  private val refused = mutableSetOf<String>()

  override fun definition() = ModuleDefinition {
    Name("Dictation")
    Events(EVENT)

    /** { state: ready | needs-model | unsupported, locale, onDevice, micInApp: true } */
    AsyncFunction("check") { language: String, promise: Promise -> check(language, promise) }.runOnQueue(Queues.MAIN)
    /** the on-device model for the language (Android 13+): installed | failed | unsupported */
    AsyncFunction("install") { _: Int, language: String, promise: Promise -> install(language, promise) }.runOnQueue(Queues.MAIN)
    /** a recording `id`: true once the recognizer listens, false when it cannot (the team server then) */
    AsyncFunction("start") { id: Int, language: String, promise: Promise ->
      session?.cancel()
      session = null
      val ctx = appContext.reactContext?.applicationContext
      val tag = language.takeIf { Regex("^[a-z]{2,3}$").matches(it) }?.let { localeTag(it) }
      if (ctx == null || tag == null) { promise.resolve(false); return@AsyncFunction }
      // the recognizer the page was told about (check): never the default one where it was told "on the phone"
      val wantOnDevice = onDeviceFor[tag] ?: (Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx))
      val s = Session(ctx, id, tag, wantOnDevice)
      session = s
      s.begin { ok -> promise.resolve(ok) }
    }.runOnQueue(Queues.MAIN)
    /** the page's sound: not used here (the recognizer has the microphone) */
    Function("push") { _: Int, _: String -> }
    AsyncFunction("stop") { id: Int -> session?.takeIf { it.id == id }?.stop() }.runOnQueue(Queues.MAIN)
    AsyncFunction("cancel") { id: Int -> session?.takeIf { it.id == id }?.let { it.cancel(); session = null } }.runOnQueue(Queues.MAIN)
    // the app went to the background: the microphone stops, the words so far are the text
    OnActivityEntersBackground { main.post { session?.stop() } }
    OnDestroy { main.post { session?.cancel(); session = null } }
  }

  private fun emit(id: Int, body: Map<String, Any>) {
    try {
      sendEvent(EVENT, Bundle().apply {
        putInt("id", id)
        for ((k, v) in body) when (v) {
          is String -> putString(k, v)
          is Boolean -> putBoolean(k, v)
          is Double -> putDouble(k, v)
        }
      })
    } catch (_: Throwable) { /* the page is gone */ }
  }

  /** The app language as the recognizer takes it: the phone's own region when its languages name one (en-GB), else a
   * usual region. */
  private fun localeTag(lang: String): String {
    val phone = LocaleList.getDefault()
    for (i in 0 until phone.size()) {
      val l = phone[i]
      if (l.language == lang && l.country.isNotEmpty()) return "${l.language}-${l.country}"
    }
    return when (lang) {
      "en" -> "en-US"; "ko" -> "ko-KR"; "ja" -> "ja-JP"; "zh" -> "zh-CN"; "es" -> "es-ES"; "id" -> "id-ID"
      else -> lang
    }
  }

  private fun has(list: List<String>, tag: String): Boolean {
    val want = tag.lowercase(Locale.ROOT)
    val lang = want.substringBefore('-')
    return list.any { val l = it.lowercase(Locale.ROOT).replace('_', '-'); l == want || l == lang }
  }

  private fun check(language: String, promise: Promise) {
    val ctx = appContext.reactContext?.applicationContext
    if (ctx == null || !Regex("^[a-z]{2,3}$").matches(language)) { promise.resolve(mapOf("state" to "unsupported")); return }
    val tag = localeTag(language)
    if (tag in refused) { promise.resolve(mapOf("state" to "unsupported")); return }
    val answer = { onDevice: Boolean? ->
      when (onDevice) {
        null -> mapOf("state" to "unsupported")
        else -> { onDeviceFor[tag] = onDevice; mapOf("state" to "ready", "locale" to tag, "onDevice" to onDevice, "micInApp" to true) }
      }
    }
    // no on-device recognizer for it: never the default one (it may send the sound out); the team server
    val fallback = { answer(null) }
    if (Build.VERSION.SDK_INT < 31 || !SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx)) { promise.resolve(fallback()); return }
    // Android 12 cannot say which languages it has on the phone: start() finds out (a language it lacks fails there)
    if (Build.VERSION.SDK_INT < 33) { promise.resolve(answer(true)); return }
    var answered = false
    val recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(ctx)
    val reply = { r: Map<String, Any> ->
      if (!answered) { answered = true; promise.resolve(r); main.post { try { recognizer.destroy() } catch (_: Throwable) {} } }
    }
    main.postDelayed({ reply(fallback()) }, 3000)
    try {
      recognizer.checkRecognitionSupport(intent(ctx, tag), ctx.mainExecutor, object : RecognitionSupportCallback {
        override fun onSupportResult(s: RecognitionSupport) {
          reply(when {
            has(s.installedOnDeviceLanguages, tag) -> answer(true)
            has(s.pendingOnDeviceLanguages, tag) || has(s.supportedOnDeviceLanguages, tag) -> mapOf("state" to "needs-model", "locale" to tag, "onDevice" to true, "micInApp" to true)
            else -> fallback()
          })
        }
        override fun onError(error: Int) { reply(fallback()) }
      })
    } catch (_: Throwable) { reply(fallback()) }
  }

  private fun install(language: String, promise: Promise) {
    val ctx = appContext.reactContext?.applicationContext
    if (ctx == null || Build.VERSION.SDK_INT < 33 || !SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx) || !Regex("^[a-z]{2,3}$").matches(language)) { promise.resolve("unsupported"); return }
    val tag = localeTag(language)
    val recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(ctx)
    var settled = false
    val settle = { r: String ->
      if (!settled) {
        settled = true
        if (r == "installed") onDeviceFor[tag] = true
        promise.resolve(r)
        main.post { try { recognizer.destroy() } catch (_: Throwable) {} }
      }
    }
    try { recognizer.triggerModelDownload(intent(ctx, tag)) } catch (_: Throwable) { settle("failed"); return }
    main.postDelayed({ settle("failed") }, INSTALL_DEADLINE_MS)
    // the download has no answer of its own before Android 14: ask every 2 s
    lateinit var poll: Runnable
    poll = Runnable {
      if (settled) return@Runnable
      try {
        recognizer.checkRecognitionSupport(intent(ctx, tag), ctx.mainExecutor, object : RecognitionSupportCallback {
          override fun onSupportResult(s: RecognitionSupport) {
            if (has(s.installedOnDeviceLanguages, tag)) settle("installed") else if (!settled) main.postDelayed(poll, 2000)
          }
          override fun onError(error: Int) { settle("failed") }
        })
      } catch (_: Throwable) { settle("failed") }
    }
    main.postDelayed(poll, 2000)
  }

  private fun intent(ctx: Context, tag: String) = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
    putExtra(RecognizerIntent.EXTRA_LANGUAGE, tag)
    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
    // (the on-device recognizer is offline anyway)
    putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
    putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.packageName)
    // a thinking pause does not end the utterance at once (recognizers may ignore it; the restart below covers that)
    putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 3000L)
    putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2000L)
  }

  private inner class Session(private val ctx: Context, val id: Int, private val tag: String, private val onDevice: Boolean) {
    private var recognizer: SpeechRecognizer? = null
    private var started: ((Boolean) -> Unit)? = null
    private var ready = false
    private var stopping = false
    private var ended = false
    /** an utterance is open (startListening called, no result or error yet) */
    private var listening = false
    private var guess = ""
    private var lastLevel = 0L
    private var retries = 0
    private val startTimeout = Runnable { fail("start_timeout") }
    private val confirm = Runnable { started?.invoke(true); started = null }
    private val stopTimeout = Runnable { finish() }

    fun begin(onStarted: (Boolean) -> Unit) {
      started = onStarted
      val r = try {
        when {
          // only the phone's own recognizer: never the default one (it may send the sound out)
          !onDevice -> null
          Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx) -> SpeechRecognizer.createOnDeviceSpeechRecognizer(ctx)
          else -> null
        }
      } catch (_: Throwable) { null }
      if (r == null) { fail("unavailable"); return }
      recognizer = r
      r.setRecognitionListener(listener)
      main.postDelayed(startTimeout, START_TIMEOUT_MS)
      listen()
    }

    private fun listen() {
      if (ended || stopping) return
      try { listening = true; recognizer?.startListening(intent(ctx, tag)) } catch (_: Throwable) { fail("unavailable") }
    }

    fun stop() {
      if (ended || stopping) return
      stopping = true
      if (!ready) { fail("stopped"); return }
      // between two utterances: nothing more to hear
      if (!listening) { finish(); return }
      try { recognizer?.stopListening() } catch (_: Throwable) { finish(); return }
      main.postDelayed(stopTimeout, STOP_TIMEOUT_MS)
    }

    fun cancel() {
      if (ended) return
      ended = true
      started?.invoke(false); started = null
      close()
    }

    /** before it was ready: start() says no (the page uses the team server); after: the page hears `error` */
    private fun fail(code: String) {
      if (ended) return
      val s = started
      if (code == "language") refused.add(tag)
      if (s != null) { started = null; ended = true; s(false); close(); return }
      if (stopping) { finish(); return }
      ended = true
      emit(id, mapOf("event" to "error", "code" to code))
      close()
    }

    /** every word final: the guess the recognizer did not get to make final is what was said */
    private fun finish() {
      if (ended) return
      if (guess.isNotBlank()) emit(id, mapOf("event" to "text", "final" to true, "text" to guess))
      guess = ""
      ended = true
      emit(id, mapOf("event" to "done"))
      close()
    }

    private fun close() {
      main.removeCallbacks(startTimeout); main.removeCallbacks(stopTimeout); main.removeCallbacks(confirm)
      val r = recognizer
      recognizer = null
      try { r?.cancel() } catch (_: Throwable) {}
      try { r?.destroy() } catch (_: Throwable) {}
      if (session === this) session = null
    }

    private fun first(b: Bundle?): String = (b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim() ?: "").take(MAX_TEXT)

    private val listener = object : RecognitionListener {
      override fun onReadyForSpeech(params: Bundle?) {
        retries = 0
        if (ready) return
        ready = true
        main.removeCallbacks(startTimeout)
        // yes once the recognizer kept the language for a moment (CONFIRM_MS)
        main.postDelayed(confirm, CONFIRM_MS)
      }
      override fun onBeginningOfSpeech() {}
      override fun onRmsChanged(rmsdB: Float) {
        val now = System.currentTimeMillis()
        if (ended || now - lastLevel < LEVEL_EVERY_MS) return
        lastLevel = now
        // Google's recognizers report about -2 (quiet) to 10 (loud speech)
        emit(id, mapOf("event" to "level", "level" to ((rmsdB + 2.0) / 12.0).coerceIn(0.0, 1.0)))
      }
      override fun onBufferReceived(buffer: ByteArray?) {}
      override fun onEndOfSpeech() {}
      override fun onPartialResults(partialResults: Bundle?) {
        if (ended) return
        val t = first(partialResults)
        if (t.isEmpty() || t == guess) return
        guess = t
        emit(id, mapOf("event" to "text", "final" to false, "text" to t))
      }
      override fun onResults(results: Bundle?) {
        if (ended) return
        listening = false
        val t = first(results).ifEmpty { guess }
        guess = ""
        if (t.isNotBlank()) emit(id, mapOf("event" to "text", "final" to true, "text" to t))
        if (stopping) finish() else main.post { listen() }
      }
      override fun onError(error: Int) {
        if (ended) return
        listening = false
        if (!ready) { fail(codeOf(error)); return }
        if (stopping) { finish(); return }
        when (error) {
          // a pause with nothing said: listen again
          SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> main.post { listen() }
          // some recognizers refuse a start that comes right after the last utterance: again, a little later
          SpeechRecognizer.ERROR_RECOGNIZER_BUSY, SpeechRecognizer.ERROR_CLIENT ->
            if (retries++ < 5) main.postDelayed({ listen() }, 150) else fail(codeOf(error))
          else -> fail(codeOf(error))
        }
      }
      override fun onEvent(eventType: Int, params: Bundle?) {}
    }
  }

  private fun codeOf(error: Int) = when (error) {
    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "denied"
    SpeechRecognizer.ERROR_AUDIO -> "audio"
    SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER, 11 -> "network"
    12, 13 -> "language"
    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "busy"
    else -> "failed"
  }
}
