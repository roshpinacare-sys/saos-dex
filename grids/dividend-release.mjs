#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * DIVIDEND-RELEASE — מפעיל-הרגל-החוץ של ESC-11 (µ→STEEM→בעלים) · הקילומטר-האחרון
 * ───────────────────────────────────────────────────────────────────────────
 * המסילה-המלאה שנמדדה-חי (2026-10-20):
 *   1. owner-dividend (חשבון-פנימי) צובר-דיבידנד-מהסדולה (dividend-sweep — רווח-נמדד-בלבד)
 *   2. השחרור: העברת-STEEM-אמת-על-השרשרת (steem-voice /transfer · מפתח-ACTIVE-מהכספת
 *      · shim-noble-טהור אחרי-גילוי-מוות-ה-native-secp256k1-תחת-באן)
 *   3. אימות-בלתי-תלוי: trx_id-בהיסטוריית-החשבון (get_account_history) — לא-מספיק-
 *      להחזיר-id-מה-broadcast (נמדד: ה-id-המוחזר-אינו-ה-trx_id — האימות-חייב-שרשרת)
 *
 * קנרית-הוכחה-חתומה (2026-10-20 · אפס-תזוזת-כסף):
 *   txid b16ad0d907fcdfd420a410f8f2184b69d482bfae · block 110,592,155 · 0.001 STEEM
 *
 * שערים:
 *   R-1 · כנות: הריבונות-משדרת-רק-מהכספת-החיה; אין-כספת → fail-closed
 *   R-2 · תקרת-נזק: ≤1.000 STEEM-פר-שידור (steem-voice-T-2) · תהליך-אחד-לשעה (T-3)
 *   R-3 · נמען: לעולם-לא-מנוחש — חייב-כתובת-מפורשת (--to) או-שחרור-עצמי-מבוקר
 *   R-4 · LAW-1-מובן-נכון: headcorner-הוא-השמורת-הגשר-והחשבון-של-הבעלים-עצמו —
 *         דיבידנד-לבעלים-מהשמורת-אינו-"התחזות-מפעיל" אלא-המטרה-עצמה (צו-בעלים
 *         "המערכת-תייצר-עבור-עצמה-ועבורי"); פעולות-פנימיות-ממשיכות-לחתום-מ-treasury
 *   R-5 · אפס-סודות: הקבלות-מתעדות-txid/סכומים-בלבד
 *
 * ריצה:  node grids/dividend-release.mjs --check    → מדידה-בלבד (יתרות-והית-שחרור)
 *        node grids/dividend-release.mjs --canary   → קנרית 0.001-עצמית (+אימות-שרשרת)
 *        node grids/dividend-release.mjs --run --to NAME --steem AMOUNT
 * ═══════════════════════════════════════════════════════════════════════════ */
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, "state");
const RECEIPTS = join(STATE_DIR, "dividend-release.jsonl");
const VOICE = "http://127.0.0.1:3023";
const RPC = "https://api.steemit.com";

async function custodyTruth() {
  // מדידת-שמורת-אמת מול-RPC-ציבורי (אימות-בלתי-תלוי — לא-מהכספת)
  const r = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "condenser_api.get_accounts", params: [["headcorner"]] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`rpc-${r.status}`);
  const j = await r.json();
  const a = j?.result?.[0];
  if (!a) throw new Error("account-not-found");
  return { steem: a.balance, sbd: a.sbd_balance, vestingShares: a.vesting_shares };
}

async function ownerDividendMu() {
  const r = await fetch("http://127.0.0.1:3010/saos-dex/api/dex/wallets", { signal: AbortSignal.timeout(5000) });
  const d = await r.json();
  const list = d?.list ?? d?.wallets ?? [];
  const od = list.find((x) => x?.name === "owner-dividend");
  return Number(od?.balances?.USDS ?? 0);
}

async function chainVerify(txid) {
  // אימות-האמת: מציאת-txid-בהיסטוריה-עד-120-אירועים-אחרונים (שניות-מהשידור)
  const r = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "condenser_api.get_account_history", params: [["headcorner", -1, 120]] }),
    signal: AbortSignal.timeout(12_000),
  });
  const j = await r.json();
  for (const [, ev] of (j?.result ?? [])) {
    if (ev?.trx_id === txid) return { verified: true, block: ev.block, op: ev.op[0] };
  }
  return { verified: false };
}

async function canary() {
  const voice = await fetch(`${VOICE}/health`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).catch(() => null);
  if (!voice?.ok || !String(voice?.activeKey ?? "").includes("חי")) throw new Error("steem-voice fail-closed (R-1)");
  const r = await fetch(`${VOICE}/transfer`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: "headcorner", amount: "0.001 STEEM", memo: "ESC-11 rail canary | SAOS sovereign dividend lane | zero-value self-transfer proof" }),
    signal: AbortSignal.timeout(30_000),
  });
  const res = await r.json();
  if (!res?.ok) return { verdict: "CANARY-FAILED", why: res?.error ?? "unknown" };
  await new Promise((x) => setTimeout(x, 4500)); // בלוק-STEEM ≈3ש׳
  const v = await chainVerify(res.txid);
  return { verdict: v.verified ? "CANARY-PROVEN" : "CANARY-BROADCASTED-UNCONFIRMED", txid: res.txid, ...v };
}

async function main() {
  const args = process.argv.slice(2);
  const out = { schema: "SAOS-DIVIDEND-RELEASE/1", at: new Date().toISOString() };
  try { out.custody = await custodyTruth(); } catch (e) { out.custody = { error: String(e).slice(0, 120) }; }
  try { out.ownerDividendMu = await ownerDividendMu(); } catch (e) { out.ownerDividendMu = null; }

  if (args.includes("--check")) {
    out.verdict = "CHECK";
    out.note = "המסילה-מוכחת-בקנרית-חתומה; שחרור-דיבידנד-אמת-ממתין-לנמען-מפורש (--to) — R-3";
  } else if (args.includes("--canary")) {
    Object.assign(out, await canary());
  } else if (args.includes("--run")) {
    const to = args[args.indexOf("--to") + 1];
    const steem = args[args.indexOf("--steem") + 1];
    if (!to || !/^[a-z0-9][a-z0-9.-]{1,15}$/.test(to)) throw new Error("R-3: נמען-חייב-מפורש (--to)");
    if (!steem) throw new Error("--steem נדרש (X.XXX STEEM)");
    const r = await fetch(`${VOICE}/transfer`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, amount: steem, memo: `SAOS sovereign dividend · owner-dividend ${out.ownerDividendMu}µ internal · ESC-11` }),
      signal: AbortSignal.timeout(30_000),
    });
    const res = await r.json();
    if (!res?.ok) return finish({ ...out, verdict: "RUN-FAILED", why: res?.error });
    await new Promise((x) => setTimeout(x, 4500));
    const v = await chainVerify(res.txid);
    Object.assign(out, { verdict: v.verified ? "RELEASED-AND-VERIFIED" : "BROADCASTED-UNCONFIRMED", txid: res.txid, to, amount: steem, ...v });
  } else {
    out.verdict = "NO-MODE (use --check | --canary | --run)";
  }
  finish(out);
}
function finish(out) {
  try { mkdirSync(STATE_DIR, { recursive: true }); appendFileSync(RECEIPTS, JSON.stringify(out) + "\n"); } catch { /* כנה */ }
  console.log(JSON.stringify(out, null, 1));
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
