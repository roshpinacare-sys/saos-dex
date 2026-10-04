# sovereign-gateway

Multi-provider **OpenAI-compatible LLM gateway** for the fleet — maximal free LLM power with **ZERO signup today**.

- **Port: 3041** (fixed — the service ignores the `PORT` env by law)
- Sibling of `zai-openai-shim` (:3040, CR-0015/CR-0024) — that artifact is untouched; this gateway reuses its verified keyless SDK pattern as the **always-ready floor** provider.

## Providers (priority order)

| # | id | mode | models | free tier (provider-documented, verify at signup) |
|---|---|---|---|---|
| 1 | `z-ai` | keyless (always ready) | `z-ai` | zero signup, zero keys — the keyless floor |
| 2 | `groq` | keyed (`GROQ_API_KEY`) | `groq/llama-3.3-70b-versatile`, `groq/llama-3.1-8b-instant`, `groq/gemma2-9b-it` | ~30 rpm / ~14,400 rpd |
| 3 | `gemini` | keyed (`GEMINI_API_KEY`) | `gemini/gemini-2.0-flash`, `gemini/gemini-2.0-flash-lite` | ~15 rpm / ~1,500 rpd |
| 4 | `mistral` | keyed (`MISTRAL_API_KEY`) | `mistral/mistral-small-latest` | ~1 req/s, ~500k tpm |
| 5 | `openrouter` | keyed (`OPENROUTER_API_KEY`) | `openrouter/meta-llama/llama-3.3-70b-instruct:free`, `openrouter/deepseek/deepseek-r1:free`, `openrouter/google/gemini-2.0-flash-exp:free`, `openrouter/qwen/qwen3-32b:free` | ~20 rpm / ~50 rpd on `:free` |
| 6 | `ollama` | keyless local (readiness-probed) | `ollama/llama3.2` | local machine, no provider limits |

Details, signup URLs, docs URLs and the reachability note (verified 2026-10-04 sandbox) live in `providers.json`.

## Surface

| Route | Verb | Behavior |
|---|---|---|
| `/health` | GET | `{status, service, port, providers:[{id, ready, mode:"keyless"\|"keyed"\|"no-key", models, lastError?, circuit?}], law}` — circuit-open providers report `ready:true` + `circuit:"open"` |
| `/v1/models` | GET | OpenAI `list` — `z-ai` + every ready keyed provider's models (`groq/...`, `gemini/...`, `mistral/...`, `openrouter/...`), plus `ollama/...` when the local daemon answers |
| `/v1/chat/completions` | POST | `{model?, messages, stream?}` — non-stream JSON (root carries additive `provider` field) or word-chunk SSE with terminal `finish_reason:"stop"` + `data: [DONE]` |

### Routing & fallback

- Model with a known prefix (`groq/...`, `gemini/...`, `mistral/...`, `openrouter/...`, `ollama/...`) → that provider.
- Model omitted, `z-ai`, `auto`, or unknown → **first READY provider** in the priority order above.
- If the chosen/first provider fails → **automatic fallback** down the priority list; the response's `provider` field records who actually served. Retry is not needed — fallback *is* the retry.
- All providers exhausted → `502 {error:{type:"upstream_error", detail}}` — fail loud, no silent partials.

### Resilience

- Per-provider timeout via `AbortController`: 60s keyed/ollama, 30s z-ai.
- Circuit breaker per provider: 3 consecutive failures → open for 60s (skipped in routing, visible in `/health`).
- `ollama` readiness = 800ms probe of `GET {OLLAMA_HOST}/api/tags` — fail-soft; no ollama binary is required for this service to work.

## How to reach it (browser / frontend code)

Through the Caddy gateway lane — **relative URLs with the `?XTransformPort=3041` query, NEVER absolute URLs**:

```js
const res = await fetch('/v1/chat/completions?XTransformPort=3041', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'hello fleet' }] }),
});
```

`GET /health?XTransformPort=3041` and `GET /v1/models?XTransformPort=3041` work the same way.

## How the operator adds free keys

1. Get free keys (no payment):
   - Groq — https://console.groq.com/keys
   - Gemini (AI Studio) — https://aistudio.google.com/app/apikey
   - Mistral — https://console.mistral.ai/
   - OpenRouter — https://openrouter.ai/settings/keys
2. Create a `.env` file **in this folder**:
   ```
   GROQ_API_KEY=gsk_...
   GEMINI_API_KEY=AIza...
   MISTRAL_API_KEY=...
   OPENROUTER_API_KEY=sk-or-...
   ```
   (Real exported env vars take precedence over the file.)
3. Restart the service — those providers auto-ready (`mode:"keyed"`); everything else keeps working keyless. Providers without keys report `mode:"no-key"`, `ready:false` and are simply skipped by routing. **No keys present? The service is still fully functional via z-ai.**

## THE LAW

**Keys via env only — never logged, never returned.** No key material appears in any response, log line, error string or the worklog; every upstream error text is redacted against all known secret values before it is stored in memory or printed; the Gemini key rides the upstream URL which is never logged. There is no endpoint that returns configuration.

## Run

```bash
cd mini-services/sovereign-gateway
bun install
bun run dev          # :3041 — log lines: [sovereign-gateway] chat provider=... model=... stream=... out_chars=...
bun selftest.mjs     # PASS/FAIL lines, exit 0/1 — asserts health, models, and a REAL keyless completion
```
