#!/usr/bin/env node
/**
 * usds-liquidity-selftest.mjs — גל-#82 · מבחני-קבלה למסילת-הפעלת-נזילות-USDS (trace 1a178c614313ad05 §3)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * אפס-רשת · אפס-מפתחות-אמת · אפס-כתיבה-למדינה-החיה. מצב-המנוע מוזרק (fake engine state
 * בצורות-המדודות של db/state-snapshot.json @h1753690). exitCode=1 על-כל-אדום.
 * החוק-המדוד (kernel.ts:908-913 + kernel.ts:62): USDS/WSBD נשאב-חי עד rb=1µ — מת;
 * USDS/WSTEEM דק (455,100µ) על-העוגן; SAOS/USDS בריא. האוצר-החי: USDS-צף 1,051µ בלבד.
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  console.log(`${ok ? " ✓" : " ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : (fail++, (process.exitCode = 1));
};

/* ── מצב-מנוע מדומה — צורות-המדידה החיות (h1753690) בגדלים-שנשלטים ─────────── */
function fakeState() {
  return {
    height: 100,
    balances: {
      treasury: { USDS: 5_000_000, SAOS: 2_000_000, WSTEEM: 12_000_000, WSBD: 2_200_000, "LP|USDS/WSTEEM": 5_656_854 },
    },
    locked: { treasury: { USDS: 1_000_000, WSBD: 50_000 } },
    assets: {
      SAOS: { refPrice: 2500 }, USDS: { refPrice: 1000 }, WSTEEM: { refPrice: 50 },
      WSBD: { refPrice: 473 }, ENERGY: { refPrice: 125 }, PHIVE: { refPrice: 48 },
    },
    pools: {
      // בריא: mid = floor(8e6×1000/2e7)=400 = anchor floor(1000×1000/2500)=400 · צד-USDS (b) = 20M
      "SAOS/USDS": { a: "SAOS", b: "USDS", ra: 8_000_000, rb: 20_000_000, lp: 12_649_110 },
      // דק על-העוגן: p.a=USDS (מיון-אלפביתי!) · mid = floor(455100×1000/9049615)=50 = anchor floor(50×1000/1000)=50
      "USDS/WSTEEM": { a: "USDS", b: "WSTEEM", ra: 455_100, rb: 9_049_615, lp: 2_029_616 },
      // מת: rb=1µ (המדידה-החיה) · mid=floor(475000×1000/1)=475,000,000 מול anchor floor(473×1000/1000)=473 → prem ≥ 10k
      "USDS/WSBD": { a: "USDS", b: "WSBD", ra: 475_000, rb: 1, lp: 689 },
    },
  };
}

/* וריאציה: בריכה-דקה שבה USDS = p.b (צד-ימין אחרי-המיון) — על-העוגן WSBD↔USDS */
function fakeStateUsdsRight() {
  const st = fakeState();
  delete st.pools["USDS/WSTEEM"];
  // mid = floor(2114000×1000/1e6)=2,114 = anchor floor(1000×1000/473)=2,114 · צד-USDS (b) = 1M
  st.pools["USDS/WSBD"] = { a: "WSBD", b: "USDS", ra: 2_114_000, rb: 1_000_000, lp: 1_453_940 };
  return st;
}

/* וריאציה: בריכה-חיה-רחוקה-מהעוגן (off-anchor, אך לא-מתה) — prem=1000bps בדיוק */
function fakeStateOffAnchor() {
  const st = fakeState();
  // mid = floor(500000×1000/9049615)=55 · anchor=50 · prem=floor((55-50)×10000/50)=1000
  st.pools["USDS/WSTEEM"] = { a: "USDS", b: "WSTEEM", ra: 500_000, rb: 9_049_615, lp: 2_127_363 };
  return st;
}

const ARM = {
  protocol: "SAOS-USDS-LIQUIDITY-ARM/1",
  sealedAt: "2026-10-26T15:00:00Z",
  pools: [
    { pair: "SAOS/USDS", minUsdsSideMu: 20_000_000 },
    { pair: "WSTEEM/USDS", minUsdsSideMu: 1_000_000 },
    { pair: "USDS/WSBD", minUsdsSideMu: 1_000_000 },
  ],
  maxOpPerRun: 4,
  note: "selftest: owner mandate trace 1a178c614313ad05 §3 — activate real USDS liquidity pairs",
};

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "usds-liquidity-selftest-"));
  return { root, armPath: join(root, "usds-arm.json"), receiptPath: join(root, "receipt.json") };
}
const writeArm = (path, doc) => writeFileSync(path, JSON.stringify(doc, null, 2));

/* ── המודול — היבוא-היחיד של המסילה (אפס-תלויות חוץ) ────────────────────────── */
const m = await import(join(HERE, "usds-liquidity.mjs"));
const ioLive = (st) => ({ fetchState: async () => ({ state: st }), readSnapshot: async () => null, postOp: async () => { throw new Error("no posts in this vector"); } });

/* ── החלה-גרעינית מדומה — אותן-סמנטיקות של amm.poolAdd / kernel pool_reseed/pool_open ── */
function applyLikeKernel(st, body) {
  const op = body.ops?.[0] ?? body;
  const pool = st.pools[op.pair];
  if (body.action === "add") { const amt = body.amountA; pool.rb += Math.floor((pool.rb * amt) / pool.ra); pool.ra += amt; }
  if (body.action === "open") { st.pools[op.pair] = { a: op.pair.split("/")[0], b: op.pair.split("/")[1], ra: body.amountA, rb: body.amountB, lp: 1 }; }
  if (op.type === "pool_reseed") { pool.ra = op.amount; pool.rb = op.amountB; }
}

/* ═══ וקטור 1 — חוק-קובץ-החימוש: חסר = סירוב-כן exit 0 · פגום/זר = exit 2 ═══ */
{
  const { root, armPath, receiptPath } = sandbox();
  // חסר — execute מסורב בכנות (הסירוב הוא-ההצלחה-על-פי-תכנון)
  const r1 = await m.runUsdsLiquidity({ execute: true, armPath, receiptPath, io: ioLive(fakeState()) });
  t("V1a missing arm → honest refusal exit 0, zero plan ops", r1.exit === 0 && r1.refused?.includes("arm file missing") === true && r1.plan.length === 0);
  // פגום — JSON שבור = exit 2 fail-closed
  writeFileSync(armPath, "{protocol: broken");
  const r2 = await m.runUsdsLiquidity({ execute: true, armPath, receiptPath, io: ioLive(fakeState()) });
  t("V1b malformed arm → exit 2 fail-closed, zero ops", r2.exit === 2 && r2.plan.length === 0 && /unreadable|malformed/i.test(r2.refused ?? ""));
  // פרוטוקול-זר
  writeArm(armPath, { ...ARM, protocol: "SOME-OTHER-ARM/3" });
  const r3 = await m.runUsdsLiquidity({ execute: true, armPath, receiptPath, io: ioLive(fakeState()) });
  t("V1c foreign arm protocol → exit 2", r3.exit === 2 && /foreign arm protocol/.test(r3.refused ?? ""));
  // זוג-לא-רשום-ברשימה-הלבנה
  writeArm(armPath, { ...ARM, pools: [{ pair: "ENERGY/USDS", minUsdsSideMu: 1_000_000 }] });
  const r4 = await m.runUsdsLiquidity({ execute: true, armPath, receiptPath, io: ioLive(fakeState()) });
  t("V1d non-whitelisted pair in arm → exit 2 (whitelist law)", r4.exit === 2 && /not-whitelisted|whitelist/i.test(r4.refused ?? ""));
  // שדה-זר
  writeArm(armPath, { ...ARM, rogue: 1 });
  const r5 = await m.runUsdsLiquidity({ execute: true, armPath, receiptPath, io: ioLive(fakeState()) });
  t("V1e foreign arm field → exit 2 fail-closed", r5.exit === 2 && /foreign arm field/.test(r5.refused ?? ""));
  // תקרת-אופים מחוץ-לתחום
  writeArm(armPath, { ...ARM, maxOpPerRun: 0 });
  const r6 = await m.runUsdsLiquidity({ execute: true, armPath, receiptPath, io: ioLive(fakeState()) });
  t("V1f maxOpPerRun out of range → exit 2", r6.exit === 2 && /maxOpPerRun/.test(r6.refused ?? ""));
  // owner-note קצר-מדי
  writeArm(armPath, { ...ARM, note: "x" });
  const r7 = await m.runUsdsLiquidity({ execute: true, armPath, receiptPath, io: ioLive(fakeState()) });
  t("V1g bare owner note refuses (owner text is the law)", r7.exit === 2 && /note/.test(r7.refused ?? ""));
  rmSync(root, { recursive: true, force: true });
}

/* ═══ וקטור 2 — מדידה טהורה: מזהי-צדדים, mid, anchor, חוות-דעת ═══ */
{
  const st = fakeState();
  const f1 = m.poolFacts(st, "SAOS/USDS", 20_000_000);
  t("V2a SAOS/USDS healthy: usdsSide=b, usdsSideMu=20,000,000", f1.usdsSide === "b" && f1.usdsSideMu === 20_000_000 && f1.verdict === "healthy");
  t("V2a mid 400 == anchor 400 (prem 0)", f1.mid === 400 && f1.anchorMid === 400 && f1.premBps === 0);
  const f2 = m.poolFacts(st, "WSTEEM/USDS", 1_000_000);
  t("V2b USDS/WSTEEM: alphabetic orientation a=USDS · thin", f2.a === "USDS" && f2.b === "WSTEEM" && f2.usdsSide === "a" && f2.usdsSideMu === 455_100 && f2.verdict === "thin");
  t("V2b mid 50 == anchor 50 (WSTEEM ref slid to 50 — measured)", f2.mid === 50 && f2.anchorMid === 50 && f2.premBps === 0);
  const f3 = m.poolFacts(st, "USDS/WSBD", 1_000_000);
  t("V2c USDS/WSBD dead (rb=1µ — the measured drain)", f3.verdict === "dead" && f3.raRepeg === 0);
  t("V2c premBps ≥ reseed trigger (10,000bps)", Math.abs(f3.premBps) >= m.RESERVE_RESEED_TRIGGER_BPS);
  const f4 = m.poolFacts(st, "SAOS/USDS", 999_999_999);
  t("V2d healthy pool flips to thin under a higher arm target", f4.verdict === "thin" && f4.usdsSideMu === 20_000_000);
  const f5 = m.poolFacts(st, "PHIVE/USDS", 1_000_000);
  t("V2e missing pool honest (no fabrication)", f5.verdict === "missing" && f5.usdsSideMu === 0);
}

/* ═══ וקטור 3 — תוכנית-ההעמקה: דלתא-מינימלית מתוך-צף-האוצר (שלמים-בלבד) ═══ */
{
  const st = fakeState();
  const p = m.nourishPlan(st, ARM);
  t("V3a plan covers exactly the 3 armed pairs", p.pools.length === 3);
  t("V3a healthy pool → no op (idempotence by design)", p.pools.find((x) => x.pair === "SAOS/USDS")?.action === "none");
  // דק: USDS=p.a → pool_add amount=delta=544,900 · הצד-הנגזר floor(9049615×544900/455100)=10,835,545
  const add = p.plan.find((o) => o.kind === "add");
  t("V3b thin pool → pool_add treasury, delta=544,900µ USDS", !!add && add.pair === "USDS/WSTEEM" && add.payload.amount === 544_900 && add.payload.issuer === "treasury");
  t("V3b derived B side = 10,835,278µ WSTEEM (ratio-preserving, integers)", add?.derivedB === 10_835_278);
  t("V3b executable within treasury float (WSTEEM avail 12,000,000)", p.pools.find((r) => r.pair === "USDS/WSTEEM")?.executable === true);
  // מת: pool_reseed — seedA(USDS)=1,000,000 · seedB=floor(1e6×1000/473)=2,114,166 · חוק-העוגן seedA===floor(seedB×refB/refA)
  const rs = p.plan.find((o) => o.kind === "reseed");
  t("V3c dead pool → pool_reseed, USDS seed = arm min 1,000,000µ", !!rs && rs.pair === "USDS/WSBD" && rs.payload.amount === 1_000_000 && rs.payload.issuer === "treasury");
  t("V3c derived seedB = 2,114,165µ WSBD (minimal seed with the exact kernel anchor law)", rs?.payload.amountB === 2_114_165);
  t("V3c kernel anchor law: seedA === floor(seedB×refB/refA) exactly", rs?.payload.amount === Math.floor((rs.payload.amountB * 473) / 1000));
  t("V3c executable (old reserves return first: needA=525,000 · needB=2,114,164)", p.pools.find((r) => r.pair === "USDS/WSBD")?.executable === true);
  t("V3c route seam: reseed rides /api/dex/batch (kernel-only op)", rs?.route === "/api/dex/batch" && rs.body.issuer === "treasury" && rs.body.ops[0].type === "pool_reseed");
  t("V3c add rides /api/dex/pool action=add", add?.route === "/api/dex/pool" && add.body.action === "add" && add.body.pair === "USDS/WSTEEM");
  t("V3d counts honest: healthy=1 thin=1 dead=1 executable=2", p.counts.healthy === 1 && p.counts.thin === 1 && p.counts.dead === 1 && p.counts.executable === 2);
}

/* ═══ וקטור 4 — כיוון-ב: USDS=צד-ימין · דלתא-מינימלית מהצד-השני ═══ */
{
  const st = fakeStateUsdsRight();
  const arm = { ...ARM, pools: [{ pair: "USDS/WSBD", minUsdsSideMu: 2_000_000 }] };
  const p = m.nourishPlan(st, arm);
  const add = p.plan.find((o) => o.kind === "add");
  t("V4a USDS=p.b thin → minimal A-side = 2,114,000µ WSBD", !!add && add.payload.amount === 2_114_000);
  t("V4a derived B (USDS side) = 1,000,000 ≥ delta (never under target)", add?.derivedB === 1_000_000);
}

/* ═══ וקטור 5 — כנות: off-anchor / אין-עוגן / צף-אוצר-לא-מספיק / op-cap ═══ */
{
  // off-anchor → הריפג שייך-לפעימה (cloud-beat R26-ALL) — אין-הפעלה-כפולה מהגריד
  {
    const p = m.nourishPlan(fakeStateOffAnchor(), { ...ARM, pools: [{ pair: "WSTEEM/USDS", minUsdsSideMu: 1_000_000 }] });
    const row = p.pools.find((x) => x.pair === "USDS/WSTEEM");
    t("V5a off-anchor → no grid op, beat-owned repeg published honestly", row?.action === "skip" && row?.verdict === "off-anchor" && /repeg/.test(row.blocked.join(" ")) && p.plan.length === 0);
  }
  // אין-עוגן (refPrice=0) → אין-ציטוט-כשר
  {
    const st = fakeState();
    st.assets.WSTEEM.refPrice = 0;
    const p = m.nourishPlan(st, { ...ARM, pools: [{ pair: "WSTEEM/USDS", minUsdsSideMu: 1_000_000 }] });
    const row = p.pools.find((x) => x.pair === "USDS/WSTEEM");
    t("V5b no-anchor → verdict no-anchor, no op", row?.verdict === "no-anchor" && p.plan.length === 0);
  }
  // צף-האוצר חוסם בכנות (המדידה-החיה: USDS-צף 1,051µ בלבד)
  {
    const st = fakeState();
    st.balances.treasury.WSTEEM = 46_621;
    st.balances.treasury.WSBD = 99_230;
    st.locked.treasury = { USDS: 999_948, WSBD: 99_230 };
    const p = m.nourishPlan(st, ARM);
    const addRow = p.pools.find((r) => r.action === "add");
    const rsRow = p.pools.find((r) => r.action === "reseed");
    t("V5c thin nourish blocked honestly (insufficient-treasury)", !!addRow && addRow.executable === false && /insufficient-treasury/.test(addRow.blocked.join(" ")));
    t("V5c reseed blocked honestly (float + returned reserves insufficient)", !!rsRow && rsRow.executable === false && /insufficient-treasury/.test(rsRow.blocked.join(" ")));
    t("V5c executable=0 — the plan PUBLISHES blockers, never fakes money", p.counts.executable === 0 && p.plan.length === 0);
  }
  // op-cap
  {
    const p = m.nourishPlan(fakeState(), { ...ARM, maxOpPerRun: 1 });
    t("V5d maxOpPerRun=1 → exactly 1 planned op, rest skipped honestly", p.plan.length === 1 && p.skipped.some((s) => /op-cap/.test(s.reason)));
  }
  // אידמפוטנציה: החלת-התוכנית על-המצב → ריצה-שנייה אפס-אופים
  {
    const st = fakeState();
    const p1 = m.nourishPlan(st, ARM);
    for (const o of p1.plan) {
      const pool = st.pools[o.pair];
      if (o.kind === "add") { pool.ra += o.payload.amount; pool.rb += o.derivedB; }
      if (o.kind === "reseed") { pool.ra = o.payload.amount; pool.rb = o.payload.amountB; }
    }
    const p2 = m.nourishPlan(st, ARM);
    t("V5e idempotence: after nourish lands, second plan is zero ops", p2.plan.length === 0 && p2.pools.every((x) => x.verdict === "healthy"));
  }
}

/* ═══ וקטור 6 — dry-run מול-מצב-מוזרק: קבלה-כתובה, אפס-פוסטים ═══ */
{
  const { root, armPath, receiptPath } = sandbox();
  writeArm(armPath, ARM);
  const st = fakeState();
  let posts = 0;
  const io = { fetchState: async () => ({ state: st }), readSnapshot: async () => null, postOp: async () => { posts++; return { ok: true, status: 200, json: {} }; } };
  const r = await m.runUsdsLiquidity({ execute: false, armPath, receiptPath, io });
  t("V6a dry-run: exit 0, zero posts, plan printed", r.exit === 0 && posts === 0 && r.plan.length === 2);
  t("V6a receipt file written with the SAOS-USDS-LIQUIDITY/1 protocol", existsSync(receiptPath) && JSON.parse(readFileSync(receiptPath, "utf8")).protocol === m.RECEIPT_PROTOCOL);
  const rec = JSON.parse(readFileSync(receiptPath, "utf8"));
  t("V6a receipt pools carry measured ra/rb/usdsSideMu/mid", rec.pools.length === 3 && rec.pools.find((x) => x.key === "USDS/WSTEEM").usdsSideMu === 455_100 && rec.pools.find((x) => x.key === "USDS/WSTEEM").mid === 50);
  t("V6a receipt plan carries the 2 executable payloads", rec.plan.length === 2 && rec.executed.length === 0 && rec.executedSkipped.length === 0);
  t("V6a receipt honest engineUnreachable=false (state was injected)", rec.engineUnreachable === false && rec.source.kind === "injected");
  t("V6a law references present (kernel op family + arm law + operator seam)", /pool_reseed/.test(rec.law.kernelOps) && /liquidity-bootstrap/.test(rec.law.armLaw) && /x-saos-operator/.test(rec.law.operatorSeam));
  t("V6a no secrets in receipt (token never serialized)", !JSON.stringify(rec).includes("TEST-TOKEN"));
  rmSync(root, { recursive: true, force: true });
}

/* ═══ וקטור 7 — execute אמת-מול-מנוע-מדומה: פוסטים, כותרות, read-after-write, אידמפוטנציה ═══ */
{
  const { root, armPath, receiptPath } = sandbox();
  writeArm(armPath, ARM);
  const st = fakeState();
  const posts = [];
  const io = {
    fetchState: async () => ({ state: st }),
    readSnapshot: async () => null,
    postOp: async (route, body, token) => {
      posts.push({ route, body, token });
      applyLikeKernel(st, body); // החלה-גרעינית מדומה — read-after-write אמת
      return { ok: true, status: 200, json: { ok: true } };
    },
  };
  process.env.DEX_OPERATOR_TOKEN = "TEST-TOKEN-never-print";
  const r = await m.runUsdsLiquidity({ execute: true, armPath, receiptPath, io, vaultTokenPath: join(root, "no-such-vault") });
  delete process.env.DEX_OPERATOR_TOKEN;
  t("V7a execute posts exactly 2 ops (add + reseed batch)", posts.length === 2 && r.exit === 0);
  t("V7a operator token rides x-saos-operator seam on every post", posts.every((p) => p.token === "TEST-TOKEN-never-print"));
  t("V7a routes: pool_add → /api/dex/pool · reseed → /api/dex/batch", posts.some((p) => p.route === "/api/dex/pool" && p.body.action === "add") && posts.some((p) => p.route === "/api/dex/batch" && p.body.ops[0].type === "pool_reseed"));
  t("V7a read-after-write: executed rows carry measured before/after", r.executed.length === 2 && r.executed.every((e) => e.after.usdsSideMu >= e.targetUsdsMu));
  t("V7a receipt records executed honestly", JSON.parse(readFileSync(receiptPath, "utf8")).executed.length === 2);
  // ריצה-שנייה על אותו-מצב: הכל בריא → אפס-פוסטים (אידמפוטנטי)
  const posts2 = posts.length;
  const r2 = await m.runUsdsLiquidity({ execute: true, armPath, receiptPath, io, vaultTokenPath: join(root, "no-such-vault") });
  t("V7b second run idempotent: zero posts, zero executed", posts.length === posts2 && r2.executed.length === 0 && /already at target|zero ops/.test(r2.refused ?? ""));
  rmSync(root, { recursive: true, force: true });
}

/* ═══ וקטור 8 — שערי-מפעיל וכנות-מנוע ═══ */
{
  const { root, armPath, receiptPath } = sandbox();
  writeArm(armPath, ARM);
  // אין-טוקן (env נוקה + קובץ-כספת נעדר) → סירוב-כן, אפס-פוסטים, exit 1
  {
    const st = fakeState();
    let posts = 0;
    const io = { fetchState: async () => ({ state: st }), readSnapshot: async () => null, postOp: async () => { posts++; return { ok: true, status: 200, json: {} }; } };
    const saved = process.env.DEX_OPERATOR_TOKEN;
    delete process.env.DEX_OPERATOR_TOKEN;
    const r = await m.runUsdsLiquidity({ execute: true, armPath, receiptPath, io, vaultTokenPath: join(root, "no-such-vault") });
    if (saved !== undefined) process.env.DEX_OPERATOR_TOKEN = saved;
    t("V8a no operator token → honest refusal exit 1, zero posts", r.exit === 1 && posts === 0 && /operator token/.test(r.refused ?? ""));
  }
  // טוקן-מכספת-הקובץ (התפר-עמיד של גל-80) — נקרא ולעולם לא נדפס
  {
    const vault = join(root, "vault-token");
    writeFileSync(vault, "VAULT-TOKEN-material\n");
    const st = fakeState();
    const tokens = [];
    const io = { fetchState: async () => ({ state: st }), readSnapshot: async () => null, postOp: async (_r, body, token) => { tokens.push(token); applyLikeKernel(st, body); return { ok: true, status: 200, json: {} }; } };
    const saved = process.env.DEX_OPERATOR_TOKEN;
    delete process.env.DEX_OPERATOR_TOKEN;
    const r = await m.runUsdsLiquidity({ execute: true, armPath, receiptPath, io, vaultTokenPath: vault });
    if (saved !== undefined) process.env.DEX_OPERATOR_TOKEN = saved;
    t("V8b vault-file token used, never logged", tokens.length === 2 && tokens.every((x) => x === "VAULT-TOKEN-material") && !JSON.stringify(r).includes("VAULT-TOKEN"));
  }
  // מנוע-נעדר + אין-סנאפשוט → קבלה-כנה engineUnreachable=true, אפס-מספרים-מומצאים
  {
    const r = await m.runUsdsLiquidity({ execute: false, armPath, receiptPath, io: { fetchState: async () => null, readSnapshot: async () => null, postOp: async () => ({ ok: false }) } });
    const rec = JSON.parse(readFileSync(receiptPath, "utf8"));
    t("V8c engine unreachable → honest receipt, empty pools, zero fabricated numbers", r.engineUnreachable === true && rec.engineUnreachable === true && rec.pools.length === 0 && rec.plan.length === 0);
    t("V8c dry-run with unreachable engine → exit 0 (measurement duty, no ops)", r.exit === 0);
  }
  // execute על-מנוע-נעדר → סירוב-יציאה-1 (אף-תכנון-על-ספק)
  {
    const r = await m.runUsdsLiquidity({ execute: true, armPath, receiptPath, io: { fetchState: async () => null, readSnapshot: async () => null, postOp: async () => ({ ok: false }) } });
    t("V8d execute on unreachable engine refused (never plan on doubt), exit 1", r.exit === 1 && r.plan.length === 0);
  }
  // נפילה-לסנאפשוט-המדוד (מקור-מדידה-אמת, מסומן-מיושן בכנות) — dry בלבד
  {
    const st = fakeState();
    const r = await m.runUsdsLiquidity({
      execute: false, armPath, receiptPath, now: 1_000_000_000_000,
      io: { fetchState: async () => null, readSnapshot: async () => ({ savedAt: new Date(1_000_000_000_000 - 3 * 3_600_000).toISOString(), state: st }), postOp: async () => ({ ok: false }) },
    });
    const rec = JSON.parse(readFileSync(receiptPath, "utf8"));
    t("V8e repo-snapshot fallback: measured pools land, source marked snapshot+stale", rec.engineUnreachable === true && rec.source.kind === "repo-snapshot" && rec.source.stale === true && rec.pools.length === 3 && rec.pools.find((x) => x.key === "USDS/WSTEEM").usdsSideMu === 455_100);
    t("V8e plan computed from the measured snapshot (2 executable)", rec.plan.length === 2);
  }
  // פוסט-נכשל אחרי-פוסט-מוצלח → fail-closed עצירה כנה (הפוסט-המוצלח מיושם — read-after-write אמת)
  {
    const st = fakeState();
    let n = 0;
    const apply = (body) => applyLikeKernel(st, body);
    const io = {
      fetchState: async () => ({ state: st }), readSnapshot: async () => null,
      postOp: async (_r, body) => { n++; if (n === 2) return { ok: false, status: 503, json: { error: "operator-auth-unconfigured" } }; apply(body); return { ok: true, status: 200, json: { ok: true } }; },
    };
    process.env.DEX_OPERATOR_TOKEN = "TEST-TOKEN-never-print";
    const r = await m.runUsdsLiquidity({ execute: true, armPath, receiptPath, io, vaultTokenPath: join(root, "no-such-vault") });
    delete process.env.DEX_OPERATOR_TOKEN;
    t("V8f mid-run post failure → fail-closed stop, executed=1 failed=1, exit 1", r.exit === 1 && r.executed.length === 1 && r.executedSkipped.length === 1 && n === 2);
  }
  rmSync(root, { recursive: true, force: true });
}

/* ═══ וקטור 9 — החלטת-אופ-הגרעין: משפחת-ה-nourish קיימת — אין-אופ-חדש ═══ */
{
  t("V9 kernel-op decision published: pool_open/pool_reseed/pool_add cover nourish — pool_nourish NOT added", /pool_open/.test(m.KERNEL_OP_DECISION) && /pool_reseed/.test(m.KERNEL_OP_DECISION) && /pool_add/.test(m.KERNEL_OP_DECISION) && /no new kernel op/i.test(m.KERNEL_OP_DECISION));
  t("V9 whitelist is exactly the owner mandate (SAOS/USDS · USDS/WSTEEM · USDS/WSBD — canonical poolKey orientation)", JSON.stringify([...m.NOURISH_PAIRS].sort()) === JSON.stringify(["SAOS/USDS", "USDS/WSBD", "USDS/WSTEEM"]));
}

console.log(`\nusds-liquidity-selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
