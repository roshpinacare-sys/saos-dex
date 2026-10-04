// ENGINE — לב רשת-הטריגרים: טיק אחד = קליטה→אסטרטגיות→כללים→אינווריאנטות
//
// דטרמיניזם: אותם-קלטות (זרע, מחיר-יחס, צ'קפוינט) → אותה-תוצאה בדיוק.
// כנות: אין מחירים מומצאים — refPrice נמדד מ-RPC ציבורי (feed_price של
// Steem) או מדידה-אחרונה עם stale=true; בלי שום-מדידה, הגרידים נשארים ידיים-בכיס.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { appendEvent, nextSeq } from "./events.mjs";
import { processRules, SEED_RULES } from "./rules.mjs";
import { STRATEGIES, simFill, mulberry32, FEE_BPS } from "./strategies.mjs";
import { observeRealFills, applyRealFills } from "./observe.mjs";
import { supremacyTick } from "./mm-supremacy.mjs";

/* R-Z75 · חיווט-העליונות: מנוע-ה-MM מטה-התנועה נרשם במפת-האסטרטגיות החיה —
 * מרגע-זה כל-טיק של ה-engine מצטט גם-את-חיילי-העליונות על ה-ref האמת.
 * הרישום כאן (ולא ב-strategies.mjs) כדי לשמור-על-מודול-העליונות ללא-ייבוא-מעגלי. */
STRATEGIES.supremacy = supremacyTick;

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, "state");
const EVENTS_LOG = join(STATE_DIR, "events.jsonl");
const STATE_PATH = join(STATE_DIR, "state.json");
const PNL_PATH = join(STATE_DIR, "pnl.json");
const ZIP_SOVEREIGN = process.env.GRID_ZIP_PATH || resolve(HERE, "../../Zip/sovereign");

/* ── מדידת-מחיר אמת: feed_price ציבורי (SBD/STEEM) ─────────────────────── */
export async function measureRefPrice() {
  try {
    const ctrl = AbortSignal.timeout(6000);
    const r = await fetch("https://api.steemit.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl,
      body: JSON.stringify({ jsonrpc: "2.0", method: "condenser_api.get_feed_history", params: [], id: 1 }),
    });
    const j = await r.json();
    const cur = j?.result?.current_median_history;
    if (cur?.base && cur?.quote) {
      const base = parseFloat(String(cur.base).replace(/[A-Za-z ]+/g, ""));
      const quote = parseFloat(String(cur.quote).replace(/[A-Za-z ]+/g, ""));
      if (base > 0 && quote > 0) return { refPrice: r6(base / quote), source: "steem-feed", stale: false };
    }
  } catch {
    /* נפילה כנה ל-stale */
  }
  return null;
}

/* ── מדידת-עיגון: צ'קפוינט ה-weave האחרון מדוח-עיגון-האפס ──────────────── */
export function measureAnchor() {
  for (const f of ["zero-anchor-report.json", "anchor-report.json"]) {
    const p = join(ZIP_SOVEREIGN, f);
    if (existsSync(p)) {
      try {
        const d = JSON.parse(readFileSync(p, "utf8"));
        const cp = d?.checkpoint ?? d?.latestCheckpoint ?? d?.cp ?? null;
        if (cp != null) return { checkpoint: Number(cp), file: f };
      } catch {
        /* דוח פגום — ממשיכים בכנות */
      }
    }
  }
  return null;
}

export function loadState() {
  if (!existsSync(STATE_PATH)) throw new Error("grids/state/state.json missing — commit the seed state first");
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

export function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 1) + "\n");
  writeFileSync(PNL_PATH, JSON.stringify(pnlView(state), null, 1) + "\n");
}

/** תצוגת P&L כנה: מה נמדד בסימולציה ומה באמת. אפס-אמת נשאר אפס-אמת.
 * T-7: realPnl (מד-רווחיות A-10) + basis מוצגים כאן — פומבי ומחושב-מחדש מה-chain. */
export function pnlView(state) {
  const rp = state.feeMeter.realPnl ?? null;
  return {
    asof: state.asof,
    real: { feesMu: state.feeMeter.realMu ?? 0, fills: state.feeMeter.realFills ?? 0, sbdDelta: state.feeMeter.realSbdDelta ?? 0, note: "אמת מוטבעת-על-שרשרת בלבד (fill_order מה-chain)" },
    realPnl: rp ? {
      realizedSbd: rp.realizedSbd, positionSteem: rp.positionSteem, positionCostSbd: rp.positionCostSbd,
      openAvgCost: rp.openAvgCost ?? null, unbasedSteem: rp.unbasedSteem ?? 0, unbasedSbd: rp.unbasedSbd ?? 0,
      basisSeededSteem: rp.basisSeededSteem ?? 0,
      note: "יסוד-עלות ממוצע על מילויים-אמת בלבד; unbased = מכירה-בלי-יסוד-נמדד (לא-נטען-כרווח)",
    } : null,
    sim: { feesMu: state.feeMeter.simMu ?? 0, fills: state.feeMeter.simFills ?? 0, note: "סימולציה מסומנת sim:true" },
    grids: (state.grids ?? []).map((g) => ({ id: g.id, strategy: g.strategy, active: g.active, inventoryMu: g.inventoryMu, pnlSimMu: g.pnlSimMu ?? 0 })),
    mission: state.mission ?? null,
  };
}

/** אינווריאנטות — הפרה אחת = HALT כללי ויציאה 2. */
export function checkInvariants(state) {
  const bad = [];
  for (const g of state.grids ?? []) {
    if (g.inventoryMu < 0) bad.push(`${g.id}:negative-inventory`);
    if ((g.params?.capMu ?? Infinity) < g.inventoryMu) bad.push(`${g.id}:cap-breached`);
  }
  if (state.feeMeter.simMu < (state.feeMeter._lastSimMu ?? 0)) bad.push("fee-meter-non-monotonic");
  state.feeMeter._lastSimMu = state.feeMeter.simMu;
  return bad;
}

/* ── טיק אחד ─────────────────────────────────────────────────────────── */
export async function runTick({ seed = 20260928, injectedPrice = null, injectedEvents = [], quiet = false } = {}) {
  const state = loadState();
  /* שער-טוהר: מצב-פגום לא רץ — HALT מיידי (האינווריאנטות קודמות לכל-פעולה) */
  const preViolations = checkInvariants(state);
  if (preViolations.length > 0) {
    appendEvent(EVENTS_LOG, { type: "grid.halt", source: "invariant", payload: { violations: preViolations, at: "pre-tick" } });
    saveState(state);
    return { ok: false, violations: preViolations, summary: `halt(pre-tick): ${preViolations.join(", ")}` };
  }
  state.asof = new Date().toISOString();
  state.runCount = (state.runCount ?? 0) + 1;
  const rng = mulberry32(seed + state.runCount * 7919);

  /* 1. מדידות אמת */
  const price = injectedPrice ?? (await measureRefPrice());
  let priceEvent = null;
  if (price) {
    priceEvent = { type: "price.ref", source: price.source, payload: { refPrice: price.refPrice, stale: !!price.stale } };
    state.market = { refPrice: r6(price.refPrice), source: price.source, stale: !!price.stale };
  } else if (state.market?.refPrice) {
    state.market.stale = true;
    priceEvent = { type: "price.ref", source: "last-known", payload: { refPrice: state.market.refPrice, stale: true } };
  }

  const anchor = measureAnchor();
  const events = [...injectedEvents];
  if (priceEvent) events.push(priceEvent);
  if (anchor && anchor.checkpoint !== state.lastCheckpoint) {
    events.push({ type: "anchor.new", source: "weave", payload: { checkpoint: anchor.checkpoint } });
    state.lastCheckpoint = anchor.checkpoint;
  }
  /* 1b. צופה-מילויים-אמת (A-9): השרשרת מדברת חזרה — רק בטיק-חי, לעולם לא בבדיקות */
  if (!injectedPrice && !injectedEvents.length) {
    try {
      const obs = await observeRealFills({ sinceSeq: state.feeMeter?._lastRealSeq ?? -1 });
      const applied = applyRealFills(state, obs);
      if (applied.added > 0) events.push(...applied.newEvents);
    } catch {
      /* כישלון-רשת: המשך-שקט — אמת שלא-נמדדה לא-נספרת, הגרידים ממשיכים */
    }
  }

  /* 2. אסטרטגיות → פקודות → מילויי-סימולציה */
  const market = state.market ?? { refPrice: null, stale: true };
  for (const g of state.grids ?? []) {
    if (!g.active) continue;
    const strat = STRATEGIES[g.strategy];
    if (!strat) continue;
    const res = strat(g, market, g.inventoryMu);
    g.lastNote = res.note;
    if (res.halted) {
      g.active = false;
      events.push({ type: "grid.halt", source: "strategy", payload: { gridId: g.id, reason: res.note } });
      continue;
    }
    const fills = simFill(res.orders ?? [], market, rng);
    for (const f of fills) {
      // אסקרו-כנה: אסור למכור מה שאין (אין naked-short), ואסור לקנות מעבר לתקרה.
      if (f.side === "ask" && g.inventoryMu < f.fillMu) continue;
      if (f.side === "bid" && g.inventoryMu + f.fillMu > (g.params?.capMu ?? Infinity)) continue;
      g.inventoryMu = Math.round((g.inventoryMu + (f.side === "bid" ? f.fillMu : -f.fillMu)) * 100) / 100;
      g.pnlSimMu = Math.round((g.pnlSimMu + f.feeMu) * 100) / 100;
      state.feeMeter.simMu = Math.round((state.feeMeter.simMu + f.feeMu) * 100) / 100;
      state.feeMeter.simFills = (state.feeMeter.simFills ?? 0) + 1;
      events.push({ type: "grid.fill", source: g.id, payload: { gridId: g.id, side: f.side, price: f.price, fillMu: f.fillMu, feeMu: f.feeMu } });
    }
    if ((res.orders ?? []).length > 0) events.push({ type: "grid.quote", source: g.id, payload: { gridId: g.id, count: res.orders.length } });
    if (g.inventoryMu > (g.params?.warnMu ?? g.params?.capMu ?? Infinity) * 0.8) {
      events.push({ type: "inventory.warn", source: g.id, payload: { gridId: g.id, inventoryMu: g.inventoryMu, capMu: g.params?.capMu } });
    }
  }

  /* 3. עמלות → מד-העמלות (T-7 תיקון-אמת: המד מדווח כל-טיק, לא רק כשיש-מילויים.
   *    באג-שנחשף-בסוויפ: חציית-אבן-דרך בטיק-ללא-מילויים הייתה שקטה —
   *    R-FEE-SPAWN לא הוצת והמיקרו-גריד לא נולד. מד שמדווח-רק-כשכיף-לו אינו מד.) */
  const fillsThisTick = events.filter((e) => e.type === "grid.fill").length;
  events.push({ type: "fee.meter", source: "engine", payload: { simMu: state.feeMeter.simMu, fills: state.feeMeter.simFills } });

  /* 4. כללים: דבר-גורר-דבר */
  // אמת שנמדדה-על-השרשרת נשארת real:true — לא מסומנת sim (כנות-מובנית)
  const fresh = events.map((e) => ({ ...e, seq: nextSeq(EVENTS_LOG) + events.indexOf(e), sim: !e.real }));
  const { actions, newEvents, fired, halted, haltReason } = processRules(state, fresh, SEED_RULES);
  for (const ev of newEvents) appendEvent(EVENTS_LOG, ev);

  /* 5. ביצוע הפעולות */
  let spawned = 0;
  for (const a of actions) {
    if (a.action === "requote") {
      for (const id of a.grids ?? []) {
        const g = (state.grids ?? []).find((x) => x.id === id);
        if (g && market.refPrice && !market.stale) g.active = true;
      }
    } else if (a.action === "arb_execute") {
      const g = (state.grids ?? []).find((x) => x.id === a.grid);
      if (g && !g.active && market.refPrice && !market.stale) {
        g.active = true; // מיקרו-הארביטרז' קם רק כשיש סטייה אמת
      }
    } else if (a.action === "rebalance") {
      const g = (state.grids ?? []).find((x) => x.id === a.grid);
      if (g && market.refPrice && !market.stale) {
        const pull = g.inventoryMu * 0.2; // איזון-20% לעבר האפס
        g.inventoryMu = Math.round((g.inventoryMu - pull) * 100) / 100;
      }
    } else if (a.action === "halt_grid") {
      const g = (state.grids ?? []).find((x) => x.id === a.grid);
      if (g) {
        g.active = false;
        g.haltReason = a.reason;
      }
      events.push({ type: "grid.halt", source: "rule", payload: { gridId: a.grid, reason: a.reason } });
    } else if (a.action === "spawn_microgrid") {
      const nextId = a.grid;
      const q = state.feeMeter.queue ?? [];
      const idx = q.indexOf(nextId);
      if (idx >= 0) {
        const template = state.templates?.[nextId] ?? { strategy: "mm-grid", params: { levels: 2, widthBps: 80, levelMu: 60, capMu: 4000 } };
        (state.grids ?? []).push({ id: `${nextId}#${1 + spawned + (state.spawnCount ?? 0)}`, ...template, active: !!market.refPrice && !market.stale, inventoryMu: 0, pnlSimMu: 0 });
        q.splice(idx, 1);
        state.feeMeter.queue = q;
        state.spawnCount = (state.spawnCount ?? 0) + 1;
        state.feeMeter.milestonesHit = [...(state.feeMeter.milestonesHit ?? []), state.feeMeter.simMu];
        spawned += 1;
        appendEvent(EVENTS_LOG, { type: "microgrid.spawn", source: "R-FEE-SPAWN", payload: { grid: nextId, atSimMu: state.feeMeter.simMu } });
      }
    } else if (a.action === "mission_check") {
      state.mission = { ...state.mission, checkedAt: state.asof, simFeesMu: state.feeMeter.simMu };
    }
  }

  /* 6. אינווריאנטות */
  const violations = checkInvariants(state);
  if (violations.length > 0 || halted) {
    appendEvent(EVENTS_LOG, { type: "grid.halt", source: "invariant", payload: { violations, halted, haltReason } });
    saveState(state);
    return { ok: false, violations, halted, haltReason, summary: summarize(state, events, fillsThisTick, spawned, fired) };
  }

  for (const ev of events) appendEvent(EVENTS_LOG, ev);
  saveState(state);
  const summary = summarize(state, events, fillsThisTick, spawned, fired);
  if (!quiet) console.log(summary);
  return { ok: true, summary, state };
}

function summarize(state, events, fills, spawned, fired) {
  const active = (state.grids ?? []).filter((g) => g.active).length;
  const kinds = {};
  for (const e of events) kinds[e.type] = (kinds[e.type] ?? 0) + 1;
  return `tick#${state.runCount} · grids:${active}/${state.grids.length} active · fills:${fills}(sim) · fees:+${state.feeMeter.simMu.toFixed(1)}µ(sim) · events:${events.length} · rules-fired:${fired} · spawned:${spawned} · [${Object.entries(kinds).map(([k, v]) => `${k}:${v}`).join(" ")}]`;
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;
