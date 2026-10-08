/**
 * invariant-fuzzer.ts — THE ADVERSARIAL INVARIANT FUZZER · מלחך-אינוואריאנטות-אדיברסרי
 * ═════════════════════════════════════════════════════════════════════════════════
 * רמת-הענקים (giants-grade): Uniswap/Maker רצים invariant-testing (Foundry/Echidna),
 * Jepsen רץ אדיברסרי-מוזל על מסדי-נתונים, Stripe רץ deterministic-simulation.
 * העיקרון המשותף: **אף-טענה-עצמית אינה ראיה** — מכונה-תוקפת מנסה לשבור את הגרעין,
 * ובדיקות-בלתי-תלויות (אודיטור-עצמאי שנכתב כאן, לא האודיטור של המנוע) מודדות אחרי
 * כל-פעולה:
 *
 *   I1 · REJECT-ATOMICITY   — כל-op שנדחה משאיר canon(state) שווה-בתים (חוק-הברזל:
 *                             "עסקה-לא-חוקית לא נוגעת במצב").
 *   I2 · CREDIT-IDENTITY    — Σcredits + gasUsed − feeMinted === קבוע-בזלי (דיפרנציאלי:
 *                             לא-תלוי בג'נזיס; תופס כל-הטבעה/דליפה-אנומלית פר-op).
 *   I3 · TRANSFER-CONSERVE  — למשפחות העברה/ספר: Σ(יתרות+בריכות+backing) לכל-נכס נשמר.
 *   I4 · NO-NEGATIVE/NO-FLOAT — אף-ערך-מצב שלילי/לא-שלם/NaN בשדות-הכסף.
 *   I5 · ENGINE-AUDITOR     — האודיטור של המנוע עצמו (settle.ledgerAudit) חייב להיות נקי.
 *   I6 · DETERMINISM        — אותו-seed על שני-שיבוטים → אותו stateRoot סופי.
 *   I7 · REPLAY-CLOSED      — op-מקובל שחוזר שוב נדחה (dedupe קשיח).
 *   I8 · DEFENSE-PROBES     — 22 התקפות-מוכרות חייבות להידחות בדלת וללא נגיעה במצב.
 *
 * מצב-הבדיקה: שיבוט-מוזן של מצב-העולם החי (נשלף מהמנוע החי ב-HTTP — לא-DB),
 * העברות-קרדיט/יתרות ממפעיל→ארנקי-fuzz (Σ נשמר — האודיטור לא נשבר). אפס-כתיבה
 * לשרשרת-החיה: applyOp רץ על structuredClone בלבד.
 *
 * ריצה: DATABASE_URL=file:/home/z/my-project/saos-dex/db/dex.db bun harness/invariant-fuzzer.ts [--seed N]
 * יציאה: exit 0 = PASS · exit 1 = הפרה/קריסה (artifact: audit-package/proof-pack/invariant-fuzz.json)
 */
import {
  applyOp, genesisState, type DexState, type Op, type OpKind,
} from "../src/lib/dex/kernel";
import { canon, stateRootOf } from "../src/lib/dex/canonical";
import { ledgerAudit, genesisTotals } from "../src/lib/dex/settle";
import { InvariantViolation } from "../src/lib/dex/invariant";

/* ── PRNG דטרמיניסטי (mulberry32) — ריצה-חוזרת = אותן-התקפות בדיוק ─────────── */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const argSeed = Number(new URL(import.meta.url).searchParams.get("seed") ?? process.argv[process.argv.indexOf("--seed") + 1] ?? NaN);
const BASE_SEED = Number.isFinite(argSeed) ? argSeed >>> 0 : 0x5a15c0de;

/* ── מצב-חי: הסנאפשוט-הגולמי (הארטיפקט הקנוני ש-state-push מפרסם לגיט) + צליבה-מול-המנוע-החי ── */
const ENGINE = "http://127.0.0.1:3010/saos-dex/api/dex/state";
const SNAPSHOT = new URL("../db/state-snapshot.json", import.meta.url).pathname;
async function fetchLiveState(): Promise<{ state: DexState; height: number; root: string; engineHeight: number; freshness: number }> {
  const engRes = await fetch(ENGINE, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json() as Promise<{ ok: boolean; state: { height: number } }>).catch(() => null);
  if (!engRes?.ok) throw new Error(`live-engine-unreachable (${ENGINE}) — המלחך רץ רק-מול-אמת`);
  const snapFile = Bun.file(SNAPSHOT);
  if (!(await snapFile.exists())) throw new Error("state-snapshot.json חסר — אין-ארטיפקט-מצב");
  const j = await snapFile.json() as { state: DexState };
  const st = j.state;
  if (!st?.height || !st.balances || !st.credits) throw new Error("bad-snapshot-shape");
  const freshness = engRes.state.height - st.height; // ≤ seal-window = טרי
  if (freshness > 600) throw new Error(`snapshot stale: engine h${engRes.state.height} vs snapshot h${st.height} (Δ${freshness} > 600)`);
  return { state: st, height: st.height, root: stateRootOf(st), engineHeight: engRes.state.height, freshness };
}

/* ── מימון-עולם-הבדיקה: העברה (לא הטבעה!) ממפעיל→ארנקי-fuzz · Σ נשמר ─────────── */
const FUZZERS = ["fuzz-a", "fuzz-b", "fuzz-c"];
const ATTACKERS = ["attacker", "", "__proto__", "constructor", "שלום", "a".repeat(300)];
function fundClone(live: DexState): DexState {
  const st = structuredClone(live) as DexState;
  const opCredits = st.credits["operator"] ?? 0;
  // FIX(FZ-תיקון-עצמי): אפס-הטבעה — כל-הקרדיטים לארנקי-הבדיקה **עוברים** מהמפעיל
  // (המלחך-הראשון מטבע 1,500 ל-attacker והאודיטור תפס את זה — כך זה עובד!)
  const fuzzEach = Math.floor(opCredits * 0.5 / FUZZERS.length);
  const attacker = Math.min(1_500, Math.floor(opCredits * 0.1));
  let moved = 0;
  for (const f of FUZZERS) { st.credits[f] = fuzzEach; moved += fuzzEach; }
  st.credits["attacker"] = attacker; moved += attacker;
  st.credits["operator"] = opCredits - moved;
  // יתרות: 25% מכל-נכס של החשבון-העשיר-ביותר (לא האוצר) עובר ל-fuzz-a — Σ נשמר
  const donor = Object.entries(st.balances)
    .filter(([w]) => !["treasury", "reserve-vault", "arena"].includes(w))
    .sort((x, y) => Object.values(y[1]).reduce((s, v) => s + v, 0) - Object.values(x[1]).reduce((s, v) => s + v, 0))[0]?.[0];
  if (donor) {
    const pool = st.balances[donor] ?? {};
    for (const [a, v] of Object.entries(pool)) {
      if (typeof v !== "number" || v <= 0 || a.startsWith("LP|")) continue;
      const take = Math.floor(v * 0.25);
      if (take <= 0) continue;
      st.balances[donor][a] = v - take;
      const fa = st.balances["fuzz-a"] ?? (st.balances["fuzz-a"] = {});
      fa[a] = (fa[a] ?? 0) + take;
    }
  }
  return st;
}

/* ── האודיטור-העצמאי (כתוב-כאן מחדש — לא יבוא מהמנוע) ─────────────────────── */
function sum(obj: Record<string, unknown> | undefined): number {
  if (!obj) return 0;
  let s = 0;
  for (const v of Object.values(obj)) if (typeof v === "number") s += v;
  return s;
}
function creditSum(st: DexState): number { return sum(st.credits); }
function assetF(st: DexState, a: string): number {
  let s = 0;
  for (const w of Object.values(st.balances)) s += (w[a] ?? 0);
  for (const p of Object.values(st.pools)) { if (p.a === a) s += p.ra; if (p.b === a) s += p.rb; }
  return s + (st.backing?.[a] ?? 0);
}
interface Violation { code: string; detail: string; seq?: number; i?: number; opType?: string }

function scanNoNegative(st: DexState, ctx: { seq: number; i: number; opType: string; out: Violation[] }): void {
  const bad = (name: string, v: unknown): void => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      ctx.out.push({ code: "I4-no-negative/integer", detail: `${name} = ${String(v)} (${typeof v})`, seq: ctx.seq, i: ctx.i, opType: ctx.opType });
    }
  };
  for (const [w, wallet] of Object.entries(st.balances)) for (const [a, v] of Object.entries(wallet)) bad(`balances[${w}][${a}]`, v);
  for (const [w, wallet] of Object.entries(st.locked ?? {})) for (const [a, v] of Object.entries(wallet)) bad(`locked[${w}][${a}]`, v);
  for (const [w, v] of Object.entries(st.credits)) bad(`credits[${w}]`, v);
  for (const [k, p] of Object.entries(st.pools)) {
    bad(`pool[${k}].ra`, p.ra); bad(`pool[${k}].rb`, p.rb);
    if (typeof p.lp === "number") bad(`pool[${k}].lp`, p.lp);
    for (const [f, v] of Object.entries(p)) if (f.startsWith("feeAccrued")) bad(`pool[${k}].${f}`, v);
  }
}

/* ── מחוללי-התקפות ──────────────────────────────────────────────────────────── */
const ADV_NUMS: (number | undefined)[] = [0, -1, -1_000_000, 1, 3, 17, 500, 9_999, 1_000_000, 500_000_000, 9_007_199_254_740_991, 1.5, -0.5, Number.MAX_SAFE_INTEGER];
const REAL_ASSETS = ["SAOS", "USDS", "WSTEEM", "WTRX", "WUSDC"];
function pick<T>(r: () => number, arr: T[]): T { return arr[Math.floor(r() * arr.length)]; }

function mkOp(r: () => number, st: DexState, n: number): Op {
  const who = pick(r, [...FUZZERS, ...FUZZERS, "attacker", "operator", "arena", "treasury", pick(r, ATTACKERS)]);
  const to = pick(r, [...FUZZERS, "attacker", "operator", "arena", "reserve-vault", pick(r, ATTACKERS)]);
  const asset = pick(r, [...REAL_ASSETS, "FAKE", "", "WFAKE", "LP|X"]);
  const adv = r() < 0.45; // 45% מה-ops אדיברסריים-מלאים
  const amount = adv ? pick(r, ADV_NUMS) : Math.floor(r() * 250_000) + 1;
  const nonce = `fz-${n}`;
  const fam = pick(r, ["transfer", "transfer", "transfer", "xfer_free", "xfer_free", "order", "order", "cancel", "pool_swap", "pool_add", "wrap_mint", "wrap_burn", "refuel", "mint_fuel", "oco_place", "trig_order", "dca_create", "ve_lock", "bond_buy", "cow_order", "heartbeat", "asset_list", "oracle_set", "harvest", "order_gc", "cancel_all", "vault_open", "batch"]);
  switch (fam) {
    case "transfer":
    case "xfer_free":
      return { type: fam, issuer: who, nonce, to, asset, amount, memo: adv ? pick(r, ["", "x".repeat(300), "\u0000null", "../../etc/passwd"]) : "fz" } as Op;
    case "order": {
      const side = r() < 0.5 ? "buy" : "sell";
      const price = adv ? pick(r, [0, -1300, 1.5, Number.MAX_SAFE_INTEGER, 1e15]) : Math.floor(1300 * (0.8 + r() * 0.4));
      return { type: "order", issuer: who, nonce, base: pick(r, ["SAOS", "USDS", "WSTEEM", "FAKE"]), quote: pick(r, ["USDS", "SAOS", ""]), side, price, amount, postOnly: r() < 0.3, ioc: r() < 0.2 } as Op;
    }
    case "cancel":
      return { type: "cancel", issuer: who, nonce, orderId: adv ? pick(r, [-1, 0, 999999, 1.5]) : Math.floor(r() * 500) } as Op;
    case "cancel_all":
      return { type: "cancel_all", issuer: who, nonce, pair: r() < 0.5 ? "SAOS/USDS" : undefined } as Op;
    case "pool_swap":
      return { type: "pool_swap", issuer: who, nonce, pair: pick(r, ["SAOS/USDS", "WSTEEM/USDS", "X/Y", ""]), assetIn: asset, amount, minOut: adv ? Number.MAX_SAFE_INTEGER : 0 } as Op;
    case "pool_add":
      return { type: "pool_add", issuer: who, nonce, pair: pick(r, ["SAOS/USDS", "X/Y"]), asset, amount } as Op;
    case "wrap_mint":
    case "wrap_burn":
      return { type: fam, issuer: who, nonce, wrapAsset: pick(r, ["WSTEEM", "WTRX", "WUSDC", "WFAKE"]), amount, external: r() < 0.5, claim: r() < 0.3 ? "fake-claim-hash" : undefined } as Op;
    case "refuel":
      return { type: "refuel", issuer: who, nonce, to, amount } as Op;
    case "mint_fuel":
      return { type: "mint_fuel", issuer: who, nonce, to, amount } as Op;
    case "oco_place":
      return { type: "oco_place", issuer: who, nonce, base: "SAOS", quote: "USDS", side: r() < 0.5 ? "buy" : "sell", amount, triggerPx: adv ? -5 : Math.floor(1300 * (0.7 + r() * 0.6)), limitPx: adv ? 0 : Math.floor(1300 * (0.7 + r() * 0.6)), trigDir: r() < 0.5 ? "down" : "up" } as Op;
    case "trig_order":
      return { type: "trig_order", issuer: who, nonce, base: "SAOS", quote: "USDS", side: r() < 0.5 ? "buy" : "sell", amount, triggerPx: adv ? Number.MAX_SAFE_INTEGER : 1250, limitPx: 1300 } as Op;
    case "dca_create":
      return { type: "dca_create", issuer: who, nonce, asset: "USDS", to: "SAOS", everyK: adv ? -3 : 10, perSlice: adv ? 0 : 1_000, slicesMax: adv ? 1e9 : 5, minOutBps: 9_700 } as Op;
    case "ve_lock":
      return { type: "ve_lock", issuer: who, nonce, asset: "SAOS", amount, weeks: adv ? pick(r, [0, -4, 1.5, 999]) : 12 } as Op;
    case "bond_buy":
      return { type: "bond_buy", issuer: who, nonce, asset: "USDS", amount: adv ? pick(r, [10, -5, 1e12]) : Math.floor(r() * 2_000_000) + 50_000 } as Op;
    case "cow_order":
      return { type: "cow_order", issuer: who, nonce, base: "SAOS", quote: "USDS", side: r() < 0.5 ? "buy" : "sell", price: adv ? 0 : 1320, amount } as Op;
    case "heartbeat":
      return { type: "heartbeat", issuer: who, nonce } as Op;
    case "asset_list":
      return { type: "asset_list", issuer: who, nonce, name: pick(r, ["FAKE", "WFAKE", ""]), refPrice: adv ? -1 : 1_000 } as Op;
    case "oracle_set":
      return { type: "oracle_set", issuer: who, nonce, prices: { SAOS: adv ? -1 : 1_300, USDS: 1_000, [pick(r, ["__proto__", "evils", "SAOS"])]: 5 } } as unknown as Op;
    case "harvest":
      return { type: "harvest", issuer: who, nonce } as Op;
    case "order_gc":
      return { type: "order_gc", issuer: who, nonce } as Op;
    case "vault_open":
      return { type: "vault_open", issuer: who, nonce, drawMu: adv ? pick(r, [-1, 0, 1e12]) : Math.floor(r() * 400_000) } as Op;
    case "batch": {
      const inner: Op[] = [];
      const cnt = adv ? pick(r, [0, 1, 9, 30]) : 2;
      for (let k = 0; k < cnt; k++) inner.push({ type: "heartbeat", issuer: who, nonce: `${nonce}-i${k}` } as Op);
      const b = { type: "batch", issuer: who, nonce, ops: inner } as unknown as Op;
      if (adv && r() < 0.4) (b as unknown as { ops: unknown[] }).ops = [(b as unknown as { ops: unknown[] }).ops]; // קינון-אסור
      if (adv && r() < 0.3) inner.push({ type: "heartbeat", issuer: "operator", nonce: `${nonce}-x` } as Op); // מנפיק-זר
      return b;
    }
    default:
      return { type: "heartbeat", issuer: who, nonce } as Op;
  }
}

/* ── הרצה ───────────────────────────────────────────────────────────────────── */
const SEQUENCES = Number(process.env.FUZZ_SEQS ?? 8);
const OPS_PER_SEQ = Number(process.env.FUZZ_OPS ?? 120);
const NOW = 1_700_000_000_000;

interface SeqStat { seq: number; seed: number; ops: number; accepted: number; rejected: number; thrown: number; crashes: Violation[]; finalRoot: string }
const allViolations: Violation[] = [];
const seqStats: SeqStat[] = [];
const engineAuditFailures: string[] = [];

async function main(): Promise<void> {
  console.log(`\n════ ADVERSARIAL INVARIANT FUZZER · seed=${BASE_SEED} · ${SEQUENCES}×${OPS_PER_SEQ} ops + defense-probes + determinism ════`);
  const live = await fetchLiveState();
  console.log(`live: engine h=${live.engineHeight} snapshot h=${live.height} (Δfresh=${live.freshness}) root=${live.root.slice(0, 12)}… · wallets=${Object.keys(live.state.balances).length} orders=${live.state.orders.length} pools=${Object.keys(live.state.pools).length}`);
  const totals = genesisTotals();
  const famCount = new Map<string, { ok: number; no: number; thr: number }>();

  const runSeq = (seq: number, seed: number, st: DexState, twin = false): SeqStat | null => {
    const r = mulberry32(seed);
    const stat: SeqStat = { seq, seed, ops: 0, accepted: 0, rejected: 0, thrown: 0, crashes: [], finalRoot: "" };
    const C0 = creditSum(st) + (st.gasUsed ?? 0) - (st.feeMinted ?? 0); // זהות-הבזל
    void C0;
    for (let i = 0; i < OPS_PER_SEQ; i++) {
      const op = mkOp(r, st, seq * 1000 + i);
      const before = canon(st);
      const tracked = new Set<string>([...REAL_ASSETS, ...Object.keys(st.backing ?? {}), "WUSDC"]);
      const F_BEFORE = new Map<string, number>();
      for (const a of tracked) F_BEFORE.set(a, assetF(st, a));
      let res: { ok: boolean; err?: string } | null = null;
      try {
        res = applyOp(st, op, NOW);
      } catch (e) {
        stat.thrown++;
        const isInv = e instanceof InvariantViolation;
        const isCanon = e instanceof Error && e.name === "CanonicalError";
        if (!isInv && !isCanon) {
          stat.crashes.push({ code: `CRASH-${e instanceof Error ? e.constructor.name : typeof e}`, detail: `${op.type}: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`, seq, i, opType: op.type });
        }
        const after = canon(st);
        if (after !== before) stat.crashes.push({ code: "THREW-BUT-MUTATED", detail: `${op.type} threw ${isInv ? "InvariantViolation" : ""} AND mutated state`, seq, i, opType: op.type });
        continue;
      }
      stat.ops++;
      const fam = op.type as string;
      const fc = famCount.get(fam) ?? { ok: 0, no: 0, thr: 0 };
      if (res.ok) { stat.accepted++; fc.ok++; } else { stat.rejected++; fc.no++; }
      famCount.set(fam, fc);
      // I1 · reject-atomicity
      if (!res.ok) {
        const after = canon(st);
        if (after !== before) {
          // FIX(fuzz-r3): לא רק "שונה" — **מה** שונה (הבדל-שדות מדויק + ה-op עצמו לשחזור)
          const diff: string[] = [];
          try {
            const b = JSON.parse(before) as Record<string, unknown>, a = JSON.parse(after) as Record<string, unknown>;
            const walk = (p1: unknown, p2: unknown, path: string): void => {
              if (typeof p1 === "number" && typeof p2 === "number") { if (p1 !== p2) diff.push(`${path}: ${p1}→${p2}`); return; }
              if (Array.isArray(p1) && Array.isArray(p2)) { if (p1.length !== p2.length) diff.push(`${path}.len: ${p1.length}→${p2.length}`); else p1.forEach((x, i) => walk(x, p2[i], `${path}[${i}]`)); return; }
              if (p1 && p2 && typeof p1 === "object" && typeof p2 === "object") {
                const o1 = p1 as Record<string, unknown>, o2 = p2 as Record<string, unknown>;
                for (const k of new Set([...Object.keys(o1), ...Object.keys(o2)])) walk(o1[k], o2[k], `${path}.${k}`);
              } else if (p1 !== p2) diff.push(`${path}: ${String(p1).slice(0, 30)}→${String(p2).slice(0, 30)}`);
            };
            walk(b, a, "$");
          } catch { diff.push("(diff-walk failed)"); }
          stat.crashes.push({ code: "I1-REJECT-MUTATED-STATE", detail: `${op.type} rejected (${res.err}) changed: ${diff.slice(0, 4).join(" | ").slice(0, 240)} · op=${JSON.stringify({ type: op.type, issuer: op.issuer, base: op.base, quote: op.quote, side: op.side, price: op.price, amount: op.amount, postOnly: op.postOnly }).slice(0, 200)}`, seq, i, opType: op.type });
        }
      } else {
        // I2 · זהות-הקרדיט אחרי-כל-op-מקובל
        const C1 = creditSum(st) + (st.gasUsed ?? 0) - (st.feeMinted ?? 0);
        if (C1 !== C0) stat.crashes.push({ code: "I2-CREDIT-IDENTITY-BROKEN", detail: `${op.type}: C ${C1} ≠ C0 ${C0} (Δ=${C1 - C0})`, seq, i, opType: op.type });
        // I3 · שימור-העברות (משפחות-טהורות) — דיפרנציאל before/after פר-op (FIX: הבזל
        // הסטטי-הייתה באג-של-המלחך: wrap/pool מוקדם-ברצף משנה F לגיטימית)
        if (["transfer", "pay", "xfer_free", "heartbeat", "cancel", "cancel_all", "order_gc", "attest", "refuel"].includes(fam)) {
          for (const [a, f0] of F_BEFORE) {
            const f1 = assetF(st, a);
            if (f1 !== f0) stat.crashes.push({ code: "I3-TRANSFER-CONSERVE", detail: `${op.type}: asset ${a} F ${f1} ≠ before ${f0} (Δ=${f1 - f0})`, seq, i, opType: op.type });
          }
        }
        // I7 · replay
        const rr = applyOp(st, op, NOW);
        if (rr.ok) stat.crashes.push({ code: "I7-REPLAY-ACCEPTED", detail: `${op.type} replay accepted (nonce=${op.nonce})`, seq, i, opType: op.type });
      }
      // I4 · לא-שלילי/לא-float — כל-op
      scanNoNegative(st, { seq, i, opType: String(op.type), out: stat.crashes });
      // I5 · האודיטור-של-המנוע — כל-15 ops + אחרון
      if (i % 15 === 14 || i === OPS_PER_SEQ - 1) {
        const audit = ledgerAudit(st, totals);
        if (audit.ok === false && Array.isArray(audit.errors) && audit.errors.length) {
          engineAuditFailures.push(`seq${seq}/op${i}: ${audit.errors.slice(0, 3).join(" | ")}`);
        }
      }
    }
    stat.finalRoot = stateRootOf(st);
    if (twin) return stat; // ריצה-תאומה: אותו-seq (אותם-nonceים) — רק-השורש נבדק, לא נרשם
    allViolations.push(...stat.crashes);
    return stat;
  };

  // I8 · פרובות-הגנה — התקפות-מוכרות שחייבות-להידחות בדלת
  const defenseProbes = (): { name: string; op: Op; expectReject: true }[] => {
    const mk = (o: Partial<Op> & { type: OpKind }): Op => ({ issuer: "fuzz-a", nonce: `dp-${Math.random().toString(36).slice(2)}`, ...o } as Op);
    const list: { name: string; op: Op }[] = [
      { name: "P01 negative-amount", op: mk({ type: "transfer", to: "fuzz-b", asset: "USDS", amount: -5 }) },
      { name: "P02 zero-amount", op: mk({ type: "transfer", to: "fuzz-b", asset: "USDS", amount: 0 }) },
      { name: "P03 float-amount", op: mk({ type: "transfer", to: "fuzz-b", asset: "USDS", amount: 1.5 }) },
      { name: "P04 proto-issuer", op: mk({ type: "heartbeat", issuer: "__proto__" }) },
      { name: "P05 proto-recipient", op: mk({ type: "transfer", to: "__proto__", asset: "USDS", amount: 5 }) },
      { name: "P06 constructor-issuer", op: mk({ type: "heartbeat", issuer: "CONSTRUCTOR" }) },
      { name: "P07 over-balance-transfer", op: mk({ type: "transfer", to: "fuzz-b", asset: "USDS", amount: 500_000_000_000 }) },
      { name: "P08 negative-price-order", op: mk({ type: "order", base: "SAOS", quote: "USDS", side: "buy", price: -1300, amount: 100 }) },
      { name: "P09 wrap_mint-external-non-treasury", op: mk({ type: "wrap_mint", wrapAsset: "WSTEEM", amount: 1_000_000, external: true, claim: "op-claim-fake" }) },
      { name: "P10 mint_fuel-non-treasury", op: mk({ type: "mint_fuel", to: "fuzz-a", amount: 100_000 }) },
      { name: "P11 primer-non-treasury", op: mk({ type: "primer" }) },
      { name: "P12 oracle_set-non-treasury", op: mk({ type: "oracle_set", prices: { SAOS: 9_999 } }) },
      { name: "P13 asset_list-non-treasury", op: mk({ type: "asset_list", name: "EVIL", refPrice: 1 }) },
      { name: "P14 xfer_free-over-cap", op: mk({ type: "xfer_free", to: "fuzz-b", asset: "USDS", amount: 3_000_000 }) },
      { name: "P15 batch-nested", op: mk({ type: "batch", ops: [{ type: "batch", issuer: "fuzz-a", nonce: "nest", ops: [] } as Op] }) },
      { name: "P16 batch-over-8", op: mk({ type: "batch", ops: Array.from({ length: 9 }, (_, k) => ({ type: "heartbeat", issuer: "fuzz-a", nonce: `b${k}` } as Op)) }) },
      { name: "P17 batch-foreign-issuer", op: mk({ type: "batch", ops: [{ type: "heartbeat", issuer: "operator", nonce: "for" } as Op] }) },
      { name: "P18 unknown-op", op: { type: "steal_funds", issuer: "fuzz-a", nonce: "u1" } as unknown as Op },
      { name: "P19 no-nonce", op: { type: "heartbeat", issuer: "fuzz-a", nonce: "" } as Op },
      { name: "P20 huge-ve-weeks", op: mk({ type: "ve_lock", asset: "SAOS", amount: 100, weeks: 999 }) },
      { name: "P21 pool_swap-absurd-minOut", op: mk({ type: "pool_swap", pair: "SAOS/USDS", assetIn: "SAOS", amount: 1_000, minOut: Number.MAX_SAFE_INTEGER }) },
      { name: "P22 negative-refPrice", op: mk({ type: "asset_price", name: "SAOS", refPrice: -1 }) },
    ];
    return list.map((x) => ({ ...x, expectReject: true as const }));
  };

  const probeState = fundClone(structuredClone(live.state));
  const probeResults: { name: string; pass: boolean; detail: string }[] = [];
  {
    const r = mulberry32(0xdefe);
    // תדלוק-ארנקי-הבדיקה-כבר-ב-fundClone; הפרובות נגד probeState
    const before = canon(probeState);
    for (const p of defenseProbes()) {
      let rejected = false, err = "";
      try {
        const rr = applyOp(probeState, p.op, NOW);
        rejected = !rr.ok; err = rr.ok ? "ACCEPTED(!)" : String(rr.err);
      } catch (e) { rejected = true; err = `threw:${e instanceof Error ? e.name : "?"}`; }
      probeResults.push({ name: p.name, pass: rejected, detail: err.slice(0, 80) });
    }
    const after = canon(probeState);
    probeResults.push({ name: "P99 probes-left-state-unchanged", pass: before === after, detail: before === after ? "canon-equal" : "MUTATED" });
  }

  // הרצת-רצפים + דטרמיניזם (I6) — ריצה-כפולה על 3 seeds
  const detPairs: { seed: number; a: string; b: string }[] = [];
  for (let s = 0; s < SEQUENCES; s++) {
    const seed = (BASE_SEED + s * 7919) >>> 0;
    const st = fundClone(structuredClone(live.state));
    seqStats.push(runSeq(s, seed, st));
    if (s < 3) {
      const stB = fundClone(structuredClone(live.state));
      runSeq(s, seed, stB, true); // אותו-seed + אותו-seq (אותם-nonceים) — ריצה-תאומה לדטרמיניזם
      detPairs.push({ seed, a: seqStats[seqStats.length - 1].finalRoot, b: stateRootOf(stB) });
    }
    process.stdout.write(`  seq ${s + 1}/${SEQUENCES} done (ok=${seqStats[s].accepted} no=${seqStats[s].rejected} thr=${seqStats[s].thrown})\n`);
  }

  /* ── דוח ── */
  const detOk = detPairs.every((p) => p.a === p.b);
  const probesPass = probeResults.filter((p) => p.pass).length;
  const totalOps = seqStats.reduce((s, x) => s + x.ops, 0);
  const totalAccepted = seqStats.reduce((s, x) => s + x.accepted, 0);
  const totalRejected = seqStats.reduce((s, x) => s + x.rejected, 0);
  const totalThrown = seqStats.reduce((s, x) => s + x.thrown, 0);
  const crashCount = allViolations.length;
  const verdict = crashCount === 0 && detOk && probesPass === probeResults.length && engineAuditFailures.length === 0 ? "PASS" : "FAIL";

  console.log(`\n── DEFENSE PROBES: ${probesPass}/${probeResults.length} ──`);
  for (const p of probeResults) console.log(`  ${p.pass ? "✓" : "✗"} ${p.name} → ${p.detail}`);
  console.log(`\n── DETERMINISM (I6): ${detOk ? "PASS" : "FAIL"} ──`);
  for (const p of detPairs) console.log(`  seed ${p.seed}: ${p.a.slice(0, 10)}… vs ${p.b.slice(0, 10)}… ${p.a === p.b ? "≡" : "≠"}`);
  console.log(`\n── FAMILY ACCEPT/REJECT (הדלת מדברת) ──`);
  for (const [f, c] of [...famCount].sort()) console.log(`  ${f.padEnd(12)} ok=${c.ok} no=${c.no} thr=${c.thr}`);
  console.log(`\n── VERDICT: ${verdict} ──`);
  console.log(`  ops=${totalOps} accepted=${totalAccepted} rejected=${totalRejected} threw=${totalThrown} violations=${crashCount} engineAuditFailures=${engineAuditFailures.length}`);
  if (allViolations.length) for (const v of allViolations.slice(0, 12)) console.log(`  ✗ ${v.code} [${v.opType}] ${v.detail.slice(0, 160)}`);
  if (engineAuditFailures.length) for (const e of engineAuditFailures.slice(0, 5)) console.log(`  ✗ ENGINE-AUDIT ${e.slice(0, 200)}`);

  const report = {
    instrument: "invariant-fuzzer",
    at: new Date().toISOString(),
    engineHeight: live.height,
    engineRoot: live.root,
    seed: BASE_SEED,
    sequences: SEQUENCES, opsPerSeq: OPS_PER_SEQ,
    totals: { ops: totalOps, accepted: totalAccepted, rejected: totalRejected, threw: totalThrown, violations: crashCount },
    invariants: {
      I1_rejectAtomicity: !allViolations.some((v) => v.code.includes("REJECT-MUTATED")),
      I2_creditIdentity: !allViolations.some((v) => v.code.startsWith("I2")),
      I3_transferConserve: !allViolations.some((v) => v.code.startsWith("I3")),
      I4_noNegativeNoFloat: !allViolations.some((v) => v.code.startsWith("I4")),
      I5_engineAuditorClean: engineAuditFailures.length === 0,
      I6_determinism: detOk,
      I7_replayClosed: !allViolations.some((v) => v.code.startsWith("I7")),
      I8_defenseProbes: `${probesPass}/${probeResults.length}`,
    },
    defenseProbes: probeResults,
    determinismPairs: detPairs.map((p) => ({ seed: p.seed, match: p.a === p.b })),
    violations: allViolations.slice(0, 40),
    engineAuditFailures: engineAuditFailures.slice(0, 10),
    verdict,
  };
  await Bun.write("audit-package/proof-pack/invariant-fuzz.json", JSON.stringify(report, null, 2));
  console.log(`\nartifact → audit-package/proof-pack/invariant-fuzz.json`);
  if (verdict !== "PASS") process.exit(1);
}

await main();
