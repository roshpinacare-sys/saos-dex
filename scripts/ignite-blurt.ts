/**
 * ignite-blurt.ts — Roast-74 · ההצתה-הפיזית-של-BLURT דרך-סוכן-הסוואפ
 * plan-rail → rail (powerup 10 BLURT → HP) עם-שער-המפעיל (הטוקן-קורא-מ-.env, לעולם-לא-נדפס).
 * פלט: תוכנית + txid + block + אימות-על-השרשרת (vesting לפני/אחרי).
 */
export {}; // module-marker (tsc: top-level-await)

const OP = (process.env.DEX_OPERATOR_TOKEN || "").trim();
if (!OP) { console.log("operator-token-missing (fail-closed)"); process.exit(1); }
const API = "http://127.0.0.1:3010/saos-dex/api/dex/agent";
const H = { "content-type": "application/json", "x-saos-dex-console": "1", "x-saos-operator": OP };

const AMOUNT = 10; // BLURT (מתוך-41.136 נזיל · רצפת 0.1)

async function vestingBefore(): Promise<string> {
  const r = await fetch("https://rpc.blurt.blog", {
    method: "POST", headers: { "content-type": "application/json", "user-agent": "saos-ignite/1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "condenser_api.get_accounts", params: [["headcorner"]], id: 1 }),
    signal: AbortSignal.timeout(12000),
  });
  const j = (await r.json()) as { result?: { vesting_shares?: string; balance?: string }[] };
  return `${j.result?.[0]?.balance ?? "?"} | vesting ${j.result?.[0]?.vesting_shares ?? "?"}`;
}

console.log("before:", await vestingBefore());

const plan = await (await fetch(API, { method: "POST", headers: H, body: JSON.stringify({ kind: "plan-rail", network: "blurt", action: "powerup", amount: AMOUNT }) })).json();
console.log("plan:", JSON.stringify(plan).slice(0, 400));
if (!plan.ok) { console.log("IGNITION-STOPPED (plan rejected — fail-closed)"); process.exit(0); }

const run = await (await fetch(API, { method: "POST", headers: H, body: JSON.stringify({ kind: "rail", network: "blurt", action: "powerup", amount: AMOUNT }) })).json();
console.log("exec ok:", run.ok, "| error:", run.error ?? null);
for (const s of run.run?.steps ?? []) console.log(`  [${s.ok ? "✓" : "✗"}] ${s.step}: ${s.detail}${s.txid ? ` · txid ${s.txid}` : ""}`);

await new Promise((r) => setTimeout(r, 3000));
console.log("after :", await vestingBefore());
