/**
 * settle.ts — עמדת-הסליקה (Settlement Desk) · SIM→REAL
 *
 * הפקודה-מוסדית: "ספר-ריבוני, אין כסף-אמת — בודקים את הסוכנים ועושים להם מבחן
 * עם כסף-אמת; מסדרים, מייצבים את השוק שהכל ישב."
 *
 * שלוש-שכבות-הוכחה, מהפנים-החוצה:
 *  1. LEDGER AUDIT (כסף-פנים) — חשבונאות-ברזל על המצב-החי:
 *     · קרדיטים: Σcredits + gasUsed === ג'נזיס (אפס-הטבעה/שריפה מחוץ-לג'נזיס)
 *     · נכסים: Σbalances + Σמאגרים + backing(עטוף) === ג'נזיס, לכל-נכס
 *     · ערבות: locked === Σפקודות-חיות (מדויק, לא-גלובלי) · avail ≥ 0 לכולם
 *     · עמלות: Σpools.feeAccruedTreasury === feeMeter + treasuryProfit (מדידה-כנה)
 *  2. AGENT EXAM (מבחן-סוכנים) — תוכנית-לימוד על שיבוט-מצב דטרמיניסטי:
 *     כל-סוכן עובר QUOTE (גריד) → CROSS (טייקר-חוצה-ספרד) → CANCEL (שחרור-נעילה
 *     מדויק) עם טענת-שימור אחרי-כל-שלב; התוכנית רצה פעמיים על שני-שיבוטים
 *     עצמאיים — stateRoot זהה = דטרמיניזם-מוכח על-העדויות-עצמן.
 *  3. REAL MONEY (כסף-אמת) — ביקורת-חיה מול רשתות-ציבוריות:
 *     · יתרות-אמת: Steem/Hive/ETH/SOL/TRON — קריאה-RPC ישירה, כנות-מלאה לכשל
 *     · אימות-עיגון-טרי: כל-שרשרת — ה-txid החי-האחרון נקרא-חזרה מה-RPC הציבורי
 *       ומושווה ביט-מול-ביט (height+stateRoot) מול-החותם-המקומי (verifyOnChain).
 *
 * אפס-סודות: כאן קוראים רק-כתובות-ציבוריות מ-relayStatus(). אין-מפתחות, אין-חתימות.
 */
import {
  genesisState, stateRoot, applyOp, notional, poolKey,
  type DexState, type Asset,
} from "./kernel";
import { fairPrice, MARKETS } from "./mm";
import { poolMid, getPool } from "./amm";
import { sortBook } from "./book";
import { getWallets } from "./chain";
import { relayStatus, verifyOnChain, type ChainName } from "./relay";

/* ── ג'נזיס-עוגן: טבלת-האמת של ההנפקה (מחושבת מהג'נזיס עצמו — תמיד-מסונכרן) ── */
export interface GenesisTotals {
  credits: number;
  assets: Record<string, number>; // Σbalances + Σpool-reserves (backing ג'נזיס = ∅)
  poolsLp: Record<string, number>; // lp-ג'נזיס לכל-בריכה
}

export function genesisTotals(): GenesisTotals {
  const g = genesisState();
  const assets: Record<string, number> = {};
  const bump = (a: string, d: number): void => { assets[a] = (assets[a] ?? 0) + d; };
  for (const [, wallet] of Object.entries(g.balances)) for (const [a, v] of Object.entries(wallet)) bump(a, v);
  for (const p of Object.values(g.pools)) { bump(p.a, p.ra); bump(p.b, p.rb); }
  const poolsLp: Record<string, number> = {};
  for (const [k, p] of Object.entries(g.pools)) poolsLp[k] = p.lp;
  const credits = Object.values(g.credits).reduce((s, v) => s + v, 0);
  return { credits, assets, poolsLp };
}

/* ── 1. ביקורת-חשבונאות-ברזל על מצב-חי (או שיבוט) ──────────────────────────── */
export interface LedgerAudit {
  ok: boolean;
  credits: { sum: number; gasUsed: number; expected: number; ok: boolean };
  assets: { asset: string; live: number; expected: number; ok: boolean; kind: "native" | "wrapped" | "lp" }[];
  escrow: { accounts: number; lockedSum: number; ordersSum: number; exact: boolean; availOk: boolean; ok: boolean };
  fees: { poolsTreasury: number; feeMeterPlusProfit: number; ok: boolean };
  negatives: string[];
  errors: string[];
}

export function ledgerAudit(st: DexState, totals: GenesisTotals): LedgerAudit {
  const errors: string[] = [];
  const negatives: string[] = [];

  // (a) קרדיטים: אפס-הטבעה מחוץ-לג'נזיס — Σcredits + gasUsed === ג'נזיס
  const creditSum = Object.values(st.credits).reduce((s, v) => s + v, 0);
  const creditsOk = creditSum + st.gasUsed === totals.credits;
  if (!creditsOk) errors.push(`credits: Σ${creditSum}+gas${st.gasUsed} ≠ genesis ${totals.credits}`);

  // (b) נכסים: Σbalances + Σpool-reserves + backing-עטוף === ג'נזיס (לכל-נכס)
  const liveAssets: Record<string, number> = {};
  const bump = (a: string, d: number): void => { liveAssets[a] = (liveAssets[a] ?? 0) + d; };
  for (const [, wallet] of Object.entries(st.balances)) for (const [a, v] of Object.entries(wallet)) bump(a, v);
  for (const p of Object.values(st.pools)) { bump(p.a, p.ra); bump(p.b, p.rb); }
  const backing = st.backing ?? {};
  const assetRows: LedgerAudit["assets"] = [];
  const names = Array.from(new Set([...Object.keys(totals.assets), ...Object.keys(liveAssets), ...Object.keys(backing)]));
  for (const a of names) {
    const isLp = a.startsWith("LP|");
    const isWrapped = a.startsWith("W") && !isLp;
    if (isLp) {
      // היצע-LP: pool.lp − Σbal(LP|) === lp-ג'נזיס (חלק-האוצר-הנעול קבוע)
      const sumBal = liveAssets[a] ?? 0;
      const key = a.slice(3);
      const lpNow = st.pools[key]?.lp ?? 0;
      const expected = (totals.poolsLp[key] ?? 0);
      const ok = lpNow - sumBal === expected;
      assetRows.push({ asset: a, live: lpNow - sumBal, expected, ok, kind: "lp" });
      if (!ok) errors.push(`lp ${key}: implied ${lpNow - sumBal} ≠ genesis ${expected}`);
      continue;
    }
    if (isWrapped) {
      // נכס-עטוף: ההיצע-מעל-הג'נזיס חייב להיות מגובה 1:1 ב-backing
      const live = liveAssets[a] ?? 0;
      const expected = (totals.assets[a] ?? 0) + ((backing[a] ?? 0) - 0);
      const ok = live === expected;
      assetRows.push({ asset: a, live, expected, ok, kind: "wrapped" });
      if (!ok) errors.push(`wrapped ${a}: supply ${live} ≠ genesis+backing ${expected}`);
      continue;
    }
    // נכס-טבעי: Σbal + Σpools + backing(W+x) === ג'נזיס (העטיפה נועלת-את-הטבעי)
    const nativeBacking = backing[`W${a}`] ?? 0;
    const live = (liveAssets[a] ?? 0) + nativeBacking;
    const expected = totals.assets[a] ?? 0;
    const ok = live === expected;
    assetRows.push({ asset: a, live, expected, ok, kind: "native" });
    if (!ok) errors.push(`native ${a}: live ${live} ≠ genesis ${expected}`);
  }

  // (c) ערבות: locked === Σפקודות-חיות (מדויק) · avail ≥ 0 · אין-יתרות-שליליות
  const lockSum: Record<string, Record<string, number>> = {};
  let ordersSum = 0;
  for (const o of st.orders) {
    if (!o.live) continue;
    const rem = o.amount - o.filled;
    if (rem <= 0) continue;
    // FIX(escrow-dust): המד-הפרטי lockMu הוא-מקור-האמת; נגזרת רק-לפקודות-ישנות
    const mu = typeof o.lockMu === "number" && Number.isSafeInteger(o.lockMu) && o.lockMu >= 0
      ? o.lockMu
      : (o.side === "sell" ? rem : notional(o.price, rem));
    if (mu <= 0) continue;
    const w = (lockSum[o.owner] = lockSum[o.owner] ?? {});
    w[o.side === "sell" ? o.base : o.quote] = (w[o.side === "sell" ? o.base : o.quote] ?? 0) + mu;
    ordersSum += mu;
  }
  let lockedSum = 0;
  let availOk = true;
  let accounts = 0;
  for (const [who, wallet] of Object.entries(st.balances)) {
    accounts++;
    for (const [a, v] of Object.entries(wallet)) {
      if (v < 0) negatives.push(`${who}.${a}=${v}`);
      const lk = st.locked[who]?.[a] ?? 0;
      if (lk < 0) negatives.push(`${who}.${a} locked=${lk}`);
      if (v - lk < 0) { availOk = false; negatives.push(`${who}.${a} avail=${v - lk}`); }
    }
  }
  for (const [who, wallet] of Object.entries(st.locked)) {
    for (const [a, v] of Object.entries(wallet)) {
      if (v === 0) continue;
      lockedSum += v;
      const expect = lockSum[who]?.[a] ?? 0;
      if (expect !== v) errors.push(`escrow ${who}.${a}: locked ${v} ≠ orders-sum ${expect}`);
    }
  }
  for (const [who, wallet] of Object.entries(lockSum)) {
    for (const [a, v] of Object.entries(wallet)) {
      const have = st.locked[who]?.[a] ?? 0;
      if (have !== v) errors.push(`escrow-shadow ${who}.${a}: orders-sum ${v} ≠ locked ${have}`);
    }
  }

  // (d) עמלות: מדידה-כנה — Σpools.feeAccruedTreasury === feeMeter + treasuryProfit
  const poolsTreasury = Object.values(st.pools).reduce((s, p) => s + p.feeAccruedTreasury, 0);
  const feesOk = poolsTreasury === st.feeMeter + st.treasuryProfit;
  if (!feesOk) errors.push(`fees: pools ${poolsTreasury} ≠ feeMeter+profit ${st.feeMeter + st.treasuryProfit}`);

  return {
    ok: errors.length === 0 && negatives.length === 0,
    credits: { sum: creditSum, gasUsed: st.gasUsed, expected: totals.credits, ok: creditsOk },
    assets: assetRows,
    escrow: { accounts, lockedSum, ordersSum, exact: errors.filter((e) => e.startsWith("escrow")).length === 0, availOk, ok: errors.filter((e) => e.startsWith("escrow") || e.startsWith("escrow-shadow")).length === 0 && negatives.length === 0 },
    fees: { poolsTreasury, feeMeterPlusProfit: st.feeMeter + st.treasuryProfit, ok: feesOk },
    negatives,
    errors,
  };
}

/* ── 2. מבחן-סוכנים — תוכנית-לימוד דטרמיניסטית על שיבוט-מצב ────────────────── */
export type ExamTask = "quote" | "cross" | "cancel";
export interface AgentExam {
  agent: string;
  tasks: { task: ExamTask; ok: boolean; note: string }[];
  conservationAfterEach: boolean;
  determinismRoot: string;
  score: number; // 0..3
  pass: boolean;
}
export interface ExamReport {
  agents: AgentExam[];
  determinismIdentical: boolean;
  roots: string[];
  audit: LedgerAudit; // ביקורת-סופית על מצב-המבחן (ראיה לשימור-גם-אחרי-המבחן)
  ok: boolean;
}

const EXAM_T0 = 1_700_000_000_000; // חותמת-זמן-קבועה — דטרמיניזם מלא

function clone(st: DexState): DexState {
  return JSON.parse(JSON.stringify(st)) as DexState;
}

/** תוכנית-הלימוד: QUOTE → CROSS → CANCEL, טענת-שימור אחרי-כל-שלב.
 * חוזה: אותם-קלטים על אותו-מצב-התחלתי = אותו-stateRoot (קריאת-ה-kernel). */
function runCurriculum(
  preExam: DexState, agent: string, prices: { bid: number; ask: number; fair: number },
  totals: GenesisTotals,
): { exam: AgentExam; finalRoot: string } {
  const st = clone(preExam);
  const tasks: AgentExam["tasks"] = [];
  let conservationAfterEach = true;
  const check = (phase: string): void => {
    const a = ledgerAudit(st, totals);
    if (!a.ok) { conservationAfterEach = false; tasks.push({ task: "quote", ok: false, note: `${phase}: ${a.errors[0] ?? "conservation"}` }); }
  };
  const push = (task: ExamTask, ok: boolean, note: string): void => { tasks.push({ task, ok, note }); };

  // ── QUOTE: פקודת-גריד buy+sell סביב-הפייר (20k µ, רחוק-מהמגע כדי-לא-לחצות)
  const bidPx = Math.max(1, Math.floor((prices.fair * 9_900) / 10_000));
  const askPx = Math.floor((prices.fair * 10_100) / 10_000);
  // מבחן-מדורג: הסוכן מצטט מה שיש-לו — 20k → 5k → 1k (כנות: מי-שאין-לו-לא-מצטט)
  let rBuy: ReturnType<typeof applyOp> | null = null;
  for (const amt of [20_000, 5_000, 1_000]) {
    rBuy = applyOp(st, { type: "order", issuer: agent, nonce: `exam-${agent}-q1`, base: "SAOS", quote: "USDS", side: "buy", price: bidPx, amount: amt }, EXAM_T0);
    if (rBuy.ok) { push("quote", true, `buy ${amt}µ @${bidPx}`); break; }
    if (amt === 1_000) push("quote", false, `buy: ${rBuy.err}`);
  }
  let rSell: ReturnType<typeof applyOp> | null = null;
  for (const amt of [20_000, 5_000, 1_000]) {
    rSell = applyOp(st, { type: "order", issuer: agent, nonce: `exam-${agent}-q2`, base: "SAOS", quote: "USDS", side: "sell", price: askPx, amount: amt }, EXAM_T0);
    if (rSell.ok) { push("quote", true, `sell ${amt}µ @${askPx}`); break; }
    if (amt === 1_000) push("quote", false, `sell: ${rSell.err}`);
  }
  check(`quote:${agent}`);

  // ── CROSS: טייקר-שוק — חוצה את הספר במחיר-המייקר (איסור-מילוי-עצמי פעיל)
  // בוחרים-צד-שיש-עליו-נזילות-של-אחרים (הספר-החי עמוס-גריד — אמור-לחצות)
  let crossed = false; let crossNote = "no-cross";
  const tryCross = (side: "buy" | "sell"): boolean => {
    const opp = sortBook(st, "SAOS", "USDS", side === "buy" ? "sell" : "buy").find((o) => o.owner !== agent);
    if (!opp) return false;
    const qty = Math.min(5_000, opp.amount - opp.filled);
    if (qty <= 0) return false;
    const r = applyOp(st, { type: "fill", issuer: agent, nonce: `exam-${agent}-x1-${side}`, base: "SAOS", quote: "USDS", side, amount: qty, market: true }, EXAM_T0);
    crossed = r.ok; crossNote = r.ok ? `taker ${side} ${qty}µ @maker ${opp.price} (owner ${opp.owner})` : r.err;
    return r.ok;
  };
  if (!tryCross("buy")) { crossNote = "no-cross"; crossed = false; if (!tryCross("sell")) { crossed = false; } }
  push("cross", crossed, crossNote);
  check(`cross:${agent}`);

  // ── CANCEL: ביטול-פקודה-מנוחה-שלנו — הנעילה-משתחררת-במדויק (לולאת-סגירת-חשבון)
  const mine = st.orders.find((o) => o.live && o.owner === agent && o.nonce === `exam-${agent}-q1`)
    ?? st.orders.find((o) => o.live && o.owner === agent && o.nonce === `exam-${agent}-q2`)
    ?? st.orders.find((o) => o.live && o.owner === agent);
  let cancelled = false; let cancelNote = "no-resting-order";
  if (mine) {
    // FIX(escrow-dust): מד-הנעילה-הפרטי נקרא לפני-הביטול (cancel מאפס את-המד)
    const remPre = mine.amount - mine.filled;
    const held = typeof mine.lockMu === "number" && Number.isSafeInteger(mine.lockMu) && mine.lockMu >= 0
      ? mine.lockMu
      : (mine.side === "sell" ? remPre : notional(mine.price, remPre));
    const lockAsset = mine.side === "sell" ? mine.base : mine.quote;
    const before = st.locked[agent]?.[lockAsset] ?? 0;
    const r = applyOp(st, { type: "cancel", issuer: agent, nonce: `exam-${agent}-c1`, orderId: mine.id }, EXAM_T0);
    const after = st.locked[agent]?.[lockAsset] ?? 0;
    const releasedExact = before - after === held;
    cancelled = r.ok && releasedExact;
    cancelNote = r.ok ? (releasedExact ? `cancel #${mine.id} · lock ${held}µ released exactly` : `cancel ok but lock Δ=${before - after} ≠ held ${held}`) : r.err;
  }
  push("cancel", cancelled, cancelNote);
  check(`cancel:${agent}`);

  const score = tasks.filter((t) => t.ok).length;
  return {
    exam: {
      agent, tasks,
      conservationAfterEach,
      determinismRoot: stateRoot(st),
      score,
      pass: tasks.every((t) => t.ok) && conservationAfterEach,
    },
    finalRoot: stateRoot(st),
  };
}

export function runExam(st: DexState): ExamReport {
  const totals = genesisTotals();
  const preExam = clone(st);
  const fair = fairPrice(preExam, "SAOS", "USDS") || 2_500;
  const prices = { fair, bid: Math.floor((fair * 9_900) / 10_000), ask: Math.floor((fair * 10_100) / 10_000) };
  const agents = ["soldier-1", "soldier-2", "soldier-3", "soldier-4", "bot-a", "bot-b", "bot-c"];
  const run1 = agents.map((a) => runCurriculum(preExam, a, prices, totals));
  const run2 = agents.map((a) => runCurriculum(preExam, a, prices, totals)); // עצמאי-לחלוטין
  const roots1 = run1.map((r) => r.finalRoot);
  const roots2 = run2.map((r) => r.finalRoot);
  const identical = roots1.every((r, i) => r === roots2[i]);
  // ביקורת-סופית על מצב-המבחן (מריצה-1) — השימור-שורד-גם-את-המבחן-עצמו
  const stAfter = clone(preExam);
  for (const a of agents) {
    applyOp(stAfter, { type: "order", issuer: a, nonce: `exam-${a}-q1`, base: "SAOS", quote: "USDS", side: "buy", price: prices.bid, amount: 20_000 }, EXAM_T0);
    applyOp(stAfter, { type: "order", issuer: a, nonce: `exam-${a}-q2`, base: "SAOS", quote: "USDS", side: "sell", price: prices.ask, amount: 20_000 }, EXAM_T0);
  }
  const audit = ledgerAudit(stAfter, totals);
  return {
    agents: run1.map((r) => r.exam),
    determinismIdentical: identical,
    roots: roots1.slice(0, 2),
    audit,
    ok: identical && run1.every((r) => r.exam.pass) && audit.ok,
  };
}

/* ── 3. כסף-אמת: ביקורת-חיה מול רשתות-ציבוריות (קריאה-בלבד, אפס-סודות) ─────── */
export interface RailBalance {
  rail: ChainName;
  identity: string;            // כתובת/חשבון ציבורי
  native: string;              // יתרה-טבעית (מחרוזת-אנושית)
  extra: string;               // רכיב-נוסף (SBD/HBD/VESTS/nonce)
  ok: boolean;                 // האם-הקריאה-חיה-הצליחה
  detail: string;              // מקור-הנתון או-הכשל (כנות-מלאה)
  at: string;
}
export interface AnchorSpot {
  rail: ChainName; height: number; ok: boolean; verified: boolean; detail: string;
}
export interface RealMoneyReport {
  rails: RailBalance[];
  anchors: AnchorSpot[];
  liveRails: number;           // כמה-רשתות ענו-חי
  verifiedNow: number;         // כמה-עיגונים אומתו-כרגע-בקריאה-חוזרת
  ok: boolean;                 // ≥1 rail חי && 0 mismatch
}

const UA = "saos-dex-settle/1.0 (+institutional-audit)";
async function jfetch<T>(url: string, body?: unknown, timeoutMs = 9_000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally { clearTimeout(timer); }
}
const num = (s: string): number => parseFloat(String(s).replace(/[^\d.]/g, "")) || 0;

async function auditRail(rail: ChainName, identity: string): Promise<RailBalance> {
  const at = new Date().toISOString();
  try {
    if (rail === "steem" || rail === "hive") {
      const node = rail === "steem" ? "https://api.steemit.com" : "https://api.hive.blog";
      const r = await jfetch<{ result: { balance: string; sbd_balance?: string; hbd_balance?: string; vesting_shares: string }[] }>(
        node, { jsonrpc: "2.0", method: "condenser_api.get_accounts", params: [[identity]], id: 1 });
      const acc = r.result?.[0];
      if (!acc) throw new Error("account not found");
      const sym = rail === "steem" ? "STEEM" : "HIVE";
      const debt = num(rail === "steem" ? acc.sbd_balance ?? "0" : acc.hbd_balance ?? "0");
      return {
        rail, identity, ok: true,
        native: `${num(acc.balance).toFixed(3)} ${sym}`,
        extra: `${debt.toFixed(3)} ${rail === "steem" ? "SBD" : "HBD"} · ${Math.floor(num(acc.vesting_shares)).toLocaleString("en-US")} VESTS`,
        detail: node.replace("https://", ""), at,
      };
    }
    if (rail === "tron") {
      const r = await jfetch<{ data: { balance?: number }[] }>(`https://api.trongrid.io/v1/accounts/${identity}?visible=true`);
      const sun = r.data?.[0]?.balance ?? 0;
      return {
        rail, identity, ok: true,
        native: `${(sun / 1e6).toFixed(6)} TRX`, extra: `energy-band only (unfunded tx rail)`,
        detail: "api.trongrid.io", at,
      };
    }
    if (rail === "eth") {
      const rpc = process.env.ETH_RPC_URL || "https://eth.llamarpc.com";
      const r = await jfetch<{ result: string; error?: { message: string } }>(rpc, {
        jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [identity, "latest"],
      });
      if (r.error) throw new Error(r.error.message);
      const wei = BigInt(r.result);
      const n = await jfetch<{ result: string }>(rpc, { jsonrpc: "2.0", id: 2, method: "eth_getTransactionCount", params: [identity, "latest"] });
      return {
        rail, identity, ok: true,
        native: `${(Number(wei) / 1e18).toFixed(9)} ETH`, extra: `nonce ${parseInt(n.result, 16)} (broadcasts live)`,
        detail: new URL(rpc).host, at,
      };
    }
    // sol
    const rpc = process.env.SOL_RPC_URL || "https://api.mainnet-beta.solana.com";
    const r = await jfetch<{ result: { value: number } }>(rpc, {
      jsonrpc: "2.0", id: 1, method: "getBalance", params: [identity],
    });
    const lam = r.result?.value ?? 0;
    return {
      rail, identity, ok: true,
      native: `${(lam / 1e9).toFixed(9)} SOL`, extra: `${lam.toLocaleString("en-US")} lamports (memo anchors live)`,
      detail: new URL(rpc).host, at,
    };
  } catch (e) {
    return {
      rail, identity, ok: false, native: "—", extra: "—",
      detail: `read failed: ${e instanceof Error ? e.message.slice(0, 80) : "error"}`, at,
    };
  }
}

/** אימות-עיגון-טרי: מעדיפים רשומה שכבר-אומתה (קריאה-חוזרת-על-עדות-מאונדקסת =
 * ההוכחה-הטריה-החזקה); נופלים לרשומה-חיה-בת-יותר-מ-45ש׳ (חלון-אינדוקס). */
async function anchorSpotCheck(): Promise<AnchorSpot[]> {
  const rs = relayStatus() as { records: { chain: ChainName; height: number; status: string; txid: string | null; stateRoot?: string; verified?: boolean | null; at: string }[] };
  const chains: ChainName[] = ["steem", "hive", "tron", "eth", "sol"];
  const pick = (c: ChainName) =>
    rs.records.find((r) => r.chain === c && r.status === "anchored" && r.txid && r.stateRoot && r.verified === true)
    ?? rs.records.find((r) => r.chain === c && r.status === "anchored" && r.txid && r.stateRoot && Date.now() - new Date(r.at).getTime() > 45_000)
    ?? null;
  const picks = chains.map((c) => {
    const rec = pick(c);
    return rec ? { c, height: rec.height, txid: rec.txid!, stateRoot: rec.stateRoot! } : null;
  });
  return Promise.all(picks.map(async (p, i) => {
    const c = chains[i]!;
    if (!p) return { rail: c, height: 0, ok: false, verified: false, detail: "no anchored record with txid" };
    try {
      const v = await verifyOnChain(p.c, p.txid, { height: p.height, stateRoot: p.stateRoot });
      return { rail: c, height: p.height, ok: v.ok, verified: v.ok, detail: v.detail.slice(0, 120) };
    } catch (e) {
      return { rail: c, height: p.height, ok: false, verified: false, detail: `verify error: ${e instanceof Error ? e.message.slice(0, 80) : "error"}` };
    }
  }));
}

export async function realMoneyAudit(): Promise<RealMoneyReport> {
  const rs = relayStatus() as {
    account: string | null; tronIdentity: string | null;
    identities: { eth: string | null; sol: string | null };
  };
  const identity: Record<ChainName, string | null> = {
    steem: rs.account, hive: rs.account,
    tron: rs.tronIdentity, eth: rs.identities?.eth ?? null, sol: rs.identities?.sol ?? null,
  };
  const rails = await Promise.all(
    (Object.entries(identity) as [ChainName, string | null][]).map(([rail, id]) =>
      id ? auditRail(rail, id) : Promise.resolve({
        rail, identity: "—", ok: false, native: "—", extra: "—",
        detail: "no public identity exposed by relay", at: new Date().toISOString(),
      }),
    ),
  );
  const anchors = await anchorSpotCheck();
  const liveRails = rails.filter((r) => r.ok).length;
  const verifiedNow = anchors.filter((a) => a.verified).length;
  const mismatches = anchors.filter((a) => !a.ok && a.height > 0 && !a.detail.includes("not indexed")).length;
  return { rails, anchors, liveRails, verifiedNow, ok: liveRails >= 1 && mismatches === 0 };
}

/* ── 4. יציבות-שוק: האם-הכל-יושב (מחירים-מתכנסים, ספרד-צמודה, עומק-דו-צדדי) ── */
export interface StabilityReport {
  pair: string;
  refPrice: number; fair: number; poolMid: number; bookMid: number;
  dissonanceBps: { poolVsFair: number; bookVsRef: number; fairVsRef: number };
  spreadBps: number;
  depth1pct: { bidMu: number; askMu: number };   // עומק-בתוך-±1% מהפייר
  topImbalanceBps: number;                        // אי-איזון-מגע (buy-pressure חיובי)
  sitting: boolean;
  reasons: string[];
}

export function stabilityCheck(st: DexState): StabilityReport {
  const m = MARKETS[0]; // SAOS/USDS — הזוג-הריבוני
  const fair = fairPrice(st, m.base, m.quote);
  const p = getPool(st, poolKey(m.base, m.quote));
  const pm = p ? poolMid(p) : 0;
  const ref = st.assets[m.base]?.refPrice ?? 0;
  const bids = sortBook(st, m.base, m.quote, "buy");
  const asks = sortBook(st, m.base, m.quote, "sell");
  const bb = bids[0]?.price ?? 0, ba = asks[0]?.price ?? 0;
  const bookMid = bb > 0 && ba > 0 ? Math.floor((bb + ba) / 2) : (bb || ba || 0);
  const spreadBps = bb > 0 && ba > 0 ? Math.floor(((ba - bb) / ((ba + bb) / 2)) * 10_000) : 0;
  const bps = (a: number, b: number): number => (a > 0 && b > 0 ? Math.floor(((a - b) / b) * 10_000) : 0);
  const lo = fair > 0 ? Math.floor((fair * 9_900) / 10_000) : 0;
  const hi = fair > 0 ? Math.floor((fair * 10_100) / 10_000) : 0;
  const depth = (side: "buy" | "sell"): number =>
    sortBook(st, m.base, m.quote, side)
      .filter((o) => o.price >= lo && o.price <= hi)
      .reduce((s, o) => s + (o.amount - o.filled), 0);
  const bidMu = depth("buy"), askMu = depth("sell");
  const tot = bidMu + askMu;
  const topImbalanceBps = tot > 0 ? Math.floor(((bidMu - askMu) / tot) * 10_000) : 0;
  const d = {
    poolVsFair: bps(pm, fair),
    bookVsRef: bps(bookMid, ref),
    fairVsRef: bps(fair, ref),
  };
  const reasons: string[] = [];
  const sitting =
    Math.abs(d.poolVsFair) <= 60 &&
    Math.abs(d.fairVsRef) <= 450 &&
    spreadBps > 0 && spreadBps <= 45 &&
    bidMu >= 100_000 && askMu >= 100_000 &&
    Math.abs(topImbalanceBps) <= 6_500;
  if (Math.abs(d.poolVsFair) > 60) reasons.push(`pool↔book dissonance ${d.poolVsFair}bps > 60`);
  if (Math.abs(d.fairVsRef) > 450) reasons.push(`fair↔ladder-ref ${d.fairVsRef}bps > 450`);
  if (!(spreadBps > 0 && spreadBps <= 45)) reasons.push(`spread ${spreadBps}bps out of (0,45]`);
  if (bidMu < 100_000 || askMu < 100_000) reasons.push(`depth±1% thin (bid ${bidMu}µ / ask ${askMu}µ < 100k)`);
  if (Math.abs(topImbalanceBps) > 6_500) reasons.push(`top-of-book imbalance ${topImbalanceBps}bps > 6500`);
  return {
    pair: "SAOS/USDS", refPrice: ref, fair, poolMid: pm, bookMid,
    dissonanceBps: d, spreadBps, depth1pct: { bidMu, askMu }, topImbalanceBps,
    sitting, reasons,
  };
}
