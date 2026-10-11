// LIQUIDITY-SELFTEST — וקטורים דטרמיניסטיים אופליין למסילת-הזרקת-הנזילות (9-c)
//   node grids/liquidity-selftest.mjs → אפס-רשת, אפס-מפתחות-אמת, אפס-כתיבה-למדינה-החיה
// החול: עותק-מילולי של המסילה + שרשרת-התלויות שלה (brake/validate/key-gate/mover/
// events/book-law) + STASIS.json פיקטיבי + node_modules-סימלינק — המדינה-החיה לא נוגעת.
// ה-WIF בוקע בזיכרון מזרע-קבוע ומת לסוף-הריצה — אף-מפתח לא כתוב בקוד/בדיסק.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
let pass = 0, fail = 0;
const t = (name, ok) => {
  console.log(`${ok ? " ✓" : " ✗"} ${name}`);
  if (ok) pass++; else { fail++; process.exitCode = 1; }
};

const DEPS = ["brake.mjs", "validate-params.mjs", "key-gate.mjs", "mover.mjs", "book-law.mjs", "events.mjs"];

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "liquidity-selftest-"));
  mkdirSync(join(root, "grids", "state"), { recursive: true });
  // עותק-בתים-מילולי של המסילה + תלויותיה — אותו-קוד-בדיוק, פסיקות-מדינה סנדבוקסיות
  writeFileSync(join(root, "grids", "liquidity-bootstrap.mjs"), read(`${HERE}/liquidity-bootstrap.mjs`));
  for (const d of DEPS) writeFileSync(join(root, "grids", d), read(`${HERE}/${d}`));
  try { symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir"); } catch { /* כבר קיים */ }
  // STASIS פיקטיבי — staged עם lane=grid פתוח (המסילה מותרת; אין-גרדים-חיצוניים)
  writeFileSync(join(root, "grids", "state", "STASIS.json"), JSON.stringify({
    protocol: "SAOS-FATE-DEFENSE-STASIS/1", active: true, mode: "staged",
    reason: "selftest staged brake", since: "2026-10-11T00:00:00Z",
    stagedLanes: { allow: ["grid"], reason: "selftest", since: "2026-10-11T00:00:00Z" },
  }, null, 2));
  return root;
}
const read = (p) => { if (!existsSync(p)) throw new Error(`missing selftest dep: ${p}`); return readFileSync(p, "utf8"); };

/* ── WIF-חול: בוקע מזרע-קבוע בזיכרון — אף-מפתח-אמת לא נוגע בכאן ───────────── */
const { privToWif, wifToPriv } = await import(join(HERE, "mover.mjs"));
const TEST_WIF = privToWif(crypto.createHash("sha256").update(`saos-9c-selftest-seed:${Date.now()}-${process.pid}`).digest());
void wifToPriv; // (החוק: הגזירה-קדימה נבדקת מול הרשות-המדומה, לא מול מפתח-אמת)
const keyGate = await import(join(HERE, "key-gate.mjs"));
const TEST_PUB = keyGate.wifToPublicSafe(TEST_WIF);
if (!TEST_PUB) { console.error("selftest boot failure: sandbox WIF did not derive a pubkey"); process.exit(1); }

/* ── שרשרת-מדומה: מצב-חי סגור-בתוך-הוקטור ─────────────────────────────────── */
function fakeChain({ steem = 100, sbd = 10, pub = TEST_PUB, orders = [] } = {}) {
  const state = { orders: [...orders] };
  const rpc = async (method, params) => {
    if (method === "condenser_api.get_accounts") {
      return [{ balance: `${steem.toFixed(3)} STEEM`, sbd_balance: `${sbd.toFixed(3)} SBD`, active: { key_auths: [[pub, 1]] } }];
    }
    if (method === "condenser_api.get_open_orders") return state.orders.map((o) => ({ ...o }));
    if (method === "condenser_api.get_order_book") {
      return { asks: [{ real_price: "0.102000" }], bids: [{ real_price: "0.101300" }] };
    }
    throw new Error(`fake chain: unexpected ${method}`);
  };
  const sign = async (_wif, ops) => {
    for (const [type, body] of ops) {
      if (type !== "limit_order_create") throw new Error(`fake chain: unexpected op ${type}`);
      state.orders.push({ orderid: body.orderid, sell_price: { base: body.amount_to_sell, quote: body.min_to_receive } });
    }
    return { txid: `mock-${state.orders.length}`, block: 99 };
  };
  return { state, rpc, sign };
}
const PARITY = 0.1009; // קו-הזהות מתחת למגע — האסק-1 מוצמד למגע (Z-80)
const ioOf = (c) => ({ rpc: c.rpc, sign: c.sign, parity: async () => PARITY });

function writeArm(root, doc) {
  writeFileSync(join(root, "grids", "liquidity-arm.json"), JSON.stringify(doc, null, 2));
}
const ARM = (paramsRel) => ({
  protocol: "SAOS-LIQUIDITY-ARM/1", sealedAt: "2026-10-11T17:10:00Z",
  ownerWord: "selftest: owner mandate trace 1a12b258c9776305", maxOpsPerRun: 6,
  params: paramsRel,
});
function writeParams(root, doc) {
  const p = join(root, "params.json");
  writeFileSync(p, JSON.stringify(doc, null, 2));
  return p;
}
const GOOD_PARAMS = {
  protocol: "SAOS-GRID-PARAMS/1", sealedAt: "2026-10-11T16:55:00Z",
  steem: { commitPct: 0.85, minKeepSteem: 0.5, minLevelSteem: 1.0, minLevelSbd: 0.05, bidLevels: 3, bidStepBps: 150, askLevels: 3, askStepBps: 80, parityBandBps: 5000, expiryDays: 27 },
  hive: { commitPct: 0.9, minKeepHive: 0.005, minLevelHive: 0.010, minLevelHbd: 0.001, askMinRecvHbd: 0.2, bidLevels: 3, bidStepBps: 200, askLevels: 3, askStepBps: 50, parityBandBps: 5000, expiryDays: 27 },
};

/* ═══ וקטור 1 — אין-קובץ-חימוש = סירוב-כנה עם exit 0 (ההצלחה-על-פי-תכנון) ═══ */
{
  const root = sandbox();
  const m = await import(join(root, "grids", "liquidity-bootstrap.mjs"));
  const c = fakeChain();
  const r = await m.runBootstrap({ account: "testacct", execute: true, params: writeParams(root, GOOD_PARAMS), io: ioOf(c) });
  t("V1 missing arm file → honest refusal, exit 0, zero ops", r.refused?.includes("arm file missing") === true && r.exit === 0 && r.plan.length === 0);
  rmSync(root, { recursive: true, force: true });
}

/* ═══ וקטור 2 — חימוש+מלאי: תוכנית-דלתא מדויקת, ביצוע, ואז אידמפוטנטיות מלאה ═══ */
{
  const root = sandbox();
  writeArm(root, ARM("params.json"));
  const m = await import(join(root, "grids", "liquidity-bootstrap.mjs"));
  const c = fakeChain();
  const io = ioOf(c);
  // dry-run: מתכנן 6 רמות (3 אסקים מעל קו-הזהות + 3 בידים מתחת למגע), לא שודר
  const dry = await m.runBootstrap({ account: "testacct", execute: false, params: writeParams(root, GOOD_PARAMS), io });
  t("V2a dry-run plans exactly 6 delta levels (3 ask + 3 bid)", dry.plan.length === 6 && dry.plan.filter((o) => o.side === "ask").length === 3 && dry.plan.filter((o) => o.side === "bid").length === 3);
  t("V2a every ask sits ≥ parity (value-line law)", dry.plan.filter((o) => o.side === "ask").every((o) => o.px >= PARITY));
  t("V2a every bid sits below the touch (never crosses the book)", dry.plan.filter((o) => o.side === "bid").every((o) => o.px < 0.1013));
  const sizes = dry.plan.filter((o) => o.side === "ask").map((o) => parseFloat(o.amountToSell));
  t("V2a ask size = 85% of (100-0.5)/3 ≈ 28.191 STEEM", Math.abs(sizes[0] - 28.191) < 0.002);
  // execute: כל-האופים מיושמים, נקראים-אחר-כתיבה, קבלה נכתבת. המפתח-החול ביד —
  // והוא גוזר בדיוק את רשות-ה-active-המדומה (אותו-משטר verify-then-sign)
  process.env.STEEM_ACTIVE_WIF = TEST_WIF;
  const run1 = await m.runBootstrap({ account: "testacct", execute: true, params: writeParams(root, GOOD_PARAMS), io });
  t("V2b execute applies all 6 ops with read-after-write", run1.applied.length === 6 && run1.failed.length === 0 && run1.txids.length === 6);
  t("V2b orderids live in the bootstrap namespace (…51+)", run1.applied.every((o) => o.orderid % 100 >= 51));
  // ריצה-שנייה על אותה-שרשרת: הכל-כבר-מדורג → אפס-אופים (אידמפוטנטי)
  const run2 = await m.runBootstrap({ account: "testacct", execute: true, params: writeParams(root, GOOD_PARAMS), io });
  t("V2c second run is a no-op (delta-only idempotence)", run2.plan.length === 0 && run2.applied.length === 0 && /already at target depth|nothing to deploy/.test(run2.refused ?? ""));
  delete process.env.STEEM_ACTIVE_WIF;
  rmSync(root, { recursive: true, force: true });
}

/* ═══ וקטור 3 — פרמטרים-רעים = fail-closed, אפס-אופים ═══ */
{
  const root = sandbox();
  writeArm(root, ARM("params.json"));
  const m = await import(join(root, "grids", "liquidity-bootstrap.mjs"));
  const bad = JSON.parse(JSON.stringify(GOOD_PARAMS));
  bad.steem.commitPct = 0.99; // מעל הפסיקה (≤0.95)
  const c = fakeChain();
  const r = await m.runBootstrap({ account: "testacct", execute: true, params: writeParams(root, bad), io: ioOf(c) });
  t("V3 out-of-rail params refused, exit 2, zero ops", r.exit === 2 && r.plan.length === 0 && /REJECTED by grids\/validate-params.mjs/.test(r.refused ?? ""));
  rmSync(root, { recursive: true, force: true });
}

/* ═══ וקטור 4 — מפתח-שאינו גוזר את הרשות-החיה = סירוב-חתימה, אפס-אופים ═══ */
{
  const root = sandbox();
  writeArm(root, ARM("params.json"));
  const m = await import(join(root, "grids", "liquidity-bootstrap.mjs"));
  const c = fakeChain({ pub: "STM8STALEKEYaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }); // רשות-חיה אחרת
  process.env.STEEM_ACTIVE_WIF = TEST_WIF; // המפתח-החול ביד — אבל הוא לא הרשות-החיה
  const r = await m.runBootstrap({ account: "testacct", execute: true, params: writeParams(root, GOOD_PARAMS), io: ioOf(c) });
  t("V4 stale key refused at the gate (fail-closed), zero ops, exit 1", r.exit === 1 && r.plan.length > 0 && r.applied.length === 0 && /does NOT derive the live active authority/.test(r.refused ?? ""));
  delete process.env.STEEM_ACTIVE_WIF;
  rmSync(root, { recursive: true, force: true });
}

/* ═══ וקטור 5 — קובץ-חימוש-זר (פרוטוקול-אחר) = exit 2 fail-closed ═══ */
{
  const root = sandbox();
  writeArm(root, { protocol: "SOME-OTHER-ARM/3", sealedAt: "2026-10-11T17:10:00Z", ownerWord: "x".repeat(20), maxOpsPerRun: 6, params: "params.json" });
  const m = await import(join(root, "grids", "liquidity-bootstrap.mjs"));
  const c = fakeChain();
  const r = await m.runBootstrap({ account: "testacct", execute: true, params: writeParams(root, GOOD_PARAMS), io: ioOf(c) });
  t("V5 foreign arm protocol refused (fail-closed), zero ops", r.exit === 2 && r.plan.length === 0 && /foreign arm protocol/.test(r.refused ?? ""));
  rmSync(root, { recursive: true, force: true });
}

/* ═══ וקטור 6 — אין-פאריטי-חוץ = אין-פריסה (קו-הזהות הוא חוק) ═══ */
{
  const root = sandbox();
  writeArm(root, ARM("params.json"));
  const m = await import(join(root, "grids", "liquidity-bootstrap.mjs"));
  const c = fakeChain();
  const r = await m.runBootstrap({ account: "testacct", execute: true, params: writeParams(root, GOOD_PARAMS), io: { rpc: c.rpc, sign: c.sign, parity: async () => null } });
  t("V6 no external parity → no deployment (value-line law), exit 0", r.plan.length === 0 && r.exit === 0 && /value line is the law/.test(r.skips.join(" ")));
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nliquidity-selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
