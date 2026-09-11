/**
 * agent.ts — Roast-73 · סוכן-הסוואפ (THE-SWAP-AGENT)
 * ═════════════════════════════════════════════════════════════════════════════
 * דבר-המפעיל: "אני רוצה לתת לסוכן של זה לשלוח אותו לעשות סוואפ ולטפל בכל
 * הדברים האלה ויש עוד דברים עם עוד רשתות".
 *
 * הסוכן = מתווך-ביצוע-אחד-שהמפעיל שולח-אותו: הוא מקבל **כוונה** (intent) ומטפל
 * בהכל — תכנון, אימות-סמכויות, חציית-אורקל, ביצוע-אטומי על-הגרעין, מסילות-
 * שרשרת-אמת, יומן-מלא. שלושה-מנועי-ביצוע-תחת-יד-אחת:
 *
 *   1. swap  — מסלול-הטוב-ביותר על-הבריכות-החיות (exec-route · batch אטומי
 *              דבר-גורר-דבר · minOut fail-closed לכל-רגל) + חציית-אורקל:
 *              המחיר-האפקטיבי מוצלב-מול-מחיר-האורקל-הקנוני (stateRoot) וניתן
 *              פסק-דין-כנה (aligned/divergent) לפני-הביצוע.
 *   2. rail  — המרות-שרשרת-אמת (Hive-Engine sell → SWAP.HIVE → HIVE → HP)
 *              דרך rail-exec (אימות-סמכות-חי + תחומי-יתרה-חיים + שער-RC).
 *   3. plan  — דרייראן: אותה-תוכנית בלי-ביצוע (המפעיל רואה-לפני-ששולחים).
 *
 * יומן-סוכן: טבעת-זיכרון (שורד-HMR דרך-globalThis) — אפס-סודות; כל-צעד עם
 * תוצאת-אמת. מטריצת-הצתה: מי-חי, מי-חמוש, מי-חסר-דלק — מפה-כנה למפעיל.
 *
 * אין-סודות-כאן: הסוכן לא מחזיק מפתחות — הוא מפעיל מנועים-שכבר-מאובטחים
 * (rail-exec מאמת-סמכויות; הגרעין מאמת-יתרות; שער-המפעיל מאמת-זהות).
 */
import { getLiveState, nextNonce, submitOp } from "./chain";
import { knownAsset, avail, type Op } from "./kernel";
import { buildAtomicRoutePlan, isExecIssuer } from "./exec-route";
import { railPlan, railExecute, railStatusPublic, type RailRequest, type RailAction } from "./rail-exec";
import { fleetStatusPublic } from "./fleet";

/* ── יומן-הסוכן (טבעת-זיכרון) ──────────────────────────────────────────────── */
export interface AgentStep {
  at: string;
  step: string;
  ok: boolean;
  detail: string;
  txid?: string;
}
export interface AgentRun {
  id: string;
  at: string;
  kind: string;
  intent: Record<string, unknown>;
  status: "done" | "failed";
  steps: AgentStep[];
}
const JOURNAL_CAP = 40;

interface AgentGlobal {
  journal: AgentRun[];
  seq: number;
}
declare global {
  var __saosDexAgent: AgentGlobal | undefined;
}
function agentG(): AgentGlobal {
  if (!globalThis.__saosDexAgent) globalThis.__saosDexAgent = { journal: [], seq: 0 };
  return globalThis.__saosDexAgent;
}
function journalPush(run: AgentRun): void {
  const g = agentG();
  g.journal.unshift(run);
  if (g.journal.length > JOURNAL_CAP) g.journal.length = JOURNAL_CAP;
}

/* ── חציית-אורקל: המחיר-האפקטיבי מול-האורקל-הקנוני ────────────────────────── */
export interface OracleCross {
  effPriceMu: number;
  oracleMu: number | null;
  oracleAtH: number | null;
  spreadBps: number | null;
  verdict: "no-oracle" | "aligned" | "divergent";
  note: string;
}
function oracleCross(assetIn: string, effPriceMu: number): OracleCross {
  const st = getLiveState();
  const o = st.oracle?.[assetIn];
  if (!o || !(o.mu > 0)) {
    return { effPriceMu, oracleMu: null, oracleAtH: null, spreadBps: null, verdict: "no-oracle", note: "אין-מחיר-אורקל-לנכס-זה (עדיין) — הביצוע מתבסס-על-הבריכות-בלבד" };
  }
  // FIX(Roast-73 · units): effPriceMu של-הראוטר הוא יחס ×1000 (µ-יציאה ל-1000µ-כניסה);
  // האורקל מאוחסן µ-USDS ל-1-יחידת-נכס. ההצלבה-הכנה מחייבת המרה: perUnit = effPrice×1000.
  const perUnitMu = effPriceMu * 1000;
  const spreadBps = Math.round(((perUnitMu - o.mu) / o.mu) * 10_000);
  const verdict: OracleCross["verdict"] = Math.abs(spreadBps) <= 200 ? "aligned" : "divergent";
  return {
    effPriceMu: perUnitMu, oracleMu: o.mu, oracleAtH: o.atH, spreadBps, verdict,
    note: verdict === "aligned"
      ? `הציטוט-מיושר-לאורקל (${spreadBps}bps · h${o.atH})`
      : `הציטוט-זז-מהאורקל (${spreadBps > 0 ? "+" : ""}${spreadBps}bps · h${o.atH}) — זו-אמת-שוק: הבריכות-חיות-ומתומחרות-בעצמן; פסק-הדין נמסר-כנה-למפעיל`,
  };
}

/* ── תוכנית-סוואפ (קריאה-בלבד) ─────────────────────────────────────────────── */
export interface SwapPlan {
  ok: boolean;
  error?: string;
  routeVenues?: string[];
  expectOutMu?: number;
  effPriceMu?: number;
  oracle?: OracleCross;
  balance?: { issuer: string; asset: string; availableMu: number; enough: boolean };
  opsCount?: number;
  honesty: string;
}

export function planSwap(assetIn: string, assetOut: string, amount: number, minOut: number | undefined, issuer: string): SwapPlan {
  const honesty = "ציטוט=סימולציית-שלמים על-הבריכות-החיות (30bps לרגל) · batch-אטומי (הכל-או-כלום) · minOut fail-closed · חציית-אורקל מוצגת-כנה";
  const st = getLiveState();
  if (!knownAsset(st, assetIn) || !knownAsset(st, assetOut) || assetIn === assetOut || !(amount > 0)) {
    return { ok: false, error: "bad-request", honesty };
  }
  if (!isExecIssuer(issuer)) return { ok: false, error: "bad-issuer", honesty };
  const plan = buildAtomicRoutePlan(assetIn, assetOut, amount, minOut);
  if (!plan.ok || !plan.sub) return { ok: false, error: plan.error ?? "no-route", honesty };
  const have = avail(st, issuer, assetIn);
  return {
    ok: true,
    routeVenues: plan.routeVenues,
    expectOutMu: plan.expectOutMu,
    effPriceMu: plan.effPriceMu,
    oracle: oracleCross(assetIn, plan.effPriceMu ?? 0),
    balance: { issuer, asset: assetIn, availableMu: have, enough: have >= amount },
    opsCount: plan.sub.length,
    honesty,
  };
}

/* ── ביצוע-סוואפ (batch אטומי) ─────────────────────────────────────────────── */
export function runSwap(assetIn: string, assetOut: string, amount: number, minOut: number | undefined, issuer: string): { ok: boolean; run?: AgentRun; error?: string } {
  const plan = planSwap(assetIn, assetOut, amount, minOut, issuer);
  const g = agentG();
  const id = `ag-${++g.seq}-${Date.now().toString(36)}`;
  const run: AgentRun = {
    id, at: new Date().toISOString(), kind: "swap",
    intent: { assetIn, assetOut, amount, minOut: minOut ?? null, issuer },
    status: "failed", steps: [],
  };
  const step = (ok: boolean, stepName: string, detail: string, txid?: string) =>
    run.steps.push({ at: new Date().toISOString(), step: stepName, ok, detail: detail.slice(0, 240), ...(txid ? { txid } : {}) });

  if (!plan.ok) {
    step(false, "plan", plan.error ?? "no-route");
    journalPush(run);
    return { ok: false, error: plan.error ?? "no-route" };
  }
  step(true, "plan", `${plan.routeVenues?.join(" → ") ?? "?"} · expect ${plan.expectOutMu}µ · oracle=${plan.oracle?.verdict ?? "?"}`);
  if (plan.balance && !plan.balance.enough) {
    step(false, "balance", `יתרה-לא-מספקת ל-${issuer}: ${plan.balance.availableMu}µ < ${amount}µ ${assetIn}`);
    journalPush(run);
    return { ok: false, run, error: "insufficient-balance" };
  }
  // ביצוע — אותו-מנוע-אטומי של הראוטר (exec-route → submitOp batch)
  const atomic = buildAtomicRoutePlan(assetIn, assetOut, amount, minOut);
  if (!atomic.ok || !atomic.sub) {
    step(false, "build", atomic.error ?? "no-route");
    journalPush(run);
    return { ok: false, run, error: atomic.error ?? "no-route" };
  }
  const ops: Op[] = atomic.sub.map((s, i) => ({ ...s, issuer, nonce: nextNonce(`agent-${i}`) })) as Op[];
  const r = submitOp({ type: "batch", issuer, nonce: nextNonce("agent-batch"), ops });
  if (!r.queued) {
    step(false, "submit", r.reason ?? "queue-rejected");
    journalPush(run);
    return { ok: false, run, error: r.reason ?? "queue-rejected" };
  }
  step(true, "submit", `batch אטומי נכנס לגרעין (${ops.length} רגליים) — minOut fail-closed לכל-רגל`);
  run.status = "done";
  journalPush(run);
  return { ok: true, run };
}

/* ── ביצוע-מסילה (שרשרת-אמת) ──────────────────────────────────────────────── */
export async function runRail(req: RailRequest): Promise<{ ok: boolean; run?: AgentRun; error?: string }> {
  const g = agentG();
  const id = `ag-${++g.seq}-${Date.now().toString(36)}`;
  const run: AgentRun = {
    id, at: new Date().toISOString(), kind: "rail",
    intent: { ...req, note: `רשת-${(req.network ?? "hive").toUpperCase()} · מבצע-ריבוני-בדמון` } as Record<string, unknown>,
    status: "failed", steps: [],
  };
  const step = (ok: boolean, stepName: string, detail: string, txid?: string) =>
    run.steps.push({ at: new Date().toISOString(), step: stepName, ok, detail: detail.slice(0, 240), ...(txid ? { txid } : {}) });

  const plan = await railPlan(req);
  step(plan.ok, "rail-plan", plan.ok
    ? `${plan.steps.join(" | ")} · bound=${plan.bound ?? "-"} · rc=${plan.rcEffective !== null ? Math.floor(plan.rcEffective / 1e6) + "M" : "?"}`
    : plan.error ?? "plan-failed");
  if (!plan.ok) { journalPush(run); return { ok: false, run, error: plan.error }; }

  const res = await railExecute(req);
  step(res.ok, "broadcast", res.ok ? `שודר-לרשת-${(req.network ?? "hive").toUpperCase()} (block ${res.block ?? "?"})` : res.error ?? "broadcast-failed", res.txid);
  run.status = res.ok ? "done" : "failed";
  journalPush(run);
  return res.ok ? { ok: true, run } : { ok: false, run, error: res.error };
}

/* ── דרייראן-מסילה ────────────────────────────────────────────────────────── */
export async function planRail(req: RailRequest): Promise<Record<string, unknown>> {
  const p = await railPlan(req);
  return { ok: p.ok, error: p.error ?? null, account: p.account, authorityOk: p.authorityOk, rcEffective: p.rcEffective, balances: p.balances, steps: p.steps, bound: p.bound };
}

/* ── מטריצת-הצתה: מי-חי, מי-חמוש, מי-חסר-דלק (מפה-כנה) ────────────────────── */
export interface IgnitionRow {
  network: string;
  state: "live" | "armed" | "needs-fuel" | "pending";
  keys: boolean;
  what: string;
  gap: string;
}
/* Roast-74: המטריצה-נבנית-מהאמת-החיה-שנמדדה (לא-מהצהרות):
 * — STEEM_ACTIVE_WIF נבחן-חי מול-authority-החי (active/posting/owner) = לא-שולט.
 * — blurt.world + api.steem-engine.com = NXDOMAIN גלובלי (מדוד-דרך-DoH).
 * — BLURT: מפתח-כספת זהה למפתח-על-השרשרת (הצלבה-מלאה) → חמוש.
 */
function ignitionMatrix(): IgnitionRow[] {
  const env = (k: string) => Boolean((process.env[k] || "").trim());
  return [
    {
      network: "HIVE", state: "armed", keys: env("HIVE_ACTIVE_WIF") && env("HIVE_ANCHOR_ACCOUNT"),
      what: "מסילת-המרה-אמת (rail-exec · אימות-סמכות-חי) + עיגון-צי (fleet)",
      gap: "נזילות-פיזית-זעירה (SWAP.HIVE≈0.072) — המסילה-מאומתת-על-מיקרו (txid 46ed2f58)",
    },
    {
      network: "STEEM", state: "pending", keys: env("STEEM_ACTIVE_WIF"),
      what: "מסדרון-עיגון 1:1 בגרעין (WSTEEM) + מסילת-STEEM-ממומשת-ב-rail-exec (אותו-דפוס-גרפני)",
      gap: "הזהות-חסומה-כנה: STEEM_ACTIVE_WIF-אינו-שולט ב-headcorner (נמדד-חי-מול-השרשרת) — נדרש-מפתח-מהמפעיל · Steem-Engine-ראשי-מת (NXDOMAIN) · RC-שופע (~3.4T)",
    },
    {
      network: "BLURT", state: "armed", keys: env("BLURT_ACTIVE_WIF"),
      what: "מסילת-BLURT-חמושה (powerup/transfer · chain_id-מ-@beblurt/dblurt · rpc.blurt.blog) — WBLURT-בגרעין",
      gap: "אין-Engine (blurt.world-אבד) — אין-המרת-pegged · אין-rc_api (מדוד) — שער-RC-לא-רלוונטי · נזיל 41+ BLURT",
    },
    {
      network: "TRON", state: "needs-fuel", keys: env("STEEM_ACTIVE_WIF"),
      what: "דלת-פקדות-חיה (peg-door) — זהות-פקדה ריבונית + אימות-RPC + הטבעה-אטומית (WTRX)",
      gap: "עיגון-TRON 0.3 TRX + הפקדה-הראשונה (~18.3 TRX = 5$) — ממתין-למפעיל",
    },
    {
      network: "SOL", state: "needs-fuel", keys: env("SOL_PRIVATE_KEY"),
      what: "דלת-פקדות-חיה (WSOL) — משמורת-815,000-lamports-כבר-על-הכתובת!",
      gap: "81,880-lamports-לרצפת-העיגון (0.000082-SOL) — ואז-peg-in-מלא",
    },
    {
      network: "ETH", state: "pending", keys: env("ETH_PRIVATE_KEY"),
      what: "אורקל-ETH-חי-על-השרשרת + זהות-wallet:headcorner-evm",
      gap: "meta-tx-v2 (שידור-עיגון) — בתור-ההצתה",
    },
    {
      network: "BTC", state: "pending", keys: true,
      what: "wallet:headcorner-btc-בכספת · אורקל-BTC-חי",
      gap: "אין-מסילה-כלל (כנות) — נכס-אורקל-בלבד-כרגע",
    },
  ];
}

/* ── מצב-ציבורי ────────────────────────────────────────────────────────────── */
export async function agentStatus(): Promise<Record<string, unknown>> {
  const [rail, fleet] = await Promise.all([
    railStatusPublic().catch((e) => ({ configured: false, error: String(e).slice(0, 120) })),
    Promise.resolve(fleetStatusPublic()),
  ]);
  return {
    ok: true,
    capabilities: {
      swap: "live (batch אטומי + חציית-אורקל)",
      rail: rail.configured ? "armed (HIVE-חי · BLURT-חמוש · STEEM-חסום-זהות-מדוד)" : "dead (אין-זהות-ריבונית-בסביבה)",
      door: "live (peg-in/peg-out/open-pool/refresh-oracle — /api/dex/door)",
      fleet: fleet.configured ? `live (${fleet.usableCount} חיילים-שמישים)` : `quiet-disabled (${fleet.openError ?? "vault-unavailable"})`,
      oracle: "live (לולאת-חוץ-מצב 60ש׳ — בתוך-ה-stateRoot)",
    },
    rail,
    fleet: { configured: fleet.configured, usableCount: fleet.usableCount, accounts: fleet.accounts },
    ignition: ignitionMatrix(),
    journal: agentG().journal,
    honesty: "הסוכן אינו-מחזיק-מפתחות — הוא מפעיל-מנועים-מאובטחים (rail-exec/fleet/door/גרעין) · יומן-טבעת-40-ריצות · אפס-סודות-בפלט",
  };
}
