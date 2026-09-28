// MOVER — מבצע-ההצעה (A-5 · fleet/r130): offer.json → פקודות-אמת על ספר-STEEM
// ═══════════════════════════════════════════════════════════════════════════
// החוליה האחרונה בלולאה: grids(sim) → peg(הצעה) → **mover(ביצוע)** → שרשרת(אמת)
//
// דוקטרינת-חתימה (R81 + Task-62 שהוכח-חי: txid b269647e…):
//   · המנוע מציע — המוביל חותם. אפס-מפתחות בגיט: המקור-הריבוני נזין
//     בזמן-ריצה בלבד (MASTER_SOURCE_PATH), נגזר בזיכרון-התהליך, לעולם לא
//     נכתב לדיסק, ללוג או לקבלה.
//   · גזירת-הרשויות (R10 מדוד): סיסמת-האב הראשונה במקור →
//     sha256(account+role+password) → נקודה-פרטית → WIF-לא-דחוס (0x80+priv32)
//     — בדיוק כמו steem-js toWif; צ'קסאם-פומבי = ripemd160(pub) ישיר (לא
//     כפול-גרפן — R10: 47/53 תווים משותפים והזנב סוטה).
//   · verify-then-write: נגזר → מוצלב מול הרשויות-החיות של השרשרת → רק
//     התאמה-מלאה של active מתירה חתימה. אי-התאמה = יציאה-כנה, אפס-שידור.
//   · סדר-הביצוע של grid-beat (R24): ביטול-פקודות-פתוחות → פריסת-הסולם
//     מההצעה. orderid = YYYYMMDD×100+seq. סכומים בדיוק-3-ספרות.
//   · מצב-additive (--additive · T-6): פריסה בלי-ביטול — להצעה שחושבה
//     מול-הנזיל-הפנוי בזמן שמוביל-אח (money-mover v1.9.0) מחזיק כבר את
//     הסולם. לא-נוגעים בפקודות-אחרות, מדלגים על orderid-תפוסים, ובדיקת-
//     קדם: נזיל-חי ≥ סכום-התוכנית (fail-closed).
//   · ביצוע-פר-צד ב-additive (D-022 · T-7): הצעה-חסומה-חלקית לא עוצרת את
//     הצד-הפתוח — רק-מצב-רענון דורש OFFER-READY מלא (שלמות-סולם). ב-additive
//     הבטיחות היא שערי-הרמה-עצמם: אכיפת-פאריטי פר-רמה + קדם-נזיל-חי פר-סכום
//     + טריות-פאריטי. צד-ריק = דילוג-כנה; שני-צדדים-ריקים = אפס-פעולה-כנה.
//   · שערי-הגנה טרם-כל-שידור: ההצעה ok, פאריטי-בתוך-הרצועה (מדידה-טרייה),
//     RC-דלק חי, אין-מכירה-מתחת-לפאריטי (אכיפה-עצמית על כל-רמה).
//   · ראיות: כל-txid נרשם ל-mover-log.jsonl (פומבי לחלוטין) + אירוע
//     offer.executed ביומן-רשת-הטריגרים — דבר-גורר-דבר באמת.

import { writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import crypto from "node:crypto";
import bs58 from "bs58";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ripemd160 } from "@noble/hashes/ripemd160";
import steem from "steem";
import { appendEvent } from "./events.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVENTS_LOG = join(HERE, "state", "events.jsonl");
const OFFER_PATH = join(HERE, "state", "offer.json");
const MOVER_LOG = join(HERE, "state", "mover-log.jsonl");

const STEEM_NODES = ["https://api.steemit.com", "https://api.justyy.com", "https://steem-rpc.publicnode.com"];
const STEEM_CHAIN_ID = "0".repeat(64);
const ACCOUNT = process.env.SAOS_RELAY_AGENT_ACCOUNT || "headcorner";
const PARITY_BAND_BPS = 5000;
const RC_MIN = 1e9; // דלק-מינימלי לאומדן-פעולה (fail-closed מתחת לזה)

const num = (s) => (s ? parseFloat(String(s).replace(/[A-Za-z ]+/g, "")) : 0);
const dp3 = (v) => Math.floor(v * 1000) / 1000;

/* ── גזירת-המפתח (R10 מדוד — זהה ל-steem-rearm.ts של הפלטפורמה) ─────────── */
const privToPub = (priv) => {
  const pub = Buffer.from(secp256k1.getPublicKey(priv, true));
  const chk = Buffer.from(ripemd160(pub)).subarray(0, 4); // ישיר — לא כפול-גרפן
  return "STM" + bs58.encode(Buffer.concat([pub, chk]));
};
const privToWif = (priv) => {
  const body = Buffer.concat([Buffer.from([0x80]), priv]);
  const chk = crypto.createHash("sha256").update(crypto.createHash("sha256").update(body).digest()).digest().subarray(0, 4);
  return bs58.encode(Buffer.concat([body, chk]));
};
const extractMasterPasswords = (content) =>
  [...new Set([...content.matchAll(/\bP[57][1-9A-HJ-NP-Za-km-z]{48,50}\b/g)].map((m) => m[0]))];

function deriveActiveWif(masterSource) {
  const candidates = extractMasterPasswords(masterSource);
  if (candidates.length === 0) throw new Error("no master-password candidates in source (fail-closed)");
  return { candidates, privFor: (role, password) => Buffer.from(crypto.createHash("sha256").update(`${ACCOUNT}${role}${password}`).digest()) };
}

/* ── RPC (אותם-צמתים של realmarket, fail-כנה) ────────────────────────────── */
async function rpcAny(method, params) {
  const errs = [];
  for (const node of STEEM_NODES) {
    try {
      const r = await fetch(node, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(String(j.error.message ?? "rpc-error").slice(0, 80));
      return j.result;
    } catch (e) {
      errs.push(`${new URL(node).host}: ${String(e.message ?? e).slice(0, 60)}`);
    }
  }
  throw new Error(`all-steem-nodes-failed · ${errs.join(" | ")}`);
}

/* ── חתימה-ושידור (אותו-נתיב מוכח-חי של realmarket.signAndBroadcast) ────── */
async function signAndBroadcast(wif, ops) {
  const dgp = await rpcAny("condenser_api.get_dynamic_global_properties", []);
  const tx = {
    ref_block_num: Number(dgp.head_block_number) & 0xffff,
    ref_block_prefix: Buffer.from(String(dgp.head_block_id), "hex").readUInt32LE(4),
    expiration: new Date(new Date(String(dgp.time) + "Z").getTime() + 60_000).toISOString().slice(0, 19),
    operations: ops,
    extensions: [],
  };
  const prev = steem.config.get("chain_id");
  steem.config.set("chain_id", STEEM_CHAIN_ID);
  let signed;
  try {
    signed = steem.auth.signTransaction(tx, [wif]); // WARN-33B קוסמטי — הסקלר נכון
  } finally {
    try { steem.config.set("chain_id", prev ?? STEEM_CHAIN_ID); } catch { /* keep */ }
  }
  const res = await rpcAny("condenser_api.broadcast_transaction_synchronous", [{ ...signed }]);
  if (!res?.id) throw new Error("broadcast answered without id (honest)");
  return { txid: res.id, block: res.block_num ?? null };
}

/* ── מדידות-שער ───────────────────────────────────────────────────────────── */
async function freshParity() {
  const jget = async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "grids-mover" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  let steemUsd = null, sbdUsd = null;
  for (let i = 0; i < 2 && steemUsd == null; i++) {
    try { const j = await jget("https://api.binance.com/api/v3/ticker/price?symbol=STEEMUSDT"); if (Number(j.price) > 0) steemUsd = Number(j.price); } catch {}
  }
  try { const j = await jget("https://api.coingecko.com/api/v3/simple/price?ids=steem,steem-dollars&vs_currencies=usd"); if (steemUsd == null && j?.steem?.usd > 0) steemUsd = j.steem.usd; if (j?.["steem-dollars"]?.usd > 0) sbdUsd = j["steem-dollars"].usd; } catch {}
  if (steemUsd == null || sbdUsd == null) {
    try { const m = await jget("https://roshpinacare-sys.github.io/Console/dex/money.json"); if (steemUsd == null && m?.marks?.steemUsd > 0) steemUsd = m.marks.steemUsd; if (sbdUsd == null && m?.marks?.sbdUsd > 0) sbdUsd = m.marks.sbdUsd; } catch {}
  }
  return steemUsd != null && sbdUsd != null && sbdUsd > 0 ? steemUsd / sbdUsd : null;
}

/* ═══ הריצה ═════════════════════════════════════════════════════════════════ */
export async function runMover({ dryRun = false, additive = false } = {}) {
  const evidence = { at: new Date().toISOString(), account: ACCOUNT, mode: additive ? "additive" : "refresh", cancelled: [], placed: [], blockers: [] };

  /* 1. המקור-הריבוני (זמן-ריצה בלבד) */
  const srcPath = process.env.MASTER_SOURCE_PATH || "/tmp/keystation/live-agent/keys/hed-soldiers-source.txt";
  if (!existsSync(srcPath)) throw new Error(`master source missing at ${srcPath} (fail-closed)`);
  const { candidates, privFor } = deriveActiveWif(readFileSync(srcPath, "utf8"));

  /* 2. הצלבה מול הרשויות-החיות — רק התאמה-מלאה של active מתירה המשך */
  const acc = (await rpcAny("condenser_api.get_accounts", [[ACCOUNT]]))?.[0];
  if (!acc) throw new Error("account absent from live chain (fail-closed)");
  const liveActive = acc.active?.key_auths?.[0]?.[0];
  const liveWif = (() => {
    for (const pw of candidates) {
      const wif = privToWif(privFor("active", pw));
      if (privToPub(privFor("active", pw)) === liveActive) return wif;
    }
    return null;
  })();
  if (!liveWif) throw new Error("no sealed master derives the LIVE active authority — refusing to sign (fail-closed)");

  /* 3. RC-דלק */
  const rc = await rpcAny("rc_api.find_rc_accounts", { accounts: [ACCOUNT] }).catch(() => null);
  const rcNow = Number(rc?.rc_accounts?.[0]?.rc_manabar?.current_mana ?? 0);
  if (rcNow < RC_MIN) throw new Error(`RC fuel below floor: ${rcNow} < ${RC_MIN} (fail-closed)`);

  /* 4. ההצעה — טרייה ותקינה
     רענון: OFFER-READY מלא (שלמות-סולם אטומית).
     additive (D-022): מספיק צד-אחד מתוכנן — שערי-הרמה והנזיל אוכפים את-השאר. */
  if (!existsSync(OFFER_PATH)) throw new Error("offer.json missing — run grids/peg.mjs first");
  const offer = JSON.parse(readFileSync(OFFER_PATH, "utf8"));
  const planAskCount = (offer.plan?.asks ?? []).length;
  const planBidCount = (offer.plan?.bids ?? []).length;
  if (additive) {
    if (planAskCount + planBidCount === 0) {
      evidence.blockers.push("additive: both sides empty in plan — honest no-op, nothing placed");
      return evidence;
    }
  } else if (!offer.ok || offer.verdict !== "OFFER-READY") {
    throw new Error(`offer not executable: ${offer.verdict} · ${offer.blocker ?? ""}`);
  }
  const parity = await freshParity();
  if (parity == null) throw new Error("fresh parity unavailable — no marking, no trading (fail-closed)");
  const offerParity = offer.fair?.externalParity;
  const driftBps = offerParity > 0 ? Math.floor(((parity - offerParity) / offerParity) * 10000) : Infinity;
  if (Math.abs(driftBps) > 300) throw new Error(`offer parity drifted ${driftBps}bps from fresh marks — regenerate the offer (honest)`);
  if (Math.abs(offer.parityBps ?? 0) > PARITY_BAND_BPS) throw new Error("offer parity outside band — refusing (fail-closed)");

  /* 5. ביטול-פקודות-פתוחות (רענון אטומי של grid-beat R24)
     מצב-additive: אף-ביטול — הסולם-הקיים (של-מוביל-אח) נשאר בעבודה. */
  const openRaw = await rpcAny("condenser_api.get_open_orders", [ACCOUNT]).catch(() => []);
  const takenIds = new Set((openRaw ?? []).map((o) => Number(o.orderid)));
  if (additive) {
    evidence.cancelled.push({ skipped: "additive-mode — sibling ladder untouched", openOrders: (openRaw ?? []).length });
  } else {
    for (const o of openRaw ?? []) {
      if (dryRun) { evidence.cancelled.push({ id: o.orderid, dryRun: true }); continue; }
      try {
        const r = await signAndBroadcast(liveWif, [["limit_order_cancel", { owner: ACCOUNT, orderid: o.orderid }]]);
        evidence.cancelled.push({ id: o.orderid, txid: r.txid });
      } catch (e) {
        evidence.cancelled.push({ id: o.orderid, error: String(e.message ?? e).slice(0, 80) });
      }
    }
  }

  /* 5b. בדיקת-קדם-additive: הנזיל-החי חייב לכסות את סכום-התוכנית
     (ההצעה נמדדה נגד-נזיל — אם הוא קטן מאז, ידיים-בכיס בכנות). */
  if (additive) {
    const wantSteem = (offer.plan.asks ?? []).reduce((s, a) => s + a.sizeSteem, 0);
    const wantSbd = (offer.plan.bids ?? []).reduce((s, b) => s + (b.spendSbd ?? 0), 0);
    const liqSteem = num(acc.balance), liqSbd = num(acc.sbd_balance);
    if (liqSteem < wantSteem - 1e-9 || liqSbd < wantSbd - 1e-9) {
      throw new Error(`additive pre-flight: plan needs ${wantSteem.toFixed(3)} STEEM/${wantSbd.toFixed(3)} SBD, live liquid ${liqSteem.toFixed(3)}/${liqSbd.toFixed(3)} — refusing (fail-closed)`);
    }
  }

  /* 6. פריסת-הסולם מההצעה — אכיפה-עצמית של דוקטרינת-הפאריטי בכל-רמה */
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  let seq = 1;
  const nextId = () => {
    let id = Number(today) * 100 + seq++;
    while (takenIds.has(id)) id = Number(today) * 100 + seq++; // additive: לא לדרוך על פקודות-חיות
    return id;
  };
  const expiry = Math.floor(Date.now() / 1000) + 27 * 86_400;

  for (const a of offer.plan.asks ?? []) {
    const px = a.priceSbdPerSteem;
    if (px < parity) { evidence.placed.push({ level: a.level, side: "ask", blocked: `price ${px} < parity ${parity.toFixed(6)} — never sell below external value` }); continue; }
    const sell = dp3(a.sizeSteem), recv = dp3(a.sizeSteem * px);
    if (sell <= 0 || recv <= 0) continue;
    const id = nextId();
    if (dryRun) { evidence.placed.push({ id, side: "ask", sell: `${sell.toFixed(3)} STEEM`, receive: `${recv.toFixed(3)} SBD`, price: px, dryRun: true }); continue; }
    try {
      const r = await signAndBroadcast(liveWif, [["limit_order_create", { owner: ACCOUNT, orderid: id, amount_to_sell: `${sell.toFixed(3)} STEEM`, min_to_receive: `${recv.toFixed(3)} SBD`, fill_or_kill: false, expiration: new Date(expiry * 1000).toISOString().slice(0, 19) }]]);
      evidence.placed.push({ id, side: "ask", sell: `${sell.toFixed(3)} STEEM`, receive: `${recv.toFixed(3)} SBD`, price: px, txid: r.txid, block: r.block });
    } catch (e) {
      evidence.placed.push({ id, side: "ask", error: String(e.message ?? e).slice(0, 80) });
    }
  }
  for (const b of offer.plan.bids ?? []) {
    const px = b.priceSbdPerSteem;
    if (px > parity) { evidence.placed.push({ level: b.level, side: "bid", blocked: `price ${px} > parity ${parity.toFixed(6)} — never pay above external value` }); continue; }
    const spend = dp3(b.spendSbd), recv = dp3(b.sizeSteem);
    if (spend <= 0 || recv <= 0) continue;
    const id = nextId();
    if (dryRun) { evidence.placed.push({ id, side: "bid", sell: `${spend.toFixed(3)} SBD`, receive: `${recv.toFixed(3)} STEEM`, price: px, dryRun: true }); continue; }
    try {
      const r = await signAndBroadcast(liveWif, [["limit_order_create", { owner: ACCOUNT, orderid: id, amount_to_sell: `${spend.toFixed(3)} SBD`, min_to_receive: `${recv.toFixed(3)} STEEM`, fill_or_kill: false, expiration: new Date(expiry * 1000).toISOString().slice(0, 19) }]]);
      evidence.placed.push({ id, side: "bid", sell: `${spend.toFixed(3)} SBD`, receive: `${recv.toFixed(3)} STEEM`, price: px, txid: r.txid, block: r.block });
    } catch (e) {
      evidence.placed.push({ id, side: "bid", error: String(e.message ?? e).slice(0, 80) });
    }
  }

  /* 7. ראיות-פומביות בלבד + אירוע-לולאה */
  evidence.summary = { cancelled: evidence.cancelled.filter((c) => c.txid).length, placed: evidence.placed.filter((p) => p.txid).length, failed: evidence.placed.filter((p) => p.error).length, blocked: evidence.placed.filter((p) => p.blocked).length };
  appendFileSync(MOVER_LOG, JSON.stringify(evidence) + "\n");
  appendEvent(EVENTS_LOG, { type: "offer.executed", source: "mover", sim: false, payload: { ...evidence.summary, parity: Math.round(parity * 1e6) / 1e6 } });
  return evidence;
}

/* CLI: node grids/mover.mjs [--dry-run] [--additive] */
if (process.argv[1] && process.argv[1].endsWith("mover.mjs")) {
  const dry = process.argv.includes("--dry-run");
  const additive = process.argv.includes("--additive");
  try {
    const ev = await runMover({ dryRun: dry, additive });
    console.log(`[mover${dry ? " · dry" : ""}] cancelled=${ev.summary.cancelled} placed=${ev.summary.placed} failed=${ev.summary.failed} blocked=${ev.summary.blocked}`);
    for (const p of ev.placed.filter((x) => x.txid)) console.log(`  ✓ #${p.id} ${p.side}: ${p.sell} → ${p.receive} @${p.price} · tx ${String(p.txid).slice(0, 14)}…`);
    for (const p of ev.placed.filter((x) => x.error)) console.log(`  ✗ #${p.id ?? "?"} ${p.side}: ${p.error}`);
    for (const p of ev.placed.filter((x) => x.blocked)) console.log(`  ⛔ ${p.blocked}`);
  } catch (e) {
    console.error(`[mover] refused honestly: ${String(e.message ?? e).slice(0, 140)}`);
    process.exit(2);
  }
}
