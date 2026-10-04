// CONVERT (D-023 · T-8) — מסילת-ההמרה: קציר-אסקים → SBD נזיל → המרה בפאריטי-פנים → 3.5 ימים → STEEM → פריסה-מחדש ≥ פאריטי
// ═══════════════════════════════════════════════════════════════════════════
// הכלכלה הנמדדה (T-7, חי): SBD פנים = פאריטי-$1 · שוק SBD ≈ $0.59 →
// המרה קונה STEEM ב-1/steemUsd לכל SBD — כ-69% יותר STEEM ל-SBD מאשר קנייה
// בפאריטי בספר. העלות: נעילת 3.5 ימים + אי-ודאות מחיר-חציון. הדוקטרינה:
//   · convert-first על ה-SBD-הנזיל-שנקצר מאסקים — אבל אף-פעם לא נוגעים
//     ב-SBD העובד בסולם-הקניות (הרזרבה למדדים נשארת נזילה)
//   · אפס-המצאה: המרה רק על יתרה-נזילה-אמת, רק עם סימון-שער-אמת, רק
//     בתוך תקרת-חשיפה פתוחה (MAX_PENDING) — נעילת 3.5 ימים היא סיכון
//   · אותה-דוקטרינת-חתימה של המוביל (R10/R81): מקור-ריבוני בזמן-ריצה
//     בלבד, verify-then-sign מול הרשויות-החיות, fail-closed, ראיות-פומביות
//   · המתכנן חסר-מפתחות וטהור לגמרי (selftest אופליין); המבצע = שער-יחיד

import { writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import crypto from "node:crypto";
import { appendEvent } from "./events.mjs";
import { stasisHalt } from "./brake.mjs"; // owner directive 2026-10-04: think-before-sign — the signer obeys the brake
import { measureMarks, measureSnapshot } from "./peg.mjs";
import { ACCOUNT, RC_MIN, num, dp3, rpcAny, signAndBroadcast, deriveActiveWif, privToPub, privToWif, wifToPriv } from "./mover.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, "state");
const PLAN_PATH = join(STATE_DIR, "convert-plan.json");
const CONVERT_LOG = join(STATE_DIR, "convert-log.jsonl");
const EVENTS_LOG = join(STATE_DIR, "events.jsonl");

export const CONVERT_POLICY = {
  MIN_EDGE_BPS: 1500,    // ≥15% מתחת לפאריטי-פנים ($1) — היסטרזיס מול רעש-שער
  MIN_CONVERT_SBD: 1.0,  // מתחת לזה — אבק, השרשרת לא שווה את-הדלק
  BID_RESERVE_SBD: 0.5,  // שמור-נזיל לסולם-הקניות (בידים חייבים SBD נזיל)
  MAX_PENDING_SBD: 10,   // תקרת-חשיפה פתוחה-בו-זמנית (נעילת 3.5 ימים)
};

/* ── מתכנן טהור — אפס IO, בדיקות-אופליין מלאות ──────────────────────────── */
export function planConvert({ liquidSbd = 0, pendingSbd = 0, pendingRequests = null, sbdUsd = null, steemUsd = null, policy = CONVERT_POLICY, nowIso = null } = {}) {
  const gates = [];
  let discountBps = null;
  if (sbdUsd == null || !(sbdUsd > 0)) {
    gates.push("sbd mark unavailable — no convert without price truth (fail-closed)");
  } else {
    discountBps = Math.round((1 - sbdUsd) * 10000); // פאריטי-פנים = $1/SBD
    if (discountBps < policy.MIN_EDGE_BPS) gates.push(`edge ${discountBps}bps < ${policy.MIN_EDGE_BPS}bps — convert-no-edge (hold for re-mark)`);
  }
  const capLeft = Math.max(0, Math.round((policy.MAX_PENDING_SBD - (pendingSbd ?? 0)) * 1000) / 1000);
  const raw = (liquidSbd ?? 0) - policy.BID_RESERVE_SBD;
  let amount = Math.min(raw, capLeft);
  amount = dp3(Math.max(0, amount)); // floor-3-ספרות — אותה-משמעת-סכומים של המוביל
  if (amount < policy.MIN_CONVERT_SBD) {
    gates.push(`convertible ${amount.toFixed(3)} SBD (liquid ${(liquidSbd ?? 0).toFixed(3)} − reserve ${policy.BID_RESERVE_SBD} ≤ cap-left ${capLeft.toFixed(3)}) < ${policy.MIN_CONVERT_SBD} — below-threshold/dust`);
    amount = 0;
  }
  const ok = gates.length === 0 && amount >= policy.MIN_CONVERT_SBD;
  return {
    ok,
    verdict: ok ? "CONVERT-PLAN" : "CONVERT-HOLD",
    at: nowIso ?? null,
    account: ACCOUNT,
    amountSbd: ok ? amount : 0,
    liquidSbd: Math.round((liquidSbd ?? 0) * 1000) / 1000,
    pendingSbd: Math.round((pendingSbd ?? 0) * 1000) / 1000,
    pendingRequests: Array.isArray(pendingRequests) ? pendingRequests : null, // Z-87a: קבלת-בשלות — הרשומות-המילוליות מ-get_conversion_requests
    capLeft,
    discountBps,
    marks: { steemUsd, sbdUsd },
    expectedSteem: ok && steemUsd > 0 ? Math.floor((amount / steemUsd) * 1000) / 1000 : null,
    lockDays: 3.5,
    gates,
    policy,
  };
}

/* ── Z-87a · קבלת-בשלות: שדות-האמת של get_conversion_requests נשמרים-כמו-שהם ──
 * הבאג-שנמדד (audit-Z86c): convert.mjs:76-78 קרא את הרשומות-חי אך שמר רק את-הסכום —
 * requestid ותאריך-הבשלות נשרו → הפאי-אאוט של 2026-10-06 לא היה ניתן-לאימות-קבלה.
 * החוק-החדש: כל-רשומה נשמרת מילולית — רק שדות-שה-API אכן החזיר (חוק-אף-המצאה):
 *   {requestid, amount, conversion_date, id, owner}. שדה-שלא-חזר — לא מומצא כאן.
 * הערת-מיפוי: "completion_time" בשפת-ההנחיה = השדה conversion_date שה-API מחזיר בפועל. */
export const CONVERSION_VERBATIM_FIELDS = ["requestid", "amount", "conversion_date", "id", "owner"];
export function summarizeConversionRequests(rawRows) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const requests = rows.map((r) => {
    const src = r && typeof r === "object" && r.request ? r.request : (r || {});
    const out = {};
    for (const f of CONVERSION_VERBATIM_FIELDS) if (src[f] !== undefined) out[f] = src[f]; // מילולי — בלי-עיבוד
    return out;
  });
  const pendingSbd = dp3(rows.reduce((s, r) => s + num((r ?? {}).amount ?? (r?.request ?? {}).amount), 0));
  return { pendingSbd, pendingCount: requests.length, requests };
}

/* ── Z-89 · חוק-תשלום-הבשלות — קבוע-בקוד-השרשרת, לא-בפרוזה ─────────────────
 * libraries/chain/database.cpp :: process_conversions() (steemit/steem master,
 * נשלף-ואומת 2026-10-04): amount_to_issue = itr->amount × fhistory.current_median_history
 * — נמדד בזמן-העיבוד (הבשלות), לא בזמן-הבקשה. התשלום צף עד הבשלות → כל
 * "expectedSteem" הוא הערכה-מסומנת-כך ולא עובדה (חוק-אף-המצאה).
 *
 * שני-סוגי-חציון-שנמדדו-חי (api.steemit.com, 2026-10-04) — ואסור לערבב:
 *  · current_median_history = החציון-המותאם (מקור-החוק): "58270125.447 SBD"/"559753583.308 STEEM"
 *    → 0.1041 SBD-ל-STEEM — כולל התאמת-מצב-החוב של-השרשרת;
 *  · price_history[] = חציוני-העדים-הגולמיים: "0.064 SBD"/"1.000 STEEM" — בלי-ההתאמה.
 * ערבובם היה ממציא פס-שקר — לכן הפס-הגולמי מדווח-בשקיפות-בלבד, ופס-אמת לחציון-המותאם
 * נבנה-רק מסדרת-קבלות-מדודה עתידית (אין-סדרה-כזו-עדיין → band=null בכנות). */
const amountOf = (e) => {
  if (e == null) return NaN;
  if (typeof e === "string") return num(e.split(" ")[0]); // "0.064 SBD" — condenser חי
  return num(e.amount); // אובייקט-NAI {amount, precision, nai}
};
export function medianFromFeedHistory(feedHistory) {
  const cur = feedHistory?.current_median_history;
  const b = amountOf(cur?.base), q = amountOf(cur?.quote);
  const medianNow = (b > 0 && q > 0) ? b / q : null; // base=SBD, quote=STEEM → SBD-ל-STEEM (המותאם — מקור-החוק)
  const rawMeds = (Array.isArray(feedHistory?.price_history) ? feedHistory.price_history : [])
    .map((e) => { const rb = amountOf(e?.base), rq = amountOf(e?.quote); return (rb > 0 && rq > 0) ? rb / rq : null; })
    .filter((m) => m > 0);
  const rawMedianNow = rawMeds.length > 0 ? rawMeds[0] : null; // כניסת-העדים-הגולמית-הראשונה-כפי-שהצומת-החזיר
  return {
    medianNow: medianNow > 0 ? medianNow : null,      // המותאם — מה-שהחוק-משתמש-בו
    rawMedianNow: rawMedianNow > 0 ? rawMedianNow : null, // גולמי — שקיפות-בלבד
    rawBand: rawMeds.length >= 2 ? { min: Math.min(...rawMeds), max: Math.max(...rawMeds), samples: rawMeds.length } : null,
    note: "current_median_history (adjusted, debt-position) is the LAW input; price_history holds raw witness medians — reported, never mixed",
  };
}

export function estimateMaturityPayout({ rows = null, medianNow = null, rawMedianNow = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const pendingSbd = dp3(list.reduce((s, r) => s + num((r ?? {}).amount ?? (r?.request ?? {}).amount), 0));
  const semantics = "payout = amount / ADJUSTED median-at-maturity (steem database.cpp process_conversions) — ESTIMATE, floats until conversion_date";
  if (!(pendingSbd > 0)) return { pendingSbd, estimate: null, reason: "no pending rows", semantics };
  if (!(medianNow > 0)) return { pendingSbd, estimate: null, reason: "no median mark — no invention (fail-closed)", semantics };
  const estimate = Math.floor((pendingSbd / medianNow) * 1000) / 1000; // אותו-רצפה-שמרני של expectedSteem
  return {
    pendingSbd, medianNow, estimate,
    rawMedianNow: rawMedianNow > 0 ? rawMedianNow : null, // שקיפות: חציון-העדים-הגולמי — לא-מקור-החוק
    band: null, // אין-סדרת-חציון-מותאם-מדודה-עדיין — פס-שקר לא מומצא; נבנה מקבלות-חוזרות
    semantics,
  };
}

/* ── מדידה-חיה: יתרה-נזילה + המרות-פתוחות ────────────────────────────────── */
export async function measureConvertState(account = ACCOUNT) {
  const snap = await measureSnapshot(account);
  let pendingRaw = [];
  try { pendingRaw = await rpcAny("condenser_api.get_conversion_requests", [account]) ?? []; } catch { pendingRaw = []; }
  const sum = summarizeConversionRequests(pendingRaw);
  return { liquidSbd: snap.balances.sbd, liquidSteem: snap.balances.steem, pendingSbd: sum.pendingSbd, pendingCount: sum.pendingCount, pendingRequests: sum.requests };
}

/* ── הריצה: מתכנן-חסר-מפתחות (ברירת-מחדל) · --execute = שער-החתימה ───────── */
export async function runConvert({ execute = false, dryRun = false, masterSourcePath = process.env.MASTER_SOURCE_PATH } = {}) {
  /* 0. בלם-ההון (owner 2026-10-04): חתימת-המרה אסורה בזמן-הקפאה; תוכנית-מדידה ממשיכה */
  if (execute && stasisHalt("convert")) {
    return { at: new Date().toISOString(), account: ACCOUNT, mode: "execute", gates: ["STASIS active — convert signing halted (think-before-sign, owner directive 2026-10-04)"], txids: [], summary: { converted: 0, blocked: 1, failed: 0 }, halted: "STASIS" };
  }
  const evidence = { at: new Date().toISOString(), account: ACCOUNT, mode: execute ? "execute" : "plan", gates: [], txids: [] };
  const { liquidSbd, pendingSbd, pendingCount, pendingRequests, liquidSteem } = await measureConvertState();
  const marks = await measureMarks();
  // Z-89: הערכת-בשלות מסומנת-כך — חוק-התשלום מקוד-השרשרת (process_conversions),
  // חציון-זמן-עיבוד + פס-היסטוריה. keyless, fail-closed בלי-חציון.
  const feedHist = await rpcAny("condenser_api.get_feed_history", []).catch(() => null);
  const med = medianFromFeedHistory(feedHist);
  const maturityEstimate = estimateMaturityPayout({ rows: pendingRequests, medianNow: med.medianNow, rawMedianNow: med.rawMedianNow });
  const plan = planConvert({ liquidSbd, pendingSbd, pendingRequests, sbdUsd: marks.sbdUsd, steemUsd: marks.steemUsd, nowIso: evidence.at });
  plan.maturityEstimate = maturityEstimate; // הערכה — לא עובדה (ראה semantics)
  evidence.plan = plan;
  evidence.maturityEstimate = maturityEstimate;
  evidence.state = { liquidSbd, liquidSteem, pendingSbd, pendingCount, pendingRequests };

  if (!plan.ok) {
    evidence.note = "honest hold — " + plan.gates.join(" · ");
    persistPlan(plan, evidence);
    appendEvent(EVENTS_LOG, { type: "convert.hold", source: "convert", sim: false, payload: { gates: plan.gates, liquidSbd: plan.liquidSbd, pendingSbd: plan.pendingSbd, discountBps: plan.discountBps } });
    return evidence;
  }

  if (!execute) {
    evidence.note = "keyless plan only — execution requires the single signing gate (--execute · same doctrine as mover)";
    persistPlan(plan, evidence);
    appendEvent(EVENTS_LOG, { type: "convert.planned", source: "convert", sim: false, payload: { amountSbd: plan.amountSbd, expectedSteem: plan.expectedSteem, discountBps: plan.discountBps } });
    return evidence;
  }

  /* שער-החתימה — אותם-שערי-הגנה של המוביל, fail-closed.
   * Z-81: שני-מקורות-מפתח, שניהם verify-then-sign מול הרשויות-החיות:
   *  (א) כספת-האב הקנונית (master-source file) — כפי-שהיה;
   *  (ב) STEEM_ACTIVE_WIF (סוד-ה-CI שכבר מחמש את grid-beat) — כגיבוי
   *      כשהכספת לא קיימת בסביבת-הריצה. אותו-חוק: רק התאמת-active מלאה
   *      מתירה חתימה; אף-מפתח לא נכתב לדיסק/לוג/קבלה. */
  const srcPath = masterSourcePath
    || ["/tmp/keystation/live-agent/keys/hed-soldiers-source.txt", "/home/z/git-audit/steem/agent/keys/hed-soldiers-source.txt"].find((p) => existsSync(p))
    || null;
  const acc = (await rpcAny("condenser_api.get_accounts", [[ACCOUNT]]))?.[0];
  if (!acc) throw new Error("account absent from live chain (fail-closed)");
  const liveActive = acc.active?.key_auths?.[0]?.[0];
  let liveWif = null;
  let keySource = null;
  if (srcPath && existsSync(srcPath)) {
    const { candidates, privFor } = deriveActiveWif(readFileSync(srcPath, "utf8"));
    for (const pw of candidates) {
      if (privToPub(privFor("active", pw)) === liveActive) { liveWif = privToWif(privFor("active", pw)); keySource = "master-vault"; break; }
    }
  }
  if (!liveWif && process.env.STEEM_ACTIVE_WIF) {
    try {
      if (privToPub(wifToPriv(process.env.STEEM_ACTIVE_WIF)) === liveActive) { liveWif = process.env.STEEM_ACTIVE_WIF; keySource = "ci-secret (verified-against-live-authority)"; }
    } catch { /* WIF פגום — נשאר fail-closed למטה */ }
  }
  if (!liveWif) throw new Error("no key source derives the LIVE active authority (master vault absent + no valid STEEM_ACTIVE_WIF) — refusing to sign (fail-closed)");
  evidence.keySource = keySource; // הוכחת-מקור-מכובדת בלי לחשוף את המפתח
  const rc = await rpcAny("rc_api.find_rc_accounts", { accounts: [ACCOUNT] }).catch(() => null);
  const rcNow = Number(rc?.rc_accounts?.[0]?.rc_manabar?.current_mana ?? 0);
  if (rcNow < RC_MIN) throw new Error(`RC fuel below floor: ${rcNow} < ${RC_MIN} (fail-closed)`);

  /* טריות-שער: אם ה-SBD זז מהסימון בין-המדידה-לחתימה — ידיים-בכיס */
  const fresh = await measureConvertState();
  if (Math.abs(fresh.liquidSbd - liquidSbd) > 0.001) throw new Error(`liquid SBD moved ${liquidSbd} → ${fresh.liquidSbd} between measure and sign — re-plan (honest)`);
  if (fresh.pendingSbd + plan.amountSbd > CONVERT_POLICY.MAX_PENDING_SBD + 1e-9) throw new Error("pending exposure cap would be exceeded — refusing (fail-closed)");

  const requestid = Math.floor(Date.parse(evidence.at) / 1000) % 2147483647;
  if (dryRun) {
    evidence.txids.push({ requestid, amount: `${plan.amountSbd.toFixed(3)} SBD`, dryRun: true });
  } else {
    const r = await signAndBroadcast(liveWif, [["convert", { owner: ACCOUNT, requestid, amount: `${plan.amountSbd.toFixed(3)} SBD` }]]);
    evidence.txids.push({ requestid, amount: `${plan.amountSbd.toFixed(3)} SBD`, txid: r.txid, block: r.block });
    appendFileSync(CONVERT_LOG, JSON.stringify({ at: evidence.at, requestid, amountSbd: plan.amountSbd, expectedSteem: plan.expectedSteem, discountBps: plan.discountBps, txid: r.txid, block: r.block }) + "\n");
    appendEvent(EVENTS_LOG, { type: "convert.executed", source: "convert", sim: false, payload: { requestid, amountSbd: plan.amountSbd, txid: r.txid } });
  }
  evidence.summary = { converted: evidence.txids.filter((t) => t.txid).length, blocked: 0, failed: evidence.txids.filter((t) => t.error).length };
  persistPlan(plan, evidence);
  return evidence;
}

function persistPlan(plan, evidence) {
  try {
    writeFileSync(PLAN_PATH, JSON.stringify({ ...plan, evidence: { at: evidence.at, mode: evidence.mode, note: evidence.note ?? null, txids: evidence.txids } }, null, 1) + "\n");
  } catch { /* דוח-כתיבה לא מפיל מסילה */ }
}

/* ── selftest: אופליין לגמרי — המתכנן-הטהור בלבד ─────────────────────────── */
export async function selftest() {
  const t = (name, ok) => {
    console.log(`${ok ? " ✓" : " ✗"} ${name}`);
    if (!ok) process.exitCode = 1;
  };
  const P = CONVERT_POLICY;

  /* וקטור-1: האמת-החיה של היום (T-8 מדידה): נזיל 0.223, פתוח 0 → HOLD אבק */
  const v1 = planConvert({ liquidSbd: 0.223, pendingSbd: 0, sbdUsd: 0.591672, steemUsd: 0.06287 });
  t("live-truth: 0.223 liquid → CONVERT-HOLD dust", v1.verdict === "CONVERT-HOLD" && v1.amountSbd === 0 && v1.gates.length === 1);

  /* וקטור-2: בלי סימון-שער — אפס-המצאה */
  const v2 = planConvert({ liquidSbd: 5, pendingSbd: 0, sbdUsd: null });
  t("no sbd mark → HOLD (no invention)", v2.verdict === "CONVERT-HOLD" && /mark unavailable/.test(v2.gates[0]));

  /* וקטור-3: קצה-נמוך מההיסטרזיס → HOLD */
  const v3 = planConvert({ liquidSbd: 5, pendingSbd: 0, sbdUsd: 0.90 });
  t("edge 10% < 15% hysteresis → CONVERT-HOLD", v3.verdict === "CONVERT-HOLD" && v3.discountBps === 1000 && /no-edge/.test(v3.gates[0]));

  /* וקטור-4: קציר-אמת 3.142 SBD (הספר-המלא של T-8) → PLAN 2.642 */
  const v4 = planConvert({ liquidSbd: 3.142, pendingSbd: 0, sbdUsd: 0.591672, steemUsd: 0.06287 });
  t("harvest 3.142 → PLAN 2.642 (reserve 0.5 kept liquid)", v4.verdict === "CONVERT-PLAN" && Math.abs(v4.amountSbd - 2.642) < 1e-9 && v4.liquidSbd === 3.142);
  t("expectedSteem estimated from face $1", v4.expectedSteem !== null && Math.abs(v4.expectedSteem - Math.floor((2.642 / 0.06287) * 1000) / 1000) < 1e-9);

  /* וקטור-5: תקרת-חשיפה — פתוח 9.7 → נותר 0.3 < מינימום → HOLD */
  const v5 = planConvert({ liquidSbd: 5, pendingSbd: 9.7, sbdUsd: 0.59 });
  t("pending 9.7 → cap-left 0.3 < 1.0 → CONVERT-HOLD", v5.verdict === "CONVERT-HOLD" && Math.abs(v5.capLeft - 0.3) < 1e-9);

  /* וקטור-6: תקרה בדיוק — פתוח 8.5, נזיל 5 → PLAN 1.5 */
  const v6 = planConvert({ liquidSbd: 5, pendingSbd: 8.5, sbdUsd: 0.59 });
  t("cap-left 1.5 → PLAN 1.5 (cap binds)", v6.verdict === "CONVERT-PLAN" && Math.abs(v6.amountSbd - 1.5) < 1e-9);

  /* וקטור-7: רזרבת-הבידים לא נוגעת — נזיל 0.9 → אבק */
  const v7 = planConvert({ liquidSbd: 0.9, pendingSbd: 0, sbdUsd: 0.59 });
  t("0.9 liquid − 0.5 reserve = 0.4 < 1.0 → HOLD", v7.verdict === "CONVERT-HOLD");

  /* וקטור-8: דטרמיניזם — אותו-קלט, אותו-פלט (בלי nowIso) */
  const a = planConvert({ liquidSbd: 4, pendingSbd: 1, sbdUsd: 0.58 });
  const b = planConvert({ liquidSbd: 4, pendingSbd: 1, sbdUsd: 0.58 });
  t("determinism: same input → same plan", JSON.stringify(a) === JSON.stringify(b));

  /* וקטור-9: סימון-בדיוק-על-ההיסטרזיס → מותר (≥) */
  const v9 = planConvert({ liquidSbd: 4, pendingSbd: 0, sbdUsd: 0.85 });
  t("edge exactly 15% → allowed (≥ gate)", v9.verdict === "CONVERT-PLAN" && Math.abs(v9.amountSbd - 3.5) < 1e-9);

  /* וקטור-10: שלמות-מדיניות — ההרזרבה והתקרה בתוך-הפוליטיקה המיוצאת */
  t("policy integrity: reserve < min < cap ordering", P.BID_RESERVE_SBD < P.MIN_CONVERT_SBD && P.MIN_CONVERT_SBD <= P.MAX_PENDING_SBD);

  /* וקטור-10b (Z-87a): קבלת-בשלות — requestid+conversion_date+amount נשמרים-מילולית.
   * הרשומות-מטה מוקלטות-חי מ-condenser_api.get_conversion_requests (2026-10-04,
   * grids/state/fixtures/steem-conversion-requests.json) — לא-המצאה: כל-שדה הוחזר-בפועל. */
  const liveRows = [
    { amount: "0.001 SBD", conversion_date: "2026-10-06T00:02:12", id: 135589, owner: "headcorner", requestid: 1790942528 },
    { amount: "7.611 SBD", conversion_date: "2026-10-06T00:02:30", id: 135590, owner: "headcorner", requestid: 1790942546 },
  ];
  const sum10b = summarizeConversionRequests(liveRows);
  t("maturity receipt: requestid + conversion_date kept verbatim (Z-87a)", sum10b.requests.length === 2 && sum10b.requests[0].requestid === 1790942528 && sum10b.requests[1].conversion_date === "2026-10-06T00:02:30");
  t("maturity receipt: pendingSbd = sum of verbatim amounts", Math.abs(sum10b.pendingSbd - 7.612) < 1e-9);
  t("maturity receipt: no invented fields (keys ⊆ returned set)", sum10b.requests.every((r) => Object.keys(r).every((k) => CONVERSION_VERBATIM_FIELDS.includes(k))));
  const s10c = summarizeConversionRequests("garbage");
  t("maturity receipt: non-array input → zero pending, never throws (fail-closed)", s10c.pendingCount === 0 && s10c.pendingSbd === 0 && s10c.requests.length === 0);
  const v10d = planConvert({ liquidSbd: 4, pendingSbd: 7.612, pendingRequests: sum10b.requests, sbdUsd: 0.59 });
  t("maturity receipt: plan carries pendingRequests → convert-plan.json shape", v10d.verdict === "CONVERT-PLAN" && Array.isArray(v10d.pendingRequests) && v10d.pendingRequests[0].requestid === 1790942528);

  /* וקטור-11 (Z-81): היפוך-WIF — roundtrip מושלם + fail-closed על צורה פגומה */
  try {
    const { privToWif, wifToPriv } = await import("./mover.mjs");
    const priv = Buffer.from(crypto.createHash("sha256").update("z81-wif-roundtrip-vector").digest());
    const wif = privToWif(priv);
    t("wifToPriv ∘ privToWif = identity (Z-81)", Buffer.from(wifToPriv(wif)).equals(priv));
    let refused = false;
    try { wifToPriv("STMbogusNotAWif"); } catch { refused = true; }
    t("wifToPriv refuses non-WIF shape (fail-closed)", refused);
  } catch (e) { t("wif roundtrip vector failed: " + String(e).slice(0, 60), false); }

  console.log(process.exitCode === 1 ? "CONVERT-SELFTEST: FAIL" : "CONVERT-SELFTEST: PASS");
}

/* ── CLI: node grids/convert.mjs [--execute] [--dry-run] [--selftest] ─────── */
if (process.argv[1] && process.argv[1].endsWith("convert.mjs")) {
  if (process.argv.includes("--selftest")) { await selftest(); process.exit(process.exitCode ?? 0); }
  try {
    const ev = await runConvert({ execute: process.argv.includes("--execute"), dryRun: process.argv.includes("--dry-run") });
    console.log(`[convert${process.argv.includes("--dry-run") ? " · dry" : ""}] ${ev.plan?.verdict ?? "?"} · ${ev.note ?? JSON.stringify(ev.summary ?? ev.txids)}`);
    for (const t of ev.txids) console.log(`  ${t.txid ? "✓" : "·"} req#${t.requestid} ${t.amount}${t.txid ? ` · tx ${String(t.txid).slice(0, 14)}…` : t.dryRun ? " (dry)" : ""}`);
  } catch (e) {
    console.error(`[convert] refused honestly: ${String(e?.message ?? e).slice(0, 140)}`);
    process.exit(2);
  }
}
