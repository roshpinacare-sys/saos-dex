import path from "path";
process.env.DATABASE_URL = `file:${path.join(process.cwd(), "db", "dex.db")}`;
process.env.SAOS_DEX_STATE_DIR = path.join(process.cwd(), "db");
async function main() {
  const chain = await import("../src/lib/dex/chain");
  const rt = chain.ensureChain();
  const t = Date.now();
  while (rt.pendingLoad && Date.now() - t < 60_000) await new Promise((r) => setTimeout(r, 300));
  chain.stopLoops();
  const st = rt.st as any;
  const who = ["treasury","operator","arena","save-pot","vault-pot","lend-pot","bot-a","bot-b","bot-c","bot-e","soldier-1","soldier-2","soldier-3","soldier-4","soldier-5","soldier-6","soldier-7","soldier-8"];
  for (const w of who) {
    const b = st.balances[w] ?? {};
    const parts = Object.entries(b).filter(([,v]:any)=>v>0).map(([a,v]:any)=>`${a}:${v}`).join(" · ");
    if (parts) console.log(w.padEnd(12), parts);
  }
  console.log("\nheight:", st.height, "| refPrice:", JSON.stringify(Object.fromEntries(Object.entries(st.assets).map(([k,v]:any)=>[k,v.refPrice]))));
  console.log("savings:", JSON.stringify(st.savings ? { pot: st.savings.potMu, positions: Object.keys(st.savings.positions) } : null));
  console.log("vaults:", st.vaults ? Object.keys(st.vaults) : null);
  console.log("gasUsed:", st.gasUsed, "| credits treasury:", st.credits?.treasury, "| arena:", st.credits?.arena);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
