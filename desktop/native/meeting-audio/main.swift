// Meeting notes' sound on a Mac (docs/AGENTS/plan/20261116-1903-live-meeting-notes.md): the desktop app's main process
// starts this per meeting and stops it (desktop/src/main/meeting.ts). It writes two tracks of 16 kHz mono float32
// samples to stdout as frames ('M' microphone / 'O' others, a uint32 LE count, the samples; desktop/src/common/meeting/
// session.ts FrameReader) and one JSON line per event to stderr ({"event":"started","callApps":[…]}, {"event":"error",
// "what":…}). Nothing is written to disk.
//
// "Others" is a Core Audio process tap (macOS 14.2+) on the sound of the call apps that are running (Zoom, Teams,
// Webex, Slack, FaceTime, and the browsers a Meet tab plays in), so music or alerts from other apps are not written
// down; with none running the meeting is microphone only. The idea follows Yogurt (github.com/FrigadeHQ/yogurt,
// app/native/yogurt-audio/main.swift, MIT, Copyright (c) 2026 Frigade); this file is written for Trina.
//
// macOS asks for the microphone (NSMicrophoneUsageDescription) and for "System Audio Recording"
// (NSAudioCaptureUsageDescription) the first time; both are asked on behalf of the app that started this helper. A
// refused tap gives silence, not an error: the app checks for that.
import AVFoundation
import CoreAudio
import Foundation

let RATE = 16000.0
let out = FileHandle.standardOutput
/// frames are written here, never on the audio threads (the tap's IOProc is a real-time thread)
let writeQueue = DispatchQueue(label: "meeting-audio.write")

func event(_ dict: [String: Any]) {
  if let d = try? JSONSerialization.data(withJSONObject: dict), let s = String(data: d, encoding: .utf8) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
  }
}

func writeFrame(_ kind: UInt8, _ samples: UnsafeBufferPointer<Float>) {
  guard let base = samples.baseAddress, !samples.isEmpty else { return }
  var frame = Data([kind])
  var n = UInt32(samples.count).littleEndian
  frame.append(Data(bytes: &n, count: 4))
  // float32 as it is: both Mac architectures are little-endian
  frame.append(Data(bytes: base, count: samples.count * 4))
  writeQueue.async {
    // the app went away (a closed pipe): stop quietly, no crash report
    do { try out.write(contentsOf: frame) } catch { exit(0) }
  }
}

/// Converts any PCM buffer to 16 kHz mono float32 and writes it as frames of `kind`.
final class Resampler {
  let kind: UInt8
  private var converter: AVAudioConverter?
  private var from: AVAudioFormat?
  private let to = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: RATE, channels: 1, interleaved: false)!
  init(kind: UInt8) { self.kind = kind }
  func feed(_ buffer: AVAudioPCMBuffer) {
    if from == nil || from! != buffer.format {
      from = buffer.format
      converter = AVAudioConverter(from: buffer.format, to: to)
      // every channel goes into the one (without it only the first channel is heard)
      converter?.downmix = true
    }
    guard let conv = converter else { return }
    let cap = AVAudioFrameCount(Double(buffer.frameLength) * RATE / buffer.format.sampleRate) + 32
    guard let outBuf = AVAudioPCMBuffer(pcmFormat: to, frameCapacity: cap) else { return }
    var given = false
    var err: NSError?
    conv.convert(to: outBuf, error: &err) { _, status in
      if given { status.pointee = .noDataNow; return nil }
      given = true
      status.pointee = .haveData
      return buffer
    }
    if err != nil || outBuf.frameLength == 0 { return }
    writeFrame(kind, UnsafeBufferPointer(start: outBuf.floatChannelData![0], count: Int(outBuf.frameLength)))
  }
}

// ---------------- the microphone ----------------
let engine = AVAudioEngine()
let mic = Resampler(kind: 0x4D)
func startMic() -> Bool {
  let input = engine.inputNode
  let fmt = input.outputFormat(forBus: 0)
  if fmt.sampleRate <= 0 || fmt.channelCount == 0 { event(["event": "error", "what": "no_microphone"]); return false }
  input.installTap(onBus: 0, bufferSize: 2048, format: fmt) { buf, _ in mic.feed(buf) }
  do { try engine.start(); return true } catch {
    event(["event": "error", "what": "microphone", "detail": "\(error)"]); return false
  }
}

// ---------------- the call apps' sound ----------------
/// bundle ids whose sound is "others": the call apps, and the browsers a Meet or Teams tab plays in (anything else a
/// browser plays during the meeting is heard too). FaceTime's call sound plays from avconferenced.
let CALL_APPS: [String] = [
  "us.zoom.xos", "com.microsoft.teams2", "com.microsoft.teams", "com.cisco.webexmeetingsapp", "Cisco-Systems.Spark",
  "com.tinyspeck.slackmacgap", "com.apple.FaceTime", "com.apple.avconferenced", "com.google.Chrome", "com.apple.Safari", "com.microsoft.edgemac",
  "company.thebrowser.Browser", "org.mozilla.firefox", "com.brave.Browser", "com.hnc.Discord", "com.skype.skype",
]

func tapFormat(_ obj: AudioObjectID) -> AudioStreamBasicDescription? {
  var addr = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
  var v = AudioStreamBasicDescription()
  return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &v) == noErr ? v : nil
}

/// The audio process objects of running call apps (and their helpers, whose bundle id starts with the app's).
func callProcesses() -> ([AudioObjectID], [String]) {
  var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr, size > 0 else { return ([], []) }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return ([], []) }
  var found: [AudioObjectID] = []
  var conferenced: [AudioObjectID] = []
  var names = Set<String>()
  for id in ids {
    var baddr = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyBundleID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var bsize = UInt32(MemoryLayout<CFString?>.size)
    var bid: Unmanaged<CFString>?
    guard AudioObjectGetPropertyData(id, &baddr, 0, nil, &bsize, &bid) == noErr, let b = bid?.takeRetainedValue() as String? else { continue }
    if let app = CALL_APPS.first(where: { b == $0 || b.hasPrefix($0 + ".") }) {
      // avconferenced always runs: its sound counts only while FaceTime is open (below), named as FaceTime
      if app == "com.apple.avconferenced" { conferenced.append(id); continue }
      found.append(id); names.insert(app)
    }
  }
  if names.contains("com.apple.FaceTime") { found.append(contentsOf: conferenced) }
  return (found, Array(names).sorted())
}

let others = Resampler(kind: 0x4F)
var tapID = AudioObjectID(kAudioObjectUnknown)
var aggregateID = AudioObjectID(kAudioObjectUnknown)
var procID: AudioDeviceIOProcID?

func startTap(_ processes: [AudioObjectID]) -> Bool {
  let desc = CATapDescription(stereoMixdownOfProcesses: processes)
  desc.uuid = UUID()
  desc.muteBehavior = .unmuted
  desc.isPrivate = true
  guard AudioHardwareCreateProcessTap(desc, &tapID) == noErr else { event(["event": "error", "what": "tap"]); return false }
  guard let fmt = tapFormat(tapID) else { event(["event": "error", "what": "tap_format"]); return false }
  let aggDesc: [String: Any] = [
    kAudioAggregateDeviceNameKey: "Trina meeting notes",
    kAudioAggregateDeviceUIDKey: UUID().uuidString,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: desc.uuid.uuidString, kAudioSubTapDriftCompensationKey: true]],
  ]
  guard AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggregateID) == noErr else { event(["event": "error", "what": "aggregate"]); return false }
  var asbd = fmt
  guard let format = AVAudioFormat(streamDescription: &asbd) else { return false }
  let status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, nil) { _, inData, _, _, _ in
    guard let buf = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: inData, deallocator: nil) else { return }
    others.feed(buf)
  }
  guard status == noErr, AudioDeviceStart(aggregateID, procID) == noErr else { event(["event": "error", "what": "tap_start"]); return false }
  return true
}

func stopTap() {
  if aggregateID != kAudioObjectUnknown {
    if let p = procID { AudioDeviceStop(aggregateID, p); AudioDeviceDestroyIOProcID(aggregateID, p) }
    AudioHardwareDestroyAggregateDevice(aggregateID)
  }
  if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
  aggregateID = AudioObjectID(kAudioObjectUnknown); tapID = AudioObjectID(kAudioObjectUnknown); procID = nil
}
/// main thread only
func stopAll() {
  engine.inputNode.removeTap(onBus: 0)
  engine.stop()
  stopTap()
}

// ---------------- main ----------------
// --check: say which call apps are running and exit (no capture, no permission question)
if CommandLine.arguments.contains("--check") {
  let (_, names) = callProcesses()
  event(["event": "check", "callApps": names])
  exit(0)
}
// SIGTERM / SIGINT and a closed stdin (the app going away) stop on the main thread, never inside a signal handler
signal(SIGPIPE, SIG_IGN)
func quit() { stopAll(); writeQueue.sync {}; exit(0) }
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
  signal(sig, SIG_IGN)
  let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  src.setEventHandler { quit() }
  src.resume()
  signalSources.append(src)
}
let micOk = startMic()
var (procs, names) = callProcesses()
var tapOk = procs.isEmpty ? false : startTap(procs)
event(["event": "started", "microphone": micOk, "callApps": names, "callSound": tapOk])
if !micOk && procs.isEmpty { /* nothing to hear yet: a call app may start later */ }
// a call app (or a Meet tab) that starts or stops its sound later: the tap follows, every 5 s
let watch = DispatchSource.makeTimerSource(queue: .main)
watch.schedule(deadline: .now() + 5, repeating: 5)
watch.setEventHandler {
  let (now, nowNames) = callProcesses()
  if Set(now) == Set(procs) { return }
  stopTap()
  procs = now; names = nowNames
  tapOk = now.isEmpty ? false : startTap(now)
  event(["event": "callApps", "callApps": names, "callSound": tapOk])
}
watch.resume()
DispatchQueue.global().async {
  while FileHandle.standardInput.availableData.count > 0 {}
  DispatchQueue.main.async { quit() }
}
RunLoop.main.run()
