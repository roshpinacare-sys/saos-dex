/**
 * rail-exec.ts — Roast-74 · מבצע-המסילה-הרב-רשתי-בדמון (THE-MULTI-RAIL-EXECUTOR)
 * ═════════════════════════════════════════════════════════════════════════════
 * היסטוריה-כנה: hive-rail (Task 27) ביצע דרך חותם-חוץ (127.0.0.1:3004/sign) —
 * החותם **אינו-קיים עוד** (relay-service נכתב-מחדש ב-roast-66). Roast-73 בנה
 * מחדש: הדמון מבצע-בעצמו עם אותן-ערבויות, רשת-HIVE-בלבד.
 *
 * Roast-74 · רב-רשתי מהאמת-החיה (נמדד-לפני-קוד):
 *   HIVE  — חי ומאומת (מסילת-ההמרה-האמת: txid 46ed2f58 · עיגון: 539ecc50).
 *   STEEM — השרשרת חיה (api.steemit.com · RC-שופע ~3.4T) אבל **STEEM_ACTIVE_WIF
 *           אינו-שולט ב-headcorner** (active/posting/owner — כולם-לא, נמדד-חי;
 *           ההפרכה-של-טענת-73-a). הנתיב-ממומש-ונשאר fail-closed על-שער-הסמכות
 *           עד-שהמפעיל-יתקין-מפתח-active-נכון. Steem-Engine: הדומיין-הראשי
 *           NXDOMAIN-גלובלי (מת) — pegged-convert-חסום-גם-הוא.
 *   BLURT — השרשרת חיה (rpc.blurt.blog; blurt.world-אבד-NXDOMAIN). headcorner
 *           חי-עליה (41+ BLURT) ומפתח-ה-active-בכספת-האם **זהה-למפתח-על-השרשרת**
 *           (BLT5HhJD… — הצלבה-מלאה). אין-Engine (מת) ואין-rc_api (נמדד) —
 *           מסילת-BLURT = powerup/transfer, שער-RC-לא-רלוונטי-בכנות.
 *
 * אותם-שערים-לכל-רשת (מה שרלוונטי-לרשת — השאר מדווח-כנה-למה):
 *   G1 שער-סמכות — WIF→pub (בהתאמת-קידומת-השרשרת) חייב-להופיע ב-authority-החי;
 *      אי-התאמה = סירוב, אפס-שידור.
 *   G2 תחומי-כמות מהיתרות-החיות-על-השרשרת (נמדדות-בכל-בקשה).
 *   G3 שער-RC — רק-לשרשרות-עם-rc_api (Hive/Steem). Blurt: ללא-rc_api (מדידה)
 *      — השער-מדווח-לא-רלוונטי, לא-מבויש-בשקר.
 *   G4 כל-מוטציה-דרך-שער-המפעיל (x-saos-operator) + consoleGuard.
 *   G5 הכל-דרך-fencedFetch · אפס-סודות בפלט (txid/שמות/כמויות בלבד).
 */
/* M2: steem-lib-מקומי הוסר — החתימה ב-signer.ts; rail-exec משדר דרך grapheneOpsBroadcast */
import { fencedFetch } from "./fence";
// M2 · Signer–Executor: קריאות-חומר-מפתח דרך מודול-ה-Signer-היחיד (envKey · pubOfWif)
import { envKey, pubOfWif } from "./signer";
import {
  rcMana, grapheneOpsBroadcast,
  HIVE_CHAIN_ID, HIVE_NODES,
  STEEM_CHAIN_ID, STEEM_NODES,
  BLURT_CHAIN_ID, BLURT_NODES,
} from "./relay";

/** G4-תנאי-מוקדם: שער-המפעיל חייב-להיות-מוגדר — בלי-טוקן-מפעיל המסילה לא נחמשת */
function operatorEnvConfigured(): boolean {
  return Boolean((process.env.DEX_OPERATOR_TOKEN || "").trim());
}

/* ── קבועי-בטיחות (נמדדו-חי) ──────────────────────────────────────────────── */
const AUTH_TTL_MS = 10 * 60_000;      // תוקף-אימות-סמכות (כמו-הצי)
const AUTH_NEG_TTL_MS = 60_000;       // FIX(Roast-74): מטמון-כשל-קצר — מניעת-הצפת-צומת-חוץ (429-Cloudflare נמדד)
const STATUS_TTL_MS = 60_000;         // FIX(Roast-74): מטמון-סטטוס-פר-רשת — דקירת-UI-בקצב-12ש׳ לא תכה בצמתים
const RC_MIN_RAIL = 210_000_000;      // Roast-73: עלות-op-נמדדה-בדיוק (206,379,561) + מרווח
const HIVE_TX_FLOOR = 0.001;          // שמירת-עמלה על-היתרה-הנוזלת (HIVE)
const BLURT_TX_FLOOR = 0.100;         // Roast-74: רצפת-BLURT (עמלות-זולות; נזיל 41+)
const STEEM_TX_FLOOR = 0.001;
const MEMO_MAX = 120;
/* FIX(Roast-74 · מדוד-חי): Cloudflare-מציב-אתגר-HTML מול-סוכן-המשתמש-הדיפולטי-של-undici
 * (בדיקה: curl/bun-עוברים · undici-ללא-UA-מקבל <html>) — סוכן-משתמש-מפורש-פותר. */
const RAIL_FETCH_HEADERS = { "content-type": "application/json", "user-agent": "saos-dex-rail/1.0 (+sovereign-dex)" } as const;
const ENGINE_PROBE_TTL_MS = 5 * 60_000; // מטמון-חיות-מנוע — מניעת-האטת-מצב-ציבורי

const HE_HIVE_NODE = "https://api.hive-engine.com/rpc/contracts";
const HE_HIVE_ID = "ssc-mainnet-hive";
const HE_STEEM_NODES = ["https://api.steem-engine.net/rpc/contracts"];
const HE_STEEM_ID = "ssc-mainnet-steem";

/* ── טבלת-הרשתות (כל-העובדות-מהמדידות-החיות-שלעיל) ────────────────────────── */
export type RailNetwork = "hive" | "steem" | "blurt";
export type RailAction = "sell" | "withdraw" | "powerup" | "transfer";

interface RailNetConfig {
  nodes: string[];
  chainId: string;
  wifEnv: string;
  prefix: "STM" | "BLT";        // קידומת-כתובות-השרשרת (מקור: מפתחות-ה-authority-על-השרשרת)
  base: string;                  // הנכס-הנייטיב (HIVE/STEEM/BLURT)
  sscId: string | null;          // מזהה-custom_json-של-Engine (null = אין-Engine-חי)
  engineNodes: string[];
  pegged: { contract: string; symbol: string } | null; // חוזה-משיכת-מנוע (null = אין)
  rcFloor: number | null;        // null = rc_api-נעדרת-על-השרשרת (מדוד — Blurt)
  txFloor: number;
  ops: RailAction[];
  note: string;                  // אמת-הרשת (מהמדידות)
}

const RAIL_NETWORKS: Record<RailNetwork, RailNetConfig> = {
  hive: {
    nodes: HIVE_NODES, chainId: HIVE_CHAIN_ID, wifEnv: "HIVE_ACTIVE_WIF", prefix: "STM",
    base: "HIVE", sscId: HE_HIVE_ID, engineNodes: [HE_HIVE_NODE],
    pegged: { contract: "hivepegged", symbol: "SWAP.HIVE" },
    rcFloor: RC_MIN_RAIL, txFloor: HIVE_TX_FLOOR,
    ops: ["sell", "withdraw", "powerup", "transfer"],
    note: "רשת-האם · Engine-חי · המסילה-מאומתת-על-המרה-אמת (Roast-73)",
  },
  steem: {
    nodes: STEEM_NODES, chainId: STEEM_CHAIN_ID, wifEnv: "STEEM_ACTIVE_WIF", prefix: "STM",
    base: "STEEM", sscId: HE_STEEM_ID, engineNodes: HE_STEEM_NODES,
    pegged: { contract: "steempegged", symbol: "SWAP.STEEM" },
    rcFloor: RC_MIN_RAIL, txFloor: STEEM_TX_FLOOR,
    ops: ["sell", "withdraw", "powerup", "transfer"],
    note: "שרשרת-חיה-ורעננה (RC ~3.4T) · הזהות-בסביבה-אינה-שולטת-בחשבון (נמדד-חי) · Engine-ראשי-מת (NXDOMAIN)",
  },
  blurt: {
    nodes: BLURT_NODES, chainId: BLURT_CHAIN_ID, wifEnv: "BLURT_ACTIVE_WIF", prefix: "BLT",
    base: "BLURT", sscId: null, engineNodes: [],
    pegged: null,
    rcFloor: null, txFloor: BLURT_TX_FLOOR,
    ops: ["powerup", "transfer"],
    note: "שרשרת-חיה (rpc.blurt.blog; blurt.world-אבד) · מפתח-כספת-זהה-לשרשרת · אין-Engine · אין-rc_api (מדידה)",
  },
};

export const RAIL_NETWORK_LIST: RailNetwork[] = ["hive", "steem", "blurt"];

/* ── סוגי-בקשה ─────────────────────────────────────────────────────────────── */
export interface RailRequest {
  account: string;
  action: RailAction;
  network?: RailNetwork; // ברירת-מחדל hive (תאימות-אחורה מלאה)
  symbol?: string;    // sell
  quantity?: number;  // sell / withdraw (Engine יחידות)
  price?: number;     // sell (מחיר-מגביל)
  amount?: number;    // powerup/transfer (נייטיב)
  to?: string;        // transfer
}

export interface RailResult {
  ok: boolean;
  txid?: string;
  account?: string;
  network?: RailNetwork;
  block?: number | null;
  error?: string;
  detail?: string;
}

/* ── מצב-ריצה (שורד-HMR דרך-globalThis; אפס-סודות-במצב-הציבורי) ────────────── */
interface AuthRT {
  ok: boolean | null;
  checkedAt: number;
  pub: string | null;   // ציבורי-בלבד
  error?: string;
}
interface EngineRT { alive: boolean | null; checkedAt: number }
interface StatusRT { at: number; snapshot: RailNetStatus }
interface RailRT {
  auths: Map<string, AuthRT>;       // key = `${net}:${account}`
  engine: Map<string, EngineRT>;    // key = net
  status: Map<string, StatusRT>;    // key = net — FIX(Roast-74): מניעת-הצפת-צמתים-חוץ מדקירת-UI-כל-12ש׳
}
declare global {
  var __saosDexRail: RailRT | undefined;
}
function railRT(): RailRT {
  if (!globalThis.__saosDexRail) globalThis.__saosDexRail = { auths: new Map(), engine: new Map(), status: new Map() };
  const rt = globalThis.__saosDexRail;
  // FIX(Roast-74): מצב-ישן-מ-HMR-עשוי-לחסר-שדות-חדשים — משלימים-בעדינות (fail-open-מבני-בלבד)
  if (!rt.auths) rt.auths = new Map();
  if (!rt.engine) rt.engine = new Map();
  if (!rt.status) rt.status = new Map();
  return rt;
}

/* ── זהות-המסילה: החשבון-הריבוני-האחד (זהה-בכל-השרשרות-בשם) ─────────────────── */
export function railAccount(): { account: string | null; note: string } {
  const account = (process.env.HIVE_ANCHOR_ACCOUNT || "").toLowerCase().trim();
  if (!account) return { account: null, note: "HIVE_ANCHOR_ACCOUNT חסר-בסביבה" };
  if (!(process.env.HIVE_ACTIVE_WIF || "").trim()) return { account: null, note: "HIVE_ACTIVE_WIF חסר-בסביבה" };
  return { account, note: "חשבון-המסילה-הריבוני (מפתח-active בסביבת-הדמון בלבד)" };
}

export function railExecConfigured(): boolean {
  return railAccount().account !== null;
}

/** נקודות-הקצה-החיות-של-המבצע (מיוצא ל-fence-check — הצלבה-מול-מניפסט-הגדר). */
export function railExecEndpoints(): string[] {
  const out = new Set<string>();
  for (const net of RAIL_NETWORK_LIST) {
    const cfg = RAIL_NETWORKS[net];
    for (const n of cfg.nodes) out.add(n);
    for (const e of cfg.engineNodes) out.add(e);
  }
  return [...out];
}

/* ── G1: אימות-סמכות-חי (WIF→pub מול-authority-השרשרת, בהתאמת-קידומת) ──────── */
export async function railAuthority(net: RailNetwork = "hive", force = false): Promise<{ ok: boolean; pub: string | null; error?: string }> {
  const cfg = RAIL_NETWORKS[net];
  const { account } = railAccount();
  if (!account) return { ok: false, pub: null, error: "rail-account-unresolved" };
  const wif = envKey(cfg.wifEnv);
  if (!wif) return { ok: false, pub: null, error: `wif-missing (${cfg.wifEnv} חסר-בסביבה-של-הדמון)` };
  const rt = railRT();
  const key = `${net}:${account}`;
  const cached = rt.auths.get(key);
  if (!force && cached && cached.ok === true && Date.now() - cached.checkedAt < AUTH_TTL_MS) {
    return { ok: true, pub: cached.pub };
  }
  // FIX(Roast-74): כשל-טרי — לא חוזרים-לדפוק-על-הצומת כל-דקירת-סטטוס (429-נמדד)
  if (!force && cached && cached.ok === false && Date.now() - cached.checkedAt < AUTH_NEG_TTL_MS) {
    return { ok: false, pub: cached.pub, error: cached.error };
  }
  let stmPub = "";
  try {
    // M2: גזירת-פומבי דרך ה-Signer (pubOfWif — פליטה-פסולה = null = זריקה)
    const derived = pubOfWif(wif);
    if (!derived) throw new Error("derive-null");
    stmPub = derived;
  } catch {
    rt.auths.set(key, { ok: false, checkedAt: Date.now(), pub: null, error: "wif-derive-failed" });
    return { ok: false, pub: null, error: "wif-derive-failed" };
  }
  // הסמכות-על-השרשרת-מנוסחת-בקידומת-השרשרת; גוף-המפתח-זהה (גרפנה)
  const pub = cfg.prefix === "BLT" ? `BLT${stmPub.replace(/^STM/, "")}` : stmPub;
  let activeAuths: string[] = [];
  for (const node of cfg.nodes) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      try {
        const res = await fencedFetch(node, "rail-exec.authority", {
          method: "POST", headers: RAIL_FETCH_HEADERS,
          body: JSON.stringify({ jsonrpc: "2.0", method: "condenser_api.get_accounts", params: [[account]], id: 1 }),
          signal: ctrl.signal,
        });
        const json = (await res.json()) as { result?: { active?: { key_auths?: [string, number][] } }[] };
        const a = json.result?.[0];
        if (a) { activeAuths = (a.active?.key_auths ?? []).map((k) => k[0]); break; }
      } finally { clearTimeout(t); }
    } catch { /* צומת-הבא */ }
  }
  if (activeAuths.length === 0) {
    rt.auths.set(key, { ok: false, checkedAt: Date.now(), pub, error: "chain-unreachable (fail-closed)" });
    return { ok: false, pub, error: "chain-unreachable (fail-closed)" };
  }
  const ok = activeAuths.includes(pub);
  rt.auths.set(key, { ok, checkedAt: Date.now(), pub, error: ok ? undefined : "authority-mismatch (WIF אינו שולט בחשבון זה — נדחה, אפס-שידור)" });
  if (!ok) return { ok: false, pub, error: "authority-mismatch (WIF אינו שולט בחשבון זה — נדחה, אפס-שידור)" };
  return { ok: true, pub };
}

/* ── יתרות-חיות (ציבורי — חשבון/סימבול/כמות בלבד) ──────────────────────────── */
async function engineBalances(net: RailNetwork, account: string): Promise<Record<string, string> | null> {
  const cfg = RAIL_NETWORKS[net];
  if (!cfg.sscId || cfg.engineNodes.length === 0) return null;
  for (const node of cfg.engineNodes) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      try {
        const res = await fencedFetch(node, "rail-exec.engineBalances", {
          method: "POST", headers: RAIL_FETCH_HEADERS,
          body: JSON.stringify({ jsonrpc: "2.0", method: "find", params: { contract: "tokens", table: "balances", query: { account }, limit: 1000 }, id: 1 }),
          signal: ctrl.signal,
        });
        const json = (await res.json()) as { result?: { symbol: string; balance: string }[] };
        const out: Record<string, string> = {};
        for (const r of json.result ?? []) out[r.symbol] = r.balance;
        return out;
      } finally { clearTimeout(t); }
    } catch { /* מנוע-הבא */ }
  }
  return null; // אין-מנוע-נגיש — השער ייסגר (fail-closed)
}

async function nativeLiquid(net: RailNetwork, account: string): Promise<number> {
  const cfg = RAIL_NETWORKS[net];
  for (const node of cfg.nodes) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      try {
        const res = await fencedFetch(node, "rail-exec.nativeLiquid", {
          method: "POST", headers: RAIL_FETCH_HEADERS,
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

/** חיות-מנוע (מטמון-TTL — כדי-שמצב-הסוכן-לא-יתלה-על-מנוע-מת) */
async function engineAlive(net: RailNetwork): Promise<boolean> {
  const cfg = RAIL_NETWORKS[net];
  if (!cfg.sscId || cfg.engineNodes.length === 0) return false;
  const rt = railRT();
  const c = rt.engine.get(net);
  if (c && c.alive !== null && Date.now() - c.checkedAt < ENGINE_PROBE_TTL_MS) return c.alive;
  let alive = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fencedFetch(cfg.engineNodes[0], "rail-exec.engineAlive", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "find", params: { contract: "tokens", table: "balances", query: { account: "__probe__" }, limit: 1 }, id: 1 }),
        signal: ctrl.signal,
      });
      alive = res.ok;
    } finally { clearTimeout(t); }
  } catch { alive = false; }
  rt.engine.set(net, { alive, checkedAt: Date.now() });
  return alive;
}

/** עיצוב-כמות למחרוזת-עם-דיוק-הסימבול (Engine מקובע על מחרוזות) */
function qtyStr(x: number, precision = 8): string {
  return x.toFixed(precision).replace(/0+$/, "").replace(/\.$/, ".0");
}

/* ── G3: שער-RC (רק-לשרשרות-עם-rc_api; Blurt — ללא, נמדד) ──────────────────── */
async function rcGate(net: RailNetwork, account: string): Promise<{ ok: boolean; effective: number | null; error?: string }> {
  const cfg = RAIL_NETWORKS[net];
  if (cfg.rcFloor === null) return { ok: true, effective: null, error: undefined }; // לא-רלוונטי (מדוד)
  const eff = await rcMana(cfg.nodes[0], account);
  if (eff === null) return { ok: false, effective: null, error: "rc-unmeasured (fail-closed)" };
  if (eff < cfg.rcFloor) return { ok: false, effective: eff, error: `rc-below-floor (${Math.floor(eff / 1e6)}M < ${cfg.rcFloor / 1e6}M) — המתן להטענה` };
  return { ok: true, effective: eff };
}

/* ── סימולציית-תוכנית (קריאה-בלבד — לסוכן ול-UI) ───────────────────────────── */
export interface RailPlan {
  ok: boolean;
  error?: string;
  network: RailNetwork;
  account: string | null;
  authorityOk: boolean | null;
  rcEffective: number | null;
  rcAvailable: boolean;
  balances: Record<string, string>;
  steps: string[];
  bound: string | null; // התחום-המחייב-לפעולה (היתרה-החיה)
}

function resolveNet(req: RailRequest): RailNetwork {
  const n = String(req.network ?? "hive").toLowerCase();
  return (RAIL_NETWORK_LIST as string[]).includes(n) ? (n as RailNetwork) : "hive";
}

export async function railPlan(req: RailRequest): Promise<RailPlan> {
  const net = resolveNet(req);
  const cfg = RAIL_NETWORKS[net];
  const { account } = railAccount();
  const plan: RailPlan = { ok: false, network: net, account, authorityOk: null, rcEffective: null, rcAvailable: cfg.rcFloor !== null, balances: {}, steps: [], bound: null };
  if (!account) { plan.error = "rail-account-unresolved"; return plan; }
  if (!operatorEnvConfigured()) { plan.error = "operator-auth-unconfigured (fail-closed)"; return plan; }

  const auth = await railAuthority(net);
  plan.authorityOk = auth.ok;
  if (!auth.ok) { plan.error = auth.error ?? "authority-failed"; return plan; }

  const rc = await rcGate(net, account);
  plan.rcEffective = rc.effective;
  if (!rc.ok) { plan.error = rc.error; return plan; }

  if (req.action === "sell" || req.action === "withdraw") {
    if (!cfg.sscId || cfg.engineNodes.length === 0 || !cfg.pegged) {
      plan.error = `engine-absent (${net}): לרשת-זו-אין-מנוע-חי (נמדד) — sell/withdraw-לא-רלוונטיים; ops: ${cfg.ops.join(",")}`;
      return plan;
    }
    if (!plan.rcAvailable) { /* rc לא רלוונטי — כבר עבר */ }
    const bal = await engineBalances(net, account);
    if (bal === null) { plan.error = `engine-unreachable (${net}) — fail-closed`; return plan; }
    plan.balances = bal;
    if (req.action === "sell") {
      const sym = String(req.symbol ?? "").toUpperCase();
      if (!/^[A-Z0-9.\-]{2,12}$/.test(sym)) { plan.error = "bad-symbol"; return plan; }
      const b = Number(bal[sym] ?? 0);
      const qty = Number(req.quantity);
      if (!(qty > 0)) { plan.error = "bad-quantity"; return plan; }
      if (qty > b) { plan.error = `insufficient-engine-balance (${qtyStr(qty)} > ${qtyStr(b)})`; plan.bound = `${sym}=${bal[sym] ?? "0"}`; return plan; }
      const price = Number(req.price);
      if (!(price > 0) || !Number.isFinite(price)) { plan.error = "bad-price (מחיר-מגביל נדרש — אין-שוק-חוץ-בגרעין)"; return plan; }
      plan.steps.push(`he_market_sell ${qtyStr(qty)} ${sym} @ ${price} (רשת-${net})`);
      plan.bound = `${sym}=${bal[sym] ?? "0"}`;
    } else {
      const sym = cfg.pegged.symbol;
      const b = Number(bal[sym] ?? 0);
      const qty = req.quantity === undefined ? b : Number(req.quantity);
      if (!(qty >= cfg.txFloor)) { plan.error = `insufficient-${sym} (${b}) — מינימום-משיכה ${cfg.txFloor}`; plan.bound = `${sym}=${bal[sym] ?? "0"}`; return plan; }
      if (qty > b) { plan.error = `insufficient-${sym} (${qtyStr(qty)} > ${qtyStr(b)})`; plan.bound = `${sym}=${bal[sym] ?? "0"}`; return plan; }
      plan.steps.push(`${cfg.pegged.contract} withdraw ${qtyStr(qty, 8)} ${sym} → ${cfg.base} נוזלי (רשת-${net})`);
      plan.bound = `${sym}=${bal[sym] ?? "0"}`;
    }
  } else {
    const liquid = await nativeLiquid(net, account);
    if (liquid < 0) { plan.error = `${net}-unreachable (fail-closed)`; return plan; }
    const amt = Number(req.amount);
    if (!(amt > 0) || amt > liquid - cfg.txFloor) {
      plan.error = `insufficient-liquid (היתרה-החיה ${liquid} ${cfg.base} · רצפת-עמלה ${cfg.txFloor})`;
      plan.bound = `${cfg.base}=${liquid}`;
      return plan;
    }
    if (req.action === "powerup") {
      plan.steps.push(`transfer_to_vesting ${amt.toFixed(3)} ${cfg.base} → HP (רשת-${net})`);
      plan.bound = `${cfg.base}=${liquid}`;
    } else {
      const to = String(req.to ?? "").trim().toLowerCase();
      if (!/^[a-z0-9\-.]{3,16}$/.test(to)) { plan.error = "bad-to"; return plan; }
      plan.steps.push(`transfer ${amt.toFixed(3)} ${cfg.base} → ${to} (רשת-${net})`);
      plan.bound = `${cfg.base}=${liquid}`;
    }
  }
  plan.ok = true;
  return plan;
}

/* ── ביצוע (G1..G5 — אותם-שערים ואז-שידור-יחיד) ────────────────────────────── */
export async function railExecute(req: RailRequest): Promise<RailResult> {
  const net = resolveNet(req);
  const cfg = RAIL_NETWORKS[net];
  const plan = await railPlan(req);
  if (!plan.ok || !plan.account) return { ok: false, network: net, error: plan.error ?? "plan-failed", detail: plan.bound ?? undefined };
  const account = plan.account;
  const wif = envKey(cfg.wifEnv);

  try {
    if (req.action === "sell" && cfg.sscId) {
      const payload = {
        contractName: "market", contractAction: "sell",
        contractPayload: { symbol: String(req.symbol ?? "").toUpperCase(), quantity: qtyStr(Number(req.quantity)), price: String(req.price) },
      };
      const r = await grapheneOpsBroadcast(cfg.nodes[0], cfg.chainId, account,
        [["custom_json", { required_auths: [account], required_posting_auths: [], id: cfg.sscId, json: JSON.stringify(payload) }]], wif, "active");
      return { ok: true, txid: r.txid, account, network: net, block: r.block };
    }
    if (req.action === "withdraw" && cfg.pegged && cfg.sscId) {
      const sym = cfg.pegged.symbol;
      const bal = Number(plan.balances[sym] ?? 0);
      const qty = req.quantity === undefined ? bal : Number(req.quantity);
      const payload = {
        contractName: cfg.pegged.contract, contractAction: "withdraw",
        contractPayload: { quantity: qtyStr(qty, 8) },
      };
      const r = await grapheneOpsBroadcast(cfg.nodes[0], cfg.chainId, account,
        [["custom_json", { required_auths: [account], required_posting_auths: [], id: cfg.sscId, json: JSON.stringify(payload) }]], wif, "active");
      return { ok: true, txid: r.txid, account, network: net, block: r.block };
    }
    if (req.action === "powerup") {
      const amt = Number(req.amount).toFixed(3);
      const r = await grapheneOpsBroadcast(cfg.nodes[0], cfg.chainId, account,
        [["transfer_to_vesting", { from: account, to: String(req.to ?? account).toLowerCase(), amount: `${amt} ${cfg.base}` }]], wif, "active");
      return { ok: true, txid: r.txid, account, network: net, block: r.block };
    }
    if (req.action === "transfer") {
      const memo = String((req as RailRequest & { memo?: string }).memo ?? "").slice(0, MEMO_MAX);
      const amt = Number(req.amount).toFixed(3);
      const r = await grapheneOpsBroadcast(cfg.nodes[0], cfg.chainId, account,
        [["transfer", { from: account, to: String(req.to ?? "").toLowerCase(), amount: `${amt} ${cfg.base}`, memo }]], wif, "active");
      return { ok: true, txid: r.txid, account, network: net, block: r.block };
    }
    return { ok: false, network: net, error: `action-${req.action}-unavailable-on-${net}` };
  } catch (e) {
    return { ok: false, network: net, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

/* ── מצב-ציבורי (אפס-סודות) — פר-רשת ───────────────────────────────────────── */
export interface RailNetStatus {
  wif: boolean;
  authorityOk: boolean | null;
  authorityError?: string;
  authorityCheckedAt?: string;
  rcEffective: number | null;
  rcOk: boolean | null;
  rcAvailable: boolean;
  liquid: number | null;
  engineAlive: boolean;
  engineBalances?: Record<string, string>;
  ops: RailAction[];
  gap: string;
  note: string;
}

export interface RailStatusPublic {
  configured: boolean;
  account: string | null;
  note: string;
  networks: Record<RailNetwork, RailNetStatus>;
  ops: RailAction[];
  bounds: { rcMin: number; txFloors: Record<RailNetwork, number>; memoMax: number };
  honesty: string;
  /* תאימות-אחורה (hive — המסילה-הראשית) */
  authorityOk?: boolean | null;
  authorityCheckedAt?: string | null;
  rcEffective?: number | null;
  rcOk?: boolean | null;
  engineBalances?: Record<string, string>;
  hiveLiquid?: number | null;
}

function netGap(net: RailNetwork, auth: { ok: boolean; error?: string }, liquid: number | null, engine: boolean): string {
  if (net === "hive") {
    return engine && liquid !== null && liquid >= 0
      ? "נזילות-פיזית-זעירה — המסילה-מאומתת-על-מיקרו (המרה-ראשונה-txid-46ed2f58)"
      : "ממתין-למדידה-חיה-מלאה";
  }
  if (net === "steem") {
    if (!auth.ok && (auth.error ?? "").includes("authority-mismatch")) return "הזהות-בסביבה-אינה-שולטת ב-headcorner-על-Steem (נמדד-חי: active/posting/owner) — נדרש-מפתח-active-נכון-מהמפעיל";
    if (!engine) return "Steem-Engine-מת (הדומיין-הראשי-NXDOMAIN-גלובלי) — pegged-convert-חסום; powerup/transfer-זמינים-ברגע-שהזהות-תתוקן";
    return "שרשרת-חיה ו-RC-שופע — הבלוק-היחיד: הזהות";
  }
  // blurt
  if (!auth.ok && (auth.error ?? "").includes("wif-missing")) return "מפתח-BLURT_ACTIVE_WIF-חסר-בסביבה-של-הדמון (קיים-בכספת-האם — pubKey-זהה-לשרשרת)";
  if (!engine) return "אין-Engine (blurt.world-אבד) — מסילה=powerup/transfer · אין-rc_api (מדידה) — שער-RC-לא-רלוונטי";
  return "armed";
}

export async function railStatusPublic(): Promise<RailStatusPublic> {
  const { account, note } = railAccount();
  const configured = railExecConfigured();
  const networks = {} as Record<RailNetwork, RailNetStatus>;
  const base: RailStatusPublic = {
    configured,
    account,
    note,
    networks,
    ops: ["sell", "withdraw", "powerup", "transfer"],
    bounds: {
      rcMin: RC_MIN_RAIL,
      txFloors: { hive: HIVE_TX_FLOOR, steem: STEEM_TX_FLOOR, blurt: BLURT_TX_FLOOR },
      memoMax: MEMO_MAX,
    },
    honesty: "המסילה מבצעת-בדמון (החותם-החוץ ההיסטורי אינו-קיים עוד) — אותם-ערבויות-פר-רשת: אימות-סמכות-חי + תחומי-יתרה-חיים + שער-RC (כשקיים-rc_api) + שער-מפעיל · HIVE-חי · STEEM-חסום-זהות (מדוד) · BLURT-חמוש (powerup/transfer)",
  };
  if (!configured || !account) {
    for (const net of RAIL_NETWORK_LIST) {
      const cfg = RAIL_NETWORKS[net];
      networks[net] = {
        wif: Boolean((process.env[cfg.wifEnv] || "").trim()), authorityOk: null, rcEffective: null, rcOk: null,
        rcAvailable: cfg.rcFloor !== null, liquid: null, engineAlive: false, ops: cfg.ops, gap: "חשבון-מסילה-לא-פתור", note: cfg.note,
      };
    }
    return base;
  }
  await Promise.allSettled(RAIL_NETWORK_LIST.map(async (net) => {
    const cfg = RAIL_NETWORKS[net];
    const rt = railRT();
    const cached = rt.status.get(net);
    if (cached && Date.now() - cached.at < STATUS_TTL_MS) { networks[net] = cached.snapshot; return; }
    const wifPresent = Boolean((process.env[cfg.wifEnv] || "").trim());
    const [auth, liquid, engine] = await Promise.all([
      railAuthority(net).catch(() => ({ ok: false as boolean | null, pub: null, error: "probe-failed" })),
      nativeLiquid(net, account).catch(() => -1),
      engineAlive(net).catch(() => false),
    ]);
    let rcEff: number | null = null;
    let rcOk: boolean | null = null;
    if (cfg.rcFloor !== null) {
      rcEff = await rcMana(cfg.nodes[0], account).catch(() => null);
      rcOk = rcEff !== null && rcEff >= cfg.rcFloor;
    }
    let engineBals: Record<string, string> | undefined;
    if (auth.ok && engine && cfg.pegged) {
      engineBals = (await engineBalances(net, account)) ?? undefined;
    }
    const snapshot: RailNetStatus = {
      wif: wifPresent,
      authorityOk: auth.ok,
      authorityError: auth.ok ? undefined : auth.error,
      authorityCheckedAt: new Date(Date.now()).toISOString(),
      rcEffective: rcEff,
      rcOk,
      rcAvailable: cfg.rcFloor !== null,
      liquid: liquid >= 0 ? liquid : null,
      engineAlive: engine,
      engineBalances: engineBals,
      ops: cfg.ops,
      gap: netGap(net, auth as { ok: boolean; error?: string }, liquid, engine),
      note: cfg.note,
    };
    rt.status.set(net, { at: Date.now(), snapshot });
    networks[net] = snapshot;
  }));
  // תאימות-אחורה: שדות-hive-ברמה-העליונה
  const h = networks.hive;
  base.authorityOk = h.authorityOk;
  base.authorityCheckedAt = h.authorityCheckedAt ?? null;
  base.rcEffective = h.rcEffective;
  base.rcOk = h.rcOk;
  base.engineBalances = h.engineBalances;
  base.hiveLiquid = h.liquid;
  return base;
}
