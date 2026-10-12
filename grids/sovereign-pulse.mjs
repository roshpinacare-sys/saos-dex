// SOVEREIGN-PULSE — הדופק-הריבוני על-השרשרת (R16-a · owner mandate trace 1a12dbe9812eff11)
// ════════════════════════════════════════════════════════════════════════════════════════
// שאלת-הבעלים: "מה אפשר להקים על הבלוקצ'יין שלנו?" — התשובה: קיום-הריבונות עצמו, רשום-אמת.
// כל-מחזור המנוע מודד את מצב-הצי (קבלת-הרווחיות-המכונה + פסק-הגריד-הציבורי) ומחתים אותו
// על-Steem כ-custom_json מוחתם-posting (עלות-אפס — RC בלבד). מאז-ומעתה: כל-צומת-בעולם
// יכול לאמת לבד, מהשרשרת, שהריבונות חיה, מתי נמדדה, ומה-נמדד — בלי-לסמוך על אף-שרת שלנו.
//
// בטיחות (כל-השכבות חייבות; כל-כשל = יציאה-כנה בלי-נגיעה):
//   1. STASIS: stasisHalt("general") — מסילת-ה-general פתוחה (R30 full-lift).
//   2. שער-מפתח: postingAuthorityOk (grids/key-gate.mjs) — ה-WIF חייב לגזור את רשות-
//      ה-posting החיה של החשבון לפני-כל-חתימה (fail-closed).
//   3. מקורות-מגניבים: אם-קבלת-הרווחיות או פסק-הגריד לא-נקראים — הדופק יוצא
//      mode=heartbeat-only (קיום-בלבד, אפס-מספרים-מומצאים). כנות מעל הכל.
//   4. קריאה-אחרי-כתיבה: ה-txid נמדד בשרשרת (get_transaction) — ה-op חייב להיות
//      custom_json מזהה-זה עם-payload-זה.
//   5. אפס-סודות בקבלה; ה-WIF לעולם לא נכתב ללוג/קבלה.
//
// שימוש: node grids/sovereign-pulse.mjs [--execute] [--selftest]
//   ברירת-מחדל: dry-run (מרכיב-את-הדופק ומדפיס-אותו; לא שודר כלום).
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ACCOUNT, rpcAny, signAndBroadcast } from "./mover.mjs";
import { stasisHalt } from "./brake.mjs";
import { postingAuthorityOk } from "./key-gate.mjs";
import { appendEvent } from "./events.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const execute = process.argv.includes("--execute");
const PULSE_ID = "saos-pulse";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── מקורות-מדידה (keyless, defensive — אפס-המצאה) ──────────────────────────── */
async function fetchProfitState() {
  for (const url of [
    "https://raw.githubusercontent.com/roshpinacare-sys/Sandbox/main/receipts/profit-oracle-latest.json",
  ]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j = await r.json();
      const s = j?.summary ?? j;
      const net = Number(s?.netWorthSbdEquiv ?? s?.netWorth?.sbdEquiv ?? NaN);
      const verdict = String(s?.verdict ?? "").toUpperCase();
      const delta = Number(s?.deltaVsPriorPct ?? NaN);
      if (Number.isFinite(net) || verdict) {
        return { at: String(s?.at ?? j?.at ?? ""), netWorthSbdEquiv: Number.isFinite(net) ? net : null, verdict: verdict || null, deltaVsPriorPct: Number.isFinite(delta) ? delta : null };
      }
    } catch { /* מקור-כהה — נמשיך כנה */ }
  }
  return null;
}
async function fetchGridVerdict() {
  try {
    const r = await fetch("https://raw.githubusercontent.com/roshpinacare-sys/Console/main/dex/grid.json", { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    return { verdict: String(j?.verdict ?? ""), blocker: Array.isArray(j?.blocker) ? j.blocker.join("; ").slice(0, 200) : (j?.blocker ?? null), placed: j?.run?.placed ?? null, fills: j?.run?.filledTotal ?? null };
  } catch { return null; }
}

export function composePulse({ profit, grid }) {
  const attested = !!(profit && grid && grid.verdict);
  // חוק-הכנות: attested = שני-המקורות-חיים → המספרים-המדודים; אחרת heartbeat-only עם
  // אפס-מספרים (קיום-בלבד) — אף-פעם לא תמונה-חלקית שנראית-כאילו-אושרה.
  const state = attested
    ? {
        netWorthSbdEquiv: profit?.netWorthSbdEquiv ?? null,
        profitVerdict: profit?.verdict ?? null,
        profitDeltaPct: profit?.deltaVsPriorPct ?? null,
        gridVerdict: grid?.verdict || null,
        gridBlocker: grid?.blocker ?? null,
      }
    : { netWorthSbdEquiv: null, profitVerdict: null, profitDeltaPct: null, gridVerdict: null, gridBlocker: null };
  return {
    protocol: "SAOS-SOVEREIGN-PULSE/1",
    at: new Date().toISOString().slice(0, 19) + "Z",
    mode: attested ? "attested" : "heartbeat-only",
    state,
    sources: { profitAt: profit?.at ?? null, profitReceipt: "Sandbox receipts/profit-oracle-latest.json", gridSource: "Console dex/grid.json" },
    honesty: "המספרים כאן הם-עותק-מדוד של קבלות-ציבוריות (profit-oracle + grid-pulse); כל-אחד יכול להצליב מול המקורות. heartbeat-only = המקורות-כהים בזמן-הדופק — אפס-מספרים-מומצאים.",
  };
}

/* ── selftest — וקטורים אופליין, בלי-רשת ובלי-מפתחות ────────────────────────── */
export async function selftest() {
  const assert = (c, m) => { if (!c) { console.error("SELFTEST FAIL:", m); process.exit(1); } };
  // וקטור 1: שני-מקורות-חיים → attested עם-המספרים
  const p1 = composePulse({ profit: { at: "2026-10-12T05:29:00Z", netWorthSbdEquiv: 455.32, verdict: "FLAT", deltaVsPriorPct: 0 }, grid: { verdict: "ARMED-LIVE", blocker: null } });
  assert(p1.mode === "attested" && p1.state.netWorthSbdEquiv === 455.32 && p1.state.gridVerdict === "ARMED-LIVE" && p1.protocol === "SAOS-SOVEREIGN-PULSE/1", "attested compose");
  // וקטור 2: מקור-כהה → heartbeat-only, אפס-מספרים
  const p2 = composePulse({ profit: null, grid: null });
  assert(p2.mode === "heartbeat-only" && p2.state.netWorthSbdEquiv === null && p2.state.gridVerdict === null, "heartbeat-only honest");
  // וקטור 3: רק-מקור-אחד → עדיין heartbeat-only (דרושים-שניהם)
  const p3 = composePulse({ profit: { at: "x", netWorthSbdEquiv: 1, verdict: "PROFIT", deltaVsPriorPct: 1 }, grid: null });
  assert(p3.mode === "heartbeat-only" && p3.state.netWorthSbdEquiv === null, "partial sources stay honest");
  // וקטור 4: custom_json op — צורה-חוקית (posting-auth)
  const op = ["custom_json", { required_auths: [], required_posting_auths: [ACCOUNT], id: PULSE_ID, json: JSON.stringify(p1) }];
  assert(op[1].required_posting_auths.length === 1 && op[1].required_auths.length === 0 && op[1].id === PULSE_ID && JSON.parse(op[1].json).protocol === "SAOS-SOVEREIGN-PULSE/1", "custom_json op shape");
  // וקטור 5: קריאה-אחרי-כתיבה — וקטור-דחייה על-op-זר
  const fakeTx = { operations: [["custom_json", { id: "follow", json: "{}" }]] };
  const ok = verifyReadback(fakeTx, { txid: "0".repeat(40), op: op[1] });
  assert(ok.ok === false, "readback refuses a foreign op");
  console.log("SELFTEST PASS: 5/5 vectors");
}

function verifyReadback(tx, want) {
  try {
    const op = tx?.operations?.find(([t]) => t === "custom_json")?.[1];
    if (!op) return { ok: false, reason: "no custom_json in tx" };
    if (op.id !== want.id) return { ok: false, reason: `id mismatch (${op.id})` };
    if (JSON.stringify(JSON.parse(op.json)) !== JSON.stringify(JSON.parse(want.json))) return { ok: false, reason: "payload mismatch" };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 120) };
  }
}

/* ── הריצה ──────────────────────────────────────────────────────────────────── */
async function main() {
  if (process.argv.includes("--selftest")) { await selftest(); return; }

  // 1) שער-STASIS
  if (stasisHalt("general")) {
    console.log("sovereign-pulse: מסילת general סגורה (STASIS) — לא נגעתי בכלום (כנות, לא כישלון)");
    process.exit(0);
  }

  // 2) מקורות
  const profit = await fetchProfitState();
  const grid = await fetchGridVerdict();
  const pulse = composePulse({ profit, grid });
  console.log(`sovereign-pulse: mode=${pulse.mode} · netWorth=${pulse.state.netWorthSbdEquiv} · grid=${pulse.state.gridVerdict}`);

  // 3) שער-מפתח (posting) — לפני-כל-חתימה
  const wif = process.env.STEEM_POSTING_WIF || "";
  const gate = await postingAuthorityOk({ account: ACCOUNT, wif, rpc: rpcAny });
  if (!gate.ok) {
    console.error(`sovereign-pulse: שער-המפתח מסרב — ${gate.reason}`);
    console.error("sovereign-pulse: fail-closed — אפס-שידור. הדופק-הבא ינסה שוב (המערכת-מאמצת-את-המפתח-החי מה-census במידת-הצורך).");
    process.exit(1);
  }

  const op = ["custom_json", { required_auths: [], required_posting_auths: [ACCOUNT], id: PULSE_ID, json: JSON.stringify(pulse) }];

  // 4) dry-run = פרסום-מקומי בלבד
  if (!execute) {
    console.log("sovereign-pulse: dry-run — הדופק לא שודר (הוסף --execute)");
    console.log(JSON.stringify(op, null, 1).slice(0, 800));
    process.exit(0);
  }

  // 5) שידור + קריאה-אחרי-כתיבה
  let result = { at: new Date().toISOString(), account: ACCOUNT, mode: pulse.mode, txid: null, readback: null };
  try {
    const r = await signAndBroadcast(wif, [op]);
    result.txid = r.txid; result.block = r.block;
    console.log(`sovereign-pulse: שודר txid=${r.txid} block=${r.block}`);
    await sleep(2500);
    const tx = await rpcAny("condenser_api.get_transaction", [r.txid]).catch(() => null);
    result.readback = tx ? verifyReadback(tx, { txid: r.txid, id: PULSE_ID, json: op[1].json }) : { ok: false, reason: "tx unreadable (irreversible lag) — יאומת במחזור-הבא" };
    console.log(`sovereign-pulse: readback=${result.readback.ok ? "OK" : "PENDING"} ${result.readback.reason ?? ""}`);
  } catch (e) {
    result.readback = { ok: false, reason: String(e?.message ?? e).slice(0, 200) };
    console.error(`sovereign-pulse: שידור-נכשל בכנות — ${result.readback.reason}`);
  }

  // 6) קבלה
  try {
    appendFileSync(join(HERE, "state", "sovereign-pulse.jsonl"), JSON.stringify(result) + "\n");
    appendEvent(join(HERE, "state", "events.jsonl"), { kind: "sovereign-pulse", at: result.at, account: ACCOUNT, mode: pulse.mode, txid: result.txid, ok: !!result.readback?.ok, sim: false });
  } catch { /* כשל-קבלה לא מפיל את התוצאה החיה */ }

  process.exit(result.readback?.ok || result.txid ? 0 : 1);
}

main().catch((e) => { console.error("sovereign-pulse FATAL:", String(e?.message ?? e).slice(0, 200)); process.exit(1); });
