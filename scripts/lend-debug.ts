import fs from "fs"; import os from "os"; import path from "path";
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "saos-lend-debug-"));
fs.cpSync(path.join(process.cwd(), "db"), path.join(SANDBOX, "db"), { recursive: true });
process.env.DATABASE_URL = `file:${path.join(SANDBOX, "db", "dex.db")}`;
process.chdir(SANDBOX);
async function main() {
  const chain = await import("../src/lib/dex/chain");
  const rt = chain.ensureChain();
  const t = Date.now();
  while (rt.pendingLoad && Date.now() - t < 60_000) await new Promise((r) => setTimeout(r, 300));
  chain.stopLoops();
  const { submitOp, nextNonce } = chain as any;
  const st = rt.st as any;
  console.log("h:", st.height);
  const free1 = (st.balances["soldier-1"]?.WSTEEM ?? 0) - (st.locked?.["soldier-1"]?.WSTEEM ?? 0);
  console.log("soldier-1 WSTEEM:", st.balances["soldier-1"]?.WSTEEM, "locked:", st.locked?.["soldier-1"]?.WSTEEM, "free:", free1);
  console.log("treasury USDS:", st.balances.treasury?.USDS);
  let r = submitOp({ type: "lend_supply", issuer: "soldier-1", nonce: nextNonce("dbg1"), asset: "WSTEEM", amount: 20000 });
  console.log("submit soldier-1 supply:", JSON.stringify(r));
  await chain.stepOnce();
  console.log("after block: rejectedLast:", JSON.stringify(rt.rejectedLast));
  console.log("lend:", JSON.stringify(st.lend ?? null).slice(0, 300));
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
