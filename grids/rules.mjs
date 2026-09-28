// RULES — מנוע-הכללים: דבר-גורר-דבר (DAG טריגרים חסום-עומק)
//
// כלל = {on: טיפוס-אירוע, when: תנאי, then: פעולות}. פעולה מייצרת אירועים,
// האירועים נכנסים חזרה ללולאה — כך הרשת מפעילה את עצמה. שני מגני-לולאה:
//   · maxDepth=8   — עומק שרשור מרבי לאירוע בודד
//   · maxFires=64  — מספר הצתות מרבי לכל-טיק (חריגה → grid.halt)
// סדר דטרמיניסטי מלא: לפי seq של האירוע ואז לפי id הכלל.

export const MAX_DEPTH = 8;
export const MAX_FIRES = 64;

/* ── הכללים המייסדים ──────────────────────────────────────────────────────
   R-ANCHOR-QUOTE  · עיגון חדש ב-weave → רענון-ציטוטים בכל-הגרידים החיים
   R-DRIFT-ARB     · סטיית-פאריטי מעבר לרצועה → מיקרו-ארביטרז'
   R-FILL-REBAL    · מילוי בגריד → איזון-מלאי מחדש
   R-INVENTORY-ARM · מלאי חוצה תקרה → עצירת-הגריד (circuit breaker)
   R-FEE-SPAWN     · מד-עמלות חוצה אבן-דרך → הולדת מיקרו-גריד הבא (הרחבה
                     שממומנת-מעצמה — אותה משמעת feeMeter של LIQUIDITY_STRATEGY)
   R-MISSION-CHECK · כל עמלה → עדכון התקדמות משימת-ה-1000$/יום
────────────────────────────────────────────────────────────────────────── */

export const SEED_RULES = [
  {
    id: "R-ANCHOR-QUOTE",
    on: "anchor.new",
    when: () => true,
    then: (ctx) => [{ action: "requote", grids: ctx.activeGrids() }],
  },
  {
    id: "R-DRIFT-ARB",
    on: "parity.drift",
    when: (p) => Math.abs(p.driftBps ?? 0) >= (p.bandBps ?? 25),
    then: (ctx) => [{ action: "arb_execute", grid: "micro-arb", driftBps: (ctx.event?.payload?.driftBps) ?? 0 }],
  },
  {
    id: "R-FILL-REBAL",
    on: "grid.fill",
    when: () => true,
    then: (ctx) => [{ action: "rebalance", grid: ctx.event?.payload?.gridId }],
  },
  {
    id: "R-INVENTORY-ARM",
    on: "inventory.warn",
    when: (p) => (p.inventoryMu ?? 0) > (p.capMu ?? Infinity),
    then: (ctx) => [{ action: "halt_grid", grid: ctx.event?.payload?.gridId, reason: "inventory-cap" }],
  },
  {
    id: "R-FEE-SPAWN",
    on: "fee.meter",
    when: (p, state) =>
      Array.isArray(state?.feeMeter?.queue) &&
      state.feeMeter.queue.length > 0 &&
      state.feeMeter.simMu >= nextMilestone(state),
    then: (ctx) => [{ action: "spawn_microgrid", grid: ctx.state?.feeMeter?.queue?.[0] }],
  },
  {
    id: "R-MISSION-CHECK",
    on: "fee.meter",
    when: () => true,
    then: (ctx) => [{ action: "mission_check", simMu: ctx.state?.feeMeter?.simMu ?? 0 }],
  },
];

/** אבן-הדרך הבאה להולדת מיקרו-גריד: כל הכפלה של עמלות-המדד מאז ההולדה הקודמת. */
export function nextMilestone(state) {
  const hit = state?.feeMeter?.milestonesHit ?? [];
  const last = hit.length > 0 ? hit[hit.length - 1] : 0;
  return Math.max(1000, last * 2); // אבן-הפתיחה: 1000µ (µ = יחידת-המדידה של ה-Dex)
}

/**
 * הרצת הכללים על אירועים טריים. PURE-מספיק: קלט state + events →
 * {actions, newEvents, fired} בלי תופעות-לוואי. ה-engine מבצע.
 */
export function processRules(state, events, rules = SEED_RULES) {
  const actions = [];
  const newEvents = [];
  let fired = 0;
  let halted = false;
  let haltReason = null;

  const queue = events.map((e) => ({ ev: e, depth: 0 }));

  while (queue.length > 0) {
    const { ev, depth } = queue.shift();
    if (depth > MAX_DEPTH) {
      halted = true;
      haltReason = `depth>${MAX_DEPTH} on ${ev.type}`;
      break;
    }
    if (fired >= MAX_FIRES) {
      halted = true;
      haltReason = `fires>${MAX_FIRES}`;
      break;
    }
    for (const rule of rules) {
      if (rule.on !== ev.type) continue;
      let ok = false;
      try {
        ok = rule.when(ev.payload ?? {}, state);
      } catch {
        ok = false; // כלל שנכשל בתנאי לא מפסיק את הצי
      }
      if (!ok) continue;
      fired += 1;
      if (fired > MAX_FIRES) {
        halted = true;
        haltReason = `fires>${MAX_FIRES}`;
        break;
      }
      const ctx = { state, event: ev, activeGrids: () => (state.grids ?? []).filter((g) => g.active).map((g) => g.id) };
      let acts = [];
      try {
        acts = rule.then(ctx) ?? [];
      } catch {
        acts = [];
      }
      for (const a of acts) {
        actions.push({ rule: rule.id, depth, ...a });
        if (a.emit) {
          newEvents.push(a.emit);
          queue.push({ ev: a.emit, depth: depth + 1 });
        }
      }
    }
    if (halted) break;
  }
  return { actions, newEvents, fired, halted, haltReason };
}
