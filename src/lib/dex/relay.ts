/* relay.ts — "הדלת" — עיגון חותמות SAOS-DEX לשרשראות ציבוריות. · מהדורה-מוסדית
 *
 * מאזין ל-seal() (כל 12 בלוקים), לוקח stateRoot + height, ומשדר custom_json
 * (סמכות active, אפס-עלות — RC) ל-Steem + Hive, וכן עיגון TRON מותנה-מימון.
 *
 * מורשת anchor.cjs / chain_attest.cjs (Task 44/82/89/99 — 64 עיגונים חיים):
 *   · חתימה מקומית: build tx ← dgp, sign (steem.auth, chain_id דינמי), שידור-סינכרוני
 *   · Steem: chain_id אפסים · Hive: beeab0de… · אותו ACTIVE_WIF (הוכח קריפטוגרפית)
 *   · TRON: זהות נגזרת מאותו סקלר secp256k1 — מותנה במימון (כנות: ללא TRX אין שידור)
 *
 * הקשחה-מוסדית (מהדורה זו):
 *   · Circuit Breaker per-chain: כשלים-רצופים קשים → OPEN (הפסקת-ניסיונות) →
 *     half-open (פרובה-יחידה) → הצלחה → CLOSED. תנאי-תקציב (RC-low/unfunded)
 *     אינו כשל-מערכת ואינו סופר ל-breaker.
 *   · Exponential backoff עם jitter (±20%) — לא-דת-מאמץ-תזמון.
 *   · verifyOnChain: אחרי-קבלת-txid — קריאה-חוזרת מה-RPC הציבורי, השוואת
 *     stateRoot+height מול-המקומי. אי-התאמה → ALERT בלוג + מדד-מיסמאץ'.
 *   · Reconciliation: לולאה-תקופתית מאמתת-בדיעבד כל-עיגון ששודר וטרם-אומת.
 *   · אפס סודות בלוגים/פלט/קבצים: מפתחות בזיכרון בלבד מ-.env (gitignored, אומת)
 *
 * חוזה-החתימה שש-השלבים (Task 11-b — port נאמן-מקור מ-relay-eth.ts · e5d22e5
 * ומ-anchor-live.ts · 3f4eeb3; המימוש-הקנוני: Saosmartwallet orchestrator.ts 6/6):
 *   · session-gate (stage 1/6): אין-פתרון-מפתח בלי-סשן-חתימה חי —
 *     SAOS_RELAY_SIGNING_SESSION_UNLOCKED=1 (חימוש-מפעיל לכל-אתחול-תהליך; דו-מפתחי:
 *     המפתחות-ב-.env לבדם כבר-אינם-משדרים) או unlockRelaySigningSession() (API · TTL).
 *     נאכף לפני-כל-טעינת-מפתח (loadKeys) — סדר-השורות-הוא-החוזה (דוקטרינת live_gate 10-d-3).
 *   · policy-gate (stage 2/6): evaluatePolicy לפני-כל-נגיעה-במפתח — פעולות-מותרות
 *     (עיגון chain-seal עצמי בלבד) · resolveRoleFor prefer-posting (least-privilege
 *     בשרשראות-התומכות) · replay-guard (אותו (chain,epoch,height) כבר-עוגן = שידור-חוזר)
 *     · repeat-guard (port מ-budget.py — commit אחרי-הצלחה בלבד) · תקציב-נפח יומי
 *     מהשרשרת-המבוקרת. שלילה נרשמת policy_violation ועוצרת — לעולם לא הסגרה.
 *   · audit-trail (stage 6/6): key_used / signing_attempt / broadcast / policy_violation
 *     — כולל כשלים והמתנות-כלכליות — בשרשרת-ה-hash המשותפת של relay-eth
 *     (state/signing-audit.jsonl דרך appendAudit · SAOS_DEX_STATE_DIR מנתב-בידוד-בדיקות).
 *     אפס חומר-מפתח באירועים (מזהים/גבהים/txids בלבד).
 *   · השלבים 3-5 כבר-חיים בנתיבי-השרשרת (prefer-posting CROSS-F-01 + authorityOk ·
 *     reveal-בזיכרון-בלבד · שידור-מוגבל-פעולה/עלות + breaker). נמדד 6/6 ב-saos-jummper
 *     signingcontract.check.
 */
import fs from "fs";
import path from "path";
import { createHash, timingSafeEqual } from "crypto";
import type { SealInfo } from "./chain";
import { chaosPartitioned } from "./chaos";
import { fleetConfigured, fleetSealNow, fleetSealOn, fleetStatusPublic } from "./fleet";

import { fencedFetch } from "./fence"; // FIX(SETTLE-11)+FIX(Roast-65-b · H2): כל-ה-fetch-ים-דרך-הגדר (redirect:error מרוכז)
import { ethSealBroadcast, verifyEthAnchor, ethIdentity, signEthAnchor, ETH_RPCS,
  // Task 11-b · חוזה-החתימה שש-השלבים — אותם-פרימיטיבים בדיוק (שער-אחד, שרשרת-ביקורת-אחת):
  // SigningGateError = קודי-השער · appendAudit = הפרימיטיב-המבוקר (hash-chain על
  // state/signing-audit.jsonl) · fingerprint/AUDIT_FILE = קנוניות משותפת ל-repeat/replay/תקציב.
  SigningGateError, appendAudit, fingerprint, AUDIT_FILE,
  type PolicyCheck, type SigningAuditEvent } from "./relay-eth";
import { solSealBroadcast, verifySolAnchor, solIdentity } from "./relay-sol";
// M2 · הפרדת Signer–Executor: מודול-המפתחות-היחיד — קריאת-חומר-מפתח (envKey) + ליבות-חתימה (גרפנה/blurt/tron) עברו לשם
import { KEY_ENV_NAMES, envKey, wifNormalized, pubOfWif, signGrapheneTx, signAndSendBlurt, signAndSendTron } from "./signer";
// roast-78 · רצפת-הגנת-גיבוי: קריאת-התביעות-המוטבעות (st.backing) מהמצב-הקנוני-החי.
// אין-מעגל: chain.ts אינו-מייבא את relay.ts (אומת).
import { getLiveState } from "./chain";

type GrapheneTx = {
  ref_block_num: number;
  ref_block_prefix: number;
  expiration: string;
  operations: unknown[];
  extensions: unknown[];
};

export const ZERO_CHAIN_ID = "0000000000000000000000000000000000000000000000000000000000000000";
/* Roast-74: מזהה-השרשרת-של-Steem (ג'נזיס = אפסים) — מיוצא למבצע-המסילה-הרב-רשתי */
export const STEEM_CHAIN_ID = ZERO_CHAIN_ID;

/* ── קבועים ── */
export const ANCHOR_ID = "saos-dex.anchor.v1";
export const HIVE_CHAIN_ID = "beeab0de00000000000000000000000000000000000000000000000000000000";
export const STEEM_NODES = ["https://api.steemit.com", "https://api.justyy.com"];
export const HIVE_NODES = ["https://api.hive.blog", "https://api.deathwing.me"];
/* Roast-74 · מדוד-חי: blurt.world אבד (NXDOMAIN גלובלי) — הצומת-החי-היחיד-שנמדד.
 * chain_id נלקח-מה-SDK-הרשמי-העדכני (@beblurt/dblurt 0.17.0 — 64-hex). */
export const BLURT_NODES = ["https://rpc.blurt.blog"];
export const BLURT_CHAIN_ID = "cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f";
const TRON_RPC = "https://api.trongrid.io";
const RC_MIN = 1_000_000;          // מינימום-שמרטות לפני שידור (custom_json ~190B « 1M)
const RETRY_MAX = 6;
const QUEUE_CAP = 8;

/* Circuit breaker — ספי-מוסד */
const BREAKER_THRESHOLD = 4;        // כשלים-קשים-רצופים → OPEN
const BREAKER_COOLDOWN_MS = 5 * 60_000; // OPEN → half-open (פרובה-יחידה)

/* Verification / reconciliation */
const VERIFY_DELAY_MS = 4_000;      // זמן-התייצבות-אינדוקס אחרי-שידור-סינכרוני
const VERIFY_TRIES = 4;
const VERIFY_GAP_MS = 6_000;
const RECONCILE_EVERY_MS = 90_000;  // לולאת-פיוס תקופתית
const RECONCILE_FIRST_MS = 8_000;   // מחזור-ראשון — מיד-אחרי-עלייה (ריפוי-שאריות)
const RECONCILE_BATCH = 3;          // עד-3 אימותים-בדיעבד למחזור

/* ── סוגים ── */
/* Roast-82 · מסילת-BLURT — השרשרת-השביעית: BLURT (fork-גרפני-של-Steem) ללא-מערכת-RC-כלל
 * (אימות-חי: get_accounts אינו-מחזיר rc_manabar) — עיגון-אפס-עלות-אמת. הצומת-וה-chain_id
 * נמדדו-חי-ב-roast-74; המפתח (BLURT_ACTIVE_WIF) בכספת; החשבון headcorner חי על BLURT. */
export type ChainName = "steem" | "hive" | "blurt" | "tron" | "eth" | "sol" | "fleet";
const ALL_CHAINS: ChainName[] = ["steem", "hive", "blurt", "tron", "eth", "sol", "fleet"];
/* עיגון-כבד (gas/SOL) ועיגון-RC — רק החותם-החדש-ביותר מעוגן עליהם */
const LATEST_ONLY: ChainName[] = ["hive", "tron", "eth", "sol", "fleet"];
/* המתנה-כלכלית: RC מתחדש מהר; מימון (TRX/gas/SOL) הוא אירוע-תפעולי איטי */
// Roast-73 · FIX(fleet-rc-economics): היה-20דק' לשרשרות-RC — נמדד-חי: עיגון-אחד
// בולע ~500M-RC והכנסת-ה-RC-המשותפת-של-הצי היא ~16.4B/יום (190k/ש׳) → קצב-20דק'
// שורף-פי-2 מההכנסה ורוקן-את-כל-החיילים-עד-הקרקע (usable=0/11 — נמדד). קצב-מאוזן:
// 45דק' ≈ 32/יום × ~500M = 16B/יום ≈ איזון-אמת. headcorner-לבדו (41.2B-max, 95k/ש׳)
// ממשיך-להספיק-ל-hive — והמפעיל תמיד-יכול לעגן-ידנית (POST /fleet anchor) מעבר-לקצב.
const econWaitMin = (c: ChainName): number => (c === "steem" || c === "hive" || c === "fleet" ? 45 : 30);

/* roast-78 · רצפת-הגנת-הגיבוי — התביעות-המוטבעות של WSOL ב-lamports.
 * מתמטיקת-הטבעה (peg-door verifySolDeposit): amountMu = floor(lamports/1e6)
 * ⇒ 1µ-תביעה = 1e6-lamports גיבוי-פיזי. st.backing נעול 1:1 בגרעין (fail-closed),
 * ולכן הרצפה = backing.WSOL × 1e6. עיגון-SOL שורף 5,000-lamports מהמשמורת —
 * אותה-משמורת-היא הגיבוי-הפיזי. השער: אסור שהשריפה תצלול מתחת-לתביעות. */
function solClaimsFloorLamports(): number {
  try {
    const st = getLiveState();
    const claimsMu = Math.max(0, Math.floor(st.backing?.WSOL ?? 0));
    return claimsMu * 1_000_000;
  } catch {
    return 0; // אין-מצב-חי → אין-רצפה-מחושבת; הרצפה-הקנונית (rent+fee) נשארת
  }
}
export type AnchorStatus = "anchored" | "sent-unconfirmed" | "pending" | "failed";
export type BreakerState = "closed" | "open" | "half-open";

export interface AnchorRecord {
  chain: ChainName;
  /** EPOCH-PATCH-SPEC: מזהה-גלגול-מונה-הגבהים — (epoch,height) ייחודי-חוצה-ריסטארטים */
  epoch: string;
  height: number;
  stateRoot: string;
  digest: string;
  txid: string | null;
  /** SETTLE-13: לעיגון-צי — איזה-חשבון-חייל חתם (ציבורי; אין-סודות) */
  account?: string;
  status: AnchorStatus;
  at: string;
  attempt: number;
  verified: boolean | null;   // null = טרם-נבדק · true = אומת ב-RPC · false = מיסמאץ'
  verifiedAt: string | null;
  error?: string;
}

export interface BreakerView {
  state: BreakerState;
  failures: number;
  openedAt: number | null;
  trips: number;
}

export interface RelayChainState {
  enabled: boolean;
  status: AnchorStatus | "idle" | "disabled";
  lastTxid: string | null;
  lastHeight: number | null;
  lastAt: string | null;
  lastError: string | null;
  lastVerifyError: string | null;
  anchored: number;
  verified: number;
  mismatches: number;
  breaker: BreakerView;
  // FIX(CROSS-F-04, saos-jummper): הפנקס-הציבורי לא-העיד על-איזו-רשת/שער כל-עיגון
  // פגע — devnet-מול-mainnet היו בלתי-נבדלים. עתה: host בפועל (בדידורג/עודכן בשידור).
  endpointHost: string | null;
}

interface RelayMetrics {
  broadcasts: number;
  verified: number;
  mismatches: number;
  breakerTrips: number;
  economicWaits: number;
  /* ROTATION ENGINE (Task 3-a): כמה-פעמים כשל-דלק על-הזהות-הראשית נפתר-בחייל-צי
   * במקום עצירת-מנוע — המדד-הקנוני ל"המסילה-לא-עצרה". */
  rotations: number;
  lastVerifyLatencyMs: number | null;
}

interface ChainJobState { attempts: number; rcWaits: number; nextTryAt: number; done: boolean }
interface SealJob {
  info: SealInfo;
  at: string;
  /** EPOCH-PATCH-SPEC: נקבע-פעם-אחת-לעבודה (לא-פר-שרשרת!) — שומר-על שוויון-בייטים-בין-השרשראות */
  epoch: string;
  chains: Record<ChainName, ChainJobState>;
}

interface RelayRT {
  jobs: SealJob[];
  processing: boolean;
  records: AnchorRecord[];
  chainState: Record<ChainName, RelayChainState>;
  metrics: RelayMetrics;
  account: string | null;
  tronAddress: string | null;
  ethAddress: string | null;   // זהות-הצי idx=2 (מאומתת מול-ETH_EXPECTED_ADDRESS)
  solAddress: string | null;   // זהות-הצי idx=2 (מאומתת מול-SOL_EXPECTED_ADDRESS)
  ethIntents: { height: number; intentHash: string; signature: string; address: string; verified: boolean }[]; // כוונות-EIP-191 (אפס-גז)
  startedAt: number;
  lastActivityAt: number;
  reconcileStarted: boolean;
}

const g = globalThis as unknown as { __saosDexRelay?: RelayRT };
/* הפרדת-מצב: כלי-בדיקה (scripts/chaos-test.ts) מכוון SAOS_DEX_STATE_DIR לתיקיית-זמן —
 * כך ראיות-בדיקה לעולם לא נוגעות ב-state/anchors.json הציבורי של הדמון החי */
const STATE_DIR = process.env.SAOS_DEX_STATE_DIR
  ? path.resolve(process.env.SAOS_DEX_STATE_DIR)
  : path.join(process.cwd(), "state");
const ANCHORS_FILE = path.join(STATE_DIR, "anchors.json");

/* ── Epoch lifecycle (EPOCH-PATCH-SPEC · מיושם-מהמפרט של saos-jummper · roast-76) ──
 * `height` מתחיל-מחדש-עם-כל-גלגול-תהליך — (epoch,height) הוא-המפתח-היחיד-הייחודי-חוצה-ריסטארטים.
 * Bump-על-גובה-לא-עולה (ולא-על-ריסטארט): ריסטארט-עם-שחזור-מצב אינו-נצפה-מבפנים;
 * גובה-לא-עולה כן-נצפה — והוא-התנאי-היחיד שבו-יכולה-להיווצר-התנגשות-על-השרשרת.
 * Bump-מיותר-עולה-epoch-אחד-ולא-יוצר-סתירה; היעדר-bump-כשצריך = פיצול-ציבורי-קבוע. */
type EpochState = { epochIndex: number; lastHeight: number | null };
const EPOCH_FILE = path.join(STATE_DIR, "epoch.json");

function loadEpoch(): EpochState {
  try {
    const s = JSON.parse(fs.readFileSync(EPOCH_FILE, "utf8")) as EpochState;
    if (!Number.isInteger(s.epochIndex) || s.epochIndex < 0) throw new Error("bad epochIndex");
    if (s.lastHeight !== null && (!Number.isInteger(s.lastHeight) || s.lastHeight < 0)) throw new Error("bad lastHeight");
    return s;
  } catch {
    return { epochIndex: 0, lastHeight: null };
  }
}

function saveEpoch(s: EpochState): void {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(EPOCH_FILE, JSON.stringify(s)); } catch { /* נשאיר-בזיכרון — כתיבה-נכשלת לא-מפילה-עיגון */ }
}

/** מחזיר-את-מחרוזת-ה-epoch לגובה-זה, עם-bump-מוקדם-אם-חובה. */
export function assignEpoch(height: number): string {
  if (!Number.isInteger(height) || height < 0) throw new Error(`assignEpoch: height must be a non-negative integer, got ${height}`);
  const s = loadEpoch();
  if (s.lastHeight === null || height > s.lastHeight) {
    saveEpoch({ epochIndex: s.epochIndex, lastHeight: height });
  } else {
    s.epochIndex += 1;
    saveEpoch({ epochIndex: s.epochIndex, lastHeight: height });
  }
  return `e${loadEpoch().epochIndex}`;
}

/* ════════════════════════════════════════════════════════════════════════
 * חוזה-החתימה שש-השלבים על "הדלת" (Task 11-b) — port נאמן-מקור מ-relay-eth.ts
 * (Task 8-a · e5d22e5) ומ-anchor-live.ts (platform · 3f4eeb3). שלושת-השלבים
 * החסרים נחוטים כאן (session-gate · policy-gate · audit-trail); השלבים 3/4/5
 * כבר-חיים בנתיבי-השרשרת למטה. fail-closed לכל-אורכו: כשל-שלב = עצירה
 * לפני-שידור. כלום לא נחתם על אולי.
 * ══════════════════════════════════════════════════════════════════════ */

/* ── stage 1/6 — מצב-הסשן (על globalThis — עמיד-ל-hot-reload, אותו-דפוס relay-eth) ── */

const SESSION_TTL_MS = 60 * 60 * 1000; // שעה — אחריה נדרש חימוש-מחדש (re-auth)

interface RelaySigningSessionState {
  unlocked: boolean;
  source: "env" | "api" | null;
  unlockedAtMs: number | null;
  stepUpAtMs: number | null;
}

const gRelaySigning = globalThis as unknown as { __saosDexRelaySigningSession?: RelaySigningSessionState };
function relaySigningSession(): RelaySigningSessionState {
  if (!gRelaySigning.__saosDexRelaySigningSession) {
    gRelaySigning.__saosDexRelaySigningSession = { unlocked: false, source: null, unlockedAtMs: null, stepUpAtMs: null };
  }
  return gRelaySigning.__saosDexRelaySigningSession;
}

function relaySessionEnvArmed(): boolean {
  const v = (process.env.SAOS_RELAY_SIGNING_SESSION_UNLOCKED ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** פתיחת-סשן-חתימה מפורשת (API לקוראים אינטראקטיביים). stepUpToken אופציונלי —
 * מאומת מול SAOS_RELAY_SIGNING_STEPUP_TOKEN_SHA256 ומספק step-up (re-auth). */
export function unlockRelaySigningSession(opts?: { stepUpToken?: string; source?: string }): void {
  const s = relaySigningSession();
  s.unlocked = true;
  s.source = "api";
  s.unlockedAtMs = Date.now();
  if (opts?.stepUpToken && verifyRelayStepUp(opts.stepUpToken)) s.stepUpAtMs = Date.now();
}

/** step-up re-auth: השוואה timing-safe מול hash הטוקן שהמפעיל הגדיר. */
export function verifyRelayStepUp(token: string): boolean {
  const expected = (process.env.SAOS_RELAY_SIGNING_STEPUP_TOKEN_SHA256 ?? "").trim().toLowerCase();
  if (!expected || !token) return false;
  const got = createHash("sha256").update(token).digest("hex");
  const a = Buffer.from(got, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * stage 1/6 — session-gate: חייב לעבור לפני loadKeys (לפני שכל בייט-מפתח נוגע).
 * תהליך-בלתי-מושגח מחייב חימוש-מפעיל מפורש:
 *   SAOS_RELAY_SIGNING_SESSION_UNLOCKED=1 (חימוש-לכל-אתחול-תהליך) או
 *   unlockRelaySigningSession()          (API — עם TTL של SESSION_TTL_MS).
 * SAOS_RELAY_SIGNING_REQUIRE_STEPUP=1 דורש step-up שהושלם גם עבור חימוש-env.
 */
function ensureUnlocked(): void {
  const s = relaySigningSession();
  if (!s.unlocked && relaySessionEnvArmed()) {
    s.unlocked = true;
    s.source = "env";
    s.unlockedAtMs = Date.now();
  }
  if (!s.unlocked) {
    throw new SigningGateError(
      "SESSION_LOCKED",
      "relay signing session is locked — no key resolution for an unattended process (stage 1/6): arm SAOS_RELAY_SIGNING_SESSION_UNLOCKED=1 (or call unlockRelaySigningSession) alongside the .env keys",
    );
  }
  if (s.source === "api" && s.unlockedAtMs !== null && Date.now() - s.unlockedAtMs > SESSION_TTL_MS) {
    s.unlocked = false;
    s.source = null;
    s.unlockedAtMs = null;
    throw new SigningGateError("SESSION_EXPIRED", "relay signing session expired — re-unlock required before any key resolution (stage 1/6)");
  }
  if ((process.env.SAOS_RELAY_SIGNING_REQUIRE_STEPUP ?? "").trim() === "1" && s.stepUpAtMs === null) {
    throw new SigningGateError("POLICY_STEP_UP_REQUIRED", "step-up re-authentication demanded (SAOS_RELAY_SIGNING_REQUIRE_STEPUP=1) — unlockRelaySigningSession({ stepUpToken }) required (stage 1/6)");
  }
}

/* ── stage 3/6 — פתרון-תפקיד (הצהרת-המדיניות; הביצוע-החי כבר בנתיבי-השרשרת) ── */

export type RelayAnchorRole = "active" | "posting";

/**
 * התפקיד נגזר ממה שהפעולה עושה (port של resolveRoleFor/defaultRoleFor):
 * custom_json-עיגון הוא פרסום — prefer-posting בשרשראות-התומכות (steem/hive —
 * אותו-דוקטרינת CROSS-F-01 ש-loadKeys מבצעת); BLURT — active-בלבד (אין-מפתח-
 * פרסום-בכספת); tron/eth/sol — פעולות-נושאות-ערך → active; צי — POSTING-בלבד
 * (SETTLE-13). null = חסר-תפקיד (flavor-less) — מסרב, לא ממיר.
 * ההכרעה-החיה-בשידור (required_auths/required_posting_auths ב-buildOp) נגזרת
 * מהתפקיד-הפתור-אחרי-ה-self-heal של authorityOk — post-policy, כמו-החוזה.
 */
export function resolveRoleFor(chain: ChainName): RelayAnchorRole | null {
  switch (chain) {
    case "steem":
      return envKey("STEEM_POSTING_WIF") ? "posting"
        : envKey("STEEM_ACTIVE_WIF") ? "active" : null;
    case "hive":
      return envKey("HIVE_POSTING_WIF") ? "posting"
        : envKey("HIVE_ACTIVE_WIF") ? "active" : null;
    case "blurt":
      return envKey("BLURT_ACTIVE_WIF") ? "active" : null;
    case "tron": // פעולת-ערך → active. FIX(F-8): TRON_PRIVATE_KEY (זהות-הכספת-הריבונית, hex)
      // הוא-מקור-סמכות-מלא — לא רק הסקלר-הגרפני; אפס-תלות במות-Steem.
      return envKey("TRON_PRIVATE_KEY") || envKey("STEEM_ACTIVE_WIF") || envKey("STEEM_POSTING_WIF") ? "active" : null;
    case "eth":
    case "sol":
      return "active"; // חתימה-חיה בתוך relay-eth/relay-sol — פעולות-ערך (גז/עמלה)
    case "fleet":
      return "posting"; // SETTLE-13: עיגון-צי POSTING-בלבד, אפס-עלות
    default:
      return null;
  }
}

/* ── מצב-החזרה (repeat-guard) — port מ-saos-jummper budget.py RepeatGuard:
 * כל-קריאה בודדות עוברות; הנזק הוא בחזרתיות ובצבירה. commit אחרי-הצלחה-בלבד.
 * מפתח per-chain: אותו-payload חוקי על שרשראות-שונות (עיגון-רב-רשתי). */

const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;
const REPEAT_MAX = 1;

const gRelayRepeat = globalThis as unknown as { __saosDexRelayRepeatSeen?: Map<string, number[]> };
function repeatSeen(): Map<string, number[]> {
  if (!gRelayRepeat.__saosDexRelayRepeatSeen) gRelayRepeat.__saosDexRelayRepeatSeen = new Map();
  return gRelayRepeat.__saosDexRelayRepeatSeen;
}

function repeatKey(chain: ChainName, payload: unknown): string {
  return `${chain}:${fingerprint(payload)}`;
}

function repeatCount(key: string, now: number): number {
  const kept = (repeatSeen().get(key) ?? []).filter((t) => t >= now - REPEAT_WINDOW_MS);
  repeatSeen().set(key, kept);
  return kept.length;
}

function commitRepeat(chain: ChainName, payload: unknown, now: number): void {
  const key = repeatKey(chain, payload);
  const seen = repeatSeen();
  seen.set(key, [...(seen.get(key) ?? []).filter((t) => t >= now - REPEAT_WINDOW_MS), now]);
}

/* ── שרשרת-הביקורת (stage 6/6) — נקראת מהפנקס-המשותף של relay-eth
 * (signing-audit.jsonl · SAOS_DEX_STATE_DIR מנתב-לבידוד-בדיקות, אותו-ניתוב
 * כמו anchors.json). ספירות-התקציב וה-replay נגזרות-ממנו — buildOperationContext
 * של ה-orchestrator: המדיניות קוראת-היסטוריה-מבוקרת, לא מנחשת. */

function readAuditStats(chain: ChainName, epoch: string, height: number): { spentToday: number; priorHeight: number | null } {
  const day = new Date().toISOString().slice(0, 10);
  let spentToday = 0;
  let priorHeight: number | null = null;
  try {
    for (const line of fs.readFileSync(AUDIT_FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as SigningAuditEvent;
        if (ev.type !== "broadcast" || ev.result !== "success") continue;
        const t = (ev.target ?? {}) as { chain?: unknown; epoch?: unknown; height?: unknown };
        if (typeof t.chain !== "string" || t.chain !== chain) continue;
        if (typeof ev.at === "string" && ev.at.slice(0, 10) === day) spentToday += 1;
        if (epoch && t.epoch === epoch && typeof t.height === "number" && t.height === height) {
          priorHeight = t.height; // אותו (chain,epoch,height) כבר-עוגן-בהצלחה — שידור-חוזר
        }
      } catch { /* שורה-פגומה — נדלגת */ }
    }
  } catch { /* אין-ביקורת עדיין — תקציב מלא */ }
  return { spentToday, priorHeight };
}

/** תקציב-נפח-יומי — סכום-תקרות-הקצב-העצמיות של המסילה (econWaitMin:
 * 32+32+48+48+48+48+32) — רק-לולאה-חריגה-מהקצב-העצמי-מגיעה-עד-כאן.
 * ניתן-לעקיפה-מפורשת-למפעיל. */
function dailyAnchorLimit(): number {
  const raw = Number.parseInt(process.env.SAOS_RELAY_ANCHOR_DAILY_LIMIT ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 288;
}

/* ── שער-המדיניות (stage 2/6) ── */

export interface RelayPolicyDecision {
  allowed: boolean;
  reasons: string[];
  checks: PolicyCheck[];
  role: RelayAnchorRole | null;
  requirements: { stepUpAuth: boolean; dailyLimit: number };
}

/**
 * stage 2/6 — evaluatePolicy: נרץ לפני שמפתח נוגע (לפני loadKeys). כללים
 * סטטיים fail-closed (port של הכללים הקומפילים של PolicyEngine + budget.py):
 * שלילה = זריקה, לעולם לא הסגרה.
 */
export function evaluatePolicy(op: { chain: ChainName; payload: unknown }): RelayPolicyDecision {
  const checks: PolicyCheck[] = [];
  const reasons: string[] = [];
  const denyGuard = (guard: string, reason: string): void => {
    checks.push({ guard, allowed: false, reason });
    reasons.push(`${guard}: ${reason}`);
  };

  // 1) allowed-operations — הדלת חותמת ומשדרת עיגון chain-seal עצמי בלבד
  const p = (op.payload ?? {}) as { protocol?: unknown; action?: unknown; at?: unknown; epoch?: unknown; height?: unknown; stateRoot?: unknown; digest?: unknown };
  if (
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
  const role = resolveRoleFor(op.chain);
  if (role === null) {
    denyGuard("role", `no signing role for ${op.chain} — a role-less key refuses rather than defaulting (stage 3/6)`);
  } else {
    checks.push({ guard: "role", allowed: true, reason: `${op.chain}:${role} (prefer-posting least-privilege where the chain supports it)` });
  }

  // 3) replay-guard — הצלחה-מבוקרת-קודמת באותו (chain,epoch,height) = שידור-חוזר,
  //    גם-אם-בייטי-ה-payload סטו (loop-containment על-זהות-העיגן, לא על-התוכן)
  const stats = readAuditStats(op.chain, typeof p.epoch === "string" ? p.epoch : "", typeof p.height === "number" ? p.height : -1);
  if (stats.priorHeight !== null) {
    denyGuard("replay", `h${String(p.height)} was already anchored on ${op.chain} in epoch ${String(p.epoch)} (prior success in the audit chain) — a replayed height is a replay, not a decision`);
  } else {
    checks.push({ guard: "replay", allowed: true, reason: "no prior success at this height/epoch" });
  }

  // 4) repeat-guard (budget.py port) — הפעולה-הזהה-על-השרשרת-הזאת כבר שודרה-בהצלחה בחלון = לולאה
  const now = Date.now();
  const prior = repeatCount(repeatKey(op.chain, op.payload), now);
  if (prior >= REPEAT_MAX) {
    denyGuard("repeat", `identical ${op.chain} payload already broadcast ${prior} time(s) within ${REPEAT_WINDOW_MS / 60000}min — a repeating identical operation is a loop, not a decision`);
  } else {
    checks.push({ guard: "repeat", allowed: true, reason: "not a repeat" });
  }

  // 5) תקציב-נפח יומי (spentToday נקרא מהשרשרת-המבוקרת — buildOperationContext של ה-orchestrator)
  const limit = dailyAnchorLimit();
  if (stats.spentToday >= limit) {
    denyGuard("daily-volume-budget", `daily cap reached — ${stats.spentToday}/${limit} successful broadcasts today (UTC) — honest economic hold`);
  } else {
    checks.push({ guard: "daily-volume-budget", allowed: true, reason: `spentToday ${stats.spentToday}/${limit}` });
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    checks,
    role,
    requirements: { stepUpAuth: (process.env.SAOS_RELAY_SIGNING_REQUIRE_STEPUP ?? "").trim() === "1", dailyLimit: limit },
  };
}

/* ── payload קנוני משותף לכל-השרשראות — הועבר-מתוך attemptChain עבור שער-המדיניות:
 * ההערכה-לפני-המפתח חייבת-לראות את-אותם-בייטים-שייחתמו. סדר-השדות נשמר-בדיוק —
 * שוויון-בייטים-בין-שרשראות (EPOCH-PATCH-SPEC) לא-נפגע. ── */
function canonicalSealPayload(job: SealJob): { protocol: string; action: string; at: string; epoch: string; height: number; stateRoot: string; digest: string } {
  return {
    protocol: "saos-dex/v1", action: "chain-seal", at: job.at,
    epoch: job.epoch,
    height: job.info.toHeight, stateRoot: job.info.stateRoot, digest: job.info.digest,
  };
}

/* ── הגבלת-תדירות-רישום-ביקורת: לולאת-הדלת רצה-כל-חותם (כל-12-בלוקים) — שלילה
 * מתמשכת לא תהפוך-לשטף-אירועים. האכיפה-עצמה נאכפת-בכל-הערכה; רק-הרישום-מוגבל-
 * תדירות (המצב-הכנה נשמר-תמיד ב-lastError של השרשרת). ── */
const AUDIT_THROTTLE_MS = 60 * 60 * 1000;
const gAuditAt = globalThis as unknown as { __saosDexRelayAuditAt?: Map<string, number> };
function auditThrottled(key: string): boolean {
  const now = Date.now();
  const m = gAuditAt.__saosDexRelayAuditAt ?? (gAuditAt.__saosDexRelayAuditAt = new Map());
  const last = m.get(key) ?? 0;
  if (now - last < AUDIT_THROTTLE_MS) return true; // מוגבל-תדירות — המדיניות עדיין נאכפת
  m.set(key, now);
  return false;
}

/* ── חוזה-מפתחות-מנורמל (SETTLE-11) ── */
type RelayKeys = {
  account: string; steemWif: string; steemAuth: "posting" | "active";
  hiveAccount: string; hiveWif: string; hiveAuth: "posting" | "active";
  // Roast-82: BLURT — active-בלבד (אין-מפתח-פרסום-בכספת), אותו-חשבון headcorner
  blurtWif: string | null; blurtPub: string | null;
  ethKey: string | null; solKey: string | null;
  ethExpected: string | null; solExpected: string | null;
  // Task 54 · FIX(authority-pub): פאב-האימות נגזר-מה-WIF-הגולמי (פורמט-דחוס K/L) —
  // wifToPublic של-הספרייה מחזיר פאב-שגוי לפורמט-המנורמל 5K (נמדד-חי 2026-09-09:
  // אותו-סקלר → פאב-שונה!). החתימה עצמה רצה על המנורמל (SETTLE-10/11) — שני העולמות.
  steemPub: string | null; hivePub: string | null;
  // FIX(R13 · wif-forms): steem-js 0.7.11 מפענח K/L דחוס לסקלר שגוי בשקט
  // (WARN בלי-זריקה — BigInteger.fromBuffer כולל דגל-הדחיסה 0x01 → k·256+1).
  // עתה: הצורה-המנורמלת (5K) נשמרת לצד הגולמית; ה-preflight בודק את שתי-הצורות
  // מול-השרשרת וה-self-heal בוחר את-הצורה-המנצחת לחתימה — שני דורות-רישום חיים.
  steemWifNorm: string | null; hiveWifNorm: string | null; blurtWifNorm: string | null;
};

/* ── FIX(SETTLE-11) נרמול-WIF — עבר ל-signer.ts (M2 · Signer–Executor) ──
 * wifNormalized מיובא ממודול-המפתחות-היחיד; סמנטיקה-זהה ביט-מול-ביט. */

/* ── מפתחות: זיכרון-בלבד מ-.env (Next טוען אוטומטית; הקובץ gitignored-אומת) ──
 * FIX(SETTLE-11): WIF-ים מנורמלים בטעינה לפורמט-גרפני (לא-דחוס) — שני הפורמטים
 * (51/52 תווים) נתמכים; פליטה-פסולה → null + ALERT כנה (fail-closed). */
// FIX(roast-79 · keys-memo): loadKeys נקרא-בכל-ריצת-processQueue (כל-חותם) והיה
// מפרק-מחדש-את-אותו-.env ומריץ-שוב wifToPublic על-מפתחות-פסולים (WARN ×כל-חותם —
// נמדד 12/12). env הוא-סטטי-בזמן-ריצה → מטמון-מודול לפי-חתימת-הקלטים. בונוס-תקנה:
// ה-self-heal של-authorityOk (כתיבת-ה-WIF-המנצח-בחזרה) שרד-עכשיו-בין-חותמים —
// קודם-הוא-נשטף-בכל-קריאה-מחדש-של-האובייקט.
let keysMemo: { sig: string; keys: RelayKeys | null } | null = null;
async function loadKeys(): Promise<RelayKeys | null> {
  // FIX(R14-a · content-fingerprint): החתימה הייתה לפי-אורך-בלבד — WIF-גרפני תמיד
  // 51/52 תווים, כך שרוטציית-מפתח-באותו-אורך (Next מטעין-.env מחדש חי) הייתה שקופה
  // לגמרי: loadKeys ממשיך להחזיר את המפתח-הישן עד-restart, וה-authChecked של השרשרת
  // (מפתח-לפי-chain בלבד) שומר על פסק-הדין-הישן. עתה: טביעת-אצבע של התוכן
  // (sha256 — אפס-ערכי-גלם בלוג/מחרוזת, 16-תווי-הקס) + ניקוי-מטמון-הסמכות בשינוי.
  const envs = KEY_ENV_NAMES;
  const h = createHash("sha256");
  for (const k of envs) h.update(`${k}\x00${envKey(k)}\x00`);
  const sig = h.digest("hex").slice(0, 16);
  if (keysMemo && keysMemo.sig === sig) return keysMemo.keys;
  if (keysMemo) {
    for (const c of [...authChecked.keys()]) authChecked.delete(c); // פסק-דין-ישן לא מגן על מפתח-חדש
    console.info("[saos-relay][keys] .env key-material changed — keys + authority cache reloaded");
  }
  const keys = await loadKeysUncached();
  keysMemo = { sig, keys };
  return keys;
}

async function loadKeysUncached(): Promise<RelayKeys | null> {
  // M2: כל-קריאות-חומר-המפתח דרך envKey — נקודת-האכיפה היחידה (signer.ts)
  const account = envKey("SAOS_RELAY_AGENT_ACCOUNT").toLowerCase();
  // FIX(CROSS-F-01, saos-jummper מדוד): עדיפות-מפתח-פרסום (POSTING) על-פני-ACTIVE.
  // עיגון-custom_json אינו-צריך-סמכות-כספים: ACTIVE יכולה-להעביר-כל-נכס-בחשבון;
  // POSTING רק-מפרסמת. זהה-במשאבים-וב-RC, ומוריד-יכולת-העברה-מהשידור-האוטומטי.
  // בלי-מפתח-פרסום (STEEM_POSTING_WIF/HIVE_POSTING_WIF) — נשארים-על ACTIVE-ההיסטורי
  // (כנות, לא-שבירה; כל-21-העוגנים-החיים-הוגשו-על-ACTIVE).
  const steemPost = envKey("STEEM_POSTING_WIF");
  const hivePost = envKey("HIVE_POSTING_WIF");
  const steemRaw = steemPost || envKey("STEEM_ACTIVE_WIF");
  const hiveRaw = hivePost || envKey("HIVE_ACTIVE_WIF");
  // FIX(F-7 · EXEC-CD-35 · עצמאות-מפתחות-פר-שרשרת): היה `if (!account || !steemRaw || !hiveRaw) return null;`
  // — מפתח-Steem-חסר (רוטציה-מתועדת) היה מחזיר null ומנטרל **גם-את-Hive-המאומת** (נמדד-חי:
  // hive/posting MATCH מול-הרשות-החיה אך chainState.hive=disabled). עתה: ה-Relay חי כשיש
  // לפחות-זהות-אחת; כל-שרשרת נשענת על **המפתח-שלה-בלבד** (ריק = מושבתת-שקטה ב-attemptChain).
  // מפתח-זבל → pub=null → authority-mismatch כנה פר-שרשרת (fail-closed עדיין, אך מבודד).
  if (!account || (!steemRaw && !hiveRaw)) return null;
  // Roast-82: BLURT — אופציונלי-בטעינה (השרשרת-מושבתת-בשקט-בלעדו, אותו-דפוס-SETTLE-11)
  // FIX(prefix): steem-js מנרמל-פאב-עם-קידומת-STM-ברירת-מחדל; BLURT רושמת-BLT. אותו-גוף-מפתח
  // (נמדד-חי: STM5HhJD…≡BLT5HhJD…=ה-active-של-headcorner) — רק-הקידומת-שונה. מציבים-BLT-סביב-הגזירה.
  const blurtRaw = envKey("BLURT_ACTIVE_WIF") || null;
  // FIX(prefix): steem-js מנרמל-פאב-עם-קידומת-STM-ברירת-מחדל; BLURT רושמת-BLT. אותו-גוף-מפתח
  // (נמדד-חי: STM5HhJD…≡BLT5HhJD…=ה-active-של-headcorner) — רק-הקידומת-שונה. pubOfWif מטפל-בקידומת-פנימית.
  const blurtPub: string | null = blurtRaw ? pubOfWif(blurtRaw, "BLT") : null;
  // Task 54 · FIX(sign-wif): החתימה על ה-WIF-הגולמי (דחוס K/L) — נמדד-חי 2026-09-09:
  // הספרייה הנוכחית גוזרת פאב-שגוי מהפורמט-המנורמל 5K (גם ב-wifToPublic וגם בחתימה
  // → "Missing Active Authority" על-השרשרת). הגולמי: פאב-נכון + חתימה-מאומתת.
  // הנרמול-ההיסטורי (SETTLE-10/11) נשמר-כנפילה-חזרה רק-אם-החתימה-על-הגולמי נדחית.
  const steemWif = steemRaw || "";
  const hiveWif = hiveRaw || "";
  // FIX(F-7): אין-עצירה-גלובלית על-מפתח-חסר-פר-שרשרת; ערך-קיים-ופסול ייתפס-כנה
  // ב-authorityOk (pub=null → authority-mismatch → disabled פר-שרשרת, אפס-חתימה).
  const steemAuth: "posting" | "active" = steemPost ? "posting" : "active";
  const hiveAuth: "posting" | "active" = hivePost ? "posting" : "active";
  // אפשרות-עוגן-Hive נפרד (חשבון-צבא עם RC גבוה) — ברירת-מחדל: אותה זהות
  const hiveAccount = (envKey("HIVE_ANCHOR_ACCOUNT") || account).toLowerCase();
  // ETH/SOL: זהויות-צי (wallets-registry) — אופציונליות; כשקיימות, ה-Relay חמוש
  // (signing-חי מקומי) והשידור נעול-מימון עד-שהכתובות ימומנו (כנות)
  const ethKey = envKey("ETH_PRIVATE_KEY") || null;
  const solKey = envKey("SOL_PRIVATE_KEY") || null;
  const ethExpected = envKey("ETH_EXPECTED_ADDRESS") || null;
  const solExpected = envKey("SOL_EXPECTED_ADDRESS") || null;
  // Task 54 · פאב-אימות מהגולמי (ראה FIX(authority-pub) למעלה); כישלון = null → authorityOk ידווח כנה
  const steemPub: string | null = steemRaw ? pubOfWif(steemRaw) : null;
  const hivePub: string | null = hiveRaw ? pubOfWif(hiveRaw) : null;
  // FIX(R13 · wif-forms): צורות-מנורמלות — fail-soft: פליטה-פסולה = null (ה-preflight ידווח כנה)
  const steemWifNorm = steemRaw ? await wifNormalized(steemRaw) : null;
  const hiveWifNorm = hiveRaw ? await wifNormalized(hiveRaw) : null;
  const blurtWifNorm = blurtRaw ? await wifNormalized(blurtRaw) : null;
  return { account, steemWif, steemAuth, hiveAccount, hiveWif, hiveAuth, blurtWif: blurtRaw, blurtPub, ethKey, solKey, ethExpected, solExpected, steemPub, hivePub, steemWifNorm, hiveWifNorm, blurtWifNorm };
}

/* בדיקת-נוכחות-סינכרונית (ל-rtInit — בלי-פענוח) */
function keysConfigured(): { main: boolean; steem: boolean; hive: boolean; tron: boolean; blurt: boolean; eth: boolean; sol: boolean; account: string | null } {
  // M2: קריאות-נוכחות-סודות דרך envKey בלבד (signer.ts)
  const account = envKey("SAOS_RELAY_AGENT_ACCOUNT").toLowerCase() || null;
  const steemWif = envKey("STEEM_POSTING_WIF") || envKey("STEEM_ACTIVE_WIF");
  const hiveWif = envKey("HIVE_POSTING_WIF") || envKey("HIVE_ACTIVE_WIF");
  // FIX(F-7 · EXEC-CD-35): אתחול-פר-שרשרת — כל-שרשרת נשענת על המפתח-שלה בלבד
  // (היה: main=steem∧hive → מפתח-Steem-חסר היה משבית גם-את-Hive-המאומת). tron נשאר
  // נגזר-מהסקלר-הגרפני (זהות-STEEM-family) — סמנטיקה-קיימת-ללא-שינוי.
  // FIX(F-7+F-8 · EXEC-CD-35): tron נשען על המפתח-שלו-עצמו (TRON_PRIVATE_KEY — זהות-הכספת)
  // או על הסקלר-הגרפני; כבר-לא-מוצמד-למות-Steem.
  return {
    main: !!(account && steemWif && hiveWif),
    steem: !!(account && steemWif),
    hive: !!(account && hiveWif),
    tron: !!(envKey("TRON_PRIVATE_KEY") || steemWif),
    blurt: !!envKey("BLURT_ACTIVE_WIF"),
    eth: !!envKey("ETH_PRIVATE_KEY"),
    sol: !!envKey("SOL_PRIVATE_KEY"),
    account,
  };
}

async function bs58lib(): Promise<{ decode(s: string): Uint8Array; encode(b: Uint8Array): string }> {
  const m = (await import("bs58")) as unknown as { default: { decode(s: string): Uint8Array; encode(b: Uint8Array): string } };
  return m.default;
}

/* ── זהות-TRON מהסקלר (פלט-ציבורי בלבד) ── */
async function tronIdentity(wif: string): Promise<string | null> {
  try {
    const [{ secp256k1 }, { keccak_256 }, b58] = await Promise.all([
      import("@noble/curves/secp256k1"),
      import("@noble/hashes/sha3"),
      bs58lib(),
    ]);
    const raw = Buffer.from(b58.decode(wif));
    const data = raw.subarray(0, raw.length - 4);
    const priv = data.subarray(1, 33);
    const pub65 = Buffer.from(secp256k1.getPublicKey(priv, false));
    const h = keccak_256(pub65.subarray(1));
    const payload = Buffer.concat([Buffer.from([0x41]), Buffer.from(h.subarray(12))]);
    const sh1 = createHash("sha256").update(payload).digest();
    const chk = createHash("sha256").update(sh1).digest().subarray(0, 4);
    return b58.encode(Buffer.concat([payload, chk]));
  } catch {
    return null;
  }
}

/* scalarOf — עבר ל-signer.ts (M2) כ-deriveScalar */

/* FIX(F-8 · EXEC-CD-35): זהות-TRON ממפתח-hex-טהור (זהות-הכספת-הריבונית) —
 * אותה-נגזרת בדיוק (secp256k1→keccak→0x41→base58check) על סקלר מהקס. */
async function tronIdentityFromHex(hexPriv: string): Promise<string | null> {
  try {
    const [{ secp256k1 }, { keccak_256 }, b58] = await Promise.all([
      import("@noble/curves/secp256k1"),
      import("@noble/hashes/sha3"),
      bs58lib(),
    ]);
    const priv = Buffer.from(hexPriv, "hex");
    const pub65 = Buffer.from(secp256k1.getPublicKey(priv, false));
    const h = keccak_256(pub65.subarray(1));
    const payload = Buffer.concat([Buffer.from([0x41]), Buffer.from(h.subarray(12))]);
    const sh1 = createHash("sha256").update(payload).digest();
    const chk = createHash("sha256").update(sh1).digest().subarray(0, 4);
    return b58.encode(Buffer.concat([payload, chk]));
  } catch {
    return null;
  }
}

/* ── JSON-RPC ── */
async function rpc<T>(endpoint: string, body: unknown, timeoutMs = 20000): Promise<T> {
  // FIX(SETTLE-11): גדר-ריבונית — שער-לא-מקובע = חסימה fail-closed · FIX(Roast-65-b · H2): דרך-fencedFetch (redirect:error)
  // FIX(Roast-74 · מדוד-חי): Cloudflare מציב אתגר-HTML מול-סוכן-המשתמש-הדיפולטי-של-undici —
  // סוכן-משתמש-מפורש פותר (rpc.blurt.blog; בדיקה: curl/bun עוברים, undici-ללא-UA מקבל <html>).
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fencedFetch(endpoint, "relay.rpc", { method: "POST", headers: { "Content-Type": "application/json", "user-agent": "saos-dex-rail/1.0 (+sovereign-dex)" }, body: JSON.stringify(body), signal: ctrl.signal });
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message || "rpc error");
    return json.result as T;
  } finally {
    clearTimeout(t);
  }
}

async function dgp(endpoint: string) {
  return rpc<{ head_block_number: number; head_block_id: string; time: string }>(endpoint, {
    jsonrpc: "2.0", method: "condenser_api.get_dynamic_global_properties", params: [], id: 1,
  });
}

export async function rcMana(endpoint: string, account: string): Promise<number | null> {
  try {
    const r = await rpc<{ rc_accounts: { rc_manabar: { current_mana: string; last_update_time: number }; max_rc: string }[] }>(endpoint, {
      jsonrpc: "2.0", method: "rc_api.find_rc_accounts", params: { accounts: [account] }, id: 1,
    }, 12000);
    const a = r.rc_accounts?.[0];
    if (!a) return 0;
    // FIX(CROSS-F-05, saos-jummper מדוד-mainnet): rc_manabar.current_mana הוא-תמונת-מצב
    // מאז-last_update_time — לא-יתרה. קריאה-ישירה דיווחה 1.39M מול-אפקטיבי 73.3M
    // (52.6x-חסר) והשער-סגר-עיגון-חינם-בשקר ("דורש-הון"). הקרנה-קנונית:
    // effective = min(max_rc, current + (max_rc/432000) * (now − last_update_time))
    const cur = Number(a.rc_manabar?.current_mana) || 0;
    const max = Number(a.max_rc) || 0;
    const last = Number(a.rc_manabar?.last_update_time) || 0;
    const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - last);
    return Math.min(max, cur + (max / 432000) * elapsed);
  } catch {
    return null; // צומת-לא זמין — לא חוסם (שער רק כשיש מדידה)
  }
}

/* ── op טרי לכל שידור (signTransaction מוטט את האובייקט — מורשת anchor.cjs) ──
 * ROTATION ENGINE (Task 3-a): מיוצא-גם-ל-fleet.ts (חתימת-חיילים על blurt עם אותו-op-קנוני). */
export function buildOp(account: string, payload: unknown, auth: "posting" | "active"): [string, Record<string, unknown>] {
  return ["custom_json", {
    // FIX(CROSS-F-01): POSTING כשיש-מפתח-פרסום — יכולת-העברת-כספים מוסרת-מהשידור-האוטומטי
    required_auths: auth === "active" ? [account] : [],
    required_posting_auths: auth === "posting" ? [account] : [],
    id: ANCHOR_ID,
    json: JSON.stringify(payload),
  }];
}

/* ── שידור-גרפני אחיד: build ← sign(chain_id) ← broadcast_transaction_synchronous ──
 * SETTLE-13: מיוצא-למודול-הצי (fleet.ts) — נתיב-חתימה-אחד-מוסדי.
 * Roast-73: הוכלל — grapheneOpsBroadcast מקבל מערך-ops מלא (custom_json עם-id
 * נגזר, transfer_to_vesting, transfer…) ו-grapheneSealBroadcast הוא-עטיפה-דקה
 * על-המסילה-הזאת עם ה-op-הקנוני של העיגון. אותו-מנוע, אפס-שכפול-חתימה. */
export type GrapheneOp = [string, Record<string, unknown>];

export async function grapheneOpsBroadcast(
  node: string, chainId: string, account: string, ops: GrapheneOp[], wif: string,
  _auth: "posting" | "active",
) {
  void _auth; // הסמכות נקבעת-בתוך ה-ops עצמם (required_auths/required_posting_auths)
  if (ops.length === 0 || ops.length > 4) throw new Error("grapheneOpsBroadcast: 1..4 ops only (fail-closed)");
  const d = await dgp(node);
  const tx: GrapheneTx = {
    ref_block_num: d.head_block_number & 0xffff,
    ref_block_prefix: Buffer.from(d.head_block_id, "hex").readUInt32LE(4),
    expiration: new Date(new Date(d.time + "Z").getTime() + 60000).toISOString().slice(0, 19),
    operations: ops,
    extensions: [],
  };
  // M2: החתימה בתוך מודול-ה-Signer — ה-executor בונה tx ומשדר את-החתום (אפס-שינוי סמנטיקה)
  const signed = signGrapheneTx(tx, chainId, wif);
  const res = await rpc<{ id?: string; block_num?: number }>(node, {
    jsonrpc: "2.0", method: "condenser_api.broadcast_transaction_synchronous", params: [{ ...signed }], id: 1,
  });
  if (res && res.id) return { txid: res.id, block: res.block_num ?? null, confirmed: true };
  throw new Error("sync-broadcast answered without id (honest)");
}

export async function grapheneSealBroadcast(node: string, chainId: string, account: string, payload: unknown, wif: string, auth: "posting" | "active") {
  return grapheneOpsBroadcast(node, chainId, account, [buildOp(account, payload, auth)], wif, auth);
}

/* ── Roast-82: BLURT — SDK-הרשמי (@beblurt/dblurt) בלבד ──
 * נמדד-חי: steem-js חותם-טקס-תקני-לכאורה (פאב-נגזר-תואם-BLT5HhJD…, חתימה-65B,
 * chain_id-מאומת-מול-get_config) והשרשרת דוחה "tx_missing_active_auth" — בעוד
 * ה-SDK-הרשמי משדר-מיד-ומאומת. פער-סריאליזציה/חתימה-שקט-בין-הספריות — הנתיב-הקנוני-של-BLURT-הוא-הפתרון.
 * client-singleton על-הצומת-הקנוני (BLURT_NODES[0]) — עבר ל-signer.ts (M2). ה-op-נבנה-דרך-buildOp (אותו-ANCHOR_ID-קנוני). */
async function blurtSealBroadcast(account: string, payload: unknown, wif: string): Promise<{ txid: string }> {
  // M2: חתימה+שידור-BLURT בתוך ה-Signer (SDK-הרשמי — Roast-82 · client-singleton שם)
  return signAndSendBlurt(BLURT_NODES[0], account, [buildOp(account, payload, "active")], wif);
}

/* ── TRON: עיגון מותנה-מימון (transfer 1 sun + extra_data = stateRoot) ──
 * FIX(F-9 · EXEC-CD-35): יעד-העברת-העיגון = זהות-צי ידועה-שלנו (רשימה-לבנה —
 * אותה-רשימה של tron-self-anchor.ts R21); TRON אוסר-transfer-עצמי (נמדד-חי). */
const TRON_ANCHOR_TARGET = "TYVwwuvdDmfy3shxT3cb3RKLrRCshaZxTy";
async function tronSealBroadcast(tronAddress: string, stateRoot: string, keyMaterial: string): Promise<{ txid: string }> {
  // M2: חתימת-TRON בתוך ה-Signer — הודעות-השגיאה-הכנות נשמרו מילה-במילה (classifier תלוי-בהן)
  // FIX(F-8): keyMaterial = WIF-גרפני או hex-טהור (זהות-הכספת) — ה-Signer מבחין-לפי-צורה
  return signAndSendTron(TRON_RPC, tronAddress, stateRoot, keyMaterial, TRON_ANCHOR_TARGET);
}

/* ══ verifyOnChain — קריאה-חוזרת מה-RPC הציבורי והשוואת stateRoot ════════════
 * SECURITY INTENT: זו עמוד-התווך של אמון-אפס בעצמנו — כל-txid שה-Relay שידר
 * נקרא חזרה מתשתית-ציבורית בלתי-תלויה, ומושווה ביט-מול-ביט מול-המקומי.
 * אי-התאמה = עדות לשחיתות-מצב, עדכון-מטעה או פגיעה-חתימה — ולכן היא נחסמת
 * מלהיחשב "מאומת", נרשמת כ-mismatch במדדים ומדליקה ALERT מיידי ללוג.
 * Steem/Hive: condenser_api.get_transaction(txid) → custom_json(ANCHOR_ID) →
 *             השוואת height+stateRoot מול-החותם המקומי.
 * TRON:       gettransactioninfobyid (אישור-בלוק) + gettransactionbyid
 *             (extra_data מכיל את ה-digest).
 * תשובה: { ok, detail } — ok=false עם detail="not indexed" = נסיון-חוזר מותר
 * (ואינו מיסמאץ' — הרשומה נשארת null ונכנסת לתור-הפיוס).
 */
export async function verifyOnChain(
  chain: ChainName,
  txid: string,
  expected: { height: number; stateRoot: string; account?: string }
): Promise<{ ok: boolean; detail: string }> {
  // chaos-gate: מחיצה-מוזרקת מדמה ניתוק-RPC מלא — גם על נתיב-הקריאה (אמת-היקף-התקלה)
  if (chaosPartitioned(chain)) return { ok: false, detail: "not indexed: injected network partition (chaos)" };
  if (chain === "eth") {
    return verifyEthAnchor(txid, expected, rtInit().ethAddress);
  }
  if (chain === "sol") {
    return verifySolAnchor(txid, expected, rtInit().solAddress);
  }
  if (chain === "tron") {
    const info = await rpc<{ blockNumber?: number; receipt?: { status?: string } }>(
      `${TRON_RPC}/wallet/gettransactioninfobyid`, { value: txid, visible: true }, 15000,
    ).catch(() => null);
    if (!info?.blockNumber) return { ok: false, detail: "not indexed: tron tx awaiting block" };
    const tx = await rpc<{ raw_data?: { extra_data?: string[]; contract?: { parameter?: { value?: { owner_address?: string } } }[] } }>(
      `${TRON_RPC}/wallet/gettransactionbyid`, { value: txid, visible: true }, 15000,
    ).catch(() => null);
    const extra = tx?.raw_data?.extra_data?.[0];
    // FIX(Roast-64-c · F5): "extra_data not surfaced" קיבל ok:true — עיגון-TRON נרשם
    // "verified" בלי-שום-קריאת-חזרה-של-ה-payload (סתירה-ל-SECURITY INTENT). עתה:
    // בלי-payload-גלוי = ok:false "payload-not-surfaced" — הרשומה נשארת-לא-מאומתת
    // (לעולם לא מזויף-מאומת), ונכנסת-לתור-הפיוס.
    if (!extra) return { ok: false, detail: `payload-not-surfaced: confirmed in block ${info.blockNumber} but node hides extra_data — record stays unverified (fail-closed)` };
    // FIX(R15-c · anchor-identity-binding): היה — extra_data בלבד. ה-stateRoot פומבי
    // וכל-אדם יכול createtransaction עם אותו-extra_data לכתובת-שלו (~1-sun) — והיה
    // נספר כעוגן-מאומת. עתה: owner_address חייב-להיות זהות-ה-TRON-הריבונית.
    // (visible=true → הצומת מחזיר כתובות-base58 — נמדד-חי — ההשוואה בצורה-זו.)
    const tronId = rtInit().tronAddress;
    if (tronId) {
      const owner = tx?.raw_data?.contract?.[0]?.parameter?.value?.owner_address;
      if (!owner || owner.toLowerCase() !== String(tronId).toLowerCase()) {
        return { ok: false, detail: "mismatch: not-our-anchor — owner_address is not the sovereign identity (fail-closed)" };
      }
    }
    // FIX(Roast-64-c · F5): השוואה מתוחמת-ופורשת — פענוח-ה-payload והשוואת-שוויון
    // מדויק מול-ה-stateRoot (ביט-מול-ביט), לא-substring על-הגולם.
    const payload = Buffer.from(extra, "hex").toString("utf8").trim();
    if (payload === expected.stateRoot) return { ok: true, detail: `confirmed in block ${info.blockNumber} · extra_data stateRoot match (exact)` };
    return { ok: false, detail: `mismatch: extra_data payload (${payload.slice(0, 12)}…) != local stateRoot ${expected.stateRoot.slice(0, 12)}…` };
  }

  const nodes = chain === "steem" ? STEEM_NODES : chain === "blurt" ? BLURT_NODES : HIVE_NODES;
  for (const node of nodes) {
    const tx = await rpc<{ operations?: unknown[] }>(node, {
      jsonrpc: "2.0", method: "condenser_api.get_transaction", params: [txid], id: 1,
    }, 15000).catch(() => null);
    if (!tx || !Array.isArray(tx.operations)) continue;
    for (const entry of tx.operations as [string, Record<string, unknown>][]) {
      const [opName, opBody] = entry;
      if (opName !== "custom_json" || opBody?.id !== ANCHOR_ID) continue;
      // FIX(Roast-64-c · F6): אימות-מחבר — ה-op-חייב לשאת את החשבון-שלנו ב-required_auths
      // או ב-required_posting_auths. צד-ג' יכול-לפרסם custom_json זהה-עם אותו-ANCHOR_ID
      // — בלי-בדיקת-רשות זה היה נספר-כ"מאומת". אין-חשבון-צפוי (לא-הוגדר) → לא-ניתן-לקשור → ok:false.
      const expectedAccount = expected.account ?? null;
      if (!expectedAccount) return { ok: false, detail: "mismatch: anchor account unknown — authority binding unverifiable (fail-closed)" };
      const auths = [
        ...((opBody.required_auths as unknown[] | undefined) ?? []),
        ...((opBody.required_posting_auths as unknown[] | undefined) ?? []),
      ].map((x) => String(x).toLowerCase());
      if (!auths.includes(expectedAccount.toLowerCase())) {
        return { ok: false, detail: `mismatch: custom_json not authorized by ${expectedAccount} (third-party anchor refused)` };
      }
      let parsed: { height?: number; stateRoot?: string };
      try { parsed = JSON.parse(String(opBody.json)) as { height?: number; stateRoot?: string }; }
      catch { return { ok: false, detail: "mismatch: on-chain custom_json unparseable" }; }
      const rootOk = parsed.stateRoot === expected.stateRoot;
      const heightOk = parsed.height === expected.height;
      if (rootOk && heightOk) return { ok: true, detail: `stateRoot verified on ${chain} via ${new URL(node).host}` };
      return {
        ok: false,
        detail: `mismatch: on-chain h${parsed.height ?? "?"}/${String(parsed.stateRoot ?? "?").slice(0, 12)}… vs local h${expected.height}/${expected.stateRoot.slice(0, 12)}…`,
      };
    }
    return { ok: false, detail: `mismatch: tx found but no ${ANCHOR_ID} op inside` };
  }
  return { ok: false, detail: "not indexed: no node returned the transaction yet" };
}

/* ── Circuit breaker ── */
function mkBreaker(): BreakerView { return { state: "closed", failures: 0, openedAt: null, trips: 0 }; }

function breakerAllows(b: BreakerView): boolean {
  if (b.state === "closed") return true;
  if (b.state === "open") {
    if (b.openedAt !== null && Date.now() - b.openedAt >= BREAKER_COOLDOWN_MS) {
      b.state = "half-open"; // פרובה-יחידה תיכף
      return true;
    }
    return false;
  }
  return true; // half-open — מתיר ניסיון-בדיקה (התור טורי, אין-סערת-פרובות)
}

function breakerOnSuccess(b: BreakerView): void {
  b.failures = 0;
  b.openedAt = null;
  b.state = "closed";
}

function breakerOnFailure(rt: RelayRT, chain: ChainName): void {
  const b = rt.chainState[chain].breaker;
  b.failures += 1;
  if (b.state === "half-open" || b.failures >= BREAKER_THRESHOLD) {
    if (b.state !== "open") {
      b.trips += 1;
      rt.metrics.breakerTrips += 1; // מדד-גלובלי — חייב לנוע עם-הפסקה (נקודת-תצפית מוסדית)
    }
    b.state = "open";
    b.openedAt = Date.now();
    // ALERT — מוסדי: פתיחת-breaker היא אירוע-רעש-גבוה
    console.error(`[saos-relay][ALERT] circuit-breaker OPEN on ${chain} · ${b.failures} consecutive hard failures · probe in ${BREAKER_COOLDOWN_MS / 60_000}min`);
  }
}

/* ── backoff אקספוננציאלי עם jitter (±20%) ── */
function backoffMs(attempt: number): number {
  const base = Math.min(20_000 * Math.pow(2, attempt - 1), 15 * 60_000);
  return Math.floor(base * (0.8 + Math.random() * 0.4));
}

/* FIX(CROSS-F-04): host-מקורת לכל-שרשרת — עדות-רשת גם-לפני-השידור-הראשון.
 * ETH/SOL מה-env (עם-ברירות-המחדל המיושרות ל-verify) · TRON קבוע · hive/steem
 * ה-node המועדף. היה-פה שער-לא-מוכרז = פנקס-עיגון שאינו-יכול להעיד על-רשת. */
function hostOf(u: string | undefined): string | null {
  if (!u) return null;
  try { return new URL(u).host; } catch { return null; }
}
function configuredHost(chain: ChainName): string | null {
  if (chain === "tron") return hostOf(TRON_RPC);
  if (chain === "eth") return hostOf(process.env.ETH_RPC_URL ?? ETH_RPCS[0]); // FIX(SETTLE-11): fallback = ברירת-המחדל האמתית (הישנה הייתה-שער-לא-מקובע)
  if (chain === "sol") return hostOf(process.env.SOL_RPC_URL ?? "https://api.mainnet-beta.solana.com");
  return hostOf((chain === "steem" ? STEEM_NODES : chain === "blurt" ? BLURT_NODES : HIVE_NODES)[0]);
}

/* ── רישום-ציבורי (state/anchors.json — הוכחות בלבד, אפס סודות) ── */
function upsertRecord(rt: RelayRT, rec: AnchorRecord): void {
  const i = rt.records.findIndex((r) => r.chain === rec.chain && r.height === rec.height && r.at === rec.at);
  if (i >= 0) rt.records[i] = { ...rt.records[i], ...rec };
  else rt.records.unshift(rec);
  rt.records = rt.records.slice(0, 60);
}

/* ── SETTLE-17: סגירת-פער-הכנות — עיגוני-צי-ידניים/אבני-דרך-P&L נרשמים-בפנקס ──
 * ההיסטוריה: 3-עיגוני-SETTLE-13-החיים (h8424/wic · h8436/haran · h8508/wog —
 * txid-אמת-על-Hive) מעולם-לא-נרשמו-בפנקס-הציבורי-כי-נתיב-ה-route-עקף-את-rt.records.
 * עתה: כל-עיגון-צי-מוצלח (ידני-או-אוטומטי-מ-milestone.ts) נרשם-כ-anchored,
 * נשמר-בדיסק, ונכנס-לפיוס-האוטומטי (קריאה-חוזרת-get_transaction-מאמתת-על-Hive). */
export function recordFleetAnchor(
  height: number, stateRoot: string, digest: string, txid: string, account: string,
): void {
  const rt = rtInit();
  const rec: AnchorRecord = {
    // EPOCH-PATCH-SPEC: עיגוני-צי-ידניים מגיעים-מחוץ-למונה-האוטומטי — נושאים-את-ה-epoch-החי-של-הגובה
    chain: "fleet", epoch: assignEpoch(height), height, stateRoot, digest, txid, status: "anchored",
    at: new Date().toISOString(), attempt: 1, account,
    verified: null, verifiedAt: null,
  };
  upsertRecord(rt, rec);
  rt.chainState.fleet.endpointHost = rt.chainState.fleet.endpointHost ?? hostOf(HIVE_NODES[0]);
  persist(rt);
  scheduleVerification(rt, rec);
}

function persist(rt: RelayRT): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    /* FIX(Roast-74): עדות-עיגון-מאומתת-אחרונה — מצביע-בר-קיימא לביקורת/כאוס.
     * anchors.json מתחלף (pending-רעננים דוחפים החוצה confirmed) ומותיר-את-חדר-הבדיקה
     * בלי-וקטור-קריאה-חוזרת; last-anchor.json שומר-את-העיגון-האמת-האחרון-שהתקבל. */
    try {
      const la = [...rt.records].find((r) => r.status === "anchored" && typeof r.txid === "string" && r.txid.length >= 40 && typeof r.stateRoot === "string" && r.stateRoot.length === 64);
      if (la) fs.writeFileSync(path.join(STATE_DIR, "last-anchor.json"), JSON.stringify({ chain: la.chain, txid: la.txid, height: la.height, stateRoot: la.stateRoot, account: la.account ?? rt.account, at: la.at }, null, 1) + "\n");
    } catch { /* כתיבה-נכשלה — העדות-עדיין-ב-anchors.json ועל-השרשרת */ }
    const chainOut = (ALL_CHAINS as ChainName[]).map((c) => {
      const last = rt.records.find((r) => r.chain === c);
      const anchored = rt.records.find((r) => r.chain === c && r.status === "anchored");
      const EXPLORER: Record<ChainName, (id: string) => string> = {
        steem: (id) => `https://steemworld.org/tx/${id}`,
        hive: (id) => `https://hiveblocks.com/tx/${id}`,
        blurt: (id) => `https://blocks.blurt.world/tx/${id}`,
        tron: (id) => `https://tronscan.org/#/transaction/${id}`,
        eth: (id) => `https://etherscan.io/tx/${id}`,
        sol: (id) => `https://solscan.io/tx/${id}`,
        // SETTLE-13: עיגוני-הצי נוחתים-על-Hive — אותו-סקר-ציבורי
        fleet: (id) => `https://hiveblocks.com/tx/${id}`,
      };
      const link = anchored?.txid ? EXPLORER[c](anchored.txid) : null;
      return [c, {
        status: rt.chainState[c].status,
        // כשאין-txid והחוסם-הוא-מימון — הסטטוס-הכן "pending funding (armed)"
        pendingFunding: rt.chainState[c].enabled && /unfunded/i.test(rt.chainState[c].lastError ?? ""),
        account: c === "steem" ? rt.account : c === "eth" ? rt.ethAddress : c === "sol" ? rt.solAddress : (((process.env.HIVE_ANCHOR_ACCOUNT || process.env.SAOS_RELAY_AGENT_ACCOUNT || "") as string).toLowerCase().trim() || rt.account),
        lastTxid: last?.txid ?? null,
        lastHeight: last?.height ?? null,
        lastAt: last?.at ?? null,
        lastAnchoredTxid: anchored?.txid ?? null,
        anchored: rt.chainState[c].anchored,
        verified: rt.chainState[c].verified,
        mismatches: rt.chainState[c].mismatches,
        // FIX(CROSS-F-04): איזו רשת/שער — עדות-גלויה בפנקס הציבורי
        endpointHost: rt.chainState[c].endpointHost ?? configuredHost(c),
        breaker: rt.chainState[c].breaker,
        explorer: link,
        lastError: rt.chainState[c].lastError,
        lastVerifyError: rt.chainState[c].lastVerifyError,
      }];
    });
    const out = {
      updatedAt: new Date().toISOString(),
      anchorId: ANCHOR_ID,
      account: rt.account,
      tronIdentity: rt.tronAddress,
      chains: Object.fromEntries(chainOut),
      totals: {
        anchored: (ALL_CHAINS as ChainName[]).reduce((a, c) => a + rt.chainState[c].anchored, 0),
        verified: rt.metrics.verified,
        mismatches: rt.metrics.mismatches,
        records: rt.records.length,
      },
      records: rt.records.slice(0, 30),
      // FIX(P0-5): כוונות-EIP-191 נשמרות-לדיסק — בלי-זה החתימות היו-זיכרון-בלבד
      // ואבדו-בכל-הפעלה-מחדש (החסרון-היחיד שנותר מה-SETTLE-7 P0)
      ethIntents: rt.ethIntents,
    };
    const tmp = ANCHORS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n");
    fs.renameSync(tmp, ANCHORS_FILE);
  } catch { /* כשל-כתיבה לא מפיל את ה-Relay */ }
}

/* ── אימות-בדיעבד של-txid יחיד (מעדכן רשומה+מדדים; לא-חוסם, לא-זורק) ── */
async function verifyRecord(rt: RelayRT, rec: AnchorRecord): Promise<void> {
  if (!rec.txid) return;
  const t0 = Date.now();
  let last = { ok: false, detail: "unverified" };
  for (let i = 0; i < VERIFY_TRIES; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, VERIFY_GAP_MS));
    try {
      // FIX(Roast-64-c · F6): חשבון-הרשות הצפוי מוזרם לאימות-המחבר —
      // צי (fleet) = החייל-שחתם (rec.account) · steem = rt.account · hive/fleet = HIVE_ANCHOR_ACCOUNT.
      const expectedAccount = rec.account
        ?? (rec.chain === "steem" ? rt.account : ((process.env.HIVE_ANCHOR_ACCOUNT || "").toLowerCase().trim() || rt.account));
      last = await verifyOnChain(rec.chain, rec.txid, { height: rec.height, stateRoot: rec.stateRoot, account: expectedAccount ?? undefined });
    } catch (e) {
      last = { ok: false, detail: String((e as Error)?.message || e).slice(0, 120) };
    }
    if (last.ok || !last.detail.startsWith("not indexed")) break;
  }
  rec.verifiedAt = new Date().toISOString();
  rt.metrics.lastVerifyLatencyMs = Date.now() - t0;
  // FIX(Roast-63): "awaiting finalized block" של-SOL אינו מיסמאץ' — זה-טרם-אינדוקס
  // (Solana מאשרת-confirmed תוך-שניות אך finalized רק-אחרי-~32-סלוטים). היה-נספר
  // כ-mismatch → אזעקת-שווא-קבועה (68-רשומות-אמת סומנו-זיוף) ו-realMoney.ok לא-יכול-היה-להתאמת.
  const indexed = !last.detail.startsWith("not indexed") && !last.detail.startsWith("awaiting finalized block");
  // "טרם-נוכח באינדקס" אינו מיסמאץ' — הרשומה נשארת null ונכנסת לתור-הפיוס (reconcile)
  // FIX(SETTLE-13, מחלקה-roshpina-forensic בזמן-ריצה): ספירה-על-מעברים-בלבד —
  // אימות-חוזר-של-רשומה-כבר-מאומתת לא-מנפח את המדדים (verified ≤ anchored מבנית).
  const prevVerified = rec.verified;
  rec.verified = indexed ? last.ok : null;
  if (!indexed) rec.verifiedAt = null;
  if (rec.verified === true) {
    rt.chainState[rec.chain].lastVerifyError = null;
    if (prevVerified !== true) {
      rt.metrics.verified += 1;
      rt.chainState[rec.chain].verified += 1;
    }
  } else {
    if (rec.verified === false) {
      if (prevVerified === true) { // מהפכה: מאומת→מיסמאץ' — מתקנים-את-שני-המדדים
        rt.metrics.verified -= 1;
        rt.chainState[rec.chain].verified -= 1;
      }
      if (prevVerified !== false) {
        rt.metrics.mismatches += 1;
        rt.chainState[rec.chain].mismatches += 1;
      }
      rt.chainState[rec.chain].lastVerifyError = last.detail;
      rec.error = last.detail.slice(0, 180); // הרשומה נושאת-את-הפירוט (ראיה-ציבורית)
      // ALERT — אי-התאמה בין השרשרת-הציבורית למקומי הוא אירוע-חמור
      console.error(`[saos-relay][ALERT] ${rec.chain} h${rec.height} stateRoot verification FAILED · ${last.detail}`);
    }
  }
  upsertRecord(rt, rec);
  persist(rt);
}

function scheduleVerification(rt: RelayRT, rec: AnchorRecord): void {
  void (async () => {
    await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
    try { await verifyRecord(rt, rec); } catch { /* לא-חוסם */ }
  })();
}

/* ── Reconciliation: פיוס-תקופתי — כל-עיגון ששודר וטרם-אומת עובר קריאה-חוזרת ── */
function startReconciler(rt: RelayRT): void {
  if (rt.reconcileStarted) return;
  rt.reconcileStarted = true;
  const loop = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, RECONCILE_FIRST_MS)); // מחזור-ראשון מהיר — ריפוי-שאריות מיד
    try {
      const due = rt.records.filter((r) => r.status === "anchored" && r.verified === null && r.txid).slice(0, RECONCILE_BATCH);
      for (const rec of due) {
        try { await verifyRecord(rt, rec); } catch { /* לא-חוסם */ }
      }
    } finally {
      void loop();
    }
  };
  void loop();
}

/* ── עיבוד-תור (לא-חוסם; breaker + backoff-עם-jitter; מצב per-chain) ── */
/* ── FIX(SETTLE-11) טיסה-מקדימה של רשויות: המפתח-ב-.env חייב-להיות רשות-חיה על-השרשרת ──
 * ההיסטוריה: מפתחות-פגומים-ב-.env (בליעת-פלט-כלים — תופעה-מתועדת §15) גרמו לדחיות
 * "Missing Posting Authority" בכל-חותם → breaker-פתוח-בשווא + רעש. עתה: גזירת-מפתח-ציבורי
 * מקומית + השוואה מול-רשות-החשבון ב-RPC ציבורי — אי-התאמה = השבתה-כנה fail-closed.
 * אין-מדידה (צומת-לא-זמין) = לא-חוסם — נבדק-בשידור (אותו-עיקרון rcMana). */
/* FIX(Roast-64-c · F9): authorityOk היה fail-open (catch → true) ו-cache-לנצח
 * (authChecked נקרא-פעם-אחת). עתה: cache עם-TTL-של-10-דקות · כשל-רשת-חד-פעמי
 * = שומר-על-פסק-הדין-הקודם-בלבד (מתועד lastError, לא-נטען-כ"טרי") · ≥3-כשלי-רשת
 * רצופים = fail-CLOSED עד-בדיקה-מוצלחת. */
const AUTH_TTL_MS = 10 * 60_000;
const AUTH_NETFAIL_MAX = 3;
interface AuthCacheEntry { verdict: boolean; at: number; netFails: number; lastError: string | null }
const authChecked = new Map<"steem" | "hive" | "blurt", AuthCacheEntry>();
async function authorityOk(rt: RelayRT, keys: RelayKeys, chain: "steem" | "hive" | "blurt"): Promise<boolean> {
  const prev = authChecked.get(chain);
  // פסק-דין-מוצלח-טרי (בלי-שגיאה) — בתוקף-TTL
  if (prev && prev.lastError === null && Date.now() - prev.at < AUTH_TTL_MS) return prev.verdict;
  try {
    const node = chain === "steem" ? STEEM_NODES[0] : chain === "blurt" ? BLURT_NODES[0] : HIVE_NODES[0];
    const account = chain === "hive" ? keys.hiveAccount : keys.account;
    // Roast-73 · FIX(steem-disable-root-cause): היה — WIF-אחד-קבוע (posting||active) מול
    // key_auths[0]-בלבד → מפתח-פרסום-שפג-תוקפו השבית-את-שרשרת-שלמה fail-closed-לנצח
    // ("authority-mismatch … disabled"). עתה: בחירת-חותם-חיה — לכל-מועמד (posting
    // קודם — הרשאה-הפחותה; אחר-כך active) נבדקת-הסמכות-החיה-מול-כל-רשימת-המפתחות,
    // והזוג-WIF+auth-המנצח נכתב-בחזרה-ל-keys (self-heal). אף-מועמד-לא-מאומת →
    // fail-closed-כנה (בדיוק-כמו-קודם, אבל-בלי-לקבור-חותם-חי).
    const r = await rpc<{ posting: { key_auths: [string, number][] }; active: { key_auths: [string, number][] } }[]>(node, {
      jsonrpc: "2.0", method: "condenser_api.get_accounts", params: [[account]], id: 1,
    }, 12000);
    const a = r?.[0];
    const pubs = (arr?: [string, number][]): string[] => (arr ?? []).map((k) => k[0]);
    const postingPubs = pubs(a?.posting?.key_auths);
    const activePubs = pubs(a?.active?.key_auths);
    const candidates: { wif: string; auth: "posting" | "active"; pub: string | null }[] = [];
    // Roast-82: BLURT — אין-מפתח-פרסום-בכספת (רק-active), לכן postWif=ריק ו-actWif=BLURT_ACTIVE_WIF
    // FIX(prefix): גזירת-פאב-עם-קידומת-BLT-כשמדובר-ב-BLURT (ההשוואה-מול-key_auths-על-השרשרת)
    const blurtPfx = chain === "blurt";
    const chainPrefix: "STM" | "BLT" = blurtPfx ? "BLT" : "STM";
    const postWif = chain === "steem" ? envKey("STEEM_POSTING_WIF") : chain === "hive" ? envKey("HIVE_POSTING_WIF") : "";
    const actWif = chain === "steem" ? envKey("STEEM_ACTIVE_WIF") : chain === "hive" ? envKey("HIVE_ACTIVE_WIF") : envKey("BLURT_ACTIVE_WIF");
    // FIX(R13 · wif-forms): כל-מקור-מפתח נבדק בשתי-הצורות — המנורמלת 5K קודם
    // (המתמטיקה-הנכונה, מול-רישום-תקין) ואחר-כך הגולמית (הספרייה מזיזה K/L-דחוס
    // לסקלר-שגוי-שקט: k·256+1 — תקין-מול-שרשרת-שנרשמה בדור-הפגום).
    // המנצח קובע גם את-צורת-החתימה (self-heal למטה).
    const normOf = chain === "steem" ? keys.steemWifNorm : chain === "hive" ? keys.hiveWifNorm : keys.blurtWifNorm;
    // FIX(R14-a · dual-form-every-source): היה — normOf אחת (של המקור-הנבחר post||active);
    // כששני-המפתחות קיימים (posting+active) ה-active מעולם-לא נבדק בצורתו-המנורמלת.
    // עתה: כל-מקור נבדק בשתי-הצורות שלו (מנורמל קודם), בדיוק-כמו-ההבטחה ב-R13.
    const seen = new Set<string>();
    const pairs: Array<[string, "posting" | "active"]> = [];
    const pushPair = (wif: string, auth: "posting" | "active") => {
      if (!wif) return;
      const k = `${auth}\x00${wif}`;
      if (seen.has(k)) return;
      seen.add(k);
      pairs.push([wif, auth]);
    };
    if (postWif) pushPair((await wifNormalized(postWif)) ?? "", "posting");
    if (actWif) pushPair((await wifNormalized(actWif)) ?? "", "active");
    if (normOf) {
      if (chain !== "blurt") pushPair(normOf, "posting");
      pushPair(normOf, "active");
    }
    if (postWif) pushPair(postWif, "posting");
    if (actWif) pushPair(actWif, "active");
    for (const [wif, auth] of pairs) {
      try { candidates.push({ wif, auth, pub: pubOfWif(wif, chainPrefix) }); } catch { /* skip */ }
    }
    let chosen: { wif: string; auth: "posting" | "active"; pub: string | null } | null = null;
    for (const c of candidates) {
      if (!c.pub) continue;
      const okNow = c.auth === "posting" ? postingPubs.includes(c.pub) : activePubs.includes(c.pub);
      if (okNow) { chosen = c; break; }
    }
    if (!chosen) {
      authChecked.set(chain, { verdict: false, at: Date.now(), netFails: 0, lastError: null });
      console.error(`[saos-relay][ALERT] authority-mismatch on ${chain}: אף-מפתח-ב-.env אינו רשות-חיה של ${account} (posting גם active נבדקו) — disabled fail-closed (נדרשת רוטציה/ייבוא-מפתח-נכון)`);
      return false;
    }
    // self-heal: הזוג-המנצח נכתב-בחזרה — השידור יחתום עליו עם הסמכות-החיה
    if (chain === "steem") { keys.steemWif = chosen.wif; keys.steemAuth = chosen.auth; keys.steemPub = chosen.pub; }
    else if (chain === "hive") { keys.hiveWif = chosen.wif; keys.hiveAuth = chosen.auth; keys.hivePub = chosen.pub; }
    else { keys.blurtWif = chosen.wif; keys.blurtPub = chosen.pub; }
    authChecked.set(chain, { verdict: true, at: Date.now(), netFails: 0, lastError: null });
    return true;
  } catch (e) {
    const netFails = (prev?.netFails ?? 0) + 1;
    const lastError = String((e as Error)?.message ?? e).slice(0, 120);
    if (netFails >= AUTH_NETFAIL_MAX) {
      // ≥3-כשלי-רשת-רצופים → סגירה fail-closed עד-אימות-מוצלח (לא-עוד-fail-open-נצחי)
      authChecked.set(chain, { verdict: false, at: Date.now(), netFails, lastError });
      console.error(`[saos-relay][ALERT] authority-check unreachable ×${netFails} on ${chain} — fail-closed until successful re-check (${lastError})`);
      return false;
    }
    // שגיאה-חד-פעמית: שומר-על-פסק-הדין-הקודם (אין-קודם → לא-חוסם — ייבדק-בשידור)
    // אך לא-נשמר-כ"טרי" (lastError!=null → הבדיקה-תחזור-בניסיון-הבא) ומתועד.
    if (prev) authChecked.set(chain, { ...prev, netFails, lastError });
    else authChecked.set(chain, { verdict: true, at: Date.now(), netFails, lastError });
    return prev?.verdict ?? true;
  }
}

async function attemptChain(rt: RelayRT, keys: RelayKeys | null, job: SealJob, chain: ChainName): Promise<void> {
  // FIX(SETTLE-11): שרשרת-ללא-מפתח = מושבתת-שקטה. ההיסטוריה: "eth/sol key missing"
  // נספר ככשל-קשה ×15 בכל-חותם → breakers-נפתחו-בשווא + רעש-לוג + זיהום-מדדים.
  // SETTLE-13: "fleet" אינו-דורש-מפתחות-headcorner — הצי-חתום-מתוך-הכספת-שלו.
  if (!keys && chain !== "fleet") {
    job.chains[chain].done = true;
    rt.chainState[chain].enabled = false;
    rt.chainState[chain].status = "disabled";
    rt.chainState[chain].lastError = "relay keys missing — quiet-disabled (no record, no breaker, no retry)";
    return;
  }
  if ((chain === "steem" && !keys?.steemWif) || (chain === "hive" && !keys?.hiveWif) || (chain === "eth" && !keys?.ethKey) || (chain === "sol" && !keys?.solKey) || (chain === "blurt" && !keys?.blurtWif)) {
    // FIX(F-7 · EXEC-CD-35): שער-מפתח-פר-שרשרת — steem/hive נוספים לצד eth/sol/blurt;
    // מפתח-חסר-פר-שרשרת מושבת **רק-את-השרשרת-ההיא** (עצמאות-מלאה, אפס-הדבקה).
    job.chains[chain].done = true;
    rt.chainState[chain].enabled = false;
    rt.chainState[chain].status = "disabled";
    rt.chainState[chain].lastError = `${chain} key missing — quiet-disabled (no record, no breaker, no retry)`;
    return;
  }
  const cs = job.chains[chain];
  // FIX(SETTLE-11): טיסה-מקדימה — מפתח-שאינו-רשות-על-השרשרת = השבתה-כנה (בלי-רכבת-דחיות)
  // הערה: הבדיקה לפני cs.attempts += 1 — לכן התנאי הוא ===0 (הניסיון-הראשון)
  // FIX(Roast-69 · preflight-chaos-scope): טיסת-הבדיקה היא קריאת-רשת-אמת (get_accounts) —
  // במחיצה-מוזרקת היא-דילגה-מעל-שער-הכאוס ונגעה-ברשת-בפועל (נתפס-בריצת-כאוס-חיה).
  // בפרודקשן chaosPartitioned===false-תמיד — אפס-שינוי-התנהגות; במבחן: המחיצה-אמת-לכל-דבר.
  if (keys && (chain === "steem" || chain === "hive" || chain === "blurt") && cs.attempts === 0 && !chaosPartitioned(chain) && !(await authorityOk(rt, keys, chain))) {
    cs.done = true;
    rt.chainState[chain].enabled = false;
    rt.chainState[chain].status = "disabled";
    rt.chainState[chain].lastError = `authority-mismatch: המפתח-ב-.env אינו רשות-השרשרת של ${chain === "hive" ? keys.hiveAccount : keys.account} — disabled (fail-closed, נדרשת רוטציה/ייבוא-מפתח-נכון)`;
    /* stage 6/6 — סירוב-סמכות הוא אירוע-ביקורת (מוגבל-תדירות): המפתח-שבכספת אינו
     * רשות-חיה על-השרשרת — אף-חתימה לא תתבצע עד-רוטציה. אפס-חומר-מפתח באירוע. */
    if (!auditThrottled(`authority:${chain}`)) {
      appendAudit({ type: "policy_violation", actor: { keyId: `relay-${chain}`, account: chain === "hive" ? keys.hiveAccount : keys.account }, target: { chain, gate: "authority", height: job.info.toHeight, epoch: job.epoch }, result: "blocked", reason: rt.chainState[chain].lastError ?? undefined });
    }
    return;
  }
  const b = rt.chainState[chain].breaker;
  if (!breakerAllows(b)) {
    cs.nextTryAt = (b.openedAt ?? Date.now()) + BREAKER_COOLDOWN_MS + 1000; // ה-breaker סגור — נחכה-לפרובה
    return;
  }
  cs.attempts += 1;
  // EPOCH-PATCH-SPEC §4: ה-epoch-הוקצה-כבר-ב-relaySeal (פעם-אחת-לעבודה) — כאן-רק-נצרך,
  // לפני-בניית-ה-payload ולפני-כל-רישום
  const epoch = job.epoch;
  const anchorAccount = chain === "hive" ? keys?.hiveAccount : keys?.account;
  const rec: AnchorRecord = {
    chain, epoch, height: job.info.toHeight, stateRoot: job.info.stateRoot, digest: job.info.digest,
    txid: null, status: "pending", at: job.at, attempt: cs.attempts,
    verified: null, verifiedAt: null,
  };
  /* payload קנוני משותף לכל-השרשראות — אותם בייטים על כל שרשרת (עיגון-עצמו-עקבי).
   * Task 11-b: הועבר-למעלה-מתוך-ה-try (הפקה-טהורה-מהעבודה) — אותו-אובייקט-שנבנה
   * כאן-הוא-זה שהוערך בשער-המדיניות (לפני-המפתח) ושייחתם במסגרת-החתימה. */
  const payload = canonicalSealPayload(job);
  /* ROTATION ENGINE (Task 3-a): התפקיד-שבאמת-חתם כשהמשמרת-נתנה-לחייל-צי (ל-audit-trail-כנה) */
  let rotatedRole: "posting" | "active" | null = null;
  try {
    /* chaos-gate — scripts/chaos-test.ts: מחיצת-רשת מוזרקת בתוך-נתיב-הכשל הרגיל.
     * SECURITY INTENT: הזריקה חייבת לעבור בדיוק כמו RPC בלתי-נגיש — catch →
     * breakerOnFailure (בניגוד לתנאי-תקציב) → backoff → רשומה כנה. אינרטי
     * בפרודקשן: chaosPartitioned === false תמיד, אלא אם כלי-בדיקה חימם אותו. */
    if (chaosPartitioned(chain)) {
      throw new Error(`chaos: injected network partition on ${chain} — rpc unreachable (fault-injection)`);
    }
    // EPOCH-PATCH-SPEC: epoch-בתוך-ה-payload-הקנוני (לא-באתרי-קריאה-פר-שרשרת) — שומר-על
    // שוויון-בייטים-בין-שרשראות וסוגר-את-התנגשות-הגבהים-אחרי-ריסטארטים
    if (chain === "tron") {
      // FIX(F-8 · EXEC-CD-35): מקור-הזהות — TRON_PRIVATE_KEY (hex, זהות-הכספת-הריבונית)
      // קודם; בהיעדרו — הסקלר-הגרפני (STEEM-family, ההיסטורי). אפס-קישור-למות-Steem.
      const tronHex = envKey("TRON_PRIVATE_KEY");
      const keyMaterial = tronHex && /^[0-9a-fA-F]{64}$/.test(tronHex)
        ? tronHex
        : keys?.steemWif || "";
      if (!keyMaterial) throw new Error("tron identity requires relay keys (disabled)");
      if (!rt.tronAddress) {
        rt.tronAddress = /^[0-9a-fA-F]{64}$/.test(keyMaterial)
          ? await tronIdentityFromHex(keyMaterial)
          : await tronIdentity(keyMaterial);
      }
      if (!rt.tronAddress) throw new Error("tron identity derivation failed");
      const r = await tronSealBroadcast(rt.tronAddress, job.info.stateRoot, keyMaterial);
      rec.txid = r.txid;
      rec.status = "anchored";
    } else if (chain === "fleet") {
      // SETTLE-13: צי-עיגון-ריבוני — חתימה-מקומית-מהכספת, סבב-חשבונות, POSTING-בלבד, אפס-עלות
      const r = await fleetSealNow(payload);
      rec.txid = r.txid;
      rec.account = r.account;
      rt.chainState.fleet.endpointHost = hostOf(HIVE_NODES[0]);
      rec.status = "anchored";
    } else if (chain === "eth") {
      if (!keys?.ethKey) throw new Error("eth key missing (disabled)");
      if (!rt.ethAddress) {
        const id = ethIdentity(keys.ethKey);
        if (keys.ethExpected && id.address.toLowerCase() !== keys.ethExpected.toLowerCase()) {
          rt.chainState.eth.enabled = false; // fail-closed — זהות שונה מהמניפסט-המעוגן
          throw new Error("eth identity mismatch: derived address != expected (fail-closed, disabled)");
        }
        rt.ethAddress = id.address;
        console.info(`[saos-relay] eth identity armed: ${id.address} (EIP-191 intents + funded broadcast)`);
      }
      // טירה-1: כוונת-עיגון חתומה EIP-191 — אפס-גז, ראיה-קריפטוגרפית תמידית
      const intent = signEthAnchor(payload, keys.ethKey);
      rt.ethIntents.unshift({ height: job.info.toHeight, intentHash: intent.intentHash, signature: intent.signature, address: intent.address, verified: intent.verified });
      rt.ethIntents = rt.ethIntents.slice(0, 12);
      // FIX(P0-5): עמידות-מיידית — החתימה על-דיסק לפני-כל-ניסיון-שידור (ראיה-תמידית גם-אחרי-restart)
      persist(rt);
      // טירה-2: שידור-חי — נעול-מימון עד-שהכתובת תמומן (unfunded → המתנה-כלכלית כנה)
      const r = await ethSealBroadcast(payload, keys.ethKey);
      rec.txid = r.txid;
      rec.status = "anchored";
    } else if (chain === "sol") {
      if (!keys?.solKey) throw new Error("sol key missing (disabled)");
      if (!rt.solAddress) {
        const id = solIdentity(keys.solKey);
        if (keys.solExpected && id.address !== keys.solExpected) {
          rt.chainState.sol.enabled = false; // fail-closed — זהות שונה מהמניפסט-המעוגן
          throw new Error("sol identity mismatch: derived address != expected (fail-closed, disabled)");
        }
        rt.solAddress = id.address;
        console.info(`[saos-relay] sol identity armed: ${id.address} (SPL-memo anchoring, fee-gated)`);
      }
      const r = await solSealBroadcast(payload, keys.solKey, solClaimsFloorLamports());
      rec.txid = r.txid;
      rec.status = "anchored";
    } else if (chain === "steem" || chain === "hive" || chain === "blurt") {
      if (chain === "blurt") {
        // Roast-82: ל-BLURT אין-RC-כלל (אומת-חי) — אין-שער-משאבים; חתימה-דרך-ה-SDK-הרשמי-בלבד
        const r = await blurtSealBroadcast(anchorAccount!, payload, keys!.blurtWif!);
        rt.chainState[chain].endpointHost = hostOf(BLURT_NODES[0]);
        rec.txid = r.txid;
        rec.status = "anchored";
      } else {
      const nodes = chain === "steem" ? STEEM_NODES : HIVE_NODES;
      const chainId = chain === "steem" ? ZERO_CHAIN_ID : HIVE_CHAIN_ID;
      const wif = chain === "steem" ? keys!.steemWif : keys!.hiveWif;
      const auth = chain === "steem" ? keys!.steemAuth : keys!.hiveAuth;
      if (cs.attempts === 1) {
        const mana = await rcMana(nodes[0], anchorAccount!);
        if (mana !== null && mana < RC_MIN) throw new Error(`rc-low: ${mana} < ${RC_MIN} — waiting (honest retry)`);
      }
      // payload מכווץ — RC-תודעתי (כל בייט = כ-580K RC על Hive)
      const r = await grapheneSealBroadcast(nodes[0], chainId, anchorAccount!, payload, wif, auth);
      rt.chainState[chain].endpointHost = hostOf(nodes[0]); // FIX(CROSS-F-04): השער בפועל — נרשם
      rec.txid = r.txid;
      rec.status = "anchored";
      }
    } else {
      throw new Error(`chain ${chain} has no anchor path (unreachable)`);
    }
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 180);
    // סיווג-כנות: חוסר-תקציב (RC/unfunded) **וגם-הגבלת-סביבה** (rate-limit/quota/429
    // מ-RPC-ציבורי) אינם כשל-מערכת — הם המתנה-כלכלית כנה. ספירתם ככשל-קשי
    // יצרה-מעגל-שבירה: breaker נפתח ×7 על-רכבת-בריאה שרק-מוגבלת-תדר.
    // SETTLE-13: "no usable account" (צי: כל-החשבונות-RC-קר/בהתקררות) = המתנה-כלכלית-גם-כן
    const economic = /rc-low|has not enough RC|unfunded|backing-floor|gas-ceiling|rate limit|too many requests|quota|\b429\b|no usable account|acnt\.balance\s*>=?\s*fee/i.test(msg);
    if (economic) {
      // חוסר-תקציב = המתנה כלכלית כנה — לא כשל-מערכת (לא נספר ל-breaker); בדיקה-מחדש תקופתית
      cs.attempts = 0;
      cs.rcWaits += 1;
      rt.metrics.economicWaits += 1;
      /* ── ROTATION ENGINE (Task 3-a · ניהול-דלק-אוטונומי): כשל-דלק על הזהות-הראשית
       * אינו עצירת-מנוע — הצבא-מהכספת מקבל-את-המשמרת (hive/steem: RC · blurt: fee-balance).
       * ניסיון-אחד-מדוד-פר-כשל; הצלחה = עיגון-מלא עם rec.account=חייל; כשל = המתנה-
       * הכלכלית-הכנה נמשכת (ה-breaker-הפר-חשבון של-הצי רוסן-לולאות). אפס-סודות בלוגים. ── */
      let rotated = false;
      if (chain === "steem" || chain === "hive" || chain === "blurt") {
        try {
          const r = await fleetSealOn(chain, payload, anchorAccount ?? undefined);
          rec.txid = r.txid;
          rec.account = r.account;
          rec.status = "anchored";
          rec.error = undefined;
          rotated = true;
          rotatedRole = r.role;
          rt.metrics.rotations += 1;
          rt.chainState[chain].endpointHost = hostOf(chain === "steem" ? STEEM_NODES[0] : chain === "hive" ? HIVE_NODES[0] : BLURT_NODES[0]);
          console.info(`[saos-relay][ROTATION] ${chain}: ${anchorAccount} → ${r.account} (fuel-fallback · wait#${cs.rcWaits} · txid ${r.txid})`);
        } catch (rotErr) {
          const rm = String((rotErr as Error)?.message || rotErr).slice(0, 140);
          console.info(`[saos-relay][ROTATION] ${chain}: fleet-fallback unavailable — ${rm} · continuing honest economic wait`);
        }
      }
      if (!rotated) {
        rec.status = "pending";
        rec.attempt = cs.rcWaits;
        cs.nextTryAt = Date.now() + econWaitMin(chain) * 60_000;
        if (cs.rcWaits > 48) { rec.status = "failed"; cs.done = true; rec.error = msg + " · budget-wait expired (honest)"; }
        else rec.error = msg;
        rt.chainState[chain].lastError = msg;
      }
    } else if (/expecting 32 bytes|invalid (wif|private|key)|bad (wif|base58)|checksum/i.test(msg)) {
      // FIX(SETTLE-11): שגיאת-תצורה (מפתח-פסול) היא קבועה — אין-טעם-בניסיונות-חוזרים;
      // לא-נספרת-ל-breaker (לא-רכבת-כשלים-אמיתית), סימון-כנה וסיום.
      rec.status = "failed";
      cs.done = true;
      rec.error = "config-permanent: " + msg;
      rt.chainState[chain].lastError = rec.error;
    } else {
      breakerOnFailure(rt, chain); // כשל-קשי — נספר ל-breaker (עלול לפתוח אותו)
      if (cs.attempts >= RETRY_MAX) {
        rec.status = "failed";
        cs.done = true;
      } else {
        rec.status = "pending";
        cs.nextTryAt = Date.now() + backoffMs(cs.attempts);
      }
      rec.error = msg;
      rt.chainState[chain].lastError = msg;
    }
    /* stage 6/6 — כשל-ניסיון נרשם גם-הוא (כולל-המתנה-כלכלית: "נוסה-ונדחה-תקציב");
     * אפס חומר-מפתח באירוע — מזהים/גבהים/סיבות-חתוכות בלבד. */
    appendAudit({ type: "signing_attempt", actor: { keyId: `relay-${chain}`, account: anchorAccount ?? null }, target: { chain, height: job.info.toHeight, epoch }, result: "failure", reason: msg });
  }
  upsertRecord(rt, rec);
  if (rec.status !== "pending") cs.done = true;
  rt.chainState[chain].status = rec.status;
  rt.chainState[chain].lastTxid = rec.txid ?? rt.chainState[chain].lastTxid;
  rt.chainState[chain].lastHeight = rec.height;
  rt.chainState[chain].lastAt = rec.at;
  if (rec.status === "anchored") {
    breakerOnSuccess(b);
    rt.chainState[chain].anchored += 1;
    rt.chainState[chain].lastError = null;
    rt.metrics.broadcasts += 1;
    /* ── stage 6/6 — audit-trail: key_used + broadcast (הצלחה) + commit שער-החזרה ──
     * אותו-פרימיטיב-מבוקר של relay-eth (appendAudit — שרשרת-hash אחת לכל-החותמים
     * בתהליך). role = התפקיד-שבאמת-חתם (post-self-heal ל-graphene; פעולות-ערך = active;
     * צי = posting). אפס-סודות: חשבון-ציבורי/גובה/txid בלבד. */
    const usedRole: RelayAnchorRole | null =
      rotatedRole // Task 3-a: המשמרת-מהצי — התפקיד-המדוד שבאמת חתם (posting/active)
      ? rotatedRole
      : chain === "steem" ? (keys?.steemAuth ?? null)
      : chain === "hive" ? (keys?.hiveAuth ?? null)
      : chain === "fleet" ? "posting"
      : "active"; // blurt (buildOp active) · tron/eth/sol (פעולות-ערך)
    const auditActor = { keyId: `relay-${chain}`, account: rec.account ?? anchorAccount ?? rt.account ?? null };
    appendAudit({ type: "key_used", actor: auditActor, target: { chain, role: usedRole, height: rec.height, epoch: rec.epoch }, result: "success" });
    appendAudit({ type: "broadcast", actor: auditActor, target: { chain, height: rec.height, epoch: rec.epoch, txid: rec.txid }, result: "success", reason: `chain-seal anchored on ${chain}${usedRole ? ` with ${usedRole} role` : ""}` });
    commitRepeat(chain, payload, Date.now());
    scheduleVerification(rt, rec); // verifyOnChain — קריאה-חוזרת מיד-אחרי-שידור (לא-חוסם)
  }
  rt.lastActivityAt = Date.now();
  persist(rt);
}

async function processQueue(rt: RelayRT): Promise<void> {
  if (rt.processing) return;
  // FIX(R14-a · TOCTOU): הדגל לפני ה-await — שתי-ריצות-סינכרוניות (catch-up sealing)
  // היו עוברות-יחד את-השומר בזמן loadKeys ומשדרות את-אותה-עבודה במקביל.
  rt.processing = true;
  try {
    /* ── stage 1/6 — session-gate: לפני **כל טעינת-מפתח** (loadKeys למטה — סדר-השורות
     * הוא-החוזה; דוקטרינת live_gate 10-d-3: שער-לפני-מפתח). סשן-נעול = אף בייט-מפתח
     * לא נוגע ואף שידור לא נבנה — fail-closed כנה (חימוש-דו-מפתחי, כמו relay-eth). ── */
    try {
      ensureUnlocked();
    } catch (e) {
      const reason = e instanceof SigningGateError ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e).slice(0, 200);
      for (const c of ALL_CHAINS as ChainName[]) {
        if (rt.chainState[c].enabled) rt.chainState[c].lastError = `session-gate: ${reason}`;
      }
      if (!auditThrottled("session-lock")) {
        appendAudit({ type: "signing_attempt", actor: { keyId: "relay-anchor-1", gate: "session" }, target: { gate: "session", stage: "1/6" }, result: "failure", reason });
      }
      return;
    }

    const now = Date.now();

    /* ── stage 2/6 — policy-gate: הערכה לפני **כל טעינת-מפתח** (loadKeys למטה); שלילה
     * עוצרת את-השרשרת-ההיא לכל-החותם (done) + policy_violation מוגבל-תדירות.
     * שרשרת-כבויה-תצורתית (enabled=false) ממשיכה-לנתיב-הכיבוי-השקט הקיים —
     * כיבוי-תצורה אינו-הפרת-מדיניות (כנות, לא-רעש). ── */
    const plan = new Map<SealJob, ChainName[]>();
    for (const job of [...rt.jobs].reverse()) {
      const due = (ALL_CHAINS as ChainName[]).filter((c) => {
        const cs = job.chains[c];
        return !cs.done && cs.attempts < RETRY_MAX && cs.nextTryAt <= now;
      });
      if (due.length === 0) continue;
      const payload = canonicalSealPayload(job); // אותם-בייטים-שייחתמו (canonicalSealPayload למעלה)
      const ok: ChainName[] = [];
      for (const c of due) {
        if (!rt.chainState[c].enabled) { ok.push(c); continue; }
        const decision = evaluatePolicy({ chain: c, payload });
        if (decision.allowed) { ok.push(c); continue; }
        const reason = decision.reasons.join("; ");
        job.chains[c].done = true;
        rt.chainState[c].status = "failed";
        rt.chainState[c].lastError = `policy-denied: ${reason}`;
        if (!auditThrottled(`policy:${c}`)) {
          appendAudit({ type: "policy_violation", actor: { keyId: "relay-anchor-1", chain: c }, target: { chain: c, height: job.info.toHeight, epoch: job.epoch }, result: "blocked", reason });
        }
      }
      if (ok.length > 0) plan.set(job, ok);
    }

    const keys = await loadKeys();
    // SETTLE-13: גם-בלי-מפתחות-headcorner — הצי-הריבוני-ממשיך-לעגן (עיגון-לא-תלוי-זהות-אחת)
    if (!keys && !fleetConfigured()) return;

    // עיבוד כל-העבודות מהישן-לחדש — steem מעגן כל-חותם, hive/tron רק-את-החדש-ביותר
    // (רק-זוגות (עבודה,שרשרת)-שעברו-את-שער-המדיניות למעלה)
    for (const [job, due] of plan) {
      await Promise.all(due.map((c) => attemptChain(rt, keys, job, c).catch(() => { /* לא-חוסם */ })));
    }
    rt.jobs = rt.jobs.filter((j) => !(ALL_CHAINS as ChainName[]).every((c) => j.chains[c].done));
  } finally {
    rt.processing = false;
  }
}

/* ── שחזור-ראיות-ציבוריות מהריצה-הקודמת (state/anchors.json — הוכחות בלבד) ──
 * ה-Relay שורד הפעלות-מחדש: הרשומות חוזרות, המדדים נספרים-מחדש מהן, וכל-עיגון
 * ששודר וטרם-אומת נכנס אוטומטית לתור-הפיוס. */
function restoreRecords(rt: RelayRT): void {
  try {
    const raw = JSON.parse(fs.readFileSync(ANCHORS_FILE, "utf8")) as { records?: Partial<AnchorRecord>[]; ethIntents?: { height: number; intentHash: string; signature: string; address: string; verified: boolean }[] };
    // FIX(P0-5): שחזור-כוונות-EIP-191 — ראיות-החתימה שורדות-הפעלות (לפני-ה-return-המוקדם)
    if (Array.isArray(raw.ethIntents)) {
      const cleanIntents = raw.ethIntents
        .filter((i) => i && typeof i.intentHash === "string" && typeof i.signature === "string" && typeof i.address === "string" && typeof i.height === "number")
        .slice(0, 12);
      if (cleanIntents.length > 0) {
        rt.ethIntents = cleanIntents;
        console.info(`[saos-relay] restored ${cleanIntents.length} EIP-191 intents from anchors.json (evidence survives restart)`);
      }
    }
    if (!Array.isArray(raw.records)) return;
    const clean: AnchorRecord[] = [];
    for (const r of raw.records.slice(0, 60)) {
      if (!r || typeof r.chain !== "string" || typeof r.height !== "number" || !r.txid || typeof r.stateRoot !== "string") continue;
      if (!(r.chain === "steem" || r.chain === "hive" || r.chain === "tron" || r.chain === "eth" || r.chain === "sol" || r.chain === "fleet")) continue;
      clean.push({
        chain: r.chain, epoch: typeof r.epoch === "string" && /^e\d+$/.test(r.epoch) ? r.epoch : "e0-pre", // רשומות-טרום-הפאץ' — מסומנות-בכנות
        height: r.height, stateRoot: r.stateRoot, digest: String(r.digest ?? ""),
        txid: r.txid, status: (r.status === "anchored" ? "anchored" : "pending"),
        at: String(r.at ?? new Date().toISOString()), attempt: Number(r.attempt ?? 1),
        account: typeof r.account === "string" ? r.account : undefined,
        // פסיקה-שמורה-בדיסק אינה אמת-מידה סופית: false נחשב "דורש-אימות-מחדש" (null)
        // כדי-שלולאת-הפיוס תגזור-אותה מחדש מה-RPC (ריפוי-עצמי משאריות-מהדורות-קודמות).
        verified: r.verified === true ? true : null,
        verifiedAt: typeof r.verifiedAt === "string" ? r.verifiedAt : null,
      });
    }
    if (clean.length === 0) return;
    rt.records = clean;
    for (const c of ALL_CHAINS as ChainName[]) {
      const recs = clean.filter((r) => r.chain === c);
      if (recs.length === 0) continue;
      const last = recs[0];
      // FIX(roshpina-forensic): הספירה הייתה אסימטרית — anchored נספר מ-status
      // אך verified/mismatches נספרו מכל-הרשומות (כולל-pending) — יצר מצב
      // בלתי-אפשרי verified>anchored בפנקס הציבורי. עתה: הכל נגזר מתוך
      // רשומות-ה-anchored בלבד → verified+mismatches ≤ anchored מבנית.
      const anchoredRecs = recs.filter((r) => r.status === "anchored");
      rt.chainState[c].anchored = anchoredRecs.length;
      rt.chainState[c].verified = anchoredRecs.filter((r) => r.verified === true).length;
      rt.chainState[c].mismatches = anchoredRecs.filter((r) => r.verified === false).length;
      rt.chainState[c].lastTxid = last.txid;
      rt.chainState[c].lastHeight = last.height;
      rt.chainState[c].lastAt = last.at;
      rt.chainState[c].status = last.status;
    }
    const anchoredAll = clean.filter((r) => r.status === "anchored");
    rt.metrics.verified = anchoredAll.filter((r) => r.verified === true).length;
    rt.metrics.mismatches = anchoredAll.filter((r) => r.verified === false).length;
    console.info(`[saos-relay] restored ${clean.length} anchor records from prior run — reconcile queue re-armed`);
  } catch { /* אין-קובץ/פורמט-ישן — פתיחה-נקייה */ }
}

/* ── אתחול-זמן-ריצה (שורד HMR דרך globalThis) ── */
function rtInit(): RelayRT {
  if (g.__saosDexRelay) return g.__saosDexRelay;
  const cfg = keysConfigured();
  const mk = (on: boolean): RelayChainState => ({
    enabled: on, status: on ? "idle" : "disabled",
    lastTxid: null, lastHeight: null, lastAt: null,
    lastError: null, lastVerifyError: null,
    anchored: 0, verified: 0, mismatches: 0,
    breaker: mkBreaker(),
    endpointHost: null,
  });
  const rt: RelayRT = {
    jobs: [], processing: false, records: [],
    chainState: { steem: mk(cfg.steem), hive: mk(cfg.hive), blurt: mk(cfg.blurt), tron: mk(cfg.tron), eth: mk(cfg.eth), sol: mk(cfg.sol), fleet: mk(fleetConfigured()) },
    metrics: { broadcasts: 0, verified: 0, mismatches: 0, breakerTrips: 0, economicWaits: 0, rotations: 0, lastVerifyLatencyMs: null },
    account: cfg.account,
    tronAddress: null,
    ethAddress: null,
    solAddress: null,
    ethIntents: [],
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    reconcileStarted: false,
  };
  g.__saosDexRelay = rt;
  restoreRecords(rt); // ראיות-העיגון מהריצה-הקודמת חוזרות לפני-תחילת-הפיוס
  if (cfg.steem || cfg.hive || cfg.tron) startReconciler(rt); // לולאת-פיוס — רק-כשיש-זהות-עיגון-חיה (F-7: פר-שרשרת)
  return rt;
}

/** ה-hook מ-seal() — לא-חוסם, לא-זורק */
export function relaySeal(info: SealInfo): void {
  try {
    const rt = rtInit();
    // SETTLE-13: ה-Relay חי-גם-כשאין-מפתחות-headcorner — הצי-מכסה-עיגון (ריבונות-לא-תלוית-זהות)
    if (!rt.account && !fleetConfigured()) return; // אין-מפתחות-ואין-צי — ה-Relay כבוי-בכנות
    if (rt.jobs.length >= QUEUE_CAP) rt.jobs.pop(); // החדש-חשוב מהישן — הישן נזרק
    // חותמות-ישנות של עיגון-כבד/RC מסומנות done — רק החותם החדש-ביותר נעגן עליהן (תקציב RC/gas/SOL)
    for (const j of rt.jobs) for (const c of LATEST_ONLY) j.chains[c].done = true;
    // EPOCH-PATCH-SPEC §4: assignEpoch-פעם-אחת-לעבודה-המשותפת — ה-payload שייבנה-ממנו
    // יישאר-בייטים-זהים-על-כל-השרשראות (הקריאה-פר-שרשרת הייתה-מפרה-את-המאפיין)
    const epoch = assignEpoch(info.toHeight);
    rt.jobs.unshift({
      info, at: new Date().toISOString(), epoch,
      chains: {
        steem: { attempts: 0, rcWaits: 0, nextTryAt: 0, done: false },
        hive: { attempts: 0, rcWaits: 0, nextTryAt: 0, done: false },
        blurt: { attempts: 0, rcWaits: 0, nextTryAt: 0, done: false },
        tron: { attempts: 0, rcWaits: 0, nextTryAt: 0, done: false },
        eth: { attempts: 0, rcWaits: 0, nextTryAt: 0, done: false },
        sol: { attempts: 0, rcWaits: 0, nextTryAt: 0, done: false },
        fleet: { attempts: 0, rcWaits: 0, nextTryAt: 0, done: false },
      },
    });
    void processQueue(rt).catch(() => { /* לעולם לא מפיל את השרשרת */ });
  } catch { /* לעולם לא מפיל את השרשרת */ }
}

/** relayAuditVerify — ערוץ-אימות לכלי-ביקורת (ולמבחני-כאוס):
 * מריץ רשומה אחת במלוא-נתיב-האימות — קריאה-חוזרת מה-RPC הציבורי, השוואת
 * stateRoot+height, ALERT בלוג על-מיסמאץ', ועדכון-מדדים (mismatches/verified).
 * SECURITY INTENT: מאפשר להוכיח שהמערכת מזהה stateRoot מזויף ומסרבת לאשר אותו —
 * בלי שידור, בלי חסימה, ובלי גישה למפתחות. מבודד-מצב דרך SAOS_DEX_STATE_DIR.
 */
export async function relayAuditVerify(
  chain: ChainName,
  txid: string,
  expected: { height: number; stateRoot: string; account?: string } // Roast-73: account נוסע-לוקטור-הבדיקה (עיגוני-צי=חותם-החייל)
): Promise<{ ok: boolean; verified: boolean | null; detail: string }> {
  const rt = rtInit();
  const rec: AnchorRecord = {
    chain, epoch: "e0-pre", height: expected.height, stateRoot: expected.stateRoot, digest: "", // מאמת-מקריאה-חוזרת — לא-רישום-מונה-חדש (לא-נוגע-במונה)
    txid, status: "anchored", at: new Date().toISOString(), attempt: 1,
    verified: null, verifiedAt: null,
    ...(expected.account ? { account: expected.account } : {}), // Roast-73
  };
  await verifyRecord(rt, rec);
  if (rec.verified === true) return { ok: true, verified: true, detail: "verified on-chain (read-back match)" };
  if (rec.verified === false) return { ok: false, verified: false, detail: rec.error ?? rt.chainState[chain].lastVerifyError ?? "mismatch" };
  return { ok: false, verified: null, detail: "not indexed (pending reconciliation)" };
}

/** מצב-ציבורי ל-API/UI — אפס סודות */
export function relayStatus(): Record<string, unknown> {
  const rt = rtInit();
  return {
    enabled: !!rt.account,
    account: rt.account,
    anchorId: ANCHOR_ID,
    uptimeMs: Date.now() - rt.startedAt,
    lastActivityAt: rt.lastActivityAt,
    queue: rt.jobs.length,
    tronIdentity: rt.tronAddress,
    identities: { eth: rt.ethAddress, sol: rt.solAddress },
    ethIntents: rt.ethIntents.slice(0, 3).map((i) => ({ height: i.height, intentHash: i.intentHash.slice(0, 18) + "…", signature: i.signature.slice(0, 12) + "…", address: i.address, verified: i.verified })),
    metrics: rt.metrics,
    // FIX(CROSS-F-04): גם-view ה-API מעיד על-הרשת (fallback לשער-המקורת כשאין-שידור-בפועל-עדיין)
    chains: Object.fromEntries((ALL_CHAINS as ChainName[]).map((c) => [
      c, { ...rt.chainState[c], endpointHost: rt.chainState[c].endpointHost ?? configuredHost(c) },
    ])),
    records: rt.records.slice(0, 60).map((r) => ({
      chain: r.chain, epoch: r.epoch, // EPOCH-PATCH-SPEC: גלוי-לציבור — (epoch,height)=המפתח-הייחודי
      height: r.height, status: r.status, txid: r.txid, at: r.at, attempt: r.attempt,
      account: r.account, // SETTLE-13: חתים-הצי-הריבוני (שם-חשבון-ציבורי-בלבד)
      stateRoot: r.stateRoot, // עדות-ציבורית — נדרשת לאימות-עיגון-טרי בעמדת-הסליקה
      verified: typeof r.verified === "boolean" ? r.verified : null, verifiedAt: r.verifiedAt ?? null,
      error: r.error ? r.error.slice(0, 90) : undefined,
    })),
    // SETTLE-13: טלמטריית-הצי-הריבוני (אפס-סודות)
    fleet: fleetStatusPublic(),
  };
}

/** SETTLE-13: החותם-המתאים-ביותר-לעיגון-צי-כפוי (מהתור; אחרת-הרשומה-האחרונה) */
export function latestSealForFleet(): { height: number; stateRoot: string; digest: string; at: string } | null {
  const rt = rtInit();
  const job = rt.jobs[0];
  if (job) return { height: job.info.toHeight, stateRoot: job.info.stateRoot, digest: job.info.digest, at: job.at };
  const last = rt.records[0];
  if (last) return { height: last.height, stateRoot: last.stateRoot, digest: last.digest, at: last.at };
  return null;
}
