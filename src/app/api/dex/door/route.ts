import { NextResponse } from "next/server";
import { operatorAuth } from "@/lib/operator-auth";
import { consoleGuard } from "@/lib/dex/guard";
import { getLiveState, submitOp, nextNonce, requestOracleRefresh } from "@/lib/dex/chain";
import { doorReport, verifyTrxDeposit, verifySolDeposit, depositIdentities } from "@/lib/dex/peg-door";
// שער-זהות-אסורות קיים-בגרעין עצמו (FORBIDDEN_KEYS — fail-closed ב-applyOp)

export const dynamic = "force-dynamic";

/* ══ דלת-המטבעות (Task 72 · THE-COIN-DOOR) ═══════════════════════════════════
 * GET  — דוח-אמת ציבורי: זהויות-פקדה · יתרות-משמורת-חי · אורקל-קנוני ·
 *        גיבוי-עוגנים · בריכות מול-אורקל (spread) · יומן-הדלת.
 * POST — מאושר-מפעיל (x-saos-operator + כותרת-קונסולה):
 *   · peg-in        { chain: "trx"|"sol", txid, to? }  → אימות-RPC-ציבורי →
 *                     הטבעה-מגובה-אטומית (wrap_mint external + xfer_free)
 *   · peg-out       { asset: "WTRX"|"WSOL", amount, dest } → הפרדה-ל-outbox
 *   · open-pool     { peg: "WTRX"|"WSOL" } → העברת-העוגן-לאוצר + פתיחת-בריכה
 *                     מול-USDS במחיר-אורקל
 *   · refresh-oracle {} → דחיפת-פיד-מיידית
 * אימות-הפקדה הוא מול-RPC-ציבורי בלבד — אף-סמכות-סגורה; claim חד-פעמי בגרעין. */

const TXID_RE = /^[a-zA-Z0-9]{55,95}$/;
const ACCOUNT_RE = /^[a-z0-9][a-z0-9_-]{1,23}$/;
const PEG_ASSETS = { WTRX: "trx", WSOL: "sol" } as const;
type PegAsset = keyof typeof PEG_ASSETS;

export async function GET() {
  try {
    const st = getLiveState();
    const report = await doorReport(st);
    return NextResponse.json(report);
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "door-report-failed" });
  }
}

export async function POST(req: Request) {
  const oa = operatorAuth(req);
  if (oa) return oa;
  const g = consoleGuard(req);
  if (g) return g;

  const body = (await req.json().catch(() => ({}))) as {
    action?: string; chain?: string; txid?: string; to?: string;
    asset?: string; amount?: number; dest?: string; peg?: string;
  };
  const action = String(body.action ?? "");

  try {
    switch (action) {
      case "peg-in": {
        const chain = String(body.chain ?? "").toLowerCase();
        if (chain !== "trx" && chain !== "sol") {
          return NextResponse.json({ ok: false, error: "bad-chain", note: "chain חייב להיות trx או sol" });
        }
        // FIX(R16-a·M3): txid מנורמל-לפי-השרשרת — TRX txid הוא hex (רישיות-חסרת-משמעות,
        // הרינג-חד-פעמי משווה-מחרוזות-בדיוק → "abc…" ו-"ABC…" היו שתי-תביעות על-אותה-הפקדה)
        // → lowercase. SOL txid הוא base58 (**רישיות-משמעותית** — lowercase היה משחית
        // את-החתימה ומונע-אימות-לגיטימי) → נשמר-כפי-שנמסר. bridge.ts:473 כבר-נרמל.
        const txidRaw = String(body.txid ?? "").trim();
        const txid = chain === "trx" ? txidRaw.toLowerCase() : txidRaw;
        if (!TXID_RE.test(txid)) {
          return NextResponse.json({ ok: false, error: "bad-txid", note: "txid נראה שגוי (אורך/תווים)" });
        }
        const to = String(body.to ?? "operator").trim().toLowerCase();
        if (!ACCOUNT_RE.test(to)) {
          return NextResponse.json({ ok: false, error: "bad-account", note: "שם-חשבון-יעד לא חוקי" });
        }
        const ids = depositIdentities();
        const addr = chain === "trx" ? ids.tron : ids.sol;
        if (!addr) {
          return NextResponse.json({ ok: false, error: "identity-unavailable", note: `זהות-הפקדה-${chain} אינה מוגדרת בסביבה (fail-closed)` });
        }
        const proof = chain === "trx" ? await verifyTrxDeposit(txid, addr) : await verifySolDeposit(txid, addr);
        if (!proof.ok || !(proof.amountMu > 0)) {
          // כנות: אימות-כישלון = נתון, לא 500 — המפעיל רואה בדיוק מה נכשל
          return NextResponse.json({ ok: false, error: proof.detail, note: proof.error, chain, txid, amountMu: 0 });
        }
        const wrapAsset = (chain === "trx" ? "WTRX" : "WSOL") as PegAsset;
        const claim = `${chain}:${txid}`;
        // הטבעה-מגובה-אטומית: wrap_mint external (תביעה-חד-פעמית בגרעין) + העברה-חופשית
        // למפקיד. batch = דבר-גורר-דבר — אין-נכס-תלוש-באמצע-שרשרת.
        const r = submitOp({
          type: "batch", issuer: "treasury", nonce: nextNonce("door-in"),
          ops: [
            { type: "wrap_mint", issuer: "treasury", nonce: nextNonce("door-mint"), wrapAsset, amount: proof.amountMu, claim, external: true },
            { type: "xfer_free", issuer: "treasury", nonce: nextNonce("door-xfer"), to, asset: wrapAsset, amount: proof.amountMu },
          ],
        });
        return NextResponse.json({
          ok: r.queued, error: r.reason,
          note: r.queued
            ? `פקדה-אומתה: +${proof.amountMu}µ ${wrapAsset} → ${to} (תביעה ${claim.slice(0, 28)}…) — תיכלל בבלוק-הבא`
            : undefined,
          chain, txid, amountMu: proof.amountMu, wrapAsset, claim, proof: proof.detail,
        });
      }
      case "peg-out": {
        const asset = String(body.asset ?? "") as PegAsset;
        if (!(asset in PEG_ASSETS)) {
          return NextResponse.json({ ok: false, error: "bad-asset", note: "asset חייב להיות WTRX או WSOL" });
        }
        const amount = Math.floor(Number(body.amount));
        if (!(amount > 0)) {
          return NextResponse.json({ ok: false, error: "bad-amount", note: "amount (µ) חייב להיות שלם-חיובי" });
        }
        const dest = String(body.dest ?? "").trim();
        if (dest.length < 8 || dest.length > 96) {
          return NextResponse.json({ ok: false, error: "bad-dest", note: "כתובת-יעד-חוץ חובה (לתיעוד-השליחה)" });
        }
        const st = getLiveState();
        const have = st.balances["operator"]?.[asset] ?? 0;
        if (have < amount) {
          return NextResponse.json({ ok: false, error: "insufficient-peg", note: `יתרת-${asset}-של-המפעיל ${have}µ < ${amount}µ` });
        }
        // פדיון = הפרדה-גלויה ל-outbox (מחוץ-למחזור) + עדות-יעד. השליחה-הפיזית
        // מכתובת-המשמורת נעשית בידי-המפעיל ומופיעה בירידת-יתרת-המשמורת (אמת).
        const r = submitOp({
          type: "batch", issuer: "operator", nonce: nextNonce("door-out"),
          ops: [
            { type: "xfer_free", issuer: "operator", nonce: nextNonce("door-out-x"), to: "peg-outbox", asset, amount },
            { type: "attest", issuer: "operator", nonce: nextNonce("door-out-a"), claim: `peg-out ${amount}µ ${asset} → ${dest.slice(0, 48)}` },
          ],
        });
        return NextResponse.json({
          ok: r.queued, error: r.reason,
          note: r.queued ? `${amount}µ ${asset} הופרדו ל-peg-outbox — שלח את המטבע-האמיתי מכתובת-המשמורת אל ${dest}` : undefined,
        });
      }
      case "open-pool": {
        const peg = String(body.peg ?? "") as PegAsset;
        if (!(peg in PEG_ASSETS)) {
          return NextResponse.json({ ok: false, error: "bad-peg", note: "peg חייב להיות WTRX או WSOL" });
        }
        const st = getLiveState();
        const pair = `USDS/${peg}`;
        if (st.pools[pair]) {
          return NextResponse.json({ ok: false, error: "pool-exists", note: `${pair} כבר חי` });
        }
        const o = st.oracle?.[peg];
        if (!o) {
          return NextResponse.json({ ok: false, error: "no-oracle", note: `אין-מחיר-אורקל עדיין עבור ${peg} — המתן לפיד-הראשון (עד-60ש׳)` });
        }
        if (st.height - o.atH > 2_400) {
          return NextResponse.json({ ok: false, error: "oracle-stale", note: "מחיר-האורקל ישן מדי (>2 שע') — refresh-oracle תחילה" });
        }
        const have = st.balances["operator"]?.[peg] ?? 0;
        if (!(have > 0)) {
          return NextResponse.json({ ok: false, error: "no-peg-balance", note: `אין-${peg}-אצל-המפעיל — בצע peg-in קודם` });
        }
        const usdsSide = Math.floor((have * o.mu) / 1000); // µ-USDS = µ-עוגן × ($-ליחידה)
        if (!(usdsSide > 0) || (st.balances["treasury"]?.["USDS"] ?? 0) < usdsSide) {
          return NextResponse.json({ ok: false, error: "treasury-usds-short", note: `האוצר צריך ${usdsSide}µ USDS לזריעה` });
        }
        // שלב-1: המפעיל מעביר את כל-העוגן שלו לאוצר (xfer_free). שלב-2: האוצר
        // פותח-בריכה במחיר-אורקל. שני-ה-ops נדחפים יחד — מנגנון-הבלוק מבצע
        // בסדר; כישלון-שלב-2 נראה-כנה ב-rejectedLast (fail-closed, אין-סטט).
        submitOp({ type: "xfer_free", issuer: "operator", nonce: nextNonce("door-seed"), to: "treasury", asset: peg, amount: have });
        submitOp({ type: "pool_open", issuer: "treasury", nonce: nextNonce("door-pool"), pair, amount: usdsSide, amountB: have });
        return NextResponse.json({
          ok: true,
          note: `בריכת-${pair} נזרעת: ${have}µ ${peg} (מהמפעיל) + ${usdsSide}µ USDS (מהאוצר) במחיר-אורקל ${(o.mu / 1e6).toPrecision(6)}$ — תיפתח בבלוק-הבא`,
        });
      }
      case "refresh-oracle": {
        const r = requestOracleRefresh();
        return NextResponse.json({ ok: r.queued, error: r.reason, note: r.queued ? "פיד-האורקל נבדק עכשיו — שינויים ייכנסו בבלוק-הבא" : undefined });
      }
      default:
        return NextResponse.json({ ok: false, error: `unknown action: ${action}` });
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
