# OpenClaw 插件系统构建说明

更新时间：2026-05-28

本文是对当前工作区源码的走读笔记。文中的代码引用使用仓库根路径和行号，例如 `src/plugins/loader.ts:1563-1765`。行号会随代码变动漂移，若后续重构，需要重新校准。

## 结论

OpenClaw 的插件系统不是一个简单的“扫描目录后全量 import”的机制。它更像两层系统：

- 控制面：先发现插件根目录，读取 `openclaw.plugin.json`，建立 manifest registry、installed index、metadata snapshot、lookup table 和 activation plan。这一层尽量不执行插件代码。
- 运行面：在 gateway、provider、channel、tool、CLI、HTTP route 等具体场景需要时，再按作用域加载插件模块，调用插件导出的 `register(api)`，把能力注册到 `PluginRegistry`，并把 registry 挂到 active runtime surface。

整体链路可以理解为：

```mermaid
flowchart LR
  A["插件包和 manifest"] --> B["source roots"]
  B --> C["discovery"]
  C --> D["manifest registry"]
  D --> E["metadata snapshot"]
  E --> F["lookup table / startup plan"]
  F --> G["runtime registry loader"]
  G --> H["loadOpenClawPlugins"]
  H --> I["register(api)"]
  I --> J["PluginRegistry"]
  J --> K["active providers / channels / tools / HTTP / services"]
```

注意：源码里插件包目录叫 `extensions/`，这是内部路径名；对外和文档语义仍然是 plugin/plugins。

## 插件包由什么构成

一个 OpenClaw 原生插件至少有三类信息：

1. Manifest：`openclaw.plugin.json`。这是控制面最早读取的元数据，负责插件 id、配置 schema、provider/channel/tool/hook/CLI/activation/setup 等声明。manifest 文件名和大小上限在 `src/plugins/manifest.ts:34-37` 定义；activation 字段在 `src/plugins/manifest.ts:157-183`，setup 字段在 `src/plugins/manifest.ts:219-230`。
2. Package entry：`package.json` 里的 `openclaw.extensions` 描述源码入口，`openclaw.runtimeExtensions` 描述构建后的运行时入口，二者需要一一对应。入口校验和 source/runtime entry 解析在 `src/plugins/package-entry-resolution.ts:57-83`、`src/plugins/package-entry-resolution.ts:141-239`、`src/plugins/package-entry-resolution.ts:477-598`。
3. Runtime export：插件入口最终导出函数或对象，loader 会接受 `register`，也兼容历史 `activate` 别名。解析规则在 `src/plugins/loader.ts:1472-1513`，实际调用 `register(api)` 在 `src/plugins/loader.ts:2479-2486`。

SDK 提供了几类常用入口封装：

- 通用插件：`definePluginEntry` 生成默认 entry，延迟暴露 config schema，并保留 `register` 函数，见 `src/plugin-sdk/plugin-entry.ts:305-329`。
- Channel 插件：`defineChannelPluginEntry` 按 registration mode 区分 CLI metadata、tool discovery 和 full runtime 注册，见 `src/plugin-sdk/core.ts:532-578`。
- Tool 插件：`defineToolPlugin` 从 tool definitions 生成 metadata，默认声明 `onStartup: true`，并注册工具，见 `src/plugin-sdk/tool-plugin.ts:131-212`。
- Provider 插件：`defineSingleProviderPluginEntry` 负责 provider auth/catalog 和 `api.registerProvider`、`api.registerModelCatalogProvider`，见 `src/plugin-sdk/provider-entry.ts:153-270`。
- Setup 插件：`defineSetupPluginEntry` 返回 setup plugin 包装，见 `src/plugin-sdk/core.ts:586-588`。

## 插件从哪里来

插件来源分四类，最后都进入同一套 registry 语义：

- Bundled plugins：源码树里的 `extensions/*`，构建后随核心分发。
- Global installed plugins：用户配置目录下的 `extensions`。
- Workspace plugins：工作区 `.openclaw/extensions`。
- Explicit load paths：`plugins.load.paths` 中显式指定的路径。

根目录解析在 `src/plugins/roots.ts:17-27`。Bundled root 解析优先找构建产物，例如 `dist/extensions`、`dist-runtime/extensions`，然后才回退到源码 checkout 的 `extensions`，见 `src/plugins/bundled-dir.ts:164-194` 和 `src/plugins/bundled-dir.ts:301-309`。

Discovery 阶段先构造候选对象，再做路径边界、权限、world-writable、可疑 owner 等安全检查，见 `src/plugins/discovery.ts:58-85` 和 `src/plugins/discovery.ts:118-239`。真正扫描 explicit paths、workspace、bundled、global/install records 的入口是 `discoverOpenClawPlugins`，见 `src/plugins/discovery.ts:1314-1515`。

当多个来源声明同一个插件 id，manifest registry 会做去重和优先级处理。当前优先级是 config > workspace > global > bundled，代码注释在 `src/plugins/manifest-registry.ts:1096-1099`。

## 构建和安装链路

Bundled plugin 的构建入口挂在根 `package.json`。主构建脚本是 `scripts/build-all.mjs`，对应 `package.json:1391-1396`；插件相关脚本集中在 `package.json:1558-1570`。

构建 bundled plugins 时，`scripts/lib/bundled-plugin-build-entries.mjs:186-249` 会遍历 `extensions/*`，要求目录有 manifest 或被识别为 manifestless support package，并从 package metadata 和 public surface entry 收集构建入口。插件资产构建和复制通过 `openclaw.assetScripts` hook 执行，读取和运行逻辑在 `scripts/bundled-plugin-assets.mjs:60-132`。

外部代码插件安装时，核心会先验证 package 级 contract。`@openclaw/plugin-package-contract` 要求 package metadata 带有 `openclaw.compat.pluginApi` 和 `openclaw.build.openclawVersion`，见 `packages/plugin-package-contract/src/index.ts:20-23`；兼容信息标准化和校验在 `packages/plugin-package-contract/src/index.ts:46-75`、`packages/plugin-package-contract/src/index.ts:89-99`。

安装路径会优先把 source dir 当成 native package，再考虑 bundle fallback 和 package dir。这个分支在 `src/plugins/install.ts:1265-1288`。安装校验会读取 `package.json`、`openclaw.extensions`、manifest、插件 id、host version、entry boundary，并做危险代码和 source scan，见 `src/plugins/install.ts:1315-1477`。真正安装 package dir 时会准备目标目录、判断依赖安装、复制到插件存储，再做依赖 scan/link，见 `src/plugins/install.ts:1575-1657`。

安装后的快照由 installed plugin index 表示。它把 discovery/registry 结果、规范化 install records、policy hash、diagnostics 等写成索引，见 `src/plugins/installed-plugin-index.ts:44-102`。有效启用状态读取在 `src/plugins/installed-plugin-index.ts:127-148`。

## 控制面如何建立

控制面的关键目标是：在尽量不执行插件代码的前提下，知道有哪些插件、它们拥有什么能力、哪些配置会触发它们、哪些插件需要在当前场景加载。

### 1. Manifest 加载

`loadPluginManifest` 会在 root 边界内打开 `openclaw.plugin.json`，解析 JSON/JSON5，要求对象、`id` 和 `configSchema`，再规范化 channels、providers、cliBackends、model metadata、auth、setup、activation、contracts、tool metadata、channel configs 等字段，见 `src/plugins/manifest.ts:1565-1745`。

### 2. Manifest registry

`PluginManifestRecord` 是 manifest 控制面的标准记录，字段包括 id/name/version、默认启用、origin、channels/providers/cliBackends、setup、contracts、configSchema、channelConfigs、source/root/setupSource 等，见 `src/plugins/manifest-registry.ts:194-260`。

`loadPluginManifestRegistry` 会规范化插件配置，调用 discovery，加载 native 或 bundle manifest，检查 min host version，构建 bundle/native record，计算 schema cache key，并处理重复插件，见 `src/plugins/manifest-registry.ts:932-1115`。

### 3. Metadata snapshot

Metadata snapshot 把 installed index、manifest registry、diagnostics、owner maps、normalizer、metrics、discovery 结果合并成一个进程内快照。owner maps 包括 channel、channel config、provider、model catalog provider、CLI backend、setup provider、command alias、contract 等映射，见 `src/plugins/plugin-metadata-snapshot.ts:424-480` 和 `src/plugins/plugin-metadata-snapshot.ts:614-690`。

快照加载和 memoization 在 `src/plugins/plugin-metadata-snapshot.ts:489-556`。Gateway 还维护一个当前快照的单槽 handoff，用 workspace、policy hash、config fingerprint 做兼容判断，见 `src/plugins/current-plugin-metadata-snapshot.ts:33-35` 和 `src/plugins/current-plugin-metadata-snapshot.ts:109-190`。如果当前 Gateway 快照兼容，`resolvePluginMetadataSnapshot` 会复用它，否则重新解析，见 `src/plugins/plugin-metadata-snapshot.ts:575-611`。

### 4. Lookup table 和 enablement

`loadPluginLookUpTable` 会复用或创建 metadata snapshot，计算 gateway startup plan，并返回 hash key、startup plan、metrics，见 `src/plugins/plugin-lookup-table.ts:50-103`。

插件启用状态有几层：

- 默认启用：`enabledByDefault` 或 platform-specific default，见 `src/plugins/default-enablement.ts:6-13`。
- 显式启用：`enablePluginInConfig` 会处理 `plugins.enabled`、denylist、allowlist，再写入 `entries.<id>.enabled`，见 `src/plugins/enable.ts:12-39`。
- 有效插件 id：`resolveEffectivePluginIds` 先处理 allowlist 和 `entries.<id>.enabled`，再被 deny 或 entry false 移除，最后补上 auto-enable、slot、channel owner、startup plan 需要的插件，见 `src/plugins/effective-plugin-ids.ts:99-123` 和 `src/plugins/effective-plugin-ids.ts:143-189`。
- Auto-enable：检测和应用在 `src/config/plugin-auto-enable.detect.ts:11-34`、`src/config/plugin-auto-enable.apply.ts:44-57`。

### 5. Activation planning

运行时按需加载不是靠猜，而是靠 manifest activation metadata 和 owner metadata。`resolveManifestActivationPlan` 支持 command、provider、agent harness、channel、route、capability 等 trigger，见 `src/plugins/activation-planner.ts:1-66` 和 `src/plugins/activation-planner.ts:66-121`。

不同 trigger 会产生不同原因，例如 `activation-provider-hint`、`manifest-provider-owner`、`manifest-channel-owner`、`manifest-tool-contract` 等。具体匹配逻辑在 `src/plugins/activation-planner.ts:150-253`。

Gateway 启动计划更细，它会从 configured channels、agent harness runtime、root config activation paths、speech/web-search/model/generation providers、explicit hook policy、memory/context slots、`onStartup` 等入口筛选插件。核心决策在 `src/plugins/gateway-startup-plugin-ids.ts:927-1134`，通过 metadata snapshot 加载 startup plan 的入口在 `src/plugins/gateway-startup-plugin-ids.ts:1147-1186`。

## 运行面如何加载

运行面由 `loadOpenClawPlugins` 和 runtime registry loader 负责。它的关键特点是：有 scope、有 cache、有 manifest-only 路径，也有 full module activation 路径。

### 1. Scope 和 registry loader

`ensurePluginRegistryLoaded` 接收 scope。scope 可以是 none、configured channels、specific channels 或 all，定义在 `src/plugins/runtime/runtime-registry-loader.ts:25-40`。scope 会被映射成 configured channel ids、channel ids 或 effective plugin ids，见 `src/plugins/runtime/runtime-registry-loader.ts:81-108`。

实际加载时，`ensurePluginRegistryLoaded` 会解析上下文、找到 channel owner plugin ids、检查 active registry 是否兼容、构造只激活指定插件的 scoped config，然后调用 `loadOpenClawPlugins`，见 `src/plugins/runtime/runtime-registry-loader.ts:125-228`。

### 2. Loader context

`PluginLoadOptions` 描述 loader 可接受的运行参数，见 `src/plugins/loader.ts:175-215`。`resolvePluginLoadCacheContext` 会应用默认值、activation source、规范化 config、install records、cache key、`shouldActivate` 和 `shouldLoadModules`，见 `src/plugins/loader.ts:1139-1207`。

loader 还会把启用状态、allow/deny、memory slot、entries、enabled channels、autoEnabledReasons 等纳入 activation metadata hash，见 `src/plugins/loader.ts:908-943`。这让 cache key 能跟随插件激活输入变化。

### 3. Manifest-only 和 full module load

`loadOpenClawPlugins` 的主入口在 `src/plugins/loader.ts:1563-1765`。它会处理空 scope、cache 复用、active state 清理、module loader/runtime proxy 延迟创建、registry 创建、discovery 和 manifest registry 加载。

每个 manifest record 进入 schema/status 检查后，registration plan 会决定 disabled、setup、full 等模式；bundle record 不会加载代码，见 `src/plugins/loader.ts:1910-1974`。

config schema 是必需的。loader 会验证 `plugins.entries.<id>.config`，如果 `loadModules=false`，就只把 manifest snapshot metadata 写进 registry record，不导入 runtime module，见 `src/plugins/loader.ts:2069-2118`。manifest snapshot metadata 的复制函数在 `src/plugins/loader.ts:1126-1137`。

如果需要 full module load，loader 会选择 runtime/setup entry，在插件 root 边界内打开 entry，然后加载模块，见 `src/plugins/loader.ts:2120-2160`。

### 4. register(api)

模块 export 解析完成后，如果没有 `register` 或历史 `activate`，loader 会报错。然后它按插件配置、hook policy、registration mode、runtime proxy 创建 API，见 `src/plugins/loader.ts:2449-2468`。真正执行 `register(api)` 在 `src/plugins/loader.ts:2479-2486`。

如果是 snapshot load，loader 会恢复 global runtime prompt 和 registry state，避免非激活加载污染进程全局，见 `src/plugins/loader.ts:2487-2499`。注册失败时会回滚插件 global side effects 并恢复 registry，见 `src/plugins/loader.ts:2502-2526`。成功后会缓存 registry state，并在需要时激活 registry，见 `src/plugins/loader.ts:2576-2597`。

CLI parse-time 有单独的 metadata registry 加载路径，使用 `activate=false` 和 manifest registry，只取 CLI descriptors，见 `src/plugins/loader.ts:2604-2648`。

## PluginRegistry 和 API 表面

`PluginRegistry` 是所有 runtime 能力的汇总容器。空 registry 的结构包含 plugins、tools、hooks、typedHooks、channels、providers、CLI、HTTP routes、services 等数组，见 `src/plugins/registry-empty.ts:3-54`。

插件拿到的 `api` 不是裸 registry，而是由 `createApi` 包装出来的 per-plugin 能力面。API 会带上 registration mode、runtime、logger、resolvePath，并调用 `buildPluginApi`，见 `src/plugins/registry.ts:2600-2639`。API 暴露的能力包括 `registerTool`、`registerHttpRoute`、`registerProvider`、`registerEmbeddingProvider`、`registerChannel`、各种 provider、gateway method/service/discovery、CLI、text transforms、reload、commands、conversation binding 等，见 `src/plugins/registry.ts:2641-2715`。

一些关键注册器：

- Tools：`registerTool` 在 `src/plugins/registry.ts:569-774`。
- HTTP routes：`registerHttpRoute` 在 `src/plugins/registry.ts:774-896`。
- Channels：`registerChannel` 在 `src/plugins/registry.ts:896-975`。
- Model providers：`registerProvider` 在 `src/plugins/registry.ts:984-1079`。
- CLI backends 和 CLI metadata：`registerCliBackend`、`registerCli` 在 `src/plugins/registry.ts:1079-1198` 和 `src/plugins/registry.ts:1393-1435`。
- Provider-like 能力去重：`registerUniqueProviderLike` 和 speech/realtime/media/image/video/music/web-fetch/web-search provider 注册在 `src/plugins/registry.ts:1198-1389`。
- Services：`registerService` 在 `src/plugins/registry.ts:1632-1708`。
- Typed hooks：`registerTypedHook` 会验证 hook name、处理历史 deactivate alias、prompt/conversation hook policy、timeout，再写入 registry，见 `src/plugins/registry.ts:2392-2471`。
- Runtime proxy：per-plugin runtime proxy 会给 runtime 操作加作用域，并限制 trusted state store，见 `src/plugins/registry.ts:2523-2598`。

注册完成后，active runtime surface 由 `src/plugins/runtime.ts` 管理。`setActivePluginRegistry` 会递增版本，并同步 HTTP/channel surface，再 retire 上一个 registry，见 `src/plugins/runtime.ts:182-205`。读取 active registry 的函数在 `src/plugins/runtime.ts:207-223`；active HTTP route 和 channel registry 的单独 surface 在 `src/plugins/runtime.ts:248-319`；active registry key/version 在 `src/plugins/runtime.ts:322-331`。

为了避免重复加载，`getCompatibleActivePluginRegistry` 会检查 active registry 是否覆盖 required plugin ids、workspace、channel/http-route registry 等条件，见 `src/plugins/active-runtime-registry.ts:24-65` 和 `src/plugins/active-runtime-registry.ts:81-115`。

## 插件能力如何被消费

Provider runtime 会先从 manifest metadata 和 owner maps 推导 provider owner plugin ids，再按 providerRefs/modelRefs 构造加载范围。显式 provider owner 解析在 `src/plugins/providers.runtime.ts:38-91`，provider load base 在 `src/plugins/providers.runtime.ts:104-160`，runtime load options 在 `src/plugins/providers.runtime.ts:258-287`，最终返回 `registry.providers` 在 `src/plugins/providers.runtime.ts:313-367`。

Channel 插件优先从 active channel registry 读取，fallback 到 bundled channel plugin。`getChannelPlugin` 在 `src/channels/plugins/registry.ts:12-38`；active channel registry 的排序和索引在 `src/channels/plugins/registry-loaded.ts:51-91`；list/get loaded channel plugins 在 `src/channels/plugins/registry-loaded.ts:94-111`。

Tools 会应用 plugin tool allow/deny 规则，见 `src/plugins/tools.ts:126-175`。Services 从 registry 里启动插件服务，并给每个服务提供 scoped context 和 cleanup，见 `src/plugins/services.ts:94-154`。HTTP routes 通过 active/scope registry 注册，包含路径规范化和冲突检查，见 `src/plugins/http-registry.ts:19-106`。

## 关键约束

1. Manifest-first：OpenClaw 先读 manifest 再决定是否加载代码。配置 schema、owner metadata、activation hint 都应该尽量放在 manifest。
2. Lazy runtime：插件 runtime module 只有在 scope 或 activation plan 命中时才加载。metadata snapshot 和 lookup table 是为了让热路径不反复扫目录或读 JSON。
3. Boundary-first：discovery、manifest、entry resolution 都强调插件 root 边界。外部代码插件不能通过 package entry 逃出插件包。
4. Registry-owned lifecycle：插件能力写入 `PluginRegistry`，再由 runtime 统一切换 active registry surface。失败时 loader 会回滚 global side effects。
5. Bundled 和 external 共享同一 registry 语义：bundled 插件来自内部 `extensions/*`，外部插件来自安装目录或 explicit paths，但能力消费方通常只看 manifest/registry/snapshot，不直接依赖某个插件目录。
6. Config 是 contract：插件配置必须通过 manifest config schema 验证。配置变更会影响 activation metadata hash、effective plugin ids 和 startup plan。

## 代码引用索引

| 主题 | 关键代码 |
| --- | --- |
| 插件根目录解析 | `src/plugins/roots.ts:17-27` |
| Bundled root 解析 | `src/plugins/bundled-dir.ts:164-194`, `src/plugins/bundled-dir.ts:301-309` |
| Discovery candidate 和安全检查 | `src/plugins/discovery.ts:58-85`, `src/plugins/discovery.ts:118-239` |
| Discovery 主入口 | `src/plugins/discovery.ts:1314-1515` |
| Manifest 文件约定 | `src/plugins/manifest.ts:34-37` |
| Manifest activation/setup 字段 | `src/plugins/manifest.ts:157-183`, `src/plugins/manifest.ts:219-230` |
| Manifest 加载和规范化 | `src/plugins/manifest.ts:1565-1745` |
| Manifest record 结构 | `src/plugins/manifest-registry.ts:194-260` |
| Manifest registry 加载 | `src/plugins/manifest-registry.ts:932-1115` |
| 插件来源优先级 | `src/plugins/manifest-registry.ts:1096-1099` |
| Metadata snapshot owner maps | `src/plugins/plugin-metadata-snapshot.ts:424-480` |
| Metadata snapshot 加载和复用 | `src/plugins/plugin-metadata-snapshot.ts:489-556`, `src/plugins/plugin-metadata-snapshot.ts:575-611`, `src/plugins/plugin-metadata-snapshot.ts:614-690` |
| 当前 Gateway snapshot handoff | `src/plugins/current-plugin-metadata-snapshot.ts:33-35`, `src/plugins/current-plugin-metadata-snapshot.ts:109-190` |
| Lookup table | `src/plugins/plugin-lookup-table.ts:50-103` |
| 默认启用和显式启用 | `src/plugins/default-enablement.ts:6-13`, `src/plugins/enable.ts:12-39` |
| Effective plugin ids | `src/plugins/effective-plugin-ids.ts:99-123`, `src/plugins/effective-plugin-ids.ts:143-189` |
| Auto-enable | `src/config/plugin-auto-enable.detect.ts:11-34`, `src/config/plugin-auto-enable.apply.ts:44-57` |
| Manifest activation planner | `src/plugins/activation-planner.ts:1-66`, `src/plugins/activation-planner.ts:66-121`, `src/plugins/activation-planner.ts:150-253` |
| Gateway startup plan | `src/plugins/gateway-startup-plugin-ids.ts:927-1134`, `src/plugins/gateway-startup-plugin-ids.ts:1147-1186` |
| Loader options 和 cache context | `src/plugins/loader.ts:175-215`, `src/plugins/loader.ts:908-943`, `src/plugins/loader.ts:1139-1207` |
| Manifest-only metadata | `src/plugins/loader.ts:1126-1137`, `src/plugins/loader.ts:2069-2118` |
| Loader 主入口 | `src/plugins/loader.ts:1563-1765` |
| Registration plan | `src/plugins/loader.ts:1910-1974` |
| Runtime/setup entry load | `src/plugins/loader.ts:2120-2160` |
| Runtime export 和 register | `src/plugins/loader.ts:1472-1513`, `src/plugins/loader.ts:2449-2486` |
| Loader rollback/cache/activate | `src/plugins/loader.ts:2487-2526`, `src/plugins/loader.ts:2576-2597` |
| CLI metadata registry | `src/plugins/loader.ts:2604-2648` |
| Runtime registry scope loader | `src/plugins/runtime/runtime-registry-loader.ts:25-40`, `src/plugins/runtime/runtime-registry-loader.ts:81-108`, `src/plugins/runtime/runtime-registry-loader.ts:125-228` |
| Active runtime registry | `src/plugins/active-runtime-registry.ts:24-65`, `src/plugins/active-runtime-registry.ts:81-115`, `src/plugins/runtime.ts:182-331` |
| Empty registry shape | `src/plugins/registry-empty.ts:3-54` |
| API 创建和能力注册 | `src/plugins/registry.ts:2600-2639`, `src/plugins/registry.ts:2641-2715` |
| Tool/HTTP/channel/provider/CLI/service/hook 注册 | `src/plugins/registry.ts:569-975`, `src/plugins/registry.ts:984-1435`, `src/plugins/registry.ts:1632-1708`, `src/plugins/registry.ts:2392-2471` |
| Runtime proxy | `src/plugins/registry.ts:2523-2598` |
| SDK 通用 entry | `src/plugin-sdk/plugin-entry.ts:305-329` |
| SDK channel/setup entry | `src/plugin-sdk/core.ts:532-578`, `src/plugin-sdk/core.ts:586-588` |
| SDK tool/provider entry | `src/plugin-sdk/tool-plugin.ts:131-212`, `src/plugin-sdk/provider-entry.ts:153-270` |
| Bundled plugin build scripts | `package.json:1391-1396`, `package.json:1558-1570`, `scripts/lib/bundled-plugin-build-entries.mjs:186-249`, `scripts/bundled-plugin-assets.mjs:60-132` |
| External plugin package contract | `packages/plugin-package-contract/src/index.ts:20-23`, `packages/plugin-package-contract/src/index.ts:46-75`, `packages/plugin-package-contract/src/index.ts:89-99` |
| Package entry resolution | `src/plugins/package-entry-resolution.ts:57-83`, `src/plugins/package-entry-resolution.ts:141-239`, `src/plugins/package-entry-resolution.ts:477-632`, `src/plugins/package-entry-resolution.ts:635-681` |
| Install path 和 installed index | `src/plugins/install.ts:1265-1288`, `src/plugins/install.ts:1315-1477`, `src/plugins/install.ts:1575-1657`, `src/plugins/installed-plugin-index.ts:44-148` |
| Provider/channel/tool/service/HTTP consumption | `src/plugins/providers.runtime.ts:38-367`, `src/channels/plugins/registry.ts:12-38`, `src/channels/plugins/registry-loaded.ts:51-111`, `src/plugins/tools.ts:126-175`, `src/plugins/services.ts:94-154`, `src/plugins/http-registry.ts:19-106` |

## 验证记录

- 已按 docs 工作流先运行 `corepack pnpm docs:list`，再阅读相关 docs 页面。
- 已阅读相关 scoped guides：`docs/AGENTS.md`、`src/plugins/AGENTS.md`、`src/plugin-sdk/AGENTS.md`、`extensions/AGENTS.md`、`src/channels/AGENTS.md`。
- 本次只新增内部 Markdown 走读笔记，没有修改运行时代码。
