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
import { railPlan, railExecute, railStatusPublic, type RailRequest, type RailAction, type RailStatusPublic } from "./rail-exec";
import { fleetStatusPublic } from "./fleet";
// FIX(6-a · truth-matrix): מטריצת-ההצתה נגזרת-חי-מהמקורות-שה-UI כבר-מציג —
// relayStatus (כשרי-הרשתות: enabled/anchored/verified/lastError) + זהויות-הדלת.
import { relayStatus } from "./relay";
import { depositIdentities } from "./peg-door";

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
/** FIX(Roast-75 · units-v2): החצייה הקודמת (effPrice×1000) הייתה נכונה רק
 * לנכסי-גרעין בקנה-מיקרו (1e6µ=יחידה). נכסי-הדלת (WTRX/WSOL) מוטבעים
 * בקנה-מילי (1000µ=יחידה — 1-lamport=1e-6µ מרוסט-72) — עליהם ה-×1000
 * הכפיל-פי-1000-שגוי. עכשיו: השוואה-ישירה של µ-USDS-ל-µ-נכס משני-הצדדים
 * (measured מהכמויות-בפועל · oracle עם-גשר-סקייל-פר-נכס) — כנות-מספרית. */
function oracleScaleMu(asset: string): number {
  return asset === "WTRX" || asset === "WSOL" ? 1000 : 1_000_000;
}
function oracleCross(assetIn: string, assetOut: string, amountInMu: number, amountOutMu: number, effPriceMu: number): OracleCross {
  const x = assetIn === "USDS" ? assetOut : assetIn; // צד-הנכס-מול-האורקל
  const measuredPerMu = assetIn === "USDS"
    ? (amountOutMu > 0 ? amountInMu / amountOutMu : 0)   // µ-USDS ל-1µ-נכס
    : (amountInMu > 0 ? amountOutMu / amountInMu : 0);   // µ-USDS ל-1µ-נכס
  const st = getLiveState();
  const o = st.oracle?.[x];
  if (!o || !(o.mu > 0) || !(measuredPerMu > 0)) {
    return { effPriceMu, oracleMu: null, oracleAtH: null, spreadBps: null, verdict: "no-oracle", note: "אין-מחיר-אורקל-לנכס-זה (עדיין) — הביצוע מתבסס-על-הבריכות-בלבד" };
  }
  const oraclePerMu = o.mu / oracleScaleMu(x); // µ-USDS ל-1µ-נכס (גשר-סקייל)
  const spreadBps = Math.round(((measuredPerMu - oraclePerMu) / oraclePerMu) * 10_000);
  const verdict: OracleCross["verdict"] = Math.abs(spreadBps) <= 200 ? "aligned" : "divergent";
  return {
    effPriceMu, oracleMu: o.mu, oracleAtH: o.atH, spreadBps, verdict,
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
    oracle: oracleCross(assetIn, assetOut, amount, plan.expectOutMu ?? 0, plan.effPriceMu ?? 0),
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
  step(true, "submit", `batch אטומי נכנס לגרעין (${ops.length} רגליים) — minOut fail-closed לכל-רגל · פסק-הדין-הסופי מהבלוק`);
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
/* FIX(6-a · truth-matrix): המטריצה הייתה-קשיחה-מלאה (SOL="live", ETH/HIVE/BLURT="armed"
 * + txids-צלייה-היסטוריים-כ"ראייה-חיה") בניגוד-לדיווח-החי-של-ה-relay-עצמו. עכשיו: נגזרת-
 * **חי** מאותם-מקורות-שהמערכת-כבר-מציגה — relayStatus (chains.*.enabled/anchored/verified/
 * lastError · identities) + railStatusPublic (סמכויות-חי · נזיל-מדוד) + זהויות-הדלת.
 * סמנטיקת-המצבים (נגזרת — לא-מוצהרת):
 *   live       — relay מדווח enabled + עיגון-מאומת-קריאה-חוזרת (verified>0, אפס-מיסמאץ')
 *   armed      — enabled עם-זהות, טרם-הוכח-עיגון-מאומת
 *   needs-fuel — disabled/לא-ממומן/זהות-לא-נגזרת (הפער-המדויק מה-relay ב-gap)
 *   pending    — אין-מסילה-כלל
 * אפס-txids-היסטוריים-כ"ראייה-חיה" — ההיסטוריה חיה-בפנקס-הציבורי וב-System-Health. */
type RelayChainSnap =
  | { enabled: boolean; status: string; lastError: string | null; anchored: number; verified: number; mismatches: number }
  | undefined;
interface IgnitionRelay {
  chains: Record<string, RelayChainSnap>;
  tronIdentity: string | null;
  identities?: { eth: string | null; sol: string | null };
}

function ignitionState(ch: RelayChainSnap, opts: { identityMissing?: boolean } = {}): IgnitionRow["state"] {
  if (!ch) return "pending";
  if (!ch.enabled || opts.identityMissing) return "needs-fuel";
  if (/unfunded/i.test(ch.lastError ?? "")) return "needs-fuel";
  if (ch.verified > 0 && ch.mismatches === 0) return "live";
  return "armed";
}

function relayGap(ch: RelayChainSnap): string {
  if (!ch) return "relay: אין-דיווח";
  if (!ch.enabled) return `relay: כבוי (${ch.lastError ?? "אין-זהות-ריבונית-בסביבה"})`;
  const base = `relay: ${ch.anchored} עוגנים · ${ch.verified} מאומתים`;
  if (ch.mismatches > 0) return `${base} · ${ch.mismatches} מיסמאצ'ים — דורש-בדיקה`;
  if (/unfunded/i.test(ch.lastError ?? "")) return `${base} · מושהה-מימון (unfunded)`;
  return `${base} · סטטוס ${ch.status}`;
}

function railLiveSummary(relay: IgnitionRelay): string {
  return (["steem", "hive", "blurt"] as const).map((c) => {
    const ch = relay.chains[c];
    if (!ch) return `${c.toUpperCase()}-לא-מדווח`;
    if (!ch.enabled) return `${c.toUpperCase()}-כבוי`;
    return `${c.toUpperCase()}-${ch.verified > 0 && ch.mismatches === 0 ? "חי" : "חמוש"}`;
  }).join(" · ");
}

function ignitionMatrix(relay: IgnitionRelay, rail: RailStatusPublic | { configured: boolean; error?: string }, doorIds: { tron: string | null; sol: string | null; evm: string | null }): IgnitionRow[] {
  const env = (k: string) => Boolean((process.env[k] || "").trim());
  const chains = relay.chains;
  const netOf = (n: "hive" | "steem" | "blurt") =>
    "networks" in rail && rail.networks ? rail.networks[n] : undefined;
  const authTxt = (n: "hive" | "steem" | "blurt"): string => {
    const ni = netOf(n);
    if (!ni) return "";
    if (ni.authorityOk === false) return " · סמכות-active-נכשלה-אימות-חי — אפס-שידור";
    if (ni.authorityOk === true) return " · סמכות-אומתה-חי";
    return "";
  };
  const liquidTxt = (n: "hive" | "steem" | "blurt"): string => {
    const ni = netOf(n);
    return ni && ni.liquid !== null && ni.liquid >= 0 ? ` · נזיל ${ni.liquid.toFixed(3)}-מדוד` : "";
  };
  const rcTxt = (n: "hive" | "steem" | "blurt"): string => {
    const ni = netOf(n);
    return ni && ni.rcEffective !== null ? ` · RC ${Math.floor(ni.rcEffective / 1e6)}M` : "";
  };
  return [
    {
      network: "HIVE", state: ignitionState(chains.hive), keys: env("HIVE_ACTIVE_WIF") && env("HIVE_ANCHOR_ACCOUNT"),
      what: "מסילת-המרה-אמת (rail-exec · אימות-סמכות-חי) + עיגון-צי (fleet)",
      gap: `${relayGap(chains.hive)}${authTxt("hive")}${liquidTxt("hive")}${rcTxt("hive")}`,
    },
    {
      network: "STEEM", state: ignitionState(chains.steem), keys: env("STEEM_ACTIVE_WIF"),
      what: "מסדרון-עיגון 1:1 בגרעין (WSTEEM) + מסילת-STEEM-חיה (rail-exec · אימות-סמכות-חי)",
      gap: `${relayGap(chains.steem)}${authTxt("steem")}${liquidTxt("steem")}${rcTxt("steem")}`,
    },
    {
      network: "BLURT", state: ignitionState(chains.blurt), keys: env("BLURT_ACTIVE_WIF"),
      what: "מסילת-BLURT (powerup/transfer · chain_id-מ-@beblurt/dblurt · rpc.blurt.blog) — WBLURT-בגרעין",
      gap: `${relayGap(chains.blurt)}${authTxt("blurt")}${liquidTxt("blurt")}`,
    },
    {
      network: "TRON", state: ignitionState(chains.tron, { identityMissing: !relay.tronIdentity && !doorIds.tron }), keys: env("STEEM_ACTIVE_WIF"),
      what: "דלת-פקדות (peg-door) — זהות-פקדה ריבונית + אימות-RPC + הטבעה-אטומית (WTRX)",
      gap: `${relayGap(chains.tron)} · זהות-פקדה ${doorIds.tron ? "נגזרת" : "לא-נגזרת"}${relay.tronIdentity ? "" : " · זהות-עיגון-relay-לא-נגזרת"}`,
    },
    {
      network: "SOL", state: ignitionState(chains.sol, { identityMissing: !relay.identities?.sol }), keys: env("SOL_PRIVATE_KEY"),
      what: "דלת-פקדות (WSOL) + בריכת-USDS/WSOL-במחיר-אורקל + סוואפים-על-הגרעין",
      gap: `${relayGap(chains.sol)} · זהות-relay ${relay.identities?.sol ? "נגזרת" : "לא-נגזרת"} · ${getLiveState().pools["USDS/WSOL"] ? "בריכת-WSOL-חיה-בגרעין" : "אין-בריכת-WSOL-פתוחה"}`,
    },
    {
      network: "ETH", state: ignitionState(chains.eth, { identityMissing: !relay.identities?.eth && !doorIds.evm }), keys: env("ETH_PRIVATE_KEY"),
      what: "דלת-פקדות-EVM (זהות-אחת · ETH/Base/BSC) + אורקל-ETH-על-השרשרת",
      gap: `${relayGap(chains.eth)} · זהות-פקדה ${doorIds.evm ? "נגזרת" : "לא-נגזרת"}${relay.identities?.eth ? "" : " · זהות-עיגון-relay-לא-נגזרת"}`,
    },
    {
      network: "BTC", state: "pending", keys: env("BTC_PRIVATE_KEY") || env("BTC_WIF"),
      what: "אורקל-BTC-על-השרשרת",
      gap: "אין-מסילה-כלל (כנות) — נכס-אורקל-בלבד-כרגע",
    },
  ];
}

/* ── מצב-ציבורי ────────────────────────────────────────────────────────────── */
export async function agentStatus(): Promise<Record<string, unknown>> {
  const [rail, fleet, relay, doorIds] = await Promise.all([
    railStatusPublic().catch((e) => ({ configured: false, error: String(e).slice(0, 120) })),
    Promise.resolve(fleetStatusPublic()),
    Promise.resolve(relayStatus() as unknown as IgnitionRelay),
    Promise.resolve(depositIdentities()),
  ]);
  return {
    ok: true,
    capabilities: {
      swap: "live (batch אטומי + חציית-אורקל)",
      // FIX(6-a): הרכבה-חי-מדיווח-ה-relay — אפס-מחרוזת-קשיחה ואפס-txid-היסטורי
      rail: rail.configured ? `armed · ${railLiveSummary(relay)}` : "dead (אין-זהות-ריבונית-בסביבה)",
      door: "live (peg-in/peg-out/open-pool/refresh-oracle — /api/dex/door)",
      fleet: fleet.configured ? `live (${fleet.usableCount} חיילים-שמישים)` : `quiet-disabled (${fleet.openError ?? "vault-unavailable"})`,
      oracle: "live (לולאת-חוץ-מצב 60ש׳ — בתוך-ה-stateRoot)",
    },
    rail,
    fleet: { configured: fleet.configured, usableCount: fleet.usableCount, accounts: fleet.accounts },
    ignition: ignitionMatrix(relay, rail, doorIds),
    journal: agentG().journal,
    honesty: "הסוכן אינו-מחזיק-מפתחות — הוא מפעיל-מנועים-מאובטחים (rail-exec/fleet/door/גרעין) · יומן-טבעת-40-ריצות · אפס-סודות-בפלט",
  };
}
