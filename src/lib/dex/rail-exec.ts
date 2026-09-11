/**
 * rail-exec.ts — Roast-73 · מבצע-המסילה-הריבוני-בדמון (THE-RAIL-EXECUTOR)
 * ═════════════════════════════════════════════════════════════════════════════
 * היסטוריה-כנה: hive-rail (Task 27) ביצע דרך חותם-חוץ (127.0.0.1:3004/sign) —
 * החותם **אינו-קיים עוד** (relay-service נכתב-מחדש ב-roast-66; אין-handler-ל-/sign
 * באף-קוד-בריפו — נמדד). המסילה הייתה מתה fail-closed לנצח ("rail-not-configured")
 * וכל-קריאה-אליה הייתה-תלות-פנטום.
 *
 * בנייה-מחדש-כנה: הדמון כבר מחזיק את מפתחות-ה-ACTIVE הריבוניים בסביבת-הריצה שלו
 * (אותם-שמות-שהועברו-תמיד-דרך-allowlist-האם: HIVE_ACTIVE_WIF/STEEM_ACTIVE_WIF).
 * נמדד-חי (Roast-73): HIVE_ACTIVE_WIF שולט ב-authority-active של headcorner על
 * Hive **וגם** STEEM_ACTIVE_WIF על Steem — המסילה יכולה-לירות-היום.
 *
 * אותם-ערבויות-שהחותם-החוץ-הבטיח, נאכפות-כאן:
 *   G1 שער-סמכות — WIF→pub חייב-להופיע ב-authority-החי על-השרשרת (מטמון-TTL);
 *      אי-התאמה = סירוב, אפס-שידור.
 *   G2 רשימת-ops-מותרים + תחומי-כמות מהיתרות-החיות-על-השרשרת (אי-אפשר-לחרוג
 *      מהיתרה — כל-כמות נבדקת מול-היתרה-החיה באותו-בקשה).
 *   G3 שער-RC לפני-שידור (custom_json-active נמדד ~199M; רצפה 200M).
 *   G4 כל-מוטציה-דרך-שער-המפעיל (x-saos-operator) + consoleGuard בשכבת-ה-API.
 *   G5 הכל-דרך-fencedFetch · אפס-סודות בפלט (txid/שמות/כמויות-בלבד).
 *
 * כנות: רשת-HIVE בלבד-פעילה (בגרסה-זו). STEEM/BLURT — אותו-דפוס-גרפני זמין
 * ברמת-החתימה (grapheneOpsBroadcast) אבל נתיב-המסילה-שלהן נשאר כנה-חסום עד
 * בדיקת-ערבויות-משלהן. אפס-סודות-ביומן · כל-כשל כנה-מפורט.
 */
import steemLibRaw from "steem";
import { fencedFetch } from "./fence";
import { rcMana, grapheneOpsBroadcast, HIVE_CHAIN_ID, HIVE_NODES } from "./relay";

/** G4-תנאי-מוקדם: שער-המפעיל חייב-להיות-מוגדר — בלי-טוקן-מפעיל המסילה לא נחמשת */
function operatorEnvConfigured(): boolean {
  return Boolean((process.env.DEX_OPERATOR_TOKEN || "").trim());
}

interface SteemAuth {
  auth: { wifToPublic(wif: string): string };
}
const steemLib = steemLibRaw as unknown as SteemAuth;

/* ── קבועי-בטיחות (נמדדו-חי) ──────────────────────────────────────────────── */
const AUTH_TTL_MS = 10 * 60_000;      // תוקף-אימות-סמכות (כמו-הצי)
const RC_MIN_RAIL = 210_000_000;      // Roast-73: עלות-op-נמדדה-בדיוק (206,379,561) + מרווח
const HIVE_TX_FLOOR = 0.001;          // שמירת-עמלה על-היתרה-הנוזלת (HIVE)
const MEMO_MAX = 120;

const HE_NODE = "https://api.hive-engine.com/rpc/contracts";
const SSC_ID = "ssc-mainnet-hive";    // מזהה-ה-custom_json של-Hive-Engine

/* ── סוגי-בקשה (אותו-ממשק-ציבורי ש-hive-rail חשף-תמיד) ─────────────────────── */
export type RailAction = "sell" | "withdraw" | "powerup" | "transfer";

export interface RailRequest {
  account: string;
  action: RailAction;
  symbol?: string;    // sell
  quantity?: number;  // sell / withdraw (HIVE-Engine יחידות)
  price?: number;     // sell (מחיר-מגביל; חייב-להתאים-להצעה-החיה למילוי-מיידי)
  amount?: number;    // powerup/transfer (HIVE)
  to?: string;        // transfer
}

export interface RailResult {
  ok: boolean;
  txid?: string;
  account?: string;
  block?: number | null;
  error?: string;
  detail?: string;
}

/* ── מצב-ריצה (שורד-HMR דרך-globalThis; אפס-סודות-במצב-הציבורי) ────────────── */
interface AuthRT {
  ok: boolean | null;
  checkedAt: number;
  pub: string | null;   // ציבורי-בלבד
}
interface RailRT {
  auths: Map<string, AuthRT>; // key = `${account}`
}
declare global {
  var __saosDexRail: RailRT | undefined;
}
function railRT(): RailRT {
  if (!globalThis.__saosDexRail) globalThis.__saosDexRail = { auths: new Map() };
  return globalThis.__saosDexRail;
}

/* ── זהות-המסילה: החשבון-שהמפתח-הפעיל-שבסביבה באמת שולט-בו ──────────────────── */
export function railAccount(): { account: string | null; note: string } {
  const account = (process.env.HIVE_ANCHOR_ACCOUNT || "").toLowerCase().trim();
  if (!account) return { account: null, note: "HIVE_ANCHOR_ACCOUNT חסר-בסביבה" };
  if (!(process.env.HIVE_ACTIVE_WIF || "").trim()) return { account: null, note: "HIVE_ACTIVE_WIF חסר-בסביבה" };
  return { account, note: "חשבון-המסילה-הריבוני (מפתח-active בסביבת-הדמון בלבד)" };
}

export function railExecConfigured(): boolean {
  return railAccount().account !== null;
}

/** נקודות-הקצה-החיות-של-המבצע (מיוצא ל-fence-check — הצלבה-מול-מניפסט-הגדר כדי
 * שהפינים-והקוד-לא-יסטו-זה-מזה-בשקט; Roast-73 מחליף-את-הצלבה-של-החותם-הישן). */
export function railExecEndpoints(): string[] {
  return [HE_NODE, ...HIVE_NODES];
}

/* ── G1: אימות-סמכות-חי (WIF→pub מול-authority-השרשרת) ─────────────────────── */
export async function railAuthority(force = false): Promise<{ ok: boolean; pub: string | null; error?: string }> {
  const { account } = railAccount();
  if (!account) return { ok: false, pub: null, error: "rail-account-unresolved" };
  const rt = railRT();
  const cached = rt.auths.get(account);
  if (!force && cached && cached.ok === true && Date.now() - cached.checkedAt < AUTH_TTL_MS) {
    return { ok: true, pub: cached.pub };
  }
  let pub = "";
  try {
    pub = steemLib.auth.wifToPublic((process.env.HIVE_ACTIVE_WIF || "").trim());
  } catch {
    rt.auths.set(account, { ok: false, checkedAt: Date.now(), pub: null });
    return { ok: false, pub: null, error: "wif-derive-failed" };
  }
  // authority-חי מהשרשרת (condenser get_accounts) — בדיוק-כמו-החותם-הישן
  let activeAuths: string[] = [];
  for (const node of HIVE_NODES) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      try {
        const res = await fencedFetch(node, "rail-exec.authority", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "condenser_api.get_accounts", params: [[account]], id: 1 }),
          signal: ctrl.signal,
        });
        const json = (await res.json()) as { result?: { active?: { key_auths?: [string, number][] } }[] };
        const a = json.result?.[0];
        if (a) { activeAuths = (a.active?.key_auths ?? []).map((k) => k[0]); break; }
      } finally { clearTimeout(t); }
    } catch { /* צומת-הבא */ }
  }
  const ok = activeAuths.includes(pub);
  rt.auths.set(account, { ok, checkedAt: Date.now(), pub });
  if (!ok) return { ok: false, pub, error: "authority-mismatch (WIF אינו שולט בחשבון זה — נדחה, אפס-שידור)" };
  return { ok: true, pub };
}

/* ── יתרות-חיות (ציבורי — חשבון/סימבול/כמות בלבד) ──────────────────────────── */
async function heBalances(account: string): Promise<Record<string, string>> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fencedFetch(HE_NODE, "rail-exec.heBalances", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "find", params: { contract: "tokens", table: "balances", query: { account }, limit: 1000 }, id: 1 }),
      signal: ctrl.signal,
    });
    const json = (await res.json()) as { result?: { symbol: string; balance: string }[] };
    const out: Record<string, string> = {};
    for (const r of json.result ?? []) out[r.symbol] = r.balance;
    return out;
  } finally { clearTimeout(t); }
}

async function hiveLiquid(account: string): Promise<number> {
  for (const node of HIVE_NODES) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      try {
        const res = await fencedFetch(node, "rail-exec.hiveLiquid", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "condenser_api.get_accounts", params: [[account]], id: 1 }),
          signal: ctrl.signal,
        });
        const json = (await res.json()) as { result?: { balance?: string }[] };
        const b = json.result?.[0]?.balance; // "0.000 HIVE"
        return b ? Number(b.split(" ")[0]) : 0;
      } finally { clearTimeout(t); }
    } catch { /* צומת-הבא */ }
  }
  return -1; // לא-נמדד — השער ייסגר (fail-closed)
}

/** עיצוב-כמות למחרוזת-עם-דיוק-הסימבול (Hive-Engine מקובע על מחרוזות) */
function qtyStr(x: number, precision = 8): string {
  return x.toFixed(precision).replace(/0+$/, "").replace(/\.$/, ".0");
}

/* ── G3: שער-RC ─────────────────────────────────────────────────────────────── */
async function rcGate(account: string): Promise<{ ok: boolean; effective: number | null; error?: string }> {
  const eff = await rcMana(HIVE_NODES[0], account);
  if (eff === null) return { ok: false, effective: null, error: "rc-unmeasured (fail-closed)" };
  if (eff < RC_MIN_RAIL) return { ok: false, effective: eff, error: `rc-below-floor (${Math.floor(eff / 1e6)}M < ${RC_MIN_RAIL / 1e6}M) — המתן להטענה` };
  return { ok: true, effective: eff };
}

/* ── סימולציית-תוכנית (קריאה-בלבד — לסוכן ול-UI) ───────────────────────────── */
export interface RailPlan {
  ok: boolean;
  error?: string;
  account: string | null;
  authorityOk: boolean | null;
  rcEffective: number | null;
  balances: Record<string, string>;
  steps: string[];
  bound: string | null; // התחום-המחייב-לפעולה (היתרה-החיה)
}

export async function railPlan(req: RailRequest): Promise<RailPlan> {
  const { account } = railAccount();
  const plan: RailPlan = { ok: false, account, authorityOk: null, rcEffective: null, balances: {}, steps: [], bound: null };
  if (!account) { plan.error = "rail-account-unresolved"; return plan; }
  if (!operatorEnvConfigured()) { plan.error = "operator-auth-unconfigured (fail-closed)"; return plan; }

  const auth = await railAuthority();
  plan.authorityOk = auth.ok;
  if (!auth.ok) { plan.error = auth.error ?? "authority-failed"; return plan; }

  const rc = await rcGate(account);
  plan.rcEffective = rc.effective;
  if (!rc.ok) { plan.error = rc.error; return plan; }

  if (req.action === "sell" || req.action === "withdraw") {
    plan.balances = await heBalances(account);
    if (req.action === "sell") {
      const sym = String(req.symbol ?? "").toUpperCase();
      if (!/^[A-Z0-9.\-]{2,12}$/.test(sym)) { plan.error = "bad-symbol"; return plan; }
      const bal = Number(plan.balances[sym] ?? 0);
      const qty = Number(req.quantity);
      if (!(qty > 0)) { plan.error = "bad-quantity"; return plan; }
      if (qty > bal) { plan.error = `insufficient-engine-balance (${qtyStr(qty)} > ${qtyStr(bal)})`; plan.bound = `${sym}=${plan.balances[sym] ?? "0"}`; return plan; }
      const price = Number(req.price);
      if (!(price > 0) || !Number.isFinite(price)) { plan.error = "bad-price (מחיר-מגביל נדרש — אין-שוק-חוץ-בגרעין)"; return plan; }
      plan.steps.push(`he_market_sell ${qtyStr(qty)} ${sym} @ ${price}`);
      plan.bound = `${sym}=${plan.balances[sym] ?? "0"}`;
    } else {
      const bal = Number(plan.balances["SWAP.HIVE"] ?? 0);
      const qty = req.quantity === undefined ? bal : Number(req.quantity);
      if (!(qty >= 0.001)) { plan.error = `insufficient-SWAP.HIVE (${bal}) — מינימום-משיכה 0.001`; plan.bound = `SWAP.HIVE=${plan.balances["SWAP.HIVE"] ?? "0"}`; return plan; }
      if (qty > bal) { plan.error = `insufficient-SWAP.HIVE (${qtyStr(qty)} > ${qtyStr(bal)})`; plan.bound = `SWAP.HIVE=${plan.balances["SWAP.HIVE"] ?? "0"}`; return plan; }
      plan.steps.push(`hivepegged withdraw ${qtyStr(qty, 8)} SWAP.HIVE → HIVE נוזלי (רשת-Hive)`);
      plan.bound = `SWAP.HIVE=${plan.balances["SWAP.HIVE"] ?? "0"}`;
    }
  } else {
    const liquid = await hiveLiquid(account);
    if (liquid < 0) { plan.error = "hive-unreachable (fail-closed)"; return plan; }
    const amt = Number(req.amount);
    if (!(amt > 0) || amt > liquid - HIVE_TX_FLOOR) {
      plan.error = `insufficient-liquid (היתרה-החיה ${liquid} HIVE · רצפת-עמלה ${HIVE_TX_FLOOR})`;
      plan.bound = `HIVE=${liquid}`;
      return plan;
    }
    if (req.action === "powerup") {
      plan.steps.push(`transfer_to_vesting ${amt.toFixed(3)} HIVE → HP`);
      plan.bound = `HIVE=${liquid}`;
    } else {
      const to = String(req.to ?? "").trim().toLowerCase();
      if (!/^[a-z0-9\-.]{3,16}$/.test(to)) { plan.error = "bad-to"; return plan; }
      plan.steps.push(`transfer ${amt.toFixed(3)} HIVE → ${to}`);
      plan.bound = `HIVE=${liquid}`;
    }
  }
  plan.ok = true;
  return plan;
}

/* ── ביצוע (G1..G5 — אותם-שערים ואז-שידור-יחיד) ────────────────────────────── */
export async function railExecute(req: RailRequest): Promise<RailResult> {
  const plan = await railPlan(req);
  if (!plan.ok || !plan.account) return { ok: false, error: plan.error ?? "plan-failed", detail: plan.bound ?? undefined };
  const account = plan.account;
  const wif = (process.env.HIVE_ACTIVE_WIF || "").trim();

  try {
    if (req.action === "sell") {
      const payload = {
        contractName: "market", contractAction: "sell",
        contractPayload: { symbol: String(req.symbol ?? "").toUpperCase(), quantity: qtyStr(Number(req.quantity)), price: String(req.price) },
      };
      const r = await grapheneOpsBroadcast(HIVE_NODES[0], HIVE_CHAIN_ID, account,
        [["custom_json", { required_auths: [account], required_posting_auths: [], id: SSC_ID, json: JSON.stringify(payload) }]], wif, "active");
      return { ok: true, txid: r.txid, account, block: r.block };
    }
    if (req.action === "withdraw") {
      const bal = Number(plan.balances["SWAP.HIVE"] ?? 0);
      const qty = req.quantity === undefined ? bal : Number(req.quantity);
      const payload = {
        contractName: "hivepegged", contractAction: "withdraw",
        contractPayload: { quantity: qtyStr(qty, 8) },
      };
      const r = await grapheneOpsBroadcast(HIVE_NODES[0], HIVE_CHAIN_ID, account,
        [["custom_json", { required_auths: [account], required_posting_auths: [], id: SSC_ID, json: JSON.stringify(payload) }]], wif, "active");
      return { ok: true, txid: r.txid, account, block: r.block };
    }
    if (req.action === "powerup") {
      const amt = Number(req.amount).toFixed(3);
      const r = await grapheneOpsBroadcast(HIVE_NODES[0], HIVE_CHAIN_ID, account,
        [["transfer_to_vesting", { from: account, to: String(req.to ?? account).toLowerCase(), amount: `${amt} HIVE` }]], wif, "active");
      return { ok: true, txid: r.txid, account, block: r.block };
    }
    // transfer
    const memo = String((req as RailRequest & { memo?: string }).memo ?? "").slice(0, MEMO_MAX);
    const amt = Number(req.amount).toFixed(3);
    const r = await grapheneOpsBroadcast(HIVE_NODES[0], HIVE_CHAIN_ID, account,
      [["transfer", { from: account, to: String(req.to ?? "").toLowerCase(), amount: `${amt} HIVE`, memo }]], wif, "active");
    return { ok: true, txid: r.txid, account, block: r.block };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

/* ── מצב-ציבורי (אפס-סודות) ─────────────────────────────────────────────────── */
export async function railStatusPublic(): Promise<Record<string, unknown>> {
  const { account, note } = railAccount();
  const configured = railExecConfigured();
  const rt = railRT();
  const cached = account ? rt.auths.get(account) : undefined;
  const base: Record<string, unknown> = {
    configured,
    account,
    note,
    authorityOk: cached?.ok ?? null,
    authorityCheckedAt: cached ? new Date(cached.checkedAt).toISOString() : null,
    ops: ["sell", "withdraw", "powerup", "transfer"],
    bounds: { rcMin: RC_MIN_RAIL, hiveTxFloor: HIVE_TX_FLOOR, memoMax: MEMO_MAX },
    honesty: "המסילה מבצעת-בדמון (החותם-החוץ ההיסטורי אינו-קיים עוד) — אותם-ערבויות: אימות-סמכות-חי + תחומי-יתרה-חיים + שער-RC + שער-מפעיל · רשת-HIVE בלבד-בשלב-זה",
  };
  if (!configured || !account) return base;
  try {
    const [auth, rc] = await Promise.all([railAuthority(), rcMana(HIVE_NODES[0], account)]);
    base.authorityOk = auth.ok;
    base.rcEffective = rc;
    base.rcOk = rc !== null && rc >= RC_MIN_RAIL;
    if (auth.ok && base.rcOk) {
      const [bal, liquid] = await Promise.all([heBalances(account), hiveLiquid(account)]);
      base.engineBalances = bal;
      base.hiveLiquid = liquid;
    }
  } catch (e) {
    base.probeError = String((e as Error)?.message ?? e).slice(0, 120);
  }
  return base;
}
