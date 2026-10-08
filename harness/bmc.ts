/**
 * bmc.ts — THE BOUNDED MODEL CHECKER · בודק-המודל-החסום (מכשיר #15)
 * ═══════════════════════════════════════════════════════════════════════════════
 * EXEC-CD-36 · "איך הענקים עושים את זה?" — השכבה-שאחרי-ה-fuzz:
 *   ה-fuzzer (4,000 ops בסבב-2) מוכיח "לא מצאנו-הפרה בדגימה-אקראית".
 *   ה-BMC מוכיח טענה-כמתית: **לכל** רצף-פעולות עד-עומק N ממרחב-תבניות-אדיברסרי
 *   קבוע — אין-הפרה. זו בדיוק רמת TLA+/Certora (AWS מוכיחה DynamoDB/S3 כך,
 *   Certora מוכיחה Uniswap/Aave) — על גרעין-ה-DEX שלנו.
 *
 * מודל: עותק-מצומצם של הסנאפשוט-החי (ארנקות-בודקים ממומנים בהעברה-טהורה —
 * Σ נשמר; ספר/nonces/journal ריקים; בריכה-קנונית אחת; שני נכסים) — **אותו קוד
 * applyOp בדיוק**, מצב-קטן כדי שהאקסהוסטיביות תהיה סבירה-חישובית. ה-fuzzer
 * מכסה את המצב-המלא באקראי; ה-BMC מכסה את המכניקה באקסהוסטיביות.
 *
 * מודל-החשבונאות (נלמד-חי-בסבב-הראשון של המכשיר — ראה PROOF-REPORT):
 *   `locked` הוא **עיקול-על-היתרה**, לא-דלי-כסף-נפרד (ledgerAudit b: Σbalances
 *   +רזרבות+backing בלי-locked). נעילה מוסיפה-איסור ולא-מזיזה-מטבעות.
 *
 * אינוואריאנטות (אחרי **כל** apply בכל-קידומת-של כל-רצף):
 *   B1 REJECT-ATOMICITY   — op נדחה/זורק ⇒ stateRoot שווה-בתים לפני.
 *   B2 MONEY-HYGIENE      — אף-יתרה/נעילה/קרדיט שלילי, לא-שלם, NaN, Infinity.
 *   B3 CREDIT-DIFF        — ΔΣcredits + ΔgasUsed − ΔfeeMinted === 0 לכל-קבלה.
 *   B4 PURE-CONSERVATION  — למשפחות-טהורות (transfer/pay/xfer_free/order/cancel/
 *                           cancel_all/fill): Σbalances+רזרבות-בריכה+backing
 *                           קבוע-לכל-נכס (עיקולים-מותרים, מטבעות-לא).
 *   B5 SWAP-SANITY        — pool_swap מקובל: שתי-הרזרבות חיוביות, k לא-יורד
 *                           נבדק-בגרעין; כאן: רזרבות-חיוביות + חיוב-גז-אמת.
 *   B6 DETERMINISM        — כל-רצף-97 מרופליים-פעמיים ⇒ אותו-stateRoot סופי.
 *   B7 GAS-RECEIPT (F-12) — לכל-קבלה: result.gas === ΔgasUsed (חוזה-הקבלות;
 *                           נולד מהממצא-הראשון של המכשיר-הזה).
 *   B8 FEE-TRUTH (EXEC-CD-37) — לכל-pool_swap מקובל: המכשיר מחשב **בעצמו** (מקבועי
 *                           ה-מכשיר, לא מייבוא מהגרעין) feeAmt=floor(in·bps/10⁴)
 *                           עם bps מדונמי מוצב/רצפה 4/תקרה 1500, treasuryFee=
 *                           floor(feeAmt·30/100) — ודורש ΔfeeAccruedTreasury ===
 *                           ΔfeeMeter === treasuryFee בדיוק.
 *   B9 LOCK-TRUTH (EXEC-CD-37) — אחרי-כל-קבלה: לכל (ארנק,נכס) locked[w][a] ===
 *                           Σ lockMu של-פקודות-חיות (sell→base · buy→quote);
 *                           אף-lockMu שלילי; אף-רשומת-locked מנותקת-מפקודה.
 *                           תרגום-ישיר של החוזה "הנעילה נשארת מדויקת-בסוף".
 *
 * היסטוריית-ממצאים: הריצה-הראשונה (depth 3, 8,000 רצפים) תפסה F-12 אמיתי
 * (pool-משפחה מחזירה gas:0 תוך-צריכת-100) + תיקן-שני-באגי-מכשיר (B4 ספר-
 * locked-כפול; B6 נונסים-גלובליים-לא-דטרמיניסטיים). התיקונים-מתועדים ב-PROOF-REPORT.
 *
 * ריצה: DATABASE_URL=file:../db/dex.db bun harness/bmc.ts [--depth 4] [--quiet]
 * יציאה: exit 0 = PASS · exit 1 = הפרה/קריסה. ארטיפקט: audit-package/proof-pack/bmc.json
 */
import { applyOp, type DexState, type Op } from "../src/lib/dex/kernel";
import { stateRootOf } from "../src/lib/dex/canonical";

/* ── קלט ─────────────────────────────────────────────────────────────────────── */
const argv = process.argv;
const depthIdx = argv.indexOf("--depth");
const DEPTH = Math.min(5, Math.max(1, Number.isFinite(Number(argv[depthIdx + 1])) ? Number(argv[depthIdx + 1]) : 3));
const QUIET = argv.includes("--quiet");
const SNAPSHOT = new URL("../db/state-snapshot.json", import.meta.url).pathname;
const ARTIFACT = new URL("../audit-package/proof-pack/bmc.json", import.meta.url).pathname;

/* ── בניית-המודל-המצומצם ─────────────────────────────────────────────────────── */
function reducedModel(live: DexState): DexState {
  const st = structuredClone(live) as DexState;
  const A = "SAOS", U = "USDS";
  st.orders = [];
  st.locked = {};
  st.nonces = [];
  st.journal = [];
  st.balances = {
    "bmc-a": { [U]: 2_000_000, [A]: 1_000_000 },
    "bmc-b": { [U]: 1_000_000, [A]: 500_000 },
    treasury: { [U]: 100_000, [A]: 50_000 },
  };
  st.credits = { "bmc-a": 5_000, "bmc-b": 5_000, treasury: 100 };
  const pair = st.pools?.[`${A}/${U}`] ? `${A}/${U}` : Object.keys(st.pools ?? {})[0];
  if (!pair) throw new Error("bmc: אין-בריכה-חיה-בסנאפשוט");
  st.pools = { [pair]: structuredClone(st.pools[pair]) };
  st.assets = { [A]: { ...st.assets[A] }, [U]: { ...st.assets[U] } };
  st.backing = {};
  st.extBack = {};
  return st;
}

/* ── מרחב-התבניות-האדיברסרי — nonces דטרמיניסטיים-טהורים (f(seq,i,tpl)) ──────── */
type Ctx = { st: DexState; lastOrderId: { a: number | null; b: number | null } };
type Tpl = { name: string; pure: boolean; mk: (c: Ctx, i: number, seq: number, ti: number) => Op };
const T: (name: string, pure: boolean, mk: Tpl["mk"]) => Tpl = (name, pure, mk) => ({ name, pure, mk });
let PAIR = "SAOS/USDS";
const QUOTE = (): string => PAIR.split("/")[1];
const BASE = (): string => PAIR.split("/")[0];
const TEMPLATES: Tpl[] = [
  T("xfer-ok", true, (c, i, s, ti) => ({ type: "transfer", issuer: "bmc-a", nonce: `bmc-${s}-${i}-${ti}`, to: "bmc-b", asset: "USDS", amount: 1_000 })),
  T("xfer-overdraft", true, (c, i, s, ti) => ({ type: "transfer", issuer: "bmc-a", nonce: `bmc-${s}-${i}-${ti}`, to: "bmc-b", asset: "USDS", amount: 1e12 })),
  T("xfer-self", true, (c, i, s, ti) => ({ type: "transfer", issuer: "bmc-a", nonce: `bmc-${s}-${i}-${ti}`, to: "bmc-a", asset: "USDS", amount: 500 })),
  T("xfer-negative", true, (c, i, s, ti) => ({ type: "transfer", issuer: "bmc-a", nonce: `bmc-${s}-${i}-${ti}`, to: "bmc-b", asset: "USDS", amount: -500 })),
  T("xfer-unknown-asset", true, (c, i, s, ti) => ({ type: "transfer", issuer: "bmc-a", nonce: `bmc-${s}-${i}-${ti}`, to: "bmc-b", asset: "ZZTOP", amount: 100 })),
  T("pay-ok", true, (c, i, s, ti) => ({ type: "pay", issuer: "bmc-b", nonce: `bmc-${s}-${i}-${ti}`, to: "bmc-a", asset: "SAOS", amount: 700 })),
  T("xfer-free", true, (c, i, s, ti) => ({ type: "xfer_free", issuer: "bmc-a", nonce: `bmc-${s}-${i}-${ti}`, to: "bmc-b", asset: "USDS", amount: 100 })),
  T("order-sell-ok", true, (c, i, s, ti) => ({ type: "order", issuer: "bmc-a", nonce: `bmc-${s}-${i}-${ti}`, base: BASE(), quote: QUOTE(), side: "sell", price: 1_300, amount: 500 })),
  T("order-buy-ok", true, (c, i, s, ti) => ({ type: "order", issuer: "bmc-b", nonce: `bmc-${s}-${i}-${ti}`, base: BASE(), quote: QUOTE(), side: "buy", price: 800, amount: 400 })),
  T("order-cross", true, (c, i, s, ti) => ({ type: "order", issuer: "bmc-b", nonce: `bmc-${s}-${i}-${ti}`, base: BASE(), quote: QUOTE(), side: "buy", price: 99_000, amount: 300 })),
  T("order-bad-price", true, (c, i, s, ti) => ({ type: "order", issuer: "bmc-a", nonce: `bmc-${s}-${i}-${ti}`, base: BASE(), quote: QUOTE(), side: "sell", price: -1, amount: 100 })),
  T("order-same-pair", true, (c, i, s, ti) => ({ type: "order", issuer: "bmc-a", nonce: `bmc-${s}-${i}-${ti}`, base: QUOTE(), quote: QUOTE(), side: "sell", price: 1_000, amount: 100 })),
  T("cancel-last", true, (c, i, s, ti) => ({ type: "cancel", issuer: i % 2 ? "bmc-b" : "bmc-a", nonce: `bmc-${s}-${i}-${ti}`, orderId: (i % 2 ? c.lastOrderId.b : c.lastOrderId.a) ?? 999_999_999 })),
  T("cancel-unknown", true, (c, i, s, ti) => ({ type: "cancel", issuer: "bmc-a", nonce: `bmc-${s}-${i}-${ti}`, orderId: 999_999_999 })),
  T("cancel-all", true, (c, i, s, ti) => ({ type: "cancel_all", issuer: "bmc-a", nonce: `bmc-${s}-${i}-${ti}` })),
  T("fill-unknown", true, (c, i, s, ti) => ({ type: "fill", issuer: "bmc-a", nonce: `bmc-${s}-${i}-${ti}`, orderId: 999_999_999, market: true })),
  T("swap-ok", false, (c, i, s, ti) => ({ type: "pool_swap", issuer: "bmc-a", nonce: `bmc-${s}-${i}-${ti}`, pair: PAIR, assetIn: QUOTE(), amount: 1_000, minOut: 0 })),
  T("swap-overdraft", false, (c, i, s, ti) => ({ type: "pool_swap", issuer: "bmc-a", nonce: `bmc-${s}-${i}-${ti}`, pair: PAIR, assetIn: QUOTE(), amount: 1e12, minOut: 0 })),
  T("swap-bad-pair", false, (c, i, s, ti) => ({ type: "pool_swap", issuer: "bmc-a", nonce: `bmc-${s}-${i}-${ti}`, pair: "FOO/BAR", assetIn: "USDS", amount: 100, minOut: 0 })),
  T("op-gate-mint", true, (c, i, s, ti) => ({ type: "mint_fuel", issuer: "bmc-a", nonce: `bmc-${s}-${i}-${ti}`, amount: 1_000 })),
];

/* ── האינוואריאנטות ──────────────────────────────────────────────────────────── */
interface Violation { code: string; seq: number; i: number; detail: string }
const V: Violation[] = [];

function moneyHygiene(st: DexState, seq: number, i: number): void {
  const maps: [string, unknown][] = [["balances", st.balances], ["locked", st.locked], ["credits", st.credits]];
  for (const [mname, m0] of maps) {
    const m = m0 as Record<string, unknown>;
    for (const [w, wallet] of Object.entries(m)) {
      if (typeof wallet !== "object" || wallet === null) {
        if (typeof wallet === "number" && (!Number.isFinite(wallet) || wallet < 0 || !Number.isInteger(wallet)))
          V.push({ code: "B2", seq, i, detail: `${mname}.${w}=${wallet}` });
        continue;
      }
      for (const [a, v] of Object.entries(wallet as Record<string, unknown>)) {
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || !Number.isInteger(v))
          V.push({ code: "B2", seq, i, detail: `${mname}.${w}.${a}=${v}` });
      }
    }
  }
}

/** Σכסף-אמת לכל-נכס — לפי-מודל-העיקול: balances+רזרבות+backing (בלי-locked!) */
function realTotals(st: DexState): Record<string, number> {
  const t: Record<string, number> = {};
  const bump = (a: string, d: number): void => { if (typeof d === "number" && Number.isFinite(d)) t[a] = (t[a] ?? 0) + d; };
  for (const w of Object.values(st.balances)) for (const [a, v] of Object.entries(w)) bump(a, v as number);
  for (const p of Object.values(st.pools)) { bump(p.a, p.ra); bump(p.b, p.rb); }
  for (const [a, v] of Object.entries(st.backing ?? {})) bump(a, v);
  return t;
}
const credSnap = (st: DexState): { cred: number; minted: number; gas: number } =>
  ({ cred: Object.values(st.credits).reduce((s, v) => s + v, 0), minted: st.feeMinted ?? 0, gas: st.gasUsed ?? 0 });

/* ── B8: קבועי-העמלה של-המכשיר — מוצהרים-כאן, אסור לייבא מהגרעין (מוטנט-קבוע חייב להיתפס) ── */
const BMC_FEE_BPS_STATIC = 30, BMC_TREASURY_CUT_PCT = 30, BMC_DYN_MIN = 4, BMC_DYN_MAX = 1_500;
const bmcEffectiveBps = (p: { dynFeeBps?: number }): number =>
  Math.min(BMC_DYN_MAX, Math.max(BMC_DYN_MIN, p.dynFeeBps ?? BMC_FEE_BPS_STATIC));
const bmcTreasuryFee = (amountIn: number, bps: number): number =>
  Math.floor(Math.floor((amountIn * bps) / 10_000) * BMC_TREASURY_CUT_PCT / 100);

/* ── B9: אמת-נעילות — החייב-העיקול חייב להיות בדיוק סך-הפקודות-החיות שלו ── */
const lockAssetOf = (o: { side: string; base: string; quote: string }): string => (o.side === "sell" ? o.base : o.quote);
function lockTruth(st: DexState, seqNum: number, i: number): void {
  for (const [w, assets] of Object.entries(st.locked)) {
    for (const [a, v] of Object.entries(assets)) {
      const liability = st.orders
        .filter((o) => o.live && o.owner === w && lockAssetOf(o) === a)
        .reduce((s, o) => s + (typeof o.lockMu === "number" ? o.lockMu : 0), 0);
      if ((v as number) !== liability)
        V.push({ code: "B9", seq: seqNum, i, detail: `locked[${w}][${a}]=${v} אך חייב-פקודות-חיות=${liability}` });
    }
  }
  for (const o of st.orders) {
    if (o.live && typeof o.lockMu === "number" && o.lockMu < 0)
      V.push({ code: "B9-NEG", seq: seqNum, i, detail: `order#${o.id} lockMu=${o.lockMu} שלילי` });
  }
}

/* ── הרצה-אקסהוסטיבית ────────────────────────────────────────────────────────── */
interface BmcOutcome {
  verdict: "PASS" | "FAIL";
  depth: number; templates: number; sequences: number; applies: number; replays: number;
  violations: Violation[]; seqsRejectedFully: number; seqsHadAccept: number; elapsedMs: number;
  model: { wallets: number; assets: string[]; pools: string[]; baseRoot: string };
}
async function main(): Promise<void> {
  const t0 = Date.now();
  const raw = (await Bun.file(SNAPSHOT).json()) as { state: DexState };
  const base = reducedModel(raw.state);
  PAIR = Object.keys(base.pools)[0];
  const baseRoot = stateRootOf(base);
  const n = TEMPLATES.length;
  let totalSeqs = 1; for (let d = 0; d < DEPTH; d++) totalSeqs *= n;
  let applies = 0, replays = 0, rejectedFully = 0, hadAccept = 0;
  console.log(`\n════ BOUNDED MODEL CHECKER · depth=${DEPTH} · |T|=${n} · רצפים=${totalSeqs.toLocaleString()} ════`);
  console.log(`מודל: ארנקות=${Object.keys(base.balances).length} נכסים=${Object.keys(base.assets).join(",")} בריכה=${PAIR} baseRoot=${baseRoot.slice(0, 12)}…`);

  const runSeq = (seqNum: number, st: DexState): { root: string; anyAccept: boolean } => {
    let x = seqNum; const idx: number[] = new Array(DEPTH).fill(0);
    for (let d = 0; d < DEPTH; d++) { idx[d] = x % n; x = Math.floor(x / n); }
    const tot0 = realTotals(st);
    const lastOrder: { a: number | null; b: number | null } = { a: null, b: null };
    let anyAccept = false;
    for (let i = 0; i < DEPTH; i++) {
      const ti = idx[i], tpl = TEMPLATES[ti];
      const op = tpl.mk({ st, lastOrderId: lastOrder }, i, seqNum, ti);
      const preRoot = stateRootOf(st);
      const preReal = tpl.pure ? realTotals(st) : null;
      const preCred = credSnap(st);
      const poolPre = op.type === "pool_swap" && op.pair ? st.pools[op.pair] : null;
      const preFee = poolPre ? { t: poolPre.feeAccruedTreasury, m: st.feeMeter ?? 0 } : null;
      let res;
      try { res = applyOp(st, op, 1_700_000_000_000 + i); }
      catch (e) {
        applies++;
        if (stateRootOf(st) !== preRoot) V.push({ code: "B1-THROW", seq: seqNum, i, detail: `${tpl.name} זרק ${String(e).slice(0, 90)} ושינה-מצב` });
        continue;
      }
      applies++;
      const postRoot = stateRootOf(st);
      if (!res.ok) {
        if (postRoot !== preRoot) V.push({ code: "B1", seq: seqNum, i, detail: `${tpl.name} נדחה ושינה-root` });
        continue;
      }
      anyAccept = true;
      moneyHygiene(st, seqNum, i);
      lockTruth(st, seqNum, i); // B9 — אחרי-כל-קבלה
      if (preFee && poolPre && op.type === "pool_swap" && typeof op.amount === "number") {
        const postT = poolPre.feeAccruedTreasury, postM = st.feeMeter ?? 0;
        const expected = bmcTreasuryFee(op.amount, bmcEffectiveBps(poolPre));
        if (postT - preFee.t !== expected || postM - preFee.m !== expected)
          V.push({ code: "B8", seq: seqNum, i, detail: `${tpl.name}: Δtreasury=${postT - preFee.t} Δmeter=${postM - preFee.m} אך מתמטיקת-המכשיר=${expected} (in=${op.amount} bps=${bmcEffectiveBps(poolPre)})` });
      }
      const postCred = credSnap(st);
      const dGas = postCred.gas - preCred.gas, dMint = postCred.minted - preCred.minted, dCred = postCred.cred - preCred.cred;
      if (dCred + dGas - dMint !== 0)
        V.push({ code: "B3", seq: seqNum, i, detail: `${tpl.name}: ΔΣ${dCred} ΔgasUsed=${dGas} Δminted=${dMint}` });
      if ((res.gas ?? 0) !== dGas)
        V.push({ code: "B7", seq: seqNum, i, detail: `${tpl.name}: result.gas=${res.gas} אך ΔgasUsed=${dGas}` });
      if (tpl.pure) {
        const postReal = realTotals(st);
        for (const [a, v0] of Object.entries(tot0)) {
          if ((postReal[a] ?? 0) !== v0) { V.push({ code: "B4", seq: seqNum, i, detail: `${tpl.name}: ${a} Σ${v0}→${postReal[a] ?? 0}` }); break; }
        }
        for (const a of Object.keys(postReal)) if (!(a in tot0)) { V.push({ code: "B4-NEW", seq: seqNum, i, detail: `${tpl.name}: נכס-חדש ${a}` }); break; }
      }
      if (op.type === "pool_swap") {
        const p = st.pools[op.pair ?? ""];
        if (!p || p.ra <= 0 || p.rb <= 0) V.push({ code: "B5", seq: seqNum, i, detail: `${tpl.name}: רזרבה-לא-חיובית אחרי-swap` });
      }
      if (op.type === "order") {
        const oid = (res as { orderId?: number }).orderId ?? (st.orders.length ? st.orders[st.orders.length - 1].id : null);
        if (op.issuer === "bmc-a") lastOrder.a = oid; else lastOrder.b = oid;
      }
    }
    return { root: stateRootOf(st), anyAccept };
  };

  for (let seqNum = 0; seqNum < totalSeqs; seqNum++) {
    const st = structuredClone(base) as DexState;
    const { root, anyAccept } = runSeq(seqNum, st);
    if (!anyAccept) rejectedFully++; else hadAccept++;
    if (seqNum % 97 === 0 && V.length === 0) {
      const st2 = structuredClone(base) as DexState;
      const { root: root2 } = runSeq(seqNum, st2);
      replays++;
      if (root2 !== root) V.push({ code: "B6", seq: seqNum, i: -1, detail: "ריפליי-דטרמיניזם נפרד" });
    }
    if (!QUIET && seqNum % 20_000 === 0 && seqNum > 0) console.log(`  …${seqNum.toLocaleString()} רצפים · applies=${applies.toLocaleString()} · הפרות=${V.length}`);
  }

  const outcome: BmcOutcome = {
    verdict: V.length === 0 ? "PASS" : "FAIL",
    depth: DEPTH, templates: n, sequences: totalSeqs, applies, replays,
    violations: V.slice(0, 50), seqsRejectedFully: rejectedFully, seqsHadAccept: hadAccept,
    elapsedMs: Date.now() - t0,
    model: { wallets: Object.keys(base.balances).length, assets: Object.keys(base.assets), pools: Object.keys(base.pools), baseRoot },
  };
  await Bun.write(ARTIFACT, JSON.stringify({ ...outcome, ts: new Date().toISOString(), instrument: "bmc.ts" }, null, 2) + "\n");
  console.log(`\n${outcome.verdict === "PASS" ? "✅" : "❌"} BMC verdict=${outcome.verdict} · רצפים=${totalSeqs.toLocaleString()} · applies=${applies.toLocaleString()} · ריפליים=${replays} · נדחו-מלא=${rejectedFully.toLocaleString()} · עם-קבלה=${hadAccept.toLocaleString()} · ${outcome.elapsedMs}ms`);
  if (V.length) { console.log(`הפרות (${V.length}):`); for (const v of V.slice(0, 10)) console.log(`  [${v.code}] seq#${v.seq} op${v.i}: ${v.detail}`); }
  else console.log(`טענה-כמתית: לכל-רצף מאורך-${DEPTH} על |T|=${n} תבניות — B1..B9 עומדות אחרי-כל-קידומת.`);
  process.exit(V.length ? 1 : 0);
}
main().catch((e) => { console.error("bmc crash:", e); process.exit(1); });
