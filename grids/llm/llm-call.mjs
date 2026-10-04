/**
 * llm-call.mjs — גשר-ה-LLM של הצי (Z-85): קריאה אחת, ניתוב-מדורג, HOLD כן.
 *
 * אפס-תלויות (node ≥ 20, fetch מובנה) — רץ זהה ב-runner של GitHub Actions
 * ובכל-מכונה. זהו ה-LLM-של-הצי: לא סוכן-הסשן (הוא כלי-ידני שנמחק עם
 * הסנדבוקס), אלא הקוד הזה + סודות-GitHub + CI — החיים-עצמאיים של הרשת.
 *
 * שימוש-מודולי:
 *   import { callLLM } from './llm-call.mjs';
 *   const r = await callLLM({ messages: [{ role: 'user', content: 'hi' }] });
 *   // r = { content, provider, model, attempts }
 *   // כישלון-כולל/אין-מפתחות → throws Error עם הודעה המתחילה ב-LLM-HOLD
 *
 * שימוש-CLI:
 *   node llm-call.mjs --prompt "reply exactly: BRIDGE-OK" [--model groq/llama-3.3-70b-versatile]
 *   → פלט JSON יחיד; אין-הצלחה → exit 2 עם {"ok":false,"hold":"LLM-HOLD",...}
 *
 * חוקים: מפתחות רק מ-env; כל-שגיאה עוברת redact (אף-מפתח בשום-פלט);
 * timeout לכל-ספק; סדר-עדיפות לפי PROVIDERS; מודל-מקודם מכתיב ספק.
 */

import { PROVIDERS, keyedProviders, resolveModel, redact, REDACTED } from './llm-providers.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** בניית-בקשה לפי סגנון-הספק (openai | gemini). */
export function buildRequest(provider, model, messages, key) {
  if (!provider || !provider.endpoint || !provider.style) {
    throw new Error('bad-provider-entry');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('no-messages');
  }
  if (provider.style === 'openai') {
    return {
      url: provider.endpoint,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ model, messages, stream: false }),
      },
    };
  }
  if (provider.style === 'gemini') {
    const system = messages
      .filter((m) => (m?.role ?? '') === 'system')
      .map((m) => String(m?.content ?? ''))
      .filter((s) => s.length > 0);
    const contents = messages
      .filter((m) => m?.role === 'user' || m?.role === 'assistant')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m?.content ?? '') }] }));
    const body = { contents };
    if (system.length > 0) body.systemInstruction = { parts: [{ text: system.join('\n') }] };
    return {
      url: `${provider.endpoint}/${encodeURIComponent(model)}:generateContent`,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
        body: JSON.stringify(body),
      },
    };
  }
  throw new Error(`unknown-provider-style:${provider.style}`);
}

/** חילוץ-התוכן מתשובת-ספק לפי סגנון. */
export function extractContent(style, payload) {
  if (style === 'openai') {
    const c = payload?.choices?.[0]?.message?.content;
    return typeof c === 'string' ? c : '';
  }
  if (style === 'gemini') {
    const parts = payload?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map((p) => String(p?.text ?? '')).join('');
  }
  return '';
}

/**
 * הקריאה-הריבונית: מנסה ספקים-חמושים לפי-סדר (או ספק-כפוי מניתוב-מודל),
 * ראשון-שמצליח מנצח, כל-כישלון נרשם-ומושתק.
 */
export async function callLLM(opts) {
  const o = opts ?? {};
  const env = o.env ?? process.env;
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
  const messages = o.messages;
  const routed = resolveModel(o.model, o.providers ?? PROVIDERS);

  const attempts = [];
  const noteAttempt = (providerId, model, status, error) => {
    attempts.push({ provider: providerId, model, status: status ?? null, error: redact(String(error ?? ''), env) });
  };

  let chain;
  if (routed) {
    const key = env?.[routed.provider.envVar];
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(`LLM-HOLD: provider ${routed.provider.id} requested via model prefix but its env ${routed.provider.envVar} is not armed`);
    }
    chain = [{ provider: routed.provider, model: routed.model }];
  } else {
    chain = keyedProviders(env, o.providers ?? PROVIDERS).map((p) => ({
      provider: p,
      model: o.pickModel ?? p.models[0],
    }));
  }

  if (chain.length === 0) {
    throw new Error('LLM-HOLD: no providers armed — set GROQ_API_KEY / GEMINI_API_KEY / MISTRAL_API_KEY / OPENROUTER_API_KEY (GitHub secrets or env). Fail-closed by law.');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('LLM-HOLD: no-messages');
  }

  for (const step of chain) {
    const { provider, model } = step;
    const key = env?.[provider.envVar] ?? '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const { url, init } = buildRequest(provider, model, messages, key);
      const res = await fetchImpl(url, { ...init, signal: controller.signal });
      const text = await res.text();
      if (!res.ok) {
        noteAttempt(provider.id, model, res.status, text.slice(0, 400));
        continue;
      }
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        noteAttempt(provider.id, model, res.status, 'non-json-upstream-response');
        continue;
      }
      const content = extractContent(provider.style, payload);
      if (typeof content !== 'string' || content.length === 0) {
        noteAttempt(provider.id, model, res.status, 'empty-content-upstream');
        continue;
      }
      return { content, provider: provider.id, model, attempts, redacted: REDACTED };
    } catch (err) {
      const msg = err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err?.message ?? String(err);
      noteAttempt(provider.id, model, null, msg);
      if (err?.name !== 'AbortError') {
        // שגיאת-רשת-קשה → המשך לספק-הבא; backoff קצר כדי-לא-להציף
        await sleep(150);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`LLM-HOLD: all armed providers failed :: ${JSON.stringify(attempts)}`);
}

// ---- CLI
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prompt') out.prompt = argv[++i] ?? '';
    else if (a === '--model') out.model = argv[++i] ?? '';
    else if (a === '--messages-file') out.messagesFile = argv[++i] ?? '';
    else if (a === '--timeout-ms') out.timeoutMs = Number(argv[++i] ?? '');
  }
  return out;
}

export async function cliMain(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let messages = null;
  if (args.messagesFile) {
    const fs = await import('node:fs');
    messages = JSON.parse(fs.readFileSync(args.messagesFile, 'utf8'));
  } else if (args.prompt) {
    messages = [{ role: 'user', content: args.prompt }];
  }
  try {
    const r = await callLLM({ messages, model: args.model || undefined, timeoutMs: args.timeoutMs || undefined });
    process.stdout.write(`${JSON.stringify({ ok: true, provider: r.provider, model: r.model, content: r.content, attempts: r.attempts }, null, 2)}\n`);
    return 0;
  } catch (err) {
    const msg = redact(err?.message ?? String(err));
    const hold = msg.startsWith('LLM-HOLD');
    let attempts;
    try {
      attempts = JSON.parse(msg.slice(msg.indexOf('::') + 2).trim());
    } catch {
      attempts = undefined;
    }
    process.stdout.write(`${JSON.stringify({ ok: false, hold: hold ? 'LLM-HOLD' : 'ERROR', note: hold ? msg.slice(0, msg.indexOf('::')).trim() : msg, attempts }, null, 2)}\n`);
    return hold ? 2 : 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`${redact(e?.message ?? e)}\n`);
    process.exit(1);
  });
}
