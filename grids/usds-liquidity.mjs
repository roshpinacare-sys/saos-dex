#!/usr/bin/env node
/**
 * usds-liquidity.mjs — גל-#82 · מסילת-הפעלת-נזילות-USDS אמת (owner directive §3 · trace 1a178c614313ad05)
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * המנדט: "ACTIVATE REAL USDS LIQUIDITY PAIRS: Inject active USDS liquidity sides into
 * saos-dex AMM pools". המדידה-החיה (kernel.ts:908-913 ג'נזיס · kernel.ts:62 ·
 * db/state-snapshot.json @h1753690): USDS/WSBD **נשאב-חי עד rb=1µ** (מת),
 * USDS/WSTEEM חי-דק (455,100µ) על-העוגן, SAOS/USDS בריא (~100Mµ). האוצר מחזיק USDS
 * אמת (מס-שירות נמדד 1,525.546 USDS בספר-הכלכלה) — אבל הצף-החופשי בגרעין זעיר.
 *
 * החלטת-אופ-הגרעין (נבדקה-מול-הקוד-החי, לא-מומצאת): משפחת-ה-nourish **קיימת** בגרעין —
 *   · pool_open  (kernel.ts:2098, Roast-71) — יצירת-בריכה-ריבונית דו-צדדית מהאוצר;
 *   · pool_reseed (kernel.ts:2192, G76-a) — החייאת-בריכה-מתה דו-צדדית-על-העוגן
 *     (הרזרבות-הישנות חוזרות-לאוצר, LP-אוצר נשרף-ונולד √k, זריעה מצף-חופשי בלבד);
 *   · pool_add   (amm.ts:54) — העמקה שומרת-יחס מהאוצר (dust/insufficient fail-closed);
 *   · pool_repeg (kernel.ts:2148, R26) — סימון-מחדש-על-העוגן (שייך-לפעימה cloud-beat).
 * לכן **אין-אופ-גרעין-חדש**: pool_nourish היה משכפל את pool_add/שלשת-האחים ומפר את
 * דוקטרינת-אין-הפעלה-כפולה. המסילה הזו מכינה-פיילודים לאופים-הקיימים בלבד.
 *
 * שכבות-בטיחות (אותו-חוק של grids/liquidity-bootstrap.mjs):
 *   1. Dry-run ברירת-מחדל — מדפיס טבלת-בריכות-מדודה + תוכנית-דלתא + כותב קבלה; נוגע
 *      רק בקובץ-הקבלה המקומי (grids/state — מישור-הפרסום), אף-פוסט למנוע.
 *   2. קובץ-חימוש של-הבעלים בלבד: grids/usds-arm.json (SAOS-USDS-LIQUIDITY-ARM/1).
 *      חסר = סירוב-כן exit 0 (הסירוב הוא-ההצלחה-על-פי-תכנון). פגום/פרוטוקול-זר/
 *      שדה-זר/זוג-מחוץ-לרשימה-הלבנה = exit 2 fail-closed.
 *   3. רשימה-לבנה קנונית (מנדט-הבעלים): SAOS/USDS · WSTEEM/USDS · USDS/WSBD —
 *      בריכה-חדשה נפתחת רק לזוגות-אלה; שאר-הזוגות נמדדים-ומתפרסמים-בכנות בלבד.
 *   4. תכנון-בלבד-מהצף: כל-דלתא נבדקת מול avail-האוצר (יתרה פחות נעולות — אותו-חוק
 *      של kernel avail); אין-הטבעה, אין-שליליים, שלמים-בלבד. חסם = פרסום-כן, לא-שקר.
 *   5. --execute חייב: מצב-מנוע-חי (לא-סנאפשוט — אין-תכנון-על-ספק) + טוקן-מפעיל
 *      (env DEX_OPERATOR_TOKEN או כספת /home/z/coord-work/vault/operator-token —
 *      תפר-גל-80) בכותרת x-saos-operator + x-saos-dex-console:1 (operator-auth.ts +
 *      guard.ts). read-after-write: הצד-USDS חייב לגדול אל-היעד — אחרת עצירה fail-closed.
 *   6. מנוע-נעדר → קבלה-כנה engineUnreachable=true, אפס-מספרים-מומצאים (עמודות-ריקות),
 *      או נפילה-מדודה-לסנאפשוט-המסומן (db/state-snapshot.json — מקור-אמת, מיושן-מסומן).
 *
 * שימוש: node grids/usds-liquidity.mjs [--execute] [--arm נתיב] [--receipt נתיב]
 *           [--state נתיב-סנאפשוט] [--engine URL]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

/* ── חוקי-פרוטוקול ────────────────────────────────────────────────────────────── */
export const ARM_PROTOCOL = "SAOS-USDS-LIQUIDITY-ARM/1";
export const RECEIPT_PROTOCOL = "SAOS-USDS-LIQUIDITY/1";
/** רשימה-לבנה קנונית — מנדט-הבעלים (trace 1a178c614313ad05 §3): בריכה-חדשה רק-אלה.
 * צורה-קנונית (מיון-אלפביתי של poolKey — kernel.ts:814): SAOS<USDS, USDS<WSTEEM, USDS<WSBD. */
export const NOURISH_PAIRS = ["SAOS/USDS", "USDS/WSTEEM", "USDS/WSBD"];
/** שער-ה"בריכה-מתה" — אותו-חוק של POOL_RESEED_TRIGGER_BPS בגרעין (kernel.ts:379). */
export const RESERVE_RESEED_TRIGGER_BPS = 10_000;
/** רצועת-העוגן — אותו-חוק R26-ALL של usds-activation.ts (USDS_ANCHOR_BAND_BPS). */
export const ANCHOR_BAND_BPS = 1_000;
/** גיל-סנאפשוט-מרבי לפני-סימון-מיושן (סנאפשוט-מיושן = מדידה-כנה, לא-בסיס-לביצוע). */
export const STALE_SNAPSHOT_MS = 2 * 3_600_000;
/** החלטת-אופ-הגרעין — מתפרסמת-בכל-קבלה (שקיפות-היא-המוצר). */
export const KERNEL_OP_DECISION =
  "existing kernel op family covers nourish: pool_open (kernel.ts:2098) + pool_reseed (kernel.ts:2192, dead-pool revival on anchor) + pool_add (amm.ts:54, ratio-preserving deepening) + pool_repeg (kernel.ts:2148, beat-owned) — no new kernel op (pool_nourish would duplicate pool_add and violate the no-double-activation doctrine)";

/* ── פרימיטיבים-קנוניים — אותן-נוסחאות בדיוק של הגרעין (שלמים-בלבד, אפס-float) ── */
/** poolKey של הגרעין (kernel.ts:814): מיון-אלפביתי קובע צד-שמאל/ימין. */
export const canonPair = (a, b) => [a, b].sort().join("/");
/** avail של הגרעין: יתרה פחות נעולות (kernel.ts — balances/locked). */
export function availMu(st, who, asset) {
  const bal = st?.balances?.[who]?.[asset] ?? 0;
  const lock = st?.locked?.[who]?.[asset] ?? 0;
  return bal - lock;
}
/** מחיר-אמצע-גרעיני: mµ-של-a ל-1 יחידת-b (kernel poolMid משפחה: floor(ra×1000/rb)). */
const midOf = (p) => (p.rb > 0 ? Math.floor((p.ra * 1000) / p.rb) : 0);
const anchorMidOf = (refA, refB) => (refA > 0 ? Math.floor((refB * 1000) / refA) : 0);
const premBpsOf = (mid, anchor) =>
  mid > 0 && anchor > 0 ? Math.floor(((mid - anchor) * 10_000) / anchor) : mid > 0 ? 0 : RESERVE_RESEED_TRIGGER_BPS;

/** צד-USDS של בריכה: מזוהה לפי-שם-הנכס (a/b אחרי-המיון), לא לפי-ניחוש-כיוון. */
export function usdsSideOf(pool) {
  if (!pool) return { side: null, mu: 0, asset: null };
  if (pool.a === "USDS") return { side: "a", mu: pool.ra, asset: "USDS" };
  if (pool.b === "USDS") return { side: "b", mu: pool.rb, asset: "USDS" };
  return { side: null, mu: 0, asset: null };
}

/** מדידת-בריכה — חוות-דעת כנה: missing/no-anchor/dead/off-anchor/thin/healthy. */
export function poolFacts(st, pair, minUsdsSideMu = 0) {
  const key = canonPair(...pair.split("/"));
  const p = st?.pools?.[key] ?? null;
  if (!p) return { key, present: false, a: null, b: null, ra: 0, rb: 0, usdsSide: null, usdsSideMu: 0, mid: 0, anchorMid: 0, premBps: 0, raRepeg: 0, verdict: "missing" };
  const refA = st?.assets?.[p.a]?.refPrice ?? 0;
  const refB = st?.assets?.[p.b]?.refPrice ?? 0;
  const usds = usdsSideOf(p);
  const mid = midOf(p);
  const anchorMid = anchorMidOf(refA, refB);
  const premBps = premBpsOf(mid, anchorMid);
  const raRepeg = refA > 0 ? Math.floor((refB * p.rb) / refA) : 0;
  let verdict;
  if (!(refA > 0) || !(refB > 0)) verdict = "no-anchor";
  else if (!(p.ra > 0) || !(p.rb > 0) || raRepeg <= 0 || Math.abs(premBps) >= RESERVE_RESEED_TRIGGER_BPS) verdict = "dead";
  else if (Math.abs(premBps) >= ANCHOR_BAND_BPS) verdict = "off-anchor";
  else if (usds.side && usds.mu < minUsdsSideMu) verdict = "thin";
  else verdict = "healthy";
  return { key, present: true, a: p.a, b: p.b, ra: p.ra, rb: p.rb, usdsSide: usds.side, usdsSideMu: usds.mu, mid, anchorMid, premBps, raRepeg, verdict };
}

/* ── גזירת-זרע-על-העוגן (חוק-הגרעין: seedA === floor(seedB×refB/refA)) ────────── */
/** צד-חופשי = canon-b (הגזירה-הקרנלית נולדת-מ-b); צד-a נגזר-מדויק. */
function deriveSeedA(seedB, refA, refB) {
  return refA > 0 ? Math.floor((refB * seedB) / refA) : 0;
}
/** צד-a נתון (USDS=cannon-a) → מוצאים seedB המינימלי שמקיים-את-חוק-העוגן בדיוק.
 * מונוטוני — מתחילים-מהאידיאל floor(seedA×refA/refB) ומטפסים; תקרה-חתומה-כנה. */
function solveSeedB(seedA, refA, refB) {
  if (!(refA > 0) || !(refB > 0) || !(seedA > 0) || !Number.isSafeInteger(seedA * refA)) return null;
  let seedB = Math.floor((seedA * refA) / refB);
  for (let i = 0; i < 4096 && seedB > 0; i++) {
    if (deriveSeedA(seedB, refA, refB) === seedA) return seedB;
    seedB += 1;
  }
  return null; // כנות: אין-זרע-על-העוגן בטווח-סביר — האופ נחסם, לא-מומצא
}

/* ── תוכנית-ההעמקה — דלתא-מינימלית מתוך-צף-האוצר (טהורה, דטרמיניסטית) ─────────── */
function planOne(st, cfg) {
  const min = cfg.minUsdsSideMu;
  const f = poolFacts(st, cfg.pair, min);
  const row = { pair: f.key, verdict: f.verdict, action: "none", executable: false, blocked: [], usdsSideMu: f.usdsSideMu, targetUsdsMu: min, deltaUsds: 0, op: null };
  if (f.verdict === "missing") {
    row.action = "open";
    row.deltaUsds = min;
    if (!NOURISH_PAIRS.includes(f.key)) { row.blocked.push(`pair-not-whitelisted(${f.key})`); return row; }
    const refA = st?.assets?.[f.key.split("/")[0]]?.refPrice ?? 0;
    const refB = st?.assets?.[f.key.split("/")[1]]?.refPrice ?? 0;
    if (!(refA > 0) || !(refB > 0)) { row.blocked.push("no-anchor"); return row; }
    // זריעה-על-העוגן: ערך-שווה שני-הצדדים (amountA×refA = amountB×refB)
    const usdsIsA = f.key.split("/")[0] === "USDS";
    const a = usdsIsA ? min : deriveSeedA(min, refA, refB);
    const b = usdsIsA ? Math.floor((min * refA) / refB) : min;
    if (!(a > 0) || !(b > 0)) { row.blocked.push("seed-dust"); return row; }
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) { row.blocked.push("seed-overflow"); return row; }
    if (availMu(st, "treasury", f.key.split("/")[0]) < a || availMu(st, "treasury", f.key.split("/")[1]) < b) {
      row.blocked.push(`insufficient-treasury: need ${f.key.split("/")[0]}+${a}µ/${f.key.split("/")[1]}+${b}µ free`);
      return row;
    }
    row.executable = true;
    row.op = {
      kind: "open", pair: f.key, targetUsdsMu: min, deltaUsds: min,
      route: "/api/dex/pool",
      body: { action: "open", pair: f.key, amountA: a, amountB: b, issuer: "treasury" },
      payload: { type: "pool_open", issuer: "treasury", pair: f.key, amount: a, amountB: b },
      derivedB: b, seedA: a, seedB: b,
    };
    return row;
  }
  if (f.verdict === "dead") {
    row.action = "reseed";
    const refA = st?.assets?.[f.a]?.refPrice ?? 0;
    const refB = st?.assets?.[f.b]?.refPrice ?? 0;
    if (!(refA > 0) || !(refB > 0)) { row.blocked.push("no-anchor"); return row; }
    if (!(min > 0)) { row.blocked.push("seed-dust(arm-min=0)"); return row; } // מדידה-בלי-יעד: הזריעה-עצמה נשמרת-לבעלים
    const usdsIsA = f.a === "USDS";
    let seedA, seedB;
    if (usdsIsA) { seedA = min; seedB = solveSeedB(min, refA, refB); }
    else { seedB = min; seedA = deriveSeedA(min, refA, refB); }
    row.deltaUsds = Math.max(0, min - f.usdsSideMu);
    if (!(seedA > 0) || !(seedB > 0)) { row.blocked.push(usdsIsA ? "seed-anchor-unreachable" : "seed-dust(no-anchor)"); return row; }
    if (!Number.isSafeInteger(seedA) || !Number.isSafeInteger(seedB)) { row.blocked.push("seed-overflow"); return row; }
    // חוק-העוגן-הקרנלי: seedA === floor(seedB×refB/refA) — נאכף-כאן לפני-הפיילוד
    if (seedA !== deriveSeedA(seedB, refA, refB)) { row.blocked.push("off-anchor-seed"); return row; }
    // הרזרבות-הישנות חוזרות-לאוצר תחילה — הנטו הוא-מה-שנבדק (אותו-חוק של הגרעין)
    const needA = Math.max(0, seedA - f.ra);
    const needB = Math.max(0, seedB - f.rb);
    if (availMu(st, "treasury", f.a) < needA || availMu(st, "treasury", f.b) < needB) {
      row.blocked.push(`insufficient-treasury: need ${f.a}+${needA}µ/${f.b}+${needB}µ free (reserves return first)`);
      return row;
    }
    row.executable = true;
    row.op = {
      kind: "reseed", pair: f.key, targetUsdsMu: min, deltaUsds: row.deltaUsds,
      route: "/api/dex/batch",
      body: { issuer: "treasury", ops: [{ type: "pool_reseed", pair: f.key, amount: seedA, amountB: seedB }] },
      payload: { type: "pool_reseed", issuer: "treasury", pair: f.key, amount: seedA, amountB: seedB },
      seedA, seedB,
    };
    return row;
  }
  if (f.verdict === "off-anchor") {
    row.action = "skip";
    row.blocked.push("off-anchor — pool_repeg is the beat's op (cloud-beat R26-ALL); the grid lane never double-activates a wrong price");
    return row;
  }
  if (f.verdict === "no-anchor") {
    row.action = "skip";
    row.blocked.push("no-anchor — oracle refPrice missing on one side; quoting through it would be a lie");
    return row;
  }
  if (f.verdict === "thin") {
    row.action = "add";
    const delta = min - f.usdsSideMu;
    row.deltaUsds = delta;
    if (!(delta > 0)) { row.action = "none"; return row; }
    const usdsIsA = f.a === "USDS";
    let amount, derivedB;
    if (usdsIsA) {
      amount = delta; // מוסיפים USDS ישירות (צד-a) — הגרעין גוזר את-b שומר-יחס
      derivedB = f.ra > 0 ? Math.floor((f.rb * amount) / f.ra) : 0;
    } else {
      // USDS=צד-b: מינימום-שלמים בצד-a כך-שהגזירה floor(rb×amount/ra) ≥ delta
      amount = Math.floor((delta * f.ra + f.rb - 1) / f.rb);
      derivedB = f.ra > 0 ? Math.floor((f.rb * amount) / f.ra) : 0;
    }
    if (!(amount > 0) || !(derivedB > 0)) { row.blocked.push("dust-add"); return row; }
    if (!Number.isSafeInteger(amount * f.ra) || !Number.isSafeInteger(amount) || !Number.isSafeInteger(derivedB)) { row.blocked.push("delta-math-overflow"); return row; }
    if (availMu(st, "treasury", f.a) < amount || availMu(st, "treasury", f.b) < derivedB) {
      row.blocked.push(`insufficient-treasury: need ${f.a}+${amount}µ/${f.b}+${derivedB}µ free`);
      return row;
    }
    row.executable = true;
    row.op = {
      kind: "add", pair: f.key, targetUsdsMu: min, deltaUsds: delta,
      route: "/api/dex/pool",
      body: { action: "add", pair: f.key, amountA: amount, issuer: "treasury" },
      payload: { type: "pool_add", issuer: "treasury", pair: f.key, amount },
      derivedB,
    };
    return row;
  }
  return row; // healthy — אידמפוטנטי: אפס-פעולה
}

/** התוכנית-המלאה: שורה-מדודה לכל-זוג-מחומש + רק-האופים-הברי-ביצוע ב-plan (op-cap נאכף). */
export function nourishPlan(st, armDoc) {
  const cap = armDoc.maxOpPerRun;
  const rows = [], plan = [], skipped = [];
  for (const cfg of armDoc.pools) {
    const row = planOne(st, cfg);
    if (row.op) {
      if (plan.length < cap) plan.push(row.op);
      else { row.executable = false; row.blocked.push(`op-cap(maxOpPerRun=${cap}) — the run never pours the whole float at once`); skipped.push({ pair: row.pair, reason: `op-cap(maxOpPerRun=${cap})` }); }
    } else if (row.action === "skip" || row.blocked.length > 0) {
      skipped.push({ pair: row.pair, reason: row.blocked.join(" | ") || row.verdict });
    }
    rows.push({ pair: row.pair, verdict: row.verdict, action: row.action, usdsSideMu: row.usdsSideMu, targetUsdsMu: row.targetUsdsMu, deltaUsds: row.deltaUsds, executable: row.executable, blocked: row.blocked });
  }
  const counts = {
    healthy: rows.filter((r) => r.verdict === "healthy").length,
    thin: rows.filter((r) => r.verdict === "thin").length,
    offAnchor: rows.filter((r) => r.verdict === "off-anchor").length,
    dead: rows.filter((r) => r.verdict === "dead").length,
    missing: rows.filter((r) => r.verdict === "missing").length,
    noAnchor: rows.filter((r) => r.verdict === "no-anchor").length,
    executable: plan.length,
    skipped: skipped.length,
  };
  return { pools: rows, plan, skipped, counts };
}

/* ── קובץ-החימוש של-הבעלים — אותו-חוק fail-closed של liquidity-bootstrap ──────── */
export function loadArm(armPath) {
  if (!existsSync(armPath)) return { present: false, ok: false, errors: [`arm file missing at ${armPath} — the lane refuses honestly (refusal = success by design)`] };
  try {
    const j = JSON.parse(readFileSync(armPath, "utf8"));
    const errors = [];
    if (j.protocol !== ARM_PROTOCOL) errors.push(`foreign arm protocol '${String(j.protocol)}' — expected ${ARM_PROTOCOL}`);
    if (!Array.isArray(j.pools) || j.pools.length === 0 || j.pools.length > 8) errors.push("pools must be a non-empty array (1..8)");
    else {
      const seen = new Set();
      for (const p of j.pools) {
        if (!p || typeof p !== "object") { errors.push("pool entry must be an object"); continue; }
        for (const k of Object.keys(p)) if (!["pair", "minUsdsSideMu"].includes(k)) errors.push(`foreign pool field '${k}' — fail-closed`);
        const key = typeof p.pair === "string" && p.pair.includes("/") ? canonPair(...p.pair.split("/")) : null;
        if (!key || !NOURISH_PAIRS.includes(key)) { errors.push(`pair '${String(p.pair)}' not-whitelisted (owner mandate: ${NOURISH_PAIRS.join(" · ")})`); continue; }
        if (seen.has(key)) errors.push(`duplicate pool pair '${key}'`);
        seen.add(key);
        if (!Number.isInteger(p.minUsdsSideMu) || p.minUsdsSideMu < 1 || p.minUsdsSideMu > 1e12) errors.push(`minUsdsSideMu for ${key} must be an integer in [1, 1e12]`);
      }
    }
    if (!Number.isInteger(j.maxOpPerRun) || j.maxOpPerRun < 1 || j.maxOpPerRun > 12) errors.push("maxOpPerRun must be an integer in [1, 12]");
    if (typeof j.note !== "string" || j.note.trim().length < 8) errors.push("note must carry the documented owner authority (trace/id) — a bare word refuses");
    if (j.sealedAt !== undefined && (typeof j.sealedAt !== "string" || !Number.isFinite(Date.parse(j.sealedAt)))) errors.push("sealedAt, when present, must be ISO");
    for (const k of Object.keys(j)) if (!["protocol", "sealedAt", "pools", "maxOpPerRun", "note"].includes(k)) errors.push(`foreign arm field '${k}' — fail-closed`);
    return { present: true, ok: errors.length === 0, errors, doc: errors.length === 0 ? j : null };
  } catch (e) {
    return { present: true, ok: false, errors: [`arm file unreadable/malformed: ${String(e?.message ?? e).slice(0, 120)}`] };
  }
}

/* ── קבלה — SAOS-USDS-LIQUIDITY/1 (אפס-סודות · אפס-מספרים-מומצאים) ───────────── */
const LAW = {
  kernelOps: "pool_open (kernel.ts:2098 Roast-71) · pool_reseed (kernel.ts:2192 G76-a dead-pool revival on anchor) · pool_add (amm.ts:54 ratio-preserving) · pool_repeg (kernel.ts:2148 R26, beat-owned)",
  kernelOpDecision: KERNEL_OP_DECISION,
  armLaw: "grids/liquidity-bootstrap.mjs law: arm file missing = honest refusal exit 0; malformed/foreign = exit 2 fail-closed",
  operatorSeam: "src/lib/operator-auth.ts x-saos-operator == DEX_OPERATOR_TOKEN (timing-safe) + src/lib/dex/guard.ts x-saos-dex-console: 1; token from env or the wave-80 vault file — never logged, never serialized",
  plansOnly: "the grid box prepares payloads and publishes receipts; real broadcast happens where the engine lives (engine-side submitOp), gated by the owner arm + operator token",
  units: "µ = micro-units · mid = mµ-of-a per 1 unit b (kernel poolMid orientation) · refPrice = mµ-USDS per 1 unit",
};

function buildReceipt({ generatedAt, engineUnreachable, source, st, planRes, planGatedBy, executed, executedSkipped }) {
  // צף-האוצר נמדד לכל-נכס-שנוגע לזוגות-בטבלה (שקיפות מלאה, אפס-המצאה)
  const assets = new Set();
  for (const row of planRes.pools) {
    const f = poolFacts(st, row.pair, row.targetUsdsMu);
    if (f.a) assets.add(f.a);
    if (f.b) assets.add(f.b);
  }
  const floatMu = {};
  for (const a of [...assets].sort()) floatMu[a] = availMu(st, "treasury", a);
  return {
    protocol: RECEIPT_PROTOCOL,
    generatedAt,
    trace: "1a178c614313ad05",
    wave: "#82",
    engineUnreachable,
    source,
    treasury: { floatMu, note: "avail = balance − locked (kernel law); the free float is the ONLY funding source — no minting, no negatives" },
    pools: planRes.pools.map((r) => {
      const f = poolFacts(st, r.pair, r.targetUsdsMu);
      return { key: f.key, ra: f.ra, rb: f.rb, usdsSideMu: f.usdsSideMu, mid: f.mid, anchorMid: f.anchorMid, premBps: f.premBps, verdict: f.verdict, usdsSide: f.usdsSide };
    }),
    plan: planRes.plan,
    planGatedBy: planGatedBy ?? null,
    executed,
    executedSkipped,
    skipped: planRes.skipped,
    counts: planRes.counts,
    law: LAW,
  };
}

/* ── ברירות-מחדל של-io — המדידה-החיה (מנוע :3010) ונפילה-מדודה-לסנאפשוט ───────── */
async function defaultFetchState(engineUrl) {
  try {
    const r = await fetch(`${engineUrl}/api/dex/state`, { signal: AbortSignal.timeout(4000), headers: { "User-Agent": "grids-usds-liquidity" } });
    if (!r.ok) return null;
    const j = await r.json();
    const st = j?.state;
    return st && typeof st === "object" && st.pools && st.balances && st.assets ? st : null;
  } catch { return null; } // כנות: המנוע-נעדר — לא-שקר, לא-המצאה
}
function defaultReadSnapshot(statePath) {
  try {
    if (!existsSync(statePath)) return null;
    const j = JSON.parse(readFileSync(statePath, "utf8"));
    const st = j?.state;
    return st && typeof st === "object" && st.pools && st.balances && st.assets && typeof j.savedAt === "string"
      ? { savedAt: j.savedAt, state: st }
      : null;
  } catch { return null; }
}
async function defaultPostOp(url, body, token) {
  try {
    const r = await fetch(url, {
      method: "POST", signal: AbortSignal.timeout(8000),
      headers: { "content-type": "application/json", "x-saos-dex-console": "1", "x-saos-operator": token },
      body: JSON.stringify(body),
    });
    const json = await r.json().catch(() => ({}));
    return { ok: r.ok && json?.ok !== false, status: r.status, json };
  } catch (e) { return { ok: false, status: 0, json: { error: String(e?.message ?? e).slice(0, 120) } }; }
}
function readVaultToken(vaultTokenPath) {
  try {
    if (!vaultTokenPath || !existsSync(vaultTokenPath)) return null;
    const raw = readFileSync(vaultTokenPath, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch { return null; }
}
/** מקבל-מצב סובלני: מעטפת {state} (כמו /api/dex/state) או מצב-גולמי — שניהם כשרים. */
function unwrapState(x) {
  if (x && typeof x === "object" && x.pools && x.balances && x.assets) return x;
  if (x && typeof x === "object" && x.state && x.state.pools && x.state.balances && x.state.assets) return x.state;
  return null;
}

/* ── הרצה ─────────────────────────────────────────────────────────────────────── */
/**
 * @param {object} opts
 * @param {boolean} [opts.execute]     ברירת-מחדל dry-run (מדידה+תוכנית+קבלה; אף-פוסט)
 * @param {string}  [opts.armPath]     קובץ-החימוש (ברירת-מחדל grids/usds-arm.json)
 * @param {string}  [opts.receiptPath] קבלה (ברירת-מחדל grids/state/usds-liquidity-state.json)
 * @param {string}  [opts.statePath]   סנאפשוט-מדוד (ברירת-מחדל db/state-snapshot.json)
 * @param {string}  [opts.engineUrl]   המנוע-החי (ברירת-מחדל env SAOS_DEX_ENGINE_URL || http://127.0.0.1:3010)
 * @param {string}  [opts.vaultTokenPath] כספת-הטוקן (ברירת-מחדל /home/z/coord-work/vault/operator-token)
 * @param {object}  [opts.io]          הזרקה ל-selftest: {fetchState, readSnapshot, postOp}
 * @param {number}  [opts.now]         זמן-נתון לדטרמיניזם-במבחנים
 */
export async function runUsdsLiquidity(opts = {}) {
  const execute = !!opts.execute;
  const nowIso = new Date(typeof opts.now === "number" ? opts.now : Date.now()).toISOString();
  const armPath = opts.armPath ? resolve(opts.armPath) : join(HERE, "usds-arm.json");
  const receiptPath = opts.receiptPath ? resolve(opts.receiptPath) : join(HERE, "state", "usds-liquidity-state.json");
  const statePath = opts.statePath ? resolve(opts.statePath) : join(REPO, "db", "state-snapshot.json");
  const engineUrl = opts.engineUrl ?? process.env.SAOS_DEX_ENGINE_URL ?? "http://127.0.0.1:3010";
  const vaultTokenPath = opts.vaultTokenPath ?? "/home/z/coord-work/vault/operator-token";
  const statePathDisplay = statePath.startsWith(REPO + "/") ? statePath.slice(REPO.length + 1) : statePath; // קבלות נושאות נתיב-יחס-לריפו (ארטיפקט-נייד)
  const io = {
    fetchState: opts.io?.fetchState ?? (() => defaultFetchState(engineUrl)),
    readSnapshot: opts.io?.readSnapshot ?? (() => defaultReadSnapshot(statePath)),
    postOp: opts.io?.postOp ?? ((route, body, token) => defaultPostOp(`${engineUrl}${route}`, body, token)),
  };
  const ioProvided = !!opts.io;
  const res = { exit: 0, refused: null, engineUnreachable: false, source: null, pools: [], plan: [], executed: [], executedSkipped: [], receiptWritten: false };

  /* 1) קובץ-החימוש — החוק: חסר = סירוב-כן exit 0 · פגום = exit 2 */
  const arm = loadArm(armPath);
  if (!arm.present) {
    res.refused = `arm file missing (${armPath}) — ${arm.errors[0]}`;
    if (!execute) {
      // מדידה מתפרסמת גם-בלי-חימוש (שקיפות); התוכנית עצמה נשמרת-לבעלים
      const stLive = unwrapState(await io.fetchState());
      const snap = stLive ? null : await io.readSnapshot();
      const st = stLive ?? snap?.state ?? null;
      res.engineUnreachable = !stLive;
      res.source = stLive ? { kind: ioProvided ? "injected" : "engine", url: engineUrl, height: st.height ?? null }
        : snap ? { kind: "repo-snapshot", path: statePathDisplay, savedAt: snap.savedAt, stale: true, note: "live engine unreachable — measured snapshot published honestly" }
        : { kind: "none", note: "no engine, no snapshot — zero fabricated numbers" };
      if (st) {
        // מדידה לכל-הרשימה-הלבנה ביעד-אפס: הטבלה-המדודה מתפרסמת; התוכנית עצמה נשמרת-לבעלים
        const planRes = nourishPlan(st, { pools: NOURISH_PAIRS.map((pair) => ({ pair, minUsdsSideMu: 0 })), maxOpPerRun: 1 });
        const receipt = buildReceipt({ generatedAt: nowIso, engineUnreachable: !stLive, source: res.source, st, planRes, planGatedBy: "arm file missing (SAOS-USDS-LIQUIDITY-ARM/1) — measurement published, delta plan withheld until the owner arms the lane", executed: [], executedSkipped: [] });
        try { mkdirSync(dirname(receiptPath), { recursive: true }); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n"); res.receiptWritten = true; } catch { /* כתיבה-נכשלה — הפרסום נשאר בפלט */ }
        res.pools = receipt.pools; res.plan = []; res.exit = 0;
      }
    }
    return res;
  }
  if (!arm.ok) { res.refused = `arm file REJECTED: ${arm.errors.join(" | ")}`; res.exit = 2; return res; }

  /* 2) המצב-החי — קריאה-לפני-כתיבה; execute לעולם לא על-ספק */
  const stLive = unwrapState(await io.fetchState());
  let st = stLive, snap = null;
  if (!stLive) {
    snap = await io.readSnapshot();
    st = snap?.state ?? null;
  }
  res.engineUnreachable = !stLive;
  if (!st) {
    res.source = { kind: "none", note: "no engine, no snapshot — zero fabricated numbers" };
    if (execute) { res.refused = "live engine unreachable and no measured snapshot — refusing to execute on doubt (fail-closed)"; res.exit = 1; return res; }
    // אפס-שורות-אפסים: בלי-מדידה אין-טבלה — שורות-אפס היו נראות-כמו-מדידה. כנות = ריק.
    const planRes = { pools: [], plan: [], skipped: [], counts: { healthy: 0, thin: 0, offAnchor: 0, dead: 0, missing: 0, noAnchor: 0, executable: 0, skipped: 0 } };
    const receipt = buildReceipt({ generatedAt: nowIso, engineUnreachable: true, source: res.source, st: { pools: {}, balances: {}, locked: {}, assets: {} }, planRes, planGatedBy: "engine unreachable — empty measured table, zero fabricated numbers", executed: [], executedSkipped: [] });
    try { mkdirSync(dirname(receiptPath), { recursive: true }); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n"); res.receiptWritten = true; } catch { /* non-fatal */ }
    return res;
  }
  res.source = stLive
    ? { kind: ioProvided ? "injected" : "engine", url: engineUrl, height: st.height ?? null }
    : { kind: "repo-snapshot", path: statePathDisplay, savedAt: snap.savedAt, stale: Date.now() - Date.parse(snap.savedAt) > STALE_SNAPSHOT_MS, note: "live engine unreachable — measured snapshot published honestly (never a basis for --execute)" };

  /* 3) התוכנית — דלתא-מינימלית מצף-האוצר, op-cap נאכף */
  const planRes = nourishPlan(st, arm.doc);
  res.pools = planRes.pools; res.plan = planRes.plan;

  if (planRes.plan.length === 0) {
    const receipt = buildReceipt({ generatedAt: nowIso, engineUnreachable: !stLive, source: res.source, st, planRes, planGatedBy: null, executed: [], executedSkipped: [] });
    try { mkdirSync(dirname(receiptPath), { recursive: true }); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n"); res.receiptWritten = true; } catch { /* non-fatal */ }
    res.refused = planRes.skipped.length ? `nothing to deploy (delta-only): ${planRes.skipped.slice(0, 2).join(" | ")}` : "already at target depth — zero ops (idempotent)";
    return res;
  }
  if (!execute) {
    // dry-run כותב-קבלה (המדידה+התוכנית מתפרסמות) — אף-פוסט למנוע, אף-שינוי-מצב
    const receipt = buildReceipt({ generatedAt: nowIso, engineUnreachable: !stLive, source: res.source, st, planRes, planGatedBy: null, executed: [], executedSkipped: [] });
    try { mkdirSync(dirname(receiptPath), { recursive: true }); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n"); res.receiptWritten = true; } catch { /* non-fatal */ }
    res.refused = "dry-run — plan only, nothing posted (add --execute for real submission behind the operator seam)";
    return res;
  }

  /* 4) סנאפשוט = אסור-לבצע (מדידה-מיושנת אינה-בסיס-לכסף) */
  if (!stLive) { res.refused = "live engine unreachable — snapshot is measurement, never an execution basis (fail-closed)"; res.exit = 1; return res; }

  /* 5) טוקן-המפעיל — env תחילה, כספת-גל-80 אחר-כך; לעולם לא נדפס/נסריח */
  const token = (process.env.DEX_OPERATOR_TOKEN || "").trim() || readVaultToken(vaultTokenPath);
  if (!token) { res.refused = "no operator token (env DEX_OPERATOR_TOKEN empty + vault file absent) — mutations stay locked (fail-closed)"; res.exit = 1; return res; }

  /* 6) ביצוע + read-after-write פר-אופ — הצד-USDS חייב להגיע-אל-היעד */
  for (const op of planRes.plan) {
    const before = poolFacts(st, op.pair, op.targetUsdsMu);
    const r = await io.postOp(op.route, op.body, token);
    if (!r.ok) {
      res.executedSkipped.push({ kind: op.kind, pair: op.pair, reason: `post failed (HTTP ${r.status}): ${String(r.json?.error ?? "unknown").slice(0, 120)}` });
      res.exit = 1;
      break; // fail-closed: אין-המשך-עיוור אחרי-כישלון
    }
    const stAfter = unwrapState(await io.fetchState());
    if (!stAfter) {
      res.executedSkipped.push({ kind: op.kind, pair: op.pair, reason: "read-after-write: state refetch failed — fail-closed stop" });
      res.exit = 1;
      break;
    }
    const after = poolFacts(stAfter, op.pair, op.targetUsdsMu);
    if (after.usdsSideMu >= op.targetUsdsMu) {
      res.executed.push({ kind: op.kind, pair: op.pair, route: op.route, targetUsdsMu: op.targetUsdsMu, before: { usdsSideMu: before.usdsSideMu, ra: before.ra, rb: before.rb }, after: { usdsSideMu: after.usdsSideMu, ra: after.ra, rb: after.rb } });
      st = stAfter; // המדידה-החיה מתקדמת עם-הביצוע
    } else {
      res.executedSkipped.push({ kind: op.kind, pair: op.pair, reason: `read-after-write: USDS side ${before.usdsSideMu}→${after.usdsSideMu}µ did not reach target ${op.targetUsdsMu}µ — fail-closed stop` });
      res.exit = 1;
      break;
    }
  }

  /* 7) קבלה — המדידה-הסופית + מה-בוצע/מה-נעצר בכנות */
  const planResFinal = nourishPlan(st, arm.doc);
  const receipt = buildReceipt({ generatedAt: nowIso, engineUnreachable: false, source: res.source, st, planRes: planResFinal, planGatedBy: null, executed: res.executed, executedSkipped: res.executedSkipped });
  try { mkdirSync(dirname(receiptPath), { recursive: true }); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n"); res.receiptWritten = true; } catch { /* non-fatal */ }
  return res;
}

/* ── CLI ──────────────────────────────────────────────────────────────────────── */
if (process.argv[1] && process.argv[1].endsWith("usds-liquidity.mjs")) {
  const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };
  const execute = process.argv.includes("--execute");
  const opts = {
    execute,
    ...(process.argv.includes("--arm") ? { armPath: arg("--arm") } : {}),
    ...(process.argv.includes("--receipt") ? { receiptPath: arg("--receipt") } : {}),
    ...(process.argv.includes("--state") ? { statePath: arg("--state") } : {}),
    ...(process.argv.includes("--engine") ? { engineUrl: arg("--engine") } : {}),
  };
  const r = await runUsdsLiquidity(opts);
  if (r.refused) console.log(`usds-liquidity: ${r.refused}`);
  if (r.engineUnreachable) console.log("usds-liquidity: engineUnreachable=true — no fabricated numbers (honest receipt)");
  if (r.source) console.log(`usds-liquidity: source=${r.source.kind}${r.source.stale ? " (STALE — snapshot)" : ""}${r.source.height !== undefined && r.source.height !== null ? ` @h${r.source.height}` : ""}`);
  if (r.pools.length > 0) {
    console.log("usds-liquidity: measured pool table (µ · mid=mµ-of-a per 1 b):");
    for (const p of r.pools) {
      console.log(`  ${p.key.padEnd(14)} ra=${String(p.ra).padStart(12)} rb=${String(p.rb).padStart(12)} usdsSide(${p.usdsSide})=${String(p.usdsSideMu).padStart(12)} mid=${String(p.mid).padStart(10)} anchor=${String(p.anchorMid).padStart(10)} prem=${String(p.premBps).padStart(7)}bps ${p.verdict}`);
    }
  }
  for (const op of r.plan) console.log(`usds-liquidity: PLAN ${op.kind} ${op.pair} target=${op.targetUsdsMu}µ ${JSON.stringify(op.body)}`);
  for (const e of r.executed) console.log(`usds-liquidity: EXECUTED ${e.kind} ${e.pair} usdsSide ${e.before.usdsSideMu}→${e.after.usdsSideMu}µ (target ${e.targetUsdsMu})`);
  for (const s of r.executedSkipped) console.error(`usds-liquidity: STOPPED ${s.kind} ${s.pair} — ${s.reason}`);
  if (r.receiptWritten) console.log(`usds-liquidity: receipt written (${RECEIPT_PROTOCOL})`);
  process.exit(r.exit);
}
