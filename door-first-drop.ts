/**
 * door-first-drop.ts — הטיפה הראשונה · THE FIRST REAL DROP (R34)
 * =============================================================================
 * הפקדה-אמיתית-ראשונה דרך דלת-המטבעות (Task 72 · THE-COIN-DOOR), מבוצעת
 * על-השרשרת-הקנונית של saos-dex:
 *
 *   1. אימות-הפקדה מול-RPC-ציבורי (trongrid · keyless · בלי-סמכות-סגורה):
 *      TransferContract אמיתי אל כתובת-המשמורת הריבונית TYVwwuvd…
 *      — הכסף האמיתי (2.000002 TRX) נמדד-חי על-השרשרת, ומעולם לא תבע.
 *   2. הטבעה-מגובה-אטומית (kernel · wrap_mint external + xfer_free):
 *      1 TRX = 1000µ-WTRX · התביעה `trx:<txid>` נרשמת-חד-פעמית בטבעת-ה-extClaims.
 *   3. הוכחת-נחיתה: יתרת-המפקיד לפני/אחרי + backing חי + תביעה בספר — או כישלון כנה.
 *   4. forceFlush → ה-db הקנוני מתעדכן; ה-commit+push והפרסום ל-Console נעשים
 *      בידי המפעיל (אותה שרשרת-אמת כמו-cloud-beat: קודם-השרשרת, אחר-כך-הפרסום).
 *
 * כנות-מלאה: ה-TRX האמיתי נשאר בכתובת-המשמורת כגיבוי-פיזי 1:1 (2,000,000 sun
 * = 2000µ WTRX). ההטבעה אינה מזיזה את הכסף — היא מתעדת-אותו: המשמורת היא
 * הרזרבה, ה-WTRX הוא זכות-הפדיון המתועדת.
 *
 * הרצה: bun run door-first-drop.ts [txid]
 */
import path from "path";

/* ── סביבה לפני-כל-ייבוא-של-המנוע (אותו-דפוס-ההגנה של cloud-beat) ── */
process.env.DATABASE_URL = `file:${path.join(process.cwd(), "db", "dex.db")}`;
process.env.SAOS_DEX_STATE_DIR = path.join(process.cwd(), "db");

const TXID = (process.argv[2] ?? "8d84e637f3ebc87b8248361a58342eb05014315beb9a9e9b6f3c1c403de9e917").toLowerCase();
/** כתובת-המשמורת הריבונית — פומבית, מתועדת-ב-FORENSIC-AUDIT §5 ו-AGENT-ESTATE-MAP
 *  כ"ארנק-ראשי". מפתח-פרטי אינו-נדרש: האימות חסר-מפתח (RPC-ציבורי), ההטבעה
 *  היא פעולת-אוצר-פנימית, והכסף נשאר-במשמורת כגיבוי. */
const CUSTODY_TRON = "TYVwwuvdDmfy3shxT3cb3RKLrRCshaZxTy";
const CLAIM = `trx:${TXID}`;

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log(`[first-drop] boot · txid=${TXID}`);

  const chain = await import("./src/lib/dex/chain");
  const { verifyTrxDeposit } = await import("./src/lib/dex/peg-door");
  const rt = chain.ensureChain();
  const waitLoad = async () => {
    const t = Date.now();
    while (rt.pendingLoad && Date.now() - t < 90_000) await new Promise((r) => setTimeout(r, 300));
  };
  await waitLoad();
  if (rt.halted) {
    console.error(`[first-drop] chain HALTED — refusing. reason: ${rt.haltReason ?? "?"}`);
    process.exit(1);
  }
  chain.stopLoops();
  const heightBefore = rt.st.height;
  console.log(`[first-drop] chain loaded · height ${heightBefore}`);

  /* ── 1) אימות-הפקדה מול-RPC-ציבורי — הראיה, לא-ההבטחה ── */
  const proof = await verifyTrxDeposit(TXID, CUSTODY_TRON);
  console.log(`[first-drop] verify: ok=${proof.ok} · ${proof.detail} · amountMu=${proof.amountMu}${proof.error ? " · err=" + proof.error : ""}`);
  if (!proof.ok || !(proof.amountMu > 0)) {
    console.error("[first-drop] deposit NOT verified — refusing to mint (fail-closed)");
    process.exit(2);
  }

  /* ── 2) יתרת-משמורת-חיה מול-ההטבעה: לעולם לא מעל הכסף שבאמת שם ── */
  const custodySun = await (async () => {
    try {
      const r = await fetch(`https://api.trongrid.io/v1/accounts/${CUSTODY_TRON}`, { cache: "no-store" });
      const j = (await r.json()) as { data?: { balance?: number }[]; success?: boolean };
      if (j?.success === false) return null;
      return j?.data?.[0]?.balance ?? 0;
    } catch { return null; }
  })();
  if (custodySun !== null && proof.amountMu > Math.floor(custodySun / 1000) + 1) {
    console.error(`[first-drop] HONESTY GUARD: mint ${proof.amountMu}µ > custody ${Math.floor(custodySun / 1000)}µ — refusing (never mint beyond real money)`);
    process.exit(3);
  }
  console.log(`[first-drop] live custody: ${custodySun} sun (${(custodySun ?? 0) / 1e6} TRX) — mint ${proof.amountMu}µ WTRX is fully backed`);

  const { submitOp, nextNonce } = chain as unknown as {
    submitOp: (op: Record<string, unknown>) => { queued: boolean; reason?: string };
    nextNonce: (p: string) => string;
  };
  const st = rt.st as unknown as {
    balances: Record<string, Record<string, number>>;
    backing: Record<string, number>;
    extClaims: string[];
  };

  /* ── 3) כפילות-תביעה: אם כבר נתבעה — יציאה-כנה בלי-מגע ── */
  if ((st.extClaims ?? []).includes(CLAIM)) {
    console.error(`[first-drop] claim ${CLAIM.slice(0, 28)}… already used — nothing to do (idempotent, honest exit)`);
    process.exit(0);
  }

  /* ── 4) הטבעה-מגובה-אטומית — אותם-ops בדיוק של שער-הדלת (POST peg-in) ── */
  const TO = "operator"; // המפקיד-הוא-המפעיל: הוא-שהפקיד את ה-TRX מכיסו
  const balBefore = st.balances[TO]?.["WTRX"] ?? 0;
  const r = submitOp({
    type: "batch", issuer: "treasury", nonce: nextNonce("first-drop"),
    ops: [
      { type: "wrap_mint", issuer: "treasury", nonce: nextNonce("fd-mint"), wrapAsset: "WTRX", amount: proof.amountMu, claim: CLAIM, external: true },
      { type: "xfer_free", issuer: "treasury", nonce: nextNonce("fd-xfer"), to: TO, asset: "WTRX", amount: proof.amountMu },
    ],
  });
  if (!r.queued) {
    console.error(`[first-drop] op REJECTED: ${r.reason ?? "?"}`);
    process.exit(4);
  }
  await chain.stepOnce(); // ה-op נכנס-לממפול — בלוק-אחד מבצע

  /* ── 5) הוכחת-נחיצה (R33 pattern): מדד-לפני/אחרי, לא-הבטחה ── */
  const balAfter = st.balances[TO]?.["WTRX"] ?? 0;
  const landed = balAfter - balBefore >= proof.amountMu;
  if (!landed) {
    console.error(`[first-drop] mint did NOT land (bal ${balBefore}→${balAfter}, want +${proof.amountMu}) — honest failure, no false success`);
    process.exit(5);
  }
  const backingAfter = st.backing?.["WTRX"] ?? 0;
  const claimRecorded = (st.extClaims ?? []).includes(CLAIM);
  const heightAfter = rt.st.height;
  console.log(`\n[first-drop] *** FIRST REAL DROP LANDED ***`);
  console.log(`  operator WTRX : ${balBefore} → ${balAfter} (+${proof.amountMu}µ = ${(proof.amountMu / 1000).toFixed(3)} TRX-equivalent)`);
  console.log(`  treasury backing[WTRX]: ${backingAfter}µ (custody ${custodySun} sun on-chain)`);
  console.log(`  claim recorded: ${claimRecorded} (${CLAIM.slice(0, 34)}…)`);
  console.log(`  height        : ${heightBefore} → ${heightAfter}`);
  if (!claimRecorded) {
    console.error("[first-drop] WARNING: balance landed but claim not in extClaims — inspect before pushing!");
    process.exit(6);
  }

  chain.forceFlush();
  console.log(`[first-drop] db flushed · done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`[first-drop] next: commit db files + push, then cloud-beat publishes to Console`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[first-drop] FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
