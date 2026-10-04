// CUSTODY (Z-89 · directive element #5) — שכבת-האמת של החזקות-רב-שרשרת
// ═══════════════════════════════════════════════════════════════════════════
// החוק: כל-שורה-שהיא מדידה-חיה-מקורית (קבלה) או שורה-כנה של "נעדר/לא-ניתן-למדידה"
// בלי-המצאה. בעלות נקבעת על-ידי השוואת-רשויות-מפתח ציבוריות בין-השרשרות:
// אם-החשבון-בשרשרת-אחרת נושא את-אותם-מפתחות-ציבוריים בדיוק כמו חשבון-הצי
// החתום-והמוכח — הבעלות מאומתת (key-controlled), בלי-קריאת-סודות ובלי-חתימה.
// CEX: אין-מפתחות → שורה-כנה "לא-ניתן-למדידה — rail לא-חמוש" (חוק-אפס-סודות).
// המודול הזה: plan/measure-only — אינו חותם על-שום-דבר, כמו שאר קו-הסריקה.

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ACCOUNT, rpcAny, num, dp3 } from "./mover.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, "state");
const CUSTODY_PATH = join(STATE_DIR, "custody.json");

export const CUSTODY_SCHEMA = "custody-v1";

export const CUSTODY_NODES = {
  steem: ["https://api.steemit.com", "https://api.steem.fans"],
  hive: ["https://api.hive.blog", "https://api.deathwing.me"],
  blurt: ["https://blurt-rpc.saboin.com", "https://rpc.blurt.blog"],
};

/** מחשבון-טהור: מפתחות-ציבוריים משתי-רשויות — זהות-גוף-מפתח (בלי-קידומת-שרשרת). */
export function stripKeyPrefix(k) {
  return String(k ?? "").replace(/^(STM|TST|BLT|BRT)/, "");
}

export function authorityMatch(authA, authB) {
  const norm = (a) => (a ?? []).map((x) => stripKeyPrefix(Array.isArray(x) ? x[0] : x)).filter((k) => k.length > 0).sort();
  const A = norm(authA), B = norm(authB);
  if (A.length === 0 || B.length === 0) return false;
  return A.length === B.length && A.every((k, i) => k === B[i]);
}

/** בעלות-מאומתת: active ו-owner זהים-בדיוק מול-חשבון-העוגן-החתום-של-הצי. */
export function ownershipVerdict({ anchorActive, anchorOwner, candActive, candOwner }) {
  const active = authorityMatch(anchorActive, candActive);
  const owner = authorityMatch(anchorOwner, candOwner);
  if (active && owner) return "verified-key-controlled";
  if (active || owner) return "partial-match-unverified";
  return "name-match-unverified";
}

/** וקטור-טהור: שורת-חזקה אחת. אפס-המצאה: מה-שנמדד — כתוב; מה-שלא — נעדר. */
export function custodyRow({ chain, venue, asset, amount = null, ownership = null, realness = null, source = null, note = null }) {
  return { chain, venue, asset, amount, ownership, realness, source, note };
}

/** ההרכבה-הטהורה: מהמדידות-הגולמיות לפנקס custody-v1. */
export function buildCustodyInventory({ anchor = {}, blurt = {}, hive = {}, cex = {}, nowIso = null } = {}) {
  const rows = [];
  // STEEM — חשבון-העוגן (נשלט-וחתום-על-ידי-הצי; רשויות-המפתח-שלו = המקור-לאימות)
  if (anchor.account) {
    rows.push(custodyRow({
      chain: "steem", venue: "chain-liquid", asset: "STEEM",
      amount: anchor.liquidSteem ?? null, ownership: "anchor (fleet-signed)",
      realness: "ONCHAIN_REAL", source: anchor.source ?? "condenser_api.get_accounts",
    }));
    rows.push(custodyRow({
      chain: "steem", venue: "chain-liquid", asset: "SBD",
      amount: anchor.liquidSbd ?? null, ownership: "anchor (fleet-signed)",
      realness: "ONCHAIN_REAL", source: anchor.source ?? "condenser_api.get_accounts",
    }));
    rows.push(custodyRow({
      chain: "steem", venue: "chain-locked", asset: "SBD-IN-CONVERT",
      amount: anchor.pendingSbd ?? null, ownership: "anchor (fleet-signed)",
      realness: "ONCHAIN_REAL", source: "condenser_api.get_conversion_requests",
      note: "matures 2026-10-06→10-07; payout estimate lives in convert-plan.json maturityEstimate",
    }));
    if (anchor.vests != null) {
      rows.push(custodyRow({
        chain: "steem", venue: "chain-vests", asset: "VESTS",
        amount: anchor.vests, ownership: "anchor (fleet-signed)",
        realness: "ONCHAIN_REAL", source: "condenser_api.get_accounts",
      }));
    }
  } else {
    rows.push(custodyRow({ chain: "steem", venue: "chain-liquid", asset: "STEEM", amount: null, ownership: null, realness: "ABSENT", source: "anchor account unmeasured — fail-closed row", note: "no invention" }));
  }
  // BLURT — בעלות-נקבעת-על-ידי-השוואת-רשויות-מול-העוגן (keyless verification)
  if (blurt.account) {
    rows.push(custodyRow({
      chain: "blurt", venue: "chain-liquid", asset: "BLURT",
      amount: blurt.liquidBlurt ?? null, ownership: blurt.ownership ?? "name-match-unverified",
      realness: "ONCHAIN_REAL", source: blurt.source ?? "condenser_api.get_accounts @blurt",
      note: blurt.note ?? null,
    }));
    if (blurt.vests != null) {
      rows.push(custodyRow({
        chain: "blurt", venue: "chain-vests", asset: "VESTS",
        amount: blurt.vests, ownership: blurt.ownership ?? "name-match-unverified",
        realness: "ONCHAIN_REAL", source: blurt.source ?? "condenser_api.get_accounts @blurt",
      }));
    }
  } else {
    rows.push(custodyRow({ chain: "blurt", venue: "chain-liquid", asset: "BLURT", amount: null, ownership: null, realness: "ABSENT", source: "blurt account unmeasured — fail-closed row", note: "no invention" }));
  }
  // HIVE — שם-קיים-אך-המפתחות-שונים → לא-נספר-כחזקה (אפס-המצאה)
  if (hive.account) {
    rows.push(custodyRow({
      chain: "hive", venue: "chain-liquid", asset: "HIVE",
      amount: hive.liquidHive ?? null, ownership: hive.ownership ?? "name-match-unverified",
      realness: "ONCHAIN_REAL", source: hive.source ?? "condenser_api.get_accounts @hive",
      note: hive.note ?? "name exists on-chain; authorities differ from the fleet anchor — NOT counted as fleet custody",
    }));
  }
  // CEX — אין-מפתחות, אפס-סודות: לא-ניתן-למדידה
  rows.push(custodyRow({
    chain: "cex", venue: "htx/binance", asset: "STEEM/HIVE/SBD",
    amount: null, ownership: null, realness: "UNMEASURABLE-NO-RAIL",
    source: cex.source ?? "no API key held (zero-secrets law) — balances unmeasurable without owner rail",
    note: "rail-readiness measured 2026-10-04: HTX steem deposit/withdraw ALLOWED, withdraw fee 0.01 STEEM, min 4, memo required",
  }));
  // ENGINE (L2) — אין-חשבון-צי-מזוהה → שורה-כנה
  rows.push(custodyRow({
    chain: "hive-engine", venue: "L2", asset: "SWAP.HIVE/SWAP.BLURT",
    amount: null, ownership: null, realness: "ABSENT",
    source: "no fleet Engine holdings measured — bridge-in path exists (1:1 measured evidence, see venues/blurt-quote.mjs)",
  }));

  return {
    schema: CUSTODY_SCHEMA,
    at: nowIso,
    account: anchor.account ?? null,
    rows,
    counts: {
      onchainReal: rows.filter((r) => r.realness === "ONCHAIN_REAL").length,
      absent: rows.filter((r) => r.realness === "ABSENT").length,
      unmeasurable: rows.filter((r) => r.realness === "UNMEASURABLE-NO-RAIL").length,
    },
    law: "measure-only custody truth — every row is a live receipt or an honest absence; ownership via public key-authority match, zero secrets",
  };
}

/* ── מדידה-חיה keyless ───────────────────────────────────────────────────── */
async function qChain(hosts, method, params) {
  let lastErr = "unreachable";
  for (const host of hosts) {
    try {
      const r = await fetch(host, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }) });
      const j = await r.json();
      if (j?.result) return { ok: true, result: j.result };
      lastErr = JSON.stringify(j?.error ?? "empty").slice(0, 90);
    } catch (e) { lastErr = String(e?.message ?? e).slice(0, 90); }
  }
  return { ok: false, error: lastErr };
}

export async function runCustody({ nowIso = null } = {}) {
  const at = nowIso ?? new Date().toISOString();
  // anchor: STEEM headcorner
  const steem = await qChain(CUSTODY_NODES.steem, "condenser_api.get_accounts", [[ACCOUNT]]).catch(() => ({ ok: false }));
  const anchorAcc = steem.ok ? steem.result?.[0] : null;
  // pending convert (שקל-נעול — חלק-מהחזקה)
  let pendingSbd = null;
  try {
    const cv = await rpcAny("condenser_api.get_conversion_requests", [ACCOUNT]);
    pendingSbd = dp3((Array.isArray(cv) ? cv : []).reduce((s, r) => s + num(r?.amount), 0));
  } catch { pendingSbd = null; }
  const anchor = anchorAcc ? {
    account: ACCOUNT,
    liquidSteem: num(anchorAcc.balance), liquidSbd: num(anchorAcc.sbd_balance), vests: anchorAcc.vesting_shares,
    activeAuth: anchorAcc.active?.key_auths ?? [], ownerAuth: anchorAcc.owner?.key_auths ?? [],
    source: "condenser_api.get_accounts @steem",
  } : { account: null };

  // BLURT headcorner
  const blurt = await qChain(CUSTODY_NODES.blurt, "condenser_api.get_accounts", [[ACCOUNT]]).catch(() => ({ ok: false }));
  const blurtAcc = blurt.ok ? blurt.result?.[0] : null;
  let blurtRow = { account: null };
  if (blurtAcc) {
    const verdict = ownershipVerdict({
      anchorActive: anchor.activeAuth ?? [], anchorOwner: anchor.ownerAuth ?? [],
      candActive: blurtAcc.active?.key_auths ?? [], candOwner: blurtAcc.owner?.key_auths ?? [],
    });
    blurtRow = {
      account: ACCOUNT, liquidBlurt: num(blurtAcc.balance), vests: blurtAcc.vesting_shares,
      ownership: verdict,
      note: verdict === "verified-key-controlled"
        ? "authorities byte-identical to the fleet-signed STEEM anchor — same controller, zero secrets touched"
        : "authorities differ / partial — NOT counted as verified custody",
      source: "condenser_api.get_accounts @blurt (blurt-rpc.saboin.com) + authority match vs anchor",
    };
  }

  // HIVE headcorner (שם-קיים-במדידה; הרשויות-שונות → לא-נספר)
  const hive = await qChain(CUSTODY_NODES.hive, "condenser_api.get_accounts", [[ACCOUNT]]).catch(() => ({ ok: false }));
  const hiveAcc = hive.ok ? hive.result?.[0] : null;
  let hiveRow = { account: null };
  if (hiveAcc) {
    const verdict = ownershipVerdict({
      anchorActive: anchor.activeAuth ?? [], anchorOwner: anchor.ownerAuth ?? [],
      candActive: hiveAcc.active?.key_auths ?? [], candOwner: hiveAcc.owner?.key_auths ?? [],
    });
    hiveRow = {
      account: ACCOUNT, liquidHive: num(hiveAcc.balance), hbd: num(hiveAcc.hbd_balance),
      ownership: verdict,
      note: "name exists on-chain; authorities " + (verdict === "verified-key-controlled" ? "MATCH" : "DIFFER from the fleet anchor — NOT counted as fleet custody"),
      source: "condenser_api.get_accounts @hive (api.hive.blog) + authority match vs anchor",
    };
  }

  const inv = buildCustodyInventory({
    anchor: anchor.account ? { account: anchor.account, liquidSteem: anchor.liquidSteem, liquidSbd: anchor.liquidSbd, vests: anchor.vests, pendingSbd, source: anchor.source } : {},
    blurt: blurtRow.account ? blurtRow : {},
    hive: hiveRow.account ? hiveRow : {},
    nowIso: at,
  });
  return inv;
}

export function persistCustody(inv) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    if (!existsSync(STATE_DIR)) throw new Error("state dir unavailable");
    writeFileSync(CUSTODY_PATH, JSON.stringify(inv, null, 1) + "\n");
    return true;
  } catch { return false; }
}

/* ── CLI: node grids/custody.mjs ─────────────────────────────────────────── */
if (process.argv[1] && process.argv[1].endsWith("custody.mjs") && !process.argv.includes("--selftest")) {
  const inv = await runCustody();
  persistCustody(inv);
  console.log(JSON.stringify({ schema: inv.schema, at: inv.at, counts: inv.counts, rows: inv.rows.map((r) => `${r.chain}/${r.asset}=${r.amount ?? "null"} (${r.ownership ?? "-"})`) }, null, 1));
}
