// COMMUNITY-SELFTEST — שער-ברזל למתכנן-הקהילה (אופליין, אפס-רשת, אפס-מפתחות)
// כל-חוק נכשל = קומיט לא יוצא. המתכנן טהור — החוקים כאן הם האמת היחידה עליו.
import { planCommunity, communityAuth, COMMUNITY_POLICY } from "./community.mjs";

const MANDATE = {
  spec: "SAOS-COMMUNITY-MANDATE/1",
  grantedBy: "operator",
  traceId: "1a1056131d2dfc79",
  name: "hive-197711",
  title: "SAOS · רשת בונים ריבונית",
};

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
};

console.log("community-selftest — iron rules for the community planner");

/* ── שער-מנדט ────────────────────────────────────────────────────────────── */
(() => {
  const p = planCommunity({ name: "hive-197711", mandate: null, liquidSteem: 100, accountFee: 3 });
  t("1 · no mandate → HOLD (owner-gated structurally)", p.verdict === "HOLD" && p.gates.some((g) => g.includes("owner mandate")));
})();

(() => {
  const p = planCommunity({ name: "hive-999999", mandate: MANDATE, liquidSteem: 100, accountFee: 3 });
  t("2 · mandate name mismatch → HOLD", p.verdict === "HOLD" && p.gates.some((g) => g.includes("mismatch")));
})();

/* ── אידמפוטנטיות ───────────────────────────────────────────────────────── */
(() => {
  const p = planCommunity({ name: "hive-197711", mandate: MANDATE, alreadyExists: true });
  t("3 · already exists → CREATED (zero ops, honest)", p.verdict === "CREATED" && p.path === "already-exists");
})();

/* ── חוקי-שם ─────────────────────────────────────────────────────────────── */
(() => {
  const MANDATE_BADNAME = { ...MANDATE, name: "Bad_Name!" };
  const p = planCommunity({ name: "Bad_Name!", mandate: MANDATE_BADNAME });
  t("4 · invalid account name → HOLD", p.verdict === "HOLD" && p.gates.some((g) => g.includes("bad account name")));
  const q = planCommunity({ name: "hive-197711", mandate: MANDATE, nameFree: false });
  t("5 · name taken on-chain → HOLD", q.verdict === "HOLD" && q.gates.some((g) => g.includes("taken")));
})();

/* ── נתיבי-יצירה ─────────────────────────────────────────────────────────── */
(() => {
  const p = planCommunity({ name: "hive-197711", mandate: MANDATE, pendingClaimed: 1 });
  t("6 · claimed credit available → READY (claimed, zero fee)", p.ok && p.path === "claimed");
})();
(() => {
  const p = planCommunity({ name: "hive-197711", mandate: MANDATE, rcCurrent: 1.68e12, rcMax: 1.68e12, liquidSteem: 0, accountFee: 3 });
  t("7 · RC at ceiling → READY (claim path)", p.ok && p.path === "claim");
})();
(() => {
  const p = planCommunity({ name: "hive-197711", mandate: MANDATE, rcCurrent: 0.5e12, rcMax: 1.68e12, liquidSteem: 5, accountFee: 3 });
  t("8 · RC below floor falls through to fee path", p.ok && p.path === "fee");
  const q = planCommunity({ name: "hive-197711", mandate: MANDATE, rcCurrent: 0.5e12, rcMax: 1.68e12, liquidSteem: 2.686, accountFee: 3 });
  t("9 · today's live state (liquid 2.686 < 3.1) → HOLD with funds reason", q.verdict === "HOLD" && q.gates.some((g) => g.includes("2.686") && g.includes("3.100")));
  const r = planCommunity({ name: "hive-197711", mandate: MANDATE, liquidSteem: 3.1, accountFee: 3, rcCurrent: 0, rcMax: 0 });
  t("10 · liquid ≥ fee+buffer → READY (fee path)", r.ok && r.path === "fee");
  const s = planCommunity({ name: "hive-197711", mandate: MANDATE, liquidSteem: 3.05, accountFee: 3, rcCurrent: 0, rcMax: 0 });
  t("11 · liquid inside buffer → HOLD (reserve discipline)", s.verdict === "HOLD");
})();

/* ── צורת-רשויות: הקהילה נשלטת על-ידי headcorner, אפס-מפתחות-יתום ──────── */
(() => {
  const a = communityAuth("STM5HhJD5WUXu8vPhDmLaC2fTuuJYkwxF62Rt17HZ5G2PbnBvuHXF");
  t("12 · authority threshold 1", a.weight_threshold === 1);
  t("13 · headcorner account_auth present at weight 1", a.account_auths.length === 1 && a.account_auths[0][0] === "headcorner" && a.account_auths[0][1] === 1);
  t("14 · generated key present at weight 1", a.key_auths.length === 1 && a.key_auths[0][1] === 1);
})();

/* ── קבלות ──────────────────────────────────────────────────────────────── */
(() => {
  const p = planCommunity({ name: "hive-197711", mandate: MANDATE, liquidSteem: 100, nowIso: "2026-10-04T05:39:38Z" });
  t("15 · verdict enum closed (READY/HOLD/CREATED)", ["READY", "HOLD", "CREATED"].includes(p.verdict));
  const q = planCommunity({ name: "hive-197711", mandate: MANDATE, liquidSteem: 100, nowIso: "2026-10-04T05:39:38Z" });
  t("16 · plan byte-stable (deterministic receipt)", JSON.stringify(p) === JSON.stringify(q));
  const bad = { wif: "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLz7", priv: "deadbeef" };
  void bad;
  t("17 · receipt contains no key-material field", !JSON.stringify(p).toLowerCase().includes("wif") && !("priv" in p));
})();

/* ── מדיניות ────────────────────────────────────────────────────────────── */
(() => {
  t("18 · fee buffer is positive and small (self-funded discipline)", COMMUNITY_POLICY.FEE_BUFFER_STEEM > 0 && COMMUNITY_POLICY.FEE_BUFFER_STEEM <= 0.5);
  t("19 · claim RC floor ≥ 0.9 (market-ops never starved)", COMMUNITY_POLICY.CLAIM_RC_FLOOR >= 0.9);
  t("20 · default name matches chain rule", COMMUNITY_POLICY.NAME_RE.test(COMMUNITY_POLICY.NAME_DEFAULT));
})();

console.log(`\ncommunity-selftest: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
