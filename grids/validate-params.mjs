// VALIDATE-PARAMS — שומר-סף-פרמטרי-הגריד (fail-closed; 9-c · 2026-10-11)
// ════════════════════════════════════════════════════════════════════════════════════════
// החוק: פרמטרי-גריד (commit/levels/steps/floors) נכנסים למנוע רק דרך השומר-הזה.
// כל-חריגה מהפסיקה (rails), שדה-זר, פרוטוקול-זר, מספר-לא-סופי או קובץ-חסר =
// סירוב (exit 2) — פרמטרים רעים לעולם לא מדורגים לספר. אין-exception, אין-warn-and-continue.
//
// הפסיקה נגזרת מהמדידה-החיה (R99 + Z-80/Z-81 + 9-c):
//   · commitPct ≤ 0.95 — לעולם לא מתחייבים על הכל (גזירת-עומק לרענון/מילויים)
//   · levels ≤ 6 — לבטל/לפרוש יותר = שריפת-RC מדודה (29 ביטולים בביט-אחד, 6d6c169)
//   · bidStep ≥ 25bps — רצפת-מרווח מתחת-למגע (אין-ספאם-תור); askStep ≥ 10bps
//   · askMinRecvHbd ≥ 0.2 — חוק-גרעיניות-המחיר של R99 (מיל-צעד מעוות >0.5% מתחת לזה)
//   · parityBandBps ∈ [1000,10000] — ספר-שבור-מדי או רצועה-חסרת-תועלת — לא נסחר
//   · expiryDays ∈ [1,27] — תקרת-STEEM לתוקף-הזמנה
//
// שימוש:
//   import { validateParams } from "./validate-params.mjs";
//   const r = validateParams(doc);            // { ok: true, params, errors? }
//   node grids/validate-params.mjs [path]     // CLI: exit 0 תקין · exit 2 נדחה

export const PARAMS_PROTOCOL = "SAOS-GRID-PARAMS/1";

const CHAIN_KEYS = {
  steem: ["commitPct", "minKeepSteem", "minLevelSteem", "minLevelSbd", "bidLevels", "bidStepBps", "askLevels", "askStepBps", "parityBandBps", "expiryDays"],
  hive: ["commitPct", "minKeepHive", "minLevelHive", "minLevelHbd", "askMinRecvHbd", "bidLevels", "bidStepBps", "askLevels", "askStepBps", "parityBandBps", "expiryDays"],
};
const TOP_KEYS = ["protocol", "sealedAt", "sealedBy", "source", "rationale", "steem", "hive"];

/** מספר-סופי בדיוק (לא NaN, לא Infinity, לא מחרוזת-מספרית-שקרית) */
const finNum = (v) => typeof v === "number" && Number.isFinite(v);
const isInt = (v) => finNum(v) && Number.isInteger(v);

/**
 * הוולידטור-הטהור — אותה-פונקציה בדיוק ל-CLI, ל-grid-beat ול-selftest.
 * @param {unknown} doc  ה-JSON המפוענח (או null/undefined — נדחה)
 * @returns {{ ok: boolean, params?: object, errors: string[] }}
 */
export function validateParams(doc) {
  const errors = [];
  if (doc === null || doc === undefined || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, errors: ["params doc is not a JSON object — fail-closed"] };
  }
  for (const k of Object.keys(doc)) if (!TOP_KEYS.includes(k)) errors.push(`foreign top-level field '${k}' — fail-closed (unknown fields never deploy)`);
  if (doc.protocol !== PARAMS_PROTOCOL) errors.push(`foreign protocol '${String(doc.protocol)}' — expected ${PARAMS_PROTOCOL}`);
  const sealed = typeof doc.sealedAt === "string" ? Date.parse(doc.sealedAt) : NaN;
  if (!Number.isFinite(sealed)) errors.push("sealedAt missing or not an ISO timestamp");
  if (doc.rationale !== undefined) {
    const r = doc.rationale;
    if (r === null || typeof r !== "object" || Array.isArray(r) || !Object.values(r).every((v) => typeof v === "string")) {
      errors.push("rationale must be a plain object of documentation strings (never machine-read)");
    }
  }

  const params = {};
  for (const chain of ["steem", "hive"]) {
    const c = doc[chain];
    if (c === null || c === undefined || typeof c !== "object" || Array.isArray(c)) {
      errors.push(`missing '${chain}' section — fail-closed`);
      continue;
    }
    for (const k of Object.keys(c)) if (!CHAIN_KEYS[chain].includes(k)) errors.push(`foreign field '${chain}.${k}' — fail-closed`);
    const p = {};
    const get = (k) => c[k];

    // commitPct — (0, 0.95]
    const cp = get("commitPct");
    if (!finNum(cp) || cp <= 0 || cp > 0.95) errors.push(`${chain}.commitPct must be a finite number in (0, 0.95] — got ${JSON.stringify(cp)}`);
    else p.commitPct = cp;

    // levels — int [1, 6]
    for (const [k, label] of [["bidLevels", "bid"], ["askLevels", "ask"]]) {
      const v = get(k);
      if (!isInt(v) || v < 1 || v > 6) errors.push(`${chain}.${k} must be an integer in [1, 6] (RC cost of cancel+replace is measured) — got ${JSON.stringify(v)}`);
      else p[k] = v;
    }

    // steps — bid ≥25bps ≤1000 · ask ≥10bps ≤1000
    const bs = get("bidStepBps");
    if (!finNum(bs) || bs < 25 || bs > 1000) errors.push(`${chain}.bidStepBps must be a finite number in [25, 1000] (min spread floor below touch) — got ${JSON.stringify(bs)}`);
    else p.bidStepBps = bs;
    const as = get("askStepBps");
    if (!finNum(as) || as < 10 || as > 1000) errors.push(`${chain}.askStepBps must be a finite number in [10, 1000] — got ${JSON.stringify(as)}`);
    else p.askStepBps = as;

    // parity band — [1000, 10000]bps
    const pb = get("parityBandBps");
    if (!finNum(pb) || pb < 1000 || pb > 10000) errors.push(`${chain}.parityBandBps must be a finite number in [1000, 10000] — got ${JSON.stringify(pb)}`);
    else p.parityBandBps = pb;

    // expiry — int [1, 27]
    const ex = get("expiryDays");
    if (!isInt(ex) || ex < 1 || ex > 27) errors.push(`${chain}.expiryDays must be an integer in [1, 27] (STEEM order-expiry ceiling) — got ${JSON.stringify(ex)}`);
    else p.expiryDays = ex;

    // per-chain floors
    if (chain === "steem") {
      const mk = get("minKeepSteem");
      if (!finNum(mk) || mk < 0 || mk > 5) errors.push(`steem.minKeepSteem must be a finite number in [0, 5] — got ${JSON.stringify(mk)}`);
      else p.minKeepSteem = mk;
      const ml = get("minLevelSteem");
      if (!finNum(ml) || ml < 0.1) errors.push(`steem.minLevelSteem must be a finite number ≥ 0.1 (dust law) — got ${JSON.stringify(ml)}`);
      else p.minLevelSteem = ml;
      const ms = get("minLevelSbd");
      if (!finNum(ms) || ms < 0.01) errors.push(`steem.minLevelSbd must be a finite number ≥ 0.01 (dust law) — got ${JSON.stringify(ms)}`);
      else p.minLevelSbd = ms;
    } else {
      const mk = get("minKeepHive");
      if (!finNum(mk) || mk < 0 || mk > 1) errors.push(`hive.minKeepHive must be a finite number in [0, 1] — got ${JSON.stringify(mk)}`);
      else p.minKeepHive = mk;
      const ml = get("minLevelHive");
      if (!finNum(ml) || ml < 0.001) errors.push(`hive.minLevelHive must be a finite number ≥ 0.001 (R99 micro law) — got ${JSON.stringify(ml)}`);
      else p.minLevelHive = ml;
      const mb = get("minLevelHbd");
      if (!finNum(mb) || mb < 0.001) errors.push(`hive.minLevelHbd must be a finite number ≥ 0.001 (R99 mill-tick law) — got ${JSON.stringify(mb)}`);
      else p.minLevelHbd = mb;
      const ar = get("askMinRecvHbd");
      if (!finNum(ar) || ar < 0.2) errors.push(`hive.askMinRecvHbd must be a finite number ≥ 0.2 (R99 price-fidelity law — a level whose HBD mill-tick distortion exceeds 0.5% never counts) — got ${JSON.stringify(ar)}`);
      else p.askMinRecvHbd = ar;
    }
    params[chain] = p;
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, params: { protocol: doc.protocol, sealedAt: doc.sealedAt, sealedBy: doc.sealedBy ?? null, source: doc.source ?? null, steem: params.steem, hive: params.hive }, errors: [] };
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("validate-params.mjs")) {
  const path = process.argv[2] ?? new URL("./state/grid-params.json", import.meta.url).pathname;
  let doc;
  try {
    doc = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
  } catch (e) {
    console.error(`validate-params: params file unreadable at ${path} — fail-closed: ${String(e?.message ?? e).slice(0, 140)}`);
    process.exit(2);
  }
  const r = validateParams(doc);
  if (!r.ok) {
    console.error(`validate-params: REFUSED (${path}) — bad params can never deploy:`);
    for (const e of r.errors) console.error(`  ✗ ${e}`);
    process.exit(2);
  }
  console.log(`validate-params: OK (${path}) · protocol ${r.params.protocol} · sealedAt ${r.params.sealedAt}`);
  for (const chain of ["steem", "hive"]) {
    const p = r.params[chain];
    console.log(`  ${chain}: commit ${(p.commitPct * 100).toFixed(0)}% · levels ${p.bidLevels}x${p.askLevels} · steps ${p.bidStepBps}/${p.askStepBps}bps · parityBand ${p.parityBandBps}bps · expiry ${p.expiryDays}d`);
  }
  process.exit(0);
}
