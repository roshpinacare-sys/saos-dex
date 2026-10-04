// AGENT-SWAP-API — שער-שוק-הארביטרז' של הסוכנים/החיילים (Z-87a · trace 1a105e08984d4671)
// ═══════════════════════════════════════════════════════════════════════════════
// צורת-השוק (audit-Z86c פער-e): הסריקה (arb-scan.mjs) מפרסמת הזדמנויות בפנקס
// arb-ledger.json ← סוכן תובע תוכנית (הפונקציה הטהורה למטה) ← הביצוע היחיד
// דרך מסילה-אחת בבעלות-המפעיל. השער FAIL-CLOSED וברירת-מחדלו DISARMED.
//
// דוקטרינת-מפתחות (חוק-הצי): ב-repo הזה לא קיים חומר-מפתחות לאף-סוכן
// (fleet-roster: רוב-הצי blocked-no-key). לכן תוכניות-הסוכנים מוצעות-חסרות-מפתחות,
// והמסילה-היחידה חותמת מהחשבון-הצי שהמפעיל חימש (headcorner) — כל-תובע
// תחום-בתקרת-נומינל פר-סוכן (capSbd) מהדגלים המחויבים.
//
// סדר-השער לביצוע (fail-closed — הזול-קודם, אפס-רשת לפני-הדגלים-והמפתח):
//   1. תוכנית-תקפה + תקרת-הסוכן (capSbd) לא-נחצית.
//   2. דגל-שליטה מפורש לסוכן: control="full" + economicUse=true (agent-roster).
//   3. מפתח-חתימה שהבעלים חימש בסביבה (שמות-env בלבד — אף-ערך לא נדפס).
//   4. חוק-הספר (Z-80): מחיר-ה-maker עובר crossAudit מול-הספר-החי.
//   5. קצה-חיובי (שער-כנות נוסף — אין-ביצוע על-קצה-שלילי).
//   6. (רשת) verify-then-sign מול-הרשות-החיה + RC-דלק — אותו-דפוס של mover/convert.
//   ברירת-מחדל ללא-(2)וגם-(3) → DISARMED: פלט-תוכנית בלבד. אפס-ברירת-מחדל-חמושה.

import { ACCOUNT, RC_MIN, rpcAny, signAndBroadcast, privToPub, wifToPriv } from "./mover.mjs";
import { crossAudit } from "./book-law.mjs";
import { controlFor } from "./agent-roster.mjs";
import { FEE_BPS, r6, steemBookFeed, htxDepthFeed, binanceTopFeed, measureRefs } from "./arb-scan.mjs";

export const AGENT_SWAP_POLICY = {
  capSbdDefault: 5,        // תקרת-נומינל כשהדגל-עצמו לא מגדיר (החלטה-כתובה, לא-נגזרת)
  minNotionalSbd: 0.001,   // אבק
  supportedPairs: ["STEEM:SBD"], // רק-השוק-הפנים-האמת — לשאר: תוכנית-בלבד (PAPER/CEX_REF)
};

/** מחיר-maker כן: קנייה=ביד ≤ bestBid; מכירה=אסק ≥ bestAsk (Z-80 מחייב). */
export function makerSwapPrice(side, book) {
  if (side === "buy") return book?.bestBid != null ? { price: book.bestBid, side: "bid" } : null;
  if (side === "sell") return book?.bestAsk != null ? { price: book.bestAsk, side: "ask" } : null;
  return null;
}

/**
 * הפונקציה-הטהורה-חסרת-המפתחות: (pair, side, amount, agentId) → תוכנית.
 * books/refs מוזרקים (דטרמיניזם-לבדיקות); runAgentSwapPlan קורא-חי-מטה.
 */
export function planAgentSwap({ pair = "STEEM:SBD", side, amount, agentId, book, cexBook = null, refs = {}, control = null, policy = AGENT_SWAP_POLICY, nowIso = null, edgeBps = null }) {
  const reasons = [];
  const warnings = [];
  const sid = String(agentId ?? "").trim();
  if (!sid) reasons.push("agentId empty — no claim without an agent identity");
  if (side !== "buy" && side !== "sell") reasons.push("side must be buy|sell");
  if (!Number.isFinite(amount) || !(amount > 0)) reasons.push("amount must be > 0");
  if (!policy.supportedPairs.includes(pair)) warnings.push(`pair ${pair} has no on-chain execution rail here — plan is ${pair.includes("USDT") || pair.includes("USD") ? "CEX_REF/PAPER" : "informational"}`);

  // תקרת-הסוכן — מהדגלים המחויבים (controlFor), לא מהמצאה
  const flag = control ?? controlFor(sid);
  const capSbd = flag?.capSbd != null && Number(flag.capSbd) > 0 ? Number(flag.capSbd) : policy.capSbdDefault;
  const px = side === "buy" ? (book?.bestAsk ?? null) : (book?.bestBid ?? null);
  const notionalSbd = px != null && amount > 0 ? r6(amount * px) : null;
  let withinCap = null;
  if (notionalSbd == null) reasons.push("no live chain price — notional not computable without invention (fail-closed)");
  else {
    withinCap = notionalSbd <= capSbd + 1e-9;
    if (!withinCap) reasons.push(`cap exceeded: notional ${notionalSbd} SBD > agent cap ${capSbd} SBD — REJECTED (plan published as rejected)`);
    if (notionalSbd < policy.minNotionalSbd) reasons.push(`notional ${notionalSbd} SBD below dust floor ${policy.minNotionalSbd}`);
  }

  // חוק-הספר: מחיר-maker עובר crossAudit מחייב (ביד ≤ bestBid / אסק ≥ bestAsk)
  const mk = makerSwapPrice(side, book);
  let clamp = { ok: false, why: "book absent — no maker price without the live book (Z-80 fail-closed)" };
  if (mk) {
    const audit = crossAudit({ side: mk.side, price: mk.price }, book);
    clamp = audit.ok ? { ok: true, price: mk.price, side: mk.side } : { ok: false, why: audit.why };
  }
  if (!clamp.ok) reasons.push(`book-law clamp: ${clamp.why ?? "clamp fail"}`);

  // מצב-השער — בתוכנית-חסרת-מפתחות זה תמיד DISARMED (הביצוע הוא שער-נפרד)
  const flagOk = flag?.control === "full" && flag.economicUse === true;
  const gate = {
    state: "DISARMED",
    law: "execution requires ALL of: full+economicUse roster flag · owner-armed signing env · book-law clamp pass · positive live edge · verify-then-sign — default is DISARMED",
    flag: { control: flag?.control ?? "blocked-no-key", economicUse: flag?.economicUse === true, capSbd, source: flag?.source ?? null },
    signingEnv: "STEEM_ACTIVE_WIF (owner-armed; name only — value never read in plan mode)",
    reasons,
  };
  if (!flagOk) gate.reasons.unshift(`roster flag: control=${flag?.control ?? "blocked-no-key"} economicUse=${flag?.economicUse === true} — DISARMED (fail-closed default)`);
  if (edgeBps != null && edgeBps <= 0) warnings.push(`live edge ${edgeBps}bps non-positive — plan published for honesty; execution advisory against`);

  const rejected = reasons.some((r) => /cap exceeded|dust floor|side must|amount must|agentId empty|not computable/.test(r));
  return {
    ok: !rejected,
    status: rejected ? "REJECTED" : "PLAN",
    schema: "agent-swap-plan-v1",
    at: nowIso ?? null,
    agentId: sid || null, pair, side, amount,
    price: px,
    notionalSbd,
    cap: { capSbd, withinCap },
    edgeBps,
    realness: { chain: "ONCHAIN_REAL", cex: cexBook?.realness ?? null, entry: "CEX_REF unless both legs on-chain" },
    makerOrder: clamp.ok ? { side: mk.side, price: mk.price, amount } : null,
    bookLaw: clamp,
    warnings,
    gate,
    execution: "none — plan-only output; execution only via executeAgentSwap gate (fail-closed)",
  };
}

/** איסוף-חי keyless לתוכנית אחת (STEEM:SBD מול-HTX). */
export async function runAgentSwapPlan({ pair = "STEEM:SBD", side = "buy", amount, agentId, fetchImpl = fetch, nowIso = null, env = process.env } = {}) {
  const [bookRes, cexRes, refsRes] = await Promise.allSettled([
    steemBookFeed({ fetchImpl }), htxDepthFeed("steemusdt", { fetchImpl }), measureRefs({ fetchImpl }),
  ]);
  const book = bookRes.status === "fulfilled" && bookRes.value.ok ? bookRes.value.data : null;
  const cexBook = cexRes.status === "fulfilled" && cexRes.value.ok ? cexRes.value.data : null;
  const refs = refsRes.status === "fulfilled" ? refsRes.value.refs : {};
  const sbdUsd = refs.sbdUsd ?? null;
  let edgeBps = null;
  if (book && cexBook && sbdUsd != null) {
    const buyEff = side === "buy" ? book.bestAsk * sbdUsd * (1 + FEE_BPS / 1e4) : cexBook.asks[0]?.price ?? null;
    const sellEff = side === "sell" ? book.bestBid * sbdUsd * (1 - FEE_BPS / 1e4) : cexBook.bids[0]?.price ?? null;
    if (buyEff > 0 && sellEff > 0) edgeBps = r6(((sellEff - buyEff) / buyEff) * 1e4);
  }
  const control = controlFor(agentId, { env });
  return planAgentSwap({ pair, side, amount, agentId, book, cexBook, refs, control, nowIso, edgeBps });
}

/**
 * השער-היחיד לביצוע. FAIL-CLOSED: כל-שלב-נכשל → DISARMED/REFUSED עם-סיבה-כנה,
 * אפס-שידור. ברירת-מחדל (בלי-דגלים, בלי-env) → DISARMED לפני-כל-קריאת-רשת.
 */
export async function executeAgentSwap({ plan, env = process.env, fetchImpl = fetch, rpcImpl = rpcAny, signer = null, account = ACCOUNT } = {}) {
  const reasons = [];
  if (!plan || plan.status !== "PLAN" || plan.ok !== true) reasons.push("plan absent/REJECTED — nothing to execute");
  if (plan?.cap?.withinCap !== true) reasons.push("agent cap not satisfied");
  const flag = plan?.gate?.flag;
  if (!(flag?.control === "full" && flag.economicUse === true)) reasons.push(`roster flag not full+economicUse (${flag?.control ?? "?"}) — DISARMED`);
  const wif = env?.STEEM_ACTIVE_WIF ?? null;
  if (!wif) reasons.push("signing env absent (STEEM_ACTIVE_WIF not armed by owner) — DISARMED");
  if (plan?.bookLaw?.ok !== true) reasons.push("book-law clamp not satisfied on plan");
  if (typeof plan?.edgeBps === "number" && plan.edgeBps <= 0) reasons.push(`live edge ${plan.edgeBps}bps ≤ 0 — no execution on non-positive edge (honesty law)`);
  if (reasons.length > 0) {
    return { ok: false, status: "DISARMED", gate: "fail-closed", reasons, broadcast: null, law: "DISARMED by default: flag+env+clamp+edge+cap must ALL pass; verify-then-sign still follows before any broadcast" };
  }

  // (רשת) verify-then-sign — אותו-דפוס מחייב של mover/convert:
  const accArr = await rpcImpl("condenser_api.get_accounts", [[account]]).catch(() => null);
  const liveActive = accArr?.[0]?.active?.key_auths?.[0]?.[0];
  if (!liveActive) return { ok: false, status: "REFUSED", reasons: ["live active authority unavailable — refusing to sign (fail-closed)"], broadcast: null };
  let keyOk = false;
  try { keyOk = privToPub(wifToPriv(wif)) === liveActive; } catch { keyOk = false; }
  if (!keyOk) return { ok: false, status: "REFUSED", reasons: ["armed key does not derive the LIVE active authority — refusing (verify-then-sign)"], broadcast: null };
  const rc = await rpcImpl("rc_api.find_rc_accounts", { accounts: [account] }).catch(() => null);
  const rcNow = Number(rc?.rc_accounts?.[0]?.rc_manabar?.current_mana ?? 0);
  if (rcNow < RC_MIN) return { ok: false, status: "REFUSED", reasons: [`RC fuel below floor: ${rcNow} < ${RC_MIN}`], broadcast: null };

  // טריות-ספר: המחיר-מהודק נבדק שוב מול-ספר-חי-טרי (fail-closed)
  const fresh = await steemBookFeed({ fetchImpl });
  if (!fresh.ok) return { ok: false, status: "REFUSED", reasons: ["live book unavailable at execution time — refusing (fail-closed)"], broadcast: null };
  const freshShape = { bestAsk: fresh.data.asks?.[0]?.price ?? null, bestBid: fresh.data.bids?.[0]?.price ?? null };
  const audit = crossAudit({ side: plan.makerOrder.side, price: plan.makerOrder.price }, freshShape);
  if (!audit.ok) return { ok: false, status: "REFUSED", reasons: [`book-law clamp failed on fresh book: ${audit.why}`], broadcast: null };

  const op = plan.makerOrder.side === "bid"
    ? ["limit_order_create", { owner: account, amount_to_sell: `${r6(plan.notionalSbd)} SBD`, min_to_receive: `${r6(plan.amount)} STEEM`, fill_or_kill: false, expiration: new Date(Date.now() + 3600_000).toISOString().replace(/\.\d+Z$/, "") }]
    : ["limit_order_create", { owner: account, amount_to_sell: `${r6(plan.amount)} STEEM`, min_to_receive: `${r6(plan.notionalSbd)} SBD`, fill_or_kill: false, expiration: new Date(Date.now() + 3600_000).toISOString().replace(/\.\d+Z$/, "") }];

  if (signer) return signer(op); // injected for tests — אפס-רשת-אמת בבדיקות
  const r = await signAndBroadcast(wif, [op]).catch((e) => ({ error: String(e?.message ?? e).slice(0, 140) }));
  if (r.error) return { ok: false, status: "REFUSED", reasons: [`broadcast refused honestly: ${r.error}`], broadcast: null };
  return { ok: true, status: "EXECUTED", broadcast: { txid: r.txid, block: r.block }, op: { side: plan.makerOrder.side, price: plan.makerOrder.price, amount: plan.amount, notionalSbd: plan.notionalSbd }, agentId: plan.agentId };
}

/* ── CLI: node grids/agent-swap-api.mjs --agent <id> --side buy --amount 2 [--execute] ── */
const isCli = process.argv[1] && process.argv[1].endsWith("agent-swap-api.mjs");
if (isCli && !process.argv.includes("--selftest")) {
  const argOf = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
  const agentId = argOf("--agent", "");
  const side = argOf("--side", "buy");
  const amount = Number(argOf("--amount", "1"));
  const plan = await runAgentSwapPlan({ agentId, side, amount, nowIso: new Date().toISOString() });
  console.log(JSON.stringify(plan, null, 1));
  if (process.argv.includes("--execute")) {
    const res = await executeAgentSwap({ plan });
    console.log(JSON.stringify(res, null, 1));
  }
}
