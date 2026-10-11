// LIQUIDITY-BOOTSTRAP — מסילת-הזרקת-נזילות לספרים (9-c · 2026-10-11 · owner mandate trace 1a12b258c9776305)
// ════════════════════════════════════════════════════════════════════════════════════════
// המטרה: להגיע לעומק-יעד של הספר מתוך-המלאי הקיים — דלתא-בלבד מול השרשרת,
// אידמפוטנטי לחלוטין (ריצה-כפולה = אפס-אופים), קבלות-פר-אופ. זו מסילת-בת
// של lane=grid (אותו-חוק-ספר: אף-אסק מתחת לקו-הזהות, אף-ביד מעל המגע).
//
// בטיחות — כל-השכבות חייבות לעמוד; כל-כשל = יציאה-כנה בלי-נגיעה:
//   1. STASIS: stasisHalt("liquidity-bootstrap") — מסילת-grid חייבת להיות פתוחה
//      (mode=staged + stagedLanes.allow, או full-lift).
//   2. קובץ-חימוש של-הבעלים בלבד: grids/liquidity-arm.json (SAOS-LIQUIDITY-ARM/1).
//      קובץ-חסר = סירוב-כנה עם exit 0 (הסירוב הוא ההצלחה-על-פי-תכנון).
//      קובץ-פגום/פרוטוקול-זר/שדה-זר = exit 2 (fail-closed).
//   3. פרמטרים-מאומתים בלבד: grids/state/grid-params.json דרך grids/validate-params.mjs —
//      פרמטרים-רעים לעולם לא מדורגים לספר (exit 2).
//   4. מפתח-מאומת-מול-הרשות-החיה: STEEM_ACTIVE_WIF חייב לגזר בדיוק את רשות-ה-active
//      החיה של ACCOUNT (grids/key-gate.mjs — אותו-משטר של delegate-plan/community.mjs)
//      — רק לפני-שידור-אמת. אי-התאמה = exit 1, אפס-שידורים.
//   5. קריאה-לפני-כתיבה: הספר והפקודות-הפתוחות נמדדים טריים; דלתא בלבד — רמה-שקיימת
//      (מחיר-בטווח-סובלנות וגודל-בטווח 2%) מדולגת. לעולם לא מבטלים כאן (זה תפקיד
//      הרענון-האטומי של grid-beat); המסילה רק מוסיפה.
//   6. קריאה-אחרי-כתיבה: אחרי כל שידור — get_open_orders חייב להראות את ה-orderid;
//      אי-התאמה = עצירה fail-closed + רשום בקבלה.
//   7. תקרת-אופים: arm.maxOpsPerRun (1..12) — אף-ריצה לא שופכת את כל-המלאי בבת-אחת.
//
// שימוש: node grids/liquidity-bootstrap.mjs [--execute] [--arm path] [--params path]
//   ברירת-מחדל: dry-run (מדפיס את הדלתא; לא נוגע בכלום).

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { stasisHalt } from "./brake.mjs";
import { validateParams } from "./validate-params.mjs";
import { activeAuthorityOk, wifToPublicSafe } from "./key-gate.mjs";
import { ACCOUNT as DEF_ACCOUNT, rpcAny, signAndBroadcast, privToWif, num, dp3 } from "./mover.mjs";
import { appendEvent } from "./events.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ARM_PROTOCOL = "SAOS-LIQUIDITY-ARM/1";
const PRICE_TOL_BPS = 10;   // סובלנות-התאמת-מחיר לרמה-קיימת (אותו-סף-ריפרייס של mover)
const SIZE_TOL = 0.02;      // סובלנות-גודל 2% — רמה-קיימת = מדורגת, לא מוספת שוב

/* ── פאריטי-חוץ (אותם-מקורות של mover.freshParity — קו-הזהות הוא חוק) ─────── */
async function paritySteemSbd() {
  const jget = async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "grids-liquidity-bootstrap" } });
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

/* ── קובץ-החימוש — הטקס-המשפטי של-הבעלים, fail-closed על צורה ─────────────── */
export function loadArm(armPath) {
  if (!existsSync(armPath)) return { present: false, ok: false, errors: [`arm file missing at ${armPath} — the lane refuses honestly (refusal = success by design)`] };
  try {
    const j = JSON.parse(readFileSync(armPath, "utf8"));
    const errors = [];
    if (j.protocol !== ARM_PROTOCOL) errors.push(`foreign arm protocol '${String(j.protocol)}' — expected ${ARM_PROTOCOL}`);
    const sealed = typeof j.sealedAt === "string" ? Date.parse(j.sealedAt) : NaN;
    if (!Number.isFinite(sealed)) errors.push("sealedAt missing or not ISO");
    if (typeof j.ownerWord !== "string" || j.ownerWord.trim().length < 8) errors.push("ownerWord must carry the documented owner authority (trace/id) — a bare word refuses");
    const mo = j.maxOpsPerRun;
    if (!Number.isInteger(mo) || mo < 1 || mo > 12) errors.push("maxOpsPerRun must be an integer in [1, 12]");
    if (typeof j.params !== "string" || !j.params.trim()) errors.push("params path missing");
    for (const k of Object.keys(j)) if (!["protocol", "sealedAt", "ownerWord", "maxOpsPerRun", "params"].includes(k)) errors.push(`foreign arm field '${k}' — fail-closed`);
    return { present: true, ok: errors.length === 0, errors, doc: errors.length === 0 ? j : null };
  } catch (e) {
    return { present: true, ok: false, errors: [`arm file unreadable: ${String(e?.message ?? e).slice(0, 120)}`] };
  }
}

/* ── המתכנן-הטהור — נבדק ב-selftest בלי-רשת ובלי-מפתחות ──────────────────── */
/**
 * @param {object} a
 * @param {{ steem: number, sbd: number, hive?: number, hbd?: number }} a.balances  נזיל-חי
 * @param {{ asks: Array<{ orderid: number, sell: string, receive: string }>, bids: Array<{ orderid: number, sell: string, receive: string }> }} a.ours  הפקודות-הפתוחות-שלנו
 * @param {{ bestBid: number | null, bestAsk: number | null }} a.book
 * @param {number | null} a.parity  SBD ל-1-STEEM בזהות-חוץ
 * @param {object} a.params  פרמטרים-מאומתים (steem רלוונטי כאן)
 * @param {number} a.maxOps  תקרת-אופים-לריצה
 * @param {string} a.today   YYYYMMDD למרחב-ה-orderid של-המסילה (…51..99)
 */
export function planBootstrap({ balances, ours, book, parity, params, maxOps, today }) {
  const skips = [], ops = [];
  const s = params.steem;
  if (!book.bestBid || !book.bestAsk) return { ops, skips: [...skips, "book one-sided or unreachable — no deployment without a live touch"], needMore: false };
  if (parity == null) return { ops, skips: [...skips, "external parity unavailable — the value line is the law (principle 1)"], needMore: false };

  // מרחב-orderid של-המסילה: YYYYMMDD×100+51.. — לא מתנגש עם grid-beat (01..49 בפועל)
  let seq = 51;
  const nextId = () => {
    let id = Number(today) * 100 + seq;
    const taken = new Set([...ours.asks, ...ours.bids].map((o) => o.orderid));
    while (taken.has(id)) { seq++; id = Number(today) * 100 + seq; }
    return id;
  };
  const pxOf = (side, o) => (side === "ask" ? num(o.receive) / num(o.sell) : num(o.sell) / num(o.receive)); // SBD ל-1-STEEM בשני-הצדדים
  const sameLevel = (side, px, size, sideOrders) =>
    sideOrders.some((o) => {
      const opx = pxOf(side, o);
      const osize = num(o.sell);
      return Math.abs(opx - px) <= px * PRICE_TOL_BPS / 10_000 && Math.abs(osize - size) <= size * SIZE_TOL;
    });

  // מדף-המכירה: מעל קו-הזהות — רק מהנזיל-החופשי (המסילה לא מבטלת, לא סופרת-נעול)
  const steemFuel = Math.max(0, balances.steem - (s.minKeepSteem ?? 0.5));
  const steemCommit = Math.max(0, Math.floor(steemFuel * s.commitPct * 1000) / 1000);
  const askPer = Math.floor((steemCommit / s.askLevels) * 1000) / 1000;
  if (askPer >= (s.minLevelSteem ?? 1.0)) {
    const baseAsk = Math.max(parity * (1 + s.askStepBps / 10_000), book.bestAsk); // Z-80: הידוק אל-המגע
    for (let k = 1; k <= s.askLevels && ops.length < maxOps; k++) {
      const px = baseAsk * (1 + (s.askStepBps * (k - 1)) / 10_000);
      const recv = Math.floor(askPer * px * 1000) / 1000;
      if (recv < (s.minLevelSbd ?? 0.05)) { skips.push(`ask L${k}: recv ${recv} SBD < min ${s.minLevelSbd} — skipped honestly`); continue; }
      if (sameLevel("ask", px, askPer, ours.asks)) { skips.push(`ask L${k} @${px.toFixed(6)} already deployed (delta-only) — skipped`); continue; }
      ops.push({ kind: "place", side: "ask", orderid: nextId(), amountToSell: `${dp3(askPer)} STEEM`, minToReceive: `${dp3(recv)} SBD`, px });
    }
  } else {
    skips.push(`ask side: ${askPer.toFixed(3)} STEEM/level < min ${s.minLevelSteem} — no deployment (fuel law)`);
  }

  // מדף-הקנייה: מתחת לביד הטוב — כל-מילוי הוא עודף-מדוד מול הציון (עיקרון 2)
  const sbdCommit = Math.max(0, Math.floor(balances.sbd * s.commitPct * 1000) / 1000);
  const bidPer = Math.floor((sbdCommit / s.bidLevels) * 1000) / 1000;
  if (bidPer >= (s.minLevelSbd ?? 0.05)) {
    for (let k = 1; k <= s.bidLevels && ops.length < maxOps; k++) {
      const px = Math.min(book.bestBid * (1 - (s.bidStepBps * k) / 10_000), book.bestBid); // לעולם לא מעל המגע
      const recv = Math.floor(bidPer / px * 1000) / 1000;
      if (recv < (s.minLevelSteem ?? 1.0)) { skips.push(`bid L${k}: recv ${recv} STEEM < min ${s.minLevelSteem} — skipped honestly`); continue; }
      if (sameLevel("bid", px, bidPer, ours.bids)) { skips.push(`bid L${k} @${px.toFixed(6)} already deployed (delta-only) — skipped`); continue; }
      ops.push({ kind: "place", side: "bid", orderid: nextId(), amountToSell: `${dp3(bidPer)} SBD`, minToReceive: `${dp3(recv)} STEEM`, px });
    }
  } else {
    skips.push(`bid side: ${bidPer.toFixed(3)} SBD/level < min ${s.minLevelSbd} — no deployment (fuel law)`);
  }
  return { ops, skips, needMore: false };
}

/* ── הרצה ─────────────────────────────────────────────────────────────────── */
/**
 * @param {object} opts
 * @param {boolean} [opts.execute]  שידור-אמת (ברירת-מחדל dry-run)
 * @param {string} [opts.arm]       נתיב קובץ-החימוש (ברירת-מחדל grids/liquidity-arm.json)
 * @param {string} [opts.params]    נתיב קובץ-הפרמטרים (ברירת-מחדל grids/state/grid-params.json)
 * @param {string} [opts.account]
 * @param {object} [opts.io]        הזרקה ל-selftest: { rpc, sign, parity }
 */
export async function runBootstrap(opts = {}) {
  const execute = !!opts.execute;
  const account = opts.account ?? DEF_ACCOUNT;
  const armPath = opts.arm ? resolve(opts.arm) : join(HERE, "liquidity-arm.json");
  const io = { rpc: opts.io?.rpc ?? rpcAny, sign: opts.io?.sign ?? ((wif, ops) => signAndBroadcast(wif, ops)), parity: opts.io?.parity ?? paritySteemSbd };
  const res = { account, execute, refused: null, exit: 0, plan: [], skips: [], applied: [], failed: [], txids: [], hive: null };

  /* 1) STASIS — הבלם נשאל טרי בכל-ריצה (fail-closed) */
  if (stasisHalt("liquidity-bootstrap")) {
    res.refused = "STASIS: lane not open for liquidity-bootstrap — touching nothing (honest refusal, exit 0)";
    return res;
  }

  /* 2) קובץ-החימוש של-הבעלים — בלעדיו המסילה לא קיימת */
  const arm = loadArm(armPath);
  if (!arm.present) { res.refused = `arm file missing (${armPath}) — ${arm.errors[0]}`; return res; } // סירוב = הצלחה-על-פי-תכנון
  if (!arm.ok) { res.refused = `arm file REJECTED: ${arm.errors.join(" | ")}`; res.exit = 2; return res; }

  /* 3) פרמטרים-מאומתים בלבד — קובץ-החימוש מצביע עליהם (או --params עבור selftest) */
  const paramsPath = opts.params ? resolve(opts.params)
    : (arm.doc.params.startsWith("/") ? arm.doc.params : join(HERE, "..", arm.doc.params));
  let paramsDoc, vres;
  try { paramsDoc = JSON.parse(readFileSync(paramsPath, "utf8")); }
  catch (e) { res.refused = `params file unreadable (${arm.doc.params}) — fail-closed: ${String(e?.message ?? e).slice(0, 100)}`; res.exit = 2; return res; }
  vres = validateParams(paramsDoc);
  if (!vres.ok) { res.refused = `params REJECTED by grids/validate-params.mjs: ${vres.errors.slice(0, 3).join(" | ")}`; res.exit = 2; return res; }

  /* 4) המצב-החי — קריאה-לפני-כתיבה (fail-closed על קריאה-רעה) */
  let acc, openRaw, bookRaw;
  try {
    [acc, openRaw, bookRaw] = await Promise.all([
      io.rpc("condenser_api.get_accounts", [[account]]),
      io.rpc("condenser_api.get_open_orders", [account]).catch(() => []),
      io.rpc("condenser_api.get_order_book", [5]),
    ]);
  } catch (e) {
    res.refused = `live state unreadable — refusing to plan on doubt (fail-closed): ${String(e?.message ?? e).slice(0, 120)}`;
    res.exit = 1;
    return res;
  }
  const balances = { steem: num(acc?.[0]?.balance), sbd: num(acc?.[0]?.sbd_balance), hive: num(acc?.[0]?.balance), hbd: num(acc?.[0]?.hbd_balance) };
  const ours = {
    asks: (openRaw ?? []).filter((o) => String(o.sell_price?.base ?? "").includes("STEEM")).map((o) => ({ orderid: o.orderid, sell: o.sell_price.base, receive: o.sell_price.quote })),
    bids: (openRaw ?? []).filter((o) => String(o.sell_price?.base ?? "").includes("SBD")).map((o) => ({ orderid: o.orderid, sell: o.sell_price.base, receive: o.sell_price.quote })),
  };
  const book = {
    bestAsk: bookRaw?.asks?.[0] ? parseFloat(bookRaw.asks[0].real_price) : null,
    bestBid: bookRaw?.bids?.[0] ? parseFloat(bookRaw.bids[0].real_price) : null,
  };
  const parity = await io.parity();

  /* רגל-HIVE — דילוג-כנה: המסילה הזו מזריקה נזילות לספר-STEEM (rpc-STEEM בלבד);
   * ספר-ה-HIVE רץ דרך hivemarket/grid-beat עם חוקי-הגרעיניות שלו (R99) —
   * לעולם לא מעמידים-פן של מדידה-חוצת-שרשרת כאן. */
  res.hive = { skipped: true, reason: "hive side out of scope for this lane (STEEM rpc only): the hive book runs via grid-beat/hivemarket under the R99 price-fidelity law — never cross-chain roleplay" };

  /* 5) התוכנית — דלתא-בלבד */
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const plan = planBootstrap({ balances, ours, book, parity, params: vres.params, maxOps: arm.doc.maxOpsPerRun, today });
  res.plan = plan.ops;
  res.skips = plan.skips;
  if (plan.ops.length === 0) { res.refused = res.refused ?? (plan.skips.length ? `nothing to deploy (delta-only): ${plan.skips.slice(0, 2).join(" | ")}` : "already at target depth — zero ops (idempotent)"); return res; }
  if (!execute) { res.refused = "dry-run — plan only, nothing broadcast (add --execute for real signing)"; return res; }

  /* 6) מפתח-מאומת-מול-הרשות-החיה — רק עכשיו, לפני-שידור-אמת */
  const wif = process.env.STEEM_ACTIVE_WIF || "";
  const gate = await activeAuthorityOk({ account, wif, rpc: io.rpc });
  if (!gate.ok) { res.refused = `key gate: ${gate.reason}`; res.exit = 1; return res; }

  /* 7) שידור + קריאה-אחרי-כתיבה פר-אופ */
  for (const op of plan.ops) {
    try {
      const r = await io.sign(wif, [["limit_order_create", {
        owner: account, orderid: op.orderid,
        amount_to_sell: op.amountToSell, min_to_receive: op.minToReceive,
        fill_or_kill: false,
        expiration: new Date(Date.now() + vres.params.steem.expiryDays * 86_400_000).toISOString().slice(0, 19),
      }]]);
      res.txids.push({ txid: r.txid, block: r.block, orderid: op.orderid });
      // read-after-write: הפקודה חייבת להופיע חיה על-השרשרת
      const after = await io.rpc("condenser_api.get_open_orders", [account]).catch(() => []);
      const hit = (after ?? []).some((o) => o.orderid === op.orderid);
      if (hit) {
        res.applied.push(op);
      } else {
        res.failed.push({ ...op, reason: `read-after-write: orderid ${op.orderid} not found live — fail-closed stop` });
        break;
      }
    } catch (e) {
      res.failed.push({ ...op, reason: String(e?.message ?? e).slice(0, 160) });
      break; // fail-closed: אין-המשך-עיוור אחרי-כישלון
    }
  }
  return res;
}

/* ── CLI + קבלות ──────────────────────────────────────────────────────────── */
if (process.argv[1] && process.argv[1].endsWith("liquidity-bootstrap.mjs")) {
  const execute = process.argv.includes("--execute");
  const armIdx = process.argv.indexOf("--arm");
  const paramsIdx = process.argv.indexOf("--params");
  const res = await runBootstrap({
    execute,
    ...(armIdx > 0 ? { arm: process.argv[armIdx + 1] } : {}),
    ...(paramsIdx > 0 ? { params: process.argv[paramsIdx + 1] } : {}),
  });
  if (res.refused) console.log(`liquidity-bootstrap: ${res.refused}`);
  for (const sk of res.skips) console.log(`liquidity-bootstrap: skip — ${sk}`);
  for (const op of res.plan) console.log(`liquidity-bootstrap: plan #${op.orderid} ${op.side} ${op.amountToSell} -> ${op.minToReceive} @${op.px.toFixed(6)}`);
  for (const a of res.applied) console.log(`liquidity-bootstrap: APPLIED #${a.orderid} ${a.side} ${a.amountToSell} -> ${a.minToReceive}`);
  for (const f of res.failed) console.error(`liquidity-bootstrap: FAILED #${f.orderid} — ${f.reason}`);
  if (res.hive) console.log(`liquidity-bootstrap: ${res.hive.reason}`);
  if (execute && (res.applied.length || res.failed.length)) {
    // קבלה — רישום-מקומי בלבד (אפס סודות, אפס חומרת-מפתח)
    const receipt = { at: new Date().toISOString(), account: res.account, mode: "liquidity-bootstrap", applied: res.applied.length, failed: res.failed.length, txids: res.txids, skips: res.skips.length };
    try {
      appendFileSync(join(HERE, "state", "liquidity-receipt.jsonl"), JSON.stringify(receipt) + "\n");
      appendEvent(join(HERE, "state", "events.jsonl"), { kind: "liquidity-bootstrap", at: receipt.at, account: res.account, applied: res.applied.length, failed: res.failed.length, txids: res.txids.map((t) => t.txid), sim: false });
      console.log("liquidity-bootstrap: receipt appended (grids/state/liquidity-receipt.jsonl + events.jsonl)");
    } catch { console.warn("liquidity-bootstrap: receipt write failed (non-fatal; txids logged above)"); }
  }
  process.exit(res.exit);
}
