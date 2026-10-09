/**
 * revenue-router.ts — AUTOMATED REVENUE ROUTER · "תשואה → חבילות-נזילות → דלק-צולב"
 * ═══════════════════════════════════════════════════════════════════════════════
 * דבר-ההנחיה (2026-10-08): "Construct a native sub-routine within the core engine
 * directory that monitors the accrued curation and post yields on the verified
 * Steem track, formats them into structured liquidation payloads, and flags the
 * packages as BROADCAST-READY to prepare for cross-chain fuel distribution to
 * the unfunded Blurt and Tron accounts."
 *
 * מה-הוא עושה (כל-6ש' · liquidity-cadence):
 *   1) מודד תשואה-חיה מול STEEM (rewards + liquid) — **קופץ-צמתים** על 429/שהיה
 *      (RPC-circuit-override: STEEM_NODES סדור, צומת-מת = דלוג-מיידי).
 *   2) כשיש-מה לתבוע → claim_reward_balance (posting, אפס-עלות — אותו-מנוע-מוכח
 *      של steem-fuel-loop: signGrapheneTx RFC6979 + broadcast_transaction_synchronous).
 *   3) בונה חבילות-מימוש (liquidation payloads) מובנות: מקור (STEEM נזיל) → יעדי-
 *      דלק (BLURT army ביתרות-חיות · TRON sun · ETH gas · SOL rent) — כל-חבילה
 *      נושאת BROADCAST-READY כשמבנה-ה-op מלא (מוכן לחתימה-מקומית-מיידית).
 *   4) כותב קבלה-ציבורית (receipts/revenue-router-latest.json) + קובץ-חבילה
 *      (state/broadcast-pending/revenue-<ts>.json).
 *
 * כנות-מבנית: ההמרה-בפועל STEEM→BLURT/TRX דורשת venue-חוץ — הערוץ נרשם
 * "venue-pending" עד-הכרעה (הצ'רטר: אפס-endpoints-לא-מורשים). חבילות-מימוש
 * לא מדמות-יתרות-שאינן. אפס-סודות בקבלות · אפס-נתיבי-עבודה.
 *
 * T-34 החלטות-מוטמעות:
 *  · D1 (spread): מדידת-מחירים-בלבד (CoinGecko-public, read-only) — מזין-את-
 *    הכרעת-ה-venue; **אפס-מסחר** בלי-הכרעת-בעלים (הצ'רטר).
 *  · D3 (payload-canon): saos.liquidation-pkg/1 (חבילות למטה) · saos.tx-meta/1
 *    (tx/<chain>/<ts>-<op>.json — מטא-בלבד) · saos.tx-latency/1
 *    (tx/broadcast-latency.jsonl ~150B/שורה — metadata-only).
 *  · D4 (mesh): סדר-הקפצת-צמתים = דירוג-latency-חי מ-receipts/rpc-mesh-latest.json
 *    (טרי <26ש') — fallback ל-STEEM_NODES הקנוני.
 */
import fs from "fs";
import path from "path";
import { grapheneOpsBroadcast, STEEM_NODES, BLURT_NODES, ZERO_CHAIN_ID } from "../src/lib/dex/relay";

await import("dotenv/config");

const NOW = new Date().toISOString();
const ACCOUNT = (process.env.SAOS_RELAY_AGENT_ACCOUNT ?? "").toLowerCase();
const WIF = process.env.STEEM_POSTING_WIF ?? "";
const MOTHER = path.join(process.cwd(), "..");
const OUT = path.join(MOTHER, "receipts", "revenue-router-latest.json");
const PKG_DIR = path.join(process.cwd(), "state", "broadcast-pending");
const TX_DIR = path.join(process.cwd(), "tx");           // saos.tx-meta/1 — בידוד-נתונים
const TX_LATENCY = path.join(TX_DIR, "broadcast-latency.jsonl"); // saos.tx-latency/1

/* ── D4: סדר-צמתים מהדירוג-החי (rpc-mesh) — fallback קנוני ── */
function steemNodeOrder(): string[] {
  try {
    const mesh = JSON.parse(fs.readFileSync(path.join(MOTHER, "receipts", "rpc-mesh-latest.json"), "utf8")) as { at?: string; ranked?: { steem?: Array<{ node: string; ok: boolean }> } };
    const fresh = mesh.at ? Date.now() - Date.parse(mesh.at) < 26 * 3600 * 1000 : false;
    const ok = (mesh.ranked?.steem ?? []).filter((n) => n.ok).map((n) => n.node);
    if (fresh && ok.length > 0) return [...ok, ...STEEM_NODES.filter((n) => !ok.includes(n))];
  } catch { /* כנות */ }
  return STEEM_NODES;
}

/* ── D3: לוג-שידור — מטא-בלבד, אפס-סודות ── */
function logTxMeta(chain: string, op: string, entry: Record<string, unknown>): void {
  try {
    const dir = path.join(TX_DIR, chain);
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(dir, `${ts}-${op}.json`), JSON.stringify({ schema: "saos.tx-meta/1", at: new Date().toISOString(), chain, op, ...entry, keysLeaked: false }, null, 1) + "\n");
    fs.mkdirSync(TX_DIR, { recursive: true });
    // T-34-QB: node ביומן-ה-latency (מזין-את-דירוג-rpc-mesh) · txid מקוצר-ל-16 (מלא-ב-tx-meta/1) — תקרת-~150B/שורה
    const line = JSON.stringify({ at: new Date().toISOString(), chain, op, node: entry.node ?? null, ms: entry.latencyMs ?? null, status: entry.status ?? null, txid: entry.txid ? String(entry.txid).slice(0, 16) : null });
    fs.appendFileSync(TX_LATENCY, line + "\n");
  } catch { /* כנות */ }
}

/* ── D1: מדידת-שערים (read-only · CoinGecko-public · אפס-מסחר) ── */
async function measureSpread(): Promise<Record<string, unknown>> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 9000);
    try {
      const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=steem,blurt,tron&vs_currencies=usd", { signal: ctl.signal });
      if (!res.ok) return { status: "unreachable-honest", note: "measurement-only · no trading" };
      const p = (await res.json()) as { steem?: { usd?: number }; blurt?: { usd?: number }; tron?: { usd?: number } };
      const steemUsd = p.steem?.usd ?? null, blurtUsd = p.blurt?.usd ?? null, tronUsd = p.tron?.usd ?? null;
      const treasuryUsd = steemUsd != null ? liquidSteemMeas * steemUsd : null;
      return {
        status: "measured (read-only)",
        pricesUsd: { steem: steemUsd, blurt: blurtUsd, tron: tronUsd },
        treasuryUsd,
        impliedIfLiquidated: {
          blurtBuyable: steemUsd != null && blurtUsd ? Math.floor((liquidSteemMeas * steemUsd) / blurtUsd * 1e6) / 1e6 : null,
          tronBuyable: steemUsd != null && tronUsd ? Math.floor((liquidSteemMeas * steemUsd) / tronUsd * 1e6) / 1e6 : null,
        },
        doctrine: "measurement-only — feeds venue decision · zero execution (charter: venue-pending owner decision)",
      };
    } finally { clearTimeout(t); }
  } catch { return { status: "unreachable-honest", note: "measurement-only · no trading" }; }
}
let liquidSteemMeas = 0;

if (!ACCOUNT || !WIF) {
  console.error(JSON.stringify({ status: "not-armed (STEEM_POSTING_WIF/SAOS_RELAY_AGENT_ACCOUNT missing) — honest exit" }));
  process.exit(0); // כנות: לא-חמוש ≠ כשל-מערכת
}

/* ── RPC-circuit-override: קופץ-צמתים לפי-סדר — 429/timeout/שגיאה = צומת-הבא ── */
async function grapheneAny<T>(nodes: string[], method: string, params: unknown, timeoutMs = 12000): Promise<T> {
  const errors: string[] = [];
  for (const node of nodes) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(node, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }), signal: ctl.signal,
        });
        if (res.status === 429) { errors.push(`${node} 429`); continue; }
        const json = (await res.json()) as { result?: T; error?: { message?: string } };
        if (json.error) { errors.push(`${node} ${String(json.error.message).slice(0, 60)}`); continue; }
        return json.result as T;
      } finally { clearTimeout(t); }
    } catch (e) { errors.push(`${node} ${(e as Error).name}`); }
  }
  throw new Error(`all nodes failed: ${errors.join(" | ").slice(0, 180)}`);
}

type Acct = { balance: string; sbd_balance: string; reward_steem_balance: string; reward_sbd_balance: string; reward_vesting_balance: string };
const num = (s: string | undefined) => Number(String(s ?? "0").split(" ")[0]) || 0;

/* ── 1) תשואה-חיה ── */
const [acc] = await grapheneAny<Acct[]>(STEEM_NODES, "condenser_api.get_accounts", [[ACCOUNT]]);
if (!acc) throw new Error("steem unreachable on all nodes (honest)");
const rStm = num(acc.reward_steem_balance), rSbd = num(acc.reward_sbd_balance), rVest = num(acc.reward_vesting_balance);
const liquidSteem = num(acc.balance), liquidSbd = num(acc.sbd_balance);
liquidSteemMeas = liquidSteem;

/* ── 2) תביעה כשיש-מה (אותו-מנוע-מוכח) ── */
let claim: { txid: string; claimed: { steem: number; sbd: number; vesting: number } } | null = null;
let claimError: string | null = null;
if (rStm > 0 || rSbd > 0 || rVest > 0) {
  const op: [string, Record<string, unknown>] = ["claim_reward_balance", {
    account: ACCOUNT,
    reward_steem: acc.reward_steem_balance,
    reward_sbd: acc.reward_sbd_balance,
    reward_vesting: acc.reward_vesting_balance,
  }];
  const order = steemNodeOrder();
  for (const node of order) {
    const t0 = Date.now();
    try {
      const r = await grapheneOpsBroadcast(node, ZERO_CHAIN_ID, ACCOUNT, [op], WIF, "posting");
      claim = { txid: r.txid, claimed: { steem: rStm, sbd: rSbd, vesting: rVest } };
      logTxMeta("steem", "claim_reward_balance", { status: "confirmed", txid: r.txid, block: r.block ?? null, node: node.replace("https://", ""), latencyMs: Date.now() - t0, amounts: claim.claimed });
      break;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 100);
      logTxMeta("steem", "claim_reward_balance", { status: "failed-honest", node: node.replace("https://", ""), latencyMs: Date.now() - t0, error: msg });
      claimError = msg;
    }
  }
}

/* ── 3) יעדי-דלק — מדידה-חיה, אפס-המצאה ── */
/* BLURT: כל-חיילי-הצבא מהמטריצה-הקנונית (שמות-פאב-בלבד מ-connect-all) + יתרות-חיות */
let army: Array<{ username: string; balance: number }> = [];
let blurtPrimary: number | null = null;
try {
  const ca = JSON.parse(fs.readFileSync(path.join(MOTHER, "receipts", "connect-all-latest.json"), "utf8")) as { matrix?: Array<{ username: string }> };
  const names = (ca.matrix ?? []).map((r) => r.username);
  if (names.length > 0) {
    const res = await grapheneAny<Array<{ name: string; balance: string }> | null>(BLURT_NODES, "condenser_api.get_accounts", [names], 12000).catch(() => null);
    for (const a of res ?? []) {
      const b = num(a.balance);
      if (String(a.name).toLowerCase() === ACCOUNT) blurtPrimary = b;
      army.push({ username: String(a.name), balance: b });
    }
    army.sort((x, y) => x.balance - y.balance);
  }
} catch { /* כנות — army נשאר ריק */ }

/* TRON/ETH/SOL: מה-telemetry הקנוני (אפס-כפילות-זהויות) */
type FuelPrimary = { tron?: { sun?: number | null } | null; eth?: { wei?: number | null } | null; sol?: { lamports?: number | null } | null };
type FuelPending = { eth?: { balanceWei?: string; missingWei?: string; status?: string } | null; sol?: { balanceLamports?: number; missingLamports?: string; status?: string } | null };
let tronSun: number | null = null, ethWei: string | null = null, solLamports: number | null = null;
let ethStatus: string | null = null, solStatus: string | null = null;
try {
  const fsState = JSON.parse(fs.readFileSync(path.join(MOTHER, "receipts", "fuel-state-latest.json"), "utf8")) as { primary?: FuelPrimary };
  tronSun = fsState.primary?.tron?.sun ?? null;
  ethWei = fsState.primary?.eth?.wei != null ? String(fsState.primary.eth.wei) : null;
  solLamports = fsState.primary?.sol?.lamports ?? null;
} catch { /* כנות */ }
try {
  const pend = JSON.parse(fs.readFileSync(path.join(MOTHER, "receipts", "broadcast-pending-latest.json"), "utf8")) as FuelPending;
  ethStatus = pend.eth?.status ?? null; solStatus = pend.sol?.status ?? null;
  if (pend.eth?.missingWei) ethWei = ethWei ?? String(BigInt(pend.eth.balanceWei ?? "0"));
} catch { /* כנות */ }

/* ── 4) חבילות-מימוש ── */
const packages: Array<Record<string, unknown>> = [];

/* PKG-CLAIM — תביעת-התשואה (op-מובנה-מלא — BROADCAST-READY מטבע-הדבר, ובוצעה-מיד) */
if (rStm > 0 || rSbd > 0 || rVest > 0) {
  packages.push({
    id: "PKG-CLAIM-STEEM-YIELD",
    kind: "claim_reward_balance",
    account: ACCOUNT,
    amounts: { steem: rStm, sbd: rSbd, vesting: rVest },
    authority: "posting",
    cost: "zero (RC-covered)",
    status: claim ? "BROADCASTED-CONFIRMED" : claimError ? "claim-failed-honest" : "BROADCAST-READY",
    txid: claim?.txid ?? null,
    error: claimError,
  });
}

/* PKG-LIQUIDATION — הקופה-הנזילה → תוכנית-ניתוב-דלק (venue-pending — כנות) */
const armyUnfunded = army.filter((a) => a.balance < 0.1);
packages.push({
  id: "PKG-STEEM-LIQUIDATION",
  kind: "liquidation-payload",
  source: { chain: "steem", account: ACCOUNT, liquid: { steem: liquidSteem, sbd: liquidSbd }, note: "post-claim treasury" },
  routePlan: [
    { step: 1, from: "steem-liquid", to: "venue", status: "venue-pending (owner decision — charter: no unauthorized endpoints)" },
    { step: 2, from: "venue", to: "blurt-army-funding", status: armyUnfunded.length > 0 ? "awaiting-venue" : "targets-funded" },
    { step: 3, from: "venue", to: "tron-gas", status: (tronSun ?? 0) < 10_000_000 ? "awaiting-venue" : "targets-funded" },
    { step: 4, from: "venue", to: "evm-sol-gas", status: ethStatus === "awaiting-funding" || solStatus === "awaiting-funding" ? "awaiting-venue" : "targets-funded" },
  ],
  targets: {
    blurt: { primary: blurtPrimary, armyUnfunded: armyUnfunded.length, lowest: armyUnfunded.slice(0, 5) },
    tron: { sun: tronSun },
    eth: { wei: ethWei, status: ethStatus },
    sol: { lamports: solLamports, status: solStatus },
  },
  broadcastReady: liquidSteem > 0 || liquidSbd > 0,
  status: "BROADCAST-READY-INTERNAL (execution gate: venue decision — honest queue, no unauthorized endpoints)",
});

/* ── D1: שערים-חיים (מדידה-בלבד) ── */
const spread = await measureSpread();

const receipt = {
  schema: "saos.revenue-router/1",
  at: NOW,
  account: ACCOUNT,
  doctrine: "steem-yield → sovereign treasury → cross-chain fuel (blurt/tron/evm/sol) — claim live-zero-cost · liquidation payloads structured · venue-pending honest",
  yield: { rewards: { steem: rStm, sbd: rSbd, vesting: rVest }, liquid: { steem: liquidSteem, sbd: liquidSbd } },
  claim,
  claimError,
  spread,
  packages,
  routing: { steemNodes: STEEM_NODES.length, blurtNodes: BLURT_NODES.length, failover: "per-call circuit override (429/timeout → next node)" },
  keysLeaked: false,
  keyMaterialLogged: false,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(receipt, null, 1) + "\n");

/* קובץ-חבילה לתור-השידור (בלי-סודות — מבנה-ops בלבד) */
try {
  fs.mkdirSync(PKG_DIR, { recursive: true });
  const pkgFile = path.join(PKG_DIR, `revenue-${NOW.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(pkgFile, JSON.stringify({ at: NOW, account: ACCOUNT, packages }, null, 1) + "\n");
} catch { /* כנות */ }

console.log(`revenue-router: claim=${claim ? claim.txid.slice(0, 10) + "…" : claimError ? "failed-honest" : "nothing-to-claim"} · liquid=${liquidSteem}STEEM/${liquidSbd}SBD · blurt-army-unfunded=${armyUnfunded.length} · tron=${tronSun ?? "?"}sun · packages=${packages.length} · spread=${(spread.status as string) ?? "?"}`);
