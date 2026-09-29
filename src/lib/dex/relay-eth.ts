/* relay-eth.ts — מתאם-עיגון Ethereum עבור ה-Relay של SAOS-DEX.
 *
 * מקור: הקוד-החי של המפעיל (steem@main · agent/xwallet.cjs --evm-intent +
 * agent/identity.cjs) — אומת בדפדפן-המתמטיקה שלו ועתה מותאם לממשק-ה-Anchor
 * של ה-Relay (relay.ts). אפס תלות-חדשה: @noble/curves + @noble/hashes + bs58
 * (כבר בשימוש ה-Relay עבור TRON).
 *
 * מסקנות-ארכיטקטוניות (מתועדות ב-WORKLOG_PHASE5.md):
 *  · עקומה: ה-WIF של headcorner הוא secp256k1 — בדיוק עקומת-Ethereum. אך
 *    נגזרת-הזהות שונה (ETH = keccak256(pub-לא-דחוס)[12:], Graphene =
 *    sha256-דחוס → STM…) ולכן ה-ETH משתמש בזהות-הצי הייעודית שלו
 *    (wallets-registry idx=2), נגזרת מהזרע-הריבוני ומעוגנת-כבר-על-השרשרת
 *    (מניפסט txid 9f593bdc…). בידוד-סמכות: ה-Graphene-סמכות אינה נחשפת ל-ETH.
 *  · stateRoot הוא sha256 = 32 בייטים — נכנס כ-bytes32 ללא-המרה (calldata).
 *  · כלכלה: עיגון-EVM עולה גז (בניגוד ל-RC של Steem/Hive). שני-טירות:
 *      1) כוונת-עיגון חתומה EIP-191 — אפס-גז, מאומתת ecrecover (תמיד פעילה)
 *      2) שידור-חי EIP-1559 (calldata = payload) — חמוש אך נעול עד-מימון;
 *         עד-אז: המתנה-כלכלית כנה ("unfunded — pending funding") בדיוק
 *         כמו-ה-TRON, ואינה נספרת ל-breaker.
 *
 * אבטחה: מפתח בזיכרון בלבד מ-.env (gitignored); אפס סודות בלוגים/פלט;
 * אימות-עצמי fail-closed — כתובת-נגזרת חייבת להתאים לכתובת-הצפוי.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { createHash, timingSafeEqual } from "crypto";
import fs from "fs";
import path from "path";
import { fencedFetch } from "./fence"; // FIX(SETTLE-11)+FIX(Roast-65-b · H2): גדר + redirect:error מרוכזים

/* RPC ציבוריים (ללא-מפתח) — ניתנים לעקיפה דרך ETH_RPC_URL */
export const ETH_RPCS = (process.env.ETH_RPC_URL
  ? [process.env.ETH_RPC_URL]
  : ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"]);

export interface EthIdentity { address: string; }

export interface EthAnchorIntent {
  intentHash: string;     // keccak256 של EIP-191(message) — 0x…
  signature: string;      // 0x + 130 hex (r+s+v, v=27+recid) — חתימת personal_sign
  address: string;        // הכתובת החותמת
  verified: boolean;      // אימות-עצמי: החתימה תקפה מול-המפתח-החותם
}

/* ════════════════════════════════════════════════════════════════════════
 * חוזה-החתימה שש-השלבים (six-stage signing contract)
 * ported from saos-jummper SIGNING-CONTRACT (docs/SIGNING-CONTRACT.md) — המימוש
 * הקנוני: Saosmartwallet packages/core/src/signing/orchestrator.ts (נמדד 6/6,
 * safe_to_hold_funds). יבוא חוצה-ריפואים אינו אפשרי (חבילות נפרדות) — לכן
 * הצינור מנווט כאן נאמן-למקור. fail-closed לכל אורכו: כשל-שלב כלשהו = עצירה
 * לפני-שידור. כלום לא נחתם על אולי.
 *
 *   1. session-gate   — ensureUnlocked (+ verifyStepUp) לפני כל פתרון-מפתח;
 *                       תהליך בלתי-מושגח לא פותר מפתחות סתם כך.
 *   2. policy-gate    — evaluatePolicy לפני כל נגיעה במפתח; שלילה נרשמת
 *                       policy_violation וזורקת (allowed-operations,
 *                       repeat-guard — port מ-budget.py של jummper,
 *                       תקציב-גז יומי מהשרשרת-המבוקרת).
 *   3. least-privilege-role — התפקיד לפי מה שהפעולה עושה: שידור ששורף גז →
 *                       "active"; חתימת-כוונה אפס-גז → "posting".
 *                       מפתח חסר-תפקיד מסרב — לא ממיר בברירת-מחדל.
 *   4. reveal-once    — revealKeyFor הוא יציאת-המפתח-הגלוי היחידה; בייטי-המפתח
 *                       חיים רק בתוך מסגרת-הקריאה (אף שמירה/החזרה/לוג).
 *   5. capability-checked-broadcast — שידור הוא יכולת נפרדת מחתימה
 *                       (ETH_BROADCAST_ENABLED מעניק אותה), time-lock נכבד,
 *                       כל סירוב הוא זריקה מפורשת.
 *   6. audit-trail    — key_used / signing_attempt / broadcast / policy_violation
 *                       בשרשרת-hash על state/signing-audit.jsonl, כולל כשלים;
 *                       אפס סודות באירועים (רק מזהים/דיגסטים/txids).
 * ══════════════════════════════════════════════════════════════════════ */

/** קודי-שער — port של VaultError מה-orchestrator. */
export type SigningGateCode =
  | "SESSION_LOCKED"
  | "SESSION_EXPIRED"
  | "POLICY_STEP_UP_REQUIRED"
  | "POLICY_DENIED"
  | "KEY_NOT_FOUND"
  | "KEY_ROLELESS"
  | "BROADCAST_CAPABILITY_MISSING"
  | "TIMED_LOCK"
  | "VALIDATION";

export class SigningGateError extends Error {
  readonly code: SigningGateCode;
  readonly details: Record<string, unknown>;
  constructor(code: SigningGateCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "SigningGateError";
    this.code = code;
    this.details = details ?? {};
  }
}

export type KeyRole = "active" | "posting";

/** רשומת-מפתח ציבורית — אפס חומר-סוד (בדיוק כמו record של revealKeyFor). */
export interface SignerKeyRecord {
  keyId: string;
  /** ריק = מפתח חסר-תפקיד (flavor-less) — מסרב, לא ממיר. */
  roles: KeyRole[];
}

export interface PolicyCheck { guard: string; allowed: boolean; reason: string; }

/** port של PolicyDecision: שלילה זורקת — לעולם לא "אזהרה". */
export interface PolicyDecision {
  allowed: boolean;
  reasons: string[];
  checks: PolicyCheck[];
  requirements: { stepUpAuth: boolean; timeLock: number };
}

export type SigningAuditEventType = "key_used" | "signing_attempt" | "broadcast" | "policy_violation";

/** אירוע-ביקורת — אפס סודות: מזהי-מפתח, דיגסטים, כתובות, txids בלבד. */
export interface SigningAuditEvent {
  seq: number;
  at: string;
  type: SigningAuditEventType;
  actor: Record<string, unknown>;
  target: Record<string, unknown>;
  result: "success" | "failure" | "blocked";
  reason?: string;
  prevHash: string;
  hash: string;
}

/* ── סט-הסשן (stage 1/6) — state על globalThis (עמיד ל-hot-reload, כמו relay.ts) ── */

const SESSION_TTL_MS = 60 * 60 * 1000; // שעה — אחריה נדרש חימוש-מחדש (re-auth)

interface SigningSessionState {
  unlocked: boolean;
  source: "env" | "api" | null;
  unlockedAtMs: number | null;
  stepUpAtMs: number | null;
  capabilities: Set<string>;
}

const gSigning = globalThis as unknown as { __saosDexSigningSession?: SigningSessionState };
function signingSession(): SigningSessionState {
  if (!gSigning.__saosDexSigningSession) {
    gSigning.__saosDexSigningSession = { unlocked: false, source: null, unlockedAtMs: null, stepUpAtMs: null, capabilities: new Set() };
  }
  return gSigning.__saosDexSigningSession;
}

function sessionEnvArmed(): boolean {
  const v = (process.env.ETH_SIGNING_SESSION_UNLOCKED ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * פתיחת-סשן-חתימה מפורשת (API לקוראים אינטראקטיביים). stepUpToken אופציונלי —
 * מאומת מול ETH_SIGNING_STEPUP_TOKEN_SHA256 ומספק step-up (re-auth).
 */
export function unlockSigningSession(opts?: { stepUpToken?: string; source?: string }): void {
  const s = signingSession();
  s.unlocked = true;
  s.source = "api";
  s.unlockedAtMs = Date.now();
  if (opts?.stepUpToken && verifyStepUp(opts.stepUpToken)) s.stepUpAtMs = Date.now();
}

/** step-up re-auth: השוואה timing-safe מול hash הטוקן שהמפעיל הגדיר. */
export function verifyStepUp(token: string): boolean {
  const expected = (process.env.ETH_SIGNING_STEPUP_TOKEN_SHA256 ?? "").trim().toLowerCase();
  if (!expected || !token) return false;
  const got = createHash("sha256").update(token).digest("hex");
  const a = Buffer.from(got, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * stage 1/6 — session-gate: חייב לעבור לפני שכל מפתח נפתר. סשן נעול =
 * אף בייט-מפתח לא נוגע. תהליך-בלתי-מושגח מחייב חימוש-מפעיל מפורש:
 *   ETH_SIGNING_SESSION_UNLOCKED=1  (חימוש-סשן לכל אתחול-תהליך) או
 *   unlockSigningSession()          (API — עם TTL של SESSION_TTL_MS).
 * ETH_SIGNING_REQUIRE_STEPUP=1 דורש step-up שהושלם גם עבור חימוש-env.
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
      "signing session is locked — no key resolution for an unattended process (stage 1/6): arm ETH_SIGNING_SESSION_UNLOCKED=1 (or call unlockSigningSession) alongside ETH_BROADCAST_ENABLED",
    );
  }
  if (s.source === "api" && s.unlockedAtMs !== null && Date.now() - s.unlockedAtMs > SESSION_TTL_MS) {
    s.unlocked = false;
    s.source = null;
    s.unlockedAtMs = null;
    throw new SigningGateError("SESSION_EXPIRED", "signing session expired — re-unlock required before any key resolution (stage 1/6)");
  }
  if ((process.env.ETH_SIGNING_REQUIRE_STEPUP ?? "").trim() === "1" && s.stepUpAtMs === null) {
    throw new SigningGateError("POLICY_STEP_UP_REQUIRED", "step-up re-authentication demanded (ETH_SIGNING_REQUIRE_STEPUP=1) — unlockSigningSession({ stepUpToken }) required (stage 1/6)");
  }
}

/* ── תפקיד-מינימלי (stage 3/6) ── */

/**
 * התפקיד נגזר ממה שהפעולה עושה (port של defaultRoleFor): שידור-עיגון שורף
 * גז אמת → "active"; חתימת-כוונה EIP-191 אפס-גז (פרסום-ראיות בלבד) → "posting".
 */
export function resolveRoleFor(opType: "eth_seal_broadcast" | "eth_anchor_intent"): KeyRole {
  if (opType === "eth_anchor_intent") return "posting";
  return "active"; // eth_seal_broadcast — פעולת-העברת-ערך (גז) היחידה במודול
}

/**
 * רשומת-זהות-ה-EVM של הצי (wallets-registry idx=2, מניפסט מעוגן). התפקידים
 * מוגדרים מפורשות דרך ETH_SIGNER_ROLES (רשימה מופרדת-פסיקים). ברירת-המחדל
 * "active,posting" משקפת את המציאות הדו-טירתית הקיימת (כוונות אפס-גז + שידור
 * ממומן). ערך ריק/none = מפתח חסר-תפקיד → מסרב (flavor-less, לא ממיר).
 */
export function signerKeyRecord(): SignerKeyRecord {
  const raw = (process.env.ETH_SIGNER_ROLES ?? "active,posting").trim().toLowerCase();
  const roles = raw
    .split(",")
    .map((x) => x.trim())
    .filter((x): x is KeyRole => x === "active" || x === "posting");
  return { keyId: "eth-anchor-1", roles };
}

function requireRole(record: SignerKeyRecord, role: KeyRole): void {
  if (record.roles.length === 0) {
    throw new SigningGateError(
      "KEY_ROLELESS",
      `key ${record.keyId} is flavor-less (role null) — a role-less key refuses rather than defaulting (stage 3/6); set ETH_SIGNER_ROLES explicitly`,
    );
  }
  if (!record.roles.includes(role)) {
    throw new SigningGateError(
      "KEY_NOT_FOUND",
      `no ${role} key for the eth anchoring identity (ETH_SIGNER_ROLES=${record.roles.join(",") || "none"}) — refusing to drive a ${role}-role operation with the configured capabilities (stage 3/6)`,
    );
  }
}

/* ── עזרי-קנוניות (משותפים ל-policy ולשרשרת-הביקורת) ── */

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}

function fingerprint(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function payloadHeight(payload: unknown): number | null {
  try {
    const h = (payload as { height?: unknown }).height;
    return typeof h === "number" && Number.isFinite(h) ? h : null;
  } catch {
    return null;
  }
}

/* ── מצב-החזרה (repeat-guard) — port מ-saos-jummper budget.py RepeatGuard:
 * השליטה שחסרה כש-hive.convert שודר 11 פעמים זהה על-יתרה שלא זזה.
 * כל-קריאה בודדות עוברות; הנזק הוא בחזרתיות ובצבירה. commit רק אחרי-הצלחה. */

const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;
const REPEAT_MAX = 1;

const gRepeat = globalThis as unknown as { __saosDexEthRepeatSeen?: Map<string, number[]> };
function repeatSeen(): Map<string, number[]> {
  if (!gRepeat.__saosDexEthRepeatSeen) gRepeat.__saosDexEthRepeatSeen = new Map();
  return gRepeat.__saosDexEthRepeatSeen;
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

/* ── שרשרת-הביקורת (stage 6/6) — hash-chained JSONL ──
 * אותו-כלל-הפרדת-מצב כמו relay.ts: SAOS_DEX_STATE_DIR מנתב את הביקורת לתיקיית-זמן
 * של כלי-בדיקה — ראיות-בדיקה לעולם לא נוגעות בביקורת של הדמון החי. */

const AUDIT_DIR = process.env.SAOS_DEX_STATE_DIR
  ? path.resolve(process.env.SAOS_DEX_STATE_DIR)
  : path.join(process.cwd(), "state");
const AUDIT_FILE = path.join(AUDIT_DIR, "signing-audit.jsonl");
const AUDIT_GENESIS_HASH = "0".repeat(64);

function auditHead(): { seq: number; prevHash: string } {
  try {
    const lines = fs.readFileSync(AUDIT_FILE, "utf8").split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i] as string) as SigningAuditEvent;
        if (typeof ev.seq === "number" && typeof ev.hash === "string") return { seq: ev.seq + 1, prevHash: ev.hash };
      } catch { /* שורה-פגומה — ממשיכים אחורה */ }
    }
  } catch { /* אין-ביקורת עדיין */ }
  return { seq: 1, prevHash: AUDIT_GENESIS_HASH };
}

/**
 * stage 6/6 — appendAudit: רישום hash-chained (כל אירוע נושא seq+prevHash+hash
 * — tamper-evident). כשל-כתיבה לעולם לא מסתיר את התוצאה המקורית (החוזה של
 * ה-orchestrator) — מדווח כנה ל-stderr ומחזיר false.
 */
export function appendAudit(
  ev: Omit<SigningAuditEvent, "seq" | "at" | "prevHash" | "hash"> & { at?: string },
): boolean {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const head = auditHead();
    const body = { ...ev, at: ev.at ?? new Date().toISOString(), seq: head.seq, prevHash: head.prevHash };
    const hash = createHash("sha256").update(stableStringify(body)).digest("hex");
    const event: SigningAuditEvent = { ...body, hash };
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(event) + "\n");
    return true;
  } catch {
    console.error("[relay-eth][audit] signing-audit.jsonl write failed (audit outage — original outcome unchanged)");
    return false;
  }
}

/** סך-הגז ששויך-לשידורי-היום (UTC) מהשרשרת-המבוקרת — ה-spentToday של ה-policy. */
function readTodaysBroadcastGasWei(): bigint {
  const day = new Date().toISOString().slice(0, 10);
  let sum = 0n;
  try {
    for (const line of fs.readFileSync(AUDIT_FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as SigningAuditEvent;
        if (ev.type !== "broadcast" || ev.result !== "success") continue;
        if (typeof ev.at !== "string" || ev.at.slice(0, 10) !== day) continue;
        const g = (ev.target as { gasWei?: unknown }).gasWei;
        if (typeof g === "string" && /^\d+$/.test(g)) sum += BigInt(g);
      } catch { /* שורה-פגומה — נדלגת */ }
    }
  } catch { /* אין-ביקורת עדיין — תקציב מלא */ }
  return sum;
}

/* ── שער-המדיניות (stage 2/6) ── */

export interface AnchorPolicyOp {
  type: "eth_seal_broadcast" | "eth_anchor_intent";
  payload: unknown;
  /** חסם-עליון שמרני לעלות-הגז (wei) — לפני כל קריאת-רשת (fail-closed). */
  estimatedGasWei: bigint | null;
}

function dailyGasLimitWei(): bigint {
  const raw = (process.env.ETH_ANCHOR_DAILY_LIMIT_WEI ?? "").trim();
  if (/^\d+$/.test(raw)) return BigInt(raw);
  return 10_000_000_000_000_000n; // 0.01 ETH/יום — תקרה מתועדת (~80 עיגוני 60K-gas ב-2 gwei)
}

function timelockSeconds(): number {
  const raw = Number.parseInt(process.env.ETH_BROADCAST_TIMELOCK_SECONDS ?? "0", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * stage 2/6 — evaluatePolicy: נרץ לפני שמפתח נוגע. כללים סטטיים fail-closed
 * (port של הכללים הקומפילים של PolicyEngine + budget.py): שלילה = זריקה,
 * לעולם לא הסגרה.
 */
export function evaluatePolicy(op: AnchorPolicyOp): PolicyDecision {
  const checks: PolicyCheck[] = [];
  const reasons: string[] = [];
  const denyGuard = (guard: string, reason: string): void => {
    checks.push({ guard, allowed: false, reason });
    reasons.push(`${guard}: ${reason}`);
  };

  // 1) allowed-operations — המסילה הזאת חותמת ומשדרת שידור-עיגון עצמי בלבד
  if (op.type !== "eth_seal_broadcast") {
    denyGuard("allowed-operations", `operation type "${op.type}" is not in allowedOperations (eth_seal_broadcast only)`);
  } else {
    checks.push({ guard: "allowed-operations", allowed: true, reason: "eth_seal_broadcast" });
  }

  // 2) צורת-ה-payload — פרוטוקול-העיגון של saos-dex בלבד (צורת-ה-op כאן, לא ברשת)
  const p = (op.payload ?? {}) as { protocol?: unknown; action?: unknown; height?: unknown; stateRoot?: unknown; digest?: unknown };
  if (p.protocol === "saos-dex/v1" && p.action === "chain-seal" && typeof p.height === "number" && typeof p.stateRoot === "string" && typeof p.digest === "string") {
    checks.push({ guard: "payload-shape", allowed: true, reason: `chain-seal h${p.height}` });
  } else {
    denyGuard("payload-shape", "payload is not a saos-dex/v1 chain-seal anchor — refusing to sign foreign bytes");
  }

  // 3) repeat-guard (budget.py port) — הפעולה-הזהה כבר שודרה-בהצלחה בחלון = לולאה
  const now = Date.now();
  const prior = repeatCount(fingerprint(op.payload), now);
  if (prior >= REPEAT_MAX) {
    denyGuard("repeat", `identical payload already broadcast ${prior} time(s) within ${REPEAT_WINDOW_MS / 60000}min — a repeating identical operation is a loop, not a decision`);
  } else {
    checks.push({ guard: "repeat", allowed: true, reason: "not a repeat" });
  }

  // 4) תקציב-גז יומי (spentToday נקרא מהשרשרת-המבוקרת — buildOperationContext של ה-orchestrator)
  if (op.estimatedGasWei !== null) {
    const spent = readTodaysBroadcastGasWei();
    const limit = dailyGasLimitWei();
    if (spent + op.estimatedGasWei > limit) {
      denyGuard("daily-gas-budget", `cumulative cap exceeded — spentToday ${spent}wei + requested ${op.estimatedGasWei}wei > limit ${limit}wei (overage ${spent + op.estimatedGasWei - limit}wei); honest economic hold`);
    } else {
      checks.push({ guard: "daily-gas-budget", allowed: true, reason: `spentToday ${spent}/${limit}wei` });
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    checks,
    requirements: { stepUpAuth: (process.env.ETH_SIGNING_REQUIRE_STEPUP ?? "").trim() === "1", timeLock: timelockSeconds() },
  };
}

/* ── reveal-once (stage 4/6) + יכולת-שידור (stage 5/6) ── */

/**
 * stage 4/6 — reveal-once: port של נקודת-התפר של vault.revealKeyFor — יציאת
 * המפתח-הגלוי היחידה במודול. הבייטים חוזרים למסגרת-הקריאה בלבד; הרשומה
 * הציבורית נושאת אפס חומר-סוד. אין שמירה, החזרה או רישום של בייטי-מפתח.
 */
function revealKeyFor(privHex: string, record: SignerKeyRecord): { privateKey: Uint8Array; address: string } {
  const priv = Buffer.from(privHex.replace(/^0x/, ""), "hex");
  if (priv.length !== 32) {
    throw new SigningGateError("VALIDATION", `key ${record.keyId} rejected at reveal: eth key must be 32 bytes (stage 4/6)`);
  }
  return { privateKey: new Uint8Array(priv), address: ethIdentity(privHex).address };
}

function grantBroadcastCapabilityIfArmed(): void {
  const gate = (process.env.ETH_BROADCAST_ENABLED ?? "").trim().toLowerCase();
  if (gate === "1" || gate === "true") signingSession().capabilities.add("broadcast");
}

/** stage 5/6 — שידור הוא יכולת נפרדת מחתימה; בלי-מענק = זריקה מפורשת. */
function requireCapability(cap: "broadcast"): void {
  if (!signingSession().capabilities.has(cap)) {
    throw new SigningGateError(
      "BROADCAST_CAPABILITY_MISSING",
      `broadcast capability not granted on this signing session — signing never implies broadcasting (stage 5/6): arm ETH_BROADCAST_ENABLED`,
    );
  }
}

/** stage 5/6 — time-lock: סירוב מפורש בזמן-נעילה (port של broadcastSigned). */
function checkTimeLock(decision: PolicyDecision): void {
  const lockSeconds = Math.max(timelockSeconds(), decision.requirements.timeLock);
  if (lockSeconds > 0) {
    throw new SigningGateError(
      "TIMED_LOCK",
      `broadcast is time-locked for another ${lockSeconds}s — re-issue with broadcast once the lock expires (stage 5/6)`,
      { lockUntil: Date.now() + lockSeconds * 1000 },
    );
  }
}

function keccakHex(buf: Uint8Array): string {
  return Buffer.from(keccak_256(buf)).toString("hex");
}

/* keccak-based EIP-55 (checksum) — כמו identity.cjs של המפעיל */
export function checksumAddress(addrLowerNo0x: string): string {
  const a = addrLowerNo0x.toLowerCase();
  const h = keccakHex(Buffer.from(a, "utf8"));
  let out = "";
  for (let i = 0; i < a.length; i++) {
    const nib = parseInt(h[i], 16);
    out += nib >= 8 ? a[i].toUpperCase() : a[i];
  }
  return "0x" + out;
}

/* ── זהות: מפתח-פרטי (hex 32B) → כתובת (EIP-55) ──
 * אותה מתמטיקה כמו scalarToEvmAddress של המפעיל: pub-לא-דחוס → keccak256[12:] */
export function ethIdentity(privHex: string): EthIdentity {
  const priv = Buffer.from(privHex.replace(/^0x/, ""), "hex");
  if (priv.length !== 32) throw new Error("eth key must be 32 bytes");
  const pub = secp256k1.getPublicKey(priv, false);
  const h = keccak_256(pub.subarray(1));
  return { address: checksumAddress(Buffer.from(h.subarray(12)).toString("hex")) };
}

/* ── EIP-191: keccak256("\x19Ethereum Signed Message:\n" + len + msg) ── */
export function eip191MessageHash(msg: string): Uint8Array {
  const body = Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}${msg}`, "utf8");
  return keccak_256(body);
}

/* ── כוונת-עיגון חתומה (אפס-גז) + אימות-עצמי ──
 * SECURITY INTENT: זו הראיה-הקריפטוגרפית שניתנת-לאימות-צד-שלישי בלי גז —
 * כל מי שמחזיק את ה-payload משחזר EIP-191-hash ומריץ ecrecover → כתובת.
 * ה-Relay מקשיח את הכוונה ב-anchors.json (הוכחה-ציבורית, אפס-סודות). */
export function signEthAnchor(payload: unknown, privHex: string): EthAnchorIntent {
  const msg = JSON.stringify(payload);
  const hash = eip191MessageHash(msg);
  const priv = Buffer.from(privHex.replace(/^0x/, ""), "hex");
  const sig = secp256k1.sign(hash, priv, { prehash: false });
  const compact = sig.toCompactRawBytes(); // 64B r+s (low-s — noble מנרמל)
  const v = 27 + (sig.recovery ?? 0);
  const signature = "0x" + Buffer.concat([compact, Buffer.from([v])]).toString("hex");
  const address = ethIdentity(privHex).address;
  const verified = secp256k1.verify(compact, hash, secp256k1.getPublicKey(priv, true));
  return { intentHash: "0x" + Buffer.from(hash).toString("hex"), signature, address, verified };
}

/* ── JSON-RPC מינימלי (אותו-היגיין-timeout כמו relay.ts) ── */
async function rpc<T>(endpoint: string, method: string, params: unknown[], timeoutMs = 20000): Promise<T> {
  // FIX(SETTLE-11): גדר-ריבונית fail-closed · FIX(Roast-65-b · H2): דרך-fencedFetch (redirect:error)
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fencedFetch(endpoint, "relay-eth.rpc", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "saos-relay/1.0" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctrl.signal });
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(String(json.error.message || "eth rpc error").slice(0, 120));
    return json.result as T;
  } finally {
    clearTimeout(t);
  }
}

/* ── RLP קנוני (EIP-1559) — בונים-מפורשים: אפס קידוד-כפול ──
 * rlpScalar: מספר-שלם → big-endian מינימלי (0 → ריק) · rlpStr: מחרוזת-בייטים
 * קנונית (בייט-יחיד <0x80 → עצמו) · rlpList: רשימה מעל פריטים כבר-מקודדים. */
function rlpScalar(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0);
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.from(hex, "hex");
}
function rlpWrap(payload: Uint8Array, offset: number): Uint8Array {
  if (payload.length === 1 && payload[0] < 0x80) return Buffer.from(payload);
  if (payload.length < 56) return Buffer.concat([Buffer.from([offset + payload.length]), payload]);
  const lenBytes = rlpScalar(BigInt(payload.length));
  return Buffer.concat([Buffer.from([offset + 55 + lenBytes.length]), lenBytes, payload]);
}
function rlpStr(b: Uint8Array): Uint8Array {
  return rlpWrap(Buffer.from(b), 0x80);
}
function rlpList(encodedItems: Uint8Array[]): Uint8Array {
  return rlpWrap(Buffer.concat(encodedItems.map((x) => Buffer.from(x))), 0xc0);
}
function rlpEncode(item: Uint8Array | Uint8Array[]): Uint8Array {
  if (Array.isArray(item)) return rlpList(item.map((x) => rlpStr(x)));
  return rlpStr(item);
}

const utf8ToHex = (s: string) => Buffer.from(s, "utf8").toString("hex");
const pad32 = (b: Uint8Array) => Buffer.concat([Buffer.alloc(32 - b.length), Buffer.from(b)]);

/* מתמטיקת-הדלק של העיגון — מוצהרת ברמת-המודול כדי ששער-המדיניות (stage 2/6)
 * יעריך עלות בלי קריאת-רשת ובלי נגיעה במפתח (חסם-עליון שמרני, fail-closed). */
const GAS_LIMIT_ANCHOR = 60000; // 21000 + calldata (~200B JSON ≈ 3.2k) + מרווח-מוסדי
const GAS_CEILING_WEI = 2_000_000_000n; // 2 gwei — מעל-זה העיגון-לא-שווה-את-הדלק
const FUEL_FLOOR_WEI = 120_000_000_000_000n; // 0.00012 ETH — מתחת-זה מנוע-עיגון-יתר

/* ── שידור-עיגון חי (EIP-1559 self-tx, calldata = payload) — דרך צינור
 * חוזה-החתימה שש-השלבים (למעלה): כל שלב נכשל = עצירה לפני-שידור ──
 * חסם-מימון: יתרה חייבת לכסות gasLimit×gasPrice×2 (מרווח לשני עיגונים) —
 * אחרת נזרק "unfunded" שה-Relay מסווג כהמתנה-כלכלית כנה (לא-כשל-breaker). */
export async function ethSealBroadcast(
  payload: unknown,
  privHex: string,
): Promise<{ txid: string; intent: EthAnchorIntent; address: string }> {
  /* שער-מדיניות (המפעיל): חמוש-כברירת-מחדל אך נעול-שידור עד-חימוש-מפורש.
   * מקבל "1" או "true" — ETH_BROADCAST_ENABLED=true מפעיל שידור-חי אמת (גז-אמת).
   * (החימוש-הזה מעניק גם את יכולת-ה-broadcast ב-stage 5/6 — יכולת נפרדת מחתימה.) */
  const ethGate = process.env.ETH_BROADCAST_ENABLED?.trim().toLowerCase();
  if (ethGate !== "1" && ethGate !== "true") {
    throw new Error("unfunded-policy: live ETH broadcast disabled by operator gate (ETH_BROADCAST_ENABLED) — armed, intents signed (zero gas)");
  }

  /* ── stage 1/6 — session-gate: לפני כל פתרון-מפתח ── */
  ensureUnlocked();

  /* ── stage 3/6 — רשומת-המפתח (אפס חומר-סוד) + התפקיד הנגזר מהפעולה ── */
  const record = signerKeyRecord();
  const opRole = resolveRoleFor("eth_seal_broadcast");

  /* ── stage 2/6 — policy-gate: לפני כל נגיעה במפתח; שלילה עוצרת הכל ──
   * הערכת-העלות: gasLimit × תקרת-הגז — חסם-עליון שמרני, אפס קריאות-רשת. */
  const decision = evaluatePolicy({
    type: "eth_seal_broadcast",
    payload,
    estimatedGasWei: BigInt(GAS_LIMIT_ANCHOR) * GAS_CEILING_WEI,
  });
  if (!decision.allowed) {
    appendAudit({
      type: "policy_violation",
      actor: { keyId: record.keyId },
      target: { type: "eth_seal_broadcast", height: payloadHeight(payload) },
      result: "blocked",
      reason: decision.reasons.join("; "),
    });
    throw new SigningGateError("POLICY_DENIED", `policy denies this broadcast: ${decision.reasons.join("; ")}`, { decision });
  }

  /* ── stage 3/6–4/6 — מכאן ואילך כל כשל-שלב נרשם signing_attempt והשגיאה-המקורית מנצחת ── */
  try {
    /* ── stage 3/6 — least-privilege-role: חסר-תפקיד מסרב; אי-התאמה מסרב
     * (post-policy — בדיוק כמו resolveKeyId/flavor-less של ה-orchestrator) ── */
    requireRole(record, opRole);

    /* ── stage 4/6 — reveal-once: בייטי-המפתח חיים רק בתוך מסגרת-ה-try הזאת —
     * לא נשמרים, לא מוחזרים, לא נרשמים ── */
    const { privateKey, address } = revealKeyFor(privHex, record);
    const endpoint = ETH_RPCS[0];
    const msg = JSON.stringify(payload);
    const data = utf8ToHex(msg);

    const [chainIdHex, balHex, gasHex, nonceHex] = await Promise.all([
      rpc<string>(endpoint, "eth_chainId", []),
      rpc<string>(endpoint, "eth_getBalance", [address, "latest"]),
      rpc<string>(endpoint, "eth_gasPrice", []),
      rpc<string>(endpoint, "eth_getTransactionCount", [address, "pending"]),
    ]);
    const chainId = BigInt(chainIdHex);
    const balance = BigInt(balHex);
    const gasPrice = BigInt(gasHex);
    const nonce = BigInt(nonceHex);
    const maxPriority = 1_000_000_000n; // 1 gwei
    const maxFee = maxPriority + gasPrice * 2n; // tip ≤ maxFee תמיד (EIP-1559) + מרווח-baseFee
    const floor = BigInt(GAS_LIMIT_ANCHOR) * maxFee * 2n;
    if (balance < floor) {
      throw new Error(`unfunded: ${Number(balance / 10n ** 12n)} mwei < gas floor ${Number(floor / 10n ** 12n)} mwei — pending funding (armed, intent signed)`);
    }
    /* roast-77 · שערי-דלק-מדידים (המשמורת-היא-גם-דלק-העיגון — השחיקה-החיה 0.0019→0.0002-ETH
     * הוכיחה-שבלי-שערים-המסילה-שורפת-את-עצמה): תקרת-גז + רצפת-דלק — מעל-התקרה/מתחת-הרצפה
     * = המתנה-כלכלית-כנה, לא-שריפה. */
    if (gasPrice > GAS_CEILING_WEI) {
      throw new Error(`gas-ceiling: ${Number(gasPrice / 10n ** 9n)} gwei > ${Number(GAS_CEILING_WEI / 10n ** 9n)} — economic hold (fuel economy, roast-77)`);
    }
    if (balance - floor < FUEL_FLOOR_WEI) {
      throw new Error(`unfunded: fuel ${Number((balance - floor) / 10n ** 12n)} mwei < reserve floor ${Number(FUEL_FLOOR_WEI / 10n ** 12n)} — economic hold (protect remaining fuel)`);
    }
    const to = Buffer.from(address.replace(/^0x/, "").toLowerCase(), "hex");
    const dataBytes = Buffer.from(data, "hex");
    /* EIP-1559 [chainId,nonce,tip,fee,gas,to,value,data,accessList(+yParity,r,s)] —
     * כל-פריט נבנה-מפורש קנונית; רשימת-גישה ריקה = 0xc0 אמת (לא מחרוזת). */
    const txFields = [
      rlpStr(rlpScalar(chainId)),
      rlpStr(rlpScalar(nonce)),
      rlpStr(rlpScalar(maxPriority)),
      rlpStr(rlpScalar(maxFee)),
      rlpStr(rlpScalar(BigInt(GAS_LIMIT_ANCHOR))),
      rlpStr(to),
      rlpStr(rlpScalar(0n)),
      rlpStr(dataBytes),
      rlpList([]), // accessList ריק
    ];
    /* EIP-1559 sig-hash = keccak(0x02 || rlp([...])) — בלי קידומת-הטיפוס בחשיש
     * ecrecover מחזיר שולח-אחר (חסר-יתרה) וה-RPC דוחה "available 0". */
    const preSign = Buffer.concat([Buffer.from([0x02]), rlpList(txFields)]);
    /* חתימה מתוך-המסגרת: בייטי-המפתח חיים רק כאן (reveal-once) */
    const sig = secp256k1.sign(keccak_256(preSign), privateKey, { prehash: false });
    const yParity = sig.recovery ?? 0;
    const compact = sig.toCompactRawBytes();
    // r/s כמספרים-שלמים קנוניים (RLP minimal) — לא מחרוזות-32בייט מרופדות
    const rS = rlpStr(rlpScalar(BigInt("0x" + Buffer.from(compact.subarray(0, 32)).toString("hex"))));
    const sS = rlpStr(rlpScalar(BigInt("0x" + Buffer.from(compact.subarray(32, 64)).toString("hex"))));
    const signed = rlpList([
      ...txFields,
      rlpStr(rlpScalar(BigInt(yParity))), rS, sS,
    ]);
    /* EIP-1559: raw = 0x02 || rlp([chainId,…,yParity,r,s]) — בלי קידומת-הטיפוס
     * geth מפענח כ-LegacyTx ונופל על "input string too short for common.Address". */
    const raw = "0x02" + Buffer.from(signed).toString("hex");
    /* ── stage 5/6 — capability-checked broadcast: יכולת-שידור היא נפרדת
     * מחתימה; המענק נגזר מחימוש-המפעיל, time-lock נכבד, סירוב = זריקה ── */
    grantBroadcastCapabilityIfArmed();
    requireCapability("broadcast");
    checkTimeLock(decision);
    const txid = await rpc<string>(endpoint, "eth_sendRawTransaction", [raw], 30000);
    if (!txid || !/^0x[0-9a-f]{64}$/.test(txid)) throw new SigningGateError("VALIDATION", "eth broadcast answered without valid hash (honest)");
    /* ── stage 6/6 — audit-trail: key_used + broadcast (הצלחה) + commit שער-החזרה ── */
    appendAudit({ type: "key_used", actor: { keyId: record.keyId }, target: { role: opRole, address }, result: "success" });
    appendAudit({ type: "broadcast", actor: { keyId: record.keyId }, target: { type: "eth_seal_broadcast", height: payloadHeight(payload), txid, gasWei: (BigInt(GAS_LIMIT_ANCHOR) * maxFee).toString() }, result: "success", reason: `EIP-1559 self-tx anchor broadcast to ethereum with ${opRole} role` });
    commitRepeat(payload, Date.now());
    const intent = signEthAnchor(payload, privHex);
    return { txid, intent, address };
  } catch (e) {
    /* stage 6/6 — כשל-ניסיון-חתימה נרשם גם הוא; השגיאה-המקורית מנצחת תמיד */
    appendAudit({ type: "signing_attempt", actor: { keyId: record.keyId }, target: { type: "eth_seal_broadcast", height: payloadHeight(payload) }, result: "failure", reason: e instanceof SigningGateError ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e).slice(0, 200) });
    throw e;
  }
}

/* ── verifyOnChain: קריאה-חוזרת מה-RPC הציבורי והשוואת stateRoot+height ──
 * SECURITY INTENT: אי-אמון-עצמי — ה-txid נקרא-חזרה מתשתית-ציבורית, ה-calldata
 * מנותח ומושווה ביט-מול-ביט מול-המקומי. אי-התאמה → ALERT מעליו ב-relay.ts. */
export async function verifyEthAnchor(
  txid: string,
  expected: { height: number; stateRoot: string },
  expectedAddress: string | null,
): Promise<{ ok: boolean; detail: string }> {
  const endpoint = ETH_RPCS[0];
  const tx = await rpc<{ to: string | null; from: string | null; input: string | null; blockNumber: string | null }>(
    endpoint, "eth_getTransactionByHash", [txid], 15000,
  ).catch(() => null);
  if (!tx) return { ok: false, detail: "not indexed: tx unknown to public node yet" };
  // FIX(Roast-64-c · F7): הנמען מאוגד — expectedAddress היה מוזרק-למחרוזת-בלבד;
  // עתה: tx.to (lowercased) != הכתובת-הצפויה → ok:false "wrong-recipient" (fail-closed).
  if (expectedAddress) {
    // FIX(R15-c · anchor-identity-binding): היה — רק tx.to מאוגד. ה-payload פומבי
    // (anchors.json/UI) וכל-אדם יכול לשלוח tx עם אותו-calldata אל-הכתובת-שלנו —
    // והיה נספר כעוגן-מאומת. עתה: גם tx.from === הכתובת-שלנו (עיגון-אמת הוא
    // self-tx: from==to) — צד-ג' נדחה fail-closed "not-our-anchor".
    const from = String(tx.from ?? "").toLowerCase();
    if (!from || from !== expectedAddress.toLowerCase()) {
      return { ok: false, detail: `mismatch: not-our-anchor — sender ${from ? from.slice(0, 12) + "…" : "unknown"} is not the sovereign identity (fail-closed)` };
    }
    const to = String(tx.to ?? "").toLowerCase();
    if (!to) return { ok: false, detail: "mismatch: wrong-recipient — tx carries no recipient (contract-creation)" };
    if (to !== expectedAddress.toLowerCase()) {
      return { ok: false, detail: `mismatch: wrong-recipient on-chain (to=${to.slice(0, 12)}… expected=${expectedAddress.slice(0, 12)}…)` };
    }
  }
  if (!tx.input || tx.input === "0x") return { ok: false, detail: "mismatch: tx carries no calldata payload" };
  let parsed: { height?: number; stateRoot?: string };
  try { parsed = JSON.parse(Buffer.from(tx.input.slice(2), "hex").toString("utf8")) as { height?: number; stateRoot?: string }; }
  catch { return { ok: false, detail: "mismatch: calldata is not the anchor payload" }; }
  const rootOk = parsed.stateRoot === expected.stateRoot;
  const heightOk = parsed.height === expected.height;
  if (!rootOk || !heightOk) {
    return { ok: false, detail: `mismatch: on-chain h${parsed.height ?? "?"}/${String(parsed.stateRoot ?? "?").slice(0, 12)}… vs local h${expected.height}/${expected.stateRoot.slice(0, 12)}…` };
  }
  const receipt = await rpc<{ status: string | null; blockNumber: string | null }>(
    endpoint, "eth_getTransactionReceipt", [txid], 15000,
  ).catch(() => null);
  if (!receipt) return { ok: false, detail: "not indexed: tx in mempool — receipt pending" };
  if (receipt.status !== "0x1") return { ok: false, detail: `mismatch: receipt status ${receipt.status ?? "null"} (not success)` };
  return { ok: true, detail: `stateRoot verified on ethereum (block ${BigInt(receipt.blockNumber ?? "0x0")})` + (expectedAddress ? ` · to=${expectedAddress.slice(0, 10)}…` : "") };
}
