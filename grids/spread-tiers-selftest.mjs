// SPREAD-TIERS-SELFTEST — כלל-הזהב: בלי-ראיות → בסיס; ראיות-חוץ-אחרי-החוק → הידוק; רצפות-שומר מעולם לא נחצות.
import { deriveSpreadTiers, countThirdPartyFills, EVIDENCE_WINDOW_CUT } from "./spread-tiers.mjs";

let failed = 0;
const t = (name, cond) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failed++; }
};

console.log("spread-tiers-selftest:");

/* 1) אפס-ראיות → הבסיס-החתום (T0) */
const r0 = deriveSpreadTiers([], { askStepBps: 60, bidStepBps: 100 });
t("no fills → T0 base 60/100", r0.tier === "T0" && r0.askStepBps === 60 && r0.bidStepBps === 100);
t("T0 evidence says 0 third-party", r0.thirdPartyFills === 0);
t("T0 next tier is T1 needing 2", r0.nextTier?.name === "T1" && r0.nextTier?.needs === 2);

/* 2) wash-מילויים (selfCross) לעולם לא ראיה */
const wash = [{ chain: "steem", selfCross: true, edgeBps: 500 }, { chain: "steem", selfCross: true, edgeBps: 120 }];
t("wash fills never count", countThirdPartyFills(wash, "steem") === 0);
t("wash-only → stays T0", deriveSpreadTiers(wash, { askStepBps: 60, bidStepBps: 100 }).tier === "T0");

/* 3) edge=0 (או חסר) אינו ראיה — רק מילוי-בעל-שוליים-מדוד */
const zeroEdge = [{ chain: "steem", edgeBps: 0, at: "2026-10-23T00:00:00" }, { chain: "steem", at: "2026-10-23T00:00:00" }, { chain: "steem", edgeBps: -3, at: "2026-10-23T00:00:00" }];
t("edge=0/missing excluded, edge≠0 counted", countThirdPartyFills(zeroEdge, "steem") === 1);

/* 4) שרשרת-שגויה לא נספרת (רגל-STEEM לא נפתחת ממילויי-HIVE) */
const hiveFills = [{ chain: "hive", edgeBps: 300, at: "2026-10-23T00:00:00" }, { chain: "hive", edgeBps: 300, at: "2026-10-23T00:00:00" }];
t("hive fills don't open steem tiers", countThirdPartyFills(hiveFills, "steem") === 0);

/* 4-b) חלון-הראיות: מילויים-ישנים מעידן-מלחמת-הבוטים (לפני-החות) אינם ראיה —
 * ההיסטוריה-הקדם-חוק עמומת-מקור (wash לא-מסומן). זה-השיעור-מהמדידה-החיה:
 * 97-מילויים-ישנים עם-edge≠0 בפנקס — ספירתם-כראיה היתה מקפצת-את-הסולם
 * ישר-ל-T3 על-בסיס-שקר. החוק: רק-אחרי-EVIDENCE_WINDOW_CUT. */
t("evidence window cut is the R-GRID-WAR measured instant", EVIDENCE_WINDOW_CUT === "2026-10-22T01:43:00Z");
const preLaw = [{ chain: "steem", edgeBps: 250, at: "2026-09-13T20:08:00" }, { chain: "steem", edgeBps: 250, at: "2026-10-22T01:42:59" }];
t("pre-law fills never count (ambiguous era)", countThirdPartyFills(preLaw, "steem") === 0);
const postLaw = [{ chain: "steem", edgeBps: 250, at: "2026-10-22T01:43:01" }];
t("post-law fill counts", countThirdPartyFills(postLaw, "steem") === 1);
const ninetySeven = Array.from({ length: 97 }, () => ({ chain: "steem", edgeBps: 60, at: "2026-09-13T20:08:00" }));
t("97 pre-law fills → still T0 (the measured 2026-09 tape case)", deriveSpreadTiers(ninetySeven, { askStepBps: 60, bidStepBps: 100 }).tier === "T0");
const missingAt = [{ chain: "steem", edgeBps: 250 }];
t("fill without timestamp = ambiguous = not evidence", countThirdPartyFills(missingAt, "steem") === 0);

/* 5) T1: ≥2 מילויי-חוץ-אחרי-החוק → 45/80 */
const two = Array.from({ length: 2 }, (_, i) => ({ chain: "steem", edgeBps: 120, at: `2026-10-22T0${i + 2}:00:00` }));
const r1 = deriveSpreadTiers(two, { askStepBps: 60, bidStepBps: 100 });
t("2 post-law third-party fills → T1 45/80", r1.tier === "T1" && r1.askStepBps === 45 && r1.bidStepBps === 80);
t("T1 next is T2 needing 3 more", r1.nextTier?.name === "T2" && r1.nextTier?.needs === 3);

/* 6) T2: ≥5 → 30/60 · T3: ≥12 → 18/45 (דו-ספרתי) — הכל-אחרי-החות */
const five = Array.from({ length: 5 }, (_, i) => ({ chain: "steem", edgeBps: 60, at: `2026-10-22T0${i + 2}:00:00` }));
const r2 = deriveSpreadTiers(five, { askStepBps: 60, bidStepBps: 100 });
t("5 post-law third-party fills → T2 30/60", r2.tier === "T2" && r2.askStepBps === 30 && r2.bidStepBps === 60);
const twelve = Array.from({ length: 12 }, (_, i) => ({ chain: "steem", edgeBps: 60, at: `2026-10-22T${String(i + 2).padStart(2, "0")}:00:00` }));
const r3 = deriveSpreadTiers(twelve, { askStepBps: 60, bidStepBps: 100 });
t("12 post-law third-party fills → T3 18/45 (double-digit ask)", r3.tier === "T3" && r3.askStepBps === 18 && r3.bidStepBps === 45);
t("T3 next is T4 needing 8 more", r3.nextTier?.name === "T4" && r3.nextTier?.needs === 8);
const twenty = Array.from({ length: 20 }, (_, i) => ({ chain: "steem", edgeBps: 60, at: `2026-10-22T${String(i + 2).padStart(2, "0")}:00:00` }));
const r4 = deriveSpreadTiers(twenty, { askStepBps: 60, bidStepBps: 100 });
t("20 post-law fills → T4 12/35", r4.tier === "T4" && r4.askStepBps === 12 && r4.bidStepBps === 35);
const thirtyTwo = Array.from({ length: 32 }, (_, i) => ({ chain: "steem", edgeBps: 60, at: `2026-10-22T${String(i % 22 + 2).padStart(2, "0")}:00:00` }));
const r5 = deriveSpreadTiers(thirtyTwo, { askStepBps: 60, bidStepBps: 100 });
t("32 post-law fills → T5 10/25 (validator floors exactly)", r5.tier === "T5" && r5.askStepBps === 10 && r5.bidStepBps === 25);
t("T5 is top — no next tier", r5.nextTier === null);

/* 7) חד-כיווניות: הסולם לעולם לא מרחיב-מעל-הבסיס (בסיס-הדוק מהמדרגה נשאר) */
const tight = deriveSpreadTiers(twelve, { askStepBps: 12, bidStepBps: 30 });
t("base tighter than tier stays base (never widen)", tight.askStepBps === 12 && tight.bidStepBps === 30);

/* 8) רצפות-השומר: לעולם לא מתחת ask≥10 / bid≥25 */
const floored = deriveSpreadTiers(twelve, { askStepBps: 5, bidStepBps: 20 });
t("validator floors hold (ask≥10, bid≥25)", floored.askStepBps >= 10 && floored.bidStepBps >= 25);

/* 9) קלט-זר לא מפיל (fail-honest) */
t("null fills → T0 honestly", deriveSpreadTiers(null, { askStepBps: 60, bidStepBps: 100 }).tier === "T0");
t("garbage entries skipped", countThirdPartyFills([null, 3, "x", {}], "steem") === 0);

if (failed) { console.error(`spread-tiers-selftest: FAILED (${failed})`); process.exit(1); }
console.log("spread-tiers-selftest: PASS (17 laws)");
