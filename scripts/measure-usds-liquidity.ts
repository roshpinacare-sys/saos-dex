/**
 * measure-usds-liquidity.ts — G77-c · רץ-מדידה-חי קריאה-בלבד (READ-ONLY).
 * ═══════════════════════════════════════════════════════════════════════════════
 * קורא את תמונת-המצב החיה שהמנוע כותב (SAOS_DEX_STATE_DIR/state-snapshot.json),
 * מזריק אותה לקבלת-הנזילות הטהורה (liquidityReceipt — אותו-חוק של הפעימה) ומדפיס
 * JSON. אפס-ensureChain, אפס-כתיבה, אפס-רשת — שני-כותבים על מצב-חי = שחיתות.
 *
 * שימוש: bun scripts/measure-usds-liquidity.ts [snapshotPath]
 *   ברירת-מחדל: $SAOS_DEX_STATE_DIR/state-snapshot.json או db/state-snapshot.json.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { liquidityReceipt } from "../src/lib/dex/liquidity-receipt";

const argPath = process.argv[2];
const snapPath = argPath
  ?? (process.env.SAOS_DEX_STATE_DIR
    ? path.join(process.env.SAOS_DEX_STATE_DIR, "state-snapshot.json")
    : path.join(process.cwd(), "db", "state-snapshot.json"));

const snap = JSON.parse(readFileSync(snapPath, "utf8")) as { savedAt: string; state: unknown };
const receipt = liquidityReceipt(snap.state as never);
console.log(JSON.stringify({
  measuredFrom: snapPath,
  savedAt: snap.savedAt,
  receipt,
}, null, 1));
