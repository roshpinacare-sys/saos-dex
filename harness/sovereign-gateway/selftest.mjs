#!/usr/bin/env bun
/**
 * sovereign-gateway selftest — no test frameworks, plain fetch, PASS/FAIL lines, exit 0/1.
 *
 * Checks:
 *   1. /health — status ok, ≥1 ready provider, service identity, law line,
 *      and NO key material anywhere in the JSON (values from .env/process env,
 *      plus generic secret patterns).
 *   2. /v1/models — OpenAI list shape, contains "z-ai", no key material.
 *   3. REAL keyless chat completion through the gateway (model "z-ai") —
 *      content contains "OK", response carries a provider field, no key material.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const BASE = 'http://127.0.0.1:3041';
const DIR = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name, cond, extra = '') {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${extra ? ` :: ${extra}` : ''}`);
  if (!ok) failures += 1;
}

/** Collect any secret values that must never appear in service output. */
function secretValues() {
  const vals = [];
  for (const name of ['GROQ_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY', 'OPENROUTER_API_KEY']) {
    const v = String(process.env[name] ?? '').trim();
    if (v) vals.push(v);
  }
  const envPath = join(DIR, '.env');
  if (existsSync(envPath)) {
    try {
      for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq <= 0) continue;
        const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (v) vals.push(v);
      }
    } catch { /* ignore */ }
  }
  return vals;
}
function noKeyMaterial(text) {
  for (const v of secretValues()) if (v && text.includes(v)) return false;
  if (/sk-[A-Za-z0-9_-]{20,}/.test(text)) return false; // generic secret shape
  if (/gsk_[A-Za-z0-9_-]{20,}/.test(text)) return false; // groq key shape
  if (/AIza[A-Za-z0-9_-]{30,}/.test(text)) return false; // google key shape
  return true;
}
function withTimeout(ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, done: () => clearTimeout(timer) };
}

async function main() {
  console.log(`sovereign-gateway selftest → ${BASE}`);

  // ---- 1. /health
  let health = null;
  try {
    const t = withTimeout(15_000);
    const res = await fetch(`${BASE}/health`, { signal: t.signal });
    t.done();
    health = await res.json();
    check('health: HTTP reachable', res.ok);
  } catch (e) {
    check('health: HTTP reachable', false, String(e?.message ?? e));
  }
  if (health) {
    const text = JSON.stringify(health);
    check('health: status ok', health.status === 'ok');
    check('health: service is sovereign-gateway', health.service === 'sovereign-gateway');
    check('health: port 3041', health.port === 3041);
    check('health: law declared', typeof health.law === 'string' && health.law.includes('never logged'));
    check('health: providers array present', Array.isArray(health.providers) && health.providers.length >= 5);
    check('health: at least one ready provider', Array.isArray(health.providers) && health.providers.some((p) => p.ready === true));
    check('health: z-ai first and ready keyless', health.providers?.[0]?.id === 'z-ai' && health.providers[0].ready === true && health.providers[0].mode === 'keyless');
    check('health: no key material in JSON', noKeyMaterial(text));
    check('health: no apiKey-like fields', !/"?(api[_-]?key|authorization|bearer)"?\s*:/i.test(text));
  }

  // ---- 2. /v1/models
  let models = null;
  try {
    const t = withTimeout(15_000);
    const res = await fetch(`${BASE}/v1/models`, { signal: t.signal });
    t.done();
    models = await res.json();
    check('models: HTTP reachable', res.ok);
  } catch (e) {
    check('models: HTTP reachable', false, String(e?.message ?? e));
  }
  if (models) {
    const text = JSON.stringify(models);
    check('models: OpenAI list shape', models.object === 'list' && Array.isArray(models.data));
    check('models: contains z-ai', Array.isArray(models.data) && models.data.some((m) => m.id === 'z-ai'));
    check('models: ids are strings', Array.isArray(models.data) && models.data.every((m) => typeof m.id === 'string' && m.id.length > 0));
    check('models: no key material in JSON', noKeyMaterial(text));
  }

  // ---- 3. REAL keyless chat completion
  let chat = null;
  try {
    const t = withTimeout(120_000);
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: t.signal,
      body: JSON.stringify({
        model: 'z-ai',
        messages: [{ role: 'user', content: 'Reply with exactly: SOVEREIGN-GATEWAY-OK' }],
      }),
    });
    t.done();
    chat = await res.json();
    check('chat: HTTP 200', res.ok, res.ok ? '' : JSON.stringify(chat).slice(0, 200));
  } catch (e) {
    check('chat: HTTP 200', false, String(e?.message ?? e));
  }
  if (chat) {
    const text = JSON.stringify(chat);
    const content = chat?.choices?.[0]?.message?.content;
    check('chat: OpenAI completion shape', chat.object === 'chat.completion' && chat?.choices?.[0]?.message?.role === 'assistant');
    check('chat: content contains OK', typeof content === 'string' && content.includes('OK'), typeof content === 'string' ? content.slice(0, 120) : '(no content)');
    check('chat: provider field present', typeof chat.provider === 'string' && chat.provider.length > 0, `provider=${chat.provider}`);
    check('chat: no key material in JSON', noKeyMaterial(text));
  }

  const total = (failures === 0 ? 'PASS' : 'FAIL');
  console.log(`SELFTEST ${total} (${failures} failed check${failures === 1 ? '' : 's'})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL — selftest crashed ::', String(e?.message ?? e));
  process.exit(1);
});
