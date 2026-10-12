// KEY-GATE — שער-אימות-מפתח מול רשות-ה-active החיה (מסילת-הגריד)
// ════════════════════════════════════════════════════════════════════════════════════════
// נולד ב-9-c (grid-liquidity, 2026-10-11): המדידה-החיה (twin run 38144052862,
// 2026-10-11T13:39Z) חשפה את הכשל-השקט: grid-beat היה "חמוש" לפי נוכחות-ה-WIF בלבד
// (realmarket.activeWif בודק אורך ≥51), ואז כל-שידור נדחה על-ידי-השרשרת בשקט —
// 12 ביטולים + 6 הצבות, כולם "broadcast answered without id" — והפרסום-הציבורי
// הציג verdict=ARMED-STABLE · blocker=null. שקר-מדידה.
//
// החוק: כל-חותם-גריד מאמת לפני-החתימה שה-WIF שבידיו גוזר בדיוק את רשות-ה-active
// החיה של החשבון על-השרשרת (אותו-משטר של hivemarket.authorityOk ושל
// delegate-plan/community verify-then-sign). אי-התאמה = fail-closed — אפס-ניסיונות-
// שידור (חוסך שריפת-RC על 18 שידורים נידונים ומונע שקר-פרסומי).
//
// אין-סודות כאן: ה-WIF עצמו לעולם לא נכתב ללוג/קבלה/תוצאה — רק תשובת ok/reason.

import steem from "steem";

/**
 * גזירת-המפתח-הציבורי מ-WIF (אותו-נתיב של hivemarket.authorityOk).
 * מחזיר null על צורה-רעה — לעולם לא זורק (fail-closed כנה).
 * @param {string} wif
 * @returns {string | null}
 */
export function wifToPublicSafe(wif) {
  try {
    const pub = steem.auth.wifToPublic(String(wif ?? ""));
    return typeof pub === "string" && pub.startsWith("STM") ? pub : null;
  } catch {
    return null;
  }
}

/**
 * שער-הסמכות: האם ה-WIF גוזר את רשות-ה-active החיה של `account`?
 * @param {object} args
 * @param {string} args.account
 * @param {string | null} args.wif            ה-WIF מהכספת (לא נרשם דבר ממנו)
 * @param {(method: string, params: unknown[]) => Promise<any>} args.rpc  נקודת-הזרקה ל-selftest
 * @returns {Promise<{ ok: boolean; reason: string; authorityOk: boolean | null; livePub: string | null }>}
 */
export async function activeAuthorityOk({ account, wif, rpc }) {
  if (!wif || String(wif).length < 51) {
    return { ok: false, reason: "STEEM_ACTIVE_WIF missing — fail-closed (no signing, no broadcast)", authorityOk: null, livePub: null };
  }
  const pub = wifToPublicSafe(wif);
  if (!pub) {
    return { ok: false, reason: "STEEM_ACTIVE_WIF malformed — cannot derive a public key (fail-closed)", authorityOk: false, livePub: null };
  }
  let livePub = null;
  try {
    const accArr = await rpc("condenser_api.get_accounts", [[account]]);
    livePub = accArr?.[0]?.active?.key_auths?.[0]?.[0] ?? null;
  } catch (e) {
    // קריאת-שרשרת נכשלה — לא נחתום על-ספק (fail-closed, כנות)
    return { ok: false, reason: `live authority unreadable (${String(e?.message ?? e).slice(0, 80)}) — refusing to sign on doubt (fail-closed)`, authorityOk: null, livePub: null };
  }
  if (!livePub) {
    return { ok: false, reason: `no live active authority found for ${account} — fail-closed`, authorityOk: false, livePub: null };
  }
  if (pub !== livePub) {
    // כנות בלי-איפוק: המפתח-ישן. פעולת-הבעלים: עדכון הסוד בכספת למפתח-הגוזר את הרשות-החיה.
    return { ok: false, reason: `STEEM_ACTIVE_WIF does NOT derive the live active authority of ${account} (stale key) — refusing to sign (fail-closed); owner action: update the vault secret`, authorityOk: false, livePub };
  }
  return { ok: true, reason: "key derives the live active authority", authorityOk: true, livePub };
}

/**
 * שער-הסמכות-posting: האם ה-WIF גוזר את רשות-ה-posting החיה של `account`?
 * (R16-a · owner mandate trace 1a12dbe9812eff11: הדופק-הריבוני על-השרשרת —
 * custom_json-attestation חתום-posting, עלות-אפס. אותו-משטר fail-closed של activeAuthorityOk.)
 * @param {object} args
 * @param {string} args.account
 * @param {string | null} args.wif
 * @param {(method: string, params: unknown[]) => Promise<any>} args.rpc  נקודת-הזרקה ל-selftest
 * @returns {Promise<{ ok: boolean; reason: string; authorityOk: boolean | null; livePub: string | null }>}
 */
export async function postingAuthorityOk({ account, wif, rpc }) {
  if (!wif || String(wif).length < 51) {
    return { ok: false, reason: "STEEM_POSTING_WIF missing — fail-closed (no signing, no broadcast)", authorityOk: null, livePub: null };
  }
  const pub = wifToPublicSafe(wif);
  if (!pub) {
    return { ok: false, reason: "STEEM_POSTING_WIF malformed — cannot derive a public key (fail-closed)", authorityOk: false, livePub: null };
  }
  let livePub = null;
  try {
    const accArr = await rpc("condenser_api.get_accounts", [[account]]);
    livePub = accArr?.[0]?.posting?.key_auths?.[0]?.[0] ?? null;
  } catch (e) {
    return { ok: false, reason: `live authority unreadable (${String(e?.message ?? e).slice(0, 80)}) — refusing to sign on doubt (fail-closed)`, authorityOk: null, livePub: null };
  }
  if (!livePub) {
    return { ok: false, reason: `no live posting authority found for ${account} — fail-closed`, authorityOk: false, livePub: null };
  }
  if (pub !== livePub) {
    return { ok: false, reason: `STEEM_POSTING_WIF does NOT derive the live posting authority of ${account} (stale key) — refusing to sign (fail-closed); machine action: adopt the live key from the GEN-2 custody census (key-census-probe)`, authorityOk: false, livePub };
  }
  return { ok: true, reason: "key derives the live posting authority", authorityOk: true, livePub };
}
