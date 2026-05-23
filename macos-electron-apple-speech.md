# 在 macOS Electron 客户端中接入 Apple 原生语音识别

本文总结如何在 macOS 版 Electron 应用中接入 Apple 原生 `SFSpeechRecognizer`，实现“点击 composer 语音按钮 → 本机听写 → 文本进入输入框”的体验。

目标不是接入浏览器 Web Speech API，也不是 Whisper，而是调用 macOS 系统级 Speech 框架，也就是系统听写/Siri 同源的一套识别能力。

## 结论先行

推荐架构：

```text
Renderer Composer
  ↓ preload IPC
Electron main process
  ↓ Unix domain socket + LaunchServices
YourApp Speech Helper.app
  ↓ Swift Speech + AVFoundation
Apple SFSpeechRecognizer
```

关键经验：

- 不要直接 `spawn()` 一个裸 Swift 二进制做语音识别。
- helper 必须是一个真正的 `.app` bundle，并且带 `Info.plist`、权限描述和 entitlements。
- Electron 侧建议通过 `/usr/bin/open` 启动 helper `.app`，让 macOS TCC 按 App 身份处理权限。
- 通过 `open` 启动后拿不到 stdio，所以主进程和 helper 之间用 Unix domain socket 通信。
- renderer 不应该把 partial 结果直接追加到输入框；partial 是不断修正的，应替换当前 live 片段。
- Apple Speech 在停顿后可能重新返回一段短 partial，因此需要“已固定片段 + 当前 live 片段”的合并策略，避免停顿后覆盖前文。

## 文件结构

可以按下面结构组织：

```text
native/
  speech-cli/
    SpeechCLI.swift
    Info.plist
    SpeechCLI.entitlements
    build/
      YourApp Speech Helper.app/

scripts/
  build-speech-cli.mjs

electron/
  speech-recognition.ts
  main.ts
  preload.ts
  electron-env.d.ts

src/
  desktop-types.ts
  components/chat/ChatPage.tsx
  components/chat/Composer.tsx
```

## 1. Swift helper 为什么要做成 `.app`

macOS 的麦克风和语音识别权限由 TCC 管理。TCC 看的是“App 身份”，不是单纯的进程名。

如果直接这样启动：

```js
spawn('./speech_cli')
```

常见问题包括：

- 点击后 helper 直接 `SIGABRT`。
- crash report 里出现 TCC 相关终止。
- 系统设置里看不到你的应用。
- 明明写了 `NSSpeechRecognitionUsageDescription`，系统仍然认为没有。
- 麦克风权限出现了，但语音识别权限不出现。

根因通常是：裸二进制没有稳定的 bundle 身份，或者不是通过 LaunchServices 以 App 身份启动。

所以需要把 Swift helper 包成：

```text
YourApp Speech Helper.app
  Contents/
    Info.plist
    MacOS/
      speech_cli
```

并通过：

```bash
/usr/bin/open -n -W "YourApp Speech Helper.app" --args --socket /private/tmp/xxx.sock
```

来启动。

## 2. Info.plist

helper 的 `Info.plist` 至少需要这些字段：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleIdentifier</key>
    <string>com.yourapp.desktop.speech-cli</string>

    <key>CFBundleName</key>
    <string>YourApp Speech Helper</string>

    <key>CFBundleDisplayName</key>
    <string>YourApp Speech Helper</string>

    <key>CFBundleExecutable</key>
    <string>speech_cli</string>

    <key>CFBundlePackageType</key>
    <string>APPL</string>

    <key>LSUIElement</key>
    <true/>

    <key>CFBundleVersion</key>
    <string>1</string>

    <key>CFBundleShortVersionString</key>
    <string>1.0</string>

    <key>NSMicrophoneUsageDescription</key>
    <string>YourApp uses the microphone to turn your speech into composer text.</string>

    <key>NSSpeechRecognitionUsageDescription</key>
    <string>YourApp uses Apple Speech Recognition to transcribe your voice locally when supported.</string>
  </dict>
</plist>
```

注意：

- `CFBundleIdentifier` 要稳定，dev 和 release 尽量不要频繁变化。
- `CFBundleExecutable` 必须和 `Contents/MacOS/` 下的二进制同名。
- `CFBundlePackageType` 必须是 `APPL`。
- `LSUIElement=true` 可以让 helper 不显示 Dock 图标。
- `NSMicrophoneUsageDescription` 和 `NSSpeechRecognitionUsageDescription` 都必须存在。

## 3. Entitlements

helper 需要麦克风和语音识别 entitlement：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.security.device.audio-input</key>
    <true/>

    <key>com.apple.security.personal-information.speech-recognition</key>
    <true/>
  </dict>
</plist>
```

主应用的 macOS entitlements 也建议加上同样两项，尤其是打包后主 App 可能作为 responsible process 被 TCC 关联：

```xml
<key>com.apple.security.device.audio-input</key>
<true/>
<key>com.apple.security.personal-information.speech-recognition</key>
<true/>
```

## 4. Swift helper 协议

推荐让 helper 通过 NDJSON 通信。

Electron 发命令：

```json
{"command":"start","requiresOnDevice":true}
{"command":"stop"}
{"command":"cancel"}
{"command":"quit"}
```

Swift helper 回事件：

```json
{"type":"ready","status":"idle","locale":"zh_CN"}
{"type":"status","status":"requesting_permission"}
{"type":"status","status":"listening","locale":"zh_CN","supportsOnDevice":true,"requiresOnDevice":true}
{"type":"partial","text":"正在识别的临时文本"}
{"type":"final","text":"最终识别文本"}
{"type":"error","code":"speech_denied","message":"Speech recognition permission was denied."}
```

状态建议：

```ts
type SpeechRecognitionStatus =
  | 'unsupported'
  | 'idle'
  | 'starting'
  | 'requesting_permission'
  | 'listening'
  | 'transcribing'
  | 'error'
```

## 5. Swift helper 核心实现

关键流程：

1. 读取 Electron 发来的命令。
2. `start` 时先请求 Speech 权限。
3. Speech 授权后再请求麦克风权限。
4. 创建 `SFSpeechRecognizer`。
5. 创建 `SFSpeechAudioBufferRecognitionRequest`。
6. 通过 `AVAudioEngine.inputNode.installTap` 把麦克风音频喂给 Speech request。
7. 持续输出 `partial`。
8. `stop` 时 `endAudio()`，等待 final。

核心代码形态：

```swift
import AVFoundation
import Foundation
import Speech

final class SpeechCLI: NSObject, SFSpeechRecognizerDelegate {
  private var audioEngine = AVAudioEngine()
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var speechRecognizer: SFSpeechRecognizer?
  private var latestText = ""

  private func startRecognition(localeIdentifier: String?, requiresOnDevice: Bool) {
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
    guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
      emitError(code: "recognizer_unavailable", message: "Speech recognizer is unavailable.")
      emitStatus("idle")
      return
    }

    var supportsOnDevice = false
    if #available(macOS 10.15, *) {
      supportsOnDevice = recognizer.supportsOnDeviceRecognition
    }

    if requiresOnDevice && !supportsOnDevice {
      emitError(code: "on_device_unavailable", message: "On-device speech recognition is unavailable.")
      emitStatus("idle")
      return
    }

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
    speechRecognizer = recognizer
    speechRecognizer?.delegate = self

    let inputNode = audioEngine.inputNode
    let format = inputNode.outputFormat(forBus: 0)

    inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak request] buffer, _ in
      request?.append(buffer)
    }

    recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
      DispatchQueue.main.async {
        self?.handleRecognitionResult(result: result, error: error)
      }
    }

    do {
      audioEngine.prepare()
      try audioEngine.start()
      emitStatus("listening", extra: [
        "locale": locale.identifier,
        "supportsOnDevice": supportsOnDevice,
        "requiresOnDevice": requiresOnDevice,
      ])
    } catch {
      emitError(code: "audio_start_failed", message: error.localizedDescription)
      emitStatus("idle")
    }
  }
}
```

标点说明：

- `request.addsPunctuation = true` 只能在支持的 macOS 版本上开启。
- Apple 本机/on-device 识别的标点不保证每次都有。
- 短句、中文、停顿不明显时，partial 往往不带标点，final 才可能补一部分。
- 如果产品强依赖标点，可以在 final 后做本地后处理，或者接云端 ASR。

## 6. 为什么 Electron 和 helper 用 socket

如果直接 `spawn(helperExecutable)`，可以用 stdin/stdout，但 TCC 权限容易出问题。

如果用：

```bash
/usr/bin/open -n -W "YourApp Speech Helper.app" --args ...
```

macOS 会按真正 App 身份启动 helper，权限更稳定，但 `open` 不会把 helper 的 stdin/stdout 直接给 Electron。

所以推荐：

1. Electron main 创建 Unix domain socket server。
2. 生成 socket path，例如 `/private/tmp/yourapp-speech-${pid}-${uuid}.sock`。
3. 通过 `open` 启动 helper，并把 socket path 作为参数传进去。
4. Swift helper 连接 socket。
5. 双方通过 socket 传 NDJSON。

Electron 启动 helper 的核心代码：

```ts
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import net, { type Socket } from 'node:net'
import path from 'node:path'

async function launchHelperApp(helperAppPath: string) {
  const socketPath = path.join('/private/tmp', `yourapp-speech-${process.pid}-${randomUUID().slice(0, 8)}.sock`)
  await fs.rm(socketPath, { force: true }).catch(() => {})

  const server = net.createServer()
  server.maxConnections = 1

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => resolve())
    server.listen(socketPath)
  })

  const openProcess = spawn(
    '/usr/bin/open',
    ['-n', '-W', helperAppPath, '--args', '--socket', socketPath],
    {
      cwd: path.dirname(helperAppPath),
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )

  const socket = await new Promise<Socket>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for Apple Speech helper to connect.'))
    }, 10_000)

    server.once('connection', (client) => {
      clearTimeout(timeout)
      resolve(client)
    })

    openProcess.once('error', reject)
    openProcess.once('exit', (code, signal) => {
      reject(new Error(`Apple Speech helper exited before connecting: ${signal ?? code}`))
    })
  })

  return { process: openProcess, server, socket, socketPath }
}
```

Swift 侧通过 POSIX socket 连接更稳，避免 `FileHandle.readData` 在 socket 上读不到后续命令的坑。

## 7. 构建 helper

可以写一个 Node 构建脚本：

```js
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const source = 'native/speech-cli/SpeechCLI.swift'
const plist = 'native/speech-cli/Info.plist'
const entitlements = 'native/speech-cli/SpeechCLI.entitlements'
const appBundle = 'native/speech-cli/build/YourApp Speech Helper.app'
const appContents = path.join(appBundle, 'Contents')
const appMacOS = path.join(appContents, 'MacOS')
const appPlist = path.join(appContents, 'Info.plist')
const out = path.join(appMacOS, 'speech_cli')

fs.mkdirSync(appMacOS, { recursive: true })

spawnSync('xcrun', [
  'swiftc',
  source,
  '-o',
  out,
  '-framework',
  'Speech',
  '-framework',
  'AVFoundation',
], { stdio: 'inherit' })

fs.chmodSync(out, 0o755)
fs.copyFileSync(plist, appPlist)

spawnSync('codesign', [
  '--force',
  '--deep',
  '--sign',
  '-',
  '--entitlements',
  entitlements,
  appBundle,
], { stdio: 'inherit' })
```

`package.json` 中建议：

```json
{
  "scripts": {
    "build:speech-cli": "node scripts/build-speech-cli.mjs",
    "dev": "npm run build:speech-cli && vite",
    "build": "npm run build:speech-cli && tsc && vite build && electron-builder --config electron-builder.config.cjs"
  }
}
```

建议脚本做 mtime 判断，避免每次 dev 都重签名。频繁重签名可能导致 macOS TCC 反复要求授权。

## 8. Electron main 接入

Electron main 中做三件事：

1. 管理 helper 生命周期。
2. 向 helper 发送 `start/stop/cancel/quit`。
3. 把 helper 的 NDJSON 事件转成 renderer IPC。

IPC 建议：

```ts
ipcMain.handle('desktop:speech-recognition:get-status', () => {
  return speechRecognitionService.getSnapshot()
})

ipcMain.handle('desktop:speech-recognition:start', (_event, options) => {
  return speechRecognitionService.start(options)
})

ipcMain.handle('desktop:speech-recognition:stop', () => {
  return speechRecognitionService.stop()
})

ipcMain.handle('desktop:speech-recognition:cancel', () => {
  return speechRecognitionService.cancel()
})
```

事件 channel：

```ts
const SPEECH_RECOGNITION_EVENT_CHANNEL = 'desktop:speech-recognition-event'
```

事件类型：

```ts
type SpeechRecognitionEvent =
  | { type: 'status'; status: SpeechRecognitionStatus; locale?: string; supportsOnDevice?: boolean; requiresOnDevice?: boolean }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; code: string; message: string }
```

## 9. preload 暴露 API

preload 中暴露最小 API：

```ts
contextBridge.exposeInMainWorld('desktop', {
  getSpeechRecognitionStatus() {
    return ipcRenderer.invoke('desktop:speech-recognition:get-status')
  },
  startSpeechRecognition(options?: { locale?: string; requiresOnDevice?: boolean }) {
    return ipcRenderer.invoke('desktop:speech-recognition:start', options)
  },
  stopSpeechRecognition() {
    return ipcRenderer.invoke('desktop:speech-recognition:stop')
  },
  cancelSpeechRecognition() {
    return ipcRenderer.invoke('desktop:speech-recognition:cancel')
  },
  onSpeechRecognitionEvent(handler: (event: SpeechRecognitionEvent) => void) {
    const listener = (_event: IpcRendererEvent, event: SpeechRecognitionEvent) => handler(event)
    ipcRenderer.on('desktop:speech-recognition-event', listener)
    return () => ipcRenderer.off('desktop:speech-recognition-event', listener)
  },
})
```

## 10. Renderer composer 交互

按钮行为：

- `idle/error`：点击开始录音。
- `starting/requesting_permission`：点击取消。
- `listening`：点击停止录音并等待 final。
- `transcribing`：点击取消。

UI 建议：

- 按钮只在 macOS 显示。
- 正在听写时给圆形背景和轻微 pulse，不要让麦克风图标旋转。
- 不要在按钮旁边显示浮层文字；识别结果应直接进入输入框。
- 错误提示可以走全局 status 或 toast。

## 11. partial/final 怎么写入输入框

不能简单地：

```ts
setInputValue((prev) => prev + partialText)
```

原因：

- `partial` 是“当前识别假设”，不是新增文本。
- Apple Speech 会不断修正 partial。
- 停顿后，它有时会返回一段新的短 partial，而不是完整全文。

推荐维护一个 speech draft range：

```ts
type SpeechDraftRange = {
  start: number
  end: number
  committedText: string
  liveText: string
}
```

策略：

- 开始录音时记录当前输入框光标和选区。
- partial 到来时，只替换这段 draft range。
- 如果新的 partial 明显是在修正当前短语，更新 `liveText`。
- 如果新的 partial 明显是停顿后的新短语，把旧 `liveText` 合并进 `committedText`，新 partial 成为新的 `liveText`。
- final 到来时做最后一次替换，然后清空 draft range。

这样可以避免：

- partial 重复追加。
- 识别修正时留下脏文本。
- 停顿后继续说话覆盖前文。

## 12. 打包配置

electron-builder 中需要把 helper `.app` 作为 extra resource 打进去：

```js
const speechCliPath = path.join(__dirname, 'native', 'speech-cli', 'build', 'YourApp Speech Helper.app')

if (fs.existsSync(speechCliPath)) {
  base.extraResources = [
    ...(Array.isArray(base.extraResources) ? base.extraResources : []),
    {
      from: speechCliPath,
      to: path.join('speech', 'YourApp Speech Helper.app'),
    },
  ]
}
```

运行时路径：

```ts
const helperAppPath = app.isPackaged
  ? path.join(process.resourcesPath, 'speech', 'YourApp Speech Helper.app')
  : path.join(app.getAppPath(), 'native', 'speech-cli', 'build', 'YourApp Speech Helper.app')
```

主 App 的 `extendInfo` 也建议声明权限文案：

```json
{
  "mac": {
    "extendInfo": {
      "NSMicrophoneUsageDescription": "YourApp uses the microphone to turn your speech into composer text.",
      "NSSpeechRecognitionUsageDescription": "YourApp uses Apple Speech Recognition to transcribe your voice locally when supported."
    }
  }
}
```

## 13. 权限行为说明

macOS 权限请求顺序：

1. Speech Recognition / 语音识别
2. Microphone / 麦克风

如果语音识别没授权，通常不会走到麦克风请求。

系统设置里看不到你的 App 不一定是 bug，因为：

- TCC 只有在 App 真正请求权限后才会列出来。
- 如果裸二进制请求失败，可能不会登记。
- 如果 responsible process 被归到 Electron/Cursor/Codex/Terminal，列表里可能显示父 App。
- dev 模式下频繁重签名可能导致重新授权。

调试时可以重置权限：

```bash
tccutil reset SpeechRecognition com.yourapp.desktop.speech-cli
tccutil reset Microphone com.yourapp.desktop.speech-cli
```

注意：不要在日常 dev 脚本里自动跑 `tccutil reset`。这只适合调试权限状态。

## 14. 常见问题排查

### 点击后 helper SIGABRT

看 crash report：

```bash
ls -t ~/Library/Logs/DiagnosticReports/*speech_cli*.ips | head
```

如果看到 TCC 或 missing usage description，检查：

- helper 是否是 `.app` bundle。
- `Info.plist` 是否在 `Contents/Info.plist`。
- 是否有 `NSSpeechRecognitionUsageDescription`。
- 是否有 `NSMicrophoneUsageDescription`。
- 是否有 `CFBundleExecutable`。
- 是否有 `CFBundlePackageType=APPL`。
- 是否通过 `/usr/bin/open` 启动 `.app`，而不是直接 spawn 二进制。

### 系统设置里没有语音识别/麦克风选项

常见原因：

- 还没有真正触发权限请求。
- 请求被归到了父进程，例如 Electron/Cursor/Codex。
- helper 不是通过 LaunchServices 以 App 身份启动。
- 之前权限状态卡住，需要 `tccutil reset`。

### 麦克风权限有了，但没有识别文字

排查顺序：

1. 确认 helper 进入 `listening`。
2. 确认系统输入源选对了。
3. 确认 `AVAudioEngine.inputNode.outputFormat(forBus: 0)` 有有效 sample rate 和 channel。
4. 确认 `inputNode.installTap` 后 request 收到 buffer。
5. 说话后等待 `partial`。
6. 如果 stop 后返回空 final，可能是 “No speech detected”。

开发期可以临时加音频 buffer/RMS 诊断，但功能稳定后建议删掉，避免主进程刷日志。

### dev 模式每次都要重新授权

macOS TCC 和这些因素有关：

- bundle id
- 代码签名
- app 路径
- responsible process
- 是否重签名

如果 dev 脚本每次都重新 codesign helper，系统可能更容易重新判断权限。

建议：

- 构建脚本做 mtime 判断，没变就不重编/重签。
- 保持 `CFBundleIdentifier` 稳定。
- 不要频繁 `tccutil reset`。
- 真正验证权限稳定性时，用打包后的 `.app` 测。

### 有识别但没有标点

确认 Swift 里开启：

```swift
if #available(macOS 13.0, *) {
  request.addsPunctuation = true
}
```

仍然没有标点也正常：

- partial 阶段通常不稳定。
- on-device 识别标点不一定积极。
- 中文短句尤其容易没有标点。
- final 比 partial 更可能带标点。

如果产品要求稳定标点，需要额外后处理。

## 15. 最小验证命令

构建 helper：

```bash
npm run build:speech-cli
```

检查 app bundle：

```bash
plutil -p "native/speech-cli/build/YourApp Speech Helper.app/Contents/Info.plist"
codesign -d --entitlements :- "native/speech-cli/build/YourApp Speech Helper.app" 2>/dev/null
```

跑类型检查：

```bash
npm run typecheck
```

启动 dev：

```bash
npm run dev
```

## 16. 实现检查清单

- [ ] helper 是 `.app` bundle，不是裸二进制。
- [ ] `Info.plist` 有 Speech 和 Microphone usage description。
- [ ] `Info.plist` 有 `CFBundleExecutable` 和 `CFBundlePackageType=APPL`。
- [ ] helper entitlements 有 audio input 和 speech recognition。
- [ ] helper 被 codesign。
- [ ] Electron 通过 `/usr/bin/open` 启动 helper `.app`。
- [ ] Electron 和 helper 通过 socket 传 NDJSON。
- [ ] Swift 先请求 Speech 权限，再请求麦克风权限。
- [ ] `requiresOnDeviceRecognition` 做了可用性判断。
- [ ] `addsPunctuation` 在 macOS 13+ 开启。
- [ ] renderer 对 partial 做 live 替换，不是简单追加。
- [ ] 停顿后的新 partial 不会覆盖旧文本。
- [ ] 打包时 helper `.app` 被放入 `extraResources`。
- [ ] 主 App 和 helper 都有必要的权限声明。

## 推荐默认策略

如果产品只面向 macOS，并且优先 M 系列设备：

- 默认使用 `requiresOnDeviceRecognition: true`。
- 如果当前 locale 不支持 on-device，再提示用户安装听写语言包或切换语言。
- 不建议默认降级到在线识别，除非产品明确允许联网 ASR。
- UI 文案中明确说明“Apple 本机识别”，避免用户误以为上传到了云端。
