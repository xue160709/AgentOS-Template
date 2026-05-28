# OpenClaw token cache hit 实现说明

## 结论

OpenClaw 有明确做提升 token/prompt cache 命中的处理，而且不是单点优化。当前实现主要围绕三件事：

1. 让大段稳定 prompt 尽量保持 byte-identical prefix。
2. 给支持显式缓存的 provider 传入对应的 cache hint 或 cache resource。
3. 在长会话里减少旧工具结果、旧图片、旧 media 标记对后续 prefix cache 的破坏。

这些实现仍然受 provider 合同约束：缓存命中通常要求相同前缀、同一 provider/cache key/会话亲和、达到 provider 最小 token 门槛，并且还在 provider TTL 内。

## Provider 合同背景

- OpenAI Prompt Caching 要求 prompt 前缀精确匹配，建议把静态内容放前面、动态内容放后面；`prompt_cache_key` 可以改善相同前缀请求的路由亲和，`prompt_cache_retention` 可设置 `24h`。
- Anthropic Prompt Caching 通过 `cache_control` breakpoint 标记可缓存前缀，缓存覆盖 `tools`、`system`、`messages` 顺序中直到标记块的位置；默认短 TTL，支持 `ttl: "1h"`。
- Gemini CachedContent 是显式资源：先创建 `cachedContents/...`，之后请求用 `cachedContent` 引用，且 cached content 和模型绑定。

参考：

- OpenAI: https://platform.openai.com/docs/guides/prompt-caching
- Anthropic: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- Google Gemini: https://ai.google.dev/api/caching
- OpenRouter: https://openrouter.ai/docs/features/prompt-caching

## 代码路径总览

| 机制 | 主要代码 | 说明 |
| --- | --- | --- |
| 系统 prompt cache boundary | `src/agents/system-prompt-cache-boundary.ts:3` | 定义内部边界 `OPENCLAW_CACHE_BOUNDARY`，用于把稳定 prefix 和动态 suffix 分开。 |
| 稳定 prefix 组装和缓存 | `src/agents/system-prompt.ts:59`, `src/agents/system-prompt.ts:111`, `src/agents/system-prompt.ts:983`, `src/agents/system-prompt.ts:1253` | 固定 context file 顺序，hash 稳定输入，本地缓存 stable prompt prefix，并把动态运行态内容放到 boundary 后。 |
| provider prompt 贡献 | `src/agents/system-prompt-contribution.ts:6`, `src/agents/gpt5-prompt-overlay.ts:144` | provider 可给稳定区和动态区分别注入文本，GPT-5 overlay 使用 stablePrefix。 |
| Anthropic cache_control | `src/agents/anthropic-payload-policy.ts:73`, `src/agents/anthropic-payload-policy.ts:136`, `src/agents/anthropic-payload-policy.ts:183` | 把 boundary 前的 stablePrefix 单独作为带 `cache_control` 的 system block，dynamicSuffix 不标记；只给 trailing user turn 加 cache marker。 |
| OpenRouter Anthropic marker | `src/llm/providers/stream-wrappers/proxy.ts:157` | 只在 verified OpenRouter route 且 Anthropic-family model ref 时注入 system cache marker。 |
| OpenAI prompt cache key | `src/agents/openai-transport-stream.ts:1848`, `src/agents/openai-transport-stream.ts:2055`, `src/agents/openai-transport-stream.ts:3510` | 用 `promptCacheKey` 或 `sessionId` 作为 cache affinity key，并在 long retention 时传 `prompt_cache_retention: "24h"`。 |
| Gemini CachedContent | `src/agents/embedded-agent-runner/google-prompt-cache.ts:295`, `src/agents/embedded-agent-runner/google-prompt-cache.ts:444` | 为 Gemini 2.5/3 管理 cached content，保存 session custom entry，复用或刷新 TTL，然后从实时请求移除 system prompt/tools 并传 `cachedContent`。 |
| cache TTL 后裁剪上下文 | `src/agents/agent-hooks/context-pruning/settings.ts:48`, `src/agents/agent-hooks/context-pruning/extension.ts:5`, `src/agents/agent-hooks/context-pruning/pruner.ts:287` | cache TTL 到期后才软裁剪或硬清旧 tool result，减少下一次 cache write 大小。 |
| 旧图片和 media 标记清理 | `src/agents/embedded-agent-runner/run/history-image-prune.ts:75` | 保留最近 3 个 completed turns，旧图片和 media URI 在 replay view 中替换为稳定 marker。 |
| 观测和展示 | `src/agents/usage.ts:118`, `src/agents/embedded-agent-runner/prompt-cache-observability.ts:144`, `src/commands/status.format.ts:45` | 归一化 provider usage 中的 cacheRead/cacheWrite，跟踪 cache read 突降原因，并在 status 展示 hit rate。 |

## 1. Stable prefix 和 dynamic suffix

OpenClaw 的核心策略是：把稳定且大的内容放在 cache boundary 前，把容易变化的 channel/session/runtime 内容放在后面。

### 代码块

`src/agents/system-prompt-cache-boundary.ts:3`

```ts
export const SYSTEM_PROMPT_CACHE_BOUNDARY = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n";
```

`src/agents/system-prompt-cache-boundary.ts:9`

```ts
export function splitSystemPromptCacheBoundary(
  text: string,
): { stablePrefix: string; dynamicSuffix: string } | undefined {
  const boundaryIndex = text.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
  if (boundaryIndex === -1) {
    return undefined;
  }
  return {
    stablePrefix: text.slice(0, boundaryIndex).trimEnd(),
    dynamicSuffix: text.slice(boundaryIndex + SYSTEM_PROMPT_CACHE_BOUNDARY.length).trimStart(),
  };
}
```

`src/agents/system-prompt.ts:974`

```ts
const orderedContextFiles = sortContextFilesForPrompt(validContextFiles);
const stableContextFiles = orderedContextFiles.filter((file) => !isDynamicContextFile(file.path));
const dynamicContextFiles = orderedContextFiles.filter((file) => isDynamicContextFile(file.path));
```

`src/agents/system-prompt.ts:983`

```ts
const stablePrefixCacheKey = hashStablePromptInput({
  workspaceDir: params.workspaceDir,
  promptMode,
  promptSurface,
  toolLines,
  providerStablePrefix,
  stableContextFiles,
});
const stablePrefix = cacheStablePromptPrefix(stablePrefixCacheKey, () => {
  const lines = [
    "You are a personal assistant running inside OpenClaw.",
    ...
  ];
  ...
  lines.push(SYSTEM_PROMPT_CACHE_BOUNDARY);
  return lines.filter(Boolean).join("\n");
});
```

`src/agents/system-prompt.ts:1267`

```ts
// Channel/session-specific guidance lives below the cache boundary so large
// stable workspace context can remain a byte-identical prefix across turns.
lines.push(
  ...buildWebchatCanvasSection(...),
  ...buildMessagingSection(...),
  ...buildVoiceSection(...),
);
```

### 具体含义

- `AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md`、`TOOLS.md`、`BOOTSTRAP.md`、`MEMORY.md` 有固定排序，见 `src/agents/system-prompt.ts:59`。
- `HEARTBEAT.md` 被标为 dynamic context file，见 `src/agents/system-prompt.ts:69`。
- `sortContextFilesForPrompt` 先按固定 basename 顺序，再按 basename/path 排序，保证 prompt bytes 不随文件枚举顺序漂移，见 `src/agents/system-prompt.ts:163`。
- stable prefix 会用 SHA-256 hash 做本地 LRU cache，限制 64 个条目，见 `src/agents/system-prompt.ts:111`。
- boundary 后面才追加 Messaging、Voice、Group Chat Context、Reactions、Heartbeats、Runtime 等易变内容。

现有文档也明确写了这个设计：`docs/concepts/system-prompt.md:72` 说明 large stable content 包括 Project Context 在 boundary 上方，volatile channel/session sections 在 boundary 下方。

## 2. Provider prompt 贡献也分 stable/dynamic

Provider 可以提供 cache-aware prompt contribution，而不是直接拼一个会频繁变化的大 prompt。

### 代码块

`src/agents/system-prompt-contribution.ts:6`

```ts
export type ProviderSystemPromptContribution = {
  stablePrefix?: string;
  dynamicSuffix?: string;
  sectionOverrides?: Partial<Record<ProviderSystemPromptSectionId, string>>;
};
```

`src/agents/gpt5-prompt-overlay.ts:144`

```ts
return {
  stablePrefix: GPT5_BEHAVIOR_CONTRACT,
  sectionOverrides: mode === "friendly" ? { interaction_style: interactionStyle } : {},
};
```

### 具体含义

- 模型族稳定行为约束放 `stablePrefix`，进入 cache boundary 前。
- 真正会随运行变化的内容才放 `dynamicSuffix`，进入 boundary 后。
- 测试 `src/agents/system-prompt.test.ts:888` 覆盖 stable/dynamic contribution 被重新应用。
- 测试 `src/agents/system-prompt.test.ts:1184` 检查 Project Context 在 boundary 前，而 Messaging、Group Chat Context、Reactions、Voice 在 boundary 后。

## 3. Anthropic 和 OpenRouter cache_control

Anthropic 需要显式 `cache_control`。OpenClaw 会把系统 prompt 的 stablePrefix 拆成单独 block 并加 cache marker，dynamicSuffix 留成不带 marker 的 block，避免把易变尾部纳入 cache write scope。

### 代码块

`src/agents/anthropic-payload-policy.ts:73`

```ts
function applyAnthropicCacheControlToSystem(
  system: unknown,
  cacheControl: AnthropicEphemeralCacheControl,
): void {
  ...
  const split = splitSystemPromptCacheBoundary(record.text);
  if (!split) {
    if (record.cache_control === undefined) {
      record.cache_control = cacheControl;
    }
    normalizedBlocks.push(record);
    continue;
  }

  const { cache_control: existingCacheControl, ...rest } = record;
  if (split.stablePrefix) {
    normalizedBlocks.push({
      ...rest,
      text: split.stablePrefix,
      cache_control: existingCacheControl ?? cacheControl,
    });
  }
  if (split.dynamicSuffix) {
    normalizedBlocks.push({
      ...rest,
      text: split.dynamicSuffix,
    });
  }
}
```

`src/agents/anthropic-payload-policy.ts:136`

```ts
function applyAnthropicCacheControlToMessages(
  messages: unknown,
  cacheControl: AnthropicEphemeralCacheControl,
): void {
  ...
  if (
    lastBlockRecord.type === "text" ||
    lastBlockRecord.type === "image" ||
    lastBlockRecord.type === "tool_result"
  ) {
    lastBlockRecord.cache_control = cacheControl;
  }
}
```

`src/agents/anthropic-payload-policy.ts:183`

```ts
export function resolveAnthropicPayloadPolicy(
  input: AnthropicPayloadPolicyInput,
): AnthropicPayloadPolicy {
  ...
  return {
    allowsServiceTier: capabilities.allowsAnthropicServiceTier,
    cacheControl:
      input.enableCacheControl === true
        ? resolveAnthropicEphemeralCacheControl(input.baseUrl, input.cacheRetention)
        : undefined,
    serviceTier: input.serviceTier,
  };
}
```

OpenRouter 侧：

`src/llm/providers/stream-wrappers/proxy.ts:157`

```ts
export function createOpenRouterSystemCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  ...
  if (
    !modelId ||
    !isAnthropicModelRef(modelId) ||
    !(endpointClass === "openrouter" || ...)
  ) {
    return underlying(model, context, options);
  }

  return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
    applyAnthropicEphemeralCacheControlMarkers(payloadObj);
  });
}
```

### 具体含义

- `cacheRetention: "long"` 会在允许的 Anthropic-compatible 路径里变成 `{ type: "ephemeral", ttl: "1h" }`，见 `src/agents/anthropic-payload-policy.ts:55`。
- 没有 cache control 时，OpenClaw 会 strip 内部 boundary marker，避免把内部 HTML 注释发给 provider，见 `src/agents/anthropic-payload-policy.ts:120` 和 `src/agents/anthropic-payload-policy.ts:217`。
- trailing user turn 才加 cache marker，代码注释明确是为了保留 Anthropic cache-write scope，见 `src/agents/anthropic-payload-policy.ts:227`。
- OpenRouter 只对 verified OpenRouter route 和 Anthropic-family model ref 注入 marker，避免污染普通 OpenAI-compatible proxy。

测试：

- `src/agents/anthropic-payload-policy.test.ts:50` 覆盖 service tier 和 cache marker。
- `src/agents/embedded-agent-runner/extra-params.openrouter-cache-control.test.ts:30` 覆盖 OpenRouter Anthropic system message marker。
- `src/agents/embedded-agent-runner/extra-params.openrouter-cache-control.test.ts:90` 覆盖不向 thinking blocks 注入 `cache_control`。

## 4. OpenAI prompt_cache_key 和 retention

OpenAI 路径的重点是 cache affinity：同一会话或显式 `promptCacheKey` 尽量发同一个 cache key，并在 long retention 时传 `24h`。

### 代码块

`src/agents/openai-transport-stream.ts:1848`

```ts
function resolvePromptCacheKey(
  options: Pick<BaseStreamOptions, "promptCacheKey" | "sessionId"> | undefined,
  cacheRetention: "short" | "long" | "none",
): string | undefined {
  if (cacheRetention === "none") {
    return undefined;
  }
  return clampOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId);
}
```

`src/agents/openai-transport-stream.ts:2055`

```ts
const cacheRetention = resolveCacheRetention(options?.cacheRetention);
const promptCacheKey = resolvePromptCacheKey(options, cacheRetention);
const params: OpenAIResponsesRequestParams = {
  model: model.id,
  input: messages,
  stream: true,
  prompt_cache_key: promptCacheKey,
  prompt_cache_retention: getPromptCacheRetention(model.baseUrl, cacheRetention),
  ...
};
```

`src/agents/openai-transport-stream.ts:3510`

```ts
if (compat.supportsPromptCacheKey && promptCacheKey) {
  params.prompt_cache_key = promptCacheKey;
  if (cacheRetention === "long") {
    params.prompt_cache_retention = "24h";
  }
}
```

`src/llm/providers/openai-prompt-cache.ts:1`

```ts
export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
```

### 具体含义

- `promptCacheKey` 优先级高于 `sessionId`，所以 cron/recurring runs 可以用稳定 key 做跨 session affinity。
- key 会截断到 64 个字符，见 `src/llm/providers/openai-prompt-cache.ts:3`。
- Responses API 路径会直接带 `prompt_cache_key` 和可选 `prompt_cache_retention`。
- OpenAI-compatible completions 路径只有在 `compat.supportsPromptCacheKey` 为 true 时才传，避免有些 proxy 拒绝该字段。
- proxy 是否 strip prompt cache hint 的判断在 `src/agents/provider-attribution.ts:739` 和 `src/agents/openai-responses-payload-policy.ts:235`。

测试：

- `src/agents/openai-transport-stream.test.ts:2211` 覆盖 `promptCacheKey` 优先于 `sessionId`。
- `src/agents/openai-transport-stream.test.ts:2239` 覆盖 key 截断。

## 5. Gemini CachedContent 管理

Gemini 直接 API 路径除了支持用户显式配置 `cachedContent`，还会在 eligible 模型上自动管理 system prompt cached content。

### 代码块

`src/agents/embedded-agent-runner/prompt-cache-retention.ts:6`

```ts
export function isGooglePromptCacheEligible(params: {
  modelApi?: string;
  modelId?: string;
}): boolean {
  if (params.modelApi !== "google-generative-ai") {
    return false;
  }
  const normalizedModelId = normalizeLowercaseStringOrEmpty(params.modelId);
  return normalizedModelId.startsWith("gemini-2.5") || normalizedModelId.startsWith("gemini-3");
}
```

`src/agents/embedded-agent-runner/google-prompt-cache.ts:295`

```ts
async function createGooglePromptCache(params: {
  ...
}): Promise<{ cachedContent: string; expireTime?: string } | null> {
  const response = await params.fetchImpl(`${params.baseUrl}/cachedContents`, {
    method: "POST",
    ...
    body: JSON.stringify({
      model: params.modelId.startsWith("models/") ? params.modelId : `models/${params.modelId}`,
      ttl: resolveGooglePromptCacheTtl(params.cacheRetention),
      systemInstruction: {
        parts: [{ text: params.systemPrompt }],
      },
      ...(params.tools ? { tools: params.tools } : {}),
      ...(params.toolConfig ? { toolConfig: params.toolConfig } : {}),
    }),
  });
  ...
}
```

`src/agents/embedded-agent-runner/google-prompt-cache.ts:329`

```ts
async function ensureGooglePromptCache(...) {
  const systemPromptDigest = digestSystemPrompt(params.systemPrompt);
  const matchKey = buildGooglePromptCacheMatchKey({
    provider: params.provider,
    modelId: params.model.id,
    modelApi: params.model.api,
    baseUrl,
    systemPromptDigest,
    cacheConfigDigest: params.cacheConfigDigest,
  });
  const latestEntry = readLatestGooglePromptCacheEntry(params.sessionManager, matchKey);
  ...
}
```

`src/agents/embedded-agent-runner/google-prompt-cache.ts:444`

```ts
export async function prepareGooglePromptCacheStreamFn(...) {
  ...
  return async (model, context, options) => {
    const cacheConfig = buildManagedGooglePromptCacheConfig(context, options);
    const cachedContent = await ensureGooglePromptCache(...);
    if (!cachedContent) {
      return inner(model, context, options);
    }

    return streamWithPayloadPatch(
      inner,
      model,
      buildManagedContextForCachedContent(context),
      options,
      (payload) => {
        payload.cachedContent = cachedContent;
      },
    );
  };
}
```

### 具体含义

- `resolveManagedSystemPrompt` 会先 strip OpenClaw 内部 boundary，再 sanitize system prompt，见 `src/agents/embedded-agent-runner/google-prompt-cache.ts:91`。
- match key 包含 provider、model、api、baseUrl、systemPromptDigest、tools/toolConfig digest，避免错误复用。
- ready entry 会复用；快过期时 PATCH TTL；失败会写 failed entry 并 10 分钟 backoff。
- 使用 cached content 后，实时请求里的 `systemPrompt` 和 `tools` 会被清掉，见 `src/agents/embedded-agent-runner/google-prompt-cache.ts:257`，然后 payload 上写入 `cachedContent`。
- 文档 `docs/concepts/model-providers.md:215` 也说明 direct Gemini 支持 `cachedContent` 或 legacy `cached_content`，cache hits 会作为 OpenClaw `cacheRead`。

测试：

- `src/agents/embedded-agent-runner/google-prompt-cache.test.ts:146` 覆盖创建 cached content 并从 live request 移除 system prompt。
- `src/agents/embedded-agent-runner/google-prompt-cache.test.ts:388` 覆盖用户已显式配置 `cachedContent` 时不接管。

## 6. Context pruning 降低 cache write 成本

缓存命中不仅取决于前缀稳定，也取决于 TTL 到期后重新写 cache 的体量。OpenClaw 有 cache-TTL pruning：TTL 过后才把旧 tool results 软裁剪或硬清理。

### 代码块

`src/agents/agent-hooks/context-pruning/settings.ts:48`

```ts
export const DEFAULT_CONTEXT_PRUNING_SETTINGS: EffectiveContextPruningSettings = {
  mode: "cache-ttl",
  ttlMs: 5 * 60 * 1000,
  keepLastAssistants: 3,
  softTrimRatio: 0.3,
  hardClearRatio: 0.5,
  minPrunableToolChars: 50_000,
  ...
};
```

`src/agents/agent-hooks/context-pruning/extension.ts:5`

```ts
export default function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextPruningRuntime(ctx.sessionManager);
    ...
    if (runtime.settings.mode === "cache-ttl") {
      const ttlMs = runtime.settings.ttlMs;
      const lastTouch = runtime.lastCacheTouchAt ?? null;
      if (!lastTouch || ttlMs <= 0) {
        return undefined;
      }
      if (ttlMs > 0 && Date.now() - lastTouch < ttlMs) {
        return undefined;
      }
    }
    const next = pruneContextMessages(...);
    ...
  });
}
```

`src/agents/agent-hooks/context-pruning/pruner.ts:287`

```ts
export function pruneContextMessages(params: {
  messages: AgentMessage[];
  settings: EffectiveContextPruningSettings;
  ...
}): AgentMessage[] {
  ...
  if (ratio < settings.softTrimRatio) {
    return messages;
  }
  ...
  if (ratio < settings.hardClearRatio) {
    return outputAfterSoftTrim;
  }
  ...
  const cleared: ToolResultMessage = {
    ...msg,
    content: [asText(settings.hardClear.placeholder)],
  };
}
```

### 具体含义

- 只改本次 request 的 in-memory context，不改磁盘 transcript，见 `src/agents/agent-hooks/context-pruning.ts:1`。
- 只在 eligible provider 上启用，判断在 `src/agents/embedded-agent-runner/cache-ttl.ts:27`。
- `src/agents/embedded-agent-runner/extensions.ts:105` 从 config 读取 `agents.defaults.contextPruning`，并注入 runtime。
- `docs/concepts/session-pruning.md:24` 说明这主要对 Anthropic prompt caching 有价值：TTL 后重新 cache 的 full prompt 越小，cache write 成本越低。

## 7. 旧图片和 media 标记清理

图片和 media URI 特别容易破坏 prompt cache，因为旧历史 replay 时会被再次当成图片引用。OpenClaw 为 replay view 做幂等清理。

### 代码块

`src/agents/embedded-agent-runner/run/history-image-prune.ts:75`

```ts
/**
 * Idempotent cleanup: prune persisted image blocks from completed turns older
 * than {@link PRESERVE_RECENT_COMPLETED_TURNS}. The delay also reduces
 * prompt-cache churn, though prefix stability additionally depends on the
 * replay sanitizer being idempotent.
 */
export function pruneProcessedHistoryImages(messages: AgentMessage[]): AgentMessage[] | null {
  const pruneBeforeIndex = resolvePruneBeforeIndex(messages);
  ...
}
```

`src/agents/embedded-agent-runner/run/history-image-prune.ts:151`

```ts
export function installHistoryImagePruneContextTransform(agent: PrunableContextAgent): () => void {
  const originalTransformContext = agent.transformContext;
  agent.transformContext = async (messages: AgentMessage[], signal?: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(agent, messages, signal)
      : messages;
    const sourceMessages = Array.isArray(transformed) ? transformed : messages;
    return pruneProcessedHistoryImages(sourceMessages) ?? sourceMessages;
  };
  ...
}
```

### 具体含义

- 最近 3 个 completed turns 保持原样，见 `src/agents/embedded-agent-runner/run/history-image-prune.ts:23`。
- 更旧的 image block 替换成 `[image data removed - already processed by model]`。
- 更旧的 `[media attached: ...]`、`[Image: source: ...]`、`media://inbound/...` 替换成 `[media reference removed - already processed by model]`。
- 安装点在 `src/agents/embedded-agent-runner/run/attempt.ts:3002`，prompt build hook 前也会用 pruned replay view，见 `src/agents/embedded-agent-runner/run/attempt.ts:3991`。

测试：

- `src/agents/embedded-agent-runner/run/history-image-prune.test.ts:83` 覆盖旧用户图片裁剪。
- `src/agents/embedded-agent-runner/run/history-image-prune.test.ts:102` 覆盖旧 media marker scrub。
- `src/agents/embedded-agent-runner/run/history-image-prune.test.ts:252` 覆盖最新用户消息不被裁剪。

## 8. Usage 归一化和 cache break 观测

OpenClaw 还会把不同 provider 的 cache usage 字段归一为 `cacheRead` 和 `cacheWrite`，这样 `/status` 和内部诊断能看到缓存是否真的命中。

### 代码块

`src/agents/usage.ts:118`

```ts
export function normalizeUsage(raw?: UsageLike | null): NormalizedUsage | undefined {
  ...
  const cacheRead = normalizeTokenCount(
    raw.cacheRead ??
      raw.cache_read ??
      raw.cache_read_input_tokens ??
      raw.cached_tokens ??
      raw.input_tokens_details?.cached_tokens ??
      raw.prompt_tokens_details?.cached_tokens,
  );
  ...
  const cacheWrite = normalizeTokenCount(
    raw.cacheWrite ?? raw.cache_write ?? raw.cache_creation_input_tokens,
  );
}
```

`src/agents/embedded-agent-runner/prompt-cache-observability.ts:144`

```ts
export function beginPromptCacheObservation(params: {
  ...
  systemPrompt: string;
  toolNames: string[];
}): PromptCacheObservationStart {
  const snapshot: PromptCacheSnapshot = {
    ...
    systemPromptDigest: digestText(params.systemPrompt),
    toolDigest: buildToolDigest(params.toolNames),
    toolCount: params.toolNames.length,
  };
  const previous = trackers.get(key);
  const changes = previous ? diffSnapshots(previous.snapshot, snapshot) : null;
  ...
}
```

`src/commands/status.format.ts:45`

```ts
export const formatPromptCacheCompact = (
  sess: Pick<SessionStatus, "inputTokens" | "totalTokens" | "cacheRead" | "cacheWrite">,
) => {
  const cacheStats = resolvePromptCacheStats(sess);
  if (!cacheStats) {
    return "";
  }
  const parts = [`${cacheStats.hitRate}% hit`];
  ...
};
```

### 具体含义

- OpenAI `prompt_tokens_details.cached_tokens`、Anthropic `cache_read_input_tokens`、Gemini/other normalized fields 都能落到 `cacheRead`。
- `prompt-cache-observability` 会记录 provider/model/cacheRetention/transport/systemPromptDigest/toolDigest；如果下一次 cacheRead 明显下降，会把变化归因为 model、transport、system prompt、tools 等。
- `status.format.ts` 用 prompt-side denominator 算 cache hit rate，避免旧 totalTokens 数据低估分母。

## 当前源码行为和边界

- 这是基于当前工作区源码的分析；当前分支状态为 `main...origin/main [behind 1]`，工作区已有其他未跟踪 Markdown 文件，本报告没有修改它们。
- 没有对 release tag 做 shipped diff；如要回答某个发布版本是否已包含这些优化，需要再对相应 tag 做对比。
- 本地 `pnpm docs:list` 未能运行，因为当前 shell 中 `pnpm` 不存在；因此本报告读取了相关源码和现有 docs，但没有完成 docs list 命令。
- 缓存命中不能由 OpenClaw 单方面保证。Provider 仍要求前缀相同、工具/schema/images 一致、模型和 endpoint 兼容、TTL 未过期，并且达到 provider 最小 token 要求。
