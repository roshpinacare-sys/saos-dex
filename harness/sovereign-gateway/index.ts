/**
 * sovereign-gateway — multi-provider OpenAI-compatible LLM gateway (port 3041, fixed).
 *
 * Mission: maximal free LLM power for the fleet with ZERO signup today. The keyless
 * z-ai provider (via z-ai-web-dev-sdk, same verified pattern as the CR-0015/CR-0024
 * sibling shim on :3040 — which this service does NOT touch) is always first; free-tier
 * providers (groq/gemini/mistral/openrouter) auto-ready when the operator drops their
 * API keys into a .env file in this folder (or exports real env vars); ollama is
 * readiness-probed and fails soft.
 *
 * THE LAW (enforced in this artifact):
 *   - keys via env only — never logged, never returned, never written anywhere
 *   - every error string is redacted against all known secret values before it is
 *     logged or stored (lastError in /health is redacted too)
 *   - upstream failures after the full fallback chain → 502 {error:{type:"upstream_error"}}
 *     — fail loud, no silent partials
 *
 * Routing:
 *   - model with a known provider prefix ("groq/...", "gemini/...", "mistral/...",
 *     "openrouter/...", "ollama/...") → that provider
 *   - model omitted | "z-ai" | "auto" | unknown → first READY provider in priority
 *     order: z-ai, groq, gemini, mistral, openrouter, ollama
 *   - chosen provider fails → automatic fallback down the priority list
 *
 * Resilience:
 *   - per-provider timeout: 60s keyed/ollama, 30s z-ai (AbortController)
 *   - circuit breaker: 3 consecutive failures → open 60s (skipped in routing,
 *     reported in /health as ready:true + circuit:"open"); retry NOT needed —
 *     fallback IS the retry
 */
import ZAI from 'z-ai-web-dev-sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 3041; // fixed by spec — do NOT read the PORT env
const DIR = import.meta.dir;

// ---------- registry (providers.json ships with the artifact) ----------
interface FreeTier {
  rpm: number | null;
  rpd?: number | null;
  tpm?: number | null;
  notes: string;
}
interface RegistryProvider {
  id: string;
  signupUrl: string | null;
  keyEnvVar: string | null;
  hostEnvVar?: string;
  docsUrl: string | null;
  freeTier: FreeTier;
  models: string[];
  reachability: string;
  note?: string;
}
interface Registry {
  priority: string[];
  providers: RegistryProvider[];
  reachability: string;
}

function loadRegistry(): Registry {
  try {
    const raw = JSON.parse(readFileSync(join(DIR, 'providers.json'), 'utf8')) as Registry;
    if (!Array.isArray(raw?.providers) || raw.providers.length === 0 || !Array.isArray(raw?.priority)) {
      throw new Error('providers.json missing providers/priority');
    }
    return raw;
  } catch (err) {
    console.error(`[sovereign-gateway] FATAL: cannot load providers.json :: ${String((err as Error)?.message ?? err)}`);
    process.exit(1);
  }
}
const REGISTRY = loadRegistry();
const PRIORITY: string[] = REGISTRY.priority;
const BY_ID = new Map<string, RegistryProvider>(REGISTRY.providers.map((p) => [p.id, p]));
const PUBLIC_PREFIX = new Set(PRIORITY.filter((id) => id !== 'z-ai')); // ids usable as "pid/model" prefixes

// ---------- THE LAW: keys via env only ----------
/** Parse a .env file (KEY=VALUE lines, # comments, optional quotes) — no dotenv dependency. */
function parseEnvFile(path: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
        v = v.slice(1, -1);
      }
      if (k && v) map.set(k, v);
    }
  } catch {
    /* no .env — the service still works fully keyless via z-ai */
  }
  return map;
}
const FILE_ENV = parseEnvFile(join(DIR, '.env'));
function secret(name: string): string {
  const v = process.env[name] ?? FILE_ENV.get(name) ?? '';
  return v.trim();
}
const KEY_ENV_VARS = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY', 'OPENROUTER_API_KEY'];
function knownSecrets(): string[] {
  return KEY_ENV_VARS.map((k) => secret(k)).filter((v) => v.length > 0);
}
/** Redact every known secret value out of an arbitrary string before it is logged/stored. */
function redact(text: string): string {
  let out = String(text ?? '');
  for (const s of knownSecrets()) out = out.split(s).join('[redacted]');
  return out;
}

// ---------- provider runtime state (in-memory only) ----------
type Mode = 'keyless' | 'keyed' | 'no-key';
interface ProviderState {
  id: string;
  failures: number;
  openUntil: number; // circuit breaker: > now ⇒ open
  lastError?: string; // redacted
}
const STATE = new Map<string, ProviderState>(PRIORITY.map((id) => [id, { id, failures: 0, openUntil: 0 }]));
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 60_000;

function circuitOpen(id: string): boolean {
  const s = STATE.get(id);
  return !!s && s.openUntil > Date.now();
}
function noteSuccess(id: string): void {
  const s = STATE.get(id);
  if (s) {
    s.failures = 0;
    s.openUntil = 0;
  }
}
function noteFailure(id: string, err: unknown): void {
  const s = STATE.get(id);
  if (!s) return;
  s.failures += 1;
  s.lastError = redact(String((err as Error)?.message ?? err ?? 'unknown error')).slice(0, 300);
  if (s.failures >= CIRCUIT_THRESHOLD) s.openUntil = Date.now() + CIRCUIT_OPEN_MS;
}
function modeOf(id: string): Mode {
  if (id === 'z-ai') return 'keyless';
  if (id === 'ollama') return 'keyless';
  const p = BY_ID.get(id);
  return p?.keyEnvVar && secret(p.keyEnvVar) !== '' ? 'keyed' : 'no-key';
}
function keyReady(id: string): boolean {
  if (id === 'z-ai') return true;
  if (id === 'ollama') return ollamaOk;
  const p = BY_ID.get(id);
  return !!p?.keyEnvVar && secret(p.keyEnvVar) !== '';
}

// ---------- ollama readiness (800ms probe, fail-soft) ----------
function ollamaBase(): string {
  const raw = process.env.OLLAMA_HOST ?? FILE_ENV.get('OLLAMA_HOST') ?? 'http://127.0.0.1:11434';
  return raw.replace(/\/+$/, '');
}
let ollamaOk = false;
let ollamaProbed = false;
async function probeOllama(): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 800);
  try {
    const res = await fetch(`${ollamaBase()}/api/tags`, { signal: ac.signal });
    ollamaOk = res.ok;
  } catch {
    ollamaOk = false;
  } finally {
    clearTimeout(timer);
    ollamaProbed = true;
  }
  return ollamaOk;
}

// ---------- messages ----------
interface Msg {
  role: string;
  content: string;
}
function toMsgs(input: unknown): Msg[] {
  const out: Msg[] = [];
  for (const m of (Array.isArray(input) ? input : []) as Array<{ role?: unknown; content?: unknown }>) {
    const role = String(m?.role ?? 'user').toLowerCase();
    const content = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
    out.push({ role, content });
  }
  return out;
}
/** Map OpenAI-style messages onto the z-ai SDK surface (same pattern as the shim). */
function mapZaiMessages(messages: Msg[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') out.push({ role: 'assistant', content: m.content });
    else if (m.role === 'assistant' || m.role === 'user') out.push({ role: m.role, content: m.content });
    else out.push({ role: 'user', content: m.content });
  }
  if (out.length === 0) out.push({ role: 'user', content: '' });
  return out;
}

// ---------- z-ai keyless adapter (SDK boundary — the one place `any` is allowed) ----------
let zaiPromise: Promise<any> | null = null;
function zai(): Promise<any> {
  if (!zaiPromise) zaiPromise = ZAI.create();
  return zaiPromise;
}
function deadline(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const onAbort = () => reject(new Error(`timeout after ${TIMEOUT_ZAI_MS}ms (z-ai deadline)`));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------- timeouts ----------
const TIMEOUT_KEYED_MS = 60_000;
const TIMEOUT_ZAI_MS = 30_000;
interface TimeoutHandle {
  signal: AbortSignal;
  clear: () => void;
}
function withTimeout(ms: number): TimeoutHandle {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(timer) };
}
async function timedFetch(url: string, init: RequestInit, ms: number): Promise<Response> {
  const t = withTimeout(ms);
  try {
    return await fetch(url, { ...init, signal: t.signal });
  } finally {
    t.clear();
  }
}

// ---------- upstream adapters (fetch-based, no SDKs) ----------
async function callZai(messages: Msg[], _model: string | null): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_ZAI_MS);
  try {
    const z = await zai(); // SDK takes no signal — enforce the deadline by racing
    const completion = await Promise.race([
      z.chat.completions.create({ messages: mapZaiMessages(messages), thinking: { type: 'disabled' } }),
      deadline(ac.signal),
    ]);
    const content: unknown = completion?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) throw new Error('z-ai: empty completion');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

interface OpenAiCompatTarget {
  url: string;
  envVar: string;
}
const OPENAI_COMPAT: Record<string, OpenAiCompatTarget> = {
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', envVar: 'GROQ_API_KEY' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', envVar: 'OPENROUTER_API_KEY' },
  mistral: { url: 'https://api.mistral.ai/v1/chat/completions', envVar: 'MISTRAL_API_KEY' },
};

async function callOpenAiCompat(id: string, model: string, messages: Msg[]): Promise<string> {
  const target = OPENAI_COMPAT[id];
  if (!target) throw new Error(`${id}: no adapter`);
  const key = secret(target.envVar);
  if (!key) throw new Error(`${id}: no key (mode no-key)`);
  const res = await timedFetch(
    target.url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: messages.map((m) => ({ role: m.role, content: m.content })), stream: false }),
    },
    TIMEOUT_KEYED_MS,
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`${id}: HTTP ${res.status} ${text.slice(0, 200)}`);
  let data: { choices?: Array<{ message?: { content?: unknown } }> };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    throw new Error(`${id}: non-JSON upstream response`);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) throw new Error(`${id}: empty completion`);
  return content;
}

async function callGemini(model: string, messages: Msg[]): Promise<string> {
  const key = secret('GEMINI_API_KEY');
  if (!key) throw new Error('gemini: no key (mode no-key)');
  const system = messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => m.content).join('\n');
  const contents = messages
    .filter((m) => m.role !== 'system' && m.role !== 'developer')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  if (contents.length === 0) contents.push({ role: 'user', parts: [{ text: '' }] });
  const body: Record<string, unknown> = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  // THE LAW: the key rides the query string — this URL is NEVER logged (all logging is redacted + URL-free)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await timedFetch(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    TIMEOUT_KEYED_MS,
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`gemini: HTTP ${res.status} ${redact(text).slice(0, 200)}`);
  let data: { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    throw new Error('gemini: non-JSON upstream response');
  }
  const out = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('');
  if (!out) throw new Error('gemini: empty completion');
  return out;
}

async function callOllama(model: string, messages: Msg[]): Promise<string> {
  const res = await timedFetch(
    `${ollamaBase()}/api/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: messages.map((m) => ({ role: m.role, content: m.content })), stream: false }),
    },
    TIMEOUT_KEYED_MS,
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`ollama: HTTP ${res.status} ${text.slice(0, 200)}`);
  let data: { message?: { content?: unknown } };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    throw new Error('ollama: non-JSON upstream response');
  }
  const content = data?.message?.content;
  if (typeof content !== 'string' || content.length === 0) throw new Error('ollama: empty completion');
  return content;
}

async function callProvider(id: string, model: string | null, messages: Msg[]): Promise<string> {
  const fallbackModel = BY_ID.get(id)?.models[0] ?? null;
  const m = model ?? fallbackModel;
  switch (id) {
    case 'z-ai':
      return callZai(messages, m);
    case 'gemini':
      return callGemini(m ?? 'gemini-2.0-flash', messages);
    case 'ollama':
      return callOllama(m ?? 'llama3.2', messages);
    default:
      if (OPENAI_COMPAT[id]) return callOpenAiCompat(id, m ?? '', messages);
      throw new Error(`${id}: unknown provider`);
  }
}

// ---------- routing ----------
function routingReady(id: string): boolean {
  if (circuitOpen(id)) return false;
  return keyReady(id);
}
function publicModelIds(id: string): string[] {
  const p = BY_ID.get(id);
  if (!p) return [];
  return p.models.map((m) => (id === 'z-ai' ? 'z-ai' : `${id}/${m}`));
}
/** Resolve "groq/llama-3.3-70b-versatile" → {provider:"groq", upstream:"llama-3.3-70b-versatile"}. */
function parseModel(model: string | null | undefined): { provider: string | null; upstream: string | null } {
  if (!model) return { provider: null, upstream: null };
  const idx = model.indexOf('/');
  if (idx > 0) {
    const head = model.slice(0, idx);
    if (PUBLIC_PREFIX.has(head)) return { provider: head, upstream: model.slice(idx + 1) };
  }
  return { provider: null, upstream: null };
}
/** Ordered provider chain: explicit provider first (if any), then the rest of the ready priority list. */
function chain(explicit: string | null): string[] {
  const ready = PRIORITY.filter((id) => routingReady(id));
  if (explicit && ready.includes(explicit)) return [explicit, ...ready.filter((id) => id !== explicit)];
  return ready;
}

// ---------- OpenAI response helpers ----------
function estimateTokens(text: string): number {
  return Math.ceil((text ?? '').length / 4);
}
function completionId(): string {
  return `chatcmpl-${crypto.randomUUID()}`;
}
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'Access-Control-Allow-Origin': '*',
};

// ---------- server ----------
const server = Bun.serve({
  port: PORT,
  hostname: '::', // dual-stack: IPv4 + IPv6 (localhost may resolve to ::1)
  idleTimeout: 240,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/health') {
      await probeOllama(); // fresh probe per health check (800ms cap)
      const providers = PRIORITY.map((id) => {
        const s = STATE.get(id)!;
        const entry: Record<string, unknown> = {
          id,
          ready: keyReady(id),
          mode: modeOf(id),
          models: publicModelIds(id),
        };
        if (s.lastError) entry.lastError = s.lastError;
        if (circuitOpen(id)) entry.circuit = 'open';
        return entry;
      });
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'sovereign-gateway',
          port: PORT,
          providers,
          law: 'keys via env only — never logged, never returned',
        }),
        { headers: JSON_HEADERS },
      );
    }

    if (req.method === 'GET' && path === '/v1/models') {
      const data = PRIORITY.filter((id) => keyReady(id)).flatMap((id) =>
        publicModelIds(id).map((mid) => ({
          id: mid,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: `sovereign-gateway:${id}`,
        })),
      );
      return new Response(JSON.stringify({ object: 'list', data }), { headers: JSON_HEADERS });
    }

    if (req.method === 'POST' && path === '/v1/chat/completions') {
      let body: { model?: unknown; messages?: unknown; stream?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return new Response(
          JSON.stringify({ error: { message: 'invalid JSON body', type: 'invalid_request_error' } }),
          { status: 400, headers: JSON_HEADERS },
        );
      }
      const messages = toMsgs(body?.messages);
      if (messages.length === 0) {
        return new Response(
          JSON.stringify({ error: { message: 'messages: non-empty array required', type: 'invalid_request_error' } }),
          { status: 400, headers: JSON_HEADERS },
        );
      }
      const requestedModel = typeof body?.model === 'string' && body.model ? body.model : 'z-ai';
      const stream = body?.stream === true;
      const { provider: explicit, upstream } = parseModel(requestedModel);
      const promptChars = messages.reduce((a, m) => a + (m.content?.length ?? 0), 0);

      let served: string | null = null;
      let content = '';
      const failures: string[] = [];
      for (const id of chain(explicit)) {
        try {
          content = await callProvider(id, explicit ? upstream : null, messages);
          noteSuccess(id);
          served = id;
          break;
        } catch (err) {
          noteFailure(id, err);
          failures.push(`${id}: ${redact(String((err as Error)?.message ?? err)).slice(0, 200)}`);
        }
      }

      if (!served) {
        console.error(`[sovereign-gateway] upstream_error model=${requestedModel} msgs=${messages.length} attempts=${failures.length}`);
        return new Response(
          JSON.stringify({ error: { type: 'upstream_error', detail: failures.join(' | ') || 'no ready provider' } }),
          { status: 502, headers: JSON_HEADERS },
        );
      }

      console.log(
        `[sovereign-gateway] chat provider=${served} model=${requestedModel} msgs=${messages.length} stream=${stream} out_chars=${content.length}${failures.length ? ` fallbacks=${failures.length}` : ''}`,
      );

      if (!stream) {
        return new Response(
          JSON.stringify({
            id: completionId(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: requestedModel,
            provider: served,
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: estimateTokens(String(promptChars)),
              completion_tokens: estimateTokens(content),
              total_tokens: estimateTokens(String(promptChars)) + estimateTokens(content),
              note: 'estimates (~4 chars/token), not provider metering',
            },
          }),
          { headers: JSON_HEADERS },
        );
      }

      // SSE: identical text delivered as word-chunks, terminal finish_reason + [DONE]
      const chunks = content.length ? content.match(/\S+\s*/g) ?? [content] : [''];
      const created = Math.floor(Date.now() / 1000);
      const id = completionId();
      const enc = new TextEncoder();
      const bodyStream = new ReadableStream({
        start(controller) {
          for (const piece of chunks) {
            const evt = {
              id,
              object: 'chat.completion.chunk',
              created,
              model: requestedModel,
              provider: served,
              choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
            };
            controller.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`));
          }
          const final = {
            id,
            object: 'chat.completion.chunk',
            created,
            model: requestedModel,
            provider: served,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: estimateTokens(String(promptChars)),
              completion_tokens: estimateTokens(content),
              total_tokens: estimateTokens(String(promptChars)) + estimateTokens(content),
              note: 'estimates (~4 chars/token), not provider metering',
            },
          };
          controller.enqueue(enc.encode(`data: ${JSON.stringify(final)}\n\n`));
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(bodyStream, { headers: SSE_HEADERS });
    }

    return new Response(
      JSON.stringify({ error: { message: `no route: ${req.method} ${path}`, type: 'invalid_request_error' } }),
      { status: 404, headers: JSON_HEADERS },
    );
  },
});

void probeOllama(); // initial fail-soft probe (fire and forget)

const bootLine = PRIORITY.map((id) => `${id}(${modeOf(id)}${circuitOpen(id) ? ',circuit-open' : ''})`).join(' ');
console.log(`[sovereign-gateway] listening on :${server.port} — priority ${bootLine} | law: keys via env only — never logged, never returned`);
