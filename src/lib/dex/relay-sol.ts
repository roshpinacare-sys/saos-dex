/* relay-sol.ts — מתאם-עיגון Solana עבור ה-Relay של SAOS-DEX (SPL Memo v2).
 *
 * מקור: הקוד-החי של המפעיל (steem@main · agent/xwallet.cjs --solana-feed) —
 * עסקת-devnet חיה שהוכחה בו: fee-payer, לקוח באפס-SOL, בניית-מסר ידנית
 * (compact-u16, blockhash מ-RPC, MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr),
 * חתימת-ed25519 ושידור-base64. ההתאמה כאן: עיגון-ממו עצמי של ה-Relay דרך
 * זהות-הצי (wallets-registry idx=2 — נגזרת מהזרע-הריבוני, מעוגנת במניפסט
 * txid 9f593bdc…).
 *
 * מסקנות-ארכיטקטוניות (מתועדות ב-WORKLOG_PHASE5.md):
 *  · עקומה: Solana הוא Ed25519 — לא-ניתן לחתימה עם ה-secp256k1-WIF של
 *    headcorner. הזהות ה-SOL נגזרת מהזרע-הריבוני: sha256(seed|sol|headcorner)
 *    → ed25519-seed32 → base58.
 *  · stateRoot: רוכב בתוך הממו (בייטים חופשיים) — ללא-המרה; נקרא-חזרה מהלוג
 *    של getTransaction (אי-אמון-עצמי).
 *  · כלכלה: הרצפה-האמתית = פטור-משכרת (~890,880-lamports) + 5,000-עמלה —
 *    הוכח-בסימולציה-חיה (roast-67): מתחת-לפטור השידור נופל InsufficientFundsForRent.
 *    ברירת-מחדל mainnet-beta — SOL_RPC_URL משמש לעקיפה.
 *
 * אבטחה: מפתח בזיכרון בלבד מ-.env (gitignored); אפס סודות בלוגים/פלט;
 * אימות-עצמי fail-closed — כתובת-נגזרת חייבת להתאים לכתובת-הצפוי.
 *
 * חוזה-החתימה שש-השלבים (Task 12-a — port נאמן מ-relay-eth.ts · e5d22e5 ומ-
 * relay.ts · 0bc6927; המימוש-הקנוני: Saosmartwallet orchestrator.ts 6/6):
 *   · session-gate (stage 1/6): אין-פתרון-מפתח בלי סשן-חתימה חי —
 *     SOL_SIGNING_SESSION_UNLOCKED=1 (חימוש-מפעיל לכל-אתחול-תהליך; דו-מפתחי:
 *     מפתחות-ה-.env לבדם כבר-אינם-משדרים) או unlockSolSigningSession()
 *     (API · TTL של שעה · step-up timing-safe). נאכף לפני-כל-חשיפת-מפתח —
 *     סדר-השורות הוא-החוזה (דוקטרינת live_gate 10-d-3).
 *   · policy-gate (stage 2/6): evaluatePolicy לפני-כל-נגיעה-במפתח —
 *     allowed-operations (עיגון chain-seal עצמי בלבד) · תפקיד-נפתר ·
 *     replay-guard (אותו (epoch,height) כבר-עוגן בשרשרת-הביקורת = שידור-חוזר) ·
 *     repeat-guard (port מ-budget.py — commit אחרי-הצלחה בלבד) · תקציב-עמלות
 *     יומי מהשרשרת-המבוקרת. שלילה = policy_violation + זריקה — לעולם לא הסגרה.
 *   · least-privilege-role (stage 3/6): מיפוי-כנה למציאות-הסולנית — ל-Solana
 *     אין-נגזרת-סמכויות (posting/active) על-השרשרת: לכל-keypair רשות-יחידה.
 *     התפקיד נפתר מהצהרת-המפעיל (SOL_SIGNER_ROLES, ברירת-מחדל active — פעולת-
 *     ערך: שורפת 5,000-lamports) ונרשם בביקורת; חסר-תפקיד מסרב (flavor-less,
 *     לא ממיר). ההגבלה-המבנית היא רשימת-הפעולות-המותרות: ממו-עצמי בלבד,
 *     אפס-העברת-טוקנים, אפס-פקודות-תוכנית אחרות.
 *   · reveal-once (stage 4/6) + capability-checked-broadcast (stage 5/6):
 *     בייטי-ה-seed חיים רק במסגרת-החתימה (revealSolKey → ed25519.sign); שידור
 *     הוא יכולת נפרדת מחתימה (SOL_BROADCAST_ENABLED מעניק; requireCapability
 *     אוכף; time-lock נכבד). מבנה-העסקה (buildMemoMessage · סדר-החתימות ·
 *     sendTransaction base64) נשמר בייט-מול-בייט — אפס-שינוי-חוזה-רשת.
 *   · audit-trail (stage 6/6): key_used / signing_attempt / broadcast /
 *     policy_violation — כולל כשלים והמתנות-כלכליות — בשרשרת-ה-hash המשותפת
 *     של relay-eth (state/signing-audit.jsonl דרך appendAudit · AUDIT_FILE ·
 *     SAOS_DEX_STATE_DIR מנתב-בידוד-בדיקות). אפס חומר-מפתח באירועים
 *     (מזהים/גבהים/txids/עמלות בלבד). נמדד 6/6 ב-saos-jummper
 *     signingcontract.check.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { fencedFetch } from "./fence"; // FIX(SETTLE-11)+FIX(Roast-65-b · H2): גדר + redirect:error מרוכזים
import { createHash, timingSafeEqual } from "crypto";
import fs from "fs";
// Task 12-a · חוזה-החתימה שש-השלבים — אותם-פרימיטיבים בדיוק (שער-אחד, שרשרת-ביקורת-אחת):
// SigningGateError = קודי-השער · appendAudit = הפרימיטיב-המבוקר (hash-chain על
// state/signing-audit.jsonl) · fingerprint/AUDIT_FILE = קנוניות משותפת ל-repeat/replay/תקציב.
import { SigningGateError, appendAudit, fingerprint, AUDIT_FILE,
  type KeyRole, type PolicyCheck, type SignerKeyRecord } from "./relay-eth";

export const SOL_RPCS = (process.env.SOL_RPC_URL
  ? [process.env.SOL_RPC_URL]
  // FIX(SETTLE-7 rail-alignment): היה-devnet-כבריתת-מחדל בעוד settle.ts-מאזין
  // mainnet-beta — שידור-וביקורת קראו-לשתי-רשתות-שונות. ברירת-המחדל מיושרת
  // ל-mainnet-beta (השידור עדיין fail-closed: בלי SOL_EXPECTED_ADDRESS אין-שידור).
  : ["https://api.mainnet-beta.solana.com"]);

export const SOL_MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"; // SPL Memo v2
const SIGNATURE_FEE_LAMPORTS = 5_000;   // עמלת-חתימה בסיסית
const RENT_EXEMPT_FALLBACK = 890_880;   // מינימום-פטור-משכרת-לחשבון-0-בייטים (ריצפה-קנונית)
const RENT_MARGIN_LAMPORTS = 1_000;     // מרווח-זעיר מעל הפטור
// FIX(Roast-67 · sol-rent-floor): הישן BALANCE_FLOOR=10_000 — שקר-מבני. הוכח-חי
// (simulateTransaction מול-mainnet): InsufficientFundsForRent{account_index:0} —
// חשבון-החותם חייב-להיות **פטור-משכרת** (890,880-lamports ל-0-בייטים) ולא רק-לשלם-עמלה.
// עכשיו: הרצפה-דינמית = rentExempt(מ-RPC, fallback-קנוני) + עמלה + מרווח — והודעת-ה-unfunded
// מדויקת: כמה-חסר-בפועל (לא עוד-"Transaction simulation failed"-תעלומתי).

/* ── base58 (מורשת xwallet.cjs — אותה-אלגוריתמיקה) ── */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58Encode(buf: Uint8Array): string {
  let n = BigInt("0x" + Buffer.from(buf).toString("hex"));
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = B58[0] + out; else break; }
  return out;
}
function b58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad base58 char"); n = n * 58n + BigInt(i); }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const buf = Buffer.from(hex, "hex");
  let pad = 0;
  for (const c of s) { if (c === B58[0]) pad++; else break; }
  return Buffer.concat([Buffer.alloc(pad), buf]);
}

export interface SolIdentity { address: string; }

/* ── זהות: seed-32B (hex) → כתובת base58 ── */
export function solIdentity(secretHex: string): SolIdentity {
  const seed = Buffer.from(secretHex.replace(/^0x/, ""), "hex");
  if (seed.length !== 32) throw new Error("sol key must be a 32-byte ed25519 seed");
  return { address: b58Encode(ed25519.getPublicKey(seed)) };
}

/* ══════════════════════════════════════════════════════════════════════
 * חוזה-החתימה שש-השלבים (Task 12-a) — אותן-צורות בדיוק כמו relay-eth.ts
 * (שער-אחד נאכף לפני כל בייט-מפתח; שרשרת-ביקורת אחת לכל-החותמים בתהליך).
 * ══════════════════════════════════════════════════════════════════════ */

/* ── סט-הסשן (stage 1/6) — state על globalThis (עמיד ל-hot-reload, כמו relay-eth) ── */

const SESSION_TTL_MS = 60 * 60 * 1000; // שעה — אחריה נדרש חימוש-מחדש (re-auth)

interface SolSigningSessionState {
  unlocked: boolean;
  source: "env" | "api" | null;
  unlockedAtMs: number | null;
  stepUpAtMs: number | null;
  capabilities: Set<string>;
}

const gSolSigning = globalThis as unknown as { __saosDexSolSigningSession?: SolSigningSessionState };
function signingSession(): SolSigningSessionState {
  if (!gSolSigning.__saosDexSolSigningSession) {
    gSolSigning.__saosDexSolSigningSession = { unlocked: false, source: null, unlockedAtMs: null, stepUpAtMs: null, capabilities: new Set() };
  }
  return gSolSigning.__saosDexSolSigningSession;
}

function sessionEnvArmed(): boolean {
  const v = (process.env.SOL_SIGNING_SESSION_UNLOCKED ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** פתיחת-סשן-חתימה מפורשת (API לקוראים אינטראקטיביים). stepUpToken אופציונלי —
 * מאומת מול SOL_SIGNING_STEPUP_TOKEN_SHA256 ומספק step-up (re-auth). */
export function unlockSolSigningSession(opts?: { stepUpToken?: string; source?: string }): void {
  const s = signingSession();
  s.unlocked = true;
  s.source = "api";
  s.unlockedAtMs = Date.now();
  if (opts?.stepUpToken && verifySolStepUp(opts.stepUpToken)) s.stepUpAtMs = Date.now();
}

/** step-up re-auth: השוואה timing-safe מול hash הטוקן שהמפעיל הגדיר. */
export function verifySolStepUp(token: string): boolean {
  const expected = (process.env.SOL_SIGNING_STEPUP_TOKEN_SHA256 ?? "").trim().toLowerCase();
  if (!expected || !token) return false;
  const got = createHash("sha256").update(token).digest("hex");
  const a = Buffer.from(got, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * stage 1/6 — session-gate: חייב לעבור לפני שכל מפתח נפתר (לפני revealSolKey —
 * סדר-השורות הוא-החוזה). סשן נעול = אף בייט-מפתח לא נוגע. תהליך-בלתי-מושגח
 * מחייב חימוש-מפעיל מפורש:
 *   SOL_SIGNING_SESSION_UNLOCKED=1  (חימוש-סשן לכל אתחול-תהליך) או
 *   unlockSolSigningSession()       (API — עם TTL של SESSION_TTL_MS).
 * SOL_SIGNING_REQUIRE_STEPUP=1 דורש step-up שהושלם גם עבור חימוש-env.
 */
function ensureUnlocked(): void {
  const s = signingSession();
  if (!s.unlocked && sessionEnvArmed()) {
    s.unlocked = true;
    s.source = "env";
    s.unlockedAtMs = Date.now();
  }
  if (!s.unlocked) {
    throw new SigningGateError(
      "SESSION_LOCKED",
      "sol signing session is locked — no key resolution for an unattended process (stage 1/6): arm SOL_SIGNING_SESSION_UNLOCKED=1 (or call unlockSolSigningSession) alongside SOL_BROADCAST_ENABLED",
    );
  }
  if (s.source === "api" && s.unlockedAtMs !== null && Date.now() - s.unlockedAtMs > SESSION_TTL_MS) {
    s.unlocked = false;
    s.source = null;
    s.unlockedAtMs = null;
    throw new SigningGateError("SESSION_EXPIRED", "sol signing session expired — re-unlock required before any key resolution (stage 1/6)");
  }
  if ((process.env.SOL_SIGNING_REQUIRE_STEPUP ?? "").trim() === "1" && s.stepUpAtMs === null) {
    throw new SigningGateError("POLICY_STEP_UP_REQUIRED", "step-up re-authentication demanded (SOL_SIGNING_REQUIRE_STEPUP=1) — unlockSolSigningSession({ stepUpToken }) required (stage 1/6)");
  }
}

/* ── stage 3/6 — פתרון-תפקיד (המיפוי-הכנה למציאות-הסולנית) ── */

/**
 * רשומת-זהות-ה-SOL של הצי (wallets-registry idx=2, מניפסט מעוגן). התפקידים
 * מוגדרים מפורשות דרך SOL_SIGNER_ROLES (רשימה מופרדת-פסיקים). ברירת-המחדל
 * "active" משקפת את המציאות: עיגון-הממו שורף 5,000-lamports (פעולת-ערך).
 * ערך ריק/none = מפתח חסר-תפקיד → מסרב (flavor-less, לא ממיר).
 */
export function signerKeyRecord(): SignerKeyRecord {
  const raw = (process.env.SOL_SIGNER_ROLES ?? "active").trim().toLowerCase();
  const roles = raw
    .split(",")
    .map((x) => x.trim())
    .filter((x): x is KeyRole => x === "active" || x === "posting");
  return { keyId: "sol-anchor-1", roles };
}

/**
 * התפקיד נגזר מהצהרת-המפעיל — מיפוי-כנה למציאות-הסולנית: ל-Solana אין-נגזרת-
 * סמכויות (posting/active) על-השרשרת — לכל-keypair רשות-יחידה, ואין required_
 * posting_auths. ההגבלה-המבנית היא רשימת-הפעולות-המותרות (ממו-עצמי בלבד).
 * prefer-posting: אם המפעיל הצהיר "posting" הוא הצר את-היכולת במפורש — נכבד.
 */
export function resolveRoleFor(opType: "sol_seal_broadcast"): KeyRole | null {
  if (opType !== "sol_seal_broadcast") return null; // פעולה-זרה = חסרת-תפקיד מבנית
  const roles = signerKeyRecord().roles;
  if (roles.length === 0) return null; // flavor-less — מסרב, לא ממיר (stage 3/6)
  return roles.includes("posting") ? "posting" : "active";
}

/** stage 3/6 — אכיפה post-policy: חסר-תפקיד מסרב; אי-התאמה מסרב. */
function requireRole(record: SignerKeyRecord, role: KeyRole | null): void {
  if (role === null || record.roles.length === 0) {
    throw new SigningGateError(
      "KEY_ROLELESS",
      `key ${record.keyId} is flavor-less (role null) — a role-less key refuses rather than defaulting (stage 3/6); set SOL_SIGNER_ROLES explicitly`,
    );
  }
  if (!record.roles.includes(role)) {
    throw new SigningGateError(
      "KEY_NOT_FOUND",
      `no ${role} key for the sol anchoring identity (SOL_SIGNER_ROLES=${record.roles.join(",") || "none"}) — refusing to drive a ${role}-role operation with the configured capabilities (stage 3/6)`,
    );
  }
}

/* ── מצב-החזרה (repeat-guard) — port מ-saos-jummper budget.py RepeatGuard:
 * כל-קריאה בודדות עוברות; הנזק הוא בחזרתיות ובצבירה. commit אחרי-הצלחה-בלבד. */

const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;
const REPEAT_MAX = 1;

const gSolRepeat = globalThis as unknown as { __saosDexSolRepeatSeen?: Map<string, number[]> };
function repeatSeen(): Map<string, number[]> {
  if (!gSolRepeat.__saosDexSolRepeatSeen) gSolRepeat.__saosDexSolRepeatSeen = new Map();
  return gSolRepeat.__saosDexSolRepeatSeen;
}

function repeatCount(fp: string, now: number): number {
  const kept = (repeatSeen().get(fp) ?? []).filter((t) => t >= now - REPEAT_WINDOW_MS);
  repeatSeen().set(fp, kept);
  return kept.length;
}

function commitRepeat(payload: unknown, now: number): void {
  const fp = fingerprint(payload);
  const seen = repeatSeen();
  seen.set(fp, [...(seen.get(fp) ?? []).filter((t) => t >= now - REPEAT_WINDOW_MS), now]);
}

/* ── שרשרת-הביקורת (stage 6/6) — נקראת מהפנקס-המשותף של relay-eth
 * (signing-audit.jsonl · SAOS_DEX_STATE_DIR מנתב-לבידוד-בדיקות, אותו-ניתוב
 * כמו anchors.json). ספירות-התקציב וה-replay נגזרות-ממנו — buildOperationContext
 * של ה-orchestrator: המדיניות קוראת-היסטוריה-מבוקרת, לא מנחשת. */

function readSolAuditStats(epoch: string, height: number): { spentLamportsToday: number; priorHeight: number | null } {
  const day = new Date().toISOString().slice(0, 10);
  let spentLamportsToday = 0;
  let priorHeight: number | null = null;
  try {
    for (const line of fs.readFileSync(AUDIT_FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as { type?: unknown; result?: unknown; at?: unknown; target?: Record<string, unknown> };
        if (ev.type !== "broadcast" || ev.result !== "success") continue;
        const t = (ev.target ?? {}) as { type?: unknown; epoch?: unknown; height?: unknown; feeLamports?: unknown };
        if (t.type !== "sol_seal_broadcast") continue; // רק-אירועי-המודול (ה-pipeline מרשים-בנפרד — לא ספירה-כפולה)
        if (typeof ev.at === "string" && ev.at.slice(0, 10) === day && typeof t.feeLamports === "number") {
          spentLamportsToday += t.feeLamports;
        }
        if (epoch && t.epoch === epoch && typeof t.height === "number" && t.height === height) {
          priorHeight = t.height; // אותו (epoch,height) כבר-עוגן-בהצלחה — שידור-חוזר
        }
      } catch { /* שורה-פגומה — נדלגת */ }
    }
  } catch { /* אין-ביקורת עדיין — תקציב מלא */ }
  return { spentLamportsToday, priorHeight };
}

/** תקציב-עמלות יומי — סכום-קצב-העצמי של המסילה הסולנית (econWaitMin("sol")=30דק'
 * → 48-עיגונים/יום × 5,000-lamports). ניתן-לעקיפה-מפורשת-למפעיל. */
function dailyLamportsLimit(): number {
  const raw = Number.parseInt(process.env.SAOS_SOL_ANCHOR_DAILY_LAMPORTS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 240_000;
}

/* ── שער-המדיניות (stage 2/6) ── */

export interface SolPolicyOp {
  type: "sol_seal_broadcast";
  payload: unknown;
  /** עמלת-השריפה המוערכת (lamports) — קבוע-ידוע לפני כל קריאת-רשת (fail-closed). */
  feeLamports: number | null;
}

/** port של PolicyDecision: שלילה זורקת — לעולם לא "אזהרה". */
export interface SolPolicyDecision {
  allowed: boolean;
  reasons: string[];
  checks: PolicyCheck[];
  role: KeyRole | null;
  requirements: { stepUpAuth: boolean; dailyLamports: number; timeLock: number };
}

function payloadHeight(payload: unknown): number | null {
  try {
    const h = (payload as { height?: unknown }).height;
    return typeof h === "number" && Number.isFinite(h) ? h : null;
  } catch {
    return null;
  }
}

function payloadEpoch(payload: unknown): string | null {
  try {
    const e = (payload as { epoch?: unknown }).epoch;
    return typeof e === "string" ? e : null;
  } catch {
    return null;
  }
}

function timelockSeconds(): number {
  const raw = Number.parseInt(process.env.SOL_BROADCAST_TIMELOCK_SECONDS ?? "0", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * stage 2/6 — evaluatePolicy: נרץ לפני שמפתח נוגע (לפני revealSolKey). כללים
 * סטטיים fail-closed (port של הכללים הקומפילים של PolicyEngine + budget.py):
 * שלילה = זריקה, לעולם לא הסגרה.
 */
export function evaluatePolicy(op: SolPolicyOp): SolPolicyDecision {
  const checks: PolicyCheck[] = [];
  const reasons: string[] = [];
  const denyGuard = (guard: string, reason: string): void => {
    checks.push({ guard, allowed: false, reason });
    reasons.push(`${guard}: ${reason}`);
  };

  // 1) allowed-operations — המסילה הזאת חותמת ומשדרת עיגון chain-seal עצמי בלבד
  //    (ממו-עצמי: אפס-העברת-טוקנים, אפס-פקודות-תוכנית אחרות — ההגבלה-המבנית של Solana)
  const p = (op.payload ?? {}) as { protocol?: unknown; action?: unknown; height?: unknown; stateRoot?: unknown; digest?: unknown };
  if (
    op.type === "sol_seal_broadcast" &&
    p.protocol === "saos-dex/v1" && p.action === "chain-seal" &&
    typeof p.height === "number" && Number.isFinite(p.height) && p.height >= 0 &&
    typeof p.stateRoot === "string" && /^[0-9a-f]{64}$/.test(p.stateRoot) &&
    typeof p.digest === "string" && p.digest.length > 0
  ) {
    checks.push({ guard: "allowed-operations", allowed: true, reason: `chain-seal h${p.height}` });
  } else {
    denyGuard("allowed-operations", "payload is not a saos-dex/v1 chain-seal anchor — refusing to sign foreign bytes");
  }

  // 2) תפקיד-מינימלי — חסר-תפקיד מסרב (flavor-less, לא ממיר)
  const role = resolveRoleFor(op.type);
  if (role === null) {
    denyGuard("role", `no signing role for the sol anchoring identity — a role-less key refuses rather than defaulting (stage 3/6); set SOL_SIGNER_ROLES explicitly`);
  } else {
    checks.push({ guard: "role", allowed: true, reason: `sol:${role} (resolved from the operator declaration — Solana has no on-chain authority derivation)` });
  }

  // 3) replay-guard — הצלחה-מבוקרת-קודמת באותו (epoch,height) = שידור-חוזר,
  //    גם-אם-בייטי-ה-payload סטו (loop-containment על-זהות-העיגן, לא על-התוכן)
  const stats = readSolAuditStats(payloadEpoch(op.payload) ?? "", payloadHeight(op.payload) ?? -1);
  if (stats.priorHeight !== null) {
    denyGuard("replay", `h${String(payloadHeight(op.payload))} was already anchored on solana in epoch ${String(payloadEpoch(op.payload))} (prior success in the audit chain) — a replayed height is a replay, not a decision`);
  } else {
    checks.push({ guard: "replay", allowed: true, reason: "no prior success at this height/epoch" });
  }

  // 4) repeat-guard (budget.py port) — הפעולה-הזהה כבר שודרה-בהצלחה בחלון = לולאה
  const now = Date.now();
  const prior = repeatCount(fingerprint(op.payload), now);
  if (prior >= REPEAT_MAX) {
    denyGuard("repeat", `identical sol payload already broadcast ${prior} time(s) within ${REPEAT_WINDOW_MS / 60000}min — a repeating identical operation is a loop, not a decision`);
  } else {
    checks.push({ guard: "repeat", allowed: true, reason: "not a repeat" });
  }

  // 5) תקציב-עמלות יומי (spentToday נקרא מהשרשרת-המבוקרת — buildOperationContext של ה-orchestrator)
  if (op.feeLamports !== null) {
    const limit = dailyLamportsLimit();
    if (stats.spentLamportsToday + op.feeLamports > limit) {
      denyGuard("daily-lamports-budget", `cumulative cap exceeded — spentToday ${stats.spentLamportsToday} + requested ${op.feeLamports} > limit ${limit} lamports (overage ${stats.spentLamportsToday + op.feeLamports - limit}) — honest economic hold`);
    } else {
      checks.push({ guard: "daily-lamports-budget", allowed: true, reason: `spentToday ${stats.spentLamportsToday}/${limit} lamports` });
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    checks,
    role,
    requirements: { stepUpAuth: (process.env.SOL_SIGNING_REQUIRE_STEPUP ?? "").trim() === "1", dailyLamports: dailyLamportsLimit(), timeLock: timelockSeconds() },
  };
}

/* ── reveal-once (stage 4/6) + יכולת-שידור (stage 5/6) ── */

/**
 * stage 4/6 — reveal-once: port של נקודת-התפר של vault.revealKeyFor — יציאת
 * המפתח-הגלוי היחידה במודול. בייטי-ה-seed חוזרים למסגרת-הקריאה בלבד; הרשומה
 * הציבורית נושאת אפס חומר-סוד. אין שמירה, החזרה או רישום של בייטי-מפתח.
 */
function revealSolKey(secretHex: string, record: SignerKeyRecord): { seed: Uint8Array; address: string } {
  const seed = Buffer.from(secretHex.replace(/^0x/, ""), "hex");
  if (seed.length !== 32) {
    throw new SigningGateError("VALIDATION", `key ${record.keyId} rejected at reveal: sol key must be a 32-byte ed25519 seed (stage 4/6)`);
  }
  return { seed: new Uint8Array(seed), address: b58Encode(ed25519.getPublicKey(seed)) };
}

function grantBroadcastCapabilityIfArmed(): void {
  const gate = (process.env.SOL_BROADCAST_ENABLED ?? "").trim().toLowerCase();
  if (gate === "1" || gate === "true") signingSession().capabilities.add("broadcast");
}

/** stage 5/6 — שידור הוא יכולת נפרדת מחתימה; בלי-מענק = זריקה מפורשת. */
function requireCapability(cap: "broadcast"): void {
  if (!signingSession().capabilities.has(cap)) {
    throw new SigningGateError(
      "BROADCAST_CAPABILITY_MISSING",
      `broadcast capability not granted on this signing session — signing never implies broadcasting (stage 5/6): arm SOL_BROADCAST_ENABLED`,
    );
  }
}

/** stage 5/6 — time-lock: סירוב מפורש בזמן-נעילה (port של broadcastSigned). */
function checkTimeLock(decision: SolPolicyDecision): void {
  if (decision.requirements.timeLock > 0) {
    throw new SigningGateError(
      "TIMED_LOCK",
      `broadcast is time-locked for another ${decision.requirements.timeLock}s — re-issue with broadcast once the lock expires (stage 5/6)`,
      { lockUntil: Date.now() + decision.requirements.timeLock * 1000 },
    );
  }
}

/* ── הגבלת-תדירות-רישום-ביקורת: סירוב-סשן חוזר בלולאת-ניסיונות לא יהפוך-לשטף-
 * אירועים. האכיפה-עצמה נאכפת-בכל-קריאה; רק-הרישום-מוגבל-תדירות. ── */
const AUDIT_THROTTLE_MS = 60 * 60 * 1000;
const gSolAuditAt = globalThis as unknown as { __saosDexSolAuditAt?: Map<string, number> };
function auditThrottled(key: string): boolean {
  const now = Date.now();
  const m = gSolAuditAt.__saosDexSolAuditAt ?? (gSolAuditAt.__saosDexSolAuditAt = new Map());
  const last = m.get(key) ?? 0;
  if (now - last < AUDIT_THROTTLE_MS) return true; // מוגבל-תדירות — השער עדיין נאכף
  m.set(key, now);
  return false;
}

function cu16(n: number): Buffer { // compact-u16 (Solana shortvec)
  if (n < 128) return Buffer.from([n]);
  const out: number[] = [];
  while (n >= 128) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}

/* ── JSON-RPC (אותו-היגיין-timeout) ── */
async function rpc<T>(endpoint: string, method: string, params: unknown[], timeoutMs = 20000): Promise<T> {
  // FIX(SETTLE-11): גדר-ריבונית fail-closed · FIX(Roast-65-b · H2): דרך-fencedFetch (redirect:error)
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fencedFetch(endpoint, "relay-sol.rpc", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "saos-relay/1.0" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctrl.signal });
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(String(json.error.message || "sol rpc error").slice(0, 120));
    return json.result as T;
  } finally {
    clearTimeout(t);
  }
}

/* ── בניית-מסר Solana: חותם-יחיד + Memo instruction ──
 * header [1,0,1] · keys [signer(writable), memoProgram(ro)] · blockhash ·
 * 1 instruction: programIdx=1, accounts=[0], memo-bytes. (התאמה מלאה למבנה
 * שהוכח ב-xwallet.cjs, עם חותם-יחיד במקום זוג fee-payer.) */
function buildMemoMessage(signer32: Uint8Array, memoProgram32: Uint8Array, blockhash32: Uint8Array, memoUtf8: string): Buffer {
  const memo = Buffer.from(memoUtf8, "utf8");
  return Buffer.concat([
    Buffer.from([1, 0, 1]),   // 1 חתימה-נדרשת · 0 ro-signed · 1 ro-unsigned
    cu16(2),                  // keyCount
    Buffer.from(signer32),
    Buffer.from(memoProgram32),
    Buffer.from(blockhash32), // recent blockhash
    cu16(1),                  // instructions count
    Buffer.from([1]),         // program id INDEX = 1 (memoProgram)
    cu16(1), Buffer.from([0]),// accounts: count=1, idx 0 (signer, writable)
    cu16(memo.length), memo,
  ]);
}

/* ── roast-78 · רצפת-הגנת-גיבוי (backing-protection floor) ──
 * ההיסטוריה-החיה: משמורת-SOL 60.29M→59.705M-lamports ביממה (10-עיגונים/שעה ×
 * 5,000-lamports) — והמשמורת **היא גם הגיבוי-הפיזי של התביעות-המוטבעות** (WSOL:
 * st.backing × 1e6-lamports ל-µ). בלי-שער, העיגון-השקט שוחק את-הגיבוי עד-פגיעה
 * אמיתית בעיגון-ה-1:1 (~8-ימים-מאז-77). הדפוס-זהה-לשערי-הדלק-של-ETH (roast-77):
 * מתחת-לרצפה = המתנה-כלכלית-כנה (economic hold), לא-כשל-breaker.
 * טהור-לבדיקה (peg-selftest): מחזיר קוד-הכרעה מדויק לפי-סדר-ההגנות:
 *   1. backing-floor — השריפה תצלול מתחת-לתביעות (הגנה-על-העיגון) · לפני-הכל
 *   2. unfunded — אין-אפילו-לתשלום rent-exempt+עמלה (הרצפה-הקנונית מ-roast-67)
 *   3. ok — שריפה-מותרת: נשארים מעל-התביעות אחרי-העמלה */
export interface SolFloorDecision {
  allow: boolean;
  code: "ok" | "backing-floor" | "unfunded";
  detail: string;
}
export function solBackingFloorDecision(
  balance: number,
  claimsFloorLamports: number,
  rentMin: number,
): SolFloorDecision {
  const afterFee = balance - SIGNATURE_FEE_LAMPORTS;
  if (claimsFloorLamports > 0 && afterFee < claimsFloorLamports) {
    return {
      allow: false, code: "backing-floor",
      detail: `backing-floor: burning ${SIGNATURE_FEE_LAMPORTS} lamports would dip custody to ${afterFee} < minted-claims floor ${claimsFloorLamports} (backing 1:1 protection, roast-78) — economic hold (anchor paused, backing protected)`,
    };
  }
  const needed = rentMin + SIGNATURE_FEE_LAMPORTS + RENT_MARGIN_LAMPORTS;
  if (balance < needed) {
    return {
      allow: false, code: "unfunded",
      detail: `unfunded: ${balance} lamports < rent-exempt ${rentMin} + fee ${SIGNATURE_FEE_LAMPORTS} = ${needed} — pending top-up (${needed - balance} lamports missing ≈ ${(needed - balance) / 1e9} SOL) — armed, memos signed (zero cost)`,
    };
  }
  return { allow: true, code: "ok", detail: `burn allowed: ${balance} → ${afterFee} (claims floor ${claimsFloorLamports} respected)` };
}

/* ── שידור-עיגון חי (self-memo anchor) — דרך צינור חוזה-החתימה שש-השלבים
 * (למעלה): כל שלב נכשל = עצירה לפני-שידור ──
 * חסם-מימון: getBalance ≥ rentExempt+fee+margin — אחרת "unfunded" מדויק (המתנה-כלכלית
 * כנה אצל ה-Relay, לא-כשל-breaker). ה-blockhash נלקח מה-RPC רגע-לפני.
 * roast-78: claimsFloorLamports — רצפת-הגנת-הגיבוי (תביעות-מוטבעות ב-lamports);
 * מותנה (0/undefined = ללא-רצפה — לא-מומלץ, נשמר-לתאימות-לאחור). */
export async function solSealBroadcast(
  payload: unknown,
  secretHex: string,
  claimsFloorLamports?: number,
): Promise<{ txid: string; address: string }> {
  /* שער-מדיניות (המפעיל): מקבל "1" או "true" — SOL_BROADCAST_ENABLED=true
   * מפעיל שידור-חי אמת (5000 lamports לחתימה, חוסם-היתרה קודם).
   * (החימוש-הזה מעניק גם את יכולת-ה-broadcast ב-stage 5/6 — יכולת נפרדת מחתימה.) */
  const solGate = process.env.SOL_BROADCAST_ENABLED?.trim().toLowerCase();
  if (solGate !== "1" && solGate !== "true") {
    throw new Error("unfunded-policy: live SOL broadcast disabled by operator gate (SOL_BROADCAST_ENABLED) — armed, memos signed (zero cost)");
  }

  /* ── stage 1/6 — session-gate: לפני כל פתרון-מפתח (revealSolKey למטה — סדר-השורות
   * הוא-החוזה). סירוב נרשם signing_attempt (מוגבל-תדירות) ואף בייט-מפתח לא נוגע. ── */
  try {
    ensureUnlocked();
  } catch (e) {
    const reason = e instanceof SigningGateError ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e).slice(0, 200);
    if (!auditThrottled("sol-session-lock")) {
      appendAudit({ type: "signing_attempt", actor: { keyId: "sol-anchor-1", gate: "session" }, target: { gate: "session", stage: "1/6" }, result: "failure", reason });
    }
    throw e;
  }

  /* ── stage 3/6 — רשומת-המפתח (אפס חומר-סוד) + התפקיד הנפתר ── */
  const record = signerKeyRecord();
  const opRole = resolveRoleFor("sol_seal_broadcast");

  /* ── stage 2/6 — policy-gate: לפני כל נגיעה במפתח; שלילה עוצרת הכל ──
   * הערכת-העמלה: הקבוע-הידוע (5,000-lamports) — אפס קריאות-רשת, fail-closed. */
  const decision = evaluatePolicy({ type: "sol_seal_broadcast", payload, feeLamports: SIGNATURE_FEE_LAMPORTS });
  if (!decision.allowed) {
    appendAudit({
      type: "policy_violation",
      actor: { keyId: record.keyId },
      target: { type: "sol_seal_broadcast", height: payloadHeight(payload) },
      result: "blocked",
      reason: decision.reasons.join("; "),
    });
    throw new SigningGateError("POLICY_DENIED", `policy denies this broadcast: ${decision.reasons.join("; ")}`, { decision });
  }

  /* ── stage 3/6–6/6 — מכאן ואילך כל כשל-שלב נרשם signing_attempt והשגיאה-המקורית מנצחת ── */
  try {
    /* ── stage 3/6 — least-privilege-role: חסר-תפקיד מסרב; אי-התאמה מסרב
     * (post-policy — בדיוק כמו resolveKeyId/flavor-less של ה-orchestrator) ── */
    requireRole(record, opRole);

    /* ── stage 4/6 — reveal-once: בייטי-ה-seed חיים רק בתוך מסגרת-ה-try הזאת —
     * לא נשמרים, לא מוחזרים, לא נרשמים ── */
    const { seed, address } = revealSolKey(secretHex, record);
    const endpoint = SOL_RPCS[0];
    const memoProgram32 = b58Decode(SOL_MEMO_PROGRAM);

    // FIX(R15-c · unknown≠unfunded): כשל-קריאה היה נבלע-ל-0 → "unfunded: 0 lamports"
    // בזמן-שהאמת "לא-נודע" (אותה-מחלקת-R14-FIX-12, הצד-הסולני). עתה: null = לא-נמדד
    // → זריקה-כנה (fail-closed-נשמר: לא-שורף בלי-מדידה).
    const [balance, rentMin] = await Promise.all([
      rpc<number>(endpoint, "getBalance", [address, { commitment: "confirmed" }], 15000)
        .then((r) => (typeof r === "number" ? r : Number((r as { value?: number })?.value ?? 0)))
        .catch(() => null as number | null),
      rpc<number>(endpoint, "getMinimumBalanceForRentExemption", [0, { commitment: "confirmed" }], 15000)
        .then((r) => (typeof r === "number" && r > 0 ? r : RENT_EXEMPT_FALLBACK))
        .catch(() => RENT_EXEMPT_FALLBACK),
    ]);
    // roast-78: סדר-ההגנות — רצפת-הגיבוי קודמת לרצפה-הקנונית (היא-גבוהה-ממנה בפועל:
    // תביעות-50µ = 50M-lamports » rent+fee ~897k).
    if (balance === null) throw new Error("sol balance unmeasured (unknown ≠ unfunded) — anchor deferred honestly");
    const d = solBackingFloorDecision(balance, Math.max(0, Math.floor(claimsFloorLamports ?? 0)), rentMin);
    if (!d.allow) throw new Error(d.detail);

    const bh = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
      endpoint, "getLatestBlockhash", [{ commitment: "confirmed" }], 15000,
    );
    if (!bh?.value?.blockhash) throw new Error("getLatestBlockhash answered without blockhash");
    const memoMsg = JSON.stringify(payload);
    const msg = buildMemoMessage(ed25519.getPublicKey(seed), memoProgram32, b58Decode(bh.value.blockhash), memoMsg);
    /* חתימה מתוך-המסגרת: בייטי-ה-seed חיים רק כאן (reveal-once) */
    const sig = ed25519.sign(msg, seed);
    const tx = Buffer.concat([cu16(1), Buffer.from(sig), msg]); // sig order == signer order
    /* ── stage 5/6 — capability-checked broadcast: יכולת-שידור היא נפרדת
     * מחתימה; המענק נגזר מחימוש-המפעיל, time-lock נכבד, סירוב = זריקה ── */
    grantBroadcastCapabilityIfArmed();
    requireCapability("broadcast");
    checkTimeLock(decision);
    const txid = await rpc<string>(endpoint, "sendTransaction", [
      tx.toString("base64"), { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" },
    ], 30000);
    if (!txid || typeof txid !== "string" || txid.length < 32) throw new SigningGateError("VALIDATION", "sol broadcast answered without signature (honest)");
    /* ── stage 6/6 — audit-trail: key_used + broadcast (הצלחה) + commit שער-החזרה ──
     * אותו-פרימיטיב-מבוקר של relay-eth (appendAudit — שרשרת-hash אחת לכל-החותמים
     * בתהליך). אפס-סודות: כתובת-ציבורית/גובה/txid/עמלה בלבד. */
    appendAudit({ type: "key_used", actor: { keyId: record.keyId }, target: { role: opRole, address }, result: "success" });
    appendAudit({ type: "broadcast", actor: { keyId: record.keyId }, target: { type: "sol_seal_broadcast", height: payloadHeight(payload), epoch: payloadEpoch(payload), txid, feeLamports: SIGNATURE_FEE_LAMPORTS }, result: "success", reason: `SPL-memo chain-seal anchored on solana with ${opRole} role` });
    commitRepeat(payload, Date.now());
    return { txid, address };
  } catch (e) {
    /* stage 6/6 — כשל-ניסיון-חתימה נרשם גם הוא; השגיאה-המקורית מנצחת תמיד */
    appendAudit({ type: "signing_attempt", actor: { keyId: record.keyId }, target: { type: "sol_seal_broadcast", height: payloadHeight(payload) }, result: "failure", reason: e instanceof SigningGateError ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e).slice(0, 200) });
    throw e;
  }
}

/* ── FIX(Roast-64-c · F8): פריקה-מתוחמת של ממו-העיגון מהלוגים ──
 * ההיסטוריה: `logs.includes('"height":100')` התאים-גם-1001 (substring).
 * עתה: מוצאים את ה-JSON הראשון-הניתן-לפריקה בלוגים (ה-{...}-הראשון שמכיל
 * "height") ומשווים **מספרית** (height) ובשוויון-מדויק (stateRoot). */
function memoJsonOf(logs: string[]): { height?: number; stateRoot?: string } | null {
  for (const line of logs) {
    // FIX(Roast-75 · memo-log-unescape): תוכנית-SPL-Memo-מתומנת את התוכן בלוג
    // ("Memo (len N): \"{\\\"protocol\\\"...}\"") — הבייטים-על-השרשרת-נקיים,
    // אך-שורת-הלוג-כוללת-מרכאות-עוטפות+מילוט. בלי-פענוח-המילוט JSON.parse
    // נכשל-תמיד → כל-העוגנים-נשארים-"pending reconciliation" לנצח.
    let content = line;
    const memoIdx = line.indexOf("Memo (len");
    if (memoIdx >= 0) {
      content = line.slice(line.indexOf(":", memoIdx) + 1).trim();
      if (content.startsWith('"') && content.endsWith('"') && content.length >= 2) {
        content = content.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
    }
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const o = JSON.parse(content.slice(start, end + 1)) as { height?: unknown; stateRoot?: unknown };
      if (typeof o.height === "number" || typeof o.stateRoot === "string")
        return { height: typeof o.height === "number" ? o.height : undefined, stateRoot: typeof o.stateRoot === "string" ? o.stateRoot : undefined };
    } catch { /* רשומה-לא-JSON — הבא */ }
  }
  return null;
}

/* ── verifyOnChain: קריאה-חוזרת מה-RPC הציבורי והשוואת stateRoot ──
 * SPL Memo מתומן ללוג ("Program log: <memo>") — getTransaction מחזיר
 * logMessages ואנו משווים את ה-stateRoot+height ביט-מול-ביט מול-המקומי. */
export async function verifySolAnchor(
  txid: string,
  expected: { height: number; stateRoot: string },
  expectedAddress?: string | null,
): Promise<{ ok: boolean; detail: string }> {
  // FIX(R15-c · anchor-identity-binding): היה — אין-בדיקת-חותם-כלל. ה-memo פומבי
  // וכל-אדם יכול לפרסם Memo-tx עם אותו-stateRoot ב-5,000-lamports — והיה נספר
  // כעוגן-מאומת. עתה: כשהזהות-הריבונית-ידועה, ה-fee-payer (accountKeys[0] —
  // החותם-החובה) חייב-להיות היא. צד-ג' → fail-closed "not-our-anchor".
  const bindSigner = (t: { transaction?: { message?: { accountKeys?: string[] } } } | null): string | null => {
    if (!expectedAddress) return null; // זהות-לא-ידועה → לא-ניתן-לאגד (רקורד-ישן) — המשך-כנה
    const payer = t?.transaction?.message?.accountKeys?.[0] ?? null;
    return payer && payer === expectedAddress ? null : "not-our-anchor";
  };
  const endpoint = SOL_RPCS[0];
  const st = await rpc<{ value: ({ err: unknown; slot: number; confirmationStatus?: string } | null)[] }>(
    endpoint, "getSignatureStatuses", [[txid], { searchTransactionHistory: true }], 15000,
  ).catch(() => null);
  const v = st?.value?.[0] ?? null;
  // FIX(SETTLE-7 verify-hole): getSignatureStatuses בלי-searchTransactionHistory
  // מחזיר-null לכל-מה-שמעבר-לחלון-הסלוטים-האחרון — כל-העוגנים-הישנים קיבלו
  // "not indexed" לנצח (הסימפטום-החי: SOL 19-anchored/0-verified). מעכשיו:
  // null בסטטוס ≠ סוף-התשובה — מנסים getTransaction ישירות (עובד-גם-לעוגנים-ישנים).
  // FIX(CROSS-F-02, saos-jummper): searchTransactionHistory:false נועד-רק-לחלון-הסלוטים —
  // true אומת-נגד-הלדג'ר-המלא-בחינם (עוגנים-ישנים לא-מקבלים "unknown" נצחית).
  const tx0 = v
    ? null
    : await rpc<{ meta?: { logMessages?: string[] } | null; transaction?: { message?: { accountKeys?: string[] } } }>(
        endpoint, "getTransaction", [txid, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }], 15000,
      ).catch(() => null);
  if (!v && tx0?.meta?.logMessages?.length) {
    const bind0 = bindSigner(tx0);
    if (bind0) return { ok: false, detail: `mismatch: ${bind0} — fee-payer is not the sovereign identity (getTransaction fallback, fail-closed)` };
    const logs0 = tx0.meta.logMessages;
    const memo0 = memoJsonOf(logs0);
    if (!memo0) return { ok: false, detail: "mismatch: no parseable anchor memo in logs (getTransaction fallback)" };
    const rootOk0 = memo0.stateRoot === expected.stateRoot;
    const heightOk0 = memo0.height === expected.height; // FIX(F8): השוואה-מספרית (לא substring)
    if (rootOk0 && heightOk0) {
      return { ok: true, detail: "stateRoot verified on solana (via getTransaction fallback — history window)" };
    }
    if (!rootOk0) return { ok: false, detail: `mismatch: on-chain memo lacks local stateRoot ${expected.stateRoot.slice(0, 12)}…` };
  }
  if (!v) return { ok: false, detail: "not indexed: signature unknown to public node yet" };
  if (v.err !== null && v.err !== undefined) return { ok: false, detail: `mismatch: transaction failed on-chain (${JSON.stringify(v.err).slice(0, 80)})` };
  // FIX(CROSS-F-08, saos-jummper): confirmed אינו-סופי — פיצול-פורק יכול-להפיל-אותו.
  // עיגון-מוצג-כעובדה רק-על-finalized (המתנה-כנה במקום-טענה-שברירית).
  if (v.confirmationStatus && v.confirmationStatus !== "finalized") {
    return { ok: false, detail: `awaiting finalized block (now: ${v.confirmationStatus})` };
  }
  const tx = await rpc<{ meta?: { logMessages?: string[] } | null; transaction?: { message?: { accountKeys?: string[] } } }>(
    endpoint, "getTransaction", [txid, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }], 15000,
  ).catch(() => null);
  const bind = bindSigner(tx);
  if (bind) return { ok: false, detail: `mismatch: ${bind} — fee-payer is not the sovereign identity (fail-closed)` };
  const logs = tx?.meta?.logMessages ?? [];
  if (logs.length === 0) return { ok: false, detail: "not indexed: awaiting finalized block" };
  // FIX(Roast-64-c · F8): פריקה-מתוחמת + השוואה-מספרית — לא עוד-substring
  const memo = memoJsonOf(logs);
  if (!memo) return { ok: false, detail: "mismatch: no parseable anchor memo in logs" };
  if (memo.stateRoot !== expected.stateRoot) return { ok: false, detail: `mismatch: on-chain memo lacks local stateRoot ${expected.stateRoot.slice(0, 12)}…` };
  if (memo.height !== expected.height) return { ok: false, detail: `mismatch: on-chain memo height (${memo.height ?? "?"}) != local h${expected.height}` };
  return { ok: true, detail: `stateRoot verified on solana (slot ${v.slot})` };
}
