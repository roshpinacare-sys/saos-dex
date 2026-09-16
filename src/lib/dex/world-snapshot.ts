/**
 * world-snapshot.ts (Task 35) — בונה תמונות-עולם במדויק בצורות ה-API של הטרמינל.
 *
 * הצינור מתאים למוצר: אותם getters שהדמון מגיש מופקים כאן לקבצי-JSON סטטיים
 * (dex/*.json) שהמראה הציבורית ב-Pages קוראת. כך הטרמינל מקבל בדיוק-את-מה
 * שהדמון היה מחזיר — בלי לגעת בקוד-התצוגה כלל.
 *
 * משתמשים: cloud-beat.ts (כל פעימה, מפרסם ל-Console) · scripts/world-snapshot.ts
 * (הפקה מקומית לפריסה הראשונה). מקור-אמת אחד לצורות — אפס סטייה בין דמון למראה.
 *
 * נקודות-קצה שלא מפורסמות (settle/truth/my-orders/route/microdose/repeg): יקרות,
 * תלויות-פרמטרים או מזוהות-מפעיל — המראה מגישה להן stub הגון (ok:false, mirror:true)
 * והלקוח נשאר במצב-המתנה מעוצב, בלי 404.
 */

import * as chain from "./chain";
import { relayStatus } from "./relay";
import { agentStatus } from "./agent";
import { fleetStatusPublic } from "./fleet";
import { getPortfolio } from "./portfolio";
import { getBridgeView, bridgeAutoStatus } from "./bridge";
import { onrampSnapshot } from "../onramp";

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

/** כל קבצי-המראה בבת-אחת — שם-קובץ ← גוף. נכתבים על-ידי הפעימה ל-dex/*.json. */
export async function buildMirrorSnapshots(): Promise<Record<string, Record<string, unknown>>> {
  const files: Record<string, Record<string, unknown>> = {
    world: buildWorldSnapshot(),
    relay: buildRelaySnapshot(),
    fleet: { ok: true, fleet: fleetStatusPublic() },
    portfolio: { ok: true, portfolio: getPortfolio() },
    /* בלי startBridgeAutoKeeper — השומר שייך לדמון החי, לא להפקה-יבשה */
    bridge: { ok: true, bridge: { ...getBridgeView(), auto: bridgeAutoStatus() } },
  };
  files.agent = (await agentStatus()) as Record<string, unknown>;
  try {
    files.onramp = { ok: true, onramp: await onrampSnapshot(false) };
  } catch {
    /* היעדר-כנות: הקובץ פשוט לא ייכתב — המראה תציג המתנה, לא שקר */
  }
  /* showcase — צורה מורכבת שנבנית מהשרשרת: קריאה ישירות ל-handler של הראוט
   * (אותו קובץ שהדמון מגיש) — צורה מדויקת לנצח, אפס שכפול לוגיקה. */
  try {
    const { GET } = await import("../../app/api/dex/showcase/route");
    const res = await GET();
    files.showcase = (await res.json()) as Record<string, unknown>;
  } catch {
    /* כנות: בלי showcase בפעימה הזו — הלקוח נשאר בהמתנה */
  }
  return files;
}
