# 桌面外壳、设置与发布 PRD

## 功能概述

桌面外壳、设置与发布模块负责 AgentOS 的 Electron 应用生命周期、窗口、托盘、菜单、桌面偏好、语言设置、自动更新和跨平台打包发布。它为所有业务模块提供桌面宿主能力。

## 核心功能列表

| 优先级 | 功能 | 说明 |
| --- | --- | --- |
| P0 | Electron 窗口 | 创建 BrowserWindow，配置尺寸、标题栏、外部链接处理 |
| P0 | Preload API | 暴露安全的 `window.desktop` 和 `window.claudeChat` |
| P0 | 设置页路由 | 管理模型、偏好、更新、Agent Mode、开发者设置入口 |
| P0 | 桌面偏好 | close-to-tray、open-at-login、eye comfort、locale |
| P1 | 托盘 | 隐藏到托盘、显示窗口、新建会话、打开项目、退出 |
| P1 | 自动更新 | 检查、下载、安装并推送更新状态 |
| P1 | 国际化 | 中文、英文文案切换，语言变更后提示重启 |
| P1 | 打包发布 | macOS、Windows、Linux 构建与 GitHub 发布配置 |
| P1 | macOS 原生语音 helper | 打包并启动 Apple Speech helper `.app`，通过 preload 为 composer 提供本机听写能力 |
| P1 | 开发者工具 | 开发构建中提供工作区和模型设置清理入口 |
| P2 | 窗口安全区 | 根据平台和 Window Controls Overlay 写入 CSS 安全区变量 |
| P2 | 应用元数据 | About 面板、设置页和包信息共享产品/作者/仓库元数据 |

## 数据结构

```ts
type AppUiLocale = 'zh' | 'en'

interface DesktopPreferences {
  closeToTray: boolean
  openAtLogin: boolean
  eyeComfortMode: boolean
  locale?: AppUiLocale
}

interface AppUpdaterState {
  phase: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  updatesSupported: boolean
  currentVersion: string
  availableVersion?: string
  releaseNotes?: string
  percent?: number
  bytesPerSecond?: number
  transferred?: number
  total?: number
  errorMessage?: string
}

interface DesktopApi {
  pickProjectDirectory(): Promise<string | null>
  pickChatAttachments(options?: { allowImages?: boolean }): Promise<ClaudeChatAttachmentPickerResult>
  getDesktopPreferences(): Promise<DesktopPreferences>
  setDesktopPreferences(prefs: Partial<DesktopPreferences>): Promise<DesktopPreferences>
  checkForUpdates(): Promise<AppUpdaterState>
  getSpeechRecognitionStatus(): Promise<SpeechRecognitionSnapshot>
  startSpeechRecognition(options?: { locale?: string; requiresOnDevice?: boolean }): Promise<SpeechRecognitionCommandResult>
  stopSpeechRecognition(): Promise<SpeechRecognitionCommandResult>
  cancelSpeechRecognition(): Promise<SpeechRecognitionCommandResult>
  onSpeechRecognitionEvent(handler: (event: SpeechRecognitionEvent) => void): () => void
}

type SpeechRecognitionStatus =
  | 'unsupported'
  | 'idle'
  | 'starting'
  | 'requesting_permission'
  | 'listening'
  | 'transcribing'
  | 'error'

interface SpeechRecognitionSnapshot {
  supported: boolean
  status: SpeechRecognitionStatus
}

type SpeechRecognitionCommandResult =
  | {
      ok: true
      status: SpeechRecognitionStatus
    }
  | {
      ok: false
      status: SpeechRecognitionStatus
      message: string
    }

type SpeechRecognitionEvent =
  | { type: 'status'; status: SpeechRecognitionStatus; locale?: string; supportsOnDevice?: boolean; requiresOnDevice?: boolean }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; code: string; message: string }
```

## 业务逻辑

```mermaid
flowchart TD
  A[app ready] --> B[创建 stores]
  B --> C[创建 BrowserWindow]
  C --> D[注册 IPC]
  D --> E[同步菜单和托盘]
  E --> F[检查更新]
  C --> G{窗口关闭}
  G -- closeToTray=true --> H[隐藏窗口]
  G -- closeToTray=false --> I[关闭/退出]
  J[设置页修改偏好] --> K[保存 DesktopPreferences]
  K --> E
```

发布规则：

- macOS 使用 hardened runtime、entitlements 和可选 notarization。
- macOS 主 App entitlements 包含 `com.apple.security.device.audio-input` 和 `com.apple.security.personal-information.speech-recognition`，并在 `extendInfo` 声明麦克风与语音识别用途文案。
- Apple 凭据存在但缺少 Team ID 时禁用 notarization 并警告。
- asar 启用，但 Claude Agent SDK 相关包需要 unpack。
- Apple Speech helper 由 `scripts/build-speech-cli.mjs` 编译为 `native/speech-cli/build/AgentOS Speech Helper.app`，脚本按 `SpeechCLI.swift`、`Info.plist`、`SpeechCLI.entitlements` 的 mtime 判断是否跳过重编/重签，减少 dev 模式重复触发 TCC 授权。
- `electron-builder.config.cjs` 在 helper app 存在时把它作为 `extraResources` 放入 `speech/AgentOS Speech Helper.app`；packaged 环境从 `process.resourcesPath` 解析，dev 环境从仓库内 `native/speech-cli/build` 解析。
- 打包配置包含 `dist`、`dist-electron`，并声明收集内置 Home Plugin Skill 目录；当前仓库该目录未存在，Home Plugin 校验脚本使用 `--allow-missing` 兼容。
- GitHub 发布目标为 `xue160709/AgentOS`。

桌面规则：

- 主窗口默认 1100 x 720，最小 640 x 480；macOS 使用 hiddenInset、透明背景和 vibrancy。
- Windows 使用自绘标题栏与 native titlebar overlay；渲染层通过 `window-safe-area` 把 macOS 交通灯、Windows overlay、Linux 预留区写入 CSS 变量。
- 外部 HTTP/HTTPS 链接统一通过系统浏览器打开，非应用导航会被拦截。
- 应用使用 single instance lock；第二次启动会聚焦已有窗口。
- close-to-tray 开启时关闭窗口只隐藏；退出需要托盘菜单或显式 quit。
- 护眼模式 `eyeComfortMode` 保存在桌面偏好中，渲染层在根节点切换 `eye-comfort-mode` class，为界面叠加暖色调。
- macOS 原生语音只在 `process.platform === 'darwin'` 支持；主进程通过 `/usr/bin/open -n -W` 以 LaunchServices 启动 helper `.app`，避免裸二进制缺少稳定 bundle 身份导致 TCC 权限异常。
- Electron 与 helper 使用 `/private/tmp/agentos-speech-<pid>-<uuid>.sock` Unix domain socket 传 NDJSON；主进程将 helper 的 `status/partial/final/error` 转发到 `desktop:speech-recognition-event`。
- helper 权限请求顺序为 Speech Recognition 后 Microphone；如果用户拒绝任一权限，主进程推送 `error` 事件并把状态置为 `error`。
- 自动更新只在 packaged 环境启用，启动 8 秒后自动检查，并在应用存活期间每 6 小时轮询一次；开发模式返回 `updatesSupported: false`。
- 更新检查会复用进行中的 `checkPromise`；当状态已经是 `checking`、`available`、`downloading` 或 `downloaded` 时，重复检查直接返回当前状态。
- PNG 剪贴板只接受 `data:image/png;base64` 且有长度上限；SVG 剪贴板会限制字符数和渲染尺寸。
- 设置路由中 `general` 实际承载模型设置，`skills` 承载通用偏好和 Project Skills 开关，`developer` 只在 dev runtime 或显式开关下出现。
- 语言偏好存在 `CodeX-UI-Template-locale-v1`，初始化时只接受 `zh`/`en`，翻译缺失时回退英文，开发环境会输出缺失 key 警告。

## 相关代码文件

### 核心页面组件

- `src/components/setting/SettingsPage.tsx`
- `src/components/setting/ProjectSkillsSettingsPage.tsx`
- `src/components/setting/AppUpdateSettingsPage.tsx`
- `src/components/setting/DeveloperSettingsPage.tsx`

### 功能组件/UI组件

- `src/components/setting/AppUpdateSection.tsx`
- `src/components/setting/AboutSection.tsx`
- `src/icon-inline.tsx`
- `src/icons.ts`

### 数据管理

- `src/desktop-types.ts`
- `src/i18n/i18n.tsx`
- `src/locales/zh.json`
- `src/locales/en.json`
- `src/app-metadata.ts`
- `src/app-events.ts`

### 业务逻辑工具/工具类

- `electron/main.ts`
- `electron/preload.ts`
- `electron/speech-recognition.ts`
- `electron/desktop-preferences-store.ts`
- `electron/app-updater.ts`
- `electron/app-menu.ts`
- `electron/about-panel.ts`
- `electron/window-chrome.ts`
- `electron/ui-locale.ts`
- `electron/safe-console.ts`
- `electron/project-path.ts`
- `electron/env-loader.ts`

### Hooks/其他

- `package.json`
- `vite.config.ts`
- `electron-builder.config.cjs`
- `electron-builder.json5`
- `native/speech-cli/SpeechCLI.swift`
- `native/speech-cli/Info.plist`
- `native/speech-cli/SpeechCLI.entitlements`
- `scripts/build-speech-cli.mjs`
- `build/entitlements.mac.plist`
- `build/entitlements.mac.inherit.plist`
- `docs/RELEASE.md`
- `scripts/`
- `src/main.tsx`
- `src/window-safe-area.ts`
- `src/style.css`
- `src/theme/tokens.css`

## 关联PRD文档

### 直接关联

- `prd/model-settings.md`：设置页承载 Provider 配置。
- `prd/workspace-session.md`：窗口、托盘和导航操作影响工作区入口。

### 间接关联

- `prd/persistence.md`：桌面偏好和设置使用主进程存储。
- `prd/agent-mode.md`：设置页包含 Agent Mode 编辑入口。

### 功能关联/支撑系统

- `prd/chat-agent-runtime.md`：preload API 暴露聊天运行能力，并为 composer 语音输入提供 macOS Apple Speech 事件流。
