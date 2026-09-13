/* fleet.ts — SOVEREIGN ANCHOR FLEET (SETTLE-13) · "דבר-גורר-דבר" מתיקיות-הסוכנים
 * ═══════════════════════════════════════════════════════════════════════════════
 * גילוי-חי (בדיקת-סמכויות-RPC, 2026-09-09): 9/10-חשבונות-החיילים בכספת-הצי
 * (SAOS-FLEET-VAULT-1, חברים 2026-09-06) הם רשויות-HIVE-חיות מלאות
 * (posting+active+owner+memo — MATCH מול-השרשרת). עיגון-custom_json על-HIVE
 * הוא-RC-borne = אפס-עלות. הצי הופך-את-עיגון-ה-DEX לריבוני-רב-חשבוני:
 * ללא-keyrelay, ללא-gas, עם-שכפול-טבעי-על-פני-9-חתימות-עצמאיות.
 *
 * אבטחה (מפעיל: "רשאי להשתמש במפתחות מתיקיה-אחרת — בזהירות"):
 *   · חומר-סודי בזיכרון-בלבד — אף-פעם לא בלוגים/פלט/פנקסים/רשומות-ציבוריות.
 *   · כספת ב-agent/keys (gitignored, chmod-600) — פורמט SAOS-FLEET-VAULT-1
 *     (scrypt + AES-256-GCM; כל-פתיחה מאמתת-tag; שחיתות = זריקה fail-closed).
 *   · self-verify לכל-WIF: wifToPublic חייב-להתאים ל-pub-שבכספת — אחרת-החשבון
 *     נפסל-שקטה (אף-מפתח-לא-יוצא-מהמודול).
 *   · חשבון-לא-מאומת-בשרשרת = לא-משמש (בדיקת-get_accounts חיה + TTL).
 *   · POSTING בלבד לשידור (לא-ACTIVE) — לצי אין-יכולת-העברת-כספים-בנתיב-עיגון.
 *   · breaker-פר-חשבון (3-כשלים-רצופים → התקררות-10דק) + RC-gate קנוני.
 *   · כל-fetch דרך-הגדר-הריבונית (fencedFetch — גדר + redirect:"error", FIX Roast-65-b).
 *
 * הערת-כנות: ה-pass-של-הכספת היה-היסטורית-חשוף (meta-בריפו). החיילים-אינם-כספת-
 * אוצר — השימוש-כאן הוא-עיגון-פרסום-בלבד; רוטציית-מפתחות-לצי נותרת-המלצה-פתוחה
 * (מתועדת ב-PHISHING_DEFENSE.md) — ואינה-מבוצעת-כדי-לא-לשבור-צרכני-צי-אחרים.
 */
import fs from "fs";
import path from "path";
import { scryptSync, createDecipheriv } from "crypto";
import steemLibRaw from "steem";
import { fencedFetch } from "./fence"; // FIX(Roast-65-b · H2): גדר + redirect:error מרוכזים
import { ANCHOR_ID, HIVE_CHAIN_ID, HIVE_NODES, grapheneSealBroadcast, rcMana } from "./relay";

interface SteemAuth {
  auth: { wifToPublic(wif: string): string };
}
const steemLib = steemLibRaw as unknown as SteemAuth;

/* עלות-אמפירית-מדודה-חי (2026-09-09): עיגון-הצי-הראשון (haran, tx fa946dfb…) בלע
 * ~199M-RC מהמדד-החי — תואם-מדידת-jummper (157.7M-ל-op-קטן-יותר). הסף-להלן
 * מונע-ניסיונות-שידור-על-חשבונות-שאינם-יכולים-להרשות-את-ה-op (fail-closed-כלכלי). */
const RC_MIN_FLEET = 210_000_000;         // Roast-73: עלות-op-נמדדה-בדיוק-חי (206,379,561 — דחיית-צומת על 201M) + מרווח
const PROBE_TTL_MS = 10 * 60_000;         // תוקף-בדיקת-סמכויות/RC
const ACCT_BREAKER_TRIPS = 3;             // כשלים-רצופים-פר-חשבון → התקררות
const ACCT_COOLDOWN_MS = 10 * 60_000;
const MAX_ANCHOR_TRIES = 3;               // עד-3-חשבונות-בניסיון-חותם-אחד

const MAGIC = "SAOS-FLEET-VAULT-1";

/* ── פתיחת-הכספת (GCM-מאומת; סודות-לא-עוזבים-את-המודול) ────────────────────── */
interface VaultAccount {
  username: string;
  keys: Record<string, { wif: string; pub: string } | undefined>;
}
interface VaultBundle {
  at: string;
  accounts: VaultAccount[];
}

function vaultDir(): string | null {
  const cands = [
    process.env.SAOS_FLEET_VAULT_DIR || "",
    path.join(process.cwd(), "agent", "keys"),
    path.join(process.cwd(), "..", "agent", "keys"),
  ].filter(Boolean);
  for (const d of cands) {
    try {
      if (fs.existsSync(path.join(d, "fleet_keys.enc")) && fs.existsSync(path.join(d, "fleet_keys.meta.json"))) return d;
    } catch { /* next */ }
  }
  return null;
}

function openVault(dir: string): VaultBundle {
  const raw = fs.readFileSync(path.join(dir, "fleet_keys.enc"), "utf8");
  if (!raw.startsWith(MAGIC)) throw new Error("fleet vault: unknown seal format");
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "fleet_keys.meta.json"), "utf8")) as { pass?: string };
  if (!meta.pass) throw new Error("fleet vault: no pass in seal meta");
  // פורמט: hex(salt16 | iv12 | tag16 | ct) — זהה-למפרט-פלטפורמה (vault-seal.ts)
  const payload = Buffer.from(raw.slice(MAGIC.length).replace(/\s+/g, ""), "hex");
  const key = scryptSync(meta.pass, payload.subarray(0, 16), 32);
  const d = createDecipheriv("aes-256-gcm", key, payload.subarray(16, 28));
  d.setAuthTag(payload.subarray(28, 44));
  const plain = Buffer.concat([d.update(payload.subarray(44)), d.final()]).toString("utf8");
  const bundle = JSON.parse(plain) as { sealedAt?: string; files?: Record<string, string> } & Partial<VaultBundle>;
  const vaultJson = bundle.files?.["keys/vault.json"];
  if (!vaultJson) throw new Error("fleet vault: keys/vault.json member missing");
  const accounts = accountsFromJson(vaultJson);
  // FIX(R12 · fleet-vault-format): דור KEYS-ACCESS-2026-09-12 (R11) חתם מעטפת
  // שה-member "keys/vault.json" בה הוא-מפקד-מצונן (מפה-לפי-שם, בלי-חומר-חתימה)
  // ולא-מערך-מפתחות-חי כמו-בדור-הקודם (reseal-fleet-vault). הצי חייב חומר-חתימה
  // אמת — כשה-member המוטמע מצונן ניפול ל-vault.json החי-על-הדיסק (אותה תיקייה
  // chmod-600 gitignored — מדיניות-הבעלים 2026-09-10 "זה אצלך בקבצים").
  // fail-closed נשמר: אף-מקור-לא-נותן-חומר-חתימה → אפס-חשבונות-שמישים → צי-שקט.
  if (accounts.length === 0) {
    const diskPath = path.join(dir, "vault.json");
    try {
      if (fs.existsSync(diskPath)) {
        const diskAccounts = accountsFromJson(fs.readFileSync(diskPath, "utf8"));
        if (diskAccounts.length > 0) return { at: String(bundle.sealedAt ?? bundle.at ?? ""), accounts: diskAccounts };
      }
    } catch { /* fail-closed — השגיאה-המקורית-מהמעטפת תישמר */ }
  }
  if (accounts.length === 0) throw new Error("fleet vault: no usable signing keys (embedded member redacted + no live vault.json)");
  return { at: String(bundle.sealedAt ?? bundle.at ?? ""), accounts };
}

/* מקבל-שתי-הצורות: מערך-דור-ישן או מפה-לפי-שם-דור-R11 — מחזיר רק-שמישות-לחתימה */
function accountsFromJson(json: string): VaultAccount[] {
  let parsed: { accounts?: unknown } | null = null;
  try { parsed = JSON.parse(json) as { accounts?: unknown }; } catch { return []; }
  const raw: unknown = parsed?.accounts;
  const list: unknown[] = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.entries(raw as Record<string, unknown>).map(([k, v]) => ({ username: k, ...(typeof v === "object" && v ? v : {}) })) : [];
  return (list as Partial<VaultAccount>[])
    .filter((a) => a && typeof a.username === "string" && !!a.keys?.posting?.wif && !!a.keys?.posting?.pub)
    .map((a) => ({ username: a.username as string, keys: a.keys as VaultAccount["keys"] }));
}

/* ── מצב-זמן-ריצה (שורד-HMR דרך-globalThis; אפס-סודות-במצב-הציבורי) ─────────── */
interface FleetAccountRT {
  postingWif: string;      // סוד — זיכרון-בלבד
  postingPub: string;
  authorityOk: boolean | null;
  rcEffective: number | null;
  failCount: number;
  lastFailAt: number | null;
  anchoredCount: number;
  lastTxid: string | null;
  lastAnchorAt: string | null;
}

interface FleetRT {
  openedAt: number | null;
  openedOk: boolean;
  openError: string | null;
  sealedAt: string | null;
  accounts: Map<string, FleetAccountRT>;
  probedAt: number | null;
  probing: boolean;
  rrIndex: number;
  lastOpenTryAt: number; // Roast-73: מדידת-נסיון-פתיחה (retry-מדוד)
}

declare global {
  var __saosDexFleet: FleetRT | undefined;
}

const OPEN_RETRY_MS = 30_000; // Roast-73: נסיון-פתיחה-מחדש-מדוד — כספת-שמופיעה-בריצה מחמשת-את-הצי-בלי-הפעלה-מחדש

function fleetInit(): FleetRT {
  if (globalThis.__saosDexFleet) {
    const rt = globalThis.__saosDexFleet;
    // FIX(Roast-73): היה — כשל-פתיחה-ראשון נקבע-לנצח (openError-cache) וכספת
    // שהופיעה-בהמשך-הריצה לא-החייתה-את-הצי. עכשיו: retry-מדוד-כל-30ש׳ — אותו-
    // fail-closed (אין-כספת → אין-מפתחות), אבל-אמת-ריצה-ולא-גזירה-של-בוט-אחד.
    if (!rt.openedOk && (!rt.lastOpenTryAt || Date.now() - rt.lastOpenTryAt >= OPEN_RETRY_MS)) {
      rt.lastOpenTryAt = Date.now();
      rt.openError = null;
      tryOpen(rt);
    }
    return rt;
  }
  const rt: FleetRT = {
    openedAt: null, openedOk: false, openError: null, sealedAt: null,
    accounts: new Map(), probedAt: null, probing: false, rrIndex: 0,
    lastOpenTryAt: Date.now(),
  };
  globalThis.__saosDexFleet = rt;
  tryOpen(rt);
  return rt;
}

function tryOpen(rt: FleetRT): void {
  try {
    const dir = vaultDir();
    if (!dir) {
      rt.openError = "vault-not-present (agent/keys/fleet_keys.enc) — fleet quiet-disabled";
      return;
    }
    const bundle = openVault(dir);
    rt.openedOk = true;
    rt.openedAt = Date.now();
    rt.sealedAt = bundle.at;
    for (const a of bundle.accounts) {
      // self-verify: ה-WIF-חייב-לגזור-בדיוק-את-ה-pub-שבכספת — אחרת-נפסל (fail-closed)
      let pubOk = false;
      try {
        pubOk = steemLib.auth.wifToPublic(a.keys.posting!.wif) === a.keys.posting!.pub;
      } catch { pubOk = false; }
      if (!rt.accounts.has(a.username)) {
        rt.accounts.set(a.username, {
          postingWif: pubOk ? a.keys.posting!.wif : "",   // לא-מאומת → לא-נשמר
          postingPub: a.keys.posting!.pub,
          authorityOk: null, rcEffective: null,
          failCount: 0, lastFailAt: null,
          anchoredCount: 0, lastTxid: null, lastAnchorAt: null,
        });
      }
    }
    const n = [...rt.accounts.values()].filter((a) => a.postingWif).length;
    console.info(`[saos-fleet] vault opened: ${rt.accounts.size} accounts, ${n} self-verified posting keys (memory-only)`);
  } catch (e) {
    rt.openError = String((e as Error)?.message || e).slice(0, 160);
    console.error(`[saos-fleet][ALERT] vault open failed (fail-closed): ${rt.openError}`);
  }
}

/* ── הגדרה-סינכרונית (ל-rtInit של-הרליי — בלי-IO) ──────────────────────────── */
export function fleetConfigured(): boolean {
  const rt = fleetInit();
  return rt.openedOk && [...rt.accounts.values()].some((a) => !!a.postingWif);
}

/* ── בדיקה-חיה: סמכויות-מול-השרשרת + RC-קנוני-פר-חשבון ─────────────────────── */
async function rpcJson<T>(endpoint: string, body: unknown, timeoutMs = 15000): Promise<T> {
  // FIX(Roast-65-b · H2): דרך-fencedFetch — גדר + redirect:error (חתימות-הצי לא-משוחזרות-החוצה)
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fencedFetch(endpoint, "fleet.rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message || "rpc error");
    return json.result as T;
  } finally {
    clearTimeout(t);
  }
}

type ChainAuths = Record<string, { posting: string[]; active: string[]; memo: string } | undefined>;

export async function fleetProbe(force = false): Promise<void> {
  const rt = fleetInit();
  if (!rt.openedOk || rt.probing) return;
  if (!force && rt.probedAt && Date.now() - rt.probedAt < PROBE_TTL_MS) return;
  const names = [...rt.accounts.entries()].filter(([, a]) => !!a.postingWif).map(([n]) => n);
  if (names.length === 0) return;
  rt.probing = true;
  try {
    // איזושהי-צומת-Hive מהרשימה-המקובעת
    let auths: ChainAuths = {};
    for (const node of HIVE_NODES) {
      try {
        const res = await rpcJson<{ id: number; name: string; posting: { key_auths: [string, number][] }; memo_key: string }[]>(
          node, { jsonrpc: "2.0", method: "condenser_api.get_accounts", params: [names], id: 1 },
        );
        for (const a of res ?? []) {
          auths[a.name] = {
            posting: (a.posting?.key_auths ?? []).map((k) => k[0]),
            active: [],
            memo: a.memo_key,
          };
        }
        break;
      } catch { /* צומת-הבא */ }
    }
    for (const [name, acct] of rt.accounts) {
      if (!acct.postingWif) continue;
      const onChain = auths[name];
      acct.authorityOk = !!onChain && onChain.posting.includes(acct.postingPub);
      if (acct.authorityOk) {
        acct.rcEffective = await rcMana(HIVE_NODES[0], name);
      } else {
        acct.rcEffective = null;
      }
    }
    rt.probedAt = Date.now();
    const ok = names.filter((n) => rt.accounts.get(n)?.authorityOk).length;
    console.info(`[saos-fleet] probe: ${ok}/${names.length} accounts authority-verified on Hive (TTL ${PROBE_TTL_MS / 60000}min)`);
  } finally {
    rt.probing = false;
  }
}

/* ── בחירת-חשבון: סמכות-חיה + RC + breaker-פר-חשבון, סבב-על-המובילים ─────────── */
function usable(rt: FleetRT): { name: string; rc: number }[] {
  const now = Date.now();
  const out: { name: string; rc: number }[] = [];
  for (const [name, a] of rt.accounts) {
    if (!a.postingWif || a.authorityOk !== true) continue;
    if (a.rcEffective !== null && a.rcEffective < RC_MIN_FLEET) continue;
    if (a.failCount >= ACCT_BREAKER_TRIPS && a.lastFailAt && now - a.lastFailAt < ACCT_COOLDOWN_MS) continue;
    out.push({ name, rc: a.rcEffective ?? 0 });
  }
  return out.sort((x, y) => y.rc - x.rc);
}

/* ── חותם-צי: custom_json על-HIVE בסמכות-POSTING — אפס-עלות ───────────────────
 * SETTLE-17: המטען-פתוח-לשדות-נוספים (rail-milestone מוסיף netMu/equityMu/…)
 * — הכל-ציבורי, אפס-סודות-במטען. */
export type FleetAnchorPayload = {
  protocol: string; action: string; at: string; height: number; stateRoot: string; digest: string;
} & Record<string, unknown>;

export async function fleetSealNow(
  payload: FleetAnchorPayload,
): Promise<{ txid: string; account: string; block: number | null }> {
  const rt = fleetInit();
  if (!rt.openedOk) throw new Error(`fleet disabled: ${rt.openError ?? "vault unavailable"}`);
  await fleetProbe(false);
  const cands = usable(rt);
  if (cands.length === 0) throw new Error("fleet: no usable account (probe first — authority/RC/breaker)");
  let lastErr: Error | null = null;
  for (let i = 0; i < Math.min(MAX_ANCHOR_TRIES, cands.length); i++) {
    const sel = cands[(rt.rrIndex + i) % cands.length];
    const acct = rt.accounts.get(sel.name)!;
    try {
      const r = await grapheneSealBroadcast(HIVE_NODES[0], HIVE_CHAIN_ID, sel.name, payload, acct.postingWif, "posting");
      acct.anchoredCount += 1;
      acct.lastTxid = r.txid;
      acct.lastAnchorAt = new Date().toISOString();
      acct.failCount = 0;
      rt.rrIndex = (rt.rrIndex + i + 1) % Math.max(1, cands.length);
      return { txid: r.txid, account: sel.name, block: r.block };
    } catch (e) {
      lastErr = e as Error;
      acct.failCount += 1;
      acct.lastFailAt = Date.now();
    }
  }
  throw lastErr ?? new Error("fleet: anchor failed on all candidates");
}

/* ── מצב-ציבורי (אפס-סודות — ל-API/UI) ─────────────────────────────────────── */
export function fleetStatusPublic(): Record<string, unknown> {
  const rt = fleetInit();
  return {
    configured: rt.openedOk,
    openError: rt.openError,
    sealedAt: rt.sealedAt,
    probedAt: rt.probedAt ? new Date(rt.probedAt).toISOString() : null,
    probeStale: rt.probedAt === null || Date.now() - rt.probedAt > PROBE_TTL_MS,
    accounts: [...rt.accounts.entries()].map(([name, a]) => ({
      account: name,
      hasVerifiedKey: !!a.postingWif,
      authorityOk: a.authorityOk,
      rcEffective: a.rcEffective,
      rcOk: a.rcEffective !== null && a.rcEffective >= RC_MIN_FLEET,
      failCount: a.failCount,
      anchoredCount: a.anchoredCount,
      lastTxid: a.lastTxid,
      lastAnchorAt: a.lastAnchorAt,
      usable: !!a.postingWif && a.authorityOk === true && a.rcEffective !== null && a.rcEffective >= RC_MIN_FLEET
        && !(a.failCount >= ACCT_BREAKER_TRIPS && a.lastFailAt && Date.now() - a.lastFailAt < ACCT_COOLDOWN_MS),
    })),
    usableCount: usable(rt).length,
  };
}

/** עוגן-חוזה-מזהה-לרשומת-עיגון-ציבורית (סודות-אסורים — חתימה-כאן-במודול) */
export function fleetAnchorId(): string {
  return ANCHOR_ID;
}
