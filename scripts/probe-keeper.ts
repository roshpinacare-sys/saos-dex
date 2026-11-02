/**
 * probe-keeper.ts — A43-FAMINE-FIX diagnostic (read-only replay, tmp DB copy).
 * Prints treasury free/locked/inflight + USDS/WSTEEM book state every 4 ticks.
 */
import fs from "fs";
import path from "path";
import os from "os";

const ROOT = path.resolve(import.meta.dir, "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-keeper-"));
process.env.DATABASE_URL = `file:${path.join(tmpDir, "dex.db")}`;
for (const f of ["state-snapshot.json", "rail-lifetime.json", "book-gas.json", "dex-credits.json", "klines.json"]) {
  const src = path.join(ROOT, "db", f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmpDir, f));
}
process.env.SAOS_DEX_STATE_DIR = tmpDir;
import { execSync } from "child_process";
execSync("bunx prisma db push --skip-generate --accept-data-loss", { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });

async function main(): Promise<void> {
  const { ensureChain, stopLoops, stepOnce, getLiveState, getMarkets } = await import("../src/lib/dex/chain");
  const { avail } = await import("../src/lib/dex/kernel");
  const rt = await ensureChain();
  let t0 = Date.now();
  while ((rt as any).pendingLoad && Date.now() - t0 < 90_000) await new Promise((r) => setTimeout(r, 200));
  stopLoops();
  for (let i = 1; i <= 48; i++) {
    await stepOnce();
    if (i % 4 === 0 || i <= 3) {
      const st: any = getLiveState();
      const bal = st.balances?.treasury ?? {};
      const lock = st.locked?.treasury ?? {};
      const freeW = (bal.WSTEEM ?? 0) - (lock.WSTEEM ?? 0);
      const freeU = (bal.USDS ?? 0) - (lock.USDS ?? 0);
      const mkts = getMarkets();
      const wst = mkts.find((m: any) => m.key === "USDS/WSTEEM");
      const tAsks = st.orders.filter((o: any) => o.live && o.owner === "treasury" && o.side === "sell");
      const tCancels = (rt as any).tape?.length ?? 0;
      console.log(`t${String(i).padStart(2)} freeW=${freeW} freeU=${freeU} lockedU=${lock.USDS ?? 0} bestAsk=${wst?.bestAsk ?? 0} tSellOrders=${tAsks.length} credits=${st.credits?.treasury ?? 0}`);
    }
    if ((rt as any).halted) { console.log("HALTED:", (rt as any).haltReason); break; }
  }
  process.exit(0);
}
main().catch((e) => { console.error("probe crashed:", e); process.exit(1); });
