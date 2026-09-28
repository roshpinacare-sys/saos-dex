// SIMULATE — סימולטור-משימה דטרמיניסטי: מסלול-90-יום ליעד
//
// מה-הוא-עושה: לוקח הנחות-מפורשות (הון, מחזור, תפיסה, צמיחה-שבועית) ומדמה
// יום-יום את מסילות-ההכנסה מהמודל. דטרמיניסטי לחלוטין (זרע). מפיק:
//   · מסלול-יומי (דפוס-זולוגיה אמת של גריד: ימים-טובים וימים-פחות)
//   · יום-החצייה של היעד (אם מגיע)
//   · סיכום-90 יום
// כנות: זה סימולטור מסומן — לא הבטחה. תפקידו להוכיח שהמכונה מגיעה ליעד
// **בהנחות-מפורשות**, ולחשוף מתי-ההנחות נשברות.

import { mulberry32 } from "../grids/strategies.mjs";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function simulate({
  days = 90,
  capitalUsd = 1000,
  turnoverPerDay = 3,
  captureBps = 2,
  weeklyGrowthPct = 5,        // צמיחת-נפח/קיבולת שבועית (הנחה מפורשת)
  volPct = 3,                 // תנודתיות-יומית לדפוס-המילויים (הנחה)
  targetPerDay = 1000,
  seed = 20260928,
} = {}) {
  const rng = mulberry32(seed);
  const path = [];
  let day = 0;
  let crossed = null;
  for (let d = 1; d <= days; d++) {
    day = d;
    const growth = Math.pow(1 + weeklyGrowthPct / 100, d / 7);
    // יום-שוק רגיל: מחזור אפקטיבי סוטה עם התנודתיות (clamp 0.2..3 של ההנחה)
    const volFactor = Math.max(0.2, Math.min(3, 1 + (rng() * 2 - 1) * (volPct / 100)));
    const dayRevenue = mmRevenue(capitalUsd, turnoverPerDay * growth * volFactor, captureBps);
    if (crossed === null && dayRevenue >= targetPerDay) crossed = d;
    path.push({ day: d, revenue: Math.round(dayRevenue * 1e6) / 1e6 });
  }
  const total = path.reduce((s, p) => s + p.revenue, 0);
  const out = {
    asof: new Date().toISOString(),
    seed, days,
    params: { capitalUsd, turnoverPerDay, captureBps, weeklyGrowthPct, volPct, targetPerDay },
    honesty: "סימולציה מסומנת SIM — לא הבטחה; ההנחות מפורשות וניתנות-לשינוי",
    crossingDay: crossed,
    total90: Math.round(total * 100) / 100,
    bestDay: path[path.length - 1].revenue,
    path,
  };
  writeFileSync(join(HERE, "sim.json"), JSON.stringify(out, null, 1) + "\n");
  return out;
}

function mmRevenue(capital, turnover, captureBps) {
  return capital * turnover * (captureBps / 10000);
}

/* CLI: node mission/simulate.mjs [capital] [turnover] [captureBps] */
if (process.argv[1] && process.argv[1].endsWith("simulate.mjs")) {
  const capital = Number(process.argv[2]) || 1000;
  const turnover = Number(process.argv[3]) || 3;
  const capture = Number(process.argv[4]) || 2;
  const s = simulate({ capitalUsd: capital, turnoverPerDay: turnover, captureBps: capture });
  console.log(`SIM ${s.days}d · capital $${capital} · ${turnover}x/day · ${capture}bps capture`);
  console.log(`crossing $1000/day: ${s.crossingDay ? `day ${s.crossingDay}` : "NOT REACHED in 90d (honest)"}`);
  console.log(`best day: $${s.bestDay} · total 90d: $${s.total90}`);
}
