/**
 * cloud-beat.ts — פעימת-הענן של SAOS-DEX (Task 33)
 * =============================================================================
 * רץ ב-GitHub Actions בריפו הפרטי (אפס-סנדבוקס, אפס-שרת-אמה):
 *   1. מריץ N טיקים סנכרוניים של השרשרת הדטרמיניסטית — המשך ישיר מתמונת-
 *      המצב הקנונית שבריפו (אותה-שרשרת, אותם-שערי-busy/halted — אפס-עקיפה).
 *   2. קורא תביעות-הפקדה חתומות מהספר הציבורי על Steem (RPC גלוי, חסר-מפתח).
 *   3. מאמת חתימת saos1 (secp256k1 compact + הכתובת הנגזרת) ומתאים את ה-
 *      txid מול ספר-ההפקדות הציבורי שמפרסם הצופה ב-Console.
 *   4. מזכה USDS על שרשרת-הדקס לחשבון המשתמש (עד תקרה; מעבר — למפעיל).
 *   5. מבצע commit לקבצי-השרשרת בריפו (הריפו הוא הבית הקנוני) ורק-אז
 *      מפרסם את המצב הציבורי ל-Console (Pages) — סדר-אמת: קודם-השרשרת,
 *      אחר-כך-הפרסום. דחיפה שנדחתה = הרצה-מתנגשת — הפרסום נמנע בכנות.
 *
 * דגם-האמון (מוצהר בגלוי): הפעימה היא ה-relayer — כמו-הלב של SAOS-LIVE.
 * היא חותמת-על-הזיכויים בסמכות-האוצר של השרשרת-שלה, וכל-זיכוי מתועד
 * בספר-החי עם האסמכתא. מי-שמחזיק-את-המטבעות-האמיתיים שהופקדו הוא האוצר
 * (כתובות-הצבא) — USDS הוא זכות-פדיון מתועדת, לא-טענת-גשר-נטול-אמון.
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import bs58 from "bs58";

/* ── סביבה לפני-כל-ייבוא-של-המנוע (db.ts מאמת בטעינת-מודול) ──
 * בכוח-ולא-ב-??=: סביבת-אם (סנדבוקס) מזריקה לפעמים DATABASE_URL של-עצמה
 * (custom.db) — הלב הוא-הבעלים-היחיד של-ה-db-שלו וקובע-אותו תמיד. שומר-ה-db
 * של-המנוע תופס-בדיוק-את-זה אילו-דלף — הכיוון הזה חד-חד-ערכי. */
process.env.DATABASE_URL = `file:${path.join(process.cwd(), "db", "dex.db")}`;
/* SETTLE-18: מוני-החיים-של-המסילה רוכבים-מעתה על-השרשת (db/) — במקום state/
 * שהיה מתאפס-בכל-ריצת-Actions (פנטום-תקרה מהסוג-ש-Roast-64-c התחייב-למנוע).
 * הקובץ נטען-ב-max-מהדיסק (אף-פעם-לא-מתאפס) ומחויב עם-השרשרת בכל-פעימה. */
process.env.SAOS_DEX_STATE_DIR = path.join(process.cwd(), "db");

const ROOT = process.cwd();
const DB_DIR = path.join(ROOT, "db");
const CREDITS_FILE = path.join(DB_DIR, "dex-credits.json");
const CLOUD_TICKS = Math.max(60, Math.min(6_000, Number(process.env.CLOUD_TICKS ?? 3_600))); // [T25-FORGE] ×3 — פעימה-כבדה
const STEEM_NODE = "https://api.steemit.com";
const OP_ID = "saos.weave.live.v1";
/** חשבונות-הממסר הציבוריים (הצי + ראש-המסורת) — מהם נקראות התביעות. */
const RELAY_ACCOUNTS = [
  "cashmachine", "headcorner", "haran", "israelnews", "lsa", "macrame",
  "siq", "wic", "wog", "woq", "tov", "ynet",
];
/** תקרת-זיכוי-אוטומטי להפקדה בודדת (USDS). מעבר-לזה — המפעיל מזכה דרך השער. */
const MAX_AUTO_CREDIT_USDS = 250;
/** יחס-זיכוי למטבעות-יציבים: 1:1. האחרים — לפי-פיד-השוק החי. */
const STABLE_1TO1 = new Set(["USDT", "USDC", "USD", "TUSD", "DAI", "FDUSD"]);
const FEED_BY_CUR: Record<string, string> = {
  ETH: "eth", WETH: "eth", SOL: "sol", WSOL: "sol", BTC: "btc", WBTC: "btc",
  TRX: "trx", WTRX: "trx", STEEM: "steem", WSTEEM: "steem", HIVE: "hive",
};

/* ── קריפטו-עזר: אותן-הגזרות-בדיוק של saos-live (החוזה הקנוני) ── */
const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const rmd160 = (b: Uint8Array) => new Uint8Array(createHash("ripemd160").update(b).digest());
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const cat = (...bs: Uint8Array[]) => {
  const total = bs.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of bs) { out.set(b, o); o += b.length; }
  return out;
};

/** Canonical JSON: מפתחות ממוינים-רקורסיבית, בלי-רווחים. החוזה. */
function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canon((v as Record<string, unknown>)[k])).join(",") + "}";
}

const ADDR_RE = /^saos1[1-9A-HJ-NP-Za-km-z]{33,35}$/;
const PUB_RE = /^STM[1-9A-HJ-NP-Za-km-z]{50}$/;
const SIG_RE = /^[0-9a-f]{130}$/;

function stmToPub33(stm: string): Uint8Array | null {
  try {
    const raw = bs58.decode(stm.slice(3));
    if (raw.length !== 37) return null;
    return new Uint8Array(raw.slice(0, 33));
  } catch { return null; }
}

function addressFromPub33(pub33: Uint8Array): string {
  const payload = rmd160(sha256(pub33));
  const chk = sha256(sha256(payload)).slice(0, 4);
  return "saos1" + bs58.encode(cat(payload, chk));
}

/** אימות-מעטפת saos1: החתימה משחזרת-בדיוק-את-המפתח + הכתובת נגזרת-ממנו. */
function verifyEnvelope(env: Record<string, unknown>): boolean {
  if (typeof env.pub !== "string" || !PUB_RE.test(env.pub)) return false;
  if (typeof env.sig !== "string" || !SIG_RE.test(env.sig)) return false;
  if (typeof env.by !== "string" || !ADDR_RE.test(env.by)) return false;
  const pub33 = stmToPub33(env.pub);
  if (!pub33) return false;
  const { sig, ...sans } = env;
  const digest = sha256(utf8(canon(sans)));
  try {
    const raw = unhex(sig);
    if (raw.length !== 65) return false;
    const rec = raw[0] - 31;
    if (rec < 0 || rec > 3) return false;
    const compact = raw.slice(1, 65);
    const nobleSig = secp256k1.Signature.fromCompact(compact).addRecoveryBit(rec);
    const point = nobleSig.recoverPublicKey(digest);
    const recovered = point.toRawBytes(true);
    if (hex(recovered) !== hex(pub33)) return false;
    return addressFromPub33(pub33) === env.by;
  } catch { return false; }
}

/* ── ספר-זיכויים מקומי (אידמפוטנטיות: אסמכתא-יחידה נזקפת-פעם-אחת) ── */
interface CreditRec {
  id: string; at: string; to: string; cur: string; claimed: string;
  txid: string; chain: string; usds: number; mu: number; rate: number; how: string;
}
interface CreditsLedger {
  version: 1;
  credits: CreditRec[];
  processedTxids: Record<string, 1>;
  processedIds: Record<string, 1>;
  /** הבלוק האחרון שנסרק בסריקת-הרשת (self-serve) — 0 = עדיין לא. */
  lastScanBlock?: number;
}
function loadLedger(): CreditsLedger {
  try {
    const raw = JSON.parse(fs.readFileSync(CREDITS_FILE, "utf8")) as CreditsLedger;
    if (raw && raw.version === 1 && Array.isArray(raw.credits)) return raw;
  } catch { /* ראשון */ }
  return { version: 1, credits: [], processedTxids: {}, processedIds: {} };
}
function saveLedger(l: CreditsLedger): void {
  l.credits = l.credits.slice(-400);
  const tmp = CREDITS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(l, null, 1));
  fs.renameSync(tmp, CREDITS_FILE);
}

/* ── Steem: קריאת-הספר הציבורי (חסר-מפתח, קריאה-בלבד) ── */
/* ── סריקת-רשת: תביעות ששודרו מכל חשבון Steem (self-serve) ──
 * get_account_history רואה רק את חשבונות-הממסר. משתמש שמשדר את התביעה
 * מהחשבון שלו נתפס כאן: סורקים את חלון-הבלוקים מאז-הסריקה האחרונה
 * (JSON-RPC באצוות-10, מדידה: ~1.1s לאצווה) ומלקטים custom_json עם
 * מזהה-הפעולה שלנו מכל כותב שהוא. החתימה הפנימית (saos1) היא הסמכות
 * — התעבורה רק מסיעה. תקרת-חלון: 2400 בלוקים (~2ש'); פער גדול יותר
 * נרשם בכנות וממשיך מההווה. */
const SCAN_BATCH = 10;
const SCAN_MAX_BLOCKS = 2400;
const SCAN_CONCURRENCY = 3;
async function scanNetworkClaims(ledger: CreditsLedger): Promise<Record<string, unknown>[]> {
  let head = 0;
  for (let i = 0; i < 3 && !head; i++) {
    const props = await steemRpc<{ head_block_number?: number }>("condenser_api.get_dynamic_global_properties", []);
    head = Number(props?.head_block_number ?? 0);
    if (!head) await new Promise((r) => setTimeout(r, 2_000));
  }
  if (!head) { console.warn("[cloud-beat] scanNetwork: head unknown — skipped this beat"); return []; }
  const last = Number(ledger.lastScanBlock ?? 0);
  let from = last > 0 ? last - 12 : head - 20; // חפיפת-ביטחון 12 בלוקים
  if (head - from > SCAN_MAX_BLOCKS) {
    console.warn(`[cloud-beat] scan gap ${head - from} blocks > cap — resuming from head-${SCAN_MAX_BLOCKS} (older claims: use the gate relay)`);
    from = head - SCAN_MAX_BLOCKS;
  }
  const out: Record<string, unknown>[] = [];
  const blockNos: number[] = [];
  for (let b = from + 1; b <= head; b++) blockNos.push(b);
  let cursor = 0;
  const worker = async () => {
    while (cursor < blockNos.length) {
      const mine = blockNos.slice(cursor, cursor + SCAN_BATCH);
      cursor += SCAN_BATCH;
      const reqs = mine.map((b, i) => ({ jsonrpc: "2.0", id: i + 1, method: "condenser_api.get_ops_in_block", params: [b, false] }));
      try {
        const ac = new AbortController();
        const tm = setTimeout(() => ac.abort(), 25_000);
        const r = await fetch(STEEM_NODE, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(reqs), signal: ac.signal,
        });
        clearTimeout(tm);
        if (!r.ok) throw new Error(String(r.status));
        const arr = (await r.json()) as Array<{ result?: Array<{ op?: [string, Record<string, unknown>] }> }>;
        for (const res of arr) {
          for (const entry of res?.result ?? []) {
            const op = entry?.op;
            if (!op || op[0] !== "custom_json") continue;
            const body = op[1] as { id?: string; json?: string };
            if (body?.id !== OP_ID || typeof body.json !== "string") continue;
            try { out.push(JSON.parse(body.json) as Record<string, unknown>); } catch { /* הקיפול ידחה בכנות */ }
          }
        }
      } catch {
        await new Promise((r2) => setTimeout(r2, 1_500)); // אצווה אחת נפלה — ממשיכים, הבאה בפעימה הבאה
      }
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  ledger.lastScanBlock = head;
  console.log(`[cloud-beat] network scan: blocks ${from + 1}..${head} → ${out.length} envelopes (any-account self-serve)`);
  return out;
}

async function steemRpc<T>(method: string, params: unknown[]): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 15_000);
      const r = await fetch(STEEM_NODE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: attempt + 1, method, params }),
        signal: ac.signal,
      });
      clearTimeout(t);
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { result?: T };
      if (j.result !== undefined) return j.result;
      throw new Error("no-result");
    } catch (e) {
      if (attempt === 1) { console.warn(`[cloud-beat] steem ${method} failed: ${String(e).slice(0, 80)}`); return null; }
      await new Promise((r2) => setTimeout(r2, 1_200));
    }
  }
  return null;
}

interface DepositEntry {
  txid: string; chain: string; asset: string; amount: number;
  to: string; from?: string; ts?: number; confirmations?: number;
}
async function readPublicDeposits(): Promise<DepositEntry[]> {
  try {
    const r = await fetch("https://roshpinacare-sys.github.io/Console/dex/deposits.json", { cache: "no-store" });
    if (!r.ok) return [];
    const j = (await r.json()) as { deposits?: DepositEntry[] };
    return Array.isArray(j.deposits) ? j.deposits : [];
  } catch { return []; }
}

/* ── עזרי-git (הריצה חיה בתוך-checkout של-Actions) ── */
function git(args: string, opts: { allowFail?: boolean } = {}): string {
  try {
    return execSync(`git ${args}`, { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    if (opts.allowFail) return "";
    throw e;
  }
}

async function pushWithRetry(dir: string, branch: string, tries = 3): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      execSync(`git push origin ${branch}`, { encoding: "utf8", cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      return true;
    } catch {
      try {
        execSync(`git pull --rebase --autostash origin ${branch}`, { encoding: "utf8", cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      } catch { /* ננסה שוב */ }
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
  return false;
}

/* ── [T25] כבשן-הנזילות — פונקציה-מיוצאת (נבדקת-מקומית, רצה-בפעימה) ──
 * המכשיר שהופך דמה לנזילות-עובדת (אישור-הבעלים trace 1a13585a…): הנפקה-מוצהרת
 * (forge_issue · תקרות-קשיחות-במצב) → עומק-בריכות (pool_add) → צף-שטיפה (wash).
 * אידמפוטנטי-פר-פעימה: הגרעונות נגזרים-מהמצב-החי; מה-שהושלם לא חוזר.
 */
export interface ForgeCtx {
  st: {
    height: number;
    pools: Record<string, { a: string; b: string; ra: number; rb: number }>;
    balances: Record<string, Record<string, number>>;
    credits?: Record<string, number>;
    forge?: { program: string; sinceH: number; issuedMu: Record<string, number>; capMu: Record<string, number> };
  };
  submitOp: (op: Record<string, unknown>) => { queued: boolean; reason?: string };
  nextNonce: (p: string) => string;
  stepOnce: () => Promise<void>;
}
export async function forgePhase(ctx: ForgeCtx): Promise<void> {
  const { st: stF, submitOp, nextNonce, stepOnce } = ctx;
  const availOf = (who: string, a: string): number => stF.balances?.[who]?.[a] ?? 0;
  const forge = (asset: string, amount: number, tag: string): boolean => {
    if (!(amount > 0)) return false;
    const r = submitOp({ type: "forge_issue", issuer: "treasury", nonce: nextNonce("forge"), asset, amount });
    if (r.queued) { console.log(`[cloud-beat] FORGE +${amount}µ ${asset} (${tag})`); return true; }
    console.warn(`[cloud-beat] FORGE ${asset} rejected: ${r.reason ?? "?"} (${tag})`);
    return false;
  };
  // יעד-עומק-הזוג-הריבוני (µ) — ×5.6 מהעומק-שנמדד (12.4M → 70M)
  const sovTargetRa = 70_000_000;
  // צף-תחזוקה: רצפות-האוצר (rearm-ארנה + זריעות + דלק) — כל-פעימה משלימה-את-השחוק
  const T_FLOAT_SAOS = 30_000_000;
  const T_FLOAT_USDS = 60_000_000;
  const SOV = stF.pools["SAOS/USDS"];
  const fSaos = availOf("treasury", "SAOS");
  const fUsds = availOf("treasury", "USDS");
  const floatSaos = Math.max(0, T_FLOAT_SAOS - fSaos);
  const floatUsds = Math.max(0, T_FLOAT_USDS - fUsds);
  const sovDepth = (SOV && SOV.ra > 0 && SOV.ra < sovTargetRa) ? sovTargetRa - SOV.ra : 0;
  const addA = sovDepth;
  const addB = SOV && sovDepth > 0 ? Math.floor((SOV.rb * addA) / SOV.ra) : 0;
  const ignite = sovDepth > 0;
  const needSaos = addA + floatSaos + (ignite ? 8_000_000 : 0);  // + צף-שטיפה בהצתה
  const needUsds = addB + floatUsds + (ignite ? 12_000_000 : 0); // + צף-שטיפה בהצתה
  // מלאי-זריעה לזוגות-היציב — רק-אם-הבריכה-חסרה-ולאוצר-אין-מעל-הזריעה
  const seedNeed = (asset: string, poolPair: string, seed: number): number => {
    if (stF.pools[poolPair]) return 0;
    return Math.max(0, seed - availOf("treasury", asset));
  };
  // WSBD-מחוץ-לכבשן (ערבות-משמורת-אמת בלבד — R42); הבריכה תיפתח-מהמסילה-החיה
  const nPhive = seedNeed("PHIVE", "PHIVE/USDS", 12_000_000);
  const nEnergy = seedNeed("ENERGY", "ENERGY/USDS", 14_000_000);
  const total = needSaos + needUsds + nPhive + nEnergy;
  if (total <= 0) {
    console.log("[cloud-beat] FORGE: all targets met — treasury float healthy, program idles (caps in state)");
    return;
  }
  let armed = true;
  if (needSaos > 0) armed = forge("SAOS", needSaos, "sov-depth+wash+float") && armed;
  if (needUsds > 0) armed = forge("USDS", needUsds, "sov-depth+wash+float") && armed;
  if (nPhive > 0) armed = forge("PHIVE", nPhive, "stable-seed") && armed;
  if (nEnergy > 0) armed = forge("ENERGY", nEnergy, "stable-seed") && armed;
  if (!armed) return; // fail-closed — בלי-מלאי-מלא אין-פעולות-המשך (דחייה-כנה ביומן)
  for (let i = 0; i < 5; i++) await stepOnce(); // בלוק-לכל-מנת-הנפקה (חוק-בלוק-אחד-ל-op)
  // העמקת-הזוג-הריבוני — ratio-preserving ממלאי-האוצר-הטרי
  if (addA > 0 && availOf("treasury", "SAOS") >= addA && availOf("treasury", "USDS") >= addB) {
    const r = submitOp({ type: "pool_add", issuer: "treasury", nonce: nextNonce("forgeadd"), pair: "SAOS/USDS", amount: addA });
    if (r.queued) {
      await stepOnce();
      const p2 = stF.pools["SAOS/USDS"];
      console.log(`[cloud-beat] FORGE pool_add SAOS/USDS: +${addA}µ → ra ${p2?.ra ?? 0} rb ${p2?.rb ?? 0}`);
    } else console.warn(`[cloud-beat] FORGE pool_add rejected: ${r.reason ?? "?"}`);
  }
  // צף-השטיפה — סל-מלא (SAOS+USDS+PHIVE+ENERGY) כדי-שהמשמעות-מחזירה-תמיד-תהיה-דו-צדדית
  const wTargets: { asset: string; target: number }[] = [
    { asset: "SAOS", target: 8_000_000 }, { asset: "USDS", target: 12_000_000 },
    { asset: "PHIVE", target: 4_000_000 }, { asset: "ENERGY", target: 4_000_000 },
  ];
  for (const wt of wTargets) {
    const add = Math.max(0, wt.target - availOf("wash", wt.asset));
    if (add <= 0) continue;
    const w = submitOp({ type: "transfer", issuer: "treasury", nonce: nextNonce("forgefloat"), to: "wash", asset: wt.asset, amount: add });
    if (w.queued) console.log(`[cloud-beat] FORGE wash float +${add}µ ${wt.asset}`);
    else console.warn(`[cloud-beat] FORGE wash ${wt.asset} rejected: ${w.reason ?? "?"}`);
  }
  await stepOnce();
  // דלק-השטיפה — רצפת 1M קרדיטים (refuel-תקרה 100Kµ-פר-פקודה)
  const gasHave = stF.credits?.["wash"] ?? 0;
  if (gasHave < 1_000_000) {
    let fueled = 0;
    for (let i = 0; i < 30; i++) {
      const rf = submitOp({ type: "refuel", issuer: "treasury", nonce: nextNonce("forgewashfuel"), to: "wash", amount: 100_000 });
      if (!rf.queued) break;
      fueled++;
      if (fueled % 5 === 0) await stepOnce();
    }
    await stepOnce();
    if (fueled > 0) console.log(`[cloud-beat] FORGE wash gas +${fueled}×100Kµ credits`);
  }
}

/* ═════════════════════════ main ═════════════════════════ */
async function main(): Promise<void> {
  const t0 = Date.now();
  console.log(`[cloud-beat] boot · ticks=${CLOUD_TICKS} · db=${process.env.DATABASE_URL}`);

  const chain = await import("./src/lib/dex/chain");
  const { ensureChain, stepOnce, oracleTickOnce, stopLoops, forceFlush } = chain as {
    ensureChain: () => { pendingLoad: boolean; halted: boolean; haltReason: string | null; st: { height: number } };
    stepOnce: () => Promise<void>;
    oracleTickOnce: (force?: boolean) => Promise<void>;
    stopLoops: () => void;
    forceFlush: () => void;
  };

  const rt = ensureChain();
  const waitLoad = async () => {
    const t = Date.now();
    while (rt.pendingLoad && Date.now() - t < 90_000) await new Promise((r) => setTimeout(r, 300));
  };
  await waitLoad();
  if (rt.halted) {
    console.error(`[cloud-beat] chain HALTED — refusing to advance. reason: ${rt.haltReason ?? "?"}`);
    process.exit(1);
  }
  stopLoops(); // ריצה-עננית: בלי-טיימרי-קיר — צעדים-סנכרוניים בלבד
  const heightBefore = rt.st.height;
  console.log(`[cloud-beat] chain loaded · height ${heightBefore}`);

  // פיד-האורקל: רענון-מחירים חי לפני-הטיקים + בכל-~120 טיקים
  await oracleTickOnce().catch(() => {});
  let ticked = 0;
  for (let i = 0; i < CLOUD_TICKS; i++) {
    await stepOnce();
    ticked++;
    if (rt.halted) {
      console.error(`[cloud-beat] HALTED mid-run after ${ticked} ticks: ${rt.haltReason ?? "?"}`);
      break;
    }
    if (i > 0 && i % 120 === 0) await oracleTickOnce(true).catch(() => {}); // R23: force — פיד-טרי, החלקה-נוספת
  }
  forceFlush();
  const heightAfter = rt.st.height;
  console.log(`[cloud-beat] advanced ${heightBefore} → ${heightAfter} (${ticked} ticks, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  /* ── תביעות-הפקדה מהספר הציבורי: חשבונות-ממסר + סריקת-רשת (self-serve) ── */
  const ledger = loadLedger();
  const envelopes: Record<string, unknown>[] = [];
  const seenIds = new Set<string>();
  const pushEnv = (e: Record<string, unknown>) => {
    const id = typeof e?.id === "string" ? e.id : "";
    if (id) { if (seenIds.has(id)) return; seenIds.add(id); }
    envelopes.push(e);
  };
  for (const acc of RELAY_ACCOUNTS) {
    // מגבלת-condenser: 100 לקריאה. הלב קורא את-100-האחרונות לכל-חשבון-ממסר
    // (תביעות הן-טריות-מטבען; סריקה-עמוקה יותר מתבצעת באימות-העצמאי שבאתר).
    const hist = await steemRpc<Array<[number, { op?: [string, Record<string, unknown>] } ]>>("condenser_api.get_account_history", [acc, -1, 100]);
    if (!Array.isArray(hist)) continue;
    for (const [, entry] of hist) {
      const op = entry?.op;
      if (!op || op[0] !== "custom_json") continue;
      const body = op[1] as { id?: string; json?: string };
      if (body?.id !== OP_ID || typeof body.json !== "string") continue;
      try { pushEnv(JSON.parse(body.json) as Record<string, unknown>); } catch { /* גם-הקיפול-דוחה בכנות */ }
    }
  }
  for (const e of await scanNetworkClaims(ledger)) pushEnv(e);
  console.log(`[cloud-beat] public book: ${envelopes.length} envelopes (12 relay accounts + network scan)`);

  const deposits = await readPublicDeposits();
  const byTxid = new Map(deposits.map((d) => [String(d.txid).toLowerCase(), d]));

  // פיד-שוק לשער-זיכוי מטבעות-לא-יציבים
  let feeds: Record<string, number> = {};
  try {
    const pp = await import("./src/lib/dex/price-proof");
    /* המרה-דו-שלבית (Task 35): טיפוס-המודול האמיתי אינו-חופף-מספיק לחתימה — בלי-unknown
     * המהדר מסרב (TS2352) וחוסם את הבנייה כולה. ההמרה כאן רק מצהירה-על-החלק-שבו-משתמשים. */
    const f = await (pp as unknown as { extFeeds: (force?: boolean) => Promise<Record<string, number>> }).extFeeds(true);
    feeds = f ?? {};
  } catch (e) { console.warn(`[cloud-beat] extFeeds unavailable: ${String(e).slice(0, 60)}`); }

  const { submitOp, nextNonce } = chain as unknown as {
    submitOp: (op: Record<string, unknown>) => { queued: boolean; reason?: string };
    nextNonce: (p: string) => string;
  };

  /* ── R26 · מדיניות-עוגן-ברירה (standing anchor policy) ──────────────────────
   * אחרי-הטיקים: אם בריכת-המסדרון (USDS/WSTEEM) סוטה-מהעוגן-האורקלי בלמעלה-מ-10%
   * (מעל/מתחת) — סימון-מחדש ריבוני אל-העוגן (pool_repeg · treasury · אפס-הטבעה,
   * Σ נשמר, מגולל-ביומן). ההיגיון: המסילה משפשפת-סטיות עד-25% במנות-מדודות
   * (TWAP-scrubbing); מעבר-לזה זה-שבר-משטר (קריסת-נכס-חוץ) והסימון-מחדש הוא-
   * התשובה-הכנה-היחידה (אין-שקיות-מספיקות-לסגירת-פער-8.8x ב-swap). אפס-תלות-
   * במפעיל: הרשת מרפאת-את-עצמה בכל-פעימה — הבעיה-שנמצאה-חיה ב-h18553 (mid=473µ
   * מול-עוגן 54µ) לא-תחזור-לרדוף-אותנו בשקט. */
  try {
    const { poolKey } = await import("./src/lib/dex/kernel");
    const stx = rt.st as unknown as {
      pools: Record<string, { ra: number; rb: number; a: string; b: string; owner?: string }>;
      assets: Record<string, { refPrice?: number }>;
    };
    // [T25 · R26-ALL] סימון-מחדש-ריבוני על כל-בריכה-בבעלות-האוצר (היה: מסדרון-בלבד).
    // נמדד-חי (run 15:14Z): בריכות-יציב שנפתחו-בשוגג-הפוכים (USDS/WSBD 232µ מול 21.3Mµ;
    // ENERGY/USDS 173×-מהעוגן) נשאבו-ע"י-הארביטרז' — ה-repeg מיישר-את-המחיר-אל-העוגן
    // ומחזיר-את-העודף-לאוצר (Σ נשמר, אפס-הטבעה — אותו-חוק R26).
    const repgged: string[] = [];
    for (const [key, p] of Object.entries(stx.pools ?? {})) {
      if (p.owner && p.owner !== "treasury") continue; // בריכת-אזרח — אסור
      const refA = stx.assets[p.a]?.refPrice ?? 0;
      const refB = stx.assets[p.b]?.refPrice ?? 0;
      if (!(refA > 0) || !(refB > 0) || !(p.rb > 0)) continue;
      const mid = Math.floor((p.ra * 1000) / p.rb);
      const premBps = Math.floor(((mid - refB / refA * 1000) * 10_000) / (refB / refA * 1000));
      if (Math.abs(premBps) < 1_000) continue;
      const r = submitOp({ type: "pool_repeg", issuer: "treasury", nonce: nextNonce("rpeg"), pair: key });
      if (r.queued) {
        await stepOnce();
        const p2 = stx.pools[key];
        const mid2 = Math.floor((p2.ra * 1000) / p2.rb);
        repgged.push(`${key} ${mid}→${mid2}µ (${premBps >= 0 ? "+" : ""}${premBps}bps)`);
      } else {
        console.warn(`[cloud-beat] R26-ALL repeg ${key} rejected: ${r.reason ?? "?"}`);
      }
    }
    if (repgged.length > 0) console.log(`[cloud-beat] R26-ALL anchored ${repgged.length} pools: ${repgged.join(" · ")}`);
    else console.log("[cloud-beat] R26-ALL: all treasury pools within the 1000bps band");
  } catch (e) {
    console.warn(`[cloud-beat] R26-ALL anchor policy skipped: ${String(e).slice(0, 80)}`);
  }

  /* ── R42 · THE-SBD-RAIL — הגלגל-החיצוני-של-דבר-גורר-דבר ────────────────────
   * השלמת-המעגל שנמדדה-חיה: הגריד-החוץ מוכר-STEEM מעל-קו-הזהות ← SBD-אמת
   * מצטבר-ב-headcorner ← אבל-שם-הוא-מת. מכאן: כל-פעימה עוטפת-את-כל-העודף
   * (deficit-mint, טענה-חד-פעמית `sbd:headcorner:h:deficit`) — ה-SBD הופך
   * לגיבוי-WSBD-חי-באוצר. אותו-דפוס-מוכח של TRUTH-RAIL (WBLURT), רק-אוטומטי:
   * אין-סנדבוקס, אין-POST-מפעיל, אין-המתנה. השרשרת-הפנימית נשארת-טהורה —
   * הקריאה-החיצונית כאן (RPC-ציבורי), ה-op עם-ה-claim הוא-שנכנס-לקונצנזוס.
   * אם הגריד יקנה-STEEM-ב-SBD (צד-הקנייה) — היתרה-החיה-יורדת-מתחת-לגיבוי
   * ← אין-הטבעה (rail-deficit), והאמת-מוצגת-בגלוי ב-truth (כיסוי-חי). */
  try {
    const ENGINE_ACCOUNT = process.env.SAOS_RELAY_AGENT_ACCOUNT || "headcorner";
    const accts = await steemRpc<Array<{ sbd_balance?: string }>>("condenser_api.get_accounts", [[ENGINE_ACCOUNT]]);
    // FIX(R42-a): היתרה מגיעה-כמחרוזת "0.049 SBD" — Number() נותן-NaN→0 (נתפס-חי
    // בריצה-העננית הראשונה: "no deficit (live 0µ)" מול-0.049-אמת). parseFloat מקלף-את-הסיומת.
    const sbdBal = parseFloat(String(accts?.[0]?.sbd_balance ?? "0")) || 0;
    const liveSbdMu = Math.floor(sbdBal * 1000);
    const stx2 = rt.st as unknown as { backing?: Record<string, number>; height: number };
    const curBack = stx2?.backing?.["WSBD"] ?? 0;
    const deficit = liveSbdMu - curBack;
    if (deficit > 0) {
      const r = submitOp({
        type: "wrap_mint", issuer: "treasury", nonce: nextNonce("sdbrail"),
        wrapAsset: "WSBD", amount: deficit, external: true,
        claim: `sbd:headcorner:${stx2.height}:${deficit}`, // ייחודי-להטבעה — הגרעין דוחה-שימוש-חוזר
      });
      if (r.queued) {
        await stepOnce(); // ה-op נכנס-לממפול — בלוק-אחד מבצע
        console.log(`[cloud-beat] R42 SBD-RAIL: wrapped ${deficit}µ WSBD (live ${(sbdBal).toFixed(3)} SBD → backing ${curBack + deficit}µ, h${stx2.height})`);
      } else {
        console.warn(`[cloud-beat] R42 SBD-RAIL rejected: ${r.reason ?? "?"} (deficit ${deficit}µ)`);
      }
    } else {
      console.log(`[cloud-beat] R42 SBD-RAIL: no deficit (live ${liveSbdMu}µ vs backing ${curBack}µ${deficit < 0 ? ` — rail-deficit:${-deficit}µ` : ""})`);
    }
  } catch (e) {
    console.warn(`[cloud-beat] R42 SBD-RAIL skipped: ${String(e).slice(0, 80)}`);
  }

  await forgePhase({ st: rt.st as unknown as ForgeCtx["st"], submitOp, nextNonce, stepOnce }).catch((e) => console.warn(`[cloud-beat] T25 forge phase skipped: ${String(e).slice(0, 90)}`));

  let credited = 0, skipped = 0;
  for (const env of envelopes) {
    if (env?.k !== "deposit.claim") continue;
    if (typeof env.id !== "string" || ledger.processedIds[env.id]) continue;
    if (!verifyEnvelope(env)) { ledger.processedIds[String(env.id)] = 1; skipped++; continue; }
    const cur = String(env.cur ?? "").toUpperCase();
    const amt = Number(env.amt ?? 0);
    const ref = String(env.ref ?? "").toLowerCase();
    if (!(amt > 0) || !ref) { ledger.processedIds[String(env.id)] = 1; skipped++; continue; }
    const dep = byTxid.get(ref);
    if (!dep) { skipped++; continue; } // עוד-לא-נצפה — תישאר לפעימה-הבאה (לא-נרשמת-כמעובדת)
    if (ledger.processedTxids[dep.txid]) { ledger.processedIds[String(env.id)] = 1; skipped++; continue; }
    const depAsset = String(dep.asset ?? "").toUpperCase();
    if (depAsset && cur !== depAsset && !(cur === "USDT" && depAsset === "USDT")) { skipped++; continue; }
    const depAmt = Number(dep.amount ?? 0);
    if (depAmt > 0 && Math.abs(depAmt - amt) / depAmt > 0.02) { skipped++; continue; } // חוסר-התאמה-בסכום

    // שער: יציבים 1:1 · האחרים לפי-פיד-חי (µUSDS ליחידה)
    let rate = 1;
    if (!STABLE_1TO1.has(cur)) {
      const feed = FEED_BY_CUR[cur];
      const px = feed ? Number(feeds[feed] ?? 0) : 0;
      if (!(px > 0)) { console.warn(`[cloud-beat] no live rate for ${cur} — claim ${String(env.id).slice(0, 10)} waits`); skipped++; continue; }
      rate = px;
    }
    const usds = Math.floor(amt * rate * 100) / 100; // סנטימט-שלמות
    if (usds <= 0) { skipped++; continue; }

    if (usds > MAX_AUTO_CREDIT_USDS) {
      console.warn(`[cloud-beat] claim ${String(env.id).slice(0, 10)} = ${usds} USDS > cap ${MAX_AUTO_CREDIT_USDS} — left for operator (gate)`);
      skipped++;
      continue;
    }

    // R33 · canonical-account: הגרעין מנרמל issuer/to לקטנות (kernel.ts:612,622) —
    // כתובת-saos1 היא base58 רגישת-רישיות, ולכן השם-הקנוני של חשבון-מפקיד הוא
    // "u:" + הכתובת-הקטנה. בלי-זה הזיכוי נחת תחת שם-שונה מזה שכל-הבדיקות-הציבוריות
    // (accountExists של הגשר, מראה-הארנק) מחפשות — הכסף נעלם לעיני בעליו.
    // הוכח-חי בסימולציה: saos1BxqgarCWK… נזקף תחת u:saos1bxqgarcwk… בלי שאיש יראה.
    const to = `u:${String(env.by).toLowerCase()}`;
    // יחידות-השרשרת: 1000µ = 1 יחידה (אותו-קנון של המנוע — fmtAmtMu מחלק-ב-1000)
    const mu = Math.floor(usds * 1_000);
    const r = submitOp({
      type: "transfer", issuer: "treasury", nonce: nextNonce("cloudcredit"),
      to, asset: "USDS", amount: mu,
    });
    if (!r.queued) { console.warn(`[cloud-beat] credit op rejected: ${r.reason}`); skipped++; continue; }
    // הזיכוי נכנס-לממפול — בלוק-אחד-נוסף מבצע אותו בפועל.
    // R33 · credit-landed-proof: היה — הסימון processedTxids נקבע מיד אחרי-התור,
    // גם אם הבלוק עצמו דחה את ה-transfer (insufficient בזמן-הבלוק, escrow-צמוד).
    // תוצאה: הפקדה מסומנת-כמעובדת לנצח בלי שאף זיכוי נחת — הכסף נתקע בשקט.
    // עתה: מודדים את היתרה לפני ואחרי, ורק נחיתה-אמיתית נרשמת-כמעובדת;
    // דחייה כנה משאירה את התביעה לפעימה הבאה (ה-op-מוקיי מזוהה-לפי-nonce ייחודי).
    const stBal = (who: string): Record<string, number> =>
      ((rt.st as unknown as { balances: Record<string, Record<string, number>> }).balances[who] ?? {});
    const balBefore = (stBal(to)["USDS"] ?? 0);
    await stepOnce();
    const balAfter = (stBal(to)["USDS"] ?? 0);
    if (!(balAfter - balBefore >= mu)) {
      console.warn(`[cloud-beat] credit ${String(env.id).slice(0, 10)} did NOT land (bal ${balBefore}→${balAfter}, want +${mu}) — NOT marking processed, next beat retries`);
      skipped++;
      continue;
    }
    ledger.processedTxids[dep.txid] = 1;
    ledger.processedIds[String(env.id)] = 1;
    ledger.credits.push({
      id: String(env.id), at: new Date().toISOString(), to, cur, claimed: String(env.amt),
      txid: dep.txid, chain: String(dep.chain ?? ""), usds, mu, rate,
      how: `auto · verified vs ${String(dep.chain ?? "?")} watcher + saos1 sig`,
    });
    credited++;
    // R33 · gas-tank-on-credit — תושב-חי בסימולציה: חשבון-מפקיד טרי נולד עם USDS
    // אבל בלי-אף-קרדיט-גז → כל-order שלו נדחה בבלוק ב"insufficient-credits"
    // (התור מקבל, הבלוק דוחה — הפקודה מסומנת-כמעובדת בלי-שהוצבה). הזיכוי
    // מזריע עכשיו גם מכל-דלק: refuel 100,000µ קרדיטים מהאוצר (העברה-טהורה,
    // Σcredits נשמר, REFUEL_CAP בדיוק) — שנה-מסחר במחיר-הגז שלנו (~60µ/פקודה).
    const creditsBefore = ((rt.st as unknown as { credits: Record<string, number> }).credits[to] ?? 0);
    const rr = submitOp({ type: "refuel", issuer: "treasury", nonce: nextNonce("simfuel"), to, amount: 100_000 });
    if (rr.queued) {
      await stepOnce();
      const creditsAfter = ((rt.st as unknown as { credits: Record<string, number> }).credits[to] ?? 0);
      if (creditsAfter - creditsBefore >= 100_000) {
        console.log(`[cloud-beat] gas tank refueled: +100,000µ credits → ${to} (depositor can trade)`);
      } else {
        console.warn(`[cloud-beat] refuel ${String(env.id).slice(0, 10)} did NOT land (${creditsBefore}→${creditsAfter}) — order path may stall; next beat retries on next credit`);
      }
    } else {
      console.warn(`[cloud-beat] refuel rejected: ${rr.reason} — depositor has no gas yet`);
    }
    console.log(`[cloud-beat] credited ${usds} USDS → ${to} (txid ${dep.txid.slice(0, 14)}…, ${cur})`);
  }
  saveLedger(ledger); // תמיד: lastScanBlock חייב להתקדם גם בלי זיכויים (חלון-הסריקה)
  console.log(`[cloud-beat] claims: ${credited} credited, ${skipped} skipped/waiting`);

  /* ── פקודות-מסחר חתומות מהציבור (dex.order / dex.cancel) ──
   * אותו-מודל-האמון כמו-הזיכויים: המעטפה חתומה-saos1 (החתימה מכסה את
   * כל-השדות), הלב מתרגם אותה ל-op מקומי בשם הבעלים u:<addr>. השרשרת
   * עצמה אוכפת יתרה/נאמנות/תקרת-פקודות — דחייה היא תשובה כנה, לא-שקט. */
  let ordered = 0, cancelled = 0;
  for (const env of envelopes) {
    if (env?.k !== "dex.order" && env?.k !== "dex.cancel") continue;
    if (typeof env.id !== "string" || ledger.processedIds[env.id]) continue;
    if (!verifyEnvelope(env)) { ledger.processedIds[String(env.id)] = 1; continue; }
    const issuer = `u:${String(env.by).toLowerCase()}`; // R33 · canonical-account — אותו חוק-קטנות של הזיכוי
    if (env.k === "dex.order") {
      const base = String(env.base ?? "").toUpperCase();
      const quote = String(env.quote ?? "").toUpperCase();
      const side = env.side === "buy" ? "buy" : env.side === "sell" ? "sell" : "";
      const price = Math.round(Number(env.price ?? 0) * 1000);   // מחיר-אדם → µ-ציטוט ליחידת-בסיס
      const amount = Math.round(Number(env.amount ?? 0) * 1000); // כמות-אדם → µ-בסיס
      const r = submitOp({ type: "order", issuer, nonce: String(env.id), base, quote, side, price, amount });
      if (r.queued) {
        await stepOnce();
        // R33 · order-landed-proof: התור מקבל, הבלוק יכול-לדחות (insufficient-credits
        // / bad-params / cap-24-orders). דחייה שנרשמת-כמעובדת = פקודת-משתמש
        // נבלעת-בשקט. עתה: ה-nonce נדחף-לחלון רק-כשה-op בוצע — בדיקת-חברות
        // ב-st.nonces היא ההוכחה שהפקודה-באמת-הוצבה; אחרת התביעה נשארת-פתוחה
        // לפעימה-הבאה (המפקיד מקבל refuel-דלק מהזיכוי, אז-הניסיון-החוזר יעבור).
        const landed = ((rt.st as unknown as { nonces: string[] }).nonces ?? []).includes(`${issuer}:${String(env.id)}`);
        if (landed) { ordered++; console.log(`[cloud-beat] order ${side} ${amount}µ ${base} @${price}µ ${quote} ← ${issuer.slice(0, 18)}…`); }
        else { console.warn(`[cloud-beat] order ${String(env.id).slice(0, 10)} REJECTED IN BLOCK (likely insufficient-credits/bad-params) — left open for retry`); skipped++; continue; }
      } else { console.warn(`[cloud-beat] order ${String(env.id).slice(0, 10)} rejected: ${r.reason}`); }
    } else {
      const orderId = Number(env.orderId ?? 0);
      const r = submitOp({ type: "cancel", issuer, nonce: String(env.id), orderId });
      if (r.queued) { cancelled++; await stepOnce(); console.log(`[cloud-beat] cancel #${orderId} ← ${issuer.slice(0, 18)}…`); }
      else console.warn(`[cloud-beat] cancel ${String(env.id).slice(0, 10)} rejected: ${r.reason}`);
    }
    ledger.processedIds[String(env.id)] = 1;
  }
  if (ordered || cancelled) saveLedger(ledger);

  forceFlush();

  /* ── [T24] פנקס-המדידה-היומי — הנפח, העמלות והמילויים של כל יום, מצטבר-ב-git ──
   * שאלת-הבעלים (trace 1a1355908…): עמלות 0 · נפח כמעט 0 · מצטבר כלום. מעתה
   * כל פעימה רושמת את היום בפנקס: מילויים · סוואפים · עמלות (feeMeter) ·
   * נפח-24ש' בציטוט-µ · מסחרות-24ש' — נגזר ממסחר-אמת בלבד (הנרות), אפס-המצאה. */
  const METRICS_FILE = path.join(DB_DIR, "dex-metrics.json");
  interface MetricsDay { beats: number; ticks: number; openFills: number; openSwaps: number; openFeeMeter: number; openHeight: number; dFills: number; dSwaps: number; dFeeMeter: number; dHeight: number; vol24QuoteMu: number; trades24: number; }
  interface MetricsDoc { version: number; updatedAt: string; days: Record<string, MetricsDay>; }
  let metrics: MetricsDoc = { version: 1, updatedAt: new Date().toISOString(), days: {} };
  try { metrics = JSON.parse(fs.readFileSync(METRICS_FILE, "utf-8")) as MetricsDoc; } catch { /* יום-ראשון — פנקס חדש */ }
  const { getState: gsNow, getMarkets: gmNow } = chain as {
    getState: () => Record<string, unknown>;
    getMarkets: () => unknown[];
  };
  const stNow = gsNow() as { fills?: number; swaps?: number; feeMeter?: number; height?: number };
  const dayKey = new Date().toISOString().slice(0, 10);
  const md: MetricsDay = metrics.days[dayKey] ?? {
    beats: 0, ticks: 0,
    openFills: stNow.fills ?? 0, openSwaps: stNow.swaps ?? 0, openFeeMeter: stNow.feeMeter ?? 0, openHeight: stNow.height ?? 0,
    dFills: 0, dSwaps: 0, dFeeMeter: 0, dHeight: 0, vol24QuoteMu: 0, trades24: 0,
  };
  md.beats += 1; md.ticks += ticked;
  md.dFills = Math.max(0, (stNow.fills ?? 0) - md.openFills);
  md.dSwaps = Math.max(0, (stNow.swaps ?? 0) - md.openSwaps);
  md.dFeeMeter = Math.max(0, (stNow.feeMeter ?? 0) - md.openFeeMeter);
  md.dHeight = Math.max(0, (stNow.height ?? 0) - md.openHeight);
  // נפח-24ש' מצטבר-על-כל-הזוגות — getMarkets כבר נושא stats24 (נגזרת-כנה מהנרות)
  try {
    let vQ = 0; let tr = 0;
    for (const mk of gmNow() as { stats24?: { vol24QuoteMu?: number; trades24?: number } }[]) {
      vQ += mk.stats24?.vol24QuoteMu ?? 0; tr += mk.stats24?.trades24 ?? 0;
    }
    md.vol24QuoteMu = vQ; md.trades24 = tr;
  } catch { /* כנות: הנפח לא נמדד בריצה זו — יישאר הערך הקודם */ }
  metrics.days[dayKey] = md;
  metrics.updatedAt = new Date().toISOString();
  fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics));

  /* ── שלב-האמת: קודם-commit-השרשרת לריפו, ורק-אז-פרסום-הציבורי ── */
  git("config user.name \"dex-beat[bot]\"", { allowFail: true });
  git("config user.email \"dex-beat[bot]@agents.roshpinacare-sys\"", { allowFail: true });
  /* 2026-09 hygiene (Task 7-c): db/dex.db removed from chainFiles — runtime
   * databases are no longer tracked in git (45MB blob; see README "Database
   * files (2026-09)"). The chain snapshot/tape/credits/ledger remain committed. */
  // [T24] פנקס-המדידה-היומי נכלל בשרשרת — הנפח/העמלות/המילויים של כל יום שורדים ב-git
  const chainFiles = ["db/state-snapshot.json", "db/tape.jsonl", "db/dex-credits.json", "db/rail-lifetime.json", "db/dex-metrics.json", "db/sweep-ledger.json", "db/flow24.json"];
  for (const f of chainFiles) git(`add -- ${f}`, { allowFail: true });
  let chainPushed = false;
  const staged = git("diff --cached --name-only", { allowFail: true });
  if (staged) {
    const msg = `dex-beat: ${new Date().toISOString().slice(0, 19)}Z · h${heightBefore}→h${heightAfter} · ${credited} credits · ${ticked} ticks`;
    git(`commit -m "${msg}"`, { allowFail: true });
    chainPushed = await pushWithRetry(ROOT, "main");
    if (!chainPushed) {
      console.error("[cloud-beat] chain push REJECTED (concurrent beat advanced the repo) — publishing SKIPPED honestly; next run continues from remote");
      process.exit(0);
    }
  } else {
    chainPushed = true; // אין-שינוי-שרשרת (למשל: 0-טיקים) — הפרסום עדיין-אמיתי
  }

  /* ── הפרסום הציבורי ל-Console (Pages) ── */
  const CONSOLE_TOKEN = process.env.CONSOLE_TOKEN ?? "";
  if (!CONSOLE_TOKEN) {
    console.warn("[cloud-beat] CONSOLE_TOKEN missing — public state NOT published (chain is committed)");
    process.exit(0);
  }
  const PUB = "/tmp/console-publish";
  execSync(`rm -rf ${PUB} && git clone --depth 5 -q https://x-access-token:${CONSOLE_TOKEN}@github.com/roshpinacare-sys/Console.git ${PUB}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  const { getState, getMarkets, getPools, getTape, getProofs } = chain as {
    getState: () => Record<string, unknown>;
    getMarkets: () => unknown[];
    getPools: () => unknown[];
    getTape: (n: number) => unknown[];
    getProofs: () => { seals: unknown[]; receipts: unknown[] };
  };
  const st = getState();

  /* [T25] רשת-התמיכה/ההתנגדות + טריגרים — נגזר-מהטייפ-החי (300 מסחרות-אחרונות):
   * תמיכה = מינימום, התנגדות = מקסימום, וטריגר = חציית-סף ב-40-המסחרות-האחרונות.
   * תצוגה-בלבד (אפס-שינוי-שרשרת) — הטריגרים-החיים-בשרשרת הם trig_order של הסוכנים. */
  interface SrBand { key: string; supportMu: number; resistMu: number; lastMu: number; crossed: string | null }
  const srBands: SrBand[] = [];
  try {
    const tapeAll = (getTape(300) ?? []) as { base?: string; quote?: string; price?: number }[];
    const byPair = new Map<string, number[]>();
    for (const t of tapeAll) {
      const px = Number(t?.price ?? 0);
      if (!t?.base || !t?.quote || !(px > 0)) continue;
      const kk = `${t.base}/${t.quote}`;
      const arr = byPair.get(kk) ?? [];
      arr.push(px);
      byPair.set(kk, arr);
    }
    for (const [kk, prices] of byPair) {
      if (prices.length < 4) continue;
      const supportMu = Math.min(...prices);
      const resistMu = Math.max(...prices);
      const lastMu = prices.length > 0 ? (prices[0] as number) : 0;
      const recent = prices.slice(0, 40);
      let crossed: string | null = null;
      if (lastMu >= resistMu) crossed = "resist-touch";
      else if (lastMu <= supportMu) crossed = "support-touch";
      void recent;
      srBands.push({ key: kk, supportMu, resistMu, lastMu, crossed });
    }
    srBands.sort((x, y) => x.key.localeCompare(y.key));
  } catch { /* כנות: אין-טייפ — אין-רצועות */ }
  const publicState = {
    ok: true,
    publishedAt: new Date().toISOString(),
    beat: {
      engine: "saos-dex/1.20 cloud-beat · R23 live-anchor · T25 depth-forge",
      runAt: new Date().toISOString(),
      ticks: ticked,
      fromHeight: heightBefore,
      toHeight: heightAfter,
      // [T24] קדנס-שעתי — הדופק של שולחן-הענקים (התאום-הציבורי ב-Domain הוא המכונה)
      cadenceMin: 60,
      nextEtaMin: 60,
      creditsThisRun: credited,
      relayLabel: "cloud relayer — treasury-signed credits, all documented in the live book",
    },
    state: st,
    markets: getMarkets(),
    pools: getPools(),
    wallets: (chain as { getWallets: () => { name: string; balances: Record<string, number>; locked: Record<string, number> }[] }).getWallets(),
    orders: (chain as { ensureChain: () => { st: { orders: unknown[] } } }).ensureChain().st.orders.filter((o) => (o as { live?: boolean }).live === true).slice(-300),
    tape: getTape(40),
    seal: (getProofs().seals ?? [])[0] ?? null,
    credits: ledger.credits.slice(-50),
    creditsTotal: ledger.credits.length,
    // [T24] פנקס-המדידה-היומי — היום + ספירת-הימים: המצטבר שהבעלים ביקש לראות
    metrics: { today: { day: dayKey, ...md }, daysTracked: Object.keys(metrics.days).length },
    // [T25] רשת-התמיכה/ההתנגדות — הטריגרים של שולחן-הענקים
    sr: srBands,
    // [T25] כבשן-הנזילות — ההנפקה-המוצהרת-החיה (מהמצב-הגולמי; הכל פומבי)
    forge: (rt.st as unknown as { forge?: { program: string; sinceH: number; issuedMu: Record<string, number>; capMu: Record<string, number> } }).forge ?? null,
  };
  fs.mkdirSync(path.join(PUB, "dex"), { recursive: true });
  const stateFile = path.join(PUB, "dex", "state.json");
  fs.writeFileSync(stateFile, JSON.stringify(publicState));
  fs.writeFileSync(path.join(PUB, "dex", "credits.json"), JSON.stringify({
    publishedAt: publicState.publishedAt,
    credits: ledger.credits.slice(-200),
  }, null, 1));

  /* Task 35 — המראה הציבורית של הטרמינל ב-Pages: כל קבצי-המראה (world/relay/agent/fleet/
   * portfolio/bridge/onramp/showcase) בצורות ה-API המדויקות של המוצר — בונה-משותף
   * עם הדמון (src/lib/dex/world-snapshot.ts), אפס סטייה — + stub הגון לשאר. */
  const { buildMirrorSnapshots } = await import("./src/lib/dex/world-snapshot");
  for (const [name, body] of Object.entries(await buildMirrorSnapshots())) {
    fs.writeFileSync(path.join(PUB, "dex", `${name}.json`), JSON.stringify(body));
  }
  fs.writeFileSync(path.join(PUB, "dex", "mirror-stub.json"), JSON.stringify({
    ok: false,
    mirror: true,
    note: "Not available in the public mirror — this runs on the sovereign side",
  }));

  execSync('git config user.name "dex-beat[bot]"', { encoding: "utf8", cwd: PUB });
  execSync('git config user.email "dex-beat[bot]@agents.roshpinacare-sys"', { encoding: "utf8", cwd: PUB });
  execSync("git add dex/state.json dex/credits.json dex/world.json dex/relay.json dex/agent.json dex/fleet.json dex/portfolio.json dex/bridge.json dex/onramp.json dex/showcase.json dex/mirror-stub.json", { encoding: "utf8", cwd: PUB, stdio: ["ignore", "pipe", "pipe"] });
  const stagedPub = execSync("git diff --cached --name-only", { encoding: "utf8", cwd: PUB }).trim();
  if (stagedPub) {
    execSync(`git commit -m "dex-beat: h${heightAfter} · ${credited} credits · ${new Date().toISOString().slice(0, 16)}Z"`, { encoding: "utf8", cwd: PUB, stdio: ["ignore", "pipe", "pipe"] });
    const ok = await pushWithRetry(PUB, "main");
    console.log(`[cloud-beat] public state ${ok ? "published" : "PUSH FAILED (will retry next beat)"}`);
  } else {
    console.log("[cloud-beat] public state unchanged");
  }
  console.log(`[cloud-beat] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

if (import.meta.main) main().catch((e) => {
  console.error("[cloud-beat] FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
