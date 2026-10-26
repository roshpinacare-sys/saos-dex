/**
 * usds-sides-once.ts — G77-e · חוות-הדעת של --once על מצב-המנוע-האמיתי (קריאה-בלבד).
 * ═══════════════════════════════════════════════════════════════════════════════
 * מה-היא עושה:
 *   · קוראת-את-מצב-הקנון (db/state-snapshot.json — אותו-ארטיפקט שהפעימה-מנהלת-ב-git,
 *     או GET /api/dex/state עם --url) — **קריאה-בלבד**, אפס-כתיבה למצב-החי.
 *   · מריצה את usdsSidesOnce — הרצף-המלא (מיחזור→reseed→fund→repeg) על **עותק-
 *     אמת-דרך-הגרעין-האמיתי** (אפס-מוק) — לכל-בריכה פסק-דין כנה:
 *     EXECUTED (האופ-עובר-את-שערי-הגרעין — מוכן-לתור-הפעימה) או
 *     BLOCKED (עם-הגירעון-המדויק עד-ההפעלה).
 *   · מדפיסה את הצף-האוצר, מה-עומד-על-הספר (parked), ואת הפסקים-הדין.
 *
 * שימוש:
 *   bun scripts/usds-sides-once.ts            # מול db/state-snapshot.json
 *   bun scripts/usds-sides-once.ts --json     # פלט-מכונה (receipt מלא)
 *   bun scripts/usds-sides-once.ts --state path/to/state-snapshot.json
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { usdsSidesOnce, type UsdsSidesOpRow } from "../src/lib/dex/usds-refloat";
import type { DexState } from "../src/lib/dex/kernel";

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const stateIdx = args.indexOf("--state");
const ROOT = process.cwd();
const statePath = stateIdx >= 0 && args[stateIdx + 1]
  ? path.resolve(args[stateIdx + 1])
  : path.join(ROOT, "db", "state-snapshot.json");

function loadState(): { st: DexState; savedAt: string; src: string } {
  const raw = JSON.parse(readFileSync(statePath, "utf8")) as
    | { version?: number; savedAt?: string; state?: DexState }
    | DexState;
  if ("state" in raw && raw.state && typeof raw.state === "object") {
    return { st: raw.state, savedAt: String(raw.savedAt ?? "?"), src: statePath };
  }
  return { st: raw as DexState, savedAt: "inline", src: statePath };
}

const µ = (n: number): string => n.toLocaleString("en-US");

function main(): void {
  const { st, savedAt, src } = loadState();
  const once = usdsSidesOnce(st);

  if (jsonOut) {
    console.log(JSON.stringify({ savedAt, src, ...once }, null, 1));
    return;
  }

  console.log("═══ G77-e · USDS-SIDES ONCE — honest verdicts on the real engine state ═══");
  console.log(`state: h${µ(once.atH)} · savedAt ${savedAt} · src ${src}`);

  console.log("\n── treasury free float (µ) ──");
  for (const f of once.treasuryFloat) {
    console.log(
      `  ${f.asset.padEnd(8)} balance ${µ(f.balanceMu).padStart(12)} · locked ${µ(f.lockedMu).padStart(12)} · FREE ${µ(f.freeMu).padStart(12)}`,
    );
  }

  console.log("\n── treasury parked orders on the live book ──");
  if (once.parked.length === 0) console.log("  (none)");
  for (const p of once.parked) {
    console.log(
      `  #${p.orderId} ${p.market.padEnd(13)} ${p.side.padEnd(4)} px ${µ(p.priceMu)}µ vs anchor ${µ(p.anchorMu)}µ → prem ${p.premBps >= 0 ? "+" : ""}${µ(p.premBps)}bps · locks ${µ(p.lockMu)}µ ${p.lockAsset} · ${p.recyclable ? "RECYCLABLE (offbook ≥ ±5000bps)" : "healthy quote — untouched"}`,
    );
  }

  console.log("\n── per-pool verdicts (the G76-a plan, published every beat) ──");
  for (const p of once.pools) {
    console.log(
      `  ${p.pair.padEnd(13)} ${p.verdict.padEnd(11)} action=${p.action.padEnd(7)} mid ${µ(p.midMu)}mµ vs anchor ${µ(p.anchorMidMu)}mµ (prem ${p.premBps >= 0 ? "+" : ""}${µ(p.premBps)}bps)${p.executable ? " · EXECUTABLE" : p.blocked.length ? ` · blocked: ${p.blocked.join(" | ")}` : ""}`,
    );
  }

  console.log("\n── refloat op list (kernel-verified on a true clone) ──");
  for (const o of once.ops) printOp(o);

  console.log("\n── counts ──");
  console.log(
    `  EXECUTED ${once.counts.executed} · BLOCKED ${once.counts.blocked} · recycled ${once.counts.recycled} · freed ${Object.entries(once.counts.freedMuByAsset).map(([a, mu]) => `${µ(mu)}µ ${a}`).join(" + ") || "0"} · fuelTop ${µ(once.counts.fuelTopMuTotal)}µ credits (exact kernel gas, wash-refuel law at beat)`,
  );
  console.log("\nlanding: the beat (cloud-beat.ts G77-e phases) submits these ops at its next canonical tick — EXECUTED rows are sized to the live float and pass the kernel gates as-measured; BLOCKED rows publish their exact deficit every beat until the fuel arrives.");
}

function printOp(o: UsdsSidesOpRow): void {
  const head = `  ${o.verdict.padEnd(8)} ${o.kind.padEnd(20)} ${[o.pair, o.orderId !== undefined ? `#${o.orderId}` : ""].filter(Boolean).join(" ")}`;
  const bits: string[] = [];
  if (o.detail) {
    for (const [k, v] of Object.entries(o.detail)) {
      if (typeof v === "number") bits.push(`${k}=${µ(v)}`);
      else if (v) bits.push(`${k}=${v}`);
    }
  }
  const tail: string[] = [];
  if (bits.length) tail.push(bits.join(" · "));
  if (o.err) tail.push(`kernel-err: ${o.err}`);
  if (o.blocked.length) tail.push(o.blocked.join(" | "));
  if (o.fuelTopMu > 0) tail.push(`fuelTop ${µ(o.fuelTopMu)}µ`);
  console.log(head + (tail.length ? ` — ${tail.join(" — ")}` : ""));
}

main();
