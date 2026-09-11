/**
 * probe-multirail.ts — Roast-74 · בדיקת-חי-לפני-קוד (אפס-סודות-בפלט)
 * STEEM + BLURT: סמכות-חי, יתרות-נזילות, RC, מנועי-Engine, חוזה-הפקדה.
 * כל-הפלטים: שמות/כמויות/מפתחות-ציבוריים בלבד. WIF-לעולם-לא-נדפס.
 */
import steemLibRaw from "steem";

interface SteemAuth { auth: { wifToPublic(wif: string): string } }
const steemLib = steemLibRaw as unknown as SteemAuth;

const STEEM_NODES = ["https://api.steemit.com", "https://api.justyy.com", "https://api.steem.fans"];
const BLURT_NODES = ["https://api.blurt.world", "https://rpc.blurt.world", "https://blurt-rpc.salvychild.dev"];
const HE_STEEM = ["https://api.steem-engine.com/rpc/contracts", "https://api.steem-engine.net/rpc/contracts"];
const HE_BLURT = ["https://engine.blurt.tools/rpc/contracts", "https://blurtengine.blurt.world/rpc/contracts"];

async function rpcJ(url: string, body: unknown, tag: string, timeout = 12_000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    return (await res.json()) as unknown;
  } finally { clearTimeout(t); }
}
async function firstOk(urls: string[], body: unknown, tag: string): Promise<{ url: string; json: unknown } | null> {
  for (const u of urls) {
    try { const json = await rpcJ(u, body, tag); return { url: u, json }; } catch { /* הבא */ }
  }
  return null;
}

const ACCOUNT = (process.env.HIVE_ANCHOR_ACCOUNT || "headcorner").toLowerCase().trim();

async function chainProbe(name: string, nodes: string[], prefix: string, wifEnv: string) {
  console.log(`\n=== ${name} (${ACCOUNT}) ===`);
  const wif = (process.env[wifEnv] || "").trim();
  if (!wif) { console.log(`${wifEnv}: MISSING (fail-closed)`); return; }
  let pub = "";
  try { pub = steemLib.auth.wifToPublic(wif); } catch { console.log("wif-derive-failed"); return; }
  console.log(`derived pub: ${pub.slice(0, 8)}…${pub.slice(-4)} (prefix=${prefix})`);
  const blurtPub = prefix === "BLT" ? "BLT" + pub.replace(/^STM/, "") : pub;
  const r = await firstOk(nodes, { jsonrpc: "2.0", method: "condenser_api.get_accounts", params: [[ACCOUNT]], id: 1 }, `${name}.accounts`);
  if (!r) { console.log("nodes: UNREACHABLE"); return; }
  console.log(`node: ${r.url}`);
  const a = (r.json as { result?: Record<string, unknown>[] })?.result?.[0];
  if (!a) { console.log("account: NOT-FOUND on chain"); return; }
  console.log("balance:", a.balance, "| vesting_shares:", a.vesting_shares, "| sbd:", a.sbd ?? "-", "| rc:", (a as { rc?: unknown }).rc ?? "-");
  const activeKeys = ((a.active as { key_auths?: [string, number][] })?.key_auths ?? []).map((k) => k[0]);
  const postingKeys = ((a.posting as { key_auths?: [string, number][] })?.key_auths ?? []).map((k) => k[0]);
  const activeHit = activeKeys.includes(blurtPub) || activeKeys.includes(pub);
  const postingHit = postingKeys.includes(blurtPub) || postingKeys.includes(pub);
  console.log(`authority: active=${activeHit ? "YES" : "no"} (${activeKeys.length} keys) · posting=${postingHit ? "YES" : "no"} (${postingKeys.length} keys)`);
  // chain id (database_api.get_chain_id — appbase)
  const cid = await firstOk(nodes, { jsonrpc: "2.0", method: "database_api.get_chain_id", params: {}, id: 1 }, `${name}.chainid`);
  if (cid) console.log("chain_id:", (cid.json as { result?: string })?.result);
  // RC
  const rc = await firstOk(nodes, { jsonrpc: "2.0", method: "rc_api.find_rc_accounts", params: { accounts: [ACCOUNT] }, id: 1 }, `${name}.rc`);
  if (rc) {
    const acc = (rc.json as { result?: { rc_accounts?: { rc_manabar: { current_mana: string }; max_rc: string }[] } })?.result?.rc_accounts?.[0];
    if (acc) console.log(`RC: cur=${acc.rc_manabar.current_mana} max=${acc.max_rc}`);
    else console.log("RC: empty-result");
  } else console.log("RC: api-unreachable");
}

async function engineProbe(name: string, urls: string[], sscId: string, symbols: string[]) {
  console.log(`\n=== ${name} ===`);
  for (const sym of symbols) {
    const r = await firstOk(urls, { jsonrpc: "2.0", method: "find", params: { contract: "tokens", table: "balances", query: { account: ACCOUNT, symbol: sym }, limit: 1 }, id: 1 }, `${name}.bal`);
    if (r) {
      const row = (r.json as { result?: { balance?: string; stake?: string }[] })?.result?.[0];
      console.log(`${sym}: ${row ? `${row.balance} (stake ${row.stake ?? "-"})` : "0"} [${r.url.replace("https://", "").slice(0, 40)}]`);
    } else console.log(`${sym}: engine-UNREACHABLE`);
  }
  // חוזה-הפקדה: מי קיים ומה העמלות
  for (const contract of ["steempegged", "hivepegged", "blurtpegged"]) {
    const r = await firstOk(urls, { jsonrpc: "2.0", method: "getContract", params: { name: contract }, id: 1 }, `${name}.contract`);
    if (r) {
      const c = (r.json as { result?: { name?: string; tables?: unknown } })?.result;
      console.log(`contract ${contract}: ${c?.name ? "EXISTS" : "absent"}`);
    }
  }
}

async function main() {
  console.log(`probe-multirail · account=${ACCOUNT} · ${new Date().toISOString()}`);
  await chainProbe("STEEM", STEEM_NODES, "STM", "STEEM_ACTIVE_WIF");
  await chainProbe("BLURT", BLURT_NODES, "BLT", "STEEM_ACTIVE_WIF"); // אותו-WIF? נבדוק אם הסמכות תואמת — אחרת נדע שצריך מפתח-נפרד
  await engineProbe("STEEM-ENGINE", HE_STEEM, "ssc-mainnet-steem", ["SWAP.STEEM", "STEEMP"]);
  await engineProbe("BLURT-ENGINE", HE_BLURT, "ssc-mainnet-blurt", ["SWAP.BLURT"]);
}
main().catch((e) => { console.log("probe-fatal:", String(e).slice(0, 200)); process.exit(0); });
