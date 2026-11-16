/**
 * llm-providers.mjs — רישום-ספקי-ה-LLM החינמיים של הצי (Z-85).
 *
 * החוק-הריבוני: הכוח-האמיתי של הצי חי ב-GitHub Actions (רץ 24/7 בלי תלות
 * בסנדבוקס-סשן). המפתחות מגיעים רק מ-env (סודות-GitHub מוצפנים) — אף מפתח
 * לא נכתב בקוד, בלוג, קבלה או גרסה. אין-מפתח = HOLD כנה (fail-closed),
 * בדיוק כמו כל שער-חתימה באחזקה.
 *
 * סדר-העדיפות הוא חוזה: הראשון-עם-מפתח שמצליח מנצח, השאר fallback.
 * נגישות-נקודות-הקצה נמדדה מהסנדבוקס (2026-10-04): כולן חיות (auth-gated).
 */

/* §㊿ (2026-11-16) · ספק-הסטים — פקודת-בעלים «הכל-דרך-הארכיטקטורה»:
 * המחשוב-החי של-הצי (33-מודלים-נמדדו-חיים ב-§㊾) מתחבר-לגשר. המפתח-והבסיס
 * הועברו-לסודות-הריפו-ע"י nim-relay (Autonomy→saos-dex · gh-CLI-מוצפן · אפס-ערכים).
 * המודל-המוביל-נמדד-חי: nvidia/nemotron-3.5-lightning-30b-a3b → HTTP-200 · 301ms · 37-tokens.
 * נקודת-הקצה: דינמית מ-NVIDIA_BASE_URL (סוד-מועבר) עם-נקודת-הברירה-הקנונית. */
const NIM_ENDPOINT = (typeof process !== 'undefined' && typeof process.env?.NVIDIA_BASE_URL === 'string' && process.env.NVIDIA_BASE_URL.length > 8)
  ? process.env.NVIDIA_BASE_URL.replace(/\/+$/, '') + '/chat/completions'
  : 'https://integrate.api.nvidia.com/v1/chat/completions';

export const PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'nim',
    envVar: 'NVIDIA_NIM_KEY',
    endpoint: NIM_ENDPOINT,
    style: 'openai',
    models: Object.freeze([
      'nvidia/nemotron-3.5-lightning-30b-a3b',
      'nvidia/nemotron-3-ultra-550b-a55b',
      'deepseek-ai/deepseek-v4.1-flash',
      'openai/gpt-oss-20b',
      'z-ai/glm-5.3-flash',
    ]),
    signup: 'https://build.nvidia.com',
    freeTierNote: 'ספק-הסטים-של-הצי — מפתח-חי-בסודות-הריפו (nim-relay §㊿)',
  }),
  Object.freeze({
    id: 'groq',
    envVar: 'GROQ_API_KEY',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    style: 'openai',
    models: Object.freeze(['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it']),
    signup: 'https://console.groq.com',
    freeTierNote: 'free tier documented by provider — verify at signup',
  }),
  Object.freeze({
    id: 'gemini',
    envVar: 'GEMINI_API_KEY',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    style: 'gemini',
    models: Object.freeze(['gemini-2.0-flash', 'gemini-2.0-flash-lite']),
    signup: 'https://aistudio.google.com/apikey',
    freeTierNote: 'free tier documented by provider — verify at signup',
  }),
  Object.freeze({
    id: 'mistral',
    envVar: 'MISTRAL_API_KEY',
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    style: 'openai',
    models: Object.freeze(['mistral-small-latest']),
    signup: 'https://console.mistral.ai',
    freeTierNote: 'free tier documented by provider — verify at signup',
  }),
  Object.freeze({
    id: 'openrouter',
    envVar: 'OPENROUTER_API_KEY',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    style: 'openai',
    models: Object.freeze([
      'meta-llama/llama-3.3-70b-instruct:free',
      'deepseek/deepseek-r1:free',
      'google/gemini-2.0-flash-exp:free',
      'qwen/qwen3-32b:free',
    ]),
    signup: 'https://openrouter.ai/keys',
    freeTierNote: ':free models documented by provider — verify at signup',
  }),
]);

/** מפתחות שקיימים ב-env — הספקים-החמושים, בסדר-עדיפות. */
export function keyedProviders(env = process.env, providers = PROVIDERS) {
  return providers.filter((p) => typeof p === 'object' && p && typeof env?.[p.envVar] === 'string' && env[p.envVar].length > 0);
}

/**
 * ניתוב-מודל: "groq/llama-3.3-70b-versatile" → {provider: groq, model: 'llama-3.3-70b-versatile'}.
 * מודל ללא-קידומת → null (הניתוב הכללי יבחר לפי סדר-עדיפות).
 */
export function resolveModel(model, providers = PROVIDERS) {
  if (typeof model !== 'string' || model.length === 0) return null;
  const idx = model.indexOf('/');
  if (idx <= 0) return null;
  const pid = model.slice(0, idx);
  const rest = model.slice(idx + 1);
  const provider = providers.find((p) => p.id === pid);
  if (!provider || rest.length === 0) return null;
  return { provider, model: rest };
}

export const REDACTED = '[REDACTED]';

/** חוק-ההשתקה: ערך-מפתח ידוע לעולם לא יופיע בשום-מחרוזת-פלט. */
export function redact(text, env = process.env) {
  let out = String(text ?? '');
  for (const p of PROVIDERS) {
    const v = env?.[p.envVar];
    if (typeof v === 'string' && v.length > 0) out = out.split(v).join(REDACTED);
  }
  return out;
}
