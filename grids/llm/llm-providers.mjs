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

export const PROVIDERS = Object.freeze([
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
