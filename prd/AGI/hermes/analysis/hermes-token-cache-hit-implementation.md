# Hermes token 缓存命中实现说明

结论：Hermes 有专门做提升 token/prompt cache 命中的处理，但它不是在本地保存模型 KV cache，而是让每次发给上游模型的「可复用前缀」尽量稳定，并在支持缓存的 provider 上显式发送 `cache_control`、`prompt_cache_key` 或会话绑定 header。命中率最终由上游返回的 usage 字段确认，例如 `cached_tokens`、`cache_read_input_tokens`。

## 一句话机制

Hermes 的策略可以概括成三层：

1. 固定请求前缀：system prompt 一次构建、跨 turn 复用，插件和记忆上下文尽量注入 user message，而不是改 system prompt。
2. 显式 cache 标记：Anthropic/Claude 兼容路径在 system prompt 和最近 3 条非 system 消息上加 `cache_control` 断点。
3. 会话级 cache key：OpenAI Responses / Codex / xAI Grok 路径用 `session_id` 派生 `prompt_cache_key` 或 `x-grok-conv-id`，让服务端把同一会话路由到同一缓存域。

## 关键代码入口

| 目的 | 文件 | 代码块 |
| --- | --- | --- |
| 初始化是否启用 prompt caching 与 TTL | `agent/agent_init.py` | `agent._use_prompt_caching`, `agent._cache_ttl`，约 468-489 行 |
| 判断哪些 provider/model 支持 marker | `agent/agent_runtime_helpers.py` | `anthropic_prompt_cache_policy()`，约 1154-1248 行 |
| 真正注入 `cache_control` | `agent/prompt_caching.py` | `_apply_cache_marker()`、`apply_anthropic_cache_control()`，约 15-79 行 |
| 每轮构造 API messages 并套用缓存策略 | `agent/conversation_loop.py` | system prompt 拼接、prefill、`apply_anthropic_cache_control()`、prefix 归一化，约 864-950 行 |
| 复用/持久化 system prompt | `agent/conversation_loop.py` | session DB restore/update，约 150-229 行 |
| Responses/Codex cache key | `agent/transports/codex.py` | `prompt_cache_key`、`session_id`、`x-grok-conv-id`，约 155-159、220-265 行 |
| Qwen Portal cache marker | `plugins/model-providers/qwen-oauth/__init__.py` | `QwenProfile.prepare_messages()`，约 13-52 行 |
| Grok via OpenRouter 会话绑定 | `plugins/model-providers/openrouter/__init__.py` | `build_api_kwargs_extras()`，约 79-94 行 |
| Skill slash command 不破坏 system prompt cache | `agent/skill_commands.py`、`cli.py` | `build_skill_invocation_message()`、pending input，约 430-472、8728-8738 行 |
| 保持 Responses 结构化历史，避免 prefix 变形 | `agent/chat_completion_helpers.py`、`run_agent.py` | `codex_message_items`、`_deterministic_call_id()`，约 948-953、2501-2509 行 |
| 读取并展示缓存命中 | `agent/usage_pricing.py`、`agent/conversation_loop.py` | `normalize_usage()`、cache hit 输出，约 695-729、1769-1788 行 |

## 1. system prompt 一次构建并复用

`agent/system_prompt.py` 的模块注释已经明确说明：system prompt built once per session，并且只有 context compression 才会触发 rebuild。这个设计是缓存命中的基础，因为 provider 的 prompt cache 通常按前缀字节匹配，system prompt 一变就会 miss。

代码块：`agent/system_prompt.py` 约 1-19 行、321-334 行。

```python
# agent/system_prompt.py
"""System-prompt assembly for :class:`AIAgent`.

The agent's system prompt is built once per session and reused across all
turns — only context compression triggers a rebuild.  This keeps the
upstream prefix cache warm.
...
"""

def build_system_prompt(agent: Any, system_message: Optional[str] = None) -> str:
    """Assemble the full system prompt from all layers.

    Called once per session (cached on ``agent._cached_system_prompt``) and
    only rebuilt after context compression events. This ensures the system
    prompt is stable across all turns in a session, maximizing prefix cache
    hits.
    """
```

延伸点：`agent/conversation_loop.py` 会优先从 session DB 读回已保存的 `system_prompt`，尤其照顾 gateway 场景。因为 gateway 可能每轮新建 `AIAgent`，如果不从 DB 读回同一份 prompt，每轮都会 rebuild，前缀缓存会持续 miss。

代码块：`agent/conversation_loop.py` 约 150-229 行。

```python
# Continuing session — reuse the exact system prompt from the
# previous turn so the Anthropic cache prefix matches.
agent._cached_system_prompt = stored_prompt
...
# Persist the system prompt snapshot in SQLite.
agent._session_db.update_system_prompt(agent.session_id, agent._cached_system_prompt)
```

## 2. 插件/记忆上下文不改 system prompt

Hermes 会把外部记忆、plugin hook 的临时上下文注入当前 user message，而不是塞进 system prompt。这样每轮新增的上下文只影响后段，前面的 system prompt 前缀仍然可复用。

代码块：`agent/conversation_loop.py` 约 823-840 行、864-878 行。

```python
# Inject ephemeral context into the current turn's user message.
# Sources: memory manager prefetch + plugin pre_llm_call hooks
# with target="user_message" (the default).
if idx == current_turn_user_idx and msg.get("role") == "user":
    ...
    api_msg["content"] = _base + "\n\n" + "\n\n".join(_injections)

# Plugin context from pre_llm_call hooks is injected into the
# user message, NOT the system prompt.
# This is intentional — system prompt modifications break the prompt
# cache prefix.
```

Skill slash command 也走类似思路：用户输入 `/gif-search`、`/axolotl` 这类 skill 命令时，Hermes 构造一条 user message 放进 pending input，而不是现场改 system prompt。

代码块：`agent/skill_commands.py` 约 430-472 行；`cli.py` 约 8728-8738 行。

```python
# agent/skill_commands.py
def build_skill_invocation_message(...):
    activation_note = (
        f'[IMPORTANT: The user has invoked the "{skill_name}" skill, indicating they want '
        "you to follow its instructions. The full skill content is loaded below.]"
    )
    return _build_skill_message(...)

# cli.py
elif base_cmd in skill_commands:
    msg = build_skill_invocation_message(...)
    if msg and hasattr(self, '_pending_input'):
        self._pending_input.put(msg)
```

`/reload-skills` 也不清空 prompt cache。它只给下一轮 user message 加一个一次性 note：

代码块：`cli.py` 约 10427-10500 行、11765-11771 行。

```python
# Skills don't need to live in the system prompt...
# so this does NOT clear the prompt cache.
self._pending_skills_reload_note = "\n".join(sections)

_srn = getattr(self, '_pending_skills_reload_note', None)
if _srn:
    agent_message = _srn + "\n\n" + agent_message
    self._pending_skills_reload_note = None
```

## 3. Anthropic/Claude 兼容路径：system_and_3 cache_control

Hermes 的核心 marker 实现在 `agent/prompt_caching.py`。策略名写在文件注释里：`system_and_3`，最多 4 个断点：system prompt 加最近 3 条非 system 消息。TTL 支持 `5m` 和 `1h`。

代码块：`agent/prompt_caching.py` 约 15-79 行。

```python
def _build_marker(ttl: str) -> Dict[str, str]:
    marker: Dict[str, str] = {"type": "ephemeral"}
    if ttl == "1h":
        marker["ttl"] = "1h"
    return marker

def apply_anthropic_cache_control(api_messages, cache_ttl="5m", native_anthropic=False):
    messages = copy.deepcopy(api_messages)
    marker = _build_marker(cache_ttl)

    if messages[0].get("role") == "system":
        _apply_cache_marker(messages[0], marker, native_anthropic=native_anthropic)

    remaining = 4 - breakpoints_used
    non_sys = [i for i in range(len(messages)) if messages[i].get("role") != "system"]
    for idx in non_sys[-remaining:]:
        _apply_cache_marker(messages[idx], marker, native_anthropic=native_anthropic)
```

启用条件在 `agent/agent_runtime_helpers.py::anthropic_prompt_cache_policy()`：

代码块：`agent/agent_runtime_helpers.py` 约 1198-1248 行。

```python
if is_native_anthropic:
    return True, True
if (is_openrouter or is_nous_portal) and is_claude:
    return True, False
if is_nous_portal and "qwen" in model_lower:
    return True, False
if is_anthropic_wire and is_claude:
    return True, True
...
if provider_is_alibaba_family and model_is_qwen:
    return True, False

return False, False
```

这里返回的是 `(should_cache, use_native_layout)`。`use_native_layout=True` 表示 native Anthropic 格式，marker 布局要符合 Anthropic Messages API；`False` 表示 OpenAI-wire / OpenRouter 这类 envelope 布局。

TTL 默认值在配置里是 `5m`，可以改成 `1h`：

代码块：`hermes_cli/config.py` 约 897-900 行；`agent/agent_init.py` 约 476-487 行。

```python
# hermes_cli/config.py
"prompt_caching": {
    "cache_ttl": "5m",
}

# agent/agent_init.py
agent._cache_ttl = "5m"
_ttl = _pc_cfg.get("cache_ttl", "5m")
if _ttl in {"5m", "1h"}:
    agent._cache_ttl = _ttl
```

## 4. 每轮 API call 前真正套用缓存策略

`agent/conversation_loop.py` 在构造 `api_messages` 时，会先把缓存下来的 system prompt 放到第一条 message，再按 provider policy 决定是否注入 `cache_control`。

代码块：`agent/conversation_loop.py` 约 864-903 行。

```python
effective_system = active_system_prompt or ""
if agent.ephemeral_system_prompt:
    effective_system = (effective_system + "\n\n" + agent.ephemeral_system_prompt).strip()
if effective_system:
    api_messages = [{"role": "system", "content": effective_system}] + api_messages

if agent._use_prompt_caching:
    api_messages = apply_anthropic_cache_control(
        api_messages,
        cache_ttl=agent._cache_ttl,
        native_anthropic=agent._use_native_cache_layout,
    )
```

同一个代码块后面还做了 prefix 归一化：去掉字符串首尾空白，并把 tool call arguments JSON 重新序列化为稳定格式。这不是 provider 的显式 prompt caching API，但对 prefix byte match 和本地推理服务 KV reuse 很重要。

代码块：`agent/conversation_loop.py` 约 921-950 行。

```python
# Normalize message whitespace and tool-call JSON for consistent
# prefix matching. Ensures bit-perfect prefixes across turns.
for am in api_messages:
    if isinstance(am.get("content"), str):
        am["content"] = am["content"].strip()
...
"arguments": json.dumps(
    args_obj, separators=(",", ":"), sort_keys=True,
)
```

## 5. Qwen Portal 独立处理 cache_control

Qwen Portal provider profile 会把 message content 统一成 list-of-parts，并在 system message 最后一个 part 加 `cache_control`。

代码块：`plugins/model-providers/qwen-oauth/__init__.py` 约 13-52 行。

```python
def prepare_messages(self, messages):
    ...
    # Inject cache_control on the last part of the system message.
    for msg in prepared:
        if isinstance(msg, dict) and msg.get("role") == "system":
            content = msg.get("content")
            if isinstance(content, list) and content and isinstance(content[-1], dict):
                content[-1]["cache_control"] = {"type": "ephemeral"}
            break
```

这条路径由 `agent/transports/chat_completions.py` 调用 provider profile 的 `prepare_messages()` 和 `build_api_kwargs_extras()`。

代码块：`agent/transports/chat_completions.py` 约 489-516 行。

```python
extra_body_from_profile, top_level_from_profile = (
    profile.build_api_kwargs_extras(..., session_id=params.get("session_id"))
)
api_kwargs.update(top_level_from_profile)

profile_body = profile.build_extra_body(
    session_id=params.get("session_id"),
    ...
)
```

## 6. OpenAI Responses / Codex / xAI：用 session_id 绑定缓存域

Responses/Codex 路径不是用 Anthropic `cache_control`，而是用 `session_id` 生成 cache-routing key。

代码块：`agent/transports/codex.py` 约 155-159 行。

```python
session_id = params.get("session_id")
if not is_github_responses and not is_xai_responses and session_id:
    kwargs["prompt_cache_key"] = session_id
```

OpenAI Codex backend 还会把同一个 cache scope 放进 headers：

代码块：`agent/transports/codex.py` 约 220-236 行。

```python
if is_codex_backend:
    prompt_cache_key = kwargs.get("prompt_cache_key")
    cache_scope_id = str(prompt_cache_key or session_id or "").strip()
    if cache_scope_id:
        merged_extra_headers["session_id"] = cache_scope_id
        merged_extra_headers["x-client-request-id"] = cache_scope_id
        kwargs["extra_headers"] = merged_extra_headers
```

xAI Responses API 则同时发 header 和 body-level `prompt_cache_key`：

代码块：`agent/transports/codex.py` 约 242-265 行。

```python
if is_xai_responses and session_id:
    merged_extra_headers["x-grok-conv-id"] = session_id
    kwargs["extra_headers"] = merged_extra_headers

    merged_extra_body.setdefault("prompt_cache_key", session_id)
    kwargs["extra_body"] = merged_extra_body
```

Grok 走 OpenRouter chat completions 时也有类似处理：

代码块：`plugins/model-providers/openrouter/__init__.py` 约 79-94 行。

```python
# For xAI Grok models routed through OpenRouter, attach the
# ``x-grok-conv-id`` header so that xAI's prompt cache stays pinned to
# the same backend server across turns.
if session_id and model and model.startswith(("x-ai/grok-", "xai/grok-")):
    extra_headers["x-grok-conv-id"] = session_id
```

## 7. Responses 历史不能随便 flatten

Responses API 会返回结构化 items。Hermes 保存 `codex_message_items`，下轮 replay 时尽量保持结构不变，而不是把它们全部压平成普通文本；否则相同语义也可能变成不同前缀，导致 cache miss。

代码块：`agent/chat_completion_helpers.py` 约 948-953 行。

```python
# Codex Responses API: preserve exact assistant message items (with
# id/phase) so follow-up turns can replay structured items instead of
# flattening to plain text. This is required for prefix cache hits.
codex_message_items = getattr(assistant_message, "codex_message_items", None)
if codex_message_items:
    msg["codex_message_items"] = codex_message_items
```

另一个细节是 tool call id 的 fallback 不能用随机 UUID。Hermes 用函数名、参数和 index 生成确定性 id，避免每轮前缀因为随机 id 改变。

代码块：`run_agent.py` 约 2501-2509 行。

```python
def _deterministic_call_id(fn_name: str, arguments: str, index: int = 0) -> str:
    """Generate a deterministic call_id from tool call content.

    Deterministic IDs prevent cache invalidation — random UUIDs would
    make every API call's prefix unique, breaking OpenAI's prompt cache.
    """
```

## 8. 命中统计如何读

Hermes 不猜命中率，而是从 provider usage 字段归一化。

代码块：`agent/usage_pricing.py` 约 695-729 行。

```python
if mode == "anthropic_messages" or provider_name == "anthropic":
    cache_read_tokens = _to_int(getattr(response_usage, "cache_read_input_tokens", 0))
    cache_write_tokens = _to_int(getattr(response_usage, "cache_creation_input_tokens", 0))
elif mode == "codex_responses":
    details = getattr(response_usage, "input_tokens_details", None)
    cache_read_tokens = _to_int(getattr(details, "cached_tokens", 0) if details else 0)
else:
    details = getattr(response_usage, "prompt_tokens_details", None)
    cache_read_tokens = _to_int(getattr(details, "cached_tokens", 0) if details else 0)
```

然后在会话循环里输出：

代码块：`agent/conversation_loop.py` 约 1769-1788 行。

```python
cached = canonical_usage.cache_read_tokens
written = canonical_usage.cache_write_tokens
prompt = usage_dict["prompt_tokens"]
if (cached or written) and not agent.quiet_mode:
    hit_pct = (cached / prompt * 100) if prompt > 0 else 0
    agent._vprint(
        f"{agent.log_prefix}   💾 Cache: "
        f"{cached:,}/{prompt:,} tokens "
        f"({hit_pct:.0f}% hit, {written:,} written)"
    )
```

## 9. 覆盖它的测试

相关测试集中在：

- `tests/agent/test_prompt_caching.py`：验证 marker 注入、最多 4 个断点、`1h` TTL。
- `tests/run_agent/test_run_agent.py`：验证 Claude via OpenRouter、native Anthropic 启用缓存，非 Claude/不支持路径不启用，以及 TTL 默认 `5m`、配置 `1h` 生效。
- `tests/agent/transports/test_codex_transport.py`：验证 Responses `prompt_cache_key` 和 xAI `extra_body.prompt_cache_key` / `x-grok-conv-id`。
- `tests/agent/test_usage_pricing.py`：验证 Anthropic/OpenAI/Codex usage 中缓存 token 的归一化。

## 需要注意的边界

- 这是 provider/server-side prompt cache，不是 Hermes 本地 KV cache。
- `prompt_caching.cache_ttl` 默认是 `5m`；设成 `1h` 后，`cache_control` 才会带 `ttl: "1h"`。
- 改 system prompt、reload MCP 工具、context compression 后 rebuild prompt，都可能导致下一轮 cache miss。
- 对不暴露缓存 usage 的 provider，Hermes 仍可能做了前缀稳定化，但无法显示准确 hit rate。
