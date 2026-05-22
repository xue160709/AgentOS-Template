import AVFoundation
import Darwin
import Foundation
import Speech

final class SpeechCLI: NSObject, SFSpeechRecognizerDelegate {
  private let outputQueue = DispatchQueue(label: "agentos.speech.output")
  private var outputHandle: FileHandle = .standardOutput
  private var outputDescriptor: Int32?
  private var audioEngine = AVAudioEngine()
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var speechRecognizer: SFSpeechRecognizer?
  private var latestText = ""
  private var isRecording = false
  private var isStopping = false
  private var didEmitFinal = false
  private var hasInputTap = false
  private var fallbackFinalTimer: Timer?
  private var currentStatus = "idle"

  func run() {
    if let socketPath = Self.argumentValue(for: "--socket") {
      runWithSocket(path: socketPath)
      RunLoop.main.run()
      return
    }

    runWithStandardInput()
    RunLoop.main.run()
  }

  private func runWithStandardInput() {
    emit([
      "type": "ready",
      "status": "idle",
      "locale": Locale.current.identifier,
    ])

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      while let line = readLine(strippingNewline: true) {
        DispatchQueue.main.async {
          self?.handleCommandLine(line)
        }
      }
      DispatchQueue.main.async {
        self?.shutdown(exitCode: 0)
      }
    }
  }

  private func runWithSocket(path: String) {
    let socketDescriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard socketDescriptor >= 0 else {
      writeStderr("Failed to create IPC socket.")
      shutdown(exitCode: 1)
      return
    }

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let maxPathLength = MemoryLayout.size(ofValue: address.sun_path)
    guard path.utf8.count < maxPathLength else {
      writeStderr("IPC socket path is too long.")
      close(socketDescriptor)
      shutdown(exitCode: 1)
      return
    }

    _ = path.withCString { pointer in
      withUnsafeMutablePointer(to: &address.sun_path.0) { destination in
        strncpy(destination, pointer, maxPathLength - 1)
      }
    }

    let addressLength = socklen_t(MemoryLayout<sa_family_t>.size + path.utf8.count + 1)
    let connectResult = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
        connect(socketDescriptor, sockaddrPointer, addressLength)
      }
    }

    guard connectResult == 0 else {
      writeStderr("Failed to connect IPC socket.")
      close(socketDescriptor)
      shutdown(exitCode: 1)
      return
    }

    outputDescriptor = socketDescriptor
    emit([
      "type": "ready",
      "status": "idle",
      "locale": Locale.current.identifier,
    ])

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      var buffer = Data()
      var readBuffer = [UInt8](repeating: 0, count: 4096)
      while true {
        let bytesRead = Darwin.read(socketDescriptor, &readBuffer, readBuffer.count)
        if bytesRead <= 0 { break }
        buffer.append(readBuffer, count: bytesRead)

        while let newlineRange = buffer.firstRange(of: Data([0x0A])) {
          let lineData = buffer.subdata(in: 0..<newlineRange.lowerBound)
          buffer.removeSubrange(0..<newlineRange.upperBound)
          guard let line = String(data: lineData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                !line.isEmpty
          else {
            continue
          }
          DispatchQueue.main.async {
            self?.handleCommandLine(line)
          }
        }
      }
      DispatchQueue.main.async {
        self?.shutdown(exitCode: 0)
      }
    }
  }

  private func handleCommandLine(_ line: String) {
    guard
      let data = line.data(using: .utf8),
      let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let command = payload["command"] as? String
    else {
      emitError(code: "bad_command", message: "Command must be a JSON object with a command field.")
      return
    }

    switch command {
    case "start":
      let locale = payload["locale"] as? String
      let requiresOnDevice = (payload["requiresOnDevice"] as? Bool) ?? true
      startRecognition(localeIdentifier: locale, requiresOnDevice: requiresOnDevice)
    case "stop":
      stopRecognition()
    case "cancel":
      cancelRecognition(emitIdle: true)
    case "quit":
      shutdown(exitCode: 0)
    default:
      emitError(code: "unknown_command", message: "Unknown command: \(command)")
    }
  }

  private func startRecognition(localeIdentifier: String?, requiresOnDevice: Bool) {
    if isRecording || isStopping {
      emitStatus(currentStatus)
      return
    }

    latestText = ""
    didEmitFinal = false
    isStopping = false
    emitStatus("requesting_permission")

    SFSpeechRecognizer.requestAuthorization { [weak self] speechStatus in
      guard let self else { return }
      DispatchQueue.main.async {
        guard speechStatus == .authorized else {
          self.emitAuthorizationError(speechStatus)
          return
        }

        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
          DispatchQueue.main.async {
            guard let self else { return }
            guard granted else {
              self.emitError(code: "microphone_denied", message: "Microphone permission was denied.")
              self.emitStatus("idle")
              return
            }
            self.beginRecognition(localeIdentifier: localeIdentifier, requiresOnDevice: requiresOnDevice)
          }
        }
      }
    }
  }

  private func beginRecognition(localeIdentifier: String?, requiresOnDevice: Bool) {
    let locale = Locale(identifier: localeIdentifier?.isEmpty == false ? localeIdentifier! : Locale.current.identifier)
    guard let recognizer = SFSpeechRecognizer(locale: locale) else {
      emitError(code: "recognizer_unavailable", message: "Speech recognizer is unavailable for locale \(locale.identifier).")
      emitStatus("idle")
      return
    }

    guard recognizer.isAvailable else {
      emitError(code: "recognizer_not_available", message: "Speech recognizer is not currently available.")
      emitStatus("idle")
      return
    }

    var supportsOnDevice = false
    if #available(macOS 10.15, *) {
      supportsOnDevice = recognizer.supportsOnDeviceRecognition
    }

    if requiresOnDevice && !supportsOnDevice {
      emitError(
        code: "on_device_unavailable",
        message: "On-device speech recognition is unavailable for locale \(locale.identifier)."
      )
      emitStatus("idle", extra: [
        "locale": locale.identifier,
        "supportsOnDevice": supportsOnDevice,
      ])
      return
    }

    speechRecognizer = recognizer
    speechRecognizer?.delegate = self

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.taskHint = .dictation
    if #available(macOS 13.0, *) {
      request.addsPunctuation = true
    }
    if #available(macOS 10.15, *) {
      request.requiresOnDeviceRecognition = requiresOnDevice
    }
    recognitionRequest = request

    let inputNode = audioEngine.inputNode
    let recordingFormat = inputNode.outputFormat(forBus: 0)
    guard recordingFormat.sampleRate > 0, recordingFormat.channelCount > 0 else {
      emitError(code: "audio_input_unavailable", message: "No usable audio input format is available.")
      cleanupRecognition()
      emitStatus("idle")
      return
    }

    if hasInputTap {
      inputNode.removeTap(onBus: 0)
      hasInputTap = false
    }
    inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak request] buffer, _ in
      request?.append(buffer)
    }
    hasInputTap = true

    recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
      DispatchQueue.main.async {
        self?.handleRecognitionResult(result: result, error: error)
      }
    }

    do {
      audioEngine.prepare()
      try audioEngine.start()
      isRecording = true
      emitStatus("listening", extra: [
        "locale": locale.identifier,
        "supportsOnDevice": supportsOnDevice,
        "requiresOnDevice": requiresOnDevice,
      ])
    } catch {
      emitError(code: "audio_start_failed", message: error.localizedDescription)
      cleanupRecognition()
      emitStatus("idle")
    }
  }

  private func stopRecognition() {
    guard isRecording || recognitionRequest != nil else {
      emitStatus("idle")
      return
    }

    isStopping = true
    isRecording = false
    emitStatus("transcribing")
    stopAudio()
    recognitionRequest?.endAudio()

    fallbackFinalTimer?.invalidate()
    fallbackFinalTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { [weak self] _ in
      guard let self, self.isStopping, !self.didEmitFinal else { return }
      self.emitFinalIfNeeded()
      self.cleanupRecognition()
      self.emitStatus("idle")
    }
  }

  private func cancelRecognition(emitIdle: Bool) {
    fallbackFinalTimer?.invalidate()
    isRecording = false
    isStopping = false
    stopAudio()
    recognitionTask?.cancel()
    cleanupRecognition()
    if emitIdle {
      emitStatus("idle")
    }
  }

  private func handleRecognitionResult(result: SFSpeechRecognitionResult?, error: Error?) {
    if let result {
      latestText = result.bestTranscription.formattedString
      if result.isFinal {
        emitFinalIfNeeded()
        cleanupRecognition()
        emitStatus("idle")
        return
      }
      emit([
        "type": "partial",
        "text": latestText,
      ])
    }

    if let error {
      if isStopping {
        emitFinalIfNeeded()
      } else {
        emitError(code: "recognition_failed", message: error.localizedDescription)
      }
      cleanupRecognition()
      emitStatus("idle")
    }
  }

  private func emitFinalIfNeeded() {
    guard !didEmitFinal else { return }
    didEmitFinal = true
    emit([
      "type": "final",
      "text": latestText,
    ])
  }

  private func stopAudio() {
    if audioEngine.isRunning {
      audioEngine.stop()
    }
    if hasInputTap {
      audioEngine.inputNode.removeTap(onBus: 0)
      hasInputTap = false
    }
  }

  private func cleanupRecognition() {
    fallbackFinalTimer?.invalidate()
    fallbackFinalTimer = nil
    isRecording = false
    isStopping = false
    hasInputTap = false
    recognitionRequest = nil
    recognitionTask = nil
    speechRecognizer?.delegate = nil
    speechRecognizer = nil
  }

  private func emitAuthorizationError(_ status: SFSpeechRecognizerAuthorizationStatus) {
    switch status {
    case .denied:
      emitError(code: "speech_denied", message: "Speech recognition permission was denied.")
    case .restricted:
      emitError(code: "speech_restricted", message: "Speech recognition is restricted on this device.")
    case .notDetermined:
      emitError(code: "speech_not_determined", message: "Speech recognition permission is not determined.")
    case .authorized:
      break
    @unknown default:
      emitError(code: "speech_unknown_authorization", message: "Speech recognition authorization failed.")
    }
    emitStatus("idle")
  }

  private func emitStatus(_ status: String, extra: [String: Any] = [:]) {
    currentStatus = status
    var payload = extra
    payload["type"] = "status"
    payload["status"] = status
    emit(payload)
  }

  private func emitError(code: String, message: String) {
    emit([
      "type": "error",
      "code": code,
      "message": message,
    ])
  }

  private func emit(_ payload: [String: Any]) {
    let handle = outputHandle
    let descriptor = outputDescriptor
    outputQueue.async {
      guard JSONSerialization.isValidJSONObject(payload) else { return }
      do {
        let data = try JSONSerialization.data(withJSONObject: payload, options: [])
        if let descriptor {
          self.writeAll(data, to: descriptor)
          self.writeAll(Data([0x0A]), to: descriptor)
        } else {
          handle.write(data)
          handle.write(Data([0x0A]))
        }
      } catch {
        let fallback = #"{"type":"error","code":"json_encode_failed","message":"Failed to encode helper event."}"# + "\n"
        if let data = fallback.data(using: .utf8) {
          if let descriptor {
            self.writeAll(data, to: descriptor)
          } else {
            handle.write(data)
          }
        }
      }
    }
  }

  private func writeAll(_ data: Data, to descriptor: Int32) {
    data.withUnsafeBytes { rawBuffer in
      guard let baseAddress = rawBuffer.baseAddress else { return }
      var writtenBytes = 0
      while writtenBytes < rawBuffer.count {
        let result = Darwin.write(
          descriptor,
          baseAddress.advanced(by: writtenBytes),
          rawBuffer.count - writtenBytes
        )
        if result <= 0 { break }
        writtenBytes += result
      }
    }
  }

  private func writeStderr(_ message: String) {
    if let data = "\(message)\n".data(using: .utf8) {
      FileHandle.standardError.write(data)
    }
  }

  private func shutdown(exitCode: Int32) {
    cancelRecognition(emitIdle: false)
    if let descriptor = outputDescriptor {
      close(descriptor)
      outputDescriptor = nil
    }
    fflush(stdout)
    exit(exitCode)
  }

  private static func argumentValue(for flag: String) -> String? {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: flag),
          arguments.indices.contains(index + 1)
    else {
      return nil
    }
    return arguments[index + 1]
  }
}

let speechCLI = SpeechCLI()
speechCLI.run()
