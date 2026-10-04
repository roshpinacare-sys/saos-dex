// ENGINE-TRANSFERS (Z-90-c) — היסטוריית-העברות-ה-Engine: הנקודה-החלופית שסוגרת את-הפער-המדיד-האחרון-של-Z-89
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// המדידה-החיה (2026-10-04, מוקלדת-פעמיים כולל-Z-89): POST tokens:transfers find אל
// api.hive-engine.com מחזיר {"result":null} — בדיוק-כמו-טבלה-בלתי-קיימת; רשימת-הטבלאות
// המתועדת (hive-engine.github.io/engine-docs/tables) אינה מכילה transfers בכלל. הנתיב-החלופי
// שנמצא-ואומת-חי: חשבון-המנפיק graphene-swap קיים-על-HIVE (id 1373937) והוא חותם בעצמו את
// אופ-ההעברות-של-ה-Engine כ-custom_json (id "ssc-mainnet-hive", required_auths=[graphene-swap]) —
// כלומר ההיסטוריה-המלאה-של-הגשר יושבת-על-השרשרת עצמה דרך account_history_api.get_account_history
// (limit ≤ 1000 נמדד: 1500 → error; עימוד לאחור על-ידי start=firstIdx−1).
// בצד-בלרט: ההפקדות-מתועדות-בהיסטוריית-החשבונות עצמם — graphene-swap (שרשרת-מלאה: 32 אופ-ים
// בסך-הכל מאז 2020-07-28) ו-blurt-swap (נתיב-ההפקדות-הפעיל; היסטוריה-עמוקה, עמוד-אחרון ≈ 4 חודשים).
//
// החוק: מדידה-בלבד, חסר-מפתחות, אפס-סודות, fail-closed. הקצוות (haircut) מחושבים אך-ורק
// מזיווג-ראיות-מאומתות (הפקדת-בלרט ↔ זיכוי-Engine של אותו-משתמש, זרימה-בודדת, תוך-חלון-זמן)
// — אף-מספר לא מומצא; אין-זיווג → haircut:null עם-נימוק-כנה. תנאי-הגשר אינם-מאומתים-במסמך
// רשמי — הקבלה נושאת אזהרת-כנות תמידית "terms unverified — measured-only".

export const ENGINE_TRANSFERS_SCHEMA = "engine-transfers-v1";

export const ISSUER = "graphene-swap";      // מנפיק SWAP.BLURT ב-Engine + חשבון-הרזרבה-ההיסטורי-בבלרט (נמדד)
export const ACTIVE_BLURT_BRIDGE = "blurt-swap"; // נתיב-ההפקדות-והתשלומים-הפעיל-בבלרט (נמדד)
export const SYMBOL = "SWAP.BLURT";
export const SSC_OP_ID = "ssc-mainnet-hive";
export const PAGE_LIMIT = 1000;             // תקרה-נמדדה-חי: limit 1500 → error (api.hive.blog)
export const MAX_PAGES = 10;                // תקרת-עימוד-סבירה לסורק (עלות-מבוקרת ב-CI)
export const MAX_PAIR_DELAY_HOURS = 24;     // זיווג-זרימה-בודדת: זיכוי תוך-24h מההפקדה

export const HIVE_HISTORY_HOSTS = ["https://api.hive.blog", "https://api.deathwing.me"];
export const BLURT_HISTORY_HOSTS = ["https://blurt-rpc.saboin.com", "https://rpc.blurt.blog"];

export const HONESTY_NOTE = "bridge terms unverified — measured-only: every figure here is a live on-chain measurement, no fee is assumed and none is invented";

const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const dp6 = (v) => Math.round(v * 1e6) / 1e6;

/* ── פרסרים טהורים — צורות-חיות-שנמדדו; לעולם לא זורקים ───────────────────── */

/** שורת-היסטוריה של hived (condenser או account_history_api) → צורה-מנורמלת אחת. */
export function normalizeHistoryEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  const op = ev.op;
  let opType = null, value = null;
  if (Array.isArray(op) && op.length === 2) { opType = op[0]; value = op[1]; }
  else if (op && typeof op === "object") { opType = String(op.type ?? "").replace(/_operation$/, ""); value = op.value ?? null; }
  if (!opType) return null;
  return {
    opType,
    idx: null,
    ts: ev.timestamp ?? null,
    block: ev.block ?? null,
    virtual: !!ev.virtual_op,
    value: value && typeof value === "object" ? value : {},
  };
}

/** פרסר עמוד-Hive: account_history_api.get_account_history → שורות-מנורמלות + מטא. */
export function parseHiveIssuerPage(json) {
  const history = json?.result?.history;
  if (!Array.isArray(history)) return { rows: [], error: "no history array (fail-closed)" };
  const rows = [];
  for (const item of history) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const ev = normalizeHistoryEvent(item[1]);
    if (!ev) continue;
    ev.idx = num(item[0]) ?? null;
    if (ev.opType === "custom_json" && typeof ev.value.json === "string") {
      ev.customJsonId = ev.value.id ?? null;
      try { ev.json = JSON.parse(ev.value.json); } catch { ev.json = null; }
      const payload = ev.json?.contractPayload ?? {};
      // החוק-החי: המנפיק חותם → ה-"from" הוא required_auths[0] כאשר ה-payload אינו נושא from משלו
      const signer = Array.isArray(ev.value.required_auths) && ev.value.required_auths.length ? ev.value.required_auths[0] : null;
      ev.from = payload.from ?? signer;
      ev.to = payload.to ?? null;
      ev.symbol = payload.symbol ?? null;
      ev.quantity = num(payload.quantity);
      ev.quantityRaw = payload.quantity ?? null;
      ev.memo = payload.memo != null ? String(payload.memo) : null;
      ev.memoUser = memoUserFromCredit(ev.memo);
      ev.contractName = ev.json?.contractName ?? null;
      ev.contractAction = ev.json?.contractAction ?? null;
    }
    rows.push(ev);
  }
  return { rows, error: null };
}

/** פרסר עמוד-בלרט: condenser_api.get_account_history → שורות-מנורמלות. */
export function parseBlurtBridgePage(json) {
  const history = json?.result;
  if (!Array.isArray(history)) return { rows: [], error: "no result array (fail-closed)" };
  const rows = [];
  for (const item of history) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const ev = normalizeHistoryEvent(item[1]);
    if (!ev) continue;
    ev.idx = num(item[0]) ?? null;
    if (ev.opType === "transfer") {
      const amt = String(ev.value.amount ?? "");
      const m = amt.match(/^([\d.]+)\s+([A-Z]+)$/);
      ev.amount = m ? num(m[1]) : null;
      ev.asset = m ? m[2] : null;
      ev.from = ev.value.from ?? null;
      ev.to = ev.value.to ?? null;
      ev.memo = ev.value.memo != null ? String(ev.value.memo) : null;
    }
    rows.push(ev);
  }
  return { rows, error: null };
}

/* ── חלוקת-IN/OUT ביחס-למנפיק ─────────────────────────────────────────────── */

/** הפרדת שורות-Hive של-המנפיק: זיכויים (מהמנפיק — השלמת-הפקדה, צד-IN של הכלכלה),
 *  אל-המנפיק (שריפות-משתמש — חתימת-משתמש, בלתי-נראות בהיסטוריית-המנפיק), ואחרים. */
export function partitionIssuerTransfers(rows, { issuer = ISSUER, symbol = SYMBOL } = {}) {
  const credits = [];       // issuer → משתמש (custom_json חתום-מנפיק)
  const intoIssuer = [];    // payload.from=משתמש → issuer (נראה רק בהיסטוריות-משתמשים)
  const otherSymbolCounts = {};
  let otherOps = 0;
  for (const r of rows) {
    if (r.opType !== "custom_json" || r.contractName !== "tokens" || r.contractAction !== "transfer") { otherOps++; continue; }
    if (r.symbol !== symbol) {
      if (r.symbol) otherSymbolCounts[r.symbol] = (otherSymbolCounts[r.symbol] ?? 0) + 1;
      else otherOps++;
      continue;
    }
    const row = { idx: r.idx, ts: r.ts, from: r.from ?? null, to: r.to, quantity: r.quantity, quantityRaw: r.quantityRaw, memo: r.memo, memoUser: memoUserFromCredit(r.memo) };
    if (r.from === issuer) credits.push(row);
    else if (r.to === issuer) intoIssuer.push(row);
    else otherOps++;
  }
  return { credits, intoIssuer, otherSymbolCounts, otherOps };
}

/** memo "Token Conversion from BLURT account <משתמש-בלרט>" → שם-המשתמש; אחרת null. */
export function memoUserFromCredit(memo) {
  const m = typeof memo === "string" ? memo.match(/^Token Conversion from BLURT account\s+(\S+)\s*$/) : null;
  return m ? m[1] : null;
}

/** חלוקת שורות-בלרט: הפקדות (אל-חשבון-גשר), תשלומי-פדיון (מ-blurt-swap), תנועות-רזרבה.
 *  הערה-חיה: בצד-בלרט הנכס הוא BLURT (נכס-השרשרת) — SWAP.BLURT הוא נכס-ה-Engine בלבד. */
export function partitionBlurtBridge(rows, { depositAccounts = [ISSUER, ACTIVE_BLURT_BRIDGE], payoutFrom = ACTIVE_BLURT_BRIDGE, asset = "BLURT" } = {}) {
  const deposits = [];
  const payouts = [];
  const reserveMovements = [];
  let otherOps = 0;
  for (const r of rows) {
    if (r.opType !== "transfer" || r.asset !== asset) { otherOps++; continue; }
    if (r.to != null && depositAccounts.includes(r.to)) {
      const m = typeof r.memo === "string" ? r.memo.match(/^SWAP\.BLURT\s+(\S+)\s*$/) : null;
      deposits.push({ idx: r.idx, ts: r.ts, user: r.from, target: m ? m[1] : null, quantity: r.amount, memo: r.memo, memoForm: m ? "SWAP.BLURT <target>" : "other" });
      continue;
    }
    if (r.from === payoutFrom && /^Token Conversion from SWAP\.BLURT account\s+\S+\s*$/.test(r.memo ?? "")) {
      payouts.push({ idx: r.idx, ts: r.ts, user: r.to, quantity: r.amount, memo: r.memo });
      continue;
    }
    reserveMovements.push({ idx: r.idx, ts: r.ts, from: r.from, to: r.to, quantity: r.amount, memo: r.memo });
  }
  return { deposits, payouts, reserveMovements, otherOps };
}

/** סכום-סופרים טהור על שורות-{quantity, ts} — ללא-המצאה: כמה-שנמדד. */
export function sumRows(rows) {
  let sum = 0, count = 0;
  const tss = [];
  for (const r of rows) {
    if (typeof r.quantity !== "number" || !Number.isFinite(r.quantity)) continue;
    sum += r.quantity; count++;
    if (r.ts) tss.push(r.ts);
  }
  tss.sort();
  return {
    count,
    sum: dp6(sum),
    fromTs: tss.length ? tss[0] : null,
    toTs: tss.length ? tss[tss.length - 1] : null,
  };
}

/* ── haircut: זיווג-ראיות-מאומתות בלבד ────────────────────────────────────── */

/**
 * זיווג-זרימה-בודדת: משתמש עם בדיוק-הפקדה-אחת ובדיוק-זיכוי-אחד (אותו-משתמש-בלרט,
 * אותו-יעד-hive מ-memo), הזיכוי אחרי-ההפקדה ותוך-MAX_PAIR_DELAY_HOURS. משתמשים
 * עם-מספר-זרימות / זיכוי-חסר — נשללים-מהזיווג בכנות (לא ראייה-מאומתת).
 */
export function pairInFlows({ credits = [], deposits = [], maxDelayHours = MAX_PAIR_DELAY_HOURS } = {}) {
  const depositsByUser = new Map();
  for (const d of deposits) {
    if (!d.user || d.target == null || typeof d.quantity !== "number") continue;
    if (!depositsByUser.has(d.user)) depositsByUser.set(d.user, []);
    depositsByUser.get(d.user).push(d);
  }
  const creditsByUser = new Map();
  for (const c of credits) {
    if (!c.memoUser || c.to == null || typeof c.quantity !== "number") continue;
    const key = c.memoUser + "|" + c.to;
    if (!creditsByUser.has(key)) creditsByUser.set(key, []);
    creditsByUser.get(key).push(c);
  }
  const pairs = [];
  let excludedMultiFlow = 0, excludedPending = 0, excludedDelay = 0;
  const seenUsers = new Set();
  for (const [user, deps] of depositsByUser) {
    for (const dep of deps) {
      const ckey = user + "|" + dep.target;
      const creds = creditsByUser.get(ckey) ?? [];
      const uniqKey = user + "|" + dep.target;
      if (seenUsers.has(uniqKey)) continue;
      if (deps.length !== 1 || creds.length !== 1) {
        // אפס-זיכויים = הפקדה-ממתינה (כנה); כמה-זרימות = לא-ראייה-מאומתת
        if (creds.length === 0) excludedPending++; else excludedMultiFlow++;
        seenUsers.add(uniqKey); continue;
      }
      const c = creds[0];
      const depTs = Date.parse(dep.ts), credTs = Date.parse(c.ts);
      if (!Number.isFinite(depTs) || !Number.isFinite(credTs) || credTs < depTs) { excludedPending++; seenUsers.add(uniqKey); continue; }
      const delayH = (credTs - depTs) / 3.6e6;
      if (delayH > maxDelayHours) { excludedDelay++; seenUsers.add(uniqKey); continue; }
      const ratio = dep.quantity > 0 ? dp6(c.quantity / dep.quantity) : null;
      pairs.push({
        user, target: dep.target,
        deposit: { quantity: dep.quantity, ts: dep.ts, idx: dep.idx, chain: "blurt" },
        credit: { quantity: c.quantity, ts: c.ts, idx: c.idx, chain: "hive-engine" },
        delayHours: Math.round(delayH * 100) / 100,
        ratio, feeBps: ratio != null ? Math.round((1 - ratio) * 1e4) : null,
      });
      seenUsers.add(uniqKey);
    }
  }
  for (const [key, creds] of creditsByUser) {
    if (!seenUsers.has(key) && creds.length > 0) {
      // זיכוי ללא-הפקדה-נראית בחלון (הפקדה ישנה-מחוץ-לעמוד או נתיב-אחר) — לא ראייה
      excludedPending++;
    }
  }
  return { pairs, excludedMultiFlow, excludedPending, excludedDelay };
}

/** יחס-הגזירה הנמדד: רק מהזיווגים; אין-זיווגים → null (אף-מספר לא מומצא). */
export function computeHaircutIn(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  let depSum = 0, credSum = 0;
  const ratios = [];
  for (const p of pairs) {
    depSum += p.deposit.quantity;
    credSum += p.credit.quantity;
    if (p.ratio != null) ratios.push(p.ratio);
  }
  if (depSum <= 0) return null;
  const ratio = dp6(credSum / depSum);
  const allSame = ratios.length > 0 && ratios.every((r) => Math.abs(r - ratios[0]) < 1e-9);
  return {
    method: "paired single-flow evidence (1 deposit → 1 credit, same user+target, ≤24h) — measured only",
    pairCount: pairs.length,
    depositsSum: dp6(depSum),
    creditsSum: dp6(credSum),
    ratio,
    feeBps: Math.round((1 - ratio) * 1e4),
    commonRatio: allSame ? ratios[0] : null,
    note: "supersedes the Z-89 holder-balance surplus inference (1:1) with direct per-flow pairing; bridge terms remain unverified",
  };
}

/* ── הרכבת-הקבלה ──────────────────────────────────────────────────────────── */

export function buildEngineTransfersReceipt({
  at = null,
  engine = null,       // {rows, pagesFetched, note} — עמודי-המנפיק ב-Hive
  blurtReserve = null, // {rows, completeHistory} — graphene-swap @BLURT (היסטוריה-מלאה-נמדדת)
  blurtActive = null,  // {rows} — blurt-swap @BLURT (עמוד-אחרון)
  degraded = [],
} = {}) {
  const issuer = partitionIssuerTransfers(engine?.rows ?? []);
  const reserve = partitionBlurtBridge(blurtReserve?.rows ?? []);
  const active = partitionBlurtBridge(blurtActive?.rows ?? []);
  const engineCreditsSum = sumRows(issuer.credits);
  const engineIntoSum = sumRows(issuer.intoIssuer);
  const reserveDepositsSum = sumRows(reserve.deposits);
  const activeDepositsSum = sumRows(active.deposits);
  const activePayoutsSum = sumRows(active.payouts);

  // זיווג: הפקדות-נתיב-הפעיל (בלרט) ↔ זיכויי-המנפיק (Engine) בתוך-החלונות-שנמדדו
  const pairing = pairInFlows({ credits: issuer.credits, deposits: active.deposits });
  const haircutIn = computeHaircutIn(pairing.pairs);

  const ok = (engine?.rows?.length ?? 0) > 0 && (blurtReserve?.rows?.length ?? 0) > 0;
  return {
    schema: ENGINE_TRANSFERS_SCHEMA,
    at,
    ok,
    endpoint: {
      alternativeTo: "POST https://api.hive-engine.com/rpc/contracts find tokens:transfers → {\"result\":null} (measured 2026-10-04, incl. Z-89; table absent from official docs)",
      measured: "account_history_api.get_account_history @hive (issuer-signed custom_json ops) + condenser_api.get_account_history @blurt (bridge ledgers)",
      pageLimit: PAGE_LIMIT,
      maxPages: MAX_PAGES,
    },
    issuer: ISSUER,
    symbol: SYMBOL,
    window: {
      engine: {
        opsFetched: engine?.rows?.length ?? 0,
        pagesFetched: engine?.pagesFetched ?? 0,
        fromTs: (engine?.rows ?? []).length ? engine.rows[0].ts : null,
        toTs: (engine?.rows ?? []).length ? engine.rows[engine.rows.length - 1].ts : null,
        note: "window = the measured fetched page, not all history (issuance history on-chain since 2020-03-30, account id 1373937)",
      },
      blurtReserve: {
        opsFetched: blurtReserve?.rows?.length ?? 0,
        completeHistory: blurtReserve?.completeHistory ?? false,
        fromTs: (blurtReserve?.rows ?? []).length ? blurtReserve.rows[0].ts : null,
        toTs: (blurtReserve?.rows ?? []).length ? blurtReserve.rows[blurtReserve.rows.length - 1].ts : null,
      },
      blurtActive: {
        opsFetched: blurtActive?.rows?.length ?? 0,
        fromTs: (blurtActive?.rows ?? []).length ? blurtActive.rows[0].ts : null,
        toTs: (blurtActive?.rows ?? []).length ? blurtActive.rows[blurtActive.rows.length - 1].ts : null,
      },
    },
    in: {
      label: "bridge-IN (deposits → engine credits to users)",
      engineCredits: engineCreditsSum,
      engineIntoIssuer: { ...engineIntoSum, note: "user-signed burns toward the issuer are NOT visible in issuer-signed history — this count is not proof of absence" },
      blurtDepositsReserve: reserveDepositsSum,
      blurtDepositsActive: activeDepositsSum,
    },
    out: {
      label: "bridge-OUT (redemptions: engine burn → blurt payouts to users)",
      blurtPayouts: activePayoutsSum,
      engineBurns: { measured: false, note: "user-signed engine burns are invisible at the issuer endpoint — the OUT side is measured on the blurt payout leg only (honest limitation)" },
    },
    context: {
      otherIssuerSymbols: issuer.otherSymbolCounts,
      reserveMovements: reserve.reserveMovements.length,
      reserveMovementsNote: "Z-89's evidence class (blurt-swap→graphene-swap memos 'Token Conversion from SWAP.BLURT account …') is counted inside blurtDepositsReserve when to=issuer — not double-counted here",
    },
    haircutIn,
    pairingStats: { excludedMultiFlow: pairing.excludedMultiFlow, excludedPending: pairing.excludedPending, excludedDelay: pairing.excludedDelay },
    honesty: HONESTY_NOTE,
    degraded,
    law: "keyless measure-only history receipt — zero secrets, fail-closed legs, haircut only across verified paired evidence",
  };
}

/* ── עיבוי לשורת-האחזקה (custody-v1) ─────────────────────────────────────── */

export function condenseForCustody(receipt) {
  if (!receipt || receipt.ok !== true) return null;
  return {
    at: receipt.at,
    window: receipt.window,
    inCount: receipt.in.engineCredits.count,
    inSum: receipt.in.engineCredits.sum,
    outCount: receipt.out.blurtPayouts.count,
    outSum: receipt.out.blurtPayouts.sum,
    haircut: receipt.haircutIn
      ? { ratio: receipt.haircutIn.ratio, feeBps: receipt.haircutIn.feeBps, pairs: receipt.haircutIn.pairCount, method: receipt.haircutIn.method }
      : null,
    honesty: receipt.honesty,
    source: receipt.endpoint.measured,
  };
}

/* ── מדידה-חיה keyless ────────────────────────────────────────────────────── */

async function qJson(hosts, method, params, fetchImpl = fetch) {
  let lastErr = "unreachable";
  for (const host of hosts) {
    try {
      const r = await fetchImpl(host, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }) });
      const j = await r.json();
      if (j?.error) { lastErr = JSON.stringify(j.error).slice(0, 90); continue; }
      if ("result" in j) return { ok: true, result: j.result };
      lastErr = "no result";
    } catch (e) { lastErr = String(e?.message ?? e).slice(0, 90); }
  }
  return { ok: false, error: lastErr };
}

async function fetchHiveIssuerHistory({ fetchImpl, maxPages = 2 } = {}) {
  const rows = [];
  let start = -1, pages = 0;
  while (pages < Math.min(maxPages, MAX_PAGES)) {
    const r = await qJson(HIVE_HISTORY_HOSTS, "account_history_api.get_account_history", { account: ISSUER, start, limit: PAGE_LIMIT }, fetchImpl);
    if (!r.ok) return { rows, pagesFetched: pages, note: "degraded after " + pages + " pages: " + r.error };
    const parsed = parseHiveIssuerPage({ result: { history: r.result?.history ?? [] } });
    if (parsed.error || parsed.rows.length === 0) break;
    const firstIdx = parsed.rows[0]?.idx;
    const fresh = parsed.rows.filter((row) => !rows.some((x) => x.idx === row.idx));
    rows.push(...fresh);
    pages++;
    if (firstIdx == null || firstIdx <= 0 || fresh.length === 0) break;
    start = firstIdx - 1;
  }
  rows.sort((a, b) => (a.idx ?? 0) - (b.idx ?? 0));
  return { rows, pagesFetched: pages, note: null };
}

export async function runEngineTransfers({ fetchImpl = fetch, nowIso = null, maxPages = 2 } = {}) {
  const at = nowIso ?? new Date().toISOString();
  const degraded = [];
  const [engine, blurtReserve, blurtActive] = await Promise.all([
    fetchHiveIssuerHistory({ fetchImpl, maxPages }),
    qJson(BLURT_HISTORY_HOSTS, "condenser_api.get_account_history", [ISSUER, -1, PAGE_LIMIT], fetchImpl).then((r) => {
      if (!r.ok) { degraded.push("blurt-reserve: " + r.error); return { rows: [] }; }
      const p = parseBlurtBridgePage(r);
      return { rows: p.rows, completeHistory: p.rows.length < PAGE_LIMIT };
    }),
    qJson(BLURT_HISTORY_HOSTS, "condenser_api.get_account_history", [ACTIVE_BLURT_BRIDGE, -1, PAGE_LIMIT], fetchImpl).then((r) => {
      if (!r.ok) { degraded.push("blurt-active: " + r.error); return { rows: [] }; }
      const p = parseBlurtBridgePage(r);
      return { rows: p.rows };
    }),
  ]);
  if (engine.note) degraded.push("engine-issuer: " + engine.note);
  return buildEngineTransfersReceipt({ at, engine, blurtReserve, blurtActive, degraded });
}

/* ── persist + CLI ────────────────────────────────────────────────────────── */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, "state");
const RECEIPT_PATH = join(STATE_DIR, "engine-transfers.json");

export function persistEngineTransfers(receipt) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    if (!existsSync(STATE_DIR)) throw new Error("state dir unavailable");
    writeFileSync(RECEIPT_PATH, JSON.stringify(receipt, null, 1) + "\n");
    return true;
  } catch { return false; }
}

if (process.argv[1] && process.argv[1].endsWith("engine-transfers.mjs") && !process.argv.includes("--selftest")) {
  const receipt = await runEngineTransfers();
  persistEngineTransfers(receipt);
  console.log(JSON.stringify({
    schema: receipt.schema, at: receipt.at, ok: receipt.ok,
    window: receipt.window.engine,
    in: { engineCredits: receipt.in.engineCredits, blurtDeposits: { reserve: receipt.in.blurtDepositsReserve, active: receipt.in.blurtDepositsActive } },
    out: { blurtPayouts: receipt.out.blurtPayouts },
    haircutIn: receipt.haircutIn,
    degraded: receipt.degraded,
  }, null, 1));
}
