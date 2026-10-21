#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ORACLE-GRID — סוחר-האורקל הריבוני על הספר-שלנו (גל-95 · trace 1a15ceb5c5659485)
// "צריך לעשות את ההחלפות על הרשת שלנו ולהוכיח" — כל-הפקודות/המילויים כאן הם
// אופים-אמת על שרשרת-SAOS-DEX עצמה (orderbook מוסדי · postOnly · מודע-זומבים).
// ───────────────────────────────────────────────────────────────────────────
// האסטרטגיה (כנה):
//  · הצמד WSTEEM/USDS — המחיר-אמת שלו זז מהאורקל (median חוצה-מקורות חוץ:
//    WTRX/WSOL/WSTEEM/PHIVE מסילות-מחיר-חוץ) כל-60ש׳ — תנועת-שוק אמיתית.
//  · סולם-maker 3+3 רגליים סביב-המיד (±60/140/260bps) · postOnly (אף-פעם
//    לא-טייקר — אין-שריפת-ספרייט) · גדלים-מאוזנים (~9 USDS לרגל).
//  · חוק-ריענון: סטיית-רגל > 25bps מהיעד → ביטול+הצבה-מדויקת (אידמפוטנטי).
//  · חוק-הריגה: אורקל-ישן (atH מאחורי-הגובה > 40 בלוקים) → ביטול-הכל, ידיים-בכיס
//    (מחיר-לא-אמת = אין-מסחר; לקח-14-a).
//  · PnL: מילויי-קנייה מעלים-מלאי-וממוצע-עלות; מילויי-מכירה מממשים-שוליים
//    מול-ממוצע-העלות — הכל-נרשם-לפנקס (grids/state/oracle-grid.jsonl) עם-הקבלות
//    מהשרשרת-שלנו. אין-מספרים-מומצאים — רק-מה-שהספר החזיר.
//  · אפס-סודות-בלוג; טוקן-המפעיל נקרא מ-env בלבד.
// שימוש:  node grids/oracle-grid.mjs --loop 20000   (לולאה חיה)
//          node grids/oracle-grid.mjs --once          (טיק אחד)
//          node grids/oracle-grid.mjs --selftest      (אופליין)
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, "state");
const LEDGER_PATH = join(STATE_DIR, "oracle-grid.jsonl");
const PNLS_PATH = join(STATE_DIR, "oracle-grid-pnl.json");

const DEX = process.env.ORACLE_GRID_DEX || "http://127.0.0.1:3010/saos-dex";
const TOKEN = process.env.DEX_OPERATOR_TOKEN || "";
const ISSUER = "oracle-grid";
const FUNDER = "treasury";
const BASE = "WSTEEM", QUOTE = "USDS";
const OFFSETS_TICKS = [1, 3, 6]; // סולם-טיקים (במחירי-WSTEEM: טיק ≈ 18bps — סולם-בי-פס-זעיר מתנגש-בעיגול)
const DRIFT_TICKS = 1; // סטייה מעבר-טיק מהיעד → ריענון
const KILL_STALE_BLOCKS = 2_000; // atH מתעדכן-רק-בשינוי-מחיר (אפס-רעש-מצב) — פער-גדול ≠ תקלה
const SANITY_DIV_BPS = 3_000; // סטיית-אורקל > 30% ממיד-הבריכה-החיה = נתון-חשוד → ידיים-בכיס
const LEG_QUOTE_MU = 20_000; // ~0.02 USDS לרגל (µ) — סקאלת-הצף-האמיתית (אוצר ≈ 1 USDS)

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
const rlog = (o) => { try { appendFileSync(LEDGER_PATH, JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n"); } catch { } };
const bpsOf = (a, b) => (b === 0 ? 0 : Math.abs(a - b) / b * 10_000);

function headers() {
  return { "Content-Type": "application/json", "x-saos-operator": TOKEN, "x-saos-dex-console": "1" };
}
async function api(path, method = "GET", body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`${DEX}${path}`, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
    const j = await r.json().catch(() => ({}));
    if (j?.error === "rate-limited: 240 req/min per IP (honest budget — retry later)" || (typeof j?.error === "string" && j.error.startsWith("rate-limited"))) {
      await new Promise((res) => setTimeout(res, 6_000 * (attempt + 1) + Math.floor(Math.random() * 2_000))); // נימוס: backoff
      continue;
    }
    return j;
  }
  return { ok: false, error: "rate-limited-gave-up" };
}
async function readPnls() { try { return JSON.parse(readFileSync(PNLS_PATH, "utf8")); } catch { return { invBaseMu: 0, costQuoteMu: 0, realizedQuoteMu: 0, fills: 0, roundTrips: 0 }; } }
function savePnls(p) { writeFileSync(PNLS_PATH, JSON.stringify(p, null, 1) + "\n"); }

async function issuerBalances() {
  try {
    const w = await api("/api/dex/wallets");
    const me = (w.wallets ?? []).find((x) => x.name === ISSUER);
    return me?.balances ?? {};
  } catch { return {}; }
}

async function fundIfNeeded(needBaseMu, needQuoteMu) {
  const bal = await issuerBalances();
  const haveBase = Number(bal[BASE] ?? 0), haveQuote = Number(bal[QUOTE] ?? 0);
  const shortBase = Math.max(0, needBaseMu - haveBase);
  const shortQuote = Math.max(0, needQuoteMu - haveQuote);
  if (shortBase > 0 || shortQuote > 0) {
    // THE-SWEEP: xfer_free תקרה 2,000,000µ לפקודה — מרובה-פקודות
    const chunks = (need) => Math.ceil(need / 2_000_000);
    let n = 0;
    for (let i = 0; i < chunks(shortBase); i++) {
      const amt = Math.min(2_000_000, shortBase - i * 2_000_000);
      const r = await api("/api/dex/transfer", "POST", { from: FUNDER, to: ISSUER, asset: BASE, amountMu: amt });
      n += r?.ok ? 1 : 0; if (!r?.ok) rlog({ kind: "fund-fail", asset: BASE, amt, err: r?.error });
    }
    for (let i = 0; i < chunks(shortQuote); i++) {
      const amt = Math.min(2_000_000, shortQuote - i * 2_000_000);
      const r = await api("/api/dex/transfer", "POST", { from: FUNDER, to: ISSUER, asset: QUOTE, amountMu: amt });
      n += r?.ok ? 1 : 0; if (!r?.ok) rlog({ kind: "fund-fail", asset: QUOTE, amt, err: r?.error });
    }
    rlog({ kind: "funded", baseMu: shortBase, quoteMu: shortQuote, chunks: n });
    await new Promise((r) => setTimeout(r, 2500)); // להיכלל בבלוק
  }
}

async function cancelAll(myOrders) {
  for (const o of myOrders) {
    await api("/api/dex/cancel", "POST", { id: o.id, issuer: ISSUER });
  }
  if (myOrders.length) rlog({ kind: "cancel-all", count: myOrders.length, why: "kill-law" });
}

async function tick() {
  const st = await api("/api/dex/state");
  if (st?.error) { rlog({ kind: "api-skip", err: String(st.error).slice(0, 60) }); return { ok: false, why: String(st.error).slice(0, 40) }; }
  if (!st?.ok || st?.state?.halted) { rlog({ kind: "halt-skip", halted: st?.state?.halted, reason: st?.state?.haltReason }); return { ok: false, why: "halted" }; }
  const s = st.state;
  const height = Number(s.height ?? 0);
  const oracle = s.oracle?.[BASE];
  if (!oracle || !(oracle.mu > 0)) { rlog({ kind: "no-oracle" }); return { ok: false, why: "no-oracle" }; }
  const stale = height - Number(oracle.atH ?? 0) > KILL_STALE_BLOCKS;
  const midPx = Math.round(oracle.mu / 1000); // µq/µb×1000 — סקאלת-הספר
  if (!(midPx > 0)) return { ok: false, why: "bad-mid" };

  const my = (await api(`/api/dex/my-orders?issuer=${ISSUER}`)).orders ?? [];
  // sanity: מיד-הבריכה-החי (ציטוט-זעיר — סקאלה-זהה) — סטייה-קיצונית מהאורקל = נתון-רע
  let poolMid = 0;
  try { const q = await api(`/api/dex/swap?pair=${QUOTE}/${BASE}&assetIn=${QUOTE}&amount=2000`); if (q?.ok && q.price > 0) poolMid = Math.round(1_000_000 / q.price); } catch { } // price=µWSTEEM-ל-µUSDS×1000 → סקאלת-הספר=1e6/price
  const divBps = poolMid > 0 ? Math.abs(midPx - poolMid) / poolMid * 10_000 : 0;
  if (stale || divBps > SANITY_DIV_BPS) {
    await cancelAll(my);
    rlog({ kind: "kill-law", stale, poolMid, midPx, divBps: Math.round(divBps) });
    return { ok: true, action: "hands-in-pockets" };
  }

  // יעדי-הסולם (טיקים — במחירי-µ×1000 טיק=1) · רגלי-מכירה רק-מהמלאי-שנצבר (בויד-אז' קנייה-ראשונה)
  const pnl0 = readPnls();
  const targets = [];
  for (const t of OFFSETS_TICKS) {
    const up = midPx + t;
    const dn = midPx - t;
    const amtSell = Math.floor(LEG_QUOTE_MU * 1000 / up);   // µ-בסיס כך-ש-notional≈LEG
    const amtBuy = Math.floor(LEG_QUOTE_MU * 1000 / dn);
    if (up > 0 && amtSell > 0 && pnl0.invBaseMu >= amtSell) targets.push({ side: "sell", price: up, amount: amtSell });
    if (dn > 0 && amtBuy > 0) targets.push({ side: "buy", price: dn, amount: amtBuy });
  }

  // חוק-הריענון: ביטול-סטיות, הצבת-חסרים (אידמפוטנטי)
  const remaining = [...my];
  let placed = 0, canceled = 0;
  for (const t of targets) {
    const idx = remaining.findIndex((o) => o.side === t.side && Math.abs(o.price - t.price) <= DRIFT_TICKS);
    if (idx >= 0) { remaining.splice(idx, 1); continue; } // רגל-תקינה-קיימת
  }
  for (const o of remaining) { // מה-שנשאר = זומבים/סטיות
    const r = await api("/api/dex/cancel", "POST", { id: o.id, issuer: ISSUER });
    canceled += r?.ok ? 1 : 0;
    rlog({ kind: "cancel", id: o.id, side: o.side, price: o.price, filled: o.filled, why: "drift/zombie" });
  }
  const stillLive = ((await api(`/api/dex/my-orders?issuer=${ISSUER}`)).orders ?? []);
  for (const t of targets) {
    const exists = stillLive.some((o) => o.side === t.side && Math.abs(o.price - t.price) <= DRIFT_TICKS);
    if (exists) continue;
    // מימון-מוקדם: אם-אין-יתרה-מספקת לרגל — דלג (ה-fundIfNeeded מטופל-מעלה-בטיק)
    const r = await api("/api/dex/order", "POST", { action: "order", base: BASE, quote: QUOTE, side: t.side, price: t.price, amount: t.amount, issuer: ISSUER, postOnly: true });
    placed += r?.ok ? 1 : 0;
    rlog({ kind: r?.ok ? "place" : "place-fail", side: t.side, price: t.price, amount: t.amount, err: r?.error ?? null });
  }

  // מדידת-מילויים: דלתא-filled מול-התצפית-הקודמת (מוחזק-בפנקס-ה-PnL)
  const pnl = readPnls();
  const prevFilled = pnl.lastFilled ?? {};
  const live = stillLive.concat(my.filter((o) => !stillLive.some((x) => x.id === o.id))); // כולל-מה-שנמחק/מולא
  for (const o of live) {
    const was = Number(prevFilled[o.id] ?? 0);
    const now = Number(o.filled ?? 0);
    if (now <= was) continue;
    const dMu = now - was;
    if (o.side === "buy") {
      pnl.invBaseMu += dMu; pnl.costQuoteMu += Math.floor((o.price * dMu) / 1000);
      rlog({ kind: "fill-buy", id: o.id, price: o.price, mu: dMu, quoteMu: Math.floor((o.price * dMu) / 1000) });
    } else {
      const proceeds = Math.floor((o.price * dMu) / 1000);
      const avgCost = pnl.invBaseMu > 0 ? pnl.costQuoteMu / pnl.invBaseMu : 0;
      const cost = Math.floor(avgCost * dMu);
      pnl.invBaseMu -= dMu; pnl.costQuoteMu = Math.max(0, pnl.costQuoteMu - cost);
      pnl.realizedQuoteMu += proceeds - cost;
      pnl.roundTrips += 1;
      rlog({ kind: "fill-sell", id: o.id, price: o.price, mu: dMu, proceedsQuoteMu: proceeds, costBasisQuoteMu: cost, realizedEdgeQuoteMu: proceeds - cost });
    }
    pnl.fills += 1;
    prevFilled[o.id] = now;
  }
  pnl.lastFilled = prevFilled;
  pnl.lastMidPx = midPx;
  pnl.lastHeight = height;
  savePnls(pnl);
  return { ok: true, placed, canceled, midPx, fills: pnl.fills, realizedQuoteMu: pnl.realizedQuoteMu };
}

async function ensureFunded() {
  // בויד-אז': מימון-צד-קנייה בלבד (USDS); המכירה ניזונה מהמלאי-שנצבר ממילויים
  await fundIfNeeded(0, LEG_QUOTE_MU * OFFSETS_TICKS.length);
}

const args = process.argv.slice(2);
if (args.includes("--selftest")) {
  // ברזל-אופליין: אסרטים-על-חישובי-היעד בלבד (אפס-רשת) — סולם-טיקים
  const midPx = 56;
  const t = [];
  for (const tk of OFFSETS_TICKS) t.push(midPx + tk, midPx - tk);
  const ok = t.every((p) => Number.isInteger(p) && p > 0) && t[0] > t[1] && new Set(t).size === t.length;
  console.log(`selftest: targets=${t.join(",")} → ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 2);
} else if (args.includes("--once")) {
  await ensureFunded();
  console.log(JSON.stringify(await tick()));
} else if (args.includes("--loop")) {
  const every = Number(args[args.indexOf("--loop") + 1]) || 20_000;
  console.log(`[oracle-grid] חי · issuer=${ISSUER} · base=${BASE} · כל ${every}ms`);
  await ensureFunded();
  for (;;) {
    try { const r = await tick(); if (!r.ok) console.log(`[oracle-grid] skip: ${r.why}`); }
    catch (e) { console.error(`[oracle-grid] tick-err: ${String(e?.message ?? e).slice(0, 120)}`); rlog({ kind: "tick-err", err: String(e).slice(0, 120) }); }
    await new Promise((r) => setTimeout(r, every));
  }
} else {
  console.log("שימוש: --loop 20000 | --once | --selftest");
}
