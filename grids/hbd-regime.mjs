/**
 * hbd-regime.mjs — גל-81 · משטר-החתך HBD (trace 1a1787f32fee7401 §3/§4)
 * =============================================================================
 * מדידה-חיה (grid-beat 2026-10-26T14:00Z): החותם-הגולמי (median מ-5-מקורות,
 * price-proof) ל-HBD היה 1.79$ — פרמיה-של-שוק-דק (+79% מול-משטר-ההדפסה) —
 * והוא-ניתק-בכנות-אך-בשווא את רגל-ה-HIVE כולה ("DISARMED-BROKEN-MARKET",
 * סטייה-מדומה 8071bps) בזמן-שהסטייה-האמיתית-מול-משטר-ההדפסה היא ~96bps.
 *
 * הדוקטרינה-כבר-קיימת-בצי: route-receipt.mjs שורה 64 —
 *   "hbdUsd: 1 (משטר-החתך) ... same honesty as arb-scan HIVE:HBD".
 * HBD הוא-נכס-הדפסה-ל-1$ (המרה-פנימית-מובטחת מול-HIVE בשווי-1$) —
 * החותם-הכן-הוא-הפגיון; החותם-הגולמי-ממשיך-להתפרסם-לצידו-לביקורת.
 *
 * אפס-רשת, טהור, דטרמיניסטי — אותו-קלט → אותו-פלט. fail-honest: בלי-קלט
 * (null/לא-חיובי) → mark=null (אין-סימון, אין-מסחר) — שום-דבר-לא-מדומה.
 */

export const HBD_PRINT_PEG_USD = 1.0;

/**
 * @param {number|null|undefined} rawHbdUsd — החותם-הגולמי מ-price-proof (median+MAD)
 * @returns {{mark: number|null, regime: string, raw: number|null, devBps: number|null, note: string}}
 */
export function hbdMarkRegime(rawHbdUsd) {
  if (rawHbdUsd === null || rawHbdUsd === undefined || !(rawHbdUsd > 0)) {
    return {
      mark: null,
      regime: "unavailable",
      raw: rawHbdUsd ?? null,
      devBps: null,
      note: "raw HBD mark unavailable — no marking, no trading (fail-honest, grid-beat N3 law)",
    };
  }
  const devBps = Math.round(Math.abs(rawHbdUsd - HBD_PRINT_PEG_USD) / HBD_PRINT_PEG_USD * 10000);
  return {
    mark: HBD_PRINT_PEG_USD,
    regime: "print-peg-1.00",
    raw: rawHbdUsd,
    devBps,
    note: `route-receipt haircut doctrine applied (hbdUsd=1); raw 5-source median published for audit (dev ${devBps}bps vs print regime)`,
  };
}
