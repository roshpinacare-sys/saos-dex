/**
 * world-snapshot.ts (Task 35) — בונה תמונת-עולם במדויק בצורת ה-API של הטרמינל.
 *
 * הצינור מתאים למוצר: אותם getters שהדמון מגיש ב-/api/dex/state מופקים כאן
 * לקובץ-JSON סטטי (dex/world.json) שהמראה הציבורית ב-Pages קוראת. כך הטרמינל
 * מקבל בדיוק-את-מה שהדמון היה מחזיר — בלי לגעת בקוד-התצוגה כלל.
 *
 * משתמשים: cloud-beat.ts (כל פעימה, מפרסם ל-Console) · scripts/world-snapshot.ts
 * (הפקה מקומית לפריסה הראשונה). מקור-אמת אחד לצורה — אפס סטייה בין דמון למראה.
 */

import * as chain from "./chain";
import { relayStatus } from "./relay";

export function buildWorldSnapshot(): Record<string, unknown> {
  const rt = chain.ensureChain();
  const proofs = chain.getProofs();
  return {
    ok: true,
    /* publishedAt — שדה-עזר לרצועת-המראה באתר (גיל-נתונים כן); הטרמינל עצמו מתעלם ממנו */
    publishedAt: new Date().toISOString(),
    version: chain.chainVersion(),
    state: chain.getState(),
    markets: chain.getMarkets(),
    pools: chain.getPools(),
    wallets: chain.getWallets(),
    arena: chain.getArena(),
    proofs: {
      seals: proofs.seals,
      receipts: proofs.receipts,
      blockWindow: proofs.blockWindow,
    },
    tape: chain.getTape(30),
    tick: rt.tickCount,
  };
}

export function buildRelaySnapshot(): Record<string, unknown> {
  return { ok: true, relay: relayStatus() };
}
