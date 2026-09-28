// SELFTEST — mission: זהויות-מתמטיות חייבות להתקיים בדיוק

import { ammFeesPerDay, mmRevenuePerDay, capitalForTarget, volumeForTarget, breakEvenTable } from "./model.mjs";
import { simulate } from "./simulate.mjs";

let fail = 0;
const t = (name, ok) => {
  console.log(`${ok ? " ✓" : " ✗"} ${name}`);
  if (!ok) fail = 1;
};

/* זהות 1: עמלות-AMM ליניאריות בנפח */
t("30bps on $1,000,000/day volume (100% share) = $3,000/day", ammFeesPerDay(1_000_000) === 3000);
t("30bps share 50% halves it", ammFeesPerDay(1_000_000, 5000) === 1500);

/* זהות 2: הון דרוש — סגירה-מעגלית מדויקת */
for (const [tpd, to, cb] of [[1000, 3, 2], [1000, 10, 5], [500, 1, 1]]) {
  const K = capitalForTarget(tpd, to, cb);
  t(`capital closure target=${tpd} to=${to} cb=${cb}`, Math.abs(mmRevenuePerDay(K, to, cb) - tpd) < 1e-9);
}

/* זהות 3: נפח דרוש — סגירה-מעגלית */
const V = volumeForTarget(1000);
t("volume closure 1000$ via 30bps", Math.abs(ammFeesPerDay(V) - 1000) < 1e-9);

/* זהות 4: טבלת-שבירה עקבית */
const table = breakEvenTable(1000);
t("break-even table 20 rows (5 captures × 4 turnovers)", table.length === 20);
t("higher turnover → less capital needed", table.find((r) => r.captureBps === 5 && r.turnoverPerDay === 30).capitalUsd <
  table.find((r) => r.captureBps === 5 && r.turnoverPerDay === 1).capitalUsd);
t("higher capture → less capital needed", table.find((r) => r.captureBps === 20 && r.turnoverPerDay === 3).capitalUsd <
  table.find((r) => r.captureBps === 1 && r.turnoverPerDay === 3).capitalUsd);

/* זהות 5: סימולטור דטרמיניסטי — אותו-זרע → אותו-מסלול */
const s1 = simulate({ capitalUsd: 5000, seed: 7 });
const s2 = simulate({ capitalUsd: 5000, seed: 7 });
t("simulation deterministic (same seed)", JSON.stringify(s1.path) === JSON.stringify(s2.path));
t("simulation crossing labeled honestly", s1.crossingDay === null || typeof s1.crossingDay === "number");

console.log(fail ? "MISSION-SELFTEST: FAIL" : "MISSION-SELFTEST: PASS");
process.exit(fail);
