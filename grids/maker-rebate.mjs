// MAKER-REBATE — פנקס-צבירת-הריבייטים-למייקרים של הרשת-הריבונית (SAOS-MAKER-REBATE/1)
// ═══════════════════════════════════════════════════════════════════════════════════════════
// תפקיד: בהינתן חלון-מילויים (fills window) — לחשב צבירת-ריבייט פר-חשבון-מייקר, מתוקצבת
// אך-ורק מחית-האוצר על אותו חלון. זהו מימוש-המדיניות שהובטחה ב-LIQUIDITY_STRATEGY §3:
// «ריבייט פר-מדידה… אף-פעם לא מהנפקה-חדשה · ריבייט שאינו-מכוסה בעמלות-שנמדדו — לא-משולם».
//
// חוק-המקור (ברזל, בלתי-ניתן-לערעור):
//   הריבייט יוצא אך-ורק מחית-האוצר — TREASURY_CUT_PCT (30%) מעמלת-ה-FEE_BPS (30bps)
//   שכבר-נגבתה מהטייקר. לעולם לא מוטבע, לעולם לא מה-LP (ה-70% שלהם הוא שלהם),
//   לעולם לא מאוויר. Σריבייט-החלון ≤ Σחית-האוצר-על-אותו-חלון — בכל-רגל ובסך-הכל.
//
// חוקי-ברזל (אותם-חוקי-בית של route-graph/daily-budget):
//   1. PLAN-ONLY — הפנקס מחשב ומציע, לא חותם. אף-כתיבת-קובץ, אף-מפתח, אף-שידור, אף-fs.
//   2. אפס-מספרים-מומצאים — כל-notional נגזר מהרשומה-עצמה; רשומה שאינה-נושאת ייחוס-מייקר
//      אינה זכאית דבר (נמדלגת-ונמדדת — fail-honest); חלון-פגום/תצורה-בלתי-חוקית → ok:false
//      (fail-closed). שום-קלט-רע לא מייצר כסף.
//   3. דטרמיניזם — שלמים-בלבד (floor, אותו-חוק-notional של הקרנל), מיון-קנוני לפי-מייקר,
//      אפס-שעון, אפס-random: אותן-קלטות → אותו-פלט ביט-ביט.
//   4. אנטי-כפילות — הייחוס-עצמו חי ב-src/lib/dex/maker.ts (EXEC-CD-8 makerFeed על
//      TradeEvent.kind:"fill"); כאן רק חוק-התקציב והחלון. הסליקה (כשתיפתח) תעבור
//      rebateMarkPaid + refuel-גרעיני — העברה-טהורה, אפס-הטבעה — ותהיה מחויבת להיצמד
//      ליתרת-האוצר בפועל (הפנקס הוא תוכנית; המצב-החי הוא השופט).
//
// יחידות: notionalMu = נומינל-ציטוט ב-µ — חוק-הקרנל המדויק (kernel.ts:846):
//   notional = floor(price × amountMu / 1000)   · price=µ-ציטוט ל-1-יחידת-בסיס · amountMu=µ-בסיס.
// עמלה: feeMu = floor(notionalMu × feeBps / 10_000)  · חית-אוצר: cutMu = floor(feeMu × cutPct / 100).
// ריבייט-פר-רגל: rebate = min( floor(notionalMu × rebateBps / 10_000), cutMu ) — מינימום כפול
//   שמבטיח שגם בתקרה-החוקית (rebateBps ≤ floor(feeBps×cutPct/100)) הריבייט לעולם לא חורג
//   מהחית-האוצר של אותה-רגל (ה-floor-הכפול של החית יכול להיות קטן ב-1µ מהריבייט-הגולמי).

export const PROTOCOL = "SAOS-MAKER-REBATE/1";

export const FEE_BPS_DEFAULT = 30;          // BOOK_TAKER_FEE_BPS / FEE_BPS של הקרנל
export const TREASURY_CUT_PCT_DEFAULT = 30; // TREASURY_CUT_PCT של הקרנל — חית-האוצר
export const REBATE_BPS_DEFAULT = 5;        // ריבייט-ברירת-מחדל: 5bps מה-notional (האוצר שומר 4bps-מהחית)
export const MAX_WINDOW_ROWS = 1_000_000;   // סורג-נזק: חלון-ענק אינו קלט-חוקי (fail-closed)

/** תקרת-הריבייט-החוקית: bps-מקסימלי שהחית-האוצר יכולה לממן (בברירות-המחדל: floor(30×30/100)=9). */
export function maxRebateBps(feeBps, cutPct) {
  return Math.floor((Number(feeBps) * Number(cutPct)) / 100);
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isInt = (x) => Number.isSafeInteger(x);
const isFin = (x) => typeof x === "number" && Number.isFinite(x);

/* ── נירמול-רשומה: כל-צורת-מילוי מדודה בריפו → {maker, notionalMu} | {skip, reason} ─────
 * צורות-נתמכות (כל-אחת מהשורה-עצמה, אפס-הנחות):
 *  · TradeEvent של-הקרנל: {kind:"fill", maker, price, amountMu} (book.ts/cow.ts) —
 *    notionalMu = floor(price×amountMu/1000) (חוק-notional מלא).
 *  · רשומה-מנורמלת: {maker, notionalMu} (כבר-ציטוט-µ שלם — למשל מקורא-חלון).
 *  · מילוי-ספר-STEEM הציבורי (observe.mjs): {seq, side, steem, sbd, counterparty, role} —
 *    role:"maker" → הבעלים-שלנו הניח (maker=account/owner); role:"taker" → הצד-השני הניח
 *    (maker=counterparty); בלי-role אין-ייחוס-אמת → אינו-זכאי (fail-honest).
 *    notionalMu = round(sbd×1000) (1 SBD = 1000µ). הערה-כנה: ספר-STEEM הוא אפס-עמלה —
 *    עם feeBps=0 התקציב-שלו אפס-כנה (ר' maker.ts: הריבייט-שם ממומן-גז, חוק-אחר). */
export function normalizeFill(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return { skip: "malformed" };
  let maker = null;
  if (typeof row.maker === "string" && row.maker.length > 0) maker = row.maker;
  else if (row.role === "taker" && typeof row.counterparty === "string" && row.counterparty.length > 0) maker = row.counterparty;
  else if (typeof row.owner === "string" && row.owner.length > 0) maker = row.owner;
  else if (typeof row.account === "string" && row.account.length > 0) maker = row.account;
  if (maker === null) return { skip: "no-attribution" };
  if (!ID_RE.test(maker)) return { skip: "bad-maker" };

  let notionalMu;
  if (isInt(row.notionalMu)) {
    notionalMu = row.notionalMu;
  } else if (isInt(row.price) && isInt(row.amountMu)) {
    const prod = row.price * row.amountMu;
    if (!Number.isSafeInteger(prod)) return { skip: "overflow" };
    notionalMu = Math.floor(prod / 1000); // חוק-notional של הקרנל — לא-בקירוב
  } else if (isFin(row.sbd) && row.sbd > 0) {
    const mu = Math.round(row.sbd * 1000); // SBD→µ — תיקון-עשרוני-בדת (אותו-דפוס-עיגול של observe.mjs)
    if (!Number.isSafeInteger(mu)) return { skip: "overflow" };
    notionalMu = mu;
  } else {
    return { skip: "bad-notional" };
  }
  if (notionalMu < 0) return { skip: "bad-notional" };
  if (notionalMu === 0) return { skip: "dust-notional" }; // אבק — אין-עמלה, אין-חית, אין-ריבייט
  return { maker, notionalMu };
}

/** בדיקת-תצורה — fail-closed: תצורה-בלתי-חוקית = אין-פנקס היום. */
export function validateConfig(cfg = {}) {
  const feeBps = cfg.feeBps ?? FEE_BPS_DEFAULT;
  const treasuryCutPct = cfg.treasuryCutPct ?? TREASURY_CUT_PCT_DEFAULT;
  const rebateBps = cfg.rebateBps ?? REBATE_BPS_DEFAULT;
  if (!isInt(feeBps) || feeBps < 0 || feeBps > 10_000) return { ok: false, reason: `bad-feeBps:${feeBps}` }; // feeBps=0 = ספר-אפס-עמלה — תקף, תקציבו אפס-כנה
  if (!isInt(treasuryCutPct) || treasuryCutPct < 0 || treasuryCutPct > 100) return { ok: false, reason: `bad-treasuryCutPct:${treasuryCutPct}` };
  const cap = maxRebateBps(feeBps, treasuryCutPct);
  if (!isInt(rebateBps) || rebateBps < 0 || rebateBps > cap) return { ok: false, reason: `rebateBps-exceeds-treasury-cut:${rebateBps}>${cap}` };
  return { ok: true, config: { feeBps, treasuryCutPct, rebateBps, maxRebateBps: cap } };
}

/* ── הפנקס: חלון-מילויים → צבירת-ריבייט פר-מייקר, מתוקצב-חית-אוצר ────────────────────────
 * fills: מערך-רשומות, או {fills:[...]} (אותה-עטיפה של קוראי-ה-state).
 * מחזיר פנקס-שלם: {ok:true, protocol, config, window, perMaker[], totals, law, honesty}
 * או {ok:false, protocol, reason} — fail-closed על חלון/תצורה פגומים. אף-רשומה-רעה לא
 * מפילה חלון — היא נמדלגת ונמדדת ב-window.reasons (fail-honest, אותו-משטר של daily-budget). */
export function computeRebates(fills, config = {}) {
  const cfg = validateConfig(config);
  if (!cfg.ok) return { ok: false, protocol: PROTOCOL, reason: cfg.reason };

  const rows = Array.isArray(fills) ? fills : (fills && typeof fills === "object" && Array.isArray(fills.fills) ? fills.fills : null);
  if (!Array.isArray(rows)) return { ok: false, protocol: PROTOCOL, reason: "window-not-array" };
  if (rows.length > MAX_WINDOW_ROWS) return { ok: false, protocol: PROTOCOL, reason: "window-too-large" };

  const { feeBps, treasuryCutPct, rebateBps } = cfg.config;
  const byMaker = new Map();
  const reasons = {};
  let credited = 0, skipped = 0;
  let totNotional = 0, totFee = 0, totCut = 0, totRebate = 0;

  for (const row of rows) {
    const n = normalizeFill(row);
    if (n.skip) { skipped++; reasons[n.skip] = (reasons[n.skip] ?? 0) + 1; continue; }
    const feeMu = Math.floor((n.notionalMu * feeBps) / 10_000);
    const cutMu = Math.floor((feeMu * treasuryCutPct) / 100);
    const rawRebate = Math.floor((n.notionalMu * rebateBps) / 10_000);
    const rebateMu = Math.min(rawRebate, cutMu); // חוק-התקציב פר-רגל — גם-בתקרה לעולם לא חורג
    credited++;
    totNotional += n.notionalMu; totFee += feeMu; totCut += cutMu; totRebate += rebateMu;
    let rec = byMaker.get(n.maker);
    if (!rec) { rec = { maker: n.maker, fills: 0, notionalMu: 0, feeMu: 0, treasuryCutMu: 0, rebateMu: 0 }; byMaker.set(n.maker, rec); }
    rec.fills += 1; rec.notionalMu += n.notionalMu; rec.feeMu += feeMu; rec.treasuryCutMu += cutMu; rec.rebateMu += rebateMu;
  }

  // מיון-קנוני לפי-שם-מייקר (דטרמיניזם — אין-סדר-הכנסה בפלט)
  const perMaker = [...byMaker.values()].sort((a, b) => (a.maker < b.maker ? -1 : a.maker > b.maker ? 1 : 0));
  const reasonsSorted = {};
  for (const k of Object.keys(reasons).sort()) reasonsSorted[k] = reasons[k];

  return {
    ok: true,
    protocol: PROTOCOL,
    config: cfg.config,
    window: { rows: rows.length, credited, skipped, reasons: reasonsSorted },
    perMaker,
    totals: {
      notionalMu: totNotional,
      feeMu: totFee,
      treasuryCutMu: totCut,
      rebateMu: totRebate,
      treasuryKeepsMu: totCut - totRebate, // העודף-שנשאר-אצל-האוצר — לעולם ≥ 0
    },
    law: "הריבייט יוצא אך-ורק מחית-האוצר (TREASURY_CUT_PCT מעמלת-FEE_BPS) — לעולם לא מוטבע, לעולם לא מה-LP; Σריבייט ≤ Σחית-האוצר",
    honesty: "plan-only · אפס-כתיבה · אפס-שעון · שלמים-בלבד · רשומה-בלי-ייחוס-מייקר = אינה-זכאית (נמדדת ב-reasons) · הסליקה-החיה מחויבת להיצמד ליתרת-האוצר בפועל",
  };
}

/** צבירה-מונוטונית: חלונות-חלק-דיסקרטיים A,B — האיחוד אדיטיבי-בדיוק בשלמים, ואף-מייקר
 * אינו יורד מהצבירה שלו בחלקים. טהור, לשימוש-מפעיל/ביקורת. */
export function monotoneCheck(ledgerA, ledgerB, ledgerUnion) {
  if (!ledgerA?.ok || !ledgerB?.ok || !ledgerUnion?.ok) return false;
  const a = ledgerA.totals, b = ledgerB.totals, u = ledgerUnion.totals;
  if (u.rebateMu !== a.rebateMu + b.rebateMu) return false; // אדיטיביות-שלמים
  if (u.notionalMu !== a.notionalMu + b.notionalMu) return false;
  if (u.treasuryCutMu !== a.treasuryCutMu + b.treasuryCutMu) return false;
  for (const rec of [...ledgerA.perMaker, ...ledgerB.perMaker]) {
    const uRec = ledgerUnion.perMaker.find((r) => r.maker === rec.maker);
    if (!uRec || uRec.rebateMu < rec.rebateMu || uRec.fills < rec.fills) return false;
  }
  return true;
}
