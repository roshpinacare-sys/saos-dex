/**
 * llm-selftest.mjs — שער-ברזל לגשר-ה-LLM של הצי (Z-85).
 * כללי-אינווריאנטה: רישום-תקין, fail-closed ללא-מפתחות, סדר-עדיפות,
 * fallback, timeout, צורות-בקשה לפי סגנון-ספק, חוק-ההשתקה, ניתוב-מודל,
 * CLI HOLD. אפס-תלות; רץ על node טהור ב-runner ובסנדבוקס.
 */

import { PROVIDERS, keyedProviders, resolveModel, redact, REDACTED } from './llm-providers.mjs';
import { callLLM, buildRequest, extractContent, cliMain } from './llm-call.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS — ${name}`);
  } else {
    fail++;
    failures.push({ name, detail });
    console.error(`FAIL — ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

const ENV = {
  GROQ_API_KEY: 'FAKE-GROQ-KEY-FOR-REDACTION-TEST-0123456789abcdef',
  GEMINI_API_KEY: 'FAKE-GEMINI-KEY-FOR-REDACTION-TEST-0123456789abcdef',
  MISTRAL_API_KEY: '',
  OPENROUTER_API_KEY: '',
};

function okFetch(status, body) {
  return async () => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
}

const OPENAI_OK = { choices: [{ message: { role: 'assistant', content: 'BRIDGE-OK' } }] };
const GEMINI_OK = { candidates: [{ content: { parts: [{ text: 'BRIDGE' }, { text: '-OK' }] } }] };

async function main() {
  // 1-2: רישום-תקין וללא-חומר-מפתח
  const ids = PROVIDERS.map((p) => p.id);
  check('registry: ids unique & ordered', JSON.stringify(ids) === JSON.stringify(['groq', 'gemini', 'mistral', 'openrouter']));
  check(
    'registry: every entry complete (envVar/endpoint/style/models/signup)',
    PROVIDERS.every((p) => p.envVar?.endsWith('_API_KEY') && p.endpoint?.startsWith('https://') && ['openai', 'gemini'].includes(p.style) && Array.isArray(p.models) && p.models.length > 0 && p.signup?.startsWith('https://'))
  );
  const blob = JSON.stringify(PROVIDERS);
  check('registry: no key-like material', !/sk-|ghp_|github_pat_/.test(blob));

  // 3: keyedProviders
  check('keyedProviders: empty env → none', keyedProviders({}, PROVIDERS).length === 0);
  check('keyedProviders: two armed → priority order', JSON.stringify(keyedProviders(ENV, PROVIDERS).map((p) => p.id)) === JSON.stringify(['groq', 'gemini']));

  // 4: resolveModel
  const rm = resolveModel('groq/llama-3.3-70b-versatile', PROVIDERS);
  check('resolveModel: prefix routes & strips', rm?.provider?.id === 'groq' && rm?.model === 'llama-3.3-70b-versatile');
  check('resolveModel: unknown prefix → null', resolveModel('nosuch/x', PROVIDERS) === null);
  check('resolveModel: bare model → null', resolveModel('llama-3.3-70b-versatile', PROVIDERS) === null);

  const MESSAGES = [{ role: 'system', content: 'be exact' }, { role: 'user', content: 'say BRIDGE-OK' }];

  // 5: אין-מפתחות → HOLD עם אפס-קריאות-רשת (fail-closed)
  let netCalls = 0;
  let held = null;
  try {
    await callLLM({ messages: MESSAGES, env: {}, fetchImpl: async () => { netCalls++; return okFetch(200, OPENAI_OK)(); } });
  } catch (e) {
    held = e?.message ?? '';
  }
  check('no-key: LLM-HOLD thrown', held?.startsWith('LLM-HOLD') === true, held);
  check('no-key: zero network attempts (fail-closed)', netCalls === 0, String(netCalls));

  // 6: סדר-עדיפות + fallback (ראשון 500 → שני מנצח)
  const order = [];
  const seqFetch = async (url) => {
    order.push(String(url));
    if (order.length === 1) return { ok: false, status: 500, text: async () => 'upstream boom' };
    return { ok: true, status: 200, text: async () => JSON.stringify(GEMINI_OK) };
  };
  const r6 = await callLLM({ messages: MESSAGES, env: ENV, fetchImpl: seqFetch });
  check('fallback: second provider serves after first 500', r6.provider === 'gemini' && r6.content === 'BRIDGE-OK');
  check('fallback: attempts recorded in priority order', order.length === 2 && order[0].includes('api.groq.com') && order[1].includes('generativelanguage.googleapis.com'));

  // 7: ראשון-מנצח (השני לא-נקרא)
  let secondCalled = false;
  const r7 = await callLLM({
    messages: MESSAGES,
    env: ENV,
    fetchImpl: async (url) => {
      if (String(url).includes('googleapis')) secondCalled = true;
      return { ok: true, status: 200, text: async () => JSON.stringify(OPENAI_OK) };
    },
  });
  check('first-success-wins: groq serves, gemini untouched', r7.provider === 'groq' && secondCalled === false);

  // 8: timeout → AbortError → ספק-הבא
  const slowFetch = async (url, init) => {
    if (String(url).includes('api.groq.com')) {
      await new Promise((res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(GEMINI_OK) };
  };
  const r8 = await callLLM({ messages: MESSAGES, env: ENV, fetchImpl: slowFetch, timeoutMs: 80 });
  check('timeout: abort falls through to next provider', r8.provider === 'gemini');

  // 9: צורת-openai
  const b9 = buildRequest(PROVIDERS[0], 'llama-3.3-70b-versatile', MESSAGES, 'K9');
  check('openai shape: bearer + model + messages', b9.init.headers.Authorization === 'Bearer K9' && JSON.parse(b9.init.body).model === 'llama-3.3-70b-versatile' && Array.isArray(JSON.parse(b9.init.body).messages));

  // 10-11: צורת-gemini + חילוץ
  const b10 = buildRequest(PROVIDERS[1], 'gemini-2.0-flash', MESSAGES, 'K10');
  const body10 = JSON.parse(b10.init.body);
  check('gemini shape: endpoint, header, contents, systemInstruction', b10.url.endsWith('/models/gemini-2.0-flash:generateContent') && b10.init.headers['x-goog-api-key'] === 'K10' && body10.contents[0].role === 'user' && body10.systemInstruction?.parts?.[0]?.text === 'be exact');
  check('gemini extraction: parts joined', extractContent('gemini', GEMINI_OK) === 'BRIDGE-OK');

  // 12: ניתוב-מודל כופה ספק; מפתח-חסר → HOLD שמזכיר את שם-ה-env
  let openrouterCalled = false;
  const r12 = await callLLM({
    messages: MESSAGES,
    model: 'groq/llama-3.3-70b-versatile',
    env: ENV,
    fetchImpl: async (url) => {
      if (String(url).includes('openrouter')) openrouterCalled = true;
      return { ok: true, status: 200, text: async () => JSON.stringify(OPENAI_OK) };
    },
  });
  check('model-prefix: forced provider serves, others untouched', r12.provider === 'groq' && openrouterCalled === false);
  let heldEnvName = '';
  try {
    await callLLM({ messages: MESSAGES, model: 'openrouter/qwen/qwen3-32b:free', env: ENV, fetchImpl: okFetch(200, OPENAI_OK) });
  } catch (e) {
    heldEnvName = e?.message ?? '';
  }
  check('model-prefix: unarmed provider → HOLD names its env var', heldEnvName.includes('LLM-HOLD') && heldEnvName.includes('OPENROUTER_API_KEY'), heldEnvName.slice(0, 80));

  // 13: חוק-ההשתקה — הספק מחזיר את המפתח בשגיאה → הפלט מושתק
  let held13 = '';
  try {
    await callLLM({
      messages: MESSAGES,
      env: ENV,
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => `denied: key ${ENV.GROQ_API_KEY} is invalid` }),
    });
  } catch (e) {
    held13 = e?.message ?? '';
  }
  check('redaction: raw key never in output, [REDACTED] present', held13.includes(REDACTED) && !held13.includes(ENV.GROQ_API_KEY), held13.slice(0, 60));
  check('redaction: redact() standalone', redact(`x ${ENV.GEMINI_API_KEY} y`, ENV).includes(REDACTED) && !redact(`x ${ENV.GEMINI_API_KEY} y`, ENV).includes(ENV.GEMINI_API_KEY));

  // 14-15: תוכן-ריק / תשובה-לא-JSON → כישלון-כן ומעבר-ספק
  const r14 = await callLLM({
    messages: MESSAGES,
    env: ENV,
    fetchImpl: (url) => (String(url).includes('api.groq.com') ? { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '' } }] }) } : { ok: true, status: 200, text: async () => JSON.stringify(GEMINI_OK) }),
  });
  check('empty-content: treated as failure, next provider serves', r14.provider === 'gemini');
  const r15 = await callLLM({
    messages: MESSAGES,
    env: ENV,
    fetchImpl: (url) => (String(url).includes('api.groq.com') ? { ok: true, status: 200, text: async () => '<html>not json</html>' } : { ok: true, status: 200, text: async () => JSON.stringify(GEMINI_OK) }),
  });
  check('non-json: treated as failure, next provider serves', r15.provider === 'gemini');

  // 16: CLI ללא-מפתחות → exit 2 עם hold JSON (subprocess אמיתי)
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileP = promisify(execFile);
  let cliOk = false;
  let cliJson = null;
  try {
    await execFileP(process.execPath, ['grids/llm/llm-call.mjs', '--prompt', 'hi'], { cwd: process.cwd(), env: {} });
  } catch (e) {
    cliOk = e.code === 2;
    try {
      cliJson = JSON.parse(e.stdout);
    } catch {}
  }
  check('CLI: no-key run exits 2 with LLM-HOLD json', cliOk && cliJson?.hold === 'LLM-HOLD' && cliJson?.ok === false);

  console.log(`\nSELFTEST ${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} rules green`);
  if (fail > 0) {
    console.error(JSON.stringify(failures, null, 2));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`SELFTEST CRASH :: ${redact(e?.message ?? e)}`);
  process.exit(1);
});
