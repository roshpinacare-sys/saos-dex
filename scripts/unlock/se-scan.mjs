// se-scan.mjs — מסילת-ה-Steem-Engine: מלאי-טוקנים-לכל-האחזקות (קריאה-בלבד)
const ENDPOINTS = ["https://api.steem-engine.net/rpc/", "https://engine.rukai.co", "https://api.steem-engine.com/rpc/"];
const ROSTER = ["headcorner", "cashmachine", "haran", "israelnews", "lsa", "macrame", "siq", "tov", "wic", "wog", "woq", "hcsoldier4", "hcsoldier5", "hcsoldier6"];
async function se(method, params) {
  for (const ep of ENDPOINTS) {
    try {
      const r = await fetch(ep, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const t = await r.text(); if (!t) continue;
      const j = JSON.parse(t); if (j.error) continue;
      if (j.result) return j.result;
    } catch {}
  }
  return null;
}
const bal = await se("find", { contract: "tokens", table: "balances", query: { account: { $in: ROSTER } }, limit: 1000, descending: false }).catch(() => null);
if (!bal) { console.log("VERDICT-SE: all-endpoints-unreachable (honest)"); process.exit(0); }
const rows = bal.filter(b => parseFloat(b.balance) > 0 || parseFloat(b.stake) > 0);
console.log(`SE: ${bal.length} rows scanned · nonzero ${rows.length}`);
for (const b of rows.slice(0, 40)) console.log(`  ${b.account}: ${b.symbol} bal=${b.balance} stake=${b.stake}`);
if (rows.length) {
  const metrics = await se("find", { contract: "market", table: "metrics", query: { symbol: { $in: [...new Set(rows.map(r => r.symbol))] } }, limit: 100, descending: false }).catch(() => null);
  if (metrics?.length) for (const m of metrics) console.log(`  market ${m.symbol}: last=${m.lastPrice} vol=${m.volume ?? "?"}`);
}
console.log("VERDICT-SE: scanned");
