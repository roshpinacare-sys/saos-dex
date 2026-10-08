/* steem-fuel-loop.ts — Task 3-d · לולאת-הדלק-העצמית (Steem-תשואות → קופה-ריבונית)
 * ═════════════════════════════════════════════════════════════════════════════
 * דבר-הבעלים: "האם הסוכנים יפתחו מנגנון-אוטומטי להמרת-תשואות מ-Steem (שם-העיגון
 * עובד-100%) כדי-לממן-את-דמי-הגז-וה-Fees ב-Blurt וב-Tron?"
 * התשובה-שהוחלטה: **כן** — שלב-א': תביעת-התשואות-הקנונית (claim_reward_balance —
 * posting-סמכות, אפס-עלות-RC). שלב-ב' (הפוליטיקה-הכנה): ההמרה-ל-BLURT/TRON דורשת
 * נקודת-מסחר-חוץ (אין-rail-on-chain-ישיר) — הקופה-נצברת-ונמדדת, והערוץ-נרשם
 * "venue-pending" עד-להכרעת-נקודת-המסחר. אפס-סודות בקבלות.
 *
 * כנות-מבנית: בלי-venue, הפונקציה-היחידה-שרצה-על-השרשרת-היום היא claim (הכנסה-
 * בטוחה-אפס-עלות). כל-שאר — מדידה + מדיניות + ניהול-סיכון. לא מבוצע סוופ-חוץ
 * בלי-הכרעת-בעלים (האסורים של-הצ'רטר: endpoints-לא-מורשים).
 */
import fs from "fs";
import path from "path";
import { grapheneOpsBroadcast, STEEM_NODES, ZERO_CHAIN_ID } from "../src/lib/dex/relay";

await import("dotenv/config");

const NOW = new Date().toISOString();
const ACCOUNT = (process.env.SAOS_RELAY_AGENT_ACCOUNT ?? "").toLowerCase();
const WIF = process.env.STEEM_POSTING_WIF ?? "";
const OUT = path.join(process.cwd(), "..", "receipts", "fuel-ledger-latest.json");

if (!ACCOUNT || !WIF) {
  console.error(JSON.stringify({ status: "not-armed (STEEM_POSTING_WIF/SAOS_RELAY_AGENT_ACCOUNT missing) — honest exit" }));
  process.exit(0); // כנות: לא-חמוש ≠ כשל-מערכת
}

async function rpc<T>(method: string, params: unknown, timeoutMs = 15000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(STEEM_NODES[0], {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }), signal: ctl.signal,
    });
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message ?? "rpc");
    return json.result as T;
  } finally { clearTimeout(t); }
}

type Rewards = { balance: string; sbd_balance: string; reward_steem_balance: string; reward_sbd_balance: string; reward_vesting_balance: string; reward_vesting_steem: string };
const [acc] = await rpc<Rewards[]>("condenser_api.get_accounts", [[ACCOUNT]]);
if (!acc) throw new Error("primary account not found on steem (honest)");

const num = (s: string | undefined) => Number(String(s ?? "0").split(" ")[0]) || 0;
const rStm = num(acc.reward_steem_balance);
const rSbd = num(acc.reward_sbd_balance);
const rVest = num(acc.reward_vesting_balance);

const ledger: Record<string, unknown> = {
  schema: "saos.fuel-ledger/1",
  at: NOW,
  account: ACCOUNT,
  doctrine: "steem-yield → sovereign treasury: claim (live, zero-cost) → conversion-venue pending owner decision (honest queue)",
  rewards: { steem: rStm, sbd: rSbd, vesting: rVest },
  liquid: { steem: num(acc.balance), sbd: num(acc.sbd_balance) },
  claimed: null as null | { txid: string; claimed: { steem: number; sbd: number; vesting: number } },
  venue: {
    status: rStm + rSbd > 0 ? "venue-pending (accumulated — awaiting conversion-route decision)" : "nothing-to-convert",
    note: "no unauthorized endpoints (charter); internal DEX rails routed when counterparties exist",
  },
};

if (rStm > 0 || rSbd > 0 || rVest > 0) {
  /* claim_reward_balance — posting-סמכות (נחתם-ב-WIF-הפוסטינג), אפס-עלות-RC.
   * הערה-קנונית: זהו-op-מבני (לא-custom_json) — אין-שדות-required_auths/id. */
  const op: [string, Record<string, unknown>] = ["claim_reward_balance", {
    account: ACCOUNT,
    reward_steem: acc.reward_steem_balance,
    reward_sbd: acc.reward_sbd_balance,
    reward_vesting: acc.reward_vesting_balance,
  }];
  try {
    const r = await grapheneOpsBroadcast(STEEM_NODES[0], ZERO_CHAIN_ID, ACCOUNT, [op], WIF, "posting");
    ledger.claimed = { txid: r.txid, claimed: { steem: rStm, sbd: rSbd, vesting: rVest } };
    console.log(JSON.stringify({ status: "claimed", txid: r.txid, claimed: ledger.claimed.claimed }));
  } catch (e) {
    ledger.error = String((e as Error)?.message ?? e).slice(0, 160);
    console.log(JSON.stringify({ status: "claim-failed-honest", error: ledger.error }));
  }
} else {
  console.log(JSON.stringify({ status: "nothing-to-claim", liquid: ledger.liquid }));
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(ledger, null, 2));
