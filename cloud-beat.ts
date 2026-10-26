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
import { readFileSync } from "node:fs";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { WASH_ENABLED } from "./src/lib/dex/mm"; import { WASH_FLOOR } from "./src/lib/dex/kernel"; // W0.3-followup: wash gates live in the engine
import { secp256k1 } from "@noble/curves/secp256k1";
import bs58 from "bs58";
import { envelopeToKernelOp } from "./src/lib/dex/envelope";

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
  /* Task 23: hcsaosdep01 — זהות-המפעיל-השנייה (נולדה-אמת 2026-10-19, txid 8e444f93…)
   * — ערוץ-ההפקדות/התביעות של האורגניזם מלבד-ראש-המסורת; מפתחות-בכספת (600). */
  "hcsaosdep01",
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
  // W33 fail-honest: the publish push failed silently twice in a row (16:08Z,
  // 16:21Z) with errors swallowed — a book that cannot publish must SAY why.
  for (let i = 0; i < tries; i++) {
    try {
      execSync(`git push origin ${branch}`, { encoding: "utf8", cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      return true;
    } catch (e) {
      const why = String((e as { stderr?: string; message?: string }).stderr ?? (e as { message?: string }).message ?? e).split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300);
      console.error(`[cloud-beat] push try ${i + 1}/${tries} FAILED: ${why || "(no stderr — inspect runner)"}`);
      try {
        execSync(`git pull --rebase --autostash origin ${branch}`, { encoding: "utf8", cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e2) {
        console.error(`[cloud-beat] rebase try ${i + 1} failed: ${String((e2 as { stderr?: string }).stderr ?? e2).split("\n").slice(-2).join(" | ").slice(0, 200)}`);
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
  return false;
}

/* ── T37-e · קבלת-כשל-פורנזית (forensics-on-failure) ────────────────────────
 * נמדד-חי (T36 · ה-HALT של-h151812): הריצה-הכושלת לא דחפה דבר ל-git — ה-op
 * המדויק-שחתך את היתרה היה בלתי-ניתן-לשחזור (הפורנזיקה נאלצה לנחש מהיומן).
 * השורש: דחיפת-הקבלות חיה-רק בסוף-ריצה-מוצלחת; HALT-אתחול/FATAL מתים בלי
 * לדחוף — בדיוק-הריצות-הכושלות הן-הראיות-היקרות.
 * החוק: כל-נתיב-כשל דוחף קבלת-כשל (best-effort — לעולם לא מסתיר את קוד-היציאה
 * האמיתי): גובה · סיבת-ההעצה · זנב-היומן (סוגי-ה-op האמיתיים!) · הדחיות-האחרונות
 * · מפת-הקרדיטים · stateRoot. היומן-כבר-חי-במצב — זה רק מנוע-הדחיפה-שלו.
 */
async function pushFailureReceipt(reason: string, snap?: { halted?: boolean; haltReason?: string | null; st?: unknown }): Promise<void> {
  try {
    const st = (snap?.st ?? {}) as {
      height?: number; journal?: { h: number; t: number; soldier: string; action: string; note: string }[];
      credits?: Record<string, number>; stateRoot?: string; treasuryProfit?: number; feeMeter?: number;
      stats?: { rejectedLast?: unknown };
    };
    const receipt = {
      ok: false,
      reason,
      halted: snap?.halted ?? null,
      haltReason: snap?.haltReason ?? null,
      height: st.height ?? null,
      stateRoot: st.stateRoot ?? null,
      treasuryProfit: st.treasuryProfit ?? null,
      feeMeter: st.feeMeter ?? null,
      credits: st.credits ?? null,
      rejectedLast: st.stats?.rejectedLast ?? null,
      journalTail: (st.journal ?? []).slice(-40),
      at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(ROOT, "db", "failure-receipt.json"), JSON.stringify(receipt, null, 1));
    execSync('git config user.name "dex-beat[bot]"', { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    execSync('git config user.email "dex-beat[bot]@agents.roshpinacare-sys"', { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    execSync("git add db/failure-receipt.json", { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const staged = execSync("git diff --cached --name-only", { encoding: "utf8", cwd: ROOT }).trim();
    if (staged) {
      execSync(`git commit -m "failure-receipt: ${reason.slice(0, 80).replace(/[,\"\`]/g, " ")} · h${st.height ?? "?"}"`, { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
      const ok = await pushWithRetry(ROOT, "main");
      console.log(`[cloud-beat] failure receipt ${ok ? "pushed" : "PUSH FAILED (local only — next run overwrites)"}`);
    }
  } catch (e) {
    console.warn(`[cloud-beat] failure-receipt push skipped: ${String(e).slice(0, 80)}`);
  }
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
  // צף-השטיפה — W0.3-followup (2026-10-17, owner-approved wave-0): מנוטר עם-המנוע.
  // WASH_ENABLED=false ⇒ אפס-הזרמת-צף/דלק לארנק-wash — אחרת-הביט בונה מצבור-מלאי
  // מזויף על-הספרים למכונה-שכבר-לא-סוחרת. החזרת-ההזרמה = אותו-שער בלבד
  // (WASH_ENABLED=true) + החלטת-בעלים מתועדת + תווית volume=synthetic.
  if (!WASH_ENABLED) console.log("[cloud-beat] wash disabled (W0.3) — no float/gas provisioning, no synthetic depth");
  if (WASH_ENABLED) {
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
  } // W0.3-followup: end WASH_ENABLED guard
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
    // T37-e: גם-HALT-אתחול דוחף קבלת-כשל (הראיה-היקרה) — ואז יוצא כנה.
    await pushFailureReceipt(`boot-halt: ${rt.haltReason ?? "?"}`, { halted: rt.halted, haltReason: rt.haltReason, st: (rt as unknown as { st?: unknown }).st });
    console.error(`[cloud-beat] chain HALTED — refusing to advance. reason: ${rt.haltReason ?? "?"}`);
    process.exit(1);
  }
  stopLoops(); // ריצה-עננית: בלי-טיימרי-קיר — צעדים-סנכרוניים בלבד
  const heightBefore = rt.st.height;
  console.log(`[cloud-beat] chain loaded · height ${heightBefore}`);

  const { submitOp, nextNonce } = chain as unknown as {
    submitOp: (op: Record<string, unknown>) => { queued: boolean; reason?: string };
    nextNonce: (p: string) => string;
  };

  /* ── EXEC-CD-9-completion · THE-PRIMER-FIRE (חיבור-ההצתה-המוכרזת) ──────────
   * נמדד-חי (h135139 · 2026-10-14): הפריימר הוכרז (EXEC-CD-9), ממומש-בגרעין
   * (case "primer"), מאושר-מפעיל — ומעולם לא נורה (primerUsed=undefined).
   * התוצאה-המדודה: כל-הארנה מתה-על-גז (אוצר 14µ · חיילים 0–5µ · בוטים 5–15µ מול
   * גז-פקודה 60µ) — שומר-הסף (SETTLE-17-c) וכל-מציטי-הספר משותקים; מחזור-
   * ה-bookgas יבש (אין-שריפת-ספר — אין-מה-למחזר); המזרקה נעולה (meter על
   * רצפת-8,000 · profit 892µ). ההצתה-החד-פעמית-המוצהרת היא הפריצה-הכנה:
   * +1Mµ קרדיטים בספליט-קבוע, מגוללת-ביומן, מוצהרת-בביקורת (primerPortion).
   * אידמפוטנטי-בדחייה — מי-שכבר-נורה מדלג-בכנות. לפני-לופ-הטיקים — כך כל-
   * הפעימה-עצמה רצה-על-דלק-חי. */
  try {
    const stp = rt.st as unknown as { primerUsed?: boolean };
    if (!stp.primerUsed) {
      const r = submitOp({ type: "primer", issuer: "treasury", nonce: nextNonce("primer") });
      if (r.queued) {
        await stepOnce();
        console.log("[cloud-beat] THE-PRIMER FIRED: +1,000,000µ credits (arena 300K · bot-a/b/c 150K×3 · treasury 150K · operator 100K) — book arena re-primed");
      } else console.warn(`[cloud-beat] primer rejected: ${r.reason ?? "?"}`);
    } else console.log("[cloud-beat] primer already fired — idempotent skip");
  } catch (e) { console.warn(`[cloud-beat] primer phase skipped: ${String(e).slice(0, 80)}`); }

  /* ── EXEC-CD-10 · THE-REPRIME-2 — הצתת-הדלק-מחדש (חד-פעמית, מנומקת-במדידה) ──
   * נמדד-חי (2026-10-20 · origin/main h683,667): Σcredits=12,839µ בלבד (operator
   * 179 · treasury/wash/arena/בוטים 0) — המלאי נשרף-כולו דרך-מחזור-ה-bookgas-החוקי,
   * המזרקה מטביעה 27µ-בלבד, וכל-op-גז נדחה: אותו-דפוס-קפוא של-EXEC-CD-9 ("אף-op-
   * לא-עובר → אף-גז-לא-נאסף → אין-מה-למחזר"). חוק-הגרעין reprime (אותו-משפט-פריימר:
   * אוצר-בלבד · פעם-אחת-לנצח · ספליט-קבוע 2Mµ · feeMinted↑ · מוצהר-בביקורת).
   * שער-הסף בענן: נורה רק כשהספר בתשישות-אמת (Σcredits < 100Kµ) — אידמפוטנטי. */
  try {
    const stx_r = rt.st as unknown as { reprimeUsed?: boolean; credits?: Record<string, number> };
    const sumCr = Object.values(stx_r.credits ?? {}).reduce((s, v) => s + (typeof v === "number" ? v : 0), 0);
    if (!stx_r.reprimeUsed && sumCr < 100_000) {
      const r = submitOp({ type: "reprime", issuer: "treasury", nonce: nextNonce("reprime") });
      if (r.queued) {
        await stepOnce();
        const sumCr2 = Object.values((rt.st as unknown as { credits?: Record<string, number> }).credits ?? {}).reduce((s, v) => s + (typeof v === "number" ? v : 0), 0);
        console.log(`[cloud-beat] THE-REPRIME-2 FIRED: +2,000,000µ credits (arena 500K · treasury 500K · bot-a/b/c 200K×3 · operator 400K) — Σcredits ${sumCr}→${sumCr2}, book lanes re-armed`);
      } else console.warn(`[cloud-beat] reprime rejected: ${r.reason ?? "?"}`);
    } else console.log(`[cloud-beat] reprime gate: used=${!!stx_r.reprimeUsed} Σcredits=${sumCr} — idempotent skip`);
  } catch (e) { console.warn(`[cloud-beat] reprime phase skipped: ${String(e).slice(0, 80)}`); }

  /* ── SETTLE-19-c · רזרבת-הדלק-ההפוכה (fuel-reversal) ─────────────────────
   * נמדד-חי (run 38568088488: הפריימר-נשחק-בריצה-אחת; run 38569794882: 3,894
   * דחיות-גז, הגשר-משותק): גז-האוצר הוא הפקק-החוזר-של-ספר-ה-סרוו. בזמן-זאת
   * השטיפה מחזיקה 1.87Mµ-קרדיטים-עומדים (הצף-המסחרי-שלה אבק — הסוואפים-שלה
   * נדחים-bad-quote) — הון-דלק-מת. החוק: כשהאוצר מתחת-לרצפת-ספר-הסרוו (500Kµ)
   * והשטיפה מעל-רצפת-ה-1M שלה — המחזור-ההפוך: השטיפה מעירה-את-האוצר (עד
   * 5×REFUEL_CAP=500Kµ לפעימה). העברה-טהורה (אפס-הטבעה, Σ נשמר, מגולל-ביומן);
   * הדלק חוזר-לשטיפה מהעמלות שהיא-עצמה מייצרת (מד-העמלות → מזרקה). לפני-
   * לופ-הטיקים — כך-הסרוו-ושומר-הסף רצים-על-דלק-חי מהבלוק-הראשון. */
  try {
    const stf = rt.st as unknown as { credits?: Record<string, number> };
    const tCr = stf.credits?.["treasury"] ?? 0;
    const wCr = stf.credits?.["wash"] ?? 0;
    if (tCr < 500_000 && wCr > 1_000_000) {
      let moved = 0;
      for (let i = 0; i < 5; i++) {
        const need = Math.min(500_000 - (stf.credits?.["treasury"] ?? 0), (stf.credits?.["wash"] ?? 0) - 1_000_000, 100_000);
        if (need <= 0) break;
        const r = submitOp({ type: "refuel", issuer: "wash", nonce: nextNonce("washfuel"), to: "treasury", amount: need });
        if (!r.queued) { console.warn(`[cloud-beat] fuel-reversal rejected: ${r.reason ?? "?"}`); break; }
        moved += need;
        await stepOnce();
      }
      if (moved > 0) console.log(`[cloud-beat] SETTLE-19-c fuel-reversal: wash→treasury +${moved}µ credits (wash floor 1M intact — idle reserve re-armed the book lane)`);
    }
  } catch (e) { console.warn(`[cloud-beat] fuel-reversal skipped: ${String(e).slice(0, 80)}`); }

  // W0.3-followup · GAS-RECOVERY runs HERE — before the tick loop (measured 2026-10-17:
  // forgePhase ran post-ticks, so 120 ticks executed with a 22µ treasury: 100% op rejection.
  if (!WASH_ENABLED) {
    console.log("[cloud-beat] wash disabled (W0.3) — no float/gas provisioning, no synthetic depth");
    // W0.3-followup · GAS-RECOVERY (2026-10-17): the dead machine's reserve is
    // strangling the whole book — measured 2026-10-17: Σcredits=1,008,792µ of
    // which wash held 995,900µ (98.7%); treasury=22µ, arena=20µ → every book op
    // rejected insufficient-credits (60+ rejections/block, dex-beat commits
    // literally say "0 credits"). This pulls ONLY the legally-pullable band
    // (credits above WASH_FLOOR — the DAM-OPEN 800,000µ owner law of 2026-10-15
    // is respected to the µ; any deviation below the floor stays an owner
    // ratification, per the dam law's own wording). Pure refuel ops: zero-mint,
    // Σcredits conserved, journaled per-op. The fleet's own FUEL_FUNDERS
    // machinery takes it from there.
    const washCr = (rt.st as unknown as { credits?: Record<string, number> }).credits?.["wash"] ?? 0;
    const pullable = Math.max(0, washCr - WASH_FLOOR);
    if (pullable > 0) {
      let pulled = 0;
      for (let i = 0; i < 40 && pulled < pullable; i++) {
        const amt = Math.min(100_000, pullable - pulled, ((rt.st as unknown as { credits?: Record<string, number> }).credits?.["wash"] ?? 0) - WASH_FLOOR);
        if (amt <= 0) break;
        const r = submitOp({ type: "refuel", issuer: "wash", nonce: nextNonce("washrecall"), to: "treasury", amount: amt });
        if (!r.queued) { console.warn(`[cloud-beat] gas-recovery refuel rejected: ${r.reason ?? "?"}`); break; }
        pulled += amt;
        await stepOnce();
      }
      console.log(`[cloud-beat] GAS-RECOVERY: wash→treasury +${pulled}µ credits (floor=${WASH_FLOOR}µ per DAM-RELEASE 2026-10-17 owner ratification; zero-mint, Σ conserved)`);
    } else {
      console.log("[cloud-beat] GAS-RECOVERY: wash reserve already at owner floor — nothing legally pullable");
    }
  }

  // פיד-האורקל: רענון-מחירים חי לפני-הטיקים + בכל-~120 טיקים
  await oracleTickOnce().catch(() => {});
  /* [W2 (2026-10-18) · owner directive "ודא שהמערכת לא תנטרל את עצמה מהחיובים/פעולות שלה"]
   * ECON-STASIS — שובר-רצפה כלכלי. מדידה: wash הושחר חוקית ל-0 (DAM-RELEASE W1.3,
   * אשרור-בעלים "כן תמשיך שחרר"), treasury=0, Σ=15,963µ ושורפת ~420µ/שעה → ~38 שעות-ריצה
   * ואז דחיות insufficient-credits מציפות את הביט (מחלת-ה-Σ0 המדודה 2026-10-17).
   * החוק החדש: מתחת לרצפה — העבודה המחויבת-גז (הטיקים) נעצרת כנה, הביט ממשיך לחייב-שרשרת
   * (commit+label+receipts) ומדגל לבעלים. הפיך בקבוע אחד; לא נוגע ב-WASH_FLOOR ששוחרר. */
  const ECON_STASIS_FLOOR = 5_000; // µ — ≈12 שעות-ריצה בקצב-השריפה הנמדד; הרמה/הורדה = מילת-בעלים
  const liveSumCredits = Object.values((rt.st as unknown as { credits?: Record<string, number> }).credits ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
  let econStasis = false;
  if (liveSumCredits < ECON_STASIS_FLOOR) {
    econStasis = true;
    console.error(`[cloud-beat] ECON-STASIS: Σ credits ${liveSumCredits}µ < floor ${ECON_STASIS_FLOOR}µ — billed work SKIPPED this beat (owner flag: fuel floor reached; mint_fuel/recycle policy decision pending) — chain bookkeeping stays alive, honestly`);
  }
  let ticked = 0;
  if (!econStasis) for (let i = 0; i < CLOUD_TICKS; i++) {
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
    /* FIX(Task 23 · 2026-10-20 · credit-rate-bug): ההמרה-הישנה הצהירה extFeeds כ-Record<string,number>
     * והלולאה קראה feeds["steem"] — תמיד-undefined (המחירים תחת .usd) → "no live rate" לנצח, כל-זיכוי-נכס-לא-יציב
     * הושתק-מבנית גם-כשהפיד-חי (נמדד: oracle_set WSTEEM=0.0521$ באותה-ריצה בה "no live rate"). עתה: חילוץ-usd. */
    const f = await (pp as unknown as { extFeeds: (force?: boolean) => Promise<unknown> }).extFeeds(true);
    feeds = ((f as { ok?: boolean; usd?: Record<string, number | null> })?.ok ? (f as { usd: Record<string, number | null> }).usd : {}) as Record<string, number>;
  } catch (e) { console.warn(`[cloud-beat] extFeeds unavailable: ${String(e).slice(0, 60)}`); }

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
    const reseeded: string[] = [];
    for (const [key, p] of Object.entries(stx.pools ?? {})) {
      if (p.owner && p.owner !== "treasury") continue; // בריכת-אזרח — אסור
      const refA = stx.assets[p.a]?.refPrice ?? 0;
      const refB = stx.assets[p.b]?.refPrice ?? 0;
      if (!(refA > 0) || !(refB > 0) || !(p.rb > 0)) continue;
      const mid = Math.floor((p.ra * 1000) / p.rb);
      const premBps = Math.floor(((mid - refB / refA * 1000) * 10_000) / (refB / refA * 1000));
      if (Math.abs(premBps) < 1_000) continue;
      // [G76-a · USDS-AMM-ACTIVATION] dead-pool branch: כשמתמטיקת-ה-repeg אינה
      // מסוגלת (raNew = refB×rb/refA ≤ 0 — rb-אבק) או שהבריכה מעל ±10,000bps
      // מהעוגן — ה-repeg נדחה-מבנית כל-פעימה (kernel "bad-anchor"/dust-add על
      // USDS/WSBD המדוד: rb=1µ). pool_reseed הוא הנתיב-החוקי-היחיד: זריעה
      // דו-צדדית מדויקת-על-העוגן ממלאי-אוצר-חופשי (fail-closed; חסום-בכנות
      // עם-הסיבה כל-עוד הצף-ריק — הפעימה מפרסמת, אף-המצאה).
      const raRepeg = Math.floor((refB * p.rb) / refA);
      if (raRepeg <= 0 || Math.abs(premBps) >= 10_000) {
        const { reseedOpFor } = await import("./src/lib/dex/usds-activation");
        const rs = reseedOpFor(rt.st as never, key, nextNonce("rseed"));
        if (!rs.executable) {
          console.log(`[cloud-beat] G76-a reseed ${key} BLOCKED (fail-honest): ${rs.blocked.join(" | ")}`);
          continue;
        }
        const r = submitOp(rs.op as unknown as Record<string, unknown>);
        if (r.queued) {
          await stepOnce();
          const p2 = stx.pools[key];
          const mid2 = p2 ? Math.floor((p2.ra * 1000) / p2.rb) : 0;
          reseeded.push(`${key} ${mid}→${mid2}µ (seed ${rs.seedA}/${rs.seedB}µ)`);
        } else console.warn(`[cloud-beat] G76-a reseed ${key} rejected: ${r.reason ?? "?"}`);
        continue;
      }
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
    if (reseeded.length > 0) console.log(`[cloud-beat] G76-A RESEEDED ${reseeded.length} dead pools: ${reseeded.join(" · ")}`);
    if (repgged.length > 0) console.log(`[cloud-beat] R26-ALL anchored ${repgged.length} pools: ${repgged.join(" · ")}`);
    else if (reseeded.length === 0) console.log("[cloud-beat] R26-ALL: all treasury pools within the 1000bps band");
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
      /* FIX(Task 23 · credit-issuer): היה issuer=treasury — נמדד-חי (04:29Z): transfer(treasury):insufficient-credits
       * — לאוצר 0-קרדיטי-דלק (השרשרת-כולה ב-ECON-STASIS) והזיכוי נדחה-לנצח גם-עם-יתרת-USDS. המפעיל
       * מחזיק גם-USDS (12.6Mµ) וגם-דלק (180) — זו-הסמכות-החיה-שמנפיקה-עתה; הפנקס-רושם-את-המנפיק-בגלוי. */
      type: "transfer", issuer: "operator", nonce: nextNonce("cloudcredit"),
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
  let ordered = 0, cancelled = 0, transferred = 0, registered = 0;
  /* ── המתרגם הקנוני (envelope.ts) — סגירת לולאת-המשתמש ──────────────────
   * עד-היום הלב קיפל רק dex.order/dex.cancel — בזמן שה-wallet הציבורי מחתים
   * dex.offer {cur,units,price} · token.transfer {symbol,to,amount} · wallet.create.
   * פקודות משתמש חתומות נבלעו בשקט (נמדד). מעתה: כל הסוגים מתורגמים אחיד ל-op-גרעין:
   *   · dex.offer → order sell SAOS/<cur> (החוזה-הוותיק של ה-wallet, units=µ)
   *   · dex.order → החוזה-המוסדי המלא (base/quote/side, אדם→µ)
   *   · dex.cancel → orderId או offerId — שני השמות בשטח מקבלים אותה משמעות
   *   · token.transfer → transfer של נכס-ידוע-גרעין (µ)
   *   · wallet.create → אישור-קיום כנה: אין רישום-פקטיבי; חשבון-גרעין חי
   *     מהזיכוי/הפעולה הראשונה (R33, self-serve)
   * סוגים לא-ידועים נשארים פתוחים — לא נסגרים כמעובדים (מהדורה-עתידית עשויה
   * להבין). אימות-החתימה קודם-לתרגום; השרשרת עצמה אוכפת יתרה/נאמנות/דלק —
   * דחיית-בלוק היא תשובה כנה והתביעה נשארת פתוחה לפעימה-הבאה. */
  const { knownAsset } = await import("./src/lib/dex/kernel");
  const stK = rt.st as unknown as Parameters<typeof knownAsset>[0];
  const stx = rt.st as unknown as {
    nonces: string[]; orders: { id: number; owner: string; live: boolean }[];
    balances: Record<string, Record<string, number>>;
  };
  for (const env of envelopes) {
    const envK = String(env?.k ?? "");
    if (envK !== "dex.order" && envK !== "dex.offer" && envK !== "dex.cancel" && envK !== "token.transfer" && envK !== "wallet.create") continue;
    if (typeof env.id !== "string" || ledger.processedIds[env.id]) continue;
    if (!verifyEnvelope(env)) { ledger.processedIds[String(env.id)] = 1; continue; }
    const t = envelopeToKernelOp(env);
    if (!t.ok) { console.warn(`[cloud-beat] envelope ${String(env.id).slice(0, 10)} (${envK}) not translatable: ${t.reason}`); continue; }
    const issuer = `u:${String(env.by).toLowerCase()}`; // R33 · canonical-account — אותו חוק-קטנות של הזיכוי
    if (t.kind === "ack") {
      // wallet.create: אין op-גרעין — נסגר פעם-אחת בכנות (החשבון נולד מהפעולה הראשונה).
      ledger.processedIds[String(env.id)] = 1; registered++; continue;
    }
    // שער-נכסים: זוג/נכס לא-ידוע-גרעין יידחה-בכל-פעימה לנצח — נסגר בכנות עם סיבה.
    if (t.kind === "order" && !(knownAsset(stK, t.op.base) && knownAsset(stK, t.op.quote))) {
      console.warn(`[cloud-beat] order ${String(env.id).slice(0, 10)}: unknown asset pair ${t.op.base}/${t.op.quote} — closing honestly (no retry spam)`);
      ledger.processedIds[String(env.id)] = 1; continue;
    }
    if (t.kind === "transfer" && !knownAsset(stK, t.op.asset)) {
      console.warn(`[cloud-beat] transfer ${String(env.id).slice(0, 10)}: unknown asset ${t.op.asset} — closing honestly`);
      ledger.processedIds[String(env.id)] = 1; continue;
    }
    // dex.cancel על פקודה שאינה חיה עוד תחת הבעלים — אין מה לבטל; נסגר בכנות.
    if (t.kind === "cancel" && !stx.orders.find((o) => o.live && o.id === t.op.orderId && o.owner === issuer)) {
      console.warn(`[cloud-beat] cancel ${String(env.id).slice(0, 10)}: order #${t.op.orderId} not live under ${issuer.slice(0, 18)}… — nothing to cancel (closing honestly)`);
      ledger.processedIds[String(env.id)] = 1; continue;
    }
    const op = { ...t.op, issuer, nonce: String(env.id) } as Record<string, unknown>;
    const balBefore = t.kind === "transfer" ? (stx.balances[String(t.op.to)]?.[String(t.op.asset)] ?? 0) : 0;
    const r = submitOp(op);
    if (!r.queued) { console.warn(`[cloud-beat] ${envK} ${String(env.id).slice(0, 10)} rejected by queue: ${r.reason}`); continue; }
    await stepOnce();
    // R33 · landed-proof (אותו חוזה של הזיכויים): התור מקבל, הבלוק יכול-לדחות —
    // רק נחיתה-אמיתית נרשמת-כמעובדת; דחייה כנה משאירה את התביעה לפעימה-הבאה.
    if (t.kind === "order") {
      const landed = (stx.nonces ?? []).includes(`${issuer}:${String(env.id)}`);
      if (landed) { ordered++; console.log(`[cloud-beat] order ${t.op.side} ${t.op.amount}µ ${t.op.base} @${t.op.price}µ ${t.op.quote} ← ${issuer.slice(0, 18)}…`); }
      else { console.warn(`[cloud-beat] order ${String(env.id).slice(0, 10)} REJECTED IN BLOCK (likely insufficient-credits/bad-params) — left open for retry`); skipped++; continue; }
    } else if (t.kind === "cancel") {
      const landed = !stx.orders.find((o) => o.live && o.id === t.op.orderId && o.owner === issuer);
      if (landed) { cancelled++; console.log(`[cloud-beat] cancel #${t.op.orderId} ← ${issuer.slice(0, 18)}…`); }
      else { console.warn(`[cloud-beat] cancel ${String(env.id).slice(0, 10)} did NOT land — left open for retry`); skipped++; continue; }
    } else {
      const landed = (stx.balances[String(t.op.to)]?.[String(t.op.asset)] ?? 0) - balBefore >= Number(t.op.amount);
      if (landed) { transferred++; console.log(`[cloud-beat] transfer ${t.op.amount}µ ${t.op.asset} → ${String(t.op.to).slice(0, 18)}…`); }
      else { console.warn(`[cloud-beat] transfer ${String(env.id).slice(0, 10)} did NOT land (bal ${balBefore}→${stx.balances[String(t.op.to)]?.[String(t.op.asset)] ?? 0}) — left open for retry`); skipped++; continue; }
    }
    ledger.processedIds[String(env.id)] = 1;
  }
  if (ordered || cancelled || transferred || registered) saveLedger(ledger);

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
  /* [W1.5 agent-zai] pre-commit integrity gate — measured 17.10 (a6d7806 repair):
   * conflict markers once reached db/state-snapshot.json and red-x4 the beat for
   * 4.5h before diagnosis. Law: the boot arbiter must parse BEFORE we commit it.
   * Fail-closed: refuse the chain commit, keep the tree honest, exit 2. */
  let sumCredits = -1;
  try {
    const snap = JSON.parse(readFileSync("db/state-snapshot.json", "utf8")) as { credits?: Record<string, number>; state?: { credits?: Record<string, number> } };
    /* W2-fix (measured 2026-10-18): the snapshot nests credits under `state` — the
     * W1.6 label read the top level and reported Σ0 while the real Σ was ~16Kµ
     * (same mis-path I made locally minutes earlier — the "empty economy" was a
     * read-path artifact, not famine). Both shapes accepted, nested wins. */
    sumCredits = Object.values(snap.state?.credits ?? snap.credits ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
  } catch (gateErr) {
    console.error(`[cloud-beat] INTEGRITY-GATE: db/state-snapshot.json unparseable (${String(gateErr).slice(0, 140)}) — chain commit REFUSED (fail-closed, W1.5)`);
    process.exit(2);
  }
  let chainPushed = false;
  const staged = git("diff --cached --name-only", { allowFail: true });
  if (staged) {
    /* [W1.6] honest beat label — '0 credits' was claims-credited-THIS-beat, read
     * by the owner (and by agents) as the economy being empty. The label now
     * reports both: claims this run AND the real Σ balance from the snapshot. */
    const msg = `dex-beat: ${new Date().toISOString().slice(0, 19)}Z · h${heightBefore}→h${heightAfter} · claimed${credited} · Σ${sumCredits} credits · ${ticked} ticks`;
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
    execSync(`git commit -m "dex-beat: h${heightAfter} · claimed${credited} · Σ${sumCredits} credits · ${new Date().toISOString().slice(0, 16)}Z"`, { encoding: "utf8", cwd: PUB, stdio: ["ignore", "pipe", "pipe"] });
    const ok = await pushWithRetry(PUB, "main");
    console.log(`[cloud-beat] public state ${ok ? "published" : "PUSH FAILED (will retry next beat)"}`);
  } else {
    console.log("[cloud-beat] public state unchanged");
  }
  console.log(`[cloud-beat] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

if (import.meta.main) main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("[cloud-beat] FATAL:", msg);
  // T37-e: FATAL דוחף קבלת-כשל לפני-היציאה — הפורנזיקה של-הריצה-הכושלת חיה-ב-git.
  await pushFailureReceipt(`fatal: ${msg.slice(0, 120)}`).catch(() => {});
  process.exit(1);
});
